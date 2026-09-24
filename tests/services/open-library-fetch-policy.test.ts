/**
 * @fileoverview Fetch-policy tests: per-endpoint-class attempt timeouts, the
 * shared retry deadline, which upstream failures end a ladder early, how the
 * bibkeys route classifies a non-2xx, and how `openlibrary_get_edition`'s author
 * enrichment degrades.
 *
 * Every test drives the REAL `fetchWithTimeout` → `withRetry` path through a
 * `globalThis.fetch` fake, so a status mapping or retry decision is exercised
 * rather than stubbed. Timeouts and backoffs run on Vitest's fake clock; a
 * "hung" upstream is a fetch that settles only when its signal aborts, exactly
 * as a stalled socket does.
 * @module tests/services/open-library-fetch-policy.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';
import { openlibraryAuthorResource } from '@/mcp-server/resources/definitions/openlibrary-author.resource.js';
import { openlibraryGetEdition } from '@/mcp-server/tools/definitions/openlibrary-get-edition.tool.js';
import {
  ATTEMPT_TIMEOUT_MS,
  EDITION_ENRICHMENT_CONCURRENCY,
  getOpenLibraryService,
  initOpenLibraryService,
  RETRY_DEADLINE_MS,
} from '@/services/open-library/open-library-service.js';

type FetchArgs = Parameters<typeof globalThis.fetch>;

/** The page HAProxy serves when Open Library has no backend available. */
const HAPROXY_503_PAGE =
  '<html><body><h1>503 Service Unavailable</h1>\nNo server is available to handle this request.\n</body></html>\n';

let fetchSpy: MockInstance<typeof globalThis.fetch>;
/** Fake-clock time at which each request was issued, in call order. */
let requestTimes: number[];

function requestUrl(input: unknown): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  if (input && typeof input === 'object' && 'url' in input) return String(input.url);
  return String(input);
}

/** Routes every request through `handler`, recording when each one was issued. */
function serve(handler: (url: string, init: FetchArgs[1]) => Promise<Response>): void {
  fetchSpy.mockImplementation((input, init) => {
    requestTimes.push(Date.now());
    return handler(requestUrl(input), init);
  });
}

/** A request that never answers: it settles only when its signal aborts. */
function hang(init: FetchArgs[1]): Promise<Response> {
  return new Promise((_resolve, reject) => {
    const signal = init?.signal;
    if (!signal) return;
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
}

/** Resolves with `body` after `ms` of fake-clock time, unless the request aborts first. */
function answerAfter(ms: number, init: FetchArgs[1], response: () => Response): Promise<Response> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(response()), ms);
    init?.signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(init.signal?.reason);
      },
      { once: true },
    );
  });
}

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), { status: 200, ...init });
}

function haproxy(status: number): Response {
  return new Response(HAPROXY_503_PAGE, {
    status,
    statusText: 'Service Unavailable',
    headers: { 'content-type': 'text/html' },
  });
}

/** Fake-clock milliseconds between two recorded requests. */
function gapBetweenRequests(first: number, second: number): number {
  return (requestTimes[second] ?? Number.NaN) - (requestTimes[first] ?? Number.NaN);
}

function requestsTo(fragment: string): number {
  return fetchSpy.mock.calls.filter(([input]) => requestUrl(input).includes(fragment)).length;
}

/**
 * Starts `run` on the fake clock and reports how it settled and at what
 * fake-clock time, without letting a rejection go unhandled while the clock is
 * being advanced.
 */
function track<T>(run: () => Promise<T>) {
  const startedAt = Date.now();
  const state: { settled: boolean; value?: T; error?: unknown; elapsedMs?: number } = {
    settled: false,
  };
  const done = run().then(
    (value) => {
      Object.assign(state, { settled: true, value, elapsedMs: Date.now() - startedAt });
    },
    (error: unknown) => {
      Object.assign(state, { settled: true, error, elapsedMs: Date.now() - startedAt });
    },
  );
  return { state, done };
}

beforeEach(() => {
  initOpenLibraryService();
  requestTimes = [];
  fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unmocked fetch'));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('OpenLibraryService — fetch policy constants', () => {
  it('pins the per-class attempt timeouts and the ladder deadline', () => {
    expect(ATTEMPT_TIMEOUT_MS.record).toBe(10_000);
    expect(ATTEMPT_TIMEOUT_MS.search).toBe(30_000);
    expect(ATTEMPT_TIMEOUT_MS.fulltext).toBe(45_000);
    expect(RETRY_DEADLINE_MS).toBe(50_000);
  });
});

