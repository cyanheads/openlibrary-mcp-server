/**
 * @fileoverview Resolve cover image URLs from Open Library's Covers API.
 * @module mcp-server/tools/definitions/openlibrary-get-cover-url.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  coverIdentifierExpectation,
  getOpenLibraryService,
  isUnsafeCoverIdentifier,
} from '@/services/open-library/open-library-service.js';

export const openlibraryGetCoverUrl = tool('openlibrary_get_cover_url', {
  title: 'Get Cover URL',
  description:
    'Resolve a cover image URL for a book or author photo. Returns a direct HTTPS URL in the requested size (S/M/L). The Covers API always returns HTTP 200 — missing covers return a 1×1 placeholder GIF, not a 404 — so the identifier format is validated locally first: "id" must be numeric, "isbn" 10 or 13 digits, "olid" an edition OLID (OL…M) for target "book" and an author OLID (OL…A) for target "author". Identifiers with path separators or control characters, and author-by-ISBN lookups, are rejected before any request. URLs can be embedded in markdown as ![cover](url).',
  annotations: { readOnlyHint: true, idempotentHint: true },
  input: z.object({
    identifier: z
      .string()
      .describe(
        'The identifier value, validated against id_type before the URL is built. For "id": a numeric cover or photo ID from work/edition/author data. For "isbn": 10 or 13 digits, hyphens optional. For "olid": an edition OLID (OL…M) for target "book", an author OLID (OL…A) for target "author".',
      ),
    id_type: z
      .enum(['id', 'isbn', 'olid'])
      .describe(
        '"id" is the numeric cover_i / cover ID from search or work results. "isbn" and "olid" look up the cover from those identifiers.',
      ),
    target: z
      .enum(['book', 'author'])
      .default('book')
      .describe(
        '"book" returns a book cover from covers.openlibrary.org/b/. "author" returns an author photo from covers.openlibrary.org/a/ — use with id_type "id" (photo_id) or "olid" (author OLID).',
      ),
    size: z
      .enum(['S', 'M', 'L'])
      .default('M')
      .describe(
        'Image size. S = small (~45px tall), M = medium (~150px tall), L = large (~400px tall).',
      ),
  }),
  output: z.object({
    url: z
      .string()
      .describe(
        'Direct HTTPS URL to the cover image. The Covers API returns HTTP 200 for all requests — a 1×1 placeholder GIF is returned when no cover exists for the identifier.',
      ),
    note: z
      .string()
      .describe(
        'Reminder that the URL always returns HTTP 200; a placeholder GIF is served when no cover exists.',
      ),
  }),

  errors: [
    {
      reason: 'invalid_identifier',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The identifier contains path separators, "..", or control characters, or does not match the format its id_type expects.',
      recovery:
        'Pass a bare identifier with no slashes or path segments, matching its id_type: a numeric ID for "id", 10 or 13 digits for "isbn", OL…M for "olid" with target "book", OL…A for "olid" with target "author".',
    },
    {
      reason: 'invalid_target',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The id_type is not valid for the target — an author photo cannot be resolved by ISBN.',
      recovery:
        'For author photos use id_type "id" (photo_id) or "olid"; ISBN resolves book covers only.',
    },
  ],

  handler(input, ctx) {
    ctx.log.info('Resolving cover URL', {
      identifier: input.identifier,
      id_type: input.id_type,
      target: input.target,
      size: input.size,
    });
    if (isUnsafeCoverIdentifier(input.identifier)) {
      throw ctx.fail(
        'invalid_identifier',
        `"${input.identifier}" contains path separators or control characters.`,
        ctx.recoveryFor('invalid_identifier'),
      );
    }
    if (input.target === 'author' && input.id_type === 'isbn') {
      throw ctx.fail(
        'invalid_target',
        'Author photos cannot be looked up by ISBN; use id_type "id" or "olid".',
        ctx.recoveryFor('invalid_target'),
      );
    }
    // The Covers API serves a placeholder GIF rather than a 404, so a malformed
    // identifier is indistinguishable from a missing cover once the URL is built.
    const expected = coverIdentifierExpectation(input.identifier, input.id_type, input.target);
    if (expected) {
      throw ctx.fail(
        'invalid_identifier',
        `"${input.identifier}" is not ${expected}.`,
        ctx.recoveryFor('invalid_identifier'),
      );
    }
    const svc = getOpenLibraryService();
    const url = svc.getCoverUrl(input.identifier, input.id_type, input.target, input.size);
    return {
      url,
      note: 'The Covers API returns HTTP 200 for all requests — a 1×1 placeholder GIF is served if no cover exists for this identifier.',
    };
  },

  format: (result) => {
    const lines: string[] = [];
    lines.push(`**Cover URL:** ${result.url}`);
    lines.push(`**Note:** ${result.note}`);
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
