/**
 * @fileoverview Edge case and security tests for the openlibrary_search_authors tool.
 * @module tests/tools/openlibrary-search-authors-edge.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { escapeMarkdownInline } from '@cyanheads/mcp-ts-core/utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openlibrarySearchAuthors } from '@/mcp-server/tools/definitions/openlibrary-search-authors.tool.js';
import { initOpenLibraryService } from '@/services/open-library/open-library-service.js';
import { expectLinearTime } from '../timing.js';

describe('openlibrarySearchAuthors — blank query', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  const declaredRecovery = () =>
    openlibrarySearchAuthors.errors!.find((entry) => entry.reason === 'no_search_criteria')
      ?.recovery;

  beforeEach(() => {
    initOpenLibraryService();
    fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(Response.json({ numFound: 0, docs: [] }));
  });
  afterEach(() => vi.restoreAllMocks());

  it.each(['', '   ', '\t\n'])(
    'fails %j as no_search_criteria before any request, on both surfaces',
    async (query) => {
      const result = await runToolContract(openlibrarySearchAuthors, { query });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: {
          code: JsonRpcErrorCode.ValidationError,
          data: { reason: 'no_search_criteria', recovery: { hint: declaredRecovery() } },
        },
      });
      expect(
        result.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n'),
      ).toContain(declaredRecovery());
      expect(fetchSpy).not.toHaveBeenCalled();
    },
  );

  it('fails a blank query over the page ceiling without logging a clamp', async () => {
    const ctx = createMockContext({ errors: openlibrarySearchAuthors.errors });
    const log = vi.spyOn(ctx.log, 'notice');
    await expect(
      openlibrarySearchAuthors.handler(
        openlibrarySearchAuthors.input.parse({ query: '   ', limit: 1500 }),
        ctx,
      ),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'no_search_criteria' },
    });
    expect(log).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each([
    [0, 'No authors matched "john \\*smith\\*"'],
    [4304, 'authors matched "john \\*smith\\*", so the last offset'],
  ])('escapes the query inside the notice (total %i) on both surfaces', async (total, expected) => {
    fetchSpy.mockResolvedValue(Response.json({ numFound: total, docs: [] }));
    const result = await runToolContract(openlibrarySearchAuthors, {
      query: 'john *smith*',
      offset: 9999,
    });
    expect((result.structuredContent as { notice: string }).notice).toContain(expected);
    expect(
      result.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n'),
    ).toContain(expected);
  });

  // The authors and search-inside notices both route the caller's unbounded query through this escape.
  it.each([
    ['a long digit run', (size: number) => '7'.repeat(size)],
    ['one long line ending in a break', (size: number) => `${'§1 x'.repeat(size / 4)}\ny`],
    ['breaks throughout', (size: number) => '  \r\n'.repeat(size / 4)],
    ['repeated emphasis openers', (size: number) => '*'.repeat(size)],
    ['repeated underscores', (size: number) => '_'.repeat(size)],
    ['repeated backticks', (size: number) => '`'.repeat(size)],
    ['repeated link openers', (size: number) => '['.repeat(size)],
    ['nested angle openers', (size: number) => '<a'.repeat(size / 2)],
    ['nested link openers', (size: number) => '[a]('.repeat(size / 4)],
    ['overlapping entity prefixes', (size: number) => '&#x'.repeat(Math.ceil(size / 3))],
  ])(
    'escapes a query of %s in linear time',
    (_shape, make) => expectLinearTime(make, escapeMarkdownInline),
    0,
  );

  it('sends a padded query untrimmed', async () => {
    await runToolContract(openlibrarySearchAuthors, { query: ' le guin ' });
    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(new URL(String(fetchSpy.mock.calls[0]?.[0])).searchParams.get('q')).toBe(' le guin ');
  });
});

describe('openlibrarySearchAuthors — edge cases and security', () => {
  beforeEach(() => {
    initOpenLibraryService();
  });

  // ─── Input validation ───────────────────────────────────────────────────────

  it('rejects limit below 1', () => {
    expect(() => openlibrarySearchAuthors.input.parse({ query: 'tolkien', limit: 0 })).toThrow();
  });

  it('accepts a limit above the page ceiling for clamping', () => {
    expect(openlibrarySearchAuthors.input.parse({ query: 'tolkien', limit: 101 }).limit).toBe(101);
  });

  it('rejects negative offset', () => {
    expect(() => openlibrarySearchAuthors.input.parse({ query: 'tolkien', offset: -1 })).toThrow();
  });

  // ─── Pagination boundaries ──────────────────────────────────────────────────

  it('accepts limit 1', () => {
    const input = openlibrarySearchAuthors.input.parse({ query: 'tolkien', limit: 1 });
    expect(input.limit).toBe(1);
  });

  it('accepts limit 100', () => {
    const input = openlibrarySearchAuthors.input.parse({ query: 'tolkien', limit: 100 });
    expect(input.limit).toBe(100);
  });

  // ─── Service error propagation ──────────────────────────────────────────────

  it('propagates service errors', async () => {
    const ctx = createMockContext({ errors: openlibrarySearchAuthors.errors });
    const svc = (
      await import('@/services/open-library/open-library-service.js')
    ).getOpenLibraryService();
    vi.spyOn(svc, 'searchAuthors').mockRejectedValueOnce(new Error('Network error'));

    const input = openlibrarySearchAuthors.input.parse({ query: 'tolkien' });
    await expect(openlibrarySearchAuthors.handler(input, ctx)).rejects.toThrow('Network error');
  });

  // ─── Injection attempt ──────────────────────────────────────────────────────

  it('passes query injection attempt to service as plain text', async () => {
    const ctx = createMockContext({ errors: openlibrarySearchAuthors.errors });
    const svc = (
      await import('@/services/open-library/open-library-service.js')
    ).getOpenLibraryService();
    const spy = vi.spyOn(svc, 'searchAuthors').mockResolvedValueOnce({
      total: 0,
      authors: [],
    });

    const injectionQuery = '<script>alert("xss")</script>';
    const input = openlibrarySearchAuthors.input.parse({ query: injectionQuery });
    await openlibrarySearchAuthors.handler(input, ctx);

    expect(spy).toHaveBeenCalledWith(injectionQuery, expect.any(Number), expect.any(Number), ctx);
  });

  // ─── Notice enrichment ──────────────────────────────────────────────────────

  it('notice mentions the query when no results found', async () => {
    const ctx = createMockContext({ errors: openlibrarySearchAuthors.errors });
    const svc = (
      await import('@/services/open-library/open-library-service.js')
    ).getOpenLibraryService();
    vi.spyOn(svc, 'searchAuthors').mockResolvedValueOnce({ total: 0, authors: [] });

    const input = openlibrarySearchAuthors.input.parse({ query: 'xzxzxz_notanauthor' });
    await openlibrarySearchAuthors.handler(input, ctx);

    const enrichment = getEnrichment(ctx);
    expect(enrichment.notice).toContain('xzxzxz_notanauthor');
  });

  // ─── Format edge cases ──────────────────────────────────────────────────────

  it('formats author with no ratings (absent rating line)', () => {
    const author = {
      author_id: 'OL1A',
      name: 'No-Ratings Author',
      alternate_names: [],
      work_count: 3,
      top_subjects: [],
      // ratings_average absent
    };
    const output = { total: 1, offset: 0, authors: [author] };
    const text = (openlibrarySearchAuthors.format!(output)[0] as { text: string }).text;
    expect(text).toContain('OL1A');
    expect(text).not.toContain('Rating:');
    expect(text).not.toContain('undefined');
  });

  it('renders every top subject without an obsolete cap notice', async () => {
    const ctx = createMockContext({ errors: openlibrarySearchAuthors.errors });
    const svc = (
      await import('@/services/open-library/open-library-service.js')
    ).getOpenLibraryService();

    const author = {
      author_id: 'OL2A',
      name: 'Prolific Author',
      alternate_names: [],
      work_count: 50,
      top_subjects: ['Subject1', 'Subject2', 'Subject3', 'Subject4', 'Subject5', 'Subject6'],
    };
    vi.spyOn(svc, 'searchAuthors').mockResolvedValueOnce({ total: 1, authors: [author] });

    const input = openlibrarySearchAuthors.input.parse({ query: 'prolific' });
    const result = await openlibrarySearchAuthors.handler(input, ctx);

    // structuredContent keeps every top subject.
    expect(result.authors[0]!.top_subjects).toHaveLength(6);

    // Every subject is available to text clients, so there is no cap disclosure.
    const enrichment = getEnrichment(ctx);
    expect(enrichment.notice).toBeUndefined();

    // The final subject must survive the text rendering too.
    const text = (openlibrarySearchAuthors.format!(result)[0] as { text: string }).text;
    expect(text).toContain('Subject5');
    expect(text).toContain('Subject6');
  });

  it('renders five subjects without a cap notice', async () => {
    const ctx = createMockContext({ errors: openlibrarySearchAuthors.errors });
    const svc = (
      await import('@/services/open-library/open-library-service.js')
    ).getOpenLibraryService();

    const author = {
      author_id: 'OL2A',
      name: 'Boundary Author',
      alternate_names: [],
      work_count: 50,
      top_subjects: ['Subject1', 'Subject2', 'Subject3', 'Subject4', 'Subject5'],
    };
    vi.spyOn(svc, 'searchAuthors').mockResolvedValueOnce({ total: 1, authors: [author] });

    const input = openlibrarySearchAuthors.input.parse({ query: 'boundary' });
    await openlibrarySearchAuthors.handler(input, ctx);

    // A complete list needs no truncation disclosure.
    expect(getEnrichment(ctx).notice).toBeUndefined();
  });

  it('formats empty results cleanly', () => {
    const output = { total: 0, offset: 0, authors: [] };
    const text = (openlibrarySearchAuthors.format!(output)[0] as { text: string }).text;
    expect(text).toContain('Total:** 0');
    expect(text).toContain('Returned:** 0');
    expect(text).not.toContain('undefined');
  });

  it('format does not emit null strings', () => {
    const author = {
      author_id: 'OL3A',
      name: 'Sparse Author',
      alternate_names: [],
      work_count: 0,
      top_subjects: [],
    };
    const text = (
      openlibrarySearchAuthors.format!({ total: 1, offset: 0, authors: [author] })[0] as {
        text: string;
      }
    ).text;
    expect(text).not.toContain('null');
  });
});
