# openlibrary-mcp-server — Design

## MCP Surface

### Tools

| Name | Description | Key Inputs | Annotations |
|:-----|:------------|:-----------|:------------|
| `openlibrary_search_books` | Full-text book search across works. Supports field filters (title, author, subject, publisher, ISBN, language). Returns work-level records with edition counts, cover IDs, and reading availability. | `query`, `title`, `author`, `subject`, `publisher`, `isbn`, `language`, `sort`, `limit`, `offset`, `include_availability` | `readOnlyHint: true` |
| `openlibrary_search_inside` | Full-text search inside the scanned text of Internet Archive books. Returns matching items with snippets and a relevance score. Usually takes 10–30 s. | `query`, `limit`, `offset` | `readOnlyHint: true` |
| `openlibrary_get_work` | Fetch a work by Open Library Work ID (OL…W), following merge redirects to the canonical work. Returns title, description, subjects, cover IDs, and linked author IDs for follow-up lookups. | `work_id` | `readOnlyHint: true` |
| `openlibrary_get_editions` | List editions of a work — different publishers, languages, and formats — following merge redirects to the canonical work. Returns ISBNs, publisher, language, page count, and edition OLIDs. | `work_id`, `limit`, `offset` | `readOnlyHint: true` |
| `openlibrary_get_edition` | Resolve the first 50 distinct edition identifiers in one upstream batch: ISBN-10, ISBN-13, OCLC, LCCN, or OLID (OL…M). Returns edition metadata, per-identifier misses in `unresolved`, and remaining inputs in `unprocessed`. | `identifiers`, `id_type` | `readOnlyHint: true, idempotentHint: true` |
| `openlibrary_search_authors` | Search authors by name. Returns Open Library Author IDs, names, birth/death dates, and top works. | `query`, `limit`, `offset` | `readOnlyHint: true` |
| `openlibrary_get_author` | Fetch author detail by Open Library Author ID (OL…A). Returns bio, birth/death dates, photo IDs, and remote IDs (Wikidata, VIAF, ISNI, Goodreads, LibraryThing). | `author_id` | `readOnlyHint: true, idempotentHint: true` |
| `openlibrary_get_author_works` | List works by an author. Returns titles, cover IDs, and work OLIDs for drilling into editions or details. | `author_id`, `limit`, `offset` | `readOnlyHint: true` |
| `openlibrary_get_subject` | Browse works by subject (e.g., "science fiction", "history"). Returns matching works with edition counts and cover IDs, plus total work count for the subject. | `subject`, `limit`, `offset` | `readOnlyHint: true` |
| `openlibrary_get_cover_url` | Resolve a cover image URL for a book or author at one size (S/M/L). Supports lookup by cover ID, ISBN, OLID, or author OLID. | `identifier`, `id_type`, `target`, `size` | `readOnlyHint: true, idempotentHint: true` |

### Resources

| URI Template | Description | Pagination |
|:-------------|:------------|:-----------|
| `openlibrary://works/{work_id}` | Work detail by OL Work ID. Injectable context for chat about a specific book. | No |
| `openlibrary://authors/{author_id}` | Author detail by OL Author ID. Injectable context. | No |

Both resources declare `not_found` with the existing NotFound code and message. JSON-RPC errors carry `data.reason`, a request ID, and recovery guidance naming `openlibrary_search_books` or `openlibrary_search_authors` respectively.

### Prompts

None. The server is data/lookup-oriented; no recurring interaction patterns warrant a template.

---

## Overview

Read-only access to Open Library (Internet Archive) — a catalog of 20M+ book editions covering metadata, author info, subject browsing, and reading availability. Designed for educators, researchers, librarians, and agents that need book lookups, bibliography construction, reading list generation, or identifier resolution (ISBN, OCLC, LCCN, OLID).

The server wraps Open Library's search, work, edition, author, and subject APIs and constructs Covers API URLs. No authentication is required. Open Library [publishes limits](https://openlibrary.org/developers/api#rate-limits) of one request per second for unidentified clients and three for identified requests; the service includes a `User-Agent` with a contact email.

---

## Requirements

- Read-only; no write, list, or user-account operations
- Full-text book search with field filters (title, author, subject, publisher, ISBN, language, sort)
- Work and edition lookup by OL Work ID
- Edition lookup by any of: ISBN-10, ISBN-13, OCLC, LCCN, OLID — all four through the batch `/api/books.json?bibkeys=` endpoint
- Author search and detail retrieval, with author→works traversal
- Subject browsing with work counts and edition data
- Cover image URL construction for books and authors (S/M/L sizes)
- Reading availability status surfaced from search results where requested (only for works with an Internet Archive item in the `ia` field)
- Work → Edition relationship clearly represented; agents can drill from a work to specific printings
- Identifier passthrough: work OLIDs, edition OLIDs, author OLIDs, cover IDs surfaced in outputs for chaining

---

## Services

