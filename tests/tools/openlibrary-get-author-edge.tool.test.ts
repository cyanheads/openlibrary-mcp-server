/**
 * @fileoverview Edge case and security tests for the openlibrary_get_author tool.
 * @module tests/tools/openlibrary-get-author-edge.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { openlibraryGetAuthor } from '@/mcp-server/tools/definitions/openlibrary-get-author.tool.js';
import { initOpenLibraryService } from '@/services/open-library/open-library-service.js';

describe('openlibraryGetAuthor — edge cases and security', () => {
  beforeEach(() => {
    initOpenLibraryService();
  });

  // ─── Prefix stripping ────────────────────────────────────────────────────────

  it('passes /authors/ prefix to service unchanged (service strips it)', async () => {
    const ctx = createMockContext({ errors: openlibraryGetAuthor.errors });
    const svc = (
      await import('@/services/open-library/open-library-service.js')
    ).getOpenLibraryService();
    const spy = vi.spyOn(svc, 'getAuthor').mockResolvedValueOnce({
      author_id: 'OL24638A',
      name: 'F. Scott Fitzgerald',
      photo_ids: [],
      remote_ids: {},
    });

    const input = openlibraryGetAuthor.input.parse({ author_id: '/authors/OL24638A' });
    await openlibraryGetAuthor.handler(input, ctx);

    expect(spy).toHaveBeenCalledWith('/authors/OL24638A', ctx);
  });

  // ─── Service error types ─────────────────────────────────────────────────────

  it('propagates service unavailable error', async () => {
    const ctx = createMockContext({ errors: openlibraryGetAuthor.errors });
    const svc = (
      await import('@/services/open-library/open-library-service.js')
    ).getOpenLibraryService();
    vi.spyOn(svc, 'getAuthor').mockRejectedValueOnce(
      new Error('Service unavailable — API returned HTML instead of JSON.'),
    );

    const input = openlibraryGetAuthor.input.parse({ author_id: 'OL24638A' });
    await expect(openlibraryGetAuthor.handler(input, ctx)).rejects.toThrow('Service unavailable');
  });

  it('propagates not_found as NotFound code', async () => {
    const ctx = createMockContext({ errors: openlibraryGetAuthor.errors });
    const svc = (
      await import('@/services/open-library/open-library-service.js')
    ).getOpenLibraryService();
    vi.spyOn(svc, 'getAuthor').mockRejectedValueOnce({
      code: JsonRpcErrorCode.NotFound,
      message: 'Author not found',
    });

    const input = openlibraryGetAuthor.input.parse({ author_id: 'OL999999A' });
    await expect(openlibraryGetAuthor.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
    });
  });

  // ─── Sparse payload — only required fields ───────────────────────────────────

  it('handles author with empty remote_ids', async () => {
    const ctx = createMockContext({ errors: openlibraryGetAuthor.errors });
    const svc = (
      await import('@/services/open-library/open-library-service.js')
    ).getOpenLibraryService();
    vi.spyOn(svc, 'getAuthor').mockResolvedValueOnce({
      author_id: 'OL1A',
      name: 'Sparse Author',
      photo_ids: [],
      remote_ids: {},
    });

    const input = openlibraryGetAuthor.input.parse({ author_id: 'OL1A' });
    const result = await openlibraryGetAuthor.handler(input, ctx);
    expect(result.remote_ids).toEqual({});
    expect(result.photo_ids).toHaveLength(0);
  });

  it('handles author with multiple photo_ids', async () => {
    const ctx = createMockContext({ errors: openlibraryGetAuthor.errors });
    const svc = (
      await import('@/services/open-library/open-library-service.js')
    ).getOpenLibraryService();
    vi.spyOn(svc, 'getAuthor').mockResolvedValueOnce({
      author_id: 'OL24638A',
      name: 'Well Photographed Author',
      photo_ids: [111, 222, 333],
      remote_ids: {},
    });

    const input = openlibraryGetAuthor.input.parse({ author_id: 'OL24638A' });
    const result = await openlibraryGetAuthor.handler(input, ctx);
    expect(result.photo_ids).toEqual([111, 222, 333]);
  });

  // ─── Format edge cases ───────────────────────────────────────────────────────

  it('format shows all remote_id types when present', () => {
    const full = {
      author_id: 'OL1A',
      name: 'Rich Author',
      photo_ids: [1],
      remote_ids: {
        wikidata: 'Q123',
        viaf: '456',
        isni: '0000000123',
        goodreads: '789',
        librarything: 'richauthor',
      },
    };
    const text = (openlibraryGetAuthor.format!(full)[0] as { text: string }).text;
    expect(text).toContain('wikidata');
    expect(text).toContain('Q123');
    expect(text).toContain('viaf');
    expect(text).toContain('456');
    expect(text).toContain('isni');
    expect(text).toContain('goodreads');
    expect(text).toContain('librarything');
  });

  it('format does not emit external_ids section when remote_ids is empty', () => {
    const sparse = {
      author_id: 'OL1A',
      name: 'Author',
      photo_ids: [],
      remote_ids: {},
    };
    const text = (openlibraryGetAuthor.format!(sparse)[0] as { text: string }).text;
    expect(text).not.toContain('External IDs');
  });

  it('format does not emit undefined or null literals', () => {
    const sparse = {
      author_id: 'OL1A',
      name: 'Author',
      photo_ids: [],
      remote_ids: {},
    };
    const text = (openlibraryGetAuthor.format!(sparse)[0] as { text: string }).text;
    expect(text).not.toContain('undefined');
    expect(text).not.toContain('null');
  });

  it('format renders bio block when present', () => {
    const withBio = {
      author_id: 'OL1A',
      name: 'Biographical Author',
      bio: 'A deeply interesting person who wrote many things.',
      photo_ids: [],
      remote_ids: {},
    };
    const text = (openlibraryGetAuthor.format!(withBio)[0] as { text: string }).text;
    expect(text).toContain('A deeply interesting person');
  });
});
