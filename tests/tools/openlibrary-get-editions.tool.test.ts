/**
 * @fileoverview Tests for the openlibrary_get_editions tool.
 * @module tests/tools/openlibrary-get-editions.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { openlibraryGetEditions } from '@/mcp-server/tools/definitions/openlibrary-get-editions.tool.js';
import { initOpenLibraryService } from '@/services/open-library/open-library-service.js';

const MOCK_EDITION = {
  edition_id: 'OL7353617M',
  title: 'The Great Gatsby',
  publish_date: '1953',
  publishers: ['Scribner'],
  languages: ['eng'],
  isbn_10: ['0743273567'],
  isbn_13: ['9780743273565'],
  page_count: 180,
  cover_ids: [9255566],
  work_id: 'OL45804W',
};

const MOCK_EDITIONS_RESULT = {
  total: 42,
  work_id: 'OL45804W',
  editions: [MOCK_EDITION],
};

describe('openlibraryGetEditions', () => {
  beforeEach(() => {
    initOpenLibraryService();
  });

  it('returns editions for valid work_id', async () => {
    const ctx = createMockContext({ errors: openlibraryGetEditions.errors });
    const svc = (
      await import('@/services/open-library/open-library-service.js')
    ).getOpenLibraryService();
    vi.spyOn(svc, 'getEditions').mockResolvedValueOnce(MOCK_EDITIONS_RESULT);

    const input = openlibraryGetEditions.input.parse({ work_id: 'OL45804W' });
    const result = await openlibraryGetEditions.handler(input, ctx);

    expect(result.work_id).toBe('OL45804W');
    expect(result.total).toBe(42);
    expect(result.editions).toHaveLength(1);
    expect(result.editions[0]!.edition_id).toBe('OL7353617M');
  });

  it('strips /works/ prefix from work_id', async () => {
    const ctx = createMockContext({ errors: openlibraryGetEditions.errors });
    const svc = (
      await import('@/services/open-library/open-library-service.js')
    ).getOpenLibraryService();
    const spy = vi.spyOn(svc, 'getEditions').mockResolvedValueOnce(MOCK_EDITIONS_RESULT);

    const input = openlibraryGetEditions.input.parse({ work_id: '/works/OL45804W' });
    await openlibraryGetEditions.handler(input, ctx);

    // The handler forwards input directly to svc.getEditions — the service strips the prefix
    expect(spy).toHaveBeenCalledWith('/works/OL45804W', 10, 0, ctx);
  });

  it('throws not_found via ctx.fail when service returns null', async () => {
    const ctx = createMockContext({ errors: openlibraryGetEditions.errors });
    const svc = (
      await import('@/services/open-library/open-library-service.js')
    ).getOpenLibraryService();
    vi.spyOn(svc, 'getEditions').mockResolvedValueOnce(null);

    const input = openlibraryGetEditions.input.parse({ work_id: 'OL999999999W' });
    await expect(openlibraryGetEditions.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: {
        reason: 'not_found',
        // The declared hint must reach the wire, not just live in errors[].
        recovery: {
          hint: openlibraryGetEditions.errors!.find((e) => e.reason === 'not_found')!.recovery,
        },
      },
    });
  });

  it('applies default limit and offset', () => {
    const input = openlibraryGetEditions.input.parse({ work_id: 'OL45804W' });
    expect(input.limit).toBe(10);
    expect(input.offset).toBe(0);
  });

  it('formats editions with all key fields', () => {
    const blocks = openlibraryGetEditions.format!(MOCK_EDITIONS_RESULT);
    const text = (blocks[0] as { text: string }).text;

    expect(text).toContain('OL45804W');
    expect(text).toContain('42');
    expect(text).toContain('OL7353617M');
    expect(text).toContain('The Great Gatsby');
    expect(text).toContain('1953');
    expect(text).toContain('Scribner');
    expect(text).toContain('9780743273565');
    expect(text).toContain('9255566');
  });

  it('formats sparse edition (no optional fields)', () => {
    const sparse = {
      total: 1,
      work_id: 'OL1W',
      editions: [
        {
          edition_id: 'OL1M',
          title: 'Sparse Edition',
          publishers: [],
          languages: [],
          isbn_10: [],
          isbn_13: [],
          cover_ids: [],
        },
      ],
    };
    const text = (openlibraryGetEditions.format!(sparse)[0] as { text: string }).text;
    expect(text).toContain('OL1M');
    expect(text).toContain('Sparse Edition');
  });
});
