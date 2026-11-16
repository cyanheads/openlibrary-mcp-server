/**
 * @fileoverview Edge case and input validation tests for the openlibrary_get_editions tool.
 * @module tests/tools/openlibrary-get-editions-edge.tool.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { escapeMarkdownInline } from '@cyanheads/mcp-ts-core/utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openlibraryGetEditions } from '@/mcp-server/tools/definitions/openlibrary-get-editions.tool.js';
import { initOpenLibraryService } from '@/services/open-library/open-library-service.js';

/**
 * `work_id` values that are not work OLIDs. Open Library answers each with a
 * 404, or — for `OL…M` and `OL…A` — with a 301 to the edition or author record.
 */
const NON_WORK_IDS = [
  ['an ISBN-13', '9780765326355'],
  ['a hyphenated ISBN-13', '978-0-7653-2635-5'],
  ['an ISBN-10', '0140328726'],
  ['an ISBN-10 with an X check digit', '080442957X'],
  ['an edition OLID', 'OL7353617M'],
  ['an author OLID', 'OL34184A'],
  ['a lowercase work OLID', 'ol45804w'],
  ['a whitespace-padded work OLID', ' OL45804W '],
  ['a slugged work path', 'OL45804W/Fantastic_Mr_Fox'],
  ['a full work URL', 'https://openlibrary.org/works/OL45804W'],
  ['a prefix without its leading slash', 'works/OL45804W'],
  ['an empty string', ''],
] as const;

