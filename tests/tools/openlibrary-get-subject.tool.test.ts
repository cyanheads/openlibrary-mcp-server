/**
 * @fileoverview Tests for the openlibrary_get_subject tool.
 * @module tests/tools/openlibrary-get-subject.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { openlibraryGetSubject } from '@/mcp-server/tools/definitions/openlibrary-get-subject.tool.js';
import { initOpenLibraryService } from '@/services/open-library/open-library-service.js';

const SUBJECT_RESULT = {
  subject_name: 'Science Fiction',
  subject_key: 'science_fiction',
  work_count: 5432,
  works: [
    {
      work_id: 'OL1W',
      title: 'Dune',
      author_names: ['Frank Herbert'],
      edition_count: 150,
      cover_id: 999,
    },
    {
      work_id: 'OL2W',
      title: 'Foundation',
      author_names: ['Isaac Asimov'],
      edition_count: 80,
    },
  ],
};

describe('openlibraryGetSubject', () => {
  beforeEach(() => {
    initOpenLibraryService();
  });

  it('returns subject with works', async () => {
    const ctx = createMockContext({ errors: openlibraryGetSubject.errors });
    const svc = (
      await import('@/services/open-library/open-library-service.js')
    ).getOpenLibraryService();
    vi.spyOn(svc, 'getSubject').mockResolvedValueOnce(SUBJECT_RESULT);

    const input = openlibraryGetSubject.input.parse({ subject: 'science fiction' });
    const result = await openlibraryGetSubject.handler(input, ctx);

    expect(result.subject_name).toBe('Science Fiction');
    expect(result.work_count).toBe(5432);
    expect(result.works).toHaveLength(2);
    expect(result.works[0]!.work_id).toBe('OL1W');

    const enrichment = getEnrichment(ctx);
    expect(enrichment.notice).toBeUndefined();
  });

  it('throws not_found via ctx.fail when service returns null', async () => {
    const ctx = createMockContext({ errors: openlibraryGetSubject.errors });
    const svc = (
      await import('@/services/open-library/open-library-service.js')
    ).getOpenLibraryService();
    vi.spyOn(svc, 'getSubject').mockResolvedValueOnce(null);

    const input = openlibraryGetSubject.input.parse({ subject: 'zzz_nonexistent_xyz' });
    await expect(openlibraryGetSubject.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'not_found' },
    });
  });

  it('formats subject with all fields', () => {
    const blocks = openlibraryGetSubject.format!(SUBJECT_RESULT);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('Science Fiction');
    expect(text).toContain('science_fiction');
    expect(text).toContain('5432');
    expect(text).toContain('OL1W');
    expect(text).toContain('Dune');
    expect(text).toContain('Frank Herbert');
    expect(text).toContain('999');
    expect(text).toContain('OL2W');
  });

  it('formats work without optional cover_id', () => {
    const result = {
      ...SUBJECT_RESULT,
      works: [{ work_id: 'OL3W', title: 'No Cover', author_names: [], edition_count: 5 }],
    };
    const text = (openlibraryGetSubject.format!(result)[0] as { text: string }).text;
    expect(text).toContain('OL3W');
    expect(text).toContain('No Cover');
  });

  it('applies defaults: limit 12, offset 0', () => {
    const input = openlibraryGetSubject.input.parse({ subject: 'fiction' });
    expect(input.limit).toBe(12);
    expect(input.offset).toBe(0);
  });

  it('populates notice enrichment when work_count is 0', async () => {
    const ctx = createMockContext({ errors: openlibraryGetSubject.errors });
    const svc = (
      await import('@/services/open-library/open-library-service.js')
    ).getOpenLibraryService();
    vi.spyOn(svc, 'getSubject').mockResolvedValueOnce({
      subject_name: 'xzqnonexistent',
      subject_key: 'xzqnonexistent',
      work_count: 0,
      works: [],
    });

    const input = openlibraryGetSubject.input.parse({ subject: 'xzqnonexistent' });
    const result = await openlibraryGetSubject.handler(input, ctx);

    expect(result.work_count).toBe(0);
    expect(result.works).toHaveLength(0);
    // message is gone from output; notice lives in enrichment
    expect((result as Record<string, unknown>).message).toBeUndefined();

    const enrichment = getEnrichment(ctx);
    expect(enrichment.notice).toContain('xzqnonexistent');
    expect(enrichment.notice).toContain('lowercase');
  });

  it('formats empty-result subject correctly', () => {
    const emptyResult = {
      subject_name: 'xzqnonexistent',
      subject_key: 'xzqnonexistent',
      work_count: 0,
      works: [] as typeof SUBJECT_RESULT.works,
    };
    const blocks = openlibraryGetSubject.format!(emptyResult);
    const text = (blocks[0] as { text: string }).text;
    // format() shows header and zero counts; notice is in enrichment trailer
    expect(text).toContain('xzqnonexistent');
    expect(text).toContain('Total works:** 0');
  });
});
