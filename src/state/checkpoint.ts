import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "fs";
import { dirname, join, relative, sep } from "path";
import type { CarafeEvent } from "../format/events";
import type { SessionDistillate } from "../format/distillate";
import type { CarafeStore } from "../format/store";
import { atomicWriteFileSync } from "../format/store";
import { realExec, type ExecFn } from "../exec";
import { checkpointSyncEnabled } from "./sync";
import { protectedFolderGate, type ProtectedFolderGate } from "./protected-folders";
import {
  checkpointRef,
  deleteLocalRef,
  deleteRemoteRefs,
  mirrorCheckpoint,
  pushCheckpointRefs,
  type MirrorFile,
} from "./gitrefs";
import {
  chunkThreshold,
  descriptorPath,
  packLargeFile,
  partPath,
  type LargeFileDescriptor,
  unpackLargeFile,
} from "./chunks";
import {
  hasObject,
  hashBytes,
  hashFile,
  putObject,
  readObject,
  storeRootFromCheckpointDir,
} from "./objects";

const VERSION = 2;
const DEFAULT_KEEP = 30;
export const RECENT_MS = 15 * 60 * 1000;
export const DEFAULT_BUDGET_BYTES = 5 * 1024 * 1024 * 1024;
export const DEFAULT_INACTIVE_DAYS = 30;
export const DEFAULT_MIN_FREE_BYTES = 5 * 1024 * 1024 * 1024;
export const SNAPSHOT_PROBE_TIMEOUT_MS = 10_000;

const probeTimeoutWarnings = new Set<string>();
const snapshotProbeExec: ExecFn = (cmd, cwd, env, input) => realExec(cmd, cwd, env, input, {
  timeoutMs: SNAPSHOT_PROBE_TIMEOUT_MS,
  onTimeout: (timedOut, timeoutMs) => {
    const operation = timedOut.slice(0, 3).join(" ");
    const key = `${cwd}\0${operation}`;
    if (probeTimeoutWarnings.has(key)) return;
    probeTimeoutWarnings.add(key);
    console.error(`carafe snapshot probe timed out after ${timeoutMs / 1000}s (${operation}); continuing without that metadata`);
  },
});

