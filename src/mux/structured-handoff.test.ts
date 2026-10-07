import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  discoverInRoot,
  parseClaude,
  parseCodex,
  render,
  type ParsedNativeSession,
} from "./structured-handoff";

let testWork = "";
let tempCounter = 0;
beforeEach(() => { testWork = mkdtempSync(join(tmpdir(), "carafe-mux-")); tempCounter = 0; });
afterEach(() => { rmSync(testWork, { recursive: true, force: true }); });
function tempDir(): string {
  const dir = join(testWork, String(tempCounter++));
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("structured handoff", () => {
  test("parses claude events and files", () => {
    const path = join(tempDir(), "session.jsonl");
    writeFileSync(
      path,
      `${JSON.stringify({ type: "user", cwd: "/repo", message: { content: "Fix it" } })}\n` +
        `${JSON.stringify({
          type: "assistant",
          cwd: "/repo",
          message: {
            content: [
              { type: "tool_use", name: "Read", input: { file_path: "/repo/src/a.rs" } },
              { type: "text", text: "Done" },
            ],
          },
        })}\n`,
    );
    const parsed = parseClaude(path);
    expect(parsed.cwd).toBe("/repo");
    expect(parsed.events).toHaveLength(2);
    expect(parsed.events[1]!.files).toEqual(["/repo/src/a.rs"]);
    expect(parsed.events[1]!.lines.some((line) => line.includes("**Read**"))).toBeTrue();
  });

  test("parses codex events", () => {
    const path = join(tempDir(), "rollout.jsonl");
    writeFileSync(
      path,
      `${JSON.stringify({ type: "session_meta", payload: { cwd: "/repo" } })}\n` +
        `${JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "Fix it" } })}\n` +
        `${JSON.stringify({
          type: "response_item",
          payload: {
            type: "function_call",
            name: "read_file",
            arguments: JSON.stringify({ path: "/repo/a.rs" }),
          },
        })}\n`,
    );
    const parsed = parseCodex(path);
    expect(parsed.events).toHaveLength(2);
    expect(parsed.events[1]!.files).toEqual(["/repo/a.rs"]);
  });

  test("discovery selects matching working directory", () => {
    const dir = tempDir();
    const right = join(dir, "right.jsonl");
    writeFileSync(
      join(dir, "wrong.jsonl"),
      JSON.stringify({ type: "user", cwd: "/other", message: { content: "Wrong" } }),
    );
    writeFileSync(
      right,
      JSON.stringify({ type: "user", cwd: "/repo", message: { content: "Right" } }),
    );

    const found = discoverInRoot("claude", dir, "/repo", 0, new Set());

    expect(found).not.toBeNull();
    expect(found!.path).toBe(right);
    expect(found!.events[0]!.lines[0]).toContain("Right");
  });

  test("discovery does not adopt a preexisting parallel session", () => {
    const dir = tempDir();
    const existing = join(dir, "existing.jsonl");
    writeFileSync(
      existing,
      JSON.stringify({ type: "user", cwd: "/repo", message: { content: "Other session" } }),
    );

    const found = discoverInRoot("claude", dir, "/repo", 0, new Set([existing]));

    expect(found).toBeNull();
  });

  test("full renderer redacts secrets", () => {
    const parsed: ParsedNativeSession = {
      path: "/trace.jsonl",
      cwd: "/repo",
      events: [
        {
          seq: 0,
          kind: "user",
          lines: ["**user:** token ghp_abcdefghijklmnopqrstuvwxyz"],
          files: [],
        },
      ],
      sourceBytes: 123,
    };
    const rendered = render("claude", "codex", "/repo", parsed);
    expect(rendered.tier).toBe("full");
    expect(rendered.text).toContain("⟦REDACTED:github-token⟧");
    expect(rendered.redactions["github-token"]).toBe(1);
  });

  test("large renderer is layered and retains source path", () => {
    const events = Array.from({ length: 120 }, (_, seq) => ({
      seq,
      kind: "user",
      lines: [`**user:** turn ${seq} ${"x".repeat(2_000)}`],
      files: ["/repo/src/a.rs"],
    }));
    const parsed: ParsedNativeSession = {
      path: "/complete.jsonl",
      cwd: "/repo",
      events,
      sourceBytes: 456,
    };
    const rendered = render("claude", "codex", "/repo", parsed);
    expect(rendered.tier).toBe("layered");
    expect(rendered.text).toContain("complete native trace: /complete.jsonl");
    expect(rendered.text).toContain("## Turn directory");
    expect(rendered.text).toContain("## Verbatim tail");
  });
});
