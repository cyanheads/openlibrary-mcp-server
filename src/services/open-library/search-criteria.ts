/**
 * @fileoverview Blank-criterion policy for Open Library's search endpoints. Upstream answers a
 * whitespace-only search value with HTTP 500, and an empty one with a zero-match page, so a blank
 * value is treated as absent and a search left without any criterion is refused before a request.
 * @module services/open-library/search-criteria
 */

/**
 * The `openlibrary_search_books` inputs Open Library builds a query from, in request order.
 * `language` and `sort` only filter or order the matches; alone they match nothing.
 */
const BOOK_SEARCH_CRITERIA = ['query', 'title', 'author', 'subject', 'publisher', 'isbn'] as const;

export type BookSearchCriterion = (typeof BOOK_SEARCH_CRITERIA)[number];

/** True when a search value holds nothing but whitespace. */
export function isBlank(value: string): boolean {
  return value.trim() === '';
}

/**
 * The criteria a works search sends: each one holding more than whitespace (`isbn` more than
 * whitespace and hyphens), as given. Values stay untrimmed because upstream counts padding toward
 * its 3-character query minimum (`" ab"` matches, `"ab"` is refused).
 */
export function bookSearchCriteria(
  params: {
    readonly [K in BookSearchCriterion]?: string | undefined;
  },
): Partial<Record<BookSearchCriterion, string>> {
  const criteria: Partial<Record<BookSearchCriterion, string>> = {};
  for (const field of BOOK_SEARCH_CRITERIA) {
    const value = params[field];
    if (value !== undefined && !isBlank(field === 'isbn' ? value.replaceAll('-', '') : value))
      criteria[field] = value;
  }
  return criteria;
}
