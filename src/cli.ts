import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import matter from "gray-matter";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { defaultHomeVault, describeSource, resolveVault } from "./config.js";
import { Vault } from "./vault.js";
import { extractLinks } from "./util.js";
import { VERSION } from "./version.js";

const HELP = `second-brain-mcp ${VERSION}
A markdown-backed personal knowledge base for AI agents, served over MCP.

Usage:
  second-brain-mcp                 Start the MCP server on stdio (what your AI client runs)
  second-brain-mcp init [--dir D]  Create your own vault (default: ~/SecondBrain) and print setup steps
  second-brain-mcp doctor          Check your setup and run a live handshake against the server
  second-brain-mcp --version       Print the version

Environment:
  VAULT_PATH   Use this folder as the vault (overrides ~/SecondBrain and the demo vault)
  DEBUG_MCP=1  Log debug output to stderr
`;

const entryPath = fileURLToPath(new URL("./index.js", import.meta.url));

/** Handle CLI subcommands. Returns an exit code, or null when the server should start. */
export async function runCli(args: string[]): Promise<number | null> {
  const [command, ...rest] = args;
  switch (command) {
    case undefined:
    case "serve":
    case "--stdio":
      return null;
    case "-h":
    case "--help":
    case "help":
      console.log(HELP);
      return 0;
    case "-v":
    case "--version":
    case "version":
      console.log(VERSION);
      return 0;
    case "init":
      return init(rest);
    case "doctor":
      return doctor();
    default:
      console.error(`Unknown command "${command}".\n\n${HELP}`);
      return 2;
  }
}

// ---------------------------------------------------------------------------
// init
// ---------------------------------------------------------------------------

const START_HERE = `---
title: Start Here
tags:
  - meta
---

Welcome to your second brain. Everything here is a plain markdown file you own.
Open this folder in any editor and you will see exactly what your AI assistant sees.

How it works:

- **Notes** live in \`notes/\`. Ask your assistant to capture something and it creates one.
- **Links**: write the exact title of another note in double square brackets, like [[Vault Conventions]],
  and the two notes become connected. Ask "what links here?" to follow the connections.
- **Todos**: write \`- [ ] task\` in any note. Ask "what's still open?" to collect them all.
- **Journal**: say "log that I finished the report" and it lands in today's journal with a timestamp.
- **Templates**: try "start a meeting note called Roadmap sync". Add your own in \`templates/\`.

Things to try first:

- "Search my notes for conventions"
- "Give me my vault stats"
- "Plan my day"

- [ ] Delete this note once you are comfortable
`;

const CONVENTIONS = `---
title: Vault Conventions
tags:
  - meta
---

A few habits that keep a vault useful:

1. One idea per note, with a specific title. Titles are how notes get linked.
2. Search before creating, so you extend notes instead of duplicating them.
3. Link generously. The connections are the point. See [[Start Here]] for the basics.
4. Keep tags few and reusable. Two or three per note is plenty.
5. Review weekly. Ask your assistant for a weekly review and save it as a note.
`;

const SAMPLE_TEMPLATE = `---
name: One-on-one
description: Agenda and follow-ups for a recurring one-on-one.
tags:
  - one-on-one
---

**With:** {{person}}
**Date:** {{date}}

## Their updates

## My updates

## Feedback

## Action items
- [ ]
`;

function setupInstructions(vaultDir: string, isDefaultLocation: boolean): string {
  const viaNpx = entryPath.includes(`${path.sep}_npx${path.sep}`);
  const command = viaNpx ? "npx" : "node";
  const argList = viaNpx ? ["-y", "second-brain-mcp"] : [entryPath];
  const server = { command, args: argList, ...(isDefaultLocation ? {} : { env: { VAULT_PATH: vaultDir } }) };
  const claudeCodeEnv = isDefaultLocation ? "" : ` -e VAULT_PATH=${JSON.stringify(vaultDir)}`;
  const block = (value: unknown) =>
    JSON.stringify(value, null, 2)
      .split("\n")
      .map((line) => `    ${line}`)
      .join("\n");

  return [
    "Connect it to your AI client (then restart the client):",
    "",
    "  Claude Code",
    `    claude mcp add --scope user second-brain${claudeCodeEnv} -- ${command} ${argList.join(" ")}`,
    "",
    "  Claude Desktop (claude_desktop_config.json) and Cursor (.cursor/mcp.json)",
    block({ mcpServers: { "second-brain": server } }),
    "",
    "  VS Code (.vscode/mcp.json)",
    block({ servers: { "second-brain": server } }),
    "",
  ].join("\n");
}

