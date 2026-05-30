/**
 * @fileoverview Security tests: secrets never appear in output, injection attempts are handled
 * safely, and sensitive env values are never leaked through any tool output or error message.
 * @module tests/security/security.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { openlibraryGetAuthor } from '@/mcp-server/tools/definitions/openlibrary-get-author.tool.js';
import { openlibraryGetCoverUrl } from '@/mcp-server/tools/definitions/openlibrary-get-cover-url.tool.js';
import { openlibraryGetEdition } from '@/mcp-server/tools/definitions/openlibrary-get-edition.tool.js';
import { openlibraryGetEditions } from '@/mcp-server/tools/definitions/openlibrary-get-editions.tool.js';
import { openlibraryGetSubject } from '@/mcp-server/tools/definitions/openlibrary-get-subject.tool.js';
import { openlibraryGetWork } from '@/mcp-server/tools/definitions/openlibrary-get-work.tool.js';
import { openlibrarySearchAuthors } from '@/mcp-server/tools/definitions/openlibrary-search-authors.tool.js';
import { openlibrarySearchBooks } from '@/mcp-server/tools/definitions/openlibrary-search-books.tool.js';
import { initOpenLibraryService } from '@/services/open-library/open-library-service.js';

/** Stub sentinel used as a mock "secret" env value. */
const SECRET_SENTINEL = 'SUPERSECRET_TEST_VALUE_DO_NOT_LEAK';

describe('security — no env secrets appear in tool output or errors', () => {
  beforeEach(() => {
    // Inject the sentinel into the process env before each test
    process.env.OPEN_LIBRARY_USER_AGENT = SECRET_SENTINEL;
    initOpenLibraryService();
  });

  it('get_author: error message does not contain the user-agent sentinel', async () => {
    const ctx = createMockContext({ errors: openlibraryGetAuthor.errors });
    const svc = (
      await import('@/services/open-library/open-library-service.js')
    ).getOpenLibraryService();
    vi.spyOn(svc, 'getAuthor').mockRejectedValueOnce(new Error('Not found'));

    const input = openlibraryGetAuthor.input.parse({ author_id: 'OL1A' });
    try {
      await openlibraryGetAuthor.handler(input, ctx);
    } catch (err) {
      const errorStr = JSON.stringify(err);
      expect(errorStr).not.toContain(SECRET_SENTINEL);
    }
  });

  it('search_books: result does not contain the user-agent sentinel', async () => {
    const ctx = createMockContext({ errors: openlibrarySearchBooks.errors });
    const svc = (
      await import('@/services/open-library/open-library-service.js')
    ).getOpenLibraryService();
    vi.spyOn(svc, 'searchBooks').mockResolvedValueOnce({ total: 0, offset: 0, works: [] });

    const input = openlibrarySearchBooks.input.parse({ query: 'test' });
    const result = await openlibrarySearchBooks.handler(input, ctx);
    expect(JSON.stringify(result)).not.toContain(SECRET_SENTINEL);
  });

  it('get_cover_url: result does not contain the user-agent sentinel', () => {
    const ctx = createMockContext();
    const input = openlibraryGetCoverUrl.input.parse({ identifier: '123', id_type: 'id' });
    const result = openlibraryGetCoverUrl.handler(input, ctx);
    expect(JSON.stringify(result)).not.toContain(SECRET_SENTINEL);
  });

  it('get_edition: error from service does not contain the user-agent sentinel', async () => {
    const ctx = createMockContext({ errors: openlibraryGetEdition.errors });
    const svc = (
      await import('@/services/open-library/open-library-service.js')
    ).getOpenLibraryService();
    vi.spyOn(svc, 'getEditionByIdentifier').mockRejectedValueOnce(new Error('Not found'));

    const input = openlibraryGetEdition.input.parse({ identifier: 'OL1M', id_type: 'olid' });
    try {
      await openlibraryGetEdition.handler(input, ctx);
    } catch (err) {
      expect(JSON.stringify(err)).not.toContain(SECRET_SENTINEL);
    }
  });

  it('get_editions: result does not contain the user-agent sentinel', async () => {
    const ctx = createMockContext({ errors: openlibraryGetEditions.errors });
    const svc = (
      await import('@/services/open-library/open-library-service.js')
    ).getOpenLibraryService();
    vi.spyOn(svc, 'getEditions').mockResolvedValueOnce({
      total: 0,
      work_id: 'OL1W',
      editions: [],
    });

    const input = openlibraryGetEditions.input.parse({ work_id: 'OL1W' });
    const result = await openlibraryGetEditions.handler(input, ctx);
    expect(JSON.stringify(result)).not.toContain(SECRET_SENTINEL);
  });

  it('get_work: result does not contain the user-agent sentinel', async () => {
    const ctx = createMockContext({ errors: openlibraryGetWork.errors });
    const svc = (
      await import('@/services/open-library/open-library-service.js')
    ).getOpenLibraryService();
    vi.spyOn(svc, 'getWork').mockResolvedValueOnce({
      work_id: 'OL1W',
      title: 'Test',
      subjects: [],
      subject_places: [],
      subject_times: [],
      subject_people: [],
      cover_ids: [],
      author_ids: [],
    });

    const input = openlibraryGetWork.input.parse({ work_id: 'OL1W' });
    const result = await openlibraryGetWork.handler(input, ctx);
    expect(JSON.stringify(result)).not.toContain(SECRET_SENTINEL);
  });

  it('get_subject: result does not contain the user-agent sentinel', async () => {
    const ctx = createMockContext({ errors: openlibraryGetSubject.errors });
    const svc = (
      await import('@/services/open-library/open-library-service.js')
    ).getOpenLibraryService();
    vi.spyOn(svc, 'getSubject').mockResolvedValueOnce({
      subject_name: 'Fiction',
      subject_key: 'fiction',
      work_count: 0,
      works: [],
    });

    const input = openlibraryGetSubject.input.parse({ subject: 'fiction' });
    const result = await openlibraryGetSubject.handler(input, ctx);
    expect(JSON.stringify(result)).not.toContain(SECRET_SENTINEL);
  });

  it('search_authors: result does not contain the user-agent sentinel', async () => {
    const ctx = createMockContext({ errors: openlibrarySearchAuthors.errors });
    const svc = (
      await import('@/services/open-library/open-library-service.js')
    ).getOpenLibraryService();
    vi.spyOn(svc, 'searchAuthors').mockResolvedValueOnce({ total: 0, authors: [] });

    const input = openlibrarySearchAuthors.input.parse({ query: 'test' });
    const result = await openlibrarySearchAuthors.handler(input, ctx);
    expect(JSON.stringify(result)).not.toContain(SECRET_SENTINEL);
  });
});

