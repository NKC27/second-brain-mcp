import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import matter from "gray-matter";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { BUILT_IN_TEMPLATES } from "../src/templates.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(here, "..");
/** The public skill, plus any others named in SKILL_DIRS (colon-separated), e.g. the private Pro skill. */
const skillDirs = [
  path.join(projectRoot, "skill", "second-brain"),
  ...(process.env.SKILL_DIRS ?? "")
    .split(":")
    .filter(Boolean)
    .map((d) => path.resolve(d)),
];

let client: Client;
let vaultDir: string;
let toolSchemas: Map<string, Set<string>>;
let promptNames: Set<string>;

async function markdownFiles(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = await Promise.all(
    entries.map((e) => (e.isDirectory() ? markdownFiles(path.join(dir, e.name)) : [path.join(dir, e.name)]))
  );
  return files.flat().filter((f) => f.endsWith(".md"));
}

/** Names of keys at the top level of a call's argument text, ignoring nested objects and quoted strings. */
function topLevelKeys(args: string): string[] {
  const keys: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let token = "";
  for (let i = 0; i < args.length; i++) {
    const c = args[i]!;
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      token = "";
    } else if ("{[(<".includes(c)) {
      depth++;
      token = "";
    } else if ("}])>".includes(c)) {
      depth--;
      token = "";
    } else if (c === ":" && depth === 0 && /^[A-Za-z]\w*$/.test(token)) {
      keys.push(token);
      token = "";
    } else if (/\w/.test(c)) {
      token += c;
    } else {
      token = "";
    }
  }
  return keys;
}

