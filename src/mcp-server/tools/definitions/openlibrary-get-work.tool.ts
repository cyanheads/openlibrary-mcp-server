/**
 * @fileoverview Fetch a work by Open Library Work ID.
 * @module mcp-server/tools/definitions/openlibrary-get-work.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { NO_TITLE } from '@/mcp-server/tools/heading-placeholders.js';
import { WORK_ID_MESSAGE, WORK_ID_PATTERN } from '@/mcp-server/tools/work-id.js';
import {
  getOpenLibraryService,
  normalizeWorkId,
} from '@/services/open-library/open-library-service.js';

/**
 * Max subject tags rendered in the `content[]` text. `structuredContent` always
 * carries the complete `subjects` array; only the human-facing text is capped,
 * with the omitted count disclosed via the enrichment trailer.
 */
const SUBJECTS_TEXT_CAP = 10;

export const openlibraryGetWork = tool('openlibrary_get_work', {
  title: 'Get Work',
  description:
    'Fetch a work by Open Library Work ID (OL…W). Returns title, description, subjects, cover IDs, and linked author IDs for follow-up lookups. Works represent the abstract book concept independent of any specific edition. A merged work ID resolves to the work it was merged into. To reach a work from an ISBN, call openlibrary_get_edition with id_type "isbn" — its work_id output is the parent work. Note: author names are not included — use openlibrary_get_author or openlibrary_search_books for names.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    work_id: z
      .string()
      .regex(WORK_ID_PATTERN, WORK_ID_MESSAGE)
      .describe(
        'Open Library Work ID. Format: OL…W (e.g., "OL45804W"), optionally prefixed "/works/". Not an ISBN — resolve an ISBN to its work with openlibrary_get_edition (id_type "isbn").',
      ),
  }),
  output: z.object({
    work_id: z
      .string()
      .describe(
        'Canonical Open Library Work ID (OL…W) — differs from the requested work_id when that ID was merged into this work.',
      ),
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
      when: 'Work ID does not exist on Open Library, or it redirects to no reachable work.',
      recovery:
        'Verify the Work ID (e.g., "OL45804W") or find it with openlibrary_search_books; holding an ISBN, call openlibrary_get_edition with id_type "isbn", whose work_id output is the parent work.',
    },
  ],

  /** Agent-facing context: merged-ID substitution and subject-cap disclosures. */
  enrichment: {
    notice: z
      .string()
      .optional()
      .describe(
        'Set when the requested work ID was merged into a different canonical ID, and when the text output caps a long subject list (naming the omitted count and the complete array in structuredContent). Absent when neither applies.',
      ),
  },

  async handler(input, ctx) {
    ctx.log.info('Fetching work', { work_id: input.work_id });
    const svc = getOpenLibraryService();
    const result = await svc.getWork(input.work_id, ctx);
    if (!result) {
      throw ctx.fail(
        'not_found',
        `Work ${input.work_id} not found on Open Library.`,
        ctx.recoveryFor('not_found'),
      );
    }

    // `notice` is last-wins, so both disclosures are joined into one string.
    const notices: string[] = [];
    const requested = normalizeWorkId(input.work_id);
    if (result.work_id !== requested) {
      notices.push(
        `${requested} is a merged record; this is ${result.work_id}. Use ${result.work_id} for further lookups.`,
      );
    }
    // Disclose the subjects that format() caps out of the text; structuredContent keeps all.
    if (result.subjects.length > SUBJECTS_TEXT_CAP) {
      notices.push(
        `Subjects are capped at ${SUBJECTS_TEXT_CAP} in text output; showing ${SUBJECTS_TEXT_CAP} of ${result.subjects.length}. The full list is in structuredContent (subjects).`,
      );
    }
    if (notices.length) ctx.enrich.notice(notices.join(' '));

    return result;
  },

  format: (result) => {
    const lines: string[] = [];
    lines.push(`## ${result.title || NO_TITLE}`);
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
      lines.push(`**Subjects:** ${result.subjects.slice(0, SUBJECTS_TEXT_CAP).join(', ')}`);
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
