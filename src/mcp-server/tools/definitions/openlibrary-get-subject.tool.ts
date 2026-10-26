/**
 * @fileoverview Browse works by subject on Open Library.
 * @module mcp-server/tools/definitions/openlibrary-get-subject.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { escapeMarkdownInline } from '@cyanheads/mcp-ts-core/utils';
import { NO_TITLE } from '@/mcp-server/tools/heading-placeholders.js';
import {
  applyPaginationLimit,
  composeNotices,
  paginationLimit,
  paginationLimitNotice,
} from '@/mcp-server/tools/limit-policy.js';
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
        'Subject name. Normalized before lookup — trimmed, lowercased, and internal whitespace converted to underscores (e.g., " Science Fiction " → "science_fiction") — so varying case or surrounding whitespace does not change the result.',
      ),
    limit: paginationLimit(12).describe(
      'Max works to return. Subject pages typically show 12 at a time.',
    ),
    offset: z.number().int().min(0).default(0).describe('Zero-based offset for pagination.'),
  }),
  output: z.object({
    subject_name: z.string().describe('Canonical subject name as stored on Open Library.'),
    subject_key: z.string().describe('Normalized subject key (lowercase, underscores).'),
    work_count: z.number().describe('Total works tagged with this subject.'),
    offset: z
      .number()
      .describe(
        'Zero-based offset of the first returned result — echoes the requested offset, so an empty page still records the offset that produced it.',
      ),
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
        'Recovery guidance when work_count is 0, composed with requested/applied page limits and next offset when the limit was reduced to 100. Absent when neither applies.',
      ),
  },

  errors: [
    {
      reason: 'invalid_subject',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The subject is empty after trimming whitespace.',
      recovery: 'Supply a nonblank subject name such as science fiction and retry.',
    },
  ],

  async handler(input, ctx) {
    if (!input.subject.trim()) {
      throw ctx.fail('invalid_subject', 'Supply a subject name containing more than whitespace.');
    }
    ctx.log.info('Fetching subject', {
      subject: input.subject,
      limit: input.limit,
      offset: input.offset,
    });
    const svc = getOpenLibraryService();
    const limit = applyPaginationLimit(input.limit, 'openlibrary_get_subject', ctx);
    const result = await svc.getSubject(input.subject, limit, input.offset, ctx);

    ctx.enrich.total(result.work_count);

    const notice = composeNotices(
      result.work_count === 0
        ? `No works found for subject "${escapeMarkdownInline(input.subject)}". Case and spacing are normalized before lookup, so re-sending the same words in a different case returns this same result — try a different word form (singular/plural), a synonym, or a broader term instead.`
        : undefined,
      paginationLimitNotice(input.limit, input.offset, result.works.length),
    );
    if (notice) ctx.enrich.notice(notice);
    if (result.work_count === 0) {
      return {
        subject_name: result.subject_name,
        subject_key: result.subject_key,
        work_count: 0,
        offset: input.offset,
        works: [],
      };
    }

    // Open Library neither clamps nor reports the offset, so the requested one is the applied one.
    return { ...result, offset: input.offset };
  },

  format: (result) => {
    const lines: string[] = [];
    lines.push(
      result.subject_name.includes('\n') || result.subject_name.includes('\r')
        ? `**Subject:** ${escapeMarkdownInline(result.subject_name)}`
        : `## Subject: ${escapeMarkdownInline(result.subject_name)}`,
    );
    lines.push(
      `**Key:** ${escapeMarkdownInline(result.subject_key)} | **Total works:** ${result.work_count} | **Offset:** ${result.offset} | **Returned:** ${result.works.length}`,
    );

    for (const work of result.works) {
      lines.push('');
      lines.push(
        work.title.includes('\n') || work.title.includes('\r')
          ? `**Title:** ${escapeMarkdownInline(work.title)}`
          : `### ${work.title ? escapeMarkdownInline(work.title) : NO_TITLE}`,
      );
      if (work.title === '') lines.push('**Title:** ""');
      lines.push(`**Work ID:** ${escapeMarkdownInline(work.work_id)}`);
      lines.push(
        `**Authors:** ${work.author_names.length ? work.author_names.map(escapeMarkdownInline).join(', ') : '[]'}`,
      );
      lines.push(`**Editions:** ${work.edition_count}`);
      if (work.cover_id != null) lines.push(`**Cover ID:** ${work.cover_id}`);
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
