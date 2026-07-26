<div align="center">
  <h1>@cyanheads/openlibrary-mcp-server</h1>
  <p><b>Search books and authors, fetch editions, browse subjects, and resolve cover images from Open Library via MCP. STDIO or Streamable HTTP.</b>
  <div>9 Tools • 2 Resources</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.1.20-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/openlibrary-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^1.29.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/openlibrary-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/openlibrary-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^6.0.3-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.3.0-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/openlibrary-mcp-server/releases/latest/download/openlibrary-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=openlibrary-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjeWFuaGVhZHMvb3BlbmxpYnJhcnktbWNwLXNlcnZlciJdfQ==) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22openlibrary-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40cyanheads%2Fopenlibrary-mcp-server%22%5D%7D)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

**Public Hosted Server:** [https://openlibrary.caseyjhand.com/mcp](https://openlibrary.caseyjhand.com/mcp)

</div>

---

## Tools

9 tools for working with Open Library's catalog of 20M+ books, editions, authors, and subjects:

| Tool | Description |
|:---|:---|
| `openlibrary_search_books` | Full-text book search with field filters (title, author, subject, publisher, ISBN, language), sort options, pagination, and optional live reading availability |
| `openlibrary_get_work` | Fetch a work by Open Library Work ID (OL…W) — title, description, subjects, cover IDs, and author IDs |
| `openlibrary_get_editions` | List editions of a work — publishers, languages, formats, ISBNs, and print run details |
| `openlibrary_get_edition` | Fetch a single edition by ISBN-10, ISBN-13, OCLC, LCCN, or Open Library Edition ID (OL…M) |
| `openlibrary_search_authors` | Search authors by name — returns Author IDs, birth/death dates, top works, and subject associations |
| `openlibrary_get_author` | Fetch author detail by Open Library Author ID (OL…A) — bio, dates, photo IDs, and linked identifiers from Wikidata, VIAF, ISNI, Goodreads, and LibraryThing |
| `openlibrary_get_author_works` | List works by an author — titles, cover IDs, and Work OLIDs for drilling into editions or details |
| `openlibrary_get_subject` | Browse works by subject tag — returns matching works with edition counts and cover IDs plus the total work count |
| `openlibrary_get_cover_url` | Resolve a cover image URL for a book or author photo in S/M/L size — returns a direct HTTPS URL embeddable in markdown |

### `openlibrary_search_books`

Full-text book search across Open Library works.

- Free-text query with Solr field prefixes: `title:`, `author:`, `subject:`, `publisher:`, `isbn:`, `language:`
- Dedicated filter parameters for title, author, subject, publisher, ISBN, and language
- Sort by relevance, newest, oldest, community rating, or edition count
- Pagination via offset for paging through large result sets
- Optional live reading availability from Internet Archive (borrow/browse/read status) — adds ~200ms latency; off by default
- Returns work-level records with edition counts, cover IDs, Internet Archive identifiers, and e-book access status

---

### `openlibrary_get_work`

Fetch a work by Open Library Work ID (OL…W).

- Title, description, subjects, cover IDs, and linked author IDs
- Works represent the abstract book concept independent of any specific edition
- Author names are not included — use `openlibrary_get_author` or `openlibrary_search_books` for names

---

### `openlibrary_get_editions`

List editions of a work — different publishers, languages, formats, and print runs.

- Returns ISBNs, publisher, language, page count, and edition OLIDs
- Pagination via offset
- Use after `openlibrary_get_work` or `openlibrary_search_books` to find a specific printing

---

### `openlibrary_get_edition`

Fetch a single edition by identifier.

- Accepts ISBN-10, ISBN-13, OCLC, LCCN, or Open Library Edition ID (OL…M)
- Pass `id_type "isbn"` for both ISBN-10 and ISBN-13
- Returns full edition metadata: authors, publisher, language, all identifier types, and the parent work ID

---

### `openlibrary_search_authors`

Search Open Library authors by name.

- Partial names and alternate names work
- Returns Open Library Author IDs, names, birth/death dates, top works, and subject associations
- Use author IDs for `openlibrary_get_author` (bio, remote IDs) or `openlibrary_get_author_works` (list of works)

---

### `openlibrary_get_author`

Fetch author detail by Open Library Author ID (OL…A).

- Bio, birth/death dates, photo IDs
- Linked external identifiers: Wikidata, VIAF, ISNI, Goodreads, and LibraryThing
- Use `openlibrary_search_authors` to find an author ID first

---

### `openlibrary_get_author_works`

List works by an author.

- Returns titles, cover IDs, and Work OLIDs for drilling into editions or details
- Use `openlibrary_get_author` for author bio and details, or `openlibrary_get_editions` to explore specific printings

---

### `openlibrary_get_subject`

Browse works by subject tag.

- Returns matching works with edition counts and cover IDs, plus the total work count for the subject
- Subjects are user-contributed and may be inconsistent ("science fiction", "Science fiction", "SF" are separate tags)
- Try lowercase forms first

---

### `openlibrary_get_cover_url`

Resolve a cover image URL for a book or author photo.

- Returns a direct HTTPS URL in the requested size (S/M/L)
- URLs can be embedded in markdown as `![cover](url)`
- The Covers API always returns HTTP 200 — missing covers return a 1×1 placeholder GIF, not a 404

## Resources

| Type | Name | Description |
|:---|:---|:---|
| Resource | `openlibrary://works/{work_id}` | Work detail by Open Library Work ID — title, description, subjects, cover IDs, and author IDs as injectable context |
| Resource | `openlibrary://authors/{author_id}` | Author detail by Open Library Author ID — name, bio, dates, photo IDs, and linked external identifiers as injectable context |

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core):

