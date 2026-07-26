/**
 * @fileoverview Fetch author detail by Open Library Author ID.
 * @module mcp-server/tools/definitions/openlibrary-get-author.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  getOpenLibraryService,
  normalizeAuthorId,
} from '@/services/open-library/open-library-service.js';

export const openlibraryGetAuthor = tool('openlibrary_get_author', {
  title: 'Get Author',
  description:
    'Fetch author detail by Open Library Author ID (OL…A). Returns bio, birth/death dates, photo IDs, and linked identifiers from Wikidata, VIAF, ISNI, Goodreads, and LibraryThing. Use openlibrary_search_authors to find an author ID first.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    author_id: z
      .string()
      .describe(
        'Open Library Author ID. Format: OL…A (e.g., "OL24638A"). A leading "/authors/" prefix is stripped if provided.',
      ),
  }),
  output: z.object({
    author_id: z.string().describe('Canonical Open Library Author ID (OL…A).'),
    name: z.string().describe('Primary author name.'),
    personal_name: z
      .string()
      .optional()
      .describe('Personal or given name. Absent when not recorded.'),
    fuller_name: z
      .string()
      .optional()
      .describe('Full name including middle names. Absent when not recorded.'),
    bio: z.string().optional().describe('Author biography. Absent when not provided.'),
    birth_date: z.string().optional().describe('Birth date string. Absent when not recorded.'),
    death_date: z.string().optional().describe('Death date string. Absent when not recorded.'),
    photo_ids: z
      .array(z.number())
      .describe(
        'Numeric photo IDs. Pass to openlibrary_get_cover_url with target "author" and id_type "id".',
      ),
    remote_ids: z
      .object({
        wikidata: z.string().optional().describe('Wikidata entity ID (e.g., Q12345).'),
        viaf: z.string().optional().describe('VIAF identifier.'),
        isni: z.string().optional().describe('ISNI identifier.'),
        goodreads: z.string().optional().describe('Goodreads author ID.'),
        librarything: z.string().optional().describe('LibraryThing author identifier.'),
      })
      .describe('Remote identifiers for cross-referencing with other databases.'),
  }),
  enrichment: {
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
    ctx.log.info('Fetching author', { author_id: input.author_id });
    const svc = getOpenLibraryService();
    const result = await svc.getAuthor(input.author_id, ctx);
    if (!result) {
      throw ctx.fail(
        'not_found',
        `Author ${input.author_id} not found on Open Library.`,
        ctx.recoveryFor('not_found'),
      );
    }
    // A merged author stays reachable under its old ID, so the record returned can
    // be a different author's than was asked for. `format()` never sees the input,
    // so the substitution is disclosed here — and only on an actual difference, or
    // every ordinary lookup would carry an empty notice.
    const requested = normalizeAuthorId(input.author_id);
    if (result.author_id !== requested) {
      ctx.enrich.notice(
        `${requested} is a merged record; this is the canonical author ${result.author_id}. Use ${result.author_id} for further lookups.`,
      );
    }
    return result;
  },

  format: (result) => {
    const lines: string[] = [];
    lines.push(`## ${result.name}`);
    lines.push(`**Author ID:** ${result.author_id}`);
    if (result.personal_name) lines.push(`**Personal name:** ${result.personal_name}`);
    if (result.fuller_name) lines.push(`**Fuller name:** ${result.fuller_name}`);
    const dates: string[] = [];
    if (result.birth_date) dates.push(`Born: ${result.birth_date}`);
    if (result.death_date) dates.push(`Died: ${result.death_date}`);
    if (dates.length) lines.push(dates.join(' | '));
    if (result.bio) {
      lines.push('');
      lines.push(result.bio);
    }
    if (result.photo_ids.length) lines.push(`**Photo IDs:** ${result.photo_ids.join(', ')}`);
    const remoteIds = Object.entries(result.remote_ids)
      .filter(([, v]) => v != null)
      .map(([k, v]) => `${k}: ${v}`);
    if (remoteIds.length) lines.push(`**External IDs:** ${remoteIds.join(' | ')}`);
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