function limit(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function maxFiles(): number { return limit("CARAFE_CHECKPOINT_MAX_FILES", 20_000); }
function maxBytes(): number { return limit("CARAFE_CHECKPOINT_MAX_BYTES", 200 * 1024 * 1024); }
function maxFileBytes(): number {
  const n = Number(process.env.CARAFE_CHECKPOINT_MAX_FILE_BYTES);
  return Number.isFinite(n) && n > 0 ? n : Infinity;
}

export interface CheckpointSkipped {
  path: string;
  reason: string;
}

/** Shared reason string: non-regular files (symlinks, dirs, fifos) are never
 *  COPIED into a snapshot — but undo preserves them by RENAME, so this skip
 *  reason alone must not block an undo. */
export const SKIP_NOT_REGULAR = "not a regular file";

/** One file in a version-2 manifest. Bodies live in state/objects/, never in
 *  the snapshot directory: `hash` is the content sha256 for a whole file, and
 *  `parts` names one object per chunk for a file at or over chunkThreshold()
 *  (hash is then the sha256 of the ORIGINAL bytes, which unpack verifies).
 *  `ino` lets the next snapshot of the same session prove a file is untouched
 *  without reading it. */
export interface SnapshotFileEntry {
  path: string;
  hash: string;
  parts?: string[];
  size: number;
  mode: number;
  mtimeMs: number;
  ino?: number;
}

export interface CheckpointManifest {
  seq: number | string;
  ts: string | null;
  takenAt: string;
  cwd: string;
  gitHead: string | null;
  gitBranch: string | null;
  dirtyCount: number | null;
  fileCount: number;
  totalBytes: number;
  skipped: CheckpointSkipped[];
  manual?: boolean;
  /** version 2 only: the snapshot's contents, by reference into state/objects/. */
  files?: SnapshotFileEntry[];
  version: 1 | 2;
}

export interface CheckpointResult {
  dir: string;
  manifest: CheckpointManifest;
  mirroredRef?: string;
}

export interface WorkingFile {
  path: string;
  abs: string;
  size: number;
  mode: number;
  mtimeMs: number;
  /** live working files only — the unchanged-file proof alongside size+mtime */
  ino?: number;
  /** snapshot entries only — lets a reader compare content without materialising */
  hash?: string;
}

interface WorkingSet {
  files: WorkingFile[];
  gitHead: string | null;
  gitBranch: string | null;
  dirtyCount: number | null;
  skipped: CheckpointSkipped[];
  guardSkip?: string;
}

function stateDir(store: CarafeStore, tool: string, sessionId: string): string {
  return join(store.root, "state", tool, sessionId);
}

export function checkpointDir(store: CarafeStore, tool: string, sessionId: string, seq: number | string): string {
  return join(stateDir(store, tool, sessionId), String(seq));
}

function manifestPath(dir: string): string {
  return join(dir, "manifest.json");
}

function filesRoot(dir: string): string {
  return join(dir, "files");
}

function materializedRoot(dir: string): string {
  return join(dir, "files-materialized");
}

function safeRelative(p: string): boolean {
  return !!p && !p.startsWith("/") && !p.split(/[\\/]/).includes("..");
}

function git(cwd: string, args: string[], exec: ExecFn): { ok: boolean; out: string } {
  return exec(["git", ...args], cwd);
}

function splitNul(out: string): string[] {
  return out.split("\0").filter(Boolean);
}

function visibleFilesFromGit(cwd: string, exec: ExecFn): WorkingSet | null {
  const inside = git(cwd, ["rev-parse", "--is-inside-work-tree"], exec);
  if (!inside.ok || inside.out !== "true") return null;

  const listed = git(cwd, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], exec);
  if (!listed.ok) return null;

  const head = git(cwd, ["rev-parse", "HEAD"], exec);
  const branch = git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"], exec);
  const status = git(cwd, ["status", "--porcelain"], exec);

  const files: WorkingFile[] = [];
  const skipped: CheckpointSkipped[] = [];
  for (const rel of splitNul(listed.out)) {
    if (!safeRelative(rel)) {
      skipped.push({ path: rel, reason: "unsafe path" });
      continue;
    }
    const abs = join(cwd, rel);
    let st;
    try { st = lstatSync(abs); } catch { continue; }
    if (!st.isFile()) {
      skipped.push({ path: rel, reason: SKIP_NOT_REGULAR });
      continue;
    }
    files.push({ path: rel, abs, size: st.size, mode: st.mode, mtimeMs: st.mtimeMs, ino: st.ino });
    if (files.length > maxFiles()) {
      return { files, skipped, gitHead: null, gitBranch: null, dirtyCount: null, guardSkip: `git cwd has more than ${maxFiles()} visible files` };
    }
  }

  return {
    files,
    skipped,
    gitHead: head.ok && head.out ? head.out : null,
    gitBranch: branch.ok && branch.out && branch.out !== "HEAD" ? branch.out : null,
    dirtyCount: status.ok ? (status.out ? status.out.split("\n").filter(Boolean).length : 0) : null,
  };
}

function walkFallback(cwd: string): WorkingSet {
  const files: WorkingFile[] = [];
  const skipped: CheckpointSkipped[] = [];
  const stack = [""];
  while (stack.length) {
    const relDir = stack.pop()!;
    const absDir = join(cwd, relDir);
    let entries: string[];
    try { entries = readdirSync(absDir); } catch { continue; }
    for (const name of entries) {
      if (name === ".git" || name === "node_modules" || name === "dist") continue;
      const rel = relDir ? join(relDir, name) : name;
      if (!safeRelative(rel)) {
        skipped.push({ path: rel, reason: "unsafe path" });
        continue;
      }
      const abs = join(cwd, rel);
      let st;
      try { st = lstatSync(abs); } catch { continue; }
      if (st.isDirectory()) {
        stack.push(rel);
        continue;
      }
      if (!st.isFile()) {
        skipped.push({ path: rel, reason: SKIP_NOT_REGULAR });
        continue;
      }
      files.push({ path: rel, abs, size: st.size, mode: st.mode, mtimeMs: st.mtimeMs, ino: st.ino });
      if (files.length > maxFiles()) return { files, skipped, gitHead: null, gitBranch: null, dirtyCount: null, guardSkip: `non-git cwd has more than ${maxFiles()} files` };
    }
  }
  return { files, skipped, gitHead: null, gitBranch: null, dirtyCount: null };
}

export function collectWorkingSet(cwd: string, exec: ExecFn = realExec): WorkingSet | null {
  if (!existsSync(cwd)) return null;
  try {
    const st = statSync(cwd);
    if (!st.isDirectory()) return null;
  } catch {
    return null;
  }
  return visibleFilesFromGit(cwd, exec) ?? walkFallback(cwd);
}

/** Per-session one-shot notes (guard skips, size warnings) for the watcher. */
const sessionNotes = new Set<string>();
let pendingNotes: string[] = [];

