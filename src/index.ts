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
import { initOpenLibraryService } from './services/open-library/open-library-service.js';

await createApp({
  name: 'openlibrary-mcp-server',
  title: 'openlibrary-mcp-server',
  landing: { requireAuth: false },
  tools: [
    openlibrarySearchBooks,
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
