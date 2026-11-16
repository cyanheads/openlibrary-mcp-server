<div align="center">
  <h1>@cyanheads/openlibrary-mcp-server</h1>
  <p><b>Search books and authors, fetch editions, browse subjects, and resolve cover images from Open Library via MCP. STDIO or Streamable HTTP.</b>
  <div>10 Tools • 2 Catalog Resources • 1 Agent Skill</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.4.1-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/openlibrary-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^2.4.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/openlibrary-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/openlibrary-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.4.4-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/openlibrary-mcp-server/releases/latest/download/openlibrary-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=openlibrary-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjeWFuaGVhZHMvb3BlbmxpYnJhcnktbWNwLXNlcnZlciJdfQ==) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22openlibrary-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40cyanheads%2Fopenlibrary-mcp-server%22%5D%7D)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

**Public Hosted Server:** [https://openlibrary.caseyjhand.com/mcp](https://openlibrary.caseyjhand.com/mcp)

</div>

---

## Overview

Open Library's catalog of 20M+ books, editions, authors, and subjects, plus full-text search inside Internet Archive's scanned books. Search and browse, drill from a work into its editions or an author into their works, and construct cover image URLs.

### Tools

| Tool | Description |
|:---|:---|
| `openlibrary_search_books` | Catalog search with field filters (title, author, subject, publisher, ISBN, language), a provider-selected edition, pagination, and optional live reading availability |
| `openlibrary_get_work` | Fetch a work by Open Library Work ID (OL…W) — title, description, subjects, cover IDs, and author IDs |
| `openlibrary_get_editions` | List editions of a work — publishers, languages, formats, ISBNs, print run details, and edition-level credits (subtitle, by-statement, translators and other contributors) |
| `openlibrary_get_edition` | Resolve up to 50 distinct identifiers per call by ISBN-10, ISBN-13, OCLC, LCCN, or Open Library Edition ID (OL…M), reporting misses and unprocessed identifiers |
| `openlibrary_search_authors` | Search authors by name — returns Author IDs, birth/death dates, top works, and subject associations |
| `openlibrary_get_author` | Fetch author detail by Open Library Author ID (OL…A) — bio, dates, photo IDs, and linked identifiers from Wikidata, VIAF, ISNI, Goodreads, and LibraryThing |
| `openlibrary_get_author_works` | List works by an author — titles, cover IDs, and Work OLIDs for drilling into editions or details |
| `openlibrary_get_subject` | Browse works by subject tag — returns matching works with edition counts and cover IDs plus the total work count |
| `openlibrary_search_inside` | Full-text search inside the scanned text of Internet Archive books — returns matching items with snippets |
| `openlibrary_get_cover_url` | Resolve a cover image URL for a book or author photo in S/M/L size — returns a direct HTTPS URL embeddable in markdown |

### Resources

| Resource | Description |
|:---|:---|
| `openlibrary://works/{work_id}` | Work detail by Open Library Work ID — title, description, subjects, cover IDs, and author IDs as injectable context |
| `openlibrary://authors/{author_id}` | Author detail by Open Library Author ID — name, bio, dates, photo IDs, and linked external identifiers as injectable context |

Both resources mirror data also available via `openlibrary_get_work` and `openlibrary_get_author` — useful for clients that don't surface MCP resources.

### Agent skill

[`openlibrary-guide`](./skills/openlibrary-guide/SKILL.md) covers edition selection, bibliography resolution, passage identification, and incomplete metadata. It is included in npm, Docker, and desktop bundles and served through MCP skill discovery and `skill://` resources.

## Capability reference

Paginated tools return at most 1,000 rows per call, except `openlibrary_search_inside` at 100. Larger positive integer limits are clamped with a notice showing the applied limit and, when a later page exists, the next offset. `OPENLIBRARY_CLAMP_LIMITS=false` restores schema rejection above 100 rows. Text and structured output carry the same complete domain data, including arrays and numeric precision.

### `openlibrary_search_books` <sub>tool</sub>

- Free-text query with Solr field prefixes (`title:`, `author:`, `subject:`, `publisher:`, `isbn:`, `language:`, plus `ia:<ia_identifier>`, `author_key:<author_id>`, `first_publish_year:[1900 TO 1950]`, `ebook_access:public`) or dedicated filter parameters; 1–1000 results per page (default 10), offset pagination
- A search needs at least one non-blank `query`, `title`, `author`, `subject`, `publisher`, or `isbn`; blank criteria count as absent, and `language` or `sort` alone fails as `no_search_criteria` before any request
- `sort`: `relevance` (default), `new`, `old`, `rating`, `editions`
- `language` accepts a 3-letter MARC code, an ISO 639-2/T code (`deu`, `fra`, …) in any case, or a translatable 2-letter ISO code; a code that is neither a MARC code nor an Open Library language record fails as `unknown_language_code` rather than silently matching nothing. Chinese is indexed under both `chi` and `cmn`
- `include_availability` adds live Internet Archive borrow/read status, off by default, at the cost of one additional search request per 100 returned works with an Internet Archive scan; flags Open Library leaves out are omitted rather than reported as `false`, and `availability: null` means none was returned for the work. A lookup that does not complete never fails the search: those works read `null` and the notice names them as unknown
- Returns work-level records with edition counts, cover IDs, subjects, and Internet Archive identifiers
- Optional `matching_edition` and `matching_edition_count` preserve the Search API's selected edition and matching count. The selected edition is provider-ranked; it does not prove that every unfielded search term matches that edition
- `invalid_search_query` reports upstream HTTP 422 validation with recovery guidance

---

### `openlibrary_get_work` <sub>tool</sub>

- Fetch by Open Library Work ID (OL…W), optionally `/works/`-prefixed; anything else — an ISBN, an edition or author OLID — fails input validation before any request, naming `openlibrary_get_edition` (`id_type: "isbn"`) as the route from an ISBN to its work
- Returns title, description, subjects (plus place/time/people breakdowns), cover IDs, and author IDs — no author names (use `openlibrary_get_author` or `openlibrary_search_books`)
- A merged work ID stays reachable — the redirect chain is followed to the canonical record, `work_id` reports the canonical ID, and an enrichment notice names both IDs when they differ
- `not_found` when the Work ID doesn't exist or its redirect chain reaches no work

---

### `openlibrary_get_editions` <sub>tool</sub>

- List editions of a work by Work ID (OL…W), optionally `/works/`-prefixed; 1–1000 per page (default 10), offset pagination, with the requested `offset` echoed in the output; an offset at or past the total returns an empty page with a notice naming the last offset that returns a result
- Same `work_id` validation as `openlibrary_get_work` — an ISBN resolves to its work through `openlibrary_get_edition` (`id_type: "isbn"`)
- Returns ISBN-10/13, publishers, languages, page count, cover IDs, and edition OLIDs (OL…M), plus `physical_format`, `edition_name`, and the edition-level credits `subtitle`, `by_statement`, `contributors` (name and role), `contributions` (legacy credit strings), and `translated_from` (MARC language codes) when recorded, all verbatim
- A merged work ID stays reachable — the editions of the canonical work come back under its ID in `work_id`, with an enrichment notice naming both IDs; a live work costs one request
- `not_found` when the Work ID doesn't exist or its redirect chain reaches no work

---

### `openlibrary_get_edition` <sub>tool</sub>

- Accepts 1–1,000 input strings, deduplicates exact strings, and processes the first 50 distinct identifiers in one upstream batch; the remainder is returned as `unprocessed` for resubmission. Every identifier shares one `id_type`: `isbn` (10 or 13 digits, an ISBN-10 may end in an `X` check digit), `oclc` (numeric), `lccn` (any non-blank string), or `olid` (OL…M). With `OPENLIBRARY_CLAMP_LIMITS=false`, the input array is limited to 50 entries
- Partial success: identifiers that resolve return in `editions` (request order), each row carrying its `identifier` exactly as supplied; the rest land in `unresolved` with `invalid_identifier` (malformed or blank, never sent upstream) or `not_found` (well-formed, no record) — the call fails only when nothing resolves
- `upstream_unavailable` (retryable) when Open Library's batch lookup itself fails — an HTTP error status other than a rate limit, or an HTML page or other body that is not JSON — so an upstream outage never reads as a missing edition
- Authors come inline — the edition's own credits, or ones marked `source: "work"` recovered from the parent work when the edition itself lists none; if those lookups fail, the batch still returns, and an enrichment notice names the editions whose authors are missing or shown by ID
- Returns ISBN-10/13, OCLC, LCCN, LC call numbers, publishers, all cataloged `languages`, page count, cover IDs, parent work ID, and an Internet Archive `ebook_url` when one exists. The singular `language` remains the first cataloged language; `physical_format`, `edition_name`, and the credits `subtitle`, `by_statement`, `contributors`, `contributions`, and `translated_from` preserve the catalog's wording when present
- If no processed identifier resolves, the typed error also carries every `unprocessed` identifier in its data and recovery hint

---

### `openlibrary_search_authors` <sub>tool</sub>

- Search by name — partial and alternate names match; 1–1000 per page (default 10), offset pagination; a blank query fails as `no_search_criteria`
- Returns Author ID (OL…A), alternate names, birth/death dates, top work, work count, top subjects, and average rating

---

### `openlibrary_get_author` <sub>tool</sub>

- Fetch by Author ID (OL…A, in any case — it is upper-cased before the request); a leading `/authors/` prefix is stripped
- Returns bio, birth/death dates, photo IDs, and linked identifiers (Wikidata, VIAF, ISNI, Goodreads, LibraryThing)
- A merged author ID stays reachable — the response is the canonical record, and an enrichment notice names the canonical ID when it differs from the one requested
- `not_found` when the Author ID doesn't exist, names a record that is not an author (a work or edition OLID), or its redirect chain reaches no author

---

### `openlibrary_get_author_works` <sub>tool</sub>

- List works by Author ID (OL…A, in any case); 1–1000 per page (default 20), offset pagination, with the requested `offset` echoed in the output; an empty page with a positive total carries a past-end notice
- Returns title, first-publish date, cover IDs, and Work ID (OL…W) per work; for an author's works ranked by edition count, use `openlibrary_search_books` with query `author_key:<author_id>` and sort `editions`
- A merged author ID stays reachable — an enrichment notice names the canonical ID when it differs from the one requested
- `not_found` when the Author ID doesn't exist, names a record that is not an author (a work or edition OLID), or its redirect chain reaches no author

---

### `openlibrary_get_subject` <sub>tool</sub>

- Subject name is trimmed, lowercased, and normalized from whitespace to underscores; 1–1000 per page (default 12), offset pagination, with the requested `offset` echoed in the output; an offset at or past the total carries a past-end notice
- A `place:`, `person:`, or `time:` prefix browses a place, person, or period, taking a value from `openlibrary_get_work`'s `subject_places`, `subject_people`, or `subject_times` verbatim (`place:London (England)`); whitespace after the prefix is dropped
- Blank input fails as `invalid_subject` before any request
- Returns canonical subject name, normalized subject key, `subject_type` (`place`, `person`, `time`, or `subject`), total work count, and per-work author names, edition count, and cover ID
- Empty results carry a recovery notice suggesting a different word form, synonym, or broader term — subject tags are user-contributed and inconsistent

---

### `openlibrary_search_inside` <sub>tool</sub>

- Full-text search across Internet Archive's scanned book text — the only tool that answers "which book contains this passage?"; quote a phrase for an exact match, unquoted terms match independently
- Usually takes 10–30 s against the live index, far above the metadata tools — reach for it deliberately, not as a general book search
- 1–100 results per page (default 10), offset pagination; each result carries a relevance score comparable only within its own result set. The full-text index serves only its first 10,000 results: a page that would run past them is shortened with a notice, and an offset of 10000 or more fails as `offset_past_result_window`. A blank query fails as `no_search_criteria`
- Results key on Internet Archive `ia_identifier`, not Open Library work IDs — pass it to `openlibrary_search_books` as query `ia:<ia_identifier>` to reach the work and, in `matching_edition`, the edition holding that scan
- `upstream_unavailable` (retryable) when the index answers without a result set, so a failed search never reads as "no book contains this"

---

### `openlibrary_get_cover_url` <sub>tool</sub>

- Resolves a cover or author-photo URL from `id` (numeric), `isbn` (10 or 13 digits, an ISBN-10 may end in an `X` check digit), or `olid` (OL…M for `target: "book"`, OL…A for `target: "author"`, in any case — the URL carries it upper-cased); `size` is `S`/`M`/`L` (default `M`)
- Identifiers are validated locally before any request — path separators, `..`, and control characters fail as `invalid_identifier`, and an author lookup by `isbn` fails as `invalid_target`
- The tool constructs the URL without fetching it; a returned URL does not verify that a cover exists
- Output URL is ready to embed directly as `![cover](url)`

---

### `openlibrary://works/{work_id}` <sub>resource</sub>

- Same fields as `openlibrary_get_work`, as injectable `application/json` context for a conversation about a specific book
- A work-OLID-shaped `work_id` in any case is upper-cased before the request
- `work_id` comes from `openlibrary_search_books` or `openlibrary_get_author_works`; a merged ID resolves to the canonical work, whose ID the returned `work_id` carries, and an ID that is not a work (an edition or author OLID) is not found

---

### `openlibrary://authors/{author_id}` <sub>resource</sub>

- Same fields as `openlibrary_get_author`, as injectable `application/json` context for a conversation about a specific author
- An author-OLID-shaped `author_id` in any case is upper-cased before the request
- `author_id` comes from `openlibrary_search_authors`; a merged ID resolves to the canonical author, whose ID the returned `author_id` carries, and an ID that is not an author (a work or edition OLID) is not found

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core): stdio and Streamable HTTP transports, pluggable auth (`none` / `jwt` / `oauth`), swappable storage (`in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`), structured logging with optional OpenTelemetry tracing.

