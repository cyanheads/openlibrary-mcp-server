/**
 * @fileoverview Service-level tests that drive the REAL fetch layer
 * (`fetchWithTimeout` → `withRetry` → the service's 404 mapping) rather than
 * stubbing `svc.getX()`.
 *
 * Two things only reachable at this layer are covered here: upstream HTTP 404s
 * normalized into the declared `not_found` contract, and the request/response
 * translation itself — the outgoing query string the search builds, and how
 * upstream fields are mapped onto the domain types. The tool tests mock at the
 * service boundary and never see either, which is how a filter sent under the
 * wrong parameter name and an identifier mapped from the wrong upstream field
 * both shipped uncovered.
 * @module tests/services/open-library-service.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openlibraryAuthorResource } from '@/mcp-server/resources/definitions/openlibrary-author.resource.js';
import { openlibraryGetEdition } from '@/mcp-server/tools/definitions/openlibrary-get-edition.tool.js';
import { openlibraryGetWork } from '@/mcp-server/tools/definitions/openlibrary-get-work.tool.js';
import {
  EDITION_ENRICHMENT_CONCURRENCY,
  getOpenLibraryService,
  initOpenLibraryService,
  MAX_AUTHOR_REDIRECT_HOPS,
} from '@/services/open-library/open-library-service.js';

/** A 404 like Open Library returns for a missing by-ID record (works/authors/editions). */
function notFoundResponse(): Response {
  return new Response('{}', { status: 404, statusText: 'Not Found' });
}

/** A 200 `{}` like the /api/books bibkeys endpoint returns for an unmatched OCLC. */
function emptyOkResponse(): Response {
  return new Response('{}', { status: 200, statusText: 'OK' });
}

/** Normalizes whatever `fetchWithTimeout` hands the global fetch into a URL string. */
function requestUrl(input: unknown): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  if (input && typeof input === 'object' && 'url' in input) return String(input.url);
  return String(input);
}

/**
 * Routes fetches by URL fragment so a multi-hop call (edition → work → authors)
 * can be driven end to end. Anything unmatched 404s, which is what Open Library
 * does for an unknown record.
 */
function mockFetchRoutes(routes: Record<string, unknown>): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(((input: unknown) => {
    const url = requestUrl(input);
    for (const [fragment, body] of Object.entries(routes)) {
      if (url.includes(fragment)) {
        return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
      }
    }
    return Promise.resolve(notFoundResponse());
  }) as typeof globalThis.fetch);
}

/** A search response carrying a single doc with the given overrides. */
function searchResponse(doc: Record<string, unknown>): Response {
  return new Response(
    JSON.stringify({
      numFound: 1,
      start: 0,
      docs: [{ key: '/works/OL45804W', title: 'X', ...doc }],
    }),
    { status: 200 },
  );
}

describe('OpenLibraryService — upstream 404 handling', () => {
  beforeEach(() => {
    initOpenLibraryService();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ─── By-ID lookups map 404 → null (reviving the dead not_found checks) ──────

  it('getWork returns null on a 404 instead of leaking FetchHttpError', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(notFoundResponse());
    const svc = getOpenLibraryService();

    await expect(svc.getWork('OL999999999999W', createMockContext())).resolves.toBeNull();
    // NotFound is not in withRetry's transient set — the 404 must not be retried.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('getEditions returns null on a 404', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(notFoundResponse());
    const svc = getOpenLibraryService();
    await expect(
      svc.getEditions('OL999999999999W', 10, 0, createMockContext()),
    ).resolves.toBeNull();
  });

  it('getAuthor returns null on a 404', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(notFoundResponse());
    const svc = getOpenLibraryService();
    await expect(svc.getAuthor('OL999999999999A', createMockContext())).resolves.toBeNull();
  });

  it('getAuthorWorks returns null on a 404', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(notFoundResponse());
    const svc = getOpenLibraryService();
    await expect(
      svc.getAuthorWorks('OL999999999999A', 10, 0, createMockContext()),
    ).resolves.toBeNull();
  });

  // ─── Unmatched bibkeys come back as unresolved, not as a throw ──────────────

  // Open Library omits an unresolvable bibkey from the response map entirely, so
  // the whole batch can come back as `{}` with HTTP 200.
  it('getEditionsByIdentifiers reports every unmatched identifier rather than throwing (200 {})', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(emptyOkResponse());
    const svc = getOpenLibraryService();
    const ctx = createMockContext({ errors: openlibraryGetEdition.errors });

    await expect(
      svc.getEditionsByIdentifiers(['99999999', '88888888'], 'oclc', ctx),
    ).resolves.toEqual({ editions: [], unresolved: ['99999999', '88888888'] });
  });

  it('surfaces the batch not_found contract through the get_edition tool', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(emptyOkResponse());
    const ctx = createMockContext({ errors: openlibraryGetEdition.errors });
    const input = openlibraryGetEdition.input.parse({
      identifiers: ['9780000000000'],
      id_type: 'isbn',
    });

    const error = await Promise.resolve(openlibraryGetEdition.handler(input, ctx)).catch((e) => e);
    expect(error).toBeInstanceOf(McpError);
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'not_found' },
    });
  });

  // ─── End-to-end: data.reason reaches the wire through the definitions ───────

  it('surfaces data.reason "not_found" through the get_work tool on a 404', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(notFoundResponse());
    const ctx = createMockContext({ errors: openlibraryGetWork.errors });
    const input = openlibraryGetWork.input.parse({ work_id: 'OL999999999999W' });

    const error = await Promise.resolve(openlibraryGetWork.handler(input, ctx)).catch((e) => e);
    expect(error).toBeInstanceOf(McpError);
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'not_found' },
    });
  });

  it('surfaces a clean NotFound (not FetchHttpError) through the author resource on a 404', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(notFoundResponse());
    const params = openlibraryAuthorResource.params!.parse({ author_id: 'OL999999999999A' });
    const ctx = createMockContext({ uri: new URL('openlibrary://authors/OL999999999999A') });

    const error = await Promise.resolve(openlibraryAuthorResource.handler(params, ctx)).catch(
      (e) => e,
    );
    expect(error).toBeInstanceOf(McpError);
    expect((error as McpError).code).toBe(JsonRpcErrorCode.NotFound);
    // The raw fetch-layer error carried data.errorSource: 'FetchHttpError'; a clean
    // not-found must not.
    expect((error as McpError).data?.errorSource).toBeUndefined();
  });
});

