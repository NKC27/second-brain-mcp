---
name: second-brain
description: Personal knowledge base and journal stored as plain markdown on the user's own machine, used through the second-brain MCP server. Use whenever the user wants to remember, save, capture, log, jot down, look up, find, link, review or organize notes, ideas, meeting notes, decisions, projects, reading notes, contacts, todos or journal entries, or asks things like "what do I know about X", "what did we decide", "what's still open", "plan my day" or "weekly review". Not for editing code files or the user's ordinary documents.
---

# Second Brain

You have access to the user's long-term memory: plain markdown notes and a daily journal on their own machine, reached through the `second-brain` MCP server. Nothing leaves their computer. Make capturing, finding and connecting knowledge effortless, and be trustworthy about what is and isn't in their notes.

## Before the first note task in a conversation

1. **Check the tools exist.** Look for `search_notes`, `create_note` and friends (clients may prefix them, e.g. `mcp__second-brain__search_notes`). If they are missing, do not pretend to save anything. Say the server isn't connected and walk the user through `reference/setup.md`; `npx -y second-brain-mcp doctor` diagnoses most problems.
2. **Orient once with `get_stats`.** It shows where the vault lives, how big it is and the top tags.
   - If it says *the bundled demo vault* and the user is saving real content, tell them once that notes are going into the demo folder and offer to set up their own (`reference/setup.md`, step 1).
   - If the vault is empty, welcome them and offer a first note instead of searching.

## Choose the move

| The user says (or implies) | Do this |
| --- | --- |
| "remember / save / note that ...", pastes info to keep | `search_notes` first, then extend a match with `update_note` (`append: true`) or `create_note` |
| "log / jot / add to today", a status update | `journal_entry` |
| "what do I know about X", "find my notes on ..." | `search_notes`, then `get_note` on the best 1-3 hits. Answer from the notes and name them |
| "what's open", "what's on my plate" | `get_open_todos`, plus `get_journal` for context |
| "mark ... done", "I finished ..." | `complete_todo`. Never rewrite a note just to tick a box |
| meeting notes, a decision, a project, a book, a person | `list_templates`, then `create_note_from_template` |
| "how are these connected", "what links here" | `find_related_notes`, `get_backlinks` |
| "tidy up", "what's disconnected" | `get_stats` (orphans), `suggest_links`, then `link_mentions` after approval |
| "rename that note" | `rename_note`. It rewrites every link for you |
| "I deleted the wrong thing" | `restore_note` |

All tools, their arguments and gotchas are in `reference/tools.md`.

## How to write notes that stay useful

1. **Search before you create.** Duplicates are the main way a vault rots. Try 2-3 distinctive keywords (search matches any term and ranks title hits higher), plus a tag filter if you know it. Extend an existing note with `update_note` and `append: true` rather than starting a near-copy.
2. **Specific titles, one idea per note.** "Postgres connection pooling" beats "Notes". If the body covers two topics, make two notes. Titles are the handles other notes link to.
3. **Absolute dates.** Notes outlive the conversation, so write `2026-10-23`, never "next Friday" or "tomorrow". If you don't know today's date, ask or read it from the latest journal entry.
4. **Link with `[[Exact Title]]`.** Only link to notes you have confirmed exist (search first) and never invent a link. After creating a note, `find_related_notes` shows what it should connect to.
5. **Reuse tags.** Run `list_tags` before inventing one. One to three per note, lowercase.
6. **Todos are `- [ ]` lines**, one per line, with an owner and a due date when known. They are what `get_open_todos` collects.
7. **Record what the user said, not your gloss.** Keep their facts and wording. Mark anything you inferred as inferred. Don't pad.
8. **Structured notes start from a template** (`list_templates`, `create_note_from_template`). Unfilled fields show as `_TBD_`, which is honest; fill them later or leave them.

## Be trustworthy

- **Say only what the tools confirmed.** Report a save only after the tool succeeded. Pass errors on plainly.
- **Separate their notes from your knowledge.** If a search finds nothing, say "nothing in your notes about that", then offer general help clearly labelled as general.
- **Confirm before anything destructive:** `delete_note` and `merge_notes` (both recoverable with `restore_note`, but still confirm), `update_note` that replaces an existing note's body (show what will change), and any batch of more than a few edits. Appending, journaling, ticking a todo and linking mentions don't need confirmation.
- **"Did you mean ...?"** from a tool means the title wasn't found. Confirm the suggestion before acting on a different note.
- **Keep secrets out.** Don't store passwords, API keys or card numbers in plain-text notes; suggest a password manager. The user can still insist.
- **Stay in scope.** Read only what the question needs, and don't surface unrelated personal notes. Don't copy vault contents to other tools or messages unless asked.

## How to reply

- Short. After a write: one line, e.g. *Saved **Postgres connection pooling** (database, how-to), linked to Connection limits.* Add at most one useful follow-up offer.
- When answering from notes, lead with the answer, then *From: **Note A**, **Note B***.
- Quote the relevant lines rather than pasting whole notes. Use lists for todos.
- Don't narrate tool calls or list the tools you used.

## Scale

For a vault of hundreds of notes, never list everything. Search with keywords and a `limit`, use `get_journal` with `days` for time windows, and `find_related_notes` to navigate. Titles from tool output are the handles for every follow-up call.

## Files in this skill

- `reference/tools.md` every tool, its arguments and gotchas
- `reference/setup.md` install, connect, your own vault
- `reference/troubleshooting.md` when something doesn't work
