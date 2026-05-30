/**
 * @fileoverview Edge case and security tests for the openlibrary_search_books tool.
 * @module tests/tools/openlibrary-search-books-edge.tool.test
 */

import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
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

describe('openlibrarySearchBooks — edge cases and security', () => {
  beforeEach(() => {
    initOpenLibraryService();
  });

  // ─── Input validation ───────────────────────────────────────────────────────

  it('rejects limit below 1', () => {
    expect(() => openlibrarySearchBooks.input.parse({ query: 'test', limit: 0 })).toThrow();
  });

  it('rejects limit above 100', () => {
    expect(() => openlibrarySearchBooks.input.parse({ query: 'test', limit: 101 })).toThrow();
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
    // Single bare query produces no queryEcho (only multi-filter does)
    expect(enrichment.queryEcho).toBeUndefined();
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
    expect(enrichment.queryEcho).toBeDefined();
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