describe('security — format output does not contain secrets', () => {
  beforeEach(() => {
    initOpenLibraryService();
  });

  it('search_books format: no sentinel in formatted output', () => {
    const output = {
      total: 1,
      offset: 0,
      works: [
        {
          work_id: 'OL1W',
          title: 'Test',
          author_names: [],
          author_ids: [],
          edition_count: 1,
          ebook_access: 'no_ebook' as const,
          has_fulltext: false,
          ia_identifiers: [],
        },
      ],
    };
    const text = (openlibrarySearchBooks.format!(output)[0] as { text: string }).text;
    expect(text).not.toContain(SECRET_SENTINEL);
  });

  it('get_cover_url format: no sentinel in formatted output', () => {
    const output = {
      url: 'https://covers.openlibrary.org/b/id/123-M.jpg',
      note: 'The Covers API returns HTTP 200.',
    };
    const text = (openlibraryGetCoverUrl.format!(output)[0] as { text: string }).text;
    expect(text).not.toContain(SECRET_SENTINEL);
  });
});

describe('security — injection attempts do not cause unhandled errors', () => {
  beforeEach(() => {
    initOpenLibraryService();
  });

  const injectionStrings = [
    "'; DROP TABLE works; --",
    '<script>alert(1)</script>',
    // Dollar-brace pattern (not a real template literal — test that it's handled as plain text)
    '$' + '{process.env.SECRET}',
    '../../../etc/passwd',
    '\x00\x01\x02null-byte',
    '\\u0000',
    'a'.repeat(65_536), // oversized
  ];

  for (const injection of injectionStrings) {
    it(`search_books handler accepts injection string without crash: ${JSON.stringify(injection).slice(0, 40)}`, async () => {
      const ctx = createMockContext({ errors: openlibrarySearchBooks.errors });
      const svc = (
        await import('@/services/open-library/open-library-service.js')
      ).getOpenLibraryService();
      vi.spyOn(svc, 'searchBooks').mockResolvedValueOnce({ total: 0, offset: 0, works: [] });

      // Parse may throw for schema violations; what we assert is the handler doesn't crash
      let input: ReturnType<typeof openlibrarySearchBooks.input.parse> | null = null;
      try {
        input = openlibrarySearchBooks.input.parse({ query: injection });
      } catch {
        // Schema rejection is acceptable — not a crash
        return;
      }

      if (input) {
        // Handler must not throw an unhandled exception
        const result = await openlibrarySearchBooks.handler(input, ctx);
        expect(result).toBeDefined();
      }
    });
  }

  it('get_subject handler accepts XSS subject without crashing', async () => {
    const ctx = createMockContext({ errors: openlibraryGetSubject.errors });
    const svc = (
      await import('@/services/open-library/open-library-service.js')
    ).getOpenLibraryService();
    vi.spyOn(svc, 'getSubject').mockResolvedValueOnce({
      subject_name: '<script>alert(1)</script>',
      subject_key: 'scriptalert1script',
      work_count: 0,
      works: [],
    });

    const input = openlibraryGetSubject.input.parse({
      subject: '<script>alert(1)</script>',
    });
    const result = await openlibraryGetSubject.handler(input, ctx);
    expect(result.work_count).toBe(0);
  });
});