export function noteOncePerSession(sessionId: string, kind: string, message: string): void {
  const key = `${sessionId}:${kind}`;
  if (sessionNotes.has(key)) return;
  if (sessionNotes.size > 5000) sessionNotes.clear(); // a watcher runs for weeks
  sessionNotes.add(key);
  pendingNotes.push(message);
}

/** Drain the notes accumulated since the last call (the watcher prints them). */
export function drainSnapshotNotes(): string[] {
  const out = pendingNotes;
  pendingNotes = [];
  return out;
}

interface SnapshotWrite {
  entries: SnapshotFileEntry[];
  fileCount: number;
  totalBytes: number;
  newBytes: number;
}

/** Write every file body into state/objects/ and describe them in a manifest.
 *  Nothing is copied into the snapshot directory: a file whose (size, mtime,
 *  inode) still match the session's previous manifest is not even read. */
function writeSnapshotObjects(
  store: CarafeStore,
  files: WorkingFile[],
  skipped: CheckpointSkipped[],
  previous: Map<string, SnapshotFileEntry>,
): SnapshotWrite {
  const entries: SnapshotFileEntry[] = [];
  let fileCount = 0;
  let totalBytes = 0;
  let newBytes = 0;
  for (const f of files) {
    if (f.size > maxFileBytes()) {
      skipped.push({ path: f.path, reason: `larger than ${maxFileBytes()} bytes` });
      continue;
    }
    try {
      const mode = f.mode & 0o777;
      const prev = previous.get(f.path);
      if (prev && prev.size === f.size && prev.mtimeMs === f.mtimeMs && prev.ino !== undefined && prev.ino === f.ino) {
        // Unchanged on disk: reuse the content reference. A chmod leaves mtime
        // alone, so the MODE is always taken from the live stat.
        entries.push({ ...prev, mode });
      } else if (f.size >= chunkThreshold()) {
        const packed = packLargeFile(f.abs, f.path, mode);
        const parts: string[] = [];
        for (const part of packed.parts) {
          const hash = hashBytes(part);
          if (!hasObject(store, hash)) {
            putObject(store, part);
            newBytes += part.length;
          }
          parts.push(hash);
        }
        entries.push({ path: f.path, hash: packed.descriptor.sha256, parts, size: packed.descriptor.originalBytes, mode, mtimeMs: f.mtimeMs, ino: f.ino });
      } else {
        const hash = hashFile(f.abs, f.size);
        if (!hasObject(store, hash)) {
          putObject(store, readFileSync(f.abs));
          newBytes += f.size;
        }
        entries.push({ path: f.path, hash, size: f.size, mode, mtimeMs: f.mtimeMs, ino: f.ino });
      }
      fileCount++;
      totalBytes += f.size;
    } catch (e) {
      skipped.push({ path: f.path, reason: `snapshot failed: ${(e as Error).message}` });
    }
  }
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { entries, fileCount, totalBytes, newBytes };
}

/** The content identity of a snapshot: path, content and mode. A snapshot whose
 *  identity equals the previous one adds nothing an undo could use. */
function snapshotIdentity(entries: SnapshotFileEntry[]): string {
  return entries.map((e) => `${e.path}\u0000${e.parts ? e.parts.join(",") : e.hash}\u0000${e.mode & 0o777}`).join("\n");
}

const pushWarnings = new Set<string>();

function warnPushOnce(key: string, message: string): void {
  if (pushWarnings.has(key)) return;
  pushWarnings.add(key);
  console.error(`carafe checkpoint push failed: ${message}`);
}

export function mirrorCheckpointToGit(
  d: SessionDistillate,
  manifest: CheckpointManifest,
  opts: { exec?: ExecFn; push?: boolean; remote?: string; toleratePushFailure?: boolean } = {},
): { ref: string; commit: string; pushed?: boolean; pushError?: string } | null {
  if (!d.cwd || typeof manifest.seq !== "number") return null;
  const exec = opts.exec ?? realExec;
  const set = collectWorkingSet(d.cwd, exec);
  if (!set || set.guardSkip) return null;
  const files: MirrorFile[] = set.files.map((f) => ({ path: f.path, abs: f.abs, size: f.size, mode: f.mode, mtimeMs: f.mtimeMs }));
  const mirrored = mirrorCheckpoint(d.cwd, d.tool, d.sessionId, manifest.seq, files, {
    exec,
    ts: manifest.ts,
    takenAt: manifest.takenAt,
    gitHead: manifest.gitHead,
    gitBranch: manifest.gitBranch,
    dirtyCount: manifest.dirtyCount,
    manual: manifest.manual,
  });
  if (!opts.push) return { ref: mirrored.ref, commit: mirrored.commit };
  const pushed = pushCheckpointRefs(d.cwd, opts.remote ?? "origin", [mirrored.ref], exec);
  if (!pushed.ok) {
    if (opts.toleratePushFailure) warnPushOnce(`${d.cwd}:${opts.remote ?? "origin"}`, pushed.message);
    else return { ref: mirrored.ref, commit: mirrored.commit, pushError: pushed.message };
  }
  return { ref: mirrored.ref, commit: mirrored.commit, pushed: pushed.ok };
}

