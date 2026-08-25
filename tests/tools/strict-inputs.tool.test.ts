/**
 * @fileoverview Every tool's advertised input is closed: an argument key the
 * schema does not declare is rejected by name rather than silently stripped.
 * Pins the surface a caller sees when it sends a misspelled or invented
 * parameter, across the whole tool set.
 * @module tests/tools/strict-inputs.tool.test
 */

import { describe, expect, it } from 'vitest';
import { openlibraryGetAuthor } from '@/mcp-server/tools/definitions/openlibrary-get-author.tool.js';
import { openlibraryGetAuthorWorks } from '@/mcp-server/tools/definitions/openlibrary-get-author-works.tool.js';
import { openlibraryGetCoverUrl } from '@/mcp-server/tools/definitions/openlibrary-get-cover-url.tool.js';
import { openlibraryGetEdition } from '@/mcp-server/tools/definitions/openlibrary-get-edition.tool.js';
import { openlibraryGetEditions } from '@/mcp-server/tools/definitions/openlibrary-get-editions.tool.js';
import { openlibraryGetSubject } from '@/mcp-server/tools/definitions/openlibrary-get-subject.tool.js';
import { openlibraryGetWork } from '@/mcp-server/tools/definitions/openlibrary-get-work.tool.js';
import { openlibrarySearchAuthors } from '@/mcp-server/tools/definitions/openlibrary-search-authors.tool.js';
import { openlibrarySearchBooks } from '@/mcp-server/tools/definitions/openlibrary-search-books.tool.js';
import { openlibrarySearchInside } from '@/mcp-server/tools/definitions/openlibrary-search-inside.tool.js';

/** Every tool, paired with the smallest argument set its schema accepts. */
const CASES = [
  { tool: openlibrarySearchBooks, valid: { query: 'gatsby' } },
  { tool: openlibrarySearchInside, valid: { query: 'so we beat on' } },
  { tool: openlibraryGetWork, valid: { work_id: 'OL45804W' } },
  { tool: openlibraryGetEditions, valid: { work_id: 'OL45804W' } },
  { tool: openlibraryGetEdition, valid: { identifiers: ['9780743273565'], id_type: 'isbn' } },
  { tool: openlibrarySearchAuthors, valid: { query: 'fitzgerald' } },
  { tool: openlibraryGetAuthor, valid: { author_id: 'OL24638A' } },
  { tool: openlibraryGetAuthorWorks, valid: { author_id: 'OL24638A' } },
  { tool: openlibraryGetSubject, valid: { subject: 'science_fiction' } },
  { tool: openlibraryGetCoverUrl, valid: { identifier: '9255566', id_type: 'id' } },
] as const;

describe('tool inputs are closed', () => {
  for (const { tool, valid } of CASES) {
    it(`${tool.name} accepts its declared arguments`, () => {
      expect(tool.input.safeParse(valid).success).toBe(true);
    });

    it(`${tool.name} rejects an undeclared argument by name`, () => {
      const result = tool.input.safeParse({ ...valid, not_a_real_parameter: 'x' });
      expect(result.success).toBe(false);
      const issue = result.success ? undefined : result.error.issues[0];
      expect(issue).toMatchObject({ code: 'unrecognized_keys', path: [] });
      expect(JSON.stringify(issue)).toContain('not_a_real_parameter');
    });
  }
});
