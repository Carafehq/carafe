import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "fs";
import { join, resolve } from "path";
import {
  cacheIsStale, channelOf, checksumFor, compareVersions, DEFAULT_REPO, preferredRelease, releaseRepo, updateAvailable, warningFromCache,
} from "./update";
import { CHANNEL, versionLine } from "../version";

// Runs in both trees. The private tree (Carafe Pro present) updates from the Pro
// repository; scripts/export-open.sh rewrites the name so the open export updates
// from the public one. The suffix is built here, not written out, so the export's
// rewrite leaves this expectation alone and the check below means something there.
describe("release repository", () => {
  const ROOT = resolve(import.meta.dir, "../..");
  const HAS_PRO = existsSync(join(ROOT, "src", "closed", "index.ts"));
  const expected = "Carafehq/carafe" + (HAS_PRO ? "-" + "pro" : "");

  test("the default names the Pro repository in the private tree and the public one in the export", () => {
    expect(DEFAULT_REPO).toBe(expected);
    expect(releaseRepo({})).toBe(expected);
  });
  test("private feed overrides work; public builds keep their fixed feed", () => {
    expect(releaseRepo({ CARAFE_REPO: "someone/fork" })).toBe(HAS_PRO ? "someone/fork" : expected);
    expect(releaseRepo({ CARAFE_REPO: "" })).toBe(expected);
  });
  test("install.sh and the menu bar releases link name the same repository", () => {
    const install = readFileSync(join(ROOT, "install.sh"), "utf8");
    expect((HAS_PRO ? /^REPO="\$\{CARAFE_REPO:-([^}]+)\}"$/m.exec(install)?.[1] : /^REPO="([^"]+)"$/m.exec(install)?.[1])).toBe(expected);
    const swift = readFileSync(join(ROOT, "apps/menubar/Sources/CarafeMenuBar/main.swift"), "utf8");
    expect(swift).toContain(`"https://github.com/${expected}/releases/latest"`);
  });
});

describe("compareVersions", () => {
  test("orders numerically per part, not lexically", () => {
    expect(compareVersions("0.0.1", "0.1.0")).toBeLessThan(0);
    expect(compareVersions("0.1.0", "1.0.0")).toBeLessThan(0);
    expect(compareVersions("0.0.10", "0.0.9")).toBeGreaterThan(0);
    expect(compareVersions("1.0.0", "0.9.9")).toBeGreaterThan(0);
  });
  test("equal versions, with and without v prefix", () => {
    expect(compareVersions("0.1.0", "0.1.0")).toBe(0);
    expect(compareVersions("v0.1.0", "0.1.0")).toBe(0);
  });
  test("missing parts count as zero", () => {
    expect(compareVersions("1.0", "1.0.0")).toBe(0);
    expect(compareVersions("1", "1.0.1")).toBeLessThan(0);
  });
  test("non-numeric parts never report newer", () => {
    expect(compareVersions("dev", "0.0.1")).toBe(0);
    expect(compareVersions("0.1.0", "dev")).toBe(0);
  });
});

describe("checksumFor", () => {
  const text = [
    "aa".repeat(32) + "  carafe-0.1.0-darwin-arm64.tar.gz",
    "bb".repeat(32) + "  carafe-0.1.0-linux-x64.tar.gz",
  ].join("\n");
  test("finds the digest for the exact asset name", () => {
    expect(checksumFor(text, "carafe-0.1.0-linux-x64.tar.gz")).toBe("bb".repeat(32));
  });
  test("no partial-name matches", () => {
    expect(checksumFor(text, "carafe-0.1.0-linux-x64.tar")).toBeNull();
  });
  test("rejects malformed digests", () => {
    expect(checksumFor("nothex  carafe-0.1.0-linux-x64.tar.gz", "carafe-0.1.0-linux-x64.tar.gz")).toBeNull();
  });
});

describe("warningFromCache", () => {
  test("warns only when the cached release is newer", () => {
    expect(warningFromCache({ checkedAt: 0, latest: "0.2.0" }, "0.1.0")).toContain("0.2.0");
    expect(warningFromCache({ checkedAt: 0, latest: "0.1.0" }, "0.1.0")).toBeNull();
    expect(warningFromCache({ checkedAt: 0, latest: "0.0.9" }, "0.1.0")).toBeNull();
  });
  test("silent when the check never succeeded", () => {
    expect(warningFromCache(null, "0.1.0")).toBeNull();
    expect(warningFromCache({ checkedAt: 0, latest: null }, "0.1.0")).toBeNull();
  });
  test("names both versions and the update command", () => {
    const w = warningFromCache({ checkedAt: 0, latest: "0.2.0" }, "0.1.0")!;
    expect(w).toContain("installed 0.1.0");
    expect(w).toContain("carafe update");
  });
});

