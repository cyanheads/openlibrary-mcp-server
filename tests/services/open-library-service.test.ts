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
  RETRY_DEADLINE_MS,
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

describe('OpenLibraryService — search filter compatibility', () => {
  afterEach(() => vi.restoreAllMocks());

  it.each(['', undefined])('keeps a %s query omitted beside a title filter', async (query) => {
    initOpenLibraryService();
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ numFound: 0, start: 100, docs: [] })));
    await expect(
      getOpenLibraryService().searchBooks(
        { query, title: 'Pride and Prejudice', limit: 100, offset: 100 },
        createMockContext(),
      ),
    ).resolves.toEqual({ total: 0, offset: 100, works: [] });
    const url = new URL(requestUrl(fetchSpy.mock.calls[0]?.[0]));
    expect(url.searchParams.has('q')).toBe(false);
    expect(url.searchParams.get('title')).toBe('Pride and Prejudice');
    expect(url.searchParams.get('limit')).toBe('100');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

describe('OpenLibraryService — searchBooks criteria forwarding', () => {
  beforeEach(() => initOpenLibraryService());
  afterEach(() => vi.restoreAllMocks());

  type SearchParams = Parameters<ReturnType<typeof getOpenLibraryService>['searchBooks']>[0];

  /** The criterion parameters one search sent upstream, keyed by their upstream names. */
  async function sentCriteria(
    params: Omit<SearchParams, 'limit' | 'offset'>,
  ): Promise<Record<string, string>> {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(() => Promise.resolve(searchResponse({})));
    await getOpenLibraryService().searchBooks(
      { ...params, limit: 1, offset: 0 },
      createMockContext(),
    );
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const url = new URL(requestUrl(fetchSpy.mock.calls[0]?.[0]));
    return Object.fromEntries(
      ['q', 'title', 'author', 'subject', 'publisher', 'isbn'].flatMap((name) => {
        const value = url.searchParams.get(name);
        return value === null ? [] : [[name, value]];
      }),
    );
  }

  // Upstream counts padding toward its 3-character query minimum: " ab" matches, "ab" is a 422.
  it.each<[Omit<SearchParams, 'limit' | 'offset'>, Record<string, string>]>([
    [{ query: ' ab' }, { q: ' ab' }],
    [{ query: 'ab' }, { q: 'ab' }],
    [{ query: 'title:' }, { q: 'title:' }],
    [{ query: 'ia:callmeishmael0000olso' }, { q: 'ia:callmeishmael0000olso' }],
    [{ query: '', title: 'faust' }, { title: 'faust' }],
    [{ title: ' faust ' }, { title: ' faust ' }],
    [{ isbn: '9780140449136' }, { isbn: '9780140449136' }],
    [{ isbn: '978-0-14-044913-6' }, { isbn: '9780140449136' }],
  ])('sends %j as given: %j', async (params, sent) => {
    expect(await sentCriteria(params)).toEqual(sent);
  });

  const BLANKS = ['', ' ', '   ', '\t', '\n', ' \t\r\n '];
  const CRITERIA = ['query', 'title', 'author', 'subject', 'publisher', 'isbn'] as const;

  it.each(CRITERIA.flatMap((field) => BLANKS.map((blank) => [field, blank] as const)))(
    'leaves a blank %s (%j) out of the request beside a real criterion',
    async (field, blank) => {
      const other = field === 'title' ? { author: 'goethe' } : { title: 'faust' };
      expect(await sentCriteria({ ...other, [field]: blank })).toEqual(other);
    },
  );

  it.each(['-', '--', ' - ', '-\t-'])(
    'leaves a hyphen-only isbn (%j) out of the request',
    async (isbn) => {
      expect(await sentCriteria({ title: 'faust', isbn })).toEqual({ title: 'faust' });
    },
  );
});