async function init(args: string[]): Promise<number> {
  const dirFlag = args.indexOf("--dir");
  const customDir = dirFlag >= 0 ? args[dirFlag + 1] : undefined;
  if (dirFlag >= 0 && !customDir) {
    console.error("--dir needs a folder path.");
    return 2;
  }
  const dir = path.resolve(customDir ?? defaultHomeVault());
  const isDefault = !customDir || dir === defaultHomeVault();

  const exists = await fs
    .stat(path.join(dir, "notes"))
    .then((s) => s.isDirectory())
    .catch(() => false);

  if (exists) {
    console.log(`A vault already exists at ${dir}. Leaving it untouched.\n`);
  } else {
    await fs.mkdir(path.join(dir, "notes"), { recursive: true });
    await fs.mkdir(path.join(dir, "journal"), { recursive: true });
    await fs.mkdir(path.join(dir, "templates"), { recursive: true });
    const now = new Date().toISOString();
    const stamp = (text: string) => text.replace(/^---\n/, `---\ncreated: '${now}'\nupdated: '${now}'\n`);
    await fs.writeFile(path.join(dir, "notes", "start-here.md"), stamp(START_HERE), "utf-8");
    await fs.writeFile(path.join(dir, "notes", "vault-conventions.md"), stamp(CONVENTIONS), "utf-8");
    await fs.writeFile(path.join(dir, "templates", "one-on-one.md"), SAMPLE_TEMPLATE, "utf-8");
    console.log(`Created your vault at ${dir}\n`);
  }

  console.log(setupInstructions(dir, isDefault));
  if (isDefault) {
    console.log("Your vault is at the default location, so no VAULT_PATH setting is needed.");
  }
  console.log("Check everything with:  second-brain-mcp doctor");
  return 0;
}

// ---------------------------------------------------------------------------
// doctor
// ---------------------------------------------------------------------------

type Level = "ok" | "warn" | "fail";

async function doctor(): Promise<number> {
  const results: { level: Level; text: string }[] = [];
  const report = (level: Level, text: string) => results.push({ level, text });

  const major = Number.parseInt(process.versions.node.split(".")[0]!, 10);
  report(
    major >= 18 ? "ok" : "fail",
    `Node.js ${process.versions.node}${major >= 18 ? "" : " (version 18 or newer is required)"}`
  );

  const location = resolveVault();
  report("ok", `Vault: ${location.path} (${describeSource(location.source)})`);
  if (location.source === "demo") {
    report("warn", "You are using the demo vault. Run `second-brain-mcp init` to create your own.");
  }

  const vault = new Vault(location.path);
  const notesDirExists = await fs
    .stat(path.join(location.path, "notes"))
    .then((s) => s.isDirectory())
    .catch(() => false);
  if (!notesDirExists) {
    report("warn", "No notes/ folder yet. It will be created the first time the server starts.");
  } else {
    try {
      const probe = path.join(location.path, ".doctor-write-test");
      await fs.writeFile(probe, "ok");
      await fs.unlink(probe);
      report("ok", "The vault folder is writable");
    } catch {
      report("fail", "The vault folder is not writable, so notes cannot be saved");
    }

    const notes = await vault.loadAll();
    const journalDays = (await vault.listJournalDates()).length;
    const customTemplates = (await vault.listTemplates()).filter((t) => t.source === "custom").length;
    report("ok", `${notes.length} note(s), ${journalDays} journal day(s), ${customTemplates} custom template(s)`);

    const missingTitle: string[] = [];
    for (const slug of await vault.listSlugs()) {
      const raw = await fs.readFile(path.join(location.path, "notes", `${slug}.md`), "utf-8");
      if (typeof matter(raw).data.title !== "string") missingTitle.push(slug);
    }
    if (missingTitle.length) {
      report(
        "warn",
        `${missingTitle.length} note(s) have no title in their frontmatter (the filename is used instead): ${missingTitle.slice(0, 3).join(", ")}`
      );
    }

    const byTitle = new Map<string, number>();
    for (const n of notes) byTitle.set(n.title.toLowerCase(), (byTitle.get(n.title.toLowerCase()) ?? 0) + 1);
    const duplicates = [...byTitle].filter(([, count]) => count > 1).map(([title]) => title);
    if (duplicates.length)
      report("warn", `Duplicate note titles make links ambiguous: ${duplicates.slice(0, 3).join(", ")}`);

    const broken = new Set<string>();
    for (const n of notes) {
      for (const link of extractLinks(n.body)) {
        if (!byTitle.has(link.toLowerCase())) broken.add(link);
      }
    }
    if (broken.size) {
      report(
        "warn",
        `${broken.size} link(s) point at notes that do not exist: ${[...broken]
          .slice(0, 3)
          .map((l) => `[[${l}]]`)
          .join(", ")}`
      );
    } else if (notes.length) {
      report("ok", "All [[links]] resolve to a note");
    }
  }

  // Live handshake: start the server exactly as an AI client would and ask it a question.
  let client: Client | undefined;
  try {
    const env = Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== undefined)) as Record<
      string,
      string
    >;
    env.VAULT_PATH = location.path;
    client = new Client({ name: "second-brain-doctor", version: VERSION });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [entryPath], env }));
    const { tools } = await client.listTools();
    const stats = await client.callTool({ name: "get_stats", arguments: {} });
    report(stats.isError ? "fail" : "ok", `Server handshake succeeded: ${tools.length} tools available`);
  } catch (err) {
    report("fail", `Server handshake failed: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    await client?.close().catch(() => undefined);
  }

  const label: Record<Level, string> = { ok: "[ok]  ", warn: "[warn]", fail: "[FAIL]" };
  console.log(`second-brain-mcp ${VERSION}\n`);
  for (const r of results) console.log(`${label[r.level]} ${r.text}`);
  const failed = results.some((r) => r.level === "fail");
  console.log(failed ? "\nSome checks failed." : "\nEverything needed to run looks good.");
  return failed ? 1 : 0;
}
