import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { buildCorpus } from "../bench/corpus";
import { writeDistillate } from "../format/distillate";
import { sealSession } from "../format/sessions";
import { CarafeStore } from "../format/store";
import { sessionsForCwd } from "../reflex/state";
import {
  backfillSessionIndexes, indexCatalogPath, planSessionIndexBackfill, readIndexCatalog, rebuildIndexCatalog,
  refreshSessionIndexes, sessionIndexFreshness, sessionIndexPath,
} from "../search/session-index";
import { runImport } from "./import";

let root = "";
let oldHome: string | undefined;
let oldCcRoot: string | undefined;
let oldCodexRoot: string | undefined;

function ccPath(id: string, cwd: string): string {
  return join(root, "claude", "projects", cwd.replaceAll("/", "-"), `${id}.jsonl`);
}

function writeCc(id: string, cwd: string, lines: string[]): string {
  const path = ccPath(id, cwd);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, lines.join("\n") + "\n");
  return path;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "carafe-watch-index-"));
  oldHome = process.env.CARAFE_HOME;
  oldCcRoot = process.env.CARAFE_CC_ROOT;
  oldCodexRoot = process.env.CARAFE_CODEX_ROOT;
  process.env.CARAFE_HOME = root;
  process.env.CARAFE_CC_ROOT = join(root, "claude");
  process.env.CARAFE_CODEX_ROOT = join(root, "codex");
});

afterEach(() => {
  if (oldHome === undefined) delete process.env.CARAFE_HOME; else process.env.CARAFE_HOME = oldHome;
  if (oldCcRoot === undefined) delete process.env.CARAFE_CC_ROOT; else process.env.CARAFE_CC_ROOT = oldCcRoot;
  if (oldCodexRoot === undefined) delete process.env.CARAFE_CODEX_ROOT; else process.env.CARAFE_CODEX_ROOT = oldCodexRoot;
  rmSync(root, { recursive: true, force: true });
});

