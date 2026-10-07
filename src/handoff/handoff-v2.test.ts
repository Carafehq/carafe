/**
 * The handoff-as-handoff waves: sibling sessions, recaps, standing
 * instructions, the real goal, honest truncation, a tail that never contains
 * its own generation, the repo header, and id prefixes.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { SessionDistillate } from "../format/distillate";
import { writeDistillate } from "../format/distillate";
import type { CarafeEvent } from "../format/events";
import { sealSession } from "../format/sessions";
import { CarafeStore } from "../format/store";
import { AmbiguousSessionIdError, findSession, isExcludedWorkspace, siblingSessions, workspaceKey } from "../query/sessions";
import { clip, extractPieces, isSelfGenerationLine, withoutSelfGeneration } from "./pieces";
import { isStandingInstruction } from "../keymoments/instructions";
import { momentCharCost, renderMomentLine, steeringPriority } from "../keymoments/select";
import { branchFromTrace, goalText, renderHandoff, reposWorkedIn, tokenEstimate } from "./render";

const sessionId = "handoff-v2-fixture";

function distillate(events: CarafeEvent[], over: Partial<SessionDistillate> = {}): SessionDistillate {
  return {
    tool: "codex", sessionId, sourcePath: "/tmp/session.jsonl", title: "handoff v2 fixture",
    cwd: "/tmp/project", gitBranch: "feat/test", startTs: "2026-01-01T10:00:00Z", endTs: "2026-01-01T11:00:00Z",
    eventCount: events.length, toolUseCount: events.filter((event) => event.kind === "tool_use").length,
    sidechain: false, rawBytes: 10, version: 1, ...over,
  };
}

function event(seq: number, kind: string, payload: Record<string, unknown>, id = sessionId): CarafeEvent {
  return { ts: `2026-01-01T10:${String(seq % 60).padStart(2, "0")}:00Z`, tool: "codex", sessionId: id, seq, kind, raw: { payload } };
}

/** enough filler to force the layered tier (the orientation layer) */
function filler(from: number, count = 230): CarafeEvent[] {
  return Array.from({ length: count }, (_, i) => event(from + i, "assistant", { message: `filler-${i} ${"x".repeat(1_000)}` }));
}

const render = (events: CarafeEvent[], over: Partial<SessionDistillate> = {}, opts = {}) =>
  renderHandoff(distillate(events, over), events, { now: "2026-02-01T00:00:00Z", target: "codex", ...opts });

describe("W2 recaps", () => {
  const events = [
    event(1, "user", { message: "Build the exporter" }),
    event(2, "user", { message: "where are we?" }),
    event(3, "assistant", { message: "Three of five tables export cleanly; the join on orders still drops rows." }),
    ...filler(4),
  ];

  test("a recap request's reply becomes a recap moment, rendered before the steers", () => {
    const { text } = render(events);
    expect(text).toContain(`- recap (asked "where are we?"): Three of five tables export cleanly`);
    expect(text).toContain("[seq 3]");
  });

  test("the recap replaces the steering moment for the same request", () => {
    const { text } = render(events);
    const momentsSection = text.slice(text.indexOf("## Key moments"), text.indexOf("## How to read the rest"));
    expect(momentsSection).not.toContain("- steering: where are we?");
  });

  // v5 round 3: the newest recap leads the file; only the older ones are
  // listed below, so a session with ONE recap has no list at all
  test("the newest recap is quoted in full at the top of the file", () => {
    const { text } = render(events);
    const newestAt = text.indexOf("## The newest recap (asked ");
    expect(newestAt).toBeGreaterThan(0);
    expect(newestAt).toBeLessThan(text.indexOf("## Notes (deterministic"));
    expect(text).toContain("the join on orders still drops rows.");
  });

  test("only the last three recaps are quoted in full", () => {
    const many: CarafeEvent[] = [event(1, "user", { message: "Build the exporter" })];
    for (let i = 0; i < 5; i++) {
      many.push(event(2 + i * 2, "user", { message: "status" }), event(3 + i * 2, "assistant", { message: `RECAP-BODY-${i} state of play` }));
    }
    many.push(...filler(20));
    const { text } = render(many);
    // the newest leads the file…
    const lead = text.slice(text.indexOf("## The newest recap"), text.indexOf("## Notes (deterministic"));
    expect(lead).toContain("RECAP-BODY-4");
    // …and the two before it follow, newest first, without it
    const quoted = text.slice(text.indexOf("## Recaps the assistant wrote"), text.indexOf("## How to read the rest"));
    expect(quoted).not.toContain("RECAP-BODY-0");
    expect(quoted).not.toContain("RECAP-BODY-4");
    expect(quoted).toContain("RECAP-BODY-2");
    expect(quoted.indexOf("RECAP-BODY-3")).toBeLessThan(quoted.indexOf("RECAP-BODY-2"));
  });
});

