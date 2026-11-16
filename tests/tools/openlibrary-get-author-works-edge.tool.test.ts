/**
 * @fileoverview Edge case and input validation tests for openlibrary_get_author_works.
 * @module tests/tools/openlibrary-get-author-works-edge.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openlibraryGetAuthorWorks } from '@/mcp-server/tools/definitions/openlibrary-get-author-works.tool.js';
import { initOpenLibraryService } from '@/services/open-library/open-library-service.js';

function contentText(result: { content: unknown[] }): string {
  return result.content
    .map((block) => (block && typeof block === 'object' && 'text' in block ? block.text : ''))
    .join('\n');
}

describe('openlibraryGetAuthorWorks — edge cases', () => {
  beforeEach(() => {
    initOpenLibraryService();
  });

  // ─── Input validation ───────────────────────────────────────────────────────

  it('rejects limit below 1', () => {
    expect(() =>
      openlibraryGetAuthorWorks.input.parse({ author_id: 'OL24638A', limit: 0 }),
    ).toThrow();
  });

  it('accepts a limit above the page ceiling for clamping', () => {
    expect(
      openlibraryGetAuthorWorks.input.parse({ author_id: 'OL24638A', limit: 1001 }).limit,
    ).toBe(1001);
  });

  it('rejects negative offset', () => {
    expect(() =>
      openlibraryGetAuthorWorks.input.parse({ author_id: 'OL24638A', offset: -1 }),
    ).toThrow();
  });

  // ─── Pagination boundaries ──────────────────────────────────────────────────

  it('accepts limit 1 (minimum)', () => {
    const input = openlibraryGetAuthorWorks.input.parse({ author_id: 'OL24638A', limit: 1 });
    expect(input.limit).toBe(1);
  });

  it('accepts limit 1000 (page ceiling)', () => {
    const input = openlibraryGetAuthorWorks.input.parse({ author_id: 'OL24638A', limit: 1000 });
    expect(input.limit).toBe(1000);
  });

  // ─── Not found error contract ────────────────────────────────────────────────

  it('fails as not_found when service returns null (non-existent author)', async () => {
    const svc = (
      await import('@/services/open-library/open-library-service.js')
    ).getOpenLibraryService();
    vi.spyOn(svc, 'getAuthorWorks').mockResolvedValueOnce(null);

    const result = await runToolContract(openlibraryGetAuthorWorks, {
      author_id: 'OL999999999A',
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.NotFound,
        data: {
          reason: 'not_found',
          // The declared hint must reach the wire, not just live in errors[].
          recovery: {
            hint: openlibraryGetAuthorWorks.errors!.find((e) => e.reason === 'not_found')!.recovery,
          },
        },
      },
    });
    const text = contentText(result);
    expect(text).toContain('not_found');
    expect(text).toContain(
      openlibraryGetAuthorWorks.errors!.find((e) => e.reason === 'not_found')!.recovery,
    );
  });

  // ─── Empty works list ────────────────────────────────────────────────────────

  it('handles author with zero works', async () => {
    const ctx = createMockContext({ errors: openlibraryGetAuthorWorks.errors });
    const svc = (
      await import('@/services/open-library/open-library-service.js')
    ).getOpenLibraryService();
    vi.spyOn(svc, 'getAuthorWorks').mockResolvedValueOnce({
      total: 0,
      author_id: 'OL24638A',
      works: [],
    });

    const input = openlibraryGetAuthorWorks.input.parse({ author_id: 'OL24638A' });
    const result = await openlibraryGetAuthorWorks.handler(input, ctx);

    expect(result.total).toBe(0);
    expect(result.works).toHaveLength(0);
  });

  // ─── Prefix stripping in author_id ──────────────────────────────────────────

  it('passes /authors/ prefix to service unchanged (service strips it)', async () => {
    const ctx = createMockContext({ errors: openlibraryGetAuthorWorks.errors });
    const svc = (
      await import('@/services/open-library/open-library-service.js')
    ).getOpenLibraryService();
    const spy = vi.spyOn(svc, 'getAuthorWorks').mockResolvedValueOnce({
      total: 1,
      author_id: 'OL24638A',
      works: [],
    });

    const input = openlibraryGetAuthorWorks.input.parse({
      author_id: '/authors/OL24638A',
    });
    await openlibraryGetAuthorWorks.handler(input, ctx);

    // Handler passes to service as-is; service strips the prefix
    expect(spy).toHaveBeenCalledWith(
      '/authors/OL24638A',
      expect.any(Number),
      expect.any(Number),
      ctx,
    );
  });

  // ─── Format completeness ─────────────────────────────────────────────────────

  it('format does not emit undefined or null literals', () => {
    const result = {
      total: 1,
      author_id: 'OL24638A',
      works: [
        {
          work_id: 'OL1W',
          title: 'Minimal Work',
          cover_ids: [],
          // first_publish_date absent
        },
      ],
    };
    const text = (
      openlibraryGetAuthorWorks.format!({ ...result, offset: 0 })[0] as { text: string }
    ).text;
    expect(text).not.toContain('undefined');
    expect(text).not.toContain('null');
  });

  it('formats works with multiple cover IDs', () => {
    const result = {
      total: 1,
      author_id: 'OL1A',
      works: [
        {
          work_id: 'OL1W',
          title: 'Multi-cover Work',
          cover_ids: [111, 222, 333],
        },
      ],
    };
    const text = (
      openlibraryGetAuthorWorks.format!({ ...result, offset: 0 })[0] as { text: string }
    ).text;
    expect(text).toContain('111');
    expect(text).toContain('222');
    expect(text).toContain('333');
  });
});

describe('openlibraryGetAuthorWorks — offset echo', () => {
  /** An `authors/{id}/works.json` page as Open Library returns it. */
  function worksPage(size: number, count: number): Record<string, unknown> {
    return {
      size,
      entries: Array.from({ length: count }, (_, i) => ({
        key: `/works/OL${i + 1}W`,
        title: `Work ${i + 1}`,
      })),
    };
  }

  /** Routes by URL fragment; anything unrouted 404s as an unknown record does. */
  function route(routes: Record<string, unknown>) {
    return vi.spyOn(globalThis, 'fetch').mockImplementation(((input: unknown) => {
      const url = String(input instanceof Request ? input.url : input);
      for (const [fragment, body] of Object.entries(routes)) {
        if (url.includes(fragment)) {
          return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
        }
      }
      return Promise.resolve(new Response('{}', { status: 404 }));
    }) as typeof globalThis.fetch);
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
    route({ '/authors/OL34184A/works.json': worksPage(640, returned) });

    const result = await runToolContract(openlibraryGetAuthorWorks, {
      author_id: 'OL34184A',
      limit: 2,
      ...(offset === undefined ? {} : { offset }),
    });

    expect(result.isError).toBeFalsy();
    const structured = openlibraryGetAuthorWorks.output.parse(result.structuredContent);
    expect(structured.offset).toBe(expected);
    expect(structured.works).toHaveLength(returned);
    expect(contentText(result)).toContain(
      `**Author ID:** OL34184A | **Total works:** 640 | **Offset:** ${expected} | **Returned:** ${returned}`,
    );
  });

  // The works come back from a second request under the canonical ID; the echo
  // is still the offset the caller asked for.
  it('echoes the requested offset after following a merged-author redirect', async () => {
    const fetchSpy = route({
      '/authors/OL2162284A.json': {
        key: '/authors/OL2162284A',
        type: { key: '/type/redirect' },
        location: '/authors/OL19981A',
      },
      '/authors/OL19981A.json': { key: '/authors/OL19981A', type: { key: '/type/author' } },
      '/authors/OL19981A/works.json': worksPage(900, 2),
    });

    const result = await runToolContract(openlibraryGetAuthorWorks, {
      author_id: 'OL2162284A',
      limit: 2,
      offset: 40,
    });

    const structured = openlibraryGetAuthorWorks.output.parse(result.structuredContent);
    expect(structured.author_id).toBe('OL19981A');
    expect(structured.offset).toBe(40);
    expect(contentText(result)).toContain('**Offset:** 40 | **Returned:** 2');
    expect(String(fetchSpy.mock.calls.at(-1)?.[0])).toContain('offset=40');
  });

  // ─── Past-end pages ─────────────────────────────────────────────────────────

  // Open Library can report a `size` above the rows it serves (OL31353A: 271
  // reported, 270 served), so offset 270 is empty though below the total.
  it.each([270, 271, 5000])(
    'discloses an empty page at offset %i on both surfaces without claiming a last offset',
    async (offset) => {
      route({ '/authors/OL31353A/works.json': worksPage(271, 0) });

      const result = await runToolContract(openlibraryGetAuthorWorks, {
        author_id: 'OL31353A',
        offset,
      });

      expect(result.isError).toBeFalsy();
      const notice = `Offset ${offset} is past the end of the result set — 271 works are listed for OL31353A, though Open Library's count can include works it no longer serves, so the list can end before 271. Retry with a lower offset.`;
      expect(result.structuredContent).toMatchObject({ total: 271, offset, works: [], notice });
      expect(contentText(result)).toContain(notice);
      expect(contentText(result)).not.toContain('last offset');
    },
  );

  it('adds no past-end notice for an author with no works', async () => {
    route({ '/authors/OL1A/works.json': worksPage(0, 0) });

    const result = await runToolContract(openlibraryGetAuthorWorks, { author_id: 'OL1A' });

    expect(result.structuredContent).toMatchObject({ total: 0, works: [] });
    expect(result.structuredContent).not.toHaveProperty('notice');
  });

  it('composes the past-end notice with the clamp and merged-author notices', async () => {
    route({
      '/authors/OL2162284A.json': {
        key: '/authors/OL2162284A',
        type: { key: '/type/redirect' },
        location: '/authors/OL19981A',
      },
      '/authors/OL19981A.json': { key: '/authors/OL19981A', type: { key: '/type/author' } },
      '/authors/OL19981A/works.json': worksPage(900, 0),
    });

    const result = await runToolContract(openlibraryGetAuthorWorks, {
      author_id: 'OL2162284A',
      limit: 1001,
      offset: 900,
    });

    expect((result.structuredContent as { notice?: string }).notice).toBe(
      "Offset 900 is past the end of the result set — 900 works are listed for OL19981A, though Open Library's count can include works it no longer serves, so the list can end before 900. Retry with a lower offset. Requested limit 1001; applied limit 1000. OL2162284A is a merged record; these are the works of OL19981A. Use OL19981A for further lookups.",
    );
  });
});
