import fs from "node:fs/promises";
import path from "node:path";
import matter from "gray-matter";
import type { Note } from "./types.js";
import { BUILT_IN_TEMPLATES, type Template } from "./templates.js";
import { escapeRegex, levenshtein, slugify } from "./util.js";

interface SaveInput {
  title: string;
  body: string;
  tags: string[];
  slug?: string;
  created?: string;
}

export class Vault {
  readonly root: string;
  private readonly notesDir: string;
  private readonly journalDir: string;
  private readonly templatesDir: string;
  private readonly trashDir: string;

  constructor(root: string) {
    this.root = root;
    this.notesDir = path.join(root, "notes");
    this.journalDir = path.join(root, "journal");
    this.templatesDir = path.join(root, "templates");
    this.trashDir = path.join(root, ".trash");
  }

  async init(): Promise<void> {
    await fs.mkdir(this.notesDir, { recursive: true });
    await fs.mkdir(this.journalDir, { recursive: true });
  }

  /**
   * Resolve a file name inside `dir`, refusing anything that is not a plain file name there.
   * Names reach this code from tool arguments and resource URIs, so a name like `../../x` must never escape the vault.
   */
  private inside(dir: string, fileName: string): string {
    const base = path.resolve(dir);
    const full = path.resolve(base, fileName);
    if (path.dirname(full) !== base) throw new Error(`Invalid file name: ${JSON.stringify(fileName)}`);
    return full;
  }

  private notePath(slug: string): string {
    return this.inside(this.notesDir, `${slug}.md`);
  }

  private journalPath(date: string): string {
    return this.inside(this.journalDir, `${date}.md`);
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

  /**
   * Remove a note. By default it is moved to `.trash/` so it can be restored;
   * pass `{ trash: false }` to delete the file outright (used internally by rename).
   */
  async delete(slug: string, options: { trash?: boolean } = {}): Promise<boolean> {
    try {
      const from = this.notePath(slug);
      if (options.trash === false) {
        await fs.unlink(from);
      } else {
        await fs.mkdir(this.trashDir, { recursive: true });
        const stamp = new Date()
          .toISOString()
          .replace(/[-:]/g, "")
          .replace(/\.\d+Z$/, "Z");
        await fs.rename(from, path.join(this.trashDir, `${slug}--${stamp}.md`));
      }
      return true;
    } catch {
      return false;
    }
  }

  /** Restore the most recently trashed note matching a slug or title. */
  async restore(query: string): Promise<Note | null> {
    const wantedSlug = slugify(query);
    const wantedTitle = query.trim().toLowerCase();
    const files = (await fs.readdir(this.trashDir).catch(() => [] as string[])).filter((f) => f.endsWith(".md"));

    const candidates: { file: string; slug: string; title: string }[] = [];
    for (const file of files) {
      const slug = file.slice(0, file.lastIndexOf("--"));
      const parsed = matter(await fs.readFile(path.join(this.trashDir, file), "utf-8"));
      const title = typeof parsed.data.title === "string" ? parsed.data.title : slug;
      if (slug === wantedSlug || title.toLowerCase() === wantedTitle) candidates.push({ file, slug, title });
    }
    const latest = candidates.sort((a, b) => b.file.localeCompare(a.file))[0];
    if (!latest) return null;

    const slug = (await this.load(latest.slug)) ? await this.uniqueSlug(latest.slug) : latest.slug;
    await fs.rename(path.join(this.trashDir, latest.file), this.notePath(slug));
    return this.load(slug);
  }

  /** Rewrite [[old]] to [[new]] in every note and journal entry. Returns how many files changed. */
  async rewriteLinks(oldTitle: string, newTitle: string): Promise<number> {
    const re = new RegExp(`\\[\\[\\s*${escapeRegex(oldTitle)}\\s*\\]\\]`, "gi");
    const files = [
      ...(await this.listSlugs()).map((s) => this.notePath(s)),
      ...(await this.listJournalDates()).map((d) => this.journalPath(d)),
    ];
    let changed = 0;
    for (const file of files) {
      const parsed = matter(await fs.readFile(file, "utf-8"));
      const next = parsed.content.replace(re, () => `[[${newTitle}]]`);
      if (next === parsed.content) continue;
      const frontmatter = { ...parsed.data, updated: new Date().toISOString() };
      await fs.writeFile(file, matter.stringify(next, frontmatter), "utf-8");
      changed += 1;
    }
    return changed;
  }

  /** Give a note a new title (and slug), updating every [[link]] that pointed at the old title. */
  async rename(note: Note, newTitle: string): Promise<{ note: Note; linksUpdated: number }> {
    const newSlug = slugify(newTitle);
    if (newSlug !== note.slug && (await this.load(newSlug))) {
      throw new Error(`A note with the slug "${newSlug}" already exists`);
    }
    await this.save({ title: newTitle, slug: newSlug, tags: note.tags, body: note.body, created: note.created });
    if (newSlug !== note.slug) await this.delete(note.slug, { trash: false });
    const linksUpdated = await this.rewriteLinks(note.title, newTitle);
    const renamed = await this.load(newSlug);
    if (!renamed) throw new Error(`Failed to read back note "${newSlug}" after renaming`);
    return { note: renamed, linksUpdated };
  }

  // ---------- templates ----------

  /** Built-in templates plus any `templates/*.md` in the vault (custom ones win on id clashes). */
  async listTemplates(): Promise<Template[]> {
    const custom: Template[] = [];
    const files = await fs.readdir(this.templatesDir).catch(() => [] as string[]);
    for (const file of files.filter((f) => f.endsWith(".md"))) {
      const parsed = matter(await fs.readFile(path.join(this.templatesDir, file), "utf-8"));
      const id = file.slice(0, -3);
      const data = parsed.data as Record<string, unknown>;
      custom.push({
        id,
        name: typeof data.name === "string" ? data.name : id,
        description: typeof data.description === "string" ? data.description : "Custom template",
        tags: Array.isArray(data.tags) ? data.tags.map(String) : [],
        body: parsed.content.trim(),
        source: "custom",
      });
    }
    const customIds = new Set(custom.map((t) => t.id));
    return [...custom, ...BUILT_IN_TEMPLATES.filter((t) => !customIds.has(t.id))];
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

  /** Replace the body of an existing journal day, keeping its frontmatter. */
  async writeJournalBody(date: string, body: string): Promise<void> {
    const file = this.journalPath(date);
    const parsed = matter(await fs.readFile(file, "utf-8"));
    const frontmatter = { ...parsed.data, updated: new Date().toISOString() };
    await fs.writeFile(file, matter.stringify(`${body.trim()}\n`, frontmatter), "utf-8");
  }

  /** Journal entries from the last `days` calendar days (including today), oldest first. */
  async loadRecentJournal(days: number): Promise<Note[]> {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - (days - 1));
    const cutoffStr = cutoff.toISOString().slice(0, 10);
    const dates = (await this.listJournalDates()).filter((d) => d >= cutoffStr);
    const notes = await Promise.all(dates.map((d) => this.loadJournal(d)));
    return notes.filter((n): n is Note => n !== null);
  }
}
