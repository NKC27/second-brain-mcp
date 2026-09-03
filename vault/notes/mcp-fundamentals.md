---
title: MCP Fundamentals
tags:
  - mcp
  - reference
created: '2026-09-01T09:05:00.000Z'
updated: '2026-09-01T09:05:00.000Z'
---

The Model Context Protocol is a JSON-RPC based standard for connecting an LLM client
to servers that expose three primitives:

- **Tools** — functions the model can call, with a JSON-schema-validated input.
- **Resources** — addressable data the client can read (files, DB rows, API responses).
- **Prompts** — reusable prompt templates the client can surface to the user.

A client (Claude Desktop, Claude Code, Cursor, VS Code) speaks the protocol over
stdio or HTTP to one or more servers, and merges their tools into the model's
available tool set for a session.

See [[Second Brain Architecture]] for how this vault server is put together, and
[[Client Setup Cheatsheet]] for wiring it into a specific client.

Todo:
- [ ] Read the July 2026 spec revision notes on the stateless transport model
- [ ] Try the official MCP Inspector against this server
- [x] Pick a first portfolio project to build