describe("W3 standing instructions", () => {
  const events = [
    event(1, "user", { message: "Build the exporter" }),
    event(2, "user", { message: "never push without asking me first" }),
    event(3, "assistant", { message: "Understood." }),
    event(4, "user", { message: "always answer in plain english" }),
    event(5, "assistant", { message: "Will do." }),
    // decoys: specific to a file / a commit / a URL, so not standing rules
    event(6, "user", { message: "never touch src/handoff/render.ts again" }),
    event(7, "assistant", { message: "ok" }),
    event(8, "user", { message: "do not revert 4be825dfa11" }),
    event(9, "assistant", { message: "ok" }),
    ...filler(10),
  ];

  // v6/V4 REPLACES v5's single list: an order that FORBIDS something is a
  // prohibition and moves to its own section under the newest recap; the rest
  // stay here, and nothing is printed twice.
  test("short general orders are listed verbatim, right after the notes — prohibitions excepted", () => {
    const { text } = render(events);
    const section = text.slice(text.indexOf("## Standing instructions from the owner (verbatim)"), text.indexOf("## Key moments"));
    expect(text.indexOf("## Standing instructions")).toBeGreaterThan(text.indexOf("## Notes (deterministic"));
    expect(section).toContain(`- "always answer in plain english"  [seq 4, 2026-01-01 10:04 UTC,`);
    expect(section).not.toContain("never push without asking me first");
    const doNot = text.slice(text.indexOf("## Do not (the owner's prohibitions, verbatim)"), text.indexOf("## What this is"));
    expect(doNot).toContain(`- "never push without asking me first"  [seq 2, 2026-01-01 10:02 UTC,`);
  });

  test("an order about one file, commit or URL is not a standing instruction", () => {
    const { text } = render(events);
    const section = text.slice(text.indexOf("## Standing instructions"), text.indexOf("## Key moments"));
    expect(section).not.toContain("src/handoff/render.ts");
    expect(section).not.toContain("4be825dfa11");
  });

  test("instructions stay steering moments too", () => {
    const { text } = render(events);
    expect(text).toContain("- steering: never push without asking me first");
  });
});

describe("standing instructions reject pasted documents and feelings", () => {
  const paste = [
    "Recommendation: **approve the direction** with three changes.",
    "### 3. \"Code never speaks\" is too absolute",
    "Do not cut over until the bench is green.",
  ].join("\n");
  const longTurn = `here is the review, tell me what you think\n${paste}\n${"more review prose. ".repeat(20)}`;

  test("a line inside a long turn is a paste, never a rule", () => {
    for (const line of paste.split("\n")) expect(isStandingInstruction(line, longTurn)).toBe(false);
    // the same sentence typed on its own IS a rule
    expect(isStandingInstruction("Do not cut over until the bench is green.")).toBe(true);
  });

  test("markdown markers, bold, questions and first person are rejected", () => {
    expect(isStandingInstruction("### 3. \"Code never speaks\" is too absolute")).toBe(false);
    expect(isStandingInstruction("- never do that")).toBe(false);
    expect(isStandingInstruction("> never do that")).toBe(false);
    expect(isStandingInstruction("3) never do that")).toBe(false);
    expect(isStandingInstruction("`never` do that")).toBe(false);
    expect(isStandingInstruction("Recommendation: **approve the direction** and never stop")).toBe(false);
    expect(isStandingInstruction("should I always run the bench first?")).toBe(false);
    expect(isStandingInstruction("so where are we I don't understand")).toBe(false);
    expect(isStandingInstruction("we never got that working")).toBe(false);
  });

  test("the genuine rules of a real session survive", () => {
    for (const rule of [
      "plain english",
      "i want you to tell me before you do anything expensive",
      "do not do anything yourself use codex for the implementation",
      "stop doing whack-a-mole fixes, find the root cause every time",
    ]) {
      expect(isStandingInstruction(rule)).toBe(true);
    }
  });

  test("a whole pasted review contributes nothing to the section", () => {
    const events = [
      event(1, "user", { message: "Build the exporter" }),
      event(2, "user", { message: longTurn }),
      event(3, "assistant", { message: "Noted." }),
      event(4, "user", { message: "plain english" }),
      event(5, "assistant", { message: "Understood." }),
      ...filler(6),
    ];
    const { text } = render(events);
    const section = text.slice(text.indexOf("## Standing instructions"), text.indexOf("## Key moments"));
    expect(section).toContain(`- "plain english"  [seq 4,`);
    expect(section).not.toContain("approve the direction");
    expect(section).not.toContain("Code never speaks");
    expect(section).not.toContain("cut over");
  });
});

