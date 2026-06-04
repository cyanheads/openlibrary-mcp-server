/**
 * @fileoverview Tests for the openlibrary-work resource.
 * @module tests/resources/openlibrary-work.resource.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { openlibraryWorkResource } from '@/mcp-server/resources/definitions/openlibrary-work.resource.js';
import { initOpenLibraryService } from '@/services/open-library/open-library-service.js';

const MOCK_WORK = {
  work_id: 'OL45804W',
  title: 'The Great Gatsby',
  description: 'A novel set in the Jazz Age.',
  subjects: ['Fiction'],
  subject_places: ['New York'],
  subject_times: ['1920s'],
  subject_people: [],
  cover_ids: [123456],
  author_ids: ['OL24638A'],
};

describe('openlibraryWorkResource', () => {
  beforeEach(() => {
    initOpenLibraryService();
  });

  it('returns work data for valid work_id', async () => {
    const ctx = createMockContext({ tenantId: 'test-tenant' });
    const svc = (
      await import('@/services/open-library/open-library-service.js')
    ).getOpenLibraryService();
    vi.spyOn(svc, 'getWork').mockResolvedValueOnce(MOCK_WORK);

    const params = openlibraryWorkResource.params.parse({ work_id: 'OL45804W' });
    const result = await openlibraryWorkResource.handler(params, ctx);

    expect(result.work_id).toBe('OL45804W');
    expect(result.title).toBe('The Great Gatsby');
  });

  it('throws not_found for invalid work_id', async () => {
    const ctx = createMockContext({ tenantId: 'test-tenant' });
    const svc = (
      await import('@/services/open-library/open-library-service.js')
    ).getOpenLibraryService();
    vi.spyOn(svc, 'getWork').mockResolvedValueOnce(null);

    const params = openlibraryWorkResource.params.parse({ work_id: 'OL999999999W' });
    await expect(openlibraryWorkResource.handler(params, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
    });
  });
});
