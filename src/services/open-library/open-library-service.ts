/**
 * @fileoverview Open Library REST API client. Handles search, works, editions, authors,
 * subjects, and cover URL construction with retry and timeout.
 * @module services/open-library/open-library-service
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import { McpError, validationError } from '@cyanheads/mcp-ts-core/errors';
import { fetchWithTimeout, withRetry } from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig } from '@/config/server-config.js';
import { normalizeLanguageCode } from './language-codes.js';
import type {
  AuthorDetail,
  AuthorSearchResult,
  AuthorWork,
  EditionAuthor,
  EditionDetail,
  EditionIdType,
  EditionSummary,
  InsideMatch,
  SearchWork,
  SubjectWork,
  WorkAvailability,
  WorkDetail,
} from './types.js';

const BASE_URL = 'https://openlibrary.org';
const COVERS_URL = 'https://covers.openlibrary.org';
const TIMEOUT_MS = 15_000;

/** Bibkey prefix `/api/books` expects for each identifier type. */
const BIBKEY_PREFIX: Record<EditionIdType, string> = {
  isbn: 'ISBN',
  oclc: 'OCLC',
  lccn: 'LCCN',
  olid: 'OLID',
};

/**
 * How many enrichment requests one identifier batch may have in flight against
 * openlibrary.org at once. `/api/books` resolves the whole batch in a single
 * request, but an edition carrying no inline authors still costs a work lookup
 * plus one lookup per author credit — at the 50-identifier cap that is well over
 * a hundred requests, and ungated they would all open at once. Open Library is
 * volunteer-run infrastructure, so the batch trickles them through instead.
 *
 * Six balances the two costs: it holds the sustained rate of a worst-case batch
 * near ten requests a second rather than dumping the whole fan-out in one tick,
 * while still finishing a large batch in a fraction of the serial time.
 */
export const EDITION_ENRICHMENT_CONCURRENCY = 6;

/**
 * Caps how many tasks run at once. Callers keep their existing `Promise.all`
 * shape — and therefore their result order — while the gate decides when each
 * task actually starts.
 *
 * Scope one gate per batch, not per service: the service is a singleton, so a
 * shared gate would queue unrelated concurrent tool calls behind each other.
 */
class ConcurrencyGate {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  async run<T>(task: () => Promise<T>): Promise<T> {
    // Re-check after waking: a slot freed for this waiter can be taken by a
    // caller that entered between the release and this continuation.
    while (this.active >= this.limit) {
      await new Promise<void>((resolve) => {
        this.waiting.push(resolve);
      });
    }
    this.active++;
    try {
      return await task();
    } finally {
      this.active--;
      this.waiting.shift()?.();
    }
  }
}

/** The `details` payload `/api/books?jscmd=details` returns per resolved bibkey. */
type RawEditionDetails = {
  key?: string;
  title?: string;
  authors?: Array<{ key: string; name?: string }>;
  publish_date?: string;
  publishers?: string[];
  languages?: Array<{ key: string }>;
  isbn_10?: string[];
  isbn_13?: string[];
  oclc_numbers?: string[];
  lccn?: string[];
  lc_classifications?: string[];
  number_of_pages?: number;
  description?: unknown;
  covers?: number[];
  works?: Array<{ key: string }>;
  ocaid?: string;
};

/**
 * Strips the `{{{…}}}` markers the full-text index wraps around matched terms.
 * They are an upstream highlight convention rather than book content, so a model
 * reading the snippet should see the sentence as it appears on the page.
 */
function normalizeHighlight(snippet: string): string {
  return snippet.replaceAll('{{{', '').replaceAll('}}}', '');
}

/** Every `ebook_access` tier Open Library publishes, in ascending order of access. */
const EBOOK_ACCESS_TIERS: ReadonlySet<string> = new Set<SearchWork['ebook_access']>([
  'no_ebook',
  'unclassified',
  'printdisabled',
  'borrowable',
  'public',
]);

/** Strips a leading path segment prefix from an OL ID (e.g. "/works/OL45804W" → "OL45804W"). */
function stripPrefix(id: string, prefix: string): string {
  return id.startsWith(prefix) ? id.slice(prefix.length) : id;
}

/** Normalizes an author identifier to its bare OLID form ("/authors/OL24638A" → "OL24638A"). */
export function normalizeAuthorId(authorId: string): string {
  return stripPrefix(authorId, '/authors/');
}

/**
 * Keeps only entries usable as Covers API identifiers from an upstream `covers`
 * or `photos` array.
 *
 * Open Library writes `-1` into these arrays as its own "no image in this slot"
 * sentinel rather than omitting the slot, and the same convention makes any
 * non-positive entry an empty slot — so the filter is `> 0`, not `!== -1`. A
 * sentinel that reached `cover_ids` would read as a real ID, and the only thing
 * a client can do with it is spend an `openlibrary_get_cover_url` call to be
 * told it is invalid.
 *
 * The upstream field is *declared* `number[]`, but that is an assertion about
 * untrusted JSON rather than a guarantee — Open Library nulls values it has no
 * data for elsewhere in the same payloads (see {@link toEbookAccess}) — so
 * entries are checked for numeric integrality instead of assumed.
 */