describe("quoted trace text never becomes structure", () => {
  const withHeadings = [
    event(1, "user", { message: "@\"docs/brief.md\"\n## Operating model\nYou plan, codex implements.\n## Rules\nNever push." }),
    event(2, "user", { message: "where are we?" }),
    event(3, "assistant", { message: "## The short version\nThree of five waves are in.\n### What is left\n- truncation\n- prefixes" }),
    ...filler(4),
  ];

  test("a multi-line goal is blockquoted, not pasted as headings", () => {
    const { text } = render(withHeadings);
    expect(text).toContain("> ## Operating model");
    expect(text).not.toMatch(/^## Operating model$/m);
  });

  test("recap bodies are blockquoted", () => {
    const { text } = render(withHeadings);
    expect(text).toContain("> ## The short version");
    expect(text).not.toMatch(/^## The short version$/m);
    expect(text).not.toMatch(/^### What is left$/m);
  });

  test("a recap moment line stays one line", () => {
    const { text } = render(withHeadings);
    const line = text.split("\n").find((candidate) => candidate.startsWith("- recap (asked"))!;
    expect(line).toContain("## The short version Three of five waves are in. ### What is left");
    expect(line).toEndWith("[seq 3]");
  });

  test("an instruction line stays one line, whitespace collapsed", () => {
    const events = [
      event(1, "user", { message: "go" }),
      event(2, "user", { message: "never   push\twithout asking" }),
      event(3, "assistant", { message: "ok" }),
      ...filler(4),
    ];
    const { text } = render(events);
    // v6/V4 — it is a prohibition, so the Do not section is where it lands
    const section = text.slice(text.indexOf("## Do not (the owner's prohibitions"), text.indexOf("## What this is"));
    expect(section).toContain(`- "never push without asking"  [seq 2,`);
    for (const line of section.split("\n").filter((candidate) => candidate.startsWith("- \""))) {
      expect(line).toEndWith("]");
    }
  });

  test("every section heading in the orientation layer is the renderer's own", () => {
    const { text } = render(withHeadings);
    // The verbatim tail is the trace itself and stays exactly as it was; the
    // orientation layer above it is the renderer's own structure.
    const orientation = text.slice(0, text.indexOf("## The tail, verbatim"));
    const headings = orientation.split("\n").filter((line) => /^#{1,3} /.test(line));
    for (const heading of headings) {
      expect(heading).toMatch(/^(?:# Handoff:|## (?:What this is|Half-done|Right now|Last seen in the session|What the outgoing agent said|The newest recap|Do not|What reached a remote|Waiting on the owner|Notes|Standing instructions|Glossary|File map|Lessons|Other sessions|Key moments|Recaps|[\w.-]+, as last seen|How to read|The tail)|### (?:Ch \d+|Q\d|[\w.-]+, last \d+ dated entries))/);
    }
  });
});

describe("W4 the goal", () => {
  test("an @file first prompt prints the text under the reference", () => {
    const events = [event(1, "user", { message: `@"docs/plan.md"\nImplement phase two of the plan, starting with the writer.` }), ...filler(2)];
    const { text } = render(events);
    expect(text).toContain("- goal (first prompt): Implement phase two of the plan, starting with the writer.  [seq 1]");
  });

  test("a bare @file prompt keeps the reference", () => {
    const pieces = extractPieces([event(1, "user", { message: "@docs/plan.md" })], {}, {});
    expect(goalText(pieces)?.text).toBe("@docs/plan.md");
  });

  test("a long first prompt prints its content, not just its first line", () => {
    const body = `Rewrite the importer.\n${"Detail line. ".repeat(300)}`;
    const pieces = extractPieces([event(1, "user", { message: body })], {}, {});
    const goal = goalText(pieces);
    expect(goal?.text.length).toBe(2_500);
    expect(goal?.text).toContain("Detail line.");
  });
});

describe("W5 truncation", () => {
  test("the clip marker names the session, the seq, and the flag that lifts the cap", () => {
    const events = [event(7, "tool_result", { output: "y".repeat(5_000) })];
    const [piece] = extractPieces(events, {}, {});
    expect(piece!.lines[0]).toContain(`carafe show ${sessionId} --seq 7 --max-chars 0`);
  });

  test("an unbounded result cap renders a result whole", () => {
    const events = [event(7, "tool_result", { output: "y".repeat(5_000) })];
    const [piece] = extractPieces(events, { resultCap: Infinity }, {});
    expect(piece!.lines[0]).not.toContain("more chars");
    expect(piece!.lines[0]!.length).toBeGreaterThan(5_000);
  });

  test("clip without a reference still points at the command", () => {
    expect(clip("z".repeat(10), 4)).toContain("carafe show <id> --seq <seq> --max-chars 0");
  });

  test("the tail's tool results use the wider 6,000-char cap", () => {
    const events = [
      event(1, "user", { message: "Build the exporter" }),
      ...filler(2),
      event(300, "user", { message: "read the review" }),
      event(301, "tool_result", { output: "R".repeat(5_000) }),
    ];
    const { text } = render(events);
    const tail = text.slice(text.indexOf("## The tail, verbatim"));
    expect(tail).toContain("R".repeat(4_000));
  });
});

describe("W6 the tail never contains its own generation", () => {
  const generation = [
    event(300, "user", { message: "hand this off" }),
    event(301, "tool_use", { name: "Bash", arguments: { command: `carafe handoff ${sessionId} --to codex` } }),
    event(302, "tool_result", { output: "handoff ready → Codex (agent)" }),
  ];

  test("a generation call and its result are recognised and dropped", () => {
    const line = `→ **Bash** {"command":"carafe handoff ${sessionId} --to codex"}`;
    expect(isSelfGenerationLine(line, sessionId)).toBe(true);
    expect(isSelfGenerationLine(`→ **Bash** {"command":"carafe handoff other-session"}`, sessionId)).toBe(false);
    const pieces = extractPieces(generation, {}, {});
    const cleaned = withoutSelfGeneration(pieces, sessionId);
    expect(cleaned.flatMap((piece) => piece.lines).join("\n")).not.toContain("carafe handoff");
    expect(cleaned.flatMap((piece) => piece.lines).join("\n")).not.toContain("handoff ready");
  });

  test("`carafe key-moments current` counts as this session's own generation", () => {
    expect(isSelfGenerationLine(`→ **Bash** {"command":"carafe key-moments current"}`, sessionId)).toBe(true);
  });

  test("a generation call in the MIDDLE of the tail never shortens it", () => {
    const events = [
      event(1, "user", { message: "Build the exporter" }),
      ...filler(2),
      event(300, "user", { message: "hand this off" }),
      event(301, "tool_use", { name: "Bash", arguments: { command: `carafe handoff ${sessionId} --to codex` } }),
      event(302, "tool_result", { output: "handoff ready" }),
      event(303, "user", { message: "actually, three more days of work first" }),
      event(304, "assistant", { message: "On it." }),
      event(305, "tool_use", { name: "Edit", arguments: { file_path: "/tmp/project/late.ts" } }),
      event(306, "tool_result", { output: "ok" }),
      event(307, "user", { message: "and the last fix" }),
      event(308, "assistant", { message: "Done." }),
    ];
    const { text } = render(events);
    const tail = text.slice(text.indexOf("## The tail, verbatim"));
    expect(tail).toContain("actually, three more days of work first");
    expect(tail).toContain("and the last fix");
    expect(tail).toContain("Done.");
    // the call itself is still gone, wherever it sat
    expect(tail).not.toContain("carafe handoff");
    expect(tail).not.toContain("handoff ready");
  });

  test("repeated generation calls only cut at the trailing run", () => {
    const events = [
      event(1, "user", { message: "Build the exporter" }),
      ...filler(2),
      event(300, "tool_use", { name: "Bash", arguments: { command: `carafe handoff ${sessionId}` } }),
      event(301, "tool_result", { output: "handoff ready" }),
      event(302, "user", { message: "KEEP THIS TURN" }),
      event(303, "assistant", { message: "Sure." }),
      event(304, "tool_use", { name: "Bash", arguments: { command: `carafe key-moments ${sessionId}` } }),
      event(305, "tool_result", { output: "key moments ready" }),
      event(306, "tool_use", { name: "Bash", arguments: { command: `carafe handoff ${sessionId}` } }),
      event(307, "tool_result", { output: "handoff ready" }),
    ];
    const { text, tailStartSeq } = render(events);
    const tail = text.slice(text.indexOf("## The tail, verbatim"), text.indexOf("\n## Dig deeper"));
    expect(tail).toContain("KEEP THIS TURN");
    expect(tail).toContain("Sure.");
    expect(tail).not.toContain("carafe ");
    expect(tailStartSeq).toBeLessThanOrEqual(302);
  });

  test("the tail ends before the generation call when the session ends on it", () => {
    const events = [event(1, "user", { message: "Build the exporter" }), ...filler(2), ...generation];
    const { text, tailStartSeq } = render(events);
    const tail = text.slice(text.indexOf("## The tail, verbatim"));
    expect(tail).not.toContain("carafe handoff");
    expect(tail).not.toContain("handoff ready");
    expect(tail).toContain("hand this off");
    expect(tailStartSeq).toBeLessThan(301);
  });
});

describe("W7 the header", () => {
  test("repos are the ones actually worked in, with the branch last seen in the trace", () => {
    const work = mkdtempSync(join(tmpdir(), "carafe-worked-"));
    mkdirSync(join(work, ".git"), { recursive: true });
    try {
      const events = [
        event(1, "user", { message: "fix both repos" }),
        event(2, "tool_use", { name: "Bash", arguments: { command: `codex exec "go" -C "${work}"` } }),
        event(3, "tool_result", { output: "ok" }),
        event(4, "tool_use", { name: "Bash", arguments: { command: `git -C "${work}" rev-parse --abbrev-ref HEAD` } }),
        event(5, "tool_result", { output: "feat/handoff-v2" }),
      ];
      const pieces = extractPieces(events, {}, {});
      expect(reposWorkedIn(events, pieces)[0]?.path).toBe(work);
      expect(branchFromTrace(pieces)).toBe("feat/handoff-v2");
      const { text } = render(events);
      // v6/V9 REPLACES v5's trace-read header branch: `· branch x` is printed
      // only when the LIVE readings agree that every header repo is on it, and
      // this render has none, so the claim is omitted rather than guessed
      expect(text).toContain(`- repos: ${work} (2 tool calls)`);
      expect(text).not.toContain("· branch feat/handoff-v2");
      // round 8 — the header leads with the repository worked in most, never
      // the folder the session happened to start in
      expect(text).not.toContain("- started in:");
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  test("shared roots, scratch space and the home directory are never repos", () => {
    for (const key of ["/", "/tmp", "/private/tmp", "/var", "/private/var", process.env.HOME ?? "/nonexistent-home", "/private/tmp/claude-501/abc/scratchpad", "/tmp/claude-xyz/work"]) {
      expect(isExcludedWorkspace(key)).toBe(true);
    }
    const events = [
      event(1, "tool_use", { name: "Bash", arguments: { command: "cd / && ls" } }),
      event(2, "tool_result", { output: "ok" }),
      event(3, "tool_use", { name: "Bash", arguments: { command: "cd /private/tmp/claude-501/session/scratchpad && ls" } }),
      event(4, "tool_result", { output: "ok" }),
    ];
    expect(reposWorkedIn(events, extractPieces(events, {}, {}))).toEqual([]);
  });

  test("work under an excluded cwd is excluded however deep it sits", () => {
    const scratch = "/private/tmp/claude-501/session/scratchpad";
    const events = [
      event(1, "tool_use", { name: "Bash", arguments: { command: `cd ${scratch}/deep/inner && ls` } }),
      event(2, "tool_result", { output: "ok" }),
    ];
    expect(reposWorkedIn(events, extractPieces(events, {}, {}), scratch)).toEqual([]);
  });

  test("`On branch X` in any result is a branch reading", () => {
    const events = [event(1, "tool_use", { name: "Bash", arguments: { command: "git status" } }), event(2, "tool_result", { output: "On branch main\nnothing to commit" })];
    expect(branchFromTrace(extractPieces(events, {}, {}))).toBe("main");
  });
});

describe("W8 what a steer changed", () => {
  test("a bent moment renders the reply's first line; costing keeps the old note", () => {
    const bent = { kind: "ask", seq: 9, text: "**user:** actually, do the queues first", note: "trajectory changed", nextReply: "Switching to the queue work." } as const;
    expect(renderMomentLine({ ...bent })).toBe(`- steering: actually, do the queues first → then: "Switching to the queue work."  [seq 9]`);
    // no reply recorded → no suffix at all, never the bare label
    expect(renderMomentLine({ kind: "ask", seq: 9, text: "**user:** go", note: "trajectory changed" })).toBe("- steering: go  [seq 9]");
    // selection still sees the stored note, so budgets do not move
    expect(steeringPriority({ ...bent })).toBe(1);
    expect(momentCharCost({ ...bent })).toBe(momentCharCost({ kind: "ask", seq: 9, text: "**user:** actually, do the queues first", note: "trajectory changed" }));
  });

  test("the rendered suffix is the assistant's next line, not a label", () => {
    const events: CarafeEvent[] = [event(1, "user", { message: "Build the exporter" })];
    let seq = 2;
    // two file neighbourhoods, so the turn between them reads as a bend
    for (const file of ["/tmp/project/a.ts", "/tmp/project/b.ts"]) {
      for (let i = 0; i < 3; i++) {
        events.push(event(seq++, "user", { message: `work on ${i}` }));
        events.push(event(seq++, "assistant", { message: "Working." }));
        events.push(event(seq++, "tool_use", { name: "Read", arguments: { file_path: `${file}${i}` } }));
        events.push(event(seq++, "tool_result", { output: "ok" }));
      }
    }
    events.push(...filler(seq));
    const { text } = render(events);
    expect(text).not.toContain("→ trajectory changed");
    if (text.includes("then: \"")) expect(text).toContain(`then: "Working."`);
  });
});

describe("W9 the token estimate", () => {
  test("tokens are estimated at chars/2.7 and labelled an estimate", () => {
    expect(tokenEstimate(156_174)).toBe("≈ 58K tokens (estimate)");
    expect(tokenEstimate(1_728)).toBe("≈ 640 tokens (estimate)");
    const { text } = render([event(1, "user", { message: "go" }), ...filler(2)]);
    expect(text).toMatch(/≈ \d+K tokens \(estimate\)/);
  });
});

describe("W10 duplicate file names", () => {
  test("two paths sharing a basename render as parent/name", () => {
    const events: CarafeEvent[] = [event(1, "user", { message: "touch both renderers" })];
    let seq = 2;
    for (let i = 0; i < 3; i++) {
      for (const path of ["/tmp/project/handoff/render.ts", "/tmp/project/ui/render.ts"]) {
        events.push(event(seq++, "tool_use", { name: "Edit", arguments: { file_path: path } }));
        events.push(event(seq++, "tool_result", { output: "ok" }));
      }
    }
    events.push(...filler(seq));
    const { text } = render(events);
    expect(text).toContain("handoff/render.ts");
    expect(text).toContain("ui/render.ts");
  });
});

describe("W11 generated-at", () => {
  test("the header says when it was made and how to remake it", () => {
    const { text } = render([event(1, "user", { message: "go" }), event(2, "assistant", { message: "ok" })]);
    expect(text).toContain(`- generated 2026-02-01T00:00:00Z from events up to seq 2; optional regeneration if carafe is installed: carafe handoff ${sessionId}`);
  });
});

describe("W1 sibling sessions and W12 id prefixes", () => {
  let root = "";
  let repo = "";
  let oldHome: string | undefined;

  const seed = (id: string, over: Partial<SessionDistillate>, events: CarafeEvent[] = [event(1, "user", { message: "work" }, id)]): void => {
    const store = new CarafeStore(root);
    const d = distillate(events, { sessionId: id, ...over });
    sealSession(store, d.tool, d.sessionId, events);
    writeDistillate(store, d);
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "carafe-handoff-v2-"));
    repo = mkdtempSync(join(tmpdir(), "carafe-repo-"));
    mkdirSync(join(repo, ".git"), { recursive: true });
    mkdirSync(join(repo, "packages", "api"), { recursive: true });
    oldHome = process.env.CARAFE_HOME;
    process.env.CARAFE_HOME = root;
  });

  afterEach(() => {
    if (oldHome === undefined) delete process.env.CARAFE_HOME;
    else process.env.CARAFE_HOME = oldHome;
    for (const dir of [root, repo]) if (dir) rmSync(dir, { recursive: true, force: true });
  });

  test("workspaceKey is the nearest repo root, else the cwd ITSELF", () => {
    expect(workspaceKey(join(repo, "packages", "api"))).toBe(repo);
    expect(workspaceKey(repo)).toBe(repo);
    // no .git anywhere: two unrelated projects in one folder are NOT siblings
    expect(workspaceKey("/tmp/no-such-projects-dir/expo-app")).toBe("/tmp/no-such-projects-dir/expo-app");
    expect(workspaceKey("/tmp/no-such-projects-dir/yokey")).not.toBe(workspaceKey("/tmp/no-such-projects-dir/expo-app"));
    expect(workspaceKey(null)).toBe(null);
  });

  test("a git worktree shares the main repository's workspace", () => {
    const tree = mkdtempSync(join(tmpdir(), "carafe-worktree-"));
    try {
      writeFileSync(join(tree, ".git"), `gitdir: ${repo}/.git/worktrees/feature\n`);
      expect(workspaceKey(tree)).toBe(repo);
      expect(workspaceKey(join(tree, "src"))).toBe(repo);
    } finally {
      rmSync(tree, { recursive: true, force: true });
    }
  });

  test("sessions sharing a workspace in the last 14 days are siblings; helpers fold into their parent", () => {
    seed("aaaa1111-main", { cwd: repo, tool: "codex", startTs: "2026-01-10T09:00:00Z", endTs: "2026-01-10T12:00:00Z" });
    seed("bbbb2222-other", { cwd: join(repo, "packages", "api"), tool: "claude-code", title: "the API work", startTs: "2026-01-08T09:00:00Z", endTs: "2026-01-08T18:00:00Z" });
    seed("agent-3333-helper", { cwd: join(repo, "packages", "api"), tool: "claude-code", sidechain: true, startTs: "2026-01-08T10:00:00Z", endTs: "2026-01-08T11:00:00Z" });
    seed("cccc4444-stale", { cwd: repo, tool: "codex", startTs: "2025-11-01T09:00:00Z", endTs: "2025-11-01T10:00:00Z" });
    seed("dddd5555-elsewhere", { cwd: "/tmp/somewhere-else-entirely", tool: "codex" });

    const store = new CarafeStore(root);
    const main = findSession(store, "aaaa1111-main")!;
    const siblings = siblingSessions(store, main);
    expect(siblings.map((s) => s.sessionId)).toEqual(["bbbb2222-other"]);
    expect(siblings[0]!.helpers).toBe(1);
    expect(siblings[0]!.title).toBe("the API work");
  });

  test("the handoff lists them with a way to read each one", () => {
    seed("bbbb2222-other", { cwd: repo, tool: "claude-code", title: "the API work", startTs: "2026-01-08T09:00:00Z", endTs: "2026-01-08T18:00:00Z" });
    const store = new CarafeStore(root);
    const events = [event(1, "user", { message: "Build the exporter" }), ...filler(2)];
    const d = distillate(events, { cwd: repo, startTs: "2026-01-10T09:00:00Z", endTs: "2026-01-10T12:00:00Z" });
    const { text } = renderHandoff(d, events, { now: "2026-02-01T00:00:00Z", target: "codex", siblings: siblingSessions(store, d) });
    const section = text.slice(text.indexOf("## Other sessions in this workspace"));
    expect(section).toContain(`- claude-code bbbb2222 · "the API work" · 2026-01-08 → 2026-01-08 · 1 events`);
    expect(section).toContain("carafe handoff <id> for any of them");
  });

  test("an orchestrator in a stub folder finds the sessions of the repos it worked in", () => {
    const stub = mkdtempSync(join(tmpdir(), "carafe-stub-"));
    const other = join(stub, "repo-b");
    mkdirSync(join(other, ".git"), { recursive: true });
    try {
      seed("bbbb2222-in-repo-a", { cwd: repo, tool: "claude-code", title: "work in repo A", startTs: "2026-01-09T09:00:00Z", endTs: "2026-01-09T18:00:00Z" });
      seed("cccc3333-in-repo-b", { cwd: other, tool: "codex", title: "work in repo B", startTs: "2026-01-09T09:00:00Z", endTs: "2026-01-09T18:00:00Z" });
      const elsewhere = join(stub, "elsewhere");
      mkdirSync(elsewhere, { recursive: true });
      seed("dddd4444-unrelated", { cwd: elsewhere, tool: "codex", title: "unrelated", startTs: "2026-01-09T09:00:00Z", endTs: "2026-01-09T18:00:00Z" });
      const store = new CarafeStore(root);
      // the orchestrator SAT in a stub folder and worked via `git -C` elsewhere
      const d = distillate([], { cwd: stub, startTs: "2026-01-10T09:00:00Z", endTs: "2026-01-10T12:00:00Z" });
      expect(siblingSessions(store, d).map((s) => s.sessionId)).toEqual([]);
      const found = siblingSessions(store, d, undefined, [repo, other]).map((s) => s.sessionId).sort();
      expect(found).toEqual(["bbbb2222-in-repo-a", "cccc3333-in-repo-b"]);
    } finally {
      rmSync(stub, { recursive: true, force: true });
    }
  });

  test("an excluded workspace key never matches siblings", () => {
    seed("eeee5555-scratch", { cwd: "/private/tmp/claude-501/x/scratchpad", tool: "codex", startTs: "2026-01-09T09:00:00Z", endTs: "2026-01-09T18:00:00Z" });
    const store = new CarafeStore(root);
    const d = distillate([], { cwd: "/private/tmp/claude-501/x/scratchpad", startTs: "2026-01-10T09:00:00Z", endTs: "2026-01-10T12:00:00Z" });
    expect(siblingSessions(store, d)).toEqual([]);
  });

  test("a unique id prefix of at least six characters resolves", () => {
    seed("aaaa1111-main", { cwd: repo });
    const store = new CarafeStore(root);
    expect(findSession(store, "aaaa11")?.sessionId).toBe("aaaa1111-main");
    expect(findSession(store, "aaaa1")).toBe(null);
    expect(findSession(store, "zzzzzzzz")).toBe(null);
  });

  test("an ambiguous prefix errors with the candidates listed", () => {
    seed("aaaa1111-one", { cwd: repo });
    seed("aaaa1111-two", { cwd: repo });
    const store = new CarafeStore(root);
    expect(() => findSession(store, "aaaa11")).toThrow(AmbiguousSessionIdError);
    try {
      findSession(store, "aaaa11");
    } catch (error) {
      expect((error as AmbiguousSessionIdError).candidates).toEqual(["aaaa1111-one", "aaaa1111-two"]);
      expect((error as Error).message).toContain("aaaa1111-two");
    }
    // the full id is never ambiguous
    expect(findSession(store, "aaaa1111-one")?.sessionId).toBe("aaaa1111-one");
  });
});
