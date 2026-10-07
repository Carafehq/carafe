import { describe, expect, test } from "bun:test";
import type { CarafeEvent } from "../format/events";
import { extractPieces } from "./pieces";

function codexMessage(seq: number, role: string, text: string): CarafeEvent {
  return {
    ts: null, tool: "codex", sessionId: "roles", seq, kind: "assistant",
    raw: { timestamp: "2026-03-02T09:00:00.000Z", type: "response_item", payload: { type: "message", role, content: [{ type: role === "assistant" ? "output_text" : "input_text", text }] } },
  };
}

describe("codex response_item message roles", () => {
  test("only the assistant role renders as the assistant", () => {
    const lines = (ev: CarafeEvent) => extractPieces([ev], {}, {})[0]!.lines;
    expect(lines(codexMessage(1, "assistant", "I'll look through the workspace first."))).toEqual(["**assistant:** I'll look through the workspace first."]);
    expect(lines(codexMessage(2, "developer", "<permissions instructions>\nFilesystem sandboxing…"))).toEqual(["**system:** <permissions instructions>\nFilesystem sandboxing…"]);
    expect(lines(codexMessage(3, "user", "<environment_context>\n<cwd>/Users/x</cwd>\n</environment_context>"))).toEqual(["**system:** <environment_context>\n<cwd>/Users/x</cwd>\n</environment_context>"]);
    // The prompt echo: event_msg user_message already carries the turn.
    expect(lines(codexMessage(4, "user", "find the acme repo"))).toEqual([]);
  });
});
