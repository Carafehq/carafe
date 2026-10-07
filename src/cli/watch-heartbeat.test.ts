import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  AUTO_RESTART_MIN_INTERVAL_MS, enterStage, HEARTBEAT_BUILD_STALE_MS, HEARTBEAT_STALE_MS, heartbeatPath, judgeHeartbeat, newHeartbeat,
  readHeartbeat, readWatchdogMemory, writeHeartbeat, type WatchdogMemory, type WatchHeartbeat,
} from "./watch-heartbeat";
import { checkWatchdog, formatWatchdogReport, type ServiceRunner } from "./service";

let root = "";
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "carafe-heartbeat-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const T0 = Date.parse("2026-09-22T10:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();
const MIN = 60_000;
const HOUR = 60 * MIN;
const fresh: WatchdogMemory = { version: 1, lastCheckAt: null, lastAutoRestartAt: null };
const alive = () => true;

function beatAt(ms: number, stage: WatchHeartbeat["stage"] = "idle", detail: string | null = null): WatchHeartbeat {
  const hb = newHeartbeat(iso(T0), 4242);
  enterStage(hb, stage, detail, iso(ms));
  hb.at = iso(ms);
  return hb;
}

describe("heartbeat file", () => {
  test("is written atomically (no temp file left behind), round-trips, and reads as null when missing or unreadable", () => {
    const store = join(root, ".carafe");
    expect(readHeartbeat(store)).toBeNull();
    const hb = newHeartbeat(iso(T0), 4242);
    hb.lastTickAt = iso(T0);
    enterStage(hb, "protected-folder", "/Users/ada/Documents", iso(T0 + 1000));
    writeHeartbeat(store, hb, iso(T0 + 1000));
    expect(readdirSync(join(store, "state"))).toEqual(["watch-heartbeat.json"]);
    const read = readHeartbeat(store)!;
    expect(read).toEqual(hb);
    expect(read.at).toBe(iso(T0 + 1000));
    expect(read.stageSince).toBe(iso(T0 + 1000));
    writeFileSync(heartbeatPath(store), "{ half a fi");
    expect(readHeartbeat(store)).toBeNull();
  });

  test("the stage stamp moves only when the stage or its detail changes", () => {
    const hb = newHeartbeat(iso(T0), 1);
    enterStage(hb, "tick", null, iso(T0 + 1000));
    enterStage(hb, "tick", null, iso(T0 + 5000));
    expect(hb.stageSince).toBe(iso(T0 + 1000));
    enterStage(hb, "indexing", "a", iso(T0 + 6000));
    enterStage(hb, "indexing", "b", iso(T0 + 7000));
    expect(hb.stageSince).toBe(iso(T0 + 7000));
  });
});

describe("staleness decision (injected clock)", () => {
  test("fresh is ok; five minutes without a beat while the pid lives is stuck; a dead pid is not running", () => {
    const hb = beatAt(T0);
    expect(judgeHeartbeat(hb, { nowMs: T0 + HEARTBEAT_STALE_MS - 1, pidAlive: alive, memory: fresh, mayRestart: true }).state).toBe("ok");
    const stuck = judgeHeartbeat(hb, { nowMs: T0 + HEARTBEAT_STALE_MS, pidAlive: alive, memory: fresh, mayRestart: true });
    expect(stuck).toMatchObject({ state: "stuck", cause: "unknown", autoRestart: true, withheld: null, ageMs: HEARTBEAT_STALE_MS });
    expect(judgeHeartbeat(hb, { nowMs: T0 + HOUR, pidAlive: () => false, memory: fresh, mayRestart: true })).toMatchObject({ state: "not running", autoRestart: false });
    expect(judgeHeartbeat(null, { nowMs: T0, pidAlive: alive, memory: fresh, mayRestart: true })).toMatchObject({ state: "no heartbeat", autoRestart: false });
  });

  test("a first open of a protected folder is a pending permission prompt: reported, never restarted", () => {
    const hb = beatAt(T0, "protected-folder", "/Users/ada/Documents");
    const v = judgeHeartbeat(hb, { nowMs: T0 + 3 * HOUR, pidAlive: alive, memory: fresh, mayRestart: true });
    expect(v).toMatchObject({ state: "stuck", cause: "permission prompt", autoRestart: false });
    expect(v.withheld).toContain("permission dialog");
    const text = formatWatchdogReport({ verdict: v, restarted: false, restartError: null });
    expect(text).toContain("stuck: Carafe's watcher is stuck (last activity 180 min ago)");
    expect(text).toContain("likely cause: waiting for a macOS permission prompt");
    expect(text).toContain("look for a dialog, or open Privacy settings");
  });

  test("an index build gets fifteen minutes, not five", () => {
    const hb = beatAt(T0, "indexing", "claude-code abc (50000 events)");
    expect(judgeHeartbeat(hb, { nowMs: T0 + 10 * MIN, pidAlive: alive, memory: fresh, mayRestart: true }).state).toBe("ok");
    expect(judgeHeartbeat(hb, { nowMs: T0 + HEARTBEAT_BUILD_STALE_MS, pidAlive: alive, memory: fresh, mayRestart: true })).toMatchObject({ state: "stuck", cause: "index build", autoRestart: true });
  });

  test("at most one automatic restart per thirty minutes, and none unless the caller may act", () => {
    const hb = beatAt(T0);
    const now = T0 + 20 * MIN;
    const recent: WatchdogMemory = { version: 1, lastCheckAt: iso(now - MIN), lastAutoRestartAt: iso(now - 10 * MIN) };
    const held = judgeHeartbeat(hb, { nowMs: now, pidAlive: alive, memory: recent, mayRestart: true });
    expect(held).toMatchObject({ state: "stuck", autoRestart: false });
    expect(held.withheld).toContain("already restarted 10 min ago");
    const later: WatchdogMemory = { ...recent, lastAutoRestartAt: iso(now - AUTO_RESTART_MIN_INTERVAL_MS) };
    expect(judgeHeartbeat(hb, { nowMs: now, pidAlive: alive, memory: later, mayRestart: true }).autoRestart).toBe(true);
    expect(judgeHeartbeat(hb, { nowMs: now, pidAlive: alive, memory: fresh }).autoRestart).toBe(false);
  });

  test("a Mac that slept since the previous check is forgiven once", () => {
    const hb = beatAt(T0);
    const now = T0 + 8 * HOUR;
    const slept: WatchdogMemory = { version: 1, lastCheckAt: iso(T0 + MIN), lastAutoRestartAt: null };
    expect(judgeHeartbeat(hb, { nowMs: now, pidAlive: alive, memory: slept, mayRestart: true }).state).toBe("ok");
    const awake: WatchdogMemory = { version: 1, lastCheckAt: iso(now - MIN), lastAutoRestartAt: null };
    expect(judgeHeartbeat(hb, { nowMs: now, pidAlive: alive, memory: awake, mayRestart: true }).state).toBe("stuck");
  });
});