function sanitizeImageIds(raw: unknown): number[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((id): id is number => Number.isInteger(id) && id > 0);
}

/** Extracts the 3-letter language code from a raw language key path ("/languages/eng" → "eng"). */
function extractLanguageCode(key: string): string {
  const parts = key.split('/');
  return parts[parts.length - 1] ?? key;
}

/**
 * Maps an upstream `ebook_access` string onto the known tier union. Open Library
 * can add tiers at any time and the tool's output schema is a strict enum, so an
 * unrecognized value is reported as `unclassified` — the tier that already means
 * "access not determined" — instead of failing validation and discarding the
 * whole page of results over one work's unexpected field.
 */
function toEbookAccess(raw: string | null | undefined, ctx: Context): SearchWork['ebook_access'] {
  // Open Library nulls absent fields rather than omitting them, so an unset tier
  // arrives as `null` as often as `undefined` — neither is an unrecognized tier.
  if (raw == null) return 'no_ebook';
  if (EBOOK_ACCESS_TIERS.has(raw)) return raw as SearchWork['ebook_access'];
  ctx.log.warning('Unrecognized ebook_access tier from Open Library', { value: raw });
  return 'unclassified';
}

/** Normalizes a description that may be a string or { value: string } object. */
function extractDescription(raw: unknown): string | undefined {
  if (typeof raw === 'string') return raw || undefined;
  if (raw && typeof raw === 'object' && 'value' in raw && typeof raw.value === 'string') {
    return raw.value || undefined;
  }
  return;
}

/**
 * How many `/type/redirect` hops an author lookup will follow before giving up.
 *
 * Open Library keeps a merged author as a redirect stub pointing at the record
 * that absorbed it, and an already-merged author can be merged again — so the
 * stub's target is itself sometimes a stub. Following the chain is therefore
 * unavoidable, but it is upstream-controlled data: without a cap, a chain that
 * is circular or pathologically long would hold the request open indefinitely.
 * Four covers the observed depth with room to spare; past it the lookup fails
 * closed to the caller's `not_found` rather than looping.
 */
export const MAX_AUTHOR_REDIRECT_HOPS = 4;

/** The `/type/*` key Open Library stamps on a merged-away author's stub record. */
const REDIRECT_TYPE_KEY = '/type/redirect';

/**
 * The author record as Open Library returns it, including the two fields that
 * only a merge stub populates meaningfully.
 *
 * `location` is present on *every* author record — a live author carries
 * `"location": null` — so it says nothing on its own about whether the record is
 * a redirect. `type.key` is the only honest discriminator, and the one
 * {@link OpenLibraryService.fetchAuthorRecord} branches on.
 */
type RawAuthorRecord = {
  key?: string;
  name?: string;
  personal_name?: string;
  fuller_name?: string;
  bio?: unknown;
  birth_date?: string;
  death_date?: string;
  photos?: number[];
  remote_ids?: {
    wikidata?: string;
    viaf?: string;
    isni?: string;
    goodreads?: string;
    librarything?: string;
  };
  type?: { key?: string };
  location?: string | null;
  error?: string;
};

/**
 * The canonical author ID a redirect stub points at, or `undefined` when the
 * stub names no usable target. A stub whose `location` is absent, null, or not
 * an author OLID is malformed: resolution stops there and the caller reports the
 * author as absent rather than guessing at a target or fetching a path that
 * cannot be an author.
 */
function redirectTarget(raw: RawAuthorRecord): string | undefined {
  if (typeof raw.location !== 'string') return;
  const target = normalizeAuthorId(raw.location.trim());
  return /^OL\d+A$/i.test(target) ? target : undefined;
}

/**
 * True when an error is the status-mapped `McpError` that `fetchWithTimeout`
 * throws on an upstream HTTP 404. `withRetry` rethrows it unchanged (NotFound is
 * not a transient code), so `data.status` reaches here intact. Callers map this
 * to an absent-record `null` so each tool's own `not_found` path fires instead
 * of the raw fetch-layer error leaking to the client.
 */
function isUpstreamNotFound(err: unknown): boolean {
  return err instanceof McpError && err.data?.status === 404;
}

/**
 * True when a cover identifier contains characters that would let it escape its
 * path segment in the Covers API URL — path separators (`/`, `\`), a
 * parent-directory sequence (`..`), or any control character (0x00–0x1F, 0x7F).
 * A cover must resolve to the exact identifier supplied, never a reinterpreted
 * path. Control characters are scanned by code point rather than embedded in a
 * regex (which `noControlCharactersInRegex` forbids).
 */
