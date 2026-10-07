/**
 * The watcher's heartbeat, read by something OUTSIDE the watcher.
 *
 * The in-process watchdog cannot fire while the watcher's only thread is
 * blocked in the kernel (a first open of ~/Documents waiting on a macOS
 * permission prompt blocks it for as long as nobody answers). So the watcher
 * also leaves a small file behind at every completed tick and every stage it
 * enters, and the menu bar app — a different process — judges it every minute
 * through `carafe service watchdog`. The judgement is a pure function of the
 * file, the clock and two remembered times, so it is tested with an injected
 * clock; nothing here restarts anything by itself.
 */
import { mkdirSync, readFileSync } from "fs";
import { dirname, join } from "path";
import { atomicWriteFileSync } from "../format/store";

/** What the watcher is doing. `protected-folder` means: inside the first open of
 *  `folder`, which is where a macOS permission prompt holds a process. */
export type HeartbeatStage = "starting" | "first import" | "tick" | "idle" | "indexing" | "protected-folder";

export interface WatchHeartbeat {
  version: 1;
  pid: number;
  startedAt: string;
  /** when this file was last written: the heartbeat itself */
  at: string;
  /** when the last tick completed; null before the first one */
  lastTickAt: string | null;
  stage: HeartbeatStage;
  /** detail for the stage: the import stage, the session being indexed, the folder being opened */
  detail: string | null;
  stageSince: string;
  /** protected folders this watcher was refused (skipped until it restarts) */
  deniedFolders: string[];
  /** After a (re)start: the backlog the watcher is still working through once
   *  capture itself is current; null when there is none. Absent in heartbeats
   *  written by older watchers. */
  catchingUp?: CatchUpSummary | null;
}

/** What is left of the startup backlog. `indexPlanned` is false until the
 *  index backfill plan has run (until then `indexQueued` counts only the
 *  sessions captured at startup). */
export interface CatchUpSummary {
  snapshotsQueued: number;
  indexQueued: number;
  indexPlanned: boolean;
  since: string;
}

export const HEARTBEAT_STALE_MS = 5 * 60 * 1000;
/** A single index build of a very large session legitimately runs for minutes. */
export const HEARTBEAT_BUILD_STALE_MS = 15 * 60 * 1000;
export const AUTO_RESTART_MIN_INTERVAL_MS = 30 * 60 * 1000;
export const WATCHDOG_CHECK_INTERVAL_MS = 60 * 1000;

export function heartbeatPath(root: string): string {
  return join(root, "state", "watch-heartbeat.json");
}

export function newHeartbeat(nowIso = new Date().toISOString(), pid = process.pid): WatchHeartbeat {
  return { version: 1, pid, startedAt: nowIso, at: nowIso, lastTickAt: null, stage: "starting", detail: null, stageSince: nowIso, deniedFolders: [], catchingUp: null };
}

/** Enter a stage (the stamp moves only when the stage or its detail changes). */
export function enterStage(hb: WatchHeartbeat, stage: HeartbeatStage, detail: string | null = null, nowIso = new Date().toISOString()): void {
  if (hb.stage !== stage || hb.detail !== detail) hb.stageSince = nowIso;
  hb.stage = stage;
  hb.detail = detail;
}

/** Atomic (temp + rename): a reader never sees half a file. */
export function writeHeartbeat(root: string, hb: WatchHeartbeat, nowIso = new Date().toISOString()): void {
  hb.at = nowIso;
  const path = heartbeatPath(root);
  mkdirSync(dirname(path), { recursive: true });
  atomicWriteFileSync(path, JSON.stringify(hb));
}

/** null when missing or unreadable; never throws. */
export function readHeartbeat(root: string): WatchHeartbeat | null {
  try {
    const parsed = JSON.parse(readFileSync(heartbeatPath(root), "utf8")) as Partial<WatchHeartbeat>;
    if (parsed.version !== 1 || typeof parsed.at !== "string" || typeof parsed.pid !== "number" || typeof parsed.stage !== "string") return null;
    return { ...parsed, deniedFolders: Array.isArray(parsed.deniedFolders) ? parsed.deniedFolders : [], catchingUp: validCatchUp(parsed.catchingUp) } as WatchHeartbeat;
  } catch { return null; }
}

function validCatchUp(value: unknown): CatchUpSummary | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Partial<CatchUpSummary>;
  if (typeof v.snapshotsQueued !== "number" || typeof v.indexQueued !== "number" || typeof v.since !== "string") return null;
  return { snapshotsQueued: v.snapshotsQueued, indexQueued: v.indexQueued, indexPlanned: v.indexPlanned !== false, since: v.since };
}

/** Is the watcher still starting up: before its first completed tick (the
 *  first import), or working through the backlog it deferred to get there. */
export type StartupPhase =
  | { phase: "first import"; stage: string | null }
  | { phase: "catching up"; summary: CatchUpSummary };

export function startupPhase(hb: WatchHeartbeat | null): StartupPhase | null {
  if (!hb) return null;
  if (!hb.lastTickAt && (hb.stage === "starting" || hb.stage === "first import" || hb.stage === "protected-folder")) {
    return { phase: "first import", stage: hb.stage === "first import" ? hb.detail : null };
  }
  if (hb.catchingUp) return { phase: "catching up", summary: hb.catchingUp };
  return null;
}

