/**
 * @fileoverview Tests for the openlibrary_get_subject tool.
 * @module tests/tools/openlibrary-get-subject.tool.test
 */

import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
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
  it('renders an empty work title explicitly beside the authored heading placeholder', async () => {
    const svc = (
      await import('@/services/open-library/open-library-service.js')
    ).getOpenLibraryService();
    vi.spyOn(svc, 'getSubject').mockResolvedValueOnce({
      ...SUBJECT_RESULT,
      works: [{ ...SUBJECT_RESULT.works[0]!, title: '' }],
    });
    const result = await runToolContract(openlibraryGetSubject, { subject: 'fiction' });
    expect(result.structuredContent).toMatchObject({ works: [{ title: '' }] });
    const text = result.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('\n');
    expect(text).toContain('### *(no title recorded)*');
    expect(text).toContain('**Title:** ""');
  });
  it('escapes caller text inside the authored unknown-subject notice', async () => {
    initOpenLibraryService();
    const svc = (
      await import('@/services/open-library/open-library-service.js')
    ).getOpenLibraryService();
    vi.spyOn(svc, 'getSubject').mockResolvedValueOnce({
      subject_name: 'missing',
      subject_key: 'missing',
      work_count: 0,
      works: [],
    });
    const result = await runToolContract(openlibraryGetSubject, {
      subject: '*Subject*\n# literal',
    });
    const text = result.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('\n');
    expect(text).toContain('\\*Subject\\*\\\n> \\# literal');
  });
  it('preserves multiline literal names and empty authors on both surfaces', async () => {
    initOpenLibraryService();
    const svc = (
      await import('@/services/open-library/open-library-service.js')
    ).getOpenLibraryService();
    const page = {
      subject_name: '*Subject*\n# literal',
      subject_key: '<b>subject</b>',
      work_count: 1,
      works: [
        {
          work_id: 'OL1W',
          title: '*Title*\n# literal',
          author_names: [],
          edition_count: 0,
          cover_id: 0,
        },
      ],
    };
    vi.spyOn(svc, 'getSubject').mockResolvedValueOnce(page);
    const result = await runToolContract(openlibraryGetSubject, { subject: 'subject' });
    expect(result.structuredContent).toMatchObject(page);
    const text = result.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('\n');
    for (const value of [
      '**Subject:** \\*Subject\\*\\\n\\# literal',
      '**Title:** \\*Title\\*\\\n\\# literal',
      '\\<b>subject\\</b>',
      '**Authors:** []',
      '**Editions:** 0',
      '**Cover ID:** 0',
    ])
      expect(text).toContain(value);
  });

  it('resumes a shortened page after actual rows and records one clamp', async () => {
    initOpenLibraryService();
    const ctx = createMockContext({ errors: openlibraryGetSubject.errors });
    const log = vi.spyOn(ctx.log, 'notice');
    const svc = (
      await import('@/services/open-library/open-library-service.js')
    ).getOpenLibraryService();
    const spy = vi.spyOn(svc, 'getSubject').mockResolvedValueOnce(SUBJECT_RESULT);
    const result = await openlibraryGetSubject.handler(
      openlibraryGetSubject.input.parse({ subject: 'fiction', limit: 200, offset: 9 }),
      ctx,
    );
    expect(result).toMatchObject({ work_count: 5432, offset: 9 });
    expect(spy).toHaveBeenCalledWith('fiction', 100, 9, ctx);
    expect(getEnrichment(ctx).notice).toBe(
      'Requested limit 200; applied limit 100. Next offset: 11.',
    );
    expect(log).toHaveBeenCalledOnce();
  });
  it('clamps an unknown-subject page while composing recovery on both surfaces', async () => {
    initOpenLibraryService();
    const svc = (
      await import('@/services/open-library/open-library-service.js')
    ).getOpenLibraryService();
    const spy = vi.spyOn(svc, 'getSubject').mockResolvedValueOnce({
      subject_name: 'missing',
      subject_key: 'missing',
      work_count: 0,
      works: [],
    });
    const result = await runToolContract(openlibraryGetSubject, {
      subject: 'missing',
      limit: 101,
      offset: 24,
    });
    expect(result.isError).toBeFalsy();
    expect(spy).toHaveBeenCalledOnce();
    expect(spy).toHaveBeenCalledWith('missing', 100, 24, expect.anything());
    expect(result.structuredContent).toMatchObject({
      work_count: 0,
      offset: 24,
      notice: expect.stringContaining('synonym'),
    });
    expect(JSON.stringify(result.content)).toContain('Next offset: 24');
  });
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

  it('treats an unknown subject as an empty result, not a failure', async () => {
    const ctx = createMockContext({ errors: openlibraryGetSubject.errors });
    const svc = (
      await import('@/services/open-library/open-library-service.js')
    ).getOpenLibraryService();
    // Open Library answers any subject key with HTTP 200, echoing the key back
    // with work_count 0 — there is no absent-record shape left to fail on.
    vi.spyOn(svc, 'getSubject').mockResolvedValueOnce({
      subject_name: 'zzz_nonexistent_xyz',
      subject_key: 'zzz_nonexistent_xyz',
      work_count: 0,
      works: [],
    });

    const input = openlibraryGetSubject.input.parse({ subject: 'zzz_nonexistent_xyz' });
    const result = await openlibraryGetSubject.handler(input, ctx);

    expect(result.work_count).toBe(0);
    expect(result.works).toEqual([]);
  });

  it('has no not_found contract for unknown nonblank subject keys', () => {
    expect(openlibraryGetSubject.errors).not.toContainEqual(
      expect.objectContaining({ reason: 'not_found' }),
    );
    expect(openlibraryGetSubject.errors!.map((entry) => entry.reason)).toEqual(['invalid_subject']);
  });

  it('formats subject with all fields', () => {
    const blocks = openlibraryGetSubject.format!({ ...SUBJECT_RESULT, offset: 0 });
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
    const text = (openlibraryGetSubject.format!({ ...result, offset: 0 })[0] as { text: string })
      .text;
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
    // The guidance must be actionable: case and spacing normalize away, so
    // advising a case change would send the caller back for the same result.
    expect(enrichment.notice).not.toContain('lowercase');
    expect(enrichment.notice).not.toContain('case-sensitive');
    expect(enrichment.notice).toContain('word form');
    expect(enrichment.notice).toContain('synonym');
    expect(enrichment.notice).toContain('broader term');
    expect(enrichment.totalCount).toBe(0);
  });

  it('formats empty-result subject correctly', () => {
    const emptyResult = {
      subject_name: 'xzqnonexistent',
      subject_key: 'xzqnonexistent',
      work_count: 0,
      works: [] as typeof SUBJECT_RESULT.works,
    };
    const blocks = openlibraryGetSubject.format!({ ...emptyResult, offset: 0 });
    const text = (blocks[0] as { text: string }).text;
    // format() shows header and zero counts; notice is in enrichment trailer
    expect(text).toContain('xzqnonexistent');
    expect(text).toContain('Total works:** 0');
  });
});
