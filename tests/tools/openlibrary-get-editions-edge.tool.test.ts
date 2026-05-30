/**
 * @fileoverview Edge case and input validation tests for the openlibrary_get_editions tool.
 * @module tests/tools/openlibrary-get-editions-edge.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { openlibraryGetEditions } from '@/mcp-server/tools/definitions/openlibrary-get-editions.tool.js';
import { initOpenLibraryService } from '@/services/open-library/open-library-service.js';

describe('openlibraryGetEditions — edge cases', () => {
  beforeEach(() => {
    initOpenLibraryService();
  });

  // ─── Input validation ───────────────────────────────────────────────────────

  it('rejects limit below 1', () => {
    expect(() => openlibraryGetEditions.input.parse({ work_id: 'OL45804W', limit: 0 })).toThrow();
  });

  it('rejects limit above 100', () => {
    expect(() => openlibraryGetEditions.input.parse({ work_id: 'OL45804W', limit: 101 })).toThrow();
  });

  it('rejects negative offset', () => {
    expect(() => openlibraryGetEditions.input.parse({ work_id: 'OL45804W', offset: -1 })).toThrow();
  });

  it('rejects non-integer limit', () => {
    expect(() => openlibraryGetEditions.input.parse({ work_id: 'OL45804W', limit: 5.5 })).toThrow();
  });

  // ─── Pagination boundary values ─────────────────────────────────────────────

  it('accepts limit 1 (minimum)', () => {
    const input = openlibraryGetEditions.input.parse({ work_id: 'OL45804W', limit: 1 });
    expect(input.limit).toBe(1);
  });

  it('accepts limit 100 (maximum)', () => {
    const input = openlibraryGetEditions.input.parse({ work_id: 'OL45804W', limit: 100 });
    expect(input.limit).toBe(100);
  });

  it('accepts large offset', () => {
    const input = openlibraryGetEditions.input.parse({ work_id: 'OL45804W', offset: 500 });
    expect(input.offset).toBe(500);
  });

  // ─── Empty editions result ──────────────────────────────────────────────────

  it('handles zero editions returned', async () => {
    const ctx = createMockContext({ errors: openlibraryGetEditions.errors });
    const svc = (
      await import('@/services/open-library/open-library-service.js')
    ).getOpenLibraryService();
    vi.spyOn(svc, 'getEditions').mockResolvedValueOnce({
      total: 0,
      work_id: 'OL45804W',
      editions: [],
    });

    const input = openlibraryGetEditions.input.parse({ work_id: 'OL45804W' });
    const result = await openlibraryGetEditions.handler(input, ctx);

    expect(result.total).toBe(0);
    expect(result.editions).toHaveLength(0);
  });

  // ─── Format edge cases ──────────────────────────────────────────────────────

  it('formats edition with all language codes', () => {
    const result = {
      total: 1,
      work_id: 'OL45804W',
      editions: [
        {
          edition_id: 'OL1M',
          title: 'Multi-lang Edition',
          publishers: ['Gallimard'],
          languages: ['fre', 'eng'],
          isbn_10: [],
          isbn_13: [],
          cover_ids: [],
        },
      ],
    };
    const text = (openlibraryGetEditions.format!(result)[0] as { text: string }).text;
    expect(text).toContain('fre');
    expect(text).toContain('eng');
  });

  it('format does not emit undefined or null strings for sparse editions', () => {
    const result = {
      total: 1,
      work_id: 'OL1W',
      editions: [
        {
          edition_id: 'OL1M',
          title: 'Minimal',
          publishers: [],
          languages: [],
          isbn_10: [],
          isbn_13: [],
          cover_ids: [],
        },
      ],
    };
    const text = (openlibraryGetEditions.format!(result)[0] as { text: string }).text;
    expect(text).not.toContain('undefined');
    expect(text).not.toContain('null');
  });

  it('formats empty editions list correctly', () => {
    const result = { total: 200, work_id: 'OL45804W', editions: [] };
    const text = (openlibraryGetEditions.format!(result)[0] as { text: string }).text;
    expect(text).toContain('200');
    expect(text).toContain('Returned:** 0');
  });

  // ─── Service call arguments ─────────────────────────────────────────────────

  it('forwards limit and offset to service', async () => {
    const ctx = createMockContext({ errors: openlibraryGetEditions.errors });
    const svc = (
      await import('@/services/open-library/open-library-service.js')
    ).getOpenLibraryService();
    const spy = vi.spyOn(svc, 'getEditions').mockResolvedValueOnce({
      total: 0,
      work_id: 'OL45804W',
      editions: [],
    });

    const input = openlibraryGetEditions.input.parse({
      work_id: 'OL45804W',
      limit: 50,
      offset: 100,
    });
    await openlibraryGetEditions.handler(input, ctx);
    expect(spy).toHaveBeenCalledWith('OL45804W', 50, 100, ctx);
  });
});