function mirrorWorkingSetToGit(
  d: SessionDistillate,
  manifest: CheckpointManifest,
  files: WorkingFile[],
  opts: { exec: ExecFn; push?: boolean; remote?: string; toleratePushFailure?: boolean },
): { ref: string; commit: string; pushed?: boolean; pushError?: string } | null {
  if (!d.cwd || typeof manifest.seq !== "number") return null;
  const mirrorFiles: MirrorFile[] = files.map((f) => ({ path: f.path, abs: f.abs, size: f.size, mode: f.mode, mtimeMs: f.mtimeMs }));
  const mirrored = mirrorCheckpoint(d.cwd, d.tool, d.sessionId, manifest.seq, mirrorFiles, {
    exec: opts.exec,
    ts: manifest.ts,
    takenAt: manifest.takenAt,
    gitHead: manifest.gitHead,
    gitBranch: manifest.gitBranch,
    dirtyCount: manifest.dirtyCount,
    manual: manifest.manual,
  });
  if (!opts.push) return { ref: mirrored.ref, commit: mirrored.commit };
  const pushed = pushCheckpointRefs(d.cwd, opts.remote ?? "origin", [mirrored.ref], opts.exec);
  if (!pushed.ok) {
    if (opts.toleratePushFailure) warnPushOnce(`${d.cwd}:${opts.remote ?? "origin"}`, pushed.message);
    else return { ref: mirrored.ref, commit: mirrored.commit, pushError: pushed.message };
  }
  return { ref: mirrored.ref, commit: mirrored.commit, pushed: pushed.ok };
}

function syncAfterCheckpoint(store: CarafeStore, d: SessionDistillate, manifest: CheckpointManifest, exec: ExecFn, files: WorkingFile[]): string | undefined {
  if (!d.cwd) return undefined;
  const sync = checkpointSyncEnabled(store, d.cwd, exec);
  if (!sync) return undefined;
  try {
    return mirrorWorkingSetToGit(d, manifest, files, { exec, push: true, remote: sync.remote, toleratePushFailure: true })?.ref;
  } catch (e) {
    warnPushOnce(`${d.cwd}:${sync.remote}`, (e as Error).message);
    return undefined;
  }
}

/** Free bytes on the store's volume, through the exec seam. Cached briefly:
 *  every snapshot would otherwise spawn df. */
let freeCache: { at: number; root: string; bytes: number | null } | null = null;

export function freeBytesForStore(store: CarafeStore, exec: ExecFn = realExec, now = Date.now()): number | null {
  if (freeCache && freeCache.root === store.root && now - freeCache.at < 60_000) return freeCache.bytes;
  let bytes: number | null = null;
  try {
    const r = exec(["df", "-k", "-P", store.root], store.root);
    if (r.ok) {
      const line = r.out.split("\n").filter(Boolean)[1];
      const avail = line ? Number(line.trim().split(/\s+/)[3]) : NaN;
      if (Number.isFinite(avail)) bytes = avail * 1024;
    }
  } catch { bytes = null; }
  freeCache = { at: now, root: store.root, bytes };
  return bytes;
}

/** Test seam: the df cache must not leak between stores inside one process. */
export function resetFreeSpaceCache(): void {
  freeCache = null;
}

function recentPath(store: CarafeStore): string {
  return join(store.root, "state", "checkpoint-recent.json");
}

type RecentMap = Record<string, { at: number; tool: string; sessionId: string; agent: boolean }>;

function readRecent(store: CarafeStore): RecentMap {
  try { return JSON.parse(readFileSync(recentPath(store), "utf8")) as RecentMap; } catch { return {}; }
}

function recordRecent(store: CarafeStore, cwd: string, tool: string, sessionId: string, at: number): void {
  try {
    const map = readRecent(store);
    map[cwd] = { at, tool, sessionId, agent: isAgentSession(sessionId) };
    atomicWriteFileSync(recentPath(store), JSON.stringify(map));
  } catch { /* the recency hint is a courtesy, never a blocker */ }
}

