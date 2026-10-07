import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { disableService, enableService, formatServiceStatus, restartService, statusService, type ServiceRunner } from "./service";

let root = "";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "carafe-service-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const opts = (runner: ServiceRunner) => ({ home: root, serviceDir: join(root, "LaunchAgents"), runner });

function fakeRunner(results: Array<{ code: number; out?: string }>): { runner: ServiceRunner; calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    runner: (cmd) => {
      calls.push(cmd);
      const result = results[Math.min(calls.length - 1, results.length - 1)] ?? { code: 0 };
      return { code: result.code, out: result.out ?? "" };
    },
  };
}

describe("capture service", () => {
  test("enable writes a valid plist and bootstraps it", () => {
    // bootout finds a loaded agent (0), print then no longer finds it (113), bootstrap succeeds.
    const fake = fakeRunner([{ code: 0 }, { code: 113 }, { code: 0 }]);
    const result = enableService({ ...opts(fake.runner), platform: "darwin" });
    const text = readFileSync(result.paths.serviceFile, "utf8");
    expect(result.ok).toBe(true);
    expect(text).toContain("<string>com.carafe.watch</string>");
    expect(text).toContain("<true/>");
    expect(text).toContain("<string>watch</string>");
    expect(text).toContain("<string>--interval</string>");
    expect(text).toContain("<string>10</string>");
    expect(text).toContain("<string>Background</string>");
    expect(text).toContain(join(root, ".carafe", "state", "watch-service.log"));
    expect(fake.calls).toEqual([
      ["launchctl", "bootout", `gui/${process.getuid?.() ?? 0}/com.carafe.watch`],
      ["launchctl", "print", `gui/${process.getuid?.() ?? 0}/com.carafe.watch`],
      ["launchctl", "bootstrap", `gui/${process.getuid?.() ?? 0}`, result.paths.serviceFile],
    ]);
  });

  test("enable retries the bootstrap while launchd is still unloading the old agent", () => {
    const fake = fakeRunner([{ code: 0 }, { code: 113 }, { code: 5, out: "Bootstrap failed: 5: Input/output error" }, { code: 0 }]);
    const result = enableService({ ...opts(fake.runner), platform: "darwin" });
    expect(result.ok).toBe(true);
    expect(fake.calls.filter((cmd) => cmd[1] === "bootstrap")).toHaveLength(2);
  });

  test("disable bootouts and removes only the generated service file", () => {
    const fake = fakeRunner([{ code: 1 }]);
    const enabled = enableService({ ...opts(fakeRunner([{ code: 1 }, { code: 0 }]).runner), platform: "darwin" });
    const other = join(root, "LaunchAgents", "other.plist");
    writeFileSync(other, "user-owned");
    const result = disableService({ ...opts(fake.runner), platform: "darwin" });
    expect(result.ok).toBe(true);
    expect(existsSync(enabled.paths.serviceFile)).toBe(false);
    expect(readFileSync(other, "utf8")).toBe("user-owned");
    expect(fake.calls).toEqual([["launchctl", "bootout", `gui/${process.getuid?.() ?? 0}/com.carafe.watch`]]);
  });

  test("status reports missing, installed, running, and lock holder facts", () => {
    const missing = statusService({ ...opts(fakeRunner([{ code: 1 }]).runner), platform: "darwin" });
    expect(missing.present).toBe(false);
    expect(missing.loaded).toBe(false);
    expect(formatServiceStatus(missing)).toContain("service file: missing");

    const enabled = enableService({ ...opts(fakeRunner([{ code: 1 }, { code: 0 }]).runner), platform: "darwin" });
    mkdirSync(join(root, ".carafe", "state"), { recursive: true });
    writeFileSync(join(root, ".carafe", "state", "watch.lock"), `${process.pid}\ntest-token\n`);
    const running = statusService({ ...opts(fakeRunner([{ code: 0, out: "state = running" }]).runner), platform: "darwin" });
    expect(running.present).toBe(true);
    expect(running.loaded).toBe(true);
    expect(running.running).toBe(true);
    expect(running.holderPid).toBe(process.pid);
    expect(running.holderAlive).toBe(true);
    expect(formatServiceStatus(running)).toContain(`watch lock: pid ${process.pid} alive`);
    expect(enabled.paths.serviceFile).toBe(running.path);
  });

  test("second enable rewrites and reloads without duplicate calls", () => {
    // first: nothing loaded (bootout 1) → bootstrap; second: loaded (0) → unloaded (113) → bootstrap
    const fake = fakeRunner([{ code: 1 }, { code: 0 }, { code: 0 }, { code: 113 }, { code: 0 }]);
    const first = enableService({ ...opts(fake.runner), platform: "darwin" });
    const firstText = readFileSync(first.paths.serviceFile, "utf8");
    const second = enableService({ ...opts(fake.runner), platform: "darwin", intervalSeconds: 12 });
    const secondText = readFileSync(second.paths.serviceFile, "utf8");
    expect(secondText).not.toBe(firstText);
    expect(secondText).toContain("<string>12</string>");
    expect(fake.calls).toHaveLength(5);
    expect(fake.calls.filter((cmd) => cmd[1] === "bootstrap")).toHaveLength(2);
  });

  test("linux enable installs and activates the user unit", () => {
    const fake = fakeRunner([{ code: 0 }, { code: 0 }]);
    const result = enableService({ ...opts(fake.runner), platform: "linux" });
    const text = readFileSync(result.paths.serviceFile, "utf8");
    expect(text).toContain("Restart=always");
    expect(text).toContain("WantedBy=default.target");
    expect(fake.calls).toEqual([
      ["systemctl", "--user", "daemon-reload"],
      ["systemctl", "--user", "enable", "--now", "carafe-watch"],
    ]);
  });
  describe("restart", () => {
    const target = `gui/${process.getuid?.() ?? 0}/com.carafe.watch`;
    const notFound = { code: 113, out: `Could not find service "com.carafe.watch" in domain for user gui: ${process.getuid?.() ?? 0}` };

    test("a loaded service is kick-started, nothing else", () => {
      const fake = fakeRunner([{ code: 0 }]);
      const result = restartService({ ...opts(fake.runner), platform: "darwin" });
      expect(result).toEqual({ ok: true, message: "watcher restarted" });
      expect(fake.calls).toEqual([["launchctl", "kickstart", "-k", target]]);
    });

    test("a service launchd does not have, with its plist installed, is bootstrapped", () => {
      const enabled = enableService({ ...opts(fakeRunner([{ code: 1 }, { code: 0 }]).runner), platform: "darwin" });
      const fake = fakeRunner([notFound, { code: 0 }]);
      const result = restartService({ ...opts(fake.runner), platform: "darwin" });
      expect(result.ok).toBe(true);
      expect(result.message).toContain("bootstrapped");
      expect(fake.calls).toEqual([
        ["launchctl", "kickstart", "-k", target],
        ["launchctl", "bootstrap", `gui/${process.getuid?.() ?? 0}`, enabled.paths.serviceFile],
      ]);
    });

    test("not loaded is confirmed with print when kickstart's error does not say so", () => {
      enableService({ ...opts(fakeRunner([{ code: 1 }, { code: 0 }]).runner), platform: "darwin" });
      const fake = fakeRunner([{ code: 1, out: "odd failure" }, { code: 113 }, { code: 0 }]);
      const result = restartService({ ...opts(fake.runner), platform: "darwin" });
      expect(result.ok).toBe(true);
      expect(fake.calls.map((cmd) => cmd[1])).toEqual(["kickstart", "print", "bootstrap"]);
    });

    test("a loaded service whose kickstart fails is reported, never bootstrapped", () => {
      enableService({ ...opts(fakeRunner([{ code: 1 }, { code: 0 }]).runner), platform: "darwin" });
      const fake = fakeRunner([{ code: 1, out: "Operation not permitted" }, { code: 0 }]);
      const result = restartService({ ...opts(fake.runner), platform: "darwin" });
      expect(result.ok).toBe(false);
      expect(result.message).toBe("watcher restart failed: Operation not permitted");
      expect(fake.calls.map((cmd) => cmd[1])).toEqual(["kickstart", "print"]);
    });

    test("not loaded and no plist: one clear line naming the install command (ok false = CLI exit 1)", () => {
      const fake = fakeRunner([notFound]);
      const result = restartService({ ...opts(fake.runner), platform: "darwin" });
      expect(result.ok).toBe(false);
      expect(result.message.split("\n")).toHaveLength(1);
      expect(result.message).toContain("not installed");
      expect(result.message).toContain("carafe service enable");
      expect(fake.calls).toEqual([["launchctl", "kickstart", "-k", target]]);
    });
  });
});
