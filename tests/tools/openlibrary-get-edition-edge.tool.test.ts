/**
 * @fileoverview Edge case and validation tests for the openlibrary_get_edition tool.
 * @module tests/tools/openlibrary-get-edition-edge.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { openlibraryGetEdition } from '@/mcp-server/tools/definitions/openlibrary-get-edition.tool.js';
import { initOpenLibraryService } from '@/services/open-library/open-library-service.js';

const FULL_EDITION = {
  edition_id: 'OL7353617M',
  title: 'The Great Gatsby',
  authors: [{ name: 'F. Scott Fitzgerald', author_id: 'OL24638A' }],
  publish_date: '1953',
  publishers: ['Scribner'],
  language: 'eng',
  isbn_10: ['0743273567'],
  isbn_13: ['9780743273565'],
  oclc: ['36863723'],
  lccn: ['00027665'],
  page_count: 180,
  description: 'A novel about the Roaring Twenties.',
  cover_ids: [9255566],
  work_id: 'OL45804W',
  ebook_url: 'https://archive.org/details/greatgatsby00fitz',
};

describe('openlibraryGetEdition — edge cases', () => {
  beforeEach(() => {
    initOpenLibraryService();
  });

  // ─── ISBN validation ────────────────────────────────────────────────────────

  it('accepts ISBN-10 with hyphens', async () => {
    const ctx = createMockContext({ errors: openlibraryGetEdition.errors });
    const svc = (
      await import('@/services/open-library/open-library-service.js')
    ).getOpenLibraryService();
    const spy = vi.spyOn(svc, 'getEditionByIdentifier').mockResolvedValueOnce(FULL_EDITION);

    const input = openlibraryGetEdition.input.parse({
      identifier: '0-7432-7356-7',
      id_type: 'isbn',
    });
    await openlibraryGetEdition.handler(input, ctx);
    expect(spy).toHaveBeenCalled();
  });

  it('accepts ISBN-13 with hyphens', async () => {
    const ctx = createMockContext({ errors: openlibraryGetEdition.errors });
    const svc = (
      await import('@/services/open-library/open-library-service.js')
    ).getOpenLibraryService();
    const spy = vi.spyOn(svc, 'getEditionByIdentifier').mockResolvedValueOnce(FULL_EDITION);

    const input = openlibraryGetEdition.input.parse({
      identifier: '978-0-7432-7356-5',
      id_type: 'isbn',
    });
    await openlibraryGetEdition.handler(input, ctx);
    expect(spy).toHaveBeenCalled();
  });

  it('rejects ISBN shorter than 10 digits after stripping hyphens', async () => {
    const ctx = createMockContext({ errors: openlibraryGetEdition.errors });
    const input = openlibraryGetEdition.input.parse({ identifier: '12345', id_type: 'isbn' });
    await expect(openlibraryGetEdition.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'invalid_identifier' },
    });
  });

  it('rejects ISBN-11 (non-standard length)', async () => {
    const ctx = createMockContext({ errors: openlibraryGetEdition.errors });
    const input = openlibraryGetEdition.input.parse({ identifier: '12345678901', id_type: 'isbn' });
    await expect(openlibraryGetEdition.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'invalid_identifier' },
    });
  });

  // ─── OLID validation ────────────────────────────────────────────────────────

  it('accepts uppercase OLID format', async () => {
    const ctx = createMockContext({ errors: openlibraryGetEdition.errors });
    const svc = (
      await import('@/services/open-library/open-library-service.js')
    ).getOpenLibraryService();
    const spy = vi.spyOn(svc, 'getEditionByIdentifier').mockResolvedValueOnce(FULL_EDITION);

    const input = openlibraryGetEdition.input.parse({ identifier: 'OL7353617M', id_type: 'olid' });
    await openlibraryGetEdition.handler(input, ctx);
    expect(spy).toHaveBeenCalled();
  });

  it('accepts lowercase olid pattern (ol1234m)', async () => {
    const ctx = createMockContext({ errors: openlibraryGetEdition.errors });
    const svc = (
      await import('@/services/open-library/open-library-service.js')
    ).getOpenLibraryService();
    const spy = vi.spyOn(svc, 'getEditionByIdentifier').mockResolvedValueOnce(FULL_EDITION);

    const input = openlibraryGetEdition.input.parse({ identifier: 'ol7353617m', id_type: 'olid' });
    await openlibraryGetEdition.handler(input, ctx);
    expect(spy).toHaveBeenCalled();
  });

  it('rejects OLID with wrong suffix (A instead of M)', async () => {
    const ctx = createMockContext({ errors: openlibraryGetEdition.errors });
    const input = openlibraryGetEdition.input.parse({ identifier: 'OL7353617A', id_type: 'olid' });
    await expect(openlibraryGetEdition.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'invalid_identifier' },
    });
  });

  it('rejects OLID without numeric segment', async () => {
    const ctx = createMockContext({ errors: openlibraryGetEdition.errors });
    const input = openlibraryGetEdition.input.parse({ identifier: 'OLM', id_type: 'olid' });
    await expect(openlibraryGetEdition.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'invalid_identifier' },
    });
  });

  // ─── OCLC and LCCN paths ────────────────────────────────────────────────────

  it('accepts oclc id_type and passes to service', async () => {
    const ctx = createMockContext({ errors: openlibraryGetEdition.errors });
    const svc = (
      await import('@/services/open-library/open-library-service.js')
    ).getOpenLibraryService();
    const spy = vi.spyOn(svc, 'getEditionByIdentifier').mockResolvedValueOnce(FULL_EDITION);

    const input = openlibraryGetEdition.input.parse({
      identifier: '36863723',
      id_type: 'oclc',
    });
    const result = await openlibraryGetEdition.handler(input, ctx);
    expect(spy).toHaveBeenCalledWith('36863723', 'oclc', ctx);
    expect(result.edition_id).toBe('OL7353617M');
  });

  it('accepts lccn id_type and passes to service', async () => {
    const ctx = createMockContext({ errors: openlibraryGetEdition.errors });
    const svc = (
      await import('@/services/open-library/open-library-service.js')
    ).getOpenLibraryService();
    const spy = vi.spyOn(svc, 'getEditionByIdentifier').mockResolvedValueOnce(FULL_EDITION);

    const input = openlibraryGetEdition.input.parse({
      identifier: '00027665',
      id_type: 'lccn',
    });
    await openlibraryGetEdition.handler(input, ctx);
    expect(spy).toHaveBeenCalledWith('00027665', 'lccn', ctx);
  });

  // ─── not_found error from service ──────────────────────────────────────────

  it('propagates not_found for OCLC identifier', async () => {
    const ctx = createMockContext({ errors: openlibraryGetEdition.errors });
    const svc = (
      await import('@/services/open-library/open-library-service.js')
    ).getOpenLibraryService();
    vi.spyOn(svc, 'getEditionByIdentifier').mockRejectedValueOnce({
      code: JsonRpcErrorCode.NotFound,
      message: 'Edition not found for OCLC',
    });

    const input = openlibraryGetEdition.input.parse({ identifier: '9999999', id_type: 'oclc' });
    await expect(openlibraryGetEdition.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
    });
  });

  // ─── Format edge cases ──────────────────────────────────────────────────────

  it('formats edition with author without author_id', () => {
    const edition = {
      ...FULL_EDITION,
      authors: [{ name: 'Anonymous Author' }],
    };
    const text = (openlibraryGetEdition.format!(edition)[0] as { text: string }).text;
    expect(text).toContain('Anonymous Author');
    // Should not show parenthetical ID
    expect(text).not.toContain('undefined');
  });

  it('formats edition without ebook url', () => {
    const edition = { ...FULL_EDITION, ebook_url: undefined };
    const text = (openlibraryGetEdition.format!(edition)[0] as { text: string }).text;
    expect(text).not.toContain('E-book:');
  });

  it('format output does not contain null or undefined strings', () => {
    const sparse = {
      edition_id: 'OL1M',
      title: 'Sparse',
      authors: [],
      publishers: [],
      isbn_10: [],
      isbn_13: [],
      oclc: [],
      lccn: [],
      cover_ids: [],
    };
    const text = (openlibraryGetEdition.format!(sparse)[0] as { text: string }).text;
    expect(text).not.toContain('undefined');
    expect(text).not.toContain('null');
  });
});