- Declarative tool definitions — single file per tool, framework handles registration and validation
- Unified error handling across all tools
- Pluggable auth (`none`, `jwt`, `oauth`)
- Swappable storage backends: `in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`
- Structured logging with optional OpenTelemetry tracing
- Runs locally (stdio/HTTP) or on Cloudflare Workers from the same codebase

Open Library-specific:

- Complete Open Library REST API integration — Search API, Books API, Authors API, Subjects API, Covers API
- Configurable `User-Agent` header for well-behaved bot identification per community convention
- Work → editions → edition drill-down pattern with explicit linking between OLIDs across tools
- Internet Archive availability lookup (opt-in) for borrow/read status on search results

Agent-friendly output:

- Explicit recovery hints on empty results — echoes search criteria and suggests how to broaden
- All OLID cross-links surfaced in responses so agents can chain tool calls without re-searching
- Cover URLs rendered as embeddable markdown image syntax

## Getting started

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

- [Bun v1.3.0](https://bun.sh/) or higher (or Node.js ≥ 24.0.0).
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

## Configuration

All configuration is validated at startup via Zod schemas in `src/config/server-config.ts`. Key environment variables:

| Variable | Description | Default |
|:---|:---|:---|
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http` | `stdio` |
| `MCP_HTTP_PORT` | HTTP server port | `3010` |
| `MCP_HTTP_ENDPOINT_PATH` | HTTP endpoint path where the MCP server is mounted | `/mcp` |
| `MCP_PUBLIC_URL` | Public origin override for TLS-terminating reverse-proxy deployments | none |
| `MCP_AUTH_MODE` | Authentication: `none`, `jwt`, or `oauth` | `none` |
| `MCP_LOG_LEVEL` | Log level (`debug`, `info`, `warning`, `error`, etc.) | `info` |
| `MCP_GC_PRESSURE_INTERVAL_MS` | Opt-in Bun-only forced-GC pressure loop (ms). Recommended starting point if heap growth is observed: `60000`. | `0` (disabled) |
| `LOGS_DIR` | Directory for log files (Node.js only) | `<project-root>/logs` |
| `STORAGE_PROVIDER_TYPE` | Storage backend: `in-memory`, `filesystem`, `supabase`, `cloudflare-kv/r2/d1` | `in-memory` |
| `OPENLIBRARY_USER_AGENT` | User-Agent sent with all Open Library API requests. Include a contact email per community convention. | `openlibrary-mcp-server/1.0 (openlibrary@archive.org)` |
| `OTEL_ENABLED` | Enable OpenTelemetry | `false` |

## Running the server

### Local development

- **Build and run the production version**:

  ```sh
  # One-time build
  bun run rebuild

  # Run the built server
  bun run start:http
  # or
  bun run start:stdio
  ```

- **Run checks and tests**:
  ```sh
  bun run devcheck  # Lints, formats, type-checks, and more
  bun run test      # Runs the test suite
  ```

## Project structure

| Directory | Purpose |
|:---|:---|
| `src/mcp-server/tools` | Tool definitions (`*.tool.ts`). Nine tools across Search, Books, Authors, Subjects, and Covers. |
| `src/mcp-server/resources` | Resource definitions. Work and Author resources. |
| `src/services/open-library` | Open Library service layer — API client and domain types. |
| `src/config` | Server-specific environment variable parsing and validation with Zod. |
| `tests/` | Unit and integration tests, mirroring the `src/` structure. |

## Development guide

See [`CLAUDE.md`](./CLAUDE.md) for development guidelines and architectural rules. The short version:

- Handlers throw, framework catches — no `try/catch` in tool logic
- Use `ctx.log` for logging, `ctx.state` for storage
- Register new tools and resources in the `createApp()` arrays

## Contributing

Issues and pull requests are welcome. Run checks and tests before submitting:

```sh
bun run devcheck
bun run test
```

## License

This project is licensed under the Apache 2.0 License. See the [LICENSE](./LICENSE) file for details.