describe('OpenLibraryService — searchBooks language filter', () => {
  beforeEach(() => {
    initOpenLibraryService();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Runs a search and returns the URL the service actually requested. */
  async function searchUrl(language: string): Promise<string> {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(() => Promise.resolve(searchResponse({})));
    await getOpenLibraryService().searchBooks(
      { title: 'the little prince', language, limit: 3, offset: 0 },
      createMockContext(),
    );
    return requestUrl(fetchSpy.mock.calls[0]?.[0]);
  }

  it('sends a 3-letter MARC code as the language= result filter, never lang=', async () => {
    const url = await searchUrl('fre');
    // `lang=` is Open Library's UI-language parameter and filters nothing.
    expect(url).toContain('language=fre');
    expect(url).not.toMatch(/[?&]lang=/);
  });

  it('translates a 2-letter ISO 639-1 code to its MARC equivalent', async () => {
    expect(await searchUrl('fr')).toContain('language=fre');
  });

  it.each([
    ['de', 'ger'],
    ['nl', 'dut'],
    ['zh', 'chi'],
    ['el', 'gre'],
    ['cs', 'cze'],
    ['fa', 'per'],
  ])('maps %s to the MARC code %s, not a truncation of the name', async (iso, marc) => {
    expect(await searchUrl(iso)).toContain(`language=${marc}`);
  });

  it('uppercases and whitespace are tolerated on the way in', async () => {
    expect(await searchUrl(' FR ')).toContain('language=fre');
  });

  it('omits the language parameter entirely when none is supplied', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(() => Promise.resolve(searchResponse({})));
    await getOpenLibraryService().searchBooks(
      { title: 'the little prince', limit: 3, offset: 0 },
      createMockContext(),
    );
    expect(requestUrl(fetchSpy.mock.calls[0]?.[0])).not.toContain('language=');
  });

  it('rejects an unrecognized 2-letter code instead of passing it through or dropping it', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(() => Promise.resolve(searchResponse({})));

    const error = await getOpenLibraryService()
      .searchBooks({ query: 'dune', language: 'zz', limit: 3, offset: 0 }, createMockContext())
      .catch((e) => e);

    expect(error).toBeInstanceOf(McpError);
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'unknown_language_code' },
    });
    expect((error as McpError).data?.recovery).toMatchObject({ hint: expect.any(String) });
    // A rejected filter must not reach upstream at all.
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('OpenLibraryService — searchBooks ebook_access tiers', () => {
  beforeEach(() => {
    initOpenLibraryService();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function accessTierFor(ebookAccess: unknown) {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
      Promise.resolve(
        searchResponse(ebookAccess === undefined ? {} : { ebook_access: ebookAccess }),
      ),
    );
    const result = await getOpenLibraryService().searchBooks(
      { query: 'gatsby', limit: 1, offset: 0 },
      createMockContext(),
    );
    return result.works[0]?.ebook_access;
  }

  it('passes through the unclassified tier rather than failing the page', async () => {
    expect(await accessTierFor('unclassified')).toBe('unclassified');
  });

  it.each(['no_ebook', 'printdisabled', 'borrowable', 'public'])(
    'passes through the %s tier',
    async (tier) => {
      expect(await accessTierFor(tier)).toBe(tier);
    },
  );

  it('coalesces a tier Open Library adds later to unclassified instead of throwing', async () => {
    expect(await accessTierFor('some_future_tier')).toBe('unclassified');
  });

  it('treats an absent ebook_access as no_ebook', async () => {
    expect(await accessTierFor(undefined)).toBe('no_ebook');
  });

  // Open Library nulls absent fields rather than omitting them (an edition's
  // `authors`/`lccn`/`oclc_numbers` all arrive as null), so a null tier is an
  // unset one, not an unrecognized one.
  it('treats a null ebook_access as no_ebook, not an unrecognized tier', async () => {
    expect(await accessTierFor(null)).toBe('no_ebook');
  });
});

describe('OpenLibraryService — searchBooks subject mapping', () => {
  beforeEach(() => {
    initOpenLibraryService();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** 15 tags — well past the 5 the tool's text output renders. */
  const MANY_SUBJECTS = Array.from({ length: 15 }, (_, i) => `subject-${i + 1}`);

  it('returns every subject tag, uncapped', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
      Promise.resolve(searchResponse({ subject: MANY_SUBJECTS })),
    );

    const result = await getOpenLibraryService().searchBooks(
      { query: 'dune', limit: 1, offset: 0 },
      createMockContext(),
    );

    expect(result.works[0]?.subjects).toEqual(MANY_SUBJECTS);
  });

  it('omits subjects entirely when upstream tags none', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => Promise.resolve(searchResponse({})));

    const result = await getOpenLibraryService().searchBooks(
      { query: 'dune', limit: 1, offset: 0 },
      createMockContext(),
    );

    expect(result.works[0]?.subjects).toBeUndefined();
  });
});

