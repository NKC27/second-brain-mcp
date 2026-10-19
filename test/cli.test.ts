import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(here, "..");
const entry = path.join(projectRoot, "dist", "index.js");

async function cli(args: string[], env: Record<string, string> = {}) {
  const base = Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== undefined)) as Record<
    string,
    string
  >;
  delete base.VAULT_PATH;
  try {
    const { stdout, stderr } = await run(process.execPath, [entry, ...args], { env: { ...base, ...env } });
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

test("--version matches package.json and --help lists the commands", async () => {
  const pkg = JSON.parse(await fs.readFile(path.join(projectRoot, "package.json"), "utf-8")) as { version: string };
  assert.equal((await cli(["--version"])).stdout.trim(), pkg.version);

  const help = await cli(["--help"]);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /init/);
  assert.match(help.stdout, /doctor/);
});

test("unknown commands fail loudly instead of silently starting a server", async () => {
  const result = await cli(["frobnicate"]);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /Unknown command "frobnicate"/);
});

test("init creates a usable vault, is idempotent, and prints setup for every client", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "sb-cli-home-"));
  const first = await cli(["init"], { HOME: home });
  assert.equal(first.code, 0);
  assert.match(first.stdout, /Created your vault at/);
  assert.match(first.stdout, /claude mcp add --scope user second-brain -- node /);
  assert.match(first.stdout, /"mcpServers"/);
  assert.match(first.stdout, /"servers"/);
  assert.doesNotMatch(first.stdout, /-e VAULT_PATH|"VAULT_PATH"/, "default location needs no env var in the snippets");

  const vault = path.join(home, "SecondBrain");
  assert.deepEqual((await fs.readdir(path.join(vault, "notes"))).sort(), ["start-here.md", "vault-conventions.md"]);
  assert.ok((await fs.readdir(path.join(vault, "templates"))).includes("one-on-one.md"));

  const marker = path.join(vault, "notes", "start-here.md");
  await fs.writeFile(marker, "my own edits");
  const second = await cli(["init"], { HOME: home });
  assert.match(second.stdout, /already exists/);
  assert.equal(await fs.readFile(marker, "utf-8"), "my own edits");
  await fs.rm(home, { recursive: true, force: true });
});

test("init --dir uses a custom folder and tells you to set VAULT_PATH", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sb-cli-custom-"));
  const target = path.join(dir, "my vault");
  const result = await cli(["init", "--dir", target]);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /-e VAULT_PATH=/);
  assert.match(result.stdout, /"VAULT_PATH"/);
  await fs.access(path.join(target, "notes", "start-here.md"));
  await fs.rm(dir, { recursive: true, force: true });
});

test("a freshly initialised vault passes doctor, including the live handshake", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "sb-cli-doctor-"));
  await cli(["init"], { HOME: home });
  const result = await cli(["doctor"], { HOME: home });
  assert.equal(result.code, 0, result.stdout);
  assert.match(result.stdout, /your ~\/SecondBrain folder/);
  assert.match(result.stdout, /Server handshake succeeded: \d+ tools available/);
  assert.match(result.stdout, /All \[\[links\]\] resolve/);
  await fs.rm(home, { recursive: true, force: true });
});

test("doctor reports broken links and duplicate titles as warnings, not failures", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sb-cli-warn-"));
  await fs.mkdir(path.join(dir, "notes"), { recursive: true });
  await fs.writeFile(path.join(dir, "notes", "a.md"), "---\ntitle: Same\n---\n\nsee [[Missing Note]]\n");
  await fs.writeFile(path.join(dir, "notes", "b.md"), "---\ntitle: Same\n---\n\nbody\n");
  await fs.writeFile(path.join(dir, "notes", "c.md"), "no frontmatter\n");

  const result = await cli(["doctor"], { VAULT_PATH: dir });
  assert.equal(result.code, 0);
  assert.match(result.stdout, /\[warn\].*Duplicate note titles/);
  assert.match(result.stdout, /\[warn\].*\[\[Missing Note\]\]/);
  assert.match(result.stdout, /\[warn\].*no title in their frontmatter/);
  await fs.rm(dir, { recursive: true, force: true });
});
