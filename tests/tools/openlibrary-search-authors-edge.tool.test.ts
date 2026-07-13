/**
 * @fileoverview Edge case and security tests for the openlibrary_search_authors tool.
 * @module tests/tools/openlibrary-search-authors-edge.tool.test
 */

import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { openlibrarySearchAuthors } from '@/mcp-server/tools/definitions/openlibrary-search-authors.tool.js';
import { initOpenLibraryService } from '@/services/open-library/open-library-service.js';

describe('openlibrarySearchAuthors — edge cases and security', () => {
  beforeEach(() => {
    initOpenLibraryService();
  });

  // ─── Input validation ───────────────────────────────────────────────────────

  it('rejects limit below 1', () => {
    expect(() => openlibrarySearchAuthors.input.parse({ query: 'tolkien', limit: 0 })).toThrow();
  });

  it('rejects limit above 100', () => {
    expect(() => openlibrarySearchAuthors.input.parse({ query: 'tolkien', limit: 101 })).toThrow();
  });

  it('rejects negative offset', () => {
    expect(() => openlibrarySearchAuthors.input.parse({ query: 'tolkien', offset: -1 })).toThrow();
  });

  // ─── Pagination boundaries ──────────────────────────────────────────────────

  it('accepts limit 1', () => {
    const input = openlibrarySearchAuthors.input.parse({ query: 'tolkien', limit: 1 });
    expect(input.limit).toBe(1);
  });

  it('accepts limit 100', () => {
    const input = openlibrarySearchAuthors.input.parse({ query: 'tolkien', limit: 100 });
    expect(input.limit).toBe(100);
  });

  // ─── Service error propagation ──────────────────────────────────────────────

  it('propagates service errors', async () => {
    const ctx = createMockContext({ errors: openlibrarySearchAuthors.errors });
    const svc = (
      await import('@/services/open-library/open-library-service.js')
    ).getOpenLibraryService();
    vi.spyOn(svc, 'searchAuthors').mockRejectedValueOnce(new Error('Network error'));

    const input = openlibrarySearchAuthors.input.parse({ query: 'tolkien' });
    await expect(openlibrarySearchAuthors.handler(input, ctx)).rejects.toThrow('Network error');
  });

  // ─── Injection attempt ──────────────────────────────────────────────────────

  it('passes query injection attempt to service as plain text', async () => {
    const ctx = createMockContext({ errors: openlibrarySearchAuthors.errors });
    const svc = (
      await import('@/services/open-library/open-library-service.js')
    ).getOpenLibraryService();
    const spy = vi.spyOn(svc, 'searchAuthors').mockResolvedValueOnce({
      total: 0,
      authors: [],
    });

    const injectionQuery = '<script>alert("xss")</script>';
    const input = openlibrarySearchAuthors.input.parse({ query: injectionQuery });
    await openlibrarySearchAuthors.handler(input, ctx);

    expect(spy).toHaveBeenCalledWith(injectionQuery, expect.any(Number), expect.any(Number), ctx);
  });

  // ─── Notice enrichment ──────────────────────────────────────────────────────

  it('notice mentions the query when no results found', async () => {
    const ctx = createMockContext({ errors: openlibrarySearchAuthors.errors });
    const svc = (
      await import('@/services/open-library/open-library-service.js')
    ).getOpenLibraryService();
    vi.spyOn(svc, 'searchAuthors').mockResolvedValueOnce({ total: 0, authors: [] });

    const input = openlibrarySearchAuthors.input.parse({ query: 'xzxzxz_notanauthor' });
    await openlibrarySearchAuthors.handler(input, ctx);

    const enrichment = getEnrichment(ctx);
    expect(enrichment.notice).toContain('xzxzxz_notanauthor');
  });

  // ─── Format edge cases ──────────────────────────────────────────────────────

  it('formats author with no ratings (absent rating line)', () => {
    const author = {
      author_id: 'OL1A',
      name: 'No-Ratings Author',
      alternate_names: [],
      work_count: 3,
      top_subjects: [],
      // ratings_average absent
    };
    const output = { total: 1, authors: [author] };
    const text = (openlibrarySearchAuthors.format!(output)[0] as { text: string }).text;
    expect(text).toContain('OL1A');
    expect(text).not.toContain('Rating:');
    expect(text).not.toContain('undefined');
  });

  it('caps top subjects in text and discloses the omitted count, keeping the full array', async () => {
    const ctx = createMockContext({ errors: openlibrarySearchAuthors.errors });
    const svc = (
      await import('@/services/open-library/open-library-service.js')
    ).getOpenLibraryService();

    const author = {
      author_id: 'OL2A',
      name: 'Prolific Author',
      alternate_names: [],
      work_count: 50,
      top_subjects: ['Subject1', 'Subject2', 'Subject3', 'Subject4', 'Subject5', 'Subject6'],
    };
    vi.spyOn(svc, 'searchAuthors').mockResolvedValueOnce({ total: 1, authors: [author] });

    const input = openlibrarySearchAuthors.input.parse({ query: 'prolific' });
    const result = await openlibrarySearchAuthors.handler(input, ctx);

    // structuredContent keeps every top subject.
    expect(result.authors[0]!.top_subjects).toHaveLength(6);

    // The enrichment trailer discloses the cap and true total — previously silent.
    const enrichment = getEnrichment(ctx);
    expect(enrichment.notice).toContain('showing 5 of 6');
    expect(enrichment.notice).toContain('structuredContent');

    // format() still caps the text at 5 — the 6th subject is omitted from content[].
    const text = (openlibrarySearchAuthors.format!(result)[0] as { text: string }).text;
    expect(text).toContain('Subject5');
    expect(text).not.toContain('Subject6');
  });

  it('does not disclose top-subject capping at exactly the cap (boundary)', async () => {
    const ctx = createMockContext({ errors: openlibrarySearchAuthors.errors });
    const svc = (
      await import('@/services/open-library/open-library-service.js')
    ).getOpenLibraryService();

    const author = {
      author_id: 'OL2A',
      name: 'Boundary Author',
      alternate_names: [],
      work_count: 50,
      top_subjects: ['Subject1', 'Subject2', 'Subject3', 'Subject4', 'Subject5'],
    };
    vi.spyOn(svc, 'searchAuthors').mockResolvedValueOnce({ total: 1, authors: [author] });

    const input = openlibrarySearchAuthors.input.parse({ query: 'boundary' });
    await openlibrarySearchAuthors.handler(input, ctx);

    // Exactly 5 subjects, cap 5 — nothing omitted, so no truncation disclosure.
    expect(getEnrichment(ctx).notice).toBeUndefined();
  });

  it('formats empty results cleanly', () => {
    const output = { total: 0, authors: [] };
    const text = (openlibrarySearchAuthors.format!(output)[0] as { text: string }).text;
    expect(text).toContain('Total:** 0');
    expect(text).toContain('Returned:** 0');
    expect(text).not.toContain('undefined');
  });

  it('format does not emit null strings', () => {
    const author = {
      author_id: 'OL3A',
      name: 'Sparse Author',
      alternate_names: [],
      work_count: 0,
      top_subjects: [],
    };
    const text = (
      openlibrarySearchAuthors.format!({ total: 1, authors: [author] })[0] as {
        text: string;
      }
    ).text;
    expect(text).not.toContain('null');
  });
});
