/**
 * @fileoverview Service-level tests that drive the REAL fetch layer
 * (`fetchWithTimeout` → `withRetry` → the service's 404 mapping) to prove
 * upstream HTTP 404s are normalized into the declared `not_found` contract.
 *
 * The tool/resource `not_found` tests mock at `svc.getX()` and never touch the
 * fetch path, so they passed even while the regression shipped. These mock
 * `globalThis.fetch` to return an actual 404 and assert the surfaced error is a
 * clean `not_found` (with `data.reason` on the wire), never the raw
 * `FetchHttpError` the pre-fix code leaked.
 * @module tests/services/open-library-service.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openlibraryAuthorResource } from '@/mcp-server/resources/definitions/openlibrary-author.resource.js';
import { openlibraryGetEdition } from '@/mcp-server/tools/definitions/openlibrary-get-edition.tool.js';
import { openlibraryGetWork } from '@/mcp-server/tools/definitions/openlibrary-get-work.tool.js';
import {
  getOpenLibraryService,
  initOpenLibraryService,
} from '@/services/open-library/open-library-service.js';

/** A 404 like Open Library returns for a missing by-ID record (works/authors/editions). */
function notFoundResponse(): Response {
  return new Response('{}', { status: 404, statusText: 'Not Found' });
}

/** A 200 `{}` like the /api/books bibkeys endpoint returns for an unmatched OCLC. */
function emptyOkResponse(): Response {
  return new Response('{}', { status: 200, statusText: 'OK' });
}

describe('OpenLibraryService — upstream 404 handling', () => {
  beforeEach(() => {
    initOpenLibraryService();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ─── By-ID lookups map 404 → null (reviving the dead not_found checks) ──────

  it('getWork returns null on a 404 instead of leaking FetchHttpError', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(notFoundResponse());
    const svc = getOpenLibraryService();

    await expect(svc.getWork('OL999999999999W', createMockContext())).resolves.toBeNull();
    // NotFound is not in withRetry's transient set — the 404 must not be retried.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('getEditions returns null on a 404', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(notFoundResponse());
    const svc = getOpenLibraryService();
    await expect(
      svc.getEditions('OL999999999999W', 10, 0, createMockContext()),
    ).resolves.toBeNull();
  });

  it('getAuthor returns null on a 404', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(notFoundResponse());
    const svc = getOpenLibraryService();
    await expect(svc.getAuthor('OL999999999999A', createMockContext())).resolves.toBeNull();
  });

  it('getAuthorWorks returns null on a 404', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(notFoundResponse());
    const svc = getOpenLibraryService();
    await expect(
      svc.getAuthorWorks('OL999999999999A', 10, 0, createMockContext()),
    ).resolves.toBeNull();
  });

  // ─── getEditionByIdentifier throws a tagged not_found ───────────────────────

  it('getEditionByIdentifier throws not_found with data.reason on a 404 (isbn branch)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(notFoundResponse());
    const svc = getOpenLibraryService();
    const ctx = createMockContext({ errors: openlibraryGetEdition.errors });

    const error = await svc.getEditionByIdentifier('9780000000000', 'isbn', ctx).catch((e) => e);
    expect(error).toBeInstanceOf(McpError);
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'not_found' },
    });
  });

  it('getEditionByIdentifier throws not_found with data.reason for an unmatched OCLC (200 {})', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(emptyOkResponse());
    const svc = getOpenLibraryService();
    const ctx = createMockContext({ errors: openlibraryGetEdition.errors });

    const error = await svc.getEditionByIdentifier('99999999', 'oclc', ctx).catch((e) => e);
    expect(error).toBeInstanceOf(McpError);
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'not_found' },
    });
  });

  // ─── End-to-end: data.reason reaches the wire through the definitions ───────

  it('surfaces data.reason "not_found" through the get_work tool on a 404', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(notFoundResponse());
    const ctx = createMockContext({ errors: openlibraryGetWork.errors });
    const input = openlibraryGetWork.input.parse({ work_id: 'OL999999999999W' });

    const error = await openlibraryGetWork.handler(input, ctx).catch((e) => e);
    expect(error).toBeInstanceOf(McpError);
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'not_found' },
    });
  });

  it('surfaces a clean NotFound (not FetchHttpError) through the author resource on a 404', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(notFoundResponse());
    const params = openlibraryAuthorResource.params.parse({ author_id: 'OL999999999999A' });
    const ctx = createMockContext({ uri: new URL('openlibrary://authors/OL999999999999A') });

    const error = await openlibraryAuthorResource.handler(params, ctx).catch((e) => e);
    expect(error).toBeInstanceOf(McpError);
    expect((error as McpError).code).toBe(JsonRpcErrorCode.NotFound);
    // The raw fetch-layer error carried data.errorSource: 'FetchHttpError'; a clean
    // not-found must not.
    expect((error as McpError).data?.errorSource).toBeUndefined();
  });
});
