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
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openlibraryAuthorResource } from '@/mcp-server/resources/definitions/openlibrary-author.resource.js';
import { openlibraryWorkResource } from '@/mcp-server/resources/definitions/openlibrary-work.resource.js';
import { openlibraryGetAuthor } from '@/mcp-server/tools/definitions/openlibrary-get-author.tool.js';
import { openlibraryGetAuthorWorks } from '@/mcp-server/tools/definitions/openlibrary-get-author-works.tool.js';
import { openlibraryGetEdition } from '@/mcp-server/tools/definitions/openlibrary-get-edition.tool.js';
import { openlibraryGetEditions } from '@/mcp-server/tools/definitions/openlibrary-get-editions.tool.js';
import { openlibraryGetWork } from '@/mcp-server/tools/definitions/openlibrary-get-work.tool.js';
import { openlibrarySearchBooks } from '@/mcp-server/tools/definitions/openlibrary-search-books.tool.js';
import {
  EDITION_ENRICHMENT_CONCURRENCY,
  getOpenLibraryService,
  initOpenLibraryService,
  MAX_AUTHOR_REDIRECT_HOPS,
  MAX_WORK_REDIRECT_HOPS,
} from '@/services/open-library/open-library-service.js';

/** A 404 like Open Library returns for a missing by-ID record (works/authors/editions). */
function notFoundResponse(): Response {
  return new Response('{}', { status: 404, statusText: 'Not Found' });
}

/** A 200 `{}` like the /api/books.json bibkeys endpoint returns for an unmatched OCLC. */
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

// The suite never reaches openlibrary.org: a request no test routed fails loudly.
beforeEach(() => {
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unmocked fetch'));
});

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
    ).resolves.toEqual({
      editions: [],
      unresolved: ['99999999', '88888888'],
      authorGaps: { failed: [], skipped: [] },
    });
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

/**
 * Availability objects as `/search.json?fields=…,availability` returns them. The
 * partial shapes are verbatim from live searches (moby dick, calculus,
 * cookbook, programming): Open Library nulls five of the booleans on some
 * `open` works, drops six of them on a `status: "error"` lookup, and nulls
 * `openlibrary_edition` alone on others.
 */
describe('OpenLibraryService — searchBooks availability mapping', () => {
  const COMPLETE = {
    status: 'borrow_available',
    available_to_browse: true,
    available_to_borrow: false,
    available_to_waitlist: false,
    is_printdisabled: true,
    is_readable: false,
    is_lendable: true,
    is_previewable: true,
    identifier: 'jrrtolkienshobbi0000unse',
    openlibrary_work: 'OL16059606W',
    openlibrary_edition: 'OL32589898M',
    is_restricted: true,
    __src__: 'core.models.lending.get_availability',
  };

  const NULL_BOOLEANS = {
    status: 'open',
    available_to_browse: null,
    available_to_borrow: null,
    available_to_waitlist: null,
    is_printdisabled: null,
    is_readable: null,
    is_lendable: null,
    is_previewable: true,
    identifier: 'lp_moby-dick-or-the-whale-by-herman-melville_herman-melville-louis-zorich',
    openlibrary_work: null,
    openlibrary_edition: null,
    is_restricted: false,
    __src__: 'core.models.lending.get_availability',
  };

  const ERROR_STATUS = {
    status: 'error',
    error_message: 'not found',
    identifier: 'calculusmadeeasy00thom_850',
    is_restricted: true,
    is_browseable: false,
    __src__: 'core.models.lending.get_availability',
  };

  const EDITION_NULL_ONLY = {
    status: 'borrow_available',
    available_to_browse: true,
    available_to_borrow: false,
    available_to_waitlist: false,
    is_readable: false,
    is_lendable: true,
    is_previewable: true,
    identifier: 'bwb_P9-CDP-811',
    openlibrary_edition: null,
    is_restricted: true,
  };

  beforeEach(() => {
    initOpenLibraryService();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function availabilityFor(availability: unknown) {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
      Promise.resolve(
        searchResponse({
          ia: ['someitem'],
          ...(availability === undefined ? {} : { availability }),
        }),
      ),
    );
    const result = await getOpenLibraryService().searchBooks(
      { query: 'moby dick', limit: 1, offset: 0, include_availability: true },
      createMockContext(),
    );
    return result.works[0]?.availability;
  }

  it('keeps every schema key of a complete object and drops the rest', async () => {
    expect(await availabilityFor(COMPLETE)).toEqual({
      status: 'borrow_available',
      available_to_browse: true,
      available_to_borrow: false,
      available_to_waitlist: false,
      is_readable: false,
      is_lendable: true,
      is_previewable: true,
      is_restricted: true,
      openlibrary_edition: 'OL32589898M',
    });
  });

  // A `false` default would state the opposite of `status: "open"`.
  it('omits the booleans Open Library nulled rather than defaulting them to false', async () => {
    expect(await availabilityFor(NULL_BOOLEANS)).toEqual({
      status: 'open',
      is_previewable: true,
      is_restricted: false,
    });
  });

  // The IA lookup itself failed, so the flags that ride along are not facts.
  it('keeps only the status of a status "error" object', async () => {
    expect(await availabilityFor(ERROR_STATUS)).toEqual({ status: 'error' });
  });

  it('omits a null openlibrary_edition and keeps the booleans', async () => {
    expect(await availabilityFor(EDITION_NULL_ONLY)).toEqual({
      status: 'borrow_available',
      available_to_browse: true,
      available_to_borrow: false,
      available_to_waitlist: false,
      is_readable: false,
      is_lendable: true,
      is_previewable: true,
      is_restricted: true,
    });
  });

  it('reports "unknown" when the status is missing or not a string', async () => {
    expect(await availabilityFor({ is_readable: true })).toEqual({
      status: 'unknown',
      is_readable: true,
    });
    expect(await availabilityFor({ status: 7, is_readable: 'yes' })).toEqual({
      status: 'unknown',
    });
  });

  it.each([
    ['absent', undefined],
    ['null', null],
    ['a string', 'open'],
    ['an array', [COMPLETE]],
  ])('maps availability that is %s to null', async (_label, value) => {
    expect(await availabilityFor(value)).toBeNull();
  });

  it('leaves availability out entirely when it was not requested', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
      Promise.resolve(searchResponse({ availability: COMPLETE })),
    );
    const result = await getOpenLibraryService().searchBooks(
      { query: 'moby dick', limit: 1, offset: 0 },
      createMockContext(),
    );
    expect(result.works[0]?.availability).toBeUndefined();
  });

  it('returns the whole page through the tool when works carry every partial shape', async () => {
    const shapes = [COMPLETE, NULL_BOOLEANS, ERROR_STATUS, EDITION_NULL_ONLY, 'garbage', null];
    vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            numFound: shapes.length,
            start: 0,
            docs: shapes.map((availability, i) => ({
              key: `/works/OL${i + 1}W`,
              title: `Work ${i + 1}`,
              ia: [`item${i}`],
              availability,
            })),
          }),
          { status: 200 },
        ),
      ),
    );

    const result = await runToolContract(openlibrarySearchBooks, {
      query: 'moby dick',
      limit: 50,
      include_availability: true,
    });

    expect(result.isError).toBeFalsy();
    const works = (result.structuredContent as { works: Array<{ availability: unknown }> }).works;
    expect(works).toHaveLength(shapes.length);
    expect(works.map((w) => w.availability)).toEqual([
      expect.objectContaining({ status: 'borrow_available', is_restricted: true }),
      { status: 'open', is_previewable: true, is_restricted: false },
      { status: 'error' },
      expect.not.objectContaining({ openlibrary_edition: expect.anything() }),
      null,
      null,
    ]);
    const text = result.content.map((block) => ('text' in block ? block.text : '')).join('\n');
    expect(text).toContain('**Availability:** Status: error\n');
    expect(text).toContain('**Availability:** Status: open | Preview: true | Restricted: false');
    expect(text).toContain('No availability returned');
    expect(text).not.toContain('null');
  });
});

