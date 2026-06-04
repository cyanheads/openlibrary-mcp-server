/**
 * @fileoverview Browse works by subject on Open Library.
 * @module mcp-server/tools/definitions/openlibrary-get-subject.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getOpenLibraryService } from '@/services/open-library/open-library-service.js';

export const openlibraryGetSubject = tool('openlibrary_get_subject', {
  title: 'Get Subject',
  description:
    'Browse works by subject. Returns matching works with edition counts and cover IDs, plus the total work count for the subject. Subjects are user-contributed and may be inconsistent ("science fiction", "Science fiction", "SF" are separate tags). Try lowercase forms first.',
  annotations: { readOnlyHint: true, openWorldHint: true },
  input: z.object({
    subject: z
      .string()
      .describe(
        'Subject name. Spaces are converted to underscores internally (e.g., "science fiction" → "science_fiction"). Use lowercase for best results.',
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .default(12)
      .describe('Max works to return. Subject pages typically show 12 at a time.'),
    offset: z.number().int().min(0).default(0).describe('Zero-based offset for pagination.'),
  }),
  output: z.object({
    subject_name: z.string().describe('Canonical subject name as stored on Open Library.'),
    subject_key: z.string().describe('Normalized subject key (lowercase, underscores).'),
    work_count: z.number().describe('Total works tagged with this subject.'),
    works: z
      .array(
        z
          .object({
            work_id: z.string().describe('Open Library Work ID (OL…W).'),
            title: z.string().describe('Work title.'),
            author_names: z.array(z.string()).describe('Author display names.'),
            edition_count: z.number().describe('Total editions for this work.'),
            cover_id: z
              .number()
              .optional()
              .describe('Numeric cover ID. Absent when no cover exists.'),
          })
          .describe('A work under this subject.'),
      )
      .describe('Works under this subject, up to limit.'),
  }),

  /** Agent-facing context: empty-result notice when the subject has no works. */
  enrichment: {
    notice: z
      .string()
      .optional()
      .describe(
        'Recovery guidance when work_count is 0 — echoes the subject and suggests alternatives. Absent when works are found.',
      ),
  },

  errors: [
    {
      reason: 'not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'Subject not found or has no works.',
      recovery:
        'Try a broader or alternate subject term (e.g., "fiction" instead of a specific subgenre).',
    },
  ],

  async handler(input, ctx) {
    ctx.log.info('Fetching subject', {
      subject: input.subject,
      limit: input.limit,
      offset: input.offset,
    });
    const svc = getOpenLibraryService();
    const result = await svc.getSubject(input.subject, input.limit, input.offset, ctx);

    if (!result)
      throw ctx.fail('not_found', `Subject "${input.subject}" not found on Open Library.`);

    if (result.work_count === 0) {
      ctx.enrich.notice(
        `No works found for subject "${input.subject}". Subjects on Open Library are user-contributed and case-sensitive — try lowercase (e.g., "science fiction"), an alternate form, or a broader term.`,
      );
      return {
        subject_name: result.subject_name,
        subject_key: result.subject_key,
        work_count: 0,
        works: [],
      };
    }

    return result;
  },

  format: (result) => {
    const lines: string[] = [];
    lines.push(`## Subject: ${result.subject_name}`);
    lines.push(
      `**Key:** ${result.subject_key} | **Total works:** ${result.work_count} | **Returned:** ${result.works.length}`,
    );

    for (const work of result.works) {
      lines.push('');
      lines.push(`### ${work.title}`);
      lines.push(`**Work ID:** ${work.work_id}`);
      if (work.author_names.length) lines.push(`**Authors:** ${work.author_names.join(', ')}`);
      lines.push(`**Editions:** ${work.edition_count}`);
      if (work.cover_id != null) lines.push(`**Cover ID:** ${work.cover_id}`);
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