Open Library-specific:

- Open Library Search, Search Inside (full-text), Books, Authors, and Subjects APIs, cover URL construction, and Internet Archive availability lookups
- Work → editions and author → works drill-down, with explicit OLID cross-links between tool outputs
- Configurable `User-Agent` header (`OPENLIBRARY_USER_AGENT`) identifying the server per Open Library's bot-blocking convention
- Batch edition resolution — up to 50 ISBN/OCLC/LCCN/OLID identifiers in one upstream call, with per-identifier partial-failure reporting
- Timeouts sized per endpoint class (10 s record lookups, 30 s searches, 45 s full-text) inside a 50 s retry budget, so a slow upstream is waited on and a failing one returns a classified error before a typical 60 s client timeout; gateway errors are not retried in a loop

Agent-friendly output:

- Recovery guidance on every empty result — echoes the search criteria and suggests how to broaden a query or which offset to retry
- Merged-record disclosure — `openlibrary_get_author`, `openlibrary_get_author_works`, `openlibrary_get_work`, and `openlibrary_get_editions` follow merge redirects and surface the canonical ID via an enrichment notice when a requested ID was merged
- Per-item partial failure — `openlibrary_get_edition` returns resolved editions alongside typed `unresolved` reasons instead of failing the whole batch
- Complete text and structured output, with clamp and recovery notices preserved on both surfaces

