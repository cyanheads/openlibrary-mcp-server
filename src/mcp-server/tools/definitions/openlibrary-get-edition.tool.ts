/**
 * @fileoverview Resolve a batch of editions by identifier (ISBN, OCLC, LCCN, or OLID).
 * @module mcp-server/tools/definitions/openlibrary-get-edition.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { NO_TITLE } from '@/mcp-server/tools/heading-placeholders.js';
import { getOpenLibraryService } from '@/services/open-library/open-library-service.js';
import type { EditionIdType } from '@/services/open-library/types.js';

/**
 * Max identifiers per call. Open Library resolves the whole batch in one
 * `/api/books` request; 50 keys measure ~2s and ~60KB of detail records, which
 * is where one response stops being worth the round trips it saves.
 */
const MAX_IDENTIFIERS = 50;

/**
 * Names the shape an identifier was expected to have, or `undefined` when it is
 * well-formed for its type. LCCN has no fixed format upstream, so it passes
 * through unchecked.
 */
function identifierExpectation(identifier: string, idType: EditionIdType): string | undefined {
  if (idType === 'isbn') {
    const digits = identifier.replace(/-/g, '');
    return /^\d{10}$/.test(digits) || /^\d{13}$/.test(digits)
      ? undefined
      : 'an ISBN of 10 or 13 digits';
  }
  if (idType === 'olid') {
    return /^OL\d+M$/i.test(identifier)
      ? undefined
      : 'an Open Library Edition ID of the form OL…M (e.g., OL7353617M)';
  }
  if (idType === 'oclc') {
    return /^\d+$/.test(identifier) ? undefined : 'a numeric OCLC number';
  }
  return;
}

