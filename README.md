<div align="center">
  <h1>@cyanheads/openlibrary-mcp-server</h1>
  <p><b>Search books and authors, fetch editions, browse subjects, and resolve cover images from Open Library via MCP. STDIO or Streamable HTTP.</b>
  <div>10 Tools • 2 Resources</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.2.5-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/openlibrary-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^2.0.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/openlibrary-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/openlibrary-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.4.0-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/openlibrary-mcp-server/releases/latest/download/openlibrary-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=openlibrary-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjeWFuaGVhZHMvb3BlbmxpYnJhcnktbWNwLXNlcnZlciJdfQ==) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22openlibrary-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40cyanheads%2Fopenlibrary-mcp-server%22%5D%7D)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

**Public Hosted Server:** [https://openlibrary.caseyjhand.com/mcp](https://openlibrary.caseyjhand.com/mcp)

</div>

---

## Overview

Open Library's catalog of 20M+ books, editions, authors, and subjects, plus full-text search across Internet Archive's scanned books. Search and browse from any MCP client, drill from a work into its editions or an author into their works, and resolve cover and author-photo URLs. Runs as a stdio process, a local Streamable HTTP server, or the public hosted endpoint above.

### Tools

| Tool | Description |
|:---|:---|
| `openlibrary_search_books` | Full-text book search with field filters (title, author, subject, publisher, ISBN, language), sort options, pagination, and optional live reading availability |
| `openlibrary_get_work` | Fetch a work by Open Library Work ID (OL…W) — title, description, subjects, cover IDs, and author IDs |
| `openlibrary_get_editions` | List editions of a work — publishers, languages, formats, ISBNs, and print run details |
| `openlibrary_get_edition` | Resolve up to 50 editions in one call by ISBN-10, ISBN-13, OCLC, LCCN, or Open Library Edition ID (OL…M), reporting per-identifier misses |
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

## Capability reference

### `openlibrary_search_books` <sub>tool</sub>

- Free-text query with Solr field prefixes (`title:`, `author:`, `subject:`, `publisher:`, `isbn:`, `language:`) or dedicated filter parameters; 1–100 results per page (default 10), offset pagination
- `sort`: `relevance` (default), `new`, `old`, `rating`, `editions`
- `language` accepts a 3-letter MARC code or a translatable 2-letter ISO code; an untranslatable 2-letter code fails as `unknown_language_code` rather than being silently dropped
- `include_availability` adds live Internet Archive borrow/read status (~200ms latency), off by default
- Returns work-level records with edition counts, cover IDs, subjects, and Internet Archive identifiers; `content[]` text caps Internet Archive IDs and subjects at 5 each per work, `structuredContent` carries every one

---

### `openlibrary_get_work` <sub>tool</sub>

- Fetch by Open Library Work ID (OL…W); a leading `/works/` prefix is stripped
- Returns title, description, subjects (plus place/time/people breakdowns), cover IDs, and author IDs — no author names (use `openlibrary_get_author` or `openlibrary_search_books`)
- `content[]` text caps subjects at 10; `structuredContent` carries the complete list
- `not_found` when the Work ID doesn't exist

---

### `openlibrary_get_editions` <sub>tool</sub>

- List editions of a work by Work ID (OL…W); 1–100 per page (default 10), offset pagination
- Returns ISBN-10/13, publisher, language, page count, cover IDs, and edition OLIDs (OL…M) per edition
- `not_found` when the Work ID doesn't exist

---

### `openlibrary_get_edition` <sub>tool</sub>

- Resolves 1–50 identifiers per call in a single upstream request — every identifier shares one `id_type`: `isbn` (10 or 13 digits), `oclc` (numeric), `lccn` (unchecked), or `olid` (OL…M)
- Partial success: identifiers that resolve return in `editions` (request order); the rest land in `unresolved` with `invalid_identifier` (malformed, never sent upstream) or `not_found` (well-formed, no record) — the call fails only when nothing resolves
- Authors come inline — the edition's own credits, or ones marked `source: "work"` recovered from the parent work when the edition itself lists none
- Returns ISBN-10/13, OCLC, LCCN, LC call numbers, publisher, language, page count, cover IDs, parent work ID, and an Internet Archive `ebook_url` when one exists

---

### `openlibrary_search_authors` <sub>tool</sub>

- Search by name — partial and alternate names match; 1–100 per page (default 10), offset pagination
- Returns Author ID (OL…A), alternate names, birth/death dates, top work, work count, top subjects, and average rating
- `content[]` text caps top subjects at 5 per author; `structuredContent` carries the complete list

---

### `openlibrary_get_author` <sub>tool</sub>

- Fetch by Author ID (OL…A); a leading `/authors/` prefix is stripped
- Returns bio, birth/death dates, photo IDs, and linked identifiers (Wikidata, VIAF, ISNI, Goodreads, LibraryThing)
- A merged author ID stays reachable — the response is the canonical record, and an enrichment notice names the canonical ID when it differs from the one requested
- `not_found` when the Author ID doesn't exist

---

### `openlibrary_get_author_works` <sub>tool</sub>

- List works by Author ID (OL…A); 1–100 per page (default 20), offset pagination
- Returns title, first-publish date, cover IDs, and Work ID (OL…W) per work
- A merged author ID stays reachable — an enrichment notice names the canonical ID when it differs from the one requested
- `not_found` when the Author ID doesn't exist

---

### `openlibrary_get_subject` <sub>tool</sub>

- Subject name is normalized before lookup (lowercased, spaces → underscores), so case and spacing never change the result; 1–100 per page (default 12), offset pagination
- Returns canonical subject name, normalized subject key, total work count, and per-work author names, edition count, and cover ID
- Empty results carry a recovery notice suggesting a different word form, synonym, or broader term — subject tags are user-contributed and inconsistent

---

### `openlibrary_search_inside` <sub>tool</sub>

- Full-text search across Internet Archive's scanned book text — the only tool that answers "which book contains this passage?"; quote a phrase for an exact match, unquoted terms match independently
- Seconds-slow against the live index, an order of magnitude above the metadata tools — reach for it deliberately, not as a general book search
- 1–100 results per page (default 10), offset pagination; each result carries a relevance score comparable only within its own result set
- Results key on Internet Archive `ia_identifier`, not Open Library work IDs — match it against `ia_identifiers` from `openlibrary_search_books` to reach the catalogue record
- `content[]` text caps snippets at 3 per item; `structuredContent` carries every snippet

---

### `openlibrary_get_cover_url` <sub>tool</sub>

- Resolves a cover or author-photo URL from `id` (numeric), `isbn` (10 or 13 digits), or `olid` (OL…M for `target: "book"`, OL…A for `target: "author"`); `size` is `S`/`M`/`L` (default `M`)
- Identifiers are validated locally before any request — path separators, `..`, and control characters fail as `invalid_identifier`, and an author lookup by `isbn` fails as `invalid_target`
- The Covers API always returns HTTP 200 — a missing cover is a 1×1 placeholder GIF, not an error, which is why local validation exists
- Output URL is ready to embed directly as `![cover](url)`

---

### `openlibrary://works/{work_id}` <sub>resource</sub>

- Same fields as `openlibrary_get_work`, as injectable `application/json` context for a conversation about a specific book
- `work_id` comes from `openlibrary_search_books` or `openlibrary_get_author_works`

---

### `openlibrary://authors/{author_id}` <sub>resource</sub>

- Same fields as `openlibrary_get_author`, as injectable `application/json` context for a conversation about a specific author
- `author_id` comes from `openlibrary_search_authors`

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core): stdio and Streamable HTTP transports, pluggable auth (`none` / `jwt` / `oauth`), swappable storage (`in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`), structured logging with optional OpenTelemetry tracing.

