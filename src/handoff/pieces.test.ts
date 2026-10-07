import { describe, expect, test } from "bun:test";
import type { CarafeEvent } from "../format/events";
import { extractPieces, filesOf } from "./pieces";

function event(tool: string, kind: string, raw: unknown): CarafeEvent {
  return { ts: null, tool, sessionId: "pieces-test", seq: 1, kind, raw };
}

describe("handoff pieces", () => {
  test("renders a Claude Code compaction summary as system content", () => {
    const ev = event("claude-code", "user", {
      type: "user",
      message: { content: "This session is being continued from a previous conversation that ran out of context.\nSummary..." },
    });
    expect(extractPieces([ev], {}, {})[0]?.lines).toEqual([
      "**system:** This session is being continued from a previous conversation that ran out of context.\nSummary...",
    ]);
  });

  test("renders a Claude Code PR-link meta event as one artifact line", () => {
    const ev = event("claude-code", "meta", {
      type: "pr-link",
      prNumber: 23,
      prUrl: "https://github.com/acme/billing/pull/23",
    });
    expect(extractPieces([ev], {}, {})[0]?.lines).toEqual([
      "pr-link #23 https://github.com/acme/billing/pull/23",
    ]);
  });

  test("extracts every file header from a Codex apply_patch call", () => {
    const patch = [
      "*** Begin Patch",
      "*** Update File: src/queue/worker.ts",
      "*** Add File: src/queue/retry.ts",
      "*** Delete File: src/queue/old.ts",
      "*** Move to: src/queue/archive.ts",
      "*** End Patch",
    ].join("\n");
    const ev = event("codex", "tool_use", {
      payload: { name: "apply_patch", arguments: JSON.stringify({ input: patch }) },
    });
    expect(filesOf(ev)).toEqual([
      "src/queue/worker.ts",
      "src/queue/retry.ts",
      "src/queue/old.ts",
      "src/queue/archive.ts",
    ]);
  });

  test("extracts a file argument from a conservative sed command", () => {
    const ev = event("codex", "tool_use", {
      payload: { name: "exec_command", arguments: JSON.stringify({ cmd: "sed -n '1,120p' src/queue/worker.ts" }) },
    });
    expect(filesOf(ev)).toEqual(["src/queue/worker.ts"]);
  });

  test("does not treat a URL in a shell command as a file", () => {
    const ev = event("codex", "tool_use", {
      payload: { name: "exec_command", arguments: JSON.stringify({ cmd: "cat https://example.com/src/worker.ts" }) },
    });
    expect(filesOf(ev)).toEqual([]);
  });
});
