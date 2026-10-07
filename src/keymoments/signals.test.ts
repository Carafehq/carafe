import { describe, expect, test } from "bun:test";
import type { CarafeEvent } from "../format/events";
import type { EventPieces } from "../handoff/pieces";
import { commandFamily, commandOf, isReadish, normalizeSentence, tokenJaccard, toolRuns } from "./signals";

function run(tool: string, result: string, command = "bun test") {
  const events: CarafeEvent[] = [
    { seq: 0, kind: "user", raw: {}, sessionId: "signals", tool, ts: null },
    { seq: 1, kind: "tool_use", raw: {}, sessionId: "signals", tool, ts: null },
    { seq: 2, kind: "tool_result", raw: {}, sessionId: "signals", tool, ts: null },
  ];
  const lines = ["**user:** test", `→ **exec_command** ${JSON.stringify({ cmd: command })}`, `  ⤷ ${result}`];
  const pieces: EventPieces[] = lines.map((line, seq) => ({ seq, kind: events[seq]!.kind, lines: [line], chars: line.length, ts: null }));
  return toolRuns(events, pieces)[0]!;
}

describe("key-moment signals", () => {
  test("normalizes command families across runner flags", () => {
    expect(commandFamily("bun test src/a.test.ts")).toBe("bun test");
    expect(commandFamily("npx --yes tsc --noEmit")).toBe("npx tsc");
    expect(commandFamily("git commit -m done")).toBe("git commit");
    expect(commandFamily("pytest -q")).toBe("pytest");
    expect(commandFamily('cd "/a b" && bun test')).toBe("bun test");
    expect(commandFamily("export X=1 && npx tsc --noEmit")).toBe("npx tsc");
    expect(commandFamily("source .env; pytest -q")).toBe("pytest");
    expect(commandFamily("git status --short")).toBe("git status");
  });

  test("extracts string and argv commands", () => {
    expect(commandOf('→ **exec_command** {"cmd":"bun test"}')).toBe("bun test");
    expect(commandOf('→ **shell** {"command":["git","status","--short"]}')).toBe("git status --short");
  });

  test("recognizes read-only tools and shell commands", () => {
    expect(isReadish(null, "Read")).toBe(true);
    expect(isReadish("rg -n error src", "exec_command")).toBe(true);
    expect(isReadish("bun test", "exec_command")).toBe(false);
  });

  test("uses implicit Claude Code success and explicit Codex success", () => {
    expect(run("claude-code", "Tests passed")).toMatchObject({ failed: false, succeeded: true });
    expect(run("claude-code", "Exit code 1\nTests failed")).toMatchObject({ failed: true, succeeded: false });
    expect(run("claude-code", "FAIL src/a.test.ts — expected true")).toMatchObject({ failed: true, succeeded: false });
    expect(run("codex", "Process exited with code 0")).toMatchObject({ failed: false, succeeded: true });
    expect(run("codex", "Tests passed")).toMatchObject({ failed: false, succeeded: false });
  });

  test("treats harness errors as neither failures nor successes", () => {
    for (const result of [
      "<tool_use_error>error TS2322: harness rejected the call</tool_use_error>",
      "Permission for this action was denied",
      "The user doesn't want to proceed",
    ]) expect(run("claude-code", result)).toMatchObject({ failed: false, succeeded: false });
  });

  test("normalizes sentences for deterministic near-duplicate grouping", () => {
    const a = normalizeSentence("Please never edit the generated client by hand.");
    const b = normalizeSentence("Never edit generated client by hand!");
    expect(tokenJaccard(a, b)).toBeGreaterThanOrEqual(0.6);
  });
});
