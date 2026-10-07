import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { dirname, join, relative, resolve } from "path";
import { loadPro, notInBuild, PRO_COMMANDS, proRouteFeature } from "./tier";
import { cliUsage, CLI_USAGE } from "./cli/usage";
import { HTML, pageHtml } from "./ui/html";
import { proRouteMissing } from "./ui/server";

// The open-core seam. These tests run in BOTH trees: the full private tree
// (src/closed present) and the open-source export (src/closed absent). The
// open build's behaviour is exercised in the full tree with CARAFE_OPEN_BUILD=1.

const ROOT = resolve(import.meta.dir, "..");
const CLOSED = join(ROOT, "src", "closed");
const HAS_CLOSED = existsSync(join(CLOSED, "index.ts"));
const cli = join(ROOT, "src/cli/index.ts");
let workspace = "";

beforeEach(() => { workspace = mkdtempSync(join(tmpdir(), "carafe-tier-")); });
afterEach(() => { rmSync(workspace, { recursive: true, force: true }); });

function env(store: string, open: boolean): Record<string, string> {
  const cc = join(workspace, "sources", "claude");
  const codex = join(workspace, "sources", "codex");
  mkdirSync(cc, { recursive: true });
  mkdirSync(codex, { recursive: true });
  const e: Record<string, string> = {
    ...(process.env as Record<string, string>),
    PATH: `/opt/homebrew/bin:${process.env.HOME}/.bun/bin:${process.env.PATH ?? ""}`,
    CARAFE_HOME: store, CARAFE_CC_ROOT: cc, CARAFE_CODEX_ROOT: codex, CARAFE_NO_UPDATE_CHECK: "1",
  };
  if (open) e.CARAFE_OPEN_BUILD = "1";
  else delete e.CARAFE_OPEN_BUILD;
  return e;
}

function run(args: string[], open: boolean) {
  const store = join(workspace, "store");
  const r = Bun.spawnSync([process.execPath, "run", cli, ...args], { cwd: ROOT, env: env(store, open), stdout: "pipe", stderr: "pipe" });
  return { code: r.exitCode, stdout: r.stdout.toString(), stderr: r.stderr.toString(), storeCreated: existsSync(store) };
}

const SOURCE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs)$/;
const SKIP_DIRS = new Set(["node_modules", ".git", "dist"]);
// import/export … from "x", import("x"), require("x"), bare import "x"
const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)(["'`])([^"'`\n]+)\1/gm;

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) { if (path !== CLOSED) sourceFiles(path, out); }
    else if (SOURCE_EXT.test(entry.name)) out.push(path);
  }
  return out;
}

