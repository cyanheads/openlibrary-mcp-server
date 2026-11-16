/**
 * @fileoverview Tests for the openlibrary_search_inside tool.
 * @module tests/tools/openlibrary-search-inside.tool.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openlibrarySearchInside } from '@/mcp-server/tools/definitions/openlibrary-search-inside.tool.js';
import {
  getOpenLibraryService,
  initOpenLibraryService,
} from '@/services/open-library/open-library-service.js';

/**
 * The upstream envelope, shaped as the live `search/inside.json` returns it:
 * every `fields` value is an array, the metadata keys are `meta_`-prefixed, and
 * matched terms are wrapped in `{{{…}}}`.
 */
function insideResponse(
  hits: Array<{
    identifier?: string;
    meta_title?: string;
    meta_creator?: string;
    text?: string[];
    score?: number;
  }>,
  total = hits.length,
): Response {
  return new Response(
    JSON.stringify({
      hits: {
        total,
        max_score: hits.length ? 30.28 : null,
        hits: hits.map((hit) => ({
          _id: `${hit.identifier}|abc123`,
          _score: hit.score ?? 30.28,
          fields: {
            ...(hit.identifier ? { identifier: [hit.identifier] } : {}),
            ...(hit.meta_title ? { meta_title: [hit.meta_title] } : {}),
            ...(hit.meta_creator ? { meta_creator: [hit.meta_creator] } : {}),
          },
          ...(hit.text ? { highlight: { text: hit.text } } : {}),
        })),
      },
    }),
    { status: 200 },
  );
}

const RICH_MATCH = {
  ia_identifier: 'raptorsofparadis0000burr_o0e8',
  title: 'Raptors of paradise',
  creator: 'Burridge, Jay, author',
  snippets: ['~ the spice must flow ~', 'He winked at Bea. “The spice must flow.'],
  score: 30.28,
};

/** The text blocks of a tool result as a client renders them, joined by newlines. */
function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content
    .flatMap((block) => (block.type === 'text' ? [block.text ?? ''] : []))
    .join('\n');
}

