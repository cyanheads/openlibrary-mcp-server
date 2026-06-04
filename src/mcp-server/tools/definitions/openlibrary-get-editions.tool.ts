/**
 * @fileoverview List editions of a work.
 * @module mcp-server/tools/definitions/openlibrary-get-editions.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getOpenLibraryService } from '@/services/open-library/open-library-service.js';

export const openlibraryGetEditions = tool('openlibrary_get_editions', {
  title: 'Get Editions',
  description:
    'List editions of a work — different publishers, languages, formats, and print runs. Returns ISBNs, publisher, language, page count, and edition OLIDs. Use after openlibrary_get_work or openlibrary_search_books to find a specific printing.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    work_id: z
      .string()
      .describe('Open Library Work ID (OL…W). A leading "/works/" prefix is stripped if provided.'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .default(10)
      .describe('Max editions to return. Prefer 10–20 for exploration.'),
    offset: z.number().int().min(0).default(0).describe('Zero-based offset for pagination.'),
  }),
  output: z.object({
    total: z.number().describe('Total editions for this work.'),
    work_id: z.string().describe('Open Library Work ID.'),
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
              .describe('Parent Work ID. Usually matches the requested work_id.'),
          })
          .describe('A single edition of the work.'),
      )
      .describe('Editions of the work, up to limit.'),
  }),
  errors: [
    {
      reason: 'not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'Work ID does not exist on Open Library.',
      recovery:
        'Verify the Work ID format (e.g., "OL45804W") or use openlibrary_search_books first.',
    },
  ],

  async handler(input, ctx) {
    ctx.log.info('Fetching editions', {
      work_id: input.work_id,
      limit: input.limit,
      offset: input.offset,
    });
    const svc = getOpenLibraryService();
    const result = await svc.getEditions(input.work_id, input.limit, input.offset, ctx);
    if (!result) throw ctx.fail('not_found', `Work ${input.work_id} not found on Open Library.`);
    return result;
  },

  format: (result) => {
    const lines: string[] = [];
    lines.push(
      `**Work ID:** ${result.work_id} | **Total editions:** ${result.total} | **Returned:** ${result.editions.length}`,
    );

    for (const ed of result.editions) {
      lines.push('');
      lines.push(`### ${ed.title}`);
      lines.push(`**Edition ID:** ${ed.edition_id}`);
      const meta: string[] = [];
      if (ed.publish_date) meta.push(`Published: ${ed.publish_date}`);
      if (ed.publishers.length) meta.push(`Publisher: ${ed.publishers.join(', ')}`);
      if (ed.languages.length) meta.push(`Language: ${ed.languages.join(', ')}`);
      if (ed.page_count != null) meta.push(`Pages: ${ed.page_count}`);
      if (meta.length) lines.push(meta.join(' | '));
      if (ed.isbn_13.length) lines.push(`**ISBN-13:** ${ed.isbn_13.join(', ')}`);
      if (ed.isbn_10.length) lines.push(`**ISBN-10:** ${ed.isbn_10.join(', ')}`);
      if (ed.cover_ids.length) lines.push(`**Cover IDs:** ${ed.cover_ids.join(', ')}`);
      if (ed.work_id) lines.push(`**Work ID:** ${ed.work_id}`);
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
