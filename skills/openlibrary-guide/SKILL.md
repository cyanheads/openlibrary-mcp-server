---
name: openlibrary-guide
description: Use with openlibrary_* tools when identifying a book from a passage, selecting a particular edition, resolving bibliographies, or checking reading availability. Guides catalog identity, edition evidence, incomplete metadata, and no-match recovery.
license: Apache-2.0
metadata:
  author: "cyanheads"
  version: "1.0"
---

## Scope

Use Open Library for book discovery, bibliographic metadata, author catalogs, and links to Internet Archive copies. Metadata search finds catalog records; passage search covers scanned book text indexed by Internet Archive. Neither establishes coverage of every published book. The server is keyless and read-only; personal library management and borrowing transactions are outside its scope.

## Identifiers

Book search, subject browsing, and author catalogs yield work IDs. Edition lists yield edition IDs for detailed lookup; identifier lookup can return a parent work ID when the catalog records one. Author search and work records yield author IDs; author details yield photo IDs and external authority identifiers. Keep those external identifiers separate from Open Library IDs.

Passage search yields Internet Archive item identifiers, also found among a catalog search result's IA identifiers. An IA item identifies a scan, not an Open Library work or edition. Cover IDs come from book records; photo IDs come from author records.

## Gates

- Verify the edition before asserting a particular translation, publisher, date, format, or printing. Work-level search matches establish a candidate work; they do not establish that one edition satisfies every requested condition. Missing edition metadata remains unknown.
- Check unresolved identifiers and author-recovery notices before calling a bibliography complete. A credit recovered from the parent work does not establish an edition-specific translator, editor, or other contributor. An empty author list accompanied by a recovery notice is incomplete evidence.
- Request live availability before answering whether a copy can be read or borrowed now. Missing flags, absent availability, and an availability error are unknowns. An IA item or reading URL alone does not prove unrestricted access.
- Compare the total with the returned page and its offset before treating an empty page as no matches. A timeout or upstream failure says nothing about whether a book or passage exists. Even a genuine zero-match result establishes only that the current query found nothing in this index.
- Use the canonical work or author ID returned after a merge for subsequent lookups.
- Treat a cover URL as a candidate image link. The URL tool does not fetch the image; verify the image separately before claiming a cover exists.

## Core chain

For a book known by title or author, identify the intended work, inspect its metadata, then inspect its editions when the question concerns a particular publication. Resolve author IDs separately when names or biographical details are needed. For a known ISBN or other edition identifier, start with edition lookup and follow its parent work only when that link is present.

## Workflows

### Select a translation or printing

Narrow metadata search to candidate works, then inspect editions against the user's conditions. Continue through edition pages before concluding that no suitable edition is catalogued. Use detailed edition lookup for a candidate that needs closer inspection. Report which conditions the record confirms and which remain unrecorded; do not substitute the work's first publication date for the edition's publication date.

Metadata queries support field prefixes such as `title:`, `author:`, `subject:`, `publisher:`, `isbn:`, and `language:`. In-query language filters use three-letter MARC codes, for example `language:fre`; two-letter normalization belongs to the dedicated language filter. Inspect the effective-query echo when supplied before interpreting surprising results.

### Resolve a bibliography

Group edition identifiers by type and resolve each group with openlibrary_get_edition. Keep unresolved entries attached to their original input. Correct malformed identifiers; search by title and author when a well-formed identifier has no catalog match. If author recovery is incomplete, retry only the affected editions later rather than treating missing names as anonymous authorship.

### Explore an author's catalog

Disambiguate people using biographical details and representative works before attributing a catalog to a person. Follow the selected author's works into work detail or editions as the question requires. When browsing by subject, change word form, use a synonym, or broaden the term after zero results: the subject tool normalizes case and spacing, so changing only those repeats the same lookup.

### Identify a remembered passage

Use openlibrary_search_inside when the text of a passage is the evidence. Double quotes request an exact phrase; unquoted words search more broadly. A genuine zero match can justify shortening the phrase or removing quotes. Allow for the slower full-text endpoint before switching tactics; an upstream failure calls for retrying later, not rewriting a supposedly unsuccessful query.

Read the returned snippets as evidence of the matched scan. Follow its IA identifier to `https://archive.org/details/{ia_identifier}`. To connect it to Open Library metadata, search using the candidate title or creator and compare IA identifiers before asserting that the scan and catalog record correspond. Relevance scores compare hits within that result set; they are not confidence percentages.

### Check reading access or show artwork

Use live availability for the candidate work and preserve its reported edition context when discussing access. Distinguish freely readable, borrowable, restricted, and unknown access using the returned evidence. Resolve artwork from a record's cover or photo IDs, keeping book covers and author photos separate.
