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

/** Titles shorter than this are too generic to suggest as links. */
const MIN_LINKABLE_TITLE = 4;

function mentionRegex(title: string): RegExp {
  return new RegExp(`(?<![\\w\\[])${escapeRegex(title)}(?![\\w\\]])`, "i");
}

/** Split into prose (even indexes) and existing [[links]] (odd indexes), so links are never edited. */
function splitLinks(body: string): string[] {
  return body.split(/(\[\[[^\]]*\]\])/);
}

/** The text of the first mention of `title` that is not already inside a [[link]], or null. */
export function findMention(body: string, title: string): string | null {
  const re = mentionRegex(title);
  const parts = splitLinks(body);
  for (let i = 0; i < parts.length; i += 2) {
    const match = parts[i]!.match(re);
    if (match) return match[0];
  }
  return null;
}

/** Turn the first unlinked mention of `title` into a [[link]]. Returns the new body, or null if none. */
export function linkFirstMention(body: string, title: string): string | null {
  const re = mentionRegex(title);
  const parts = splitLinks(body);
  for (let i = 0; i < parts.length; i += 2) {
    if (re.test(parts[i]!)) {
      parts[i] = parts[i]!.replace(re, () => `[[${title}]]`);
      return parts.join("");
    }
  }
  return null;
}

export interface LinkSuggestion {
  from: Note;
  to: Note;
  /** The text in `from` that mentions `to`. */
  phrase: string;
}

/**
 * Find notes that mention another note's title without linking to it.
 * If `source` is given only that note is scanned. Pairs that already have a link are skipped.
 */
export function suggestLinks(notes: Note[], source?: Note): LinkSuggestion[] {
  const suggestions: LinkSuggestion[] = [];
  const sources = source ? [source] : notes;
  for (const from of sources) {
    const alreadyLinked = new Set(extractLinks(from.body).map((l) => l.toLowerCase()));
    for (const to of notes) {
      if (to.slug === from.slug || to.title.length < MIN_LINKABLE_TITLE) continue;
      if (alreadyLinked.has(to.title.toLowerCase())) continue;
      const phrase = findMention(from.body, to.title);
      if (phrase) suggestions.push({ from, to, phrase });
    }
  }
  return suggestions;
}

const STOPWORDS = new Set(
  "about above after again also because been before being between both could does doing down during each from further have having here into just more most only other over same should some such than that their them then there these they this those through under until very were what when where which while will with would your".split(
    " "
  )
);

function keywords(text: string): Set<string> {
  const words = text.toLowerCase().match(/[a-z][a-z0-9-]{3,}/g) ?? [];
  return new Set(words.filter((w) => !STOPWORDS.has(w)));
}

export interface RelatedResult {
  note: Note;
  score: number;
  reasons: string[];
}

/** Rank other notes by how related they are to `target`: shared tags, direct links, shared vocabulary. */
export function findRelated(notes: Note[], target: Note, limit = 5): RelatedResult[] {
  const graph = buildGraph(notes);
  const linksOut = new Set(graph.edges.filter((e) => e.from === target.slug).map((e) => e.to));
  const linksIn = new Set(graph.edges.filter((e) => e.to === target.slug).map((e) => e.from));
  const targetTags = new Set(target.tags.map((t) => t.toLowerCase()));
  const targetWords = keywords(`${target.title} ${target.body}`);

  const results: RelatedResult[] = [];
  for (const note of notes) {
    if (note.slug === target.slug) continue;
    let score = 0;
    const reasons: string[] = [];

    const sharedTags = note.tags.filter((t) => targetTags.has(t.toLowerCase()));
    if (sharedTags.length > 0) {
      score += sharedTags.length * 2;
      reasons.push(`shared tags: ${sharedTags.join(", ")}`);
    }
    if (linksOut.has(note.slug)) {
      score += 3;
      reasons.push("linked from this note");
    }
    if (linksIn.has(note.slug)) {
      score += 3;
      reasons.push("links to this note");
    }
    const sharedWords = [...keywords(`${note.title} ${note.body}`)].filter((w) => targetWords.has(w));
    if (sharedWords.length >= 3) {
      score += Math.min(sharedWords.length, 5);
      reasons.push(`shared keywords: ${sharedWords.slice(0, 4).join(", ")}`);
    }

    if (score > 0) results.push({ note, score, reasons });
  }
  return results.sort((a, b) => b.score - a.score).slice(0, limit);
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