export function isUnsafeCoverIdentifier(identifier: string): boolean {
  if (identifier.includes('/') || identifier.includes('\\') || identifier.includes('..')) {
    return true;
  }
  for (let i = 0; i < identifier.length; i++) {
    const code = identifier.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

/**
 * Describes the identifier shape the Covers API expects for one
 * `id_type` × `target` pair, or `undefined` when the supplied identifier already
 * matches it. The Covers API answers every request with HTTP 200 — a malformed
 * identifier yields the same 1×1 placeholder GIF a genuinely coverless book
 * does — so a typo is only ever caught here.
 *
 * Exported so the tool handler and {@link OpenLibraryService.getCoverUrl}'s
 * enforcement seam check one rule rather than two copies of it.
 */
export function coverIdentifierExpectation(
  identifier: string,
  idType: 'id' | 'isbn' | 'olid',
  target: 'book' | 'author',
): string | undefined {
  if (idType === 'id') {
    return /^\d+$/.test(identifier) ? undefined : 'a numeric cover or photo ID (e.g., 9255566)';
  }
  if (idType === 'isbn') {
    const digits = identifier.replace(/-/g, '');
    return /^\d{10}$/.test(digits) || /^\d{13}$/.test(digits)
      ? undefined
      : 'an ISBN of 10 or 13 digits, hyphens optional (e.g., 9780743273565)';
  }
  // An edition OLID passed with target "author" resolves to a plausible author
  // photo URL that can only ever serve the placeholder, so the suffix is checked
  // against the target rather than accepted as any OLID.
  return target === 'author'
    ? /^OL\d+A$/i.test(identifier)
      ? undefined
      : 'an author OLID ending in A (e.g., OL24638A)'
    : /^OL\d+M$/i.test(identifier)
      ? undefined
      : 'an edition OLID ending in M (e.g., OL7353617M)';
}

export class OpenLibraryService {
  private readonly userAgent: string;

  constructor(userAgent: string) {
    this.userAgent = userAgent;
  }

  private headers(): Record<string, string> {
    return { 'User-Agent': this.userAgent };
  }

  private fetch<T>(url: string, ctx: Context, expectedStatuses?: number[]): Promise<T> {
    // `fetchWithTimeout` and `withRetry` accept `RequestContext` which requires an index signature.
    // `Context` is structurally compatible at runtime — cast is safe per framework docs.
    // biome-ignore lint/suspicious/noExplicitAny: safe per framework docs
    const rCtx = ctx as any;
    return withRetry(
      async () => {
        const response = await fetchWithTimeout(url, TIMEOUT_MS, rCtx, {
          headers: this.headers(),
          signal: ctx.signal,
          ...(expectedStatuses ? { expectedStatuses } : {}),
        });
        const text = await response.text();
        if (/^\s*<(!DOCTYPE\s+html|html[\s>])/i.test(text)) {
          throw new Error('Service unavailable — API returned HTML instead of JSON.');
        }
        return JSON.parse(text) as T;
      },
      {
        operation: `OpenLibrary.fetch`,
        context: rCtx,
        baseDelayMs: 1000,
        signal: ctx.signal,
      },
    );
  }

  /**
   * Fetches JSON like {@link fetch}, but resolves to `null` when the upstream
   * returns HTTP 404 instead of throwing. Open Library 404s on missing by-ID
   * records, so mapping that to `null` revives each caller's own `not_found`
   * path — their `ctx.fail('not_found', …)` / `notFound()` with tool-specific
   * recovery — instead of leaking the raw status-mapped fetch error. A 404 is
   * an outcome here, not a failure, so it is declared expected and logs at
   * `debug` rather than `error`.
   */
  private async fetchOrNull<T>(url: string, ctx: Context): Promise<T | null> {
    try {
      return await this.fetch<T>(url, ctx, [404]);
    } catch (err) {
      if (isUpstreamNotFound(err)) return null;
      throw err;
    }
  }

  // ─── Search ───────────────────────────────────────────────────────────────────

  async searchBooks(
    params: {
      query?: string | undefined;
      title?: string | undefined;
      author?: string | undefined;
      subject?: string | undefined;
      publisher?: string | undefined;
      isbn?: string | undefined;
      language?: string | undefined;
      sort?: string | undefined;
      limit: number;
      offset: number;
      include_availability?: boolean | undefined;
    },
    ctx: Context,
  ): Promise<{ total: number; offset: number; works: SearchWork[] }> {
    const qs = new URLSearchParams();

    if (params.query) qs.set('q', params.query);
    if (params.title) qs.set('title', params.title);
    if (params.author) qs.set('author', params.author);
    if (params.subject) qs.set('subject', params.subject);
    if (params.publisher) qs.set('publisher', params.publisher);
    if (params.isbn) qs.set('isbn', params.isbn.replace(/-/g, ''));
    // `language=` is the result filter and takes 3-letter MARC codes; `lang=` is
    // Open Library's UI-language parameter and filters nothing.
    if (params.language) qs.set('language', normalizeLanguageCode(params.language));
    if (params.sort && params.sort !== 'relevance') {
      qs.set('sort', params.sort);
    }

    qs.set('limit', String(params.limit));
    qs.set('offset', String(params.offset));

    const baseFields =
      'key,title,author_name,author_key,first_publish_year,edition_count,cover_i,subject,ebook_access,has_fulltext,ratings_average,ia';
    const fields = params.include_availability ? `${baseFields},availability` : baseFields;
    qs.set('fields', fields);

    const url = `${BASE_URL}/search.json?${qs.toString()}`;
    ctx.log.debug('Searching books', { url });

    const raw = await this.fetch<{
      numFound: number;
      start: number;
      docs: Array<{
        key: string;
        title: string;
        author_name?: string[];
        author_key?: string[];
        first_publish_year?: number;
        edition_count?: number;
        cover_i?: number;
        subject?: string[];
        ebook_access?: string;
        has_fulltext?: boolean;
        ratings_average?: number;
        availability?: WorkAvailability;
        ia?: string[];
      }>;
    }>(url, ctx);

    const works: SearchWork[] = raw.docs.map((doc) => {
      const workId = doc.key ? stripPrefix(doc.key, '/works/') : '';
      const ebookAccess = toEbookAccess(doc.ebook_access, ctx);
      return {
        work_id: workId,
        title: doc.title ?? '',
        author_names: doc.author_name ?? [],
        author_ids: (doc.author_key ?? []).map((k) => stripPrefix(k, '/authors/')),
        ...(typeof doc.first_publish_year === 'number' && {
          first_publish_year: doc.first_publish_year,
        }),
        edition_count: doc.edition_count ?? 0,
        ...(typeof doc.cover_i === 'number' && { cover_id: doc.cover_i }),
        // Complete list: the tool caps only the rendered text and discloses the
        // omitted count, so structuredContent keeps every tag the index returned.
        ...(doc.subject?.length ? { subjects: doc.subject } : {}),
        ebook_access: ebookAccess,
        has_fulltext: doc.has_fulltext ?? false,
        ...(typeof doc.ratings_average === 'number' && { ratings_average: doc.ratings_average }),
        availability: params.include_availability ? (doc.availability ?? null) : undefined,
        ia_identifiers: doc.ia ?? [],
      };
    });

    return {
      total: raw.numFound,
      offset: raw.start,
      works,
    };
  }

  // ─── Works ────────────────────────────────────────────────────────────────────

  async getWork(workId: string, ctx: Context): Promise<WorkDetail | null> {
    const id = stripPrefix(workId, '/works/');
    const url = `${BASE_URL}/works/${id}.json`;
    ctx.log.debug('Fetching work', { workId: id });

    const raw = await this.fetchOrNull<{
      key: string;
      title: string;
      description?: unknown;
      subjects?: string[];
      subject_places?: string[];
      subject_times?: string[];
      subject_people?: string[];
      covers?: number[];
      authors?: Array<{ author: { key: string } }>;
      created?: { value: string };
      last_modified?: { value: string };
    }>(url, ctx);

    if (!raw?.key) return null;

    const desc = extractDescription(raw.description);
    return {
      work_id: stripPrefix(raw.key, '/works/'),
      title: raw.title ?? '',
      ...(desc !== undefined ? { description: desc } : {}),
      subjects: raw.subjects ?? [],
      subject_places: raw.subject_places ?? [],
      subject_times: raw.subject_times ?? [],
      subject_people: raw.subject_people ?? [],
      cover_ids: sanitizeImageIds(raw.covers),
      author_ids: (raw.authors ?? []).map((a) => stripPrefix(a.author.key, '/authors/')),
      ...(raw.created?.value !== undefined ? { created: raw.created.value } : {}),
      ...(raw.last_modified?.value !== undefined ? { last_modified: raw.last_modified.value } : {}),
    };
  }

  // ─── Editions ─────────────────────────────────────────────────────────────────

  async getEditions(
    workId: string,
    limit: number,
    offset: number,
    ctx: Context,
  ): Promise<{ total: number; work_id: string; editions: EditionSummary[] } | null> {
    const id = stripPrefix(workId, '/works/');
    const url = `${BASE_URL}/works/${id}/editions.json?limit=${limit}&offset=${offset}`;
    ctx.log.debug('Fetching editions', { workId: id, limit, offset });

    const raw = await this.fetchOrNull<{
      size: number;
      entries: Array<{
        key: string;
        title?: string;
        publish_date?: string;
        publishers?: string[];
        languages?: Array<{ key: string }>;
        isbn_10?: string[];
        isbn_13?: string[];
        number_of_pages?: number;
        covers?: number[];
        works?: Array<{ key: string }>;
      }>;
    }>(url, ctx);

    if (!raw?.entries) return null;

    const editions: EditionSummary[] = raw.entries.map((e) => ({
      edition_id: stripPrefix(e.key ?? '', '/books/'),
      title: e.title ?? '',
      ...(e.publish_date ? { publish_date: e.publish_date } : {}),
      publishers: e.publishers ?? [],
      languages: (e.languages ?? []).map((l) => extractLanguageCode(l.key)),
      isbn_10: e.isbn_10 ?? [],
      isbn_13: e.isbn_13 ?? [],
      ...(typeof e.number_of_pages === 'number' && { page_count: e.number_of_pages }),
      cover_ids: sanitizeImageIds(e.covers),
      ...(e.works?.[0]?.key ? { work_id: stripPrefix(e.works[0].key, '/works/') } : {}),
    }));

    return { total: raw.size, work_id: id, editions };
  }

  // ─── Edition by identifier ────────────────────────────────────────────────────

  /**
   * Resolves `/authors/{id}` display names in parallel — up to whatever `gate`
   * allows in flight — tagging each entry with the provenance of the
   * attribution. An author whose lookup fails degrades to its own ID as the name
   * rather than dropping the credit entirely.
   */
  private resolveAuthors(
    authorKeys: string[],
    source: EditionAuthor['source'],
    ctx: Context,
    gate: ConcurrencyGate,
  ): Promise<EditionAuthor[]> {
    return Promise.all(
      authorKeys.map(async (key) => {
        const authorId = stripPrefix(key, '/authors/');
        try {
          const authorRaw = await gate.run(() =>
            this.fetch<{ name?: string }>(`${BASE_URL}/authors/${authorId}.json`, ctx),
          );
          return { name: authorRaw.name ?? authorId, author_id: authorId, source };
        } catch {
          return { name: authorId, author_id: authorId, source };
        }
      }),
    );
  }

  /**
   * Author keys recorded on an edition's parent work. Open Library records
   * authorship at the work level for many editions, so an edition with no
   * `authors` of its own is usually attributed here rather than genuinely
   * anonymous.
   */
  private async workAuthorKeys(
    workKey: string | undefined,
    ctx: Context,
    gate: ConcurrencyGate,
  ): Promise<string[]> {
    if (!workKey) return [];
    const workId = stripPrefix(workKey, '/works/');
    const raw = await gate.run(() =>
      this.fetchOrNull<{ authors?: Array<{ author?: { key?: string } }> }>(
        `${BASE_URL}/works/${workId}.json`,
        ctx,
      ),
    );
    return (raw?.authors ?? [])
      .map((entry) => entry.author?.key)
      .filter((key): key is string => typeof key === 'string');
  }

  /**
   * Maps one `/api/books` `details` payload onto the domain edition shape. The
   * secondary lookups the work-level fallback needs run through `gate`, which is
   * shared across the whole batch.
   */
  private async toEditionDetail(
    d: RawEditionDetails,
    ctx: Context,
    gate: ConcurrencyGate,
  ): Promise<EditionDetail> {
    // This route embeds author names inline; only the work-level fallback needs
    // secondary lookups.
    let authors: EditionAuthor[] = (d.authors ?? []).map((a) => ({
      name: a.name ?? stripPrefix(a.key, '/authors/'),
      author_id: stripPrefix(a.key, '/authors/'),
      source: 'edition',
    }));
    if (authors.length === 0) {
      const workKeys = await this.workAuthorKeys(d.works?.[0]?.key, ctx, gate);
      authors = await this.resolveAuthors(workKeys, 'work', ctx, gate);
    }

    const description = extractDescription(d.description);
    return {
      edition_id: stripPrefix(d.key ?? '', '/books/'),
      title: d.title ?? '',
      authors,
      ...(d.publish_date ? { publish_date: d.publish_date } : {}),
      publishers: d.publishers ?? [],
      ...(d.languages?.[0] ? { language: extractLanguageCode(d.languages[0].key) } : {}),
      isbn_10: d.isbn_10 ?? [],
      isbn_13: d.isbn_13 ?? [],
      oclc: d.oclc_numbers ?? [],
      lccn: d.lccn ?? [],
      lc_classifications: d.lc_classifications ?? [],
      ...(typeof d.number_of_pages === 'number' && { page_count: d.number_of_pages }),
      ...(description !== undefined ? { description } : {}),
      cover_ids: sanitizeImageIds(d.covers),
      ...(d.works?.[0]?.key ? { work_id: stripPrefix(d.works[0].key, '/works/') } : {}),
      ...(d.ocaid ? { ebook_url: `https://archive.org/details/${d.ocaid}` } : {}),
    };
  }

  /**
   * Resolves a batch of identifiers of one type in a single `/api/books` request.
   * All four bibkey prefixes go through this one route: it accepts many keys per
   * call and embeds author names inline, so a list of N identifiers costs one
   * request instead of N lookups plus a secondary lookup per author.
   *
   * Open Library omits an unresolvable bibkey from the response map entirely —
   * no null, no error entry — so a requested key missing from the map is the
   * not-found signal. Those identifiers come back in `unresolved` rather than
   * failing the whole batch; the caller decides whether an empty `editions` is
   * an error.
   *
   * Editions whose authors are only recorded on the parent work still need
   * per-edition lookups. Those share one {@link ConcurrencyGate} across the
   * batch, so a 50-identifier request tapers its follow-up traffic instead of
   * opening a socket per edition and per author credit at once.
   */
  async getEditionsByIdentifiers(
    identifiers: string[],
    idType: EditionIdType,
    ctx: Context,
  ): Promise<{ editions: EditionDetail[]; unresolved: string[] }> {
    // Keep the caller's identifier alongside the key sent upstream: the response
    // is keyed by the bibkey, which differs from the input for a hyphenated ISBN.
    const requested = identifiers.map((identifier) => ({
      identifier,
      bibkey: `${BIBKEY_PREFIX[idType]}:${idType === 'isbn' ? identifier.replace(/-/g, '') : identifier}`,
    }));
    ctx.log.debug('Fetching editions', { idType, count: requested.length });

    const bibkeys = requested.map((r) => r.bibkey).join(',');
    const url = `${BASE_URL}/api/books?bibkeys=${encodeURIComponent(bibkeys)}&format=json&jscmd=details`;
    const rawMap = await this.fetch<Record<string, { details?: RawEditionDetails }>>(url, ctx);

    const gate = new ConcurrencyGate(EDITION_ENRICHMENT_CONCURRENCY);
    const resolved = await Promise.all(
      requested.map(async ({ identifier, bibkey }) => {
        const details = rawMap[bibkey]?.details;
        if (!details?.key) return { identifier, edition: undefined };
        return { identifier, edition: await this.toEditionDetail(details, ctx, gate) };
      }),
    );

    const editions: EditionDetail[] = [];
    const unresolved: string[] = [];
    for (const { identifier, edition } of resolved) {
      if (edition) editions.push(edition);
      else unresolved.push(identifier);
    }
    return { editions, unresolved };
  }

  // ─── Full-text search inside scanned books ────────────────────────────────────

  /**
   * Searches the full text of scanned Internet Archive books. The endpoint is an
   * Elasticsearch passthrough: the item and metadata `fields` arrive as arrays
   * (take `[0]`) while the per-file bookkeeping ones are bare strings, the
   * metadata keys are `meta_`-prefixed, and `_id` is a composite
   * `identifier|sha1` rather than a bare IA identifier. A zero-match query is an
   * HTTP 200 with `hits.total: 0`, not an error.
   */
  async searchInside(
    query: string,
    limit: number,
    offset: number,
    ctx: Context,
  ): Promise<{ total: number; offset: number; matches: InsideMatch[] }> {
    const qs = new URLSearchParams({
      q: query,
      limit: String(limit),
      offset: String(offset),
    });
    const url = `${BASE_URL}/search/inside.json?${qs.toString()}`;
    ctx.log.debug('Searching inside books', { query, limit, offset });

    const raw = await this.fetch<{
      hits?: {
        total?: number;
        hits?: Array<{
          _score?: number;
          fields?: {
            identifier?: string[];
            meta_title?: string[];
            meta_creator?: string[];
          };
          highlight?: { text?: string[] };
        }>;
      };
    }>(url, ctx);

    const matches: InsideMatch[] = [];
    for (const hit of raw.hits?.hits ?? []) {
      // These `fields` values arrive as arrays; the IA identifier is the only
      // join back to the catalogue, so a hit without one is unusable.
      const iaIdentifier = hit.fields?.identifier?.[0];
      if (!iaIdentifier) continue;
      const title = hit.fields?.meta_title?.[0];
      const creator = hit.fields?.meta_creator?.[0];
      matches.push({
        ia_identifier: iaIdentifier,
        ...(title ? { title } : {}),
        ...(creator ? { creator } : {}),
        snippets: (hit.highlight?.text ?? []).map(normalizeHighlight),
        score: hit._score ?? 0,
      });
    }

    return { total: raw.hits?.total ?? 0, offset, matches };
  }

  // ─── Authors ──────────────────────────────────────────────────────────────────

  async searchAuthors(
    query: string,
    limit: number,
    offset: number,
    ctx: Context,
  ): Promise<{ total: number; authors: AuthorSearchResult[] }> {
    const url = `${BASE_URL}/search/authors.json?q=${encodeURIComponent(query)}&limit=${limit}&offset=${offset}`;
    ctx.log.debug('Searching authors', { query, limit, offset });

    const raw = await this.fetch<{
      numFound: number;
      docs: Array<{
        key: string;
        name?: string;
        alternate_names?: string[];
        birth_date?: string;
        death_date?: string;
        top_work?: string;
        work_count?: number;
        top_subjects?: string[];
        ratings_average?: number;
      }>;
    }>(url, ctx);

    return {
      total: raw.numFound,
      authors: raw.docs.map((d) => ({
        author_id: stripPrefix(d.key, '/authors/'),
        name: d.name ?? '',
        alternate_names: d.alternate_names ?? [],
        ...(d.birth_date ? { birth_date: d.birth_date } : {}),
        ...(d.death_date ? { death_date: d.death_date } : {}),
        ...(d.top_work ? { top_work: d.top_work } : {}),
        work_count: d.work_count ?? 0,
        top_subjects: d.top_subjects ?? [],
        ...(typeof d.ratings_average === 'number' && { ratings_average: d.ratings_average }),
      })),
    };
  }

  /**
   * Fetches an author record, following Open Library's merge stubs to the record
   * that actually holds the data.
   *
   * A merged author is not deleted: `/authors/{id}.json` answers 200 with a
   * `/type/redirect` stub naming its successor. The stub carries its own `key`
   * and no `name`, so a caller that only guards on `key` builds a nameless
   * author out of it — which is why this resolution belongs here, below every
   * author-shaped entry point, rather than at each of them.
   *
   * Returns the record together with the ID it was finally found under, which is
   * the canonical one the caller should report back. `null` covers all three
   * dead ends — absent record, malformed stub, chain past
   * {@link MAX_AUTHOR_REDIRECT_HOPS} — so callers keep their single `not_found`
   * path.
   */
  private async fetchAuthorRecord(
    authorId: string,
    ctx: Context,
  ): Promise<{ raw: RawAuthorRecord; canonicalId: string } | null> {
    let id = normalizeAuthorId(authorId);
    // A re-merge can point back at an ID already visited; stopping on a repeat
    // fails a cycle closed immediately instead of burning the whole hop budget.
    const visited = new Set<string>([id]);

    for (let hop = 0; hop <= MAX_AUTHOR_REDIRECT_HOPS; hop++) {
      ctx.log.debug('Fetching author', { authorId: id, hop });
      const raw = await this.fetchOrNull<RawAuthorRecord>(`${BASE_URL}/authors/${id}.json`, ctx);

      if (!raw || raw.error === 'notfound' || !raw.key) return null;
      if (raw.type?.key !== REDIRECT_TYPE_KEY) {
        return { raw, canonicalId: normalizeAuthorId(raw.key) };
      }

      const target = redirectTarget(raw);
      if (!target) {
        ctx.log.warning('Author redirect names no usable target', {
          authorId: id,
          location: raw.location,
        });
        return null;
      }
      if (visited.has(target)) {
        ctx.log.warning('Author redirect chain is circular', { authorId: id, target });
        return null;
      }
      visited.add(target);
      id = target;
    }

    ctx.log.warning('Author redirect chain exceeded the hop cap', {
      authorId: normalizeAuthorId(authorId),
      maxHops: MAX_AUTHOR_REDIRECT_HOPS,
    });
    return null;
  }

  async getAuthor(authorId: string, ctx: Context): Promise<AuthorDetail | null> {
    const resolved = await this.fetchAuthorRecord(authorId, ctx);
    if (!resolved) return null;
    const { raw, canonicalId } = resolved;

    const bio = extractDescription(raw.bio);
    return {
      author_id: canonicalId,
      name: raw.name ?? '',
      ...(raw.personal_name ? { personal_name: raw.personal_name } : {}),
      ...(raw.fuller_name ? { fuller_name: raw.fuller_name } : {}),
      ...(bio !== undefined ? { bio } : {}),
      ...(raw.birth_date ? { birth_date: raw.birth_date } : {}),
      ...(raw.death_date ? { death_date: raw.death_date } : {}),
      photo_ids: sanitizeImageIds(raw.photos),
      remote_ids: {
        ...(raw.remote_ids?.wikidata != null && { wikidata: raw.remote_ids.wikidata }),
        ...(raw.remote_ids?.viaf != null && { viaf: raw.remote_ids.viaf }),
        ...(raw.remote_ids?.isni != null && { isni: raw.remote_ids.isni }),
        ...(raw.remote_ids?.goodreads != null && { goodreads: raw.remote_ids.goodreads }),
        ...(raw.remote_ids?.librarything != null && { librarything: raw.remote_ids.librarything }),
      },
    };
  }

  /**
   * One page of an author's works, or `null` when the subresource reports no
   * record for that ID. Split out so {@link getAuthorWorks} can retry a second
   * ID against it without duplicating the mapping.
   */
  private async fetchAuthorWorksPage(
    id: string,
    limit: number,
    offset: number,
    ctx: Context,
  ): Promise<{ total: number; author_id: string; works: AuthorWork[] } | null> {
    const url = `${BASE_URL}/authors/${id}/works.json?limit=${limit}&offset=${offset}`;
    ctx.log.debug('Fetching author works', { authorId: id, limit, offset });

    const raw = await this.fetchOrNull<{
      size?: number;
      entries?: Array<{
        key: string;
        title?: string;
        first_publish_date?: string;
        covers?: number[];
      }>;
    }>(url, ctx);

    // A 404 maps to null via fetchOrNull; an empty {} 200 carries neither field.
    if (!raw || (raw.size === undefined && raw.entries === undefined)) return null;

    return {
      total: raw.size ?? 0,
      author_id: id,
      works: (raw.entries ?? []).map((e) => ({
        work_id: stripPrefix(e.key ?? '', '/works/'),
        title: e.title ?? '',
        ...(e.first_publish_date ? { first_publish_date: e.first_publish_date } : {}),
        cover_ids: sanitizeImageIds(e.covers),
      })),
    };
  }

  /**
   * Works by an author, following a merge redirect when the ID has one.
   *
   * The works subresource of a merged author 404s even though the author record
   * itself answers 200, so a null page is ambiguous between "no such author" and
   * "this ID was merged away". Only that path pays for the author lookup that
   * tells the two apart — a live author costs exactly one request, as before.
   *
   * The returned `author_id` is the ID the works were actually found under, so a
   * caller that followed a redirect learns the stable ID to use from here on.
   */
  async getAuthorWorks(
    authorId: string,
    limit: number,
    offset: number,
    ctx: Context,
  ): Promise<{ total: number; author_id: string; works: AuthorWork[] } | null> {
    const id = normalizeAuthorId(authorId);

    const direct = await this.fetchAuthorWorksPage(id, limit, offset, ctx);
    if (direct) return direct;

    const resolved = await this.fetchAuthorRecord(id, ctx);
    // Same ID back means the author resolves but genuinely has no works
    // subresource — retrying it would just repeat the request that returned null.
    if (!resolved || resolved.canonicalId === id) return null;

    ctx.log.info('Following author merge redirect for works', {
      requested: id,
      canonical: resolved.canonicalId,
    });
    return this.fetchAuthorWorksPage(resolved.canonicalId, limit, offset, ctx);
  }

  // ─── Subjects ─────────────────────────────────────────────────────────────────

  /**
   * Fetches a subject page. Open Library answers any subject key with HTTP 200,
   * echoing the requested key back as `name` with `work_count: 0` and no works,
   * so an unknown subject is an empty result rather than an absent record — this
   * never resolves to `null`, and callers have no not-found path to take.
   */
  async getSubject(
    subject: string,
    limit: number,
    offset: number,
    ctx: Context,
  ): Promise<{
    subject_name: string;
    subject_key: string;
    work_count: number;
    works: SubjectWork[];
  }> {
    const subjectKey = subject.toLowerCase().replace(/\s+/g, '_');
    const qs = new URLSearchParams({
      limit: String(limit),
      offset: String(offset),
    });
    const url = `${BASE_URL}/subjects/${encodeURIComponent(subjectKey)}.json?${qs.toString()}`;
    ctx.log.debug('Fetching subject', { subjectKey, limit, offset });

    const raw = await this.fetch<{
      name?: string;
      key?: string;
      work_count?: number;
      works?: Array<{
        key: string;
        title?: string;
        authors?: Array<{ name: string }>;
        edition_count?: number;
        cover_id?: number;
      }>;
    }>(url, ctx);

    return {
      subject_name: raw.name ?? subject,
      subject_key: subjectKey,
      work_count: raw.work_count ?? 0,
      works: (raw.works ?? []).map((w) => ({
        work_id: stripPrefix(w.key ?? '', '/works/'),
        title: w.title ?? '',
        author_names: (w.authors ?? []).map((a) => a.name),
        edition_count: w.edition_count ?? 0,
        ...(typeof w.cover_id === 'number' && { cover_id: w.cover_id }),
      })),
    };
  }

  // ─── Covers ───────────────────────────────────────────────────────────────────

  getCoverUrl(
    identifier: string,
    idType: 'id' | 'isbn' | 'olid',
    target: 'book' | 'author',
    size: 'S' | 'M' | 'L',
  ): string {
    // Enforcement seam: never interpolate an identifier that could escape its
    // path segment, and never build a nonsensical author-by-ISBN lookup. The
    // tool surfaces these as typed ctx.fail rejections; this guards direct calls.
    if (isUnsafeCoverIdentifier(identifier)) {
      throw validationError(
        `Cover identifier "${identifier}" contains path separators or control characters.`,
        { reason: 'invalid_identifier' },
      );
    }
    if (target === 'author' && idType === 'isbn') {
      throw validationError('Author photos cannot be looked up by ISBN.', {
        reason: 'invalid_target',
      });
    }
    const expected = coverIdentifierExpectation(identifier, idType, target);
    if (expected) {
      throw validationError(`Cover identifier "${identifier}" is not ${expected}.`, {
        reason: 'invalid_identifier',
      });
    }
    const prefix = target === 'author' ? 'a' : 'b';
    const clean = idType === 'isbn' ? identifier.replace(/-/g, '') : identifier;
    return `${COVERS_URL}/${prefix}/${idType}/${clean}-${size}.jpg`;
  }
}

// ─── Init / Accessor ──────────────────────────────────────────────────────────

let _service: OpenLibraryService | undefined;

export function initOpenLibraryService(): void {
  const { userAgent } = getServerConfig();
  _service = new OpenLibraryService(userAgent);
}

export function getOpenLibraryService(): OpenLibraryService {
  if (!_service) {
    throw new Error(
      'OpenLibraryService not initialized — call initOpenLibraryService() in setup()',
    );
  }
  return _service;
}
