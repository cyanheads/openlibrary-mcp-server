/**
 * @fileoverview Tests for the openlibrary_get_cover_url tool.
 * @module tests/tools/openlibrary-get-cover-url.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { openlibraryGetCoverUrl } from '@/mcp-server/tools/definitions/openlibrary-get-cover-url.tool.js';
import { initOpenLibraryService } from '@/services/open-library/open-library-service.js';

describe('openlibraryGetCoverUrl', () => {
  beforeEach(() => {
    initOpenLibraryService();
  });

  it('returns correct URL for numeric cover ID (book)', async () => {
    const ctx = createMockContext({ errors: openlibraryGetCoverUrl.errors });
    const input = openlibraryGetCoverUrl.input.parse({
      identifier: '9255566',
      id_type: 'id',
      target: 'book',
      size: 'M',
    });
    const result = await openlibraryGetCoverUrl.handler(input, ctx);
    expect(result.url).toBe('https://covers.openlibrary.org/b/id/9255566-M.jpg');
    expect(result.note).toContain('placeholder');
  });

  it('returns correct URL for ISBN cover', async () => {
    const ctx = createMockContext({ errors: openlibraryGetCoverUrl.errors });
    const input = openlibraryGetCoverUrl.input.parse({
      identifier: '9780743273565',
      id_type: 'isbn',
      target: 'book',
      size: 'L',
    });
    const result = await openlibraryGetCoverUrl.handler(input, ctx);
    expect(result.url).toBe('https://covers.openlibrary.org/b/isbn/9780743273565-L.jpg');
  });

  it('strips hyphens from ISBN', async () => {
    const ctx = createMockContext({ errors: openlibraryGetCoverUrl.errors });
    const input = openlibraryGetCoverUrl.input.parse({
      identifier: '978-0-7432-7356-5',
      id_type: 'isbn',
      target: 'book',
      size: 'S',
    });
    const result = await openlibraryGetCoverUrl.handler(input, ctx);
    expect(result.url).toBe('https://covers.openlibrary.org/b/isbn/9780743273565-S.jpg');
  });

  it('returns author photo URL for author target', async () => {
    const ctx = createMockContext({ errors: openlibraryGetCoverUrl.errors });
    const input = openlibraryGetCoverUrl.input.parse({
      identifier: '12345',
      id_type: 'id',
      target: 'author',
      size: 'M',
    });
    const result = await openlibraryGetCoverUrl.handler(input, ctx);
    expect(result.url).toBe('https://covers.openlibrary.org/a/id/12345-M.jpg');
  });

  it('applies default size M and target book', () => {
    const input = openlibraryGetCoverUrl.input.parse({ identifier: '123', id_type: 'id' });
    expect(input.size).toBe('M');
    expect(input.target).toBe('book');
  });

  it('formats output with url and note', () => {
    const output = {
      url: 'https://covers.openlibrary.org/b/id/123-M.jpg',
      note: 'The Covers API returns HTTP 200 for all requests.',
    };
    const text = (openlibraryGetCoverUrl.format!(output)[0] as { text: string }).text;
    expect(text).toContain('https://covers.openlibrary.org/b/id/123-M.jpg');
    expect(text).toContain('HTTP 200');
  });
});