describe('OpenLibraryService — getSubject', () => {
  beforeEach(() => {
    initOpenLibraryService();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Open Library echoes any requested key back with work_count 0 rather than
  // 404ing, so there is no absent-record shape for this method to report.
  it('resolves an unknown subject to a zero-work record, never null', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify({ name: 'zzznotarealsubjectzzz', work_count: 0, works: [] }), {
          status: 200,
        }),
      ),
    );

    const result = await getOpenLibraryService().getSubject(
      'zzznotarealsubjectzzz',
      12,
      0,
      createMockContext(),
    );

    expect(result.work_count).toBe(0);
    expect(result.works).toEqual([]);
    expect(result.subject_key).toBe('zzznotarealsubjectzzz');
  });

  it('normalizes case and spacing into the requested subject key', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify({ name: 'Science Fiction', work_count: 21127, works: [] }), {
          status: 200,
        }),
      ),
    );

    const result = await getOpenLibraryService().getSubject(
      'SCIENCE FICTION',
      1,
      0,
      createMockContext(),
    );

    expect(requestUrl(fetchSpy.mock.calls[0]?.[0])).toContain('/subjects/science_fiction.json');
    expect(result.subject_key).toBe('science_fiction');
  });
});

describe('OpenLibraryService — edition batch mapping', () => {
  /** OL22855101M — a real record whose lccn and lc_classifications differ. */
  const CONCORDE = {
    key: '/books/OL22855101M',
    title: 'Concorde',
    authors: [{ key: '/authors/OL631509A', name: 'Yves Marc' }],
    works: [{ key: '/works/OL3668495W' }],
    lccn: ['2008478952'],
    lc_classifications: ['TL685.7 .M366 2008'],
    oclc_numbers: ['244767413'],
  };

  beforeEach(() => {
    initOpenLibraryService();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('maps lccn from the upstream lccn field and call numbers to lc_classifications', async () => {
    mockFetchRoutes({ '/api/books': { 'OLID:OL22855101M': { details: CONCORDE } } });

    const { editions } = await getOpenLibraryService().getEditionsByIdentifiers(
      ['OL22855101M'],
      'olid',
      createMockContext(),
    );

    // The control number is the lookupable identifier; the call number is not.
    expect(editions[0]?.lccn).toEqual(['2008478952']);
    expect(editions[0]?.lc_classifications).toEqual(['TL685.7 .M366 2008']);
    expect(editions[0]?.oclc).toEqual(['244767413']);
  });

  it.each([
    ['isbn' as const, '9782952690607', 'ISBN:9782952690607'],
    ['oclc' as const, '244767413', 'OCLC:244767413'],
    ['lccn' as const, '2008478952', 'LCCN:2008478952'],
    ['olid' as const, 'OL22855101M', 'OLID:OL22855101M'],
  ])('builds the %s bibkey prefix upstream', async (idType, identifier, bibkey) => {
    const fetchSpy = mockFetchRoutes({ '/api/books': { [bibkey]: { details: CONCORDE } } });

    const { editions } = await getOpenLibraryService().getEditionsByIdentifiers(
      [identifier],
      idType,
      createMockContext(),
    );

    expect(requestUrl(fetchSpy.mock.calls[0]?.[0])).toContain(encodeURIComponent(bibkey));
    expect(editions).toHaveLength(1);
  });

  it('strips ISBN hyphens for the bibkey while echoing the identifier as supplied', async () => {
    const fetchSpy = mockFetchRoutes({
      '/api/books': { 'ISBN:9780743273565': { details: CONCORDE } },
    });

    const { editions, unresolved } = await getOpenLibraryService().getEditionsByIdentifiers(
      ['978-0-7432-7356-5'],
      'isbn',
      createMockContext(),
    );

    expect(requestUrl(fetchSpy.mock.calls[0]?.[0])).toContain('ISBN%3A9780743273565');
    expect(editions).toHaveLength(1);
    expect(unresolved).toEqual([]);
  });

  it('resolves the whole batch in one request, in request order', async () => {
    const fetchSpy = mockFetchRoutes({
      '/api/books': {
        'OLID:OL1M': { details: { key: '/books/OL1M', title: 'First' } },
        'OLID:OL2M': { details: { key: '/books/OL2M', title: 'Second' } },
      },
    });

    const { editions } = await getOpenLibraryService().getEditionsByIdentifiers(
      ['OL2M', 'OL1M'],
      'olid',
      createMockContext(),
    );

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(editions.map((e) => e.edition_id)).toEqual(['OL2M', 'OL1M']);
  });

  // An unresolvable bibkey is omitted from the response map entirely — no null,
  // no error entry — so a missing key is the only not-found signal.
  it('reports the identifiers upstream omitted without dropping the ones it returned', async () => {
    mockFetchRoutes({
      '/api/books': { 'OLID:OL1M': { details: { key: '/books/OL1M', title: 'First' } } },
    });

    const { editions, unresolved } = await getOpenLibraryService().getEditionsByIdentifiers(
      ['OL1M', 'OL99999999M'],
      'olid',
      createMockContext(),
    );

    expect(editions.map((e) => e.edition_id)).toEqual(['OL1M']);
    expect(unresolved).toEqual(['OL99999999M']);
  });

  it('treats an entry with no key as unresolved rather than an empty edition', async () => {
    mockFetchRoutes({ '/api/books': { 'OLID:OL1M': { details: { title: 'Keyless' } } } });

    const { editions, unresolved } = await getOpenLibraryService().getEditionsByIdentifiers(
      ['OL1M'],
      'olid',
      createMockContext(),
    );

    expect(editions).toEqual([]);
    expect(unresolved).toEqual(['OL1M']);
  });

  it('tags inline author names with source "edition" and needs no secondary lookup', async () => {
    const fetchSpy = mockFetchRoutes({
      '/api/books': { 'OLID:OL22855101M': { details: CONCORDE } },
    });

    const { editions } = await getOpenLibraryService().getEditionsByIdentifiers(
      ['OL22855101M'],
      'olid',
      createMockContext(),
    );

    expect(editions[0]?.authors).toEqual([
      { name: 'Yves Marc', author_id: 'OL631509A', source: 'edition' },
    ]);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('falls back to the parent work when the edition records no authors', async () => {
    mockFetchRoutes({
      '/api/books': {
        'ISBN:9780451524935': {
          details: {
            key: '/books/OL34854896M',
            title: 'Nineteen Eighty-Four',
            works: [{ key: '/works/OL1168083W' }],
          },
        },
      },
      '/works/OL1168083W.json': {
        authors: [{ author: { key: '/authors/OL118077A' }, type: { key: '/type/author_role' } }],
      },
      '/authors/OL118077A.json': { name: 'George Orwell' },
    });

    const { editions } = await getOpenLibraryService().getEditionsByIdentifiers(
      ['9780451524935'],
      'isbn',
      createMockContext(),
    );

    expect(editions[0]?.authors).toEqual([
      { name: 'George Orwell', author_id: 'OL118077A', source: 'work' },
    ]);
  });

  it('returns no authors, and no error, when neither the edition nor its work has any', async () => {
    mockFetchRoutes({
      '/api/books': {
        'OLID:OL999M': {
          details: {
            key: '/books/OL999M',
            title: 'Anonymous Pamphlet',
            works: [{ key: '/works/OL999W' }],
          },
        },
      },
      '/works/OL999W.json': { key: '/works/OL999W', title: 'Anonymous Pamphlet' },
    });

    const { editions } = await getOpenLibraryService().getEditionsByIdentifiers(
      ['OL999M'],
      'olid',
      createMockContext(),
    );

    expect(editions[0]?.authors).toEqual([]);
  });

  it('returns no authors when the edition has none and no parent work to fall back to', async () => {
    mockFetchRoutes({
      '/api/books': {
        'OLID:OL998M': { details: { key: '/books/OL998M', title: 'Orphan Edition' } },
      },
    });

    const { editions } = await getOpenLibraryService().getEditionsByIdentifiers(
      ['OL998M'],
      'olid',
      createMockContext(),
    );

    expect(editions[0]?.authors).toEqual([]);
    expect(editions[0]?.work_id).toBeUndefined();
  });

  it('keeps the credit with the author ID as its name when a work-level lookup fails', async () => {
    mockFetchRoutes({
      '/api/books': {
        'OLID:OL22855101M': {
          details: { ...CONCORDE, authors: undefined },
        },
      },
      '/works/OL3668495W.json': { authors: [{ author: { key: '/authors/OL631509A' } }] },
      // /authors/OL631509A.json is unrouted and 404s.
    });

    const { editions } = await getOpenLibraryService().getEditionsByIdentifiers(
      ['OL22855101M'],
      'olid',
      createMockContext(),
    );

    expect(editions[0]?.authors).toEqual([
      { name: 'OL631509A', author_id: 'OL631509A', source: 'work' },
    ]);
  });
});

/**
 * Open Library writes `-1` into `covers`/`photos` as a "no image in this slot"
 * sentinel instead of omitting the slot. Every fixture below is the real shape:
 * `https://openlibrary.org/works/OL1812244W.json` returns
 * `"covers": [9198428, 12156701, -1]`, and `/authors/OL23919A.json` returns
 * `"photos": [5543033, -1]`.
 */
describe('OpenLibraryService — cover and photo sentinel filtering', () => {
  /** A real sentinel-bearing array, plus the two other unusable entry shapes. */
  const RAW_COVERS = [9198428, -1, 12156701, 0, null];
  const USABLE_COVERS = [9198428, 12156701];

  beforeEach(() => {
    initOpenLibraryService();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('getWork drops the -1 sentinel, 0, and null from cover_ids', async () => {
    mockFetchRoutes({
      '/works/OL1812244W.json': {
        key: '/works/OL1812244W',
        title: 'Magicats!',
        covers: RAW_COVERS,
      },
    });

    const work = await getOpenLibraryService().getWork('OL1812244W', createMockContext());
    expect(work?.cover_ids).toEqual(USABLE_COVERS);
  });

  it('getEditions drops non-positive cover entries', async () => {
    mockFetchRoutes({
      '/editions.json': {
        size: 1,
        entries: [{ key: '/books/OL1M', title: 'Ed', covers: RAW_COVERS }],
      },
    });

    const result = await getOpenLibraryService().getEditions(
      'OL1812244W',
      10,
      0,
      createMockContext(),
    );
    expect(result?.editions[0]?.cover_ids).toEqual(USABLE_COVERS);
  });

  it('getEditionsByIdentifiers drops non-positive cover entries', async () => {
    mockFetchRoutes({
      '/api/books': {
        'OLID:OL1M': { details: { key: '/books/OL1M', title: 'Ed', covers: RAW_COVERS } },
      },
    });

    const { editions } = await getOpenLibraryService().getEditionsByIdentifiers(
      ['OL1M'],
      'olid',
      createMockContext(),
    );
    expect(editions[0]?.cover_ids).toEqual(USABLE_COVERS);
  });

  it('getAuthorWorks drops non-positive cover entries', async () => {
    mockFetchRoutes({
      '/works.json': {
        size: 1,
        entries: [{ key: '/works/OL1812244W', title: 'Magicats!', covers: RAW_COVERS }],
      },
    });

    const result = await getOpenLibraryService().getAuthorWorks(
      'OL31353A',
      10,
      0,
      createMockContext(),
    );
    expect(result?.works[0]?.cover_ids).toEqual(USABLE_COVERS);
  });

  // The photo path carries the identical sentinel: /authors/OL23919A.json is
  // `"photos": [5543033, -1]` upstream.
  it('getAuthor drops the -1 sentinel from photo_ids', async () => {
    mockFetchRoutes({
      '/authors/OL23919A.json': {
        key: '/authors/OL23919A',
        name: 'Isaac Asimov',
        photos: [5543033, -1],
      },
    });

    const author = await getOpenLibraryService().getAuthor('OL23919A', createMockContext());
    expect(author?.photo_ids).toEqual([5543033]);
  });

  // A record whose only entry is the sentinel has no cover at all, and an empty
  // array already reads that way — the sentinel would not.
  it('yields an empty array when every entry is a sentinel', async () => {
    mockFetchRoutes({
      '/works/OL999W.json': { key: '/works/OL999W', title: 'Coverless', covers: [-1] },
    });

    const work = await getOpenLibraryService().getWork('OL999W', createMockContext());
    expect(work?.cover_ids).toEqual([]);
  });

  it('leaves an all-usable array untouched', async () => {
    mockFetchRoutes({
      '/works/OL45804W.json': { key: '/works/OL45804W', title: 'Gatsby', covers: [9255566, 123] },
    });

    const work = await getOpenLibraryService().getWork('OL45804W', createMockContext());
    expect(work?.cover_ids).toEqual([9255566, 123]);
  });
});

/**
 * Open Library keeps a merged author as a `/type/redirect` stub: the author
 * record answers 200 naming its successor while the works subresource 404s.
 * `OL2162284A` → `OL19981A` (Stephen King) is the live example; the stub body
 * below is `https://openlibrary.org/authors/OL2162284A.json` verbatim.
 */
describe('OpenLibraryService — merged author redirects', () => {
  const REDIRECT_STUB = {
    key: '/authors/OL2162284A',
    type: { key: '/type/redirect' },
    location: '/authors/OL19981A',
    latest_revision: 80,
    revision: 80,
  };

  const CANONICAL_AUTHOR = {
    key: '/authors/OL19981A',
    name: 'Stephen King',
    type: { key: '/type/author' },
    // A live author record carries `location: null` — present, not absent. Any
    // discriminator keyed on `location` existing would misread this as a redirect.
    location: null,
    birth_date: '21 September 1947',
  };

  const CANONICAL_WORKS = {
    size: 2,
    entries: [{ key: '/works/OL81634W', title: 'The Shining' }],
  };

  beforeEach(() => {
    initOpenLibraryService();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ─── getAuthorWorks ────────────────────────────────────────────────────────

  it('getAuthorWorks resolves a merged ID to the canonical author, not not_found', async () => {
    mockFetchRoutes({
      // The stub's own works subresource is unrouted, so it 404s exactly as upstream.
      '/authors/OL2162284A.json': REDIRECT_STUB,
      '/authors/OL19981A.json': CANONICAL_AUTHOR,
      '/authors/OL19981A/works.json': CANONICAL_WORKS,
    });

    const result = await getOpenLibraryService().getAuthorWorks(
      'OL2162284A',
      10,
      0,
      createMockContext(),
    );

    expect(result).not.toBeNull();
    // The canonical ID is reported back so the caller learns the stable one.
    expect(result?.author_id).toBe('OL19981A');
    expect(result?.works[0]?.work_id).toBe('OL81634W');
  });

  it('getAuthorWorks follows a chain of two redirects', async () => {
    mockFetchRoutes({
      '/authors/OL1A.json': {
        key: '/authors/OL1A',
        type: { key: '/type/redirect' },
        location: '/authors/OL2A',
      },
      '/authors/OL2A.json': REDIRECT_STUB,
      '/authors/OL19981A.json': CANONICAL_AUTHOR,
      '/authors/OL19981A/works.json': CANONICAL_WORKS,
    });

    const result = await getOpenLibraryService().getAuthorWorks('OL1A', 10, 0, createMockContext());
    expect(result?.author_id).toBe('OL19981A');
  });

  /**
   * The fail-closed cases below all assert the request count as well as the
   * null: returning null is what the *unfixed* service did for every redirect
   * too, so the count is what distinguishes "walked the chain and stopped" from
   * both "never followed it" and "followed it forever".
   */
  it('getAuthorWorks walks a chain past the hop cap and stops, rather than looping', async () => {
    // 20 stubs, each pointing at the next — the chain never reaches an author.
    const routes: Record<string, unknown> = {};
    for (let i = 0; i < 20; i++) {
      routes[`/authors/OL${i}A.json`] = {
        key: `/authors/OL${i}A`,
        type: { key: '/type/redirect' },
        location: `/authors/OL${i + 1}A`,
      };
    }
    const fetchSpy = mockFetchRoutes(routes);

    await expect(
      getOpenLibraryService().getAuthorWorks('OL0A', 10, 0, createMockContext()),
    ).resolves.toBeNull();

    // The works page, then one author fetch per hop up to the cap.
    const calls = fetchSpy.mock.calls.length;
    expect(calls).toBeGreaterThan(1);
    // Uncapped this would walk all 20 stubs.
    expect(calls).toBeLessThanOrEqual(2 + MAX_AUTHOR_REDIRECT_HOPS);
  });

  it('getAuthorWorks stops on a circular redirect instead of ping-ponging', async () => {
    // Both IDs are real OLID shapes (OL<digits>A) so the cycle guard is what
    // stops this, not the malformed-target check.
    const fetchSpy = mockFetchRoutes({
      '/authors/OL1111A.json': {
        key: '/authors/OL1111A',
        type: { key: '/type/redirect' },
        location: '/authors/OL2222A',
      },
      '/authors/OL2222A.json': {
        key: '/authors/OL2222A',
        type: { key: '/type/redirect' },
        location: '/authors/OL1111A',
      },
    });

    await expect(
      getOpenLibraryService().getAuthorWorks('OL1111A', 10, 0, createMockContext()),
    ).resolves.toBeNull();

    // Works page + both stubs; the repeat is caught without spending the cap.
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it.each([
    ['a null location', null],
    ['an absent location', undefined],
    ['a non-author location', '/works/OL45804W'],
    ['an empty location', ''],
  ])('getAuthorWorks fails closed on a redirect with %s', async (_label, location) => {
    const fetchSpy = mockFetchRoutes({
      '/authors/OL2162284A.json': {
        key: '/authors/OL2162284A',
        type: { key: '/type/redirect' },
        ...(location === undefined ? {} : { location }),
      },
    });

    await expect(
      getOpenLibraryService().getAuthorWorks('OL2162284A', 10, 0, createMockContext()),
    ).resolves.toBeNull();

    // Works page + the stub. A malformed target is rejected on inspection, never
    // fetched — a third request would mean the service guessed at a path.
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  // The redirect lookup is a second request, so it must not be spent on the
  // overwhelming majority of lookups that never redirect.
  it('getAuthorWorks costs exactly one request when the author is not merged', async () => {
    const fetchSpy = mockFetchRoutes({ '/authors/OL19981A/works.json': CANONICAL_WORKS });

    const result = await getOpenLibraryService().getAuthorWorks(
      'OL19981A',
      10,
      0,
      createMockContext(),
    );

    expect(result?.author_id).toBe('OL19981A');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  // A live author with no works subresource must not send the resolver in a
  // circle re-requesting the ID it started from.
  it('getAuthorWorks returns null without retrying when the ID resolves to itself', async () => {
    const fetchSpy = mockFetchRoutes({ '/authors/OL19981A.json': CANONICAL_AUTHOR });

    await expect(
      getOpenLibraryService().getAuthorWorks('OL19981A', 10, 0, createMockContext()),
    ).resolves.toBeNull();
    // The works page (404) plus the author record — never a third request.
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  // ─── getAuthor ─────────────────────────────────────────────────────────────

  it('getAuthor returns the canonical record rather than the nameless stub', async () => {
    mockFetchRoutes({
      '/authors/OL2162284A.json': REDIRECT_STUB,
      '/authors/OL19981A.json': CANONICAL_AUTHOR,
    });

    const author = await getOpenLibraryService().getAuthor('OL2162284A', createMockContext());

    // The stub carries its own `key` and no `name`, so the pre-fix guard passed
    // it through as an author named ''.
    expect(author?.name).toBe('Stephen King');
    expect(author?.author_id).toBe('OL19981A');
  });

  it('getAuthor treats a live record with location: null as an author, not a redirect', async () => {
    const fetchSpy = mockFetchRoutes({ '/authors/OL19981A.json': CANONICAL_AUTHOR });

    const author = await getOpenLibraryService().getAuthor('OL19981A', createMockContext());

    expect(author?.name).toBe('Stephen King');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('getAuthor fails closed on a redirect naming no usable target', async () => {
    mockFetchRoutes({
      '/authors/OL2162284A.json': {
        key: '/authors/OL2162284A',
        type: { key: '/type/redirect' },
        location: null,
      },
    });

    await expect(
      getOpenLibraryService().getAuthor('OL2162284A', createMockContext()),
    ).resolves.toBeNull();
  });

  it('getAuthor still reports a genuinely absent author as null', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(notFoundResponse());
    await expect(
      getOpenLibraryService().getAuthor('OL999999999999A', createMockContext()),
    ).resolves.toBeNull();
  });

  // ─── Resource surface ──────────────────────────────────────────────────────

  it('the author resource inherits the redirect fix', async () => {
    mockFetchRoutes({
      '/authors/OL2162284A.json': REDIRECT_STUB,
      '/authors/OL19981A.json': CANONICAL_AUTHOR,
    });

    const params = openlibraryAuthorResource.params!.parse({ author_id: 'OL2162284A' });
    const ctx = createMockContext({ uri: new URL('openlibrary://authors/OL2162284A') });
    const result = await openlibraryAuthorResource.handler(params, ctx);

    expect(result.name).toBe('Stephen King');
    // The resource has no enrichment channel, so its author_id carrying the
    // canonical value is the only signal available — and it must carry it.
    expect(result.author_id).toBe('OL19981A');
  });
});

describe('OpenLibraryService — edition batch enrichment concurrency', () => {
  /**
   * Enough editions that the ungated fan-out is unmistakable: none carry inline
   * authors, so each costs a work lookup plus one lookup per author credit —
   * 30 + 90 follow-up requests, every one of them previously issued in the same
   * tick off a single `Promise.all`.
   */
  const EDITION_COUNT = 30;
  const AUTHORS_PER_WORK = 3;

  /** Bibkey map plus the work/author records the enrichment path walks to. */
  function batchFixture() {
    const identifiers: string[] = [];
    const bibkeys: Record<string, unknown> = {};
    const routes: Record<string, unknown> = {};

    for (let i = 0; i < EDITION_COUNT; i++) {
      const editionId = `OL${1000 + i}M`;
      const workId = `OL${2000 + i}W`;
      const authorIds = Array.from(
        { length: AUTHORS_PER_WORK },
        (_, a) => `OL${3000 + i * AUTHORS_PER_WORK + a}A`,
      );

      identifiers.push(editionId);
      bibkeys[`OLID:${editionId}`] = {
        details: {
          key: `/books/${editionId}`,
          title: `Title ${i}`,
          works: [{ key: `/works/${workId}` }],
        },
      };
      routes[`/works/${workId}.json`] = {
        authors: authorIds.map((id) => ({ author: { key: `/authors/${id}` } })),
      };
      for (const id of authorIds) {
        routes[`/authors/${id}.json`] = { name: `Author ${id}` };
      }
    }

    return { identifiers, routes: { '/api/books': bibkeys, ...routes } };
  }

  /**
   * Routes like `mockFetchRoutes`, but records how many requests are in flight
   * at once. Each response is deferred past the current macrotask so overlapping
   * requests genuinely overlap rather than each settling before the next is
   * issued.
   */
  function trackingFetchRoutes(routes: Record<string, unknown>) {
    const tracker = { inFlight: 0, peak: 0 };

    vi.spyOn(globalThis, 'fetch').mockImplementation((async (input: unknown) => {
      tracker.inFlight++;
      tracker.peak = Math.max(tracker.peak, tracker.inFlight);
      try {
        await new Promise((resolve) => setTimeout(resolve, 1));
        const url = requestUrl(input);
        for (const [fragment, body] of Object.entries(routes)) {
          if (url.includes(fragment)) {
            return new Response(JSON.stringify(body), { status: 200 });
          }
        }
        return notFoundResponse();
      } finally {
        tracker.inFlight--;
      }
    }) as typeof globalThis.fetch);

    return tracker;
  }

  beforeEach(() => {
    initOpenLibraryService();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('never exceeds the enrichment concurrency cap against Open Library', async () => {
    const { identifiers, routes } = batchFixture();
    const tracker = trackingFetchRoutes(routes);

    await getOpenLibraryService().getEditionsByIdentifiers(
      identifiers,
      'olid',
      createMockContext(),
    );

    // Ungated, the peak is one request per edition (and later per author credit)
    // — an order of magnitude past the cap.
    expect(tracker.peak).toBeLessThanOrEqual(EDITION_ENRICHMENT_CONCURRENCY);
    // …but the cap must bound the fan-out, not flatten it into serial requests.
    expect(tracker.peak).toBeGreaterThan(1);
  });

  it('resolves every edition, in request order, with its work-level authors', async () => {
    const { identifiers, routes } = batchFixture();
    trackingFetchRoutes(routes);

    const { editions, unresolved } = await getOpenLibraryService().getEditionsByIdentifiers(
      identifiers,
      'olid',
      createMockContext(),
    );

    expect(unresolved).toEqual([]);
    expect(editions.map((e) => e.edition_id)).toEqual(identifiers);
    for (const edition of editions) {
      expect(edition.authors).toHaveLength(AUTHORS_PER_WORK);
      expect(edition.authors.every((a) => a.source === 'work')).toBe(true);
      expect(edition.authors.map((a) => a.name)).toEqual(
        edition.authors.map((a) => `Author ${a.author_id}`),
      );
    }
  });
});