describe('openlibrarySearchInside', () => {
  it('clamps before fetching and preserves an over-paged notice on both surfaces', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(insideResponse([], 52));
    const result = await runToolContract(openlibrarySearchInside, {
      query: 'dune',
      limit: 101,
      offset: 100,
    });
    expect(result.isError).toBeFalsy();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(String(fetchSpy.mock.calls[0]?.[0])).toContain('limit=100');
    expect(result.structuredContent).toMatchObject({ total: 52, offset: 100, matches: [] });
    const notice = (result.structuredContent as { notice: string }).notice;
    expect(notice).toContain('Requested limit 101; applied limit 100.');
    expect(notice).not.toContain('Next offset');
    expect(notice).toContain('past the end');
    expect(textOf(result)).toContain(notice);
  });
  it('renders every literal snippet and the exact score', () => {
    const result = {
      total: 1,
      offset: 0,
      matches: [
        {
          ia_identifier: 'item',
          title: '',
          creator: '',
          score: 1.234567,
          snippets: ['a', 'b', 'c', '*last*\n# next'],
        },
      ],
    };
    const text = (openlibrarySearchInside.format!(result)[0] as { text: string }).text;
    expect(text).toContain('1.234567');
    expect(text).toContain('\\*last\\*\\\n\\# next');
    expect(text).toContain('**Title:** ');
  });
  beforeEach(() => {
    initOpenLibraryService();
    // The suite never reaches openlibrary.org: a request no test routed fails loudly.
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unmocked fetch'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('maps the Elasticsearch envelope onto the match shape', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      insideResponse(
        [
          {
            identifier: 'raptorsofparadis0000burr_o0e8',
            meta_title: 'Raptors of paradise',
            meta_creator: 'Burridge, Jay, author',
            text: ['~ {{{the spice must flow}}} ~'],
            score: 30.28,
          },
        ],
        52,
      ),
    );

    const ctx = createMockContext({ errors: openlibrarySearchInside.errors });
    const input = openlibrarySearchInside.input.parse({ query: '"the spice must flow"' });
    const result = await openlibrarySearchInside.handler(input, ctx);

    expect(result.total).toBe(52);
    expect(result.matches).toEqual([
      {
        ia_identifier: 'raptorsofparadis0000burr_o0e8',
        title: 'Raptors of paradise',
        creator: 'Burridge, Jay, author',
        snippets: ['~ the spice must flow ~'],
        score: 30.28,
      },
    ]);
  });

  it('strips the {{{…}}} highlight markers from every snippet', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      insideResponse([
        {
          identifier: 'item1',
          meta_title: 'A Book',
          text: ['before {{{matched phrase}}} after', '{{{another}}} one {{{here}}}'],
        },
      ]),
    );

    const result = await openlibrarySearchInside.handler(
      openlibrarySearchInside.input.parse({ query: 'matched phrase' }),
      createMockContext({ errors: openlibrarySearchInside.errors }),
    );

    expect(result.matches[0]?.snippets).toEqual([
      'before matched phrase after',
      'another one here',
    ]);
  });

  // meta_creator is confirmed absent on real hits; meta_title can be too. Neither
  // absence is an error, and neither may be invented in the output.
  it('keeps a sparse hit, omitting title and creator rather than fabricating them', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      insideResponse([{ identifier: 'sparseitem', text: ['a matching passage'] }]),
    );

    const result = await openlibrarySearchInside.handler(
      openlibrarySearchInside.input.parse({ query: 'passage' }),
      createMockContext({ errors: openlibrarySearchInside.errors }),
    );

    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]?.ia_identifier).toBe('sparseitem');
    expect(result.matches[0]?.title).toBeUndefined();
    expect(result.matches[0]?.creator).toBeUndefined();
  });

  it('drops a hit with no IA identifier — the only join back to the catalogue', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      insideResponse([{ meta_title: 'Orphan', text: ['text'] }, { identifier: 'good' }]),
    );

    const result = await openlibrarySearchInside.handler(
      openlibrarySearchInside.input.parse({ query: 'text' }),
      createMockContext({ errors: openlibrarySearchInside.errors }),
    );

    expect(result.matches.map((m) => m.ia_identifier)).toEqual(['good']);
  });

  it('treats a zero-match query as an empty result with a broadening notice', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(insideResponse([], 0));

    const result = await runToolContract(openlibrarySearchInside, {
      query: '"zzqqxx nonsense phrase"',
    });

    expect(result.structuredContent).toMatchObject({ total: 0, matches: [] });
    const notice =
      'No scanned book contains "zzqqxx nonsense phrase". An exact-phrase query only matches the wording as printed — drop the quotes to match the terms independently, or shorten the phrase.';
    expect((result.structuredContent as { notice?: string }).notice).toBe(notice);
    expect(textOf(result)).toContain(notice);
  });

  it('points an over-paged request at a valid offset instead of reporting no matches', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(insideResponse([], 52));

    const result = await runToolContract(openlibrarySearchInside, { query: 'dune', offset: 5000 });

    expect(result.structuredContent).toMatchObject({ total: 52, offset: 5000, matches: [] });
    const notice =
      'Offset 5000 is past the end of the result set — 52 items matched, so the last offset that returns a result is 51. Retry with a lower offset; the query itself matched.';
    expect((result.structuredContent as { notice?: string }).notice).toBe(notice);
    expect(textOf(result)).toContain(notice);
  });

  it('sends the query, limit, and offset upstream', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(insideResponse([]));

    await getOpenLibraryService().searchInside(
      'dune',
      5,
      10,
      createMockContext({ errors: openlibrarySearchInside.errors }),
    );

    const url = String(fetchSpy.mock.calls[0]?.[0]);
    expect(url).toContain('/search/inside.json');
    expect(url).toContain('q=dune');
    expect(url).toContain('limit=5');
    expect(url).toContain('offset=10');
  });

  it('rejects an empty query at the schema rather than relying on upstream', () => {
    expect(() => openlibrarySearchInside.input.parse({ query: '' })).toThrow();
  });

  it.each([' ', '   ', '\t', '\n'])(
    'fails a whitespace-only query (%j) as no_search_criteria before any request',
    async (query) => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(insideResponse([], 0));
      const recovery = openlibrarySearchInside.errors!.find(
        (entry) => entry.reason === 'no_search_criteria',
      )?.recovery;
      const result = await runToolContract(openlibrarySearchInside, { query });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: {
          code: JsonRpcErrorCode.ValidationError,
          data: { reason: 'no_search_criteria', recovery: { hint: recovery } },
        },
      });
      const text = textOf(result);
      expect(text).toContain(recovery);
      expect(text).not.toContain('No scanned book contains');
      expect(fetchSpy).not.toHaveBeenCalled();
    },
  );

  // A blank query is the first fault named, whatever the offset asks for.
  it('fails a whitespace-only query at offset 10000 as no_search_criteria, on both surfaces', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(insideResponse([], 0));
    const recovery = openlibrarySearchInside.errors!.find(
      (entry) => entry.reason === 'no_search_criteria',
    )?.recovery;
    const result = await runToolContract(openlibrarySearchInside, { query: '   ', offset: 10_000 });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.ValidationError,
        data: { reason: 'no_search_criteria', recovery: { hint: recovery } },
      },
    });
    const text = textOf(result);
    expect(text).toContain(recovery);
    expect(text).not.toContain('10,000');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('fails a whitespace-only query over the page ceiling without logging a clamp', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(insideResponse([], 0));
    const ctx = createMockContext({ errors: openlibrarySearchInside.errors });
    const log = vi.spyOn(ctx.log, 'notice');
    await expect(
      openlibrarySearchInside.handler(
        openlibrarySearchInside.input.parse({ query: '   ', limit: 500 }),
        ctx,
      ),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'no_search_criteria' },
    });
    expect(log).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('applies default limit and offset', () => {
    const input = openlibrarySearchInside.input.parse({ query: 'dune' });
    expect(input.limit).toBe(10);
    expect(input.offset).toBe(0);
  });

  // ─── Complete snippet rendering ─────────────────────────────────────────────

  it('renders all snippets returned in structuredContent', async () => {
    const manySnippets = ['one', 'two', 'three', 'four', 'five'];
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      insideResponse([{ identifier: 'item1', meta_title: 'A Book', text: manySnippets }]),
    );

    const ctx = createMockContext({ errors: openlibrarySearchInside.errors });
    const result = await openlibrarySearchInside.handler(
      openlibrarySearchInside.input.parse({ query: 'x' }),
      ctx,
    );

    expect(result.matches[0]?.snippets).toEqual(manySnippets);
    const text = (openlibrarySearchInside.format!(result)[0] as { text: string }).text;
    expect(text).toContain('**Passage:** one');
    expect(text).toContain('**Passage:** three');
    expect(text).toContain('**Passage:** four');
    expect(text).toContain('**Passage:** five');
  });

  it('adds no obsolete snippet cap notice', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      insideResponse([
        { identifier: 'item1', meta_title: 'A Book', text: ['one', 'two', 'three', 'four'] },
      ]),
    );

    const ctx = createMockContext({ errors: openlibrarySearchInside.errors });
    const notices: string[] = [];
    ctx.enrich.notice = (message: string) => {
      notices.push(message);
    };

    await openlibrarySearchInside.handler(openlibrarySearchInside.input.parse({ query: 'x' }), ctx);

    expect(notices).toEqual([]);
  });

  it('adds no cap notice when every snippet is rendered', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      insideResponse([{ identifier: 'item1', meta_title: 'A Book', text: ['only one'] }]),
    );

    const ctx = createMockContext({ errors: openlibrarySearchInside.errors });
    const notices: string[] = [];
    ctx.enrich.notice = (message: string) => {
      notices.push(message);
    };

    await openlibrarySearchInside.handler(openlibrarySearchInside.input.parse({ query: 'x' }), ctx);

    expect(notices).toEqual([]);
  });

  // ─── format() ───────────────────────────────────────────────────────────────

  it('renders the identifier, score, creator, and snippets a caller needs to act on', () => {
    const text = (
      openlibrarySearchInside.format!({
        total: 52,
        offset: 0,
        matches: [RICH_MATCH],
      })[0] as { text: string }
    ).text;

    expect(text).toContain('**Total results:** 52');
    expect(text).toContain('raptorsofparadis0000burr_o0e8');
    expect(text).toContain('Raptors of paradise');
    expect(text).toContain('Burridge, Jay, author');
    expect(text).toContain('30.28');
    expect(text).toContain('\\~ the spice must flow \\~');
  });

  it('omits absent title and creator and explicitly renders empty snippets', () => {
    const text = (
      openlibrarySearchInside.format!({
        total: 1,
        offset: 0,
        matches: [{ ia_identifier: 'sparseitem', snippets: [], score: 1.5 }],
      })[0] as { text: string }
    ).text;

    expect(text).not.toContain('**Creator:**');
    expect(text).not.toContain('**Title:**');
    expect(text).toContain('**Snippets:** []');
    // A sparse item still carries its identifier.
    expect(text).toContain('**IA identifier:** sparseitem');
    expect(text).not.toContain('undefined');
  });

  it('renders an empty result without throwing', () => {
    const text = (
      openlibrarySearchInside.format!({ total: 0, offset: 0, matches: [] })[0] as { text: string }
    ).text;
    expect(text).toContain('**Returned:** 0');
  });
});

