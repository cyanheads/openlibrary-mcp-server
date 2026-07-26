/**
 * @fileoverview Tests for the openlibrary_get_author_works tool.
 * @module tests/tools/openlibrary-get-author-works.tool.test
 */

import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { openlibraryGetAuthorWorks } from '@/mcp-server/tools/definitions/openlibrary-get-author-works.tool.js';
import { initOpenLibraryService } from '@/services/open-library/open-library-service.js';

const MOCK_WORK = {
  work_id: 'OL45804W',
  title: 'The Great Gatsby',
  first_publish_date: '1925',
  cover_ids: [9255566],
};

const MOCK_AUTHOR_WORKS_RESULT = {
  total: 7,
  author_id: 'OL24638A',
  works: [MOCK_WORK],
};

describe('openlibraryGetAuthorWorks', () => {
  beforeEach(() => {
    initOpenLibraryService();
  });

  it('returns works for valid author_id', async () => {
    const ctx = createMockContext();
    const svc = (
      await import('@/services/open-library/open-library-service.js')
    ).getOpenLibraryService();
    vi.spyOn(svc, 'getAuthorWorks').mockResolvedValueOnce(MOCK_AUTHOR_WORKS_RESULT);

    const input = openlibraryGetAuthorWorks.input.parse({ author_id: 'OL24638A' });
    const result = await openlibraryGetAuthorWorks.handler(input, ctx);

    expect(result.author_id).toBe('OL24638A');
    expect(result.total).toBe(7);
    expect(result.works).toHaveLength(1);
    expect(result.works[0]!.work_id).toBe('OL45804W');
    expect(result.works[0]!.title).toBe('The Great Gatsby');
  });

  it('forwards author_id and pagination to service', async () => {
    const ctx = createMockContext();
    const svc = (
      await import('@/services/open-library/open-library-service.js')
    ).getOpenLibraryService();
    const spy = vi.spyOn(svc, 'getAuthorWorks').mockResolvedValueOnce({
      total: 0,
      author_id: 'OL24638A',
      works: [],
    });

    const input = openlibraryGetAuthorWorks.input.parse({
      author_id: 'OL24638A',
      limit: 5,
      offset: 10,
    });
    await openlibraryGetAuthorWorks.handler(input, ctx);

    expect(spy).toHaveBeenCalledWith('OL24638A', 5, 10, ctx);
  });

  it('propagates service errors', async () => {
    const ctx = createMockContext();
    const svc = (
      await import('@/services/open-library/open-library-service.js')
    ).getOpenLibraryService();
    vi.spyOn(svc, 'getAuthorWorks').mockRejectedValueOnce(new Error('Author not found'));

    const input = openlibraryGetAuthorWorks.input.parse({ author_id: 'OL99999A' });
    await expect(openlibraryGetAuthorWorks.handler(input, ctx)).rejects.toThrow('Author not found');
  });

  // `format()` receives only the domain payload, never the input, so it cannot
  // see that the works came back under a different ID than was requested. The
  // handler's enrichment notice is the only place to disclose it.
  it('discloses a merged-ID substitution through the enrichment notice', async () => {
    const ctx = createMockContext();
    const svc = (
      await import('@/services/open-library/open-library-service.js')
    ).getOpenLibraryService();
    vi.spyOn(svc, 'getAuthorWorks').mockResolvedValueOnce({
      total: 2,
      author_id: 'OL19981A',
      works: [MOCK_WORK],
    });

    const input = openlibraryGetAuthorWorks.input.parse({ author_id: 'OL2162284A' });
    await openlibraryGetAuthorWorks.handler(input, ctx);

    const notice = getEnrichment(ctx).notice as string;
    expect(notice).toContain('OL2162284A');
    expect(notice).toContain('OL19981A');
  });

  it('adds no notice when the works came back under the requested ID', async () => {
    const ctx = createMockContext();
    const svc = (
      await import('@/services/open-library/open-library-service.js')
    ).getOpenLibraryService();
    vi.spyOn(svc, 'getAuthorWorks').mockResolvedValueOnce(MOCK_AUTHOR_WORKS_RESULT);

    const input = openlibraryGetAuthorWorks.input.parse({ author_id: 'OL24638A' });
    await openlibraryGetAuthorWorks.handler(input, ctx);

    // An unguarded enrich call would key `notice` to undefined and render a
    // literal "undefined" line on every ordinary lookup.
    expect(getEnrichment(ctx)).not.toHaveProperty('notice');
    // The total must still be disclosed either way.
    expect(getEnrichment(ctx).totalCount).toBe(7);
  });

  it('applies default limit and offset', () => {
    const input = openlibraryGetAuthorWorks.input.parse({ author_id: 'OL24638A' });
    expect(input.limit).toBe(20);
    expect(input.offset).toBe(0);
  });

  it('formats works with all key fields', () => {
    const blocks = openlibraryGetAuthorWorks.format!(MOCK_AUTHOR_WORKS_RESULT);
    const text = (blocks[0] as { text: string }).text;

    expect(text).toContain('OL24638A');
    expect(text).toContain('7');
    expect(text).toContain('OL45804W');
    expect(text).toContain('The Great Gatsby');
    expect(text).toContain('1925');
    expect(text).toContain('9255566');
  });

  it('formats sparse work (no optional fields)', () => {
    const sparse = {
      total: 1,
      author_id: 'OL1A',
      works: [
        {
          work_id: 'OL1W',
          title: 'Sparse Work',
          cover_ids: [],
        },
      ],
    };
    const text = (openlibraryGetAuthorWorks.format!(sparse)[0] as { text: string }).text;
    expect(text).toContain('OL1W');
    expect(text).toContain('Sparse Work');
  });
});
