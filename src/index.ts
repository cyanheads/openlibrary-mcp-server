#!/usr/bin/env node
/**
 * @fileoverview openlibrary-mcp-server MCP server entry point.
 * @module index
 */

import { createApp } from '@cyanheads/mcp-ts-core';
import { openlibraryAuthorResource } from './mcp-server/resources/definitions/openlibrary-author.resource.js';
import { openlibraryWorkResource } from './mcp-server/resources/definitions/openlibrary-work.resource.js';
import { openlibraryGetAuthor } from './mcp-server/tools/definitions/openlibrary-get-author.tool.js';
import { openlibraryGetAuthorWorks } from './mcp-server/tools/definitions/openlibrary-get-author-works.tool.js';
import { openlibraryGetCoverUrl } from './mcp-server/tools/definitions/openlibrary-get-cover-url.tool.js';
import { openlibraryGetEdition } from './mcp-server/tools/definitions/openlibrary-get-edition.tool.js';
import { openlibraryGetEditions } from './mcp-server/tools/definitions/openlibrary-get-editions.tool.js';
import { openlibraryGetSubject } from './mcp-server/tools/definitions/openlibrary-get-subject.tool.js';
import { openlibraryGetWork } from './mcp-server/tools/definitions/openlibrary-get-work.tool.js';
import { openlibrarySearchAuthors } from './mcp-server/tools/definitions/openlibrary-search-authors.tool.js';
import { openlibrarySearchBooks } from './mcp-server/tools/definitions/openlibrary-search-books.tool.js';
import { openlibrarySearchInside } from './mcp-server/tools/definitions/openlibrary-search-inside.tool.js';
import { initOpenLibraryService } from './services/open-library/open-library-service.js';

await createApp({
  name: 'openlibrary-mcp-server',
  title: 'openlibrary-mcp-server',
  instructions:
    'Use the keyless, read-only openlibrary_* tools for Open Library catalog research. IDs distinguish works (OL…W), editions (OL…M), and authors (OL…A). Find a work with openlibrary_search_books, inspect it with openlibrary_get_work, then select editions with openlibrary_get_editions/openlibrary_get_edition; resolve people with openlibrary_search_authors → openlibrary_get_author. Work tools require work IDs: resolve an ISBN through openlibrary_get_edition to obtain its parent work_id when recorded. Edition lookup batches identifiers of one type. Use openlibrary_search_inside for passages in scanned books; use metadata search for titles, authors, and subjects. openlibrary_get_cover_url constructs image URLs without fetching or verifying an image.',
  skills: 'skills',
  // No tool calls ctx.requestInput, so nothing here needs a session to answer a
  // mid-handler prompt. Declared rather than left to MCP_SESSION_MODE's `auto`
  // default, which resolves to stateful.
  sessionMode: 'stateless',
  landing: { requireAuth: false },
  tools: [
    openlibrarySearchBooks,
    openlibrarySearchInside,
    openlibraryGetWork,
    openlibraryGetEditions,
    openlibraryGetEdition,
    openlibrarySearchAuthors,
    openlibraryGetAuthor,
    openlibraryGetAuthorWorks,
    openlibraryGetSubject,
    openlibraryGetCoverUrl,
  ],
  resources: [openlibraryWorkResource, openlibraryAuthorResource],
  prompts: [],
  setup(core) {
    void core;
    initOpenLibraryService();
  },
});