export function isAgentSession(sessionId: string): boolean {
  return sessionId.startsWith("agent-");
}

/** A helper agent works in its parent's worktree: when the parent snapshotted
 *  that same cwd moments ago, the agent's snapshot would be a duplicate of it. */
function agentCoveredByParent(store: CarafeStore, d: SessionDistillate, now: number): boolean {
  if (!isAgentSession(d.sessionId) || !d.cwd) return false;
  const recent = readRecent(store)[d.cwd];
  return !!recent && !recent.agent && now - recent.at < RECENT_MS;
}

function takeCheckpointAt(
  store: CarafeStore,
  d: SessionDistillate,
  key: number | string,
  seq: number | string,
  ts: string | null,
  opts: { manual?: boolean; exec?: ExecFn; noSync?: boolean; now?: number } = {},
): CheckpointResult | null {
  if (!d.cwd) return null;
  const writeExec = opts.exec ?? realExec;
  // These calls only inspect disk/repository state. They are safe to kill and
  // skip; mutation below deliberately keeps the caller's unbounded executor.
  const probeExec = opts.exec ?? snapshotProbeExec;
  const now = opts.now ?? Date.now();
  // Manual and pre-undo snapshots are never guarded away: an undo depends on
  // its stash existing, and an explicit `carafe checkpoint` is a user request.
  if (!opts.manual) {
    if (agentCoveredByParent(store, d, now)) {
      noteOncePerSession(d.sessionId, "agent-covered", `snapshot skipped for ${d.sessionId}: parent session snapshotted ${d.cwd} within the last ${Math.round(RECENT_MS / 60000)}m`);
      return null;
    }
    const free = freeBytesForStore(store, probeExec, now);
    const minFree = checkpointMinFreeBytes(store);
    if (free !== null && free < minFree) {
      noteOncePerSession(d.sessionId, "low-disk", `snapshot skipped: ${(free / 1024 / 1024 / 1024).toFixed(1)}GiB free is below checkpointMinFreeBytes (${(minFree / 1024 / 1024 / 1024).toFixed(1)}GiB)`);
      return null;
    }
  }
  try {
    const set = collectWorkingSet(d.cwd, probeExec);
    if (!set || set.guardSkip) {
      if (set?.guardSkip) noteOncePerSession(d.sessionId, "guard", `snapshot skipped: ${set.guardSkip}`);
      return null;
    }
    const dir = checkpointDir(store, d.tool, d.sessionId, key);
    const skipped = [...set.skipped];
    const prevManifest = latestSessionManifest(store, d.tool, d.sessionId);
    const previous = new Map((prevManifest?.files ?? []).map((f) => [f.path, f]));
    const written = writeSnapshotObjects(store, set.files, skipped, previous);
    // Nothing changed since the previous snapshot: an extra manifest would buy
    // no undo point at all. Taking none is what makes a tool-result trigger free.
    if (!opts.manual && prevManifest && prevManifest.version === 2 && snapshotIdentity(written.entries) === snapshotIdentity(prevManifest.files ?? [])) {
      return null;
    }
    if (written.newBytes > maxBytes()) {
      noteOncePerSession(d.sessionId, "max-bytes", `snapshot of ${d.cwd} added ${(written.newBytes / 1024 / 1024).toFixed(0)}MB of new content, over CARAFE_CHECKPOINT_MAX_BYTES (${maxBytes()}) — kept anyway`);
    }
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const manifest: CheckpointManifest = {
      seq,
      ts,
      takenAt: new Date(now).toISOString(),
      cwd: d.cwd,
      gitHead: set.gitHead,
      gitBranch: set.gitBranch,
      dirtyCount: set.dirtyCount,
      fileCount: written.fileCount,
      totalBytes: written.totalBytes,
      skipped,
      ...(opts.manual ? { manual: true } : {}),
      files: written.entries,
      version: VERSION,
    };
    writeFileSync(manifestPath(dir), JSON.stringify(manifest, null, 2));
    if (!opts.manual) recordRecent(store, d.cwd, d.tool, d.sessionId, now);
    const mirroredRef = opts.noSync ? undefined : syncAfterCheckpoint(store, d, manifest, writeExec, set.files);
    return { dir, manifest, ...(mirroredRef ? { mirroredRef } : {}) };
  } catch {
    return null;
  }
}

export function takeCheckpoint(store: CarafeStore, d: SessionDistillate, seq: number, ts: string | null, exec?: ExecFn, opts: { now?: number } = {}): CheckpointResult | null {
  return takeCheckpointAt(store, d, seq, seq, ts, { exec, now: opts.now });
}