/**
 * `OL17952222M` is the live example: its record carries `oclc_number:
 * ["61224395"]` with `oclc_numbers: null`.
 */
describe('OpenLibraryService — OCLC number merging', () => {
  beforeEach(() => {
    initOpenLibraryService();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function oclcFor(details: Record<string, unknown>) {
    mockFetchRoutes({
      '/api/books': { 'OLID:OL17952222M': { details: { key: '/books/OL17952222M', ...details } } },
    });
    const { editions } = await getOpenLibraryService().getEditionsByIdentifiers(
      ['OL17952222M'],
      'olid',
      createMockContext(),
    );
    return editions[0]?.oclc;
  }

  it.each([
    ['only oclc_number', { oclc_number: ['61224395'], oclc_numbers: null }, ['61224395']],
    ['only oclc_numbers', { oclc_numbers: ['244767413'] }, ['244767413']],
    [
      'both keys, overlapping',
      { oclc_numbers: ['1', '2'], oclc_number: ['2', '3'] },
      ['1', '2', '3'],
    ],
    ['both keys, distinct', { oclc_number: ['9'], oclc_numbers: ['8', '7'] }, ['9', '8', '7']],
    ['neither key', {}, []],
    ['both null', { oclc_number: null, oclc_numbers: null }, []],
    ['a duplicate within one key', { oclc_numbers: ['5', '5'] }, ['5']],
  ])('merges %s', async (_label, details, expected) => {
    expect(await oclcFor(details)).toEqual(expected);
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

  // The bibkeys response is keyed by the bibkey as sent, so the check digit is
  // canonicalized once, here, and the caller's spelling is what comes back.
  it('sends an ISBN-10 X check digit upstream in upper case and resolves it', async () => {
    const fetchSpy = mockFetchRoutes({
      '/api/books': {
        'ISBN:080442957X': { details: { key: '/books/OL2838295M', title: 'Prophecy' } },
      },
    });

    const { editions, unresolved } = await getOpenLibraryService().getEditionsByIdentifiers(
      ['0-8044-2957-x'],
      'isbn',
      createMockContext(),
    );

    expect(requestUrl(fetchSpy.mock.calls[0]?.[0])).toContain('ISBN%3A080442957X');
    expect(editions.map((e) => e.edition_id)).toEqual(['OL2838295M']);
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
        key: '/works/OL1168083W',
        type: { key: '/type/work' },
        authors: [{ author: { key: '/authors/OL118077A' }, type: { key: '/type/author_role' } }],
      },
      '/authors/OL118077A.json': {
        key: '/authors/OL118077A',
        type: { key: '/type/author' },
        name: 'George Orwell',
      },
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
      '/works/OL999W.json': {
        key: '/works/OL999W',
        type: { key: '/type/work' },
        title: 'Anonymous Pamphlet',
      },
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
      '/works/OL3668495W.json': {
        key: '/works/OL3668495W',
        type: { key: '/type/work' },
        authors: [{ author: { key: '/authors/OL631509A' } }],
      },
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
        type: { key: '/type/work' },
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
        type: { key: '/type/author' },
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
      '/works/OL999W.json': {
        key: '/works/OL999W',
        type: { key: '/type/work' },
        title: 'Coverless',
        covers: [-1],
      },
    });

    const work = await getOpenLibraryService().getWork('OL999W', createMockContext());
    expect(work?.cover_ids).toEqual([]);
  });

  it('leaves an all-usable array untouched', async () => {
    mockFetchRoutes({
      '/works/OL45804W.json': {
        key: '/works/OL45804W',
        type: { key: '/type/work' },
        title: 'Gatsby',
        covers: [9255566, 123],
      },
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

/**
 * Open Library keeps a merged work as a `/type/redirect` stub: `works/{id}.json`
 * answers 200 naming its successor while `works/{id}/editions.json` 404s.
 * `OL2714496W` → `OL2714491W` is the live one-hop example and
 * `OL5687942W` → `OL2968844W` → `OL2968802W` → `OL2968606W` the live three-hop
 * chain; the stub bodies below carry the fields those records return.
 *
 * Every case asserts the upstream request count: `null` is also what a resolver
 * that never followed the chain, or followed it forever, would return.
 */
describe('OpenLibraryService — merged work redirects', () => {
  function workStub(id: string, location: unknown): Record<string, unknown> {
    return {
      key: `/works/${id}`,
      type: { key: '/type/redirect' },
      ...(location === undefined ? {} : { location }),
      created: { type: '/type/datetime', value: '2009-12-10T00:16:59.713837' },
      last_modified: { type: '/type/datetime', value: '2024-06-28T18:06:18.387122' },
    };
  }

  function liveWork(id: string, title: string): Record<string, unknown> {
    // A live work carries no `location` key at all, unlike a live author.
    return {
      key: `/works/${id}`,
      type: { key: '/type/work' },
      title,
      subjects: ['Self-help'],
      covers: [6481234],
      authors: [{ type: { key: '/type/author_role' }, author: { key: '/authors/OL1234A' } }],
    };
  }

  const CANONICAL_EDITIONS = {
    size: 14,
    entries: [{ key: '/books/OL9M', title: 'The little book of letting go', works: [] }],
  };

  /** A chain of `length` stubs `OL100W → OL101W → …`, ending at `OL1{length}W`. */
  function stubChain(length: number): Record<string, unknown> {
    const routes: Record<string, unknown> = {};
    for (let i = 0; i < length; i++) {
      routes[`/works/OL${100 + i}W.json`] = workStub(`OL${100 + i}W`, `/works/OL${101 + i}W`);
    }
    return routes;
  }

  beforeEach(() => {
    initOpenLibraryService();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ─── getWork ───────────────────────────────────────────────────────────────

  it('getWork costs one request for a live work and reports its own ID', async () => {
    const fetchSpy = mockFetchRoutes({
      '/works/OL2714491W.json': liveWork('OL2714491W', 'The little book of letting go'),
    });

    const work = await getOpenLibraryService().getWork('OL2714491W', createMockContext());

    expect(work?.work_id).toBe('OL2714491W');
    expect(work?.title).toBe('The little book of letting go');
    expect(work?.author_ids).toEqual(['OL1234A']);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('getWork follows a one-hop merge stub to the canonical record', async () => {
    const fetchSpy = mockFetchRoutes({
      '/works/OL2714496W.json': workStub('OL2714496W', '/works/OL2714491W'),
      '/works/OL2714491W.json': liveWork('OL2714491W', 'The little book of letting go'),
    });

    const work = await getOpenLibraryService().getWork('OL2714496W', createMockContext());

    // The stub has a key and no title, so the pre-fix guard returned it hollow.
    expect(work?.title).toBe('The little book of letting go');
    expect(work?.work_id).toBe('OL2714491W');
    expect(work?.subjects).toEqual(['Self-help']);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('getWork follows a three-hop chain and accepts a /works/ prefix', async () => {
    const fetchSpy = mockFetchRoutes({
      '/works/OL5687942W.json': workStub('OL5687942W', '/works/OL2968844W'),
      '/works/OL2968844W.json': workStub('OL2968844W', '/works/OL2968802W'),
      '/works/OL2968802W.json': workStub('OL2968802W', '/works/OL2968606W'),
      '/works/OL2968606W.json': liveWork('OL2968606W', 'Into the Blue'),
    });

    const work = await getOpenLibraryService().getWork('/works/OL5687942W', createMockContext());

    expect(work?.work_id).toBe('OL2968606W');
    expect(work?.title).toBe('Into the Blue');
    expect(fetchSpy).toHaveBeenCalledTimes(4);
  });

  it('getWork resolves a chain exactly at the hop cap', async () => {
    const hops = MAX_WORK_REDIRECT_HOPS;
    const fetchSpy = mockFetchRoutes({
      ...stubChain(hops),
      [`/works/OL${100 + hops}W.json`]: liveWork(`OL${100 + hops}W`, 'End of the chain'),
    });

    const work = await getOpenLibraryService().getWork('OL100W', createMockContext());

    expect(work?.work_id).toBe(`OL${100 + hops}W`);
    expect(fetchSpy).toHaveBeenCalledTimes(hops + 1);
  });

  it('getWork gives up one hop past the cap instead of walking the whole chain', async () => {
    // 20 stubs, with a real work at the far end the resolver must never reach.
    const fetchSpy = mockFetchRoutes({
      ...stubChain(20),
      '/works/OL120W.json': liveWork('OL120W', 'Unreachable'),
    });

    await expect(
      getOpenLibraryService().getWork('OL100W', createMockContext()),
    ).resolves.toBeNull();

    // The starting record plus MAX_WORK_REDIRECT_HOPS followed hops, then stop.
    expect(fetchSpy).toHaveBeenCalledTimes(MAX_WORK_REDIRECT_HOPS + 1);
  });

  it('getWork stops on a circular redirect without spending the hop cap', async () => {
    const fetchSpy = mockFetchRoutes({
      '/works/OL1111W.json': workStub('OL1111W', '/works/OL2222W'),
      '/works/OL2222W.json': workStub('OL2222W', '/works/OL1111W'),
    });

    await expect(
      getOpenLibraryService().getWork('OL1111W', createMockContext()),
    ).resolves.toBeNull();
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('getWork stops on a stub that points at itself', async () => {
    const fetchSpy = mockFetchRoutes({
      '/works/OL1111W.json': workStub('OL1111W', '/works/OL1111W'),
    });

    await expect(
      getOpenLibraryService().getWork('OL1111W', createMockContext()),
    ).resolves.toBeNull();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['a null location', null],
    ['an absent location', undefined],
    ['an empty location', ''],
    ['an author location', '/authors/OL34184A'],
    ['an edition location', '/books/OL7353617M'],
    ['a lowercase work location', '/works/ol2714491w'],
    ['a non-string location', 2714491],
  ])(
    'getWork fails closed on a stub with %s, never fetching a guessed path',
    async (_label, location) => {
      const fetchSpy = mockFetchRoutes({
        '/works/OL2714496W.json': workStub('OL2714496W', location),
        // Reachable only if the resolver guessed at a target.
        '/works/OL2714491W.json': liveWork('OL2714491W', 'The little book of letting go'),
      });

      await expect(
        getOpenLibraryService().getWork('OL2714496W', createMockContext()),
      ).resolves.toBeNull();
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    },
  );

  it('getWork fails closed when a hop mid-chain 404s', async () => {
    const fetchSpy = mockFetchRoutes({
      '/works/OL5687942W.json': workStub('OL5687942W', '/works/OL2968844W'),
      // OL2968844W is unrouted and 404s.
    });

    await expect(
      getOpenLibraryService().getWork('OL5687942W', createMockContext()),
    ).resolves.toBeNull();
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  // Open Library 301s `/works/OL…M.json` and `/works/OL…A.json` to the edition
  // and author records, and native fetch follows the 301 — so a work lookup can
  // be answered 200 by a record of the wrong type. The edition shape below
  // (`authors[].key`, no `author` wrapper) is what crashed the work mapper.
  it.each([
    [
      'an edition',
      'OL7353617M',
      {
        key: '/books/OL7353617M',
        type: { key: '/type/edition' },
        title: 'Fantastic Mr. Fox',
        authors: [{ key: '/authors/OL34184A' }],
        works: [{ key: '/works/OL45804W' }],
      },
    ],
    [
      'an author',
      'OL34184A',
      { key: '/authors/OL34184A', type: { key: '/type/author' }, name: 'Roald Dahl' },
    ],
  ])('getWork reports %s record answering a work URL as absent', async (_label, id, record) => {
    const fetchSpy = mockFetchRoutes({ [`/works/${id}.json`]: record });

    await expect(getOpenLibraryService().getWork(id, createMockContext())).resolves.toBeNull();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('getWork rejects a stub whose target is not a work record', async () => {
    const fetchSpy = mockFetchRoutes({
      '/works/OL2714496W.json': workStub('OL2714496W', '/works/OL2714491W'),
      '/works/OL2714491W.json': { key: '/books/OL2714491M', type: { key: '/type/edition' } },
    });

    await expect(
      getOpenLibraryService().getWork('OL2714496W', createMockContext()),
    ).resolves.toBeNull();
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  // ─── getEditions ───────────────────────────────────────────────────────────

  it('getEditions costs one request for a live work', async () => {
    const fetchSpy = mockFetchRoutes({ '/works/OL2714491W/editions.json': CANONICAL_EDITIONS });

    const result = await getOpenLibraryService().getEditions(
      'OL2714491W',
      10,
      0,
      createMockContext(),
    );

    expect(result?.work_id).toBe('OL2714491W');
    expect(result?.total).toBe(14);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("getEditions resolves a merge stub after a null page and re-pages under the canonical ID with the caller's limit and offset", async () => {
    const fetchSpy = mockFetchRoutes({
      // The stub's own editions page is unrouted, so it 404s exactly as upstream.
      '/works/OL2714496W.json': workStub('OL2714496W', '/works/OL2714491W'),
      '/works/OL2714491W.json': liveWork('OL2714491W', 'The little book of letting go'),
      '/works/OL2714491W/editions.json': CANONICAL_EDITIONS,
    });

    const result = await getOpenLibraryService().getEditions(
      'OL2714496W',
      3,
      6,
      createMockContext(),
    );

    expect(result?.work_id).toBe('OL2714491W');
    expect(result?.editions[0]?.edition_id).toBe('OL9M');
    const urls = fetchSpy.mock.calls.map(([input]: [unknown]) => requestUrl(input));
    expect(urls).toEqual([
      expect.stringContaining('/works/OL2714496W/editions.json?limit=3&offset=6'),
      expect.stringContaining('/works/OL2714496W.json'),
      expect.stringContaining('/works/OL2714491W.json'),
      expect.stringContaining('/works/OL2714491W/editions.json?limit=3&offset=6'),
    ]);
  });

  it('getEditions follows a three-hop chain', async () => {
    const fetchSpy = mockFetchRoutes({
      '/works/OL5687942W.json': workStub('OL5687942W', '/works/OL2968844W'),
      '/works/OL2968844W.json': workStub('OL2968844W', '/works/OL2968802W'),
      '/works/OL2968802W.json': workStub('OL2968802W', '/works/OL2968606W'),
      '/works/OL2968606W.json': liveWork('OL2968606W', 'Into the Blue'),
      '/works/OL2968606W/editions.json': { size: 2, entries: [] },
    });

    const result = await getOpenLibraryService().getEditions(
      'OL5687942W',
      10,
      0,
      createMockContext(),
    );

    expect(result?.work_id).toBe('OL2968606W');
    // Null page, four records, then the canonical page.
    expect(fetchSpy).toHaveBeenCalledTimes(6);
  });

  it('getEditions reports an absent ID as null after one resolution request', async () => {
    const fetchSpy = mockFetchRoutes({});

    await expect(
      getOpenLibraryService().getEditions('OL999999999W', 10, 0, createMockContext()),
    ).resolves.toBeNull();
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  // A live work whose editions page 404s must not send the resolver back to the
  // page it just asked for.
  it('getEditions returns null without re-requesting when the ID resolves to itself', async () => {
    const fetchSpy = mockFetchRoutes({
      '/works/OL2714491W.json': liveWork('OL2714491W', 'The little book of letting go'),
    });

    await expect(
      getOpenLibraryService().getEditions('OL2714491W', 10, 0, createMockContext()),
    ).resolves.toBeNull();
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('getEditions gives up one hop past the cap', async () => {
    const fetchSpy = mockFetchRoutes(stubChain(20));

    await expect(
      getOpenLibraryService().getEditions('OL100W', 10, 0, createMockContext()),
    ).resolves.toBeNull();
    expect(fetchSpy).toHaveBeenCalledTimes(1 + MAX_WORK_REDIRECT_HOPS + 1);
  });

  it('getEditions stops on a circular redirect', async () => {
    const fetchSpy = mockFetchRoutes({
      '/works/OL1111W.json': workStub('OL1111W', '/works/OL2222W'),
      '/works/OL2222W.json': workStub('OL2222W', '/works/OL1111W'),
    });

    await expect(
      getOpenLibraryService().getEditions('OL1111W', 10, 0, createMockContext()),
    ).resolves.toBeNull();
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it('getEditions fails closed on a stub whose location is not a work OLID', async () => {
    const fetchSpy = mockFetchRoutes({
      '/works/OL2714496W.json': workStub('OL2714496W', '/authors/OL34184A'),
    });

    await expect(
      getOpenLibraryService().getEditions('OL2714496W', 10, 0, createMockContext()),
    ).resolves.toBeNull();
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  // ─── Tool and resource surfaces ────────────────────────────────────────────

  /** Text of every content block, joined. */
  function contentText(result: { content: unknown[] }): string {
    return result.content
      .map((block) => (block && typeof block === 'object' && 'text' in block ? block.text : ''))
      .join('\n');
  }

  it('openlibrary_get_work reports the canonical ID and discloses the substitution on both surfaces', async () => {
    mockFetchRoutes({
      '/works/OL2714496W.json': workStub('OL2714496W', '/works/OL2714491W'),
      '/works/OL2714491W.json': liveWork('OL2714491W', 'The little book of letting go'),
    });

    const result = await runToolContract(openlibraryGetWork, { work_id: 'OL2714496W' });

    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as { work_id: string; notice?: string };
    expect(structured.work_id).toBe('OL2714491W');
    expect(structured.notice).toContain('OL2714496W');
    expect(structured.notice).toContain('OL2714491W');
    expect(contentText(result)).toContain(structured.notice as string);
    expect(openlibraryGetWork.output.parse(structured).work_id).toBe('OL2714491W');
  });

  it('openlibrary_get_work adds no notice for a live work', async () => {
    mockFetchRoutes({
      '/works/OL2714491W.json': liveWork('OL2714491W', 'The little book of letting go'),
    });

    const result = await runToolContract(openlibraryGetWork, { work_id: '/works/OL2714491W' });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).not.toHaveProperty('notice');
  });

  // `notice` is last-wins, so a merged work with a capped subject list must
  // carry both disclosures in one string rather than losing the first.
  it('openlibrary_get_work joins the merge notice with the subject-cap notice', async () => {
    mockFetchRoutes({
      '/works/OL2714496W.json': workStub('OL2714496W', '/works/OL2714491W'),
      '/works/OL2714491W.json': {
        ...liveWork('OL2714491W', 'The little book of letting go'),
        subjects: Array.from({ length: 12 }, (_, i) => `subject-${i}`),
      },
    });

    const result = await runToolContract(openlibraryGetWork, { work_id: 'OL2714496W' });

    const notice = (result.structuredContent as { notice?: string }).notice;
    expect(notice).toContain('OL2714496W');
    expect(notice).toContain('OL2714491W');
    expect(notice).toContain('showing 10 of 12');
  });

  it('openlibrary_get_work reports not_found for a stub whose location is not a work OLID', async () => {
    mockFetchRoutes({
      '/works/OL2714496W.json': workStub('OL2714496W', '/works/OL7353617M'),
    });

    const result = await runToolContract(openlibraryGetWork, { work_id: 'OL2714496W' });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.NotFound, data: { reason: 'not_found' } },
    });
  });

  it('openlibrary_get_editions reports the canonical ID and discloses the substitution on both surfaces', async () => {
    mockFetchRoutes({
      '/works/OL2714496W.json': workStub('OL2714496W', '/works/OL2714491W'),
      '/works/OL2714491W.json': liveWork('OL2714491W', 'The little book of letting go'),
      '/works/OL2714491W/editions.json': CANONICAL_EDITIONS,
    });

    const result = await runToolContract(openlibraryGetEditions, {
      work_id: 'OL2714496W',
      limit: 3,
      offset: 6,
    });

    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as {
      work_id: string;
      offset: number;
      notice?: string;
    };
    expect(structured.work_id).toBe('OL2714491W');
    // The retry keeps the caller's page, and the echo is the requested offset.
    expect(structured.offset).toBe(6);
    expect(structured.notice).toContain('OL2714496W');
    expect(structured.notice).toContain('OL2714491W');
    expect(contentText(result)).toContain(structured.notice as string);
    expect(openlibraryGetEditions.output.parse(structured).work_id).toBe('OL2714491W');
  });

  it('openlibrary_get_editions adds no notice for a live work', async () => {
    mockFetchRoutes({ '/works/OL2714491W/editions.json': CANONICAL_EDITIONS });

    const result = await runToolContract(openlibraryGetEditions, { work_id: 'OL2714491W' });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).not.toHaveProperty('notice');
  });

  it('the work resource returns the canonical record for a merged ID', async () => {
    mockFetchRoutes({
      '/works/OL2714496W.json': workStub('OL2714496W', '/works/OL2714491W'),
      '/works/OL2714491W.json': liveWork('OL2714491W', 'The little book of letting go'),
    });

    const params = openlibraryWorkResource.params!.parse({ work_id: 'OL2714496W' });
    const ctx = createMockContext({ uri: new URL('openlibrary://works/OL2714496W') });
    const result = await openlibraryWorkResource.handler(params, ctx);

    expect(result.title).toBe('The little book of letting go');
    // The resource has no enrichment channel; its work_id is the only signal.
    expect(result.work_id).toBe('OL2714491W');
  });

  // The resource takes no input pattern, so an edition OLID reaches the service.
  it('the work resource reports an edition OLID as NotFound, not an InternalError', async () => {
    mockFetchRoutes({
      '/works/OL7353617M.json': {
        key: '/books/OL7353617M',
        type: { key: '/type/edition' },
        authors: [{ key: '/authors/OL34184A' }],
      },
    });

    const params = openlibraryWorkResource.params!.parse({ work_id: 'OL7353617M' });
    const ctx = createMockContext({ uri: new URL('openlibrary://works/OL7353617M') });
    const error = await Promise.resolve(openlibraryWorkResource.handler(params, ctx)).catch(
      (e) => e,
    );

    expect(error).toBeInstanceOf(McpError);
    expect((error as McpError).code).toBe(JsonRpcErrorCode.NotFound);
  });
});

/**
 * Open Library 301s `/authors/OL…W.json` and `/authors/OL…M.json` to the work
 * and edition records, and native fetch follows the 301 — so an author lookup
 * can be answered 200 by a record of another type. Only a `/type/author` record
 * is an author, whether reached directly or at the end of a redirect chain.
 */
describe('OpenLibraryService — author lookups reject records of another type', () => {
  const WORK_AT_AUTHOR_URL = {
    key: '/works/OL45804W',
    type: { key: '/type/work' },
    title: 'Fantastic Mr Fox',
    authors: [{ author: { key: '/authors/OL34184A' } }],
  };
  const EDITION_AT_AUTHOR_URL = {
    key: '/books/OL7353617M',
    type: { key: '/type/edition' },
    title: 'Fantastic Mr. Fox',
    authors: [{ key: '/authors/OL34184A' }],
  };
  const LIVE_AUTHOR = {
    key: '/authors/OL23919A',
    type: { key: '/type/author' },
    name: 'J. K. Rowling',
    location: null,
  };

  function contentText(result: { content: unknown[] }): string {
    return result.content
      .map((block) => (block && typeof block === 'object' && 'text' in block ? block.text : ''))
      .join('\n');
  }

  beforeEach(() => {
    initOpenLibraryService();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    ['a work', 'OL45804W', WORK_AT_AUTHOR_URL],
    ['an edition', 'OL7353617M', EDITION_AT_AUTHOR_URL],
  ])(
    'getAuthor reports %s record answering an author URL as absent',
    async (_label, id, record) => {
      const fetchSpy = mockFetchRoutes({ [`/authors/${id}.json`]: record });

      await expect(getOpenLibraryService().getAuthor(id, createMockContext())).resolves.toBeNull();
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    },
  );

  it('getAuthor rejects a redirect whose target answers with a work record', async () => {
    const fetchSpy = mockFetchRoutes({
      '/authors/OL2162284A.json': {
        key: '/authors/OL2162284A',
        type: { key: '/type/redirect' },
        location: '/authors/OL19981A',
      },
      '/authors/OL19981A.json': { ...WORK_AT_AUTHOR_URL, key: '/works/OL19981W' },
    });

    await expect(
      getOpenLibraryService().getAuthor('OL2162284A', createMockContext()),
    ).resolves.toBeNull();
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('getAuthorWorks reports a work ID as absent after one resolution request', async () => {
    // The works subresource 404s for a non-author ID, so the resolver runs.
    const fetchSpy = mockFetchRoutes({ '/authors/OL45804W.json': WORK_AT_AUTHOR_URL });

    await expect(
      getOpenLibraryService().getAuthorWorks('OL45804W', 10, 0, createMockContext()),
    ).resolves.toBeNull();
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('openlibrary_get_author fails not_found with no merge notice for a work ID', async () => {
    mockFetchRoutes({ '/authors/OL45804W.json': WORK_AT_AUTHOR_URL });

    const result = await runToolContract(openlibraryGetAuthor, { author_id: 'OL45804W' });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.NotFound, data: { reason: 'not_found' } },
    });
    expect(result.structuredContent).not.toHaveProperty('notice');
    expect(contentText(result)).not.toContain('merged record');
  });

  it('openlibrary_get_author_works fails not_found with no merge notice for a work ID', async () => {
    mockFetchRoutes({ '/authors/OL45804W.json': WORK_AT_AUTHOR_URL });

    const result = await runToolContract(openlibraryGetAuthorWorks, { author_id: 'OL45804W' });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.NotFound, data: { reason: 'not_found' } },
    });
    expect(contentText(result)).not.toContain('merged record');
  });

  it('the author resource reports an edition OLID as NotFound', async () => {
    mockFetchRoutes({ '/authors/OL7353617M.json': EDITION_AT_AUTHOR_URL });

    const params = openlibraryAuthorResource.params!.parse({ author_id: 'OL7353617M' });
    const ctx = createMockContext({ uri: new URL('openlibrary://authors/OL7353617M') });
    const error = await Promise.resolve(openlibraryAuthorResource.handler(params, ctx)).catch(
      (e) => e,
    );

    expect(error).toBeInstanceOf(McpError);
    expect((error as McpError).code).toBe(JsonRpcErrorCode.NotFound);
  });

  // No input pattern narrows `author_id`: every form Open Library answers with
  // an author record keeps resolving.
  it.each([
    ['a bare OLID', 'OL23919A', '/authors/OL23919A.json'],
    ['an /authors/-prefixed OLID', '/authors/OL23919A', '/authors/OL23919A.json'],
    ['a lowercase OLID the upstream answers', 'ol23919a', '/authors/ol23919a.json'],
  ])('openlibrary_get_author still resolves %s', async (_label, authorId, path) => {
    const fetchSpy = mockFetchRoutes({ [path]: LIVE_AUTHOR });

    const result = await runToolContract(openlibraryGetAuthor, { author_id: authorId });

    expect(result.isError).toBeFalsy();
    const structured = openlibraryGetAuthor.output.parse(result.structuredContent);
    expect(structured.author_id).toBe('OL23919A');
    expect(structured.name).toBe('J. K. Rowling');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

/**
 * An edition with no inline authors takes its credits from the parent work. When
 * that parent was merged away, `works/{id}.json` answers with a redirect stub
 * carrying no `authors`, so the credits live on the canonical work; when a
 * credited author was merged away, its stub carries no `name`, so the name and
 * the stable ID live on the canonical author.
 */
describe('OpenLibraryService — edition author enrichment through merged works and authors', () => {
  beforeEach(() => {
    initOpenLibraryService();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('recovers the credits from the canonical work when the parent work is a merge stub', async () => {
    const fetchSpy = mockFetchRoutes({
      '/api/books': {
        'OLID:OL5M': {
          details: {
            key: '/books/OL5M',
            title: 'Stubbed Parent',
            works: [{ key: '/works/OL2714496W' }],
          },
        },
      },
      '/works/OL2714496W.json': {
        key: '/works/OL2714496W',
        type: { key: '/type/redirect' },
        location: '/works/OL2714491W',
      },
      '/works/OL2714491W.json': {
        key: '/works/OL2714491W',
        type: { key: '/type/work' },
        authors: [{ author: { key: '/authors/OL1234A' } }],
      },
      '/authors/OL1234A.json': {
        key: '/authors/OL1234A',
        type: { key: '/type/author' },
        name: 'Real Author',
      },
    });

    const { editions, authorGaps } = await getOpenLibraryService().getEditionsByIdentifiers(
      ['OL5M'],
      'olid',
      createMockContext(),
    );

    expect(editions[0]?.authors).toEqual([
      { name: 'Real Author', author_id: 'OL1234A', source: 'work' },
    ]);
    expect(authorGaps).toEqual({ failed: [], skipped: [] });
    // bibkeys, stub, canonical work, author.
    expect(fetchSpy).toHaveBeenCalledTimes(4);
  });

  it('recovers no credits, without a gap, when the parent stub names no work', async () => {
    const fetchSpy = mockFetchRoutes({
      '/api/books': {
        'OLID:OL5M': {
          details: {
            key: '/books/OL5M',
            title: 'Broken Parent',
            works: [{ key: '/works/OL2714496W' }],
          },
        },
      },
      '/works/OL2714496W.json': {
        key: '/works/OL2714496W',
        type: { key: '/type/redirect' },
        location: '/authors/OL1234A',
      },
    });

    const { editions, authorGaps } = await getOpenLibraryService().getEditionsByIdentifiers(
      ['OL5M'],
      'olid',
      createMockContext(),
    );

    expect(editions[0]?.authors).toEqual([]);
    expect(authorGaps).toEqual({ failed: [], skipped: [] });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  /** An edition with no inline authors whose live parent work credits `authorKey`. */
  function creditedBy(authorKey: string): Record<string, unknown> {
    return {
      '/api/books': {
        'OLID:OL5M': {
          details: { key: '/books/OL5M', title: 'Credited', works: [{ key: '/works/OL5W' }] },
        },
      },
      '/works/OL5W.json': {
        key: '/works/OL5W',
        type: { key: '/type/work' },
        authors: [{ author: { key: authorKey } }],
      },
    };
  }

  // `/authors/OL2162284A.json` is a live merge stub pointing at OL19981A.
  it('credits the canonical author, by ID and name, when the credited author is a merge stub', async () => {
    const fetchSpy = mockFetchRoutes({
      ...creditedBy('/authors/OL2162284A'),
      '/authors/OL2162284A.json': {
        key: '/authors/OL2162284A',
        type: { key: '/type/redirect' },
        location: '/authors/OL19981A',
      },
      '/authors/OL19981A.json': {
        key: '/authors/OL19981A',
        type: { key: '/type/author' },
        name: 'Stephen King',
        location: null,
      },
    });

    const { editions, authorGaps } = await getOpenLibraryService().getEditionsByIdentifiers(
      ['OL5M'],
      'olid',
      createMockContext(),
    );

    expect(editions[0]?.authors).toEqual([
      { name: 'Stephen King', author_id: 'OL19981A', source: 'work' },
    ]);
    expect(authorGaps).toEqual({ failed: [], skipped: [] });
    // bibkeys, work, author stub, canonical author.
    expect(fetchSpy).toHaveBeenCalledTimes(4);
  });

  it('keeps the credited ID as the name, without a gap, when the author stub resolves to nothing', async () => {
    const fetchSpy = mockFetchRoutes({
      ...creditedBy('/authors/OL2162284A'),
      '/authors/OL2162284A.json': {
        key: '/authors/OL2162284A',
        type: { key: '/type/redirect' },
        location: '/authors/OL19981A',
      },
      // OL19981A is unrouted and 404s.
    });

    const { editions, authorGaps } = await getOpenLibraryService().getEditionsByIdentifiers(
      ['OL5M'],
      'olid',
      createMockContext(),
    );

    expect(editions[0]?.authors).toEqual([
      { name: 'OL2162284A', author_id: 'OL2162284A', source: 'work' },
    ]);
    expect(authorGaps).toEqual({ failed: [], skipped: [] });
    expect(fetchSpy).toHaveBeenCalledTimes(4);
  });

  // Per the author resolver's type check, a work answering an author URL is not
  // an author: the credit keeps its ID, and it is no gap.
  it('keeps the credited ID as the name, without a gap, when the credit names a non-author record', async () => {
    const fetchSpy = mockFetchRoutes({
      ...creditedBy('/authors/OL45804W'),
      '/authors/OL45804W.json': {
        key: '/works/OL45804W',
        type: { key: '/type/work' },
        title: 'Fantastic Mr Fox',
      },
    });

    const { editions, authorGaps } = await getOpenLibraryService().getEditionsByIdentifiers(
      ['OL5M'],
      'olid',
      createMockContext(),
    );

    expect(editions[0]?.authors).toEqual([
      { name: 'OL45804W', author_id: 'OL45804W', source: 'work' },
    ]);
    expect(authorGaps).toEqual({ failed: [], skipped: [] });
    expect(fetchSpy).toHaveBeenCalledTimes(3);
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
        key: `/works/${workId}`,
        type: { key: '/type/work' },
        authors: authorIds.map((id) => ({ author: { key: `/authors/${id}` } })),
      };
      for (const id of authorIds) {
        routes[`/authors/${id}.json`] = {
          key: `/authors/${id}`,
          type: { key: '/type/author' },
          name: `Author ${id}`,
        };
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
