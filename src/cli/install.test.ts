import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

describe("installer", () => {
  test("is POSIX shell syntax and defaults capture on", () => {
    const path = join(import.meta.dir, "../../install.sh");
    const result = Bun.spawnSync({ cmd: ["sh", "-n", path], stdout: "pipe", stderr: "pipe" });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    const text = readFileSync(path, "utf8");
    expect(text).toContain('START_WATCHER="${CARAFE_START_WATCHER:-yes}"');
    expect(text).toContain("--no-watcher");
    expect(text).toContain('"$INSTALL_DIR/carafe" service enable --keep-owner');
    expect(text).not.toContain("nohup");
  });
});

// --channel on a stubbed GitHub: `curl` is replaced by a script that serves a canned
// release listing and refuses every download, so the run stops at "no asset named
// carafe-<resolved>-<target>.tar.gz" — which names the release the channel resolved to.
describe("installer channels", () => {
  const INSTALL = join(import.meta.dir, "../../install.sh");
  let LISTING = "[]";

  function install(args: string[], listing = LISTING): { code: number; stderr: string; requested: string[] } {
    const dir = mkdtempSync(join(tmpdir(), "carafe-install-"));
    try {
      const bin = join(dir, "bin");
      mkdirSync(bin);
      writeFileSync(join(dir, "listing.json"), listing);
      writeFileSync(join(bin, "curl"), [
        "#!/bin/sh",
        'url=""; for a in "$@"; do url=$a; done',
        'echo "$url" >> "$STUB_DIR/requested"',
        "case $url in",
        '  *"/releases?per_page=100") cat "$STUB_DIR/listing.json" ;;',
        '  */releases/tags/*) printf \'{"tag_name": "%s", "assets": []}\' "${url##*/}" ;;',
        '  */releases/latest) printf \'{"tag_name": "v0.1.11", "assets": []}\' ;;',
        "  *) exit 22 ;;",
        "esac",
        "",
      ].join("\n"));
      chmodSync(join(bin, "curl"), 0o755);
      const r = Bun.spawnSync({
        cmd: ["sh", INSTALL, ...args],
        env: {
          PATH: `${bin}:/usr/bin:/bin`, HOME: dir, STUB_DIR: dir, CARAFE_INSTALL_DIR: join(dir, "install"),
          CARAFE_FORCE_INSTALL: "1", CARAFE_START_WATCHER: "no", CARAFE_GITHUB_TOKEN: "", GITHUB_TOKEN: "",
        },
        stdout: "pipe", stderr: "pipe",
      });
      let requested: string[] = [];
      try { requested = readFileSync(join(dir, "requested"), "utf8").trim().split("\n"); } catch { /* none */ }
      return { code: r.exitCode ?? -1, stderr: r.stderr.toString(), requested };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test("stable (the default) installs releases/latest and never lists releases", () => {
    const r = install([]);
    expect(r.stderr).toContain("no asset named carafe-0.1.11-");
    expect(r.requested.some((u) => u.endsWith("/releases/latest"))).toBe(true);
    expect(r.requested.some((u) => u.includes("per_page"))).toBe(false);
  });

});