export function takeManualCheckpoint(store: CarafeStore, d: SessionDistillate, seq: number, ts: string | null, exec?: ExecFn): CheckpointResult | null {
  return takeCheckpointAt(store, d, seq, seq, ts, { exec, manual: true });
}

export function takePreUndoCheckpoint(store: CarafeStore, d: SessionDistillate, seq: number, ts: string | null, exec?: ExecFn): CheckpointResult | null {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return takeCheckpointAt(store, d, `pre-undo-${stamp}`, seq, ts, { exec, manual: true, noSync: true });
}

function readManifest(p: string): CheckpointManifest | null {
  try {
    const parsed = JSON.parse(readFileSync(p, "utf8")) as CheckpointManifest;
    // Version 1 (a files/ tree) and version 2 (objects + manifest) both read.
    return parsed?.version === 1 || parsed?.version === 2 ? parsed : null;
  } catch {
    return null;
  }
}

/** Every snapshot directory of one session, manifest included. */
export function sessionSnapshots(store: CarafeStore, tool: string, sessionId: string): Array<{ key: string; dir: string; manifest: CheckpointManifest }> {
  const base = stateDir(store, tool, sessionId);
  let names: string[] = [];
  try { names = readdirSync(base); } catch { return []; }
  const out: Array<{ key: string; dir: string; manifest: CheckpointManifest }> = [];
  for (const name of names) {
    if (name.startsWith("ref-")) continue; // a materialised git-ref cache, not a stored snapshot
    const dir = join(base, name);
    const manifest = readManifest(manifestPath(dir));
    if (manifest) out.push({ key: name, dir, manifest });
  }
  return out;
}

/** The newest version-2 manifest of a session — the baseline that lets the next
 *  snapshot skip re-reading unchanged files. */
function latestSessionManifest(store: CarafeStore, tool: string, sessionId: string): CheckpointManifest | null {
  let best: CheckpointManifest | null = null;
  for (const s of sessionSnapshots(store, tool, sessionId)) {
    if (s.manifest.version !== 2) continue;
    if (!best || s.manifest.takenAt > best.takenAt) best = s.manifest;
  }
  return best;
}

export function readCheckpointManifest(dir: string): CheckpointManifest | null {
  return readManifest(manifestPath(dir));
}

export function listCheckpoints(store: CarafeStore, tool: string, sessionId: string): Array<{ seq: number; ts: string | null; takenAt: string; fileCount: number; totalBytes: number; gitHead: string | null }> {
  const base = stateDir(store, tool, sessionId);
  let names: string[] = [];
  try { names = readdirSync(base); } catch { return []; }
  const out: Array<{ seq: number; ts: string | null; takenAt: string; fileCount: number; totalBytes: number; gitHead: string | null }> = [];
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    const m = readManifest(join(base, name, "manifest.json"));
    if (!m || typeof m.seq !== "number") continue;
    out.push({ seq: m.seq, ts: m.ts, takenAt: m.takenAt, fileCount: m.fileCount, totalBytes: m.totalBytes, gitHead: m.gitHead });
  }
  return out.sort((a, b) => a.seq - b.seq);
}

export function checkpointManifestForSeq(store: CarafeStore, tool: string, sessionId: string, seq: number): { dir: string; manifest: CheckpointManifest } | null {
  const dir = checkpointDir(store, tool, sessionId, seq);
  const manifest = readCheckpointManifest(dir);
  return manifest ? { dir, manifest } : null;
}

function newestNonMetaUser(events: CarafeEvent[]): CarafeEvent | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.kind === "user" && e.ts && (e.raw as any)?.isMeta !== true) return e;
  }
  return null;
}

function configNumber(store: CarafeStore, key: string, fallback: number): number {
  try {
    const cfg = JSON.parse(readFileSync(join(store.root, "config.json"), "utf8"));
    const n = Number(cfg?.[key]);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
  } catch {
    return fallback;
  }
}

export function checkpointKeep(store: CarafeStore): number {
  return configNumber(store, "checkpointKeep", DEFAULT_KEEP);
}

export function checkpointBudgetBytes(store: CarafeStore): number {
  return configNumber(store, "checkpointBudgetBytes", DEFAULT_BUDGET_BYTES);
}

export function checkpointInactiveDays(store: CarafeStore): number {
  return configNumber(store, "checkpointInactiveDays", DEFAULT_INACTIVE_DAYS);
}

