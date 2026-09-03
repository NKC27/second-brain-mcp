---
title: Client Setup Cheatsheet
tags:
  - mcp
  - howto
created: '2026-09-02T15:30:00.000Z'
updated: '2026-09-02T15:30:00.000Z'
---

Quick reference for wiring this server into each client. Full snippets are in the
project README, this is just the shape of each config.

**Claude Desktop** — `claude_desktop_config.json`, under `mcpServers`, points at the
built `dist/index.js` with `node`.

**Claude Code** — `claude mcp add` from the CLI, or a project-level `.mcp.json`.

**Cursor** — Settings → MCP → Add new MCP server, same `command` + `args` shape as
Claude Desktop.

**VS Code (Copilot)** — `.vscode/mcp.json` in the workspace, or the `MCP: Add Server`
command from the palette.

All of them boil down to: run `node dist/index.js` as a subprocess and talk stdio.
See [[MCP Fundamentals]] for why that's the default transport.
