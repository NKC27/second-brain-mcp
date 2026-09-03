#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { Vault } from "./vault.js";
import { buildGraph, computeStats, computeStreak, searchNotes } from "./search.js";
import { extractLinks, extractTodos, wordCount } from "./util.js";
import { log } from "./logger.js";
import type { Note } from "./types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VAULT_PATH = process.env.VAULT_PATH
  ? path.resolve(process.env.VAULT_PATH)
  : path.join(__dirname, "..", "vault");

const vault = new Vault(VAULT_PATH);

const server = new McpServer(
  { name: "second-brain", version: "1.0.0", title: "Second Brain" },
  {
    instructions:
      "A personal knowledge base backed by plain markdown files on disk. Capture ideas with create_note, " +
      "connect them using [[Wiki Link]] syntax in the body, track quick thoughts with journal_entry, and use " +
      "search_notes, get_backlinks, get_open_todos, and get_stats to navigate and review the vault.",
  }
);

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

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
  return suggestion ? `${base} Did you mean "${suggestion.title}"?` : `${base} Try list_notes to see what's in the vault.`;
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
    description: "Retrieve a note's full content by title or slug. Fuzzy-matches close titles if the exact one isn't found.",
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
    description: "Update an existing note's body and/or tags. Set append=true to add to the end instead of replacing the body.",
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
    return textResult(`Updated "${updated.title}" — ${wordCount(updated.body)} words | tags: ${updated.tags.join(", ") || "none"}`);
  }
);

server.registerTool(
  "delete_note",
  {
    title: "Delete Note",
    description: "Permanently delete a note from the vault.",
    inputSchema: { title: z.string().describe("Note title or slug to delete") },
  },
  async ({ title }) => {
    const { note, suggestion } = await resolveNote(title);
    if (!note) return textResult(notFoundMessage(title, suggestion), true);
    await vault.delete(note.slug);
    return textResult(`Deleted "${note.title}".`);
  }
);

server.registerTool(
  "list_notes",
  {
    title: "List Notes",
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
      return textResult(tag ? `No notes tagged "${tag}".` : "The vault is empty — create your first note with create_note.");
    }
    const lines = notes.map(
      (n) => `- **${n.title}** (${n.slug}) — ${n.tags.join(", ") || "no tags"} — ${wordCount(n.body)}w — updated ${n.updated.slice(0, 10)}`
    );
    return textResult(`${notes.length} note(s):\n\n${lines.join("\n")}`);
  }
);

server.registerTool(
  "search_notes",
  {
    title: "Search Notes",
    description: "Full-text search across the vault, ranked by relevance (title matches weighted higher), with a matching snippet per result.",
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
    const lines = results.map((r, i) => `${i + 1}. **${r.note.title}** (${r.note.slug}, score ${r.score})\n   ${r.snippet}`);
    return textResult(`${results.length} result(s) for "${query}":\n\n${lines.join("\n\n")}`);
  }
);

server.registerTool(
  "journal_entry",
  {
    title: "Quick Journal Capture",
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
  "get_backlinks",
  {
    title: "Get Backlinks",
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
    return textResult(`Notes linking to "${note.title}":\n\n${backlinks.map((n) => `- ${n.title} (${n.slug})`).join("\n")}`);
  }
);

server.registerTool(
  "get_open_todos",
  {
    title: "Get Open Todos",
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
    description: "Show a dashboard of vault statistics: note/word counts, a tag cloud, journal streak, most-linked note, and orphan notes.",
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
      `Notes: ${stats.noteCount}  |  Words: ${stats.totalWords}  |  Journal streak: ${stats.journalStreak} day(s)`,
      stats.mostLinked ? `Most linked: "${stats.mostLinked.title}" (${stats.mostLinked.count} backlinks)` : "Most linked: n/a",
      `Orphan notes (no links in or out): ${stats.orphanCount}`,
      "",
      "Top tags:",
      ...(tagLines.length ? tagLines : ["  (no tags yet)"]),
    ];
    return textResult(lines.join("\n"));
  }
);

server.registerTool(
  "export_vault",
  {
    title: "Export Vault",
    description: "Export every note and journal entry to a single JSON file for backup or migration.",
    inputSchema: {
      outputPath: z.string().optional().describe("Destination file path (defaults to vault-export.json next to the vault)"),
    },
  },
  async ({ outputPath }) => {
    const notes = await vault.loadAll();
    const journal = await loadAllJournalNotes();
    const dest = outputPath ? path.resolve(outputPath) : path.join(VAULT_PATH, "..", "vault-export.json");
    const payload = { exportedAt: new Date().toISOString(), notes, journal };
    await fs.writeFile(dest, JSON.stringify(payload, null, 2), "utf-8");
    return textResult(`Exported ${notes.length} note(s) and ${journal.length} journal entr${journal.length === 1 ? "y" : "ies"} to ${dest}`);
  }
);

// ---------------------------------------------------------------------------
// resources
// ---------------------------------------------------------------------------

server.registerResource(
  "note",
  new ResourceTemplate("note://{slug}", {
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
  { title: "Vault Link Graph", description: "JSON adjacency list of [[wiki link]] connections between notes", mimeType: "application/json" },
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
    argsSchema: { title: z.string().describe("Note title or slug to summarize") },
  },
  async ({ title }) => {
    const { note, suggestion } = await resolveNote(title);
    const text = note
      ? `Summarize the following note in 3-5 sentences, then suggest 2 related topics I might want to note next.\n\n# ${note.title}\n\n${note.body}`
      : notFoundMessage(title, suggestion);
    return { messages: [{ role: "user" as const, content: { type: "text" as const, text } }] };
  }
);

// ---------------------------------------------------------------------------
// entry point
// ---------------------------------------------------------------------------

async function main() {
  await vault.init();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log("second-brain MCP server connected via stdio, vault at", VAULT_PATH);
}

main().catch((err) => {
  console.error("Fatal error starting second-brain MCP server:", err);
  process.exit(1);
});
