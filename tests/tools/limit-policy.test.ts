/**
 * @fileoverview Startup policy, page boundaries, and exactly-once clamp telemetry.
 * @module tests/tools/limit-policy.test
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from '@cyanheads/mcp-ts-core';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

const telemetry = vi.hoisted(() => ({ add: vi.fn(), create: vi.fn() }));
vi.mock('@cyanheads/mcp-ts-core/utils', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  createCounter: telemetry.create.mockImplementation(() => ({ add: telemetry.add })),
}));

describe('limit policy', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
    telemetry.create.mockClear();
    telemetry.add.mockClear();
  });

  it.each([true, false])(
    'preserves lower and finite integer bounds with clamping=%s',
    async (enabled) => {
      vi.stubEnv('OPENLIBRARY_CLAMP_LIMITS', String(enabled));
      const { paginationLimit } = await import('@/mcp-server/tools/limit-policy.js');
      const schema = paginationLimit(20);
      for (const invalid of [
        0,
        -1,
        1.5,
        Number.NaN,
        Number.POSITIVE_INFINITY,
        Number.NEGATIVE_INFINITY,
        Number.MAX_SAFE_INTEGER + 1,
        '2',
        null,
      ]) {
        expect(schema.safeParse(invalid).success).toBe(false);
      }
      expect(schema.parse(undefined)).toBe(20);
      expect(schema.parse(1)).toBe(1);
      expect(schema.parse(100)).toBe(100);
      expect(schema.safeParse(101).success).toBe(enabled);
      expect(z.toJSONSchema(schema).maximum).toBe(enabled ? Number.MAX_SAFE_INTEGER : 100);
    },
  );

  it('records exactly once per shortened request and composes every notice', async () => {
    const { applyPaginationLimit, paginationLimitNotice, composeNotices } = await import(
      '@/mcp-server/tools/limit-policy.js'
    );
    const ctx = createMockContext();
    const log = vi.spyOn(ctx.log, 'notice');
    expect(telemetry.create).not.toHaveBeenCalled();
    expect(applyPaginationLimit(100, 'openlibrary_search_authors', ctx)).toBe(100);
    expect(telemetry.create).not.toHaveBeenCalled();
    expect(applyPaginationLimit(101, 'openlibrary_search_authors', ctx)).toBe(100);
    expect(log).toHaveBeenCalledExactlyOnceWith('Applied Open Library request limit', {
      tool: 'openlibrary_search_authors',
      requested: 101,
      applied: 100,
    });
    expect(telemetry.create).toHaveBeenCalledTimes(1);
    expect(telemetry.add).toHaveBeenCalledExactlyOnceWith(1, {
      tool: 'openlibrary_search_authors',
    });
    expect(paginationLimitNotice(101, 20, 0)).toBe(
      'Requested limit 101; applied limit 100. Next offset: 20.',
    );
    expect(paginationLimitNotice(101, 20, 7)).toBe(
      'Requested limit 101; applied limit 100. Next offset: 27.',
    );
    expect(paginationLimitNotice(100, 20, 7)).toBeUndefined();
    expect(composeNotices(undefined, 'Merged author.', paginationLimitNotice(101, 20, 7))).toBe(
      'Merged author. Requested limit 101; applied limit 100. Next offset: 27.',
    );
    expect(composeNotices(undefined)).toBeUndefined();
  });
});

describe('real runtime startup policy', () => {
  const project = fileURLToPath(new URL('../../', import.meta.url));
  let scratchRoot: string;
  let bundle: string;

  beforeAll(() => {
    scratchRoot = mkdtempSync(join(tmpdir(), 'openlibrary-limit-policy-'));
    const built = mkdtempSync(join(scratchRoot, 'startup-'));
    bundle = join(built, 'search-authors.mjs');
    symlinkSync(join(project, 'node_modules'), join(built, 'node_modules'), 'dir');
    execFileSync(
      'bun',
      [
        'build',
        './src/mcp-server/tools/definitions/openlibrary-search-authors.tool.ts',
        '--target=node',
        '--packages=external',
        '--outfile',
        bundle,
      ],
      { cwd: project, timeout: 30_000 },
    );
  });

  afterAll(() => {
    rmSync(scratchRoot, { recursive: true });
  });

  for (const runtime of ['node', 'bun']) {
    it(`${runtime} loads .env before building the advertised schema`, () => {
      const cwd = mkdtempSync(join(scratchRoot, `${runtime}-false-`));
      writeFileSync(join(cwd, '.env'), 'OPENLIBRARY_CLAMP_LIMITS=false\n');
      const env = { ...process.env };
      delete env.OPENLIBRARY_CLAMP_LIMITS;
      // Exercise the failing assertion in the same process without importing the server twice.
      const script = `import assert from 'node:assert/strict'; const {openlibrarySearchAuthors:t}=await import(${JSON.stringify(bundle)}); assert.throws(() => assert.equal(1, 2), {code:'ERR_ASSERTION'}); assert.equal(t.input.safeParse({query:'x',limit:101}).success, false, 'Expected disabled clamp rejection'); assert.equal(t.input.safeParse({query:'x',limit:100}).success, true, 'Expected limit100 acceptance');`;
      const result = spawnSync(runtime, ['--input-type=module', '-e', script], {
        cwd,
        env,
        encoding: 'utf8',
        timeout: 10_000,
      });
      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);
    });

    it(`${runtime} names a malformed clamp setting`, () => {
      const cwd = mkdtempSync(join(scratchRoot, `${runtime}-invalid-`));
      writeFileSync(join(cwd, '.env'), 'OPENLIBRARY_CLAMP_LIMITS=perhaps\n');
      const env = { ...process.env };
      delete env.OPENLIBRARY_CLAMP_LIMITS;
      const result = spawnSync(
        runtime,
        ['--input-type=module', '-e', `await import(${JSON.stringify(bundle)})`],
        { cwd, env, encoding: 'utf8', timeout: 10_000 },
      );
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('OPENLIBRARY_CLAMP_LIMITS');
    });
  }
});
