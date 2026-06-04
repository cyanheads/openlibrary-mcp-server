/**
 * @fileoverview Fetch a work by Open Library Work ID.
 * @module mcp-server/tools/definitions/openlibrary-get-work.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getOpenLibraryService } from '@/services/open-library/open-library-service.js';

export const openlibraryGetWork = tool('openlibrary_get_work', {
  title: 'Get Work',
  description:
    'Fetch a work by Open Library Work ID (OL…W). Returns title, description, subjects, cover IDs, and linked author IDs for follow-up lookups. Works represent the abstract book concept independent of any specific edition. Note: author names are not included — use openlibrary_get_author or openlibrary_search_books for names.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    work_id: z
      .string()
      .describe(
        'Open Library Work ID. Format: OL…W (e.g., "OL45804W"). A leading "/works/" prefix is stripped if provided.',
      ),
  }),
  output: z.object({
    work_id: z.string().describe('Canonical Open Library Work ID (OL…W).'),
    title: z.string().describe('Work title.'),
    description: z
      .string()
      .optional()
      .describe('Work description or blurb. Absent when not provided.'),
    subjects: z.array(z.string()).describe('Subject tags for this work.'),
    subject_places: z.array(z.string()).describe('Geographic subjects.'),
    subject_times: z.array(z.string()).describe('Time period subjects.'),
    subject_people: z.array(z.string()).describe('People subjects.'),
    cover_ids: z
      .array(z.number())
      .describe('Numeric cover IDs. Pass to openlibrary_get_cover_url with id_type "id".'),
    author_ids: z
      .array(z.string())
      .describe('Open Library Author IDs (OL…A). Use openlibrary_get_author for names and bio.'),
    created: z
      .string()
      .optional()
      .describe('ISO 8601 creation timestamp. Absent when not available.'),
    last_modified: z
      .string()
      .optional()
      .describe('ISO 8601 last-modified timestamp. Absent when not available.'),
  }),
  errors: [
    {
      reason: 'not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'Work ID does not exist on Open Library.',
      recovery:
        'Verify the OLID format (e.g., "OL45804W") or use openlibrary_search_books to find the correct ID.',
    },
  ],

  async handler(input, ctx) {
    ctx.log.info('Fetching work', { work_id: input.work_id });
    const svc = getOpenLibraryService();
    const result = await svc.getWork(input.work_id, ctx);
    if (!result) throw ctx.fail('not_found', `Work ${input.work_id} not found on Open Library.`);
    return result;
  },

  format: (result) => {
    const lines: string[] = [];
    lines.push(`## ${result.title}`);
    lines.push(`**Work ID:** ${result.work_id}`);
    if (result.description) {
      lines.push('');
      lines.push(result.description);
    }
    if (result.author_ids.length) {
      lines.push('');
      lines.push(`**Author IDs:** ${result.author_ids.join(', ')}`);
    }
    if (result.cover_ids.length) {
      lines.push(`**Cover IDs:** ${result.cover_ids.join(', ')}`);
    }
    if (result.subjects.length) {
      lines.push(`**Subjects:** ${result.subjects.slice(0, 10).join(', ')}`);
    }
    if (result.subject_places.length) {
      lines.push(`**Places:** ${result.subject_places.join(', ')}`);
    }
    if (result.subject_times.length) {
      lines.push(`**Time periods:** ${result.subject_times.join(', ')}`);
    }
    if (result.subject_people.length) {
      lines.push(`**People:** ${result.subject_people.join(', ')}`);
    }
    if (result.created) lines.push(`**Created:** ${result.created}`);
    if (result.last_modified) lines.push(`**Last modified:** ${result.last_modified}`);
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
