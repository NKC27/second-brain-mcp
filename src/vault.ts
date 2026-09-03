import fs from "node:fs/promises";
import path from "node:path";
import matter from "gray-matter";
import type { Note } from "./types.js";
import { levenshtein, slugify } from "./util.js";

interface SaveInput {
  title: string;
  body: string;
  tags: string[];
  slug?: string;
  created?: string;
}

export class Vault {
  private readonly notesDir: string;
  private readonly journalDir: string;

  constructor(root: string) {
    this.notesDir = path.join(root, "notes");
    this.journalDir = path.join(root, "journal");
  }

  async init(): Promise<void> {
    await fs.mkdir(this.notesDir, { recursive: true });
    await fs.mkdir(this.journalDir, { recursive: true });
  }

  private notePath(slug: string): string {
    return path.join(this.notesDir, `${slug}.md`);
  }

  private journalPath(date: string): string {
    return path.join(this.journalDir, `${date}.md`);
  }

  async listSlugs(): Promise<string[]> {
    const files = await fs.readdir(this.notesDir).catch(() => [] as string[]);
    return files.filter((f) => f.endsWith(".md")).map((f) => f.slice(0, -3));
  }

  async load(slug: string): Promise<Note | null> {
    try {
      const raw = await fs.readFile(this.notePath(slug), "utf-8");
      const parsed = matter(raw);
      const data = parsed.data as Record<string, unknown>;
      return {
        slug,
        title: typeof data.title === "string" ? data.title : slug,
        tags: Array.isArray(data.tags) ? data.tags.map(String) : [],
        created: typeof data.created === "string" ? data.created : "",
        updated: typeof data.updated === "string" ? data.updated : "",
        body: parsed.content.trim(),
        path: this.notePath(slug),
      };
    } catch {
      return null;
    }
  }

  async loadAll(): Promise<Note[]> {
    const slugs = await this.listSlugs();
    const notes = await Promise.all(slugs.map((s) => this.load(s)));
    return notes.filter((n): n is Note => n !== null);
  }

  /** Resolve a user-supplied string to a note by exact slug, then exact title. */
  async findBySlugOrTitle(query: string): Promise<Note | null> {
    const bySlug = await this.load(slugify(query));
    if (bySlug) return bySlug;
    const all = await this.loadAll();
    return all.find((n) => n.title.toLowerCase() === query.trim().toLowerCase()) ?? null;
  }

  /** Best-effort fuzzy match, used to power "did you mean" suggestions. */
  async suggestClosest(query: string): Promise<Note | null> {
    const notes = await this.loadAll();
    const q = query.trim().toLowerCase();
    if (!q || notes.length === 0) return null;
    let best: { note: Note; score: number } | null = null;
    for (const note of notes) {
      const t = note.title.toLowerCase();
      const containment = t.includes(q) || q.includes(t);
      const score = containment
        ? Math.min(t.length, q.length) / Math.max(t.length, q.length)
        : 1 - levenshtein(t, q) / Math.max(t.length, q.length, 1);
      if (!best || score > best.score) best = { note, score };
    }
    return best && best.score >= 0.4 ? best.note : null;
  }

  async uniqueSlug(base: string): Promise<string> {
    let slug = base;
    let n = 2;
    while (await this.load(slug)) {
      slug = `${base}-${n}`;
      n += 1;
    }
    return slug;
  }

  async save(input: SaveInput): Promise<Note> {
    const slug = input.slug ?? (await this.uniqueSlug(slugify(input.title)));
    const now = new Date().toISOString();
    const frontmatter = {
      title: input.title,
      tags: input.tags,
      created: input.created ?? now,
      updated: now,
    };
    const content = matter.stringify(`${input.body.trim()}\n`, frontmatter);
    await fs.writeFile(this.notePath(slug), content, "utf-8");
    const saved = await this.load(slug);
    if (!saved) throw new Error(`Failed to read back note "${slug}" after saving`);
    return saved;
  }

  async delete(slug: string): Promise<boolean> {
    try {
      await fs.unlink(this.notePath(slug));
      return true;
    } catch {
      return false;
    }
  }

  // ---------- journal ----------

  async listJournalDates(): Promise<string[]> {
    const files = await fs.readdir(this.journalDir).catch(() => [] as string[]);
    return files
      .filter((f) => f.endsWith(".md"))
      .map((f) => f.slice(0, -3))
      .sort();
  }

  async loadJournal(date: string): Promise<Note | null> {
    try {
      const raw = await fs.readFile(this.journalPath(date), "utf-8");
      const parsed = matter(raw);
      const data = parsed.data as Record<string, unknown>;
      return {
        slug: `journal-${date}`,
        title: typeof data.title === "string" ? data.title : `Journal — ${date}`,
        tags: Array.isArray(data.tags) ? data.tags.map(String) : ["journal"],
        created: typeof data.created === "string" ? data.created : "",
        updated: typeof data.updated === "string" ? data.updated : "",
        body: parsed.content.trim(),
        path: this.journalPath(date),
      };
    } catch {
      return null;
    }
  }

  async appendJournal(text: string): Promise<{ date: string; path: string }> {
    const now = new Date();
    const date = now.toISOString().slice(0, 10);
    const time = now.toTimeString().slice(0, 5);
    const p = this.journalPath(date);

    let existingRaw = "";
    try {
      existingRaw = await fs.readFile(p, "utf-8");
    } catch {
      // no entry for today yet
    }

    const parsed = matter(
      existingRaw || matter.stringify("", { title: `Journal — ${date}`, tags: ["journal"], created: now.toISOString() })
    );
    const body = `${parsed.content.trim()}\n\n- **${time}** ${text}`.trim();
    const frontmatter = { ...parsed.data, updated: now.toISOString() };
    await fs.writeFile(p, matter.stringify(`${body}\n`, frontmatter), "utf-8");
    return { date, path: p };
  }
}
