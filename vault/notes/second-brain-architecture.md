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

Three layers:

1. `vault.ts` — file I/O: load/save notes, slugify titles, fuzzy title matching,
   journal append-with-timestamp.
2. `search.ts` — pure functions over an in-memory `Note[]`: ranked search, the
   `[[wiki link]]` graph, and vault-wide stats (tag cloud, journal streak, orphans).
3. `index.ts` — registers everything with `McpServer` from the TypeScript SDK:
   9 tools, 3 resources (`note://{slug}`, `vault://stats`, `vault://graph`), and
   2 prompts (`weekly_review`, `summarize_note`).

See [[MCP Fundamentals]] for the protocol background and [[Portfolio Ideas]] for
where this could go next.

- [ ] Add an HTTP/SSE transport option alongside stdio for remote deployment
- [ ] Swap the naive search for embeddings once the vault gets large
