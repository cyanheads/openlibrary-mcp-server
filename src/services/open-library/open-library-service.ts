/**
 * @fileoverview Open Library REST API client. Handles search, works, editions, authors,
 * subjects, and cover URL construction with retry and timeout.
 * @module services/open-library/open-library-service
 */

import { type Context, z } from '@cyanheads/mcp-ts-core';
import {
  McpError,
  serviceUnavailable,
  timeout,
  validationError,
} from '@cyanheads/mcp-ts-core/errors';
import { defaultIsTransient, fetchWithTimeout, withRetry } from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig } from '@/config/server-config.js';
import { normalizeLanguageCode } from './language-codes.js';
import { bookSearchCriteria } from './search-criteria.js';
import type {
  AuthorDetail,
  AuthorLookupGaps,
  AuthorSearchResult,
  AuthorWork,
  EditionAuthor,
  EditionContributor,
  EditionCredits,
  EditionDetail,
  EditionIdType,
  EditionSummary,
  InsideMatch,
  ResolvedEdition,
  SearchWork,
  SubjectWork,
  WorkAvailability,
  WorkDetail,
} from './types.js';

const BASE_URL = 'https://openlibrary.org';
const COVERS_URL = 'https://covers.openlibrary.org';

/**
 * The latency classes Open Library's endpoints fall into: by-ID record lookups
 * (`/works`, `/authors`, `/books`, `/api/books.json`, editions and author-works
 * lists), Solr-backed searches (`/search.json`, `/search/authors.json`,
 * `/subjects`), and the full-text index behind `/search/inside.json`.
 */
type EndpointClass = 'record' | 'search' | 'fulltext';

/**
 * Per-attempt timeout for each endpoint class. Each sits well above what a
 * healthy upstream takes — record lookups answer in under 5 s, Solr searches
 * occasionally spike past 20 s, and full-text searches usually take 10–30 s —
 * so a slow answer is waited for instead of being abandoned and re-issued.
 */
export const ATTEMPT_TIMEOUT_MS: Readonly<Record<EndpointClass, number>> = {
  record: 10_000,
  search: 30_000,
  fulltext: 45_000,
};

/**
 * Wall-clock budget for one request's whole retry ladder — every attempt, every
 * backoff, every honored `Retry-After`. It sits under the 60 s default request
 * timeout of MCP SDK clients, so a failing upstream reaches the caller as this
 * server's classified error rather than as the client giving up. An edition
 * batch spends one such budget across its bibkeys request and every author
 * lookup it fans out, and a work or author lookup across every merge-redirect
 * hop and the list page it re-fetches under the canonical ID.
 */
export const RETRY_DEADLINE_MS = 50_000;

/** `data.errorSource` on the error {@link OpenLibraryService.fetch} raises for a 2xx HTML page. */
const HTML_BODY_ERROR_SOURCE = 'UpstreamHtmlBody';

/** `data.errorSource` on the error {@link OpenLibraryService.fetch} raises for a 2xx body that is neither JSON nor HTML. */
const NON_JSON_BODY_ERROR_SOURCE = 'UpstreamNonJsonBody';

/**
 * Gateway statuses Open Library's front end answers with when its backends are
 * saturated or down (HAProxy's `No server is available` page is a 503).
 */
const GATEWAY_FAILURE_STATUSES: ReadonlySet<number> = new Set([502, 503, 504]);

/**
 * The retry predicate for one ladder, composed over the framework default.
 *
 * A gateway failure or an HTML page in place of JSON says the upstream is
 * saturated or down, and re-sending the request within seconds adds load
 * without changing the answer — so the ladder ends there. The error keeps its
 * `ServiceUnavailable` / `Timeout` code and no `data.retryable: false`, because
 * retrying later is still the caller's right move. A full-text timeout ends the
 * ladder too: that attempt already spent most of the deadline, and a re-issue
 * re-runs the most expensive query the upstream serves. Everything else keeps
 * the framework's classification — a 429 honoring its `Retry-After`, a network
 * failure, a timed-out record or search attempt, and a truncated or other
 * non-JSON body all retry within the deadline.
 */
function isTransientFor(endpointClass: EndpointClass): (error: unknown) => boolean {
  return (error) => {
    if (error instanceof McpError) {
      const status = error.data?.status;
      const errorSource = error.data?.errorSource;
      if (typeof status === 'number' && GATEWAY_FAILURE_STATUSES.has(status)) return false;
      if (errorSource === HTML_BODY_ERROR_SOURCE) return false;
      if (endpointClass === 'fulltext' && errorSource === 'FetchTimeout') return false;
    }
    return defaultIsTransient(error);
  };
}

/**
 * True when an error from the bibkeys route is an upstream fault rather than an
 * answer. That route reports an unknown identifier by omitting its key from a
 * 200 map — it never 404s for a missing edition — so any HTTP error status is a
 * fault, as is an HTML page or any other body that is not JSON. A 429 is the
 * exception: it stays `RateLimited`, carrying the `Retry-After` the caller
 * should wait out.
 */
function isBibkeysRouteFault(error: unknown): error is McpError {
  if (!(error instanceof McpError)) return false;
  const status = error.data?.status;
  if (typeof status === 'number') return status !== 429;
  const errorSource = error.data?.errorSource;
  return errorSource === HTML_BODY_ERROR_SOURCE || errorSource === NON_JSON_BODY_ERROR_SOURCE;
}

/** Bibkey prefix `/api/books.json` expects for each identifier type. */
const BIBKEY_PREFIX: Record<EditionIdType, string> = {
  isbn: 'ISBN',
  oclc: 'OCLC',
  lccn: 'LCCN',
  olid: 'OLID',
};

/**
 * True when `identifier` is an ISBN-10 or ISBN-13 once hyphens are stripped. An
 * ISBN-10 check digit can be `X` (the value 10), in either case.
 *
 * Exported so the edition and cover tools check one rule rather than two copies
 * of it.
 */
export function isIsbn(identifier: string): boolean {
  const compact = identifier.replace(/-/g, '');
  return /^\d{9}[\dXx]$/.test(compact) || /^\d{13}$/.test(compact);
}

/** An ISBN in the form Open Library keys it by: hyphens stripped, an `x` check digit upper-cased. */
function canonicalIsbn(identifier: string): string {
  return identifier.replace(/-/g, '').toUpperCase();
}

/**
 * How many enrichment requests one identifier batch may have in flight against
 * openlibrary.org at once. `/api/books.json` resolves the whole batch in a
 * single request, but an edition carrying no inline authors still costs a work
 * lookup plus one lookup per author credit — at the 50-identifier cap that is
 * well over a hundred requests, and ungated they would all open at once. Open
 * Library is volunteer-run infrastructure, so the batch trickles them through
 * instead.
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

/** How one gated best-effort lookup ended. */
type LookupOutcome<T> = { status: 'ok'; value: T } | { status: 'failed' | 'skipped' };

