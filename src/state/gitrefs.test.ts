import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "fs";
import { randomBytes } from "crypto";
import { tmpdir } from "os";
import { join } from "path";
import { CarafeStore } from "../format/store";
import { sealSession } from "../format/sessions";
import { writeDistillate, type SessionDistillate } from "../format/distillate";
import type { CarafeEvent } from "../format/events";
import type { ExecFn } from "../exec";
import { checkpointDir, maybeAutoCheckpoint, takeCheckpoint } from "./checkpoint";
import { applyUndo, formatUndoPlan, planUndo } from "./undo";
import { enableCheckpointSync, readStoreConfig } from "./sync";
import {
  checkpointRef,
  deleteRemoteRefs,
  listRefCheckpoints,
  materializeCheckpoint,
  mirrorCheckpoint,
  pushCheckpointRefs,
} from "./gitrefs";

const temps: string[] = [];
const originalEnv = {
  threshold: process.env.CARAFE_CHUNK_THRESHOLD,
  partBytes: process.env.CARAFE_CHUNK_PART_BYTES,
  carafeHome: process.env.CARAFE_HOME,
};

afterEach(() => {
  process.env.CARAFE_CHUNK_THRESHOLD = originalEnv.threshold;
  process.env.CARAFE_CHUNK_PART_BYTES = originalEnv.partBytes;
  process.env.CARAFE_HOME = originalEnv.carafeHome;
  while (temps.length) rmSync(temps.pop()!, { recursive: true, force: true });
});

function tempDir(prefix = "carafe-gitrefs-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

function run(cmd: string[], cwd: string, env: Record<string, string> = {}): string {
  const r = Bun.spawnSync(cmd, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...env, PATH: `/opt/homebrew/bin:${process.env.PATH ?? ""}` },
  });
  if (r.exitCode !== 0) throw new Error(`${cmd.join(" ")} failed: ${Buffer.from(r.stderr).toString()}`);
  return Buffer.from(r.stdout).toString().trim();
}

const realTestExec: ExecFn = (cmd, cwd, env = {}, input) => {
  const r = Bun.spawnSync(cmd, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    stdin: input !== undefined ? Buffer.from(input) : undefined,
    env: { ...process.env, ...env, PATH: `/opt/homebrew/bin:${process.env.PATH ?? ""}` },
  });
  const stdout = Buffer.from(r.stdout);
  const stderr = Buffer.from(r.stderr);
  return { ok: r.exitCode === 0, out: (r.exitCode === 0 ? stdout : stderr).toString().trim(), stdout, stderr };
};

function initRepo(): string {
  const repo = tempDir("carafe-repo-");
  run(["git", "init"], repo);
  run(["git", "config", "user.email", "test@example.com"], repo);
  run(["git", "config", "user.name", "Test User"], repo);
  writeFileSync(join(repo, "a.txt"), "a1\n");
  writeFileSync(join(repo, "b.txt"), "b1\n");
  writeFileSync(join(repo, "script.sh"), "#!/bin/sh\necho ok\n");
  chmodSync(join(repo, "script.sh"), 0o755);
  run(["git", "add", "a.txt", "b.txt", "script.sh"], repo);
  run(["git", "commit", "-m", "initial"], repo);
  return repo;
}

function addBareOrigin(repo: string): string {
  const bare = tempDir("carafe-origin-");
  run(["git", "init", "--bare"], bare);
  run(["git", "remote", "add", "origin", bare], repo);
  return bare;
}

function files(repo: string) {
  return ["a.txt", "b.txt", "script.sh"].map((path) => {
    const abs = join(repo, path);
    const st = statSync(abs);
    return { path, abs, size: st.size, mode: st.mode, mtimeMs: st.mtimeMs };
  });
}

function store(): CarafeStore {
  return new CarafeStore(tempDir("carafe-store-"));
}

function distillate(cwd: string, sessionId = "s1"): SessionDistillate {
  return {
    tool: "codex",
    sessionId,
    sourcePath: join(cwd, "session.jsonl"),
    title: "Git Refs Test",
    cwd,
    gitBranch: "main",
    startTs: "2026-01-01T10:00:00Z",
    endTs: "2026-01-01T10:10:00Z",
    eventCount: 1,
    toolUseCount: 0,
    sidechain: false,
    rawBytes: 100,
    version: 1,
  };
}

function event(sessionId: string, seq: number): CarafeEvent {
  return { ts: "2026-01-01T10:00:00Z", tool: "codex", sessionId, seq, kind: "user", raw: { payload: { message: `seq ${seq}` } } };
}