export function checkpointMinFreeBytes(store: CarafeStore): number {
  return configNumber(store, "checkpointMinFreeBytes", DEFAULT_MIN_FREE_BYTES);
}

function isUnderState(store: CarafeStore, p: string): boolean {
  const base = join(store.root, "state") + sep;
  return p.startsWith(base);
}

export function pruneAutoCheckpoints(
  store: CarafeStore,
  tool: string,
  sessionId: string,
  keep = checkpointKeep(store),
  opts: { cwd?: string | null; exec?: ExecFn } = {},
): void {
  const base = stateDir(store, tool, sessionId);
  let names: string[] = [];
  try { names = readdirSync(base); } catch { return; }
  const autos: Array<{ seq: number; dir: string }> = [];
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    const dir = join(base, name);
    const m = readCheckpointManifest(dir);
    if (!m || m.manual || typeof m.seq !== "number") continue;
    autos.push({ seq: m.seq, dir });
  }
  autos.sort((a, b) => a.seq - b.seq);
  const pruned = autos.slice(0, Math.max(0, autos.length - keep));
  const refs: string[] = [];
  for (const old of pruned) {
    if (isUnderState(store, old.dir)) rmSync(old.dir, { recursive: true, force: true });
    if (opts.cwd) {
      const ref = checkpointRef(tool, sessionId, old.seq);
      refs.push(ref);
      deleteLocalRef(opts.cwd, ref, opts.exec ?? realExec);
    }
  }
  if (opts.cwd && refs.length) {
    const sync = checkpointSyncEnabled(store, opts.cwd, opts.exec ?? realExec);
    if (sync) deleteRemoteRefs(opts.cwd, sync.remote, refs, opts.exec ?? realExec);
  }
}

/** The user turn an automatic snapshot would be keyed to: the newest non-meta
 *  user event, when it is recent enough that the working tree still reflects it. */
export interface SnapshotCandidate { seq: number; ts: string }

export function snapshotCandidate(events: CarafeEvent[], now = Date.now()): SnapshotCandidate | null {
  const newest = newestNonMetaUser(events);
  if (!newest || !newest.ts) return null;
  return snapshotCandidateStillRecent({ seq: newest.seq, ts: newest.ts }, now) ? { seq: newest.seq, ts: newest.ts } : null;
}

/** A snapshot is of the working tree NOW: past RECENT_MS it no longer shows the turn it is keyed to. */
export function snapshotCandidateStillRecent(candidate: SnapshotCandidate, now = Date.now()): boolean {
  const eventMs = Date.parse(candidate.ts);
  return Number.isFinite(eventMs) && Math.abs(now - eventMs) <= RECENT_MS;
}

export type AutoCheckpointOptions = { now?: () => number; exec?: ExecFn; gate?: ProtectedFolderGate | null };

export function maybeAutoCheckpoint(store: CarafeStore, d: SessionDistillate, events: CarafeEvent[], opts: AutoCheckpointOptions = {}): CheckpointResult | null {
  const newest = newestNonMetaUser(events);
  if (!newest || !newest.ts) return null;
  return maybeAutoCheckpointAt(store, d, { seq: newest.seq, ts: newest.ts }, opts);
}

/** The same automatic snapshot for a candidate remembered earlier (the watcher's
 *  startup queue): every guard is re-checked against the clock now. */
export function maybeAutoCheckpointAt(store: CarafeStore, d: SessionDistillate, newest: SnapshotCandidate, opts: AutoCheckpointOptions = {}): CheckpointResult | null {
  const now = opts.now?.() ?? Date.now();
  if (!snapshotCandidateStillRecent(newest, now)) return null;
  const existing = listCheckpoints(store, d.tool, d.sessionId);
  const maxSeq = existing.reduce((m, c) => Math.max(m, c.seq), -1);
  if (newest.seq <= maxSeq) return null;
  // The watcher's first open of ~/Documents (or Desktop, Downloads) may block on
  // a macOS permission prompt; the gate makes that one announced open, and a
  // refused folder is skipped from then on instead of failing every tick.
  const gate = opts.gate === undefined ? protectedFolderGate() : opts.gate;
  if (gate && !gate.allow(d.cwd)) return null;
  const result = takeCheckpoint(store, d, newest.seq, newest.ts, opts.exec, { now });
  if (result) pruneAutoCheckpoints(store, d.tool, d.sessionId, checkpointKeep(store), { cwd: d.cwd, exec: opts.exec });
  return result;
}

