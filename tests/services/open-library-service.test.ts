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
  getOpenLibraryService,
  initOpenLibraryService,
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

  // ─── getEditionByIdentifier throws a tagged not_found ───────────────────────

  it('getEditionByIdentifier throws not_found with data.reason on a 404 (isbn branch)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(notFoundResponse());
    const svc = getOpenLibraryService();
    const ctx = createMockContext({ errors: openlibraryGetEdition.errors });

    const error = await svc.getEditionByIdentifier('9780000000000', 'isbn', ctx).catch((e) => e);
    expect(error).toBeInstanceOf(McpError);
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'not_found' },
    });
  });

  it('getEditionByIdentifier throws not_found with data.reason for an unmatched OCLC (200 {})', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(emptyOkResponse());
    const svc = getOpenLibraryService();
    const ctx = createMockContext({ errors: openlibraryGetEdition.errors });

    const error = await svc.getEditionByIdentifier('99999999', 'oclc', ctx).catch((e) => e);
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

    const error = await openlibraryGetWork.handler(input, ctx).catch((e) => e);
    expect(error).toBeInstanceOf(McpError);
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'not_found' },
    });
  });

  it('surfaces a clean NotFound (not FetchHttpError) through the author resource on a 404', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(notFoundResponse());
    const params = openlibraryAuthorResource.params.parse({ author_id: 'OL999999999999A' });
    const ctx = createMockContext({ uri: new URL('openlibrary://authors/OL999999999999A') });

    const error = await openlibraryAuthorResource.handler(params, ctx).catch((e) => e);
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

describe('OpenLibraryService — edition identifier and author mapping', () => {
  /** OL22855101M — a real record whose lccn and lc_classifications differ. */
  const CONCORDE = {
    key: '/books/OL22855101M',
    title: 'Concorde',
    authors: [{ key: '/authors/OL631509A' }],
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

  it('maps lccn from the upstream lccn field and call numbers to lc_classifications (isbn/olid route)', async () => {
    mockFetchRoutes({
      '/books/OL22855101M.json': CONCORDE,
      '/authors/OL631509A.json': { name: 'Yves Marc' },
    });

    const edition = await getOpenLibraryService().getEditionByIdentifier(
      'OL22855101M',
      'olid',
      createMockContext(),
    );

    // The control number is the lookupable identifier; the call number is not.
    expect(edition.lccn).toEqual(['2008478952']);
    expect(edition.lc_classifications).toEqual(['TL685.7 .M366 2008']);
    expect(edition.oclc).toEqual(['244767413']);
  });

  it('maps lccn from the upstream lccn field on the oclc/lccn route too', async () => {
    mockFetchRoutes({
      '/api/books': {
        'LCCN:2008478952': {
          details: { ...CONCORDE, authors: [{ key: '/authors/OL631509A', name: 'Yves Marc' }] },
        },
      },
    });

    const edition = await getOpenLibraryService().getEditionByIdentifier(
      '2008478952',
      'lccn',
      createMockContext(),
    );

    expect(edition.lccn).toEqual(['2008478952']);
    expect(edition.lc_classifications).toEqual(['TL685.7 .M366 2008']);
  });

  it('tags edition-level authors with source "edition"', async () => {
    mockFetchRoutes({
      '/books/OL22855101M.json': CONCORDE,
      '/authors/OL631509A.json': { name: 'Yves Marc' },
    });

    const edition = await getOpenLibraryService().getEditionByIdentifier(
      'OL22855101M',
      'olid',
      createMockContext(),
    );

    expect(edition.authors).toEqual([
      { name: 'Yves Marc', author_id: 'OL631509A', source: 'edition' },
    ]);
  });

  it('falls back to the parent work when the edition records no authors (isbn/olid route)', async () => {
    // OL34854896M — authors is null upstream; authorship lives on OL1168083W.
    mockFetchRoutes({
      '/isbn/9780451524935.json': {
        key: '/books/OL34854896M',
        title: 'Nineteen Eighty-Four',
        authors: null,
        works: [{ key: '/works/OL1168083W' }],
      },
      '/works/OL1168083W.json': {
        authors: [{ author: { key: '/authors/OL118077A' }, type: { key: '/type/author_role' } }],
      },
      '/authors/OL118077A.json': { name: 'George Orwell' },
    });

    const edition = await getOpenLibraryService().getEditionByIdentifier(
      '9780451524935',
      'isbn',
      createMockContext(),
    );

    expect(edition.authors).toEqual([
      { name: 'George Orwell', author_id: 'OL118077A', source: 'work' },
    ]);
  });

  it('falls back to the parent work on the oclc/lccn route as well', async () => {
    mockFetchRoutes({
      '/api/books': {
        'OCLC:12345678': {
          details: {
            key: '/books/OL34854896M',
            title: 'Nineteen Eighty-Four',
            works: [{ key: '/works/OL1168083W' }],
          },
        },
      },
      '/works/OL1168083W.json': {
        authors: [{ author: { key: '/authors/OL118077A' } }],
      },
      '/authors/OL118077A.json': { name: 'George Orwell' },
    });

    const edition = await getOpenLibraryService().getEditionByIdentifier(
      '12345678',
      'oclc',
      createMockContext(),
    );

    expect(edition.authors).toEqual([
      { name: 'George Orwell', author_id: 'OL118077A', source: 'work' },
    ]);
  });

  it('returns no authors, and no error, when neither the edition nor its work has any', async () => {
    mockFetchRoutes({
      '/books/OL999M.json': {
        key: '/books/OL999M',
        title: 'Anonymous Pamphlet',
        works: [{ key: '/works/OL999W' }],
      },
      '/works/OL999W.json': { key: '/works/OL999W', title: 'Anonymous Pamphlet' },
    });

    const edition = await getOpenLibraryService().getEditionByIdentifier(
      'OL999M',
      'olid',
      createMockContext(),
    );

    expect(edition.authors).toEqual([]);
  });

  it('returns no authors when the edition has none and no parent work to fall back to', async () => {
    mockFetchRoutes({
      '/books/OL998M.json': { key: '/books/OL998M', title: 'Orphan Edition' },
    });

    const edition = await getOpenLibraryService().getEditionByIdentifier(
      'OL998M',
      'olid',
      createMockContext(),
    );

    expect(edition.authors).toEqual([]);
    expect(edition.work_id).toBeUndefined();
  });

  it('keeps the credit with the author ID as its name when the author lookup fails', async () => {
    mockFetchRoutes({
      '/books/OL22855101M.json': CONCORDE,
      // /authors/OL631509A.json is unrouted and 404s.
    });

    const edition = await getOpenLibraryService().getEditionByIdentifier(
      'OL22855101M',
      'olid',
      createMockContext(),
    );

    expect(edition.authors).toEqual([
      { name: 'OL631509A', author_id: 'OL631509A', source: 'edition' },
    ]);
  });
});
