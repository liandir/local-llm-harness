/**
 * Shared todo-list types and helpers for the `update_todos` tool.
 *
 * The list is conversation-level state: each `update_todos` call replaces it
 * wholesale (latest wins), so the model re-sends the full list with updated
 * statuses every time. Helpers here are deliberately lenient about model output
 * — small local models drop fields and mangle casing — and never throw.
 */

export type TodoStatus = "pending" | "in_progress" | "completed";

export interface TodoItem {
  content: string;
  status: TodoStatus;
}

const STATUSES: ReadonlySet<string> = new Set(["pending", "in_progress", "completed"]);

/** Most a single `update_todos` call (or a seeded plan) may contribute. */
export const MAX_TODOS = 50;

/**
 * Coerce arbitrary model output into a clean todo list. Accepts `{ todos: [...] }`
 * or a bare array; tolerates string items, missing/odd statuses, and synonyms.
 * Items with empty content are dropped; an unrecognized status falls back to
 * "pending". Never throws.
 */
export function normalizeTodos(raw: unknown): TodoItem[] {
  const arr = extractArray(raw);
  const out: TodoItem[] = [];
  for (const entry of arr) {
    const item = normalizeItem(entry);
    if (item) out.push(item);
    if (out.length >= MAX_TODOS) break;
  }
  return out;
}

function extractArray(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    const nested = obj.todos ?? obj.items ?? obj.list ?? obj.tasks ?? obj.steps;
    if (Array.isArray(nested)) return nested;
  }
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
      try { return extractArray(JSON.parse(trimmed)); } catch { /* fall through */ }
    }
  }
  return [];
}

function normalizeItem(entry: unknown): TodoItem | undefined {
  if (typeof entry === "string") {
    const content = entry.trim();
    return content ? { content, status: "pending" } : undefined;
  }
  if (!entry || typeof entry !== "object") return undefined;
  const obj = entry as Record<string, unknown>;
  const rawContent = obj.content ?? obj.text ?? obj.title ?? obj.task ?? obj.step ?? obj.name;
  const content = typeof rawContent === "string" ? rawContent.trim() : "";
  if (!content) return undefined;
  return { content, status: normalizeStatus(obj.status ?? obj.state) };
}

function normalizeStatus(raw: unknown): TodoStatus {
  if (typeof raw !== "string") return "pending";
  const s = raw.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (STATUSES.has(s)) return s as TodoStatus;
  if (s === "in_progress" || s === "inprogress" || s === "active" || s === "doing" || s === "started") {
    return "in_progress";
  }
  if (s === "done" || s === "complete" || s === "completed" || s === "finished") return "completed";
  return "pending";
}

/** Completed vs total — drives the `Update Todos (done/total)` collapsed label. */
export function todoCounts(todos: TodoItem[]): { done: number; total: number } {
  return {
    done: todos.filter(t => t.status === "completed").length,
    total: todos.length
  };
}

/**
 * Render the list as a GitHub-flavored markdown checklist. Completed items get
 * `- [x]`; everything else `- [ ]`, with an in-progress item flagged so the fed-
 * back tool result keeps the model aware of where it is.
 */
export function renderTodosMarkdown(todos: TodoItem[]): string {
  return todos
    .map(t => {
      const box = t.status === "completed" ? "[x]" : "[ ]";
      const tag = t.status === "in_progress" ? " (in progress)" : "";
      return `- ${box} ${t.content}${tag}`;
    })
    .join("\n");
}

/**
 * Extract checklist items from an accepted plan's markdown so they can seed the
 * todo list. Matches bullet (`-`, `*`, `+`) and numbered (`1.`, `1)`) items,
 * with or without a `[ ]`/`[x]` checkbox; everything starts as "pending".
 */
export function parsePlanChecklist(markdown: string): TodoItem[] {
  const out: TodoItem[] = [];
  const line = /^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s*)?(.+?)\s*$/;
  for (const raw of markdown.split(/\r?\n/)) {
    const m = line.exec(raw);
    if (!m) continue;
    const content = m[1].trim();
    if (!content) continue;
    out.push({ content, status: "pending" });
    if (out.length >= MAX_TODOS) break;
  }
  return out;
}
