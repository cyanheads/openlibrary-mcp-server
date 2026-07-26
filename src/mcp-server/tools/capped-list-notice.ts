/**
 * @fileoverview Disclosure text for per-item lists that `format()` caps in the
 * rendered text while `structuredContent` keeps them complete.
 * @module mcp-server/tools/capped-list-notice
 */

/**
 * Builds the disclosure sentence for a nested per-item array that `format()`
 * truncates in text, aggregated across a page of results. Returns `undefined`
 * when the cap omitted nothing, so the caller can skip the notice entirely.
 *
 * `ctx.enrich.notice()` is last-wins — a later call overwrites the earlier
 * value rather than appending — so a handler disclosing more than one cap must
 * join the fragments this returns into a single `notice()` call.
 *
 * @param lengths - Per-item list lengths, one entry per result on the page.
 * @param cap - Max entries `format()` renders per item.
 * @param labels - `label` names the list, `unit` the per-item noun, `path` the
 *   dotted `structuredContent` location of the complete array.
 */
export function cappedListNotice(
  lengths: readonly number[],
  cap: number,
  labels: { label: string; unit: string; path: string },
): string | undefined {
  let shown = 0;
  let total = 0;
  for (const length of lengths) {
    total += length;
    shown += Math.min(length, cap);
  }
  if (total <= shown) return;

  const { label, unit, path } = labels;
  return `${label} are capped at ${cap} per ${unit} in text output; showing ${shown} of ${total}. Full per-${unit} lists are in structuredContent (${path}).`;
}
