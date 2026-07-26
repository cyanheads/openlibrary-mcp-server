/**
 * @fileoverview Full-text search inside the scanned text of Internet Archive books.
 * @module mcp-server/tools/definitions/openlibrary-search-inside.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { cappedListNotice } from '@/mcp-server/tools/capped-list-notice.js';
import { getOpenLibraryService } from '@/services/open-library/open-library-service.js';

/**
 * Max snippets rendered per match in the `content[]` text. `structuredContent`
 * always carries every snippet the index returned; only the human-facing text is
 * capped, with the omitted count disclosed via the enrichment trailer.
 */
const SNIPPETS_TEXT_CAP = 3;

export const openlibrarySearchInside = tool('openlibrary_search_inside', {
  title: 'Search Inside Books',
  description:
    'Search the full text of books scanned by the Internet Archive — the "which book contains this passage?" lookup that the metadata tools cannot answer. Quote a phrase for an exact-phrase match; bare terms match anywhere in the text. Each result is an Internet Archive item with the matching passages as snippets, plus a relevance score. The full-text index is an order of magnitude slower than the metadata endpoints (seconds, not milliseconds), so reach for it when the passage is the question, not as a general book search — use openlibrary_search_books for title, author, or subject. Results key on Internet Archive items rather than Open Library works: chain the returned ia_identifier to archive.org, or match it against the ia_identifiers on openlibrary_search_books results to reach the catalogue record.',
  annotations: { readOnlyHint: true, openWorldHint: true },
  input: z.object({
    query: z
      .string()
      .min(1)
      .describe(
        'Text to find inside scanned books. Wrap in double quotes for an exact-phrase match (e.g., "the spice must flow"); unquoted terms match independently and return far broader results.',
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .default(10)
      .describe(
        'Max matching items to return. Each carries its own snippets, so higher values grow the response quickly — prefer 10–20.',
      ),
    offset: z.number().int().min(0).default(0).describe('Zero-based offset for pagination.'),
  }),
  output: z.object({
    total: z.number().describe('Total matching Internet Archive items across all pages.'),
    offset: z.number().describe('Zero-based offset of the first returned match.'),
    matches: z
      .array(
        z
          .object({
            ia_identifier: z
              .string()
              .describe(
                'Internet Archive item identifier — readable at https://archive.org/details/{ia_identifier}, and the same value openlibrary_search_books returns in ia_identifiers.',
              ),
            title: z
              .string()
              .optional()
              .describe('Item title from Internet Archive metadata. Absent when not recorded.'),
            creator: z
              .string()
              .optional()
              .describe(
                'Author or creator from Internet Archive metadata, as catalogued (e.g., "Burridge, Jay, author"). Absent when not recorded — genuinely missing on some items, not an error.',
              ),
            snippets: z
              .array(z.string())
              .describe(
                'Passages containing the match, with the upstream highlight markers removed. The text output caps how many are rendered per item; this array is complete.',
              ),
            score: z
              .number()
              .describe(
                'Relevance score from the full-text index. Comparable within one result set only.',
              ),
          })
          .describe('A book whose scanned text contains the query.'),
      )
      .describe('Matching items, up to limit, ordered by relevance.'),
  }),

  /** Agent-facing context: total match count, empty-result and snippet-cap notices. */
  enrichment: {
    totalCount: z
      .number()
      .optional()
      .describe(
        'Total matching items across all pages — the upstream match count, reported even when this page is empty because offset ran past the end.',
      ),
    notice: z
      .string()
      .optional()
      .describe(
        'Guidance when the page is empty (how to broaden a query that matched nothing, or which offset to retry when offset ran past the end) or when the text output capped a per-item snippet list. Absent when neither applies.',
      ),
  },

  async handler(input, ctx) {
    ctx.log.info('Searching inside books', {
      query: input.query,
      limit: input.limit,
      offset: input.offset,
    });

    const svc = getOpenLibraryService();
    const result = await svc.searchInside(input.query, input.limit, input.offset, ctx);

    // Always the upstream match count, including on an empty page: an over-paged
    // request matched items, and reporting 0 would misdirect the correction.
    ctx.enrich.total(result.total);

    if (result.matches.length === 0) {
      ctx.enrich.notice(
        result.total > 0
          ? `Offset ${result.offset} is past the end of the result set — ${result.total} items matched, so the last offset that returns a result is ${result.total - 1}. Retry with a lower offset; the query itself matched.`
          : `No scanned book contains ${input.query}. An exact-phrase query only matches the wording as printed — drop the quotes to match the terms independently, or shorten the phrase.`,
      );
      return { total: result.total, offset: result.offset, matches: [] };
    }

    // Disclose what format() caps out of the text; structuredContent keeps every
    // snippet the index returned.
    const capNotice = cappedListNotice(
      result.matches.map((match) => match.snippets.length),
      SNIPPETS_TEXT_CAP,
      { label: 'Snippets', unit: 'item', path: 'matches[].snippets' },
    );
    if (capNotice) ctx.enrich.notice(capNotice);

    return { total: result.total, offset: result.offset, matches: result.matches };
  },

  format: (result) => {
    const lines: string[] = [];
    lines.push(
      `**Total results:** ${result.total} | **Offset:** ${result.offset} | **Returned:** ${result.matches.length}`,
    );

    for (const match of result.matches) {
      lines.push('');
      lines.push(`## ${match.title ?? match.ia_identifier}`);
      lines.push(
        `**IA identifier:** ${match.ia_identifier} | **Score:** ${match.score.toFixed(2)}`,
      );
      lines.push(`**Creator:** ${match.creator ?? 'Not available'}`);
      for (const snippet of match.snippets.slice(0, SNIPPETS_TEXT_CAP)) {
        lines.push(`> ${snippet}`);
      }
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
