export function slugify(title: string): string {
  const slug = title
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "untitled";
}

export function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] : 1 + Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1]);
    }
  }
  return dp[m][n];
}

export function wordCount(text: string): number {
  const trimmed = text.trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
}

export function extractLinks(body: string): string[] {
  const matches = [...body.matchAll(/\[\[([^\]]+)\]\]/g)];
  return [...new Set(matches.map((m) => m[1]!.trim()))];
}

export interface Todo {
  text: string;
  done: boolean;
}

export function extractTodos(body: string): Todo[] {
  const todos: Todo[] = [];
  for (const line of body.split("\n")) {
    const m = line.match(/^\s*-\s*\[([ xX])\]\s*(.+)$/);
    if (m) todos.push({ done: m[1]!.toLowerCase() === "x", text: m[2]!.trim() });
  }
  return todos;
}

export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const OPEN_TODO_LINE = /^(\s*-\s*\[) (\]\s*)(.+)$/;

/** Line numbers and text of unchecked todos whose text contains `needle` (case-insensitive). */
export function findOpenTodoLines(body: string, needle: string): { line: number; text: string }[] {
  const wanted = needle.trim().toLowerCase();
  const found: { line: number; text: string }[] = [];
  body.split("\n").forEach((raw, line) => {
    const m = raw.match(OPEN_TODO_LINE);
    if (m && m[3]!.toLowerCase().includes(wanted)) found.push({ line, text: m[3]!.trim() });
  });
  return found;
}

/** Tick the checkbox on one line of a note body. */
export function checkOffTodoLine(body: string, line: number): { body: string; text: string } {
  const lines = body.split("\n");
  const m = lines[line]?.match(OPEN_TODO_LINE);
  if (!m) throw new Error(`Line ${line} is not an open todo`);
  lines[line] = lines[line]!.replace(OPEN_TODO_LINE, "$1x$2$3");
  return { body: lines.join("\n"), text: m[3]!.trim() };
}
