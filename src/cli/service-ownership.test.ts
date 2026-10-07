import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  enableService, formatServiceStatus, plistProgramArguments, refreshServiceAfterUpdate, serviceProgram, statusService,
  systemdExecStart, type ServicePlatform, type ServiceRunner,
} from "./service";

let root = "";
let cliBin = "";
let appBin = "";

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "carafe-owner-")));
  cliBin = join(root, "bin", "carafe");
  appBin = join(root, "Applications", "Carafe.app", "Contents", "MacOS", "carafe-arm64");
  for (const bin of [cliBin, appBin]) {
    mkdirSync(join(bin, ".."), { recursive: true });
    writeFileSync(bin, "#!/bin/sh\n", { mode: 0o755 });
  }
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function recorder(results: Array<{ code: number; out?: string }> = [{ code: 0 }]): { runner: ServiceRunner; calls: string[][] } {
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

const base = (platform: ServicePlatform, runner: ServiceRunner) => ({ home: root, serviceDir: join(root, "services"), platform, runner });

/** Install a service definition that runs `program`, as its owner's `carafe service enable` would. */
function install(platform: ServicePlatform, program: string[]): string {
  const setup = recorder([{ code: 1 }, { code: 0 }]);
  return enableService({ ...base(platform, setup.runner), program }).paths.serviceFile;
}

const target = `gui/${process.getuid?.() ?? 0}/com.carafe.watch`;

describe("carafe update and the capture service it does not own", () => {
  test("same binary (darwin): kick-started in place, definition byte-identical", () => {
    const file = install("darwin", [cliBin]);
    const before = readFileSync(file);
    const fake = recorder([{ code: 0, out: "state = running" }, { code: 0 }]);
    const result = refreshServiceAfterUpdate({ ...base("darwin", fake.runner), binary: realpathSync(cliBin), version: "0.2.0" });
    expect(result).toEqual({ ok: true, action: "restarted", message: "capture service restarted on 0.2.0" });
    expect(fake.calls).toEqual([["launchctl", "print", target], ["launchctl", "kickstart", "-k", target]]);
    expect(readFileSync(file).equals(before)).toBe(true);
  });

  test("same binary reached through a symlink counts as the same (realpath)", () => {
    const link = join(root, "bin", "carafe-link");
    symlinkSync(cliBin, link);
    const file = install("darwin", [link]);
    const before = readFileSync(file);
    const fake = recorder([{ code: 0 }, { code: 0 }]);
    const result = refreshServiceAfterUpdate({ ...base("darwin", fake.runner), binary: realpathSync(cliBin), version: "0.2.0" });
    expect(result.action).toBe("restarted");
    expect(readFileSync(file).equals(before)).toBe(true);
  });

  test("app-owned (darwin): nothing run, definition byte-identical, one line naming the app's binary", () => {
    const file = install("darwin", [appBin]);
    const before = readFileSync(file);
    const fake = recorder();
    const result = refreshServiceAfterUpdate({ ...base("darwin", fake.runner), binary: realpathSync(cliBin), version: "0.2.0" });
    expect(result.ok).toBe(true);
    expect(result.action).toBe("left");
    expect(result.message).toBe(`capture service runs ${appBin} — left as is (update that copy, e.g. Carafe.app, to update the service)`);
    expect(fake.calls).toEqual([]);
    expect(readFileSync(file).equals(before)).toBe(true);
  });

  test("not loaded (darwin): nothing restarted or written", () => {
    const file = install("darwin", [cliBin]);
    const before = readFileSync(file);
    const fake = recorder([{ code: 113, out: "Could not find service" }]);
    const result = refreshServiceAfterUpdate({ ...base("darwin", fake.runner), binary: realpathSync(cliBin), version: "0.2.0" });
    expect(result).toEqual({ ok: true, action: "none", message: null });
    expect(fake.calls).toEqual([["launchctl", "print", target]]);
    expect(readFileSync(file).equals(before)).toBe(true);
  });

  test("no service definition: nothing run, nothing installed", () => {
    const fake = recorder();
    const result = refreshServiceAfterUpdate({ ...base("darwin", fake.runner), binary: realpathSync(cliBin), version: "0.2.0" });
    expect(result.action).toBe("none");
    expect(fake.calls).toEqual([]);
    expect(existsSync(join(root, "services"))).toBe(false);
  });

  test("unreadable or unrecognised definition: nothing run, no crash, file untouched", () => {
    const file = install("darwin", [cliBin]);
    writeFileSync(file, "bplist00\u0000garbage");
    const before = readFileSync(file);
    const fake = recorder();
    expect(refreshServiceAfterUpdate({ ...base("darwin", fake.runner), binary: realpathSync(cliBin), version: "0.2.0" }).action).toBe("none");
    expect(readFileSync(file).equals(before)).toBe(true);

    chmodSync(file, 0o000);
    try {
      expect(refreshServiceAfterUpdate({ ...base("darwin", fake.runner), binary: realpathSync(cliBin), version: "0.2.0" }).action).toBe("none");
    } finally {
      chmodSync(file, 0o644);
    }
    expect(fake.calls).toEqual([]);
    expect(readFileSync(file).equals(before)).toBe(true);
  });

  test("a failing kickstart is reported (update exit 1), never re-enabled", () => {
    const file = install("darwin", [cliBin]);
    const before = readFileSync(file);
    const fake = recorder([{ code: 0 }, { code: 1, out: "Operation not permitted" }]);
    const result = refreshServiceAfterUpdate({ ...base("darwin", fake.runner), binary: realpathSync(cliBin), version: "0.2.0" });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("Operation not permitted");
    expect(result.message).toContain("carafe service restart");
    expect(fake.calls.map((cmd) => cmd[1])).toEqual(["print", "kickstart"]);
    expect(readFileSync(file).equals(before)).toBe(true);
  });

  describe("linux user unit", () => {
    test("same binary: systemctl --user restart only, unit byte-identical", () => {
      const file = install("linux", [cliBin]);
      const before = readFileSync(file);
      const fake = recorder([{ code: 0, out: "active" }, { code: 0 }]);
      const result = refreshServiceAfterUpdate({ ...base("linux", fake.runner), binary: realpathSync(cliBin), version: "0.2.0" });
      expect(result.message).toBe("capture service restarted on 0.2.0");
      expect(fake.calls).toEqual([["systemctl", "--user", "is-active", "carafe-watch"], ["systemctl", "--user", "restart", "carafe-watch"]]);
      expect(readFileSync(file).equals(before)).toBe(true);
    });

    test("another carafe's unit: nothing run, unit byte-identical", () => {
      const file = install("linux", [appBin]);
      const before = readFileSync(file);
      const fake = recorder();
      const result = refreshServiceAfterUpdate({ ...base("linux", fake.runner), binary: realpathSync(cliBin), version: "0.2.0" });
      expect(result.action).toBe("left");
      expect(result.message).toContain(appBin);
      expect(fake.calls).toEqual([]);
      expect(readFileSync(file).equals(before)).toBe(true);
    });

    test("inactive unit: nothing restarted", () => {
      const file = install("linux", [cliBin]);
      const before = readFileSync(file);
      const fake = recorder([{ code: 3, out: "inactive" }]);
      expect(refreshServiceAfterUpdate({ ...base("linux", fake.runner), binary: realpathSync(cliBin), version: "0.2.0" }).action).toBe("none");
      expect(fake.calls).toEqual([["systemctl", "--user", "is-active", "carafe-watch"]]);
      expect(readFileSync(file).equals(before)).toBe(true);
    });

    test("unit without a readable ExecStart: nothing run", () => {
      const file = install("linux", [cliBin]);
      writeFileSync(file, "[Service]\nType=simple\nExecStart=\"unterminated watch\n");
      const fake = recorder();
      expect(refreshServiceAfterUpdate({ ...base("linux", fake.runner), binary: realpathSync(cliBin), version: "0.2.0" }).action).toBe("none");
      expect(fake.calls).toEqual([]);
    });
  });
});

describe("implicit enable (install.sh: --keep-owner) keeps the owner", () => {
  test("a service running another existing carafe is left byte-identical, nothing run", () => {
    const file = install("darwin", [appBin]);
    const before = readFileSync(file);
    const fake = recorder();
    const result = enableService({ ...base("darwin", fake.runner), program: [cliBin], keepOwner: true });
    expect(result.ok).toBe(true);
    expect(result.left).toBe(true);
    expect(result.message).toContain(`capture service runs ${appBin} — left as is`);
    expect(fake.calls).toEqual([]);
    expect(readFileSync(file).equals(before)).toBe(true);
  });

  test("the same carafe, an orphan (its carafe is gone), or no service: enabled as usual", () => {
    const fake = recorder([{ code: 1 }, { code: 0 }]);
    const fresh = enableService({ ...base("linux", fake.runner), program: [cliBin], keepOwner: true });
    expect(fresh.left).toBeUndefined();
    expect(serviceProgram(base("linux", fake.runner)).argv).toEqual([cliBin]);

    expect(enableService({ ...base("linux", fake.runner), program: [cliBin], keepOwner: true, intervalSeconds: 7 }).left).toBeUndefined();
    expect(readFileSync(fresh.paths.serviceFile, "utf8")).toContain("--interval 7");

    install("darwin", [join(root, "gone", "carafe")]);
    const orphan = enableService({ ...base("darwin", recorder([{ code: 1 }, { code: 0 }]).runner), program: [cliBin], keepOwner: true });
    expect(orphan.left).toBeUndefined();
    expect(serviceProgram(base("darwin", fake.runner)).argv).toEqual([cliBin]);
  });

  test("an unreadable definition is left as is", () => {
    const file = install("darwin", [appBin]);
    writeFileSync(file, "not a plist");
    const fake = recorder();
    const result = enableService({ ...base("darwin", fake.runner), program: [cliBin], keepOwner: true });
    expect(result.left).toBe(true);
    expect(fake.calls).toEqual([]);
    expect(readFileSync(file, "utf8")).toBe("not a plist");
  });

  test("explicit `carafe service enable` still takes the service over", () => {
    install("darwin", [appBin]);
    enableService({ ...base("darwin", recorder([{ code: 1 }, { code: 0 }]).runner), program: [cliBin] });
    expect(serviceProgram(base("darwin", recorder().runner)).argv).toEqual([cliBin]);
  });
});

describe("service status names the binary the service runs", () => {
  const status = (platform: ServicePlatform, program: string[]) =>
    formatServiceStatus(statusService({ ...base(platform, recorder([{ code: 0 }]).runner), program }));

  test("none, this carafe, another carafe, missing, unreadable", () => {
    expect(status("darwin", [cliBin])).toContain("service binary: none");
    const file = install("darwin", [appBin]);
    expect(status("darwin", [appBin])).toContain(`service binary: ${appBin} (this carafe)`);
    expect(status("darwin", [cliBin])).toContain(`service binary: ${appBin} (another carafe; this one is ${cliBin})`);
    rmSync(appBin);
    expect(status("darwin", [cliBin])).toContain(`service binary: ${appBin} (missing`);
    writeFileSync(file, "junk");
    expect(status("darwin", [cliBin])).toContain("service binary: unknown");
    install("linux", [cliBin]);
    expect(status("linux", [cliBin])).toContain(`service binary: ${cliBin} (this carafe)`);
  });

  test("the four contract lines the menu bar app parses stay first", () => {
    install("darwin", [cliBin]);
    const lines = status("darwin", [cliBin]).split("\n");
    expect(lines.slice(0, 4).map((line) => line.split(":")[0])).toEqual(["service file", "service loaded", "service running", "watch lock"]);
    expect(lines[4]).toStartWith("service binary: ");
  });
});

describe("service definition parsing", () => {
  test("plist ProgramArguments, XML-escaped", () => {
    const text = `<plist><dict><key>Label</key><string>x</string><key>ProgramArguments</key>
  <array>
    <string>/Users/a &amp; b/carafe</string>
    <string>watch</string>
  </array></dict></plist>`;
    expect(plistProgramArguments(text)).toEqual(["/Users/a & b/carafe", "watch"]);
    expect(plistProgramArguments("<plist/>")).toBeNull();
  });

  test("systemd ExecStart, quoted, escaped, bare and prefixed", () => {
    expect(systemdExecStart('[Service]\nExecStart="/home/a b/carafe" "/x/\\"q\\".ts" watch --interval 10\n'))
      .toEqual(["/home/a b/carafe", '/x/"q".ts', "watch", "--interval", "10"]);
    expect(systemdExecStart("ExecStart=-/usr/bin/carafe watch")).toEqual(["/usr/bin/carafe", "watch"]);
    expect(systemdExecStart("[Service]\nType=simple\n")).toBeNull();
  });
});

describe("update source", () => {
  test("update never rewrites the service definition", () => {
    const text = readFileSync(join(import.meta.dir, "update.ts"), "utf8");
    expect(text).not.toContain("enableService");
    expect(text).toContain("refreshServiceAfterUpdate({ binary: current");
  });
});