/** One line for people: "starting up — catching up (snapshots 12 left, index 40 left)". */
export function describeStartup(p: StartupPhase): string {
  if (p.phase === "first import") return `starting up — capturing sessions${p.stage ? ` (${p.stage})` : ""}`;
  const s = p.summary;
  const index = s.indexPlanned ? `index ${s.indexQueued} left` : `index ${s.indexQueued}+ left, planning`;
  return `starting up — catching up (snapshots ${s.snapshotsQueued} left, ${index})`;
}

/* ------------------------------------------------------------------ *
 * The judgement.
 * ------------------------------------------------------------------ */

/** What the outside watchdog remembers between checks. */
export interface WatchdogMemory {
  version: 1;
  lastCheckAt: string | null;
  lastAutoRestartAt: string | null;
}

export function watchdogMemoryPath(root: string): string {
  return join(root, "state", "watch-watchdog.json");
}

export function readWatchdogMemory(root: string): WatchdogMemory {
  try {
    const parsed = JSON.parse(readFileSync(watchdogMemoryPath(root), "utf8")) as Partial<WatchdogMemory>;
    if (parsed.version === 1) return { version: 1, lastCheckAt: parsed.lastCheckAt ?? null, lastAutoRestartAt: parsed.lastAutoRestartAt ?? null };
  } catch { /* first check */ }
  return { version: 1, lastCheckAt: null, lastAutoRestartAt: null };
}

export function writeWatchdogMemory(root: string, memory: WatchdogMemory): void {
  const path = watchdogMemoryPath(root);
  mkdirSync(dirname(path), { recursive: true });
  atomicWriteFileSync(path, JSON.stringify(memory));
}

export type WatchdogState = "ok" | "stuck" | "not running" | "no heartbeat";
export type StuckCause = "permission prompt" | "index build" | "unknown";

export interface WatchdogVerdict {
  state: WatchdogState;
  /** age of the heartbeat; null when there is none */
  ageMs: number | null;
  cause: StuckCause | null;
  stage: HeartbeatStage | null;
  detail: string | null;
  /** restart the watcher now (only ever when stuck, and never for a pending prompt) */
  autoRestart: boolean;
  /** why a stuck watcher is NOT restarted automatically; null otherwise */
  withheld: string | null;
  deniedFolders: string[];
  /** still starting up (first import or startup backlog); null otherwise */
  startup: StartupPhase | null;
}

export interface JudgeOptions {
  nowMs: number;
  /** is the heartbeat's pid a live process */
  pidAlive: (pid: number) => boolean;
  memory: WatchdogMemory;
  /** only a caller that may act asks for auto-restart; a status read never does */
  mayRestart?: boolean;
  checkIntervalMs?: number;
}

export function judgeHeartbeat(hb: WatchHeartbeat | null, opts: JudgeOptions): WatchdogVerdict {
  const base = { cause: null, autoRestart: false, withheld: null } as const;
  if (!hb) return { ...base, state: "no heartbeat", ageMs: null, stage: null, detail: null, deniedFolders: [], startup: null };
  const at = Date.parse(hb.at);
  const ageMs = Number.isFinite(at) ? Math.max(0, opts.nowMs - at) : null;
  const dead = { ageMs, stage: hb.stage, detail: hb.detail, deniedFolders: hb.deniedFolders ?? [], startup: null };
  if (!opts.pidAlive(hb.pid)) return { ...base, ...dead, state: "not running" };
  const common = { ...dead, startup: startupPhase(hb) };
  const threshold = hb.stage === "indexing" ? HEARTBEAT_BUILD_STALE_MS : HEARTBEAT_STALE_MS;
  if (ageMs === null || ageMs < threshold) return { ...base, ...common, state: "ok" };
  // The Mac was asleep since the previous check: the watcher did not get a
  // chance to beat. Like the in-process watchdog, forgive this one check.
  const interval = opts.checkIntervalMs ?? WATCHDOG_CHECK_INTERVAL_MS;
  const lastCheck = opts.memory.lastCheckAt ? Date.parse(opts.memory.lastCheckAt) : NaN;
  if (Number.isFinite(lastCheck) && opts.nowMs - lastCheck > interval * 3) return { ...base, ...common, state: "ok" };
  const cause: StuckCause = hb.stage === "protected-folder" ? "permission prompt" : hb.stage === "indexing" ? "index build" : "unknown";
  let withheld: string | null = null;
  if (cause === "permission prompt") withheld = "restarting cannot answer a permission dialog";
  else if (!opts.mayRestart) withheld = "not requested";
  else {
    const lastRestart = opts.memory.lastAutoRestartAt ? Date.parse(opts.memory.lastAutoRestartAt) : NaN;
    if (Number.isFinite(lastRestart) && opts.nowMs - lastRestart < AUTO_RESTART_MIN_INTERVAL_MS) {
      withheld = `already restarted ${Math.round((opts.nowMs - lastRestart) / 60_000)} min ago (at most once per ${AUTO_RESTART_MIN_INTERVAL_MS / 60_000} min)`;
    }
  }
  return { ...common, state: "stuck", cause, autoRestart: withheld === null, withheld };
}

export function pidAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: it exists, it is simply not ours to signal.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
