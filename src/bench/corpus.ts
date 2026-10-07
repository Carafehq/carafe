import { createHash } from "crypto";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import * as cc from "../adapters/claude-code";
import * as codex from "../adapters/codex";
import { deriveTitle, type ParsedSession } from "../adapters/types";
import type { CarafeEvent } from "../format/events";
import type { SessionDistillate } from "../format/distillate";
import { USAGE_VERSION } from "../query/usage";
import { generateSessionPlan } from "./generate";
import { renderClaudeCode, type RenderIds } from "./render-cc";
import { renderCodex } from "./render-codex";
import type { Distractor, GoldUnit, Size } from "./plan";

export type CorpusTier = "gate" | "full";
export interface RenderedGoldUnit extends GoldUnit { seq: number; endSeq: number; }
export interface RenderedDistractor extends Distractor { seq: number; endSeq: number; }
export interface RenderedGold { units: RenderedGoldUnit[]; distractors: RenderedDistractor[]; }
export interface BenchSession {
  name: string;
  tool: "claude-code" | "codex";
  seed: number;
  size: Size;
  jsonl: string[];
  events: CarafeEvent[];
  distillate: SessionDistillate;
  gold: RenderedGold;
  expectedBoundaries: Array<{ kind: "gap" | "branch" | "cwd"; seq: number }>;
}

const TIER_SEEDS: Record<CorpusTier, Array<[number, Size]>> = {
  gate: [[11, "S"], [12, "S"], [21, "M"], [22, "M"], [31, "L"]],
  full: [[11, "S"], [12, "S"], [13, "S"], [14, "S"], [15, "S"], [21, "M"], [22, "M"], [23, "M"], [24, "M"], [31, "L"], [32, "L"]],
};
const cache = new Map<CorpusTier, BenchSession[]>();

