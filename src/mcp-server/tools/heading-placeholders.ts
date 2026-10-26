/**
 * @fileoverview Placeholder labels for markdown headings whose source field is
 * empty, so `format()` never emits a bare heading marker.
 * @module mcp-server/tools/heading-placeholders
 */

/**
 * Open Library holds records with no title and no name: the upstream JSON
 * carries `null`, which the service normalizes to `''` so the required
 * `structuredContent` field stays a string. Interpolating that directly into a
 * heading produces `### ` with nothing after it, which reads as a truncated
 * record rather than an untitled one.
 *
 * The heading marker is authored Markdown; the formatter also labels the empty
 * title explicitly. A separate identifier line anchors the record.
 */
export const NO_TITLE = '*(no title recorded)*';