export const openlibraryGetEdition = tool('openlibrary_get_edition', {
  title: 'Get Edition',
  description: `Resolve one or more editions by identifier: ISBN-10, ISBN-13, OCLC, LCCN, or Open Library Edition ID (OL…M). Every identifier in a call shares one id_type — pass id_type "isbn" for both ISBN-10 and ISBN-13. Up to ${MAX_IDENTIFIERS} identifiers resolve in a single upstream request, so a bibliography or shelf export costs one call rather than one per book; a large batch is a large response, so ask for what you need. Returns full edition metadata including authors, publisher, language, all identifier types, and the parent work ID, with author names inline and no secondary lookup; when the edition record itself lists no authors, they are recovered from the parent work and marked as such. Partial success is the norm — identifiers that resolve come back in editions, the rest are listed in unresolved with a reason, and the call fails only when nothing resolved.`,
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    identifiers: z
      .array(
        z
          .string()
          .describe(
            'One identifier value. For ISBN: 10 or 13 digits, hyphens optional. For OCLC: numeric string. For LCCN: string as-is. For OLID: Open Library edition ID (e.g., OL7353617M).',
          ),
      )
      .min(1)
      .max(MAX_IDENTIFIERS)
      .describe(
        `Identifiers to resolve, 1–${MAX_IDENTIFIERS}, all of the type named by id_type. Resolved editions come back in request order.`,
      ),
    id_type: z
      .enum(['isbn', 'oclc', 'lccn', 'olid'])
      .describe(
        'Identifier type shared by every entry in identifiers. "isbn" handles both ISBN-10 and ISBN-13. "olid" is the native Open Library edition ID (OL…M). Mixing types within one call is not supported — issue one call per type.',
      ),
  }),
  output: z.object({
    editions: z
      .array(
        z
          .object({
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
            description: z
              .string()
              .optional()
              .describe('Edition description. Absent when not provided.'),
            cover_ids: z
              .array(z.number())
              .describe('Numeric cover IDs for openlibrary_get_cover_url.'),
            work_id: z
              .string()
              .optional()
              .describe('Parent Work ID (OL…W). Use openlibrary_get_work for work-level metadata.'),
            ebook_url: z
              .string()
              .optional()
              .describe(
                'Internet Archive URL for reading/borrowing. Present when an IA item exists.',
              ),
          })
          .describe('A resolved edition record.'),
      )
      .describe(
        'Editions that resolved, in request order. Shorter than identifiers when any entry missed.',
      ),
    unresolved: z
      .array(
        z
          .object({
            identifier: z
              .string()
              .describe('The identifier as supplied, echoed so it can be matched to the request.'),
            reason: z
              .enum(['not_found', 'invalid_identifier'])
              .describe(
                '"invalid_identifier" = the value cannot be this id_type and was never sent upstream. "not_found" = well-formed, but Open Library holds no edition under it.',
              ),
          })
          .describe('An identifier that produced no edition.'),
      )
      .describe(
        'Identifiers that produced no edition. Empty when every identifier resolved; never overlaps editions.',
      ),
  }),
  errors: [
    {
      reason: 'not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'No identifier in the batch resolved to an edition.',
      recovery:
        'Verify the identifier values or try searching by title/author with openlibrary_search_books.',
    },
    {
      reason: 'invalid_identifier',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Every identifier in the batch is malformed for the specified id_type.',
      recovery:
        'Check the identifier format: ISBNs are 10 or 13 digits; OCLC numbers are numeric; OLIDs end in M (e.g., OL7353617M).',
    },
  ],

  async handler(input, ctx) {
    ctx.log.info('Fetching editions', { count: input.identifiers.length, id_type: input.id_type });

    // A malformed identifier is reported per entry rather than failing the batch,
    // so one bad ISBN in a bibliography does not cost the other nineteen.
    const unresolved: Array<{ identifier: string; reason: 'not_found' | 'invalid_identifier' }> =
      [];
    const wellFormed: string[] = [];
    for (const identifier of input.identifiers) {
      if (identifierExpectation(identifier, input.id_type)) {
        unresolved.push({ identifier, reason: 'invalid_identifier' });
      } else {
        wellFormed.push(identifier);
      }
    }

    const resolved = wellFormed.length
      ? await getOpenLibraryService().getEditionsByIdentifiers(wellFormed, input.id_type, ctx)
      : { editions: [], unresolved: [] };
    for (const identifier of resolved.unresolved) {
      unresolved.push({ identifier, reason: 'not_found' });
    }

    if (resolved.editions.length === 0) {
      // Nothing resolved: report the reason that actually applies, rather than
      // defaulting to not-found for identifiers never sent upstream.
      const allMalformed = unresolved.every((entry) => entry.reason === 'invalid_identifier');
      const reason = allMalformed ? 'invalid_identifier' : 'not_found';
      throw ctx.fail(
        reason,
        allMalformed
          ? `None of the ${unresolved.length} supplied identifiers are valid for id_type "${input.id_type}".`
          : `No edition found for any of the ${input.identifiers.length} identifiers of type "${input.id_type}".`,
        ctx.recoveryFor(reason),
      );
    }

    return { editions: resolved.editions, unresolved };
  },

  format: (result) => {
    const lines: string[] = [];
    const renderAuthor = (a: { name: string; author_id?: string | undefined }) =>
      a.author_id ? `${a.name} (${a.author_id})` : a.name;

    for (const edition of result.editions) {
      lines.push(`## ${edition.title || NO_TITLE}`);
      lines.push(`**Edition ID:** ${edition.edition_id}`);
      const editionAuthors = edition.authors.filter((a) => a.source === 'edition');
      const workAuthors = edition.authors.filter((a) => a.source === 'work');
      if (editionAuthors.length) {
        lines.push(`**Authors:** ${editionAuthors.map(renderAuthor).join(', ')}`);
      }
      if (workAuthors.length) {
        lines.push(
          `**Authors (from parent work — not recorded on this edition):** ${workAuthors.map(renderAuthor).join(', ')}`,
        );
      }
      const meta: string[] = [];
      if (edition.publish_date) meta.push(`Published: ${edition.publish_date}`);
      if (edition.publishers.length) meta.push(`Publisher: ${edition.publishers.join(', ')}`);
      if (edition.language) meta.push(`Language: ${edition.language}`);
      if (edition.page_count != null) meta.push(`Pages: ${edition.page_count}`);
      if (meta.length) lines.push(meta.join(' | '));
      if (edition.isbn_13.length) lines.push(`**ISBN-13:** ${edition.isbn_13.join(', ')}`);
      if (edition.isbn_10.length) lines.push(`**ISBN-10:** ${edition.isbn_10.join(', ')}`);
      if (edition.oclc.length) lines.push(`**OCLC:** ${edition.oclc.join(', ')}`);
      if (edition.lccn.length) lines.push(`**LCCN:** ${edition.lccn.join(', ')}`);
      if (edition.lc_classifications.length) {
        lines.push(`**LC call number:** ${edition.lc_classifications.join(', ')}`);
      }
      if (edition.description) {
        lines.push('');
        lines.push(edition.description);
      }
      if (edition.cover_ids.length) lines.push(`**Cover IDs:** ${edition.cover_ids.join(', ')}`);
      if (edition.work_id) lines.push(`**Work ID:** ${edition.work_id}`);
      if (edition.ebook_url) lines.push(`**E-book:** ${edition.ebook_url}`);
      lines.push('');
    }

    if (result.unresolved.length) {
      lines.push(`**Unresolved (${result.unresolved.length}):**`);
      for (const entry of result.unresolved) {
        lines.push(`- ${entry.identifier} — ${entry.reason}`);
      }
    }

    return [{ type: 'text', text: lines.join('\n').trimEnd() }];
  },
});
