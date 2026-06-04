/**
 * @fileoverview Work detail resource — injectable context for chat about a specific book.
 * @module mcp-server/resources/definitions/openlibrary-work.resource
 */

import { resource, z } from '@cyanheads/mcp-ts-core';
import { notFound } from '@cyanheads/mcp-ts-core/errors';
import { getOpenLibraryService } from '@/services/open-library/open-library-service.js';

export const openlibraryWorkResource = resource('openlibrary://works/{work_id}', {
  name: 'openlibrary-work',
  title: 'Open Library Work',
  description:
    'Work detail by Open Library Work ID (OL…W). Provides title, description, subjects, cover IDs, and author IDs as injectable context for a conversation about a specific book.',
  mimeType: 'application/json',
  params: z.object({
    work_id: z.string().describe('Open Library Work ID (e.g., OL45804W).'),
  }),
  output: z.object({
    work_id: z.string().describe('Open Library Work ID.'),
    title: z.string().describe('Work title.'),
    description: z.string().optional().describe('Work description. Absent when not provided.'),
    subjects: z.array(z.string()).describe('Subject tags.'),
    subject_places: z.array(z.string()).describe('Geographic subjects.'),
    subject_times: z.array(z.string()).describe('Time period subjects.'),
    subject_people: z.array(z.string()).describe('People subjects.'),
    cover_ids: z.array(z.number()).describe('Numeric cover IDs for openlibrary_get_cover_url.'),
    author_ids: z.array(z.string()).describe('Open Library Author IDs (OL…A).'),
    created: z.string().optional().describe('ISO 8601 creation timestamp.'),
    last_modified: z.string().optional().describe('ISO 8601 last-modified timestamp.'),
  }),

  async handler(params, ctx) {
    ctx.log.info('Fetching work resource', { work_id: params.work_id });
    const result = await getOpenLibraryService().getWork(params.work_id, ctx);
    if (!result) throw notFound(`Work ${params.work_id} not found on Open Library.`);
    return result;
  },
});
