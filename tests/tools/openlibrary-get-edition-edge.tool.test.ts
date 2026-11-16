/**
 * @fileoverview Edge case and validation tests for the openlibrary_get_edition tool.
 * @module tests/tools/openlibrary-get-edition-edge.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { escapeMarkdownInline, markdownLink } from '@cyanheads/mcp-ts-core/utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { openlibraryGetEdition } from '@/mcp-server/tools/definitions/openlibrary-get-edition.tool.js';
import {
  getOpenLibraryService,
  initOpenLibraryService,
} from '@/services/open-library/open-library-service.js';

const FULL_EDITION = {
  identifier: 'OL7353617M',
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
    const text = textOf(result);
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
      const text = textOf(result);
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
    const text = textOf(result);
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

  it('returns edition credits on both surfaces and renders none that are absent', async () => {
    const credited = {
      ...FULL_EDITION,
      subtitle: 'A *novel*',
      by_statement: 'Translated by Richard Pevear and Larissa Volokhonsky',
      contributors: [
        { name: 'Richard Pevear', role: 'Translator' },
        { name: 'Larissa Volokhonsky' },
      ],
      contributions: ['Pevear, Richard, 1943-, translator', 'Larissa Volokhonsky (Translator)'],
      translated_from: ['rus'],
    };
    // Taken before the call: the stub hands `credited` itself to the handler.
    const expected = structuredClone(credited);
    const bare = { ...FULL_EDITION, identifier: 'OL1M', edition_id: 'OL1M', title: 'Bare' };
    vi.spyOn(getOpenLibraryService(), 'getEditionsByIdentifiers').mockResolvedValue({
      editions: [credited, bare],
      unresolved: [],
      authorGaps: { failed: [], skipped: [] },
    });
    const result = await runToolContract(openlibraryGetEdition, {
      identifiers: ['OL7353617M', 'OL1M'],
      id_type: 'olid',
    });
    expect(result.isError).toBeFalsy();
    const structured = openlibraryGetEdition.output.parse(result.structuredContent);
    expect(structured.editions[0]).toEqual(expected);
    for (const field of [
      'subtitle',
      'by_statement',
      'contributors',
      'contributions',
      'translated_from',
    ])
      expect(structured.editions[1]).not.toHaveProperty(field);
    const text = textOf(result);
    const [first, second] = text.split('## Bare');
    for (const line of [
      `**Subtitle:** ${escapeMarkdownInline('A *novel*')}`,
      '**By statement:** Translated by Richard Pevear and Larissa Volokhonsky',
      '**Contributors:** Richard Pevear (Translator); Larissa Volokhonsky',
      '**Contributions:** Pevear, Richard, 1943-, translator; Larissa Volokhonsky (Translator)',
      '**Translated from:** rus',
    ])
      expect(first).toContain(line);
    for (const label of [
      'Subtitle',
      'By statement',
      'Contributors',
      'Contributions',
      'Translated from',
    ])
      expect(second).not.toContain(`**${label}:**`);
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
      identifier: 'OL1M',
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

/** OL20525469M answers both ISBNs of one book, though its own isbn_13 is empty. */
const LEFT_HAND = {
  key: '/books/OL20525469M',
  title: 'The Left Hand of Darkness',
  isbn_10: ['0441478123'],
  authors: [{ key: '/authors/OL31353A', name: 'Ursula K. Le Guin' }],
};

const PEVEAR = {
  key: '/books/OL7361482M',
  title: 'Anna Karenina',
  isbn_13: ['9780143035008'],
  authors: [{ key: '/authors/OL26783A', name: 'Leo Tolstoy' }],
};

/** Answers the bibkeys route from `map`, and fails any other request. */
function mockBibkeys(map: Record<string, unknown>) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(((input: unknown) => {
    const url = input instanceof Request ? input.url : String(input);
    return url.includes('/api/books.json')
      ? Promise.resolve(new Response(JSON.stringify(map), { status: 200 }))
      : Promise.reject(new Error(`unmocked fetch: ${url}`));
  }) as typeof globalThis.fetch);
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
}

