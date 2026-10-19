import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { extractLinks, extractTodos, levenshtein, slugify, wordCount } from "../src/util.js";
import { buildGraph, computeStreak, findRelated, searchNotes } from "../src/search.js";
import { Vault } from "../src/vault.js";
import type { Note } from "../src/types.js";

function note(slug: string, title: string, body: string, tags: string[] = []): Note {
  return { slug, title, body, tags, created: "", updated: "", path: `/x/${slug}.md` };
}

test("slugify handles punctuation, spacing and empty input", () => {
  assert.equal(slugify("  Hello, World!  "), "hello-world");
  assert.equal(slugify("a   b---c"), "a-b-c");
  assert.equal(slugify("!!!"), "untitled");
});

test("extractLinks de-duplicates and trims", () => {
  assert.deepEqual(extractLinks("see [[A]] and [[ A ]] and [[B]]"), ["A", "B"]);
});

test("extractTodos reads open and done checkboxes", () => {
  const todos = extractTodos("- [ ] one\n  - [x] two\nnot a todo\n- [X] three");
  assert.deepEqual(
    todos.map((t) => [t.text, t.done]),
    [
      ["one", false],
      ["two", true],
      ["three", true],
    ]
  );
});

test("levenshtein and wordCount basics", () => {
  assert.equal(levenshtein("kitten", "sitting"), 3);
  assert.equal(wordCount("  a b   c "), 3);
  assert.equal(wordCount(""), 0);
});

test("searchNotes ranks title hits above body hits and honours tag filter", () => {
  const notes = [
    note("a", "Gardening", "plants and soil", ["hobby"]),
    note("b", "Work log", "gardening came up in standup", ["work"]),
  ];
  const results = searchNotes(notes, "gardening");
  assert.equal(results[0]!.note.slug, "a");
  assert.equal(searchNotes(notes, "gardening", "work").length, 1);
  assert.equal(searchNotes(notes, "   ").length, 0);
});

test("buildGraph links by title, ignores self links, and reports orphans", () => {
  const notes = [
    note("a", "Alpha", "see [[Beta]] and [[Alpha]]"),
    note("b", "Beta", "no links"),
    note("c", "Gamma", "alone"),
  ];
  const graph = buildGraph(notes);
  assert.deepEqual(graph.edges, [{ from: "a", to: "b" }]);
  assert.deepEqual(graph.orphans, ["c"]);
});

test("computeStreak counts back from today, or from yesterday if today is empty", () => {
  const day = (offset: number) => {
    const d = new Date();
    d.setDate(d.getDate() - offset);
    return d.toISOString().slice(0, 10);
  };
  assert.equal(computeStreak([]), 0);
  assert.equal(computeStreak([day(0), day(1), day(2)]), 3);
  assert.equal(computeStreak([day(1), day(2)]), 2);
  assert.equal(computeStreak([day(0), day(2)]), 1);
  assert.equal(computeStreak([day(5)]), 0);
});

test("findRelated surfaces shared tags, links and vocabulary with reasons", () => {
  const target = note("t", "Target", "kubernetes cluster deployment pipeline", ["devops"]);
  const notes = [
    target,
    note("tags", "Tag match", "unrelated words entirely", ["devops"]),
    note("linked", "Linker", "points at [[Target]]"),
    note("vocab", "Vocabulary", "our kubernetes cluster deployment story"),
    note("none", "Cooking", "pasta and tomatoes"),
  ];
  const related = findRelated(notes, target);
  const slugs = related.map((r) => r.note.slug);
  assert.ok(slugs.includes("tags") && slugs.includes("linked") && slugs.includes("vocab"));
  assert.ok(!slugs.includes("none") && !slugs.includes("t"));
  assert.ok(related.find((r) => r.note.slug === "linked")!.reasons.includes("links to this note"));
});

async function tempVault(): Promise<{ vault: Vault; root: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sb-vault-"));
  const vault = new Vault(root);
  await vault.init();
  return { vault, root };
}

test("vault save/load round-trips and de-duplicates slugs", async () => {
  const { vault } = await tempVault();
  const first = await vault.save({ title: "Same Title", body: "one", tags: ["x"] });
  const second = await vault.save({ title: "Same Title", body: "two", tags: [] });
  assert.equal(first.slug, "same-title");
  assert.equal(second.slug, "same-title-2");
  assert.deepEqual((await vault.load("same-title"))!.tags, ["x"]);
});

test("vault rename rewrites links in notes and journal, case-insensitively", async () => {
  const { vault, root } = await tempVault();
  const target = await vault.save({ title: "Old Name", body: "body", tags: [] });
  await vault.save({ title: "Linker", body: "see [[Old Name]] and [[old name]]", tags: [] });
  await vault.appendJournal("thinking about [[Old Name]]");

  const { note: renamed, linksUpdated } = await vault.rename(target, "New Name");
  assert.equal(renamed.slug, "new-name");
  assert.equal(await vault.load("old-name"), null);
  assert.equal(linksUpdated, 2);
  assert.equal((await vault.load("linker"))!.body, "see [[New Name]] and [[New Name]]");

  const today = new Date().toISOString().slice(0, 10);
  assert.match((await vault.loadJournal(today))!.body, /\[\[New Name\]\]/);
  await fs.rm(root, { recursive: true, force: true });
});