export function snapshotRelativeFiles(dir: string): WorkingFile[] {
  const manifest = readCheckpointManifest(dir);
  if (manifest?.version === 2) {
    // No bytes are touched here: `abs` names where the file WOULD be written,
    // and `hash` is enough to decide whether it needs writing at all.
    return (manifest.files ?? []).map((e) => ({
      path: e.path,
      abs: join(materializedRoot(dir), e.path),
      size: e.size,
      mode: e.mode,
      mtimeMs: e.mtimeMs,
      hash: e.hash,
    }));
  }
  const root = filesRoot(dir);
  const out: WorkingFile[] = [];
  const stack = [""];
  while (stack.length) {
    const relDir = stack.pop()!;
    const absDir = join(root, relDir);
    let entries: string[];
    try { entries = readdirSync(absDir); } catch { continue; }
    for (const name of entries) {
      const rel = relDir ? join(relDir, name) : name;
      const abs = join(root, rel);
      const st = lstatSync(abs);
      if (st.isDirectory()) stack.push(rel);
      else if (st.isFile()) {
        const packed = packedDescriptorFromRel(dir, rel);
        if (packed) {
          const mat = materializePackedSnapshotFile(dir, packed.path, packed);
          const mst = statSync(mat);
          out.push({ path: packed.path, abs: mat, size: packed.originalBytes, mode: packed.mode ?? 0o644, mtimeMs: mst.mtimeMs });
        } else if (!rel.includes(".carafe-large/part-")) {
          out.push({ path: rel, abs, size: st.size, mode: st.mode, mtimeMs: st.mtimeMs });
        }
      }
    }
  }
  return out;
}

export function snapshotFilesRoot(dir: string): string {
  return filesRoot(dir);
}

function packedDescriptorFromRel(dir: string, rel: string): LargeFileDescriptor | null {
  if (!rel.endsWith(".carafe-large.json")) return null;
  try {
    const parsed = JSON.parse(readFileSync(join(filesRoot(dir), rel), "utf8")) as LargeFileDescriptor;
    return parsed?.carafeChunked === 1 && descriptorPath(parsed.path) === rel ? parsed : null;
  } catch {
    return null;
  }
}

function materializePackedSnapshotFile(dir: string, rel: string, descriptor?: LargeFileDescriptor): string {
  const desc = descriptor ?? (JSON.parse(readFileSync(join(filesRoot(dir), descriptorPath(rel)), "utf8")) as LargeFileDescriptor);
  const parts: Buffer[] = [];
  for (let i = 0; i < desc.partCount; i++) parts.push(readFileSync(join(filesRoot(dir), partPath(desc.path, i))));
  const dst = join(materializedRoot(dir), desc.path);
  mkdirSync(dirname(dst), { recursive: true });
  writeFileSync(dst, unpackLargeFile(desc, parts));
  chmodSync(dst, desc.mode ?? 0o644);
  return dst;
}

/** Write one version-2 snapshot file out of state/objects/ and return its path.
 *  Called only when the BYTES are actually wanted (a restore, an explicit read);
 *  planning an undo never reaches here. */
export function materializeSnapshotFile(dir: string, rel: string): string {
  const manifest = readCheckpointManifest(dir);
  if (manifest?.version !== 2) return materializePackedSnapshotFile(dir, rel);
  const entry = (manifest.files ?? []).find((f) => f.path === rel);
  if (!entry) throw new Error(`snapshot ${dir} has no file ${rel}`);
  const dst = join(materializedRoot(dir), rel);
  try {
    const st = statSync(dst);
    if (st.size === entry.size) return dst; // already materialised by an earlier read
  } catch { /* not materialised yet */ }
  const root = storeRootFromCheckpointDir(dir);
  let data: Buffer;
  if (entry.parts) {
    const parts = entry.parts.map((h) => readObject(root, h));
    data = unpackLargeFile(
      { carafeChunked: 1, path: entry.path, originalBytes: entry.size, sha256: entry.hash, codec: "gzip", partCount: entry.parts.length, mode: entry.mode },
      parts,
    );
  } else {
    data = readObject(root, entry.hash);
  }
  mkdirSync(dirname(dst), { recursive: true });
  writeFileSync(dst, data);
  chmodSync(dst, entry.mode & 0o777);
  return dst;
}

export function snapshotFileAbs(dir: string, rel: string): string {
  const manifest = readCheckpointManifest(dir);
  if (manifest?.version === 2) return materializeSnapshotFile(dir, rel);
  const raw = join(filesRoot(dir), rel);
  if (existsSync(raw)) return raw;
  return materializePackedSnapshotFile(dir, rel);
}

export function relativeToCwd(cwd: string, abs: string): string {
  return relative(cwd, abs).split(sep).join("/");
}
