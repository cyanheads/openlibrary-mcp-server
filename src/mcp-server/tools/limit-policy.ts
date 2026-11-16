/**
 * @fileoverview Shared schema, notice, and telemetry policy for bounded Open Library requests.
 * @module mcp-server/tools/limit-policy
 */

import { type Context, z } from '@cyanheads/mcp-ts-core';
import { createCounter } from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig } from '@/config/server-config.js';

let clampCounter: ReturnType<typeof createCounter> | undefined;

/** Largest page the editions, author-works, subject, and search endpoints serve in one request. */
export const PAGE_CEILING = 1000;

/** `/search/inside.json` answers HTTP 422 above 100 rows per page. */
export const INSIDE_PAGE_CEILING = 100;

/**
 * Build the advertised page size with the operator's startup policy. With clamping off, every
 * tool keeps the original `maximum: 100` schema the switch exists to restore.
 */
export function paginationLimit(defaultLimit: number) {
  const schema = z.number().int().min(1);
  return (getServerConfig().clampLimits ? schema : schema.max(100)).default(defaultLimit);
}

/** Record one shortened request after telemetry initialization; labels are tool names only. */
export function recordLimitClamp(
  tool: string,
  ctx: Pick<Context, 'log'>,
  counts: Record<string, number>,
): void {
  ctx.log.notice('Applied Open Library request limit', { tool, ...counts });
  clampCounter ??= createCounter(
    'openlibrary.limit_clamps',
    'Requests shortened to an Open Library work ceiling',
    '{requests}',
  );
  clampCounter.add(1, { tool });
}

/** Apply the tool's page ceiling once before making an upstream request. */
export function applyPaginationLimit(
  requested: number,
  ceiling: number,
  tool: string,
  ctx: Pick<Context, 'log'>,
): number {
  const applied = Math.min(requested, ceiling);
  if (applied !== requested) recordLimitClamp(tool, ctx, { requested, applied });
  return applied;
}

/**
 * Describe a shortened page and resume after the rows actually returned. `end` is the first offset
 * that returns nothing — the match count, or the last row the endpoint serves — so a page that
 * reaches it, or lies past it, names no next offset.
 */
export function paginationLimitNotice(
  requested: number,
  applied: number,
  offset: number,
  returned: number,
  end: number,
): string | undefined {
  if (applied >= requested) return;
  const next = offset + returned;
  return `Requested limit ${requested}; applied limit ${applied}.${next < end ? ` Next offset: ${next}.` : ''}`;
}

/**
 * Disclose a page requested at or past the last row. `matched` is the clause naming what matched
 * ("161 editions belong to OL45804W"); `tail` closes the retry advice when one applies.
 */
export function pastEndNotice(
  offset: number,
  total: number,
  matched: string,
  tail?: string,
): string {
  return `Offset ${offset} is past the end of the result set — ${matched}, so the last offset that returns a result is ${total - 1}. Retry with a lower offset${tail ? `; ${tail}` : ''}.`;
}

/** Compose enrichment once so a correction never replaces existing guidance. */
export function composeNotices(...notices: Array<string | undefined>): string | undefined {
  const present = notices.filter((notice) => notice !== undefined);
  return present.length ? present.join(' ') : undefined;
}
