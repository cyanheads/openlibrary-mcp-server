/**
 * @fileoverview Tests for the openlibrary_search_authors tool.
 * @module tests/tools/openlibrary-search-authors.tool.test
 */

import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { openlibrarySearchAuthors } from '@/mcp-server/tools/definitions/openlibrary-search-authors.tool.js';
import { initOpenLibraryService } from '@/services/open-library/open-library-service.js';

const MOCK_AUTHOR = {
  author_id: 'OL24638A',
  name: 'F. Scott Fitzgerald',
  alternate_names: ['Francis Scott Key Fitzgerald'],
  birth_date: 'September 24, 1896',
  death_date: 'December 21, 1940',
  top_work: 'The Great Gatsby',
  work_count: 7,
  top_subjects: ['Fiction', 'American literature'],
  ratings_average: 3.9,
};

describe('openlibrarySearchAuthors', () => {
  beforeEach(() => {
    initOpenLibraryService();
  });

  it('returns authors for a matching query', async () => {
    const ctx = createMockContext({ errors: openlibrarySearchAuthors.errors });
    const svc = (
      await import('@/services/open-library/open-library-service.js')
    ).getOpenLibraryService();
    vi.spyOn(svc, 'searchAuthors').mockResolvedValueOnce({
      total: 1,
      authors: [MOCK_AUTHOR],
    });

    const input = openlibrarySearchAuthors.input.parse({ query: 'fitzgerald' });
    const result = await openlibrarySearchAuthors.handler(input, ctx);

    expect(result.total).toBe(1);
    expect(result.authors).toHaveLength(1);
    expect(result.authors[0]!.author_id).toBe('OL24638A');
    expect(result.authors[0]!.name).toBe('F. Scott Fitzgerald');

    const enrichment = getEnrichment(ctx);
    expect(enrichment.notice).toBeUndefined();
  });

  it('returns empty authors with notice enrichment when no results', async () => {
    const ctx = createMockContext({ errors: openlibrarySearchAuthors.errors });
    const svc = (
      await import('@/services/open-library/open-library-service.js')
    ).getOpenLibraryService();
    vi.spyOn(svc, 'searchAuthors').mockResolvedValueOnce({ total: 0, authors: [] });

    const input = openlibrarySearchAuthors.input.parse({ query: 'xyzzy99nonexistent' });
    const result = await openlibrarySearchAuthors.handler(input, ctx);

    expect(result.total).toBe(0);
    expect(result.authors).toHaveLength(0);
    // message is gone from output; notice lives in enrichment
    expect((result as Record<string, unknown>).message).toBeUndefined();

    const enrichment = getEnrichment(ctx);
    expect(enrichment.notice).toBeDefined();
    expect(enrichment.notice).toContain('xyzzy99nonexistent');
    expect(enrichment.notice).not.toContain('past the end');
  });

  it('keeps the upstream total and names the offset problem on an over-paged page', async () => {
    const ctx = createMockContext({ errors: openlibrarySearchAuthors.errors });
    const svc = (
      await import('@/services/open-library/open-library-service.js')
    ).getOpenLibraryService();

    // Upstream matched 4304 authors; offset 9999 lands past the end.
    vi.spyOn(svc, 'searchAuthors').mockResolvedValueOnce({ total: 4304, authors: [] });

    const input = openlibrarySearchAuthors.input.parse({
      query: 'gibson',
      limit: 2,
      offset: 9999,
    });
    const result = await openlibrarySearchAuthors.handler(input, ctx);

    expect(result.total).toBe(4304);
    // The offset that produced the empty page is on the record.
    expect(result.offset).toBe(9999);
    expect(result.authors).toEqual([]);

    const enrichment = getEnrichment(ctx);
    expect(enrichment.totalCount).toBe(4304);
    expect(enrichment.notice).toContain('9999');
    expect(enrichment.notice).toContain('past the end');
    expect(enrichment.notice).toContain('4303');
    expect(enrichment.notice).not.toContain('check spelling');
  });

  it('echoes the requested offset on a populated page', async () => {
    const ctx = createMockContext({ errors: openlibrarySearchAuthors.errors });
    const svc = (
      await import('@/services/open-library/open-library-service.js')
    ).getOpenLibraryService();
    vi.spyOn(svc, 'searchAuthors').mockResolvedValueOnce({
      total: 42,
      authors: [MOCK_AUTHOR],
    });

    const input = openlibrarySearchAuthors.input.parse({ query: 'tolkien', offset: 10 });
    const result = await openlibrarySearchAuthors.handler(input, ctx);

    expect(result.offset).toBe(10);
    expect(result.total).toBe(42);
  });

  it('applies default limit and offset', () => {
    const input = openlibrarySearchAuthors.input.parse({ query: 'tolkien' });
    expect(input.limit).toBe(10);
    expect(input.offset).toBe(0);
  });

  it('formats authors with all key fields', () => {
    const output = { total: 1, offset: 0, authors: [MOCK_AUTHOR] };
    const blocks = openlibrarySearchAuthors.format!(output);
    const text = (blocks[0] as { text: string }).text;

    expect(text).toContain('OL24638A');
    expect(text).toContain('F. Scott Fitzgerald');
    expect(text).toContain('1896');
    expect(text).toContain('1940');
    expect(text).toContain('The Great Gatsby');
    expect(text).toContain('Francis Scott Key Fitzgerald');
    expect(text).toContain('Fiction');
    expect(text).toContain('3.9');
  });

  it('formats sparse author (no optional fields)', () => {
    const sparse = {
      author_id: 'OL1A',
      name: 'Anonymous',
      alternate_names: [],
      work_count: 0,
      top_subjects: [],
    };
    const output = { total: 1, offset: 0, authors: [sparse] };
    const text = (openlibrarySearchAuthors.format!(output)[0] as { text: string }).text;
    expect(text).toContain('OL1A');
    expect(text).toContain('Anonymous');
  });
});
