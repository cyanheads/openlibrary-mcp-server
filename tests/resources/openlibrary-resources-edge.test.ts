/**
 * @fileoverview Edge case and error propagation tests for Open Library resources.
 * @module tests/resources/openlibrary-resources-edge.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createInMemoryStorage, createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { openlibraryAuthorResource } from '@/mcp-server/resources/definitions/openlibrary-author.resource.js';
import { openlibraryWorkResource } from '@/mcp-server/resources/definitions/openlibrary-work.resource.js';
import { initOpenLibraryService } from '@/services/open-library/open-library-service.js';
import { createResourceHandler } from '../../node_modules/@cyanheads/mcp-ts-core/dist/mcp-server/resources/utils/resourceHandlerFactory.js';
import { logger } from '../../node_modules/@cyanheads/mcp-ts-core/dist/utils/internal/logger.js';

type ResourceRequestContext = Parameters<ReturnType<typeof createResourceHandler>>[2];

/** SDK request scope supplied to the production resource factory. */
function resourceRequest(): ResourceRequestContext {
  return {
    mcpReq: {
      id: 1,
      method: 'resources/read',
      signal: new AbortController().signal,
      requestState: () => undefined,
      send: async () => {
        throw new Error('Unexpected outbound SDK request');
      },
      notify: vi.fn<ResourceRequestContext['mcpReq']['notify']>().mockResolvedValue(undefined),
      log: vi.fn<ResourceRequestContext['mcpReq']['log']>().mockResolvedValue(undefined),
      elicitInput: vi.fn<ResourceRequestContext['mcpReq']['elicitInput']>(),
      requestSampling: vi.fn<ResourceRequestContext['mcpReq']['requestSampling']>(),
    },
  };
}

describe('resource factory contracts', () => {
  beforeEach(() => {
    initOpenLibraryService();
    vi.restoreAllMocks();
  });

  it.each(['', '/authors/'])(
    'rejects an empty author identifier %j without returning a different author',
    async (authorId) => {
      const fetchSpy = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(Response.json({ key: '/authors/OL1A', name: 'Unrelated author' }));
      const handler = createResourceHandler(
        openlibraryAuthorResource,
        { logger, storage: createInMemoryStorage() },
        {},
      );
      await expect(
        handler(new URL('openlibrary://authors/'), { author_id: authorId }, resourceRequest()),
      ).rejects.toMatchObject({
        code: JsonRpcErrorCode.NotFound,
        data: {
          reason: 'not_found',
          recovery: { hint: expect.stringContaining('openlibrary_search_authors') },
          requestId: expect.any(String),
        },
      });
      expect(fetchSpy).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['works', openlibraryWorkResource, 'Work OL999W not found on Open Library.'],
    ['authors', openlibraryAuthorResource, 'Author OL999A not found on Open Library.'],
  ] as const)(
    'preserves %s missing-record code and message through the factory',
    async (kind, definition, message) => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 404 }));
      const handler = createResourceHandler(
        definition,
        { logger, storage: createInMemoryStorage() },
        {},
      );
      const id = kind === 'works' ? 'OL999W' : 'OL999A';
      const variables = kind === 'works' ? { work_id: id } : { author_id: id };
      await expect(
        handler(new URL(`openlibrary://${kind}/${id}`), variables, resourceRequest()),
      ).rejects.toMatchObject({
        code: JsonRpcErrorCode.NotFound,
        message,
        data: { requestId: expect.any(String) },
      });
    },
  );

  it.each([
    ['works', openlibraryWorkResource, 'openlibrary_search_books'],
    ['authors', openlibraryAuthorResource, 'openlibrary_search_authors'],
  ] as const)(
    'supplies %s not_found reason and recovery through the resource factory',
    async (kind, definition, searchTool) => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 404 }));
      const handler = createResourceHandler(
        definition,
        { logger, storage: createInMemoryStorage() },
        {},
      );
      const id = kind === 'works' ? 'OL999W' : 'OL999A';
      const variables = kind === 'works' ? { work_id: id } : { author_id: id };
      await expect(
        handler(new URL(`openlibrary://${kind}/${id}`), variables, resourceRequest()),
      ).rejects.toMatchObject({
        code: JsonRpcErrorCode.NotFound,
        data: {
          reason: 'not_found',
          recovery: { hint: expect.stringContaining(searchTool) },
          requestId: expect.any(String),
        },
      });
    },
  );
});

