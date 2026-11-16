/**
 * @fileoverview The `work_id` input constraint shared by the tools that take a
 * work OLID, so both advertise and enforce one pattern and one message.
 * @module mcp-server/tools/work-id
 */

/**
 * A work OLID, optionally `/works/`-prefixed. An ISBN, an edition or author
 * OLID, a padded ID, a web URL or slug all fail upstream anyway (404, or a 301
 * to a record of another type). A lowercase OLID is rejected too, although the
 * service would upper-case it: the pattern is advertised in `tools/list`, and
 * widening it would change a validation outcome existing clients rely on.
 */
export const WORK_ID_PATTERN = /^(?:\/works\/)?OL\d+W$/;

/** Validation message for a `work_id` outside {@link WORK_ID_PATTERN}; it reaches the caller as the recovery hint. */
export const WORK_ID_MESSAGE =
  'work_id must be an Open Library Work ID: OL…W (e.g., "OL45804W"), optionally prefixed "/works/". To reach a work from an ISBN, call openlibrary_get_edition with id_type "isbn" — its work_id output is the parent work. Edition IDs (OL…M) go to openlibrary_get_edition with id_type "olid", author IDs (OL…A) to openlibrary_get_author.';
