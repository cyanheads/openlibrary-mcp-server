/**
 * @fileoverview Open Library REST API client. Handles search, works, editions, authors,
 * subjects, and cover URL construction with retry and timeout.
 * @module services/open-library/open-library-service
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import { McpError, notFound, validationError } from '@cyanheads/mcp-ts-core/errors';
import { fetchWithTimeout, withRetry } from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig } from '@/config/server-config.js';
import type {
  AuthorDetail,
  AuthorSearchResult,
  AuthorWork,
  EditionDetail,
  EditionIdType,
  EditionSummary,
  SearchWork,
  SubjectWork,
  WorkAvailability,
  WorkDetail,
} from './types.js';

const BASE_URL = 'https://openlibrary.org';
const COVERS_URL = 'https://covers.openlibrary.org';
const TIMEOUT_MS = 15_000;

/** Strips a leading path segment prefix from an OL ID (e.g. "/works/OL45804W" → "OL45804W"). */
function stripPrefix(id: string, prefix: string): string {
  return id.startsWith(prefix) ? id.slice(prefix.length) : id;
}

/** Extracts the 3-letter language code from a raw language key path ("/languages/eng" → "eng"). */
function extractLanguageCode(key: string): string {
  const parts = key.split('/');
  return parts[parts.length - 1] ?? key;
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
 * True when an error is the status-mapped `McpError` that `fetchWithTimeout`
 * throws on an upstream HTTP 404. `withRetry` rethrows it unchanged (NotFound is
 * not a transient code), so `data.statusCode` reaches here intact. Callers map
 * this to an absent-record `null` so each tool's own `not_found` path fires
 * instead of the raw fetch-layer error leaking to the client.
 */
function isUpstreamNotFound(err: unknown): boolean {
  return err instanceof McpError && err.data?.statusCode === 404;
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

export class OpenLibraryService {
  private readonly userAgent: string;

  constructor(userAgent: string) {
    this.userAgent = userAgent;
  }

  private headers(): Record<string, string> {
    return { 'User-Agent': this.userAgent };
  }

  private fetch<T>(url: string, ctx: Context): Promise<T> {
    // `fetchWithTimeout` and `withRetry` accept `RequestContext` which requires an index signature.
    // `Context` is structurally compatible at runtime — cast is safe per framework docs.
    // biome-ignore lint/suspicious/noExplicitAny: safe per framework docs
    const rCtx = ctx as any;
    return withRetry(
      async () => {
        const response = await fetchWithTimeout(url, TIMEOUT_MS, rCtx, {
          headers: this.headers(),
          signal: ctx.signal,
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
   * recovery — instead of leaking the raw status-mapped fetch error.
   */
  private async fetchOrNull<T>(url: string, ctx: Context): Promise<T | null> {
    try {
      return await this.fetch<T>(url, ctx);
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
    if (params.language) qs.set('lang', params.language);
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
      const ebookAccess = (doc.ebook_access as SearchWork['ebook_access']) ?? 'no_ebook';
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
        ...(doc.subject?.length ? { subjects: doc.subject.slice(0, 5) } : {}),
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
      cover_ids: raw.covers ?? [],
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
      cover_ids: e.covers ?? [],
      ...(e.works?.[0]?.key ? { work_id: stripPrefix(e.works[0].key, '/works/') } : {}),
    }));

    return { total: raw.size, work_id: id, editions };
  }

  // ─── Edition by identifier ────────────────────────────────────────────────────

  async getEditionByIdentifier(
    identifier: string,
    idType: EditionIdType,
    ctx: Context,
  ): Promise<EditionDetail> {
    ctx.log.debug('Fetching edition', { identifier, idType });

    if (idType === 'isbn' || idType === 'olid') {
      const path =
        idType === 'isbn' ? `isbn/${identifier.replace(/-/g, '')}` : `books/${identifier}`;
      const url = `${BASE_URL}/${path}.json`;
      const raw = await this.fetchOrNull<{
        key?: string;
        title?: string;
        authors?: Array<{ key: string }>;
        publish_date?: string;
        publishers?: string[];
        languages?: Array<{ key: string }>;
        isbn_10?: string[];
        isbn_13?: string[];
        oclc_numbers?: string[];
        lc_classifications?: string[];
        number_of_pages?: number;
        description?: unknown;
        covers?: number[];
        works?: Array<{ key: string }>;
        ocaid?: string;
        error?: string;
      }>(url, ctx);

      if (!raw || raw.error === 'notfound' || !raw.key) {
        throw notFound(
          `Edition not found for ${idType.toUpperCase()} "${identifier}". Verify the identifier or try searching by title/author.`,
          { reason: 'not_found', ...ctx.recoveryFor('not_found') },
        );
      }

      // Resolve author names via parallel secondary lookups
      const authors: Array<{ name: string; author_id?: string }> = await Promise.all(
        (raw.authors ?? []).map(async (authorRef) => {
          const authorId = stripPrefix(authorRef.key, '/authors/');
          try {
            const authorRaw = await this.fetch<{ name?: string }>(
              `${BASE_URL}/authors/${authorId}.json`,
              ctx,
            );
            return { name: authorRaw.name ?? authorId, author_id: authorId };
          } catch {
            return { author_id: authorId, name: authorId };
          }
        }),
      );

      const editionId = stripPrefix(raw.key, '/books/');
      const edDesc = extractDescription(raw.description);
      return {
        edition_id: editionId,
        title: raw.title ?? '',
        authors,
        ...(raw.publish_date ? { publish_date: raw.publish_date } : {}),
        publishers: raw.publishers ?? [],
        ...(raw.languages?.[0] ? { language: extractLanguageCode(raw.languages[0].key) } : {}),
        isbn_10: raw.isbn_10 ?? [],
        isbn_13: raw.isbn_13 ?? [],
        oclc: raw.oclc_numbers ?? [],
        lccn: raw.lc_classifications ?? [],
        ...(typeof raw.number_of_pages === 'number' && { page_count: raw.number_of_pages }),
        ...(edDesc !== undefined ? { description: edDesc } : {}),
        cover_ids: raw.covers ?? [],
        ...(raw.works?.[0]?.key ? { work_id: stripPrefix(raw.works[0].key, '/works/') } : {}),
        ...(raw.ocaid ? { ebook_url: `https://archive.org/details/${raw.ocaid}` } : {}),
      };
    }

    // OCLC / LCCN route — use /api/books with jscmd=details
    const prefix = idType === 'oclc' ? 'OCLC' : 'LCCN';
    const bibkey = `${prefix}:${identifier}`;
    const url = `${BASE_URL}/api/books?bibkeys=${encodeURIComponent(bibkey)}&format=json&jscmd=details`;
    const rawMap = await this.fetch<
      Record<
        string,
        {
          details?: {
            key?: string;
            title?: string;
            authors?: Array<{ key: string; name?: string }>;
            publish_date?: string;
            publishers?: string[];
            languages?: Array<{ key: string }>;
            isbn_10?: string[];
            isbn_13?: string[];
            oclc_numbers?: string[];
            lc_classifications?: string[];
            number_of_pages?: number;
            description?: unknown;
            covers?: number[];
            works?: Array<{ key: string }>;
            ocaid?: string;
          };
        }
      >
    >(url, ctx);

    const entry = rawMap[bibkey];
    if (!entry?.details?.key) {
      throw notFound(
        `Edition not found for ${prefix} "${identifier}". Verify the identifier or try searching by title/author.`,
        { reason: 'not_found', ...ctx.recoveryFor('not_found') },
      );
    }

    const d = entry.details;
    const authors: Array<{ name: string; author_id?: string }> = (d.authors ?? []).map((a) => ({
      name: a.name ?? stripPrefix(a.key, '/authors/'),
      author_id: stripPrefix(a.key, '/authors/'),
    }));

    const oclcDesc = extractDescription(d.description);
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
      lccn: d.lc_classifications ?? [],
      ...(typeof d.number_of_pages === 'number' && { page_count: d.number_of_pages }),
      ...(oclcDesc !== undefined ? { description: oclcDesc } : {}),
      cover_ids: d.covers ?? [],
      ...(d.works?.[0]?.key ? { work_id: stripPrefix(d.works[0].key, '/works/') } : {}),
      ...(d.ocaid ? { ebook_url: `https://archive.org/details/${d.ocaid}` } : {}),
    };
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

  async getAuthor(authorId: string, ctx: Context): Promise<AuthorDetail | null> {
    const id = stripPrefix(authorId, '/authors/');
    const url = `${BASE_URL}/authors/${id}.json`;
    ctx.log.debug('Fetching author', { authorId: id });

    const raw = await this.fetchOrNull<{
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
      error?: string;
    }>(url, ctx);

    if (!raw || raw.error === 'notfound' || !raw.key) return null;

    const bio = extractDescription(raw.bio);
    return {
      author_id: stripPrefix(raw.key, '/authors/'),
      name: raw.name ?? '',
      ...(raw.personal_name ? { personal_name: raw.personal_name } : {}),
      ...(raw.fuller_name ? { fuller_name: raw.fuller_name } : {}),
      ...(bio !== undefined ? { bio } : {}),
      ...(raw.birth_date ? { birth_date: raw.birth_date } : {}),
      ...(raw.death_date ? { death_date: raw.death_date } : {}),
      photo_ids: raw.photos ?? [],
      remote_ids: {
        ...(raw.remote_ids?.wikidata != null && { wikidata: raw.remote_ids.wikidata }),
        ...(raw.remote_ids?.viaf != null && { viaf: raw.remote_ids.viaf }),
        ...(raw.remote_ids?.isni != null && { isni: raw.remote_ids.isni }),
        ...(raw.remote_ids?.goodreads != null && { goodreads: raw.remote_ids.goodreads }),
        ...(raw.remote_ids?.librarything != null && { librarything: raw.remote_ids.librarything }),
      },
    };
  }

  async getAuthorWorks(
    authorId: string,
    limit: number,
    offset: number,
    ctx: Context,
  ): Promise<{ total: number; author_id: string; works: AuthorWork[] } | null> {
    const id = stripPrefix(authorId, '/authors/');
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
        cover_ids: e.covers ?? [],
      })),
    };
  }

  // ─── Subjects ─────────────────────────────────────────────────────────────────

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
  } | null> {
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
      error?: string;
    }>(url, ctx);

    if (raw.error === 'notfound' || (!raw.name && !raw.work_count)) return null;

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