| Service | Wraps | Used By |
|:--------|:------|:--------|
| `OpenLibraryService` | Open Library REST APIs (`/search.json`, `/search/authors.json`, `/search/inside.json`, `/works/`, `/api/books.json`, `/authors/`, `/subjects/`) | All tools |

Single service — all Open Library endpoints share the same base URL, rate limit regime, and response-parsing conventions. No benefit to splitting.

### Timeouts and retries

Every request runs through one fetch path: `fetchWithTimeout` inside `withRetry`, with the endpoint's class deciding the per-attempt timeout.

| Class | Endpoints | Attempt timeout |
|:------|:----------|:----------------|
| record | `/works/{id}.json`, `/works/{id}/editions.json`, `/authors/{id}.json`, `/authors/{id}/works.json`, `/api/books.json` | 10 s |
| search | `/search.json`, `/search/authors.json`, `/subjects/{key}.json` | 30 s |
| fulltext | `/search/inside.json` | 45 s |

- One ladder — every attempt, backoff, and honored `Retry-After` — runs under a 50 s `deadlineMs`, below the 60 s default request timeout of MCP SDK clients. Each attempt receives the ladder's signal (deadline plus caller cancellation) and a timeout capped at the deadline's remaining time.
- A service `isTransient`, composed over the framework's `defaultIsTransient`, ends the ladder without a retry on HTTP 502/503/504, on a 2xx HTML page (raised as a `ServiceUnavailable` `McpError`), and on a full-text timeout. Those errors keep their `ServiceUnavailable`/`Timeout` code and carry no `retryable: false` — retrying later is still right for the caller.
- A 429 (honoring `Retry-After`), a network failure, and a record or search timeout retry within the deadline. A by-ID 404 maps to `null` in one request, reviving each tool's own `not_found`.
- A call that issues requests in sequence — an edition batch's author enrichment, a merged work's or author's redirect hops plus the editions or works page re-fetched under the canonical ID — spends one 50 s budget measured from the start of the call, and each ladder gets only what is left of it.
- A caller's cancellation propagates: it is never absorbed into a degraded success, a skip notice, or `upstream_unavailable`. It surfaces as `RequestCancelled` when it lands during a request; one that lands during a retry backoff reaches the caller as the raw abort, a framework behavior tracked in cyanheads/mcp-ts-core#509.

---

## Config

| Env Var | Required | Description |
|:--------|:---------|:------------|
| `OPENLIBRARY_USER_AGENT` | No | Custom `User-Agent` string. Default: `openlibrary-mcp-server casey@caseyjhand.com`. Include a contact email. |
| `OPENLIBRARY_CLAMP_LIMITS` | No | Default `true`: clamp page requests to 100 and process the first 50 distinct edition identifiers. `false` restores the original advertised schema bounds. Parsed with `z.stringbool()`. |

No API key is required.

---

## Implementation Order

1. `src/config/server-config.ts` — `OPENLIBRARY_USER_AGENT` env var
2. `OpenLibraryService` — HTTP client with `User-Agent`, retry, timeout, response parsing
3. `openlibrary_search_books` — the entry point for most workflows
4. `openlibrary_get_work` and `openlibrary_get_editions` — drill-down from search
5. `openlibrary_get_edition` — identifier resolution (ISBN/OCLC/LCCN/OLID)
6. `openlibrary_search_authors` and `openlibrary_get_author` + `openlibrary_get_author_works`
7. `openlibrary_get_subject`
8. `openlibrary_get_cover_url`
9. Resources

Each step is independently testable via real API responses.

---

## Domain Mapping

The Open Library data model has two key entity types agents need to navigate:

| Entity | ID Pattern | Description |
|:-------|:-----------|:------------|
| **Work** | `OL…W` | The abstract "book" — one record regardless of how many editions/translations exist |
| **Edition** | `OL…M` | A specific printing — tied to ISBN(s), publisher, language, format |
| **Author** | `OL…A` | Author record with bio, dates, linked remote IDs |

A work can have many editions. An edition's parent work link may be absent from the catalog response.

### Merged records

Open Library merges duplicate works and authors without deleting the absorbed record: `/works/{id}.json` (or `/authors/{id}.json`) answers 200 with a stub — `type.key: "/type/redirect"`, `location: "/works/OL…W"`, no title or name — while the record's subresources (`/editions.json`, `/works.json`) answer 404. A stub is not rewritten when its target is merged again, so chains form; the deepest observed was three hops (`OL5687942W` → `OL2968844W` → `OL2968802W` → `OL2968606W`). A live work carries no `location` key and a live author carries `location: null`, so `type.key` is the only discriminator.

Open Library also answers a by-ID URL naming another record kind — `/works/OL…M.json`, `/works/OL…A.json`, `/authors/OL…W.json` — with a 301 to that record, which native fetch follows. A 200 from a work or author URL is not proof of a work or an author, so resolution returns only a record typed `/type/work` or `/type/author`.