/**
 * The full-text index serves `offset + limit` up to 10,000 and answers past it with an HTTP 200
 * error object, which no retry fixes. A page that would cross the window is fitted to it with the
 * clamp notice; an offset at or past it fails before any request.
 */
describe('openlibrarySearchInside — the 10,000-result window', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  const sent = () => new URL(String(fetchSpy.mock.calls[0]?.[0])).searchParams;
  const hits = (count: number) =>
    Array.from({ length: count }, (_, i) => ({ identifier: `item${i}`, text: ['x'] }));

  beforeEach(() => {
    initOpenLibraryService();
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unmocked fetch'));
  });
  afterEach(() => vi.restoreAllMocks());

  it('routes an ia_identifier to its catalog record through an ia: query, with a fallback', () => {
    expect(openlibrarySearchInside.description).toContain(
      'openlibrary_search_books as query "ia:<ia_identifier>"',
    );
    expect(openlibrarySearchInside.description).toMatch(/matches nothing.*title and creator/);
  });

  it('names its 100-row ceiling and the window in the limit and offset descriptions', () => {
    expect(openlibrarySearchInside.input.shape.limit.description).toContain(
      'values above 100 apply 100',
    );
    expect(openlibrarySearchInside.input.shape.offset.description).toContain('below 10000');
  });

  it.each([
    // [offset, requested limit, applied limit]
    [9950, 100, 50],
    [9950, 150, 50],
    [9999, 10, 1],
  ])(
    'fits offset %i with limit %i to %i rows, logs the clamp once, and says where results end',
    async (offset, requested, applied) => {
      fetchSpy.mockResolvedValue(insideResponse(hits(applied), 719_290));
      const ctx = createMockContext({ errors: openlibrarySearchInside.errors });
      const log = vi.spyOn(ctx.log, 'notice');
      const result = await openlibrarySearchInside.handler(
        openlibrarySearchInside.input.parse({ query: 'whale', offset, limit: requested }),
        ctx,
      );
      expect(result.matches).toHaveLength(applied);
      expect(fetchSpy).toHaveBeenCalledOnce();
      expect(sent().get('limit')).toBe(String(applied));
      expect(sent().get('offset')).toBe(String(offset));
      expect(log).toHaveBeenCalledExactlyOnceWith('Applied Open Library request limit', {
        tool: 'openlibrary_search_inside',
        requested,
        applied,
      });
      const notice = getEnrichment(ctx).notice as string;
      expect(notice).toContain(`Requested limit ${requested}; applied limit ${applied}.`);
      // Offset 10000 is refused, so the notice names no next offset.
      expect(notice).not.toContain('Next offset');
      expect(notice).toContain('first 10,000 results');
    },
  );

  it('carries the window notice on both surfaces', async () => {
    fetchSpy.mockResolvedValue(insideResponse(hits(50), 719_290));
    const result = await runToolContract(openlibrarySearchInside, {
      query: 'whale',
      offset: 9950,
      limit: 100,
    });
    const notice = (result.structuredContent as { notice: string }).notice;
    expect(notice).toContain('applied limit 50');
    expect(textOf(result)).toContain(notice);
  });

  it('names the window, and no next offset, when the ceiling clamp lands on its last row', async () => {
    fetchSpy.mockResolvedValue(insideResponse(hits(100), 719_290));
    const result = await runToolContract(openlibrarySearchInside, {
      query: 'whale',
      offset: 9900,
      limit: 101,
    });
    expect(sent().get('limit')).toBe('100');
    expect((result.structuredContent as { notice: string }).notice).toBe(
      "Requested limit 101; applied limit 100. Open Library's full-text index serves only its first 10,000 results; narrow or quote the query to reach matches ranked below them.",
    );
  });

  it.each([
    // [offset, requested limit, next offset]
    [0, 150, 100],
    [9850, 200, 9950],
  ])(
    'keeps the window out of a ceiling clamp at offset %i (limit %i) that ends short of it, on both surfaces',
    async (offset, requested, next) => {
      fetchSpy.mockResolvedValue(insideResponse(hits(100), 719_290));
      const result = await runToolContract(openlibrarySearchInside, {
        query: 'whale',
        offset,
        limit: requested,
      });
      expect(sent().get('limit')).toBe('100');
      const notice = (result.structuredContent as { notice: string }).notice;
      expect(notice).toBe(`Requested limit ${requested}; applied limit 100. Next offset: ${next}.`);
      expect(textOf(result)).toContain(notice);
    },
  );

  it('keeps the window out of a past-end page whose matches end well inside it', async () => {
    fetchSpy.mockResolvedValue(insideResponse([], 525));
    const result = await runToolContract(openlibrarySearchInside, {
      query: 'whale harpoon',
      offset: 9950,
      limit: 100,
    });
    expect(sent().get('limit')).toBe('50');
    expect((result.structuredContent as { notice: string }).notice).toBe(
      'Requested limit 100; applied limit 50. Offset 9950 is past the end of the result set — 525 items matched, so the last offset that returns a result is 524. Retry with a lower offset; the query itself matched.',
    );
  });

  it('leaves a page that ends exactly at the window alone', async () => {
    fetchSpy.mockResolvedValue(insideResponse(hits(10), 719_290));
    const result = await runToolContract(openlibrarySearchInside, {
      query: 'whale',
      offset: 9990,
      limit: 10,
    });
    expect(sent().get('limit')).toBe('10');
    expect(result.structuredContent).not.toHaveProperty('notice');
  });

  it.each([10_000, 10_001, 800_000])(
    'fails offset %i as offset_past_result_window before any request, on both surfaces',
    async (offset) => {
      const recovery = openlibrarySearchInside.errors!.find(
        (entry) => entry.reason === 'offset_past_result_window',
      )?.recovery;
      const result = await runToolContract(openlibrarySearchInside, { query: 'whale', offset });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: {
          code: JsonRpcErrorCode.ValidationError,
          data: { reason: 'offset_past_result_window', recovery: { hint: recovery } },
        },
      });
      expect(recovery).toContain('below 10000');
      const text = textOf(result);
      expect(text).toContain(recovery);
      expect(text).toContain(String(offset));
      expect(fetchSpy).not.toHaveBeenCalled();
    },
  );
});

