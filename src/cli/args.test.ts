import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { SessionDistillate } from "../format/distillate";
import type { CarafeEvent } from "../format/events";
import { sealSession } from "../format/sessions";
import { CarafeStore } from "../format/store";
import { positionalArgs } from "./args";

const cli = join(process.cwd(), "src/cli/index.ts");
let workspace = "";

beforeEach(() => { workspace = mkdtempSync(join(tmpdir(), "carafe-cli-args-")); });
afterEach(() => { rmSync(workspace, { recursive: true, force: true }); });

function env(store: string): Record<string, string> {
  const cc = join(workspace, "sources", "claude");
  const codex = join(workspace, "sources", "codex");
  mkdirSync(cc, { recursive: true });
  mkdirSync(codex, { recursive: true });
  return { ...process.env, PATH: `/opt/homebrew/bin:${process.env.HOME}/.bun/bin:${process.env.PATH ?? ""}`, CARAFE_HOME: store, CARAFE_CC_ROOT: cc, CARAFE_CODEX_ROOT: codex } as Record<string, string>;
}

test("boolean flags before ids do not consume the id, while value flags do", () => {
  expect(positionalArgs(["--questions", "abc"])).toEqual(["abc"]);
  expect(positionalArgs(["--thinking", "abc", "--to", "codex"])).toEqual(["abc"]);
  expect(positionalArgs(["--list", "abc"])).toEqual(["abc"]);
  expect(positionalArgs(["--apply", "abc", "--to-seq", "4"])).toEqual(["abc"]);
  expect(positionalArgs(["--force", "archive.carafe"])).toEqual(["archive.carafe"]);
});

test("handoff accepts --questions before the id", () => {
  const root = join(workspace, "store");
  const store = new CarafeStore(root);
  const id = "11111111-1111-4111-8111-111111111111";
  const event: CarafeEvent = {
    ts: "2026-09-20T10:00:00Z", tool: "codex", sessionId: id, seq: 0, kind: "user",
    raw: { timestamp: "2026-09-20T10:00:00Z", type: "event_msg", payload: { type: "user_message", message: "Ship the parser fix." } },
  };
  sealSession(store, "codex", id, [event]);
  mkdirSync(join(root, "distillate", "codex"), { recursive: true });
  const d: SessionDistillate = {
    tool: "codex", sessionId: id, sourcePath: id, title: "Parser fix", titleSource: "derived",
    cwd: null, gitBranch: null, startTs: event.ts, endTs: event.ts, lastActivityTs: event.ts,
    internal: false, hasUserText: true, eventCount: 1, toolUseCount: 0, sidechain: false, rawBytes: 0, version: 1,
  };
  writeFileSync(store.distillatePath("codex", id), JSON.stringify(d));
  const result = Bun.spawnSync([process.execPath, "run", cli, "handoff", "--questions", id], { cwd: process.cwd(), env: env(root), stdout: "pipe", stderr: "pipe" });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  expect(result.stdout.toString()).toContain("Answer these seven questions");
  expect(result.stdout.toString()).not.toContain("usage: carafe handoff");
  let baseline: string | undefined;
  for (const label of [undefined, "cursor", "devin", "Any custom tool"]) {
    const args = ["run", cli, "handoff", id, "--no-arm", "--no-live", ...(label ? ["--to", label] : [])];
    const handoff = Bun.spawnSync([process.execPath, ...args], { env: env(root), stdout: "pipe", stderr: "pipe" });
    expect(handoff.exitCode, handoff.stderr.toString()).toBe(0);
    expect(handoff.stdout.toString()).toContain(`handoff ready → ${label ?? "any agent"}`);
    // Separate processes have distinct generation/check times; all other bytes match.
    const body = readFileSync(join(root, "handoffs", `${id}.md`), "utf8")
      .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g, "<generation-time>");
    baseline ??= body;
    expect(body).toBe(baseline);
  }

});

describe("help is inert", () => {
  test("state-changing commands print usage without creating a store", () => {
    const commands = [
      ["import", "--help"], ["watch", "-h"], ["service", "enable", "--help"],
      ["handoff", "--questions", "latest", "--help"], ["checkpoint", "latest", "--help"],
      ["sync", "enable", "--help"], ["skills", "install", "--help"], ["reflex", "arm", "--help"],
      ["undo", "latest", "--apply", "--help"], ["gc", "--yes", "--help"],
      ["share", "latest", "--yes", "--help"], ["receive", "x.carafe", "--force", "--help"],
      ["pr-post", "latest", "--post", "--help"], ["distill", "latest", "--force", "--help"],
      ["index", "latest", "--rebuild", "--help"], ["reindex", "--force", "--help"],
      ["start", "codex", "--help"], ["ui", "--no-open", "--help"], ["update", "--help"],
    ];
    for (const [index, args] of commands.entries()) {
      const root = join(workspace, `store-${index}`);
      const result = Bun.spawnSync([process.execPath, "run", cli, ...args], { cwd: process.cwd(), env: env(root), stdout: "pipe", stderr: "pipe" });
      expect(result.exitCode, `${args.join(" ")}\n${result.stderr}`).toBe(0);
      expect(result.stdout.toString()).toContain("usage:");
      expect(existsSync(root), args.join(" ")).toBe(false);
    }
  }, 20_000);
});