/** An `editions.json` page as Open Library returns it. */
function editionsPage(size: number, count: number): Response {
  return new Response(
    JSON.stringify({
      size,
      entries: Array.from({ length: count }, (_, i) => ({
        key: `/books/OL${i + 1}M`,
        title: `Edition ${i + 1}`,
        works: [{ key: '/works/OL893414W' }],
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

describe('openlibraryGetEditions — edge cases', () => {
  beforeEach(() => {
    initOpenLibraryService();
  });

  it('preserves cataloged format and printing on both surfaces', async () => {
    const svc = (
      await import('@/services/open-library/open-library-service.js')
    ).getOpenLibraryService();
    vi.spyOn(svc, 'getEditions').mockResolvedValue({
      total: 1,
      work_id: 'OL1W',
      editions: [
        {
          edition_id: 'OL1M',
          title: 'A printing',
          publishers: [],
          languages: [],
          isbn_10: [],
          isbn_13: [],
          cover_ids: [],
          physical_format: 'paperback',
          edition_name: 'Second Dell printing',
        },
      ],
    });
    const result = await runToolContract(openlibraryGetEditions, { work_id: 'OL1W' });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      editions: [{ physical_format: 'paperback', edition_name: 'Second Dell printing' }],
    });
    expect(JSON.stringify(result.content)).toContain('paperback');
    expect(JSON.stringify(result.content)).toContain('Second Dell printing');
  });

  it('returns edition credits on both surfaces and renders none that are absent', async () => {
    const svc = (
      await import('@/services/open-library/open-library-service.js')
    ).getOpenLibraryService();
    const credited = {
      edition_id: 'OL7361482M',
      title: 'Anna Karenina',
      subtitle: 'A *novel*',
      by_statement: 'Translated by Richard Pevear and Larissa Volokhonsky',
      contributors: [
        { name: 'Richard Pevear', role: 'Translator' },
        { name: 'Larissa Volokhonsky' },
      ],
      contributions: ['Pevear, Richard, 1943-, translator', 'Larissa Volokhonsky (Translator)'],
      translated_from: ['rus'],
      publishers: [],
      languages: ['eng'],
      isbn_10: [],
      isbn_13: ['9780143035008'],
      cover_ids: [],
    };
    // Taken before the call: the stub hands `credited` itself to the handler.
    const expected = structuredClone(credited);
    const bare = {
      edition_id: 'OL1M',
      title: 'Bare',
      publishers: [],
      languages: [],
      isbn_10: [],
      isbn_13: [],
      cover_ids: [],
    };
    vi.spyOn(svc, 'getEditions').mockResolvedValue({
      total: 2,
      work_id: 'OL267096W',
      editions: [credited, bare],
    });
    const result = await runToolContract(openlibraryGetEditions, { work_id: 'OL267096W' });
    expect(result.isError).toBeFalsy();
    const structured = openlibraryGetEditions.output.parse(result.structuredContent);
    expect(structured.editions[0]).toEqual(expected);
    for (const field of [
      'subtitle',
      'by_statement',
      'contributors',
      'contributions',
      'translated_from',
    ])
      expect(structured.editions[1]).not.toHaveProperty(field);
    const [first, second] = contentText(result).split('### Bare');
    for (const line of [
      `**Subtitle:** ${escapeMarkdownInline('A *novel*')}`,
      '**By statement:** Translated by Richard Pevear and Larissa Volokhonsky',
      '**Contributors:** Richard Pevear (Translator); Larissa Volokhonsky',
      '**Contributions:** Pevear, Richard, 1943-, translator; Larissa Volokhonsky (Translator)',
      '**Translated from:** rus',
    ])
      expect(first).toContain(line);
    for (const label of [
      'Subtitle',
      'By statement',
      'Contributors',
      'Contributions',
      'Translated from',
    ])
      expect(second).not.toContain(`**${label}:**`);
  });

  // ─── Input validation ───────────────────────────────────────────────────────

  it('rejects limit below 1', () => {
    expect(() => openlibraryGetEditions.input.parse({ work_id: 'OL45804W', limit: 0 })).toThrow();
  });

  it('accepts a limit above the page ceiling for clamping', () => {
    expect(openlibraryGetEditions.input.parse({ work_id: 'OL45804W', limit: 101 }).limit).toBe(101);
  });

  it('clamps one page while retaining merged-ID notice and the actual next offset', async () => {
    const svc = (
      await import('@/services/open-library/open-library-service.js')
    ).getOpenLibraryService();
    const spy = vi
      .spyOn(svc, 'getEditions')
      .mockResolvedValue({ total: 2000, work_id: 'OL2W', editions: [] });
    const result = await runToolContract(openlibraryGetEditions, {
      work_id: 'OL1W',
      limit: 1001,
      offset: 999,
    });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]!.slice(0, 3)).toEqual(['OL1W', 1000, 999]);
    expect(result.structuredContent).toMatchObject({
      total: 2000,
      offset: 999,
      notice: expect.stringContaining('merged record'),
    });
    expect(result.structuredContent).toMatchObject({
      notice: expect.not.stringContaining('past the end'),
    });
    expect(contentText(result)).toContain(
      'Requested limit 1001; applied limit 1000. Next offset: 999.',
    );
  });

  it('applies a limit at the 1000 ceiling with no clamp notice', async () => {
    const svc = (
      await import('@/services/open-library/open-library-service.js')
    ).getOpenLibraryService();
    const spy = vi
      .spyOn(svc, 'getEditions')
      .mockResolvedValue({ total: 6116, work_id: 'OL17732W', editions: [] });
    const result = await runToolContract(openlibraryGetEditions, {
      work_id: 'OL17732W',
      limit: 1000,
    });
    expect(spy.mock.calls[0]!.slice(0, 3)).toEqual(['OL17732W', 1000, 0]);
    expect(result.structuredContent).not.toHaveProperty('notice');
  });

  it('names the 1000 ceiling in the limit description', () => {
    expect(openlibraryGetEditions.input.shape.limit.description).toContain(
      'values above 1000 apply 1000',
    );
  });

  it('composes the merged-ID, clamp, and past-end notices in one enrichment notice', async () => {
    const svc = (
      await import('@/services/open-library/open-library-service.js')
    ).getOpenLibraryService();
    vi.spyOn(svc, 'getEditions').mockResolvedValue({ total: 3, work_id: 'OL2W', editions: [] });
    const result = await runToolContract(openlibraryGetEditions, {
      work_id: 'OL1W',
      limit: 1001,
      offset: 10,
    });
    const expected =
      'OL1W is a merged record; these are the editions of OL2W. Use OL2W for further lookups. Requested limit 1001; applied limit 1000. Offset 10 is past the end of the result set — 3 editions belong to OL2W, so the last offset that returns a result is 2. Retry with a lower offset.';
    expect(result.structuredContent).toMatchObject({ total: 3, offset: 10, notice: expected });
    expect(contentText(result)).toContain(expected);
  });

  it('renders multiline metadata, present empty publication and parent work, and zero pages literally', async () => {
    const svc = (
      await import('@/services/open-library/open-library-service.js')
    ).getOpenLibraryService();
    const edition = {
      edition_id: 'OL1M',
      title: 'A *title*\n# second',
      publish_date: '',
      publishers: ['A|B', ''],
      languages: ['eng', ''],
      isbn_10: ['*isbn*'],
      isbn_13: [],
      cover_ids: [0],
      work_id: '',
      page_count: 0,
    };
    vi.spyOn(svc, 'getEditions').mockResolvedValue({
      total: 1,
      work_id: 'OL1W',
      editions: [edition],
    });
    const result = await runToolContract(openlibraryGetEditions, { work_id: 'OL1W' });
    expect(result.structuredContent).toMatchObject({ editions: [edition] });
    const text = contentText(result);
    expect(text).toContain(`**Title:** ${escapeMarkdownInline(edition.title)}`);
    expect(text).toContain(escapeMarkdownInline('*isbn*'));
    for (const value of ['Published:', '**Work ID:** ', 'Pages: 0', '**Cover IDs:** 0'])
      expect(text).toContain(value);
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

  // ─── Not found error contract ────────────────────────────────────────────────

  it('fails as not_found when service returns null (non-existent work)', async () => {
    const svc = (
      await import('@/services/open-library/open-library-service.js')
    ).getOpenLibraryService();
    vi.spyOn(svc, 'getEditions').mockResolvedValueOnce(null);

    const result = await runToolContract(openlibraryGetEditions, { work_id: 'OL999999999W' });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.NotFound,
        data: {
          reason: 'not_found',
          // The declared hint must reach the wire, not just live in errors[].
          recovery: {
            hint: openlibraryGetEditions.errors!.find((e) => e.reason === 'not_found')!.recovery,
          },
        },
      },
    });
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
    const text = (openlibraryGetEditions.format!({ ...result, offset: 0 })[0] as { text: string })
      .text;
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
    const text = (openlibraryGetEditions.format!({ ...result, offset: 0 })[0] as { text: string })
      .text;
    expect(text).not.toContain('undefined');
    expect(text).not.toContain('null');
  });

  it('formats empty editions list correctly', () => {
    const result = { total: 200, work_id: 'OL45804W', editions: [] };
    const text = (openlibraryGetEditions.format!({ ...result, offset: 0 })[0] as { text: string })
      .text;
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

describe('openlibraryGetEditions — work_id shape', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    initOpenLibraryService();
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unmocked fetch'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('advertises the work OLID pattern in the input JSON Schema', () => {
    const schema = z.toJSONSchema(openlibraryGetEditions.input) as unknown as {
      properties: { work_id: { pattern?: string } };
    };
    expect(schema.properties.work_id.pattern).toBe('^(?:\\/works\\/)?OL\\d+W$');
  });

  it.each(NON_WORK_IDS)(
    'rejects %s at validation, naming openlibrary_get_edition, with no upstream request',
    async (_label, workId) => {
      const result = await runToolContract(openlibraryGetEditions, { work_id: workId });

      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: {
          code: JsonRpcErrorCode.InvalidParams,
          data: {
            reason: 'invalid_arguments',
            recovery: { hint: expect.stringContaining('openlibrary_get_edition') },
          },
        },
      });
      expect(contentText(result)).toContain('openlibrary_get_edition');
      expect(fetchSpy).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['a bare work OLID', 'OL893414W'],
    ['a /works/-prefixed work OLID', '/works/OL893414W'],
  ])('accepts %s and resolves it upstream', async (_label, workId) => {
    fetchSpy.mockImplementation(() => Promise.resolve(editionsPage(155, 2)));

    const result = await runToolContract(openlibraryGetEditions, { work_id: workId, limit: 2 });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ work_id: 'OL893414W', total: 155 });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('still reports a well-formed but absent work as not_found', async () => {
    fetchSpy.mockImplementation(() =>
      Promise.resolve(new Response('{}', { status: 404, statusText: 'Not Found' })),
    );

    const result = await runToolContract(openlibraryGetEditions, { work_id: 'OL999999999999W' });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.NotFound, data: { reason: 'not_found' } },
    });
  });

  it('names openlibrary_get_edition as the ISBN route in the description, work_id, and not_found recovery', () => {
    const recovery = openlibraryGetEditions.errors!.find((e) => e.reason === 'not_found')!.recovery;
    const workIdDescription = openlibraryGetEditions.input.shape.work_id.description;
    for (const text of [openlibraryGetEditions.description, workIdDescription, recovery]) {
      expect(text).toContain('openlibrary_get_edition');
      expect(text).toContain('isbn');
    }
    expect(recovery).toContain('openlibrary_search_books');
  });
});

