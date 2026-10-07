import { createHash } from "crypto";
import {
  chmodSync,
  constants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "fs";
import { dirname, join } from "path";
import type { CarafeEvent } from "../format/events";
import type { SessionDistillate } from "../format/distillate";
import type { CarafeStore } from "../format/store";
import { renderHandoff } from "../handoff/render";
import { extractPieces, firstLineOf } from "../handoff/pieces";
import { realExec, type ExecFn } from "../exec";
import {
  checkpointDir,
  collectWorkingSet,
  listCheckpoints,
  readCheckpointManifest,
  SKIP_NOT_REGULAR,
  snapshotFileAbs,
  snapshotRelativeFiles,
  takePreUndoCheckpoint,
  type WorkingFile,
} from "./checkpoint";
import { listRefCheckpoints, materializeCheckpoint } from "./gitrefs";

export interface UndoPlan {
  checkpointDir: string;
  source: "local" | "git ref";
  targetSeq: number;
  checkpointSeq: number;
  restore: string[];
  unchanged: string[];
  moveToStash: string[];
  warnings: string[];
  errors: string[];
  /** per-path size detail so the plan can EXPLAIN what will change:
   *  cur = bytes on disk now (null = doesn't exist), snap = bytes after undo */
  detail: Record<string, { cur: number | null; snap: number | null }>;
}

export interface UndoApplyResult {
  plan: UndoPlan;
  stashDir: string;
  restored: number;
  moved: number;
}

function hashFile(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** Version-2 snapshot entries carry the content hash, so an unchanged file is
 *  recognised without ever writing the snapshot copy out — planning an undo
 *  materialises nothing. Version 1 keeps the stat-then-hash comparison. */
function sameFile(snapshot: WorkingFile, current: WorkingFile): boolean {
  let b;
  try { b = statSync(current.abs); } catch { return false; }
  if (!b.isFile()) return false;
  if (snapshot.size !== b.size) return false;
  if (snapshot.hash) return hashFile(current.abs) === snapshot.hash;
  let a;
  try { a = statSync(snapshot.abs); } catch { return false; }
  if (a.mtimeMs === b.mtimeMs) return true;
  return hashFile(snapshot.abs) === hashFile(current.abs);
}

export function resolveCheckpointForSeq(store: CarafeStore, d: SessionDistillate, targetSeq: number, exec: ExecFn = realExec): { seq: number; dir: string; source: "local" | "git ref" } | null {
  const candidates = listCheckpoints(store, d.tool, d.sessionId).filter((c) => c.seq <= targetSeq);
  const best = candidates[candidates.length - 1];
  if (best) return { seq: best.seq, dir: checkpointDir(store, d.tool, d.sessionId, best.seq), source: "local" };
  if (!d.cwd) return null;
  const refs = listRefCheckpoints(d.cwd, d.tool, d.sessionId, exec).filter((c) => c.seq <= targetSeq);
  const ref = refs[refs.length - 1];
  if (!ref) return null;
  const dir = join(store.root, "state", d.tool, d.sessionId, `ref-${ref.seq}`);
  materializeCheckpoint(d.cwd, ref.sha, dir, exec);
  return { seq: ref.seq, dir, source: "git ref" };
}

export function planUndo(store: CarafeStore, d: SessionDistillate, targetSeq: number, exec: ExecFn = realExec): UndoPlan {
  const available = listCheckpoints(store, d.tool, d.sessionId).map((c) => c.seq);
  const picked = resolveCheckpointForSeq(store, d, targetSeq);
  if (!picked) {
    return {
      checkpointDir: "",
      source: "local",
      targetSeq,
      checkpointSeq: -1,
      restore: [],
      unchanged: [],
      moveToStash: [],
      detail: {},
      warnings: [],
      errors: [`no checkpoint at or before seq ${targetSeq}; available seqs: ${available.length ? available.join(", ") : "none"}`],
    };
  }
  if (!d.cwd || !existsSync(d.cwd)) {
    return {
      checkpointDir: picked.dir,
      source: picked.source,
      targetSeq,
      checkpointSeq: picked.seq,
      restore: [],
      unchanged: [],
      moveToStash: [],
      detail: {},
      warnings: [],
      errors: [`cwd missing: ${d.cwd ?? "?"}`],
    };
  }

  let manifest = readCheckpointManifest(picked.dir);
  let pickedDir = picked.dir;
  let pickedSource = picked.source;
  if (!manifest && d.cwd) {
    const ref = listRefCheckpoints(d.cwd, d.tool, d.sessionId, exec).find((c) => c.seq === picked.seq);
    if (ref) {
      pickedDir = join(store.root, "state", d.tool, d.sessionId, `ref-${ref.seq}`);
      materializeCheckpoint(d.cwd, ref.sha, pickedDir, exec);
      manifest = readCheckpointManifest(pickedDir);
      pickedSource = "git ref";
    }
  }
  const current = collectWorkingSet(d.cwd, exec);
  if (!manifest || !current || current.guardSkip) {
    return {
      checkpointDir: pickedDir,
      source: pickedSource,
      targetSeq,
      checkpointSeq: picked.seq,
      restore: [],
      unchanged: [],
      moveToStash: [],
      detail: {},
      warnings: [],
      errors: [current?.guardSkip ?? "checkpoint or current working set is unavailable"],
    };
  }

  const warnings: string[] = [];
  if (manifest.gitHead && current.gitHead && manifest.gitHead !== current.gitHead) {
    warnings.push(`WARN: git HEAD now (${current.gitHead}) differs from checkpoint (${manifest.gitHead})`);
  }

  const cur = new Map(current.files.map((f) => [f.path, f]));
  const snap = snapshotRelativeFiles(pickedDir);
  const snapshotPaths = new Set(snap.map((f) => f.path));
  const restore: string[] = [];
  const unchanged: string[] = [];
  for (const f of snap) {
    const c = cur.get(f.path);
    if (c && (f.mode & 0o777) === (c.mode & 0o777) && sameFile(f, c)) unchanged.push(f.path);
    else restore.push(f.path);
  }
  const moveToStash = current.files.map((f) => f.path).filter((p) => !snapshotPaths.has(p)).sort();

  // per-path before/after sizes — the plan must EXPLAIN what changes, not just name it
  const detail: UndoPlan["detail"] = {};
  const snapByPath = new Map(snap.map((f) => [f.path, f]));
  for (const p of restore) detail[p] = { cur: cur.get(p)?.size ?? null, snap: snapByPath.get(p)?.size ?? null };
  for (const p of moveToStash) detail[p] = { cur: cur.get(p)?.size ?? null, snap: null };

  return {
    checkpointDir: pickedDir,
    source: pickedSource,
    targetSeq,
    checkpointSeq: picked.seq,
    restore: restore.sort(),
    unchanged: unchanged.sort(),
    moveToStash,
    detail,
    warnings,
    errors: [],
  };
}

/** Move into the stash, surviving cross-volume boundaries (renameSync throws
 *  EXDEV when ~/.carafe and the worktree are on different volumes). The copy
 *  lands BEFORE the original is removed — never a window with zero copies. */
function moveIntoStash(src: string, moved: string): void {
  mkdirSync(dirname(moved), { recursive: true });
  try {
    renameSync(src, moved);
  } catch {
    copyFileSync(src, moved, constants.COPYFILE_FICLONE);
    chmodSync(moved, statSync(src).mode & 0o777);
    rmSync(src, { force: true });
  }
}

/** A restore destination that is not a regular file must be moved aside first:
 *  a directory can't be copyFile'd over, and a SYMLINK would be written
 *  THROUGH — clobbering its target, possibly outside the repo. */
function moveConflictIfNeeded(dst: string, stashMovedRoot: string, rel: string): void {
  let st;
  try { st = lstatSync(dst); } catch { return; } // missing → nothing to move
  if (st.isFile()) return; // regular file: already stash-copied, safe to overwrite
  const moved = join(stashMovedRoot, rel);
  mkdirSync(dirname(moved), { recursive: true });
  renameSync(dst, moved);
}

export function applyUndo(store: CarafeStore, d: SessionDistillate, plan: UndoPlan, exec: ExecFn = realExec): UndoApplyResult {
  if (plan.errors.length) throw new Error(plan.errors.join("\n"));
  if (!d.cwd) throw new Error("cwd missing");
  const manifest = readCheckpointManifest(plan.checkpointDir);
  if (!manifest) throw new Error("checkpoint manifest missing");

  const stash = takePreUndoCheckpoint(store, d, plan.targetSeq, manifest.ts, exec);
  if (!stash) throw new Error("failed to create pre-undo stash; worktree left untouched");
  // Files the stash COPY couldn't capture (e.g. oversized) are preserved by
  // MOVING the current version whole into the stash before overwriting — a
  // rename costs nothing at any size. Nothing is ever refused or lost.
  const notCopied = new Set(stash.manifest.skipped.filter((s) => s.reason !== SKIP_NOT_REGULAR).map((s) => s.path));

  const movedRoot = join(stash.dir, "files-moved");
  let restored = 0;
  for (const rel of plan.restore) {
    const src = snapshotFileAbs(plan.checkpointDir, rel);
    const dst = join(d.cwd, rel);
    moveConflictIfNeeded(dst, movedRoot, rel);
    if (notCopied.has(rel) && existsSync(dst)) moveIntoStash(dst, join(movedRoot, rel));
    mkdirSync(dirname(dst), { recursive: true });
    copyFileSync(src, dst, constants.COPYFILE_FICLONE);
    chmodSync(dst, statSync(src).mode & 0o777);
    restored++;
  }

  let moved = 0;
  for (const rel of plan.moveToStash) {
    const src = join(d.cwd, rel);
    if (!existsSync(src)) continue;
    moveIntoStash(src, join(movedRoot, rel));
    moved++;
  }

  return { plan, stashDir: stash.dir, restored, moved };
}

function discardedLines(events: CarafeEvent[], targetSeq: number): string[] {
  const tail = events.filter((e) => e.seq > targetSeq && (e.kind === "user" || e.kind === "assistant"));
  const last = tail.slice(-5);
  const pieces = extractPieces(last, { includeThinking: false }, {});
  return pieces.map(firstLineOf).filter(Boolean);
}

export function rewindBriefPath(store: CarafeStore, sessionId: string, targetSeq: number): string {
  return join(store.root, "handoffs", `${sessionId}-rewind-${targetSeq}.md`);
}

export function writeRewindBrief(store: CarafeStore, d: SessionDistillate, events: CarafeEvent[], targetSeq: number): string {
  const good = events.filter((e) => e.seq <= targetSeq);
  const discarded = discardedLines(events, targetSeq);
  const briefDistillate: SessionDistillate = {
    ...d,
    eventCount: good.length,
    endTs: [...good].reverse().find((e) => e.ts)?.ts ?? d.startTs,
  };
  const rendered = renderHandoff(briefDistillate, good, { includeThinking: false });
  const path = rewindBriefPath(store, d.sessionId, targetSeq);
  mkdirSync(dirname(path), { recursive: true });
  const header = [
    `# Rewind Brief: ${d.title ?? d.sessionId}`,
    ``,
    `REWIND: this run went off track after seq ${targetSeq}. Below is the verified-good trace up to that point. The discarded tail attempted: ${discarded.length ? discarded.join(" | ") : "(nothing captured after this point)"}. Continue from the good state; do not repeat the discarded approach.`,
    ``,
    `---`,
    ``,
  ].join("\n");
  writeFileSync(path, header + rendered.text);
  return path;
}

function human(n: number | null): string {
  if (n === null) return "not present";
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)}MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${n}B`;
}

export function formatUndoPlan(plan: UndoPlan): string {
  const lines: string[] = [];
  lines.push(`undo plan: checkpoint seq ${plan.checkpointSeq} -> target seq ${plan.targetSeq}`);
  lines.push(`source: ${plan.source}`);
  if (plan.checkpointDir) lines.push(`checkpoint: ${plan.checkpointDir}`);
  for (const w of plan.warnings) lines.push(w);
  for (const e of plan.errors) lines.push(`ERROR: ${e}`);
  const describe = (f: string, kind: "restore" | "move") => {
    const d = plan.detail[f];
    if (!d) return `  ${f}`;
    if (kind === "move") return `  ${f} (${human(d.cur)} — set aside in stash)`;
    return `  ${f} (now ${human(d.cur)} → becomes ${human(d.snap)})`;
  };
  const bucket = (name: string, files: string[], kind?: "restore" | "move") => {
    lines.push(`${name}: ${files.length}`);
    for (const f of files.slice(0, 40)) lines.push(kind ? describe(f, kind) : `  ${f}`);
    if (files.length > 40) lines.push(`  ... ${files.length - 40} more`);
  };
  bucket("restore", plan.restore, "restore");
  bucket("unchanged", plan.unchanged);
  bucket("move-to-stash", plan.moveToStash, "move");
  if (!plan.errors.length && (plan.restore.length || plan.moveToStash.length))
    lines.push(`nothing is deleted — every current version is preserved in the pre-undo stash`);
  return lines.join("\n");
}
