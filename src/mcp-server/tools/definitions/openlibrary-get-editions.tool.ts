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
  paginationLimit,
  paginationLimitNotice,
} from '@/mcp-server/tools/limit-policy.js';
import { WORK_ID_MESSAGE, WORK_ID_PATTERN } from '@/mcp-server/tools/work-id.js';
import {
  getOpenLibraryService,
  normalizeWorkId,
} from '@/services/open-library/open-library-service.js';

export const openlibraryGetEditions = tool('openlibrary_get_editions', {
  title: 'Get Editions',
  description:
    'List editions of a work — different publishers, languages, formats, and print runs. Returns ISBNs, publisher, language, page count, and edition OLIDs. Use after openlibrary_get_work or openlibrary_search_books to find a specific printing. A merged work ID resolves to the work it was merged into. To reach a work from an ISBN, call openlibrary_get_edition with id_type "isbn" — its work_id output is the parent work.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    work_id: z
      .string()
      .regex(WORK_ID_PATTERN, WORK_ID_MESSAGE)
      .describe(
        'Open Library Work ID. Format: OL…W (e.g., "OL45804W"), optionally prefixed "/works/". Not an ISBN — resolve an ISBN to its work with openlibrary_get_edition (id_type "isbn").',
      ),
    limit: paginationLimit(10).describe(
      'Max editions to return; values above 100 apply 100 when limit clamping is enabled. Prefer 10–20 for exploration.',
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
              .describe('3-letter ISO language codes (e.g., "eng", "fre").'),
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
      .describe('Guidance for a merged work ID or a requested limit above the page ceiling.'),
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
    const limit = applyPaginationLimit(input.limit, 'openlibrary_get_editions', ctx);
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
      paginationLimitNotice(input.limit, input.offset, result.editions.length),
    );
    if (notice) ctx.enrich.notice(notice);
    // Open Library neither clamps nor reports the offset, so the requested one is the applied one.
    return { ...result, offset: input.offset };
  },

  format: (result) => {
    const literal = (value: string) => (value === '' ? '""' : escapeMarkdownInline(value));
    const list = (values: string[]) => (values.length ? values.map(literal).join(', ') : '[]');
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
      const meta: string[] = [];
      if (ed.publish_date !== undefined) meta.push(`Published: ${literal(ed.publish_date)}`);
      if (ed.publishers.length) meta.push(`Publisher: ${list(ed.publishers)}`);
      else lines.push('**Publisher:** []');
      if (ed.languages.length) meta.push(`Language: ${list(ed.languages)}`);
      else lines.push('**Language:** []');
      if (ed.page_count != null) meta.push(`Pages: ${ed.page_count}`);
      if (meta.length) lines.push(meta.join(' | '));
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
