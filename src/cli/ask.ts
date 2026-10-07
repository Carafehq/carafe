import { existsSync } from "fs";
import type { SessionDistillate } from "../format/distillate";
import { readSession } from "../format/sessions";
import { CarafeStore } from "../format/store";
import { currentSession, findSession, latestSession } from "../query/sessions";
import {
  ASK_KINDS, SessionIndex, buildSessionIndex, sessionIndexPath,
  backfillSessionIndexes,
  type AskKind, type AskOptions, type AskOverview, type AskRow,
} from "../search/session-index";

export interface AskCliOptions extends AskOptions { json?: boolean; noBuild?: boolean }

export function resolveIndexedSession(store: CarafeStore, sessionArg: string): SessionDistillate | null {
  return sessionArg === "latest" ? latestSession(store) : sessionArg === "current" ? currentSession(store) : findSession(store, sessionArg);
}

export class SessionIndexUnavailableError extends Error {}

export function openFreshSessionIndex(
  store: CarafeStore,
  session: SessionDistillate,
  opts: { noBuild?: boolean; rebuild?: boolean; onBuild?: (reason: "missing" | "stale" | "rebuild") => void } = {},
): SessionIndex {
  const exists = existsSync(sessionIndexPath(store, session));
  if (!exists && opts.noBuild) throw new SessionIndexUnavailableError(`session index missing for ${session.sessionId}; run: carafe index ${session.sessionId}`);
  const index = new SessionIndex(store, session);
  const stale = index.isStale();
  if ((stale || opts.rebuild) && opts.noBuild) {
    index.close();
    throw new SessionIndexUnavailableError(`session index stale for ${session.sessionId}; run: carafe index ${session.sessionId}`);
  }
  if (stale || opts.rebuild) {
    opts.onBuild?.(opts.rebuild ? "rebuild" : exists ? "stale" : "missing");
    index.reindex({ force: opts.rebuild });
  }
  return index;
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function countPhrase(value: number, noun: string): string {
  return `${value} ${noun}${value === 1 ? "" : "s"}`;
}

export function formatAskOverview(overview: AskOverview): string {
  const shown = overview.chapters.slice(0, 12);
  const lines = shown.map((chapter) => {
    const place = chapter.branch ?? chapter.cwd ?? "unknown";
    return `Ch ${chapter.chapterIdx} · ${place} · [seq ${chapter.startSeq}–${chapter.endSeq}] · ${countPhrase(chapter.turns, "turn")} · ${countPhrase(chapter.moments, "moment")} · ${countPhrase(chapter.failures, "failed run")}`;
  });
  if (overview.chapters.length > shown.length) lines.push(`… ${overview.chapters.length - shown.length} earlier chapters`);
  const kinds = Object.keys(overview.entities).sort();
  if (kinds.length) {
    lines.push("", "Top entities");
    for (const kind of kinds) lines.push(`  ${kind}: ${(overview.entities[kind] ?? []).map((entity) => `${entity.value} (${entity.count})`).join(", ")}`);
  }
  return lines.join("\n");
}

export function formatAskRows(rows: AskRow[]): string {
  if (!rows.length) return "no structured matches.";
  const lines: string[] = [];
  let chapter = -1;
  for (const row of rows) {
    if (row.chapterIdx !== chapter) {
      chapter = row.chapterIdx;
      lines.push(`${lines.length ? "\n" : ""}Ch ${row.chapterIdx} · ${row.branch ?? row.cwd ?? "unknown"} · [seq ${row.chapterStartSeq}–${row.chapterEndSeq}]`);
    }
    if (row.type === "moment") {
      const range = row.endSeq != null && row.endSeq !== row.seq ? `–${row.endSeq}` : "";
      const body = `${oneLine(row.text ?? "")}${row.note ? ` → ${oneLine(row.note)}` : ""}`;
      lines.push(`  ${(row.kind === "deadend" ? "dead end" : row.kind ?? "moment").padEnd(9)} [seq ${row.seq}${range}] ${body}`);
    } else if (row.type === "turn") {
      const range = row.endSeq != null && row.endSeq !== row.seq ? `–${row.endSeq}` : "";
      lines.push(`  turn      [seq ${row.seq}${range}] ${oneLine(row.text ?? "").slice(0, 90)}${row.note ? ` (${row.note})` : ""}`);
    } else {
      const outcome = row.ok ? "passed" : "failed";
      const detail = row.excerpt ? ` (${oneLine(row.excerpt)})` : "";
      lines.push(`  run       [seq ${row.seq}] ${oneLine(row.command ?? row.family ?? "")} → ${outcome}${detail}`);
    }
  }
  return lines.join("\n");
}

export function runAsk(sessionArg: string, opts: AskCliOptions = {}): void {
  const store = new CarafeStore();
  const session = resolveIndexedSession(store, sessionArg);
  if (!session) { console.error(`session not found: ${sessionArg}`); process.exit(1); }
  if (opts.kind && !ASK_KINDS.includes(opts.kind)) {
    console.error(`unknown kind: ${opts.kind}; choose ${ASK_KINDS.join(" | ")}`);
    process.exit(1);
  }
  let index: SessionIndex;
  try {
    index = openFreshSessionIndex(store, session, {
      noBuild: opts.noBuild,
      onBuild: (reason) => process.stderr.write(`session index ${reason}; building ${session.sessionId}…\n`),
    });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
  try {
    const filtered = !!(opts.file || opts.kind || opts.chapter != null || opts.failed || opts.command || opts.branch);
    if (!filtered) {
      const overview = index.overview();
      console.log(opts.json ? JSON.stringify(overview, null, 2) : formatAskOverview(overview));
    } else {
      const rows = index.ask(opts);
      console.log(opts.json ? JSON.stringify(rows, null, 2) : formatAskRows(rows));
    }
  } finally { index.close(); }
}

export function runSessionIndex(sessionArg: string, opts: { rebuild?: boolean } = {}): void {
  const store = new CarafeStore();
  const session = resolveIndexedSession(store, sessionArg);
  if (!session) { console.error(`session not found: ${sessionArg}`); process.exit(1); }
  const result = buildSessionIndex(store, session, readSession(store, session.tool, session.sessionId), { force: opts.rebuild });
  console.log(`${result.rebuilt ? "built" : "current"}: ${sessionIndexPath(store, session)}`);
  for (const [table, count] of Object.entries(result.counts)) console.log(`  ${table}: ${count}`);
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${bytes}B`;
}

export function runSessionIndexBackfill(opts: { cwd?: string; sinceDays?: number; minEvents?: number; perCwd?: number; everything?: boolean } = {}): void {
  const store = new CarafeStore();
  const result = backfillSessionIndexes(store, {
    ...opts,
    onProgress: (processed, total) => console.log(`indexing: ${processed}/${total}`),
  });
  for (const failure of result.failed) console.error(`index failed ${failure.tool} ${failure.id}: ${failure.error}`);
  console.log(
    `index backfill: ${result.built} built, ${result.skippedFresh} skipped fresh, ${result.skippedSmall} skipped small, ` +
    `${result.skippedCapped} beyond the per-directory cap, ${result.skippedFiltered} filtered` +
    `${result.failed.length ? `, ${result.failed.length} failed` : ""}, ${formatBytes(result.totalBytes)} on disk`,
  );
}

export function parseAskKind(value: string | undefined): AskKind | undefined {
  return value as AskKind | undefined;
}