/** Every `tool_name(...)` call in some markdown, with the keys passed to it. */
function findCalls(text: string): { name: string; keys: string[] }[] {
  const calls: { name: string; keys: string[] }[] = [];
  const start = /`?([a-z]+(?:_[a-z]+)+)\(/g;
  let m: RegExpExecArray | null;
  while ((m = start.exec(text))) {
    let depth = 1;
    let quote: string | null = null;
    let i = start.lastIndex;
    for (; i < text.length && depth > 0; i++) {
      const c = text[i]!;
      if (quote) {
        if (c === "\\") i++;
        else if (c === quote) quote = null;
      } else if (c === '"' || c === "'") quote = c;
      else if (c === "(") depth++;
      else if (c === ")") depth--;
    }
    calls.push({ name: m[1]!, keys: topLevelKeys(text.slice(start.lastIndex, i - 1)) });
  }
  return calls;
}

before(async () => {
  vaultDir = await fs.mkdtemp(path.join(os.tmpdir(), "sb-skill-"));
  const env = Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== undefined)) as Record<
    string,
    string
  >;
  env.VAULT_PATH = vaultDir;
  client = new Client({ name: "skill-lint", version: "0.0.0" });
  await client.connect(
    new StdioClientTransport({ command: process.execPath, args: [path.join(projectRoot, "dist", "index.js")], env })
  );

  const { tools } = await client.listTools();
  toolSchemas = new Map(
    tools.map((t) => [t.name, new Set(Object.keys((t.inputSchema as { properties?: object }).properties ?? {}))])
  );
  promptNames = new Set((await client.listPrompts()).prompts.map((p) => p.name));
});

after(async () => {
  await client.close();
  await fs.rm(vaultDir, { recursive: true, force: true });
});

for (const skillDir of skillDirs) {
  test(`[${path.basename(skillDir)}] SKILL.md has valid, well-sized frontmatter and stays concise`, async () => {
    const raw = await fs.readFile(path.join(skillDir, "SKILL.md"), "utf-8");
    const { data, content } = matter(raw);
    assert.match(data.name, /^[a-z0-9]+(-[a-z0-9]+)*$/, "name must be lowercase letters, digits and hyphens");
    assert.equal(data.name, path.basename(skillDir), "name must match the folder name");
    assert.ok(typeof data.description === "string");
    assert.ok(
      data.description.length >= 150 && data.description.length <= 1024,
      `description is ${data.description.length} chars`
    );
    assert.doesNotMatch(data.description, /[<>]/);
    assert.ok(content.split("\n").length <= 200, "SKILL.md should stay a concise router");
  });

  test(`[${path.basename(skillDir)}] every file SKILL.md points to exists`, async () => {
    const text = await fs.readFile(path.join(skillDir, "SKILL.md"), "utf-8");
    const refs = new Set([...text.matchAll(/`((?:workflows|reference|examples)\/[\w./-]+)`/g)].map((m) => m[1]!));
    assert.ok(refs.size >= 3, "expected the reference files to be linked");
    for (const ref of refs) {
      await fs.access(path.join(skillDir, ref));
    }
    // Every workflow file is reachable from the router.
    const workflows = await fs.readdir(path.join(skillDir, "workflows")).catch(() => [] as string[]);
    for (const file of workflows) {
      assert.ok(text.includes(`workflows/${file}`), `${file} is not linked from SKILL.md`);
    }
  });

  test(`[${path.basename(skillDir)}] every tool or prompt named in the skill really exists`, async () => {
    const unknown: string[] = [];
    for (const file of await markdownFiles(skillDir)) {
      const text = await fs.readFile(file, "utf-8");
      for (const m of text.matchAll(/`([a-z]+(?:_[a-z]+)+)(?=[`(])/g)) {
        const name = m[1]!;
        if (!toolSchemas.has(name) && !promptNames.has(name)) unknown.push(`${path.relative(skillDir, file)}: ${name}`);
      }
    }
    assert.deepEqual(unknown, []);
  });

  test(`[${path.basename(skillDir)}] every argument used in a documented tool call is a real argument`, async () => {
    const problems: string[] = [];
    let checked = 0;
    for (const file of await markdownFiles(skillDir)) {
      for (const call of findCalls(await fs.readFile(file, "utf-8"))) {
        const schema = toolSchemas.get(call.name);
        if (!schema) continue;
        checked++;
        for (const key of call.keys) {
          if (!schema.has(key)) problems.push(`${path.relative(skillDir, file)}: ${call.name}(${key}: ...)`);
        }
      }
    }
    const hasExamples = await fs.access(path.join(skillDir, "examples")).then(
      () => true,
      () => false
    );
    if (hasExamples) assert.ok(checked >= 10, `only ${checked} calls were checked; the parser may be broken`);
    assert.deepEqual(problems, []);
  });

  test(`[${path.basename(skillDir)}] reference/tools.md documents every tool with exactly its real arguments`, async () => {
    const text = await fs.readFile(path.join(skillDir, "reference", "tools.md"), "utf-8");
    const documented = new Map<string, Set<string>>();
    for (const line of text.split("\n")) {
      const cells = line.split("|").map((c) => c.trim());
      const name = cells[1]?.match(/^`([a-z_]+)`$/)?.[1];
      if (!name || !toolSchemas.has(name)) continue;
      documented.set(name, new Set([...(cells[2] ?? "").matchAll(/`([A-Za-z]+)\??`/g)].map((m) => m[1]!)));
    }
    assert.deepEqual([...documented.keys()].sort(), [...toolSchemas.keys()].sort(), "tools.md must cover every tool");
    for (const [name, args] of documented) {
      assert.deepEqual([...args].sort(), [...toolSchemas.get(name)!].sort(), `arguments of ${name} are out of date`);
    }
  });

  test(`[${path.basename(skillDir)}] documented template ids match the built-in templates`, async () => {
    const text = await fs.readFile(path.join(skillDir, "reference", "tools.md"), "utf-8");
    const line = text.split("\n").find((l) => l.startsWith("`meeting`, `decision`"));
    assert.ok(line, "built-in template list not found in tools.md");
    const list = line.match(/^((?:`[a-z-]+`(?:, )?)+)/)![1]!;
    const documented = [...list.matchAll(/`([a-z-]+)`/g)].map((m) => m[1]!).sort();
    assert.deepEqual(documented, BUILT_IN_TEMPLATES.map((t) => t.id).sort());
  });

  test(`[${path.basename(skillDir)}] the skill makes no network or shell promises it cannot keep`, async () => {
    for (const file of await markdownFiles(skillDir)) {
      const text = await fs.readFile(file, "utf-8");
      assert.doesNotMatch(text, /curl |wget |eval\(|base64 -d/i, `${file} contains a risky command`);
    }
  });
}