test("vault rename refuses to clobber an existing note", async () => {
  const { vault } = await tempVault();
  const a = await vault.save({ title: "Alpha", body: "", tags: [] });
  await vault.save({ title: "Beta", body: "", tags: [] });
  await assert.rejects(vault.rename(a, "Beta"), /already exists/);
});

// ---------------------------------------------------------------------------
// link suggestions
// ---------------------------------------------------------------------------

import { findMention, linkFirstMention, suggestLinks } from "../src/search.js";
import { BUILT_IN_TEMPLATES, renderTemplate, templateFields } from "../src/templates.js";
import { defaultHomeVault, DEMO_VAULT, resolveVault } from "../src/config.js";

test("findMention ignores existing links, respects word boundaries and case", () => {
  assert.equal(findMention("I like Gardening a lot", "gardening"), "Gardening");
  assert.equal(findMention("already [[Gardening]] here", "Gardening"), null);
  assert.equal(findMention("gardening-tools and gardeningx", "Gardening"), "gardening");
  assert.equal(findMention("megagardening", "Gardening"), null);
  assert.equal(findMention("nothing relevant", "Gardening"), null);
});

test("linkFirstMention only links the first plain mention and leaves existing links alone", () => {
  assert.equal(linkFirstMention("Alpha beta. Alpha again.", "Alpha"), "[[Alpha]] beta. Alpha again.");
  assert.equal(linkFirstMention("[[Alpha]] and Alpha", "Alpha"), "[[Alpha]] and [[Alpha]]");
  assert.equal(linkFirstMention("only [[Alpha]] here", "Alpha"), null);
  assert.equal(linkFirstMention("price is $5 for Alpha", "Alpha"), "price is $5 for [[Alpha]]");
});

test("suggestLinks skips short titles, self mentions and notes that already link", () => {
  const notes = [
    note("a", "Alpha Project", "talks about Beta Project and Hi and Alpha Project itself"),
    note("b", "Beta Project", "body"),
    note("hi", "Hi", "body"),
    note("c", "Gamma", "mentions Beta Project but also [[Beta Project]]"),
  ];
  const result = suggestLinks(notes);
  assert.deepEqual(
    result.map((s) => `${s.from.slug}->${s.to.slug}`),
    ["a->b"]
  );
  assert.equal(result[0]!.phrase, "Beta Project");
  assert.equal(suggestLinks(notes, notes[1]!).length, 0);
});

// ---------------------------------------------------------------------------
// templates
// ---------------------------------------------------------------------------

test("built-in templates have unique ids, descriptions and sane placeholders", () => {
  const ids = BUILT_IN_TEMPLATES.map((t) => t.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const t of BUILT_IN_TEMPLATES) {
    assert.ok(t.description.length > 10, `${t.id} needs a description`);
    assert.ok(t.tags.length > 0, `${t.id} needs a default tag`);
    assert.doesNotMatch(t.body, /\{\{\s*\}\}/, `${t.id} has an empty placeholder`);
  }
});

