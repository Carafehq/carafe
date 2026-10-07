import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { SessionDistillate } from "../format/distillate";
import { writeDistillate } from "../format/distillate";
import type { CarafeEvent } from "../format/events";
import { readSession, sealSession } from "../format/sessions";
import { CarafeStore } from "../format/store";
import { buildSessionIndex } from "../search/session-index";
import { runGrep, runShow } from "./inspect";

let root = "";
let oldHome: string | undefined;

function capture(fn: () => void): { output: string; errors: string } {
  const output: string[] = [];
  const errors: string[] = [];
  const log = console.log;
  const error = console.error;
  console.log = (...args: unknown[]) => output.push(args.join(" "));
  console.error = (...args: unknown[]) => errors.push(args.join(" "));
  try { fn(); } finally { console.log = log; console.error = error; }
  return { output: output.join("\n"), errors: errors.join("\n") };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "carafe-show-"));
  oldHome = process.env.CARAFE_HOME;
  process.env.CARAFE_HOME = root;
  const store = new CarafeStore(root);
  const events: CarafeEvent[] = Array.from({ length: 200 }, (_, seq) => ({
    ts: `2026-01-01T00:${String(seq % 60).padStart(2, "0")}:00Z`,
    tool: "codex",
    sessionId: "show-cap",
    seq,
    kind: "assistant",
    raw: { payload: { message: `payload-${seq} ${"x".repeat(1_000)}` } },
  }));
  const d: SessionDistillate = {
    tool: "codex", sessionId: "show-cap", sourcePath: "fixture.jsonl", title: "show cap fixture",
    cwd: "/tmp/project", gitBranch: "main", startTs: events[0]!.ts, endTs: events.at(-1)!.ts,
    eventCount: events.length, toolUseCount: 0, sidechain: false, rawBytes: 1, version: 1,
  };
  sealSession(store, d.tool, d.sessionId, events);
  writeDistillate(store, d);
});

afterEach(() => {
  if (oldHome === undefined) delete process.env.CARAFE_HOME;
  else process.env.CARAFE_HOME = oldHome;
  if (root) rmSync(root, { recursive: true, force: true });
});

describe("carafe show output cap", () => {
  test("the default cap stops before a large range and reports on stdout and stderr", () => {
    const shown = capture(() => runShow("show-cap"));
    expect(shown.output).toStartWith("# show cap fixture — seq 0→end");
    expect(shown.output).toContain("…output capped at 60000 chars:");
    expect(shown.errors).toContain("…output capped at 60000 chars:");
    expect(shown.output.match(/payload-\d+/g)?.length ?? 0).toBeLessThan(200);
  });

  test("--max-chars 0 prints every event", () => {
    const cli = join(import.meta.dir, "..", "cli", "index.ts");
    const result = Bun.spawnSync([process.execPath, "run", cli, "show", "show-cap", "--max-chars", "0"], {
      env: { ...process.env, CARAFE_HOME: root, CARAFE_NO_UPDATE_CHECK: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = new TextDecoder().decode(result.stdout);
    expect(result.exitCode).toBe(0);
    expect(output.match(/payload-\d+/g)).toHaveLength(200);
    expect(output).not.toContain("output capped");
    expect(new TextDecoder().decode(result.stderr)).toBe("");
  });

  test("a narrow seq range prints in full without a cap notice", () => {
    const shown = capture(() => runShow("show-cap", { seq: "10-12" }));
    expect(shown.output.match(/payload-\d+/g)).toEqual(["payload-10", "payload-11", "payload-12"]);
    expect(shown.output).not.toContain("output capped");
    expect(shown.errors).toBe("");
  });
});

describe("carafe grep session index", () => {
  test("reads fresh docs in block order without decoding the session", () => {
    const store = new CarafeStore(root);
    const d = JSON.parse(readFileSync(store.distillatePath("codex", "show-cap"), "utf8")) as SessionDistillate;
    const events = Array.from({ length: 200 }, (_, seq) => ({
      ts: `2026-01-01T00:${String(seq % 60).padStart(2, "0")}:00Z`, tool: "codex", sessionId: "show-cap", seq,
      kind: "assistant", raw: { payload: { message: `payload-${seq} ${"x".repeat(1_000)}` } },
    })) satisfies CarafeEvent[];
    buildSessionIndex(store, d, events);
    unlinkSync(store.sessionPath(d.tool, d.sessionId));

    const result = capture(() => runGrep("show-cap", "payload-[12]", { limit: 1 }));
    expect(result.output).toContain("seq 0-199 [block]");
    expect(result.output).toContain("2 match(es) (showing 1");
    expect(result.output).toEndWith("some blocks were truncated in the index; rerun with --deep for the full trace");
    expect(result.errors).toBe("");
  });

  test("falls back once when the index is absent", () => {
    const result = capture(() => runGrep("show-cap", "payload-199"));
    expect(result.output).toContain("seq 199 [assistant]");
    expect(result.errors.match(/note: no fresh index/g)).toHaveLength(1);
  });

  test("--deep forces the complete trace even when a fresh index is truncated", () => {
    const store = new CarafeStore(root);
    const d = JSON.parse(readFileSync(store.distillatePath("codex", "show-cap"), "utf8")) as SessionDistillate;
    const events = readSession(store, d.tool, d.sessionId);
    buildSessionIndex(store, d, events);

    const result = capture(() => runGrep("show-cap", "payload-199", { deep: true }));
    expect(result.output).toContain("seq 199 [assistant]");
    expect(result.output).not.toContain("[block]");
    expect(result.errors).toBe("");
  });
});
