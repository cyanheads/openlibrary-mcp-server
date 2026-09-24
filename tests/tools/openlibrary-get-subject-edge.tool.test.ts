/**
 * @fileoverview Edge case and security tests for the openlibrary_get_subject tool.
 * @module tests/tools/openlibrary-get-subject-edge.tool.test
 */

import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

  // ─── Unknown subject ─────────────────────────────────────────────────────────

  it('returns a zero-work success for an unknown subject, with actionable guidance', async () => {
    const ctx = createMockContext();
    const svc = (
      await import('@/services/open-library/open-library-service.js')
    ).getOpenLibraryService();
    vi.spyOn(svc, 'getSubject').mockResolvedValueOnce({
      subject_name: 'zzznomatchzzz',
      subject_key: 'zzznomatchzzz',
      work_count: 0,
      works: [],
    });

    const input = openlibraryGetSubject.input.parse({ subject: 'zzznomatchzzz' });
    const result = await openlibraryGetSubject.handler(input, ctx);

    expect(result.work_count).toBe(0);
    const enrichment = getEnrichment(ctx);
    expect(enrichment.notice).not.toContain('lowercase');
    expect(enrichment.notice).toContain('word form');
  });

  // ─── Unicode subjects ────────────────────────────────────────────────────────

  it('handles unicode subject without error', async () => {
    const ctx = createMockContext();
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
    const ctx = createMockContext();
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
    const ctx = createMockContext();
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
    const ctx = createMockContext();
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
    const text = (openlibraryGetSubject.format!({ ...result, offset: 0 })[0] as { text: string })
      .text;
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
    const text = (openlibraryGetSubject.format!({ ...result, offset: 0 })[0] as { text: string })
      .text;
    expect(text).not.toContain('undefined');
    expect(text).not.toContain('null');
  });
});

describe('openlibraryGetSubject — offset echo', () => {
  /** A `subjects/{key}.json` page as Open Library returns it. */
  function subjectPage(workCount: number, count: number): Response {
    return new Response(
      JSON.stringify({
        name: 'science fiction',
        work_count: workCount,
        works: Array.from({ length: count }, (_, i) => ({
          key: `/works/OL${i + 1}W`,
          title: `Work ${i + 1}`,
          authors: [{ name: 'Someone' }],
          edition_count: 1,
        })),
      }),
      { status: 200 },
    );
  }

  function contentText(result: { content: unknown[] }): string {
    return result.content
      .map((block) => (block && typeof block === 'object' && 'text' in block ? block.text : ''))
      .join('\n');
  }

  beforeEach(() => {
    initOpenLibraryService();
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unmocked fetch'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    ['the default offset', undefined, 2, 0],
    ['a mid-list offset', 5, 2, 5],
    ['an offset past the end', 100_000, 0, 100_000],
  ])('echoes %s on both surfaces', async (_label, offset, returned, expected) => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(subjectPage(21208, returned));

    const result = await runToolContract(openlibraryGetSubject, {
      subject: 'Science Fiction',
      limit: 2,
      ...(offset === undefined ? {} : { offset }),
    });

    expect(result.isError).toBeFalsy();
    const structured = openlibraryGetSubject.output.parse(result.structuredContent);
    expect(structured.offset).toBe(expected);
    expect(structured.works).toHaveLength(returned);
    expect(contentText(result)).toContain(
      `**Key:** science_fiction | **Total works:** 21208 | **Offset:** ${expected} | **Returned:** ${returned}`,
    );
  });

  // An unknown subject takes the handler's separate work_count === 0 return.
  it('echoes the offset on the empty-subject path', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(subjectPage(0, 0));

    const result = await runToolContract(openlibraryGetSubject, {
      subject: 'zzznotasubject',
      offset: 24,
    });

    expect(result.isError).toBeFalsy();
    const structured = openlibraryGetSubject.output.parse(result.structuredContent);
    expect(structured.offset).toBe(24);
    expect(structured.work_count).toBe(0);
    expect(contentText(result)).toContain('**Total works:** 0 | **Offset:** 24 | **Returned:** 0');
    expect((result.structuredContent as { notice?: string }).notice).toContain('zzznotasubject');
  });
});
