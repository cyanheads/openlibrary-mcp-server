/**
 * @fileoverview Full-text search inside the scanned text of Internet Archive books.
 * @module mcp-server/tools/definitions/openlibrary-search-inside.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { escapeMarkdownInline } from '@cyanheads/mcp-ts-core/utils';
import {
  applyPaginationLimit,
  composeNotices,
  INSIDE_PAGE_CEILING,
  paginationLimit,
  paginationLimitNotice,
  pastEndNotice,
} from '@/mcp-server/tools/limit-policy.js';
import { getOpenLibraryService } from '@/services/open-library/open-library-service.js';
import { isBlank } from '@/services/open-library/search-criteria.js';

/**
 * `/search/inside.json` serves `offset + limit` up to this many results; past it, it answers
 * HTTP 200 with an error object in place of hits, which no retry changes.
 */
const RESULT_WINDOW = 10_000;

export const openlibrarySearchInside = tool('openlibrary_search_inside', {
  title: 'Search Inside Books',
  description:
    'Search the full text of books scanned by the Internet Archive — the "which book contains this passage?" lookup that the metadata tools cannot answer. Quote a phrase for an exact-phrase match; bare terms match anywhere in the text. Each result is an Internet Archive item with the matching passages as snippets, plus a relevance score. The full-text index is far slower than the metadata endpoints, and a search usually takes 10–30 seconds. Use it when the passage is the question, and use openlibrary_search_books to search by title, author, or subject. Results key on Internet Archive items rather than Open Library works. To reach the catalogue record, pass an ia_identifier to openlibrary_search_books as query "ia:<ia_identifier>", which returns its work and, in matching_edition, the edition holding that scan; when that matches nothing (a scan no edition records), search openlibrary_search_books by the item\'s title and creator and compare the ia_identifiers on its results. Each ia_identifier also reads at archive.org.',
  annotations: { readOnlyHint: true, openWorldHint: true },
  input: z.object({
    query: z
      .string()
      .min(1)
      .describe(
        'Text to find inside scanned books. Wrap in double quotes for an exact-phrase match (e.g., "the spice must flow"); unquoted terms match independently and return far broader results.',
      ),
    limit: paginationLimit(10).describe(
      `Max matching items to return; values above ${INSIDE_PAGE_CEILING} apply ${INSIDE_PAGE_CEILING} when limit clamping is enabled. Each carries its own snippets, so higher values grow the response quickly — prefer 10–20.`,
    ),
    offset: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe(
        'Zero-based offset for pagination, below 10000: the full-text index serves only its first 10,000 results, so a page that would run past them is shortened to end there.',
      ),
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
                'Every passage containing the match, with the upstream highlight markers removed.',
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

  errors: [
    {
      reason: 'no_search_criteria',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The query is whitespace-only, so there is no text to search for.',
      recovery:
        'Supply a non-blank query holding the passage to find, such as "the spice must flow".',
    },
    {
      reason: 'offset_past_result_window',
      code: JsonRpcErrorCode.ValidationError,
      when: "offset is 10000 or more, past the first 10,000 results Open Library's full-text index serves.",
      recovery:
        'Use an offset below 10000, or narrow or quote the query so the matches you need rank within its first 10,000 results.',
    },
    {
      reason: 'upstream_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: "Open Library's full-text search answered HTTP 200 without a result set — no hits object carrying a total.",
      recovery:
        "Open Library's full-text search failed to answer, which says nothing about whether the passage exists — wait a few seconds and retry the same query unchanged.",
      retryable: true,
      // The service classifies the malformed body below the handler.
      thrownBy: 'service',
    },
  ],

  /** Agent-facing context: total match count and page guidance. */
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
        'Guidance for an empty page, a requested limit above the page ceiling, or a page shortened to end at the 10,000-result window. Absent when none applies.',
      ),
  },

  async handler(input, ctx) {
    if (isBlank(input.query)) {
      throw ctx.fail('no_search_criteria', 'The full-text search query is whitespace-only.');
    }
    if (input.offset >= RESULT_WINDOW) {
      throw ctx.fail(
        'offset_past_result_window',
        `Offset ${input.offset} is past the first 10,000 results Open Library's full-text index serves; the last offset it answers is 9999.`,
      );
    }
    ctx.log.info('Searching inside books', {
      query: input.query,
      limit: input.limit,
      offset: input.offset,
    });

    const svc = getOpenLibraryService();
    // A page that would cross the window is fitted to it, as one clamp with one notice.
    const limit = applyPaginationLimit(
      input.limit,
      Math.min(INSIDE_PAGE_CEILING, RESULT_WINDOW - input.offset),
      'openlibrary_search_inside',
      ctx,
    );
    const result = await svc.searchInside(input.query, limit, input.offset, ctx);
    const limitNotice = paginationLimitNotice(
      input.limit,
      limit,
      input.offset,
      result.matches.length,
      Math.min(result.total, RESULT_WINDOW),
    );
    // A shortened page that reaches the window's last row, with matches ranked past it, has no next page.
    const windowNotice =
      limit < input.limit && input.offset + limit >= RESULT_WINDOW && result.total > RESULT_WINDOW
        ? "Open Library's full-text index serves only its first 10,000 results; narrow or quote the query to reach matches ranked below them."
        : undefined;

    // Always the upstream match count, including on an empty page: an over-paged
    // request matched items, and reporting 0 would misdirect the correction.
    ctx.enrich.total(result.total);

    const emptyNotice =
      result.matches.length > 0
        ? undefined
        : result.total > 0
          ? pastEndNotice(
              result.offset,
              result.total,
              `${result.total} items matched`,
              'the query itself matched',
            )
          : `No scanned book contains ${escapeMarkdownInline(input.query)}. An exact-phrase query only matches the wording as printed — drop the quotes to match the terms independently, or shorten the phrase.`;
    const notice = composeNotices(limitNotice, windowNotice, emptyNotice);
    if (notice) ctx.enrich.notice(notice);

    return { total: result.total, offset: result.offset, matches: result.matches };
  },

  format: (result) => {
    const lines: string[] = [];
    lines.push(
      `**Total results:** ${result.total} | **Offset:** ${result.offset} | **Returned:** ${result.matches.length}`,
    );

    for (const match of result.matches) {
      lines.push('');
      lines.push('## Match');
      if (match.title !== undefined) lines.push(`**Title:** ${escapeMarkdownInline(match.title)}`);
      lines.push(
        `**IA identifier:** ${escapeMarkdownInline(match.ia_identifier)} | **Score:** ${match.score}`,
      );
      if (match.creator !== undefined)
        lines.push(`**Creator:** ${escapeMarkdownInline(match.creator)}`);
      if (match.snippets.length === 0) lines.push('**Snippets:** []');
      for (const snippet of match.snippets) {
        lines.push(`**Passage:** ${escapeMarkdownInline(snippet)}`);
      }
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
