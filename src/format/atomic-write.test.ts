import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { basename, join } from "path";
import { atomicWriteFileSync } from "./store";

let root = "";
afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); });

describe("atomicWriteFileSync", () => {
  test("leaves complete content and no temporary residue", () => {
    root = mkdtempSync(join(tmpdir(), "carafe-atomic-write-"));
    const path = join(root, "value.json");
    writeFileSync(path, "old");
    atomicWriteFileSync(path, "new content");
    expect(readFileSync(path, "utf8")).toBe("new content");
    expect(readdirSync(root).filter((name) => name.startsWith(`${basename(path)}.tmp.`))).toEqual([]);
  });

  test("concurrent writers leave one complete value", async () => {
    root = mkdtempSync(join(tmpdir(), "carafe-atomic-write-race-"));
    const path = join(root, "value.txt");
    const modulePath = join(process.cwd(), "src/format/store.ts");
    const scripts = ["A".repeat(100_000), "B".repeat(100_000)].map((value) =>
      `import { atomicWriteFileSync } from ${JSON.stringify(modulePath)}; atomicWriteFileSync(${JSON.stringify(path)}, ${JSON.stringify(value)});`);
    const procs = scripts.map((script) => Bun.spawn({ cmd: [process.execPath, "-e", script], cwd: process.cwd(), stdout: "pipe", stderr: "pipe" }));
    await Promise.all(procs.map((p) => p.exited));
    const content = readFileSync(path, "utf8");
    expect(["A".repeat(100_000), "B".repeat(100_000)]).toContain(content);
    expect(readdirSync(root).filter((name) => name.startsWith(`${basename(path)}.tmp.`))).toEqual([]);
  });
});
