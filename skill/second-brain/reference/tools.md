# Tool reference

Notes are addressed by **title or slug** (slug = lowercase title with hyphens). Lookup ignores case. If nothing matches, the error suggests the closest title ("Did you mean ...?"), so confirm that suggestion before acting.

Safety column: **read** never changes anything; **write** adds or changes content without losing any; **destructive** can remove or overwrite content (recoverable ones say so).

## Find and read

| Tool | Arguments | Notes |
| --- | --- | --- |
| `search_notes` | `query`, `tag?`, `limit?` (default 10) | Splits the query into words and matches **any** of them; title hits score 5x body hits. Returns a snippet around the first word. Use two or three sharp keywords, not a sentence. Searches notes only, not the journal. read |
| `get_note` | `title` | Full body with tags and last-updated time. read |
| `list_notes` | `tag?`, `limit?` (default 50, max 200) | Most recently updated first, with word counts. Notes only. read |
| `find_related_notes` | `title`, `limit?` (default 5) | Ranks other notes by shared tags (2 pts each), direct links either way (3 pts), and shared vocabulary (up to 5). Says why. read |
| `get_backlinks` | `title` | Notes that contain `[[this title]]`. read |
| `list_tags` | none | Every tag with its note count. read |
| `get_stats` | none | Vault path and where it was chosen, note and word counts, journal streak, most-linked note, orphan count, top tags. Good first call. read |

## Create and change

| Tool | Arguments | Notes |
| --- | --- | --- |
| `create_note` | `title`, `body?`, `tags?` | Fails if a note with that title or slug exists. Reports detected `[[links]]` and todos. write |
| `create_note_from_template` | `template`, `title`, `fields?`, `tags?` | Fills `{{date}}`, `{{title}}` and any `fields`; missing fields become `_TBD_` and are listed. The template's own tags are added to yours. write |
| `list_templates` | none | Template ids, what each is for, and the fields each accepts. Includes custom templates from the vault's `templates/` folder. read |
| `update_note` | `title`, `body?`, `tags?`, `append?` | Without `append`, **`body` replaces the whole body**. With `append: true` it is added to the end. `tags` always **replaces** the full tag list, so include the existing ones. destructive when replacing |
| `rename_note` | `title`, `newTitle` | New title and slug; rewrites every `[[link]]` to the old title in all notes and journal entries. Fails if the new slug already exists. write |
| `merge_notes` | `from`, `into` | Appends `from`'s content to `into` under a "Merged from" heading, unions the tags, repoints links, trashes `from`. destructive (recoverable) |
| `delete_note` | `title` | Moves the note to `.trash/`. Doesn't erase it. destructive (recoverable) |
| `restore_note` | `title` | Brings back the most recently deleted match. If the slug is taken it comes back under a new slug. write |

## Journal and todos

| Tool | Arguments | Notes |
| --- | --- | --- |
| `journal_entry` | `text` | Appends `- **HH:MM** text` to today's journal, creating the file. Returns the day streak. write |
| `get_journal` | `date?` (YYYY-MM-DD), `days?` (default 7, max 90) | One day, or the last N calendar days oldest first. Malformed dates are rejected. read |
| `get_open_todos` | `tag?` | Every unchecked `- [ ]` in notes and journal, grouped by source. read |
| `complete_todo` | `todo`, `note?` | Ticks one todo matched by part of its text. If several match you get the list back instead (an exact text match wins). write |

## Links

| Tool | Arguments | Notes |
| --- | --- | --- |
| `suggest_links` | `title?`, `limit?` (default 20) | Plain-text mentions of another note's title with no link. Ignores titles under 4 characters and pairs already linked. read |
| `link_mentions` | `title`, `targets?` | Converts the first unlinked mention of each suggested title into `[[Title]]`, longest titles first. Never edits existing links. write |

## Backup

| Tool | Arguments | Notes |
| --- | --- | --- |
| `export_vault` | `outputPath?` | Writes every note and journal entry as JSON, always inside the vault folder (default `exports/vault-export-<date>.json`). Paths outside the vault or not ending in `.json` are refused. write |

## Prompts and resources

If the client surfaces them (Claude Code lists prompts as slash commands):

- Prompts: `weekly_review` (`days?`), `daily_plan`, `capture_meeting` (`title`, `notes`), `summarize_note` (`title`, autocompletes titles)
- Resources: `note://{slug}` for any note, `vault://stats`, `vault://graph` (nodes, edges and orphans as JSON)

## Built-in templates

`meeting`, `decision`, `project`, `reading`, `person`, `idea`, `how-to`, `weekly-review`. Run `list_templates` for each one's fields. Users can add their own as `templates/<id>.md` in the vault, with optional frontmatter (`name`, `description`, `tags`) and `{{field}}` placeholders.

## Note format

```markdown
---
title: My Note
tags:
  - example
created: '2026-10-19T09:00:00.000Z'
updated: '2026-10-19T09:00:00.000Z'
---

Body in markdown. Link with [[Another Note]]. Track work with:
- [ ] open task
- [x] finished task
```

Journal entries live in `journal/YYYY-MM-DD.md`. Deleted notes sit in `.trash/` as `<slug>--<timestamp>.md`.

## Gotchas

- Titles that differ only in punctuation or case share a slug, so `create_note` treats them as the same note.
- `[[Link]]` matching ignores case but needs the exact title otherwise. Links inside code blocks are still read as links.
- Search is keyword-based, not semantic. If a query returns nothing, try a synonym or a tag filter before concluding nothing exists.
- `search_notes` and `list_notes` don't include journal entries; use `get_journal` for those.
- Two assistants editing the same note at the same moment can overwrite each other; the server doesn't lock files.
