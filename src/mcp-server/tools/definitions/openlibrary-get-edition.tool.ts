/**
 * @fileoverview Fetch a single edition by identifier (ISBN, OCLC, LCCN, or OLID).
 * @module mcp-server/tools/definitions/openlibrary-get-edition.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getOpenLibraryService } from '@/services/open-library/open-library-service.js';

export const openlibraryGetEdition = tool('openlibrary_get_edition', {
  title: 'Get Edition',
  description:
    'Fetch a single edition by identifier: ISBN-10, ISBN-13, OCLC, LCCN, or Open Library Edition ID (OL…M). Returns full edition metadata including authors, publisher, language, all identifier types, and the parent work ID. When the edition record itself lists no authors, they are recovered from the parent work and marked as such. Use for ISBN lookups — pass id_type "isbn" for both ISBN-10 and ISBN-13.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    identifier: z
      .string()
      .describe(
        'The identifier value. For ISBN: 10 or 13 digits, hyphens stripped. For OCLC: numeric string. For LCCN: string as-is. For OLID: Open Library edition ID (e.g., OL7353617M).',
      ),
    id_type: z
      .enum(['isbn', 'oclc', 'lccn', 'olid'])
      .describe(
        'Identifier type. "isbn" handles both ISBN-10 and ISBN-13. "olid" is the native Open Library edition ID (OL…M).',
      ),
  }),
  output: z.object({
    edition_id: z.string().describe('Open Library Edition ID (OL…M).'),
    title: z.string().describe('Edition title.'),
    authors: z
      .array(
        z
          .object({
            name: z.string().describe('Author display name.'),
            author_id: z
              .string()
              .optional()
              .describe(
                'Open Library Author ID (OL…A). Use openlibrary_get_author for bio and details.',
              ),
            source: z
              .enum(['edition', 'work'])
              .describe(
                '"edition" = the attribution is recorded on this edition record. "work" = the edition records no authors of its own and this credit comes from the parent work, which covers every edition of the same text.',
              ),
          })
          .describe('An author contributor for this edition.'),
      )
      .describe(
        'Authors credited for this edition. Empty only when neither the edition nor its parent work records an author.',
      ),
    publish_date: z
      .string()
      .optional()
      .describe('Publication date string. Absent when not recorded.'),
    publishers: z.array(z.string()).describe('Publisher names.'),
    language: z
      .string()
      .optional()
      .describe('3-letter ISO language code (e.g., "eng"). Absent when not recorded.'),
    isbn_10: z.array(z.string()).describe('ISBN-10 identifiers.'),
    isbn_13: z.array(z.string()).describe('ISBN-13 identifiers.'),
    oclc: z.array(z.string()).describe('OCLC/WorldCat numbers.'),
    lccn: z
      .array(z.string())
      .describe(
        'Library of Congress Control Numbers (e.g., "2008478952") — lookupable identifiers; each one resolves this edition back through this tool with id_type "lccn".',
      ),
    lc_classifications: z
      .array(z.string())
      .describe(
        'Library of Congress call numbers (e.g., "TL685.7 .M366 2008") — shelving classifications describing the subject, not identifiers. Not usable as a lookup value anywhere.',
      ),
    page_count: z.number().optional().describe('Page count. Absent when not recorded.'),
    description: z.string().optional().describe('Edition description. Absent when not provided.'),
    cover_ids: z.array(z.number()).describe('Numeric cover IDs for openlibrary_get_cover_url.'),
    work_id: z
      .string()
      .optional()
      .describe('Parent Work ID (OL…W). Use openlibrary_get_work for work-level metadata.'),
    ebook_url: z
      .string()
      .optional()
      .describe('Internet Archive URL for reading/borrowing. Present when an IA item exists.'),
  }),
  errors: [
    {
      reason: 'not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'No edition found for the given identifier.',
      recovery:
        'Verify the identifier value or try searching by title/author with openlibrary_search_books.',
    },
    {
      reason: 'invalid_identifier',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Identifier format is invalid for the specified id_type.',
      recovery:
        'Check the identifier format: ISBNs are 10 or 13 digits; OCLC numbers are numeric; OLIDs end in M (e.g., OL7353617M).',
    },
  ],

  handler(input, ctx) {
    ctx.log.info('Fetching edition', { identifier: input.identifier, id_type: input.id_type });

    // Basic validation — return rejected Promise so callers can use await
    if (input.id_type === 'isbn') {
      const digits = input.identifier.replace(/-/g, '');
      if (!/^\d{10}$/.test(digits) && !/^\d{13}$/.test(digits)) {
        return Promise.reject(
          ctx.fail(
            'invalid_identifier',
            `"${input.identifier}" is not a valid ISBN (must be 10 or 13 digits).`,
          ),
        );
      }
    } else if (input.id_type === 'olid') {
      if (!/^OL\d+M$/i.test(input.identifier)) {
        return Promise.reject(
          ctx.fail(
            'invalid_identifier',
            `"${input.identifier}" is not a valid Open Library Edition ID. Expected format: OL…M (e.g., OL7353617M).`,
          ),
        );
      }
    } else if (input.id_type === 'oclc') {
      if (!/^\d+$/.test(input.identifier)) {
        return Promise.reject(
          ctx.fail(
            'invalid_identifier',
            `"${input.identifier}" is not a valid OCLC number (must be numeric).`,
          ),
        );
      }
    }

    const svc = getOpenLibraryService();
    return svc.getEditionByIdentifier(input.identifier, input.id_type, ctx);
  },

  format: (result) => {
    const lines: string[] = [];
    lines.push(`## ${result.title}`);
    lines.push(`**Edition ID:** ${result.edition_id}`);
    const renderAuthor = (a: { name: string; author_id?: string | undefined }) =>
      a.author_id ? `${a.name} (${a.author_id})` : a.name;
    const editionAuthors = result.authors.filter((a) => a.source === 'edition');
    const workAuthors = result.authors.filter((a) => a.source === 'work');
    if (editionAuthors.length) {
      lines.push(`**Authors:** ${editionAuthors.map(renderAuthor).join(', ')}`);
    }
    if (workAuthors.length) {
      lines.push(
        `**Authors (from parent work — not recorded on this edition):** ${workAuthors.map(renderAuthor).join(', ')}`,
      );
    }
    const meta: string[] = [];
    if (result.publish_date) meta.push(`Published: ${result.publish_date}`);
    if (result.publishers.length) meta.push(`Publisher: ${result.publishers.join(', ')}`);
    if (result.language) meta.push(`Language: ${result.language}`);
    if (result.page_count != null) meta.push(`Pages: ${result.page_count}`);
    if (meta.length) lines.push(meta.join(' | '));
    if (result.isbn_13.length) lines.push(`**ISBN-13:** ${result.isbn_13.join(', ')}`);
    if (result.isbn_10.length) lines.push(`**ISBN-10:** ${result.isbn_10.join(', ')}`);
    if (result.oclc.length) lines.push(`**OCLC:** ${result.oclc.join(', ')}`);
    if (result.lccn.length) lines.push(`**LCCN:** ${result.lccn.join(', ')}`);
    if (result.lc_classifications.length) {
      lines.push(`**LC call number:** ${result.lc_classifications.join(', ')}`);
    }
    if (result.description) {
      lines.push('');
      lines.push(result.description);
    }
    if (result.cover_ids.length) lines.push(`**Cover IDs:** ${result.cover_ids.join(', ')}`);
    if (result.work_id) lines.push(`**Work ID:** ${result.work_id}`);
    if (result.ebook_url) lines.push(`**E-book:** ${result.ebook_url}`);
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