describe('OpenLibraryService — metadata and normalization', () => {
  beforeEach(() => initOpenLibraryService());
  afterEach(() => vi.restoreAllMocks());

  it.each(['', '/authors/'])(
    'rejects empty normalized author %s before either lookup',
    async (id) => {
      const fetchSpy = mockFetchRoutes({
        '/authors/.json': {
          key: '/authors/',
          type: { key: '/type/redirect' },
          location: '/authors/OL1A',
        },
        '/authors/OL1A.json': {
          key: '/authors/OL1A',
          type: { key: '/type/author' },
          name: 'Wrong author',
        },
        '/authors//works.json': { size: 1, entries: [{ key: '/works/OL1W', title: 'Wrong work' }] },
      });
      await expect(getOpenLibraryService().getAuthor(id, createMockContext())).resolves.toBeNull();
      await expect(
        getOpenLibraryService().getAuthorWorks(id, 10, 0, createMockContext()),
      ).resolves.toBeNull();
      expect(fetchSpy).not.toHaveBeenCalled();
    },
  );

  it.each([' Science Fiction ', '\tScience   Fiction\n', ' 科学 小说 '])(
    'trims subject %s before normalizing',
    async (subject) => {
      const fetchSpy = mockFetchRoutes({
        '/subjects/': { name: 'subject', work_count: 0, works: [] },
      });
      const result = await getOpenLibraryService().getSubject(subject, 10, 20, createMockContext());
      const key = subject.includes('科学') ? '科学_小说' : 'science_fiction';
      expect(result.subject_key).toBe(key);
      expect(decodeURIComponent(requestUrl(fetchSpy.mock.calls[0]?.[0]))).toContain(
        `/subjects/${key}.json`,
      );
      expect(result.work_count).toBe(0);
    },
  );

  it('preserves every language and independently optional physical fields in detail and list', async () => {
    mockFetchRoutes({
      '/api/books.json': {
        'OLID:OL1M': {
          details: {
            key: '/books/OL1M',
            languages: [{ key: '/languages/eng' }, { key: '/languages/chi' }],
            physical_format: 'paperback',
            edition_name: 'Second Dell printing',
          },
        },
        'OLID:OL2M': {
          details: {
            key: '/books/OL2M',
            languages: [{ key: '/languages/fre' }],
            physical_format: null,
            edition_name: 'First Edition.',
          },
        },
        'OLID:OL3M': {
          details: {
            key: '/books/OL3M',
            languages: [],
            physical_format: 'Hard Cover',
            edition_name: '',
          },
        },
        'OLID:OL4M': { details: { key: '/books/OL4M', physical_format: '', edition_name: null } },
      },
      '/works/OL1W/editions.json': {
        size: 4,
        entries: [
          {
            key: '/books/OL1M',
            physical_format: 'paperback',
            edition_name: 'Second Dell printing',
          },
          { key: '/books/OL2M', physical_format: null, edition_name: 'First Edition.' },
          { key: '/books/OL3M', physical_format: 'Hard Cover', edition_name: '' },
          { key: '/books/OL4M' },
        ],
      },
    });
    const detail = await getOpenLibraryService().getEditionsByIdentifiers(
      ['OL1M', 'OL2M', 'OL3M', 'OL4M'],
      'olid',
      createMockContext(),
    );
    expect(detail.editions[0]).toMatchObject({
      language: 'eng',
      languages: ['eng', 'chi'],
      physical_format: 'paperback',
      edition_name: 'Second Dell printing',
    });
    expect(detail.editions[1]).toMatchObject({
      language: 'fre',
      languages: ['fre'],
      edition_name: 'First Edition.',
    });
    expect(detail.editions[1]).not.toHaveProperty('physical_format');
    expect(detail.editions[2]).toMatchObject({ physical_format: 'Hard Cover' });
    expect(detail.editions[2]).not.toHaveProperty('language');
    expect(detail.editions[2]).not.toHaveProperty('languages');
    expect(detail.editions[2]).not.toHaveProperty('edition_name');
    expect(detail.editions[3]).not.toHaveProperty('physical_format');
    expect(detail.editions[3]).not.toHaveProperty('edition_name');
    const list = await getOpenLibraryService().getEditions('OL1W', 100, 0, createMockContext());
    expect(list?.editions[0]).toMatchObject({
      physical_format: 'paperback',
      edition_name: 'Second Dell printing',
    });
    expect(list?.editions[1]).not.toHaveProperty('physical_format');
    expect(list?.editions[1]).toHaveProperty('edition_name', 'First Edition.');
    expect(list?.editions[2]).toHaveProperty('physical_format', 'Hard Cover');
    expect(list?.editions[2]).not.toHaveProperty('edition_name');
    expect(list?.editions[3]).not.toHaveProperty('physical_format');
  });

  it.each([
    { query: 'dune' },
    { author: 'Herbert' },
    { language: 'fre' },
    { query: 'language:fre' },
    { publisher: 'Penguin' },
  ])('preserves provider selection for %j', async (params) => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      searchResponse({
        edition_count: 77,
        editions: {
          numFound: 6,
          docs: [
            {
              key: '/books/OL1M',
              title: 'Selected',
              language: ['eng', 'fre'],
              publisher: ['A', 'B'],
            },
            { key: '/books/OL2M', title: 'Second' },
          ],
        },
      }),
    );
    const result = await getOpenLibraryService().searchBooks(
      { ...params, limit: 100, offset: 0 },
      createMockContext(),
    );
    expect(result.works[0]).toMatchObject({
      edition_count: 77,
      matching_edition_count: 6,
      matching_edition: {
        edition_id: 'OL1M',
        title: 'Selected',
        languages: ['eng', 'fre'],
        publishers: ['A', 'B'],
      },
    });
    const fields = new URL(requestUrl(fetchSpy.mock.calls[0]?.[0])).searchParams
      .get('fields')
      ?.split(',');
    expect(fields).toEqual(
      expect.arrayContaining([
        'editions',
        'editions.key',
        'editions.title',
        'editions.language',
        'editions.publisher',
      ]),
    );
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it.each([
    [undefined, {}],
    [{ numFound: 0, docs: [] }, { matching_edition_count: 0 }],
    [{ numFound: 4, docs: [{}] }, { matching_edition_count: 4 }],
    [
      { numFound: 1, docs: [{ key: '/books/OL1M' }] },
      { matching_edition_count: 1, matching_edition: { edition_id: 'OL1M' } },
    ],
    [{ numFound: 'bad', docs: [{ key: null, title: 3, language: 'fre' }] }, {}],
  ])('keeps sparse nested search metadata absent: %j', async (editions, expected) => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(searchResponse({ editions }));
    const result = await getOpenLibraryService().searchBooks(
      { query: 'dune', limit: 1, offset: 0 },
      createMockContext(),
    );
    expect(result.works[0]).toMatchObject(expected);
    if (!('matching_edition' in expected))
      expect(result.works[0]).not.toHaveProperty('matching_edition');
    if (!('matching_edition_count' in expected))
      expect(result.works[0]).not.toHaveProperty('matching_edition_count');
  });
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
    const ctx = createMockContext({
      uri: new URL('openlibrary://authors/OL999999999999A'),
      errors: openlibraryAuthorResource.errors,
    });

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

  /** The 20 ISO 639-2 terminology codes that differ from their bibliographic (MARC) forms. */
  const TERMINOLOGY_TO_MARC = [
    ['deu', 'ger'],
    ['fra', 'fre'],
    ['nld', 'dut'],
    ['zho', 'chi'],
    ['ces', 'cze'],
    ['ell', 'gre'],
    ['fas', 'per'],
    ['ron', 'rum'],
    ['slk', 'slo'],
    ['cym', 'wel'],
    ['sqi', 'alb'],
    ['hye', 'arm'],
    ['eus', 'baq'],
    ['mya', 'bur'],
    ['kat', 'geo'],
    ['isl', 'ice'],
    ['mkd', 'mac'],
    ['mri', 'mao'],
    ['msa', 'may'],
    ['bod', 'tib'],
  ] as const;

  it.each(
    TERMINOLOGY_TO_MARC.flatMap(([code, marc]) =>
      [code, code.toUpperCase(), `${code[0]!.toUpperCase()}${code.slice(1)}`].map(
        (variant) => [variant, marc] as const,
      ),
    ),
  )('sends the ISO 639-2/T code %s as its MARC code %s', async (code, marc) => {
    expect(new URL(await searchUrl(code)).searchParams.get('language')).toBe(marc);
  });

  it.each(['cmn', 'yue', 'esk', 'und', 'mul', 'scc', 'ger', 'GER'])(
    'sends the language record code %s as itself, lowercased',
    async (code) => {
      expect(new URL(await searchUrl(code)).searchParams.get('language')).toBe(code.toLowerCase());
    },
  );

  it.each(['zxx', 'ZXX', 'ajm', 'kus', 'max', 'tru'])(
    'sends the MARC code %s, which no Open Library record carries, as itself, lowercased',
    async (code) => {
      expect(new URL(await searchUrl(code)).searchParams.get('language')).toBe(code.toLowerCase());
    },
  );

  it.each(['qqq', 'QQQ', 'xyz'])(
    'rejects %s, which is neither a MARC code nor an Open Library language record, before any request',
    async (code) => {
      const fetchSpy = vi
        .spyOn(globalThis, 'fetch')
        .mockImplementation(() => Promise.resolve(searchResponse({})));
      const error = await getOpenLibraryService()
        .searchBooks({ title: 'faust', language: code, limit: 3, offset: 0 }, createMockContext())
        .catch((e: unknown) => e);
      expect(error).toMatchObject({
        code: JsonRpcErrorCode.ValidationError,
        message: expect.stringContaining(`"${code}"`),
        data: {
          reason: 'unknown_language_code',
          recovery: { hint: expect.stringContaining('3-letter') },
        },
      });
      expect((error as McpError).message).toContain('3-letter');
      expect(fetchSpy).not.toHaveBeenCalled();
    },
  );

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

type FetchInit = Parameters<typeof globalThis.fetch>[1];
type SearchHandler = (url: string, init: FetchInit) => Response | Promise<Response>;

/** A page doc in the shape the page request returns: availability is never on the work. */
function pageDoc(workId: string, overrides: Record<string, unknown> = {}) {
  return {
    key: `/works/${workId}`,
    title: `Title ${workId}`,
    editions: {
      numFound: 3,
      start: 0,
      numFoundExact: true,
      docs: [{ key: `/books/${workId.replace('W', 'M')}`, title: 'Selected', language: ['eng'] }],
    },
    ...overrides,
  };
}

/** True for the keyed availability lookup rather than the page request. */
function isAvailabilityLookup(url: string): boolean {
  return new URL(url).searchParams.get('q')?.startsWith('key:(') ?? false;
}

/** The work IDs a keyed availability lookup names, in request order. */
function lookupKeys(url: string): string[] {
  const q = new URL(url).searchParams.get('q') ?? '';
  return [...q.matchAll(/"\/works\/(OL\d+W)"/g)].map((match) => match[1] ?? '');
}

/** Every request a search sent, split into the page request and the keyed lookups. */
function sentRequests(fetchSpy: ReturnType<typeof serveSearch>) {
  const urls = fetchSpy.mock.calls.map((call) => requestUrl(call[0]));
  return {
    page: urls.filter((url) => !isAvailabilityLookup(url)),
    lookups: urls.filter(isAvailabilityLookup),
  };
}

/** A keyed-lookup answer carrying `availability` for each work ID, keyed as upstream keys them. */
function lookupResponse(entries: Array<[workId: string, availability?: unknown]>): Response {
  return new Response(
    JSON.stringify({
      numFound: entries.length,
      start: 0,
      docs: entries.map(([workId, availability]) => ({
        key: `/works/${workId}`,
        ia: [`${workId.toLowerCase()}item`],
        ...(availability === undefined ? {} : { availability }),
      })),
    }),
    { status: 200 },
  );
}

/**
 * Serves `docs` as the page and answers each keyed lookup with `lookup`. `page`
 * can delay or reshape the page answer; it receives the default response.
 */
function serveSearch(
  docs: Array<Record<string, unknown>>,
  lookup: SearchHandler = () => lookupResponse([]),
  page?: (respond: () => Response, init: FetchInit) => Response | Promise<Response>,
) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(((input: unknown, init: FetchInit) => {
    const url = requestUrl(input);
    if (isAvailabilityLookup(url)) return Promise.resolve(lookup(url, init));
    const respond = () =>
      new Response(JSON.stringify({ numFound: docs.length, start: 0, docs }), { status: 200 });
    return Promise.resolve(page ? page(respond, init) : respond());
  }) as typeof globalThis.fetch);
}

/** A request that never answers: it settles only when its signal aborts, as a stalled socket does. */
function hang(init: FetchInit): Promise<Response> {
  return new Promise((_resolve, reject) => {
    const signal = init?.signal;
    signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
}

/** Answers with `respond()` after `ms` of fake-clock time, unless the request aborts first. */
function answerAfter(ms: number, init: FetchInit, respond: () => Response): Promise<Response> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(respond()), ms);
    init?.signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(init.signal?.reason);
      },
      { once: true },
    );
  });
}

/**
 * Starts `run` on the fake clock and records how it settled and at what
 * fake-clock time, without leaving a rejection unhandled while the clock runs.
 */
function track<T>(run: () => Promise<T>) {
  const startedAt = Date.now();
  const state: { value?: T; error?: unknown; elapsedMs?: number } = {};
  const done = run().then(
    (value) => {
      Object.assign(state, { value, elapsedMs: Date.now() - startedAt });
    },
    (error: unknown) => {
      Object.assign(state, { error, elapsedMs: Date.now() - startedAt });
    },
  );
  return { state, done };
}

/** Runs `run` on the fake clock, advancing it through one whole call deadline, pauses included. */
async function settle<T>(run: () => Promise<T>): Promise<T> {
  const [result] = await Promise.all([run(), vi.advanceTimersByTimeAsync(RETRY_DEADLINE_MS)]);
  return result;
}

/**
 * Availability objects as the keyed `/search.json` lookup
 * (`fields=key,ia,availability`) returns them on each work. The partial shapes
 * are verbatim from live searches (moby dick, calculus, cookbook, programming):
 * Open Library nulls five of the booleans on some `open` works, drops six of
 * them on a `status: "error"` lookup, and nulls `openlibrary_edition` alone on
 * others.
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
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  async function availabilityFor(availability: unknown) {
    vi.useFakeTimers();
    serveSearch([pageDoc('OL45804W', { ia: ['someitem'] })], () =>
      lookupResponse([['OL45804W', availability]]),
    );
    const result = await settle(() =>
      getOpenLibraryService().searchBooks(
        { query: 'moby dick', limit: 1, offset: 0, include_availability: true },
        createMockContext(),
      ),
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

  it('returns the whole page through the tool when works carry every partial shape', async () => {
    vi.useFakeTimers();
    const shapes = [COMPLETE, NULL_BOOLEANS, ERROR_STATUS, EDITION_NULL_ONLY, 'garbage', null];
    serveSearch(
      shapes.map((_, i) => pageDoc(`OL${i + 1}W`, { title: `Work ${i + 1}`, ia: [`item${i}`] })),
      () => lookupResponse(shapes.map((availability, i) => [`OL${i + 1}W`, availability])),
    );

    const result = await settle(() =>
      runToolContract(openlibrarySearchBooks, {
        query: 'moby dick',
        limit: 50,
        include_availability: true,
      }),
    );

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
    // A null payload is the Internet Archive giving no answer, so OL6W alone is unknown.
    const { notice } = result.structuredContent as { notice?: string };
    expect(notice).toContain('Availability is unknown for work OL6W:');
    expect(text).toContain(notice);
  });
});

/**
 * With `editions` in `fields`, Open Library attaches `availability` to the
 * selected edition (`editions.docs[0]`) — and only when that nested doc carries
 * an `ia` item — never to the work. So the page request cannot answer work-level
 * availability; a keyed `/search.json` lookup does, by exact work key.
 */
