# Setup

The skill teaches the assistant how to work with your notes. The notes themselves are served by the open-source `second-brain-mcp` server (MIT), which runs on your machine and talks to your AI client over stdio. It makes no network calls and sends nothing anywhere.

Requires Node.js 18 or newer (`node -v`).

## 1. Create your own vault

```bash
npx -y second-brain-mcp init
```

This creates `~/SecondBrain` with two starter notes and an example template, then prints the exact connection commands for your machine. Prefer a different folder? `npx -y second-brain-mcp init --dir ~/Documents/notes`.

Everything is plain markdown, so you can open the folder in any editor, sync it, or put it in git.

## 2. Connect your AI client

Use whichever you have, then restart the client.

**Claude Code**

```bash
claude mcp add --scope user second-brain -- npx -y second-brain-mcp
```

**Claude Desktop** (`claude_desktop_config.json`) and **Cursor** (`.cursor/mcp.json`)

```json
{
  "mcpServers": {
    "second-brain": { "command": "npx", "args": ["-y", "second-brain-mcp"] }
  }
}
```

**VS Code / GitHub Copilot** (`.vscode/mcp.json`)

```json
{
  "servers": {
    "second-brain": { "command": "npx", "args": ["-y", "second-brain-mcp"] }
  }
}
```

A custom vault folder is not at `~/SecondBrain`? Add an environment variable: `claude mcp add --scope user second-brain -e VAULT_PATH=/path/to/vault -- npx -y second-brain-mcp`, or `"env": { "VAULT_PATH": "/path/to/vault" }` in the JSON configs.

## 3. Check it works

```bash
npx -y second-brain-mcp doctor
```

It checks Node, finds your vault, tests that it's writable, flags broken `[[links]]` and duplicate titles, and starts the server exactly as your AI client would to confirm the handshake. Then ask your assistant: *"Give me my vault stats."*

## Which vault does it use?

1. `VAULT_PATH`, if set
2. `~/SecondBrain`, if it exists
3. A small demo vault bundled with the package

`get_stats` always shows which one is active. If it says "bundled demo vault", you haven't run step 1 yet.

## Running from source instead

```bash
git clone https://github.com/NKC27/second-brain-mcp.git
cd second-brain-mcp
npm install && npm run build
node dist/index.js init
```

Then register `node /absolute/path/to/second-brain-mcp/dist/index.js` instead of the `npx` command.

## Updating and removing

- Update: `npx -y second-brain-mcp@latest doctor` fetches the newest version; the plain `npx -y second-brain-mcp` entry uses a cached copy until npx refreshes it.
- Remove the connection: `claude mcp remove second-brain`, or delete the entry from your client's config.
- Your notes stay in the vault folder. Deleting the server never touches them.
