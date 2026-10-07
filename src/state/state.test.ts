import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, truncateSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { CarafeStore } from "../format/store";
import { sealSession } from "../format/sessions";
import { writeDistillate, type SessionDistillate } from "../format/distillate";
import type { CarafeEvent } from "../format/events";
import {
  checkpointDir,
  listCheckpoints,
  maybeAutoCheckpoint,
  readCheckpointManifest,
  drainSnapshotNotes,
  resetFreeSpaceCache,
  snapshotFileAbs,
  takeCheckpoint,
  takeManualCheckpoint,
} from "./checkpoint";
import { objectsRoot } from "./objects";
import { applyUndo, planUndo, writeRewindBrief } from "./undo";
import { ProtectedFolderGate } from "./protected-folders";

const temps: string[] = [];
const originalEnv = {
  maxFiles: process.env.CARAFE_CHECKPOINT_MAX_FILES,
  maxBytes: process.env.CARAFE_CHECKPOINT_MAX_BYTES,
  maxFileBytes: process.env.CARAFE_CHECKPOINT_MAX_FILE_BYTES,
  chunkThreshold: process.env.CARAFE_CHUNK_THRESHOLD,
  chunkPartBytes: process.env.CARAFE_CHUNK_PART_BYTES,
};

function objectCount(s: CarafeStore): number {
  let n = 0;
  const root = objectsRoot(s);
  let shards: string[] = [];
  try { shards = readdirSync(root); } catch { return 0; }
  for (const shard of shards) n += readdirSync(join(root, shard)).length;
  return n;
}

function snapPaths(dir: string): string[] {
  return (readCheckpointManifest(dir)?.files ?? []).map((f) => f.path).sort();
}

function snapText(dir: string, rel: string): string {
  return readFileSync(snapshotFileAbs(dir, rel), "utf8");
}

afterEach(() => {
  resetFreeSpaceCache();
  drainSnapshotNotes();
  process.env.CARAFE_CHECKPOINT_MAX_FILES = originalEnv.maxFiles;
  process.env.CARAFE_CHECKPOINT_MAX_BYTES = originalEnv.maxBytes;
  process.env.CARAFE_CHECKPOINT_MAX_FILE_BYTES = originalEnv.maxFileBytes;
  process.env.CARAFE_CHUNK_THRESHOLD = originalEnv.chunkThreshold;
  process.env.CARAFE_CHUNK_PART_BYTES = originalEnv.chunkPartBytes;
  while (temps.length) rmSync(temps.pop()!, { recursive: true, force: true });
});

