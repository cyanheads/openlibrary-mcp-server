/**
 * @fileoverview Edge case and security tests for the openlibrary_search_books tool.
 * @module tests/tools/openlibrary-search-books-edge.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openlibrarySearchBooks } from '@/mcp-server/tools/definitions/openlibrary-search-books.tool.js';
import { initOpenLibraryService } from '@/services/open-library/open-library-service.js';

/** Minimal valid work result. */
function makeWork() {
  return {
    work_id: 'OL45804W',
    title: 'Test Work',
    author_names: [],
    author_ids: [],
    edition_count: 1,
    ebook_access: 'no_ebook' as const,
    has_fulltext: false,
    ia_identifiers: [],
  };
}

/** The text blocks of a tool result as a client renders them, joined by newlines. */
function contentText(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content
    .flatMap((block) => (block.type === 'text' ? [block.text ?? ''] : []))
    .join('\n');
}

describe('openlibrarySearchBooks — edge cases and security', () => {
  it('renders an empty work title explicitly beside the authored heading placeholder', async () => {
    const svc = (
      await import('@/services/open-library/open-library-service.js')
    ).getOpenLibraryService();
    vi.spyOn(svc, 'searchBooks').mockResolvedValueOnce({
      total: 1,
      offset: 0,
      works: [{ ...makeWork(), title: '' }],
    });
    const result = await runToolContract(openlibrarySearchBooks, { query: 'book' });
    expect(result.structuredContent).toMatchObject({ works: [{ title: '' }] });
    const text = contentText(result);
    expect(text).toContain('## *(no title recorded)*');
    expect(text).toContain('**Title:** ""');
  });
  it('escapes caller text inside the authored empty-search notice', async () => {
    initOpenLibraryService();
    const svc = (
      await import('@/services/open-library/open-library-service.js')
    ).getOpenLibraryService();
    vi.spyOn(svc, 'searchBooks').mockResolvedValueOnce({ total: 0, offset: 0, works: [] });
    const result = await runToolContract(openlibrarySearchBooks, { query: '*Book*\n# literal' });
    const text = contentText(result);
    expect(text).toContain('\\*Book\\*\\\n> \\# literal');
  });
  it('renders every literal value including multiline work and selected-edition fields', async () => {
    initOpenLibraryService();
    const svc = (
      await import('@/services/open-library/open-library-service.js')
    ).getOpenLibraryService();
    const work = {
      ...makeWork(),
      title: '*Title*\n# literal',
      author_names: ['<b>Writer</b>'],
      author_ids: ['OL9A'],
      subjects: ['[subject](x)', ''],
      ia_identifiers: ['*archive*', ''],
      availability: { status: '*open*', openlibrary_edition: '' },
      matching_edition: {
        edition_id: 'OL2M',
        title: '*Edition*\n# literal',
        publishers: ['<b>Press</b>', ''],
        languages: [],
      },
    };
    vi.spyOn(svc, 'searchBooks').mockResolvedValueOnce({ total: 1, offset: 0, works: [work] });
    const result = await runToolContract(openlibrarySearchBooks, { query: 'book' });
    expect(result.structuredContent).toMatchObject({ works: [work] });
    const text = contentText(result);
    for (const value of [
      '**Title:** \\*Title\\*\\\n\\# literal',
      '\\<b>Writer\\</b>',
      '\\[subject\\](x)',
      '\\*archive\\*',
      'Status: \\*open\\* | Edition:',
      '**Selected edition title:** \\*Edition\\*\\\n\\# literal',
      '\\<b>Press\\</b>',
    ])
      expect(text).toContain(value);
  });

  it('records one clamp and resumes after rows actually returned', async () => {
    initOpenLibraryService();
    const ctx = createMockContext({ errors: openlibrarySearchBooks.errors });
    const log = vi.spyOn(ctx.log, 'notice');
    const svc = (
      await import('@/services/open-library/open-library-service.js')
    ).getOpenLibraryService();
    const spy = vi
      .spyOn(svc, 'searchBooks')
      .mockResolvedValueOnce({ total: 200, offset: 7, works: [makeWork()] });
    const result = await openlibrarySearchBooks.handler(
      openlibrarySearchBooks.input.parse({ query: 'book', limit: 1001, offset: 7 }),
      ctx,
    );
    expect(result.total).toBe(200);
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ limit: 1000, offset: 7 }), ctx);
    expect(getEnrichment(ctx).notice).toBe(
      'Requested limit 1001; applied limit 1000. Next offset: 8.',
    );
    expect(log).toHaveBeenCalledOnce();
  });
  it('serves a 1000-row page unclamped and names that ceiling in the limit description', async () => {
    const ctx = createMockContext({ errors: openlibrarySearchBooks.errors });
    const svc = (
      await import('@/services/open-library/open-library-service.js')
    ).getOpenLibraryService();
    const spy = vi
      .spyOn(svc, 'searchBooks')
      .mockResolvedValueOnce({ total: 3000, offset: 0, works: [makeWork()] });
    await openlibrarySearchBooks.handler(
      openlibrarySearchBooks.input.parse({ query: 'book', limit: 1000 }),
      ctx,
    );
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ limit: 1000 }), ctx);
    expect(getEnrichment(ctx)).not.toHaveProperty('notice');
    expect(openlibrarySearchBooks.input.shape.limit.description).toContain(
      'values above 1000 apply 1000',
    );
  });
  it('preserves false, precise ratings, independent author IDs and empty optional values', async () => {
    initOpenLibraryService();
    const svc = (
      await import('@/services/open-library/open-library-service.js')
    ).getOpenLibraryService();
    const work = {
      ...makeWork(),
      author_ids: ['OL9A'],
      ratings_average: 4.2897363,
      subjects: [],
      matching_edition_count: 0,
      matching_edition: { edition_id: 'OL2M', title: '', languages: [], publishers: [] },
    };
    vi.spyOn(svc, 'searchBooks').mockResolvedValueOnce({ total: 1, offset: 0, works: [work] });
    const result = await runToolContract(openlibrarySearchBooks, { query: 'book' });
    expect(result.structuredContent).toMatchObject({ works: [work] });
    const text = contentText(result);
    for (const value of [
      'OL9A',
      '4.2897363',
      'Has full text: false',
      '**Subjects:** []',
      '**Selected edition title:**',
      '**Selected edition languages:** []',
      '**Selected edition publishers:** []',
      '**Authors:** []',
      '**IA:** []',
      '**Matching editions (provider count):** 0',
    ])
      expect(text).toContain(value);
  });

  it('clamps a page once while preserving over-paged guidance and provider total', async () => {
    initOpenLibraryService();
    const svc = (
      await import('@/services/open-library/open-library-service.js')
    ).getOpenLibraryService();
    const spy = vi
      .spyOn(svc, 'searchBooks')
      .mockResolvedValueOnce({ total: 19, offset: 500, works: [] });
    const result = await runToolContract(openlibrarySearchBooks, {
      query: 'book',
      limit: 1001,
      offset: 500,
    });
    expect(result.isError).toBeFalsy();
    expect(spy).toHaveBeenCalledOnce();
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 1000, offset: 500 }),
      expect.anything(),
    );
    expect(result.structuredContent).toMatchObject({
      total: 19,
      offset: 500,
      works: [],
      notice: expect.stringContaining('past the end'),
    });
    expect(JSON.stringify(result.content)).toContain('applied limit 1000.');
    expect(JSON.stringify(result.content)).not.toContain('Next offset');
  });
  beforeEach(() => {
    initOpenLibraryService();
  });

  it.each([
    { query: 'language:fre' },
    { query: 'book' },
    { author: 'Writer' },
    { title: 'Book', language: 'fre' },
  ])('exposes the provider-selected edition for %j on both surfaces', async (input) => {
    const svc = (
      await import('@/services/open-library/open-library-service.js')
    ).getOpenLibraryService();
    vi.spyOn(svc, 'searchBooks').mockResolvedValue({
      total: 1,
      offset: 0,
      works: [
        {
          ...makeWork(),
          matching_edition: {
            edition_id: 'OL2M',
            title: 'Selected edition',
            languages: ['eng', 'fre'],
            publishers: ['First publisher', 'Second publisher'],
          },
          matching_edition_count: 7,
        },
      ],
    });
    const result = await runToolContract(openlibrarySearchBooks, input);
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      works: [
        {
          matching_edition: {
            edition_id: 'OL2M',
            title: 'Selected edition',
            languages: ['eng', 'fre'],
            publishers: ['First publisher', 'Second publisher'],
          },
          matching_edition_count: 7,
        },
      ],
    });
    const text = JSON.stringify(result.content);
    for (const value of [
      'OL2M',
      'Selected edition',
      'eng',
      'fre',
      'First publisher',
      'Second publisher',
      '7',
    ])
      expect(text).toContain(value);
  });

  it('lists the ia:, author_key:, first_publish_year:, and ebook_access: prefixes beside the six', () => {
    const description = openlibrarySearchBooks.input.shape.query.description;
    for (const prefix of [
      'title:',
      'author:',
      'subject:',
      'publisher:',
      'isbn:',
      'language:',
      'ia:',
      'author_key:',
      'first_publish_year:[1900 TO 1950]',
      'ebook_access:public',
    ])
      expect(description).toContain(prefix);
  });

  it('declares actionable upstream search validation recovery without restricting the query schema', () => {
    expect(openlibrarySearchBooks.input.parse({ query: '', title: 'Book' }).query).toBe('');
    expect(openlibrarySearchBooks.input.parse({ query: 'ab' }).query).toBe('ab');
    expect(openlibrarySearchBooks.errors).toContainEqual(
      expect.objectContaining({
        reason: 'invalid_search_query',
        thrownBy: 'service',
        recovery: expect.stringContaining('title'),
      }),
    );
  });

  it('propagates actual search 422 validation with recovery on both surfaces', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      Response.json(
        { detail: [{ msg: 'Search query is too short', arbitrary: 'DO_NOT_ECHO' }] },
        { status: 422 },
      ),
    );
    const result = await runToolContract(openlibrarySearchBooks, { query: 'ab' });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        data: {
          reason: 'invalid_search_query',
          status: 422,
          validation_messages: ['Search query is too short'],
          recovery: { hint: expect.stringContaining('longer general query') },
        },
      },
    });
    const text = JSON.stringify(result.content);
    expect(text).toContain('Search query is too short');
    expect(text).toContain('longer general query');
    expect(JSON.stringify(result)).not.toContain('DO_NOT_ECHO');
    vi.restoreAllMocks();
  });

  it('preserves a zero matching-edition count without inventing a selected edition', async () => {
    const svc = (
      await import('@/services/open-library/open-library-service.js')
    ).getOpenLibraryService();
    vi.spyOn(svc, 'searchBooks').mockResolvedValue({
      total: 1,
      offset: 0,
      works: [{ ...makeWork(), matching_edition_count: 0 }],
    });
    const result = await runToolContract(openlibrarySearchBooks, { query: 'book' });
    const output = openlibrarySearchBooks.output.parse(result.structuredContent);
    expect(output.works[0]).not.toHaveProperty('matching_edition');
    expect(output.works[0]?.matching_edition_count).toBe(0);
    expect(JSON.stringify(result.content)).toContain('Matching editions (provider count):** 0');
  });

  it('renders sparse selected editions and escapes complete supplied title and publisher values', async () => {
    const svc = (
      await import('@/services/open-library/open-library-service.js')
    ).getOpenLibraryService();
    vi.spyOn(svc, 'searchBooks').mockResolvedValue({
      total: 2,
      offset: 0,
      works: [
        {
          ...makeWork(),
          matching_edition: {
            edition_id: 'OL2M',
            title: '*Edition* <b>title</b>',
            publishers: ['[Publisher](https://example.test)'],
          },
        },
        { ...makeWork(), matching_edition: { edition_id: 'OL3M' } },
      ],
    });
    const result = await runToolContract(openlibrarySearchBooks, { query: 'book' });
    const output = openlibrarySearchBooks.output.parse(result.structuredContent);
    expect(output.works[0]?.matching_edition?.title).toBe('*Edition* <b>title</b>');
    expect(output.works[1]?.matching_edition).toEqual({ edition_id: 'OL3M' });
    const text = contentText(result);
    expect(text).toContain('\\*Edition\\* \\<b>title\\</b>');
    expect(text).toContain('\\[Publisher\\](https://example.test)');
    expect(text).toContain('OL3M');
    expect(text).not.toContain('undefined');
  });

  // ─── Input validation ───────────────────────────────────────────────────────

  it('rejects limit below 1', () => {
    expect(() => openlibrarySearchBooks.input.parse({ query: 'test', limit: 0 })).toThrow();
  });

  it('accepts a limit above the page ceiling for clamping', () => {
    expect(openlibrarySearchBooks.input.parse({ query: 'test', limit: 101 }).limit).toBe(101);
  });

  it('rejects negative offset', () => {
    expect(() => openlibrarySearchBooks.input.parse({ query: 'test', offset: -1 })).toThrow();
  });

  it('rejects non-integer limit', () => {
    expect(() => openlibrarySearchBooks.input.parse({ query: 'test', limit: 1.5 })).toThrow();
  });

  it('rejects invalid sort value', () => {
    expect(() => openlibrarySearchBooks.input.parse({ query: 'test', sort: 'invalid' })).toThrow();
  });

  // ─── Pagination boundaries ──────────────────────────────────────────────────

  it('accepts limit of 1', () => {
    const input = openlibrarySearchBooks.input.parse({ query: 'test', limit: 1 });
    expect(input.limit).toBe(1);
  });

  it('accepts limit of 100', () => {
    const input = openlibrarySearchBooks.input.parse({ query: 'test', limit: 100 });
    expect(input.limit).toBe(100);
  });

  it('accepts large offset for pagination', () => {
    const input = openlibrarySearchBooks.input.parse({ query: 'test', offset: 990 });
    expect(input.offset).toBe(990);
  });

  // ─── Query-echo enrichment ──────────────────────────────────────────────────

  it('does not populate queryEcho for a bare single-filter query', async () => {
    const ctx = createMockContext({ errors: openlibrarySearchBooks.errors });
    const svc = (
      await import('@/services/open-library/open-library-service.js')
    ).getOpenLibraryService();
    vi.spyOn(svc, 'searchBooks').mockResolvedValueOnce({
      total: 1,
      offset: 0,
      works: [makeWork()],
    });

    const input = openlibrarySearchBooks.input.parse({ query: 'gatsby' });
    await openlibrarySearchBooks.handler(input, ctx);

    const enrichment = getEnrichment(ctx);
    // A bare single-filter query must OMIT the queryEcho key entirely. Keying it as
    // `undefined` survives the enrichment parse and renders a literal "undefined" in
    // the content[] trailer (#10) — `toBeUndefined()` would pass either way, so assert
    // key absence.
    expect('queryEcho' in enrichment).toBe(false);
  });

  it('omits queryEcho for a bare query that yields no results', async () => {
    const ctx = createMockContext({ errors: openlibrarySearchBooks.errors });
    const svc = (
      await import('@/services/open-library/open-library-service.js')
    ).getOpenLibraryService();
    vi.spyOn(svc, 'searchBooks').mockResolvedValueOnce({ total: 0, offset: 0, works: [] });

    const input = openlibrarySearchBooks.input.parse({ query: 'zzznoresultsquery' });
    await openlibrarySearchBooks.handler(input, ctx);

    const enrichment = getEnrichment(ctx);
    // The empty-result branch reproduced the same undefined-literal bug — assert the
    // key is absent there too, while the recovery notice still lands.
    expect('queryEcho' in enrichment).toBe(false);
    expect(enrichment.notice).toBeDefined();
  });

  it('populates queryEcho when both title and author filters are active', async () => {
    const ctx = createMockContext({ errors: openlibrarySearchBooks.errors });
    const svc = (
      await import('@/services/open-library/open-library-service.js')
    ).getOpenLibraryService();
    vi.spyOn(svc, 'searchBooks').mockResolvedValueOnce({
      total: 1,
      offset: 0,
      works: [makeWork()],
    });

    const input = openlibrarySearchBooks.input.parse({
      title: 'gatsby',
      author: 'fitzgerald',
    });
    await openlibrarySearchBooks.handler(input, ctx);

    const enrichment = getEnrichment(ctx);
    // Echo case: the key is present with the composed filter string.
    expect('queryEcho' in enrichment).toBe(true);
    expect(enrichment.queryEcho).toContain('gatsby');
    expect(enrichment.queryEcho).toContain('fitzgerald');
  });

  it('includes notice with filter description when multi-filter search yields no results', async () => {
    const ctx = createMockContext({ errors: openlibrarySearchBooks.errors });
    const svc = (
      await import('@/services/open-library/open-library-service.js')
    ).getOpenLibraryService();
    vi.spyOn(svc, 'searchBooks').mockResolvedValueOnce({ total: 0, offset: 0, works: [] });

    const input = openlibrarySearchBooks.input.parse({
      query: 'nonexistent',
      author: 'nobody',
    });
    await openlibrarySearchBooks.handler(input, ctx);

    const enrichment = getEnrichment(ctx);
    expect(enrichment.notice).toBeDefined();
    expect(enrichment.notice).toContain('nonexistent');
  });

  // ─── Service error propagation ──────────────────────────────────────────────

  it('propagates service errors without swallowing them', async () => {
    const ctx = createMockContext({ errors: openlibrarySearchBooks.errors });
    const svc = (
      await import('@/services/open-library/open-library-service.js')
    ).getOpenLibraryService();
    vi.spyOn(svc, 'searchBooks').mockRejectedValueOnce(new Error('Service unavailable'));

    const input = openlibrarySearchBooks.input.parse({ query: 'test' });
    await expect(openlibrarySearchBooks.handler(input, ctx)).rejects.toThrow('Service unavailable');
  });

  // ─── Security: injection and oversized inputs ───────────────────────────────

  it('passes injection-attempt query to service without modification (no server-side exec)', async () => {
    const ctx = createMockContext({ errors: openlibrarySearchBooks.errors });
    const svc = (
      await import('@/services/open-library/open-library-service.js')
    ).getOpenLibraryService();
    const spy = vi.spyOn(svc, 'searchBooks').mockResolvedValueOnce({
      total: 0,
      offset: 0,
      works: [],
    });

    // SQL/query injection attempt — server should treat it as plain text
    const injectionQuery = "' OR '1'='1' --";
    const input = openlibrarySearchBooks.input.parse({ query: injectionQuery });
    await openlibrarySearchBooks.handler(input, ctx);

    // Passed to service as-is; service sanitizes via URLSearchParams
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ query: injectionQuery }), ctx);
  });

  it('handles unicode multibyte query without error', async () => {
    const ctx = createMockContext({ errors: openlibrarySearchBooks.errors });
    const svc = (
      await import('@/services/open-library/open-library-service.js')
    ).getOpenLibraryService();
    vi.spyOn(svc, 'searchBooks').mockResolvedValueOnce({ total: 0, offset: 0, works: [] });

    const input = openlibrarySearchBooks.input.parse({ query: '日本語テスト 한국어 العربية' });
    const result = await openlibrarySearchBooks.handler(input, ctx);
    expect(result.total).toBe(0);
  });

  it('handles an oversized query string without crashing', async () => {
    const ctx = createMockContext({ errors: openlibrarySearchBooks.errors });
    const svc = (
      await import('@/services/open-library/open-library-service.js')
    ).getOpenLibraryService();
    vi.spyOn(svc, 'searchBooks').mockResolvedValueOnce({ total: 0, offset: 0, works: [] });

    const bigQuery = 'a'.repeat(10_000);
    const input = openlibrarySearchBooks.input.parse({ query: bigQuery });
    const result = await openlibrarySearchBooks.handler(input, ctx);
    expect(result.total).toBe(0);
  });

  // ─── Format edge cases ──────────────────────────────────────────────────────

  it('formats zero results correctly', () => {
    const output = { total: 0, offset: 0, works: [] };
    const text = (openlibrarySearchBooks.format!(output)[0] as { text: string }).text;
    expect(text).toContain('Total results:** 0');
    expect(text).toContain('Returned:** 0');
  });

  it('formats work with ratings_average', () => {
    const work = {
      work_id: 'OL1W',
      title: 'Rated Work',
      author_names: [],
      author_ids: [],
      edition_count: 5,
      ebook_access: 'public' as const,
      has_fulltext: true,
      ia_identifiers: [],
      ratings_average: 4.2,
    };
    const text = (
      openlibrarySearchBooks.format!({ total: 1, offset: 0, works: [work] })[0] as {
        text: string;
      }
    ).text;
    expect(text).toContain('4.2');
    expect(text).toContain('Has full text');
  });

  it('formats multiple works in order', () => {
    const works = [
      {
        work_id: 'OL1W',
        title: 'Alpha',
        author_names: [],
        author_ids: [],
        edition_count: 1,
        ebook_access: 'no_ebook' as const,
        has_fulltext: false,
        ia_identifiers: [],
      },
      {
        work_id: 'OL2W',
        title: 'Beta',
        author_names: [],
        author_ids: [],
        edition_count: 2,
        ebook_access: 'borrowable' as const,
        has_fulltext: true,
        ia_identifiers: [],
      },
    ];
    const text = (
      openlibrarySearchBooks.format!({ total: 2, offset: 0, works: [works[0]!, works[1]!] })[0] as {
        text: string;
      }
    ).text;
    const alphaIdx = text.indexOf('Alpha');
    const betaIdx = text.indexOf('Beta');
    expect(alphaIdx).toBeLessThan(betaIdx);
  });
});

