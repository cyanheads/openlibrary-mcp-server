/**
 * @fileoverview Edge case and input validation tests for openlibrary_get_author_works.
 * @module tests/tools/openlibrary-get-author-works-edge.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { openlibraryGetAuthorWorks } from '@/mcp-server/tools/definitions/openlibrary-get-author-works.tool.js';
import { initOpenLibraryService } from '@/services/open-library/open-library-service.js';

describe('openlibraryGetAuthorWorks — edge cases', () => {
  beforeEach(() => {
    initOpenLibraryService();
  });

  // ─── Input validation ───────────────────────────────────────────────────────

  it('rejects limit below 1', () => {
    expect(() =>
      openlibraryGetAuthorWorks.input.parse({ author_id: 'OL24638A', limit: 0 }),
    ).toThrow();
  });

  it('rejects limit above 100', () => {
    expect(() =>
      openlibraryGetAuthorWorks.input.parse({ author_id: 'OL24638A', limit: 101 }),
    ).toThrow();
  });

  it('rejects negative offset', () => {
    expect(() =>
      openlibraryGetAuthorWorks.input.parse({ author_id: 'OL24638A', offset: -1 }),
    ).toThrow();
  });

  // ─── Pagination boundaries ──────────────────────────────────────────────────

  it('accepts limit 1 (minimum)', () => {
    const input = openlibraryGetAuthorWorks.input.parse({ author_id: 'OL24638A', limit: 1 });
    expect(input.limit).toBe(1);
  });

  it('accepts limit 100 (maximum)', () => {
    const input = openlibraryGetAuthorWorks.input.parse({ author_id: 'OL24638A', limit: 100 });
    expect(input.limit).toBe(100);
  });

  // ─── Not found error contract ────────────────────────────────────────────────

  it('propagates not_found with JsonRpcErrorCode.NotFound', async () => {
    const ctx = createMockContext({ errors: openlibraryGetAuthorWorks.errors });
    const svc = (
      await import('@/services/open-library/open-library-service.js')
    ).getOpenLibraryService();
    vi.spyOn(svc, 'getAuthorWorks').mockRejectedValueOnce({
      code: JsonRpcErrorCode.NotFound,
      message: 'Author not found',
    });

    const input = openlibraryGetAuthorWorks.input.parse({ author_id: 'OL999999A' });
    await expect(openlibraryGetAuthorWorks.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
    });
  });

  // ─── Empty works list ────────────────────────────────────────────────────────

  it('handles author with zero works', async () => {
    const ctx = createMockContext();
    const svc = (
      await import('@/services/open-library/open-library-service.js')
    ).getOpenLibraryService();
    vi.spyOn(svc, 'getAuthorWorks').mockResolvedValueOnce({
      total: 0,
      author_id: 'OL24638A',
      works: [],
    });

    const input = openlibraryGetAuthorWorks.input.parse({ author_id: 'OL24638A' });
    const result = await openlibraryGetAuthorWorks.handler(input, ctx);

    expect(result.total).toBe(0);
    expect(result.works).toHaveLength(0);
  });

  // ─── Prefix stripping in author_id ──────────────────────────────────────────

  it('passes /authors/ prefix to service unchanged (service strips it)', async () => {
    const ctx = createMockContext();
    const svc = (
      await import('@/services/open-library/open-library-service.js')
    ).getOpenLibraryService();
    const spy = vi.spyOn(svc, 'getAuthorWorks').mockResolvedValueOnce({
      total: 1,
      author_id: 'OL24638A',
      works: [],
    });

    const input = openlibraryGetAuthorWorks.input.parse({
      author_id: '/authors/OL24638A',
    });
    await openlibraryGetAuthorWorks.handler(input, ctx);

    // Handler passes to service as-is; service strips the prefix
    expect(spy).toHaveBeenCalledWith(
      '/authors/OL24638A',
      expect.any(Number),
      expect.any(Number),
      ctx,
    );
  });

  // ─── Format completeness ─────────────────────────────────────────────────────

  it('format does not emit undefined or null literals', () => {
    const result = {
      total: 1,
      author_id: 'OL24638A',
      works: [
        {
          work_id: 'OL1W',
          title: 'Minimal Work',
          cover_ids: [],
          // first_publish_date absent
        },
      ],
    };
    const text = (openlibraryGetAuthorWorks.format!(result)[0] as { text: string }).text;
    expect(text).not.toContain('undefined');
    expect(text).not.toContain('null');
  });

  it('formats works with multiple cover IDs', () => {
    const result = {
      total: 1,
      author_id: 'OL1A',
      works: [
        {
          work_id: 'OL1W',
          title: 'Multi-cover Work',
          cover_ids: [111, 222, 333],
        },
      ],
    };
    const text = (openlibraryGetAuthorWorks.format!(result)[0] as { text: string }).text;
    expect(text).toContain('111');
    expect(text).toContain('222');
    expect(text).toContain('333');
  });
});
