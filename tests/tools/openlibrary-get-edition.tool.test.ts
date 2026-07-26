/**
 * @fileoverview Tests for the openlibrary_get_edition tool.
 * @module tests/tools/openlibrary-get-edition.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
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

const SECOND_EDITION = {
  ...FULL_EDITION,
  edition_id: 'OL22855101M',
  title: 'Concorde',
  isbn_13: ['9782952690607'],
};

describe('openlibraryGetEdition', () => {
  beforeEach(() => {
    initOpenLibraryService();
  });

  it('resolves every identifier in the batch, in request order', async () => {
    const ctx = createMockContext({ errors: openlibraryGetEdition.errors });
    const spy = vi
      .spyOn(getOpenLibraryService(), 'getEditionsByIdentifiers')
      .mockResolvedValueOnce({ editions: [FULL_EDITION, SECOND_EDITION], unresolved: [] });

    const input = openlibraryGetEdition.input.parse({
      identifiers: ['9780743273565', '9782952690607'],
      id_type: 'isbn',
    });
    const result = await openlibraryGetEdition.handler(input, ctx);

    expect(spy).toHaveBeenCalledWith(['9780743273565', '9782952690607'], 'isbn', ctx);
    expect(result.editions.map((e) => e.edition_id)).toEqual(['OL7353617M', 'OL22855101M']);
    expect(result.unresolved).toEqual([]);
  });

  it('returns the resolved editions and reports the misses when the batch is partial', async () => {
    const ctx = createMockContext({ errors: openlibraryGetEdition.errors });
    vi.spyOn(getOpenLibraryService(), 'getEditionsByIdentifiers').mockResolvedValueOnce({
      editions: [FULL_EDITION],
      unresolved: ['OL99999999M'],
    });

    const input = openlibraryGetEdition.input.parse({
      identifiers: ['OL7353617M', 'OL99999999M', 'not-an-olid'],
      id_type: 'olid',
    });
    const result = await openlibraryGetEdition.handler(input, ctx);

    expect(result.editions).toHaveLength(1);
    expect(result.unresolved).toEqual([
      { identifier: 'not-an-olid', reason: 'invalid_identifier' },
      { identifier: 'OL99999999M', reason: 'not_found' },
    ]);
  });

  it('never sends a malformed identifier upstream', async () => {
    const ctx = createMockContext({ errors: openlibraryGetEdition.errors });
    const spy = vi
      .spyOn(getOpenLibraryService(), 'getEditionsByIdentifiers')
      .mockResolvedValueOnce({ editions: [FULL_EDITION], unresolved: [] });

    const input = openlibraryGetEdition.input.parse({
      identifiers: ['9780743273565', 'notanisbn'],
      id_type: 'isbn',
    });
    await openlibraryGetEdition.handler(input, ctx);

    expect(spy).toHaveBeenCalledWith(['9780743273565'], 'isbn', ctx);
  });

  it('throws not_found when nothing in the batch resolved', async () => {
    const ctx = createMockContext({ errors: openlibraryGetEdition.errors });
    vi.spyOn(getOpenLibraryService(), 'getEditionsByIdentifiers').mockResolvedValueOnce({
      editions: [],
      unresolved: ['OL99999998M', 'OL99999999M'],
    });

    const input = openlibraryGetEdition.input.parse({
      identifiers: ['OL99999998M', 'OL99999999M'],
      id_type: 'olid',
    });
    await expect(openlibraryGetEdition.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'not_found' },
    });
  });

  // A batch of nothing but malformed values never reached upstream, so reporting
  // it as not-found would point the caller at the wrong correction.
  it('throws invalid_identifier — not not_found — when every identifier is malformed', async () => {
    const ctx = createMockContext({ errors: openlibraryGetEdition.errors });
    const spy = vi.spyOn(getOpenLibraryService(), 'getEditionsByIdentifiers');

    const input = openlibraryGetEdition.input.parse({
      identifiers: ['notanisbn', '12345'],
      id_type: 'isbn',
    });
    await expect(openlibraryGetEdition.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: {
        reason: 'invalid_identifier',
        recovery: {
          hint: openlibraryGetEdition.errors!.find((e) => e.reason === 'invalid_identifier')!
            .recovery,
        },
      },
    });
    expect(spy).not.toHaveBeenCalled();
  });

  it('delivers the declared not_found recovery hint on the wire', async () => {
    const ctx = createMockContext({ errors: openlibraryGetEdition.errors });
    vi.spyOn(getOpenLibraryService(), 'getEditionsByIdentifiers').mockResolvedValueOnce({
      editions: [],
      unresolved: ['OL99999999M'],
    });

    const input = openlibraryGetEdition.input.parse({
      identifiers: ['OL99999999M'],
      id_type: 'olid',
    });
    await expect(openlibraryGetEdition.handler(input, ctx)).rejects.toMatchObject({
      data: {
        recovery: {
          hint: openlibraryGetEdition.errors!.find((e) => e.reason === 'not_found')!.recovery,
        },
      },
    });
  });

  // ─── Batch size ─────────────────────────────────────────────────────────────

  it('accepts a batch at the cap', async () => {
    const identifiers = Array.from({ length: 50 }, (_, i) => `OL${7353617 + i}M`);
    const ctx = createMockContext({ errors: openlibraryGetEdition.errors });
    const spy = vi
      .spyOn(getOpenLibraryService(), 'getEditionsByIdentifiers')
      .mockResolvedValueOnce({
        editions: identifiers.map((id) => ({ ...FULL_EDITION, edition_id: id })),
        unresolved: [],
      });

    const input = openlibraryGetEdition.input.parse({ identifiers, id_type: 'olid' });
    const result = await openlibraryGetEdition.handler(input, ctx);

    expect(spy.mock.calls[0]?.[0]).toHaveLength(50);
    expect(result.editions).toHaveLength(50);
  });

  it('rejects a batch past the cap at the schema', () => {
    const identifiers = Array.from({ length: 51 }, (_, i) => `OL${7353617 + i}M`);
    expect(() => openlibraryGetEdition.input.parse({ identifiers, id_type: 'olid' })).toThrow();
  });

  it('rejects an empty identifiers array at the schema', () => {
    expect(() => openlibraryGetEdition.input.parse({ identifiers: [], id_type: 'isbn' })).toThrow();
  });

  // ─── format() ───────────────────────────────────────────────────────────────

  it('formats edition with all fields', () => {
    const blocks = openlibraryGetEdition.format!({
      editions: [FULL_EDITION],
      unresolved: [],
    });
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('OL7353617M');
    expect(text).toContain('The Great Gatsby');
    expect(text).toContain('F. Scott Fitzgerald');
    expect(text).toContain('OL24638A');
    expect(text).toContain('9780743273565');
    expect(text).toContain('OL45804W');
    expect(text).toContain('https://archive.org/details/greatgatsby00fitz');
  });

  it('renders every edition in a multi-result batch, not just the first', () => {
    const text = (
      openlibraryGetEdition.format!({
        editions: [FULL_EDITION, SECOND_EDITION],
        unresolved: [],
      })[0] as { text: string }
    ).text;
    expect(text).toContain('The Great Gatsby');
    expect(text).toContain('Concorde');
    expect(text).toContain('OL22855101M');
  });

  it('renders unresolved identifiers with their reason so a miss is visible in text', () => {
    const text = (
      openlibraryGetEdition.format!({
        editions: [FULL_EDITION],
        unresolved: [
          { identifier: 'OL99999999M', reason: 'not_found' },
          { identifier: 'nope', reason: 'invalid_identifier' },
        ],
      })[0] as { text: string }
    ).text;
    expect(text).toContain('OL99999999M — not_found');
    expect(text).toContain('nope — invalid_identifier');
  });

  it('renders the control number and the call number as separate, differently-labelled fields', () => {
    const text = (
      openlibraryGetEdition.format!({ editions: [FULL_EDITION], unresolved: [] })[0] as {
        text: string;
      }
    ).text;
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
    const text = (
      openlibraryGetEdition.format!({ editions: [workSourced], unresolved: [] })[0] as {
        text: string;
      }
    ).text;
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
    const text = (
      openlibraryGetEdition.format!({ editions: [sparse], unresolved: [] })[0] as { text: string }
    ).text;
    expect(text).toContain('OL1M');
  });
});
