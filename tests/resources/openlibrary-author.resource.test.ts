/**
 * @fileoverview Tests for the openlibrary-author resource.
 * @module tests/resources/openlibrary-author.resource.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { openlibraryAuthorResource } from '@/mcp-server/resources/definitions/openlibrary-author.resource.js';
import { initOpenLibraryService } from '@/services/open-library/open-library-service.js';

const MOCK_AUTHOR = {
  author_id: 'OL24638A',
  name: 'F. Scott Fitzgerald',
  personal_name: 'Francis Scott Key Fitzgerald',
  bio: 'American novelist known for The Great Gatsby.',
  birth_date: 'September 24, 1896',
  death_date: 'December 21, 1940',
  photo_ids: [6255566],
  remote_ids: {
    wikidata: 'Q37869',
    viaf: '27063124',
    goodreads: '3190',
  },
};

describe('openlibraryAuthorResource', () => {
  beforeEach(() => {
    initOpenLibraryService();
  });

  it('returns author data for valid author_id', async () => {
    const ctx = createMockContext({ tenantId: 'test-tenant' });
    const svc = (
      await import('@/services/open-library/open-library-service.js')
    ).getOpenLibraryService();
    vi.spyOn(svc, 'getAuthor').mockResolvedValueOnce(MOCK_AUTHOR);

    const params = openlibraryAuthorResource.params!.parse({ author_id: 'OL24638A' });
    const result = await openlibraryAuthorResource.handler(params, ctx);

    expect(result.author_id).toBe('OL24638A');
    expect(result.name).toBe('F. Scott Fitzgerald');
    expect(result.bio).toContain('Great Gatsby');
    expect(result.photo_ids).toContain(6255566);
  });

  it('throws not_found for invalid author_id', async () => {
    const ctx = createMockContext({ tenantId: 'test-tenant' });
    const svc = (
      await import('@/services/open-library/open-library-service.js')
    ).getOpenLibraryService();
    vi.spyOn(svc, 'getAuthor').mockResolvedValueOnce(null);

    const params = openlibraryAuthorResource.params!.parse({ author_id: 'OL999999999A' });
    await expect(openlibraryAuthorResource.handler(params, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
    });
  });
});
