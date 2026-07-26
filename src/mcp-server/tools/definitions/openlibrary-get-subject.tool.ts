/**
 * @fileoverview Browse works by subject on Open Library.
 * @module mcp-server/tools/definitions/openlibrary-get-subject.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { getOpenLibraryService } from '@/services/open-library/open-library-service.js';

export const openlibraryGetSubject = tool('openlibrary_get_subject', {
  title: 'Get Subject',
  description:
    'Browse works by subject. Returns matching works with edition counts and cover IDs, plus the total work count for the subject. Case and spacing are normalized before lookup, so "Science Fiction" and "science_fiction" are the same request. Subject tags are user-contributed and the vocabulary varies — when a subject returns no works, try a different word form (singular/plural), a synonym, or a broader term.',
  annotations: { readOnlyHint: true, openWorldHint: true },
  input: z.object({
    subject: z
      .string()
      .describe(
        'Subject name. Normalized before lookup — lowercased with spaces converted to underscores (e.g., "Science Fiction" → "science_fiction") — so varying case or spacing does not change the result.',
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

  /** Agent-facing context: total work count and empty-result notice. */
  enrichment: {
    totalCount: z
      .number()
      .optional()
      .describe('Total works tagged with this subject across all pages.'),
    notice: z
      .string()
      .optional()
      .describe(
        'Recovery guidance when work_count is 0 — echoes the subject and suggests alternatives. Absent when works are found.',
      ),
  },

  async handler(input, ctx) {
    ctx.log.info('Fetching subject', {
      subject: input.subject,
      limit: input.limit,
      offset: input.offset,
    });
    const svc = getOpenLibraryService();
    const result = await svc.getSubject(input.subject, input.limit, input.offset, ctx);

    ctx.enrich.total(result.work_count);

    if (result.work_count === 0) {
      ctx.enrich.notice(
        `No works found for subject "${input.subject}". Case and spacing are normalized before lookup, so re-sending the same words in a different case returns this same result — try a different word form (singular/plural), a synonym, or a broader term instead.`,
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