/**
 * Per-batch state for a fan-out of secondary lookups (an edition batch's author
 * lookups, a search page's availability lookups): the concurrency gate, whether a
 * lookup has failed yet, and the batch's share of the call's time budget.
 *
 * The lookups are best-effort. A failed lookup degrades its own results instead
 * of failing the call, and once one has failed, every lookup not yet started is
 * skipped — a failure mid-batch almost always means the upstream is struggling,
 * and dozens more requests would only wait out the same fault one ladder at a
 * time. Lookups already in flight finish normally. A lookup that would start with
 * nothing left of `deadlineAt` is skipped too, so the whole call ends inside one
 * {@link RETRY_DEADLINE_MS}.
 *
 * A caller that cancels is never absorbed as a failure: its abort propagates.
 */
class BestEffortBatch {
  private readonly gate: ConcurrencyGate;
  private readonly deadlineAt: number;
  private readonly ctx: Context;
  private readonly failureMessage: string;
  private failed = false;

  constructor(options: {
    concurrency: number;
    deadlineAt: number;
    ctx: Context;
    /** The warning logged when a lookup fails. */
    failureMessage: string;
  }) {
    this.gate = new ConcurrencyGate(options.concurrency);
    this.deadlineAt = options.deadlineAt;
    this.ctx = options.ctx;
    this.failureMessage = options.failureMessage;
  }

  run<T>(
    lookup: (deadlineAt: number) => Promise<T>,
    logFields: Record<string, unknown> = {},
  ): Promise<LookupOutcome<T>> {
    return this.gate.run(async (): Promise<LookupOutcome<T>> => {
      if (this.failed || Date.now() >= this.deadlineAt) return { status: 'skipped' };
      try {
        return { status: 'ok', value: await lookup(this.deadlineAt) };
      } catch (err) {
        if (this.ctx.signal.aborted) throw err;
        this.failed = true;
        this.ctx.log.warning(this.failureMessage, {
          ...logFields,
          error: err instanceof Error ? err.message : String(err),
        });
        return { status: 'failed' };
      }
    });
  }
}

/** How an edition's author enrichment fell short, when it did. */
type AuthorLookupGap = keyof AuthorLookupGaps;

/** `'failed'` when any lookup failed, else `'skipped'` when any was skipped. */
function worstGap(statuses: Array<LookupOutcome<unknown>['status']>): AuthorLookupGap | undefined {
  if (statuses.includes('failed')) return 'failed';
  if (statuses.includes('skipped')) return 'skipped';
  return;
}

/**
 * The credit fields an edition record carries, identical on `editions.json`
 * entries and `/api/books.json` details. Untrusted shapes, checked by
 * {@link editionCredits}.
 */