describe('openlibraryGetEdition — blank identifiers', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    initOpenLibraryService();
  });

  // The bibkeys route answers `LCCN:` with a record whose lccn is [""] — an
  // unrelated edition — so a blank value must never be sent.
  it('fails a blank LCCN as invalid_identifier instead of resolving an unrelated edition', async () => {
    const fetchSpy = mockBibkeys({
      'LCCN:': { details: { key: '/books/OL7254001M', title: 'Unrelated', lccn: [''] } },
    });
    const result = await runToolContract(openlibraryGetEdition, {
      identifiers: [''],
      id_type: 'lccn',
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.ValidationError, data: { reason: 'invalid_identifier' } },
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each(
    (['isbn', 'oclc', 'olid'] as const).flatMap((idType) =>
      ['', '\t \n'].map((blank) => [idType, JSON.stringify(blank), blank] as const),
    ),
  )(
    'fails a blank %s identifier (%s) as invalid_identifier, on both surfaces',
    async (idType, _label, blank) => {
      const fetchSpy = mockBibkeys({});
      const result = await runToolContract(openlibraryGetEdition, {
        identifiers: [blank],
        id_type: idType,
      });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: {
          code: JsonRpcErrorCode.ValidationError,
          data: {
            reason: 'invalid_identifier',
            recovery: {
              hint: openlibraryGetEdition.errors!.find((e) => e.reason === 'invalid_identifier')!
                .recovery,
            },
          },
        },
      });
      expect(textOf(result)).toContain(
        `None of the 1 supplied identifiers are valid for id_type "${idType}".`,
      );
      expect(fetchSpy).not.toHaveBeenCalled();
    },
  );

  it.each(
    (['isbn', 'oclc', 'lccn', 'olid'] as const).flatMap((idType) =>
      ['', ' ', '\t \n'].map((blank) => [idType, JSON.stringify(blank), blank] as const),
    ),
  )('never sends a blank %s identifier (%s) upstream', async (idType, _label, blank) => {
    expect(await identifiersSentUpstream(blank, idType)).toEqual([]);
  });

  it('reports each blank entry per entry and sends the rest of the batch unchanged', async () => {
    const spy = vi.spyOn(getOpenLibraryService(), 'getEditionsByIdentifiers').mockResolvedValue({
      editions: [{ ...FULL_EDITION, identifier: ' 00027665 ' }],
      unresolved: [],
      authorGaps: { failed: [], skipped: [] },
    });
    const result = await runToolContract(openlibraryGetEdition, {
      identifiers: ['', ' 00027665 ', '  '],
      id_type: 'lccn',
    });
    expect(result.isError).toBeFalsy();
    expect(spy.mock.calls[0]![0]).toEqual([' 00027665 ']);
    expect(result.structuredContent).toMatchObject({
      unresolved: [
        { identifier: '', reason: 'invalid_identifier' },
        { identifier: '  ', reason: 'invalid_identifier' },
      ],
    });
    const text = textOf(result);
    expect(text).toContain('- "" — invalid_identifier');
  });

  it('fails an all-blank batch as invalid_identifier with the declared recovery', async () => {
    const fetchSpy = mockBibkeys({});
    const result = await runToolContract(openlibraryGetEdition, {
      identifiers: ['', '   '],
      id_type: 'lccn',
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.ValidationError,
        data: {
          reason: 'invalid_identifier',
          recovery: {
            hint: openlibraryGetEdition.errors!.find((e) => e.reason === 'invalid_identifier')!
              .recovery,
          },
        },
      },
    });
    expect(textOf(result)).toContain(
      'None of the 2 supplied identifiers are valid for id_type "lccn".',
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('openlibraryGetEdition — requested identifier echo', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    initOpenLibraryService();
  });

  it('echoes each resolved input on both surfaces in a mixed batch, leaving unresolved and unprocessed unchanged', async () => {
    mockBibkeys({
      'ISBN:9780441478125': { details: LEFT_HAND },
      'ISBN:0441478123': { details: LEFT_HAND },
      'ISBN:9780143035008': { details: PEVEAR },
    });
    const result = await runToolContract(openlibraryGetEdition, {
      identifiers: ['9999999999', '9780441478125', 'abc', '978-0-14-303500-8', '0441478123'],
      id_type: 'isbn',
    });
    expect(result.isError).toBeFalsy();
    const structured = openlibraryGetEdition.output.parse(result.structuredContent);
    expect(structured.editions.map((e) => [e.identifier, e.edition_id])).toEqual([
      ['9780441478125', 'OL20525469M'],
      ['978-0-14-303500-8', 'OL7361482M'],
      ['0441478123', 'OL20525469M'],
    ]);
    expect(structured.unresolved).toEqual([
      { identifier: 'abc', reason: 'invalid_identifier' },
      { identifier: '9999999999', reason: 'not_found' },
    ]);
    expect(structured.unprocessed).toEqual([]);
    const text = textOf(result);
    for (const [title, identifier] of [
      ['The Left Hand of Darkness', '9780441478125'],
      ['Anna Karenina', '978-0-14-303500-8'],
      ['The Left Hand of Darkness', '0441478123'],
    ])
      expect(text).toContain(`## ${title}\n**Identifier:** ${escapeMarkdownInline(identifier!)}\n`);
    expect(text.match(/\*\*Identifier:\*\*/g)).toHaveLength(3);
  });

  it('echoes a lowercase OLID as supplied', async () => {
    mockBibkeys({ 'OLID:ol7361482m': { details: PEVEAR } });
    const result = await runToolContract(openlibraryGetEdition, {
      identifiers: ['ol7361482m'],
      id_type: 'olid',
    });
    expect(result.structuredContent).toMatchObject({
      editions: [{ identifier: 'ol7361482m', edition_id: 'OL7361482M' }],
    });
    expect(textOf(result)).toContain('**Identifier:** ol7361482m');
  });

  it('collapses an exact duplicate to one echoed row with clamping enabled', async () => {
    const fetchSpy = mockBibkeys({ 'ISBN:9780143035008': { details: PEVEAR } });
    const result = await runToolContract(openlibraryGetEdition, {
      identifiers: ['9780143035008', '9780143035008'],
      id_type: 'isbn',
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const structured = openlibraryGetEdition.output.parse(result.structuredContent);
    expect(structured.editions.map((e) => e.identifier)).toEqual(['9780143035008']);
  });

  it('keeps one echoed row per exact duplicate with clamping disabled', async () => {
    vi.stubEnv('OPENLIBRARY_CLAMP_LIMITS', 'false');
    vi.resetModules();
    try {
      const { openlibraryGetEdition: strict } = await import(
        '@/mcp-server/tools/definitions/openlibrary-get-edition.tool.js'
      );
      const service = await import('@/services/open-library/open-library-service.js');
      service.initOpenLibraryService();
      mockBibkeys({ 'ISBN:9780143035008': { details: PEVEAR } });
      const result = await runToolContract(strict, {
        identifiers: ['9780143035008', '9780143035008'],
        id_type: 'isbn',
      });
      const structured = strict.output.parse(result.structuredContent);
      expect(structured.editions.map((e) => [e.identifier, e.edition_id])).toEqual([
        ['9780143035008', 'OL7361482M'],
        ['9780143035008', 'OL7361482M'],
      ]);
      expect(textOf(result).match(/\*\*Identifier:\*\* 9780143035008/g)).toHaveLength(2);
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });
});
