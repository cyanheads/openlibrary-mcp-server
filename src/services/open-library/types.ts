/**
 * @fileoverview Domain types for the Open Library service.
 * @module services/open-library/types
 */

/** Work-level record as returned by the search API. */
export type SearchWork = {
  work_id: string;
  title: string;
  author_names: string[];
  author_ids: string[];
  first_publish_year?: number;
  edition_count: number;
  cover_id?: number;
  subjects?: string[];
  ebook_access: 'no_ebook' | 'unclassified' | 'printdisabled' | 'borrowable' | 'public';
  has_fulltext: boolean;
  ratings_average?: number;
  /** Present when include_availability is true; null when work has no IA item. */
  availability?: WorkAvailability | null | undefined;
  ia_identifiers: string[];
};

/** Reading availability from Internet Archive. */
export type WorkAvailability = {
  status: string;
  available_to_browse: boolean;
  available_to_borrow: boolean;
  available_to_waitlist: boolean;
  is_readable: boolean;
  is_lendable: boolean;
  is_previewable: boolean;
  is_restricted: boolean;
  openlibrary_edition?: string;
};

/** Full work detail. */
export type WorkDetail = {
  work_id: string;
  title: string;
  description?: string | undefined;
  subjects: string[];
  subject_places: string[];
  subject_times: string[];
  subject_people: string[];
  cover_ids: number[];
  author_ids: string[];
  created?: string;
  last_modified?: string;
};

/** Edition summary within a work's edition list. */
export type EditionSummary = {
  edition_id: string;
  title: string;
  publish_date?: string;
  publishers: string[];
  languages: string[];
  isbn_10: string[];
  isbn_13: string[];
  page_count?: number;
  cover_ids: number[];
  work_id?: string;
};

/**
 * An author credited on an edition. `source` records where the attribution came
 * from: `'edition'` when the edition record itself lists the author, `'work'`
 * when it was recovered from the parent work (Open Library records authorship at
 * the work level for many editions).
 */
export type EditionAuthor = {
  name: string;
  author_id?: string | undefined;
  source: 'edition' | 'work';
};

/** Full edition detail. */
export type EditionDetail = {
  edition_id: string;
  title: string;
  authors: EditionAuthor[];
  publish_date?: string | undefined;
  publishers: string[];
  language?: string | undefined;
  isbn_10: string[];
  isbn_13: string[];
  oclc: string[];
  lccn: string[];
  lc_classifications: string[];
  page_count?: number | undefined;
  description?: string | undefined;
  cover_ids: number[];
  work_id?: string | undefined;
  ebook_url?: string | undefined;
};

/** Author search result. */
export type AuthorSearchResult = {
  author_id: string;
  name: string;
  alternate_names: string[];
  birth_date?: string;
  death_date?: string;
  top_work?: string;
  work_count: number;
  top_subjects: string[];
  ratings_average?: number;
};

/** Full author detail. */
export type AuthorDetail = {
  author_id: string;
  name: string;
  personal_name?: string | undefined;
  fuller_name?: string | undefined;
  bio?: string | undefined;
  birth_date?: string | undefined;
  death_date?: string | undefined;
  photo_ids: number[];
  remote_ids: {
    wikidata?: string | undefined;
    viaf?: string | undefined;
    isni?: string | undefined;
    goodreads?: string | undefined;
    librarything?: string | undefined;
  };
};

/** Work summary in author works list. */
export type AuthorWork = {
  work_id: string;
  title: string;
  first_publish_date?: string;
  cover_ids: number[];
};

/** Work summary in a subject's work list. */
export type SubjectWork = {
  work_id: string;
  title: string;
  author_names: string[];
  edition_count: number;
  cover_id?: number;
};

/** Identifier type for edition lookup. */
export type EditionIdType = 'isbn' | 'oclc' | 'lccn' | 'olid';
