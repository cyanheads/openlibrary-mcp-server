/**
 * @fileoverview Tests for the openlibrary_get_edition tool.
 * @module tests/tools/openlibrary-get-edition.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { openlibraryGetEdition } from '@/mcp-server/tools/definitions/openlibrary-get-edition.tool.js';
import { initOpenLibraryService } from '@/services/open-library/open-library-service.js';

const FULL_EDITION = {
  edition_id: 'OL7353617M',
  title: 'The Great Gatsby',
  authors: [{ name: 'F. Scott Fitzgerald', author_id: 'OL24638A', source: 'edition' as const }],
  publish_date: '1953',
  publishers: ['Scribner'],
  language: 'eng',
  isbn_10: ['0743273567'],
  isbn_13: ['9780743273565'],
  oclc: ['36863723'],
  /** Control number and call number are deliberately distinct — see issue #16. */
  lccn: ['00027665'],
  lc_classifications: ['PS3511.I9 G7 1953'],
  page_count: 180,
  description: 'A novel about the Roaring Twenties.',
  cover_ids: [9255566],
  work_id: 'OL45804W',
  ebook_url: 'https://archive.org/details/greatgatsby00fitz',
};

describe('openlibraryGetEdition', () => {
  beforeEach(() => {
    initOpenLibraryService();
  });

  it('rejects invalid ISBN format', async () => {
    const ctx = createMockContext({ errors: openlibraryGetEdition.errors });
    const input = openlibraryGetEdition.input.parse({ identifier: 'notanisbn', id_type: 'isbn' });

    await expect(openlibraryGetEdition.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'invalid_identifier' },
    });
  });

  it('rejects invalid OLID format', async () => {
    const ctx = createMockContext({ errors: openlibraryGetEdition.errors });
    const input = openlibraryGetEdition.input.parse({ identifier: 'OL1234', id_type: 'olid' });

    await expect(openlibraryGetEdition.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'invalid_identifier' },
    });
  });

  it('returns edition detail for valid ISBN', async () => {
    const ctx = createMockContext({ errors: openlibraryGetEdition.errors });
    const svc = (
      await import('@/services/open-library/open-library-service.js')
    ).getOpenLibraryService();
    vi.spyOn(svc, 'getEditionByIdentifier').mockResolvedValueOnce(FULL_EDITION);

    const input = openlibraryGetEdition.input.parse({
      identifier: '9780743273565',
      id_type: 'isbn',
    });
    const result = await openlibraryGetEdition.handler(input, ctx);

    expect(result.edition_id).toBe('OL7353617M');
    expect(result.work_id).toBe('OL45804W');
    expect(result.authors[0]!.name).toBe('F. Scott Fitzgerald');
  });

  it('throws not_found for missing edition', async () => {
    const ctx = createMockContext({ errors: openlibraryGetEdition.errors });
    const svc = (
      await import('@/services/open-library/open-library-service.js')
    ).getOpenLibraryService();
    vi.spyOn(svc, 'getEditionByIdentifier').mockRejectedValueOnce({
      code: JsonRpcErrorCode.NotFound,
      message: 'Edition not found',
    });

    const input = openlibraryGetEdition.input.parse({ identifier: 'OL9999M', id_type: 'olid' });
    await expect(openlibraryGetEdition.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
    });
  });

  it('formats edition with all fields', () => {
    const blocks = openlibraryGetEdition.format!(FULL_EDITION);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('OL7353617M');
    expect(text).toContain('The Great Gatsby');
    expect(text).toContain('F. Scott Fitzgerald');
    expect(text).toContain('OL24638A');
    expect(text).toContain('9780743273565');
    expect(text).toContain('OL45804W');
    expect(text).toContain('https://archive.org/details/greatgatsby00fitz');
  });

  it('renders the control number and the call number as separate, differently-labelled fields', () => {
    const text = (openlibraryGetEdition.format!(FULL_EDITION)[0] as { text: string }).text;
    expect(text).toContain('**LCCN:** 00027665');
    expect(text).toContain('**LC call number:** PS3511.I9 G7 1953');
    // The call number must never be presented as the lookupable identifier.
    expect(text).not.toContain('**LCCN:** PS3511.I9 G7 1953');
  });

  it('labels work-level attribution rather than presenting it as edition data', () => {
    const workSourced = {
      ...FULL_EDITION,
      authors: [{ name: 'George Orwell', author_id: 'OL273387A', source: 'work' as const }],
    };
    const text = (openlibraryGetEdition.format!(workSourced)[0] as { text: string }).text;
    expect(text).toContain('George Orwell');
    expect(text).toContain('from parent work');
    // Must not be rendered under the plain edition-authors heading.
    expect(text).not.toContain('**Authors:** George Orwell');
  });

  it('formats sparse edition (no optional fields)', () => {
    const sparse = {
      edition_id: 'OL1M',
      title: 'Sparse Edition',
      authors: [],
      publishers: [],
      isbn_10: [],
      isbn_13: [],
      oclc: [],
      lccn: [],
      lc_classifications: [],
      cover_ids: [],
    };
    const text = (openlibraryGetEdition.format!(sparse)[0] as { text: string }).text;
    expect(text).toContain('OL1M');
  });
});