/**
 * `hits.total` is the only zero-match signal the full-text index sends. A 200
 * without a `hits` result set — an error object, `{}`, a truncated payload — is
 * the upstream failing to answer, and reporting it as "no book contains this"
 * would send the caller off to rephrase a query that was fine.
 */
describe('openlibrarySearchInside — a 200 without a result set', () => {
  const upstreamUnavailableHint = () =>
    openlibrarySearchInside.errors!.find((e) => e.reason === 'upstream_unavailable')?.recovery;

  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    initOpenLibraryService();
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unmocked fetch'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns an empty result with the no-match notice for a real hits.total of 0', async () => {
    fetchSpy.mockResolvedValue(insideResponse([], 0));

    const result = await runToolContract(openlibrarySearchInside, {
      query: '"zzqqxx nonsense phrase"',
    });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ total: 0, offset: 0, matches: [] });
    const notice = (result.structuredContent as { notice?: string }).notice;
    expect(notice).toContain('No scanned book contains "zzqqxx nonsense phrase"');
    expect(textOf(result)).toContain(notice as string);
  });

  it('escapes the query inside the no-match notice on both surfaces', async () => {
    fetchSpy.mockResolvedValue(insideResponse([], 0));
    const result = await runToolContract(openlibrarySearchInside, { query: '"*white* whale"' });
    const expected = 'No scanned book contains "\\*white\\* whale"';
    expect((result.structuredContent as { notice: string }).notice).toContain(expected);
    expect(textOf(result)).toContain(expected);
  });

  it.each([
    ['a null body', null],
    ['an empty object', {}],
    ['an error object', { error: 'search inside is temporarily unavailable' }],
    ['a null hits', { hits: null }],
    ['a string hits', { hits: 'unavailable' }],
    ['an array hits', { hits: [] }],
    ['a hits object with no total', { hits: { hits: [] } }],
    ['a hits object with a non-numeric total', { hits: { total: 'many', hits: [] } }],
  ])(
    'fails %s as upstream_unavailable on both surfaces, with no no-match notice',
    async (_label, body) => {
      fetchSpy.mockResolvedValue(new Response(JSON.stringify(body), { status: 200 }));

      const result = await runToolContract(openlibrarySearchInside, {
        query: '"the spice must flow"',
      });

      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: {
          code: JsonRpcErrorCode.ServiceUnavailable,
          data: {
            reason: 'upstream_unavailable',
            retryable: true,
            recovery: { hint: upstreamUnavailableHint() },
          },
        },
      });
      const text = textOf(result);
      expect(text).toContain(upstreamUnavailableHint());
      expect(text).not.toContain('No scanned book contains');
      // A fault on the most expensive endpoint is not re-issued in-loop.
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    },
  );

  it('raises the fault from the service as a retryable ServiceUnavailable', async () => {
    fetchSpy.mockResolvedValue(new Response('{}', { status: 200 }));

    const error = await getOpenLibraryService()
      .searchInside('dune', 10, 0, createMockContext({ errors: openlibrarySearchInside.errors }))
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(McpError);
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: { reason: 'upstream_unavailable', retryable: true },
    });
  });
});
