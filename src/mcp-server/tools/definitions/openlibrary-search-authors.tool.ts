/**
 * @fileoverview Search Open Library authors by name.
 * @module mcp-server/tools/definitions/openlibrary-search-authors.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { getOpenLibraryService } from '@/services/open-library/open-library-service.js';

/**
 * Max top-subject tags rendered per author in the `content[]` text.
 * `structuredContent` always carries the complete `top_subjects` array; only the
 * human-facing text is capped, with the omitted count disclosed via the
 * enrichment trailer.
 */
const TOP_SUBJECTS_TEXT_CAP = 5;

export const openlibrarySearchAuthors = tool('openlibrary_search_authors', {
  title: 'Search Authors',
  description:
    'Search Open Library authors by name. Returns Open Library Author IDs, names, birth/death dates, top works, and subject associations. Use author IDs for openlibrary_get_author (bio, remote IDs) or openlibrary_get_author_works (list of works).',
  annotations: { readOnlyHint: true, openWorldHint: true },
  input: z.object({
    query: z.string().describe('Author name search query. Partial names and alternate names work.'),
    limit: z.number().int().min(1).max(100).default(10).describe('Max results to return.'),
    offset: z.number().int().min(0).default(0).describe('Zero-based offset for pagination.'),
  }),
  output: z.object({
    total: z.number().describe('Total matching authors across all pages.'),
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
      .describe('Total matching authors across all pages. Absent when results are empty.'),
    notice: z
      .string()
      .optional()
      .describe(
        'Recovery guidance when no authors match — echoes the query and suggests alternatives. Absent when results are found.',
      ),
  },

  async handler(input, ctx) {
    ctx.log.info('Searching authors', { query: input.query, limit: input.limit });
    const svc = getOpenLibraryService();
    const result = await svc.searchAuthors(input.query, input.limit, input.offset, ctx);

    if (result.authors.length === 0) {
      ctx.enrich.notice(
        `No authors matched "${input.query}". Try a partial name, check spelling, or use an alternate name form.`,
      );
      return { total: 0, authors: [] };
    }

    ctx.enrich.total(result.total);

    // Disclose the top subjects that format() caps out of the text; structuredContent keeps all.
    const subjectsShown = result.authors.reduce(
      (sum, author) => sum + Math.min(author.top_subjects.length, TOP_SUBJECTS_TEXT_CAP),
      0,
    );
    const subjectsTotal = result.authors.reduce(
      (sum, author) => sum + author.top_subjects.length,
      0,
    );
    if (subjectsTotal > subjectsShown) {
      ctx.enrich.notice(
        `Top subjects are capped at ${TOP_SUBJECTS_TEXT_CAP} per author in text output; showing ${subjectsShown} of ${subjectsTotal}. Full per-author lists are in structuredContent (authors[].top_subjects).`,
      );
    }

    return result;
  },

  format: (result) => {
    const lines: string[] = [];
    lines.push(`**Total:** ${result.total} | **Returned:** ${result.authors.length}`);

    for (const author of result.authors) {
      lines.push('');
      lines.push(`## ${author.name}`);
      lines.push(`**Author ID:** ${author.author_id}`);
      const meta: string[] = [];
      if (author.birth_date) meta.push(`Born: ${author.birth_date}`);
      if (author.death_date) meta.push(`Died: ${author.death_date}`);
      meta.push(`Works: ${author.work_count}`);
      if (author.ratings_average != null) meta.push(`Rating: ${author.ratings_average.toFixed(1)}`);
      if (meta.length) lines.push(meta.join(' | '));
      if (author.top_work) lines.push(`**Top work:** ${author.top_work}`);
      if (author.alternate_names.length)
        lines.push(`**Alternate names:** ${author.alternate_names.join(', ')}`);
      if (author.top_subjects.length)
        lines.push(
          `**Top subjects:** ${author.top_subjects.slice(0, TOP_SUBJECTS_TEXT_CAP).join(', ')}`,
        );
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
