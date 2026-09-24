/**
 * @fileoverview The `work_id` input constraint shared by the tools that take a
 * work OLID, so both advertise and enforce one pattern and one message.
 * @module mcp-server/tools/work-id
 */

/**
 * A work OLID, optionally `/works/`-prefixed. Every other shape a caller might
 * send — an ISBN, an edition or author OLID, a lowercase or padded ID, a web
 * URL or slug — fails upstream anyway (404, or a 301 to a record of another
 * type), so rejecting it here costs nothing that resolves today.
 */
export const WORK_ID_PATTERN = /^(?:\/works\/)?OL\d+W$/;

/** Validation message for a `work_id` outside {@link WORK_ID_PATTERN}; it reaches the caller as the recovery hint. */
export const WORK_ID_MESSAGE =
  'work_id must be an Open Library Work ID: OL…W (e.g., "OL45804W"), optionally prefixed "/works/". To reach a work from an ISBN, call openlibrary_get_edition with id_type "isbn" — its work_id output is the parent work. Edition IDs (OL…M) go to openlibrary_get_edition with id_type "olid", author IDs (OL…A) to openlibrary_get_author.';
