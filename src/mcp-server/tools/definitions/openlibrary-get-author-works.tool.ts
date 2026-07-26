/**
 * @fileoverview List works by an author.
 * @module mcp-server/tools/definitions/openlibrary-get-author-works.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  getOpenLibraryService,
  normalizeAuthorId,
} from '@/services/open-library/open-library-service.js';

export const openlibraryGetAuthorWorks = tool('openlibrary_get_author_works', {
  title: 'Get Author Works',
  description:
    'List works by an author. Returns titles, cover IDs, and work OLIDs for drilling into editions or details. Use openlibrary_get_author for author bio and details, or openlibrary_get_editions to explore specific printings.',
  annotations: { readOnlyHint: true, openWorldHint: true },
  input: z.object({
    author_id: z
      .string()
      .describe(
        'Open Library Author ID (OL…A). A leading "/authors/" prefix is stripped if provided.',
      ),
    limit: z.number().int().min(1).max(100).default(20).describe('Max works to return.'),
    offset: z.number().int().min(0).default(0).describe('Zero-based offset for pagination.'),
  }),
  output: z.object({
    total: z.number().describe('Total works by this author.'),
    author_id: z.string().describe('Open Library Author ID.'),
    works: z
      .array(
        z
          .object({
            work_id: z
              .string()
              .describe(
                'Open Library Work ID (OL…W). Use for openlibrary_get_work or openlibrary_get_editions.',
              ),
            title: z.string().describe('Work title.'),
            first_publish_date: z
              .string()
              .optional()
              .describe('First publication date string. Absent when not recorded.'),
            cover_ids: z
              .array(z.number())
              .describe('Numeric cover IDs for openlibrary_get_cover_url.'),
          })
          .describe('A work by this author.'),
      )
      .describe('Works by this author, up to limit.'),
  }),
  enrichment: {
    totalCount: z.number().optional().describe('Total works by this author across all pages.'),
    notice: z
      .string()
      .optional()
      .describe('Set when the requested author ID was merged into a different canonical ID.'),
  },
  errors: [
    {
      reason: 'not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'Author ID does not exist on Open Library.',
      recovery:
        'Verify the OLID format (e.g., "OL24638A") or use openlibrary_search_authors to find the correct ID.',
    },
  ],

  async handler(input, ctx) {
    ctx.log.info('Fetching author works', { author_id: input.author_id, limit: input.limit });
    const svc = getOpenLibraryService();
    const result = await svc.getAuthorWorks(input.author_id, input.limit, input.offset, ctx);
    if (!result) {
      throw ctx.fail(
        'not_found',
        `Author ${input.author_id} not found on Open Library.`,
        ctx.recoveryFor('not_found'),
      );
    }
    ctx.enrich.total(result.total);
    // Open Library keeps a merged author reachable under its old ID, so the works
    // can come back under a different one than was asked for. `format()` is handed
    // only the result and never sees the request, so the substitution is disclosed
    // here or not at all — and only when the IDs actually differ, since an
    // unconditional call would render an empty notice on every ordinary lookup.
    const requested = normalizeAuthorId(input.author_id);
    if (result.author_id !== requested) {
      ctx.enrich.notice(
        `${requested} is a merged record; these are the works of ${result.author_id}. Use ${result.author_id} for further lookups.`,
      );
    }
    return result;
  },

  format: (result) => {
    const lines: string[] = [];
    lines.push(
      `**Author ID:** ${result.author_id} | **Total works:** ${result.total} | **Returned:** ${result.works.length}`,
    );

    for (const work of result.works) {
      lines.push('');
      lines.push(`### ${work.title}`);
      lines.push(`**Work ID:** ${work.work_id}`);
      if (work.first_publish_date) lines.push(`**First published:** ${work.first_publish_date}`);
      if (work.cover_ids.length) lines.push(`**Cover IDs:** ${work.cover_ids.join(', ')}`);
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