Open Library-specific:

- Complete Open Library REST API coverage — Search, Search Inside (full-text), Books, Authors, Subjects, and Covers APIs, plus Internet Archive availability lookups
- Work → editions and author → works drill-down, with explicit OLID cross-links between tool outputs
- Configurable `User-Agent` header (`OPENLIBRARY_USER_AGENT`) identifying the server per Open Library's bot-blocking convention
- Batch edition resolution — up to 50 ISBN/OCLC/LCCN/OLID identifiers in one upstream call, with per-identifier partial-failure reporting

Agent-friendly output:

- Recovery guidance on every empty result — echoes the search criteria and suggests how to broaden a query or which offset to retry
- Merged-author disclosure — `openlibrary_get_author` and `openlibrary_get_author_works` surface the canonical ID via an enrichment notice when a requested ID was merged
- Per-item partial failure — `openlibrary_get_edition` returns resolved editions alongside typed `unresolved` reasons instead of failing the whole batch
- Text-output caps disclosed via enrichment notices (Internet Archive IDs, subjects, snippets) while `structuredContent` always carries the complete list

## Getting started

### Public Hosted Instance

A public instance is available at `https://openlibrary.caseyjhand.com/mcp` — no installation required. Point any MCP client at it via Streamable HTTP:

```json
{
  "mcpServers": {
    "openlibrary-mcp-server": {
      "type": "streamable-http",
      "url": "https://openlibrary.caseyjhand.com/mcp"
    }
  }
}
```