describe("carafe service watchdog", () => {
  function setup(hb: WatchHeartbeat) {
    const calls: string[][] = [];
    const runner: ServiceRunner = (cmd) => { calls.push(cmd); return { code: 0, out: "" }; };
    writeHeartbeat(join(root, ".carafe"), hb, hb.at);
    return { calls, opts: { home: root, serviceDir: join(root, "LaunchAgents"), runner, platform: "darwin" as const, pidAlive: alive } };
  }

  test("a stuck watcher is kick-started once, and the next check inside thirty minutes only reports", () => {
    const { calls, opts } = setup(beatAt(T0, "tick"));
    const first = checkWatchdog({ ...opts, autoRestart: true, nowMs: T0 + 6 * MIN });
    expect(first.restarted).toBe(true);
    expect(calls).toEqual([["launchctl", "kickstart", "-k", `gui/${process.getuid?.() ?? 0}/com.carafe.watch`]]);
    expect(readWatchdogMemory(join(root, ".carafe")).lastAutoRestartAt).toBe(iso(T0 + 6 * MIN));
    const second = checkWatchdog({ ...opts, autoRestart: true, nowMs: T0 + 7 * MIN });
    expect(second.restarted).toBe(false);
    expect(calls).toHaveLength(1);
    expect(formatWatchdogReport(second)).toContain("auto restart: withheld (already restarted 1 min ago");
  });

  test("a stuck watcher whose service launchd dropped is bootstrapped, and that counts toward the thirty minutes", () => {
    const { opts } = setup(beatAt(T0, "tick"));
    mkdirSync(join(root, "LaunchAgents"), { recursive: true });
    writeFileSync(join(root, "LaunchAgents", "com.carafe.watch.plist"), "<plist/>");
    const calls: string[][] = [];
    const runner: ServiceRunner = (cmd) => { calls.push(cmd); return cmd[1] === "kickstart" ? { code: 113, out: "Could not find service" } : { code: 0, out: "" }; };
    const first = checkWatchdog({ ...opts, runner, autoRestart: true, nowMs: T0 + 6 * MIN });
    expect(first.restarted).toBe(true);
    expect(calls.map((cmd) => cmd[1])).toEqual(["kickstart", "bootstrap"]);
    const second = checkWatchdog({ ...opts, runner, autoRestart: true, nowMs: T0 + 7 * MIN });
    expect(second.restarted).toBe(false);
    expect(calls).toHaveLength(2);
  });

  test("a pending permission prompt is never kick-started; a plain status read writes nothing and restarts nothing", () => {
    const { calls, opts } = setup(beatAt(T0, "protected-folder", join(root, "Documents")));
    const report = checkWatchdog({ ...opts, autoRestart: true, nowMs: T0 + 2 * HOUR });
    expect(report.verdict.cause).toBe("permission prompt");
    expect(calls).toEqual([]);
    rmSync(join(root, ".carafe", "state", "watch-watchdog.json"));
    const read = checkWatchdog({ ...opts, nowMs: T0 + 2 * HOUR });
    expect(read.verdict.state).toBe("stuck");
    expect(calls).toEqual([]);
    expect(existsSync(join(root, ".carafe", "state", "watch-watchdog.json"))).toBe(false);
  });

  test("the report names denied folders for the menu", () => {
    const hb = beatAt(T0);
    hb.deniedFolders = [join(root, "Documents")];
    const { opts } = setup(hb);
    const text = formatWatchdogReport(checkWatchdog({ ...opts, nowMs: T0 + 1000 }));
    expect(text).toContain("watcher: ok");
    expect(text).toContain(`denied folders: ${join(root, "Documents")}`);
    expect(text).toContain("auto restart: not needed");
  });
});
