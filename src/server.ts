import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { completable } from "@modelcontextprotocol/sdk/server/completable.js";

import { Vault } from "./vault.js";
import {
  buildGraph,
  computeStats,
  computeStreak,
  findRelated,
  linkFirstMention,
  searchNotes,
  suggestLinks,
} from "./search.js";
import { renderTemplate, templateFields } from "./templates.js";
import { describeSource, type VaultLocation } from "./config.js";
import { checkOffTodoLine, extractLinks, extractTodos, findOpenTodoLines, slugify, wordCount } from "./util.js";
import { log } from "./logger.js";
import { VERSION } from "./version.js";
import type { Note } from "./types.js";

const INSTRUCTIONS =
  "A personal knowledge base backed by plain markdown files on disk. Search before creating (search_notes, " +
  "find_related_notes), connect ideas with [[Wiki Link]] syntax, capture quick thoughts with journal_entry, " +
  "start structured notes with list_templates and create_note_from_template, and review with get_open_todos, " +
  "get_journal and get_stats. delete_note is recoverable with restore_note.";

export function createServer(vault: Vault, location: VaultLocation): McpServer {
  const VAULT_PATH = vault.root;
  const server = new McpServer(
    { name: "second-brain", version: VERSION, title: "Second Brain" },
    { instructions: INSTRUCTIONS }
  );

  // ---------------------------------------------------------------------------
  // helpers
  // ---------------------------------------------------------------------------

  // Tool annotations let clients (Claude Code, Cursor, VS Code) tell safe reads
  // from writes and destructive actions, and decide when to ask for approval.
  const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
  const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
  const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };

  function bar(count: number, max: number, width = 20): string {
    const filled = max > 0 ? Math.round((count / max) * width) : 0;
    return "#".repeat(Math.max(0, filled)) + "-".repeat(Math.max(0, width - filled));
  }

  async function resolveNote(query: string): Promise<{ note: Note | null; suggestion: Note | null }> {
    const note = await vault.findBySlugOrTitle(query);
    if (note) return { note, suggestion: null };
    const suggestion = await vault.suggestClosest(query);
    return { note: null, suggestion };
  }

  function notFoundMessage(query: string, suggestion: Note | null): string {
    const base = `No note found matching "${query}".`;
    return suggestion
      ? `${base} Did you mean "${suggestion.title}"?`
      : `${base} Try list_notes to see what's in the vault.`;
  }

  function textResult(text: string, isError = false) {
    return { isError, content: [{ type: "text" as const, text }] };
  }

  async function loadAllJournalNotes(): Promise<Note[]> {
    const dates = await vault.listJournalDates();
    const notes = await Promise.all(dates.map((d) => vault.loadJournal(d)));
    return notes.filter((n): n is Note => n !== null);
  }

  // ---------------------------------------------------------------------------
  // tools
  // ---------------------------------------------------------------------------

  server.registerTool(
    "create_note",
    {
      title: "Create Note",
      annotations: WRITE,
      description:
        "Create a new note in the vault. Use [[Note Title]] syntax anywhere in the body to link to other notes, " +
        "and '- [ ] task text' to capture todo items that show up in get_open_todos.",
      inputSchema: {
        title: z.string().min(1).describe("The note's title"),
        body: z.string().default("").describe("Markdown content"),
        tags: z.array(z.string()).default([]).describe("Tags to categorize the note"),
      },
    },
    async ({ title, body, tags }) => {
      const existing = await vault.findBySlugOrTitle(title);
      if (existing) {
        return textResult(
          `A note titled "${existing.title}" already exists (${existing.slug}). Use update_note to modify it instead.`,
          true
        );
      }
      const note = await vault.save({ title, body, tags });
      const links = extractLinks(note.body);
      const todos = extractTodos(note.body);
      log("created note", note.slug);
      return textResult(
        [
          `Created "${note.title}" → ${note.slug}.md`,
          `${wordCount(note.body)} words | tags: ${note.tags.join(", ") || "none"}`,
          links.length ? `Links detected: ${links.join(", ")}` : null,
          todos.length ? `Todos captured: ${todos.length}` : null,
        ]
          .filter(Boolean)
          .join("\n")
      );
    }
  );

  server.registerTool(
    "get_note",
    {
      title: "Get Note",
      annotations: READ_ONLY,
      description:
        "Retrieve a note's full content by title or slug. Fuzzy-matches close titles if the exact one isn't found.",
      inputSchema: { title: z.string().describe("Note title or slug") },
    },
    async ({ title }) => {
      const { note, suggestion } = await resolveNote(title);
      if (!note) return textResult(notFoundMessage(title, suggestion), true);
      return textResult(
        `# ${note.title}\n\nTags: ${note.tags.join(", ") || "none"} | Updated: ${note.updated}\n\n${note.body}`
      );
    }
  );

  server.registerTool(
    "update_note",
    {
      title: "Update Note",
      annotations: DESTRUCTIVE,
      description:
        "Update an existing note's body and/or tags. Set append=true to add to the end instead of replacing the body.",
      inputSchema: {
        title: z.string().describe("Note title or slug to update"),
        body: z.string().optional().describe("New body content"),
        tags: z.array(z.string()).optional().describe("Replace the note's tags entirely"),
        append: z.boolean().default(false).describe("If true, append `body` instead of replacing the existing content"),
      },
    },
    async ({ title, body, tags, append }) => {
      const { note, suggestion } = await resolveNote(title);
      if (!note) return textResult(notFoundMessage(title, suggestion), true);

      const newBody = body === undefined ? note.body : append ? `${note.body}\n\n${body}`.trim() : body;
      const updated = await vault.save({
        title: note.title,
        slug: note.slug,
        tags: tags ?? note.tags,
        body: newBody,
        created: note.created,
      });
      return textResult(
        `Updated "${updated.title}" — ${wordCount(updated.body)} words | tags: ${updated.tags.join(", ") || "none"}`
      );
    }
  );

  server.registerTool(
    "delete_note",
    {
      title: "Delete Note",
      annotations: DESTRUCTIVE,
      description:
        "Delete a note. It is moved to the vault's .trash folder rather than erased, so restore_note can bring it back.",
      inputSchema: { title: z.string().describe("Note title or slug to delete") },
    },
    async ({ title }) => {
      const { note, suggestion } = await resolveNote(title);
      if (!note) return textResult(notFoundMessage(title, suggestion), true);
      await vault.delete(note.slug);
      return textResult(`Deleted "${note.title}". It was moved to .trash and can be brought back with restore_note.`);
    }
  );

  server.registerTool(
    "list_notes",
    {
      title: "List Notes",
      annotations: READ_ONLY,
      description: "List notes in the vault, optionally filtered by tag, sorted by most recently updated first.",
      inputSchema: {
        tag: z.string().optional().describe("Only list notes with this tag"),
        limit: z.number().int().positive().max(200).default(50),
      },
    },
    async ({ tag, limit }) => {
      let notes = await vault.loadAll();
      if (tag) notes = notes.filter((n) => n.tags.some((t) => t.toLowerCase() === tag.toLowerCase()));
      notes.sort((a, b) => b.updated.localeCompare(a.updated));
      notes = notes.slice(0, limit);

      if (notes.length === 0) {
        return textResult(
          tag ? `No notes tagged "${tag}".` : "The vault is empty — create your first note with create_note."
        );
      }
      const lines = notes.map(
        (n) =>
          `- **${n.title}** (${n.slug}) — ${n.tags.join(", ") || "no tags"} — ${wordCount(n.body)}w — updated ${n.updated.slice(0, 10)}`
      );
      return textResult(`${notes.length} note(s):\n\n${lines.join("\n")}`);
    }
  );

  server.registerTool(
    "search_notes",
    {
      title: "Search Notes",
      annotations: READ_ONLY,
      description:
        "Full-text search across the vault, ranked by relevance (title matches weighted higher), with a matching snippet per result.",
      inputSchema: {
        query: z.string().min(1).describe("Search terms"),
        tag: z.string().optional().describe("Restrict results to this tag"),
        limit: z.number().int().positive().max(50).default(10),
      },
    },
    async ({ query, tag, limit }) => {
      const notes = await vault.loadAll();
      const results = searchNotes(notes, query, tag).slice(0, limit);
      if (results.length === 0) return textResult(`No notes matched "${query}".`);
      const lines = results.map(
        (r, i) => `${i + 1}. **${r.note.title}** (${r.note.slug}, score ${r.score})\n   ${r.snippet}`
      );
      return textResult(`${results.length} result(s) for "${query}":\n\n${lines.join("\n\n")}`);
    }
  );

  server.registerTool(
    "journal_entry",
    {
      title: "Quick Journal Capture",
      annotations: WRITE,
      description:
        "Append a timestamped entry to today's journal note, creating it if needed. Good for quick thoughts, " +
        "logs, or standup notes without the overhead of naming a full note.",
      inputSchema: { text: z.string().min(1).describe("The entry to capture") },
    },
    async ({ text }) => {
      const { date } = await vault.appendJournal(text);
      const dates = await vault.listJournalDates();
      return textResult(`Logged to journal/${date}.md. Current streak: ${computeStreak(dates)} day(s).`);
    }
  );

  server.registerTool(
    "complete_todo",
    {
      title: "Complete Todo",
      annotations: WRITE,
      description:
        "Tick off one open '- [ ]' todo, found by part of its text, in any note or journal entry. If several todos match you get a list back to choose from; pass note to narrow the search. Use this instead of rewriting a note to check something off.",
      inputSchema: {
        todo: z.string().min(2).describe("Part of the todo's text, enough to identify it"),
        note: z.string().optional().describe("Only look in this note (title or slug)"),
      },
    },
    async ({ todo, note: noteQuery }) => {
      let notes = await vault.loadAll();
      let journal = await loadAllJournalNotes();
      if (noteQuery) {
        const { note, suggestion } = await resolveNote(noteQuery);
        if (!note) return textResult(notFoundMessage(noteQuery, suggestion), true);
        notes = [note];
        journal = [];
      }

      const matches = [
        ...notes.map((n) => ({ n, isJournal: false })),
        ...journal.map((n) => ({ n, isJournal: true })),
      ].flatMap(({ n, isJournal }) => findOpenTodoLines(n.body, todo).map((hit) => ({ n, isJournal, ...hit })));

      if (matches.length === 0) return textResult(`No open todo matching "${todo}".`, true);

      const exact = matches.filter((m) => m.text.toLowerCase() === todo.trim().toLowerCase());
      const chosen = matches.length === 1 ? matches[0]! : exact.length === 1 ? exact[0]! : null;
      if (!chosen) {
        const options = matches.map((m) => `- "${m.text}" in "${m.n.title}"`).join("\n");
        return textResult(
          `${matches.length} open todos match "${todo}". Be more specific, or pass note:\n\n${options}`,
          true
        );
      }

      const { body, text } = checkOffTodoLine(chosen.n.body, chosen.line);
      if (chosen.isJournal) {
        await vault.writeJournalBody(chosen.n.slug.slice("journal-".length), body);
      } else {
        await vault.save({
          title: chosen.n.title,
          slug: chosen.n.slug,
          tags: chosen.n.tags,
          body,
          created: chosen.n.created,
        });
      }
      return textResult(`Checked off "${text}" in "${chosen.n.title}".`);
    }
  );

  server.registerTool(
    "get_backlinks",
    {
      title: "Get Backlinks",
      annotations: READ_ONLY,
      description: "List every note that links to the given note via [[Wiki Link]] syntax.",
      inputSchema: { title: z.string().describe("Note title or slug") },
    },
    async ({ title }) => {
      const { note, suggestion } = await resolveNote(title);
      if (!note) return textResult(notFoundMessage(title, suggestion), true);

      const notes = await vault.loadAll();
      const graph = buildGraph(notes);
      const backlinks = graph.edges
        .filter((e) => e.to === note.slug)
        .map((e) => notes.find((n) => n.slug === e.from))
        .filter((n): n is Note => n !== undefined);

      if (backlinks.length === 0) return textResult(`No notes link to "${note.title}" yet.`);
      return textResult(
        `Notes linking to "${note.title}":\n\n${backlinks.map((n) => `- ${n.title} (${n.slug})`).join("\n")}`
      );
    }
  );

  server.registerTool(
    "get_open_todos",
    {
      title: "Get Open Todos",
      annotations: READ_ONLY,
      description: "Scan every note and journal entry for unchecked '- [ ]' checkboxes, grouped by source.",
      inputSchema: { tag: z.string().optional().describe("Only scan notes with this tag") },
    },
    async ({ tag }) => {
      let notes = await vault.loadAll();
      if (tag) notes = notes.filter((n) => n.tags.some((t) => t.toLowerCase() === tag.toLowerCase()));
      const journalNotes = await loadAllJournalNotes();

      let total = 0;
      const blocks: string[] = [];
      for (const n of [...notes, ...journalNotes]) {
        const open = extractTodos(n.body).filter((t) => !t.done);
        if (open.length === 0) continue;
        total += open.length;
        blocks.push(`**${n.title}**\n${open.map((t) => `- [ ] ${t.text}`).join("\n")}`);
      }

      if (total === 0) return textResult("No open todos. Nice.");
      return textResult(`${total} open todo(s):\n\n${blocks.join("\n\n")}`);
    }
  );

  server.registerTool(
    "get_stats",
    {
      title: "Vault Stats",
      annotations: READ_ONLY,
      description:
        "Show a dashboard of vault statistics: note/word counts, a tag cloud, journal streak, most-linked note, and orphan notes.",
      inputSchema: {},
    },
    async () => {
      const notes = await vault.loadAll();
      const journalDates = await vault.listJournalDates();
      const stats = computeStats(notes, journalDates);
      const maxTagCount = Math.max(1, ...Object.values(stats.tagCounts));
      const tagLines = Object.entries(stats.tagCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([tag, count]) => `  ${tag.padEnd(16)} ${bar(count, maxTagCount)} ${count}`);

      const lines = [
        `Vault: ${VAULT_PATH} (${describeSource(location.source)})`,
        `Notes: ${stats.noteCount}  |  Words: ${stats.totalWords}  |  Journal streak: ${stats.journalStreak} day(s)`,
        stats.mostLinked
          ? `Most linked: "${stats.mostLinked.title}" (${stats.mostLinked.count} backlinks)`
          : "Most linked: n/a",
        `Orphan notes (no links in or out): ${stats.orphanCount}`,
        "",
        "Top tags:",
        ...(tagLines.length ? tagLines : ["  (no tags yet)"]),
      ];
      return textResult(lines.join("\n"));
    }
  );

  server.registerTool(
    "rename_note",
    {
      title: "Rename Note",
      annotations: WRITE,
      description:
        "Give a note a new title. Every [[Wiki Link]] in other notes and journal entries that pointed at the old title is rewritten, so nothing breaks.",
      inputSchema: {
        title: z.string().describe("Current note title or slug"),
        newTitle: z.string().min(1).describe("The new title"),
      },
    },
    async ({ title, newTitle }) => {
      const { note, suggestion } = await resolveNote(title);
      if (!note) return textResult(notFoundMessage(title, suggestion), true);
      if (note.title === newTitle.trim()) return textResult(`"${note.title}" already has that title.`, true);
      try {
        const result = await vault.rename(note, newTitle.trim());
        return textResult(
          `Renamed "${note.title}" to "${result.note.title}" (${result.note.slug}.md). Updated links in ${result.linksUpdated} file(s).`
        );
      } catch (err) {
        return textResult(err instanceof Error ? err.message : String(err), true);
      }
    }
  );

  server.registerTool(
    "merge_notes",
    {
      title: "Merge Notes",
      annotations: DESTRUCTIVE,
      description:
        "Merge a duplicate note into the one to keep: its content is appended under a 'Merged from' heading, tags are combined, every [[link]] to the duplicate is repointed at the kept note, and the duplicate is moved to .trash (restore_note can undo that part).",
      inputSchema: {
        from: z.string().describe("The duplicate note to fold in (title or slug)"),
        into: z.string().describe("The note to keep (title or slug)"),
      },
    },
    async ({ from, into }) => {
      const source = await resolveNote(from);
      if (!source.note) return textResult(notFoundMessage(from, source.suggestion), true);
      const target = await resolveNote(into);
      if (!target.note) return textResult(notFoundMessage(into, target.suggestion), true);
      if (source.note.slug === target.note.slug) return textResult("Those are the same note; nothing to merge.", true);

      const date = new Date().toISOString().slice(0, 10);
      const body = `${target.note.body}\n\n## Merged from ${source.note.title} (${date})\n\n${source.note.body}`.trim();
      const tags = [...new Set([...target.note.tags, ...source.note.tags])];
      await vault.save({ title: target.note.title, slug: target.note.slug, tags, body, created: target.note.created });
      await vault.delete(source.note.slug);
      const linksUpdated = await vault.rewriteLinks(source.note.title, target.note.title);
      return textResult(
        `Merged "${source.note.title}" into "${target.note.title}". Repointed links in ${linksUpdated} file(s). The original is in .trash and can be brought back with restore_note.`
      );
    }
  );

  server.registerTool(
    "find_related_notes",
    {
      title: "Find Related Notes",
      annotations: READ_ONLY,
      description:
        "Suggest notes related to a given note, ranked by shared tags, direct [[links]] in either direction, and shared vocabulary. Useful for discovering connections worth linking.",
      inputSchema: {
        title: z.string().describe("Note title or slug"),
        limit: z.number().int().positive().max(20).default(5),
      },
    },
    async ({ title, limit }) => {
      const { note, suggestion } = await resolveNote(title);
      if (!note) return textResult(notFoundMessage(title, suggestion), true);
      const related = findRelated(await vault.loadAll(), note, limit);
      if (related.length === 0) return textResult(`Nothing in the vault looks related to "${note.title}" yet.`);
      const lines = related.map(
        (r, i) => `${i + 1}. **${r.note.title}** (${r.note.slug}, score ${r.score}) — ${r.reasons.join("; ")}`
      );
      return textResult(`Notes related to "${note.title}":\n\n${lines.join("\n")}`);
    }
  );

  server.registerTool(
    "list_tags",
    {
      title: "List Tags",
      annotations: READ_ONLY,
      description: "List every tag in the vault with how many notes use it, most used first.",
      inputSchema: {},
    },
    async () => {
      const notes = await vault.loadAll();
      const counts = computeStats(notes, []).tagCounts;
      const entries = Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
      if (entries.length === 0) return textResult("No tags yet. Add some with create_note or update_note.");
      return textResult(entries.map(([tag, count]) => `- ${tag} (${count})`).join("\n"));
    }
  );

  server.registerTool(
    "restore_note",
    {
      title: "Restore Note",
      annotations: WRITE,
      description:
        "Bring back a note that was deleted with delete_note (restores the most recent match for a title or slug).",
      inputSchema: { title: z.string().describe("Title or slug of the deleted note") },
    },
    async ({ title }) => {
      const restored = await vault.restore(title);
      if (!restored) return textResult(`Nothing in the trash matches "${title}".`, true);
      return textResult(`Restored "${restored.title}" (${restored.slug}.md).`);
    }
  );

  server.registerTool(
    "get_journal",
    {
      title: "Read Journal",
      annotations: READ_ONLY,
      description:
        "Read journal entries: a single day (date as YYYY-MM-DD) or the last N days. Use it to recall what was logged recently.",
      inputSchema: {
        date: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD")
          .optional()
          .describe("A specific day"),
        days: z
          .number()
          .int()
          .positive()
          .max(90)
          .default(7)
          .describe("How many recent days to include when no date is given"),
      },
    },
    async ({ date, days }) => {
      const entries = date
        ? [await vault.loadJournal(date)].filter((n): n is Note => n !== null)
        : await vault.loadRecentJournal(days);
      if (entries.length === 0) {
        return textResult(date ? `No journal entry for ${date}.` : `No journal entries in the last ${days} day(s).`);
      }
      return textResult(entries.map((e) => `## ${e.title}\n\n${e.body}`).join("\n\n"));
    }
  );

  server.registerTool(
    "list_templates",
    {
      title: "List Templates",
      annotations: READ_ONLY,
      description:
        "List note templates (built-in ones plus any custom .md files in the vault's templates/ folder) and the fields each accepts.",
      inputSchema: {},
    },
    async () => {
      const templates = await vault.listTemplates();
      const lines = templates.map((t) => {
        const fields = templateFields(t);
        return `- **${t.id}**${t.source === "custom" ? " (custom)" : ""} — ${t.description}${fields.length ? ` Fields: ${fields.join(", ")}.` : ""}`;
      });
      return textResult(`${templates.length} template(s):\n\n${lines.join("\n")}`);
    }
  );

  server.registerTool(
    "create_note_from_template",
    {
      title: "Create Note From Template",
      annotations: WRITE,
      description:
        "Create a structured note from a template (see list_templates). Supply values for the template's fields; any left empty are marked _TBD_ so they can be filled in later with update_note.",
      inputSchema: {
        template: z.string().describe("Template id from list_templates, e.g. meeting"),
        title: z.string().min(1).describe("The new note's title"),
        fields: z
          .record(z.string(), z.string())
          .default({})
          .describe('Values for the template fields, e.g. { "attendees": "Sam, Priya" }'),
        tags: z.array(z.string()).default([]).describe("Extra tags; the template's own tags are added automatically"),
      },
    },
    async ({ template, title, fields, tags }) => {
      const templates = await vault.listTemplates();
      const chosen = templates.find((t) => t.id === template.trim().toLowerCase());
      if (!chosen) {
        return textResult(
          `No template called "${template}". Available: ${templates.map((t) => t.id).join(", ")}.`,
          true
        );
      }
      const existing = await vault.findBySlugOrTitle(title);
      if (existing) {
        return textResult(
          `A note titled "${existing.title}" already exists (${existing.slug}). Use update_note to modify it instead.`,
          true
        );
      }
      const date = new Date().toISOString().slice(0, 10);
      const { body, missing } = renderTemplate(chosen, { title, date, fields });
      const note = await vault.save({ title, body, tags: [...new Set([...chosen.tags, ...tags])] });
      return textResult(
        [
          `Created "${note.title}" from the ${chosen.id} template → ${note.slug}.md`,
          `tags: ${note.tags.join(", ") || "none"}`,
          missing.length ? `Fields left as _TBD_: ${missing.join(", ")}. Fill them in with update_note.` : null,
        ]
          .filter(Boolean)
          .join("\n")
      );
    }
  );

  server.registerTool(
    "suggest_links",
    {
      title: "Suggest Links",
      annotations: READ_ONLY,
      description:
        "Find places where a note mentions another note's title in plain text without linking to it. Review the list, then apply with link_mentions.",
      inputSchema: {
        title: z.string().optional().describe("Only scan this note; omit to scan the whole vault"),
        limit: z.number().int().positive().max(100).default(20),
      },
    },
    async ({ title, limit }) => {
      let source: Note | undefined;
      if (title) {
        const resolved = await resolveNote(title);
        if (!resolved.note) return textResult(notFoundMessage(title, resolved.suggestion), true);
        source = resolved.note;
      }
      const suggestions = suggestLinks(await vault.loadAll(), source).slice(0, limit);
      if (suggestions.length === 0)
        return textResult("No unlinked mentions found. Everything that can be linked already is.");
      const lines = suggestions.map((x) => `- "${x.from.title}" mentions "${x.phrase}" → link to [[${x.to.title}]]`);
      return textResult(
        `${suggestions.length} possible link(s):\n\n${lines.join("\n")}\n\nApply them with link_mentions.`
      );
    }
  );

  server.registerTool(
    "link_mentions",
    {
      title: "Link Mentions",
      annotations: WRITE,
      description:
        "In one note, turn the first plain-text mention of other notes' titles into [[wiki links]]. Pass targets to link only specific notes; omit it to link every suggestion from suggest_links.",
      inputSchema: {
        title: z.string().describe("The note to add links to"),
        targets: z.array(z.string()).optional().describe("Only link to these note titles"),
      },
    },
    async ({ title, targets }) => {
      const { note, suggestion } = await resolveNote(title);
      if (!note) return textResult(notFoundMessage(title, suggestion), true);

      const wanted = targets ? new Set(targets.map((t) => t.trim().toLowerCase())) : null;
      // Longest titles first, so "Second Brain Architecture" is linked before "Second Brain".
      const candidates = suggestLinks(await vault.loadAll(), note)
        .filter((x) => !wanted || wanted.has(x.to.title.toLowerCase()))
        .sort((a, b) => b.to.title.length - a.to.title.length);

      let body = note.body;
      const linked: string[] = [];
      for (const c of candidates) {
        const next = linkFirstMention(body, c.to.title);
        if (next) {
          body = next;
          linked.push(c.to.title);
        }
      }
      if (linked.length === 0) return textResult(`No unlinked mentions to link in "${note.title}".`);

      await vault.save({ title: note.title, slug: note.slug, tags: note.tags, body, created: note.created });
      return textResult(
        `Linked ${linked.length} mention(s) in "${note.title}": ${linked.map((t) => `[[${t}]]`).join(", ")}`
      );
    }
  );

  server.registerTool(
    "export_vault",
    {
      title: "Export Vault",
      annotations: WRITE,
      description:
        "Export every note and journal entry to a single JSON file for backup or migration. The file is always written inside the vault folder.",
      inputSchema: {
        outputPath: z
          .string()
          .optional()
          .describe("A .json path relative to the vault folder (defaults to exports/vault-export-<date>.json)"),
      },
    },
    async ({ outputPath }) => {
      const root = path.resolve(VAULT_PATH);
      const stamp = new Date().toISOString().slice(0, 10);
      const dest = path.resolve(root, outputPath ?? path.join("exports", `vault-export-${stamp}.json`));
      if (!dest.startsWith(root + path.sep) || path.extname(dest) !== ".json") {
        return textResult("Exports must be .json files inside the vault folder.", true);
      }
      const notes = await vault.loadAll();
      const journal = await loadAllJournalNotes();
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.writeFile(
        dest,
        JSON.stringify({ exportedAt: new Date().toISOString(), notes, journal }, null, 2),
        "utf-8"
      );
      return textResult(
        `Exported ${notes.length} note(s) and ${journal.length} journal entr${journal.length === 1 ? "y" : "ies"} to ${dest}`
      );
    }
  );

  // ---------------------------------------------------------------------------
  // resources
  // ---------------------------------------------------------------------------

  server.registerResource(
    "note",
    new ResourceTemplate("note://{slug}", {
      complete: {
        slug: async (value) =>
          (await vault.listSlugs()).filter((slug) => slug.startsWith(value.toLowerCase())).slice(0, 25),
      },
      list: async () => {
        const notes = await vault.loadAll();
        return {
          resources: notes.map((n) => ({
            uri: `note://${n.slug}`,
            name: n.title,
            description: `${n.tags.join(", ") || "no tags"} · updated ${n.updated.slice(0, 10)}`,
            mimeType: "text/markdown",
          })),
        };
      },
    }),
    { title: "Vault Note", description: "A single note from the second-brain vault", mimeType: "text/markdown" },
    async (uri, variables) => {
      const slug = Array.isArray(variables.slug) ? variables.slug[0] : variables.slug;
      const note = slug ? await vault.load(slug) : null;
      if (!note) {
        return { contents: [{ uri: uri.href, mimeType: "text/plain", text: `No note found at ${uri.href}` }] };
      }
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "text/markdown",
            text: `# ${note.title}\n\nTags: ${note.tags.join(", ") || "none"}\nUpdated: ${note.updated}\n\n${note.body}`,
          },
        ],
      };
    }
  );

  server.registerResource(
    "vault-stats",
    "vault://stats",
    { title: "Vault Stats", description: "Live JSON snapshot of vault statistics", mimeType: "application/json" },
    async (uri) => {
      const notes = await vault.loadAll();
      const journalDates = await vault.listJournalDates();
      const stats = computeStats(notes, journalDates);
      return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(stats, null, 2) }] };
    }
  );

  server.registerResource(
    "vault-graph",
    "vault://graph",
    {
      title: "Vault Link Graph",
      description: "JSON adjacency list of [[wiki link]] connections between notes",
      mimeType: "application/json",
    },
    async (uri) => {
      const notes = await vault.loadAll();
      const graph = buildGraph(notes);
      return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(graph, null, 2) }] };
    }
  );

  // ---------------------------------------------------------------------------
  // prompts
  // ---------------------------------------------------------------------------

  server.registerPrompt(
    "weekly_review",
    {
      title: "Weekly Review",
      description: "Build a prompt summarizing recent journal entries and note activity, asking for a weekly review.",
      argsSchema: { days: z.string().optional().describe("How many days back to include (default 7)") },
    },
    async ({ days }) => {
      const n = days ? Number.parseInt(days, 10) || 7 : 7;
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - n);

      const journalDates = await vault.listJournalDates();
      const recentJournal = (
        await Promise.all(journalDates.filter((d) => new Date(d) >= cutoff).map((d) => vault.loadJournal(d)))
      ).filter((n): n is Note => n !== null);

      const notes = await vault.loadAll();
      const recentNotes = notes.filter((n) => n.updated && new Date(n.updated) >= cutoff);

      const journalText = recentJournal.map((j) => `### ${j.title}\n${j.body}`).join("\n\n");
      const notesText = recentNotes.map((n) => `- ${n.title} (${n.tags.join(", ") || "no tags"})`).join("\n");

      return {
        messages: [
          {
            role: "user" as const,
            content: {
              type: "text" as const,
              text: [
                `Here is my journal and note activity from the last ${n} days.`,
                "",
                "## Journal",
                journalText || "(no journal entries)",
                "",
                "## Notes touched",
                notesText || "(no notes updated)",
                "",
                "Write a short weekly review: what I focused on, open threads worth following up, and one suggestion for next week.",
              ].join("\n"),
            },
          },
        ],
      };
    }
  );

  server.registerPrompt(
    "summarize_note",
    {
      title: "Summarize Note",
      description: "Ask for a concise summary of a specific note plus related-topic suggestions.",
      argsSchema: {
        title: completable(z.string().describe("Note title or slug to summarize"), async (value) => {
          const q = value.toLowerCase();
          return (await vault.loadAll())
            .map((n) => n.title)
            .filter((t) => t.toLowerCase().includes(q))
            .slice(0, 25);
        }),
      },
    },
    async ({ title }) => {
      const { note, suggestion } = await resolveNote(title);
      const text = note
        ? `Summarize the following note in 3-5 sentences, then suggest 2 related topics I might want to note next.\n\n# ${note.title}\n\n${note.body}`
        : notFoundMessage(title, suggestion);
      return { messages: [{ role: "user" as const, content: { type: "text" as const, text } }] };
    }
  );

  server.registerPrompt(
    "daily_plan",
    {
      title: "Daily Plan",
      description: "Plan today from open todos, the last two days of journal entries and recently touched notes.",
    },
    async () => {
      const notes = await vault.loadAll();
      const journal = [...(await vault.loadRecentJournal(2))];
      const todoBlocks: string[] = [];
      for (const n of [...notes, ...(await loadAllJournalNotes())]) {
        const open = extractTodos(n.body).filter((t) => !t.done);
        if (open.length) todoBlocks.push(`**${n.title}**\n${open.map((t) => `- [ ] ${t.text}`).join("\n")}`);
      }
      const recent = [...notes].sort((a, b) => b.updated.localeCompare(a.updated)).slice(0, 5);
      const text = [
        "Help me plan today from what is in my second brain.",
        "",
        "## Open todos",
        todoBlocks.join("\n\n") || "(none)",
        "",
        "## Recent journal",
        journal.map((j) => `### ${j.title}\n${j.body}`).join("\n\n") || "(nothing logged)",
        "",
        "## Recently touched notes",
        recent.map((n) => `- ${n.title}`).join("\n") || "(none)",
        "",
        "Pick the three things that matter most today, name anything that looks stuck or at risk, and suggest the very first action to take. Keep it short.",
      ].join("\n");
      return { messages: [{ role: "user" as const, content: { type: "text" as const, text } }] };
    }
  );

  server.registerPrompt(
    "capture_meeting",
    {
      title: "Capture Meeting",
      description: "Turn raw meeting notes into a structured meeting note with decisions and action items.",
      argsSchema: {
        title: z.string().describe("A title for the meeting note, e.g. 'Roadmap sync 2026-10-19'"),
        notes: z.string().describe("The raw notes or transcript"),
      },
    },
    async ({ title, notes }) => {
      const text = [
        `Turn these raw meeting notes into a structured note titled "${title}".`,
        "",
        '1. Call create_note_from_template with template "meeting", filling attendees and purpose where the notes make them clear.',
        "2. Then call update_note (append: false) to write the Notes, Decisions, Action items and Follow-ups sections. Action items must be '- [ ]' checkboxes with an owner and date when stated.",
        "3. Use search_notes to find people or projects mentioned and add [[wiki links]] to existing notes. Do not invent links.",
        "4. Reply with a three-line summary and list the action items.",
        "",
        "Raw notes:",
        notes,
      ].join("\n");
      return { messages: [{ role: "user" as const, content: { type: "text" as const, text } }] };
    }
  );

  return server;
}
