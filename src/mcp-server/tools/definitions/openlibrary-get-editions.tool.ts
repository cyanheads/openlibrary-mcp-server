/**
 * @fileoverview List editions of a work.
 * @module mcp-server/tools/definitions/openlibrary-get-editions.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { escapeMarkdownInline } from '@cyanheads/mcp-ts-core/utils';
import { NO_TITLE } from '@/mcp-server/tools/heading-placeholders.js';
import {
  applyPaginationLimit,
  composeNotices,
  PAGE_CEILING,
  paginationLimit,
  paginationLimitNotice,
  pastEndNotice,
} from '@/mcp-server/tools/limit-policy.js';
import { WORK_ID_MESSAGE, WORK_ID_PATTERN } from '@/mcp-server/tools/work-id.js';
import {
  getOpenLibraryService,
  normalizeWorkId,
} from '@/services/open-library/open-library-service.js';

export const openlibraryGetEditions = tool('openlibrary_get_editions', {
  title: 'Get Editions',
  description:
    'List editions of a work — different publishers, languages, formats, translations, and print runs. Returns ISBNs, publisher, language, page count, edition OLIDs, and edition-level credits: subtitle, by-statement, translators and other contributors, and the language translated from. Use after openlibrary_get_work or openlibrary_search_books to find a specific printing. A merged work ID resolves to the work it was merged into. To reach a work from an ISBN, call openlibrary_get_edition with id_type "isbn" — its work_id output is the parent work.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    work_id: z
      .string()
      .regex(WORK_ID_PATTERN, WORK_ID_MESSAGE)
      .describe(
        'Open Library Work ID. Format: OL…W (e.g., "OL45804W"), optionally prefixed "/works/". Not an ISBN — resolve an ISBN to its work with openlibrary_get_edition (id_type "isbn").',
      ),
    limit: paginationLimit(10).describe(
      `Max editions to return; values above ${PAGE_CEILING} apply ${PAGE_CEILING} when limit clamping is enabled. Prefer 10–20 for exploration.`,
    ),
    offset: z.number().int().min(0).default(0).describe('Zero-based offset for pagination.'),
  }),
  output: z.object({
    total: z.number().describe('Total editions for this work.'),
    offset: z
      .number()
      .describe(
        'Zero-based offset of the first returned result — echoes the requested offset, so an empty page still records the offset that produced it.',
      ),
    work_id: z
      .string()
      .describe(
        'Canonical Open Library Work ID the editions were found under — differs from the requested work_id when that ID was merged into this work.',
      ),
    editions: z
      .array(
        z
          .object({
            edition_id: z
              .string()
              .describe(
                'Open Library Edition ID (OL…M). Use for openlibrary_get_edition with id_type "olid".',
              ),
            title: z
              .string()
              .describe('Edition title (may differ from work title for translated editions).'),
            subtitle: z
              .string()
              .optional()
              .describe('Edition subtitle, preserved verbatim. Absent when not recorded.'),
            by_statement: z
              .string()
              .optional()
              .describe(
                'Statement of responsibility as cataloged for this edition (e.g., "Translated by A.C. Townsend"), preserved verbatim. Absent when not recorded.',
              ),
            contributors: z
              .array(
                z
                  .object({
                    name: z.string().describe('Contributor name as recorded.'),
                    role: z
                      .string()
                      .optional()
                      .describe(
                        'Contribution as recorded (e.g., "Translator", "Editor", "Illustrator"). Absent when the record names none.',
                      ),
                  })
                  .describe('A contributor credited on this edition.'),
              )
              .optional()
              .describe(
                'Translators, editors, illustrators, and other contributors credited on this edition. Absent when none are recorded; contributions can name people this list omits.',
              ),
            contributions: z
              .array(z.string())
              .optional()
              .describe(
                'Legacy free-text credit strings as cataloged (e.g., "Garnett, Constance, 1861-1946, translator"), unparsed and independent of contributors. Absent when none are recorded.',
              ),
            translated_from: z
              .array(z.string())
              .optional()
              .describe(
                'Codes of the languages this edition was translated from, in the form languages uses (e.g., "rus"). Absent when not recorded.',
              ),
            publish_date: z
              .string()
              .optional()
              .describe(
                'Publication date string (e.g., "2003", "January 2003"). Absent when not recorded.',
              ),
            publishers: z.array(z.string()).describe('Publisher names.'),
            physical_format: z
              .string()
              .optional()
              .describe(
                'Cataloged physical format or binding, preserved verbatim. Absent when not recorded.',
              ),
            edition_name: z
              .string()
              .optional()
              .describe(
                'Cataloged edition or printing statement, preserved verbatim. Absent when not recorded.',
              ),
            languages: z
              .array(z.string())
              .describe('3-letter MARC language codes (e.g., "eng", "fre").'),
            isbn_10: z.array(z.string()).describe('ISBN-10 identifiers.'),
            isbn_13: z.array(z.string()).describe('ISBN-13 identifiers.'),
            page_count: z.number().optional().describe('Page count. Absent when not recorded.'),
            cover_ids: z
              .array(z.number())
              .describe('Numeric cover IDs for openlibrary_get_cover_url.'),
            work_id: z
              .string()
              .optional()
              .describe('Parent Work ID. Usually matches the top-level work_id.'),
          })
          .describe('A single edition of the work.'),
      )
      .describe('Editions of the work, up to limit.'),
  }),
  enrichment: {
    totalCount: z.number().optional().describe('Total editions for this work across all pages.'),
    notice: z
      .string()
      .optional()
      .describe(
        'Guidance for a merged work ID, a requested limit above the page ceiling, or an offset past the last edition.',
      ),
  },
  errors: [
    {
      reason: 'not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'Work ID does not exist on Open Library, or it redirects to no reachable work.',
      recovery:
        'Verify the Work ID (e.g., "OL45804W") or find it with openlibrary_search_books; holding an ISBN, call openlibrary_get_edition with id_type "isbn", whose work_id output is the parent work.',
    },
  ],

  async handler(input, ctx) {
    ctx.log.info('Fetching editions', {
      work_id: input.work_id,
      limit: input.limit,
      offset: input.offset,
    });
    const svc = getOpenLibraryService();
    const limit = applyPaginationLimit(input.limit, PAGE_CEILING, 'openlibrary_get_editions', ctx);
    const result = await svc.getEditions(input.work_id, limit, input.offset, ctx);
    if (!result) {
      throw ctx.fail('not_found', `Work ${input.work_id} not found on Open Library.`);
    }
    ctx.enrich.total(result.total);
    // format() never sees the request, so a merged-ID substitution is disclosed
    // here, and only when the IDs differ.
    const requested = normalizeWorkId(input.work_id);
    const notice = composeNotices(
      result.work_id !== requested
        ? `${escapeMarkdownInline(requested)} is a merged record; these are the editions of ${escapeMarkdownInline(result.work_id)}. Use ${escapeMarkdownInline(result.work_id)} for further lookups.`
        : undefined,
      paginationLimitNotice(input.limit, limit, input.offset, result.editions.length, result.total),
      // The editions subresource reports an exact size, so `offset >= total` is past the last row.
      result.total > 0 && input.offset >= result.total
        ? pastEndNotice(
            input.offset,
            result.total,
            `${result.total} ${result.total === 1 ? 'edition belongs' : 'editions belong'} to ${escapeMarkdownInline(result.work_id)}`,
          )
        : undefined,
    );
    if (notice) ctx.enrich.notice(notice);
    // Open Library neither clamps nor reports the offset, so the requested one is the applied one.
    return { ...result, offset: input.offset };
  },

  format: (result) => {
    const literal = (value: string) => (value === '' ? '""' : escapeMarkdownInline(value));
    const list = (values: string[]) => (values.length ? values.map(literal).join(', ') : '[]');
    const contributor = (c: { name: string; role?: string | undefined }) =>
      c.role !== undefined ? `${literal(c.name)} (${literal(c.role)})` : literal(c.name);
    const lines: string[] = [];
    lines.push(
      `**Work ID:** ${escapeMarkdownInline(result.work_id)} | **Total editions:** ${result.total} | **Offset:** ${result.offset} | **Returned:** ${result.editions.length}`,
    );

    for (const ed of result.editions) {
      lines.push('');
      if (ed.title.includes('\n') || ed.title.includes('\r')) {
        lines.push('### Edition', '', `**Title:** ${escapeMarkdownInline(ed.title)}`);
      } else {
        lines.push(`### ${ed.title === '' ? NO_TITLE : escapeMarkdownInline(ed.title)}`);
        if (ed.title === '') lines.push('**Title:** ""');
      }
      lines.push(`**Edition ID:** ${escapeMarkdownInline(ed.edition_id)}`);
      if (ed.subtitle !== undefined) lines.push(`**Subtitle:** ${literal(ed.subtitle)}`);
      if (ed.by_statement !== undefined)
        lines.push(`**By statement:** ${literal(ed.by_statement)}`);
      // Credits can carry commas of their own ("Garnett, Constance, 1861-1946"), so entries join on "; ".
      if (ed.contributors)
        lines.push(`**Contributors:** ${ed.contributors.map(contributor).join('; ')}`);
      if (ed.contributions)
        lines.push(`**Contributions:** ${ed.contributions.map(literal).join('; ')}`);
      const meta: string[] = [];
      if (ed.publish_date !== undefined) meta.push(`Published: ${literal(ed.publish_date)}`);
      if (ed.publishers.length) meta.push(`Publisher: ${list(ed.publishers)}`);
      else lines.push('**Publisher:** []');
      if (ed.languages.length) meta.push(`Language: ${list(ed.languages)}`);
      else lines.push('**Language:** []');
      if (ed.page_count != null) meta.push(`Pages: ${ed.page_count}`);
      if (meta.length) lines.push(meta.join(' | '));
      if (ed.translated_from) lines.push(`**Translated from:** ${list(ed.translated_from)}`);
      if (ed.physical_format !== undefined)
        lines.push(`**Physical format:** ${literal(ed.physical_format)}`);
      if (ed.edition_name !== undefined)
        lines.push(`**Edition statement:** ${literal(ed.edition_name)}`);
      lines.push(`**ISBN-13:** ${list(ed.isbn_13)}`);
      lines.push(`**ISBN-10:** ${list(ed.isbn_10)}`);
      lines.push(`**Cover IDs:** ${ed.cover_ids.length ? ed.cover_ids.join(', ') : '[]'}`);
      if (ed.work_id !== undefined) lines.push(`**Work ID:** ${literal(ed.work_id)}`);
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