### Self-Hosted / Local

Add the following to your MCP client configuration file.

```json
{
  "mcpServers": {
    "openlibrary-mcp-server": {
      "type": "stdio",
      "command": "bunx",
      "args": ["@cyanheads/openlibrary-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info"
      }
    }
  }
}
```

Or with npx (no Bun required):

```json
{
  "mcpServers": {
    "openlibrary-mcp-server": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@cyanheads/openlibrary-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info"
      }
    }
  }
}
```

Or with Docker:

```json
{
  "mcpServers": {
    "openlibrary-mcp-server": {
      "type": "stdio",
      "command": "docker",
      "args": ["run", "-i", "--rm", "-e", "MCP_TRANSPORT_TYPE=stdio", "ghcr.io/cyanheads/openlibrary-mcp-server:latest"]
    }
  }
}
```

For Streamable HTTP, set the transport and start the server:

```sh
MCP_TRANSPORT_TYPE=http MCP_HTTP_PORT=3010 bun run start:http
# Server listens at http://localhost:3010/mcp
```

### Prerequisites

- [Bun v1.4.0](https://bun.sh/) or higher (or Node.js ≥ 24.0.0).
- No API key required — Open Library is a free, public API.

### Installation

1. **Clone the repository:**

```sh
git clone https://github.com/cyanheads/openlibrary-mcp-server.git
```

2. **Navigate into the directory:**

```sh
cd openlibrary-mcp-server
```

3. **Install dependencies:**

```sh
bun install
```

4. **Configure environment (optional):**

```sh
cp .env.example .env
# edit .env to override defaults — no required vars
```

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
| `OTEL_ENABLED` | Enable OpenTelemetry | `false` |

See [`.env.example`](./.env.example) for the full list of optional overrides.

## Running the server

### Local development

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
docker build -t openlibrary-mcp-server .
docker run --rm -p 3010:3010 openlibrary-mcp-server
```

The Dockerfile defaults to HTTP transport, stateless session mode, and logs to `/var/log/openlibrary-mcp-server`. OpenTelemetry peer dependencies are installed by default — build with `--build-arg OTEL_ENABLED=false` to omit them.

## Project structure

| Directory | Purpose |
|:---|:---|
| `src/index.ts` | `createApp()` entry point — registers tools and resources. |
| `src/config` | Server-specific environment variable parsing and validation with Zod. |
| `src/mcp-server/tools` | Tool definitions (`*.tool.ts`) — ten tools across Search, Books, Authors, Subjects, and Covers. |
| `src/mcp-server/resources` | Resource definitions (`*.resource.ts`) — Work and Author. |
| `src/services/open-library` | Open Library service layer — API client and domain types. |
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
