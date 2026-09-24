/**
 * @fileoverview Edge case and input validation tests for the openlibrary_get_editions tool.
 * @module tests/tools/openlibrary-get-editions-edge.tool.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
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

  // ─── Not found error contract ────────────────────────────────────────────────

  it('throws not_found via ctx.fail when service returns null (non-existent work)', async () => {
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
