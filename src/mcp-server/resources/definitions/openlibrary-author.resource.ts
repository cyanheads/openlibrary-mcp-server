/**
 * @fileoverview Author detail resource — injectable context for chat about a specific author.
 * @module mcp-server/resources/definitions/openlibrary-author.resource
 */

import { resource, z } from '@cyanheads/mcp-ts-core';
import { notFound } from '@cyanheads/mcp-ts-core/errors';
import { getOpenLibraryService } from '@/services/open-library/open-library-service.js';

export const openlibraryAuthorResource = resource('openlibrary://authors/{author_id}', {
  name: 'openlibrary-author',
  title: 'Open Library Author',
  description:
    'Author detail by Open Library Author ID (OL…A). Provides name, bio, dates, photo IDs, and linked external identifiers as injectable context for a conversation about a specific author.',
  mimeType: 'application/json',
  params: z.object({
    author_id: z.string().describe('Open Library Author ID (e.g., OL24638A).'),
  }),
  output: z.object({
    author_id: z.string().describe('Open Library Author ID.'),
    name: z.string().describe('Primary author name.'),
    personal_name: z.string().optional().describe('Personal or given name.'),
    fuller_name: z.string().optional().describe('Full name including middle names.'),
    bio: z.string().optional().describe('Author biography. Absent when not provided.'),
    birth_date: z.string().optional().describe('Birth date string.'),
    death_date: z.string().optional().describe('Death date string.'),
    photo_ids: z.array(z.number()).describe('Numeric photo IDs for openlibrary_get_cover_url.'),
    remote_ids: z
      .object({
        wikidata: z.string().optional().describe('Wikidata entity ID.'),
        viaf: z.string().optional().describe('VIAF identifier.'),
        isni: z.string().optional().describe('ISNI identifier.'),
        goodreads: z.string().optional().describe('Goodreads author ID.'),
        librarything: z.string().optional().describe('LibraryThing author identifier.'),
      })
      .describe('External identifiers for cross-referencing.'),
  }),

  async handler(params, ctx) {
    ctx.log.info('Fetching author resource', { author_id: params.author_id });
    const result = await getOpenLibraryService().getAuthor(params.author_id, ctx);
    if (!result) throw notFound(`Author ${params.author_id} not found on Open Library.`);
    return result;
  },
});
