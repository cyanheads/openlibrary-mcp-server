/**
 * @fileoverview Bundle cleanup preserves executable skill modules while removing package-root agent docs.
 * @module tests/scripts/mcpb-packaging.test
 */

import { describe, expect, it } from 'vitest';
import { filterAgentDocEntries } from '../../scripts/clean-mcpb.js';
import { checkBundleEntries } from '../../scripts/lint-packaging.js';

describe('MCPB package-root agent documentation', () => {
  it.each([
    ['skills/openlibrary-guide/SKILL.md', false],
    ['node_modules/@modelcontextprotocol/server/dist/ext/skills/index.mjs', false],
    ['node_modules/@modelcontextprotocol/core/dist/ext/skills/index.mjs', false],
    [
      'node_modules/outer/node_modules/@modelcontextprotocol/server/dist/ext/skills/node.mjs',
      false,
    ],
    ['node_modules/example/dist/skills/runtime.js', false],
    ['node_modules/example/skills/guide/SKILL.md', true],
    ['node_modules/@scope/example/framework-skills/guide/SKILL.md', true],
    ['node_modules/example/.claude/settings.json', true],
    ['node_modules/example/.agents/guide.md', true],
    ['node_modules/example/SKILL.md', true],
    ['node_modules/outer/node_modules/@scope/example/skills/guide/SKILL.md', true],
    [
      'node_modules/@scope/outer/node_modules/inner/node_modules/vendor/skills/guide/SKILL.md',
      true,
    ],
  ] as const)('classifies %s at the installed package boundary', (path, remove) => {
    expect(filterAgentDocEntries([path])).toEqual(remove ? [path] : []);
    expect(checkBundleEntries([path], 'test.mcpb')).toHaveLength(remove ? 1 : 0);
  });
});