/**
 * A blank criterion is absent (the full shape table runs at the service seam); these cases prove
 * the handler's wiring: a search left without one fails before any request, and one left with a
 * criterion sends it and keeps the blanks out of its echo and notices.
 */
describe('openlibrarySearchBooks — blank criteria', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  const declaredRecovery = () =>
    openlibrarySearchBooks.errors!.find((entry) => entry.reason === 'no_search_criteria')?.recovery;
  const sentParams = () => new URL(String(fetchSpy.mock.calls[0]?.[0])).searchParams;

  beforeEach(() => {
    initOpenLibraryService();
    fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(Response.json({ numFound: 0, start: 0, docs: [] }));
  });
  afterEach(() => vi.restoreAllMocks());

  it.each([
    {},
    { query: '' },
    { query: '   ' },
    { isbn: ' - ' },
    { language: 'ger' },
    { sort: 'new' },
  ] as const)(
    'fails %j as no_search_criteria before any request, on both surfaces',
    async (input) => {
      const result = await runToolContract(openlibrarySearchBooks, input);
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: {
          code: JsonRpcErrorCode.ValidationError,
          data: { reason: 'no_search_criteria', recovery: { hint: declaredRecovery() } },
        },
      });
      expect(contentText(result)).toContain(declaredRecovery());
      expect(fetchSpy).not.toHaveBeenCalled();
    },
  );

  it('fails a blank search over the page ceiling without logging a clamp', async () => {
    const ctx = createMockContext({ errors: openlibrarySearchBooks.errors });
    const log = vi.spyOn(ctx.log, 'notice');
    await expect(
      openlibrarySearchBooks.handler(
        openlibrarySearchBooks.input.parse({ query: '   ', limit: 1500 }),
        ctx,
      ),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'no_search_criteria' },
    });
    expect(log).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('names every accepted criterion and says language and sort need one', () => {
    const recovery = declaredRecovery();
    for (const name of ['query', 'title', 'author', 'subject', 'publisher', 'isbn'])
      expect(recovery).toContain(name);
    expect(recovery).toMatch(/language and sort .*need/);
  });

  it('sends title alone for {"title":"faust","author":" "} and echoes no blank filter', async () => {
    const result = await runToolContract(openlibrarySearchBooks, { title: 'faust', author: ' ' });
    expect(result.isError).toBeFalsy();
    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(sentParams().get('title')).toBe('faust');
    expect(sentParams().has('author')).toBe(false);
    expect(result.structuredContent).not.toHaveProperty('queryEcho');
    expect((result.structuredContent as { notice: string }).notice).toBe(
      'No works matched title "faust". Try broader or different terms.',
    );
  });

  it('leaves blank query and subject out of the request, the echo, and the empty-page notice', async () => {
    const result = await runToolContract(openlibrarySearchBooks, {
      query: '   ',
      title: 'faust',
      author: 'goethe',
      subject: '\t',
    });
    expect(sentParams().has('q')).toBe(false);
    expect(sentParams().has('subject')).toBe(false);
    expect(result.structuredContent).toMatchObject({
      queryEcho: 'title "faust", author "goethe"',
      notice: 'No works matched title "faust", author "goethe". Try broader or different terms.',
    });
    const text = contentText(result);
    expect(text).toContain('title "faust", author "goethe"');
    expect(text).not.toContain('subject');
  });

  it('sends and echoes an ISO 639-2/T language code as its MARC code', async () => {
    const result = await runToolContract(openlibrarySearchBooks, {
      title: 'faust',
      language: 'DEU',
    });
    expect(sentParams().get('language')).toBe('ger');
    expect(result.structuredContent).toMatchObject({ queryEcho: 'title "faust", language "ger"' });
    expect(contentText(result)).toContain('**queryEcho:** `title "faust", language "ger"`');
  });

  it('fails a 3-letter code with no language record before any request, on both surfaces', async () => {
    const result = await runToolContract(openlibrarySearchBooks, {
      title: 'faust',
      language: 'qqq',
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.ValidationError,
        data: {
          reason: 'unknown_language_code',
          recovery: { hint: expect.stringContaining('3-letter') },
        },
      },
    });
    expect(contentText(result)).toContain('"qqq"');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
