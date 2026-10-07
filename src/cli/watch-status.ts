/**
 * What the watcher is doing right now, for anything that cannot read its log:
 * `carafe service status`, the menu bar app. One small JSON file, rewritten
 * atomically every tick. Absent when no watcher has run since this file
 * existed (an older watcher still running shows as "unknown", not as stalled).
 */
import { mkdirSync, readFileSync } from "fs";
import { dirname, join } from "path";
import { atomicWriteFileSync } from "../format/store";

export interface WatchStatus {
  version: 1;
  pid: number;
  startedAt: string;
  lastTickAt: string;
  intervalMs: number;
  ticks: number;
  /** cumulative for this watcher process */
  filesImported: number;
  indexed: number;
  indexFailed: number;
  /** sessions still queued for indexing (a young, debounced index does not count) */
  indexBacklog: number;
  lastCaptured: { tool: string; id: string; title: string | null; at: string } | null;
  lastIndexed: { tool: string; id: string; title: string | null; at: string } | null;
  /** the index build in progress; a big session takes minutes and must not read as a stall */
  busy: { tool: string; id: string; title: string | null; eventCount: number; since: string } | null;
  lastError: string | null;
}

export function watchStatusPath(root: string): string {
  return join(root, "state", "watch-status.json");
}

export function newWatchStatus(intervalMs: number, nowIso = new Date().toISOString(), pid = process.pid): WatchStatus {
  return { version: 1, pid, startedAt: nowIso, lastTickAt: nowIso, intervalMs, ticks: 0, filesImported: 0, indexed: 0, indexFailed: 0, indexBacklog: 0, lastCaptured: null, lastIndexed: null, busy: null, lastError: null };
}

export function writeWatchStatus(root: string, status: WatchStatus): void {
  const path = watchStatusPath(root);
  mkdirSync(dirname(path), { recursive: true });
  atomicWriteFileSync(path, JSON.stringify(status));
}

/** null when missing or unreadable; never throws. */
export function readWatchStatus(root: string): WatchStatus | null {
  try {
    const parsed = JSON.parse(readFileSync(watchStatusPath(root), "utf8")) as Partial<WatchStatus>;
    if (parsed.version !== 1 || typeof parsed.lastTickAt !== "string" || typeof parsed.indexBacklog !== "number") return null;
    return parsed as WatchStatus;
  } catch { return null; }
}

/** Milliseconds since the last tick, or null when the stamp is unreadable. */
export function watchStatusAgeMs(status: WatchStatus, nowMs = Date.now()): number | null {
  const then = Date.parse(status.lastTickAt);
  return Number.isFinite(then) ? Math.max(0, nowMs - then) : null;
}
