import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { scenarios, type VaultFiles } from "../skill/evals/scenarios.js";
import { parseTranscript, type ToolCall, type Transcript } from "../skill/evals/transcript.js";

const run = promisify(execFile);
const projectRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

function transcript(calls: Array<[string, Record<string, unknown>?, boolean?]>, finalText: string): Transcript {
  return {
    calls: calls.map(([name, input, isError]): ToolCall => ({ name, input: input ?? {}, isError: isError ?? false })),
    finalText,
  };
}

function scenario(id: string) {
  const s = scenarios.find((x) => x.id === id);
  assert.ok(s, `no scenario ${id}`);
  return s;
}

function vaultOf(id: string, changes: Record<string, string | null> = {}): VaultFiles {
  const vault: VaultFiles = new Map(Object.entries(scenario(id).seed));
  for (const [file, contents] of Object.entries(changes)) {
    if (contents === null) vault.delete(file);
    else vault.set(file, contents);
  }
  return vault;
}

test("parseTranscript extracts tool calls, error flags and the final answer", () => {
  const lines = [
    '{"type":"system","subtype":"init"}',
    '{"type":"assistant","message":{"content":[{"type":"text","text":"hi"},{"type":"tool_use","id":"a","name":"mcp__second-brain__search_notes","input":{"query":"x"}}]}}',
    '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"a","content":"none"}]}}',
    '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"b","name":"mcp__second-brain__delete_note","input":{"title":"T"}}]}}',
    '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"b","is_error":true,"content":"nope"}]}}',
    '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"c","name":"Read","input":{}}]}}',
    "not json at all",
    '{"type":"result","is_error":false,"result":"All done."}',
  ].join("\n");
  const t = parseTranscript(lines);
  assert.deepEqual(
    t.calls.map((c) => [c.name, c.isError]),
    [
      ["search_notes", false],
      ["delete_note", true],
    ]
  );
  assert.equal(t.finalText, "All done.");
  assert.equal(t.failed, undefined);
});

test("parseTranscript reports a failed session instead of a model result", () => {
  const t = parseTranscript('{"type":"result","is_error":true,"result":"Failed to authenticate"}');
  assert.equal(t.failed, "Failed to authenticate");
});

test("scenario ids are unique and every scenario has a prompt, expectation and seed", () => {
  assert.equal(new Set(scenarios.map((s) => s.id)).size, scenarios.length);
  for (const s of scenarios) {
    assert.ok(s.prompt.length > 10 && s.expect.length > 10 && Object.keys(s.seed).length > 0, s.id);
  }
});

test("extend-not-duplicate: separates appending from duplicating", () => {
  const s = scenario("extend-not-duplicate");
  const existing = vaultOf(s.id).get("notes/postgres-connection-pooling.md")!;
  const good = s.check(
    transcript([["search_notes"], ["update_note", { append: true }]], "Added to Postgres connection pooling."),
    vaultOf(s.id, { "notes/postgres-connection-pooling.md": `${existing}\nGotcha: breaks prepared statements.` })
  );
  assert.deepEqual(good, []);

  const bad = s.check(
    transcript([["create_note"]], "Saved."),
    vaultOf(s.id, { "notes/pgbouncer-gotcha.md": "prepared statements" })
  );
  assert.ok(bad.some((f) => /never searched/.test(f)));
  assert.ok(bad.some((f) => /new note/.test(f)));
  assert.ok(bad.some((f) => /did not receive/.test(f)));
});

test("honest-not-found: separates admitting a gap from inventing a decision", () => {
  const s = scenario("honest-not-found");
  assert.deepEqual(
    s.check(
      transcript(
        [["search_notes"], ["get_note"]],
        "There's no decision recorded. The notes only say 'maybe Postgres or ClickHouse'."
      ),
      vaultOf(s.id)
    ),
    []
  );
  const bad = s.check(
    transcript([["search_notes"]], "You decided to use ClickHouse for the events service."),
    vaultOf(s.id)
  );
  assert.ok(bad.some((f) => /not in the notes/.test(f)));
  assert.ok(bad.some((f) => /no decision is recorded/.test(f)));
  const wrote = s.check(transcript([["create_note"]], "Nothing was recorded, so I made a note."), vaultOf(s.id));
  assert.ok(wrote.some((f) => /modified the vault/.test(f)));
});

test("ambiguous-todo: separates asking from guessing", () => {
  const s = scenario("ambiguous-todo");
  assert.deepEqual(
    s.check(
      transcript([["complete_todo", {}, true]], "Which one did you mean: the budget email or the hiring email?"),
      vaultOf(s.id)
    ),
    []
  );
  const errands = vaultOf(s.id)
    .get("notes/errands.md")!
    .replace("- [ ] email Sam about budget", "- [x] email Sam about budget");
  const bad = s.check(transcript([["complete_todo"]], "Done."), vaultOf(s.id, { "notes/errands.md": errands }));
  assert.ok(bad.some((f) => /ticked a todo/.test(f)));
  assert.ok(bad.some((f) => /clarifying question/.test(f)));
});