test("renderTemplate fills fields, reserved values and marks the rest _TBD_", () => {
  const meeting = BUILT_IN_TEMPLATES.find((t) => t.id === "meeting")!;
  assert.deepEqual(templateFields(meeting), ["attendees", "purpose"]);

  const { body, missing } = renderTemplate(meeting, {
    title: "Sync",
    date: "2026-10-19",
    fields: { attendees: "Sam", purpose: "   " },
  });
  assert.match(body, /\*\*Date:\*\* 2026-10-19/);
  assert.match(body, /\*\*Attendees:\*\* Sam/);
  assert.match(body, /\*\*Purpose:\*\* _TBD_/);
  assert.deepEqual(missing, ["purpose"]);
  assert.doesNotMatch(body, /\{\{/);
});

// ---------------------------------------------------------------------------
// vault: trash, templates, recent journal, config
// ---------------------------------------------------------------------------

test("vault delete moves to .trash and restore brings it back, even after a slug clash", async () => {
  const { vault, root } = await tempVault();
  const original = await vault.save({ title: "Precious", body: "first version", tags: ["t"] });
  assert.equal(await vault.delete(original.slug), true);
  assert.equal(await vault.load("precious"), null);
  assert.equal((await fs.readdir(path.join(root, ".trash"))).length, 1);

  await vault.save({ title: "Precious", body: "second version", tags: [] });
  const restored = await vault.restore("Precious");
  assert.equal(restored!.slug, "precious-2");
  assert.equal(restored!.body, "first version");
  assert.equal((await vault.load("precious"))!.body, "second version");
  assert.equal(await vault.restore("Precious"), null);
  await fs.rm(root, { recursive: true, force: true });
});

test("trashed notes never show up in listings or search", async () => {
  const { vault, root } = await tempVault();
  const n = await vault.save({ title: "Gone", body: "x", tags: [] });
  await vault.delete(n.slug);
  assert.deepEqual(await vault.listSlugs(), []);
  assert.deepEqual(await vault.loadAll(), []);
  await fs.rm(root, { recursive: true, force: true });
});

test("custom templates extend and override built-ins", async () => {
  const { vault, root } = await tempVault();
  assert.equal((await vault.listTemplates()).length, BUILT_IN_TEMPLATES.length);

  await fs.mkdir(path.join(root, "templates"), { recursive: true });
  await fs.writeFile(
    path.join(root, "templates", "meeting.md"),
    "---\nname: My meeting\ntags: [m]\n---\n\nbody {{who}}\n"
  );
  await fs.writeFile(path.join(root, "templates", "extra.md"), "no frontmatter at all\n");

  const templates = await vault.listTemplates();
  assert.equal(templates.length, BUILT_IN_TEMPLATES.length + 1);
  const meeting = templates.find((t) => t.id === "meeting")!;
  assert.equal(meeting.source, "custom");
  assert.equal(meeting.name, "My meeting");
  assert.equal(templates.find((t) => t.id === "extra")!.description, "Custom template");
  await fs.rm(root, { recursive: true, force: true });
});

test("loadRecentJournal returns only the requested window, oldest first", async () => {
  const { vault, root } = await tempVault();
  const day = (offset: number) => {
    const d = new Date();
    d.setDate(d.getDate() - offset);
    return d.toISOString().slice(0, 10);
  };
  for (const offset of [0, 1, 5]) {
    await fs.writeFile(
      path.join(root, "journal", `${day(offset)}.md`),
      `---\ntitle: Day ${offset}\n---\n\nentry ${offset}\n`
    );
  }
  assert.deepEqual(
    (await vault.loadRecentJournal(1)).map((n) => n.body),
    ["entry 0"]
  );
  assert.deepEqual(
    (await vault.loadRecentJournal(2)).map((n) => n.body),
    ["entry 1", "entry 0"]
  );
  assert.equal((await vault.loadRecentJournal(30)).length, 3);
  await fs.rm(root, { recursive: true, force: true });
});

test("resolveVault prefers VAULT_PATH, then ~/SecondBrain, then the demo vault", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "sb-home-"));
  assert.deepEqual(resolveVault({}, home), { path: DEMO_VAULT, source: "demo" });

  await fs.mkdir(defaultHomeVault(home), { recursive: true });
  assert.deepEqual(resolveVault({}, home), { path: defaultHomeVault(home), source: "home" });

  const explicit = resolveVault({ VAULT_PATH: "./relative/dir" }, home);
  assert.equal(explicit.source, "env");
  assert.ok(path.isAbsolute(explicit.path));
  await fs.rm(home, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// todo helpers
// ---------------------------------------------------------------------------

import { checkOffTodoLine, findOpenTodoLines } from "../src/util.js";

test("findOpenTodoLines only returns unchecked todos that contain the text", () => {
  const body = "- [ ] Call the Dentist\n- [x] call mum\n  - [ ] call plumber\nplain call line";
  assert.deepEqual(findOpenTodoLines(body, "CALL"), [
    { line: 0, text: "Call the Dentist" },
    { line: 2, text: "call plumber" },
  ]);
  assert.deepEqual(findOpenTodoLines(body, "mum"), []);
});

test("checkOffTodoLine ticks exactly one line and keeps indentation", () => {
  const body = "- [ ] one\n  - [ ] two\n- [ ] three";
  const result = checkOffTodoLine(body, 1);
  assert.equal(result.body, "- [ ] one\n  - [x] two\n- [ ] three");
  assert.equal(result.text, "two");
  assert.throws(() => checkOffTodoLine(body, 5), /not an open todo/);
});

// ---------------------------------------------------------------------------
// path safety
// ---------------------------------------------------------------------------

test("vault never reads, writes or deletes outside its folders, whatever name it is given", async () => {
  const { vault, root } = await tempVault();
  const parent = path.dirname(root);
  const outside = path.join(parent, `sb-outside-${path.basename(root)}.md`);
  await fs.writeFile(outside, "---\ntitle: Outside\n---\n\nsecret\n");

  const escape = `../${path.basename(outside, ".md")}`;
  for (const name of [escape, "../x", "a/b", "..", ".", "sub/../../x", "\\..\\x"]) {
    assert.equal(await vault.load(name), null, `load(${name}) should find nothing`);
    assert.equal(await vault.delete(name), false, `delete(${name}) should do nothing`);
    assert.equal(await vault.loadJournal(name), null, `loadJournal(${name}) should find nothing`);
  }
  await assert.rejects(vault.save({ title: "x", slug: escape, body: "pwned", tags: [] }), /Invalid file name/);
  assert.equal(
    await fs.readFile(outside, "utf-8"),
    "---\ntitle: Outside\n---\n\nsecret\n",
    "the outside file is untouched"
  );

  await fs.rm(outside, { force: true });
  await fs.rm(root, { recursive: true, force: true });
});