describe("the open/closed boundary", () => {
  test("no file outside src/closed imports from it, except the loader", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(ROOT)) {
      const rel = relative(ROOT, file);
      if (rel === join("src", "tier.ts")) continue;
      const text = readFileSync(file, "utf8");
      for (const m of text.matchAll(SPECIFIER)) {
        const spec = m[2]!;
        if (!spec.startsWith(".")) continue;
        const target = resolve(dirname(file), spec);
        if (target === CLOSED || target.startsWith(CLOSED + "/")) offenders.push(`${rel}: ${spec}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("the loader names the closed tree exactly once", () => {
    const text = readFileSync(join(ROOT, "src", "tier.ts"), "utf8");
    expect([...text.matchAll(SPECIFIER)].map((m) => m[2])).toEqual(["./format/store", "./handoff/pieces", "./closed/index"]);
  });
});

describe("the tier loader", () => {
  test("finds the Pro tier exactly when src/closed is present", async () => {
    const pro = await loadPro();
    if (!HAS_CLOSED || process.env.CARAFE_OPEN_BUILD === "1") { expect(pro).toBeNull(); return; }
    expect(pro).not.toBeNull();
    expect(pro!.features.sort()).toEqual(["distill", "share"]);
    expect(Object.keys(pro!.commands).sort()).toEqual(Object.keys(PRO_COMMANDS).sort());
  });

  test("every Pro endpoint maps to its feature; open endpoints do not", () => {
    expect(proRouteFeature("/api/receive/preview")).toBe("share");
    expect(proRouteFeature("/api/receive/import")).toBe("share");
    expect(proRouteFeature("/api/session/abc/share/preview")).toBe("share");
    expect(proRouteFeature("/api/session/abc/share/write")).toBe("share");
    expect(proRouteFeature("/api/session/abc/ledger")).toBe("distill");
    expect(proRouteFeature("/api/session/abc/distill")).toBe("distill");
    for (const open of ["/", "/api/sessions", "/api/session/abc", "/api/session/abc/key-moments", "/api/session/abc/undo", "/api/handoff"]) {
      expect(proRouteFeature(open)).toBeNull();
    }
    expect(proRouteMissing("share")).toEqual({ error: notInBuild("Person-to-person share and receive"), tier: "pro", feature: "share" });
    expect(proRouteMissing("distill").error).toBe("Decision-ledger distillation is part of Carafe Pro and is not in this build");
  });
});

describe("the open build (Pro absent)", () => {
  test("cliUsage places a block after the named command", () => {
    const text = cliUsage([{ after: "gc", text: "  carafe x   y" }]);
    const lines = text.split("\n");
    expect(lines[lines.findIndex((l) => l.startsWith("  carafe gc ")) + 1]).toBe("  carafe x   y");
    expect(cliUsage([])).toBe(CLI_USAGE);
  });

  test("each Pro command prints one honest line and exits non-zero without touching the store", () => {
    for (const name of Object.keys(PRO_COMMANDS)) {
      const r = run([name, "latest"], true);
      expect(r.code, name).toBe(1);
      expect(r.stderr.trim(), name).toBe(`\`carafe ${name}\` is part of Carafe Pro and is not in this build`);
      expect(r.stdout, name).toBe("");
      expect(r.storeCreated, name).toBe(false);
    }
  }, 30_000);

  test("help lists no Pro command", () => {
    const r = run(["--help"], true);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(`${CLI_USAGE}\n`);
    for (const name of Object.keys(PRO_COMMANDS)) expect(r.stdout).not.toContain(`carafe ${name} `);
  }, 20_000);

  test("the UI names the missing features and leaves their buttons out", () => {
    const page = pageHtml([]);
    expect(page).toContain(`<body data-off="share distill">`);
    expect(page.replace(` data-off="share distill"`, "")).toBe(HTML);
    expect(pageHtml(["share"])).toContain(`<body data-off="distill">`);
    // The script builds the buttons only when the feature is on.
    expect(HTML).toContain(`OFF.has("share")?'<span style="margin-left:auto"></span>'`);
    expect(HTML).toContain(`if(!OFF.has("distill"))h+='<div class="ledger" id="ledger">`);
    expect(HTML).toContain(`if(OFF.has("share"))document.getElementById("receiveTop").remove()`);
  });
});

describe.if(HAS_CLOSED)("the full build (Pro present)", () => {
  test("help lists the Pro commands where they always were", () => {
    const r = run(["--help"], false);
    expect(r.code).toBe(0);
    const at = (s: string) => r.stdout.indexOf(`\n  carafe ${s} `);
    const order = ["undo", "gc", "share", "receive", "pr-post", "egress-check", "distill", "key-moments"].map(at);
    expect(order.every((i) => i > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  }, 20_000);

  test("the page is served unchanged", () => {
    expect(pageHtml(["share", "distill"])).toBe(HTML);
  });

  test("a Pro command runs: missing argument prints its own usage", () => {
    const r = run(["share"], false);
    expect(r.code).toBe(1);
    expect(r.stderr.trim()).toBe("usage: carafe share <id|latest> [--to <email>] [--out <path>] [--yes]");
  }, 20_000);
});
