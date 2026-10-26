/**
 * @fileoverview Shared schema, notice, and telemetry policy for bounded Open Library requests.
 * @module mcp-server/tools/limit-policy
 */

import { type Context, z } from '@cyanheads/mcp-ts-core';
import { createCounter } from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig } from '@/config/server-config.js';

let clampCounter: ReturnType<typeof createCounter> | undefined;

/** Build the advertised page size with the operator's startup policy. */
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

/** Apply the page ceiling once before making an upstream request. */
export function applyPaginationLimit(
  requested: number,
  tool: string,
  ctx: Pick<Context, 'log'>,
): number {
  const applied = Math.min(requested, 100);
  if (applied !== requested) recordLimitClamp(tool, ctx, { requested, applied });
  return applied;
}

/** Describe a shortened page and resume after the rows actually returned. */
export function paginationLimitNotice(
  requested: number,
  offset: number,
  returned: number,
): string | undefined {
  return requested > 100
    ? `Requested limit ${requested}; applied limit 100. Next offset: ${offset + returned}.`
    : undefined;
}

/** Compose enrichment once so a correction never replaces existing guidance. */
export function composeNotices(...notices: Array<string | undefined>): string | undefined {
  const present = notices.filter((notice) => notice !== undefined);
  return present.length ? present.join(' ') : undefined;
}
