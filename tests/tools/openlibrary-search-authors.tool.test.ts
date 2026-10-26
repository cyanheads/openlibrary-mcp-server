/**
 * @fileoverview Tests for the openlibrary_search_authors tool.
 * @module tests/tools/openlibrary-search-authors.tool.test
 */

import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
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

  it('characterizes a populated page without changing totals or offset', async () => {
    const svc = (
      await import('@/services/open-library/open-library-service.js')
    ).getOpenLibraryService();
    vi.spyOn(svc, 'searchAuthors').mockResolvedValueOnce({ total: 300, authors: [MOCK_AUTHOR] });
    const ctx = createMockContext({ errors: openlibrarySearchAuthors.errors });
    const result = await openlibrarySearchAuthors.handler(
      openlibrarySearchAuthors.input.parse({ query: 'name', limit: 100, offset: 20 }),
      ctx,
    );
    expect(result).toEqual({ total: 300, offset: 20, authors: [MOCK_AUTHOR] });
    expect(getEnrichment(ctx)).toEqual({ totalCount: 300 });
  });

  it('clamps a large page before calling upstream and composes an empty-page notice', async () => {
    const svc = (
      await import('@/services/open-library/open-library-service.js')
    ).getOpenLibraryService();
    const spy = vi.spyOn(svc, 'searchAuthors').mockResolvedValueOnce({ total: 3, authors: [] });
    const ctx = createMockContext({ errors: openlibrarySearchAuthors.errors });
    const result = await openlibrarySearchAuthors.handler(
      openlibrarySearchAuthors.input.parse({ query: 'name', limit: 101, offset: 20 }),
      ctx,
    );
    expect(spy).toHaveBeenCalledExactlyOnceWith('name', 100, 20, ctx);
    expect(result).toEqual({ total: 3, offset: 20, authors: [] });
    expect(getEnrichment(ctx).notice).toContain('past the end');
    expect(getEnrichment(ctx).notice).toContain('Requested limit 101');
    expect(getEnrichment(ctx).notice).toContain('Next offset: 20');
  });

  it('renders all subjects, exact ratings, optional empty values, and literal Markdown', () => {
    const author = {
      ...MOCK_AUTHOR,
      name: '*Name*',
      birth_date: '',
      death_date: '',
      top_work: '',
      ratings_average: 3.912345,
      top_subjects: ['a', 'b', 'c', 'd', 'e', 'last*subject'],
    };
    const text = (
      openlibrarySearchAuthors.format!({ total: 1, offset: 0, authors: [author] })[0] as {
        text: string;
      }
    ).text;
    expect(text).toContain('last\\*subject');
    expect(text).toContain('3.912345');
    expect(text).toContain('Born: ');
    expect(text).toContain('Died: ');
    expect(text).toContain('**Top work:** ');
    expect(text).toContain('\\*Name\\*');
  });

  it('returns a clamped populated page and its continuation on both surfaces', async () => {
    const svc = (
      await import('@/services/open-library/open-library-service.js')
    ).getOpenLibraryService();
    const spy = vi
      .spyOn(svc, 'searchAuthors')
      .mockResolvedValueOnce({ total: 300, authors: [MOCK_AUTHOR] });
    const result = await runToolContract(openlibrarySearchAuthors, {
      query: 'name',
      limit: 250,
      offset: 40,
    });
    expect(result.isError).toBeFalsy();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]?.slice(0, 3)).toEqual(['name', 100, 40]);
    expect(result.structuredContent).toMatchObject({
      total: 300,
      offset: 40,
      authors: [MOCK_AUTHOR],
      notice: 'Requested limit 250; applied limit 100. Next offset: 41.',
    });
    const text = result.content
      .flatMap((block) => (block.type === 'text' ? [block.text] : []))
      .join('\n');
    expect(text).toContain('Requested limit 250; applied limit 100. Next offset: 41.');
    expect(text).toContain('F. Scott Fitzgerald');
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
    expect(text).toContain('**Alternate names:** []');
    expect(text).toContain('**Top subjects:** []');
  });
});