function tempDir(prefix = "carafe-state-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

function run(cmd: string[], cwd: string): string {
  const r = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe", env: { ...process.env, PATH: `/opt/homebrew/bin:${process.env.PATH ?? ""}` } });
  if (r.exitCode !== 0) throw new Error(`${cmd.join(" ")} failed: ${Buffer.from(r.stderr).toString()}`);
  return Buffer.from(r.stdout).toString().trim();
}

function initRepo(): string {
  const repo = tempDir("carafe-repo-");
  run(["git", "init"], repo);
  run(["git", "config", "user.email", "test@example.com"], repo);
  run(["git", "config", "user.name", "Test User"], repo);
  writeFileSync(join(repo, ".gitignore"), "ignored.txt\n");
  writeFileSync(join(repo, "tracked.txt"), "original\n");
  writeFileSync(join(repo, "script.sh"), "#!/bin/sh\necho ok\n");
  chmodSync(join(repo, "script.sh"), 0o755);
  run(["git", "add", ".gitignore", "tracked.txt", "script.sh"], repo);
  run(["git", "commit", "-m", "initial"], repo);
  return repo;
}

function store(): CarafeStore {
  return new CarafeStore(tempDir("carafe-store-"));
}

function distillate(cwd: string, sessionId = "s1"): SessionDistillate {
  return {
    tool: "codex",
    sessionId,
    sourcePath: join(cwd, "session.jsonl"),
    title: "State Test",
    cwd,
    gitBranch: "main",
    startTs: "2026-01-01T10:00:00Z",
    endTs: "2026-01-01T10:10:00Z",
    eventCount: 4,
    toolUseCount: 0,
    sidechain: false,
    rawBytes: 100,
    version: 1,
  };
}

function event(sessionId: string, seq: number, kind: string, text: string, ts = "2026-01-01T10:00:00Z", raw: any = {}): CarafeEvent {
  return { ts, tool: "codex", sessionId, seq, kind, raw: { payload: { message: text }, ...raw } };
}

function writeStoredSession(s: CarafeStore, d: SessionDistillate, events: CarafeEvent[]): void {
  sealSession(s, d.tool, d.sessionId, events);
  writeDistillate(s, d);
}

describe("checkpoints", () => {
  test("captures tracked and untracked git-visible files while excluding ignored, .git, and oversized files", () => {
    process.env.CARAFE_CHECKPOINT_MAX_FILE_BYTES = "20";
    const repo = initRepo();
    writeFileSync(join(repo, "untracked.txt"), "visible\n");
    writeFileSync(join(repo, "ignored.txt"), "secret\n");
    writeFileSync(join(repo, "big.bin"), "this is larger than twenty bytes\n");
    const s = store();
    const d = distillate(repo);
    const cp = takeCheckpoint(s, d, 7, "2026-01-01T10:07:00Z");
    expect(cp).not.toBeNull();
    const dir = cp!.dir;
    expect(snapText(dir, "tracked.txt")).toBe("original\n");
    expect(snapText(dir, "untracked.txt")).toBe("visible\n");
    const paths = snapPaths(dir);
    expect(paths).not.toContain("ignored.txt");
    expect(paths.some((p) => p.startsWith(".git/"))).toBe(false);
    expect(paths).not.toContain("big.bin");
    // the snapshot directory holds only a manifest — no files/ tree any more
    expect(existsSync(join(dir, "files"))).toBe(false);

    const m = readCheckpointManifest(dir)!;
    expect(m.gitHead).toBe(run(["git", "rev-parse", "HEAD"], repo));
    expect(m.fileCount).toBe(4);
    expect(m.version).toBe(2);
    expect(m.skipped.some((x) => x.path === "big.bin" && x.reason.includes("larger than"))).toBe(true);
  });

  test("local snapshots do not skip large files by default", () => {
    delete process.env.CARAFE_CHECKPOINT_MAX_FILE_BYTES;
    const repo = initRepo();
    const large = join(repo, "large-default.bin");
    writeFileSync(large, "");
    truncateSync(large, 51 * 1024 * 1024);
    const s = store();
    const d = distillate(repo);
    const cp = takeCheckpoint(s, d, 8, "2026-01-01T10:08:00Z");
    expect(cp).not.toBeNull();
    expect(snapPaths(cp!.dir)).toContain("large-default.bin");
    expect(cp!.manifest.skipped.some((x) => x.path === "large-default.bin")).toBe(false);
  });

  test("local snapshots pack chunk-threshold files and undo restores them transparently", () => {
    process.env.CARAFE_CHUNK_THRESHOLD = "10";
    process.env.CARAFE_CHUNK_PART_BYTES = "5";
    const repo = initRepo();
    writeFileSync(join(repo, "tracked.txt"), "abcdefghijklmnopqrstuvwxyz\n");
    const s = store();
    const d = distillate(repo);
    const cp = takeCheckpoint(s, d, 9, "2026-01-01T10:09:00Z");
    expect(cp).not.toBeNull();
    const chunked = readCheckpointManifest(cp!.dir)!.files!.find((f) => f.path === "tracked.txt")!;
    expect(chunked.parts?.length).toBeGreaterThan(0);
    expect(existsSync(join(cp!.dir, "files"))).toBe(false);

    writeFileSync(join(repo, "tracked.txt"), "edited\n");
    applyUndo(s, d, planUndo(s, d, 9));
    expect(readFileSync(join(repo, "tracked.txt"), "utf8")).toBe("abcdefghijklmnopqrstuvwxyz\n");
  });

  test("maybeAutoCheckpoint obeys recency, monotonic seq, and meta-user guards", () => {
    const repo = initRepo();
    const s = store();
    const d = distillate(repo);
    const ts = "2026-01-01T10:00:00Z";
    const now = Date.parse(ts) + 1000;
    const fresh = maybeAutoCheckpoint(s, d, [event("s1", 1, "user", "fresh", ts)], { now: () => now });
    expect(fresh?.manifest.seq).toBe(1);
    expect(maybeAutoCheckpoint(s, d, [event("s1", 1, "user", "fresh", ts)], { now: () => now })).toBeNull();
    expect(maybeAutoCheckpoint(s, d, [event("s1", 2, "user", "old", "2025-12-31T10:00:00Z")], { now: () => now })).toBeNull();
    expect(maybeAutoCheckpoint(s, distillate(repo, "meta"), [event("meta", 3, "user", "meta", ts, { isMeta: true })], { now: () => now })).toBeNull();
  });

  test("a protected folder is opened once through the gate; refused, its sessions are skipped without another open", () => {
    const home = tempDir("carafe-home-");
    const project = join(home, "Documents", "proj");
    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, "notes.txt"), "hello\n");
    const s = store();
    const d = distillate(project);
    const ts = "2026-01-01T10:00:00Z";
    const probes: string[] = [];
    const order: string[] = [];
    const logs: string[] = [];
    const denied = new ProtectedFolderGate({
      home,
      probe: (folder) => { probes.push(folder); order.push("probe"); return "denied"; },
      onFirstOpen: () => order.push("announce"),
      onFirstOpenDone: (_folder, result) => order.push(`done:${result}`),
      log: (message) => logs.push(message),
    });
    for (let seq = 1; seq <= 3; seq++) {
      expect(maybeAutoCheckpoint(s, d, [event("s1", seq, "user", `seq ${seq}`, ts)], { now: () => Date.parse(ts), gate: denied })).toBeNull();
    }
    expect(probes).toEqual([join(home, "Documents")]);
    expect(order).toEqual(["announce", "probe", "done:denied"]);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("no access to ~/Documents");
    expect(denied.denied()).toEqual([join(home, "Documents")]);
    expect(listCheckpoints(s, d.tool, d.sessionId)).toHaveLength(0);

    const allowed = new ProtectedFolderGate({ home, probe: () => "ok" });
    expect(maybeAutoCheckpoint(s, d, [event("s1", 4, "user", "seq 4", ts)], { now: () => Date.parse(ts), gate: allowed })?.manifest.seq).toBe(4);
    // No gate installed (every command but the watcher): unchanged behaviour.
    expect(maybeAutoCheckpoint(s, distillate(project, "s2"), [event("s2", 1, "user", "seq 1", ts)], { now: () => Date.parse(ts) })?.manifest.seq).toBe(1);
  });

  test("retention keeps newest auto checkpoints and preserves manual checkpoints", () => {
    const repo = initRepo();
    const s = store();
    writeFileSync(join(s.root, "config.json"), JSON.stringify({ version: 1, checkpointKeep: 3 }));
    const d = distillate(repo);
    const ts = "2026-01-01T10:00:00Z";
    takeManualCheckpoint(s, d, 0, ts);
    for (let seq = 1; seq <= 5; seq++) {
      writeFileSync(join(repo, "tracked.txt"), `v${seq}\n`);
      maybeAutoCheckpoint(s, d, [event("s1", seq, "user", `seq ${seq}`, ts)], { now: () => Date.parse(ts) });
    }
    expect(listCheckpoints(s, d.tool, d.sessionId).map((c) => c.seq)).toEqual([0, 3, 4, 5]);
    expect(readCheckpointManifest(checkpointDir(s, d.tool, d.sessionId, 0))?.manual).toBe(true);
  });

  test("an unchanged repository snapshots once: no second manifest, no new objects", () => {
    const repo = initRepo();
    for (let i = 0; i < 2000; i++) writeFileSync(join(repo, `f${i}.txt`), `content ${i}\n`);
    const s = store();
    const d = distillate(repo);
    expect(takeCheckpoint(s, d, 1, "2026-01-01T10:01:00Z")).not.toBeNull();
    const afterFirst = objectCount(s);
    expect(afterFirst).toBeGreaterThan(2000);

    // nothing touched: the snapshot would buy no undo point, so none is taken
    expect(takeCheckpoint(s, d, 2, "2026-01-01T10:02:00Z")).toBeNull();
    expect(objectCount(s)).toBe(afterFirst);
    expect(existsSync(checkpointDir(s, d.tool, d.sessionId, 2))).toBe(false);

    // one file changes: exactly one new object
    writeFileSync(join(repo, "f7.txt"), "different content\n");
    expect(takeCheckpoint(s, d, 3, "2026-01-01T10:03:00Z")).not.toBeNull();
    expect(objectCount(s)).toBe(afterFirst + 1);

    // a mode-only change: a new manifest, but not a single new object
    chmodSync(join(repo, "f8.txt"), 0o755);
    const modeOnly = takeCheckpoint(s, d, 4, "2026-01-01T10:04:00Z");
    expect(modeOnly).not.toBeNull();
    expect(objectCount(s)).toBe(afterFirst + 1);
    expect(readCheckpointManifest(modeOnly!.dir)!.files!.find((f) => f.path === "f8.txt")!.mode).toBe(0o755);
  }, 60_000);

  test("undo from a version-2 snapshot is byte-exact for small, medium and chunked files", () => {
    process.env.CARAFE_CHUNK_THRESHOLD = "4096";
    process.env.CARAFE_CHUNK_PART_BYTES = "1024";
    const repo = initRepo();
    const small = "s".repeat(1024);
    const medium = "m".repeat(300 * 1024);
    const chunked = "c".repeat(4097); // CARAFE_CHUNK_THRESHOLD + 1
    writeFileSync(join(repo, "small.txt"), small);
    writeFileSync(join(repo, "medium.txt"), medium);
    writeFileSync(join(repo, "chunked.bin"), chunked);
    chmodSync(join(repo, "small.txt"), 0o755);
    const s = store();
    const d = distillate(repo);
    const cp = takeCheckpoint(s, d, 5, "2026-01-01T10:05:00Z");
    expect(cp).not.toBeNull();
    expect(readCheckpointManifest(cp!.dir)!.files!.find((f) => f.path === "chunked.bin")!.parts!.length).toBeGreaterThan(0);

    writeFileSync(join(repo, "small.txt"), "clobbered");
    chmodSync(join(repo, "small.txt"), 0o644);
    writeFileSync(join(repo, "medium.txt"), "clobbered");
    writeFileSync(join(repo, "chunked.bin"), "clobbered");
    applyUndo(s, d, planUndo(s, d, 5));

    expect(readFileSync(join(repo, "small.txt"), "utf8")).toBe(small);
    expect(readFileSync(join(repo, "medium.txt"), "utf8")).toBe(medium);
    expect(readFileSync(join(repo, "chunked.bin"), "utf8")).toBe(chunked);
    expect(statSync(join(repo, "small.txt")).mode & 0o777).toBe(0o755);
  });

  test("planning an undo materialises nothing: unchanged files are recognised by hash", () => {
    const repo = initRepo();
    const s = store();
    const d = distillate(repo);
    const cp = takeCheckpoint(s, d, 1, "2026-01-01T10:01:00Z")!;
    writeFileSync(join(repo, "tracked.txt"), "edited\n");
    const plan = planUndo(s, d, 1);
    expect(plan.unchanged).toContain("script.sh");
    expect(plan.restore).toContain("tracked.txt");
    expect(existsSync(join(cp.dir, "files-materialized"))).toBe(false);
  });

  test("a helper agent skips a snapshot its parent already covers, and takes one when it does not", () => {
    const repo = initRepo();
    const s = store();
    const parent = distillate(repo, "parent");
    const agent = distillate(repo, "agent-helper-1");
    const now = Date.parse("2026-01-01T10:00:00Z");
    expect(takeCheckpoint(s, parent, 1, null, undefined, { now })).not.toBeNull();
    expect(takeCheckpoint(s, agent, 1, null, undefined, { now: now + 1000 })).toBeNull();
    expect(drainSnapshotNotes().join(" ")).toContain("parent session snapshotted");
    // the parent's coverage goes stale: the agent snapshots for itself again
    expect(takeCheckpoint(s, agent, 2, null, undefined, { now: now + 16 * 60 * 1000 })).not.toBeNull();
  });

  test("no snapshot is taken when the store's volume is below checkpointMinFreeBytes", () => {
    const repo = initRepo();
    const s = store();
    writeFileSync(join(s.root, "config.json"), JSON.stringify({ version: 1, checkpointMinFreeBytes: Number.MAX_SAFE_INTEGER }));
    const d = distillate(repo);
    resetFreeSpaceCache();
    expect(takeCheckpoint(s, d, 1, null)).toBeNull();
    expect(drainSnapshotNotes().join(" ")).toContain("checkpointMinFreeBytes");
    // a manual snapshot and a pre-undo stash are never refused
    resetFreeSpaceCache();
    expect(takeManualCheckpoint(s, d, 1, null)).not.toBeNull();
  });

  test("non-git cwd snapshots through walk fallback and guard-skips large walks", () => {
    const cwd = tempDir("carafe-plain-");
    writeFileSync(join(cwd, "a.txt"), "a");
    mkdirSync(join(cwd, "sub"));
    writeFileSync(join(cwd, "sub", "b.txt"), "b");
    const s = store();
    const d = distillate(cwd);
    const cp = takeCheckpoint(s, d, 1, "2026-01-01T10:00:00Z");
    expect(cp?.manifest.fileCount).toBe(2);
    expect(snapText(cp!.dir, join("sub", "b.txt"))).toBe("b");

    process.env.CARAFE_CHECKPOINT_MAX_FILES = "1";
    expect(takeCheckpoint(s, distillate(cwd, "guard"), 1, "2026-01-01T10:00:00Z")).toBeNull();
  });
});

