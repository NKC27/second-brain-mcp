import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(here, "..");
const serverEntry = path.join(projectRoot, "dist", "index.js");

let client: Client;
let vaultDir: string;

async function call(name: string, args: Record<string, unknown> = {}) {
  try {
    const result = await client.callTool({ name, arguments: args });
    const content = result.content as Array<{ type: string; text: string }>;
    return { isError: result.isError === true, text: content.map((c) => c.text).join("\n") };
  } catch (err) {
    // Argument validation failures may surface as protocol errors in some SDK versions.
    return { isError: true, text: err instanceof Error ? err.message : String(err) };
  }
}

before(async () => {
  vaultDir = await fs.mkdtemp(path.join(os.tmpdir(), "sb-e2e-"));
  await fs.cp(path.join(projectRoot, "vault"), vaultDir, { recursive: true });

  const env = Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== undefined)) as Record<
    string,
    string
  >;
  env.VAULT_PATH = vaultDir;

  client = new Client({ name: "e2e-test", version: "0.0.0" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [serverEntry], env }));
});

after(async () => {
  await client.close();
  await fs.rm(vaultDir, { recursive: true, force: true });
});

test("advertises every tool with a safety annotation", async () => {
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), [
    "complete_todo",
    "create_note",
    "create_note_from_template",
    "delete_note",
    "export_vault",
    "find_related_notes",
    "get_backlinks",
    "get_journal",
    "get_note",
    "get_open_todos",
    "get_stats",
    "journal_entry",
    "link_mentions",
    "list_notes",
    "list_tags",
    "list_templates",
    "merge_notes",
    "rename_note",
    "restore_note",
    "search_notes",
    "suggest_links",
    "update_note",
  ]);
  for (const tool of tools) {
    assert.ok(tool.annotations, `${tool.name} is missing annotations`);
    assert.ok(tool.description && tool.description.length > 30, `${tool.name} needs a useful description`);
  }
  const byName = new Map(tools.map((t) => [t.name, t]));
  assert.equal(byName.get("get_stats")!.annotations!.readOnlyHint, true);
  assert.equal(byName.get("get_journal")!.annotations!.readOnlyHint, true);
  assert.equal(byName.get("suggest_links")!.annotations!.readOnlyHint, true);
  assert.equal(byName.get("delete_note")!.annotations!.destructiveHint, true);
});

test("seed vault is browsable through tools, resources and prompts", async () => {
  const stats = await call("get_stats");
  assert.match(stats.text, /Notes: 5/);
  assert.match(stats.text, /Vault: .* \(set by VAULT_PATH\)/);

  const { resources } = await client.listResources();
  const uris = resources.map((r) => r.uri);
  assert.ok(uris.includes("vault://stats") && uris.includes("vault://graph") && uris.includes("note://welcome"));

  const graph = await client.readResource({ uri: "vault://graph" });
  assert.equal(JSON.parse((graph.contents[0] as { text: string }).text).orphans.length, 0);

  const prompt = await client.getPrompt({ name: "summarize_note", arguments: { title: "Welcome" } });
  assert.match((prompt.messages[0]!.content as { text: string }).text, /Summarize the following note/);
});

