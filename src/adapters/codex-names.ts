/** Codex's append-only session-name index. Source data is always read-only. */
import { readFileSync } from "fs";
import { join } from "path";

export interface CodexThreadName { name: string; updatedAt: string }

export function codexRoot(): string {
  return process.env.CARAFE_CODEX_ROOT ?? join(process.env.HOME!, ".codex");
}

export function codexSessionIndexPath(root = codexRoot()): string {
  return join(root, "session_index.jsonl");
}

export function normalizeCodexThreadName(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 120);
}

function timestampParts(value: string): { wholeMs: number; fraction: string } | null {
  const match = /^(.*?)(?:\.(\d+))?Z$/.exec(value);
  if (!match) return null;
  const wholeMs = Date.parse(`${match[1]}Z`);
  if (!Number.isFinite(wholeMs)) return null;
  return { wholeMs, fraction: (match[2] ?? "").padEnd(9, "0").slice(0, 9) };
}

function newerTimestamp(candidate: string, current: string): boolean {
  const a = timestampParts(candidate);
  const b = timestampParts(current);
  if (!a || !b) return false;
  return a.wholeMs > b.wholeMs || (a.wholeMs === b.wholeMs && a.fraction > b.fraction);
}

export function readCodexThreadNames(root = codexRoot()): Map<string, CodexThreadName> {
  const names = new Map<string, CodexThreadName>();
  let text: string;
  try { text = readFileSync(codexSessionIndexPath(root), "utf8"); }
  catch { return names; }
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line) as Record<string, unknown>;
      if (typeof row.id !== "string" || typeof row.thread_name !== "string" || typeof row.updated_at !== "string") continue;
      const name = normalizeCodexThreadName(row.thread_name);
      if (!name || !timestampParts(row.updated_at)) continue;
      const current = names.get(row.id);
      if (!current || newerTimestamp(row.updated_at, current.updatedAt)) names.set(row.id, { name, updatedAt: row.updated_at });
    } catch { /* one malformed append must not hide the rest of the index */ }
  }
  return names;
}
