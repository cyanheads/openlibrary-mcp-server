/**
 * @fileoverview Tests for the openlibrary_search_inside tool.
 * @module tests/tools/openlibrary-search-inside.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
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

    const ctx = createMockContext();
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
      createMockContext(),
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
      createMockContext(),
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
      createMockContext(),
    );

    expect(result.matches.map((m) => m.ia_identifier)).toEqual(['good']);
  });

  it('treats a zero-match query as an empty result with a broadening notice', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(insideResponse([], 0));

    const ctx = createMockContext();
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
      createMockContext(),
    );

    expect(result.total).toBe(52);
    expect(result.offset).toBe(5000);
  });

  it('sends the query, limit, and offset upstream', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(insideResponse([]));

    await getOpenLibraryService().searchInside('dune', 5, 10, createMockContext());

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

    const ctx = createMockContext();
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

    const ctx = createMockContext();
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

    const ctx = createMockContext();
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