test("prompts are listed and daily_plan is built from vault content", async () => {
  const { prompts } = await client.listPrompts();
  assert.deepEqual(prompts.map((p) => p.name).sort(), [
    "capture_meeting",
    "daily_plan",
    "summarize_note",
    "weekly_review",
  ]);

  const plan = await client.getPrompt({ name: "daily_plan" });
  const text = (plan.messages[0]!.content as { text: string }).text;
  assert.match(text, /## Open todos/);
  assert.match(text, /Try the official MCP Inspector/);

  const meeting = await client.getPrompt({
    name: "capture_meeting",
    arguments: { title: "Sync", notes: "Sam said ship Friday" },
  });
  assert.match((meeting.messages[0]!.content as { text: string }).text, /create_note_from_template/);
});

test("prompt arguments and note resources autocomplete", async () => {
  const titles = await client.complete({
    ref: { type: "ref/prompt", name: "summarize_note" },
    argument: { name: "title", value: "MCP" },
  });
  assert.ok(titles.completion.values.includes("MCP Fundamentals"));

  const slugs = await client.complete({
    ref: { type: "ref/resource", uri: "note://{slug}" },
    argument: { name: "slug", value: "client" },
  });
  assert.deepEqual(slugs.completion.values, ["client-setup-cheatsheet"]);
});

test("create, search, update, and delete round trip", async () => {
  const created = await call("create_note", { title: "E2E Note", body: "zebracorn migration plan", tags: ["e2e"] });
  assert.equal(created.isError, false);

  const dupe = await call("create_note", { title: "E2E Note" });
  assert.equal(dupe.isError, true);

  assert.match((await call("search_notes", { query: "zebracorn" })).text, /E2E Note/);

  await call("update_note", { title: "E2E Note", body: "- [ ] ship it", append: true });
  assert.match((await call("get_open_todos")).text, /ship it/);

  assert.equal((await call("delete_note", { title: "E2E Note" })).isError, false);
  assert.match((await call("search_notes", { query: "zebracorn" })).text, /No notes matched/);
});

test("deleted notes go to the trash and can be restored", async () => {
  await call("create_note", { title: "Oops Note", body: "important words here", tags: ["keep"] });
  const deleted = await call("delete_note", { title: "Oops Note" });
  assert.match(deleted.text, /restore_note/);
  assert.equal((await call("get_note", { title: "Oops Note" })).isError, true);

  const restored = await call("restore_note", { title: "Oops Note" });
  assert.equal(restored.isError, false);
  const back = await call("get_note", { title: "Oops Note" });
  assert.match(back.text, /important words here/);
  assert.match(back.text, /keep/);

  assert.equal((await call("restore_note", { title: "Never Existed" })).isError, true);
});

test("typos get a did-you-mean instead of a dead end", async () => {
  const miss = await call("get_note", { title: "MCP Fundamental" });
  assert.equal(miss.isError, true);
  assert.match(miss.text, /Did you mean "MCP Fundamentals"/);
});

test("rename_note rewrites links across the vault", async () => {
  await call("create_note", { title: "Rename Me", body: "x" });
  await call("create_note", { title: "Pointer", body: "links to [[Rename Me]]" });

  const renamed = await call("rename_note", { title: "Rename Me", newTitle: "Renamed" });
  assert.equal(renamed.isError, false);
  assert.match(renamed.text, /Updated links in 1 file/);
  assert.match((await call("get_note", { title: "Pointer" })).text, /\[\[Renamed\]\]/);
  assert.match((await call("get_backlinks", { title: "Renamed" })).text, /Pointer/);
});

test("find_related_notes and list_tags work on the seed vault", async () => {
  const related = await call("find_related_notes", { title: "MCP Fundamentals" });
  assert.equal(related.isError, false);
  assert.match(related.text, /Second Brain Architecture/);

  const tags = await call("list_tags");
  assert.match(tags.text, /- mcp \(3\)/);
});

test("templates: built-in, custom, missing fields and unknown ids", async () => {
  const list = await call("list_templates");
  for (const id of ["meeting", "decision", "project", "reading", "person", "idea", "how-to", "weekly-review"]) {
    assert.match(list.text, new RegExp(`\\*\\*${id}\\*\\*`));
  }

  const made = await call("create_note_from_template", {
    template: "meeting",
    title: "Roadmap sync",
    fields: { attendees: "Sam, Priya" },
    tags: ["q4"],
  });
  assert.equal(made.isError, false);
  assert.match(made.text, /Fields left as _TBD_: purpose/);

  const note = await call("get_note", { title: "Roadmap sync" });
  assert.match(note.text, /\*\*Attendees:\*\* Sam, Priya/);
  assert.match(note.text, /\*\*Purpose:\*\* _TBD_/);
  assert.match(note.text, /meeting, q4/);
  assert.match(note.text, new RegExp(`\\*\\*Date:\\*\\* ${new Date().toISOString().slice(0, 10)}`));

  const unknown = await call("create_note_from_template", { template: "nope", title: "X" });
  assert.equal(unknown.isError, true);
  assert.match(unknown.text, /Available: .*meeting/);

  await fs.mkdir(path.join(vaultDir, "templates"), { recursive: true });
  await fs.writeFile(
    path.join(vaultDir, "templates", "standup.md"),
    "---\nname: Standup\ndescription: Daily standup.\ntags:\n  - standup\n---\n\n**Yesterday:** {{yesterday}}\n"
  );
  assert.match((await call("list_templates")).text, /\*\*standup\*\* \(custom\)/);
  const custom = await call("create_note_from_template", {
    template: "standup",
    title: "Standup Monday",
    fields: { yesterday: "shipped the thing" },
  });
  assert.equal(custom.isError, false);
  assert.match((await call("get_note", { title: "Standup Monday" })).text, /shipped the thing/);
});

test("journal can be written and read back", async () => {
  const day = await call("get_journal", { date: "2026-09-02" });
  assert.match(day.text, /architecture note/);

  const none = await call("get_journal", { date: "1999-01-01" });
  assert.match(none.text, /No journal entry/);

  const bad = await call("get_journal", { date: "yesterday" });
  assert.equal(bad.isError, true);

  await call("journal_entry", { text: "wrote the e2e tests" });
  const recent = await call("get_journal", { days: 1 });
  assert.match(recent.text, /wrote the e2e tests/);
});

test("suggest_links finds unlinked mentions and link_mentions applies them safely", async () => {
  await call("create_note", { title: "Kubernetes Basics", body: "pods and services" });
  await call("create_note", { title: "Kubernetes Basics Advanced", body: "operators" });
  await call("create_note", {
    title: "Ops Diary",
    body: "Studied Kubernetes Basics Advanced today, then reread kubernetes basics. Already linked: [[Welcome]].",
  });

  const suggestions = await call("suggest_links", { title: "Ops Diary" });
  assert.match(suggestions.text, /link to \[\[Kubernetes Basics Advanced\]\]/);
  assert.match(suggestions.text, /link to \[\[Kubernetes Basics\]\]/);

  const applied = await call("link_mentions", { title: "Ops Diary" });
  assert.equal(applied.isError, false);
  assert.match(applied.text, /Linked 2 mention/);

  const body = (await call("get_note", { title: "Ops Diary" })).text;
  // The longer title is linked first, so it is not split into a shorter link plus stray words.
  assert.match(body, /Studied \[\[Kubernetes Basics Advanced\]\] today, then reread \[\[Kubernetes Basics\]\]\./);
  assert.match(body, /Already linked: \[\[Welcome\]\]/);

  assert.match((await call("link_mentions", { title: "Ops Diary" })).text, /No unlinked mentions/);
  assert.match((await call("suggest_links", { title: "Ops Diary" })).text, /No unlinked mentions/);
});

test("export_vault stays inside the vault folder", async () => {
  const outside = await call("export_vault", { outputPath: "../escape.json" });
  assert.equal(outside.isError, true);
  const absolute = await call("export_vault", { outputPath: path.join(os.tmpdir(), "escape.json") });
  assert.equal(absolute.isError, true);
  const wrongType = await call("export_vault", { outputPath: "notes/oops.md" });
  assert.equal(wrongType.isError, true);

  const ok = await call("export_vault");
  assert.equal(ok.isError, false);
  const files = await fs.readdir(path.join(vaultDir, "exports"));
  assert.equal(files.length, 1);
});

test("complete_todo ticks one todo and refuses to guess when it is ambiguous", async () => {
  await call("create_note", {
    title: "Errands",
    body: "- [ ] email Sam about budget\n- [ ] email Sam about hiring\n- [ ] call dentist\n- [ ] call dentist again",
  });

  const none = await call("complete_todo", { todo: "teleport" });
  assert.equal(none.isError, true);

  const ambiguous = await call("complete_todo", { todo: "email Sam" });
  assert.equal(ambiguous.isError, true);
  assert.match(ambiguous.text, /2 open todos match/);
  assert.match(ambiguous.text, /about budget/);
  assert.match((await call("get_note", { title: "Errands" })).text, /- \[ \] email Sam about budget/);

  const unique = await call("complete_todo", { todo: "about hiring" });
  assert.equal(unique.isError, false);
  assert.match(unique.text, /Checked off "email Sam about hiring" in "Errands"/);

  // "call dentist" matches two todos, but one is an exact match, so there is no ambiguity.
  assert.equal((await call("complete_todo", { todo: "call dentist" })).isError, false);

  const body = (await call("get_note", { title: "Errands" })).text;
  assert.match(body, /- \[x\] email Sam about hiring/);
  assert.match(body, /- \[x\] call dentist\n/);
  assert.match(body, /- \[ \] call dentist again/);
  assert.match(body, /- \[ \] email Sam about budget/);
});

test("complete_todo can tick a todo that lives in a journal entry and respects the note filter", async () => {
  await fs.writeFile(
    path.join(vaultDir, "journal", "2099-01-01.md"),
    "---\ntitle: Journal 2099-01-01\ntags:\n  - journal\n---\n\n- [ ] renew passport\n"
  );
  const wrongNote = await call("complete_todo", { todo: "renew passport", note: "Welcome" });
  assert.equal(wrongNote.isError, true);

  const done = await call("complete_todo", { todo: "renew passport" });
  assert.equal(done.isError, false);
  assert.match(await fs.readFile(path.join(vaultDir, "journal", "2099-01-01.md"), "utf-8"), /- \[x\] renew passport/);
  assert.doesNotMatch((await call("get_open_todos")).text, /renew passport/);
});

test("merge_notes folds a duplicate into the keeper and repoints links", async () => {
  await call("create_note", { title: "Postgres Tuning", body: "shared buffers", tags: ["database"] });
  await call("create_note", { title: "Postgres Tuning Notes", body: "work_mem tips", tags: ["database", "perf"] });
  await call("create_note", { title: "Reader", body: "see [[Postgres Tuning Notes]] for details" });

  const same = await call("merge_notes", { from: "Postgres Tuning", into: "Postgres Tuning" });
  assert.equal(same.isError, true);
  const missing = await call("merge_notes", { from: "Nope Nope", into: "Postgres Tuning" });
  assert.equal(missing.isError, true);

  const merged = await call("merge_notes", { from: "Postgres Tuning Notes", into: "Postgres Tuning" });
  assert.equal(merged.isError, false);
  assert.match(merged.text, /Repointed links in 1 file/);

  const keeper = (await call("get_note", { title: "Postgres Tuning" })).text;
  assert.match(keeper, /shared buffers/);
  assert.match(keeper, /## Merged from Postgres Tuning Notes/);
  assert.match(keeper, /work_mem tips/);
  assert.match(keeper, /database, perf/);
  assert.match((await call("get_note", { title: "Reader" })).text, /\[\[Postgres Tuning\]\]/);
  assert.equal((await call("get_note", { title: "Postgres Tuning Notes" })).isError, true);

  // The duplicate is recoverable.
  assert.equal((await call("restore_note", { title: "Postgres Tuning Notes" })).isError, false);
});
