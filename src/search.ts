import type { Note } from "./types.js";
import { escapeRegex, extractLinks, wordCount } from "./util.js";

export interface SearchResult {
  note: Note;
  score: number;
  snippet: string;
}

export function searchNotes(notes: Note[], query: string, tag?: string): SearchResult[] {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [];

  const results: SearchResult[] = [];
  for (const note of notes) {
    if (tag && !note.tags.some((t) => t.toLowerCase() === tag.toLowerCase())) continue;

    const titleLower = note.title.toLowerCase();
    const bodyLower = note.body.toLowerCase();
    let score = 0;
    for (const term of terms) {
      const re = new RegExp(escapeRegex(term), "g");
      score += (titleLower.match(re)?.length ?? 0) * 5;
      score += bodyLower.match(re)?.length ?? 0;
    }
    if (score > 0) {
      results.push({ note, score, snippet: buildSnippet(note.body, terms[0]!) });
    }
  }
  return results.sort((a, b) => b.score - a.score);
}

function buildSnippet(body: string, term: string, radius = 60): string {
  const idx = body.toLowerCase().indexOf(term.toLowerCase());
  if (idx === -1) return `${body.slice(0, 120).replace(/\n/g, " ")}...`;
  const start = Math.max(0, idx - radius);
  const end = Math.min(body.length, idx + term.length + radius);
  const prefix = start > 0 ? "..." : "";
  const suffix = end < body.length ? "..." : "";
  return prefix + body.slice(start, end).replace(/\n/g, " ") + suffix;
}

export interface GraphEdge {
  from: string;
  to: string;
}

export interface Graph {
  nodes: { id: string; title: string; tags: string[] }[];
  edges: GraphEdge[];
  orphans: string[];
}

export function buildGraph(notes: Note[]): Graph {
  const byTitleLower = new Map(notes.map((n) => [n.title.toLowerCase(), n]));
  const edges: GraphEdge[] = [];
  const linkedTo = new Set<string>();
  const linkedFrom = new Set<string>();

  for (const note of notes) {
    for (const link of extractLinks(note.body)) {
      const target = byTitleLower.get(link.toLowerCase());
      if (target && target.slug !== note.slug) {
        edges.push({ from: note.slug, to: target.slug });
        linkedTo.add(target.slug);
        linkedFrom.add(note.slug);
      }
    }
  }

  const orphans = notes.filter((n) => !linkedTo.has(n.slug) && !linkedFrom.has(n.slug)).map((n) => n.slug);

  return {
    nodes: notes.map((n) => ({ id: n.slug, title: n.title, tags: n.tags })),
    edges,
    orphans,
  };
}

export interface VaultStats {
  noteCount: number;
  totalWords: number;
  tagCounts: Record<string, number>;
  mostLinked: { slug: string; title: string; count: number } | null;
  orphanCount: number;
  journalStreak: number;
}

export function computeStats(notes: Note[], journalDates: string[]): VaultStats {
  const tagCounts: Record<string, number> = {};
  let totalWords = 0;
  for (const n of notes) {
    totalWords += wordCount(n.body);
    for (const t of n.tags) tagCounts[t] = (tagCounts[t] ?? 0) + 1;
  }

  const graph = buildGraph(notes);
  const incoming: Record<string, number> = {};
  for (const e of graph.edges) incoming[e.to] = (incoming[e.to] ?? 0) + 1;

  let mostLinked: VaultStats["mostLinked"] = null;
  for (const [slug, count] of Object.entries(incoming)) {
    const note = notes.find((n) => n.slug === slug);
    if (note && (!mostLinked || count > mostLinked.count)) {
      mostLinked = { slug, title: note.title, count };
    }
  }

  return {
    noteCount: notes.length,
    totalWords,
    tagCounts,
    mostLinked,
    orphanCount: graph.orphans.length,
    journalStreak: computeStreak(journalDates),
  };
}

export function computeStreak(dates: string[]): number {
  if (dates.length === 0) return 0;
  const set = new Set(dates);
  let streak = 0;
  const cursor = new Date();
  const todayStr = cursor.toISOString().slice(0, 10);
  if (!set.has(todayStr)) cursor.setDate(cursor.getDate() - 1);
  while (set.has(cursor.toISOString().slice(0, 10))) {
    streak += 1;
    cursor.setDate(cursor.getDate() - 1);
  }
  return streak;
}
