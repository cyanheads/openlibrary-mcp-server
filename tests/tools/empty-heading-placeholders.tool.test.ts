/**
 * @fileoverview Regression tests for #28 — records Open Library holds with no
 * title (or no name) must not render as a bare markdown heading in `content[]`.
 * One block per tool whose `format()` puts a coalesced-to-empty field in a
 * heading; each asserts the placeholder replaces it, no heading line is left
 * bare, the record identifier still anchors the entry, and a populated value is
 * rendered unchanged.
 * @module tests/tools/empty-heading-placeholders.tool.test
 */

import { describe, expect, it } from 'vitest';
import { openlibraryGetAuthor } from '@/mcp-server/tools/definitions/openlibrary-get-author.tool.js';
import { openlibraryGetAuthorWorks } from '@/mcp-server/tools/definitions/openlibrary-get-author-works.tool.js';
import { openlibraryGetEdition } from '@/mcp-server/tools/definitions/openlibrary-get-edition.tool.js';
import { openlibraryGetEditions } from '@/mcp-server/tools/definitions/openlibrary-get-editions.tool.js';
import { openlibraryGetSubject } from '@/mcp-server/tools/definitions/openlibrary-get-subject.tool.js';
import { openlibraryGetWork } from '@/mcp-server/tools/definitions/openlibrary-get-work.tool.js';
import { openlibrarySearchAuthors } from '@/mcp-server/tools/definitions/openlibrary-search-authors.tool.js';
import { openlibrarySearchBooks } from '@/mcp-server/tools/definitions/openlibrary-search-books.tool.js';
import { NO_NAME, NO_TITLE } from '@/mcp-server/tools/heading-placeholders.js';

/** A heading marker with nothing after it — the #28 symptom. */
const BARE_HEADING = /^#{1,6}[ \t]*$/m;

function render(blocks: ReadonlyArray<{ type: string; text?: string }>): string {
  const first = blocks[0];
  if (first?.type !== 'text' || first.text === undefined) {
    throw new Error(`format() produced no leading text block (got ${first?.type ?? 'nothing'})`);
  }
  return first.text;
}

describe('openlibraryGetWork format — empty title', () => {
  const work = {
    work_id: 'OL45822402W',
    title: '',
    subjects: [],
    subject_places: [],
    subject_times: [],
    subject_people: [],
    cover_ids: [],
    author_ids: [],
  };

  it('renders the placeholder instead of a bare heading', () => {
    const text = render(openlibraryGetWork.format!(work));
    expect(text).toContain(`## ${NO_TITLE}`);
    expect(text).not.toMatch(BARE_HEADING);
    expect(text).toContain('**Work ID:** OL45822402W');
  });

  it('renders a populated title unchanged', () => {
    const text = render(openlibraryGetWork.format!({ ...work, title: 'The Great Gatsby' }));
    expect(text).toContain('## The Great Gatsby');
    expect(text).not.toContain(NO_TITLE);
  });
});

describe('openlibraryGetAuthorWorks format — empty title', () => {
  const result = {
    total: 1,
    author_id: 'OL19981A',
    works: [{ work_id: 'OL45822402W', title: '', cover_ids: [] }],
  };

  it('renders the placeholder instead of a bare heading', () => {
    const text = render(openlibraryGetAuthorWorks.format!(result));
    expect(text).toContain(`### ${NO_TITLE}`);
    expect(text).not.toMatch(BARE_HEADING);
    expect(text).toContain('**Work ID:** OL45822402W');
  });

  it('renders a populated title unchanged', () => {
    const text = render(
      openlibraryGetAuthorWorks.format!({
        ...result,
        works: [{ ...result.works[0]!, title: 'Tender Is the Night' }],
      }),
    );
    expect(text).toContain('### Tender Is the Night');
    expect(text).not.toContain(NO_TITLE);
  });
});

describe('openlibraryGetEdition format — empty title', () => {
  const edition = {
    edition_id: 'OL7353617M',
    title: '',
    authors: [],
    publishers: [],
    isbn_10: [],
    isbn_13: [],
    oclc: [],
    lccn: [],
    lc_classifications: [],
    cover_ids: [],
  };
  const result = { editions: [edition], unresolved: [] };

  it('renders the placeholder instead of a bare heading', () => {
    const text = render(openlibraryGetEdition.format!(result));
    expect(text).toContain(`## ${NO_TITLE}`);
    expect(text).not.toMatch(BARE_HEADING);
    expect(text).toContain('**Edition ID:** OL7353617M');
  });

  it('renders a populated title unchanged', () => {
    const text = render(
      openlibraryGetEdition.format!({
        ...result,
        editions: [{ ...edition, title: 'The Great Gatsby' }],
      }),
    );
    expect(text).toContain('## The Great Gatsby');
    expect(text).not.toContain(NO_TITLE);
  });
});