describe('openlibraryAuthorResource — edge cases', () => {
  beforeEach(() => {
    initOpenLibraryService();
  });

  it('propagates service unavailable error', async () => {
    const ctx = createMockContext({
      tenantId: 'test-tenant',
      errors: openlibraryAuthorResource.errors,
    });
    const svc = (
      await import('@/services/open-library/open-library-service.js')
    ).getOpenLibraryService();
    vi.spyOn(svc, 'getAuthor').mockRejectedValueOnce(
      new Error('Service unavailable — API returned HTML instead of JSON.'),
    );

    const params = openlibraryAuthorResource.params!.parse({ author_id: 'OL24638A' });
    await expect(openlibraryAuthorResource.handler(params, ctx)).rejects.toThrow(
      'Service unavailable',
    );
  });

  it('handles author with all optional fields absent', async () => {
    const ctx = createMockContext({
      tenantId: 'test-tenant',
      errors: openlibraryAuthorResource.errors,
    });
    const svc = (
      await import('@/services/open-library/open-library-service.js')
    ).getOpenLibraryService();
    vi.spyOn(svc, 'getAuthor').mockResolvedValueOnce({
      author_id: 'OL1A',
      name: 'Anonymous',
      photo_ids: [],
      remote_ids: {},
    });

    const params = openlibraryAuthorResource.params!.parse({ author_id: 'OL1A' });
    const result = await openlibraryAuthorResource.handler(params, ctx);
    expect(result.author_id).toBe('OL1A');
    expect(result.name).toBe('Anonymous');
    expect(result.photo_ids).toHaveLength(0);
  });

  it('passes author_id to service unchanged', async () => {
    const ctx = createMockContext({
      tenantId: 'test-tenant',
      errors: openlibraryAuthorResource.errors,
    });
    const svc = (
      await import('@/services/open-library/open-library-service.js')
    ).getOpenLibraryService();
    const spy = vi.spyOn(svc, 'getAuthor').mockResolvedValueOnce({
      author_id: 'OL24638A',
      name: 'F. Scott Fitzgerald',
      photo_ids: [],
      remote_ids: {},
    });

    const params = openlibraryAuthorResource.params!.parse({ author_id: 'OL24638A' });
    await openlibraryAuthorResource.handler(params, ctx);
    expect(spy).toHaveBeenCalledWith('OL24638A', ctx);
  });

  it('propagates McpError as-is from service', async () => {
    const ctx = createMockContext({
      tenantId: 'test-tenant',
      errors: openlibraryAuthorResource.errors,
    });
    const svc = (
      await import('@/services/open-library/open-library-service.js')
    ).getOpenLibraryService();
    const mcpErr = new McpError(
      JsonRpcErrorCode.NotFound,
      'Author OL999A not found on Open Library.',
    );
    vi.spyOn(svc, 'getAuthor').mockRejectedValueOnce(mcpErr);

    const params = openlibraryAuthorResource.params!.parse({ author_id: 'OL999A' });
    await expect(openlibraryAuthorResource.handler(params, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
    });
  });
});

describe('openlibraryWorkResource — edge cases', () => {
  beforeEach(() => {
    initOpenLibraryService();
  });

  it('propagates service unavailable error', async () => {
    const ctx = createMockContext({
      tenantId: 'test-tenant',
      errors: openlibraryWorkResource.errors,
    });
    const svc = (
      await import('@/services/open-library/open-library-service.js')
    ).getOpenLibraryService();
    vi.spyOn(svc, 'getWork').mockRejectedValueOnce(
      new Error('Service unavailable — API returned HTML instead of JSON.'),
    );

    const params = openlibraryWorkResource.params!.parse({ work_id: 'OL45804W' });
    await expect(openlibraryWorkResource.handler(params, ctx)).rejects.toThrow(
      'Service unavailable',
    );
  });

  it('handles sparse work with no optional fields', async () => {
    const ctx = createMockContext({
      tenantId: 'test-tenant',
      errors: openlibraryWorkResource.errors,
    });
    const svc = (
      await import('@/services/open-library/open-library-service.js')
    ).getOpenLibraryService();
    vi.spyOn(svc, 'getWork').mockResolvedValueOnce({
      work_id: 'OL1W',
      title: 'Minimal',
      subjects: [],
      subject_places: [],
      subject_times: [],
      subject_people: [],
      cover_ids: [],
      author_ids: [],
    });

    const params = openlibraryWorkResource.params!.parse({ work_id: 'OL1W' });
    const result = await openlibraryWorkResource.handler(params, ctx);
    expect(result.work_id).toBe('OL1W');
    expect(result.subjects).toHaveLength(0);
  });

  it('passes work_id to service unchanged', async () => {
    const ctx = createMockContext({
      tenantId: 'test-tenant',
      errors: openlibraryWorkResource.errors,
    });
    const svc = (
      await import('@/services/open-library/open-library-service.js')
    ).getOpenLibraryService();
    const spy = vi.spyOn(svc, 'getWork').mockResolvedValueOnce({
      work_id: 'OL45804W',
      title: 'The Great Gatsby',
      subjects: [],
      subject_places: [],
      subject_times: [],
      subject_people: [],
      cover_ids: [],
      author_ids: [],
    });

    const params = openlibraryWorkResource.params!.parse({ work_id: 'OL45804W' });
    await openlibraryWorkResource.handler(params, ctx);
    expect(spy).toHaveBeenCalledWith('OL45804W', ctx);
  });

  it('propagates McpError as-is from service', async () => {
    const ctx = createMockContext({
      tenantId: 'test-tenant',
      errors: openlibraryWorkResource.errors,
    });
    const svc = (
      await import('@/services/open-library/open-library-service.js')
    ).getOpenLibraryService();
    const mcpErr = new McpError(
      JsonRpcErrorCode.NotFound,
      'Work OL999W not found on Open Library.',
    );
    vi.spyOn(svc, 'getWork').mockRejectedValueOnce(mcpErr);

    const params = openlibraryWorkResource.params!.parse({ work_id: 'OL999W' });
    await expect(openlibraryWorkResource.handler(params, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
    });
  });
});
