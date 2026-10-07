import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { formatServiceStatus, statusService } from "./service";
import { newWatchStatus, readWatchStatus, watchStatusAgeMs, watchStatusPath, writeWatchStatus } from "./watch-status";

let root = "";
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "carafe-watch-status-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe("watch status file", () => {
  test("round-trips, reports its age, and reads as null when missing or unreadable", () => {
    const store = join(root, ".carafe");
    expect(readWatchStatus(store)).toBeNull();
    const status = newWatchStatus(10_000, "2026-09-03T10:00:00.000Z", 4242);
    status.ticks = 3; status.indexBacklog = 37; status.lastIndexed = { tool: "claude-code", id: "abc", title: "Acme 1.0", at: "2026-09-03T10:00:00.000Z" };
    writeWatchStatus(store, status);
    const read = readWatchStatus(store);
    expect(read).toEqual(status);
    expect(watchStatusAgeMs(read!, Date.parse("2026-09-03T10:00:12.000Z"))).toBe(12_000);
    writeFileSync(watchStatusPath(store), "{ not json");
    expect(readWatchStatus(store)).toBeNull();
    writeFileSync(watchStatusPath(store), JSON.stringify({ version: 2 }));
    expect(readWatchStatus(store)).toBeNull();
  });

  test("carafe service status reports the last tick and the index backlog, or says the watcher predates it", () => {
    const runner = () => ({ code: 0, out: "" });
    const serviceDir = join(root, "LaunchAgents");
    mkdirSync(serviceDir, { recursive: true });
    const before = formatServiceStatus(statusService({ home: root, serviceDir, runner, platform: "darwin" }));
    expect(before).toContain("service file: missing");
    expect(before).toContain("last tick: unknown");
    expect(before).toContain("index backlog: unknown");

    const status = newWatchStatus(10_000, new Date(Date.now() - 12_000).toISOString(), 4242);
    status.indexBacklog = 37; status.indexed = 5;
    writeWatchStatus(join(root, ".carafe"), status);
    const after = statusService({ home: root, serviceDir, runner, platform: "darwin" });
    expect(after.watch?.indexBacklog).toBe(37);
    expect(after.watch?.ageMs).toBeGreaterThanOrEqual(12_000);
    const text = formatServiceStatus(after);
    expect(text).toMatch(/last tick: 1\ds ago/);
    expect(text).toContain("index backlog: 37 sessions");
    expect(text).toContain("indexed this run: 5");

    status.indexBacklog = 0;
    writeWatchStatus(join(root, ".carafe"), status);
    expect(formatServiceStatus(statusService({ home: root, serviceDir, runner, platform: "darwin" }))).toContain("index backlog: none");
  });
});