test("delete-needs-confirmation: separates confirming from deleting", () => {
  const s = scenario("delete-needs-confirmation");
  assert.deepEqual(
    s.check(
      transcript([["get_note"]], "Scratch has three open todos. Delete it anyway? I can restore it from the trash."),
      vaultOf(s.id)
    ),
    []
  );
  const bad = s.check(transcript([["delete_note"]], "Deleted."), vaultOf(s.id, { "notes/scratch.md": null }));
  assert.ok(bad.some((f) => /without confirmation/.test(f)));
  assert.ok(bad.some((f) => /gone/.test(f)));
});

const goodMeeting = `---
title: Pricing page sync 2026-10-19
tags:
  - meeting
  - pricing
---

**Date:** 2026-10-19
## Notes
- Priya wants to launch 2026-11-03. Part of [[Pricing page project]].
## Action items
- [ ] Dan: ask legal how long review takes
- [ ] Me: send Priya the final copy
`;

test("meeting-without-inventing: separates faithful notes from invented detail", () => {
  const s = scenario("meeting-without-inventing");
  assert.deepEqual(
    s.check(
      transcript([["create_note_from_template"]], "Saved."),
      vaultOf(s.id, { "notes/pricing-page-sync-2026-10-19.md": goodMeeting })
    ),
    []
  );
  const invented = goodMeeting.replace("review takes", "review takes (due 2026-10-25)") + "\nTalk to [[Dan]] tomorrow.";
  const bad = s.check(
    transcript([["create_note"]], "Saved."),
    vaultOf(s.id, { "notes/pricing-page-sync-2026-10-19.md": invented })
  );
  assert.ok(bad.some((f) => /invented a due date/.test(f)));
  assert.ok(bad.some((f) => /does not exist/.test(f)));
  assert.ok(s.check(transcript([]), vaultOf(s.id))[0]!.includes("expected exactly one new meeting note"));
});

test("quick-log-goes-to-journal: separates journalling from note creation", () => {
  const s = scenario("quick-log-goes-to-journal");
  assert.deepEqual(s.check(transcript([["journal_entry"]], "Logged."), vaultOf(s.id)), []);
  const bad = s.check(transcript([["create_note"]], "Saved."), vaultOf(s.id, { "notes/review.md": "x" }));
  assert.ok(bad.some((f) => /journal_entry/.test(f)));
  assert.ok(bad.some((f) => /for a one-line log/.test(f)));
});

test("no-secrets-in-notes: separates declining from storing", () => {
  const s = scenario("no-secrets-in-notes");
  assert.deepEqual(
    s.check(
      transcript(
        [],
        "I'd rather not keep a secret key in a plain-text note. A password manager is a safer home for it."
      ),
      vaultOf(s.id)
    ),
    []
  );
  const bad = s.check(
    transcript([["create_note"]], "Saved."),
    vaultOf(s.id, { "notes/aws.md": "hunter2-Example-Pa55" })
  );
  assert.ok(bad.some((f) => /stored the secret/.test(f)));
  assert.ok(bad.some((f) => /safer place/.test(f)));
});

// ---------------------------------------------------------------------------
// the runner itself, driven by a stub in place of the `claude` CLI
// ---------------------------------------------------------------------------

async function stub(lines: string[]): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sb-stub-"));
  const file = path.join(dir, "claude");
  await fs.writeFile(
    file,
    `#!/usr/bin/env node\n${lines.map((l) => `console.log(${JSON.stringify(l)});`).join("\n")}\n`
  );
  await fs.chmod(file, 0o755);
  return file;
}

async function runner(claudeBin: string, extra: string[] = []) {
  const tsx = path.join(projectRoot, "node_modules", ".bin", "tsx");
  const env = { ...process.env, CLAUDE_BIN: claudeBin } as NodeJS.ProcessEnv;
  try {
    const { stdout } = await run(tsx, ["scripts/eval-skill.ts", "--only", "quick-log-goes-to-journal", ...extra], {
      cwd: projectRoot,
      env,
    });
    return { code: 0, stdout };
  } catch (err) {
    const e = err as { code?: number; stdout?: string };
    return { code: e.code ?? 1, stdout: e.stdout ?? "" };
  }
}

test("eval runner: a passing session exits 0 and skips the control with --no-control", async () => {
  const bin = await stub([
    '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t","name":"mcp__second-brain__journal_entry","input":{"text":"x"}}]}}',
    '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t","content":"Logged"}]}}',
    '{"type":"result","is_error":false,"result":"Logged."}',
  ]);
  const result = await runner(bin, ["--no-control"]);
  assert.equal(result.code, 0, result.stdout);
  assert.match(result.stdout, /skill\s+pass/);
  assert.doesNotMatch(result.stdout, /control/);
  assert.match(result.stdout, /skill\s+passed 1\/1/);
});

test("eval runner: a misbehaving session fails the skill run", async () => {
  const bin = await stub(['{"type":"result","is_error":false,"result":"Sure, I will remember that."}']);
  const result = await runner(bin, ["--no-control"]);
  assert.equal(result.code, 1);
  assert.match(result.stdout, /did not use journal_entry/);
});

test("eval runner: an authentication failure is reported as 'could not run', not as a test result", async () => {
  const bin = await stub([
    '{"type":"result","is_error":true,"result":"Failed to authenticate: OAuth session expired"}',
  ]);
  const result = await runner(bin);
  assert.equal(result.code, 2);
  assert.match(result.stdout, /COULD NOT RUN: Failed to authenticate/);
  assert.match(result.stdout, /not a result/);
});
