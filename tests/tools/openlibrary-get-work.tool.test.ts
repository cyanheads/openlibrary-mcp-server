/**
 * @fileoverview Tests for the openlibrary_get_work tool.
 * @module tests/tools/openlibrary-get-work.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { openlibraryGetWork } from '@/mcp-server/tools/definitions/openlibrary-get-work.tool.js';
import { initOpenLibraryService } from '@/services/open-library/open-library-service.js';

const FULL_WORK = {
  work_id: 'OL45804W',
  title: 'The Great Gatsby',
  description: 'A novel set in the Jazz Age.',
  subjects: ['Fiction', 'American literature'],
  subject_places: ['New York'],
  subject_times: ['1920s'],
  subject_people: ['Jay Gatsby'],
  cover_ids: [123456],
  author_ids: ['OL24638A'],
  created: '2008-04-01T03:28:50.625462',
  last_modified: '2023-01-01T00:00:00',
};

describe('openlibraryGetWork', () => {
  it('renders an empty title explicitly beside the authored heading placeholder', async () => {
    const svc = (
      await import('@/services/open-library/open-library-service.js')
    ).getOpenLibraryService();
    vi.spyOn(svc, 'getWork').mockResolvedValueOnce({ ...FULL_WORK, title: '' });
    const result = await runToolContract(openlibraryGetWork, { work_id: 'OL45804W' });
    expect(result.structuredContent).toMatchObject({ title: '' });
    const text = result.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('\n');
    expect(text).toContain('## *(no title recorded)*');
    expect(text).toContain('**Title:** ""');
  });
  it('preserves merged-work notice, complete subjects, empty fields and multiline literal values on both surfaces', async () => {
    initOpenLibraryService();
    const svc = (
      await import('@/services/open-library/open-library-service.js')
    ).getOpenLibraryService();
    const work = {
      ...FULL_WORK,
      work_id: 'OL2W',
      title: '*Title*\n# literal',
      description: '',
      created: '',
      last_modified: '',
      subject_places: ['<b>Paris</b>'],
      subjects: Array.from({ length: 12 }, (_, i) => `subject-${i}`),
    };
    vi.spyOn(svc, 'getWork').mockResolvedValueOnce(work);
    const result = await runToolContract(openlibraryGetWork, { work_id: 'OL1W' });
    expect(result.structuredContent).toMatchObject({
      ...work,
      notice: expect.stringContaining('merged record'),
    });
    const text = result.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('\n');
    for (const value of [
      '**Title:** \\*Title\\*\\\n\\# literal',
      'subject-11',
      '**Description:**',
      '**Created:**',
      '**Last modified:**',
      '\\<b>Paris\\</b>',
      'merged record',
    ])
      expect(text).toContain(value);
    expect(text).not.toContain('capped');
    expect(text).not.toContain('## *Title*');
  });
  beforeEach(() => {
    initOpenLibraryService();
  });

  it('returns work detail on success', async () => {
    const ctx = createMockContext({ errors: openlibraryGetWork.errors });
    const svc = (
      await import('@/services/open-library/open-library-service.js')
    ).getOpenLibraryService();
    vi.spyOn(svc, 'getWork').mockResolvedValueOnce(FULL_WORK);

    const input = openlibraryGetWork.input.parse({ work_id: 'OL45804W' });
    const result = await openlibraryGetWork.handler(input, ctx);

    expect(result.work_id).toBe('OL45804W');
    expect(result.title).toBe('The Great Gatsby');
    expect(result.author_ids).toContain('OL24638A');
  });

  it('fails as not_found when service returns null', async () => {
    const svc = (
      await import('@/services/open-library/open-library-service.js')
    ).getOpenLibraryService();
    vi.spyOn(svc, 'getWork').mockResolvedValueOnce(null);

    const result = await runToolContract(openlibraryGetWork, { work_id: 'OL999999999W' });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.NotFound,
        data: {
          reason: 'not_found',
          // The declared hint must reach the wire, not just live in errors[].
          recovery: {
            hint: openlibraryGetWork.errors!.find((e) => e.reason === 'not_found')!.recovery,
          },
        },
      },
    });
  });

  it('formats work with all fields', () => {
    const blocks = openlibraryGetWork.format!(FULL_WORK);
    expect(blocks.some((b) => b.type === 'text')).toBe(true);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('OL45804W');
    expect(text).toContain('The Great Gatsby');
    expect(text).toContain('OL24638A');
    expect(text).toContain('123456');
    expect(text).toContain('New York');
    expect(text).toContain('1920s');
    expect(text).toContain('Jay Gatsby');
  });

  it('formats sparse work (no optional fields)', () => {
    const sparse = {
      work_id: 'OL1W',
      title: 'Sparse',
      subjects: [],
      subject_places: [],
      subject_times: [],
      subject_people: [],
      cover_ids: [],
      author_ids: [],
    };
    const text = (openlibraryGetWork.format!(sparse)[0] as { text: string }).text;
    expect(text).toContain('OL1W');
    expect(text).toContain('Sparse');
    for (const label of ['Author IDs', 'Cover IDs', 'Subjects', 'Places', 'Time periods', 'People'])
      expect(text).toContain(`**${label}:** []`);
  });
});
