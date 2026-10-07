import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, utimesSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { acquireWatchLock, releaseWatchLock, type WatchLock } from "./watch-lock";

let root = "";
afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); });

async function waitFor(path: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path) && Date.now() < deadline) await Bun.sleep(25);
  if (!existsSync(path)) throw new Error(`timed out waiting for ${path}`);
}

function childEnv(extra: Record<string, string> = {}): Record<string, string> {
  return { ...process.env, ...extra, PATH: `/opt/homebrew/bin:${process.env.PATH ?? ""}` } as Record<string, string>;
}

describe("watcher singleton lock", () => {
  test("refuses a second watcher while the lock owner is alive", () => {
    root = mkdtempSync(join(tmpdir(), "carafe-watch-lock-"));
    const lock = acquireWatchLock(root);
    expect(() => acquireWatchLock(root)).toThrow(`Carafe session capture is already running (pid ${process.pid}); lock path: ${lock.lockPath}`);
    releaseWatchLock(lock);
  });

  test("recovers a lock left by a dead process", () => {
    root = mkdtempSync(join(tmpdir(), "carafe-watch-lock-"));
    const old = acquireWatchLock(root);
    writeFileSync(old.lockPath, "2147483647\ndead-token\n");
    const replacement = acquireWatchLock(root);
    expect(replacement.pid).toBe(process.pid);
    releaseWatchLock(replacement);
  });

  test("only the owner removes its lock and pid files", () => {
    root = mkdtempSync(join(tmpdir(), "carafe-watch-lock-"));
    const lock = acquireWatchLock(root);
    releaseWatchLock({ ...lock, pid: process.pid + 1 } satisfies WatchLock);
    expect(() => acquireWatchLock(root)).toThrow(`Carafe session capture is already running (pid ${process.pid}); lock path: ${lock.lockPath}`);
    releaseWatchLock(lock);
  });

  test("two concurrent stale reclaims have exactly one winner", async () => {
    root = mkdtempSync(join(tmpdir(), "carafe-watch-lock-race-"));
    const state = join(root, "state");
    mkdirSync(state);
    writeFileSync(join(state, "watch.lock"), "2147483647\ndead-token\n");
    const modulePath = join(process.cwd(), "src/cli/watch-lock.ts");
    const releasePath = join(root, "release-winner");
    const reports = Array.from({ length: 8 }, (_, index) => join(root, `report-${index}.json`));
    const script = (reportPath: string) => `import { existsSync, writeFileSync } from "fs";
import { acquireWatchLock, releaseWatchLock } from ${JSON.stringify(modulePath)};
const stamp = () => performance.timeOrigin + performance.now();
const report = { start: stamp(), result: "" as "won" | "held", decided: 0, exit: 0 };
try {
  const lock = acquireWatchLock(${JSON.stringify(root)});
  report.result = "won"; report.decided = stamp(); writeFileSync(${JSON.stringify(reportPath)}, JSON.stringify(report));
  while (!existsSync(${JSON.stringify(releasePath)})) await Bun.sleep(25);
  releaseWatchLock(lock); report.exit = stamp(); writeFileSync(${JSON.stringify(reportPath)}, JSON.stringify(report));
} catch (e) {
  if (!(e as Error).message.includes("already running")) throw e;
  report.result = "held"; report.decided = report.exit = stamp(); writeFileSync(${JSON.stringify(reportPath)}, JSON.stringify(report));
}`;
    // This must fail against the old unlink-based code: multiple reapers can
    // unlink the same stale pathname before any contender recreates it.
    const procs = reports.map((reportPath) => Bun.spawn({
      cmd: [process.execPath, "-e", script(reportPath)], cwd: process.cwd(), env: childEnv(), stdout: "pipe", stderr: "pipe",
    }));
    await Promise.all(reports.map((path) => waitFor(path, 10_000)));
    const decisions = reports.map((path) => JSON.parse(readFileSync(path, "utf8")) as { start: number; result: "won" | "held"; decided: number; exit: number });
    expect(decisions.filter((report) => report.result === "won")).toHaveLength(1);
    expect(decisions.filter((report) => report.result === "held")).toHaveLength(7);
    expect(() => acquireWatchLock(root)).toThrow(/already running/);

    writeFileSync(releasePath, "release\n");
    const outputs = await Promise.all(procs.map(async (p) => {
      const [code, out, err] = await Promise.all([p.exited, new Response(p.stdout).text(), new Response(p.stderr).text()]);
      expect(code, err).toBe(0);
      return out.trim();
    }));
    expect(outputs).toEqual(Array(8).fill(""));
    const completedWinner = reports.map((path) => JSON.parse(readFileSync(path, "utf8")) as { result: "won" | "held"; decided: number; exit: number }).find((report) => report.result === "won")!;
    expect(completedWinner.exit).toBeGreaterThanOrEqual(completedWinner.decided);

    const afterExit = acquireWatchLock(root);
    expect(afterExit.pid).toBe(process.pid);
    releaseWatchLock(afterExit);
  });

  test("releases watcher lock and pid files on SIGINT", async () => {
    root = mkdtempSync(join(tmpdir(), "carafe-watch-signal-"));
    const lockPath = join(root, "state", "watch.lock");
    const pidPath = join(root, "watch.pid");
    const proc = Bun.spawn({
      cmd: [process.execPath, "run", "src/cli/index.ts", "watch", "--interval", "60"],
      cwd: process.cwd(), env: childEnv({ CARAFE_HOME: root, CARAFE_CC_ROOT: join(root, "claude"), CARAFE_CODEX_ROOT: join(root, "codex") }),
      stdout: "pipe", stderr: "pipe",
    });
    await waitFor(lockPath);
    proc.kill("SIGINT");
    expect(await proc.exited).toBe(0);
    expect(existsSync(lockPath)).toBe(false);
    expect(existsSync(pidPath)).toBe(false);
  });

  test("releases UI lock on SIGTERM without creating a pid file", async () => {
    root = mkdtempSync(join(tmpdir(), "carafe-ui-signal-"));
    const lockPath = join(root, "state", "watch.lock");
    const pidPath = join(root, "watch.pid");
    const port = 45000 + Math.floor(Math.random() * 1000);
    const proc = Bun.spawn({
      cmd: [process.execPath, "run", "src/cli/index.ts", "ui", "--no-open", "--port", String(port)],
      cwd: process.cwd(), env: childEnv({ CARAFE_HOME: root, CARAFE_CC_ROOT: join(root, "claude"), CARAFE_CODEX_ROOT: join(root, "codex") }),
      stdout: "pipe", stderr: "pipe",
    });
    await waitFor(lockPath);
    expect(existsSync(pidPath)).toBe(false);
    proc.kill("SIGTERM");
    expect(await proc.exited).toBe(0);
    expect(existsSync(lockPath)).toBe(false);
  }, 10_000);

  test("EPERM liveness failures count as not alive", () => {
    root = mkdtempSync(join(tmpdir(), "carafe-watch-lock-"));
    mkdirSync(join(root, "state"));
    writeFileSync(join(root, "state", "watch.lock"), "1\nold-token\n");
    const lock = acquireWatchLock(root);
    expect(lock.pid).toBe(process.pid);
    releaseWatchLock(lock);
  });

  test("young empty or garbage locks are held, but old garbage is reclaimable", () => {
    root = mkdtempSync(join(tmpdir(), "carafe-watch-lock-"));
    const lockPath = join(root, "state", "watch.lock");
    mkdirSync(join(root, "state"));
    writeFileSync(lockPath, "");
    expect(() => acquireWatchLock(root)).toThrow(/already running \(pid unknown\)/);
    utimesSync(lockPath, new Date(Date.now() - 61_000), new Date(Date.now() - 61_000));
    const lock = acquireWatchLock(root);
    expect(lock.pid).toBe(process.pid);
    releaseWatchLock(lock);
  });

  test("release does not remove a lock with a different token", () => {
    root = mkdtempSync(join(tmpdir(), "carafe-watch-lock-"));
    const lock = acquireWatchLock(root);
    writeFileSync(lock.lockPath, `${process.pid}\nreplacement-token\n`);
    releaseWatchLock(lock);
    expect(existsSync(lock.lockPath)).toBe(true);
    expect(existsSync(lock.pidPath)).toBe(true);
    unlinkSync(lock.lockPath);
    unlinkSync(lock.pidPath);
  });
});