### Identifier systems for editions

| ID type | Example | Notes |
|:--------|:--------|:------|
| ISBN-13 | `9780743273565` | Most common; bibkey `ISBN:…`, hyphens stripped |
| ISBN-10 | `0743273567`, `080442957X` | Legacy; same bibkey prefix. The check digit may be `X`, sent upper-cased |
| OCLC | `36863723` | WorldCat number; bibkey `OCLC:…` |
| LCCN | `00027665` | Library of Congress; bibkey `LCCN:…` |
| OLID | `OL7353617M` | Native Open Library edition ID; bibkey `OLID:…` (either case) |

All four types resolve through `/api/books.json?bibkeys=…&format=json&jscmd=details`, many keys per request. The response map is keyed by the bibkey as sent, and an unknown identifier is simply absent from a 200 map — the route never 404s for a missing edition.

### Covers API

Cover images are separate from the main API:

```
https://covers.openlibrary.org/b/{key_type}/{value}-{size}.jpg
https://covers.openlibrary.org/a/{key_type}/{value}-{size}.jpg   (author photos)
```

`key_type`: `id`, `isbn`, `olid`, `lccn`, `oclc`  
`size`: `S` (small), `M` (medium), `L` (large)

The [Covers API](https://openlibrary.org/dev/docs/api/covers) returns a blank image by default when a cover is missing; `?default=false` requests a 404 instead. Rate limits can also produce error statuses. The tool constructs the default URL without fetching it, so its result cannot confirm image availability.

### Reading availability

The search endpoint supports an `availability` field selector that returns live status from archive.org:

```json
{
  "status": "borrow_available",
  "available_to_browse": true,
  "available_to_borrow": false,
  "available_to_waitlist": false,
  "is_readable": false,
  "is_lendable": true,
  "is_previewable": true,
  "is_restricted": true,
  "openlibrary_work": "OL82563W",
  "openlibrary_edition": "OL61057835M"
}
```

This is requested by adding `availability` to the `fields` query parameter. It resolves against the first IA identifier in the work's `ia` array — works without any IA items return no `availability` key, and some works that do have IA items come back without one too. This adds latency (~200ms extra per request), so it's opt-in via `include_availability: true` on `openlibrary_search_books`.

The payload is an undocumented Internet Archive lending record, and it is sparse. Across 30 limit-50 searches (1,119 objects), 25 carried `null` for five of the flags — mostly on `status: "open"` works — 9 were `status: "error"` objects (`error_message: "not found"`) missing six of them, and 5 more had only `openlibrary_edition: null`. The service maps it key by key: `status` when it is a string (`"unknown"` otherwise), each flag only when it is a boolean, `openlibrary_edition` only when it is a string. A `status: "error"` object keeps its status alone, and a value that is not an object reads as none returned.

---

## Workflow Analysis

### Common agent workflow: "find and describe a book"

| Step | Tool | Purpose |
|:-----|:-----|:--------|
| 1 | `openlibrary_search_books` | Locate the work by title/author/subject |
| 2 | `openlibrary_get_work` | Get full description, subjects, cover IDs |
| 3 | `openlibrary_get_editions` | Find a specific printing (language, publisher, year) |
| 4 | `openlibrary_get_cover_url` | Resolve cover image URL from cover ID |

### Common agent workflow: "look up by ISBN"

| Step | Tool | Purpose |
|:-----|:-----|:--------|
| 1 | `openlibrary_get_edition` (id_type: isbn) | Resolve ISBN → edition + parent work key |
| 2 | `openlibrary_get_work` | Get work-level metadata if needed |

The work tools accept only work IDs: an ISBN passed as `work_id` fails validation with a message routing it through step 1.

### Common agent workflow: "explore an author's catalog"

| Step | Tool | Purpose |
|:-----|:-----|:--------|
| 1 | `openlibrary_search_authors` | Find the author by name |
| 2 | `openlibrary_get_author` | Get bio, dates, remote IDs |
| 3 | `openlibrary_get_author_works` | List works |
| 4 | `openlibrary_get_editions` (per work) | Drill into specific editions |

### Common agent workflow: "subject discovery"

| Step | Tool | Purpose |
|:-----|:-----|:--------|
| 1 | `openlibrary_get_subject` | Browse works by subject with work counts |
| 2 | `openlibrary_get_work` | Get detail on a specific work |

---

## Tool Design Details

### Shared output and limit policy

Text and structured output preserve the same complete domain values, without text-only list caps or rounded numbers. Markdown literals, links, and images retain their underlying values.

`src/mcp-server/tools/limit-policy.ts` owns page schemas, clamping, notices, and telemetry. With `OPENLIBRARY_CLAMP_LIMITS=true`, all six paginated tools accept positive safe-integer limits above 100 and apply 100 before the request. A composed notice reports requested/applied limits and the next offset (requested offset plus returned rows); existing merge and empty-page notices survive. Each clamp logs once and increments a tool-labelled counter. With the switch false, schemas advertise `maximum: 100` and reject excess limits before the handler. Defaults, offsets, totals, and lower bounds are unchanged.

The published `openlibrary-guide` is delivered through MCP skill discovery and `skill://` resources. It covers edition evidence, identifier chains, sparse metadata, passage search, and recovery decisions.

### `openlibrary_search_books`

**Input schema:**

```ts
z.object({
  query:    z.string().optional()
    .describe('Full-text search query. Supports Solr field prefixes: title:, author:, subject:, publisher:, isbn:, language:. Omit to use the filter parameters instead.'),
  title:    z.string().optional()
    .describe('Filter by title. Matched against work title and alternative titles.'),
  author:   z.string().optional()
    .describe('Filter by author name. Partial names work.'),
  subject:  z.string().optional()
    .describe('Filter by subject tag (e.g., "science fiction", "history").'),
  publisher: z.string().optional()
    .describe('Filter by publisher name. Partial names work (e.g., "Penguin").'),
  isbn:     z.string().optional()
    .describe('Find works that have editions with this ISBN (10 or 13 digits, hyphens ignored).'),
  language: z.string().regex(/^[A-Za-z]{2,3}$/).optional()
    .describe('Restrict results to one language: a 3-letter MARC code (e.g., "eng"), or a 2-letter ISO 639-1 code translated to its MARC equivalent; an untranslatable 2-letter code is rejected.'),
  sort:     z.enum(['relevance', 'new', 'old', 'rating', 'editions'])
    .default('relevance')
    .describe('Sort order. "relevance" uses Solr scoring. "new"/"old" sort by first publish year. "rating" by average community rating. "editions" by edition count.'),
  limit:    paginationLimit(10)
    .describe('Max results to return. Higher values increase response size; prefer 10–20 for exploration.'),
  offset:   z.number().int().min(0).default(0)
    .describe('Zero-based offset for pagination.'),
  include_availability: z.boolean().default(false)
    .describe('Include live reading availability from Internet Archive (borrow/read status). Adds ~200ms latency. Use when the user needs to know if they can read the book online.'),
})
```

**Output schema includes:** `total`, `offset`, `works[]` where each work has: `work_id`, `title`, `author_names`, `author_ids`, `first_publish_year`, `edition_count`, `cover_id` (optional), `subjects` (optional), `ebook_access` (enum: `no_ebook | unclassified | printdisabled | borrowable | public`; an unrecognized upstream tier maps to `unclassified`), `has_fulltext`, `ratings_average` (optional), `availability` (present on every work whenever `include_availability: true` — an object, or `null` when Open Library returned none), `ia_identifiers`.

The `availability` object shape (when present): `status` (required — observed values `open`, `borrow_available`, `borrow_unavailable`, `private`, `error`, plus `unknown` when upstream sent none) and the optional flags `available_to_browse`, `available_to_borrow`, `available_to_waitlist`, `is_readable`, `is_lendable`, `is_previewable`, `is_restricted`, and `openlibrary_edition`. A flag upstream left `null` or absent is omitted, never defaulted to `false` — that would contradict a `status: "open"` work — and `format()` renders only the flags present.

**Implementation note:** `availability` is requested by including it in the `fields` query parameter (e.g., `fields=key,title,availability`). It reads from the first IA identifier in the work's `ia` array. When `include_availability` is true and upstream returned no availability object — always for a work without `ia` items, sometimes for one with them — the output carries `availability: null`, rendered as "No availability returned by Open Library", never as "no Internet Archive item".

**Errors:**
- `unknown_language_code` — `ValidationError`: a 2-letter `language` value has no MARC equivalent, so no filter could be applied. Raised in the service before any request.
- `invalid_search_query` — `ValidationError`: the search endpoint returned HTTP 422. Only validated upstream validation messages are exposed; malformed detail receives a generic recovery message. The input schema and query/filter forwarding remain unchanged, including empty-query filter searches.

**Selected edition:** optional `matching_edition` contains `edition_id` and any supplied `title`, `languages`, and `publishers`; optional `matching_edition_count` preserves the nested provider count even if no selected record is present. The nested search fields are requested in the same upstream call for every search mode. Selection is provider-ranked and can reflect field filters, query syntax, and unfielded terms; it does not prove that every term matched the edition. Work totals and pagination retain their meaning.

### `openlibrary_search_inside`

**Input:** `query` (non-empty; quote a phrase for an exact match), `limit` (positive integer, applied ceiling 100, default 10), `offset` (default 0).

**Output:** `total`, `offset`, `matches[]` — each: `ia_identifier`, `title` (optional), `creator` (optional), `snippets[]` (highlight markers stripped), `score`. The endpoint is an Elasticsearch passthrough: `fields` values arrive as arrays, metadata keys are `meta_`-prefixed.

**Zero matches vs. a failed answer:** `hits.total: 0` is the only zero-match signal, returned as an empty result with a notice suggesting how to broaden the query. A 200 whose body has no `hits` object carrying a numeric `total` — `{}`, `null`, an error object, a truncated payload — is `upstream_unavailable`, classified outside the retry ladder like a 2xx HTML page: one request, no no-match notice.

**Errors:**
- `upstream_unavailable` — `ServiceUnavailable`, retryable: the index answered without a result set. Retry the same query.

### `openlibrary_get_work`

**Input:** `work_id: string` matching `^(?:/works/)?OL\d+W$` (advertised as the JSON Schema `pattern`), e.g., `OL45804W` or `/works/OL45804W`. Anything else — an ISBN, an edition or author OLID, a lowercase or padded ID — fails as `-32602` / `invalid_arguments` before any request, with a message naming `openlibrary_get_edition` (`id_type: "isbn"`) as the route from an ISBN to its work. Every rejected shape already fails upstream (404, or a 301 to a record of another type).

**Resolution:** the service's work resolver follows `/type/redirect` stubs whose `location` normalizes to `OL\d+W`, up to four hops, stopping on a repeated ID; any record not typed `/type/work` resolves to not found. All hops share one 50 s budget. A live work costs one request. The `openlibrary://works/{work_id}` resource, which has no input pattern, resolves through the same path.

**Output:** `work_id` (the canonical ID — differs from the input when that ID was merged), `title`, `description`, `subjects[]`, `subject_places[]`, `subject_times[]`, `subject_people[]`, `cover_ids[]`, `author_ids[]`, `created`, `last_modified`. The enrichment `notice` names the requested and canonical IDs when they differ.

**Errors:**
- `not_found` — `NotFound`: no work under that ID, or its redirect chain reaches no work (missing or non-work `location`, cycle, past the hop cap). Recovery names `openlibrary_search_books` and, for a caller holding an ISBN, `openlibrary_get_edition`.

### `openlibrary_get_editions`

**Input:** `work_id` (same pattern and rejection as `openlibrary_get_work`), `limit` (positive integer, applied ceiling 100, default 10), `offset` (default 0).

**Resolution:** the editions page is fetched directly first. Only a null page (a merge stub's `editions.json` 404s) pays for the work resolver, and the page is then re-fetched under the canonical ID with the caller's `limit` and `offset` — a one-hop stub costs four requests, a live work one. Every request of the call shares one 50 s budget.

**Output:** `total` (mapped from the API's `size` field), `offset` (the requested offset, echoed), `work_id` (the canonical ID the editions were found under), `editions[]` — each edition: `edition_id`, `title`, `publish_date`, `publishers[]`, `languages[]` (array of 3-letter codes parsed from `/languages/eng` key objects), `isbn_10[]`, `isbn_13[]`, `page_count` (from `number_of_pages`, optional), `cover_ids[]`, `work_id` (extracted from the `works[0].key` path).

**Implementation note:** The API response top-level fields are `size` (total count), `entries` (the edition array), and `links` (pagination). Map `size` → `total` and `entries` → `editions[]` in the service layer. The `language` field in raw edition records is `languages: [{"key": "/languages/eng"}]` — extract the 3-letter code from the key path.

The endpoint neither clamps nor reports the offset — an offset past the end is an empty page with the true `size` — so `offset` echoes the request. The enrichment `notice` names the requested and canonical IDs when a merged ID was followed.

**Errors:**
- `not_found` — `NotFound`: no work under that ID, or its redirect chain reaches no work.

### `openlibrary_get_edition`

**Input:** `identifiers` (1–1,000 strings with clamping enabled; 1–50 with it disabled) and `id_type` (`isbn` | `oclc` | `lccn` | `olid`). In enabled mode, exact duplicates collapse in first-occurrence order before the first 50 distinct entries are selected. Case and ISBN punctuation are not canonicalized for deduplication. Malformed identifiers consume a selected slot. ISBNs are 10 or 13 digits with hyphens optional, and an ISBN-10 may end in an `X`/`x` check digit; OCLC numbers are numeric; OLIDs match `OL…M` in either case; LCCNs pass through unchecked. A malformed identifier is reported per entry as `invalid_identifier` and never sent upstream.

**Routing:** every `id_type` → one `GET /api/books.json?bibkeys={TYPE}:{id},…&format=json&jscmd=details` per batch (record timeout class). `jscmd=details` wraps each edition under a `details` key, carries `works[].key` (`jscmd=data` omits it), and embeds author names inline. ISBN bibkeys drop hyphens and upper-case an `x` check digit; the caller's spelling is echoed back.

**Upstream faults:** the route never 404s for a missing edition, so any HTTP error status other than 429, or an HTML page in place of JSON, is classified as `upstream_unavailable` outside the retry ladder — a 404 or a gateway failure costs one request, and a retried failure (a 500) is classified once the ladder gives up. A 429 stays `RateLimited`.

**Author enrichment:** an edition whose record lists no authors takes its credits from the parent work (`source: "work"`) — one lookup of the parent work plus one lookup per credited author, six in flight per batch. Both follow merge redirects: an edition can still point at a merged-away work, whose stub carries no credits, and a work can still credit a merged-away author, whose stub carries no name — so a merged author is credited under the canonical author's ID and name. The batch shares one 50 s budget from the start of the call, bibkeys request included, and each lookup's retry ladder gets only what is left of it. A failed lookup degrades its own edition — no credits when the work lookup failed, a credit named by author ID when an author lookup did — and every lookup not yet started is then skipped. An author the upstream has no record for — or answers with a record of another type — keeps its ID as the name without counting as a failure. The tool's enrichment `notice` names the editions whose lookups failed or were skipped; a caller's cancellation propagates instead of degrading.

**Output:** `editions[]` — each `edition_id`, `title`, `authors[]` (name, optional author_id, `source`), `publish_date`, `publishers[]`, `language`, `isbn_10[]`, `isbn_13[]`, `oclc[]` (merged from `oclc_numbers` and the singular `oclc_number` some records use instead, in record order, de-duplicated), `lccn[]`, `lc_classifications[]`, `page_count`, `description`, `cover_ids[]`, `work_id` (the parent work OLID), `ebook_url` (if available via `ocaid`) — plus `unresolved[]` (`identifier`, `reason`).

**Errors:**
- `not_found` — `NotFound`: no identifier in the batch resolved. Verify the values or try searching by title/author.
- `invalid_identifier` — `ValidationError`: every identifier is malformed for the id_type.
- `upstream_unavailable` — `ServiceUnavailable`, retryable: the bibkeys route failed upstream. Retry the same call later.

**Edition evidence:** detail adds optional `languages` in catalog order while retaining `language` as the first code. List and detail expose optional `physical_format` and `edition_name` verbatim; null, missing, and empty values are omitted independently.

**Continuation:** `unprocessed` carries every remaining distinct input verbatim, including an empty array when none remain. A shortened batch reports raw requested, distinct, and processed counts and logs/counts the clamp once. All-failure errors retain `invalid_identifier`/`not_found` and carry the remainder in typed data and text-visible recovery. No additional bibkeys batch is issued.

### `openlibrary_search_authors`

**Input:** `query: string`, `limit` (positive integer, applied ceiling 100, default 10), `offset` (default 0).

**Output:** `total`, `offset` (the requested offset, echoed), `authors[]` — each: `author_id`, `name`, `alternate_names[]`, `birth_date`, `death_date`, `top_work`, `work_count`, `top_subjects[]`, `ratings_average`.

### `openlibrary_get_author`

**Input:** `author_id: string` — `OL…A` format. Leading `/authors/` prefix stripped if provided.

**Output:** `author_id`, `name`, `personal_name`, `fuller_name`, `bio`, `birth_date`, `death_date`, `photo_ids[]`, `remote_ids` (object with optional keys: `wikidata`, `viaf`, `isni`, `goodreads`, `librarything`).

**Resolution:** the same merge-redirect resolver as works (`/type/redirect` stubs whose `location` normalizes to an author OLID, either case, up to four hops, one 50 s budget); any record not typed `/type/author` resolves to not found, with no merge notice. Empty IDs after `/authors/` prefix stripping return not found before either resolver or direct works-page fetch. Nonempty IDs retain permissive handling, without an input pattern. The `openlibrary://authors/{author_id}` resource and `openlibrary_get_author_works` share this policy.

**Errors:**
- `not_found` — `NotFound`: no author under that ID, a record of another type (a work or edition OLID), or a redirect chain that reaches no author. Verify the OLID or search by name first.

### `openlibrary_get_author_works`

**Input:** `author_id: string`, `limit` (positive integer, applied ceiling 100, default 20), `offset` (default 0).

**Output:** `total` (mapped from the API's `size` field), `offset` (the requested offset, echoed — the endpoint neither clamps nor reports it), `author_id` (the canonical ID after a merge redirect), `works[]` — each: `work_id`, `title`, `first_publish_date` (optional), `cover_ids[]`.

**Implementation note:** The API response top-level fields are `size` (total count) and `entries` (the work array). Map `size` → `total` and `entries` → `works[]`.

### `openlibrary_get_subject`

**Input:**
```ts
z.object({
  subject: z.string()
    .describe('Subject name. Trimmed, lowercased, and normalized from whitespace to underscores (e.g., " Science Fiction " → "science_fiction").'),
  limit: paginationLimit(12)
    .describe('Max works to return. Subject pages typically show 12 at a time.'),
  offset: z.number().int().min(0).default(0),
})
```

**Output:** `subject_name`, `subject_key`, `work_count`, `offset` (the requested offset, echoed on every path, the empty-subject return included), `works[]` — each: `work_id`, `title`, `author_names[]`, `edition_count`, `cover_id`.

**Errors:** `invalid_subject` (`ValidationError`) rejects blank-after-trim input before a request. Unknown nonblank subjects remain successful zero-work pages, with a notice suggesting a different word form, synonym, or broader term.

### `openlibrary_get_cover_url`

**Input:**
```ts
z.object({
  identifier: z.string()
    .describe('The identifier value. For "id": numeric cover ID from work/edition data. For "isbn": 10 or 13 digits. For "olid": edition OLID (OL…M) or author OLID (OL…A) when target is "author".'),
  id_type: z.enum(['id', 'isbn', 'olid'])
    .describe('"id" is the numeric cover_i / cover ID from search/work results. "isbn" and "olid" look up the cover from those identifiers.'),
  target: z.enum(['book', 'author']).default('book')
    .describe('"book" returns a cover image from covers.openlibrary.org/b/. "author" returns a photo from covers.openlibrary.org/a/ — use with id_type "id" (photo_id) or "olid" (author OLID).'),
  size: z.enum(['S', 'M', 'L']).default('M')
    .describe('Image size. S=small (~45px tall), M=medium (~150px tall), L=large (~400px tall).'),
})
```

**Output:** `url: string` — HTTPS URL on `covers.openlibrary.org`, rendered as a Markdown image, and `note: string` explaining that the image was not fetched or verified.

**Implementation note:** Missing covers can produce a placeholder image. Since this tool makes no request, it cannot declare `not_found` or infer access from an HTTP status.

---

## Known Limitations

- **Author names in edition records** — `/api/books.json?jscmd=details` embeds author names inline for the credits an edition records itself. Many editions record none and defer to their parent work, whose record carries author keys only, so those cost a work lookup plus a lookup per author (see `openlibrary_get_edition`).
- **`availability` adds latency** — the `availability` field in search triggers a cross-request to archive.org. This is why it's opt-in.
- **Full-text search is slow** — `/search/inside.json` usually answers in 10–30 s on a healthy upstream (12–13 s typical in recent runs, up to ~30 s; the search engine itself reports ~2 s), hence its 45 s attempt timeout. A timed-out attempt is never re-issued; a 429 or network error still retries within the 50 s deadline.
- **Subjects are uncontrolled vocabulary** — Open Library subjects are user-contributed strings, highly inconsistent (`"Science fiction"`, `"science fiction"`, `"SF"` are separate subjects). `openlibrary_get_subject` normalizes to lowercase and underscores, but exact subject discovery may require trial-and-error.
- **Sparse edition data** — many older or community-contributed editions lack page counts, language codes, covers, or parent-work links. Optional scalars stay absent; required collection fields can be empty.
- **Shared upstream limits** — Open Library publishes request limits; secondary author lookups also consume that allowance. A `User-Agent` identifies requests but does not guarantee capacity.
- **Works API doesn't return author names** — `GET /works/{id}.json` returns author keys, not names. Agents that need names alongside work data should use `openlibrary_search_books` (which does return `author_name[]`) or follow up with `openlibrary_get_author`.

---

## API Reference

### Base URL
`https://openlibrary.org`

### Key endpoints

| Endpoint | Purpose |
|:---------|:--------|
| `GET /search.json?q=…&fields=…&limit=…&offset=…` | Book search |
| `GET /search/authors.json?q=…&limit=…&offset=…` | Author search |
| `GET /works/{work_id}.json` | Work detail |
| `GET /works/{work_id}/editions.json?limit=…&offset=…` | Work editions list |
| `GET /api/books.json?bibkeys={ISBN\|OCLC\|LCCN\|OLID}:{id},…&format=json&jscmd=details` | Editions by any identifier type, many per request (`jscmd=details` carries the `works` reference and author names) |
| `GET /search/inside.json?q=…&limit=…&offset=…` | Full-text search inside scanned books |
| `GET /authors/{author_id}.json` | Author detail |
| `GET /authors/{author_id}/works.json?limit=…&offset=…` | Author works |
| `GET /subjects/{subject_key}.json?limit=…&offset=…` | Subject browsing |

### Covers
`https://covers.openlibrary.org/b/{key_type}/{value}-{size}.jpg` — books  
`https://covers.openlibrary.org/a/{key_type}/{value}-{size}.jpg` — authors  
Sizes: `S`, `M`, `L`. The default missing-cover response is a blank image; the tool does not fetch it.

### Pagination
Search: `offset`+`limit` or `page`+`limit` (page is 1-indexed). Works/editions, author works: `offset`+`limit`, with `next` link in response. Subjects: `offset`+`limit`.

### Error responses
HTTP 404 returns `{"error": "notfound", "key": "…"}`. HTTP 200 with empty `docs[]` is a valid empty search result (not an error). A by-ID 200 can still be a merge stub or a record of another type (see Merged records).

---

## Decisions Log

| Decision | Rationale |
|:---------|:----------|
| **No `openlibrary_resolve_identifier` wrapper tool** — edition lookup goes directly through `openlibrary_get_edition` with `id_type` enum | The id_type enum on `get_edition` is self-documenting and avoids a redundant tool. Agents pass the identifier and its type together — there's no ambiguity to resolve. |
| **Search retains work rows and exposes the provider-selected edition** | Nested edition fields arrive in the same Search API response, preserving the provider's selection without extra lookups or a local Solr parser. Detailed edition verification still uses `get_edition` or `get_editions`. |
| **`include_availability` is opt-in boolean, not a separate tool** | Availability data comes from the same search endpoint via an extra field selector, but adds latency. Folding it into the search tool as an opt-in preserves the fast path for the common case. |
| **`openlibrary_get_cover_url` returns a URL string** | The client can render the image URL directly. Constructing it requires no image fetch and makes no availability claim. |
| **No `openlibrary_get_reading_list` or user account tools** | The "Your Books" and "Lists" APIs require OAuth and are write-capable. Out of scope for a read-only server targeting book discovery, not personal library management. |
| **Single `OpenLibraryService`** | All Open Library endpoints share base URL, `User-Agent`, retry config, and rate limit. No benefit to splitting by endpoint group. |
| **`sort` exposes five values** | Relevance, newest, oldest, most editions, and rating cover the supported discovery paths without exposing arbitrary Solr sort expressions. |
| **Every `openlibrary_get_edition` id_type routes through `/api/books.json`** | One request per batch with author names inline. The per-ID routes (`/isbn/`, `/books/`) resolved 6 of 10 sampled ISBNs to a different edition than the bibkeys route, carry no inline author names, and 404 on a lowercase OLID, so they are not used even as an outage fallback — which edition an ISBN resolves to must not depend on upstream health. The legacy `/api/books` path (no `.json`) began answering 404 for every bibkey in September 2026. |
| **Per-endpoint-class timeouts under one 50 s deadline** | A single 15 s timeout was below full-text search latency and re-issued the query until an attempt happened to finish, while a four-attempt ladder against a hung upstream outlasted the 60 s client timeout. Class timeouts wait out a slow answer; the deadline guarantees a classified error first. |
| **No in-loop retry on 502/503/504 or a 2xx HTML page, via a composed `isTransient` rather than `retryable: false`** | Those are saturation signals: re-sending within seconds adds load without changing the answer. `retryable: false` would also reach the wire and tell the caller never to retry, which is wrong for a transient outage. |
| **A bibkeys-route fault is `upstream_unavailable`, never `not_found`** | That route reports a missing edition by omitting its key from a 200 map, so a 404 there means the route is broken; passing it through as `NotFound` told callers the edition did not exist. |
| **Edition author enrichment degrades per edition and skips after the first failure** | Author recovery is secondary to the edition record. Failing a 50-identifier batch over one work lookup discards 49 good records, and continuing to issue lookups against a failing upstream only multiplies the wait. |
| **`work_id` rejects anything but a work OLID at schema validation; no ISBN routing inside the work tools** | Every rejected shape already fails upstream, so the pattern costs nothing that resolves today, adds no request, and names the one-call route (`openlibrary_get_edition`, `id_type: "isbn"`). Routing ISBNs inside would add a request and a second failure mode under a parameter named `work_id`. |
| **One merge-redirect resolver for works and authors, keyed on `type.key` and requiring the expected record type** | `getEditions` and `getAuthorWorks` resolve only after a null page so a live record stays one request. The resolver returns only a `/type/work` or `/type/author` record because Open Library 301s a URL naming another record kind to that record, and a work reported as an author (or the reverse) is wrong data with a false merge notice. Author IDs take no input pattern, so no form that resolves is narrowed. |
| **The three list tools echo the requested `offset`** | None of their endpoints clamps or reports an offset, so the request is the applied value; an output field (not enrichment) matches the three search tools, which already declare one. |
| **A full-text 200 without a result set is `upstream_unavailable`, not zero matches** | `hits.total: 0` is the index's only zero-match signal; reading `{}` or an error object as zero matches told callers to rephrase queries that were fine. |
| **Availability flags are omitted when upstream sends none, never defaulted** | A `false` default would report a `status: "open"` book as unreadable. |
| **No `openlibrary_search_books` `page` parameter — only `offset`** | The API supports both `page` and `offset`. `offset` is more composable for agents iterating through results programmatically. |
| **Resources for works and authors, not editions or subjects** | Resources are stable, addressable context — works and authors have stable OLIDs and are worth injecting as context. Editions are often intermediate results (an agent gets an edition OLID from a search or work lookup). Subjects are browsing paths, not stable addressable entities. |
| **No DataCanvas integration** | Search results are bounded (max 100 per request) and metadata-only. Not tabular analytical data. Canvas adds complexity without benefit here. |
