---
title: Second Brain Architecture
tags:
  - mcp
  - architecture
  - project
created: '2026-09-02T14:00:00.000Z'
updated: '2026-09-02T14:00:00.000Z'
---

Notes and journal entries live as markdown files under `vault/`, each with YAML
frontmatter (`title`, `tags`, `created`, `updated`). The server itself never wraps
that data in a database — search, backlinks, and stats are all computed on the fly
by reading the files.

Four layers:

1. `vault.ts` — file I/O: load/save notes, slugify titles, fuzzy title matching,
   journal append-with-timestamp, soft delete to `.trash`, templates, safe renames.
   Every file name is checked so nothing can escape the vault folder.
2. `search.ts` — pure functions over an in-memory `Note[]`: ranked search, the
   wiki-link graph, link suggestions, related notes, and vault-wide stats.
3. `server.ts` — registers everything with `McpServer` from the TypeScript SDK:
   22 tools, 3 resources (`note://{slug}`, `vault://stats`, `vault://graph`), and
   4 prompts (`weekly_review`, `daily_plan`, `capture_meeting`, `summarize_note`).
4. `cli.ts` — `init` creates your own vault and prints setup for each client;
   `doctor` checks the setup and runs a live handshake against the server.

See [[MCP Fundamentals]] for the protocol background and [[Portfolio Ideas]] for
where this could go next.

- [ ] Add an HTTP/SSE transport option alongside stdio for remote deployment
- [ ] Swap the naive search for embeddings once the vault gets large
