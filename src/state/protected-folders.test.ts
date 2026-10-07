import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { displayFolder, protectedFolderOf, protectedFoldersOf, protectedFoldersOfEncodedNames, ProtectedFolderGate, realAccessProbe } from "./protected-folders";

const temps: string[] = [];
afterEach(() => { while (temps.length) rmSync(temps.pop()!, { recursive: true, force: true }); });

test("only Documents, Desktop and Downloads directly under home are protected; a name that merely starts the same is not", () => {
  const home = "/Users/ada";
  expect(protectedFolderOf("/Users/ada/Documents/New project/carafe", home)).toBe("/Users/ada/Documents");
  expect(protectedFolderOf("/Users/ada/Desktop", home)).toBe("/Users/ada/Desktop");
  expect(protectedFolderOf("/Users/ada/Downloads/x/../y", home)).toBe("/Users/ada/Downloads");
  expect(protectedFolderOf("/Users/ada/DocumentsArchive/x", home)).toBeNull();
  expect(protectedFolderOf("/Users/ada/code/Documents/x", home)).toBeNull();
  expect(protectedFolderOf("/Users/bob/Documents/x", home)).toBeNull();
  expect(protectedFolderOf("", home)).toBeNull();
  expect(protectedFoldersOf(["/Users/ada/Documents/a", null, "/Users/ada/Desktop/b", "/Users/ada/Documents/c", "/tmp/x", undefined], home))
    .toEqual(["/Users/ada/Desktop", "/Users/ada/Documents"]);
  expect(displayFolder("/Users/ada/Documents", home)).toBe("~/Documents");
});

test("a folder outside the protected set is never probed; an allowed one is probed once", () => {
  const probes: string[] = [];
  const gate = new ProtectedFolderGate({ home: "/Users/ada", probe: (f) => { probes.push(f); return "ok"; } });
  expect(gate.allow("/Users/ada/code/app")).toBe(true);
  expect(gate.allow(null)).toBe(true);
  expect(gate.allow("/Users/ada/Desktop/a")).toBe(true);
  expect(gate.allow("/Users/ada/Desktop/b")).toBe(true);
  expect(probes).toEqual(["/Users/ada/Desktop"]);
  expect(gate.denied()).toEqual([]);
});

test("the real probe reads EACCES as denied and a missing folder as missing", () => {
  const dir = mkdtempSync(join(tmpdir(), "carafe-folder-probe-"));
  temps.push(dir);
  const locked = join(dir, "locked");
  mkdirSync(locked);
  expect(realAccessProbe(locked)).toBe("ok");
  expect(realAccessProbe(join(dir, "absent"))).toBe("missing");
  chmodSync(locked, 0o000);
  // root reads anything; everyone else is refused
  try {
    if (process.getuid?.() !== 0) expect(realAccessProbe(locked)).toBe("denied");
  } finally { chmodSync(locked, 0o755); }
});

test("Claude Code project directory names map to their protected parent without opening anything", () => {
  const home = "/Users/ada";
  expect(protectedFoldersOfEncodedNames(["-Users-ada-Documents-New-project-carafe", "-Users-ada-Desktop", "-Users-ada-code-app", "-Users-ada-DocumentsArchive-x", "-Users-bob-Documents-x"], home))
    .toEqual(["/Users/ada/Desktop", "/Users/ada/Documents"]);
});
