/**
 * @fileoverview Edge case and security tests for the openlibrary_get_subject tool.
 * @module tests/tools/openlibrary-get-subject-edge.tool.test
 */

import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { openlibraryGetSubject } from '@/mcp-server/tools/definitions/openlibrary-get-subject.tool.js';
import { initOpenLibraryService } from '@/services/open-library/open-library-service.js';

describe('openlibraryGetSubject — edge cases and security', () => {
  beforeEach(() => {
    initOpenLibraryService();
  });

  // ─── Input validation ───────────────────────────────────────────────────────

  it('rejects limit below 1', () => {
    expect(() => openlibraryGetSubject.input.parse({ subject: 'fiction', limit: 0 })).toThrow();
  });

  it('rejects limit above 100', () => {
    expect(() => openlibraryGetSubject.input.parse({ subject: 'fiction', limit: 101 })).toThrow();
  });

  it('rejects negative offset', () => {
    expect(() => openlibraryGetSubject.input.parse({ subject: 'fiction', offset: -1 })).toThrow();
  });

  // ─── Pagination boundary values ─────────────────────────────────────────────

  it('accepts limit 1 (minimum)', () => {
    const input = openlibraryGetSubject.input.parse({ subject: 'fiction', limit: 1 });
    expect(input.limit).toBe(1);
  });

  it('accepts limit 100 (maximum)', () => {
    const input = openlibraryGetSubject.input.parse({ subject: 'fiction', limit: 100 });
    expect(input.limit).toBe(100);
  });

  // ─── Unicode subjects ────────────────────────────────────────────────────────

  it('handles unicode subject without error', async () => {
    const ctx = createMockContext({ errors: openlibraryGetSubject.errors });
    const svc = (
      await import('@/services/open-library/open-library-service.js')
    ).getOpenLibraryService();
    vi.spyOn(svc, 'getSubject').mockResolvedValueOnce({
      subject_name: '日本文学',
      subject_key: '日本文学',
      work_count: 0,
      works: [],
    });

    const input = openlibraryGetSubject.input.parse({ subject: '日本文学' });
    const result = await openlibraryGetSubject.handler(input, ctx);
    expect(result.work_count).toBe(0);
  });

  // ─── Injection attempts ──────────────────────────────────────────────────────

  it('passes injection-attempt subject to service unchanged', async () => {
    const ctx = createMockContext({ errors: openlibraryGetSubject.errors });
    const svc = (
      await import('@/services/open-library/open-library-service.js')
    ).getOpenLibraryService();
    const spy = vi.spyOn(svc, 'getSubject').mockResolvedValueOnce({
      subject_name: "'; DROP TABLE works; --",
      subject_key: "'; DROP TABLE works; --",
      work_count: 0,
      works: [],
    });

    const injectionSubject = "'; DROP TABLE works; --";
    const input = openlibraryGetSubject.input.parse({ subject: injectionSubject });
    await openlibraryGetSubject.handler(input, ctx);

    // Service receives the raw input; URL encoding is handled by the service
    expect(spy).toHaveBeenCalledWith(injectionSubject, expect.any(Number), expect.any(Number), ctx);
  });

  it('handles subject with special chars in enrichment notice', async () => {
    const ctx = createMockContext({ errors: openlibraryGetSubject.errors });
    const svc = (
      await import('@/services/open-library/open-library-service.js')
    ).getOpenLibraryService();
    vi.spyOn(svc, 'getSubject').mockResolvedValueOnce({
      subject_name: '<script>alert(1)</script>',
      subject_key: 'script_alert_1_script',
      work_count: 0,
      works: [],
    });

    const input = openlibraryGetSubject.input.parse({
      subject: '<script>alert(1)</script>',
    });
    const result = await openlibraryGetSubject.handler(input, ctx);

    // Result should be well-formed even with XSS-attempt subject
    expect(result.work_count).toBe(0);
    const enrichment = getEnrichment(ctx);
    expect(enrichment.notice).toBeDefined();
    // The enrichment notice should not crash — it's plain text
  });

  // ─── Works with covers ──────────────────────────────────────────────────────

  it('returns numeric cover_id in works', async () => {
    const ctx = createMockContext({ errors: openlibraryGetSubject.errors });
    const svc = (
      await import('@/services/open-library/open-library-service.js')
    ).getOpenLibraryService();
    vi.spyOn(svc, 'getSubject').mockResolvedValueOnce({
      subject_name: 'Mystery',
      subject_key: 'mystery',
      work_count: 1,
      works: [
        {
          work_id: 'OL1W',
          title: 'The Mystery',
          author_names: ['Jane Doe'],
          edition_count: 10,
          cover_id: 42,
        },
      ],
    });

    const input = openlibraryGetSubject.input.parse({ subject: 'mystery' });
    const result = await openlibraryGetSubject.handler(input, ctx);
    expect(result.works[0]!.cover_id).toBe(42);
  });

  // ─── Format completeness ────────────────────────────────────────────────────

  it('format shows work_count and returned count', () => {
    const result = {
      subject_name: 'Horror',
      subject_key: 'horror',
      work_count: 999,
      works: [
        {
          work_id: 'OL1W',
          title: 'Scary',
          author_names: ['Mr. Dark'],
          edition_count: 5,
        },
      ],
    };
    const text = (openlibraryGetSubject.format!(result)[0] as { text: string }).text;
    expect(text).toContain('999');
    expect(text).toContain('Returned:** 1');
    expect(text).toContain('Mr. Dark');
  });

  it('format does not emit undefined or null literals', () => {
    const result = {
      subject_name: 'Test',
      subject_key: 'test',
      work_count: 1,
      works: [
        {
          work_id: 'OL1W',
          title: 'Test Work',
          author_names: [],
          edition_count: 1,
          // cover_id absent
        },
      ],
    };
    const text = (openlibraryGetSubject.format!(result)[0] as { text: string }).text;
    expect(text).not.toContain('undefined');
    expect(text).not.toContain('null');
  });
});