describe("updateAvailable", () => {
  test("numeric cores decide when they differ", () => {
    expect(updateAvailable("0.1.0", "0.2.0")).toBe(true);
    expect(updateAvailable("0.2.0", "0.1.0")).toBe(false);
  });
  test("equal-base alphas are unordered and stable beats alpha", () => {
    expect(updateAvailable("0.0.1-alpha.f6564f2", "0.0.1-alpha.aa53324")).toBe(false);
    expect(updateAvailable("0.0.1-alpha.f6564f2", "0.0.1-alpha.f6564f2")).toBe(false);
    expect(updateAvailable("0.0.1-alpha.f6564f2", "0.0.1")).toBe(true); // alpha → stable
    expect(updateAvailable("0.0.1", "0.0.1-alpha.f6564f2")).toBe(false);
  });
  test("numeric order still beats a tie-break across cores", () => {
    expect(updateAvailable("0.0.1-alpha.f6564f2", "0.0.2")).toBe(true);
    expect(updateAvailable("0.1.0", "0.0.9-alpha.f6564f2")).toBe(false);
  });
  test("dev builds never update", () => {
    expect(updateAvailable("dev", "0.2.0")).toBe(false);
  });
});

describe("warningFromCache (alpha channel)", () => {
  test("does not warn across unordered sha-suffixed alphas", () => {
    expect(warningFromCache({ checkedAt: 0, latest: "0.0.1-alpha.aa53324" }, "0.0.1-alpha.f6564f2"))
      .toBeNull();
    expect(warningFromCache({ checkedAt: 0, latest: "0.0.1-alpha.f6564f2" }, "0.0.1-alpha.f6564f2")).toBeNull();
  });
});

describe("downgrade prevention and release preference", () => {
  test("the observed older alpha is neither offered nor installed over 0.1.5", () => {
    expect(compareVersions("0.1.3-alpha.50ed83a", "0.1.5")).toBeLessThan(0);
    expect(updateAvailable("0.1.5", "0.1.3-alpha.50ed83a")).toBe(false);
    expect(warningFromCache({ checkedAt: 0, latest: "0.1.3-alpha.50ed83a" }, "0.1.5")).toBeNull();
  });

  test("an alpha is newer than stable only when its base is greater", () => {
    expect(updateAvailable("0.1.5", "0.1.6-alpha.abc1234")).toBe(true);
    expect(updateAvailable("0.1.5", "0.1.5-alpha.abc1234")).toBe(false);
  });

  test("stable wins behind a run of alphas and at the same base", () => {
    const asset = { name: "x", url: "u", browser_download_url: "b" };
    const releases = Array.from({ length: 20 }, (_, i) => ({ version: `0.1.${6 + i}-alpha.${i}`, assets: [asset] }));
    releases.push({ version: "0.1.25", assets: [asset] });
    expect(preferredRelease(releases)?.version).toBe("0.1.25");
  });
});

describe("cacheIsStale", () => {
  const day = 24 * 60 * 60 * 1000;
  test("missing cache is stale; fresh cache is not; TTL boundary", () => {
    expect(cacheIsStale(null, Date.now())).toBe(true);
    const now = Date.now();
    expect(cacheIsStale({ checkedAt: now - 1000, latest: null }, now)).toBe(false);
    expect(cacheIsStale({ checkedAt: now - day - 1, latest: null }, now)).toBe(true);
  });
});


test("public release ordering and unknown suffix rejection", () => {
  expect(channelOf("0.1.0")).toBe("stable");
  expect(channelOf("0.1.1-alpha.abcdef0")).toBe("stable");
  expect(channelOf("0.2.0-unknown.1")).toBeNull();
  expect(updateAvailable("0.1.0", "0.1.1")).toBe(true);
  expect(updateAvailable("0.1.1", "0.1.0")).toBe(false);
  expect(versionLine("0.1.0", "darwin-arm64")).toBe("carafe 0.1.0 (darwin-arm64)");
});