describe('OpenLibraryService — searchBooks keyed availability lookup', () => {
  beforeEach(() => {
    initOpenLibraryService();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('keeps matching_edition and matching_edition_count from the page request', async () => {
    serveSearch([pageDoc('OL102749W', { ia: ['mobydick00melv'] })]);

    const result = await getOpenLibraryService().searchBooks(
      { title: 'moby dick', author: 'melville', limit: 1, offset: 0, include_availability: true },
      createMockContext(),
    );

    expect(result.works[0]).toMatchObject({
      work_id: 'OL102749W',
      matching_edition_count: 3,
      matching_edition: { edition_id: 'OL102749M', title: 'Selected', languages: ['eng'] },
    });
  });

  it('sends one request and leaves availability absent when it was not requested', async () => {
    const fetchSpy = serveSearch([pageDoc('OL102749W', { ia: ['mobydick00melv'] })]);

    const result = await getOpenLibraryService().searchBooks(
      { query: 'moby dick', limit: 1, offset: 0 },
      createMockContext(),
    );

    expect(result.works[0]?.availability).toBeUndefined();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(sentRequests(fetchSpy).lookups).toEqual([]);
  });

  it('sends no lookup and maps availability to null when no returned work has an IA item', async () => {
    const fetchSpy = serveSearch([pageDoc('OL1W'), pageDoc('OL2W', { ia: [] })]);

    const result = await getOpenLibraryService().searchBooks(
      { query: 'obscure', limit: 2, offset: 0, include_availability: true },
      createMockContext(),
    );

    expect(result.works.map((w) => w.availability)).toEqual([null, null]);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('sends no lookup on an empty page', async () => {
    const fetchSpy = serveSearch([]);

    const result = await getOpenLibraryService().searchBooks(
      { query: 'xyzzy', limit: 10, offset: 0, include_availability: true },
      createMockContext(),
    );

    expect(result.works).toEqual([]);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  // The #55 repro: OL102749W is public domain, yet 0.4.0 answered null.
  it('returns the work-level status from the keyed lookup, not the selected edition', async () => {
    serveSearch(
      [
        pageDoc('OL102749W', {
          ia: ['bwb_W9-CNP-717'],
          editions: {
            numFound: 1109,
            start: 0,
            numFoundExact: true,
            docs: [
              {
                key: '/books/OL58723483M',
                title: 'Moby Dick',
                availability: { status: 'borrow_unavailable', is_lendable: true },
              },
            ],
          },
        }),
      ],
      () =>
        lookupResponse([
          ['OL102749W', { status: 'open', is_readable: true, identifier: 'bwb_W9-CNP-717' }],
        ]),
    );

    const result = await getOpenLibraryService().searchBooks(
      { title: 'moby dick', author: 'melville', limit: 1, offset: 0, include_availability: true },
      createMockContext(),
    );

    expect(result.works[0]).toMatchObject({
      work_id: 'OL102749W',
      availability: { status: 'open', is_readable: true },
      matching_edition_count: 1109,
      matching_edition: { edition_id: 'OL58723483M', title: 'Moby Dick' },
    });
    expect(result.availabilityUnknown).toBeUndefined();
  });

  it('leaves availability out of the page request', async () => {
    const fetchSpy = serveSearch([pageDoc('OL1W', { ia: ['item1'] })]);

    await getOpenLibraryService().searchBooks(
      { query: 'moby dick', limit: 1, offset: 0, include_availability: true },
      createMockContext(),
    );

    const [pageUrl] = sentRequests(fetchSpy).page;
    const fields = new URL(pageUrl ?? '').searchParams.get('fields')?.split(',');
    expect(fields).not.toContain('availability');
    expect(fields).toEqual(expect.arrayContaining(['ia', 'editions', 'editions.key']));
  });

  it('names exactly the returned works with an IA item, by quoted full key', async () => {
    const fetchSpy = serveSearch([
      pageDoc('OL1W', { ia: ['item1'] }),
      pageDoc('OL2W'),
      pageDoc('OL3W', { ia: ['item3a', 'item3b'] }),
    ]);

    await getOpenLibraryService().searchBooks(
      { query: 'whales', limit: 3, offset: 0, include_availability: true },
      createMockContext(),
    );

    const { lookups } = sentRequests(fetchSpy);
    expect(lookups).toHaveLength(1);
    const params = new URL(lookups[0] ?? '').searchParams;
    expect(params.get('q')).toBe('key:("/works/OL1W" OR "/works/OL3W")');
    // Without `ia` in the field list, Open Library returns no availability at all.
    expect(params.get('fields')).toBe('key,ia,availability');
    expect(params.get('limit')).toBe('2');
  });

  // Only an OLID-shaped key is spliced into the quoted query, so a key carrying a quote never reaches it.
  it('leaves a work with an IA item but no OLID key out of the lookup, as none returned', async () => {
    const fetchSpy = serveSearch([
      pageDoc('OL1W', { ia: ['item1'] }),
      pageDoc('OL4W" OR "x', { ia: ['item4'] }),
      { ...pageDoc('OL5W', { ia: ['item5'] }), key: undefined },
      pageDoc('OL3W', { ia: ['item3'] }),
    ]);

    const result = await getOpenLibraryService().searchBooks(
      { query: 'whales', limit: 4, offset: 0, include_availability: true },
      createMockContext(),
    );

    const { lookups } = sentRequests(fetchSpy);
    expect(lookups).toHaveLength(1);
    const params = new URL(lookups[0] ?? '').searchParams;
    expect(params.get('q')).toBe('key:("/works/OL1W" OR "/works/OL3W")');
    expect(params.get('limit')).toBe('2');
    expect(result.works.map((w) => [w.work_id, w.availability])).toEqual([
      ['OL1W', null],
      ['OL4W" OR "x', null],
      ['', null],
      ['OL3W', null],
    ]);
    expect(result.availabilityUnknown).toBeUndefined();
  });

  it('sends no lookup when the only work with an IA item has no OLID key', async () => {
    const fetchSpy = serveSearch([pageDoc('OL1W'), pageDoc('OL4W" OR "x', { ia: ['item4'] })]);

    const result = await getOpenLibraryService().searchBooks(
      { query: 'whales', limit: 2, offset: 0, include_availability: true },
      createMockContext(),
    );

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(result.works.map((w) => w.availability)).toEqual([null, null]);
    expect(result.availabilityUnknown).toBeUndefined();
  });

  it('splits a 1000-row page into lookups of at most 100 keys and joins each on key', async () => {
    // 750 of 1000 works carry an IA item; the lookup omits every tenth of them.
    const ids = Array.from({ length: 1000 }, (_, i) => `OL${i + 1}W`);
    const withIa = ids.filter((_, i) => i % 4 !== 3);
    const omitted = new Set(withIa.filter((_, i) => i % 10 === 0));
    const fetchSpy = serveSearch(
      ids.map((id, i) => pageDoc(id, i % 4 !== 3 ? { ia: [`${id}item`] } : {})),
      (url) =>
        // Answered in reverse, so only a join by key can line rows up.
        lookupResponse(
          lookupKeys(url)
            .filter((id) => !omitted.has(id))
            .reverse()
            .map((id) => [id, { status: `status-${id}` }]),
        ),
    );

    const result = await getOpenLibraryService().searchBooks(
      { query: 'history', limit: 1000, offset: 0, include_availability: true },
      createMockContext(),
    );

    const { lookups } = sentRequests(fetchSpy);
    expect(lookups.map((url) => lookupKeys(url).length)).toEqual([
      100, 100, 100, 100, 100, 100, 100, 50,
    ]);
    expect(lookups.map((url) => new URL(url).searchParams.get('limit'))).toEqual([
      '100',
      '100',
      '100',
      '100',
      '100',
      '100',
      '100',
      '50',
    ]);
    expect(lookups.flatMap(lookupKeys)).toEqual(withIa);
    expect(result.works).toHaveLength(1000);
    for (const work of result.works) {
      const expected =
        withIa.includes(work.work_id) && !omitted.has(work.work_id)
          ? { status: `status-${work.work_id}` }
          : null;
      expect(work.availability).toEqual(expected);
    }
    expect(result.availabilityUnknown).toBeUndefined();
  });

  it('keeps at most three lookups in flight, and reaches three', async () => {
    const tracker = { inFlight: 0, peak: 0 };
    const ids = Array.from({ length: 1000 }, (_, i) => `OL${i + 1}W`);
    serveSearch(
      ids.map((id) => pageDoc(id, { ia: [`${id}item`] })),
      async (url) => {
        tracker.inFlight++;
        tracker.peak = Math.max(tracker.peak, tracker.inFlight);
        try {
          await new Promise((resolve) => setTimeout(resolve, 1));
          return lookupResponse(lookupKeys(url).map((id) => [id, { status: 'open' }]));
        } finally {
          tracker.inFlight--;
        }
      },
    );

    const result = await getOpenLibraryService().searchBooks(
      { query: 'history', limit: 1000, offset: 0, include_availability: true },
      createMockContext(),
    );

    expect(result.works.every((w) => w.availability?.status === 'open')).toBe(true);
    // Ten lookups, so three can be in flight at once.
    expect(tracker.peak).toBe(3);
  });

  it.each([
    [
      'a gateway 503 page',
      () =>
        new Response('<html><body><h1>503 Service Unavailable</h1></body></html>', { status: 503 }),
    ],
    ['a 2xx HTML page', () => new Response('<!DOCTYPE html><html><body>down</body></html>')],
    ['an HTTP 404', () => new Response('{}', { status: 404 })],
    [
      'an HTTP 422',
      () => new Response(JSON.stringify({ detail: [{ msg: 'Invalid' }] }), { status: 422 }),
    ],
    ['a body of another shape', () => new Response(JSON.stringify({ docs: 'none' }))],
  ])(
    'degrades %s from the lookup to availability unknown, in one request',
    async (_label, fail) => {
      const fetchSpy = serveSearch(
        [pageDoc('OL1W', { ia: ['item1'] }), pageDoc('OL2W'), pageDoc('OL3W', { ia: ['item3'] })],
        fail,
      );

      const result = await getOpenLibraryService().searchBooks(
        { query: 'whales', limit: 3, offset: 0, include_availability: true },
        createMockContext(),
      );

      // The page survives; neither invalid_search_query nor not_found reaches the caller.
      expect(result.total).toBe(3);
      expect(result.works.map((w) => w.availability)).toEqual([null, null, null]);
      expect(result.availabilityUnknown).toEqual(['OL1W', 'OL3W']);
      expect(sentRequests(fetchSpy).lookups).toHaveLength(1);
    },
  );

  /**
   * Live shape: when the Internet Archive's availability service fails, Open
   * Library still answers 200 and sets every work's `availability` to `null`,
   * while a work with no scan the Internet Archive lends has the key left out.
   */
  it('reports a work answered with availability null as unknown, and keeps looking up', async () => {
    vi.useFakeTimers();
    const ids = Array.from({ length: 150 }, (_, i) => `OL${i + 1}W`);
    const fetchSpy = serveSearch(
      ids.map((id) => pageDoc(id, { ia: [`${id}item`] })),
      (url) => {
        const keys = lookupKeys(url);
        // The first lookup's batch failed upstream; the second answered.
        if (keys[0] === 'OL1W') return lookupResponse(keys.map((id) => [id, null]));
        return lookupResponse(
          keys.map((id) => (id === 'OL150W' ? [id] : [id, { status: 'borrow_available' }])),
        );
      },
    );

    const result = await settle(() =>
      getOpenLibraryService().searchBooks(
        { query: 'history', limit: 150, offset: 0, include_availability: true },
        createMockContext(),
      ),
    );

    // The null batch is asked about once more, then left unknown.
    expect(sentRequests(fetchSpy).lookups).toHaveLength(3);
    expect(result.availabilityUnknown).toEqual(ids.slice(0, 100));
    expect(result.works.slice(0, 100).every((w) => w.availability === null)).toBe(true);
    expect(result.works[100]?.availability).toEqual({ status: 'borrow_available' });
    // Left out of the answer: no lendable scan, which is "none returned", not unknown.
    expect(result.works[149]?.availability).toBeNull();
  });

  it('asks once more about only the works answered null, and takes the second answer', async () => {
    vi.useFakeTimers();
    let calls = 0;
    const fetchSpy = serveSearch(
      ['OL1W', 'OL2W', 'OL3W'].map((id) => pageDoc(id, { ia: [`${id}item`] })),
      (url) => {
        calls += 1;
        if (calls === 1) {
          return lookupResponse([
            ['OL1W', null],
            ['OL2W', { status: 'open' }],
            ['OL3W', null],
          ]);
        }
        return lookupResponse(
          lookupKeys(url).map((id) => [id, id === 'OL1W' ? { status: 'borrow_available' } : null]),
        );
      },
    );

    const result = await settle(() =>
      getOpenLibraryService().searchBooks(
        { query: 'history', limit: 3, offset: 0, include_availability: true },
        createMockContext(),
      ),
    );

    const { lookups } = sentRequests(fetchSpy);
    expect(lookups).toHaveLength(2);
    expect(lookupKeys(lookups[1] ?? '')).toEqual(['OL1W', 'OL3W']);
    expect(result.works.map((w) => w.availability)).toEqual([
      { status: 'borrow_available' },
      { status: 'open' },
      null,
    ]);
    expect(result.availabilityUnknown).toEqual(['OL3W']);
  });

  it('keeps the first answer when the second ask fails at the HTTP level', async () => {
    vi.useFakeTimers();
    let calls = 0;
    serveSearch([pageDoc('OL1W', { ia: ['a'] }), pageDoc('OL2W', { ia: ['b'] })], () => {
      calls += 1;
      return calls === 1
        ? lookupResponse([
            ['OL1W', null],
            ['OL2W', { status: 'open' }],
          ])
        : new Response('<html>No server is available</html>', { status: 503 });
    });

    const result = await settle(() =>
      getOpenLibraryService().searchBooks(
        { query: 'history', limit: 2, offset: 0, include_availability: true },
        createMockContext(),
      ),
    );

    expect(result.works[1]?.availability).toEqual({ status: 'open' });
    expect(result.availabilityUnknown).toEqual(['OL1W']);
  });

  // Only the first answer's omission means "none returned"; the re-ask was about a work known to have a scan.
  it('reports a work the re-ask leaves out of its answer as unknown, not as none', async () => {
    vi.useFakeTimers();
    let calls = 0;
    const fetchSpy = serveSearch(
      [pageDoc('OL1W', { ia: ['a'] }), pageDoc('OL2W', { ia: ['b'] })],
      () => {
        calls += 1;
        return calls === 1
          ? lookupResponse([
              ['OL1W', null],
              ['OL2W', { status: 'open' }],
            ])
          : lookupResponse([]);
      },
    );

    const result = await settle(() =>
      getOpenLibraryService().searchBooks(
        { query: 'history', limit: 2, offset: 0, include_availability: true },
        createMockContext(),
      ),
    );

    expect(sentRequests(fetchSpy).lookups).toHaveLength(2);
    expect(result.works.map((w) => w.availability)).toEqual([null, { status: 'open' }]);
    expect(result.availabilityUnknown).toEqual(['OL1W']);
  });

  it('names the unknown works in page order when both answers list them in reverse', async () => {
    vi.useFakeTimers();
    const fetchSpy = serveSearch(
      ['OL1W', 'OL2W', 'OL3W'].map((id) => pageDoc(id, { ia: [`${id}item`] })),
      (url) =>
        lookupResponse(
          lookupKeys(url)
            .reverse()
            .map((id) => [id, null]),
        ),
    );

    const result = await settle(() =>
      getOpenLibraryService().searchBooks(
        { query: 'history', limit: 3, offset: 0, include_availability: true },
        createMockContext(),
      ),
    );

    expect(sentRequests(fetchSpy).lookups).toHaveLength(2);
    expect(result.availabilityUnknown).toEqual(['OL1W', 'OL2W', 'OL3W']);
  });

  it('re-asks only after every first lookup settles and a pause passes, one at a time', async () => {
    vi.useFakeTimers();
    const startedAt = Date.now();
    const ids = Array.from({ length: 300 }, (_, i) => `OL${i + 1}W`);
    const sent: Array<{ first: string; at: number }> = [];
    const reasks = { inFlight: 0, peak: 0 };
    serveSearch(
      ids.map((id) => pageDoc(id, { ia: [`${id}item`] })),
      async (url, init) => {
        const keys = lookupKeys(url);
        const first = keys[0] ?? '';
        const reask = sent.some((entry) => entry.first === first);
        sent.push({ first, at: Date.now() - startedAt });
        // Every first lookup lands in one Internet Archive failure; the re-asks answer.
        if (!reask) return lookupResponse(keys.map((id) => [id, null]));
        reasks.inFlight++;
        reasks.peak = Math.max(reasks.peak, reasks.inFlight);
        try {
          return await answerAfter(100, init, () =>
            lookupResponse(keys.map((id) => [id, { status: 'open' }])),
          );
        } finally {
          reasks.inFlight--;
        }
      },
    );

    const call = track(() =>
      getOpenLibraryService().searchBooks(
        { query: 'history', limit: 300, offset: 0, include_availability: true },
        createMockContext(),
      ),
    );
    await vi.advanceTimersByTimeAsync(1999);
    expect(sent.map((entry) => entry.first)).toEqual(['OL1W', 'OL101W', 'OL201W']);
    await vi.advanceTimersByTimeAsync(RETRY_DEADLINE_MS);
    await call.done;

    expect(sent.map((entry) => entry.first)).toEqual([
      'OL1W',
      'OL101W',
      'OL201W',
      'OL1W',
      'OL101W',
      'OL201W',
    ]);
    expect(sent.slice(3).every((entry) => entry.at >= 2000)).toBe(true);
    expect(reasks.peak).toBe(1);
    expect(call.state.value?.availabilityUnknown).toBeUndefined();
    expect(call.state.value?.works.every((w) => w.availability?.status === 'open')).toBe(true);
  });

  it('rejects with the cancellation when the caller aborts during the pause', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const fetchSpy = serveSearch([pageDoc('OL1W', { ia: ['a'] })], () =>
      lookupResponse([['OL1W', null]]),
    );

    const call = track(() =>
      getOpenLibraryService().searchBooks(
        { query: 'history', limit: 1, offset: 0, include_availability: true },
        createMockContext({ signal: controller.signal }),
      ),
    );
    await vi.advanceTimersByTimeAsync(1000);
    controller.abort();
    await vi.advanceTimersByTimeAsync(RETRY_DEADLINE_MS);
    await call.done;

    expect(call.state.error).toBe(controller.signal.reason);
    expect(call.state.elapsedMs).toBe(1000);
    expect(sentRequests(fetchSpy).lookups).toHaveLength(1);
  });

  it('rejects with the cancellation when the caller aborts during a re-ask request', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    let calls = 0;
    const fetchSpy = serveSearch([pageDoc('OL1W', { ia: ['a'] })], (_url, init) => {
      calls += 1;
      if (calls === 1) return lookupResponse([['OL1W', null]]);
      queueMicrotask(() => controller.abort());
      return hang(init);
    });

    const call = track(() =>
      getOpenLibraryService().searchBooks(
        { query: 'history', limit: 1, offset: 0, include_availability: true },
        createMockContext({ signal: controller.signal }),
      ),
    );
    await vi.advanceTimersByTimeAsync(RETRY_DEADLINE_MS);
    await call.done;

    expect(call.state.value).toBeUndefined();
    expect(call.state.error).toBeInstanceOf(McpError);
    expect(call.state.error).toMatchObject({ code: JsonRpcErrorCode.RequestCancelled });
    // Cancelled as the re-ask went out, right after the pause.
    expect(call.state.elapsedMs).toBe(2000);
    expect(sentRequests(fetchSpy).lookups).toHaveLength(2);
  });

  it('leaves works answered null unknown when no time is left for the pause', async () => {
    vi.useFakeTimers();
    const fetchSpy = serveSearch(
      [pageDoc('OL1W', { ia: ['a'] })],
      () => lookupResponse([['OL1W', null]]),
      (respond) => {
        // The page answers with less than the pause left of the budget it shares.
        vi.setSystemTime(Date.now() + RETRY_DEADLINE_MS - 1000);
        return respond();
      },
    );

    const call = track(() =>
      getOpenLibraryService().searchBooks(
        { query: 'history', limit: 1, offset: 0, include_availability: true },
        createMockContext(),
      ),
    );
    await vi.advanceTimersByTimeAsync(RETRY_DEADLINE_MS);
    await call.done;

    expect(sentRequests(fetchSpy).lookups).toHaveLength(1);
    expect(call.state.value?.availabilityUnknown).toEqual(['OL1W']);
    // It returns at once, rather than pausing past the deadline it shares with the page.
    expect(call.state.elapsedMs).toBe(RETRY_DEADLINE_MS - 1000);
  });

  it('stops starting lookups after one fails and reports every skipped work unknown', async () => {
    const ids = Array.from({ length: 500 }, (_, i) => `OL${i + 1}W`);
    const fetchSpy = serveSearch(
      ids.map((id) => pageDoc(id, { ia: [`${id}item`] })),
      () => new Response('<html>No server is available</html>', { status: 503 }),
    );

    const result = await getOpenLibraryService().searchBooks(
      { query: 'history', limit: 500, offset: 0, include_availability: true },
      createMockContext(),
    );

    // Five chunks; only those already in flight when the first failed were sent.
    expect(sentRequests(fetchSpy).lookups.length).toBeLessThanOrEqual(3);
    expect(result.availabilityUnknown).toEqual(ids);
    expect(result.works.every((w) => w.availability === null)).toBe(true);
  });

  it('rejects with the cancellation when the caller aborts during the lookup', async () => {
    const controller = new AbortController();
    serveSearch([pageDoc('OL1W', { ia: ['item1'] })], (_url, init) => {
      queueMicrotask(() => controller.abort());
      return hang(init);
    });

    const error = await getOpenLibraryService()
      .searchBooks(
        { query: 'whales', limit: 1, offset: 0, include_availability: true },
        createMockContext({ signal: controller.signal }),
      )
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(McpError);
    expect(error).toMatchObject({ code: JsonRpcErrorCode.RequestCancelled });
  });

  it.each([
    ['an HTTP 500', () => new Response('{}', { status: 500 })],
    ['a truncated JSON body', () => new Response('{"docs": [')],
  ])('retries %s from the lookup inside the deadline, then degrades', async (_label, fail) => {
    vi.useFakeTimers();
    const fetchSpy = serveSearch([pageDoc('OL1W', { ia: ['item1'] })], fail);

    const call = track(() =>
      getOpenLibraryService().searchBooks(
        { query: 'whales', limit: 1, offset: 0, include_availability: true },
        createMockContext(),
      ),
    );
    await vi.advanceTimersByTimeAsync(RETRY_DEADLINE_MS);
    await call.done;

    expect(call.state.error).toBeUndefined();
    expect(call.state.value?.availabilityUnknown).toEqual(['OL1W']);
    expect(sentRequests(fetchSpy).lookups.length).toBeGreaterThan(1);
    expect(call.state.elapsedMs).toBeLessThanOrEqual(RETRY_DEADLINE_MS);
  });

  it('ends a call whose lookup hangs inside the one deadline it shares with the page', async () => {
    vi.useFakeTimers();
    serveSearch(
      [pageDoc('OL1W', { ia: ['item1'] })],
      (_url, init) => hang(init),
      (respond, init) => answerAfter(20_000, init, respond),
    );

    const call = track(() =>
      getOpenLibraryService().searchBooks(
        { query: 'whales', limit: 1, offset: 0, include_availability: true },
        createMockContext(),
      ),
    );
    await vi.advanceTimersByTimeAsync(2 * RETRY_DEADLINE_MS);
    await call.done;

    expect(call.state.error).toBeUndefined();
    expect(call.state.value?.works[0]?.availability).toBeNull();
    expect(call.state.value?.availabilityUnknown).toEqual(['OL1W']);
    // The lookup got only the 30 s the page request left, not a fresh 50 s.
    expect(call.state.elapsedMs).toBe(RETRY_DEADLINE_MS);
  });

  it('sends no lookup when the page request spent the whole deadline', async () => {
    vi.useFakeTimers();
    const fetchSpy = serveSearch([pageDoc('OL1W', { ia: ['item1'] })], undefined, (respond) => {
      // The page answers at the very end of the budget it shares with the lookup.
      vi.setSystemTime(Date.now() + RETRY_DEADLINE_MS);
      return respond();
    });

    const result = await getOpenLibraryService().searchBooks(
      { query: 'whales', limit: 1, offset: 0, include_availability: true },
      createMockContext(),
    );

    expect(sentRequests(fetchSpy).lookups).toEqual([]);
    expect(result.availabilityUnknown).toEqual(['OL1W']);
    expect(result.works[0]?.availability).toBeNull();
  });

  it('discloses unknown availability in the notice on both client surfaces', async () => {
    serveSearch(
      [pageDoc('OL1W', { ia: ['item1'] }), pageDoc('OL2W')],
      () => new Response('<html>No server is available</html>', { status: 503 }),
    );

    const result = await runToolContract(openlibrarySearchBooks, {
      query: 'whales',
      limit: 2,
      include_availability: true,
    });

    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as {
      notice?: string;
      works: Array<{ availability: unknown }>;
    };
    expect(structured.works.map((w) => w.availability)).toEqual([null, null]);
    expect(structured.notice).toContain('OL1W');
    expect(structured.notice).not.toContain('OL2W');
    const text = result.content.map((block) => ('text' in block ? block.text : '')).join('\n');
    expect(text).toContain(structured.notice);
  });

  it('names several works answered null, in page order, in one notice on both client surfaces', async () => {
    vi.useFakeTimers();
    serveSearch(
      [
        pageDoc('OL1W', { ia: ['a'] }),
        pageDoc('OL2W', { ia: ['b'] }),
        pageDoc('OL3W'),
        pageDoc('OL4W', { ia: ['d'] }),
      ],
      (url) =>
        lookupResponse(
          lookupKeys(url)
            .reverse()
            .map((id) => [id, null]),
        ),
    );

    const result = await settle(() =>
      runToolContract(openlibrarySearchBooks, {
        query: 'whales',
        limit: 4,
        include_availability: true,
      }),
    );

    expect(result.isError).toBeFalsy();
    const notice =
      'Availability is unknown for 3 works OL1W, OL2W, OL4W: the availability lookup did not complete, so missing availability there does not mean none exists. Retry the search to fetch it.';
    expect((result.structuredContent as { notice?: string }).notice).toBe(notice);
    const text = result.content.map((block) => ('text' in block ? block.text : '')).join('\n');
    expect(text).toContain(notice);
  });
});

/**
 * The statuses the lookup's failure map reaches through the framework's status
 * mapping that the block above leaves unstubbed: Forbidden, a Retry-After past
 * the ladder's 30 s delay cap, and gateway codes with a JSON body.
 */
describe('OpenLibraryService — searchBooks availability lookup, remaining statuses', () => {
  beforeEach(() => {
    initOpenLibraryService();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it.each([
    [
      'an HTTP 403 bot-check page',
      () => new Response('<html><body>Access denied</body></html>', { status: 403 }),
    ],
    ['an HTTP 403 JSON body', () => new Response('{}', { status: 403 })],
    [
      'an HTTP 429 whose Retry-After outlasts the delay cap',
      () => new Response('{}', { status: 429, headers: { 'Retry-After': '120' } }),
    ],
    ['an HTTP 502 JSON body', () => new Response('{}', { status: 502 })],
    ['an HTTP 504 JSON body', () => new Response('{}', { status: 504 })],
  ])(
    'degrades %s from the lookup to availability unknown, in one request',
    async (_label, fail) => {
      const fetchSpy = serveSearch(
        [pageDoc('OL1W', { ia: ['item1'] }), pageDoc('OL2W'), pageDoc('OL3W', { ia: ['item3'] })],
        fail,
      );

      const result = await getOpenLibraryService().searchBooks(
        { query: 'whales', limit: 3, offset: 0, include_availability: true },
        createMockContext(),
      );

      expect(result.total).toBe(3);
      expect(result.works.map((w) => w.availability)).toEqual([null, null, null]);
      expect(result.availabilityUnknown).toEqual(['OL1W', 'OL3W']);
      expect(sentRequests(fetchSpy).lookups).toHaveLength(1);
    },
  );

  it('retries an HTTP 429 with a short Retry-After inside the deadline, then degrades', async () => {
    vi.useFakeTimers();
    const fetchSpy = serveSearch(
      [pageDoc('OL1W', { ia: ['item1'] })],
      () => new Response('{}', { status: 429, headers: { 'Retry-After': '2' } }),
    );

    const call = track(() =>
      getOpenLibraryService().searchBooks(
        { query: 'whales', limit: 1, offset: 0, include_availability: true },
        createMockContext(),
      ),
    );
    await vi.advanceTimersByTimeAsync(RETRY_DEADLINE_MS);
    await call.done;

    expect(call.state.error).toBeUndefined();
    expect(call.state.value?.availabilityUnknown).toEqual(['OL1W']);
    // One attempt plus the ladder's three retries, each after the 2 s Retry-After.
    expect(sentRequests(fetchSpy).lookups).toHaveLength(4);
    expect(call.state.elapsedMs).toBeLessThan(RETRY_DEADLINE_MS);
  });

  it('settles a call whose page answers at once but whose lookup hangs at the shared deadline', async () => {
    vi.useFakeTimers();
    const fetchSpy = serveSearch([pageDoc('OL1W', { ia: ['item1'] })], (_url, init) => hang(init));

    const call = track(() =>
      getOpenLibraryService().searchBooks(
        { query: 'whales', limit: 1, offset: 0, include_availability: true },
        createMockContext(),
      ),
    );
    await vi.advanceTimersByTimeAsync(2 * RETRY_DEADLINE_MS);
    await call.done;

    expect(call.state.error).toBeUndefined();
    expect(call.state.value?.availabilityUnknown).toEqual(['OL1W']);
    // A 30 s search-class attempt, then a second one cut off by the deadline.
    expect(sentRequests(fetchSpy).lookups).toHaveLength(2);
    expect(call.state.elapsedMs).toBe(RETRY_DEADLINE_MS);
  });

  it('maps a work the lookup answer leaves out to null without naming it unknown', async () => {
    serveSearch([pageDoc('OL1W', { ia: ['item1'] }), pageDoc('OL2W', { ia: ['item2'] })], () =>
      lookupResponse([['OL2W', { status: 'open' }]]),
    );

    const result = await getOpenLibraryService().searchBooks(
      { query: 'whales', limit: 2, offset: 0, include_availability: true },
      createMockContext(),
    );

    expect(result.works.map((w) => w.availability)).toEqual([null, { status: 'open' }]);
    expect(result.availabilityUnknown).toBeUndefined();
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

  /** Answers every subject request with `body`, recording the requested subject keys. */
  function subjectRoute(body: Record<string, unknown>) {
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(() => Promise.resolve(new Response(JSON.stringify(body))));
    return () =>
      spy.mock.calls.map(([input]) => {
        const path = new URL(requestUrl(input)).pathname;
        return decodeURIComponent(path.slice('/subjects/'.length, -'.json'.length));
      });
  }

  // A space after the colon of a browse prefix would otherwise become part of the
  // value — "place:_london" — and match nothing.
  it.each([
    ['place: london', 'place:london'],
    ['place:london', 'place:london'],
    ['  Place:   London (England) ', 'place:london_(england)'],
    ['person:\tElizabeth Bennet', 'person:elizabeth_bennet'],
    ['TIME:\n 19th century', 'time:19th_century'],
  ])('drops whitespace after a recognized prefix in %j', async (subject, key) => {
    const requestedKeys = subjectRoute({ name: 'x', work_count: 0, works: [] });

    const result = await getOpenLibraryService().getSubject(subject, 12, 0, createMockContext());

    expect(requestedKeys()).toEqual([key]);
    expect(result.subject_key).toBe(key);
  });

  it.each([
    ['org: united nations', 'org:_united_nations'],
    ['science: fiction', 'science:_fiction'],
    ['place :london', 'place_:london'],
    ['london place: england', 'london_place:_england'],
  ])('keeps whitespace after an unrecognized or mid-text colon in %j', async (subject, key) => {
    const requestedKeys = subjectRoute({ name: 'x', work_count: 0, works: [] });

    await getOpenLibraryService().getSubject(subject, 12, 0, createMockContext());

    expect(requestedKeys()).toEqual([key]);
  });

  it.each(['subject', 'place', 'person', 'time'])(
    'maps the upstream subject_type %s',
    async (subjectType) => {
      subjectRoute({ name: 'x', subject_type: subjectType, work_count: 3, works: [] });

      const result = await getOpenLibraryService().getSubject('x', 12, 0, createMockContext());

      expect(result.subject_type).toBe(subjectType);
    },
  );

  it.each([
    ['absent', undefined],
    ['null', null],
    ['numeric', 7],
  ])('omits a %s upstream subject_type rather than inventing one', async (_label, raw) => {
    subjectRoute({ name: 'x', ...(raw === undefined ? {} : { subject_type: raw }), work_count: 0 });

    const result = await getOpenLibraryService().getSubject('x', 12, 0, createMockContext());

    expect(result).not.toHaveProperty('subject_type');
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
 * Edition-level credits: `subtitle`, `by_statement`, `contributors`, the legacy
 * `contributions` strings, and `translated_from`. `editions.json` entries and
 * `/api/books.json` details carry identical values for them, so both routes
 * share one mapping. Fixtures are real records, trimmed.
 */
describe('OpenLibraryService — edition credit fields', () => {
  /** ISBN 9780143035008 → OL7361482M, the Pevear & Volokhonsky translation. */
  const PEVEAR = {
    key: '/books/OL7361482M',
    title: 'Anna Karenina',
    authors: [{ key: '/authors/OL26783A', name: 'Leo Tolstoy' }],
    publishers: ['Penguin'],
    languages: [{ key: '/languages/eng' }],
    translated_from: [{ key: '/languages/rus' }],
    contributors: [
      { role: 'Translator', name: 'Richard Pevear' },
      { role: 'Translator', name: 'Larissa Volokhonsky' },
    ],
    contributions: ['Richard Pevear (Translator)', 'Larissa Volokhonsky (Translator)'],
    isbn_10: ['0143035002'],
    isbn_13: ['9780143035008'],
    number_of_pages: 838,
    edition_name: 'Penguin Classics Deluxe Edition',
    publish_date: 'May 31, 2004',
    covers: [111128],
    works: [{ key: '/works/OL267096W' }],
  };

  /** OL249260M — its joint translator, Charles Morice, appears only in `contributions`. */
  const KARAMAZOV = {
    key: '/books/OL249260M',
    title: 'Les frères Karamazov',
    subtitle: null,
    by_statement:
      'traduit et adapté par E. Halpérine-Kaminsky et Ch. Morice, avec un portrait de Th. Dostoïevsky ...',
    contributors: [{ role: 'Translator', name: 'E. Halpérine-Kaminsky' }],
    contributions: [
      'Halpérine-Kaminsky, E. 1858-1936, tr.',
      'Morice, Charles, 1861-1919, joint tr.',
    ],
    translated_from: [{ key: '/languages/rus' }],
    works: [{ key: '/works/OL10432709W' }],
  };

  /** OL45545108M — carries all five fields. */
  const NAKAMURA = {
    key: '/books/OL45545108M',
    title: 'Anna karēnina',
    subtitle: 'Anna Karenina',
    by_statement: 'by Lev Tolstoi ; translated by Nakamura Hakuyō',
    contributors: [{ role: 'Translator', name: 'Nakamura Hakuyō' }],
    contributions: ['Nakamura, Hakuyō, 1890-1974, translator'],
    translated_from: [{ key: '/languages/rus' }],
    languages: [{ key: '/languages/jpn' }],
    publishers: ['Shinchōsha'],
    publish_date: '1955',
    works: [{ key: '/works/OL267096W' }],
  };

  const CREDIT_FIELDS: readonly string[] = [
    'subtitle',
    'by_statement',
    'contributors',
    'contributions',
    'translated_from',
  ];

  type RawRecord = Record<string, unknown> & { key: string };

  /** Maps the same records through both edition routes: bibkeys details by OLID, and one editions page. */
  async function mapBoth(records: RawRecord[]) {
    const olids = records.map((r) => r.key.slice('/books/'.length));
    const fetchSpy = mockFetchRoutes({
      '/api/books.json': Object.fromEntries(
        records.map((r, i) => [`OLID:${olids[i]}`, { details: r }]),
      ),
      '/works/OL1W/editions.json': { size: records.length, entries: records },
    });
    const detail = await getOpenLibraryService().getEditionsByIdentifiers(
      olids,
      'olid',
      createMockContext(),
    );
    const list = await getOpenLibraryService().getEditions('OL1W', 100, 0, createMockContext());
    return { detail: detail.editions, list: list!.editions, fetchSpy };
  }

  /** The credit fields an edition carries, and nothing else. */
  function credits(edition: object): Record<string, unknown> {
    return Object.fromEntries(Object.entries(edition).filter(([k]) => CREDIT_FIELDS.includes(k)));
  }

  beforeEach(() => initOpenLibraryService());
  afterEach(() => vi.restoreAllMocks());

  it('keeps the existing edition fields, their order, and one request per route', async () => {
    const { detail, list, fetchSpy } = await mapBoth([PEVEAR]);
    const detailFields = [
      'edition_id',
      'title',
      'authors',
      'publish_date',
      'edition_name',
      'publishers',
      'language',
      'languages',
      'isbn_10',
      'isbn_13',
      'oclc',
      'lccn',
      'lc_classifications',
      'page_count',
      'cover_ids',
      'work_id',
    ];
    const listFields = [
      'edition_id',
      'title',
      'publish_date',
      'edition_name',
      'publishers',
      'languages',
      'isbn_10',
      'isbn_13',
      'page_count',
      'cover_ids',
      'work_id',
    ];
    expect(Object.keys(detail[0]!).filter((k) => detailFields.includes(k))).toEqual(detailFields);
    expect(Object.keys(list[0]!).filter((k) => listFields.includes(k))).toEqual(listFields);
    expect(detail[0]).toMatchObject({
      edition_id: 'OL7361482M',
      authors: [{ name: 'Leo Tolstoy', author_id: 'OL26783A', source: 'edition' }],
      languages: ['eng'],
      page_count: 838,
      work_id: 'OL267096W',
    });
    // One bibkeys request (authors are inline) and one editions page.
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('returns both translators, the legacy credits, and the source language for ISBN 9780143035008', async () => {
    const fetchSpy = mockFetchRoutes({
      '/api/books.json': { 'ISBN:9780143035008': { details: PEVEAR } },
    });
    const { editions } = await getOpenLibraryService().getEditionsByIdentifiers(
      ['9780143035008'],
      'isbn',
      createMockContext(),
    );
    expect(credits(editions[0]!)).toEqual({
      contributors: [
        { name: 'Richard Pevear', role: 'Translator' },
        { name: 'Larissa Volokhonsky', role: 'Translator' },
      ],
      contributions: ['Richard Pevear (Translator)', 'Larissa Volokhonsky (Translator)'],
      translated_from: ['rus'],
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('returns both credit arrays of OL249260M in full and unmerged', async () => {
    const { detail } = await mapBoth([KARAMAZOV]);
    expect(credits(detail[0]!)).toEqual({
      by_statement: KARAMAZOV.by_statement,
      contributors: [{ name: 'E. Halpérine-Kaminsky', role: 'Translator' }],
      contributions: [
        'Halpérine-Kaminsky, E. 1858-1936, tr.',
        'Morice, Charles, 1861-1919, joint tr.',
      ],
      translated_from: ['rus'],
    });
  });

  it('maps the same records identically on the list and detail routes', async () => {
    const { detail, list } = await mapBoth([PEVEAR, KARAMAZOV, NAKAMURA]);
    expect(list.map(credits)).toEqual(detail.map(credits));
    expect(credits(list[2]!)).toEqual({
      subtitle: 'Anna Karenina',
      by_statement: 'by Lev Tolstoi ; translated by Nakamura Hakuyō',
      contributors: [{ name: 'Nakamura Hakuyō', role: 'Translator' }],
      contributions: ['Nakamura, Hakuyō, 1890-1974, translator'],
      translated_from: ['rus'],
    });
  });

  it.each(
    CREDIT_FIELDS.flatMap((field) =>
      [
        ['missing', undefined],
        ['null', null],
        ['""', ''],
        ['[]', []],
      ].map(([label, value]) => [field, label, value]),
    ),
  )('omits %s when it is %s, keeping the other credit fields', async (field, _label, value) => {
    const record: RawRecord = {
      key: NAKAMURA.key,
      ...Object.fromEntries(Object.entries(NAKAMURA).filter(([k]) => k !== field)),
      ...(value === undefined ? {} : { [field as string]: value }),
    };
    const { detail, list } = await mapBoth([record]);
    for (const edition of [detail[0]!, list[0]!]) {
      expect(edition).not.toHaveProperty(field as string);
      for (const other of CREDIT_FIELDS.filter((f) => f !== field))
        expect(edition).toHaveProperty(other);
    }
  });

  it('skips contributors without a nonempty name, translated_from entries without a string key, and non-string credits', async () => {
    const { detail, list } = await mapBoth([
      {
        key: '/books/OL1M',
        contributors: [
          { role: 'Translator', name: '' },
          { role: 'Editor' },
          { name: null, role: 'Editor' },
          null,
          'Bare string',
          { name: 'Role-less' },
          { name: 'Empty role', role: '' },
          { name: 'Null role', role: null },
          { name: 'With role', role: 'Illustrator' },
        ],
        translated_from: [
          { key: '/languages/rus' },
          {},
          { key: 3 },
          null,
          '/languages/fre',
          { key: '/languages/spa' },
        ],
        contributions: ['First credit', 3, null, '', 'Second credit'],
      },
      {
        key: '/books/OL2M',
        contributors: [{ name: '' }, { role: 'Editor' }],
        translated_from: [{}, '/languages/rus'],
        contributions: [null, ''],
      },
    ]);
    for (const editions of [detail, list]) {
      const [kept, emptied] = [editions[0]!, editions[1]!];
      expect(credits(kept)).toEqual({
        contributors: [
          { name: 'Role-less' },
          { name: 'Empty role' },
          { name: 'Null role' },
          { name: 'With role', role: 'Illustrator' },
        ],
        contributions: ['First credit', 'Second credit'],
        translated_from: ['rus', 'spa'],
      });
      // A role that is absent or empty is left off the entry, never sent as "" or null.
      for (const entry of (credits(kept).contributors as object[]).slice(0, 3))
        expect(Object.keys(entry)).toEqual(['name']);
      // Skipping every entry leaves the field absent.
      expect(credits(emptied)).toEqual({});
    }
  });

  it('passes strings through verbatim and never parses legacy credits into contributors', async () => {
    const { detail, list } = await mapBoth([
      {
        key: '/books/OL1M',
        subtitle: ' a *novel* ',
        by_statement: '  Translated by A.C. Townsend\n',
        contributions: [
          'Garnett, Constance, 1861-1946, translator',
          'Constance Garnett (Translator)',
        ],
      },
    ]);
    for (const edition of [detail[0]!, list[0]!]) {
      expect(credits(edition)).toEqual({
        subtitle: ' a *novel* ',
        by_statement: '  Translated by A.C. Townsend\n',
        contributions: [
          'Garnett, Constance, 1861-1946, translator',
          'Constance Garnett (Translator)',
        ],
      });
    }
  });
});

/**
 * Each resolved row carries the caller's identifier exactly as supplied — the
 * bibkey sent upstream is canonicalized for an ISBN, but the echo never is — so
 * a caller can join rows back to its input even when the record does not carry
 * that identifier.
 */
describe('OpenLibraryService — edition batch identifier echo', () => {
  /** OL20525469M answers ISBN 9780441478125, though its own isbn_13 is empty. */
  const LEFT_HAND = {
    key: '/books/OL20525469M',
    title: 'The Left Hand of Darkness',
    isbn_10: ['0441478123'],
    authors: [{ key: '/authors/OL31353A', name: 'Ursula K. Le Guin' }],
  };

  beforeEach(() => initOpenLibraryService());
  afterEach(() => vi.restoreAllMocks());

  it('keeps one row per input that names the same edition, each with its own identifier', async () => {
    mockFetchRoutes({
      '/api/books.json': {
        'ISBN:9780441478125': { details: LEFT_HAND },
        'ISBN:0441478123': { details: LEFT_HAND },
      },
    });
    const { editions, unresolved } = await getOpenLibraryService().getEditionsByIdentifiers(
      ['9780441478125', '0441478123'],
      'isbn',
      createMockContext(),
    );
    expect(editions.map((e) => [e.identifier, e.edition_id])).toEqual([
      ['9780441478125', 'OL20525469M'],
      ['0441478123', 'OL20525469M'],
    ]);
    expect(editions[0]?.isbn_13).toEqual([]);
    expect(unresolved).toEqual([]);
  });

  it.each([
    ['a hyphenated ISBN', 'isbn' as const, '978-0-14-303500-8', 'ISBN:9780143035008'],
    [
      'an ISBN-10 with a lowercase check digit',
      'isbn' as const,
      '0-8044-2957-x',
      'ISBN:080442957X',
    ],
    ['a lowercase OLID', 'olid' as const, 'ol7353617m', 'OLID:ol7353617m'],
  ])('echoes %s exactly as supplied', async (_label, idType, identifier, bibkey) => {
    const fetchSpy = mockFetchRoutes({
      '/api/books.json': { [bibkey]: { details: { key: '/books/OL1M', title: 'Echoed' } } },
    });
    const { editions } = await getOpenLibraryService().getEditionsByIdentifiers(
      [identifier],
      idType,
      createMockContext(),
    );
    expect(requestUrl(fetchSpy.mock.calls[0]?.[0])).toContain(encodeURIComponent(bibkey));
    expect(editions.map((e) => e.identifier)).toEqual([identifier]);
  });

  it('echoes only resolved inputs, leaving the misses in unresolved', async () => {
    mockFetchRoutes({
      '/api/books.json': { 'OLID:OL2M': { details: { key: '/books/OL2M', title: 'Second' } } },
    });
    const { editions, unresolved } = await getOpenLibraryService().getEditionsByIdentifiers(
      ['OL1M', 'OL2M', 'OL3M'],
      'olid',
      createMockContext(),
    );
    expect(editions.map((e) => e.identifier)).toEqual(['OL2M']);
    expect(unresolved).toEqual(['OL1M', 'OL3M']);
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
    const ctx = createMockContext({
      uri: new URL('openlibrary://authors/OL2162284A'),
      errors: openlibraryAuthorResource.errors,
    });
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

  it('openlibrary_get_work preserves the merge notice alongside every subject', async () => {
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
    expect(notice).not.toContain('capped');
    const text = contentText(result);
    expect(text).toContain('subject-10');
    expect(text).toContain('subject-11');
    expect(result.structuredContent).toMatchObject({
      subjects: expect.arrayContaining(['subject-10', 'subject-11']),
    });
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
    const ctx = createMockContext({
      uri: new URL('openlibrary://works/OL2714496W'),
      errors: openlibraryWorkResource.errors,
    });
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
    const ctx = createMockContext({
      uri: new URL('openlibrary://works/OL7353617M'),
      errors: openlibraryWorkResource.errors,
    });
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
    const ctx = createMockContext({
      uri: new URL('openlibrary://authors/OL7353617M'),
      errors: openlibraryAuthorResource.errors,
    });
    const error = await Promise.resolve(openlibraryAuthorResource.handler(params, ctx)).catch(
      (e) => e,
    );

    expect(error).toBeInstanceOf(McpError);
    expect((error as McpError).code).toBe(JsonRpcErrorCode.NotFound);
  });

  // No input pattern narrows `author_id`: every form that names an author keeps
  // resolving. Open Library answers only the upper-case OLID, so a lowercase one
  // is requested upper-cased.
  it.each([
    ['a bare OLID', 'OL23919A', '/authors/OL23919A.json'],
    ['an /authors/-prefixed OLID', '/authors/OL23919A', '/authors/OL23919A.json'],
    ['a lowercase OLID', 'ol23919a', '/authors/OL23919A.json'],
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
 * Open Library's by-ID routes answer only the upper-case OLID — `/authors/ol31353a.json`,
 * `/authors/ol31353a/works.json`, and `/works/ol45804w.json` all 404 — so an author or
 * work ID shaped like that kind's OLID is upper-cased where it is normalized, and the
 * merge-notice comparison sees the same canonical value. Every routed path below is
 * the upper-case one, so a lowercase request falls through to the 404.
 */
describe('OpenLibraryService — OLID case canonicalization', () => {
  const LE_GUIN = {
    key: '/authors/OL31353A',
    type: { key: '/type/author' },
    name: 'Ursula K. Le Guin',
    location: null,
  };
  const LE_GUIN_WORKS = {
    size: 271,
    entries: [{ key: '/works/OL59800W', title: 'A Wizard of Earthsea' }],
  };
  const FOX = { key: '/works/OL45804W', type: { key: '/type/work' }, title: 'Fantastic Mr Fox' };

  const AUTHOR_FORMS = [
    'ol31353a',
    'Ol31353A',
    'OL31353a',
    'oL31353A',
    '/authors/ol31353a',
    'OL31353A',
    '/authors/OL31353A',
  ];

  function contentText(result: { content: unknown[] }): string {
    return result.content
      .map((block) => (block && typeof block === 'object' && 'text' in block ? block.text : ''))
      .join('\n');
  }

  function requestedUrls(fetchSpy: ReturnType<typeof vi.spyOn>): string[] {
    return fetchSpy.mock.calls.map(([input]: unknown[]) => requestUrl(input));
  }

  beforeEach(() => {
    initOpenLibraryService();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each(AUTHOR_FORMS)(
    'openlibrary_get_author resolves %s in one request with no merge notice',
    async (authorId) => {
      const fetchSpy = mockFetchRoutes({ '/authors/OL31353A.json': LE_GUIN });

      const result = await runToolContract(openlibraryGetAuthor, { author_id: authorId });

      expect(result.isError).toBeFalsy();
      expect(openlibraryGetAuthor.output.parse(result.structuredContent).author_id).toBe(
        'OL31353A',
      );
      expect(result.structuredContent).not.toHaveProperty('notice');
      expect(contentText(result)).not.toContain('merged record');
      expect(requestedUrls(fetchSpy)).toEqual(['https://openlibrary.org/authors/OL31353A.json']);
    },
  );

  it.each(AUTHOR_FORMS)(
    'openlibrary_get_author_works resolves %s in one request with no merge notice',
    async (authorId) => {
      const fetchSpy = mockFetchRoutes({ '/authors/OL31353A/works.json': LE_GUIN_WORKS });

      const result = await runToolContract(openlibraryGetAuthorWorks, { author_id: authorId });

      expect(result.isError).toBeFalsy();
      const structured = openlibraryGetAuthorWorks.output.parse(result.structuredContent);
      expect(structured.author_id).toBe('OL31353A');
      expect(structured.total).toBe(271);
      expect(result.structuredContent).not.toHaveProperty('notice');
      expect(contentText(result)).not.toContain('merged record');
      expect(requestedUrls(fetchSpy)).toEqual([
        'https://openlibrary.org/authors/OL31353A/works.json?limit=20&offset=0',
      ]);
    },
  );

  it.each(AUTHOR_FORMS)('the author resource resolves %s in one request', async (authorId) => {
    const fetchSpy = mockFetchRoutes({ '/authors/OL31353A.json': LE_GUIN });

    const params = openlibraryAuthorResource.params!.parse({ author_id: authorId });
    const ctx = createMockContext({
      uri: new URL(`openlibrary://authors/${encodeURIComponent(authorId)}`),
      errors: openlibraryAuthorResource.errors,
    });
    const author = await openlibraryAuthorResource.handler(params, ctx);

    expect(author).toMatchObject({ author_id: 'OL31353A', name: 'Ursula K. Le Guin' });
    expect(requestedUrls(fetchSpy)).toEqual(['https://openlibrary.org/authors/OL31353A.json']);
  });

  it.each(['ol45804w', 'Ol45804W', 'OL45804w', '/works/ol45804w', 'OL45804W', '/works/OL45804W'])(
    'the work resource resolves %s in one request',
    async (workId) => {
      const fetchSpy = mockFetchRoutes({ '/works/OL45804W.json': FOX });

      const params = openlibraryWorkResource.params!.parse({ work_id: workId });
      const ctx = createMockContext({
        uri: new URL(`openlibrary://works/${encodeURIComponent(workId)}`),
        errors: openlibraryWorkResource.errors,
      });
      const work = await openlibraryWorkResource.handler(params, ctx);

      expect(work).toMatchObject({ work_id: 'OL45804W', title: 'Fantastic Mr Fox' });
      expect(requestedUrls(fetchSpy)).toEqual(['https://openlibrary.org/works/OL45804W.json']);
    },
  );

  // Only an ID shaped like the record kind's own OLID changes: the permissive
  // author_id keeps every other spelling, including another kind's OLID.
  it.each(['31353', 'ol31353', 'olx31353a', 'ol31353ab', 'ol45804w', 'ol7353617m', 'abc'])(
    'getAuthor sends the non-author-OLID %s unchanged',
    async (authorId) => {
      const fetchSpy = mockFetchRoutes({});

      await expect(
        getOpenLibraryService().getAuthor(authorId, createMockContext()),
      ).resolves.toBeNull();
      expect(requestedUrls(fetchSpy)).toEqual([`https://openlibrary.org/authors/${authorId}.json`]);
    },
  );

  it.each(['45804', 'ol45804', 'olx45804w', 'ol45804wx', 'ol31353a', 'ol7353617m', 'abc'])(
    'getWork sends the non-work-OLID %s unchanged',
    async (workId) => {
      const fetchSpy = mockFetchRoutes({});

      await expect(
        getOpenLibraryService().getWork(workId, createMockContext()),
      ).resolves.toBeNull();
      expect(requestedUrls(fetchSpy)).toEqual([`https://openlibrary.org/works/${workId}.json`]);
    },
  );

  it('getAuthorWorks sends a non-author-OLID unchanged on both requests', async () => {
    const fetchSpy = mockFetchRoutes({});

    await expect(
      getOpenLibraryService().getAuthorWorks('ol45804w', 10, 0, createMockContext()),
    ).resolves.toBeNull();
    expect(requestedUrls(fetchSpy)).toEqual([
      'https://openlibrary.org/authors/ol45804w/works.json?limit=10&offset=0',
      'https://openlibrary.org/authors/ol45804w.json',
    ]);
  });

  // The bibkeys route matches LCCNs case-sensitively the other way — LCCN:sn84003854
  // resolves and LCCN:SN84003854 matches nothing — and resolves an OLID in any case,
  // so edition lookups keep the caller's spelling in the request and the echo.
  it.each([
    ['lccn' as const, 'sn84003854', 'LCCN:sn84003854'],
    ['olid' as const, 'ol7353617m', 'OLID:ol7353617m'],
    ['oclc' as const, 'ocm1037812', 'OCLC:ocm1037812'],
  ])('edition lookup by %s keeps %s as supplied', async (idType, identifier, bibkey) => {
    const fetchSpy = mockFetchRoutes({ '/api/books': {} });

    const { editions, unresolved } = await getOpenLibraryService().getEditionsByIdentifiers(
      [identifier],
      idType,
      createMockContext(),
    );

    expect(requestUrl(fetchSpy.mock.calls[0]?.[0])).toContain(
      `bibkeys=${encodeURIComponent(bibkey)}&`,
    );
    expect(editions).toEqual([]);
    expect(unresolved).toEqual([identifier]);
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
