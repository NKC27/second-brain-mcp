# Changelog

## 1.1.0

**New tools** (22 in total, up from 11)
- `complete_todo`: tick a todo by part of its text, in any note or journal
- `create_note_from_template` and `list_templates`: eight built-in templates (meeting, decision, project, reading, person, idea, how-to, weekly-review) plus your own in `templates/`
- `get_journal`: read one day or the last N days
- `suggest_links` and `link_mentions`: find and apply unlinked mentions of other notes
- `rename_note`: retitle a note and rewrite every `[[link]]` to it
- `merge_notes`: fold a duplicate into the note you keep and repoint its links
- `find_related_notes` and `list_tags`
- `restore_note`: `delete_note` now moves notes to `.trash/` instead of erasing them

**Onboarding**
- `second-brain-mcp init` creates `~/SecondBrain` with starter notes and prints setup for Claude Code, Claude Desktop, Cursor and VS Code
- `second-brain-mcp doctor` checks Node, the vault, broken links and duplicate titles, then performs a live handshake with the server
- Vault location: `VAULT_PATH`, else `~/SecondBrain` if it exists, else the bundled demo vault

**Prompts and completion**
- New prompts `daily_plan` and `capture_meeting`
- Note titles and slugs autocomplete in `summarize_note` and `note://{slug}`

**Safety**
- Every tool carries read-only / write / destructive annotations
- `export_vault` only writes `.json` files inside the vault
- File names are checked at the storage layer so no tool argument or resource URI can reach outside the vault

**Agent skill**
- `skill/second-brain` is a SKILL.md package that teaches an agent how to use the tools well
- A checker verifies the skill against the live server: every tool and argument it names must exist, and every tool must be documented
- `npm run eval:skill` runs behavioural scenarios against a real Claude session, with and without the skill

**Project**
- 66 automated tests, Prettier, MIT licence

## 1.0.0

- First release: 11 tools, 3 resources, 2 prompts over a markdown vault
