import { describe, expect, test } from "bun:test";
import type { CarafeEvent } from "../format/events";
import type { SessionDistillate } from "../format/distillate";
import { renderHandoff, withoutHarnessContext } from "./render";

const sessionId = "handoff-render-test";

function distillate(events: CarafeEvent[]): SessionDistillate {
  return {
    tool: "codex",
    sessionId,
    sourcePath: "/tmp/session.jsonl",
    title: "test session",
    cwd: "/tmp/project",
    gitBranch: "feat/test",
    startTs: "2026-01-01T10:00:00Z",
    endTs: "2026-01-01T11:00:00Z",
    eventCount: events.length,
    toolUseCount: events.filter((event) => event.kind === "tool_use").length,
    sidechain: false,
    rawBytes: 10,
    version: 1,
  };
}

function event(seq: number, kind: string, payload: Record<string, unknown>): CarafeEvent {
  return {
    ts: `2026-01-01T10:${String(seq % 60).padStart(2, "0")}:00Z`,
    tool: "codex",
    sessionId,
    seq,
    kind,
    raw: { payload },
  };
}

function bigSession({ withMoments = true } = {}): CarafeEvent[] {
  const events: CarafeEvent[] = withMoments
    ? [
        event(1, "user", { message: "Build a durable handoff renderer" }),
        event(2, "tool_use", { name: "AskUserQuestion", arguments: { question: "Use append-only event storage?" } }),
        event(3, "tool_result", { output: "Yes — use append-only event storage" }),
      ]
    : [];

  const startSeq = events.length + 1;
  for (let i = 0; i < 230; i++) {
    events.push(event(startSeq + i, "assistant", { message: `filler-${i} ${"x".repeat(1_000)}` }));
  }
  return events;
}

