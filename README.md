# Second Brain MCP

A local-first second brain for AI agents. Your notes, journal and todos live as plain markdown files in a folder you own, and any [MCP](https://modelcontextprotocol.io) client (Claude Code, Claude Desktop, Cursor, VS Code) can search, write and connect them.

No database. No cloud account. No network calls. Open the folder in any editor and see exactly what your assistant sees.

An illustrative session:

```text
You:       Remember that pgbouncer in transaction mode breaks prepared statements.
Assistant: Added to "Postgres connection pooling" under today's date. It's related to
           "Production incidents", which also mentions pgbouncer. Link them?

You:       What's still open?
Assistant: 6 open todos. The three that matter today: ...

You:       Mark the budget email done.
Assistant: Checked off "email Sam about budget" in "Errands".
```

## Quick start

Requires Node.js 18 or newer.

```bash
npx -y second-brain-mcp init
```

This creates `~/SecondBrain` with a couple of starter notes and prints the exact connection command for your machine. For Claude Code:

```bash
claude mcp add --scope user second-brain -- npx -y second-brain-mcp
```

`init` also prints the config for Claude Desktop, Cursor and VS Code. Restart your client, then try *"give me my vault stats"* or *"start a meeting note called Roadmap sync"*.

Something not working? `npx -y second-brain-mcp doctor` checks Node, your vault, broken links and duplicate titles, then starts the server the way your client would and confirms the handshake.

## What it can do

**22 tools**, grouped by what you're doing:

| | Tools |
| --- | --- |
| Capture | `create_note`, `create_note_from_template`, `list_templates`, `update_note`, `journal_entry` |
| Find | `search_notes`, `get_note`, `list_notes`, `find_related_notes`, `get_backlinks`, `list_tags`, `get_journal` |
| Todos | `get_open_todos`, `complete_todo` |
| Connect | `suggest_links`, `link_mentions`, `rename_note`, `merge_notes` |
| Safety net | `delete_note` (moves to `.trash`), `restore_note`, `export_vault` |
| Overview | `get_stats` |

Highlights:

- **`[[Wiki links]]` and backlinks.** Link notes by writing an exact title in double brackets. `rename_note` rewrites every link for you, and `merge_notes` repoints links when you fold a duplicate into another note.
- **Link suggestions.** `suggest_links` finds places where one note mentions another's title without linking it; `link_mentions` applies them, longest titles first, never touching existing links.
- **Templates.** Eight built-in (meeting, decision, project, reading, person, idea, how-to, weekly-review). Add your own as `templates/<id>.md` in the vault with `{{field}}` placeholders.
- **Todos anywhere.** `- [ ] task` in any note or journal entry is collected by `get_open_todos` and ticked by `complete_todo`.
- **Journal with streaks.** `journal_entry` timestamps a line into today's file.
- **Typo-proof.** Misspell a title and you get "Did you mean ...?" instead of a dead end.
- **Recoverable deletes.** Deleted notes go to `.trash/`; `restore_note` brings them back.

Plus 3 resources (`note://{slug}`, `vault://stats`, `vault://graph`) and 4 prompts (`weekly_review`, `daily_plan`, `capture_meeting`, `summarize_note`) with autocomplete for note titles.

## Your vault

```text
~/SecondBrain/
  notes/       one .md file per note, with YAML frontmatter
  journal/     one file per day, e.g. 2026-10-19.md
  templates/   optional custom templates
  .trash/      deleted notes, restorable
  exports/     JSON backups from export_vault
```

The server picks the vault in this order: the `VAULT_PATH` environment variable, then `~/SecondBrain` if it exists, then a small bundled demo vault. `get_stats` always tells you which one is active.

## Safety and privacy

- **Local only.** The server makes no network requests and sends nothing anywhere.
- **Annotated tools.** Every tool is marked read-only, write or destructive so clients can skip approval prompts for reads and ask before deletes.
- **Contained.** File names are validated at the storage layer, so no tool argument or resource URI can read or write outside the vault, and `export_vault` only writes `.json` files inside it.
- **Recoverable.** Nothing is erased by `delete_note` or `merge_notes`; both move notes to `.trash/`.
- **No locking.** Two assistants editing the same note at once can overwrite each other.

## Agent skill

The tools are only half of it: an agent also needs to know *when* to use them. [`skill/second-brain/`](skill/second-brain) is a `SKILL.md` package that teaches an agent to search before it creates, link with exact titles, write absolute dates, never invent links or quotes, and confirm before destructive changes. Copy the folder into your agent's skills directory, or build the zip with `npm run package-skill`.

Because instructions can drift from code, a test checks the skill against the live server: every tool and argument it names must exist, and every tool must be documented with exactly its real arguments.

`npm run eval:skill` goes further and runs seven behavioural scenarios (extend instead of duplicating, admit when nothing is recorded, ask before ticking an ambiguous todo, confirm before deleting, and so on) against a real Claude session, with and without the skill. It needs the `claude` CLI logged in.

## Development

```bash
git clone https://github.com/NKC27/second-brain-mcp.git
cd second-brain-mcp
npm install
npm test            # builds, then runs 66 tests
npm run dev         # run the server from source (tsx watch)
npm run inspect     # open the official MCP Inspector against the built server
npm run format      # Prettier
```

The tests cover the pure logic, the storage layer (including path containment), the CLI, and end-to-end sessions that spawn the built server and drive it through the official MCP client. Set `DEBUG_MCP=1` for debug logging on stderr (stdout is reserved for the protocol).

```text
src/
  index.ts       entry point: CLI command or MCP server on stdio
  server.ts      tools, resources and prompts
  vault.ts       file storage: notes, journal, templates, trash
  search.ts      ranking, link graph, link suggestions, related notes, stats
  templates.ts   built-in templates and rendering
  cli.ts         init and doctor
  config.ts      which vault to use
skill/
  second-brain/  the agent skill (SKILL.md plus reference guides)
  evals/         behavioural scenarios and graders for the skill
test/            unit, CLI, end-to-end and skill-lint tests
vault/           small demo vault used when you haven't run init
```

## Roadmap

- Streamable HTTP transport with authentication, for a shared hosted vault
- Semantic search with embeddings for large vaults
- Importers for Obsidian and Notion exports
- A confirm-before-delete prompt from inside the server, using MCP elicitation

## Licence

MIT. See [LICENSE](LICENSE).