function sessionId(seed: number): string {
  const n = (seed * 2654435761) >>> 0;
  const h = `${n.toString(16).padStart(8, "0")}${((n ^ 0xa5a5a5a5) >>> 0).toString(16).padStart(8, "0")}${((n ^ 0x5a5a5a5a) >>> 0).toString(16).padStart(8, "0")}${((n + 0x12345678) >>> 0).toString(16).padStart(8, "0")}`;
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

function parseAndBuild(text: string, tool: "claude-code" | "codex", sid: string, planName: string, plan: ReturnType<typeof generateSessionPlan>, parsed: ParsedSession, sourcePath: string): { events: CarafeEvent[]; distillate: SessionDistillate } {
  const events = parsed.events.map((event, seq) => ({ ts: event.ts, tool, sessionId: sid, seq, kind: event.kind, sidechain: event.sidechain, raw: event.raw } satisfies CarafeEvent));
  const title = parsed.titleUpdates.length ? parsed.titleUpdates.slice().sort((a, b) => b.priority - a.priority).at(0)?.title ?? parsed.firstUserText : parsed.firstUserText;
  const d: SessionDistillate = {
    tool, sessionId: sid, internalSessionId: parsed.internalSessionId !== sid ? parsed.internalSessionId : undefined,
    sourcePath, title: title ? deriveTitle(title) : plan.title, cwd: parsed.cwd, gitBranch: parsed.gitBranch,
    startTs: events.find((e) => e.ts)?.ts ?? null, endTs: [...events].reverse().find((e) => e.ts)?.ts ?? null,
    eventCount: events.length, toolUseCount: parsed.toolUseCount, sidechain: parsed.sidechain,
    codexCalls: parsed.codexCalls.length ? parsed.codexCalls : undefined, originator: parsed.originator ?? undefined,
    sourceKind: parsed.sourceKind ?? undefined, usage: Object.keys(parsed.usageByModel).length ? parsed.usageByModel : undefined, usageV: USAGE_VERSION,
    rawBytes: Buffer.byteLength(text), version: 1,
  };
  return { events, distillate: d };
}

function renderGold(plan: ReturnType<typeof generateSessionPlan>, beatSeqs: Map<number, [number, number]>): RenderedGold {
  const map = <T extends { beats: [number, number] }>(items: T[]): Array<T & { seq: number; endSeq: number }> => items.flatMap((item) => {
    const range = beatSeqs.get(item.beats[0]);
    const end = beatSeqs.get(item.beats[1]);
    return range && end ? [{ ...item, seq: range[0], endSeq: end[1] }] : [];
  });
  return { units: map(plan.gold), distractors: map(plan.distractors) };
}

export function buildCorpus(tier: CorpusTier): BenchSession[] {
  const existing = cache.get(tier);
  if (existing) return existing;
  const out: BenchSession[] = [];
  for (const [seed, size] of TIER_SEEDS[tier]) {
    const plan = generateSessionPlan({ seed, size });
    const sid = sessionId(seed);
    const ids: RenderIds = { sessionId: sid };
    const ccTrace = renderClaudeCode(plan, ids);
    const codexTrace = renderCodex(plan, ids);
    const ccParsed = cc.parseFile(ccTrace.jsonl.join("\n"));
    const codexParsed = codex.parseFile(codexTrace.jsonl.join("\n"));
    const ccBuilt = parseAndBuild(ccTrace.jsonl.join("\n"), "claude-code", sid, "claude-code", plan, ccParsed, `claude/projects/${plan.cwd.replaceAll("/", "-")}/${sid}.jsonl`);
    const codexBuilt = parseAndBuild(codexTrace.jsonl.join("\n"), "codex", sid, "codex", plan, codexParsed, `codex/sessions/${plan.startTs.slice(0, 4)}/${plan.startTs.slice(5, 7)}/${plan.startTs.slice(8, 10)}/rollout-${plan.startTs.replaceAll(":", "-").replace(".000Z", "")}-${sid}.jsonl`);
    const boundaries = (trace: typeof ccTrace, events: CarafeEvent[]) => plan.expectedBoundaries.flatMap((expected) => {
      const range = trace.beatSeqs.get(expected.beat);
      if (!range) return [];
      const user = events.slice(range[0], range[1] + 1).find((event) => event.kind === "user");
      return user ? [{ kind: expected.kind, seq: user.seq }] : [];
    });
    out.push({ name: `${size}-${seed}-claude-code`, tool: "claude-code", seed, size, jsonl: ccTrace.jsonl, ...ccBuilt, gold: renderGold(plan, ccTrace.beatSeqs), expectedBoundaries: boundaries(ccTrace, ccBuilt.events) });
    out.push({ name: `${size}-${seed}-codex`, tool: "codex", seed, size, jsonl: codexTrace.jsonl, ...codexBuilt, gold: renderGold(plan, codexTrace.beatSeqs), expectedBoundaries: boundaries(codexTrace, codexBuilt.events) });
  }
  cache.set(tier, out);
  return out;
}

export function corpusHash(tier: CorpusTier): string {
  const hash = createHash("sha256");
  for (const session of buildCorpus(tier)) hash.update(session.jsonl.join("\n")).update("\n").update(JSON.stringify(session.gold)).update("\n");
  return hash.digest("hex");
}

export function materialize(tier: CorpusTier, dir: string): void {
  for (const session of buildCorpus(tier)) {
    const p = session.tool === "claude-code"
      ? join(dir, "claude", "projects", session.distillate.cwd!.replaceAll("/", "-"), `${session.distillate.sessionId}.jsonl`)
      : join(dir, "codex", "sessions", session.distillate.startTs!.slice(0, 4), session.distillate.startTs!.slice(5, 7), session.distillate.startTs!.slice(8, 10), `rollout-${session.distillate.startTs!.replaceAll(":", "-").replace(".000Z", "")}-${session.distillate.sessionId}.jsonl`);
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, session.jsonl.join("\n") + "\n");
  }
}

export function corpusSeeds(tier: CorpusTier): Array<[number, Size]> { return [...TIER_SEEDS[tier]]; }
