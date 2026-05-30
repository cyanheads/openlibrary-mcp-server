/**
 * @fileoverview Edge case and security tests for the openlibrary_get_cover_url tool.
 * @module tests/tools/openlibrary-get-cover-url-edge.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { openlibraryGetCoverUrl } from '@/mcp-server/tools/definitions/openlibrary-get-cover-url.tool.js';
import { initOpenLibraryService } from '@/services/open-library/open-library-service.js';

describe('openlibraryGetCoverUrl — edge cases and security', () => {
  beforeEach(() => {
    initOpenLibraryService();
  });

  // ─── Size variants ──────────────────────────────────────────────────────────

  it('returns S size URL', () => {
    const ctx = createMockContext();
    const input = openlibraryGetCoverUrl.input.parse({
      identifier: '123',
      id_type: 'id',
      size: 'S',
    });
    const result = openlibraryGetCoverUrl.handler(input, ctx);
    expect(result.url).toContain('-S.jpg');
  });

  it('returns L size URL', () => {
    const ctx = createMockContext();
    const input = openlibraryGetCoverUrl.input.parse({
      identifier: '123',
      id_type: 'id',
      size: 'L',
    });
    const result = openlibraryGetCoverUrl.handler(input, ctx);
    expect(result.url).toContain('-L.jpg');
  });

  // ─── OLID variants ──────────────────────────────────────────────────────────

  it('returns book cover URL for olid id_type', () => {
    const ctx = createMockContext();
    const input = openlibraryGetCoverUrl.input.parse({
      identifier: 'OL7353617M',
      id_type: 'olid',
      target: 'book',
      size: 'M',
    });
    const result = openlibraryGetCoverUrl.handler(input, ctx);
    expect(result.url).toBe('https://covers.openlibrary.org/b/olid/OL7353617M-M.jpg');
  });

  it('returns author photo URL for olid id_type with author target', () => {
    const ctx = createMockContext();
    const input = openlibraryGetCoverUrl.input.parse({
      identifier: 'OL24638A',
      id_type: 'olid',
      target: 'author',
      size: 'M',
    });
    const result = openlibraryGetCoverUrl.handler(input, ctx);
    expect(result.url).toBe('https://covers.openlibrary.org/a/olid/OL24638A-M.jpg');
  });

  // ─── URL structure assertions ───────────────────────────────────────────────

  it('always returns HTTPS URL (not HTTP)', () => {
    const ctx = createMockContext();
    const input = openlibraryGetCoverUrl.input.parse({ identifier: '9999', id_type: 'id' });
    const result = openlibraryGetCoverUrl.handler(input, ctx);
    expect(result.url.startsWith('https://')).toBe(true);
  });

  it('URL contains covers.openlibrary.org domain', () => {
    const ctx = createMockContext();
    const input = openlibraryGetCoverUrl.input.parse({ identifier: '9999', id_type: 'id' });
    const result = openlibraryGetCoverUrl.handler(input, ctx);
    expect(result.url).toContain('covers.openlibrary.org');
  });

  // ─── Security: path traversal and injection in identifier ──────────────────

  it('does not produce a path-traversal URL from identifier with slashes', () => {
    const ctx = createMockContext();
    // An identifier containing path-traversal chars should be passed verbatim to
    // the URL builder; openlibrary.org will reject it. What we assert here is that
    // the server does not strip the characters silently and produce a different
    // identifier-path than what the caller supplied.
    const input = openlibraryGetCoverUrl.input.parse({
      identifier: '123/../456',
      id_type: 'id',
    });
    const result = openlibraryGetCoverUrl.handler(input, ctx);
    // The URL must contain the original identifier, not a resolved path
    expect(result.url).toContain('123/../456');
  });

  it('strips hyphens from ISBN identifier (not from olid or id)', () => {
    const ctx = createMockContext();
    const input = openlibraryGetCoverUrl.input.parse({
      identifier: '978-0-7432-7356-5',
      id_type: 'isbn',
      target: 'book',
      size: 'M',
    });
    const result = openlibraryGetCoverUrl.handler(input, ctx);
    // Hyphens stripped for isbn
    expect(result.url).not.toContain('-978-');
    expect(result.url).toContain('9780743273565');
  });

  it('does NOT strip hyphens from olid identifier', () => {
    const ctx = createMockContext();
    const input = openlibraryGetCoverUrl.input.parse({
      identifier: 'OL735-3617M',
      id_type: 'olid',
      target: 'book',
      size: 'M',
    });
    const result = openlibraryGetCoverUrl.handler(input, ctx);
    // Non-ISBN identifiers pass through unchanged
    expect(result.url).toContain('OL735-3617M');
  });

  // ─── Invalid enum values rejected by schema ─────────────────────────────────

  it('rejects invalid id_type', () => {
    expect(() =>
      openlibraryGetCoverUrl.input.parse({ identifier: '123', id_type: 'doi' }),
    ).toThrow();
  });

  it('rejects invalid size', () => {
    expect(() =>
      openlibraryGetCoverUrl.input.parse({ identifier: '123', id_type: 'id', size: 'XL' }),
    ).toThrow();
  });

  it('rejects invalid target', () => {
    expect(() =>
      openlibraryGetCoverUrl.input.parse({ identifier: '123', id_type: 'id', target: 'thing' }),
    ).toThrow();
  });

  // ─── Note field ─────────────────────────────────────────────────────────────

  it('note always mentions placeholder', () => {
    const ctx = createMockContext();
    const input = openlibraryGetCoverUrl.input.parse({ identifier: '0', id_type: 'id' });
    const result = openlibraryGetCoverUrl.handler(input, ctx);
    expect(result.note).toContain('placeholder');
  });

  it('note always mentions HTTP 200', () => {
    const ctx = createMockContext();
    const input = openlibraryGetCoverUrl.input.parse({ identifier: '0', id_type: 'id' });
    const result = openlibraryGetCoverUrl.handler(input, ctx);
    expect(result.note).toContain('200');
  });
});
