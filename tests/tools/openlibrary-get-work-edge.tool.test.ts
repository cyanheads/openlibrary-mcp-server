/**
 * @fileoverview Edge case and security tests for the openlibrary_get_work tool.
 * @module tests/tools/openlibrary-get-work-edge.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { openlibraryGetWork } from '@/mcp-server/tools/definitions/openlibrary-get-work.tool.js';
import { initOpenLibraryService } from '@/services/open-library/open-library-service.js';

const SPARSE_WORK = {
  work_id: 'OL1W',
  title: 'Minimal Work',
  subjects: [],
  subject_places: [],
  subject_times: [],
  subject_people: [],
  cover_ids: [],
  author_ids: [],
};

describe('openlibraryGetWork — edge cases and security', () => {
  beforeEach(() => {
    initOpenLibraryService();
  });

  // ─── Not found error contract ────────────────────────────────────────────────

  it('throws not_found via ctx.fail when service returns null (non-existent work)', async () => {
    const ctx = createMockContext({ errors: openlibraryGetWork.errors });
    const svc = (
      await import('@/services/open-library/open-library-service.js')
    ).getOpenLibraryService();
    vi.spyOn(svc, 'getWork').mockResolvedValueOnce(null);

    const input = openlibraryGetWork.input.parse({ work_id: 'OL999999999W' });
    await expect(openlibraryGetWork.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'not_found' },
    });
  });

  // ─── Service error types ────────────────────────────────────────────────────

  it('propagates ServiceUnavailable error from service', async () => {
    const ctx = createMockContext({ errors: openlibraryGetWork.errors });
    const svc = (
      await import('@/services/open-library/open-library-service.js')
    ).getOpenLibraryService();
    vi.spyOn(svc, 'getWork').mockRejectedValueOnce(
      new Error('Service unavailable — API returned HTML instead of JSON.'),
    );

    const input = openlibraryGetWork.input.parse({ work_id: 'OL45804W' });
    await expect(openlibraryGetWork.handler(input, ctx)).rejects.toThrow('Service unavailable');
  });

  it('propagates timeout error from service', async () => {
    const ctx = createMockContext({ errors: openlibraryGetWork.errors });
    const svc = (
      await import('@/services/open-library/open-library-service.js')
    ).getOpenLibraryService();
    vi.spyOn(svc, 'getWork').mockRejectedValueOnce(new Error('Request timed out'));

    const input = openlibraryGetWork.input.parse({ work_id: 'OL45804W' });
    await expect(openlibraryGetWork.handler(input, ctx)).rejects.toThrow();
  });

  // ─── Prefix stripping in work_id ────────────────────────────────────────────

  it('passes /works/ prefix to service unchanged (service strips it)', async () => {
    const ctx = createMockContext({ errors: openlibraryGetWork.errors });
    const svc = (
      await import('@/services/open-library/open-library-service.js')
    ).getOpenLibraryService();
    const spy = vi.spyOn(svc, 'getWork').mockResolvedValueOnce(SPARSE_WORK);

    const input = openlibraryGetWork.input.parse({ work_id: '/works/OL1W' });
    await openlibraryGetWork.handler(input, ctx);
    expect(spy).toHaveBeenCalledWith('/works/OL1W', ctx);
  });

  // ─── Work with unicode data ──────────────────────────────────────────────────

  it('returns work with unicode title and subjects', async () => {
    const ctx = createMockContext({ errors: openlibraryGetWork.errors });
    const svc = (
      await import('@/services/open-library/open-library-service.js')
    ).getOpenLibraryService();
    const unicodeWork = {
      ...SPARSE_WORK,
      title: '源氏物語',
      subjects: ['日本文学', '平安時代'],
      subject_people: ['光源氏'],
    };
    vi.spyOn(svc, 'getWork').mockResolvedValueOnce(unicodeWork);

    const input = openlibraryGetWork.input.parse({ work_id: 'OL12345W' });
    const result = await openlibraryGetWork.handler(input, ctx);
    expect(result.title).toBe('源氏物語');
    expect(result.subjects).toContain('日本文学');
  });

  // ─── Format completeness ─────────────────────────────────────────────────────

  it('format includes timestamps when present', () => {
    const work = {
      ...SPARSE_WORK,
      created: '2008-04-01T03:28:50.625462',
      last_modified: '2023-01-01T00:00:00',
    };
    const text = (openlibraryGetWork.format!(work)[0] as { text: string }).text;
    expect(text).toContain('2008-04-01');
    expect(text).toContain('2023-01-01');
  });

  it('format does not emit undefined or null literals', () => {
    const text = (openlibraryGetWork.format!(SPARSE_WORK)[0] as { text: string }).text;
    expect(text).not.toContain('undefined');
    expect(text).not.toContain('null');
  });

  it('format includes description when present', () => {
    const work = {
      ...SPARSE_WORK,
      description: 'A seminal work of Japanese literature.',
    };
    const text = (openlibraryGetWork.format!(work)[0] as { text: string }).text;
    expect(text).toContain('A seminal work of Japanese literature.');
  });

  it('format renders all subject categories', () => {
    const work = {
      work_id: 'OL1W',
      title: 'Rich Work',
      subjects: ['Fiction'],
      subject_places: ['Paris'],
      subject_times: ['19th century'],
      subject_people: ['Jean Valjean'],
      cover_ids: [42],
      author_ids: ['OL1A'],
    };
    const text = (openlibraryGetWork.format!(work)[0] as { text: string }).text;
    expect(text).toContain('Fiction');
    expect(text).toContain('Paris');
    expect(text).toContain('19th century');
    expect(text).toContain('Jean Valjean');
    expect(text).toContain('42');
    expect(text).toContain('OL1A');
  });

  // ─── Subject text capping (#13) ──────────────────────────────────────────────

  it('caps subjects in text and discloses the omitted count, keeping the full array', async () => {
    const ctx = createMockContext({ errors: openlibraryGetWork.errors });
    const svc = (
      await import('@/services/open-library/open-library-service.js')
    ).getOpenLibraryService();

    // Zero-padded so subject-09 is not a substring of subject-10/-11.
    const subjects = Array.from({ length: 12 }, (_, i) => `subject-${String(i).padStart(2, '0')}`);
    vi.spyOn(svc, 'getWork').mockResolvedValueOnce({ ...SPARSE_WORK, subjects });

    const input = openlibraryGetWork.input.parse({ work_id: 'OL27482W' });
    const result = await openlibraryGetWork.handler(input, ctx);

    // structuredContent keeps every subject.
    expect(result.subjects).toHaveLength(12);

    // The enrichment trailer discloses the cap and the true total.
    const enrichment = getEnrichment(ctx);
    expect(enrichment.notice).toContain('showing 10 of 12');
    expect(enrichment.notice).toContain('structuredContent');

    // The text renders only the first 10 (SUBJECTS_TEXT_CAP).
    const text = (openlibraryGetWork.format!(result)[0] as { text: string }).text;
    expect(text).toContain('subject-09');
    expect(text).not.toContain('subject-10');
    expect(text).not.toContain('subject-11');
  });

  it('does not disclose subject capping at exactly the cap (boundary)', async () => {
    const ctx = createMockContext({ errors: openlibraryGetWork.errors });
    const svc = (
      await import('@/services/open-library/open-library-service.js')
    ).getOpenLibraryService();

    const subjects = Array.from({ length: 10 }, (_, i) => `subject-${String(i).padStart(2, '0')}`);
    vi.spyOn(svc, 'getWork').mockResolvedValueOnce({ ...SPARSE_WORK, subjects });

    const input = openlibraryGetWork.input.parse({ work_id: 'OL27482W' });
    const result = await openlibraryGetWork.handler(input, ctx);

    // At exactly the cap nothing is omitted — no disclosure, all 10 render in text.
    expect(getEnrichment(ctx).notice).toBeUndefined();
    const text = (openlibraryGetWork.format!(result)[0] as { text: string }).text;
    expect(text).toContain('subject-09');
  });
});
