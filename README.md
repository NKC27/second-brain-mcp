# Second Brain MCP Server

A local, markdown-backed personal knowledge base exposed as an [MCP](https://modelcontextprotocol.io)
server. No database, no cloud account — every note is a plain `.md` file with YAML
frontmatter that you can also open, edit, and grep with normal tools. This project
exists as a portfolio piece: it shows a complete, working MCP server (tools +
resources + prompts) built against the current TypeScript SDK (`1.30.x`).

## Features

- **9 tools** — `create_note`, `get_note`, `update_note`, `delete_note`, `list_notes`,
  `search_notes`, `journal_entry`, `get_backlinks`, `get_open_todos`, `get_stats`,
  `export_vault`
- **`[[Wiki Link]]` backlinks** — link notes by writing `[[Note Title]]` anywhere in
  the body; `get_backlinks` and the `vault://graph` resource surface the connections
- **Todo tracking** — `- [ ] task` checkboxes in any note or journal entry are
  aggregated across the whole vault by `get_open_todos`
- **Daily journal with streaks** — `journal_entry` appends a timestamped line to
  today's journal note and reports your current consecutive-day streak
- **Ranked full-text search** — `search_notes` scores title matches above body
  matches and returns a highlighted snippet
- **Fuzzy "did you mean"** — typo a title and every tool that resolves a note by
  name suggests the closest match instead of just failing
- **Vault dashboard** — `get_stats` renders a tag cloud, word/note counts, journal
  streak, most-linked note, and orphan-note count as readable text
- **3 resources** — `note://{slug}` (every note, browsable), `vault://stats` (live
  JSON snapshot), `vault://graph` (JSON link graph for external visualization)
- **2 prompts** — `weekly_review` (summarizes recent journal + note activity) and
  `summarize_note` (summarize + suggest related topics for one note)
- **Portable data** — notes live in `vault/`, override the location with the
  `VAULT_PATH` env var; `export_vault` bundles everything to one JSON file

## Setup

```bash
npm install
npm run build
```

This compiles `src/` to `dist/index.js`. The server speaks MCP over stdio, so any
client runs it as a subprocess — there's nothing to host or deploy for local use.

### Claude Desktop

Add to `claude_desktop_config.json` (Settings → Developer → Edit Config):

```json
{
  "mcpServers": {
    "second-brain": {
      "command": "node",
      "args": ["/absolute/path/to/second-brain-mcp/dist/index.js"]
    }
  }
}
```

### Claude Code

```bash
claude mcp add second-brain -- node /absolute/path/to/second-brain-mcp/dist/index.js
```

Or drop the same `mcpServers` block above into a project-level `.mcp.json`.

### Cursor

Settings → MCP → Add new MCP server, using the same `command`/`args` shape as the
Claude Desktop config above.

### VS Code (GitHub Copilot)

Add to `.vscode/mcp.json` in your workspace:

```json
{
  "servers": {
    "second-brain": {
      "command": "node",
      "args": ["/absolute/path/to/second-brain-mcp/dist/index.js"]
    }
  }
}
```

Restart the client after adding the config. Ask it something like *"what are my
open todos?"* or *"search my notes for MCP"* — it already has 5 interlinked seed
notes and 3 days of journal entries to explore.

## Development

```bash
npm run dev       # tsx watch — runs src/index.ts directly, no build step
npm run inspect    # builds, then launches the official MCP Inspector against it
```

Set `DEBUG_MCP=1` to get timestamped debug logging on stderr (stdout is reserved
for JSON-RPC traffic, so all logging must go to stderr — the SDK doesn't enforce
this for you).

By default the vault lives at `vault/` next to this README. Point at a different
folder — your real notes, or a per-client sandbox — with:

```bash
VAULT_PATH=/path/to/my/vault node dist/index.js
```

## Project layout

```
src/
  vault.ts     file I/O: load/save notes, slugify, fuzzy title match, journal append
  search.ts    pure functions: ranked search, [[link]] graph, vault-wide stats
  util.ts      slugify, Levenshtein distance, word count, link/todo extraction
  logger.ts    stderr-only debug logging
  index.ts     registers tools/resources/prompts with McpServer, starts stdio transport
vault/
  notes/       one .md file per note
  journal/     one .md file per day, e.g. 2026-09-03.md
```

## Extending it

Some natural next steps, also tracked as todos inside the seed vault itself
(ask the server — `get_open_todos` will show you):

- Swap `search_notes`' term-frequency scoring for embeddings once a vault gets large
- Add an HTTP/SSE transport alongside stdio for a remotely-hosted, multi-client vault
- Add an `outputSchema` to tools like `get_stats` for structured (not just text) results
- Wire `vault://graph` into a small D3/force-graph viewer for a visual "second brain" map
