/**
 * @fileoverview Edge case and validation tests for the openlibrary_get_edition tool.
 * @module tests/tools/openlibrary-get-edition-edge.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { openlibraryGetEdition } from '@/mcp-server/tools/definitions/openlibrary-get-edition.tool.js';
import {
  getOpenLibraryService,
  initOpenLibraryService,
} from '@/services/open-library/open-library-service.js';

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

/**
 * Runs the handler with one identifier and reports which identifiers reached the
 * service. An empty array means the value was rejected before any upstream call.
 */
async function identifiersSentUpstream(identifier: string, idType: string): Promise<string[]> {
  const ctx = createMockContext({ errors: openlibraryGetEdition.errors });
  const spy = vi
    .spyOn(getOpenLibraryService(), 'getEditionsByIdentifiers')
    .mockResolvedValue({ editions: [FULL_EDITION], unresolved: [] });
  const input = openlibraryGetEdition.input.parse({ identifiers: [identifier], id_type: idType });
  await Promise.resolve(openlibraryGetEdition.handler(input, ctx)).catch(() => undefined);
  return (spy.mock.calls[0]?.[0] as string[] | undefined) ?? [];
}

describe('openlibraryGetEdition — edge cases', () => {
  beforeEach(() => {
    initOpenLibraryService();
    vi.restoreAllMocks();
  });

  // ─── ISBN validation ────────────────────────────────────────────────────────

  it('accepts ISBN-10 with hyphens', async () => {
    expect(await identifiersSentUpstream('0-7432-7356-7', 'isbn')).toEqual(['0-7432-7356-7']);
  });

  it('accepts ISBN-13 with hyphens', async () => {
    expect(await identifiersSentUpstream('978-0-7432-7356-5', 'isbn')).toEqual([
      '978-0-7432-7356-5',
    ]);
  });

  it('rejects ISBN shorter than 10 digits after stripping hyphens', async () => {
    expect(await identifiersSentUpstream('12345', 'isbn')).toEqual([]);
  });

  it('rejects ISBN-11 (non-standard length)', async () => {
    expect(await identifiersSentUpstream('12345678901', 'isbn')).toEqual([]);
  });

  // ─── OLID validation ────────────────────────────────────────────────────────

  it('accepts uppercase OLID format', async () => {
    expect(await identifiersSentUpstream('OL7353617M', 'olid')).toEqual(['OL7353617M']);
  });

  it('accepts lowercase olid pattern (ol1234m)', async () => {
    expect(await identifiersSentUpstream('ol7353617m', 'olid')).toEqual(['ol7353617m']);
  });

  it('rejects OLID with wrong suffix (A instead of M)', async () => {
    expect(await identifiersSentUpstream('OL7353617A', 'olid')).toEqual([]);
  });

  it('rejects OLID without numeric segment', async () => {
    expect(await identifiersSentUpstream('OLM', 'olid')).toEqual([]);
  });

  // ─── OCLC and LCCN paths ────────────────────────────────────────────────────

  it('accepts oclc id_type and passes to service', async () => {
    expect(await identifiersSentUpstream('36863723', 'oclc')).toEqual(['36863723']);
  });

  it('accepts lccn id_type and passes to service', async () => {
    expect(await identifiersSentUpstream('00027665', 'lccn')).toEqual(['00027665']);
  });

  it('rejects a non-numeric OCLC identifier locally before any upstream call', async () => {
    expect(await identifiersSentUpstream('abc-not-oclc', 'oclc')).toEqual([]);
  });

  // LCCN has no fixed upstream format, so nothing is rejected locally for it.
  it('passes an unusual LCCN through rather than guessing at a format', async () => {
    expect(await identifiersSentUpstream('agr 62000298', 'lccn')).toEqual(['agr 62000298']);
  });

  // ─── Format edge cases ──────────────────────────────────────────────────────

  it('formats edition with author without author_id', () => {
    const edition = {
      ...FULL_EDITION,
      authors: [{ name: 'Anonymous Author', source: 'edition' as const }],
    };
    const text = (
      openlibraryGetEdition.format!({ editions: [edition], unresolved: [] })[0] as { text: string }
    ).text;
    expect(text).toContain('Anonymous Author');
    // Should not show parenthetical ID
    expect(text).not.toContain('undefined');
  });

  it('formats an edition mixing edition-level and work-level attribution', () => {
    const edition = {
      ...FULL_EDITION,
      authors: [
        { name: 'Edition Credit', author_id: 'OL1A', source: 'edition' as const },
        { name: 'Work Credit', author_id: 'OL2A', source: 'work' as const },
      ],
    };
    const text = (
      openlibraryGetEdition.format!({ editions: [edition], unresolved: [] })[0] as { text: string }
    ).text;
    expect(text).toContain('**Authors (recorded on this edition):** Edition Credit (OL1A)');
    expect(text).toContain('from parent work');
    expect(text).toContain('Work Credit (OL2A)');
    expect(text).not.toContain('undefined');
  });

  it('formats edition without ebook url', () => {
    const edition = { ...FULL_EDITION, ebook_url: undefined };
    const text = (
      openlibraryGetEdition.format!({ editions: [edition], unresolved: [] })[0] as { text: string }
    ).text;
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
      lc_classifications: [],
      cover_ids: [],
    };
    const text = (
      openlibraryGetEdition.format!({ editions: [sparse], unresolved: [] })[0] as { text: string }
    ).text;
    expect(text).not.toContain('undefined');
    expect(text).not.toContain('null');
  });
});