describe("undo", () => {
  test("plans restore and move buckets, and dry-run mutates nothing", () => {
    const repo = initRepo();
    const s = store();
    const d = distillate(repo);
    takeCheckpoint(s, d, 1, "2026-01-01T10:01:00Z");
    writeFileSync(join(repo, "tracked.txt"), "edited\n");
    writeFileSync(join(repo, "new.txt"), "new\n");

    const plan = planUndo(s, d, 1);
    expect(plan.restore).toContain("tracked.txt");
    expect(plan.moveToStash).toContain("new.txt");
    expect(readFileSync(join(repo, "tracked.txt"), "utf8")).toBe("edited\n");
    expect(readFileSync(join(repo, "new.txt"), "utf8")).toBe("new\n");
  });

  test("apply restores snapshot content, moves new files to stash, preserves pre-edit content and modes", () => {
    const repo = initRepo();
    const s = store();
    const d = distillate(repo);
    takeCheckpoint(s, d, 1, "2026-01-01T10:01:00Z");
    writeFileSync(join(repo, "tracked.txt"), "edited\n");
    writeFileSync(join(repo, "new.txt"), "new\n");
    chmodSync(join(repo, "script.sh"), 0o644);

    const applied = applyUndo(s, d, planUndo(s, d, 1));
    expect(readFileSync(join(repo, "tracked.txt"), "utf8")).toBe("original\n");
    expect(existsSync(join(repo, "new.txt"))).toBe(false);
    expect(snapText(applied.stashDir, "tracked.txt")).toBe("edited\n");
    expect(snapText(applied.stashDir, "new.txt")).toBe("new\n");
    expect(readFileSync(join(applied.stashDir, "files-moved", "new.txt"), "utf8")).toBe("new\n");
    expect((statSync(join(repo, "script.sh")).mode & 0o777)).toBe(0o755);
  });

  test("an oversized current file is set aside whole and restored over — never refused, never lost", () => {
    const repo = initRepo();
    const s = store();
    const d = distillate(repo);
    const cp = takeCheckpoint(s, d, 3, "2026-01-01T10:00:00Z");
    expect(cp).not.toBeNull();

    // the file grows past the stash-copy limit AFTER the checkpoint
    process.env.CARAFE_CHECKPOINT_MAX_FILE_BYTES = "16";
    const big = "this content is well past the sixteen byte copy limit\n";
    writeFileSync(join(repo, "tracked.txt"), big);

    const plan = planUndo(s, d, 3);
    expect(plan.errors).toEqual([]);
    expect(plan.restore).toContain("tracked.txt");
    // the plan EXPLAINS the change: current size → snapshot size
    expect(plan.detail["tracked.txt"]).toEqual({ cur: big.length, snap: "original\n".length });

    const result = applyUndo(s, d, plan);
    // snapshot content restored
    expect(readFileSync(join(repo, "tracked.txt"), "utf8")).toBe("original\n");
    // the oversized current version is preserved WHOLE in the stash
    const preserved = readFileSync(join(result.stashDir, "files-moved", "tracked.txt"), "utf8");
    expect(preserved).toBe(big);
  });

  test("a symlink at a restore destination is moved aside, never written through", () => {
    const repo = initRepo();
    const s = store();
    const d = distillate(repo);
    const cp = takeCheckpoint(s, d, 3, "2026-01-01T10:00:00Z");
    expect(cp).not.toBeNull();

    // replace tracked.txt with a symlink pointing OUTSIDE the repo
    const outside = tempDir("carafe-outside-");
    const target = join(outside, "precious.txt");
    writeFileSync(target, "do not clobber\n");
    rmSync(join(repo, "tracked.txt"));
    run(["ln", "-s", target, join(repo, "tracked.txt")], repo);

    const plan = planUndo(s, d, 3);
    expect(plan.errors).toEqual([]);
    const result = applyUndo(s, d, plan);

    // the symlink target outside the repo is untouched
    expect(readFileSync(target, "utf8")).toBe("do not clobber\n");
    // the worktree file is a REAL file with the snapshot content again
    expect(readFileSync(join(repo, "tracked.txt"), "utf8")).toBe("original\n");
    expect(result.restored).toBeGreaterThan(0);
  });

  test("apply aborts cleanly when the pre-undo stash cannot be created", () => {
    const repo = initRepo();
    const s = store();
    const d = distillate(repo);
    takeCheckpoint(s, d, 1, "2026-01-01T10:01:00Z");
    writeFileSync(join(repo, "tracked.txt"), "edited\n");
    const plan = planUndo(s, d, 1);
    const sessionState = join(s.root, "state", d.tool, d.sessionId);
    chmodSync(sessionState, 0o555);
    try {
      expect(() => applyUndo(s, d, plan)).toThrow(/failed to create pre-undo stash/);
      expect(readFileSync(join(repo, "tracked.txt"), "utf8")).toBe("edited\n");
    } finally {
      chmodSync(sessionState, 0o755);
    }
  });

  test("rewind brief contains the header, discarded-tail lines, and only good trace body", () => {
    const repo = initRepo();
    const s = store();
    const d = distillate(repo);
    const events = [
      event("s1", 0, "user", "start good", "2026-01-01T10:00:00Z"),
      event("s1", 1, "assistant", "good answer", "2026-01-01T10:01:00Z"),
      event("s1", 2, "tool_result", "secret tail tool output", "2026-01-01T10:02:00Z"),
      event("s1", 3, "user", "try bad path", "2026-01-01T10:03:00Z"),
      event("s1", 4, "assistant", "bad answer", "2026-01-01T10:04:00Z"),
    ];
    writeStoredSession(s, d, events);
    const path = writeRewindBrief(s, d, events, 1);
    const text = readFileSync(path, "utf8");
    expect(path).toContain(join("handoffs", "s1-rewind-1.md"));
    expect(text).toContain("REWIND: this run went off track after seq 1");
    expect(text).toContain("try bad path");
    expect(text).toContain("bad answer");
    expect(text).toContain("start good");
    expect(text).toContain("good answer");
    expect(text).not.toContain("secret tail tool output");
  });
});
