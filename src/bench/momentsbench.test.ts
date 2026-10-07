import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";
import * as cc from "../adapters/claude-code";
import * as codex from "../adapters/codex";
import { extractPieces } from "../handoff/pieces";
import { buildCorpus, corpusHash } from "./corpus";
import { generateSessionPlan } from "./generate";
import { renderClaudeCode } from "./render-cc";
import { renderCodex } from "./render-codex";
import { readBaseline, runBench } from "./run";
import { scoreSession } from "./score";
import { EXTRACTORS } from "./extractors";
import { segmentChapters } from "../keymoments/chapters";
import type { CarafeEvent } from "../format/events";
import type { SessionDistillate } from "../format/distillate";

describe("MomentsBench", () => {
  test("same seed produces identical native traces and sealed gold", () => {
    for (const size of ["S", "M", "L"] as const) {
      const a = generateSessionPlan({ seed: 77, size });
      const b = generateSessionPlan({ seed: 77, size });
      expect(a).toEqual(b);
      const ids = { sessionId: "4f9a8c10-77aa-4d00-a111-000000000077" };
      expect(renderClaudeCode(a, ids).jsonl).toEqual(renderClaudeCode(b, ids).jsonl);
      expect(renderCodex(a, ids).jsonl).toEqual(renderCodex(b, ids).jsonl);
    }
  });

  test("the gate corpus is sealed", () => {
    const expected = readFileSync(join(import.meta.dir, "gold", "gate.hash"), "utf8").trim();
    expect(corpusHash("gate"), "corpus changed — if intended, run `carafe bench moments --update-baseline`").toBe(expected);
    expect(buildCorpus("gate")).toHaveLength(10);
  });

  test("rule restatements are scored by overlap with the rule moment span", () => {
    for (const session of buildCorpus("gate")) {
      const rules = scoreSession(session, EXTRACTORS.v2!).perKind.rule;
      expect(rules?.strict.count, session.name).toBe(rules?.strict.total);
    }
  });

  test("real adapters parse every session and size targets hold", () => {
    const sessions = buildCorpus("gate");
    for (const session of sessions) {
      const parsed = session.tool === "claude-code" ? cc.parseFile(session.jsonl.join("\n")) : codex.parseFile(session.jsonl.join("\n"));
      expect(parsed.parseErrors, session.name).toBe(0);
      expect(session.events.length, session.name).toBe(parsed.events.length);
      const min = session.size === "S" ? 250 : session.size === "M" ? 3_500 : 25_000;
      const max = session.size === "S" ? 400 : session.size === "M" ? 5_000 : 35_000;
      expect(session.events.length, session.name).toBeGreaterThanOrEqual(min);
      expect(session.events.length, session.name).toBeLessThanOrEqual(max);
    }
  });

  test("rendered user turns are exactly the planned turns plus answered popups", () => {
    for (const [seed, size] of [[11, "S"], [12, "S"], [21, "M"], [22, "M"], [31, "L"]] as const) {
      const plan = generateSessionPlan({ seed, size });
      const expected = plan.beats.filter((beat) => beat.kind === "user" && !beat.systemInjected).length
        + plan.beats.filter((beat) => beat.kind === "popup" && beat.answer != null).length;
      const ids = { sessionId: `turn-${seed}` };
      const ccTrace = renderClaudeCode(plan, ids);
      const codexTrace = renderCodex(plan, ids);
      const ccEvents = cc.parseFile(ccTrace.jsonl.join("\n")).events;
      const ccTurns = ccEvents.filter((event, index) => {
        const raw = event.raw as any;
        if (event.kind !== "user" || raw?.isMeta === true) return false;
        if (typeof raw?.message?.content === "string") return true;
        const previous = ccEvents[index - 1]?.raw as any;
        return Array.isArray(raw?.message?.content) && raw.message.content.some((item: any) => item?.type === "tool_result" && item?.is_error !== true)
          && Array.isArray(previous?.message?.content) && previous.message.content.some((item: any) => item?.name === "AskUserQuestion");
      }).length;
      const codexTurns = codex.parseFile(codexTrace.jsonl.join("\n")).events.filter((event) => {
        const raw = event.raw as any;
        return event.kind === "user" && raw?.payload?.type === "user_message";
      }).length;
      expect(ccTurns, `CC seed ${seed}`).toBe(expected);
      expect(codexTurns, `Codex seed ${seed}`).toBe(expected);
    }
  });

  test("Codex renders injected context as developer content and cancelled popups as questions only", () => {
    const plan = generateSessionPlan({ seed: 31, size: "L" });
    const trace = renderCodex(plan, { sessionId: "renderer-fixture" });
    const parsed = codex.parseFile(trace.jsonl.join("\n"));
    for (const beat of plan.beats) {
      if (beat.kind !== "user" || !beat.systemInjected) continue;
      const range = trace.beatSeqs.get(plan.beats.indexOf(beat))!;
      const raw = parsed.events[range[0]]!.raw as any;
      expect(raw.type).toBe("response_item");
      expect(raw.payload).toEqual({ type: "message", role: "developer", content: [{ type: "input_text", text: beat.text }] });
    }
    for (const [beatId, beat] of plan.beats.entries()) {
      if (beat.kind !== "popup" || beat.answer !== null) continue;
      const range = trace.beatSeqs.get(beatId)!;
      expect(range[0]).toBe(range[1]);
      expect((parsed.events[range[0]]!.raw as any).payload.type).toBe("agent_message");
    }
  });

  test("v1 renders the goal before the moments section", () => {
    const session = buildCorpus("gate").find((candidate) => candidate.name === "S-11-claude-code")!;
    const pieces = extractPieces(session.events, {}, {});
    const input = { events: session.events, pieces, distillate: session.distillate };
    const moments = EXTRACTORS.v1!.extract(input).moments;
    const goal = moments.find((moment) => moment.kind === "goal");
    expect(goal).toBeDefined();
    if (!goal) return;
    expect(EXTRACTORS.v1!.render(input, moments, 20_000)).toStartWith(`- goal: ${goal.text.slice(0, 200)}  [seq ${goal.seq}]\n`);
  });

  test("L sessions have realistic user-turn density", () => {
    for (const session of buildCorpus("gate").filter((s) => s.size === "L")) {
      const turns = session.tool === "claude-code"
        ? session.events.filter((event) => { const raw = event.raw as any; return event.kind === "user" && typeof raw?.message?.content === "string" && raw?.isMeta !== true; }).length
        : session.events.filter((event) => (event.raw as any)?.payload?.type === "user_message").length;
      expect(turns, session.name).toBeGreaterThanOrEqual(500);
      expect(session.events.length / turns, session.name).toBeGreaterThanOrEqual(25);
      expect(session.events.length / turns, session.name).toBeLessThanOrEqual(50);
    }
  });

  test("each third contains the complete planted composition", () => {
    const goldKinds = ["decision.popup", "decision.freetext", "decision.approval", "steering", "deadend.abandoned", "breakthrough", "rule", "artifact.commit"];
    const distractorKinds = ["fixed-fast", "stash-housekeeping", "quoted-error", "rejected-proposal", "cancelled-popup", "ack-turn", "explore-burst", "system-injected"];
    for (const [seed, size] of [[11, "S"], [12, "S"], [21, "M"], [22, "M"], [31, "L"]] as const) {
      const plan = generateSessionPlan({ seed, size });
      for (const third of ["early", "middle", "late"] as const) {
        expect(goldKinds.every((kind) => plan.gold.some((unit) => unit.third === third && unit.kind === kind)), `${seed} ${third} gold`).toBe(true);
        expect(distractorKinds.every((kind) => plan.distractors.some((unit) => {
          const beat = unit.beats[0];
          const actual = beat < plan.beats.length / 3 ? "early" : beat < plan.beats.length * 2 / 3 ? "middle" : "late";
          return actual === third && unit.kind === kind;
        })), `${seed} ${third} distractors`).toBe(true);
      }
      expect(plan.gold.filter((unit) => unit.kind === "deadend.reversal").map((unit) => unit.third)).toEqual(["middle", "late"]);
      expect(plan.gold.filter((unit) => unit.kind === "deadend.notrace").map((unit) => unit.third)).toEqual(["early", "middle"]);
      expect(plan.gold.filter((unit) => unit.kind === "artifact.pr").map((unit) => unit.third)).toEqual(["late"]);
    }
  });

  test("abandoned and breakthrough windows contain failing streaks", () => {
    for (const [seed, size] of [[11, "S"], [12, "S"], [21, "M"], [22, "M"], [31, "L"]] as const) {
      const plan = generateSessionPlan({ seed, size });
      const failing = (beats: typeof plan.beats) => beats.filter((beat) => beat.kind === "tool" && beat.exitCode !== 0).length;
      const passing = (beats: typeof plan.beats) => beats.filter((beat) => beat.kind === "tool" && beat.name === "shell" && beat.exitCode === 0).length;
      for (const unit of plan.gold.filter((candidate) => candidate.kind === "deadend.abandoned")) {
        expect(failing(plan.beats.slice(unit.beats[0], unit.beats[1] + 1)), `${seed} ${unit.kind} ${unit.id}`).toBeGreaterThanOrEqual(2);
      }
      // A breakthrough window starts at the explanation, AFTER the streak: the failures sit
      // just before it and the window itself holds the fix and the passing run only.
      for (const unit of plan.gold.filter((candidate) => candidate.kind === "breakthrough")) {
        const window = plan.beats.slice(unit.beats[0], unit.beats[1] + 1);
        expect(failing(plan.beats.slice(Math.max(0, unit.beats[0] - 14), unit.beats[0])), `${seed} ${unit.kind} ${unit.id} streak`).toBeGreaterThanOrEqual(2);
        expect(failing(window), `${seed} ${unit.kind} ${unit.id} window`).toBe(0);
        expect(passing(window), `${seed} ${unit.kind} ${unit.id} success`).toBeGreaterThanOrEqual(1);
      }
    }
  });

  test("every no-trace experiment is completely removed later", () => {
    for (const [seed, size] of [[11, "S"], [12, "S"], [21, "M"], [22, "M"], [31, "L"]] as const) {
      const plan = generateSessionPlan({ seed, size });
      for (const unit of plan.gold.filter((candidate) => candidate.kind === "deadend.notrace")) {
        const files = plan.beats.slice(unit.beats[0], unit.beats[1] + 1).flatMap((beat) => beat.kind === "tool" && beat.name === "write" && beat.input.path ? [beat.input.path] : []);
        expect(files.length, `${seed} ${unit.id} writes`).toBe(3);
        const removal = plan.beats.slice(unit.beats[1] + 1).find((beat) => beat.kind === "tool" && beat.name === "shell" && files.every((file) => beat.input.command?.includes(file)));
        expect(removal, `${seed} ${unit.id} cleanup`).toBeDefined();
      }
    }
  });

  test("ack distractors are short acknowledgements", () => {
    const allowed = new Set(["ok", "continue", "looks good, go on", "yes", "sounds good", "thanks, carry on", "k, next", "go on"]);
    const seen = new Set<string>();
    for (const [seed, size] of [[11, "S"], [12, "S"], [13, "S"], [14, "S"], [15, "S"], [21, "M"], [22, "M"], [23, "M"], [24, "M"], [31, "L"], [32, "L"]] as const) {
      const plan = generateSessionPlan({ seed, size });
      for (const distractor of plan.distractors.filter((candidate) => candidate.kind === "ack-turn")) {
        const beat = plan.beats[distractor.beats[0]]!;
        expect(beat.kind).toBe("user");
        if (beat.kind !== "user") continue;
        expect(allowed.has(beat.text), beat.text).toBe(true);
        expect(beat.text.length, beat.text).toBeLessThanOrEqual(40);
        seen.add(beat.text);
      }
    }
    expect(seen.size).toBeGreaterThanOrEqual(6);
  });

  test("M and L sessions carry calibrated gaps, branch switches, and cwd changes", () => {
    const counts = (seed: number, size: "M" | "L") => {
      const plan = generateSessionPlan({ seed, size });
      const commands = plan.beats.flatMap((beat) => beat.kind === "tool" && beat.name === "shell" && beat.input.command ? [beat.input.command] : []);
      return {
        gaps: plan.beats.filter((beat) => beat.kind === "gap" && beat.hours >= 4).length,
        branches: commands.filter((command) => /^(git checkout|git switch)/.test(command)).length,
        cwdChanges: commands.filter((command) => command.startsWith("cd services/")).length,
      };
    };
    for (const seed of [31, 32]) {
      const signals = counts(seed, "L");
      expect(signals.gaps, `L-${seed} gaps`).toBeWithin(80, 131);
      expect(signals.branches, `L-${seed} branches`).toBeWithin(15, 36);
      expect(signals.cwdChanges, `L-${seed} cwd changes`).toBeWithin(4, 13);
    }
    for (const seed of [21, 22, 23, 24]) {
      const signals = counts(seed, "M");
      expect(signals.gaps, `M-${seed} gaps`).toBeGreaterThanOrEqual(1);
      expect(signals.branches, `M-${seed} branches`).toBeGreaterThanOrEqual(1);
      expect(signals.cwdChanges, `M-${seed} cwd changes`).toBeGreaterThanOrEqual(1);
    }
  });

  test("L sessions segment into a bounded chapter skeleton", () => {
    for (const session of buildCorpus("gate").filter((candidate) => candidate.size === "L")) {
      const pieces = extractPieces(session.events, {}, {});
      const chapters = segmentChapters(session.events, pieces);
      expect(chapters.length, session.name).toBeWithin(8, 41);
      expect(chapters.every((chapter) => chapter.turns >= 8), session.name).toBe(true);
      expect(chapters.some((chapter) => chapter.boundary === "branch"), session.name).toBe(true);
      expect(chapters.some((chapter) => chapter.boundary === "cwd"), session.name).toBe(true);
      const starts = new Set(chapters.map((chapter) => chapter.startSeq));
      for (const expected of session.expectedBoundaries) expect(starts.has(expected.seq), `${session.name} ${expected.kind} at seq ${expected.seq}`).toBe(true);
    }
  });

  test("renderers retain cwd changes while branch metadata stays constant", () => {
    const plan = generateSessionPlan({ seed: 21, size: "M" });
    const ids = { sessionId: "cwd-calibration" };
    const ccTrace = renderClaudeCode(plan, ids);
    const codexTrace = renderCodex(plan, ids);
    let currentCwd = plan.cwd;
    let cwdChanges = 0;
    for (const [beatId, beat] of plan.beats.entries()) {
      const ccRange = ccTrace.beatSeqs.get(beatId)!;
      for (let seq = ccRange[0]; seq <= ccRange[1]; seq++) {
        const raw = JSON.parse(ccTrace.jsonl[seq]!) as Record<string, unknown>;
        if ("cwd" in raw) expect(raw.cwd, `CC beat ${beatId}`).toBe(currentCwd);
        if ("gitBranch" in raw) expect(raw.gitBranch, `CC beat ${beatId}`).toBe(plan.branch);
      }
      const codexRange = codexTrace.beatSeqs.get(beatId)!;
      if (beat.kind === "user" && !beat.systemInjected) {
        const raw = JSON.parse(codexTrace.jsonl[codexRange[0]]!) as any;
        expect(raw.payload.cwd, `Codex user beat ${beatId}`).toBe(currentCwd);
      } else if (beat.kind === "popup" && beat.answer != null) {
        const raw = JSON.parse(codexTrace.jsonl[codexRange[0] + 1]!) as any;
        expect(raw.payload.cwd, `Codex popup beat ${beatId}`).toBe(currentCwd);
      } else if (beat.kind === "tool" && beat.name !== "edit" && beat.name !== "write") {
        const raw = JSON.parse(codexTrace.jsonl[codexRange[0]]!) as any;
        expect(JSON.parse(raw.payload.arguments).workdir, `Codex tool beat ${beatId}`).toBe(currentCwd);
      }
      const changed = beat.kind === "tool" && beat.name === "shell" ? beat.input.command?.match(/^cd (services\/[^ ]+) && git status --short$/) : null;
      if (changed) { currentCwd = `${plan.cwd}/${changed[1]}`; cwdChanges++; }
    }
    expect(cwdChanges).toBeGreaterThanOrEqual(1);
    expect((JSON.parse(codexTrace.jsonl[0]!) as any).payload.git.branch).toBe(plan.branch);
  });

  test("rendered piece sizes reflect realistic tool output", () => {
    for (const session of buildCorpus("gate")) {
      const chars = extractPieces(session.events, {}, {}).reduce((sum, piece) => sum + piece.chars, 0);
      const range = session.size === "S" ? [60_000, 400_000] : session.size === "M" ? [800_000, 4_000_000] : [5_000_000, 12_000_000];
      expect(chars, `${session.name}: ${chars}`).toBeGreaterThanOrEqual(range[0]!);
      expect(chars, `${session.name}: ${chars}`).toBeLessThanOrEqual(range[1]!);
    }
  });

  test("reported beat ranges contain the text emitted by both real adapters", () => {
    const plan = generateSessionPlan({ seed: 11, size: "S" });
    const ids = { sessionId: "4f9a8c10-77aa-4d00-a111-000000000077" };
    const cases = [
      [renderClaudeCode(plan, ids), cc.parseFile(renderClaudeCode(plan, ids).jsonl.join("\n")), "claude-code"],
      [renderCodex(plan, ids), codex.parseFile(renderCodex(plan, ids).jsonl.join("\n")), "codex"],
    ] as const;
    for (const [rendered, parsed, tool] of cases) {
      const events = parsed.events.map((event, seq) => ({ ts: event.ts, tool, sessionId: ids.sessionId, seq, kind: event.kind, raw: event.raw } satisfies CarafeEvent));
      const pieces = extractPieces(events, {}, {});
      for (const [beatId, beat] of plan.beats.entries()) {
        const range = rendered.beatSeqs.get(beatId);
        if (!range || range[1] < range[0] || beat.kind === "gap" || beat.kind === "token" || beat.kind === "prlink") continue;
        const text = pieces.slice(range[0], range[1] + 1).flatMap((piece) => piece.lines).join("\n");
        const expected = beat.kind === "user" || beat.kind === "assistant" ? beat.text : beat.kind === "popup" ? beat.question : beat.kind === "tool" ? (beat.input.command ?? beat.input.path ?? beat.input.pattern ?? beat.input.newText ?? beat.input.content ?? beat.output) : "";
        expect([expected, expected.replaceAll('"', '\\"')].some((candidate) => text.includes(candidate)), `${tool} beat ${beatId}`).toBe(true);
      }
    }
  });

  test("every gold anchor is present in its adapter-derived window and redaction is clean", () => {
    for (const session of buildCorpus("gate")) {
      const hits: Record<string, number> = {};
      const pieces = extractPieces(session.events, {}, hits);
      expect(hits, session.name).toEqual({});
      for (const unit of session.gold.units) {
        const text = pieces.slice(unit.seq, unit.endSeq + 1).flatMap((piece) => piece.lines).join("\n");
        expect(text, `${session.name} ${unit.kind} ${unit.id}`).toContain(unit.anchor);
      }
    }
  });

  test("scoring uses inclusive boundaries, strict kind mapping, junk, hazards, and rendering", () => {
    const events: CarafeEvent[] = Array.from({ length: 14 }, (_, seq) => ({ ts: null, tool: "codex", sessionId: "score", seq, kind: "meta", raw: {} }));
    const d: SessionDistillate = { tool: "codex", sessionId: "score", sourcePath: "score.jsonl", title: "score", cwd: null, gitBranch: null, startTs: null, endTs: null, eventCount: events.length, toolUseCount: 0, sidechain: false, rawBytes: 0, version: 1 };
    const session = { name: "score", tool: "codex" as const, seed: 1, size: "S" as const, jsonl: [], events, distillate: d, expectedBoundaries: [], gold: { units: [{ id: "g1", kind: "goal" as const, beats: [0, 0] as [number, number], anchor: "goal", third: "early" as const, seq: 2, endSeq: 4 }, { id: "g2", kind: "deadend.reversal" as const, beats: [0, 0] as [number, number], anchor: "dead", third: "middle" as const, seq: 5, endSeq: 6 }, { id: "g3", kind: "decision.freetext" as const, beats: [0, 0] as [number, number], anchor: "decision", third: "late" as const, seq: 7, endSeq: 8 }], distractors: [{ id: "d1", kind: "quoted-error" as const, beats: [0, 0] as [number, number], hazard: true, seq: 9, endSeq: 10 }] } };
    const extractor = { id: "fixture", extract: () => ({ moments: [{ kind: "goal", seq: 2, text: "goal" }, { kind: "ask", seq: 6, text: "dead" }, { kind: "decision", seq: 8, text: "decision" }, { kind: "wip", seq: 9, text: "junk" }, { kind: "wip", seq: 12, text: "unplanted" }] }), render: () => "[seq 2] [seq 6] [seq 8] [seq 9]" };
    const score = scoreSession(session, extractor, 20_000);
    expect(score.strictHits).toBe(2);
    expect(score.anyHits).toBe(3);
    expect(score.renderedHits).toBe(3);
    expect(score.junk).toBe(1);
    expect(score.hazardViolations).toBe(1);
    expect(score.unplanted).toBe(1);
    expect(score.middleStrictHits).toBe(0);
    expect(score.lateStrictHits).toBe(1);
  });

  test("open extractor layers never import the benchmark", () => {
    const roots = [join(import.meta.dir, "..", "keymoments"), join(import.meta.dir, "..", "handoff")];
    const files: string[] = [];
    const walk = (dir: string): void => { for (const name of readdirSync(dir)) { const p = join(dir, name); if (statSync(p).isDirectory()) walk(p); else if (p.endsWith(".ts")) files.push(p); } };
    roots.forEach(walk);
    for (const file of files) expect(readFileSync(file, "utf8"), file).not.toMatch(/from ["'][^"']*bench/);
  });

  test("every registered extractor matches its committed gate counts", async () => {
    const baseline = readBaseline();
    for (const extractor of Object.keys(EXTRACTORS)) {
      const card = await runBench({ tier: "gate", extractor });
      const expectedExtractor = baseline[extractor];
      expect(expectedExtractor, `${extractor} has no committed baseline`).toBeDefined();
      for (const [tool, expected] of Object.entries(expectedExtractor ?? {})) {
        const current = card.tools[tool]!;
        for (const [metric, value] of Object.entries(expected)) expect(current[metric as keyof typeof current], `${extractor}.${tool}.${metric}: baseline ${value}, current ${String(current[metric as keyof typeof current])}; run --update-baseline if intended`).toBe(value);
      }
    }
  });
});
