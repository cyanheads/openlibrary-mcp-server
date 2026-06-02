# openlibrary-mcp-server - Directory Structure

Generated on: 2026-06-02 14:44:33

```text
openlibrary-mcp-server/
├── .claude-plugin/
│   └── plugin.json
├── .codex-plugin/
│   ├── mcp.json
│   └── plugin.json
├── .github/
│   └── ISSUE_TEMPLATE/
│       ├── bug_report.yml
│       ├── config.yml
│       └── feature_request.yml
├── .vscode/
│   ├── extensions.json
│   └── settings.json
├── changelog/
│   ├── 0.1.x/
│   └── template.md
├── docs/
│   ├── design.md
│   └── idea.md
├── scripts/
│   ├── build-changelog.ts
│   ├── build.ts
│   ├── check-docs-sync.ts
│   ├── check-framework-antipatterns.ts
│   ├── check-skill-versions.ts
│   ├── check-skills-sync.ts
│   ├── clean.ts
│   ├── devcheck.ts
│   ├── lint-mcp.ts
│   ├── lint-packaging.ts
│   ├── list-skills.ts
│   ├── release-github.ts
│   ├── split-changelog.ts
│   └── tree.ts
├── skills/
│   ├── add-app-tool/
│   │   └── SKILL.md
│   ├── add-prompt/
│   │   └── SKILL.md
│   ├── add-resource/
│   │   └── SKILL.md
│   ├── add-service/
│   │   └── SKILL.md
│   ├── add-test/
│   │   └── SKILL.md
│   ├── add-tool/
│   │   └── SKILL.md
│   ├── api-auth/
│   │   └── SKILL.md
│   ├── api-canvas/
│   │   └── SKILL.md
│   ├── api-config/
│   │   └── SKILL.md
│   ├── api-context/
│   │   └── SKILL.md
│   ├── api-errors/
│   │   └── SKILL.md
│   ├── api-linter/
│   │   └── SKILL.md
│   ├── api-mirror/
│   │   └── SKILL.md
│   ├── api-services/
│   │   ├── references/
│   │   │   ├── graph.md
│   │   │   ├── llm.md
│   │   │   └── speech.md
│   │   └── SKILL.md
│   ├── api-telemetry/
│   │   └── SKILL.md
│   ├── api-testing/
│   │   └── SKILL.md
│   ├── api-utils/
│   │   ├── references/
│   │   │   ├── formatting.md
│   │   │   ├── parsing.md
│   │   │   └── security.md
│   │   └── SKILL.md
│   ├── api-workers/
│   │   └── SKILL.md
│   ├── code-simplifier/
│   │   └── SKILL.md
│   ├── design-mcp-server/
│   │   └── SKILL.md
│   ├── field-test/
│   │   └── SKILL.md
│   ├── git-wrapup/
│   │   └── SKILL.md
│   ├── maintenance/
│   │   └── SKILL.md
│   ├── orchestrations/
│   │   ├── workflows/
│   │   │   ├── field-test-fix.md
│   │   │   ├── fix-wrapup-release.md
│   │   │   ├── greenfield-build.md
│   │   │   └── maintenance-release.md
│   │   └── SKILL.md
│   ├── polish-docs-meta/
│   │   ├── references/
│   │   │   ├── agent-protocol.md
│   │   │   ├── package-meta.md
│   │   │   ├── readme.md
│   │   │   └── server-json.md
│   │   └── SKILL.md
│   ├── release-and-publish/
│   │   └── SKILL.md
│   ├── report-issue-framework/
│   │   └── SKILL.md
│   ├── report-issue-local/
│   │   └── SKILL.md
│   ├── security-pass/
│   │   └── SKILL.md
│   ├── setup/
│   │   └── SKILL.md
│   └── tool-defs-analysis/
│       └── SKILL.md
├── src/
│   ├── config/
│   │   └── server-config.ts
│   ├── mcp-server/
│   │   ├── prompts/
│   │   │   └── definitions/
│   │   ├── resources/
│   │   │   └── definitions/
│   │   │       ├── openlibrary-author.resource.ts
│   │   │       └── openlibrary-work.resource.ts
│   │   └── tools/
│   │       └── definitions/
│   │           ├── openlibrary-get-author-works.tool.ts
│   │           ├── openlibrary-get-author.tool.ts
│   │           ├── openlibrary-get-cover-url.tool.ts
│   │           ├── openlibrary-get-edition.tool.ts
│   │           ├── openlibrary-get-editions.tool.ts
│   │           ├── openlibrary-get-subject.tool.ts
│   │           ├── openlibrary-get-work.tool.ts
│   │           ├── openlibrary-search-authors.tool.ts
│   │           └── openlibrary-search-books.tool.ts
│   ├── services/
│   │   └── open-library/
│   │       ├── open-library-service.ts
│   │       └── types.ts
│   └── index.ts
├── tests/
│   ├── prompts/
│   ├── resources/
│   │   ├── openlibrary-author.resource.test.ts
│   │   ├── openlibrary-resources-edge.test.ts
│   │   └── openlibrary-work.resource.test.ts
│   ├── security/
│   │   └── security.test.ts
│   └── tools/
│       ├── openlibrary-get-author-edge.tool.test.ts
│       ├── openlibrary-get-author-works-edge.tool.test.ts
│       ├── openlibrary-get-author-works.tool.test.ts
│       ├── openlibrary-get-author.tool.test.ts
│       ├── openlibrary-get-cover-url-edge.tool.test.ts
│       ├── openlibrary-get-cover-url.tool.test.ts
│       ├── openlibrary-get-edition-edge.tool.test.ts
│       ├── openlibrary-get-edition.tool.test.ts
│       ├── openlibrary-get-editions-edge.tool.test.ts
│       ├── openlibrary-get-editions.tool.test.ts
│       ├── openlibrary-get-subject-edge.tool.test.ts
│       ├── openlibrary-get-subject.tool.test.ts
│       ├── openlibrary-get-work-edge.tool.test.ts
│       ├── openlibrary-get-work.tool.test.ts
│       ├── openlibrary-search-authors-edge.tool.test.ts
│       ├── openlibrary-search-authors.tool.test.ts
│       ├── openlibrary-search-books-edge.tool.test.ts
│       └── openlibrary-search-books.tool.test.ts
├── .dockerignore
├── .env.example
├── .gitignore
├── .mcpbignore
├── AGENTS.md
├── biome.json
├── bun.lock
├── bunfig.toml
├── CHANGELOG.md
├── CITATION.cff
├── CLAUDE.md
├── devcheck.config.json
├── Dockerfile
├── LICENSE
├── manifest.json
├── package.json
├── README.md
├── server.json
├── tsconfig.build.json
├── tsconfig.json
└── vitest.config.ts
```

_Note: This tree excludes files and directories matched by .gitignore and default patterns._
