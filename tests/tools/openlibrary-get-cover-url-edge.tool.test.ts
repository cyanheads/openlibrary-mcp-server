/**
 * @fileoverview Edge case and security tests for the openlibrary_get_cover_url tool.
 * @module tests/tools/openlibrary-get-cover-url-edge.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { openlibraryGetCoverUrl } from '@/mcp-server/tools/definitions/openlibrary-get-cover-url.tool.js';
import {
  getOpenLibraryService,
  initOpenLibraryService,
} from '@/services/open-library/open-library-service.js';

/** Invokes a synchronous handler and returns whatever it throws (or undefined). */
function caught(fn: () => unknown): unknown {
  try {
    fn();
    return;
  } catch (err) {
    return err;
  }
}

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

  it('rejects an identifier with path separators instead of building a traversal URL', () => {
    const ctx = createMockContext({ errors: openlibraryGetCoverUrl.errors });
    const input = openlibraryGetCoverUrl.input.parse({
      identifier: '123/../456',
      id_type: 'id',
    });
    // Pre-fix this returned covers.openlibrary.org/b/id/123/../456-M.jpg, which the
    // CDN collapsed to a different cover (456). The identifier must now be rejected
    // locally so the caller-supplied value can never be reinterpreted.
    const error = caught(() => openlibraryGetCoverUrl.handler(input, ctx));
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'invalid_identifier' },
    });
  });

  it('rejects an identifier containing a control character', () => {
    const ctx = createMockContext({ errors: openlibraryGetCoverUrl.errors });
    const input = openlibraryGetCoverUrl.input.parse({
      identifier: `12${String.fromCharCode(0x1f)}34`,
      id_type: 'id',
    });
    const error = caught(() => openlibraryGetCoverUrl.handler(input, ctx));
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'invalid_identifier' },
    });
  });

  it('rejects the author target with isbn id_type as an incompatible combination', () => {
    const ctx = createMockContext({ errors: openlibraryGetCoverUrl.errors });
    const input = openlibraryGetCoverUrl.input.parse({
      identifier: '9780743273565',
      id_type: 'isbn',
      target: 'author',
    });
    const error = caught(() => openlibraryGetCoverUrl.handler(input, ctx));
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'invalid_target' },
    });
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

  // Hyphens are an ISBN convention only — an OLID carrying one is malformed, and
  // passing it through built a URL that could only ever serve the placeholder.
  it('rejects a hyphenated OLID rather than passing it through into the URL', () => {
    const ctx = createMockContext({ errors: openlibraryGetCoverUrl.errors });
    const input = openlibraryGetCoverUrl.input.parse({
      identifier: 'OL735-3617M',
      id_type: 'olid',
      target: 'book',
      size: 'M',
    });
    expect(caught(() => openlibraryGetCoverUrl.handler(input, ctx))).toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'invalid_identifier' },
    });
  });

  // ─── Per-id_type format validation ──────────────────────────────────────────

  // The Covers API answers every request with HTTP 200 and a 1×1 placeholder GIF,
  // so a malformed identifier is indistinguishable from a coverless book once the
  // URL is built. Each row below produced a confident, permanently-blank URL.
  it.each([
    ['abc-not-an-isbn', 'isbn', 'book'],
    ['notanumber', 'id', 'book'],
    ['12abc', 'id', 'author'],
    ['OL24638A', 'olid', 'book'],
    ['OL7353617M', 'olid', 'author'],
    ['OL7353617', 'olid', 'book'],
  ])('rejects %s as an identifier for id_type %s / target %s', (identifier, idType, target) => {
    const ctx = createMockContext({ errors: openlibraryGetCoverUrl.errors });
    const input = openlibraryGetCoverUrl.input.parse({ identifier, id_type: idType, target });
    expect(caught(() => openlibraryGetCoverUrl.handler(input, ctx))).toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: {
        reason: 'invalid_identifier',
        recovery: {
          hint: openlibraryGetCoverUrl.errors!.find((e) => e.reason === 'invalid_identifier')!
            .recovery,
        },
      },
    });
  });

  it('names the shape the identifier was expected to have', () => {
    const ctx = createMockContext({ errors: openlibraryGetCoverUrl.errors });
    const input = openlibraryGetCoverUrl.input.parse({
      identifier: 'OL7353617M',
      id_type: 'olid',
      target: 'author',
    });
    expect(caught(() => openlibraryGetCoverUrl.handler(input, ctx))).toMatchObject({
      message: expect.stringContaining('author OLID ending in A'),
    });
  });

  // The service is the enforcement seam for callers that bypass the tool.
  it('rejects a malformed identifier at the service seam too', () => {
    const svc = getOpenLibraryService();
    expect(caught(() => svc.getCoverUrl('abc', 'isbn', 'book', 'M'))).toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'invalid_identifier' },
    });
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