describe("index on capture", () => {
  test("an import tick builds a changed session and the next changed tick rebuilds it", async () => {
    const bench = buildCorpus("gate").find((session) => session.name === "S-11-claude-code")!;
    const source = writeCc(bench.distillate.sessionId, bench.distillate.cwd!, bench.jsonl);
    const first = await runImport({ quiet: true });
    expect(first.changedSessions).toEqual([{ tool: "claude-code", id: bench.distillate.sessionId }]);
    const store = new CarafeStore(root);
    const building: string[] = [];
    expect(refreshSessionIndexes(store, first.changedSessions, { minEvents: 40, onBuild: (session) => building.push(session.sessionId) }).built).toHaveLength(1);
    expect(building).toEqual([bench.distillate.sessionId]); // announced before the build starts
    const imported = JSON.parse(await Bun.file(store.distillatePath("claude-code", bench.distillate.sessionId)).text());
    expect(sessionIndexFreshness(store, imported)).toBe("fresh");

    const appended = JSON.stringify({ type: "assistant", sessionId: bench.distillate.sessionId, uuid: "watch-appended", timestamp: "2026-12-01T00:00:00.000Z", cwd: bench.distillate.cwd, isSidechain: false, message: { model: "claude-opus-5", role: "assistant", content: [{ type: "text", text: "appended" }], usage: {} } });
    writeFileSync(source, `${bench.jsonl.join("\n")}\n${appended}\n`);
    const second = await runImport({ quiet: true });
    expect(second.changedSessions).toHaveLength(1);
    const changed = JSON.parse(await Bun.file(store.distillatePath("claude-code", bench.distillate.sessionId)).text());
    expect(sessionIndexFreshness(store, changed)).toBe("stale");
    // The rebuild debounce (tested below) would defer an index this young.
    expect(refreshSessionIndexes(store, second.changedSessions, { minEvents: 40, minRebuildIntervalMs: 0 }).built).toHaveLength(1);
    expect(sessionIndexFreshness(store, changed)).toBe("fresh");
  });

  test("maxPerTick defers the remainder and minEvents skips small sessions", async () => {
    const sessions = buildCorpus("gate").filter((session) => session.tool === "claude-code").slice(0, 4);
    for (const session of sessions) writeCc(session.distillate.sessionId, session.distillate.cwd!, session.jsonl);
    writeCc("tiny-session", "/tmp/tiny", [JSON.stringify({ type: "user", sessionId: "tiny-session", uuid: "tiny-user", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/tmp/tiny", isSidechain: false, message: { content: "hello" } })]);
    const imported = await runImport({ quiet: true });
    const store = new CarafeStore(root);
    const large = imported.changedSessions.filter((session) => session.id !== "tiny-session");
    const result = refreshSessionIndexes(store, large, { maxPerTick: 2, minEvents: 40 });
    expect(result.built).toHaveLength(2);
    expect(result.deferred).toHaveLength(2);
    expect(refreshSessionIndexes(store, imported.changedSessions.filter((session) => session.id === "tiny-session"), { minEvents: 40 }).skippedSmall).toBe(1);
  });

  test("--all backfill builds missing indexes and skips them as fresh on the second run", async () => {
    const bench = buildCorpus("gate").find((session) => session.name === "S-12-claude-code")!;
    writeCc(bench.distillate.sessionId, bench.distillate.cwd!, bench.jsonl);
    await runImport({ quiet: true });
    const store = new CarafeStore(root);
    const cli = join(import.meta.dir, "index.ts");
    const env = { ...process.env, CARAFE_HOME: root, CARAFE_CC_ROOT: join(root, "claude"), CARAFE_CODEX_ROOT: join(root, "codex"), CARAFE_NO_UPDATE_CHECK: "1" };
    const first = Bun.spawnSync([process.execPath, "run", cli, "index", "--all"], { env, stdout: "pipe", stderr: "pipe" });
    expect(first.exitCode).toBe(0);
    expect(new TextDecoder().decode(first.stdout)).toContain("index backfill: 1 built, 0 skipped fresh");
    expect(existsSync(sessionIndexPath(store, { ...bench.distillate, tool: "claude-code" }))).toBe(true);
    const second = Bun.spawnSync([process.execPath, "run", cli, "index", "--all"], { env, stdout: "pipe", stderr: "pipe" });
    expect(second.exitCode).toBe(0);
    expect(new TextDecoder().decode(second.stdout)).toContain("index backfill: 0 built, 1 skipped fresh");
  });

  test("a stale index younger than the rebuild interval is deferred, not rebuilt", async () => {
    const bench = buildCorpus("gate").find((session) => session.name === "S-11-claude-code")!;
    const source = writeCc(bench.distillate.sessionId, bench.distillate.cwd!, bench.jsonl);
    const first = await runImport({ quiet: true });
    const store = new CarafeStore(root);
    expect(refreshSessionIndexes(store, first.changedSessions, { minEvents: 40 }).built).toHaveLength(1);
    const appended = JSON.stringify({ type: "assistant", sessionId: bench.distillate.sessionId, uuid: "watch-appended-young", timestamp: "2026-12-01T00:00:00.000Z", cwd: bench.distillate.cwd, isSidechain: false, message: { model: "claude-opus-5", role: "assistant", content: [{ type: "text", text: "appended" }], usage: {} } });
    writeFileSync(source, `${bench.jsonl.join("\n")}\n${appended}\n`);
    const second = await runImport({ quiet: true });
    const young = refreshSessionIndexes(store, second.changedSessions, { minEvents: 40, minRebuildIntervalMs: 60_000 });
    expect(young.built).toHaveLength(0);
    expect(young.skippedYoung).toBe(1);
    expect(young.deferred).toEqual(second.changedSessions);
    const later = refreshSessionIndexes(store, young.deferred, { minEvents: 40, minRebuildIntervalMs: 60_000, nowMs: Date.now() + 120_000 });
    expect(later.built).toHaveLength(1);
    expect(later.skippedYoung).toBe(0);
  });

  test("the backfill plan keeps the newest sessions per directory and the catalog drives the reflex", () => {
    const store = new CarafeStore(root);
    const bench = buildCorpus("gate").find((session) => session.name === "S-11-claude-code")!;
    ["backfill-a", "backfill-b", "backfill-c"].forEach((id, day) => {
      const events = bench.events.map((event) => ({ ...event, sessionId: id }));
      const session = {
        ...bench.distillate, sessionId: id, internalSessionId: undefined, sourcePath: `${id}.jsonl`, cwd: "/tmp/backfill-project",
        endTs: `2026-06-0${day + 1}T00:00:00.000Z`, eventCount: events.length,
      };
      sealSession(store, session.tool, id, events);
      writeDistillate(store, session);
    });
    const plan = planSessionIndexBackfill(store, { perCwd: 2 });
    expect(plan.candidates.map((session) => session.sessionId)).toEqual(["backfill-c", "backfill-b"]);
    expect(plan.skippedCapped).toBe(1);
    expect(backfillSessionIndexes(store, { perCwd: 2 }).built).toBe(2);
    expect(planSessionIndexBackfill(store, { perCwd: 2 }).skippedFresh).toBe(2);
    expect(readIndexCatalog(store)?.map((entry) => entry.sessionId)).toEqual(["backfill-c", "backfill-b"]);
    const viaCatalog = sessionsForCwd(store, "/tmp/backfill-project/src").map((source) => source.session.sessionId);
    expect(viaCatalog).toEqual(["backfill-c", "backfill-b"]);
    rmSync(indexCatalogPath(store));
    expect(sessionsForCwd(store, "/tmp/backfill-project/src").map((source) => source.session.sessionId)).toEqual(viaCatalog);
    expect(rebuildIndexCatalog(store).map((entry) => entry.sessionId)).toEqual(["backfill-c", "backfill-b"]);
    expect(existsSync(indexCatalogPath(store))).toBe(true);
  });
});
