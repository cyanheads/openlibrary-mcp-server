/**
 * @fileoverview Thread-CPU timing assertion for code that scans caller-sized text.
 * @module tests/timing
 */

import { expect } from 'vitest';

const BASE = 5_000;
const LARGEST = 320_000;

/** Thread CPU milliseconds `work` takes, which test files running beside it cannot inflate. */
function cpuMs(work: () => void): number {
  const start = process.threadCpuUsage();
  work();
  const { user, system } = process.threadCpuUsage(start);
  return (user + system) / 1000;
}

/**
 * Asserts `run` stays linear in its input from 5k to 320k characters, doubling the size each step.
 * Every sample processes 320k characters (many calls at small sizes, so a 5k call measures above
 * the clock) and the least of five counts, since a garbage-collection pause only adds time. Each
 * sample must finish under `boundMs` of thread CPU before the next size runs, so a super-linear
 * regression fails within seconds. The 5k baseline is re-timed beside every larger size and the
 * full-span growth is read against the slowest of those baselines, so a baseline that ran on a
 * faster core cannot fake super-linear growth: linear is 64, quadratic 4,096, the bound 256.
 * Run it from a test whose timeout is `0`; vitest cannot interrupt a synchronous body anyway.
 */
export function expectLinearTime(
  make: (size: number) => string,
  run: (text: string) => unknown,
  boundMs = 500,
): void {
  const perCall = (text: string) => {
    const calls = Math.max(1, Math.round(LARGEST / text.length));
    run(text);
    const least = Math.min(
      ...Array.from({ length: 5 }, () =>
        cpuMs(() => {
          for (let call = 0; call < calls; call++) run(text);
        }),
      ),
    );
    expect(least, `${calls} × ${text.length} characters`).toBeLessThan(boundMs);
    return least / calls;
  };

  const baseline = make(BASE);
  const baselines: number[] = [];
  let largest = 0;
  for (let size = BASE * 2; size <= LARGEST; size *= 2) {
    baselines.push(perCall(baseline));
    largest = perCall(make(size));
  }
  expect(largest / Math.max(...baselines)).toBeLessThan(256);
}