## Getting started

Add the hosted server to Claude Code — no API key required:

```sh
claude mcp add --transport http openlibrary-mcp-server https://openlibrary.caseyjhand.com/mcp
```

Or run it locally:

```sh
claude mcp add openlibrary-mcp-server -- npx -y @cyanheads/openlibrary-mcp-server
```

For other clients, add this to the MCP config file:

```json
{
  "mcpServers": {
    "openlibrary-mcp-server": {
      "command": "npx",
      "args": ["-y", "@cyanheads/openlibrary-mcp-server"]
    }
  }
}
```

For Docker or a source build, see [Running the server](#running-the-server).

## Configuration

| Variable | Description | Default |
|:---|:---|:---|
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http` | `stdio` |
| `MCP_HTTP_PORT` | HTTP server port | `3010` |
| `MCP_HTTP_ENDPOINT_PATH` | HTTP endpoint path where the MCP server is mounted | `/mcp` |
| `MCP_SESSION_MODE` | HTTP session posture: `stateless`, `stateful`, or `auto`. Overrides the `stateless` declared in `src/index.ts`. | `stateless` |
| `MCP_PUBLIC_URL` | Public origin override for TLS-terminating reverse-proxy deployments | none |
| `MCP_AUTH_MODE` | Authentication: `none`, `jwt`, or `oauth` | `none` |
| `MCP_LOG_LEVEL` | Log level (`debug`, `info`, `warning`, `error`, etc.) | `info` |
| `MCP_GC_PRESSURE_INTERVAL_MS` | Opt-in Bun-only forced-GC pressure loop (ms). Recommended starting point if heap growth is observed: `60000`. | `0` (disabled) |
| `LOGS_DIR` | Directory for log files (Node.js only) | `<project-root>/logs` |
| `STORAGE_PROVIDER_TYPE` | Storage backend: `in-memory`, `filesystem`, `supabase`, `cloudflare-kv/r2/d1` | `in-memory` |
| `OPENLIBRARY_USER_AGENT` | User-Agent sent with all Open Library API requests. Include a contact email per community convention. | `openlibrary-mcp-server casey@caseyjhand.com` |
| `OPENLIBRARY_CLAMP_LIMITS` | Clamp page limits to each page tool's ceiling (1,000 rows; 100 for `openlibrary_search_inside`) and process the first 50 distinct edition identifiers, returning the remainder. `false` restores strict input bounds of 100 rows and 50 raw identifiers. | `true` |
| `OTEL_ENABLED` | Enable OpenTelemetry | `false` |

See [`.env.example`](./.env.example) for the full list of optional overrides.

## Running the server

### Local development

Requires [Bun v1.4.4](https://bun.sh/) or higher (or Node.js ≥ 24.0.0).

- **Clone and install:**

  ```sh
  git clone https://github.com/cyanheads/openlibrary-mcp-server.git
  cd openlibrary-mcp-server && bun install
  cp .env.example .env   # optional overrides; no required variables
  ```

- **Build and run the production version:**

  ```sh
  # One-time build
  bun run rebuild

  # Run the built server
  bun run start:http
  # or
  bun run start:stdio
  ```

- **Run checks and tests:**

  ```sh
  bun run devcheck  # Lint, format, typecheck, security
  bun run test      # Vitest test suite
  bun run lint:mcp  # Validate MCP definitions against spec
  ```

### Docker

```sh
docker run --rm -p 3010:3010 ghcr.io/cyanheads/openlibrary-mcp-server:latest
```

The image defaults to HTTP transport, stateless session mode, and logs to `/var/log/openlibrary-mcp-server`. To run it over stdio from an MCP client, use `"command": "docker"` with `"args": ["run", "-i", "--rm", "-e", "MCP_TRANSPORT_TYPE=stdio", "ghcr.io/cyanheads/openlibrary-mcp-server:latest"]`. To build locally, run `docker build -t openlibrary-mcp-server .`; OpenTelemetry peer dependencies are installed by default — build with `--build-arg OTEL_ENABLED=false` to omit them.

## Project structure

| Directory | Purpose |
|:---|:---|
| `src/index.ts` | `createApp()` entry point — registers tools and resources. |
| `src/config` | Server-specific environment variable parsing and validation with Zod. |
| `src/mcp-server/tools` | Tool definitions (`*.tool.ts`) — ten tools across Search, Books, Authors, Subjects, and Covers. |
| `src/mcp-server/resources` | Resource definitions (`*.resource.ts`) — Work and Author. |
| `src/services/open-library` | Open Library service layer — API client and domain types. |
| `skills/` | Published agent guidance, also served through MCP skill discovery. |
| `tests/` | Unit and integration tests mirroring the `src/` structure. |

## Development guide

See [`CLAUDE.md`](./CLAUDE.md) for development guidelines and architectural rules. The short version:

- Handlers throw, framework catches — no `try/catch` in tool logic
- Use `ctx.log` for logging, `ctx.state` for storage
- Register new tools and resources in the `createApp()` arrays
- Wrap external API calls: validate raw → normalize to domain type → return output schema; never fabricate missing fields

## Contributing

Issues are welcome. Run checks and tests before submitting:

```sh
bun run devcheck
bun run test
```

## License

This project is licensed under the Apache 2.0 License. See the [LICENSE](./LICENSE) file for details.