describe('OpenLibraryService — per-class timeouts and the retry deadline', () => {
  it('waits out a full-text answer slower than the old 15 s ceiling in one request', async () => {
    vi.useFakeTimers();
    serve((_url, init) => answerAfter(28_000, init, () => json({ hits: { total: 0, hits: [] } })));

    const call = track(() =>
      getOpenLibraryService().searchInside('"the spice must flow"', 10, 0, createMockContext()),
    );
    await vi.advanceTimersByTimeAsync(28_000);
    await call.done;

    expect(call.state.error).toBeUndefined();
    expect(call.state.value).toEqual({ total: 0, offset: 0, matches: [] });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('gives a full-text search one 45 s attempt and never re-issues it on timeout', async () => {
    vi.useFakeTimers();
    serve((_url, init) => hang(init));

    const call = track(() => getOpenLibraryService().searchInside('x', 10, 0, createMockContext()));
    await vi.advanceTimersByTimeAsync(44_999);
    expect(call.state.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(RETRY_DEADLINE_MS);
    await call.done;

    expect(call.state.error).toBeInstanceOf(McpError);
    expect(call.state.error).toMatchObject({ code: JsonRpcErrorCode.Timeout });
    expect(call.state.elapsedMs).toBe(45_000);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('bounds a hung Solr search by the 50 s deadline: a 30 s attempt, then what is left', async () => {
    vi.useFakeTimers();
    serve((_url, init) => hang(init));

    const call = track(() =>
      getOpenLibraryService().searchBooks(
        { query: 'dune', limit: 10, offset: 0 },
        createMockContext(),
      ),
    );
    await vi.advanceTimersByTimeAsync(RETRY_DEADLINE_MS + 10_000);
    await call.done;

    expect(call.state.error).toMatchObject({
      code: JsonRpcErrorCode.Timeout,
      data: { reason: 'retry_deadline_exceeded', deadlineMs: RETRY_DEADLINE_MS },
    });
    expect(call.state.elapsedMs).toBe(RETRY_DEADLINE_MS);
    // The first attempt got the full 30 s search timeout; the retry began after
    // the backoff, inside the same budget.
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(gapBetweenRequests(0, 1)).toBeGreaterThanOrEqual(ATTEMPT_TIMEOUT_MS.search);
  });

  it('retries a timed-out record lookup at 10 s per attempt and still ends inside the deadline', async () => {
    vi.useFakeTimers();
    serve((_url, init) => hang(init));

    const call = track(() => getOpenLibraryService().getWork('OL45804W', createMockContext()));
    await vi.advanceTimersByTimeAsync(ATTEMPT_TIMEOUT_MS.record - 1);
    // The first attempt is still waiting one millisecond before its timeout.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(RETRY_DEADLINE_MS);
    await call.done;

    expect(call.state.error).toMatchObject({ code: JsonRpcErrorCode.Timeout });
    // Four 10 s attempts plus ~7 s of backoff (±25% jitter) fit under 50 s.
    expect(fetchSpy).toHaveBeenCalledTimes(4);
    expect(call.state.elapsedMs).toBeLessThanOrEqual(RETRY_DEADLINE_MS);
    expect(gapBetweenRequests(0, 1)).toBeGreaterThanOrEqual(ATTEMPT_TIMEOUT_MS.record + 750);
  });

  it('keeps a caller cancellation a cancellation rather than relabelling it a deadline expiry', async () => {
    vi.useFakeTimers();
    serve((_url, init) => hang(init));
    const controller = new AbortController();

    const call = track(() =>
      getOpenLibraryService().getWork('OL45804W', createMockContext({ signal: controller.signal })),
    );
    await vi.advanceTimersByTimeAsync(2_000);
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);
    await call.done;

    expect(call.state.error).toMatchObject({ code: JsonRpcErrorCode.RequestCancelled });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

describe('OpenLibraryService — which failures end a ladder early', () => {
  it.each([
    [502, JsonRpcErrorCode.ServiceUnavailable],
    [503, JsonRpcErrorCode.ServiceUnavailable],
    [504, JsonRpcErrorCode.Timeout],
  ])('ends the ladder on HTTP %i after one request, keeping its code', async (status, code) => {
    serve(() => Promise.resolve(haproxy(status)));

    const error = await getOpenLibraryService()
      .searchBooks({ query: 'dune', limit: 10, offset: 0 }, createMockContext())
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(McpError);
    expect(error).toMatchObject({ code, data: { status } });
    // Still retryable from the caller's side — the in-loop retry is what stops.
    expect((error as McpError).data?.retryable).not.toBe(false);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('classifies a 2xx HTML page as ServiceUnavailable and does not retry it', async () => {
    serve(() =>
      Promise.resolve(
        new Response('<!DOCTYPE html><html><body>Down for maintenance</body></html>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        }),
      ),
    );

    const error = await getOpenLibraryService()
      .getSubject('fantasy', 12, 0, createMockContext())
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(McpError);
    expect(error).toMatchObject({ code: JsonRpcErrorCode.ServiceUnavailable });
    expect((error as McpError).data?.retryable).not.toBe(false);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('retries a 429 after the Retry-After the upstream named', async () => {
    vi.useFakeTimers();
    let calls = 0;
    serve(() => {
      calls++;
      return Promise.resolve(
        calls === 1
          ? new Response('', { status: 429, headers: { 'retry-after': '2' } })
          : json({ numFound: 0, start: 0, docs: [] }),
      );
    });

    const call = track(() =>
      getOpenLibraryService().searchBooks(
        { query: 'dune', limit: 10, offset: 0 },
        createMockContext(),
      ),
    );
    await vi.advanceTimersByTimeAsync(2_000);
    await call.done;

    expect(call.state.error).toBeUndefined();
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(gapBetweenRequests(0, 1)).toBe(2_000);
  });

  it('retries a network failure within the deadline', async () => {
    vi.useFakeTimers();
    let calls = 0;
    serve(() => {
      calls++;
      return calls === 1
        ? Promise.reject(new TypeError('fetch failed'))
        : Promise.resolve(json({ numFound: 0, docs: [] }));
    });

    const call = track(() =>
      getOpenLibraryService().searchAuthors('tolkien', 10, 0, createMockContext()),
    );
    await vi.advanceTimersByTimeAsync(2_000);
    await call.done;

    expect(call.state.error).toBeUndefined();
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('still maps a by-ID 404 to null in one request', async () => {
    serve(() => Promise.resolve(new Response('{}', { status: 404, statusText: 'Not Found' })));
    await expect(
      getOpenLibraryService().getAuthor('OL999999999999A', createMockContext()),
    ).resolves.toBeNull();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

describe('getEditionsByIdentifiers — the bibkeys route', () => {
  const upstreamUnavailableHint = () =>
    openlibraryGetEdition.errors!.find((e) => e.reason === 'upstream_unavailable')?.recovery;

  it.each([
    ['isbn' as const, '9780140328721', 'ISBN:9780140328721'],
    ['oclc' as const, '36863723', 'OCLC:36863723'],
    ['lccn' as const, '00027665', 'LCCN:00027665'],
    ['olid' as const, 'OL7353617M', 'OLID:OL7353617M'],
  ])('resolves %s through /api/books.json in one request', async (idType, identifier, bibkey) => {
    serve(() =>
      Promise.resolve(json({ [bibkey]: { details: { key: '/books/OL1M', title: 'T' } } })),
    );

    const { editions } = await getOpenLibraryService().getEditionsByIdentifiers(
      [identifier],
      idType,
      createMockContext(),
    );

    expect(editions).toHaveLength(1);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const url = new URL(requestUrl(fetchSpy.mock.calls[0]?.[0]));
    expect(url.pathname).toBe('/api/books.json');
    expect(url.searchParams.get('bibkeys')).toBe(bibkey);
    expect(url.searchParams.get('format')).toBe('json');
    expect(url.searchParams.get('jscmd')).toBe('details');
  });

  it.each([
    [404, ''],
    [502, HAPROXY_503_PAGE],
    [503, HAPROXY_503_PAGE],
    [504, HAPROXY_503_PAGE],
  ])(
    'maps HTTP %i to upstream_unavailable after one request, not to a missing edition',
    async (status, body) => {
      serve(() => Promise.resolve(new Response(body, { status })));
      const ctx = createMockContext({ errors: openlibraryGetEdition.errors });

      const error = await getOpenLibraryService()
        .getEditionsByIdentifiers(['9780140328721'], 'isbn', ctx)
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(McpError);
      expect(error).toMatchObject({
        code: JsonRpcErrorCode.ServiceUnavailable,
        data: {
          reason: 'upstream_unavailable',
          retryable: true,
          status,
          recovery: { hint: upstreamUnavailableHint() },
        },
      });
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    },
  );

  // A 500 is not a gateway saturation signal, so the ladder still retries it;
  // only once the ladder gives up is it classified.
  it('retries a 500 within the deadline, then maps it to upstream_unavailable', async () => {
    vi.useFakeTimers();
    serve(() => Promise.resolve(new Response('Internal Server Error', { status: 500 })));
    const ctx = createMockContext({ errors: openlibraryGetEdition.errors });

    const call = track(() =>
      getOpenLibraryService().getEditionsByIdentifiers(['9780140328721'], 'isbn', ctx),
    );
    await vi.advanceTimersByTimeAsync(RETRY_DEADLINE_MS);
    await call.done;

    expect(call.state.error).toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: { reason: 'upstream_unavailable', status: 500 },
    });
    expect(fetchSpy).toHaveBeenCalledTimes(4);
  });

  it('classifies a 2xx HTML page from the bibkeys route as upstream_unavailable', async () => {
    serve(() =>
      Promise.resolve(
        new Response('<html><body>maintenance</body></html>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        }),
      ),
    );
    const ctx = createMockContext({ errors: openlibraryGetEdition.errors });

    const error = await getOpenLibraryService()
      .getEditionsByIdentifiers(['9780140328721'], 'isbn', ctx)
      .catch((e: unknown) => e);

    expect(error).toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: { reason: 'upstream_unavailable', recovery: { hint: upstreamUnavailableHint() } },
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('keeps a 429 from the bibkeys route RateLimited rather than upstream_unavailable', async () => {
    // A Retry-After past the backoff cap fails fast, so the ladder ends here.
    serve(() =>
      Promise.resolve(new Response('', { status: 429, headers: { 'retry-after': '120' } })),
    );
    const ctx = createMockContext({ errors: openlibraryGetEdition.errors });

    const error = await getOpenLibraryService()
      .getEditionsByIdentifiers(['9780140328721'], 'isbn', ctx)
      .catch((e: unknown) => e);

    expect(error).toMatchObject({ code: JsonRpcErrorCode.RateLimited });
    expect((error as McpError).data?.reason).toBeUndefined();
  });

  it('puts upstream_unavailable on both client surfaces of openlibrary_get_edition', async () => {
    serve(() => Promise.resolve(new Response('', { status: 404, statusText: 'Not Found' })));

    const result = await runToolContract(openlibraryGetEdition, {
      identifiers: ['9780140328721'],
      id_type: 'isbn',
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.ServiceUnavailable,
        data: { reason: 'upstream_unavailable', recovery: { hint: upstreamUnavailableHint() } },
      },
    });
    const text = result.content.map((block) => ('text' in block ? block.text : '')).join('\n');
    expect(text).toContain(upstreamUnavailableHint());
    expect(text).toContain('upstream_unavailable');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

/**
 * Enrichment fixtures: editions whose authors live only on the parent work, so
 * each costs a work lookup and then one lookup per author credit.
 */
function enrichmentBatch(count: number) {
  const identifiers: string[] = [];
  const bibkeys: Record<string, unknown> = {};
  for (let i = 0; i < count; i++) {
    const editionId = `OL${1000 + i}M`;
    identifiers.push(editionId);
    bibkeys[`OLID:${editionId}`] = {
      details: {
        key: `/books/${editionId}`,
        title: `Title ${i}`,
        works: [{ key: `/works/OL${2000 + i}W` }],
      },
    };
  }
  return { identifiers, bibkeys };
}

/** `/works/OL{n}W.json` → the edition index it belongs to. */
function workIndex(url: string): number | undefined {
  const match = /\/works\/OL(\d+)W\.json/.exec(url);
  return match ? Number(match[1]) - 2000 : undefined;
}

/** The live work record answering a `/works/OL{n}W.json` request, crediting `authorKeys`. */
function workRecord(url: string, authorKeys: string[]): Response {
  return json({
    key: /\/works\/OL\d+W/.exec(url)?.[0],
    type: { key: '/type/work' },
    authors: authorKeys.map((key) => ({ author: { key } })),
  });
}

/** The live author record answering a `/authors/OL{n}A.json` request. */
function authorRecord(url: string, name: string): Response {
  return json({ key: /\/authors\/OL\d+A/.exec(url)?.[0], type: { key: '/type/author' }, name });
}

describe('get_edition author enrichment — degrade and skip', () => {
  it('degrades only the edition whose work lookup failed and keeps the batch', async () => {
    const { identifiers, bibkeys } = enrichmentBatch(2);
    serve((url) => {
      if (url.includes('/api/books')) return Promise.resolve(json(bibkeys));
      const index = workIndex(url);
      if (index === 0) return Promise.resolve(haproxy(503));
      if (index === 1) return Promise.resolve(workRecord(url, ['/authors/OL9A']));
      if (url.includes('/authors/OL9A.json')) return Promise.resolve(authorRecord(url, 'Nine'));
      return Promise.reject(new Error(`unrouted ${url}`));
    });

    // Edition 1's lookups race edition 0's failure, so only edition 0's outcome
    // is asserted here; the skip itself is pinned by the next test.
    const { editions, unresolved, authorGaps } =
      await getOpenLibraryService().getEditionsByIdentifiers(
        identifiers,
        'olid',
        createMockContext(),
      );

    expect(unresolved).toEqual([]);
    expect(editions.map((e) => e.edition_id)).toEqual(identifiers);
    expect(editions[0]?.authors).toEqual([]);
    expect(authorGaps.failed).toEqual(['OL1000M']);
    // One 503 ends that ladder — no in-loop retry.
    expect(requestsTo('/works/OL2000W.json')).toBe(1);
  });

  it('skips every lookup not yet started after the first failure', async () => {
    const count = EDITION_ENRICHMENT_CONCURRENCY + 2;
    const { identifiers, bibkeys } = enrichmentBatch(count);
    serve(async (url) => {
      if (url.includes('/api/books')) return json(bibkeys);
      const index = workIndex(url);
      if (index === 0) return haproxy(503);
      if (index !== undefined) {
        // The other in-flight work lookups answer after the failure has landed.
        await new Promise((resolve) => setTimeout(resolve, 20));
        return workRecord(url, [`/authors/OL${5000 + index}A`]);
      }
      throw new Error(`unrouted ${url}`);
    });

    const { editions, authorGaps } = await getOpenLibraryService().getEditionsByIdentifiers(
      identifiers,
      'olid',
      createMockContext(),
    );

    // One bibkeys request plus the work lookups the gate had already admitted.
    expect(requestsTo('/api/books')).toBe(1);
    expect(requestsTo('/works/')).toBe(EDITION_ENRICHMENT_CONCURRENCY);
    // No author lookup was started after the failure.
    expect(requestsTo('/authors/')).toBe(0);

    expect(authorGaps.failed).toEqual(['OL1000M']);
    expect(authorGaps.skipped).toEqual(identifiers.slice(1));
    // Work lookups that finished keep the credit, named by its ID; the two that
    // never started have no credit at all.
    for (let i = 1; i < EDITION_ENRICHMENT_CONCURRENCY; i++) {
      expect(editions[i]?.authors).toEqual([
        { name: `OL${5000 + i}A`, author_id: `OL${5000 + i}A`, source: 'work' },
      ]);
    }
    expect(editions[count - 1]?.authors).toEqual([]);
  });

  it('treats a failed author lookup — the second hop — as the batch failure too', async () => {
    const { identifiers, bibkeys } = enrichmentBatch(3);
    serve(async (url) => {
      if (url.includes('/api/books')) return json(bibkeys);
      const index = workIndex(url);
      if (index !== undefined) {
        // Edition 0's work answers first; the others wait until its author failed.
        if (index > 0) await new Promise((resolve) => setTimeout(resolve, 20));
        return workRecord(url, [`/authors/OL${5000 + index}A`]);
      }
      if (url.includes('/authors/OL5000A.json')) return haproxy(503);
      throw new Error(`unrouted ${url}`);
    });

    const { editions, authorGaps } = await getOpenLibraryService().getEditionsByIdentifiers(
      identifiers,
      'olid',
      createMockContext(),
    );

    expect(requestsTo('/authors/')).toBe(1);
    expect(authorGaps.failed).toEqual(['OL1000M']);
    expect(authorGaps.skipped).toEqual(['OL1001M', 'OL1002M']);
    expect(editions[0]?.authors).toEqual([
      { name: 'OL5000A', author_id: 'OL5000A', source: 'work' },
    ]);
  });

  it('reports no gaps and issues every lookup when enrichment succeeds', async () => {
    const { identifiers, bibkeys } = enrichmentBatch(3);
    serve(async (url) => {
      if (url.includes('/api/books')) return json(bibkeys);
      const index = workIndex(url);
      if (index !== undefined) {
        return workRecord(url, [`/authors/OL${5000 + index}A`]);
      }
      const author = /\/authors\/(OL\d+A)\.json/.exec(url)?.[1];
      if (author) return authorRecord(url, `Name ${author}`);
      throw new Error(`unrouted ${url}`);
    });

    const { editions, authorGaps } = await getOpenLibraryService().getEditionsByIdentifiers(
      identifiers,
      'olid',
      createMockContext(),
    );

    expect(authorGaps).toEqual({ failed: [], skipped: [] });
    expect(editions.map((e) => e.authors[0]?.name)).toEqual([
      'Name OL5000A',
      'Name OL5001A',
      'Name OL5002A',
    ]);
    expect(requestsTo('/works/')).toBe(3);
    expect(requestsTo('/authors/')).toBe(3);
  });

  it('does not count an author the upstream 404s as a failure', async () => {
    const { identifiers, bibkeys } = enrichmentBatch(2);
    serve(async (url) => {
      if (url.includes('/api/books')) return json(bibkeys);
      const index = workIndex(url);
      if (index !== undefined) {
        return workRecord(url, [`/authors/OL${5000 + index}A`]);
      }
      if (url.includes('/authors/OL5000A.json')) return new Response('{}', { status: 404 });
      if (url.includes('/authors/OL5001A.json')) return authorRecord(url, 'Found');
      throw new Error(`unrouted ${url}`);
    });

    const { editions, authorGaps } = await getOpenLibraryService().getEditionsByIdentifiers(
      identifiers,
      'olid',
      createMockContext(),
    );

    expect(authorGaps).toEqual({ failed: [], skipped: [] });
    expect(editions[0]?.authors[0]?.name).toBe('OL5000A');
    expect(editions[1]?.authors[0]?.name).toBe('Found');
  });

  it('rejects with the cancellation when the caller aborts mid-enrichment, never a degraded success', async () => {
    const { identifiers, bibkeys } = enrichmentBatch(2);
    const controller = new AbortController();
    serve((url, init) => {
      if (url.includes('/api/books')) return Promise.resolve(json(bibkeys));
      if (workIndex(url) !== undefined) {
        return Promise.resolve(workRecord(url, ['/authors/OL9A']));
      }
      // The author lookup is in flight when the caller goes away.
      queueMicrotask(() => controller.abort());
      return hang(init);
    });

    const error = await getOpenLibraryService()
      .getEditionsByIdentifiers(
        identifiers,
        'olid',
        createMockContext({ signal: controller.signal }),
      )
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(McpError);
    expect(error).toMatchObject({ code: JsonRpcErrorCode.RequestCancelled });
  });

  it('rejects with the cancellation when the caller aborts during a work lookup', async () => {
    const { identifiers, bibkeys } = enrichmentBatch(1);
    const controller = new AbortController();
    serve((url, init) => {
      if (url.includes('/api/books')) return Promise.resolve(json(bibkeys));
      queueMicrotask(() => controller.abort());
      return hang(init);
    });

    const error = await getOpenLibraryService()
      .getEditionsByIdentifiers(
        identifiers,
        'olid',
        createMockContext({ signal: controller.signal }),
      )
      .catch((e: unknown) => e);

    expect(error).toMatchObject({ code: JsonRpcErrorCode.RequestCancelled });
  });

  it('finishes the whole batch inside one deadline when the bibkeys request was slow', async () => {
    vi.useFakeTimers();
    const { identifiers, bibkeys } = enrichmentBatch(1);
    let bibkeyCalls = 0;
    serve((url, init) => {
      if (url.includes('/api/books')) {
        bibkeyCalls++;
        // Three timed-out attempts, then an answer: ~37 s of the budget spent.
        return bibkeyCalls < 4 ? hang(init) : Promise.resolve(json(bibkeys));
      }
      return hang(init);
    });

    const call = track(() =>
      getOpenLibraryService().getEditionsByIdentifiers(identifiers, 'olid', createMockContext()),
    );
    await vi.advanceTimersByTimeAsync(2 * RETRY_DEADLINE_MS);
    await call.done;

    expect(call.state.error).toBeUndefined();
    const result = call.state.value as Awaited<
      ReturnType<ReturnType<typeof getOpenLibraryService>['getEditionsByIdentifiers']>
    >;
    expect(result.editions[0]?.authors).toEqual([]);
    expect(result.authorGaps.failed).toEqual(['OL1000M']);
    // The work lookup got only what was left of the call's budget.
    expect(call.state.elapsedMs).toBeLessThanOrEqual(RETRY_DEADLINE_MS);
  });

  it('discloses a degraded batch in the enrichment notice on both client surfaces', async () => {
    const { identifiers, bibkeys } = enrichmentBatch(1);
    serve((url) => Promise.resolve(url.includes('/api/books') ? json(bibkeys) : haproxy(503)));

    const result = await runToolContract(openlibraryGetEdition, {
      identifiers,
      id_type: 'olid',
    });

    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as { notice?: string; editions: unknown[] };
    expect(structured.editions).toHaveLength(1);
    expect(structured.notice).toContain('OL1000M');
    const text = result.content.map((block) => ('text' in block ? block.text : '')).join('\n');
    expect(text).toContain(structured.notice);
  });

  it('carries no notice when every author lookup succeeded', async () => {
    const { identifiers, bibkeys } = enrichmentBatch(1);
    serve((url) => {
      if (url.includes('/api/books')) return Promise.resolve(json(bibkeys));
      if (url.includes('/works/')) return Promise.resolve(workRecord(url, []));
      return Promise.reject(new Error(`unrouted ${url}`));
    });

    const result = await runToolContract(openlibraryGetEdition, {
      identifiers,
      id_type: 'olid',
    });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).not.toHaveProperty('notice');
  });
});

/**
 * A merged work costs one request per redirect hop. Each hop's ladder draws on
 * what is left of one call-level deadline, so a slow chain still ends inside
 * {@link RETRY_DEADLINE_MS} rather than granting every hop a fresh budget.
 */
describe('merged work resolution — one deadline per call', () => {
  /** Stubs `OL100W` → … → `OL104W`, each answered after 9 s; `OL104W` never answers. */
  function slowChain(url: string, init: FetchArgs[1]): Promise<Response> {
    const match = /\/works\/OL(\d+)W(\/editions)?\.json/.exec(url);
    const n = match ? Number(match[1]) : Number.NaN;
    if (match?.[2]) {
      return answerAfter(9_000, init, () => new Response('{}', { status: 404 }));
    }
    if (n >= 100 && n < 104) {
      return answerAfter(9_000, init, () =>
        json({
          key: `/works/OL${n}W`,
          type: { key: '/type/redirect' },
          location: `/works/OL${n + 1}W`,
        }),
      );
    }
    return hang(init);
  }

  it.each<[string, () => Promise<unknown>]>([
    ['getWork', () => getOpenLibraryService().getWork('OL100W', createMockContext())],
    [
      'getEditions',
      () => getOpenLibraryService().getEditions('OL100W', 10, 0, createMockContext()),
    ],
  ])('%s ends a slow chain inside one deadline, not one per hop', async (_label, run) => {
    vi.useFakeTimers();
    serve(slowChain);

    const call = track(run);
    await vi.advanceTimersByTimeAsync(3 * RETRY_DEADLINE_MS);
    await call.done;

    expect(call.state.error).toMatchObject({ code: JsonRpcErrorCode.Timeout });
    // A fresh ladder per hop would run the hung hop for a full 50 s after the
    // chain had already spent ~40 s getting there.
    expect(call.state.elapsedMs).toBeLessThanOrEqual(RETRY_DEADLINE_MS);
    expect(requestsTo('/works/OL103W.json')).toBe(1);
    expect(requestsTo('/works/OL104W.json')).toBeGreaterThanOrEqual(1);
  });
});

/**
 * The author twin of the merged-work case: `getAuthorWorks` chains the direct
 * works page, the redirect hops, and the canonical works page, and `getAuthor`
 * (and the author resource through it) chains the hops — each call under one
 * deadline started at entry.
 */
describe('merged author resolution — one deadline per call', () => {
  /** Stubs `OL100A` → … → `OL104A`, each answered after 9 s; `OL104A` never answers. */
  function slowAuthorChain(url: string, init: FetchArgs[1]): Promise<Response> {
    const match = /\/authors\/OL(\d+)A(\/works)?\.json/.exec(url);
    const n = match ? Number(match[1]) : Number.NaN;
    if (match?.[2]) {
      return answerAfter(9_000, init, () => new Response('{}', { status: 404 }));
    }
    if (n >= 100 && n < 104) {
      return answerAfter(9_000, init, () =>
        json({
          key: `/authors/OL${n}A`,
          type: { key: '/type/redirect' },
          location: `/authors/OL${n + 1}A`,
        }),
      );
    }
    return hang(init);
  }

  it.each<[string, () => Promise<unknown>]>([
    ['getAuthor', () => getOpenLibraryService().getAuthor('OL100A', createMockContext())],
    [
      'getAuthorWorks',
      () => getOpenLibraryService().getAuthorWorks('OL100A', 10, 0, createMockContext()),
    ],
    [
      'the author resource',
      () =>
        Promise.resolve(
          openlibraryAuthorResource.handler(
            openlibraryAuthorResource.params!.parse({ author_id: 'OL100A' }),
            createMockContext({ uri: new URL('openlibrary://authors/OL100A') }),
          ),
        ),
    ],
  ])('%s ends a slow chain inside one deadline, not one per hop', async (_label, run) => {
    vi.useFakeTimers();
    serve(slowAuthorChain);

    const call = track(run);
    await vi.advanceTimersByTimeAsync(3 * RETRY_DEADLINE_MS);
    await call.done;

    expect(call.state.error).toMatchObject({ code: JsonRpcErrorCode.Timeout });
    // A fresh ladder per hop would run the hung hop for a full 50 s after the
    // chain had already spent 36–45 s getting there.
    expect(call.state.elapsedMs).toBeLessThanOrEqual(RETRY_DEADLINE_MS);
    expect(requestsTo('/authors/OL103A.json')).toBe(1);
    expect(requestsTo('/authors/OL104A.json')).toBeGreaterThanOrEqual(1);
  });

  // The canonical works page is the third leg of the same call and draws on
  // what the first two left.
  it('getAuthorWorks bounds a hung canonical works page by the call deadline', async () => {
    vi.useFakeTimers();
    serve((url, init) => {
      if (url.includes('/authors/OL100A/works.json')) {
        return answerAfter(9_000, init, () => new Response('{}', { status: 404 }));
      }
      if (url.includes('/authors/OL100A.json')) {
        return answerAfter(9_000, init, () =>
          json({
            key: '/authors/OL100A',
            type: { key: '/type/redirect' },
            location: '/authors/OL101A',
          }),
        );
      }
      if (url.includes('/authors/OL101A.json')) {
        return answerAfter(9_000, init, () =>
          json({ key: '/authors/OL101A', type: { key: '/type/author' }, name: 'Canonical' }),
        );
      }
      return hang(init);
    });

    const call = track(() =>
      getOpenLibraryService().getAuthorWorks('OL100A', 10, 0, createMockContext()),
    );
    await vi.advanceTimersByTimeAsync(3 * RETRY_DEADLINE_MS);
    await call.done;

    expect(call.state.error).toMatchObject({ code: JsonRpcErrorCode.Timeout });
    expect(call.state.elapsedMs).toBeLessThanOrEqual(RETRY_DEADLINE_MS);
    expect(requestsTo('/authors/OL101A/works.json')).toBeGreaterThanOrEqual(1);
  });
});

/**
 * A request that would start after the call's budget is spent is never sent:
 * the call ends with the same deadline outcome a ladder running out produces.
 * The clock jump stands in for an earlier leg of the call using up the budget.
 */
describe('an exhausted call budget sends no further request', () => {
  it.each<[string, string, string, () => Promise<unknown>]>([
    [
      'getEditions',
      '/works/OL100W/editions.json',
      '/works/OL100W.json',
      () => getOpenLibraryService().getEditions('OL100W', 10, 0, createMockContext()),
    ],
    [
      'getAuthorWorks',
      '/authors/OL100A/works.json',
      '/authors/OL100A.json',
      () => getOpenLibraryService().getAuthorWorks('OL100A', 10, 0, createMockContext()),
    ],
  ])(
    '%s fails with the deadline outcome instead of issuing the next lookup',
    async (_label, pagePath, recordPath, run) => {
      vi.useFakeTimers();
      serve((url) => {
        if (url.includes(pagePath)) {
          // The first leg answers only once the whole budget is gone.
          vi.setSystemTime(Date.now() + RETRY_DEADLINE_MS);
          return Promise.resolve(new Response('{}', { status: 404 }));
        }
        return Promise.resolve(
          json({ key: recordPath.replace('.json', ''), type: { key: '/type/redirect' } }),
        );
      });

      const call = track(run);
      await vi.advanceTimersByTimeAsync(1_000);
      await call.done;

      expect(call.state.error).toBeInstanceOf(McpError);
      expect(call.state.error).toMatchObject({
        code: JsonRpcErrorCode.Timeout,
        data: { reason: 'retry_deadline_exceeded' },
      });
      expect(requestsTo(pagePath)).toBe(1);
      expect(requestsTo(recordPath)).toBe(0);
    },
  );
});
