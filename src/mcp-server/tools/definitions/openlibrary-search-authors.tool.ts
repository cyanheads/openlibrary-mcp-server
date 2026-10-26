/**
 * @fileoverview Search Open Library authors by name.
 * @module mcp-server/tools/definitions/openlibrary-search-authors.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { escapeMarkdownInline } from '@cyanheads/mcp-ts-core/utils';
import {
  applyPaginationLimit,
  composeNotices,
  paginationLimit,
  paginationLimitNotice,
} from '@/mcp-server/tools/limit-policy.js';
import { getOpenLibraryService } from '@/services/open-library/open-library-service.js';

export const openlibrarySearchAuthors = tool('openlibrary_search_authors', {
  title: 'Search Authors',
  description:
    'Search Open Library authors by name. Returns Open Library Author IDs, names, birth/death dates, top works, and subject associations. Use author IDs for openlibrary_get_author (bio, remote IDs) or openlibrary_get_author_works (list of works).',
  annotations: { readOnlyHint: true, openWorldHint: true },
  input: z.object({
    query: z.string().describe('Author name search query. Partial names and alternate names work.'),
    limit: paginationLimit(10).describe(
      'Max results to return; values above 100 apply 100 when limit clamping is enabled.',
    ),
    offset: z.number().int().min(0).default(0).describe('Zero-based offset for pagination.'),
  }),
  output: z.object({
    total: z.number().describe('Total matching authors across all pages.'),
    offset: z
      .number()
      .describe(
        'Zero-based offset of the first returned result — echoes the requested offset, so an empty page still records the offset that produced it.',
      ),
    authors: z
      .array(
        z
          .object({
            author_id: z.string().describe('Open Library Author ID (OL…A).'),
            name: z.string().describe('Primary author name.'),
            alternate_names: z.array(z.string()).describe('Alternate or transliterated names.'),
            birth_date: z
              .string()
              .optional()
              .describe('Birth date string. Absent when not recorded.'),
            death_date: z
              .string()
              .optional()
              .describe('Death date string. Absent when not recorded.'),
            top_work: z
              .string()
              .optional()
              .describe("Title of the author's most popular work. Absent when unavailable."),
            work_count: z.number().describe('Number of works catalogued for this author.'),
            top_subjects: z
              .array(z.string())
              .describe("Most common subject tags across the author's works."),
            ratings_average: z
              .number()
              .optional()
              .describe(
                "Average community rating across the author's works. Absent when no ratings exist.",
              ),
          })
          .describe('A matching author record.'),
      )
      .describe('Matching authors, up to limit.'),
  }),

  /** Agent-facing context: total count disclosure and empty-result notice. */
  enrichment: {
    totalCount: z
      .number()
      .optional()
      .describe(
        'Total matching authors across all pages — the upstream match count, reported even when this page is empty because offset ran past the end.',
      ),
    notice: z
      .string()
      .optional()
      .describe(
        'Guidance for an empty page or a requested limit above the page ceiling. Absent when neither applies.',
      ),
  },

  async handler(input, ctx) {
    ctx.log.info('Searching authors', { query: input.query, limit: input.limit });
    const svc = getOpenLibraryService();
    const limit = applyPaginationLimit(input.limit, 'openlibrary_search_authors', ctx);
    const result = await svc.searchAuthors(input.query, limit, input.offset, ctx);
    const limitNotice = paginationLimitNotice(input.limit, input.offset, result.authors.length);

    // Always the upstream match count, including on an empty page: an over-paged
    // request matched authors, and reporting 0 would misdirect the correction.
    ctx.enrich.total(result.total);

    const emptyNotice =
      result.authors.length > 0
        ? undefined
        : result.total > 0
          ? `Offset ${input.offset} is past the end of the result set — ${result.total} authors matched "${input.query}", so the last offset that returns a result is ${result.total - 1}. Retry with a lower offset; the query itself matched.`
          : `No authors matched "${input.query}". Try a partial name, check spelling, or use an alternate name form.`;
    const notice = composeNotices(limitNotice, emptyNotice);
    if (notice) ctx.enrich.notice(notice);

    return { ...result, offset: input.offset };
  },

  format: (result) => {
    const lines: string[] = [];
    lines.push(
      `**Total:** ${result.total} | **Offset:** ${result.offset} | **Returned:** ${result.authors.length}`,
    );

    for (const author of result.authors) {
      lines.push('');
      lines.push('## Author');
      lines.push(`**Name:** ${escapeMarkdownInline(author.name)}`);
      lines.push(`**Author ID:** ${escapeMarkdownInline(author.author_id)}`);
      const meta: string[] = [];
      if (author.birth_date !== undefined)
        meta.push(`Born: ${escapeMarkdownInline(author.birth_date)}`);
      if (author.death_date !== undefined)
        meta.push(`Died: ${escapeMarkdownInline(author.death_date)}`);
      meta.push(`Works: ${author.work_count}`);
      if (author.ratings_average !== undefined) meta.push(`Rating: ${author.ratings_average}`);
      if (meta.length) lines.push(meta.join(' | '));
      if (author.top_work !== undefined)
        lines.push(`**Top work:** ${escapeMarkdownInline(author.top_work)}`);
      lines.push(
        `**Alternate names:** ${author.alternate_names.length ? author.alternate_names.map(escapeMarkdownInline).join(', ') : '[]'}`,
      );
      lines.push(
        `**Top subjects:** ${author.top_subjects.length ? author.top_subjects.map(escapeMarkdownInline).join(', ') : '[]'}`,
      );
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