describe('openlibraryGetEditions format — empty title', () => {
  const result = {
    total: 1,
    work_id: 'OL45804W',
    editions: [
      {
        edition_id: 'OL7353617M',
        title: '',
        publishers: [],
        languages: [],
        isbn_10: [],
        isbn_13: [],
        cover_ids: [],
      },
    ],
  };

  it('renders the placeholder instead of a bare heading', () => {
    const text = render(openlibraryGetEditions.format!(result));
    expect(text).toContain(`### ${NO_TITLE}`);
    expect(text).not.toMatch(BARE_HEADING);
    expect(text).toContain('**Edition ID:** OL7353617M');
  });

  it('renders a populated title unchanged', () => {
    const text = render(
      openlibraryGetEditions.format!({
        ...result,
        editions: [{ ...result.editions[0]!, title: 'The Great Gatsby' }],
      }),
    );
    expect(text).toContain('### The Great Gatsby');
    expect(text).not.toContain(NO_TITLE);
  });
});

describe('openlibraryGetSubject format — empty title', () => {
  const result = {
    subject_name: 'Fiction',
    subject_key: 'fiction',
    work_count: 1,
    works: [{ work_id: 'OL45822402W', title: '', author_names: [], edition_count: 0 }],
  };

  it('renders the placeholder instead of a bare heading', () => {
    const text = render(openlibraryGetSubject.format!(result));
    expect(text).toContain(`### ${NO_TITLE}`);
    expect(text).not.toMatch(BARE_HEADING);
    expect(text).toContain('**Work ID:** OL45822402W');
  });

  it('renders a populated title unchanged', () => {
    const text = render(
      openlibraryGetSubject.format!({
        ...result,
        works: [{ ...result.works[0]!, title: 'The Great Gatsby' }],
      }),
    );
    expect(text).toContain('### The Great Gatsby');
    expect(text).not.toContain(NO_TITLE);
  });
});

describe('openlibrarySearchBooks format — empty title', () => {
  const result = {
    total: 1,
    offset: 0,
    works: [
      {
        work_id: 'OL45822402W',
        title: '',
        author_names: [],
        author_ids: [],
        edition_count: 1,
        ebook_access: 'no_ebook' as const,
        has_fulltext: false,
        ia_identifiers: [],
      },
    ],
  };

  it('renders the placeholder instead of a bare heading', () => {
    const text = render(openlibrarySearchBooks.format!(result));
    expect(text).toContain(`## ${NO_TITLE}`);
    expect(text).not.toMatch(BARE_HEADING);
    expect(text).toContain('**Work ID:** OL45822402W');
  });

  it('renders a populated title unchanged', () => {
    const text = render(
      openlibrarySearchBooks.format!({
        ...result,
        works: [{ ...result.works[0]!, title: 'The Great Gatsby' }],
      }),
    );
    expect(text).toContain('## The Great Gatsby');
    expect(text).not.toContain(NO_TITLE);
  });
});

describe('openlibraryGetAuthor format — empty name', () => {
  const result = { author_id: 'OL24638A', name: '', photo_ids: [], remote_ids: {} };

  it('renders the placeholder instead of a bare heading', () => {
    const text = render(openlibraryGetAuthor.format!(result));
    expect(text).toContain(`## ${NO_NAME}`);
    expect(text).not.toMatch(BARE_HEADING);
    expect(text).toContain('**Author ID:** OL24638A');
  });

  it('renders a populated name unchanged', () => {
    const text = render(openlibraryGetAuthor.format!({ ...result, name: 'F. Scott Fitzgerald' }));
    expect(text).toContain('## F. Scott Fitzgerald');
    expect(text).not.toContain(NO_NAME);
  });
});

describe('openlibrarySearchAuthors format — empty name', () => {
  const result = {
    total: 1,
    offset: 0,
    authors: [
      {
        author_id: 'OL24638A',
        name: '',
        alternate_names: [],
        work_count: 0,
        top_subjects: [],
      },
    ],
  };

  it('renders the placeholder instead of a bare heading', () => {
    const text = render(openlibrarySearchAuthors.format!(result));
    expect(text).toContain(`## ${NO_NAME}`);
    expect(text).not.toMatch(BARE_HEADING);
    expect(text).toContain('**Author ID:** OL24638A');
  });

  it('renders a populated name unchanged', () => {
    const text = render(
      openlibrarySearchAuthors.format!({
        ...result,
        authors: [{ ...result.authors[0]!, name: 'F. Scott Fitzgerald' }],
      }),
    );
    expect(text).toContain('## F. Scott Fitzgerald');
    expect(text).not.toContain(NO_NAME);
  });
});
