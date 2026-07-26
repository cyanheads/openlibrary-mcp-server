# Changelog

All notable changes to this project. Each entry links to its full per-version file in [changelog/](changelog/).

## [0.1.20](changelog/0.1.x/0.1.20.md) — 2026-07-26

search_books and search_authors now report the true upstream match count on an over-paged empty page instead of 0; search_books structuredContent carries every subject tag instead of capping at 5; every declared error recovery hint now reaches the client; get_subject drops a dead not_found contract and its no-op case guidance.

## [0.1.19](changelog/0.1.x/0.1.19.md) — 2026-07-25

search_books no longer fails a whole page over an unclassified ebook_access tier; get_edition now returns real LCCN control numbers (was call numbers) plus a new lc_classifications field and work-level author fallback; search_books' language filter actually filters now, via Open Library's language= parameter and 3-letter MARC codes.

## [0.1.18](changelog/0.1.x/0.1.18.md) — 2026-07-13

Text output no longer silently drops data past its display cap — omitted subjects, top subjects, and Internet Archive identifiers are now disclosed via the enrichment trailer, and a stray literal queryEcho no longer leaks into search_books text.

## [0.1.17](changelog/0.1.x/0.1.17.md) — 2026-07-13 · 🛡️ Security

Cover-URL path-traversal identifiers now rejected locally; upstream 404s normalized instead of leaking raw fetch errors; OCLC identifiers validated before lookup; mcp-ts-core ^0.10.14 adoption with Bun supply-chain hardening.

## [0.1.16](changelog/0.1.x/0.1.16.md) — 2026-06-20

Adopt mcp-ts-core ^0.10.9: check-dependency-specifiers devcheck step, plugin-manifest packaging lint, fresh-scaffold devcheck guards, and re-synced framework skills.

## [0.1.15](changelog/0.1.x/0.1.15.md) — 2026-06-15

Run the release:github script under bun instead of tsx, which is not an installed dependency.

## [0.1.14](changelog/0.1.x/0.1.14.md) — 2026-06-15

Server-level instructions sent on initialize, plus unscoped agent-facing display identity in the Claude Code and Codex plugin manifests.

## [0.1.13](changelog/0.1.x/0.1.13.md) — 2026-06-12

Adopt mcp-ts-core ^0.10.6: totalCount enrichment across the five paginated tools, explicit server identity, Docker healthcheck, and a post-pack MCPB bundle cleaner.

## [0.1.12](changelog/0.1.x/0.1.12.md) — 2026-06-04

not-found errors now route through ctx.fail so data.reason is populated; getAuthorWorks 404 detection fixed

## [0.1.11](changelog/0.1.x/0.1.11.md) — 2026-06-02

mcp-ts-core ^0.9.16 → ^0.9.21 — per-request log context fix, secret scrubbing in fetchWithTimeout, withRetry fail-fast on non-retryable errors; new scripts and skills synced

## [0.1.10](changelog/0.1.x/0.1.10.md) — 2026-05-30

Enrichment adoption on search tools — query echo, result totals, and empty-result guidance now surface in a typed enrichment block; removed dead no_results error contract from search_books and search_authors

## [0.1.9](changelog/0.1.x/0.1.9.md) — 2026-05-28

@cyanheads/mcp-ts-core ^0.9.9 → ^0.9.13: HTTP body cap (413 guard), session-init gate, quieter 401/403/400/404 logging, GET /mcp surfaces package keywords; dep refresh

## [0.1.8](changelog/0.1.x/0.1.8.md) — 2026-05-26

Bug fix: default User-Agent changed from bot-style name/version format to plain string — Open Library was returning 403 for the old format

## [0.1.7](changelog/0.1.x/0.1.7.md) — 2026-05-24

Bug fix: removed error masking in work/author resource handlers; parallelized author lookups; mcp-ts-core ^0.9.7 → ^0.9.9; invalid_identifier error code corrected to ValidationError

## [0.1.6](changelog/0.1.x/0.1.6.md) — 2026-05-24

openlibrary_get_subject: remove ebooks_only filter (upstream ignores it), add empty-result guidance when work_count is 0

## [0.1.5](changelog/0.1.x/0.1.5.md) — 2026-05-23

Add hosted server endpoint metadata — remotes block in server.json and public URL in README

## [0.1.4](changelog/0.1.x/0.1.4.md) — 2026-05-23

Metadata alignment — package.json scripts/fields, Dockerfile LABEL, manifest.json fields, server.json env vars, .env.example restructured, .gitignore/.mcpbignore aligned, docs/tree.md

## [0.1.3](changelog/0.1.x/0.1.3.md) — 2026-05-23

Tagline sync — description updated across package.json, server.json, manifest.json, README, and GitHub repository

## [0.1.2](changelog/0.1.x/0.1.2.md) — 2026-05-23

Metadata polish — server.json name, runtimeHint, Dockerfile OCI labels, package.json fields, bunfig.toml

## [0.1.1](changelog/0.1.x/0.1.1.md) — 2026-05-23

Post-launch patch — full Open Library implementation: 9 tools, 2 resources, 11 test files, agent-facing docs and audit

## [0.1.0](changelog/0.1.x/0.1.0.md) — 2026-05-23

Initial release — 9 tools and 2 resources for Open Library book search, editions, authors, subjects, and cover images
