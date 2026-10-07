import { describe, expect, test } from "bun:test";
import { FirstImportHeartbeat, Watchdog, WATCHDOG_CHECK_MS } from "./watch";

describe("watchdog", () => {
  test("a never-resolving import fires once at the threshold with exit 75 semantics", () => {
    let now = 0;
    const fired: number[] = [];
    const watchdog = new Watchdog({ now: () => now, thresholdMs: 90_000, onFire: (ms) => fired.push(ms) });
    const neverImport = new Promise<never>(() => {});
    void neverImport;
    for (now = WATCHDOG_CHECK_MS; now <= 150_000; now += WATCHDOG_CHECK_MS) watchdog.check();
    expect(fired).toEqual([90_000]);
  });

  test("completed ticks and progressing first-import stages reset silence", () => {
    let now = 0;
    let fires = 0;
    const watchdog = new Watchdog({ now: () => now, thresholdMs: 90_000, onFire: () => fires++ });
    for (now = 30_000; now <= 300_000; now += 30_000) { watchdog.progress(); watchdog.check(); }
    expect(fires).toBe(0);
  });

  test("an eight-hour sleep is forgiven, then a full new threshold is required", () => {
    let now = 0;
    let fires = 0;
    const watchdog = new Watchdog({ now: () => now, thresholdMs: 90_000, onFire: () => fires++ });
    now = 30_000; watchdog.check();
    now += 8 * 60 * 60 * 1000; expect(watchdog.check()).toBe(false);
    now += 30_000; watchdog.check();
    now += 30_000; watchdog.check();
    expect(fires).toBe(0);
    now += 30_000; expect(watchdog.check()).toBe(true);
    expect(fires).toBe(1);
  });

  test("a sleep jump followed by normal ticks never fires", () => {
    let now = 0;
    let fires = 0;
    const watchdog = new Watchdog({ now: () => now, thresholdMs: 90_000, onFire: () => fires++ });
    now = 8 * 60 * 60 * 1000; watchdog.check();
    for (let i = 0; i < 8; i++) { now += 30_000; watchdog.progress(); watchdog.check(); }
    expect(fires).toBe(0);
  });
});

test("first-import stage heartbeat is independent and silent before ten seconds", () => {
  let now = 0;
  const logs: unknown[][] = [];
  const heartbeat = new FirstImportHeartbeat(() => now, (...args) => logs.push(args));
  heartbeat.enter("read sources");
  now = 9_999; expect(heartbeat.check()).toBe(false);
  now = 10_000; expect(heartbeat.check()).toBe(true);
  now = 20_000; expect(heartbeat.check()).toBe(true);
  expect(logs).toEqual([["read sources", 10], ["read sources", 20]]);
});