describe('openlibraryGetEditions — offset echo', () => {
  beforeEach(() => {
    initOpenLibraryService();
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unmocked fetch'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // None of the editions endpoint's responses report an offset, so the echo is
  // the requested value on every page — including one past the end.
  it.each([
    ['the default offset', undefined, 2, 0],
    ['a mid-list offset', 5, 2, 5],
    ['an offset past the end', 100_000, 0, 100_000],
  ])('echoes %s on both surfaces', async (_label, offset, returned, expected) => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(editionsPage(155, returned));

    const result = await runToolContract(openlibraryGetEditions, {
      work_id: 'OL893414W',
      limit: 2,
      ...(offset === undefined ? {} : { offset }),
    });

    expect(result.isError).toBeFalsy();
    const structured = openlibraryGetEditions.output.parse(result.structuredContent);
    expect(structured.offset).toBe(expected);
    expect(structured.editions).toHaveLength(returned);
    expect(contentText(result)).toContain(
      `**Work ID:** OL893414W | **Total editions:** 155 | **Offset:** ${expected} | **Returned:** ${returned}`,
    );
  });
});

describe('openlibraryGetEditions — past-end notice', () => {
  beforeEach(() => {
    initOpenLibraryService();
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unmocked fetch'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    [
      'offset 5000 of 161',
      161,
      5000,
      'Offset 5000 is past the end of the result set — 161 editions belong to OL45804W, so the last offset that returns a result is 160. Retry with a lower offset.',
    ],
    [
      'the offset equal to the total',
      161,
      161,
      'Offset 161 is past the end of the result set — 161 editions belong to OL45804W, so the last offset that returns a result is 160. Retry with a lower offset.',
    ],
    [
      'offset 1 of a single edition',
      1,
      1,
      'Offset 1 is past the end of the result set — 1 edition belongs to OL45804W, so the last offset that returns a result is 0. Retry with a lower offset.',
    ],
  ])('discloses %s on both surfaces', async (_label, total, offset, notice) => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(editionsPage(total, 0));

    const result = await runToolContract(openlibraryGetEditions, { work_id: 'OL45804W', offset });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ total, offset, editions: [], notice });
    expect(contentText(result)).toContain(notice);
  });

  it.each([
    ['the last offset that returns a result', 161, 160, 1],
    ['a work with no editions', 0, 0, 0],
  ])('adds no notice at %s', async (_label, total, offset, returned) => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(editionsPage(total, returned));

    const result = await runToolContract(openlibraryGetEditions, { work_id: 'OL45804W', offset });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ total, offset });
    expect(result.structuredContent).not.toHaveProperty('notice');
    expect(contentText(result)).not.toContain('past the end');
  });
});
