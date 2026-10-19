# Troubleshooting

Start with `npx -y second-brain-mcp doctor`. It checks most of what follows and ends with a live test of the server.

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| The assistant has no note tools | Server not registered, or the client wasn't restarted | Re-run the connect step in `setup.md`, restart the client. In Claude Code, `claude mcp list` should show `second-brain` as connected |
| `command not found: npx` or the server fails to start | Node.js isn't installed or is older than 18 | Install Node 18+ from nodejs.org, then restart the client. GUI apps sometimes don't see your shell's PATH; use the full path to `npx` or `node` in the config |
| Tools exist but notes land in a demo folder | No `~/SecondBrain` and no `VAULT_PATH` | Run `npx -y second-brain-mcp init`, restart the client, and check `get_stats` shows your vault |
| "Did you mean ...?" for a note you know exists | Title typo, or the note has no `title:` in its frontmatter (so its title is the filename) | Confirm the suggestion, or fix the title with `rename_note`. `doctor` lists notes missing a title |
| `create_note` says the note already exists | Same title, or a title that produces the same slug (`C++ Tips` and `C Tips`) | Use `update_note` with `append: true`, or choose a more distinct title |
| A `[[link]]` isn't recognised | The title doesn't match any note exactly (case is ignored, everything else counts) | Check the spelling with `search_notes`. `doctor` lists links that point nowhere |
| Search returns nothing for something you wrote | Keyword search, not semantic; or it's in the journal, which search skips | Try a synonym or fewer words; use `get_journal` for journal entries |
| `complete_todo` says several todos match | Your text is a fragment shared by more than one | Use more of the text, or pass `note` |
| A note disappeared | `delete_note` moved it to `.trash/` | `restore_note` with its title |
| Edits don't show up in the app you use to browse the folder | The app cached the old file | Refresh or reopen the folder; the server writes files immediately |
| Two machines show different notes | Each has its own vault folder | Put the vault in a synced folder and point `VAULT_PATH` at it. Avoid editing the same note on both at once |
| `export_vault` refuses a path | Exports must be `.json` files inside the vault | Omit `outputPath` for the default `exports/` location |

## Still stuck

Run the server by hand to see its logs:

```bash
DEBUG_MCP=1 npx -y second-brain-mcp
```

It waits for a client on stdin, so quit with Ctrl+C; debug lines go to stderr. When reporting an issue, include the output of `doctor` (it lists counts and a few note titles, never note bodies; remove any titles you'd rather not share) at https://github.com/NKC27/second-brain-mcp/issues.