type RawEditionCredits = {
  subtitle?: unknown;
  by_statement?: unknown;
  contributors?: unknown;
  contributions?: unknown;
  translated_from?: unknown;
};

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/** An upstream array's entries, or none when the field is not an array. */
function arrayEntries(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/**
 * Maps an edition's title and credit fields verbatim — one mapping for both
 * edition routes, so the list and the detail carry the same values. Each field
 * is omitted when missing, null, empty, or left empty once unusable entries are
 * skipped: a contributor needs a nonempty `name` (a missing or empty `role` is
 * left off the entry), a `translated_from` entry needs a `key`, and a legacy
 * credit must be a nonempty string. Legacy credits are never parsed for names
 * or roles.
 */
function editionCredits(raw: RawEditionCredits): EditionCredits {
  const contributors = arrayEntries(raw.contributors).flatMap((entry): EditionContributor[] => {
    if (typeof entry !== 'object' || entry === null) return [];
    const { name, role } = entry as { name?: unknown; role?: unknown };
    if (!isNonEmptyString(name)) return [];
    return [isNonEmptyString(role) ? { name, role } : { name }];
  });
  const contributions = arrayEntries(raw.contributions).filter(isNonEmptyString);
  const translatedFrom = arrayEntries(raw.translated_from).flatMap((entry) => {
    if (typeof entry !== 'object' || entry === null) return [];
    const { key } = entry as { key?: unknown };
    return isNonEmptyString(key) ? [extractLanguageCode(key)] : [];
  });
  return {
    ...(isNonEmptyString(raw.subtitle) ? { subtitle: raw.subtitle } : {}),
    ...(isNonEmptyString(raw.by_statement) ? { by_statement: raw.by_statement } : {}),
    ...(contributors.length ? { contributors } : {}),
    ...(contributions.length ? { contributions } : {}),
    ...(translatedFrom.length ? { translated_from: translatedFrom } : {}),
  };
}

/** The `details` payload `/api/books.json?jscmd=details` returns per resolved bibkey. */
type RawEditionDetails = RawEditionCredits & {
  key?: string;
  title?: string;
  authors?: Array<{ key: string; name?: string }>;
  publish_date?: string;
  physical_format?: unknown;
  edition_name?: unknown;
  publishers?: string[];
  languages?: Array<{ key: string }>;
  isbn_10?: string[];
  isbn_13?: string[];
  oclc_numbers?: string[] | null;
  oclc_number?: string[] | null;
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

/** Sparse edition metadata nested under search work records. */
const searchEditionsSchema = z.object({
  numFound: z.number().int().nonnegative().optional().catch(undefined),
  docs: z
    .array(
      z.object({
        key: z.string().optional().catch(undefined),
        title: z.string().optional().catch(undefined),
        language: z.array(z.string()).optional().catch(undefined),
        publisher: z.array(z.string()).optional().catch(undefined),
      }),
    )
    .optional()
    .catch(undefined),
});

/** Only validation messages cross the search error boundary; upstream input and bodies stay private. */
const searchValidationSchema = z.object({
  detail: z.array(z.object({ msg: z.string().min(1) })).min(1),
});

/** Parses the framework's captured HTTP error body without exposing malformed or unrelated fields. */
function searchValidationMessages(body: unknown): string[] | undefined {
  if (typeof body !== 'string') return;
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return;
  }
  const parsed = searchValidationSchema.safeParse(value);
  return parsed.success ? parsed.data.detail.map((detail) => detail.msg) : undefined;
}

/** Projects the provider's first ranked edition and independent matching count. */
function matchingEdition(
  raw: unknown,
): Pick<SearchWork, 'matching_edition' | 'matching_edition_count'> {
  const parsed = searchEditionsSchema.safeParse(raw);
  if (!parsed.success) return {};
  const selected = parsed.data.docs?.[0];
  const editionId = selected?.key ? stripPrefix(selected.key, '/books/') : '';
  return {
    ...(parsed.data.numFound !== undefined ? { matching_edition_count: parsed.data.numFound } : {}),
    ...(selected && editionId
      ? {
          matching_edition: {
            edition_id: editionId,
            ...(selected.title !== undefined ? { title: selected.title } : {}),
            ...(selected.language !== undefined ? { languages: selected.language } : {}),
            ...(selected.publisher !== undefined ? { publishers: selected.publisher } : {}),
          },
        }
      : {}),
  };
}

/** An author OLID in any case. */
const AUTHOR_OLID = /^OL\d+A$/i;

/** A work OLID in any case. */
const WORK_OLID = /^OL\d+W$/i;

/**
 * Upper-cases `id` when it has `shape`, the OLID shape of one record kind. Open
 * Library's by-ID routes and the Covers API answer only the upper-case form
 * (`/authors/ol31353a.json` 404s), while every other string passes through as
 * supplied, so the permissive ID inputs keep their spelling.
 */
function canonicalOlid(id: string, shape: RegExp): string {
  return shape.test(id) ? id.toUpperCase() : id;
}

/**
 * Normalizes an author identifier to its bare OLID form ("/authors/ol24638a" →
 * "OL24638A"). An ID that is not shaped like an author OLID keeps its spelling.
 */
export function normalizeAuthorId(authorId: string): string {
  return canonicalOlid(stripPrefix(authorId, '/authors/'), AUTHOR_OLID);
}

/**
 * Normalizes a work identifier to its bare OLID form ("/works/ol45804w" →
 * "OL45804W"). An ID that is not shaped like a work OLID keeps its spelling.
 */
export function normalizeWorkId(workId: string): string {
  return canonicalOlid(stripPrefix(workId, '/works/'), WORK_OLID);
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

/** The seven availability flags the output schema carries. */
const AVAILABILITY_FLAGS = [
  'available_to_browse',
  'available_to_borrow',
  'available_to_waitlist',
  'is_readable',
  'is_lendable',
  'is_previewable',
  'is_restricted',
] as const satisfies ReadonlyArray<keyof WorkAvailability>;

/**
 * Builds {@link WorkAvailability} from the Internet Archive lending payload the
 * search index attaches to a work. The payload is undocumented and sparse:
 * Open Library nulls five of the flags on some freely readable works, sends a
 * `status: "error"` object when the lending lookup itself failed, and nulls
 * `openlibrary_edition` on others. So only known keys are copied, and each only
 * when it carries its expected type — a null or absent flag is omitted, never
 * defaulted, because `false` would contradict a `status: "open"` work.
 *
 * An `"error"` status keeps nothing but the status: the lookup failed, so the
 * flags riding along with it are placeholders rather than facts. A missing or
 * non-string status reads `"unknown"`, and a value that is not an object at all
 * is treated as no availability returned.
 */
function toWorkAvailability(raw: unknown): WorkAvailability | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const status = typeof record.status === 'string' ? record.status : 'unknown';
  if (status === 'error') return { status };

  const availability: WorkAvailability = { status };
  for (const flag of AVAILABILITY_FLAGS) {
    const value = record[flag];
    if (typeof value === 'boolean') availability[flag] = value;
  }
  if (typeof record.openlibrary_edition === 'string') {
    availability.openlibrary_edition = record.openlibrary_edition;
  }
  return availability;
}

/**
 * Most work keys one availability lookup names. A 100-key lookup's URL runs to
 * about 3.3 KB, well inside what Open Library's front end accepts, and a
 * full 1000-row page then costs at most ten lookups.
 */
const AVAILABILITY_LOOKUP_KEYS = 100;

/**
 * How many availability lookups one search has in flight at once. Each makes
 * Open Library ask the Internet Archive about up to 100 items, so a full page's
 * lookups are trickled through rather than issued in one tick; three at a time
 * finish a full page's lookups in under half the time they take one after
 * another.
 */
const AVAILABILITY_LOOKUP_CONCURRENCY = 3;

/**
 * Pause before re-asking about works the Internet Archive gave no answer for. Its availability
 * service fails in bursts: in November 2026 sampling an immediate re-ask recovered none of the
 * failed batches it repeated, while the same keys asked again seconds later answered in full.
 */
const AVAILABILITY_REASK_DELAY_MS = 2000;

/** Resolves after `ms`, or rejects with the signal's reason as soon as it aborts. */
function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * A keyed availability lookup's answer: each matched work's key and lending
 * payload. `availability` is left out for a work with no scan the Internet
 * Archive lends and `null` when the Internet Archive gave no answer, so absent
 * and `null` stay distinct.
 */
const availabilityLookupSchema = z.object({
  docs: z.array(z.object({ key: z.string(), availability: z.unknown().optional() })),
});

/**
 * An edition's OCLC numbers from both keys Open Library files them under. Most
 * records use `oclc_numbers`; some carry the singular `oclc_number` instead,
 * with `oclc_numbers` null. The values merge in the order the record lists the
 * two keys, de-duplicated.
 */
function mergeOclcNumbers(details: RawEditionDetails): string[] {
  const merged = new Set<string>();
  for (const [key, value] of Object.entries(details)) {
    if ((key !== 'oclc_numbers' && key !== 'oclc_number') || !Array.isArray(value)) continue;
    for (const oclc of value) {
      if (typeof oclc === 'string') merged.add(oclc);
    }
  }
  return [...merged];
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

/**
 * How many `/type/redirect` hops a work lookup will follow before giving up.
 * Open Library does not rewrite older stubs when a work is merged again, so
 * work chains form too — `OL5687942W` sits three hops from the record holding
 * its data. Same cap and reasoning as {@link MAX_AUTHOR_REDIRECT_HOPS}.
 */
export const MAX_WORK_REDIRECT_HOPS = 4;

/** The `/type/*` key Open Library stamps on a merged-away record's stub. */
const REDIRECT_TYPE_KEY = '/type/redirect';

/**
 * The fields merge-redirect resolution reads from a by-ID record. A merge stub
 * carries `key`, `type`, and `location` and nothing else of note. `location`
 * alone says nothing — a live author carries `"location": null`, a live work
 * no `location` key at all — so `type.key` is the only honest discriminator.
 */
type RawMergeable = {
  key?: string;
  type?: { key?: string };
  location?: unknown;
  error?: string;
};

/** The author record as Open Library returns it. */
type RawAuthorRecord = RawMergeable & {
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
};

/** The work record as Open Library returns it. */
type RawWorkRecord = RawMergeable & {
  title?: string;
  description?: unknown;
  subjects?: string[];
  subject_places?: string[];
  subject_times?: string[];
  subject_people?: string[];
  covers?: number[];
  authors?: Array<{ author?: { key?: string } }>;
  created?: { value: string };
  last_modified?: { value: string };
};

/** How {@link OpenLibraryService.followMergeRedirects} walks one record kind's chain. */
type MergeChain = {
  label: 'Work' | 'Author';
  /** Path the records live under, and the prefix stripped from their keys. */
  prefix: '/works/' | '/authors/';
  /** Brings a requested ID to the form the record kind's routes answer. */
  normalize: (id: string) => string;
  maxHops: number;
  /**
   * The shape a stub's `location` must have, prefix stripped, to be followed. A
   * stub naming anything else — absent, null, empty, another record kind — is
   * malformed, and resolution stops rather than fetching a path that cannot
   * hold the record.
   */
  targetPattern: RegExp;
  /**
   * The `/type/*` a record must carry to be returned. Open Library 301s a by-ID
   * URL naming another record kind — `/works/OL…M.json`, `/authors/OL…W.json` —
   * to that record, and native fetch follows the 301, so a 200 under `/works/`
   * or `/authors/` is not proof of a work or an author.
   */
  recordType: '/type/work' | '/type/author';
};

const AUTHOR_MERGES: MergeChain = {
  label: 'Author',
  prefix: '/authors/',
  normalize: normalizeAuthorId,
  maxHops: MAX_AUTHOR_REDIRECT_HOPS,
  targetPattern: AUTHOR_OLID,
  recordType: '/type/author',
};

const WORK_MERGES: MergeChain = {
  label: 'Work',
  prefix: '/works/',
  normalize: normalizeWorkId,
  maxHops: MAX_WORK_REDIRECT_HOPS,
  targetPattern: /^OL\d+W$/,
  recordType: '/type/work',
};

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
    return isIsbn(identifier)
      ? undefined
      : 'an ISBN of 10 or 13 digits, hyphens optional, where an ISBN-10 may end in an X check digit (e.g., 9780743273565 or 080442957X)';
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

  /**
   * Fetches and parses JSON under the retry policy for `endpointClass`: each
   * attempt is capped at the class timeout and at what is left of the ladder's
   * deadline (`deadlineMs`, default {@link RETRY_DEADLINE_MS}), and the attempt's
   * signal carries both that deadline and the caller's cancellation into the
   * request. {@link isTransientFor} decides which failures earn another attempt.
   */
  private fetch<T>(
    url: string,
    ctx: Context,
    endpointClass: EndpointClass,
    options: { expectedStatuses?: number[]; deadlineMs?: number } = {},
  ): Promise<T> {
    return withRetry(
      async ({ signal, remainingMs }) => {
        const timeoutMs = Math.min(ATTEMPT_TIMEOUT_MS[endpointClass], remainingMs);
        const response = await fetchWithTimeout(url, timeoutMs, ctx, {
          headers: this.headers(),
          signal,
          ...(options.expectedStatuses ? { expectedStatuses: options.expectedStatuses } : {}),
        });
        const text = await response.text();
        if (/^\s*<(!DOCTYPE\s+html|html[\s>])/i.test(text)) {
          throw serviceUnavailable(
            'Open Library returned an HTML page instead of JSON — the service is degraded or under maintenance.',
            { errorSource: HTML_BODY_ERROR_SOURCE },
          );
        }
        // A raw SyntaxError would reach the caller classified as their ValidationError.
        try {
          return JSON.parse(text) as T;
        } catch (cause) {
          throw serviceUnavailable(
            'Open Library answered with a body that is not JSON.',
            { errorSource: NON_JSON_BODY_ERROR_SOURCE },
            { cause },
          );
        }
      },
      {
        operation: 'OpenLibrary.fetch',
        context: ctx,
        baseDelayMs: 1000,
        signal: ctx.signal,
        deadlineMs: options.deadlineMs ?? RETRY_DEADLINE_MS,
        isTransient: isTransientFor(endpointClass),
      },
    );
  }

  /**
   * Fetches a by-ID record like {@link fetch}, but resolves to `null` when the
   * upstream returns HTTP 404 instead of throwing. Open Library 404s on missing
   * by-ID records, so mapping that to `null` revives each caller's own
   * `not_found` path — their `ctx.fail('not_found', …)` / `notFound()` with
   * tool-specific recovery — instead of leaking the raw status-mapped fetch
   * error. A 404 is an outcome here, not a failure, so it is declared expected
   * and logs at `debug` rather than `error`.
   *
   * The retry ladder gets only what is left until `deadlineAt`, so a caller
   * chaining several lookups keeps them all inside the one budget it started.
   * With nothing left, no request is sent: the call fails with the same
   * `retry_deadline_exceeded` timeout a ladder running out produces, since
   * `withRetry` would otherwise issue one attempt before its 0 ms timer fired.
   */
  private async fetchOrNull<T>(url: string, ctx: Context, deadlineAt: number): Promise<T | null> {
    const remainingMs = deadlineAt - Date.now();
    if (remainingMs <= 0) {
      throw timeout(
        `OpenLibrary.fetch exceeded its ${RETRY_DEADLINE_MS}ms call deadline before a follow-up request could start.`,
        { reason: 'retry_deadline_exceeded', deadlineMs: RETRY_DEADLINE_MS },
      );
    }
    try {
      return await this.fetch<T>(url, ctx, 'record', {
        expectedStatuses: [404],
        deadlineMs: remainingMs,
      });
    } catch (err) {
      if (isUpstreamNotFound(err)) return null;
      throw err;
    }
  }

  /**
   * Fetches a by-ID record, following Open Library's merge stubs to the record
   * that holds the data.
   *
   * A merged record is not deleted: its URL answers 200 with a `/type/redirect`
   * stub naming its successor, and the stub carries its own `key` and none of
   * the data — so a caller that only guards on `key` would build a hollow
   * record out of it. An already-merged record can be merged again, so the
   * target is itself sometimes a stub; the chain is followed up to
   * `chain.maxHops`, which bounds upstream-controlled data that could otherwise
   * cycle or run on indefinitely.
   *
   * Returns the record together with the ID it was finally found under — the
   * canonical one the caller should report back. `null` covers every dead end —
   * absent record, record of the wrong type, malformed stub, cycle, chain past
   * the cap — so callers keep their single `not_found` path. Every hop runs
   * against `deadlineAt`, so a whole chain ends inside the one budget its
   * caller started.
   */
  private async followMergeRedirects<R extends RawMergeable>(
    chain: MergeChain,
    requestedId: string,
    ctx: Context,
    deadlineAt: number,
  ): Promise<{ raw: R; canonicalId: string } | null> {
    const idKey = `${chain.label.toLowerCase()}Id`;
    let id = chain.normalize(requestedId);
    if (chain.prefix === '/authors/' && id.length === 0) return null;
    // A re-merge can point back at an ID already visited; stopping on a repeat
    // fails a cycle closed immediately instead of burning the whole hop budget.
    const visited = new Set<string>([id]);

    for (let hop = 0; hop <= chain.maxHops; hop++) {
      ctx.log.debug(`Fetching ${chain.label.toLowerCase()}`, { [idKey]: id, hop });
      const raw = await this.fetchOrNull<R>(
        `${BASE_URL}${chain.prefix}${id}.json`,
        ctx,
        deadlineAt,
      );
      if (!raw?.key || raw.error === 'notfound') return null;

      const type = raw.type?.key;
      if (type !== REDIRECT_TYPE_KEY) {
        if (type === chain.recordType) {
          return { raw, canonicalId: stripPrefix(raw.key, chain.prefix) };
        }
        ctx.log.debug(`${chain.label} lookup answered with a record of another type`, {
          [idKey]: id,
          type,
        });
        return null;
      }

      const target =
        typeof raw.location === 'string' ? stripPrefix(raw.location.trim(), chain.prefix) : '';
      if (!chain.targetPattern.test(target)) {
        ctx.log.warning(`${chain.label} redirect names no usable target`, {
          [idKey]: id,
          location: raw.location,
        });
        return null;
      }
      if (visited.has(target)) {
        ctx.log.warning(`${chain.label} redirect chain is circular`, { [idKey]: id, target });
        return null;
      }
      visited.add(target);
      id = target;
    }

    ctx.log.warning(`${chain.label} redirect chain exceeded the hop cap`, {
      [idKey]: chain.normalize(requestedId),
      maxHops: chain.maxHops,
    });
    return null;
  }

  // ─── Search ───────────────────────────────────────────────────────────────────

  /**
   * One page of works. With `include_availability`, keyed lookups after the page
   * request read each work's availability; `availabilityUnknown` names, in page
   * order, the works whose lookup failed, ran out of time, or came back without
   * an Internet Archive answer, so their `null` is not "none returned".
   */
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
  ): Promise<{
    total: number;
    offset: number;
    works: SearchWork[];
    availabilityUnknown?: string[];
  }> {
    const qs = new URLSearchParams();

    // A blank criterion is absent: upstream answers a whitespace-only one with HTTP 500.
    const criteria = bookSearchCriteria(params);
    if (criteria.query !== undefined) qs.set('q', criteria.query);
    if (criteria.title !== undefined) qs.set('title', criteria.title);
    if (criteria.author !== undefined) qs.set('author', criteria.author);
    if (criteria.subject !== undefined) qs.set('subject', criteria.subject);
    if (criteria.publisher !== undefined) qs.set('publisher', criteria.publisher);
    if (criteria.isbn !== undefined) qs.set('isbn', criteria.isbn.replace(/-/g, ''));
    // `language=` is the result filter and takes 3-letter MARC codes; `lang=` is
    // Open Library's UI-language parameter and filters nothing.
    if (params.language) qs.set('language', normalizeLanguageCode(params.language));
    if (params.sort && params.sort !== 'relevance') {
      qs.set('sort', params.sort);
    }

    qs.set('limit', String(params.limit));
    qs.set('offset', String(params.offset));

    // No `availability` here: with `editions` in the field list Open Library
    // attaches it to the selected edition instead of the work, so work-level
    // availability comes from a keyed lookup after this request.
    qs.set(
      'fields',
      'key,title,author_name,author_key,first_publish_year,edition_count,cover_i,subject,ebook_access,has_fulltext,ratings_average,ia,editions,editions.key,editions.title,editions.language,editions.publisher',
    );

    const url = `${BASE_URL}/search.json?${qs.toString()}`;
    ctx.log.debug('Searching books', { url });

    // The page request's ladder starts now with the full budget, so this is its
    // deadline too; the availability lookups get what it leaves.
    const deadlineAt = Date.now() + RETRY_DEADLINE_MS;
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
        ia?: string[];
        editions?: unknown;
      }>;
    }>(url, ctx, 'search').catch((error: unknown) => {
      if (ctx.signal.aborted || !(error instanceof McpError) || error.data?.status !== 422) {
        throw error;
      }
      const messages = searchValidationMessages(error.data.body);
      throw validationError(
        messages
          ? `Open Library rejected this search: ${messages.join('; ')}`
          : 'Open Library rejected this search query or its filters.',
        {
          reason: 'invalid_search_query',
          status: 422,
          ...(messages ? { validation_messages: messages } : {}),
        },
      );
    });

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
        // Both response surfaces preserve every subject tag the index returned.
        ...(doc.subject?.length ? { subjects: doc.subject } : {}),
        ebook_access: ebookAccess,
        has_fulltext: doc.has_fulltext ?? false,
        ...(typeof doc.ratings_average === 'number' && { ratings_average: doc.ratings_average }),
        ia_identifiers: doc.ia ?? [],
        ...matchingEdition(doc.editions),
      };
    });

    if (!params.include_availability) return { total: raw.numFound, offset: raw.start, works };

    // Only a work with an IA item can have availability, and only an OLID-shaped
    // key is spliced into the lookup's quoted query.
    const { found, unknown } = await this.lookupAvailability(
      works
        .filter((work) => work.ia_identifiers.length > 0 && WORK_OLID.test(work.work_id))
        .map((work) => work.work_id),
      ctx,
      deadlineAt,
    );
    for (const work of works) work.availability = toWorkAvailability(found.get(work.work_id));
    const availabilityUnknown = works
      .filter((work) => unknown.has(work.work_id))
      .map((work) => work.work_id);

    return {
      total: raw.numFound,
      offset: raw.start,
      works,
      ...(availabilityUnknown.length > 0 && { availabilityUnknown }),
    };
  }

  /**
   * Reads work-level availability for `workIds` through keyed `/search.json`
   * lookups — `q=key:("/works/OL…W" OR …)`, at most
   * {@link AVAILABILITY_LOOKUP_KEYS} works each, run
   * {@link AVAILABILITY_LOOKUP_CONCURRENCY} at a time.
   *
   * Availability is a secondary read, so it never fails the search. A lookup that
   * fails — an HTTP error, an HTML page, a body of another shape, a ladder that
   * ran out — leaves its works unknown, and once one has failed, lookups not yet
   * started are skipped and their works unknown too: a failure almost always
   * means the upstream is struggling, and the page in hand is worth more than
   * waiting out the same fault once per lookup. Every lookup runs against
   * `deadlineAt`, the budget the page request started, and one that would start
   * with nothing left is skipped. A caller that cancels is never absorbed: its
   * abort propagates.
   *
   * A lookup can also answer 200 with a work's `availability` set to `null`:
   * Open Library asked the Internet Archive about the work's scan and got no
   * answer (its availability service reports failure for the whole batch). Those
   * works are asked about once more, after every first lookup has settled and
   * {@link AVAILABILITY_REASK_DELAY_MS} has passed, one re-ask at a time; a work
   * still `null` is unknown too. A work whose answer leaves `availability` out
   * has no scan the Internet Archive lends — "none returned", not unknown.
   *
   * Returns each answered work's raw lending payload by work ID, and the IDs
   * whose availability is unknown.
   */
  private async lookupAvailability(
    workIds: string[],
    ctx: Context,
    deadlineAt: number,
  ): Promise<{ found: Map<string, unknown>; unknown: Set<string> }> {
    const chunks: string[][] = [];
    for (let i = 0; i < workIds.length; i += AVAILABILITY_LOOKUP_KEYS) {
      chunks.push(workIds.slice(i, i + AVAILABILITY_LOOKUP_KEYS));
    }

    const request = async (ids: string[]) => {
      const qs = new URLSearchParams({
        q: `key:(${ids.map((id) => `"/works/${id}"`).join(' OR ')})`,
        // Open Library reads availability off a work's `ia` items, so it
        // returns none unless `ia` is requested too.
        fields: 'key,ia,availability',
        limit: String(ids.length),
      });
      const raw = await this.fetch<unknown>(
        `${BASE_URL}/search.json?${qs.toString()}`,
        ctx,
        'search',
        {
          deadlineMs: deadlineAt - Date.now(),
        },
      );
      return availabilityLookupSchema.parse(raw).docs;
    };

    const batch = new BestEffortBatch({
      concurrency: AVAILABILITY_LOOKUP_CONCURRENCY,
      deadlineAt,
      ctx,
      failureMessage: 'Search availability lookup failed; skipping lookups not yet started',
    });
    const answers = await Promise.all(
      chunks.map(async (chunk) => {
        const outcome = await batch.run(() => request(chunk), { works: chunk.length });
        return outcome.status === 'ok' ? { chunk, docs: outcome.value } : { chunk };
      }),
    );

    const found = new Map<string, unknown>();
    const unknown = new Set<string>();
    const unanswered: string[] = [];
    for (const { chunk, docs } of answers) {
      if (!docs) {
        for (const id of chunk) unknown.add(id);
        continue;
      }
      for (const doc of docs) {
        const id = stripPrefix(doc.key, '/works/');
        if (doc.availability === null) unanswered.push(id);
        else found.set(id, doc.availability);
      }
    }
    if (unanswered.length === 0) return { found, unknown };

    // With no time left for the pause, the works stay unknown rather than overrun the deadline.
    if (deadlineAt - Date.now() <= AVAILABILITY_REASK_DELAY_MS) {
      for (const id of unanswered) unknown.add(id);
      return { found, unknown };
    }
    await pause(AVAILABILITY_REASK_DELAY_MS, ctx.signal);
    const reask = new BestEffortBatch({
      concurrency: 1,
      deadlineAt,
      ctx,
      failureMessage: 'Search availability re-ask failed; skipping re-asks not yet started',
    });
    ctx.log.debug('Re-asking availability for works the Internet Archive did not answer', {
      works: unanswered.length,
    });
    for (let i = 0; i < unanswered.length; i += AVAILABILITY_LOOKUP_KEYS) {
      const ids = unanswered.slice(i, i + AVAILABILITY_LOOKUP_KEYS);
      const outcome = await reask.run(() => request(ids), { works: ids.length });
      const retried =
        outcome.status === 'ok'
          ? new Map(outcome.value.map((doc) => [stripPrefix(doc.key, '/works/'), doc]))
          : undefined;
      for (const id of ids) {
        const doc = retried?.get(id);
        if (doc && doc.availability !== null) found.set(id, doc.availability);
        else unknown.add(id);
      }
    }
    return { found, unknown };
  }

  // ─── Works ────────────────────────────────────────────────────────────────────

  /**
   * A work by ID, following a merge redirect when the ID has one. `work_id` is
   * the ID the record was found under, so a caller that followed a redirect
   * learns the canonical one.
   */
  async getWork(workId: string, ctx: Context): Promise<WorkDetail | null> {
    const resolved = await this.followMergeRedirects<RawWorkRecord>(
      WORK_MERGES,
      workId,
      ctx,
      Date.now() + RETRY_DEADLINE_MS,
    );
    if (!resolved) return null;
    const { raw, canonicalId } = resolved;

    const desc = extractDescription(raw.description);
    return {
      work_id: canonicalId,
      title: raw.title ?? '',
      ...(desc !== undefined ? { description: desc } : {}),
      subjects: raw.subjects ?? [],
      subject_places: raw.subject_places ?? [],
      subject_times: raw.subject_times ?? [],
      subject_people: raw.subject_people ?? [],
      cover_ids: sanitizeImageIds(raw.covers),
      author_ids: (raw.authors ?? [])
        .map((entry) => entry.author?.key)
        .filter((key): key is string => typeof key === 'string')
        .map(normalizeAuthorId),
      ...(raw.created?.value !== undefined ? { created: raw.created.value } : {}),
      ...(raw.last_modified?.value !== undefined ? { last_modified: raw.last_modified.value } : {}),
    };
  }

  // ─── Editions ─────────────────────────────────────────────────────────────────

  /**
   * Editions of a work, following a merge redirect when the ID has one.
   *
   * A merged work's editions subresource 404s while its record answers 200, so a
   * null page is ambiguous between "no such work" and "this ID was merged away".
   * Only that path pays for the resolution that tells the two apart — a live
   * work costs one request — and the retry under the canonical ID keeps the
   * caller's `limit` and `offset`. Every request of the call, redirect hops
   * included, shares one {@link RETRY_DEADLINE_MS}.
   *
   * The returned `work_id` is the ID the editions were found under.
   */
  async getEditions(
    workId: string,
    limit: number,
    offset: number,
    ctx: Context,
  ): Promise<{ total: number; work_id: string; editions: EditionSummary[] } | null> {
    const deadlineAt = Date.now() + RETRY_DEADLINE_MS;
    const id = normalizeWorkId(workId);

    const direct = await this.fetchEditionsPage(id, limit, offset, ctx, deadlineAt);
    if (direct) return direct;

    const resolved = await this.followMergeRedirects(WORK_MERGES, id, ctx, deadlineAt);
    // Same ID back means the work resolves but has no editions subresource —
    // retrying it would just repeat the request that returned null.
    if (!resolved || resolved.canonicalId === id) return null;

    ctx.log.info('Following work merge redirect for editions', {
      requested: id,
      canonical: resolved.canonicalId,
    });
    return this.fetchEditionsPage(resolved.canonicalId, limit, offset, ctx, deadlineAt);
  }

  /**
   * One page of a work's editions, or `null` when the subresource reports no
   * record for that ID. Split out so {@link getEditions} can retry a canonical ID
   * against it without duplicating the mapping.
   */
  private async fetchEditionsPage(
    id: string,
    limit: number,
    offset: number,
    ctx: Context,
    deadlineAt: number,
  ): Promise<{ total: number; work_id: string; editions: EditionSummary[] } | null> {
    const url = `${BASE_URL}/works/${id}/editions.json?limit=${limit}&offset=${offset}`;
    ctx.log.debug('Fetching editions', { workId: id, limit, offset });

    const raw = await this.fetchOrNull<{
      size: number;
      entries: Array<
        RawEditionCredits & {
          key: string;
          title?: string;
          publish_date?: string;
          physical_format?: unknown;
          edition_name?: unknown;
          publishers?: string[];
          languages?: Array<{ key: string }>;
          isbn_10?: string[];
          isbn_13?: string[];
          number_of_pages?: number;
          covers?: number[];
          works?: Array<{ key: string }>;
        }
      >;
    }>(url, ctx, deadlineAt);

    if (!raw?.entries) return null;

    const editions: EditionSummary[] = raw.entries.map((e) => ({
      edition_id: stripPrefix(e.key ?? '', '/books/'),
      title: e.title ?? '',
      ...editionCredits(e),
      ...(e.publish_date ? { publish_date: e.publish_date } : {}),
      ...(typeof e.physical_format === 'string' && e.physical_format.length > 0
        ? { physical_format: e.physical_format }
        : {}),
      ...(typeof e.edition_name === 'string' && e.edition_name.length > 0
        ? { edition_name: e.edition_name }
        : {}),
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
   * Author credits recorded on an edition's parent work, each resolved to a
   * display name. Open Library records authorship at the work level for many
   * editions, so an edition with no `authors` of its own is usually attributed
   * here rather than genuinely anonymous.
   *
   * The parent work and each credited author resolve through their merge
   * redirects: an edition can still point at a work that was merged away, whose
   * stub carries no credits, and a work can still credit a merged-away author,
   * whose stub carries no name. A credit resolved that way reports the canonical
   * author's ID and name.
   *
   * Every lookup runs through `batch`. A work lookup that fails or is skipped
   * leaves the edition with no credits; an author lookup that fails, is
   * skipped, or finds no author record keeps the credit with its ID as the name.
   * `gap` reports whether any lookup failed or was skipped — a work or author
   * the upstream simply has no record for (or answers with a record of another
   * type) is not a gap.
   */
  private async workAuthors(
    workKey: string,
    ctx: Context,
    batch: BestEffortBatch,
  ): Promise<{ authors: EditionAuthor[]; gap?: AuthorLookupGap }> {
    const work = await batch.run((deadlineAt) =>
      this.followMergeRedirects<RawWorkRecord>(WORK_MERGES, workKey, ctx, deadlineAt),
    );
    if (work.status !== 'ok') return { authors: [], gap: work.status };

    const authorKeys = (work.value?.raw.authors ?? [])
      .map((entry) => entry.author?.key)
      .filter((key): key is string => typeof key === 'string');
    const lookups = await Promise.all(
      authorKeys.map(async (key) => {
        const authorId = stripPrefix(key, '/authors/');
        const author = await batch.run((deadlineAt) =>
          this.followMergeRedirects<RawAuthorRecord>(AUTHOR_MERGES, authorId, ctx, deadlineAt),
        );
        const resolved = author.status === 'ok' ? author.value : null;
        const credit: EditionAuthor = {
          name: resolved?.raw.name ?? authorId,
          author_id: resolved?.canonicalId ?? authorId,
          source: 'work',
        };
        return { credit, status: author.status };
      }),
    );

    const gap = worstGap(lookups.map((lookup) => lookup.status));
    const authors = lookups.map((lookup) => lookup.credit);
    return gap ? { authors, gap } : { authors };
  }

  /**
   * Maps one `/api/books.json` `details` payload onto the domain edition shape,
   * with the gap in its author enrichment when the work-level fallback fell
   * short. The fallback's lookups run through `batch`, shared across the whole
   * identifier batch.
   */
  private async toEditionDetail(
    d: RawEditionDetails,
    ctx: Context,
    batch: BestEffortBatch,
  ): Promise<{ edition: EditionDetail; gap?: AuthorLookupGap }> {
    // This route embeds author names inline; only the work-level fallback needs
    // secondary lookups.
    const inlineAuthors: EditionAuthor[] = (d.authors ?? []).map((a) => ({
      name: a.name ?? stripPrefix(a.key, '/authors/'),
      author_id: stripPrefix(a.key, '/authors/'),
      source: 'edition',
    }));
    const workKey = d.works?.[0]?.key;
    const fallback =
      inlineAuthors.length === 0 && workKey
        ? await this.workAuthors(workKey, ctx, batch)
        : undefined;

    const description = extractDescription(d.description);
    const edition: EditionDetail = {
      edition_id: stripPrefix(d.key ?? '', '/books/'),
      title: d.title ?? '',
      authors: fallback?.authors ?? inlineAuthors,
      ...editionCredits(d),
      ...(d.publish_date ? { publish_date: d.publish_date } : {}),
      ...(typeof d.physical_format === 'string' && d.physical_format.length > 0
        ? { physical_format: d.physical_format }
        : {}),
      ...(typeof d.edition_name === 'string' && d.edition_name.length > 0
        ? { edition_name: d.edition_name }
        : {}),
      publishers: d.publishers ?? [],
      ...(d.languages?.[0] ? { language: extractLanguageCode(d.languages[0].key) } : {}),
      ...(d.languages?.length
        ? { languages: d.languages.map((language) => extractLanguageCode(language.key)) }
        : {}),
      isbn_10: d.isbn_10 ?? [],
      isbn_13: d.isbn_13 ?? [],
      oclc: mergeOclcNumbers(d),
      lccn: d.lccn ?? [],
      lc_classifications: d.lc_classifications ?? [],
      ...(typeof d.number_of_pages === 'number' && { page_count: d.number_of_pages }),
      ...(description !== undefined ? { description } : {}),
      cover_ids: sanitizeImageIds(d.covers),
      ...(workKey ? { work_id: stripPrefix(workKey, '/works/') } : {}),
      ...(d.ocaid ? { ebook_url: `https://archive.org/details/${d.ocaid}` } : {}),
    };
    return fallback?.gap ? { edition, gap: fallback.gap } : { edition };
  }

  /**
   * Fetches the bibkeys response map, classifying an upstream fault as the
   * `upstream_unavailable` failure the edition tool declares.
   *
   * The route answers an unknown identifier by leaving its key out of a 200 map,
   * so an HTTP error status here is never "no such edition" — letting a 404
   * through as `NotFound` would tell the caller exactly that. The fault is
   * classified outside the retry ladder: a 404 is not retried at all, a gateway
   * failure ends the ladder on its first answer, and only a failure the ladder
   * does retry (a 500, say) costs more than one request.
   */
  private async fetchEditionMap(
    url: string,
    ctx: Context,
  ): Promise<Record<string, { details?: RawEditionDetails }>> {
    try {
      return await this.fetch<Record<string, { details?: RawEditionDetails }>>(url, ctx, 'record');
    } catch (err) {
      if (!isBibkeysRouteFault(err)) throw err;
      const status = err.data?.status;
      const fault =
        typeof status === 'number'
          ? `HTTP ${status}`
          : err.data?.errorSource === HTML_BODY_ERROR_SOURCE
            ? 'an HTML page instead of JSON'
            : 'a body that is not JSON';
      throw serviceUnavailable(
        `Open Library's edition lookup failed upstream with ${fault}.`,
        {
          reason: 'upstream_unavailable',
          retryable: true,
          ...(typeof status === 'number' && { status }),
        },
        { cause: err },
      );
    }
  }

  /**
   * Resolves a batch of identifiers of one type in a single `/api/books.json`
   * request. All four bibkey prefixes go through this one route: it accepts many
   * keys per call and embeds author names inline, so a list of N identifiers
   * costs one request instead of N lookups plus a secondary lookup per author.
   *
   * Open Library omits an unresolvable bibkey from the response map entirely —
   * no null, no error entry — so a requested key missing from the map is the
   * not-found signal. Those identifiers come back in `unresolved` rather than
   * failing the whole batch; the caller decides whether an empty `editions` is
   * an error.
   *
   * Editions whose authors are only recorded on the parent work still need
   * per-edition lookups. Those run through one {@link BestEffortBatch}, so a
   * 50-identifier request tapers its follow-up traffic, stops issuing lookups
   * once one has failed, and finishes — bibkeys request included — inside one
   * {@link RETRY_DEADLINE_MS}. `authorGaps` names the editions whose authors
   * are incomplete because of that.
   *
   * Each resolved row echoes its input as `identifier`, so two inputs naming one
   * edition come back as two rows the caller can tell apart.
   */
  async getEditionsByIdentifiers(
    identifiers: string[],
    idType: EditionIdType,
    ctx: Context,
  ): Promise<{ editions: ResolvedEdition[]; unresolved: string[]; authorGaps: AuthorLookupGaps }> {
    const deadlineAt = Date.now() + RETRY_DEADLINE_MS;
    // Keep the caller's identifier alongside the key sent upstream: the response
    // is keyed by the bibkey, which differs from the input for a hyphenated ISBN
    // or a lowercase `x` check digit, and the identifier is what each row echoes.
    const requested = identifiers.map((identifier) => ({
      identifier,
      bibkey: `${BIBKEY_PREFIX[idType]}:${idType === 'isbn' ? canonicalIsbn(identifier) : identifier}`,
    }));
    ctx.log.debug('Fetching editions', { idType, count: requested.length });

    const bibkeys = requested.map((r) => r.bibkey).join(',');
    const url = `${BASE_URL}/api/books.json?bibkeys=${encodeURIComponent(bibkeys)}&format=json&jscmd=details`;
    const rawMap = await this.fetchEditionMap(url, ctx);

    const batch = new BestEffortBatch({
      concurrency: EDITION_ENRICHMENT_CONCURRENCY,
      deadlineAt,
      ctx,
      failureMessage: 'Edition author lookup failed; skipping lookups not yet started',
    });
    const resolved = await Promise.all(
      requested.map(
        async ({
          identifier,
          bibkey,
        }): Promise<{ identifier: string; edition?: EditionDetail; gap?: AuthorLookupGap }> => {
          const details = rawMap[bibkey]?.details;
          if (!details?.key) return { identifier };
          return { identifier, ...(await this.toEditionDetail(details, ctx, batch)) };
        },
      ),
    );

    const editions: ResolvedEdition[] = [];
    const unresolved: string[] = [];
    const authorGaps: AuthorLookupGaps = { failed: [], skipped: [] };
    for (const { identifier, edition, gap } of resolved) {
      if (!edition) {
        unresolved.push(identifier);
        continue;
      }
      editions.push({ identifier, ...edition });
      if (gap) authorGaps[gap].push(edition.edition_id);
    }
    return { editions, unresolved, authorGaps };
  }

  // ─── Full-text search inside scanned books ────────────────────────────────────

  /**
   * Searches the full text of scanned Internet Archive books. The endpoint is an
   * Elasticsearch passthrough: the item and metadata `fields` arrive as arrays
   * (take `[0]`) while the per-file bookkeeping ones are bare strings, the
   * metadata keys are `meta_`-prefixed, and `_id` is a composite
   * `identifier|sha1` rather than a bare IA identifier. A zero-match query is an
   * HTTP 200 with `hits.total: 0`, not an error.
   *
   * `hits.total` is the only zero-match signal. A 200 without a `hits` object
   * carrying a numeric `total` — an error object, `{}`, a truncated payload — is
   * the index failing to answer, so it throws the `upstream_unavailable` fault
   * the tool declares rather than reading as "no book contains this". Like a
   * 2xx HTML page, it is classified outside the retry ladder: re-issuing the
   * most expensive query the upstream serves within seconds is the caller's
   * call to make, not this one's.
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

    // `null` is valid JSON, so the body itself may be absent as well as its `hits`.
    const raw = await this.fetch<{
      hits?: {
        total?: unknown;
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
    } | null>(url, ctx, 'fulltext');

    const hits = raw?.hits;
    if (typeof hits?.total !== 'number') {
      throw serviceUnavailable(
        "Open Library's full-text search answered HTTP 200 without a result set.",
        { reason: 'upstream_unavailable', retryable: true },
      );
    }

    const matches: InsideMatch[] = [];
    for (const hit of hits.hits ?? []) {
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

    return { total: hits.total, offset, matches };
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
    }>(url, ctx, 'search');

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

  async getAuthor(authorId: string, ctx: Context): Promise<AuthorDetail | null> {
    const resolved = await this.followMergeRedirects<RawAuthorRecord>(
      AUTHOR_MERGES,
      authorId,
      ctx,
      Date.now() + RETRY_DEADLINE_MS,
    );
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
    deadlineAt: number,
  ): Promise<{ total: number; author_id: string; works: AuthorWork[] } | null> {
    if (id.length === 0) return null;
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
    }>(url, ctx, deadlineAt);

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
   * tells the two apart — a live author costs exactly one request.
   * Every request of the call — direct page, redirect hops, canonical page —
   * shares one {@link RETRY_DEADLINE_MS}.
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
    const deadlineAt = Date.now() + RETRY_DEADLINE_MS;
    const id = normalizeAuthorId(authorId);

    const direct = await this.fetchAuthorWorksPage(id, limit, offset, ctx, deadlineAt);
    if (direct) return direct;

    const resolved = await this.followMergeRedirects(AUTHOR_MERGES, id, ctx, deadlineAt);
    // Same ID back means the author resolves but genuinely has no works
    // subresource — retrying it would just repeat the request that returned null.
    if (!resolved || resolved.canonicalId === id) return null;

    ctx.log.info('Following author merge redirect for works', {
      requested: id,
      canonical: resolved.canonicalId,
    });
    return this.fetchAuthorWorksPage(resolved.canonicalId, limit, offset, ctx, deadlineAt);
  }

  // ─── Subjects ─────────────────────────────────────────────────────────────────

  /**
   * Fetches a subject page. Open Library answers any subject key with HTTP 200,
   * echoing the requested key back as `name` with `work_count: 0` and no works,
   * so an unknown subject is an empty result rather than an absent record — this
   * never resolves to `null`, and callers have no not-found path to take.
   *
   * `subject_type` is Open Library's reading of the key: `place`, `person`, or
   * `time` for a recognized browse prefix, `subject` otherwise.
   */
  async getSubject(
    subject: string,
    limit: number,
    offset: number,
    ctx: Context,
  ): Promise<{
    subject_name: string;
    subject_key: string;
    subject_type?: string;
    work_count: number;
    works: SubjectWork[];
  }> {
    const lowered = subject.trim().toLowerCase();
    // Whitespace after a browse prefix's colon would join the value as an
    // underscore ("place:_london") and match nothing.
    const prefix = ['place:', 'person:', 'time:'].find((p) => lowered.startsWith(p));
    const subjectKey = (
      prefix ? prefix + lowered.slice(prefix.length).trimStart() : lowered
    ).replace(/\s+/g, '_');
    const qs = new URLSearchParams({
      limit: String(limit),
      offset: String(offset),
    });
    const url = `${BASE_URL}/subjects/${encodeURIComponent(subjectKey)}.json?${qs.toString()}`;
    ctx.log.debug('Fetching subject', { subjectKey, limit, offset });

    const raw = await this.fetch<{
      name?: string;
      key?: string;
      subject_type?: unknown;
      work_count?: number;
      works?: Array<{
        key: string;
        title?: string;
        authors?: Array<{ name: string }>;
        edition_count?: number;
        cover_id?: number;
      }>;
    }>(url, ctx, 'search');

    return {
      subject_name: raw.name ?? subject,
      subject_key: subjectKey,
      ...(typeof raw.subject_type === 'string' && { subject_type: raw.subject_type }),
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
    // The Covers API matches an OLID only in upper case — any other case serves
    // the placeholder — and the check above has already confirmed the shape.
    const clean =
      idType === 'isbn'
        ? canonicalIsbn(identifier)
        : idType === 'olid'
          ? identifier.toUpperCase()
          : identifier;
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
