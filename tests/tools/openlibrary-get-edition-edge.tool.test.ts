/**
 * @fileoverview Edge case and validation tests for the openlibrary_get_edition tool.
 * @module tests/tools/openlibrary-get-edition-edge.tool.test
 */

import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { escapeMarkdownInline, markdownLink } from '@cyanheads/mcp-ts-core/utils';
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
  const spy = vi.spyOn(getOpenLibraryService(), 'getEditionsByIdentifiers').mockResolvedValue({
    editions: [FULL_EDITION],
    unresolved: [],
    authorGaps: { failed: [], skipped: [] },
  });
  const input = openlibraryGetEdition.input.parse({ identifiers: [identifier], id_type: idType });
  await Promise.resolve(openlibraryGetEdition.handler(input, ctx)).catch(() => undefined);
  return (spy.mock.calls[0]?.[0] as string[] | undefined) ?? [];
}

describe('openlibraryGetEdition — edge cases', () => {
  beforeEach(() => {
    initOpenLibraryService();
    vi.restoreAllMocks();
  });

  it('classifies a mixed malformed and missing batch as not_found without sending malformed entries', async () => {
    const spy = vi.spyOn(getOpenLibraryService(), 'getEditionsByIdentifiers').mockResolvedValue({
      editions: [],
      unresolved: ['OL1M'],
      authorGaps: { failed: [], skipped: [] },
    });
    const result = await runToolContract(openlibraryGetEdition, {
      identifiers: ['bad', 'OL1M'],
      id_type: 'olid',
    });
    expect(result.structuredContent).toMatchObject({ error: { data: { reason: 'not_found' } } });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]![0]).toEqual(['OL1M']);
  });

  it('deduplicates exact strings before the 50-slot batch and preserves the remainder on both surfaces', async () => {
    const distinct = Array.from({ length: 52 }, (_, i) => `OL${i + 1}M`);
    const spy = vi.spyOn(getOpenLibraryService(), 'getEditionsByIdentifiers').mockResolvedValue({
      editions: [FULL_EDITION],
      unresolved: [],
      authorGaps: { failed: ['OL7353617M'], skipped: [] },
    });
    const result = await runToolContract(openlibraryGetEdition, {
      identifiers: [distinct[0]!, ...distinct],
      id_type: 'olid',
    });
    expect(result.isError).toBeFalsy();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]![0]).toEqual(distinct.slice(0, 50));
    expect(result.structuredContent).toMatchObject({
      unprocessed: ['OL51M', 'OL52M'],
      notice: expect.stringContaining('53 requested'),
    });
    const text = result.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
    for (const value of ['OL51M', 'OL52M', '52 distinct', '50 processed', 'Author lookups'])
      expect(text).toContain(value);
  });

  it.each(['invalid_identifier', 'not_found'] as const)(
    'keeps all-failure %s and every remaining value in typed data and recovery',
    async (reason) => {
      const first = Array.from({ length: 50 }, (_, i) =>
        reason === 'invalid_identifier' ? `bad-${i}` : `OL${i + 1}M`,
      );
      const remainder = ['remaining *value*\nnext', ''];
      const spy = vi.spyOn(getOpenLibraryService(), 'getEditionsByIdentifiers').mockResolvedValue({
        editions: [],
        unresolved: first,
        authorGaps: { failed: [], skipped: [] },
      });
      const result = await runToolContract(openlibraryGetEdition, {
        identifiers: [...first, ...remainder],
        id_type: 'olid',
      });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: {
          data: {
            reason,
            unprocessed: remainder,
            recovery: {
              hint: expect.stringContaining(
                'Unprocessed identifier 1: remaining *value*\nnext\nUnprocessed identifier 2: ""',
              ),
            },
          },
        },
      });
      const text = result.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
      expect(text).toContain('Unprocessed identifier 1: remaining \\*value\\*\\\nnext');
      expect(text).toContain('Unprocessed identifier 2: ""');
      expect(spy).toHaveBeenCalledTimes(reason === 'invalid_identifier' ? 0 : 1);
    },
  );

  it('counts malformed inputs as processed slots and retains case variants without false duplicate-only clamp', async () => {
    const spy = vi.spyOn(getOpenLibraryService(), 'getEditionsByIdentifiers').mockResolvedValue({
      editions: [FULL_EDITION],
      unresolved: [],
      authorGaps: { failed: [], skipped: [] },
    });
    const result = await runToolContract(openlibraryGetEdition, {
      identifiers: ['bad', 'OL1M', 'ol1m', 'OL1M'],
      id_type: 'olid',
    });
    expect(spy.mock.calls[0]![0]).toEqual(['OL1M', 'ol1m']);
    expect(result.structuredContent).toMatchObject({
      unresolved: [{ identifier: 'bad', reason: 'invalid_identifier' }],
      unprocessed: [],
    });
    expect(result.structuredContent).not.toHaveProperty('notice');
  });

  it('renders literal multiline metadata, present empty values, and exact numeric values on both surfaces', async () => {
    const edition = {
      ...FULL_EDITION,
      title: 'One *title*\n# second',
      publish_date: '',
      language: '',
      work_id: '',
      description: '<b>literal</b>\n- item',
      page_count: 0,
      authors: [{ name: 'A *name*\nsecond', author_id: '', source: 'work' as const }],
      publishers: ['One|Two', ''],
      ebook_url: 'https://archive.org/a_(b)',
    };
    vi.spyOn(getOpenLibraryService(), 'getEditionsByIdentifiers').mockResolvedValue({
      editions: [edition],
      unresolved: [],
      authorGaps: { failed: [], skipped: [] },
    });
    const result = await runToolContract(openlibraryGetEdition, {
      identifiers: ['OL7353617M'],
      id_type: 'olid',
    });
    expect(result.structuredContent).toMatchObject({ editions: [edition] });
    const text = result.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
    expect(text).toContain(`**Title:** ${escapeMarkdownInline(edition.title)}`);
    expect(text).toContain(escapeMarkdownInline(edition.description));
    expect(text).toContain(escapeMarkdownInline(edition.authors[0]!.name));
    for (const value of ['Published:', 'Language:', '**Work ID:**', 'Pages: 0'])
      expect(text).toContain(value);
    expect(text).toContain(markdownLink(edition.ebook_url, edition.ebook_url));
  });

  it('preserves every cataloged language and printing field on both surfaces', async () => {
    vi.spyOn(getOpenLibraryService(), 'getEditionsByIdentifiers').mockResolvedValue({
      editions: [
        {
          ...FULL_EDITION,
          languages: ['eng', 'chi'],
          physical_format: 'paperback',
          edition_name: 'Second Dell printing',
        },
      ],
      unresolved: [],
      authorGaps: { failed: [], skipped: [] },
    });
    const result = await runToolContract(openlibraryGetEdition, {
      identifiers: ['OL7353617M'],
      id_type: 'olid',
    });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      editions: [
        {
          language: 'eng',
          languages: ['eng', 'chi'],
          physical_format: 'paperback',
          edition_name: 'Second Dell printing',
        },
      ],
    });
    const text = JSON.stringify(result.content);
    for (const value of ['eng', 'chi', 'paperback', 'Second Dell printing'])
      expect(text).toContain(value);
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

  it.each(['080442957X', '080442957x', '0-8044-2957-X'])(
    'accepts the ISBN-10 %s with an X check digit, echoed as supplied',
    async (identifier) => {
      expect(await identifiersSentUpstream(identifier, 'isbn')).toEqual([identifier]);
    },
  );

  it.each(['08044X9570', 'X804429570', '080442957XX', '978080442957X'])(
    'rejects %s — an X anywhere but an ISBN-10 check digit',
    async (identifier) => {
      expect(await identifiersSentUpstream(identifier, 'isbn')).toEqual([]);
    },
  );

  it('names the X check digit wherever the ISBN shape is stated', () => {
    const recovery = openlibraryGetEdition.errors!.find(
      (e) => e.reason === 'invalid_identifier',
    )!.recovery;
    expect(recovery).toContain('X');
    expect(openlibraryGetEdition.input.shape.identifiers.element.description).toContain(
      'X check digit',
    );
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
      openlibraryGetEdition.format!({
        editions: [edition],
        unresolved: [],
        unprocessed: [],
      })[0] as { text: string }
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
      openlibraryGetEdition.format!({
        editions: [edition],
        unresolved: [],
        unprocessed: [],
      })[0] as { text: string }
    ).text;
    expect(text).toContain('**Authors (recorded on this edition):** Edition Credit (OL1A)');
    expect(text).toContain('from parent work');
    expect(text).toContain('Work Credit (OL2A)');
    expect(text).not.toContain('undefined');
  });

  it('formats edition without ebook url', () => {
    const edition = { ...FULL_EDITION, ebook_url: undefined };
    const text = (
      openlibraryGetEdition.format!({
        editions: [edition],
        unresolved: [],
        unprocessed: [],
      })[0] as { text: string }
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
      openlibraryGetEdition.format!({ editions: [sparse], unresolved: [], unprocessed: [] })[0] as {
        text: string;
      }
    ).text;
    expect(text).not.toContain('undefined');
    expect(text).not.toContain('null');
    for (const label of [
      'Authors',
      'Publisher',
      'ISBN-13',
      'ISBN-10',
      'OCLC',
      'LCCN',
      'LC call number',
      'Cover IDs',
    ]) {
      expect(text).toContain(`**${label}:** []`);
    }
  });

  it('restores raw-array bounds and duplicate results when clamping is disabled', async () => {
    vi.stubEnv('OPENLIBRARY_CLAMP_LIMITS', 'false');
    vi.resetModules();
    try {
      const { openlibraryGetEdition: strict } = await import(
        '@/mcp-server/tools/definitions/openlibrary-get-edition.tool.js'
      );
      const service = await import('@/services/open-library/open-library-service.js');
      service.initOpenLibraryService();
      const spy = vi
        .spyOn(service.getOpenLibraryService(), 'getEditionsByIdentifiers')
        .mockResolvedValue({
          editions: [FULL_EDITION, FULL_EDITION],
          unresolved: [],
          authorGaps: { failed: [], skipped: [] },
        });
      const tooMany = await runToolContract(strict, {
        identifiers: Array(51).fill('OL7353617M'),
        id_type: 'olid',
      });
      expect(tooMany.isError).toBe(true);
      expect(spy).not.toHaveBeenCalled();
      const result = await runToolContract(strict, {
        identifiers: ['OL7353617M', 'OL7353617M'],
        id_type: 'olid',
      });
      expect(spy.mock.calls[0]![0]).toEqual(['OL7353617M', 'OL7353617M']);
      expect(result.structuredContent).toMatchObject({
        editions: [FULL_EDITION, FULL_EDITION],
        unprocessed: [],
      });
      expect(result.structuredContent).not.toHaveProperty('notice');
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });
});
