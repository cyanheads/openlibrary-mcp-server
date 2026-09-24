/**
 * @fileoverview Tests for the openlibrary_search_inside tool.
 * @module tests/tools/openlibrary-search-inside.tool.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
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

describe('openlibrarySearchInside', () => {
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

    const ctx = createMockContext({ errors: openlibrarySearchInside.errors });
    const result = await openlibrarySearchInside.handler(
      openlibrarySearchInside.input.parse({ query: '"zzqqxx nonsense phrase"' }),
      ctx,
    );

    expect(result.total).toBe(0);
    expect(result.matches).toEqual([]);
  });

  it('points an over-paged request at a valid offset instead of reporting no matches', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(insideResponse([], 52));

    const result = await openlibrarySearchInside.handler(
      openlibrarySearchInside.input.parse({ query: 'dune', offset: 5000 }),
      createMockContext({ errors: openlibrarySearchInside.errors }),
    );

    expect(result.total).toBe(52);
    expect(result.offset).toBe(5000);
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

  it('applies default limit and offset', () => {
    const input = openlibrarySearchInside.input.parse({ query: 'dune' });
    expect(input.limit).toBe(10);
    expect(input.offset).toBe(0);
  });

  // ─── Snippet cap disclosure ─────────────────────────────────────────────────

  it('caps rendered snippets at 3 while structuredContent keeps them all', async () => {
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
    expect(text).toContain('> one');
    expect(text).toContain('> three');
    expect(text).not.toContain('> four');
  });

  it('discloses the snippet cap in the enrichment notice', async () => {
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

    expect(notices.join(' ')).toContain('Snippets are capped at 3');
    expect(notices.join(' ')).toContain('matches[].snippets');
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
    expect(text).toContain('~ the spice must flow ~');
  });

  it('renders a missing creator as unknown rather than inventing one', () => {
    const text = (
      openlibrarySearchInside.format!({
        total: 1,
        offset: 0,
        matches: [{ ia_identifier: 'sparseitem', snippets: ['a passage'], score: 1.5 }],
      })[0] as { text: string }
    ).text;

    expect(text).toContain('**Creator:** Not available');
    // With no title, the identifier stands in as the heading.
    expect(text).toContain('## sparseitem');
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
 * `hits.total` is the only zero-match signal the full-text index sends. A 200
 * without a `hits` result set — an error object, `{}`, a truncated payload — is
 * the upstream failing to answer, and reporting it as "no book contains this"
 * would send the caller off to rephrase a query that was fine.
 */
describe('openlibrarySearchInside — a 200 without a result set', () => {
  const upstreamUnavailableHint = () =>
    openlibrarySearchInside.errors!.find((e) => e.reason === 'upstream_unavailable')?.recovery;

  function contentText(result: { content: unknown[] }): string {
    return result.content
      .map((block) => (block && typeof block === 'object' && 'text' in block ? block.text : ''))
      .join('\n');
  }

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
    expect(contentText(result)).toContain(notice as string);
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
      const text = contentText(result);
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
