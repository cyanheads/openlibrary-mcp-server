/**
 * @fileoverview Tests for the openlibrary_get_author tool.
 * @module tests/tools/openlibrary-get-author.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { openlibraryGetAuthor } from '@/mcp-server/tools/definitions/openlibrary-get-author.tool.js';
import { initOpenLibraryService } from '@/services/open-library/open-library-service.js';

const FULL_AUTHOR = {
  author_id: 'OL24638A',
  name: 'F. Scott Fitzgerald',
  personal_name: 'Francis Scott Key Fitzgerald',
  fuller_name: 'Francis Scott Key Fitzgerald',
  bio: 'American novelist and short story writer, widely regarded as one of the greatest American writers of the 20th century.',
  birth_date: 'September 24, 1896',
  death_date: 'December 21, 1940',
  photo_ids: [6539594],
  remote_ids: {
    wikidata: 'Q36870',
    viaf: '96993075',
    isni: '0000000121445596',
    goodreads: '3190',
    librarything: 'fitzgerald',
  },
};

describe('openlibraryGetAuthor', () => {
  beforeEach(() => {
    initOpenLibraryService();
  });

  it('returns author detail on success', async () => {
    const ctx = createMockContext({ errors: openlibraryGetAuthor.errors });
    const svc = (
      await import('@/services/open-library/open-library-service.js')
    ).getOpenLibraryService();
    vi.spyOn(svc, 'getAuthor').mockResolvedValueOnce(FULL_AUTHOR);

    const input = openlibraryGetAuthor.input.parse({ author_id: 'OL24638A' });
    const result = await openlibraryGetAuthor.handler(input, ctx);

    expect(result.author_id).toBe('OL24638A');
    expect(result.name).toBe('F. Scott Fitzgerald');
    expect(result.remote_ids.wikidata).toBe('Q36870');
  });

  it('throws not_found via ctx.fail when service returns null', async () => {
    const ctx = createMockContext({ errors: openlibraryGetAuthor.errors });
    const svc = (
      await import('@/services/open-library/open-library-service.js')
    ).getOpenLibraryService();
    vi.spyOn(svc, 'getAuthor').mockResolvedValueOnce(null);

    const input = openlibraryGetAuthor.input.parse({ author_id: 'OL999999999A' });
    await expect(openlibraryGetAuthor.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: {
        reason: 'not_found',
        // The declared hint must reach the wire, not just live in errors[].
        recovery: {
          hint: openlibraryGetAuthor.errors!.find((e) => e.reason === 'not_found')!.recovery,
        },
      },
    });
  });

  it('formats author with all fields', () => {
    const blocks = openlibraryGetAuthor.format!(FULL_AUTHOR);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('OL24638A');
    expect(text).toContain('F. Scott Fitzgerald');
    expect(text).toContain('September 24, 1896');
    expect(text).toContain('December 21, 1940');
    expect(text).toContain('6539594');
    expect(text).toContain('Q36870');
    expect(text).toContain('wikidata');
  });

  it('formats sparse author (no optional fields)', () => {
    const sparse = {
      author_id: 'OL1A',
      name: 'Unknown Author',
      photo_ids: [],
      remote_ids: {},
    };
    const text = (openlibraryGetAuthor.format!(sparse)[0] as { text: string }).text;
    expect(text).toContain('OL1A');
    expect(text).toContain('Unknown Author');
    // Absent fields should not appear as fake values
    expect(text).not.toContain('undefined');
    expect(text).not.toContain('null');
  });
});
