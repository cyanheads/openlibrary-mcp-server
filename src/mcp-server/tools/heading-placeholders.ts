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
 * These stand in for the empty value in the rendered `content[]` text only —
 * `structuredContent` keeps `''`. They are literal markers rather than the
 * record identifier: every heading that uses one is immediately followed by a
 * line carrying that identifier, so falling back to it would print it twice.
 */
export const NO_TITLE = '*(no title recorded)*';

/** Heading placeholder for a record whose name is absent upstream. */
export const NO_NAME = '*(no name recorded)*';