describe("renderHandoff", () => {
  test("layered output promotes an early decision from before the verbatim tail", () => {
    const events = bigSession();
    const result = renderHandoff(distillate(events), events);
    const keyMomentsAt = result.text.indexOf("## Key moments (deterministic, seq-anchored — selected from the WHOLE session, not just the tail)");
    const decisionAt = result.text.indexOf("Use append-only event storage?");
    // v5: the standalone chapter directory is gone; Key moments is followed by
    // the orientation layer's closing section
    // round 8 — the retrieval block is one section, "Dig deeper" (no empty heading over a second one)
    const directoryAt = result.text.indexOf("## Dig deeper");
    const tailStart = Number(/## The tail, verbatim \(seq (\d+) → /.exec(result.text)?.[1]);

    expect(result.tier).toBe("layered");
    // v5 round 4: the tail always opens on a user line, reaching back for it
    // when the budget cut mid-turn — so its first seq is the turn's, not the
    // budget's
    expect(tailStart).toBeGreaterThanOrEqual(1);
    const tailText = result.text.slice(result.text.indexOf("## The tail, verbatim"));
    expect(tailText.split("\n").find((line) => line.startsWith("**"))).toStartWith("**user:**");
    expect(keyMomentsAt).toBeGreaterThanOrEqual(0);
    expect(decisionAt).toBeGreaterThan(keyMomentsAt);
    expect(decisionAt).toBeLessThan(directoryAt);
    expect(result.text.slice(result.text.indexOf("## The tail"))).not.toContain("Use append-only event storage?");
    expect(result.text).toContain("- goal (first prompt): Build a durable handoff renderer  [seq 1]");
    expect(result.text).toMatch(/- \[seq 1–\d+\] Build a durable handoff renderer(?: · \d+ tools)? · \d+K/);
    expect(result.text).toContain(`carafe search --session ${sessionId} '<terms>'`);
    expect(result.text).toContain("find turns about something when you don't know the exact wording");
    expect(result.text).toContain("find the exact line (regex; returns seq numbers)");
    expect(result.text).toContain("capped at 60K chars");
    expect(result.text).toContain(`carafe chapters ${sessionId} [--chapter K]`);
    expect(result.text).toContain(`carafe ask ${sessionId} [--file F] [--kind K]`);
    expect(result.text).toContain("structured lookup: which chapters/dead ends/decisions touched a file, what failed");
    expect(result.text).toContain("- chapters: 1");
  });

  test("layered output stays within the former fixed-content plus 100K-tail envelope", () => {
    const events = bigSession();
    const result = renderHandoff(distillate(events), events);

    // This fixture has one short directory line. The old renderer was its
    // header/notes/map/keys plus a 100K tail; 5K is generous fixed-content slack.
    expect(result.text.length).toBeLessThanOrEqual(105_000);
  });

  test("full-tier output keeps its trace with a tool-neutral, portable header", () => {
    const events = [
      event(1, "user", { message: "small request" }),
      event(2, "assistant", { message: "acknowledged" }),
    ];
    const result = renderHandoff(distillate(events), events, { now: "2026-01-01T12:00:00Z", target: "codex" });

    expect(result.tier).toBe("full");
    expect(result.text).toBe([
      "# Handoff: test session",
      // v6/V8 — the second line of the file, when nobody answered the questions
      `> **No outgoing-agent answers.** This file is extraction only: nobody who did the work said what is live, what is half-done or what not to do. Ask the outgoing agent: carafe handoff ${sessionId} --questions`,
      "",
      // round 8 — a three-line header: the session, the repositories, how it was made
      `- session: ${sessionId} (codex) · 2 events · 0 tool calls · 2026-01-01T10:00:00Z → 2026-01-01T11:00:00Z`,
      // v6/V9 — no live readings, so no branch is claimed for the header
      "- repos: none recorded — the codebase is NOT in this file; it's at the destination",
      `- generated 2026-01-01T12:00:00Z from events up to seq 2; optional regeneration if carafe is installed: carafe handoff ${sessionId}`,
      "All carafe commands and seq pointers below are optional lookups if carafe is installed and the source store is available. Continue from the inline context and trace; no receiving-tool integration is required.",
      "",
      "_Faithful full trace. Read it and continue the work._",
      "",
      "---",
      "**user:** small request",
      "",
      "**assistant:** acknowledged",
      "",
    ].join("\n"));
    expect(result.text).not.toContain("## Key moments");
  });

  test("layered output keeps the complete chapter skeleton when extraction is empty", () => {
    const events = bigSession({ withMoments: false });
    const result = renderHandoff(distillate(events), events);

    expect(result.tier).toBe("layered");
    expect(result.text).toContain("## Key moments");
    expect(result.text).toContain("### Ch 1");
  });

  test("an elided directory keeps every chapter and teaches chapter drill-down", () => {
    const events = Array.from({ length: 501 }, (_, i) => event(i + 1, "user", { message: `turn ${i + 1} ${"x".repeat(450)}` }));
    const result = renderHandoff(distillate(events), events);
    expect(result.tier).toBe("layered");
    const chapterCount = Number(/- chapters: (\d+)/.exec(result.text)?.[1]);
    // v5: every chapter still appears exactly once — in Key moments, whole or
    // collapsed to its retrievable one-liner; the duplicate directory is gone
    expect((result.text.match(/^### Ch \d+/gm) ?? []).length).toBe(chapterCount);
    expect(result.text).not.toContain("## Directory of the session");
    expect(result.text).toContain(`carafe chapters ${sessionId} --chapter`);
  });
});

describe("harness context in handoffs", () => {
  test("a long system-injected block becomes a one-line stub with its seq; short system lines stay", () => {
    const long = `**system:** <app-context>\n# Codex desktop context\n${"- rule ".repeat(200)}`;
    const short = "**system:** [Request interrupted by user]";
    const out = withoutHarnessContext([long, "**user:** fix the build", short], 12, "abc");
    expect(out[0]).toMatch(/^\*\*system:\*\* \[harness context omitted — [\d,]+ chars starting "<app-context>…"; carafe show abc --seq 12\]$/);
    expect(out[1]).toBe("**user:** fix the build");
    expect(out[2]).toBe(short);
  });

  test("renderHandoff never carries an injected developer message verbatim", () => {
    const developer = "<app-context>\n" + "You are running inside the Codex app. ".repeat(20);
    const events: CarafeEvent[] = [
      event(0, "assistant", { type: "message", role: "developer", content: [{ type: "input_text", text: developer }] }),
      event(1, "user", { message: "continue the export work" }),
      event(2, "assistant", { type: "agent_message", message: "On it." }),
    ];
    const { text } = renderHandoff(distillate(events), events);
    expect(text).not.toContain("You are running inside the Codex app.");
    expect(text).toContain("harness context omitted");
    expect(text).toContain("continue the export work");
  });
});
