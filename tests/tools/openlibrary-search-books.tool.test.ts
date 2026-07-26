/**
 * @fileoverview Tests for the openlibrary_search_books tool.
 * @module tests/tools/openlibrary-search-books.tool.test
 */

import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { openlibrarySearchBooks } from '@/mcp-server/tools/definitions/openlibrary-search-books.tool.js';
import { initOpenLibraryService } from '@/services/open-library/open-library-service.js';

/** Builds a minimal work fixture for use in tests. */
function makeWork(
  overrides?: Partial<Parameters<typeof openlibrarySearchBooks.format>[0]['works'][0]>,
) {
  return {
    work_id: 'OL45804W',
    title: 'The Great Gatsby',
    author_names: ['F. Scott Fitzgerald'],
    author_ids: ['OL24638A'],
    first_publish_year: 1925,
    edition_count: 42,
    cover_id: 123456,
    subjects: ['Fiction', 'American literature'],
    ebook_access: 'borrowable' as const,
    has_fulltext: true,
    ratings_average: 3.9,
    ia_identifiers: ['greatsgatsby00fitz'],
    ...overrides,
  };
}

describe('openlibrarySearchBooks', () => {
  beforeEach(() => {
    initOpenLibraryService();
  });

  it('returns empty works with notice enrichment when no results', async () => {
    const ctx = createMockContext({ errors: openlibrarySearchBooks.errors });

    // Stub the service to return empty results
    const svc = (
      await import('@/services/open-library/open-library-service.js')
    ).getOpenLibraryService();
    vi.spyOn(svc, 'searchBooks').mockResolvedValueOnce({
      total: 0,
      offset: 0,
      works: [],
    });

    const input = openlibrarySearchBooks.input.parse({ query: 'xyzzy12345nonexistent', limit: 10 });
    const result = await openlibrarySearchBooks.handler(input, ctx);

    expect(result.total).toBe(0);
    expect(result.works).toHaveLength(0);
    // message is gone from output; notice lives in enrichment
    expect((result as Record<string, unknown>).message).toBeUndefined();

    const enrichment = getEnrichment(ctx);
    expect(enrichment.notice).toBeDefined();
    expect(enrichment.notice).toContain('xyzzy12345nonexistent');
  });

  it('returns works when search succeeds', async () => {
    const ctx = createMockContext({ errors: openlibrarySearchBooks.errors });
    const svc = (
      await import('@/services/open-library/open-library-service.js')
    ).getOpenLibraryService();

    const mockWork = makeWork();
    vi.spyOn(svc, 'searchBooks').mockResolvedValueOnce({
      total: 1,
      offset: 0,
      works: [mockWork],
    });

    const input = openlibrarySearchBooks.input.parse({ query: 'gatsby', limit: 10 });
    const result = await openlibrarySearchBooks.handler(input, ctx);

    expect(result.total).toBe(1);
    expect(result.works).toHaveLength(1);
    expect(result.works[0]!.work_id).toBe('OL45804W');

    const enrichment = getEnrichment(ctx);
    expect(enrichment.notice).toBeUndefined();
  });

  it('populates queryEcho enrichment for multi-filter search', async () => {
    const ctx = createMockContext({ errors: openlibrarySearchBooks.errors });
    const svc = (
      await import('@/services/open-library/open-library-service.js')
    ).getOpenLibraryService();

    const mockWork = makeWork();
    vi.spyOn(svc, 'searchBooks').mockResolvedValueOnce({
      total: 1,
      offset: 0,
      works: [mockWork],
    });

    const input = openlibrarySearchBooks.input.parse({
      query: 'gatsby',
      author: 'fitzgerald',
      limit: 10,
    });
    await openlibrarySearchBooks.handler(input, ctx);

    const enrichment = getEnrichment(ctx);
    expect(enrichment.queryEcho).toBeDefined();
    expect(enrichment.queryEcho).toContain('gatsby');
    expect(enrichment.queryEcho).toContain('fitzgerald');
  });

  it('formats output with all key fields', () => {
    const work = makeWork();
    const output = { total: 1, offset: 0, works: [work] };
    const blocks = openlibrarySearchBooks.format!(output);

    expect(blocks.some((b) => b.type === 'text')).toBe(true);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('OL45804W');
    expect(text).toContain('The Great Gatsby');
    expect(text).toContain('OL24638A');
    expect(text).toContain('1925');
    expect(text).toContain('42');
    expect(text).toContain('123456');
    expect(text).toContain('greatsgatsby00fitz');
  });

  it('formats availability when present', () => {
    const work = makeWork({
      availability: {
        status: 'borrow_available',
        available_to_browse: true,
        available_to_borrow: true,
        available_to_waitlist: false,
        is_readable: false,
        is_lendable: true,
        is_previewable: true,
        is_restricted: false,
        openlibrary_edition: 'OL61057835M',
      },
    });
    const output = { total: 1, offset: 0, works: [work] };
    const text = (openlibrarySearchBooks.format!(output)[0] as { text: string }).text;

    expect(text).toContain('borrow_available');
    expect(text).toContain('OL61057835M');
  });

  it('formats null availability as no IA item message', () => {
    const work = makeWork({ availability: null });
    const output = { total: 1, offset: 0, works: [work] };
    const text = (openlibrarySearchBooks.format!(output)[0] as { text: string }).text;

    expect(text).toContain('No Internet Archive item found');
  });

  it('handles sparse work (no optional fields)', () => {
    const sparse = {
      work_id: 'OL1W',
      title: 'Sparse Work',
      author_names: [],
      author_ids: [],
      edition_count: 0,
      ebook_access: 'no_ebook' as const,
      has_fulltext: false,
      ia_identifiers: [],
    };
    const output = { total: 1, offset: 0, works: [sparse] };
    const blocks = openlibrarySearchBooks.format!(output);

    expect(blocks.some((b) => b.type === 'text')).toBe(true);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('OL1W');
    expect(text).toContain('no_ebook');
  });

  it('applies default sort and limit', () => {
    const input = openlibrarySearchBooks.input.parse({ query: 'tolkien' });
    expect(input.sort).toBe('relevance');
    expect(input.limit).toBe(10);
    expect(input.offset).toBe(0);
    expect(input.include_availability).toBe(false);
  });

  // ─── IA-identifier text capping (#11) ────────────────────────────────────────

  it('caps IA identifiers in text but keeps the full array in structuredContent', async () => {
    const ctx = createMockContext({ errors: openlibrarySearchBooks.errors });
    const svc = (
      await import('@/services/open-library/open-library-service.js')
    ).getOpenLibraryService();

    // Zero-padded so no id is a substring prefix of another (e.g. ia-004 vs ia-047).
    const iaIds = Array.from({ length: 48 }, (_, i) => `ia-${String(i).padStart(3, '0')}`);
    vi.spyOn(svc, 'searchBooks').mockResolvedValueOnce({
      total: 1,
      offset: 0,
      works: [makeWork({ ia_identifiers: iaIds })],
    });

    const input = openlibrarySearchBooks.input.parse({ query: 'gatsby', limit: 1 });
    const result = await openlibrarySearchBooks.handler(input, ctx);

    // structuredContent (the handler return) keeps every identifier.
    expect(result.works[0]!.ia_identifiers).toHaveLength(48);

    // The enrichment trailer discloses the true total and how many the text shows.
    const enrichment = getEnrichment(ctx);
    expect(enrichment.notice).toContain('Internet Archive');
    expect(enrichment.notice).toContain('showing 5 of 48');
    expect(enrichment.notice).toContain('structuredContent');

    // The text renders only the first 5 (IA_TEXT_CAP) identifiers.
    const text = (openlibrarySearchBooks.format!(result)[0] as { text: string }).text;
    expect(text).toContain('ia-004');
    expect(text).not.toContain('ia-005');
    expect(text).not.toContain('ia-047');
  });

  it('does not disclose IA capping when a work has no identifiers', async () => {
    const ctx = createMockContext({ errors: openlibrarySearchBooks.errors });
    const svc = (
      await import('@/services/open-library/open-library-service.js')
    ).getOpenLibraryService();

    vi.spyOn(svc, 'searchBooks').mockResolvedValueOnce({
      total: 1,
      offset: 0,
      works: [makeWork({ ia_identifiers: [] })],
    });

    const input = openlibrarySearchBooks.input.parse({ query: 'gatsby', limit: 1 });
    const result = await openlibrarySearchBooks.handler(input, ctx);

    expect(getEnrichment(ctx).notice).toBeUndefined();
    const text = (openlibrarySearchBooks.format!(result)[0] as { text: string }).text;
    expect(text).not.toContain('**IA:**');
  });

  // ─── Over-paged results (offset past the end) ───────────────────────────────

  it('keeps the upstream total and names the offset problem on an over-paged page', async () => {
    const ctx = createMockContext({ errors: openlibrarySearchBooks.errors });
    const svc = (
      await import('@/services/open-library/open-library-service.js')
    ).getOpenLibraryService();

    // Upstream matched 19 works; offset 500 lands past the end, so the page is
    // empty while the match count stays nonzero.
    vi.spyOn(svc, 'searchBooks').mockResolvedValueOnce({
      total: 19,
      offset: 500,
      works: [],
    });

    const input = openlibrarySearchBooks.input.parse({
      query: 'Neuromancer William Gibson',
      limit: 2,
      offset: 500,
    });
    const result = await openlibrarySearchBooks.handler(input, ctx);

    expect(result.total).toBe(19);
    expect(result.offset).toBe(500);
    expect(result.works).toEqual([]);

    const enrichment = getEnrichment(ctx);
    expect(enrichment.totalCount).toBe(19);
    // The correction is a lower offset, not a different query.
    expect(enrichment.notice).toContain('500');
    expect(enrichment.notice).toContain('past the end');
    expect(enrichment.notice).toContain('18');
    expect(enrichment.notice).not.toContain('broader');
    expect(enrichment.notice).not.toContain('No works matched');
  });

  it('keeps the broaden guidance when nothing matched at all', async () => {
    const ctx = createMockContext({ errors: openlibrarySearchBooks.errors });
    const svc = (
      await import('@/services/open-library/open-library-service.js')
    ).getOpenLibraryService();

    vi.spyOn(svc, 'searchBooks').mockResolvedValueOnce({ total: 0, offset: 0, works: [] });

    const input = openlibrarySearchBooks.input.parse({ query: 'xyzzy12345nonexistent' });
    const result = await openlibrarySearchBooks.handler(input, ctx);

    expect(result.total).toBe(0);
    const enrichment = getEnrichment(ctx);
    expect(enrichment.notice).toContain('No works matched');
    expect(enrichment.notice).toContain('broader');
    expect(enrichment.notice).not.toContain('past the end');
  });

  // ─── Subject cap: complete in structuredContent, capped in text, disclosed ──

  it('keeps every subject in structuredContent and discloses the text cap', async () => {
    const ctx = createMockContext({ errors: openlibrarySearchBooks.errors });
    const svc = (
      await import('@/services/open-library/open-library-service.js')
    ).getOpenLibraryService();

    // Zero-padded so no tag is a substring prefix of another.
    const subjects = Array.from({ length: 15 }, (_, i) => `subj-${String(i).padStart(3, '0')}`);
    vi.spyOn(svc, 'searchBooks').mockResolvedValueOnce({
      total: 1,
      offset: 0,
      works: [makeWork({ subjects, ia_identifiers: [] })],
    });

    const input = openlibrarySearchBooks.input.parse({ query: 'dune', limit: 1 });
    const result = await openlibrarySearchBooks.handler(input, ctx);

    expect(result.works[0]!.subjects).toEqual(subjects);

    const enrichment = getEnrichment(ctx);
    expect(enrichment.notice).toContain('Subjects are capped at 5');
    expect(enrichment.notice).toContain('showing 5 of 15');
    expect(enrichment.notice).toContain('works[].subjects');

    const text = (openlibrarySearchBooks.format!(result)[0] as { text: string }).text;
    expect(text).toContain('subj-004');
    expect(text).not.toContain('subj-005');
    expect(text).not.toContain('subj-014');
  });

  it('composes both cap disclosures into one notice when subjects and IA ids overflow', async () => {
    const ctx = createMockContext({ errors: openlibrarySearchBooks.errors });
    const svc = (
      await import('@/services/open-library/open-library-service.js')
    ).getOpenLibraryService();

    vi.spyOn(svc, 'searchBooks').mockResolvedValueOnce({
      total: 1,
      offset: 0,
      works: [
        makeWork({
          subjects: Array.from({ length: 12 }, (_, i) => `s${i}`),
          ia_identifiers: Array.from({ length: 9 }, (_, i) => `ia${i}`),
        }),
      ],
    });

    const input = openlibrarySearchBooks.input.parse({ query: 'dune', limit: 1 });
    await openlibrarySearchBooks.handler(input, ctx);

    // `ctx.enrich.notice` is last-wins, so a second call would erase the first —
    // both disclosures have to arrive in a single notice string.
    const notice = getEnrichment(ctx).notice as string;
    expect(notice).toContain('Internet Archive identifiers are capped at 5');
    expect(notice).toContain('showing 5 of 9');
    expect(notice).toContain('Subjects are capped at 5');
    expect(notice).toContain('showing 5 of 12');
  });

  it('does not disclose a subject cap when no work exceeds it', async () => {
    const ctx = createMockContext({ errors: openlibrarySearchBooks.errors });
    const svc = (
      await import('@/services/open-library/open-library-service.js')
    ).getOpenLibraryService();

    vi.spyOn(svc, 'searchBooks').mockResolvedValueOnce({
      total: 1,
      offset: 0,
      works: [makeWork({ subjects: ['Fiction', 'American literature'], ia_identifiers: [] })],
    });

    const input = openlibrarySearchBooks.input.parse({ query: 'gatsby', limit: 1 });
    await openlibrarySearchBooks.handler(input, ctx);

    expect(getEnrichment(ctx).notice).toBeUndefined();
  });
});
