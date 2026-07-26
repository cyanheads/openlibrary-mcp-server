/**
 * @fileoverview Full-text book search across Open Library works.
 * @module mcp-server/tools/definitions/openlibrary-search-books.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { cappedListNotice } from '@/mcp-server/tools/capped-list-notice.js';
import { normalizeLanguageCode } from '@/services/open-library/language-codes.js';
import { getOpenLibraryService } from '@/services/open-library/open-library-service.js';

/**
 * Max Internet Archive identifiers rendered per work in the `content[]` text.
 * `structuredContent` always carries the complete `ia_identifiers` array; only
 * the human-facing text is capped, with the omitted count disclosed via the
 * enrichment trailer.
 */
const IA_TEXT_CAP = 5;

/**
 * Max subject tags rendered per work in the `content[]` text. Same contract as
 * {@link IA_TEXT_CAP} — `structuredContent` carries every tag the search
 * returned, and the trailer names how many the text omits.
 */
const SUBJECTS_TEXT_CAP = 5;

export const openlibrarySearchBooks = tool('openlibrary_search_books', {
  title: 'Search Books',
  description:
    'Full-text book search across Open Library works. Supports field filters (title, author, subject, publisher, ISBN, language) and returns work-level records with edition counts, cover IDs, and reading availability. Use query for general search or combine specific field filters. Results are work-level — drill into editions via openlibrary_get_editions.',
  annotations: { readOnlyHint: true, openWorldHint: true },
  input: z.object({
    query: z
      .string()
      .optional()
      .describe(
        'Full-text search query. Supports Solr field prefixes: title:, author:, subject:, publisher:, isbn:, language:. Omit to use the filter parameters instead.',
      ),
    title: z
      .string()
      .optional()
      .describe('Filter by title. Matched against work title and alternative titles.'),
    author: z.string().optional().describe('Filter by author name. Partial names work.'),
    subject: z
      .string()
      .optional()
      .describe('Filter by subject tag (e.g., "science fiction", "history").'),
    publisher: z
      .string()
      .optional()
      .describe('Filter by publisher name. Partial names work (e.g., "Penguin").'),
    isbn: z
      .string()
      .optional()
      .describe('Find works that have editions with this ISBN (10 or 13 digits, hyphens ignored).'),
    language: z
      .string()
      .regex(/^[A-Za-z]{2,3}$/)
      .optional()
      .describe(
        'Restrict results to one language. Takes a 3-letter MARC code (e.g., "eng", "fre", "ger", "chi") — the same vocabulary openlibrary_get_edition and openlibrary_get_editions return. A 2-letter ISO 639-1 code (e.g., "en", "fr") is accepted and translated to its MARC equivalent; an unrecognized 2-letter code is rejected rather than silently ignored. The equivalent in-query form is language:eng.',
      ),
    sort: z
      .enum(['relevance', 'new', 'old', 'rating', 'editions'])
      .default('relevance')
      .describe(
        'Sort order. "relevance" uses Solr scoring. "new"/"old" sort by first publish year. "rating" by average community rating. "editions" by edition count.',
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .default(10)
      .describe(
        'Max results to return. Higher values increase response size; prefer 10–20 for exploration.',
      ),
    offset: z.number().int().min(0).default(0).describe('Zero-based offset for pagination.'),
    include_availability: z
      .boolean()
      .default(false)
      .describe(
        'Include live reading availability from Internet Archive (borrow/read status). Adds ~200ms latency. Use when the user needs to know if they can read the book online.',
      ),
  }),
  output: z.object({
    total: z.number().describe('Total matching works across all pages.'),
    offset: z.number().describe('Zero-based offset of the first returned result.'),
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
            author_names: z.array(z.string()).describe('Author display names.'),
            author_ids: z
              .array(z.string())
              .describe('Open Library Author IDs (OL…A) for follow-up lookups.'),
            first_publish_year: z
              .number()
              .optional()
              .describe('Year of first publication. Absent when unknown.'),
            edition_count: z.number().describe('Total editions catalogued for this work.'),
            cover_id: z
              .number()
              .optional()
              .describe(
                'Numeric cover ID. Pass to openlibrary_get_cover_url with id_type "id". Absent when no cover is available.',
              ),
            subjects: z
              .array(z.string())
              .optional()
              .describe(
                "Every subject tag the search index returned for this work. The text output caps the rendered list; this array is complete. Absent when no subjects are tagged. For the work record's own curated subject lists (places, times, people), use openlibrary_get_work.",
              ),
            ebook_access: z
              .enum(['no_ebook', 'unclassified', 'printdisabled', 'borrowable', 'public'])
              .describe(
                '"public" = freely readable. "borrowable" = borrow on Internet Archive. "printdisabled" = access for print-disabled users. "no_ebook" = no digital version. "unclassified" = a digital copy may exist but its access tier is not recorded.',
              ),
            has_fulltext: z
              .boolean()
              .describe('True when a full-text version exists on Internet Archive.'),
            ratings_average: z
              .number()
              .optional()
              .describe('Average community rating (1–5). Absent when no ratings exist.'),
            availability: z
              .object({
                status: z.string().describe('Availability status string from Internet Archive.'),
                available_to_browse: z
                  .boolean()
                  .describe('True when the book can be browsed for free.'),
                available_to_borrow: z.boolean().describe('True when the book can be borrowed.'),
                available_to_waitlist: z.boolean().describe('True when a waitlist is available.'),
                is_readable: z.boolean().describe('True when the book is freely readable online.'),
                is_lendable: z.boolean().describe('True when the book can be lent.'),
                is_previewable: z.boolean().describe('True when a limited preview is available.'),
                is_restricted: z.boolean().describe('True when access is restricted.'),
                openlibrary_edition: z
                  .string()
                  .optional()
                  .describe('Edition OLID the availability check was resolved against.'),
              })
              .nullable()
              .optional()
              .describe(
                'Live reading availability from Internet Archive. Present when include_availability is true and the work has an Internet Archive item. Null when include_availability is true but no IA item exists.',
              ),
            ia_identifiers: z
              .array(z.string())
              .describe('Internet Archive item identifiers associated with this work.'),
          })
          .describe('A work-level result from the search.'),
      )
      .describe('Matching works, up to limit.'),
  }),
  errors: [
    {
      reason: 'unknown_language_code',
      code: JsonRpcErrorCode.ValidationError,
      when: 'A 2-letter language value has no MARC equivalent, so no filter could be applied.',
      recovery:
        'Pass a 3-letter MARC language code such as "eng", "fre", "ger", or "spa" instead of the unrecognized value.',
    },
  ],

  /** Agent-facing context: the parsed query echo, total count, and empty-result notice. */
  enrichment: {
    queryEcho: z
      .string()
      .optional()
      .describe(
        'The effective search criteria as the server interpreted them — query string plus any active field filters. Absent when only a bare query is used.',
      ),
    totalCount: z
      .number()
      .optional()
      .describe(
        'Total matching works across all pages — the upstream match count, reported even when this page is empty because offset ran past the end.',
      ),
    notice: z
      .string()
      .optional()
      .describe(
        'Guidance when the page is empty (how to broaden a query that matched nothing, or which offset to retry when offset ran past the end) or when the text output capped a per-work list. Absent when neither applies.',
      ),
  },

  async handler(input, ctx) {
    ctx.log.info('Searching books', {
      query: input.query,
      title: input.title,
      author: input.author,
      subject: input.subject,
      limit: input.limit,
      offset: input.offset,
    });

    const svc = getOpenLibraryService();
    const result = await svc.searchBooks(input, ctx);

    // Build queryEcho from active filters for agent context
    const filters: string[] = [];
    if (input.query) filters.push(`query "${input.query}"`);
    if (input.title) filters.push(`title "${input.title}"`);
    if (input.author) filters.push(`author "${input.author}"`);
    if (input.subject) filters.push(`subject "${input.subject}"`);
    if (input.publisher) filters.push(`publisher "${input.publisher}"`);
    if (input.isbn) filters.push(`isbn "${input.isbn}"`);
    // Echo the MARC code actually sent upstream, not the caller's input — an echo
    // asserting a filter value that was never applied is worse than no echo. The
    // service already normalized (and rejected unmappable codes) above, so this
    // lookup cannot throw here.
    if (input.language) filters.push(`language "${normalizeLanguageCode(input.language)}"`);
    const queryEcho = filters.length > 1 ? filters.join(', ') : undefined;

    // Only echo when there is an effective echo value — keying `queryEcho: undefined`
    // survives the enrichment parse and renders a literal "undefined" in the trailer.
    if (queryEcho !== undefined) ctx.enrich({ queryEcho });
    // Always the upstream match count, including on an empty page: an over-paged
    // request matched works, and reporting 0 would misdirect the correction.
    ctx.enrich.total(result.total);

    if (result.works.length === 0) {
      if (result.total > 0) {
        ctx.enrich.notice(
          `Offset ${result.offset} is past the end of the result set — ${result.total} works matched, so the last offset that returns a result is ${result.total - 1}. Retry with a lower offset; the search criteria themselves matched.`,
        );
      } else {
        ctx.enrich.notice(
          filters.length
            ? `No works matched ${filters.join(', ')}. Try broader or different terms.`
            : 'No works matched your search. Try different filters or a general query.',
        );
      }
      return { total: result.total, offset: result.offset, works: [] };
    }

    // Disclose what format() caps out of the text; structuredContent keeps every
    // entry. `notice` is last-wins, so both caps ship as one composed string.
    const capNotices = [
      cappedListNotice(
        result.works.map((work) => work.ia_identifiers.length),
        IA_TEXT_CAP,
        {
          label: 'Internet Archive identifiers',
          unit: 'work',
          path: 'works[].ia_identifiers',
        },
      ),
      cappedListNotice(
        result.works.map((work) => work.subjects?.length ?? 0),
        SUBJECTS_TEXT_CAP,
        { label: 'Subjects', unit: 'work', path: 'works[].subjects' },
      ),
    ].filter((notice): notice is string => notice !== undefined);
    if (capNotices.length) ctx.enrich.notice(capNotices.join(' '));

    return { total: result.total, offset: result.offset, works: result.works };
  },

  format: (result) => {
    const lines: string[] = [];
    lines.push(
      `**Total results:** ${result.total} | **Offset:** ${result.offset} | **Returned:** ${result.works.length}`,
    );

    for (const work of result.works) {
      lines.push('');
      lines.push(`## ${work.title}`);
      lines.push(`**Work ID:** ${work.work_id}`);
      if (work.author_names.length) {
        lines.push(
          `**Authors:** ${work.author_names.join(', ')} (IDs: ${work.author_ids.join(', ')})`,
        );
      }
      const meta: string[] = [];
      if (work.first_publish_year != null) meta.push(`First published: ${work.first_publish_year}`);
      meta.push(`Editions: ${work.edition_count}`);
      meta.push(`E-book: ${work.ebook_access}`);
      if (work.has_fulltext) meta.push('Has full text');
      if (work.ratings_average != null) meta.push(`Rating: ${work.ratings_average.toFixed(1)}`);
      lines.push(meta.join(' | '));
      if (work.cover_id != null) lines.push(`**Cover ID:** ${work.cover_id}`);
      if (work.subjects?.length) {
        lines.push(`**Subjects:** ${work.subjects.slice(0, SUBJECTS_TEXT_CAP).join(', ')}`);
      }
      if (work.ia_identifiers.length) {
        lines.push(`**IA:** ${work.ia_identifiers.slice(0, IA_TEXT_CAP).join(', ')}`);
      }
      if (work.availability != null) {
        const avParts = [
          `Status: ${work.availability.status}`,
          `Browse: ${work.availability.available_to_browse}`,
          `Borrow: ${work.availability.available_to_borrow}`,
          `Waitlist: ${work.availability.available_to_waitlist}`,
          `Read: ${work.availability.is_readable}`,
          `Lend: ${work.availability.is_lendable}`,
          `Preview: ${work.availability.is_previewable}`,
          `Restricted: ${work.availability.is_restricted}`,
        ];
        if (work.availability.openlibrary_edition) {
          avParts.push(`Edition: ${work.availability.openlibrary_edition}`);
        }
        lines.push(`**Availability:** ${avParts.join(' | ')}`);
      } else if (work.availability === null) {
        lines.push('**Availability:** No Internet Archive item found.');
      }
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