describe("git checkpoint refs", () => {
  test("mirror creates a hidden ref without changing status, index, or HEAD", () => {
    const repo = initRepo();
    writeFileSync(join(repo, "untracked.txt"), "u\n");
    const beforeStatus = run(["git", "status", "--porcelain"], repo);
    const beforeHead = run(["git", "rev-parse", "HEAD"], repo);

    const mirrored = mirrorCheckpoint(repo, "codex", "s1", 1, files(repo), { exec: realTestExec });

    expect(run(["git", "rev-parse", checkpointRef("codex", "s1", 1)], repo)).toBe(mirrored.commit);
    expect(run(["git", "status", "--porcelain"], repo)).toBe(beforeStatus);
    expect(run(["git", "rev-parse", "HEAD"], repo)).toBe(beforeHead);
  });

  test("incremental mirror reuses unchanged blobs and links parent commits", () => {
    const repo = initRepo();
    const first = mirrorCheckpoint(repo, "codex", "s1", 1, files(repo), { exec: realTestExec });
    const bBlob1 = run(["git", "ls-tree", first.commit, "b.txt"], repo).split(/\s+/)[2];

    writeFileSync(join(repo, "a.txt"), "a2\n");
    const second = mirrorCheckpoint(repo, "codex", "s1", 2, files(repo), { exec: realTestExec });
    const bBlob2 = run(["git", "ls-tree", second.commit, "b.txt"], repo).split(/\s+/)[2];

    expect(bBlob2).toBe(bBlob1);
    expect(run(["git", "rev-parse", `${second.commit}^`], repo)).toBe(first.commit);
  });

  test("chunked files materialize byte-identically and corrupted parts fail verification", () => {
    process.env.CARAFE_CHUNK_THRESHOLD = "1024";
    process.env.CARAFE_CHUNK_PART_BYTES = "512";
    const repo = initRepo();
    const payload = randomBytes(3000);
    writeFileSync(join(repo, "large.bin"), payload);
    const st = statSync(join(repo, "large.bin"));
    const mirrored = mirrorCheckpoint(repo, "codex", "s1", 1, [{ path: "large.bin", abs: join(repo, "large.bin"), size: st.size, mode: st.mode, mtimeMs: st.mtimeMs }], { exec: realTestExec });
    const tree = run(["git", "ls-tree", "-r", "--long", mirrored.commit], repo);

    expect(tree).toContain("large.bin.carafe-large.json");
    expect(tree).toContain("large.bin.carafe-large/part-000");
    expect(tree).not.toMatch(/\slarge\.bin$/);
    for (const line of tree.split("\n").filter(Boolean)) {
      const size = Number(line.trim().split(/\s+/)[3]);
      expect(size).toBeLessThanOrEqual(1024);
    }

    const out = tempDir("carafe-materialized-");
    materializeCheckpoint(repo, mirrored.commit, out, realTestExec);
    expect(readFileSync(join(out, "files", "large.bin")).equals(payload)).toBe(true);

    const area = tempDir("carafe-corrupt-");
    const index = join(area, "index");
    run(["git", "read-tree", `${mirrored.commit}^{tree}`], repo, { GIT_INDEX_FILE: index });
    writeFileSync(join(area, "bad-part"), "bad");
    const badSha = run(["git", "hash-object", "-w", join(area, "bad-part")], repo);
    run(["git", "update-index", "--add", "--cacheinfo", `100644,${badSha},large.bin.carafe-large/part-000`], repo, { GIT_INDEX_FILE: index });
    const badTree = run(["git", "write-tree"], repo, { GIT_INDEX_FILE: index });
    const badCommit = run(["git", "commit-tree", badTree, "-p", mirrored.commit, "-m", "bad"], repo);
    expect(() => materializeCheckpoint(repo, badCommit, tempDir("carafe-bad-out-"), realTestExec)).toThrow();
  });

  test("push sends refs to a local bare origin and delete prunes them", () => {
    const repo = initRepo();
    const bare = addBareOrigin(repo);
    const mirrored = mirrorCheckpoint(repo, "codex", "s1", 1, files(repo), { exec: realTestExec });

    expect(pushCheckpointRefs(repo, "origin", [mirrored.ref], realTestExec).ok).toBe(true);
    expect(run(["git", "for-each-ref", "--format=%(refname)", "refs/carafe/checkpoints"], bare)).toContain(mirrored.ref);

    expect(deleteRemoteRefs(repo, "origin", [mirrored.ref], realTestExec).ok).toBe(true);
    expect(run(["git", "for-each-ref", "--format=%(refname)", "refs/carafe/checkpoints"], bare)).toBe("");
  });

  test("sync disabled writes no refs; enable writes config; public repos require publicOk", () => {
    const repo = initRepo();
    const bare = addBareOrigin(repo);
    const s = store();
    const d = distillate(repo);

    maybeAutoCheckpoint(s, d, [event("s1", 1)], { now: () => Date.parse("2026-01-01T10:00:00Z"), exec: realTestExec });
    expect(existsSync(join(repo, ".git", "refs", "carafe"))).toBe(false);

    const enabled = enableCheckpointSync(s, repo, { yes: true, exec: realTestExec });
    expect(enabled.ok).toBe(true);
    expect(readStoreConfig(s).checkpointSync?.[bare]?.enabled).toBe(true);

    const publicExec: ExecFn = (cmd, cwd, env) => cmd[0] === "gh"
      ? { ok: true, out: "PUBLIC" }
      : realTestExec(cmd, cwd, env);
    const s2 = store();
    const publicResult = enableCheckpointSync(s2, repo, { exec: publicExec });
    expect(publicResult.ok).toBe(false);
    expect(publicResult.message).toContain("PUBLIC");
  });

  test("undo materializes from a git ref when the local snapshot directory is missing", () => {
    const repo = initRepo();
    addBareOrigin(repo);
    const s = store();
    const d = distillate(repo);
    sealSession(s, d.tool, d.sessionId, [event("s1", 1)]);
    writeDistillate(s, d);
    expect(enableCheckpointSync(s, repo, { yes: true, exec: realTestExec }).ok).toBe(true);

    const cp = takeCheckpoint(s, d, 1, "2026-01-01T10:00:00Z", realTestExec);
    expect(cp?.mirroredRef).toBe(checkpointRef("codex", "s1", 1));
    rmSync(checkpointDir(s, d.tool, d.sessionId, 1), { recursive: true, force: true });
    writeFileSync(join(repo, "a.txt"), "edited\n");

    const plan = planUndo(s, d, 1, realTestExec);
    expect(plan.errors).toEqual([]);
    expect(plan.source).toBe("git ref");
    expect(formatUndoPlan(plan)).toContain("source: git ref");
    applyUndo(s, d, plan, realTestExec);
    expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("a1\n");
  });
});
