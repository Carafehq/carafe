import { readFileSync } from "fs";
import { join } from "path";
import { atomicWriteFileSync } from "../../format/store";
import { buildCorpus, corpusHash, type CorpusTier } from "../corpus";
import { scoreProjectReflexSessions, scoreReflexSessions, type ReflexToolScore } from "./score";

export interface ReflexScorecard { tier: CorpusTier; corpus: string; sessions: number; runtimeMs: number; tools: Record<string, ReflexToolScore> }
export interface ReflexBenchOptions { tier?: CorpusTier; updateBaseline?: boolean }

const BASELINE = join(import.meta.dir, "baseline.json");
const pct = (value: number): string => `${(value * 100).toFixed(1)}%`;

export function runReflexBench(opts: ReflexBenchOptions = {}): ReflexScorecard {
  const tier = opts.tier ?? "gate";
  const started = performance.now();
  const sessions = buildCorpus(tier);
  const tools: Record<string, ReflexToolScore> = {};
  for (const tool of ["claude-code", "codex"] as const) {
    tools[tool] = scoreReflexSessions(sessions.filter((session) => session.tool === tool), tool);
    tools[`${tool} project`] = scoreProjectReflexSessions(sessions, tool);
  }
  const card = { tier, corpus: corpusHash(tier), sessions: sessions.length, runtimeMs: performance.now() - started, tools };
  if (opts.updateBaseline) {
    if (tier !== "gate") throw new Error("--update-baseline is only valid for the gate tier");
    atomicWriteFileSync(BASELINE, JSON.stringify(reflexBaselineCounts(card), null, 2) + "\n");
  }
  return card;
}

export function formatReflexScorecard(card: ReflexScorecard, opts: { misses?: boolean } = {}): string {
  const lines = [`# ReflexBench · tier ${card.tier} · corpus ${card.corpus.slice(0, 8)} · ${card.sessions} sessions`, "", "| tool | should fire | know-to-ask failures | stay silent | false fires | push precision strict / related | push recall | intrusion | suppression | mean / max ms |", "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |"];
  for (const score of Object.values(card.tools)) lines.push(`| ${score.tool} | ${score.shouldFire} | ${score.knowToAskFailures} | ${score.silentTurns} | ${score.falseFires} | ${pct(score.pushPrecision)} / ${pct(score.pushPrecisionRelated)} | ${pct(score.pushRecall)} | ${score.intrusionChars.toFixed(1)} chars | ${score.suppressionPassed}/${score.suppressionTotal} | ${score.meanRuntimeMs.toFixed(2)} / ${score.maxRuntimeMs.toFixed(2)} |`);
  const reasons = [...new Set(Object.values(card.tools).flatMap((score) => Object.keys(score.failuresByReason)))].sort();
  if (reasons.length) {
    lines.push("", "## Know-to-ask failures by planted reason", "", "| reason | claude-code | codex |", "| --- | ---: | ---: |");
    for (const reason of reasons) lines.push(`| ${reason} | ${card.tools["claude-code"]?.failuresByReason[reason] ?? 0} | ${card.tools.codex?.failuresByReason[reason] ?? 0} |`);
  }
  if (opts.misses) {
    const windows = (items: Array<{ seq: number; endSeq: number }>): string => items.map((window) => `[${window.seq}–${window.endSeq}]`).join(" ");
    for (const score of Object.values(card.tools)) {
      lines.push("", `## ${score.tool}: know-to-ask failures`, "");
      if (!score.diagnostics.misses.length) lines.push("(none)");
      for (const miss of score.diagnostics.misses) {
        lines.push(`- ${miss.session} · ${miss.reason} · ${JSON.stringify(miss.text)} · expected ${windows(miss.expected)} · ${miss.emitted.length ? `emitted instead: ${miss.emitted.map((line) => JSON.stringify(line)).join("; ")}` : `silent (${miss.silentReason ?? "no reason"})`}`);
      }
      lines.push("", `## ${score.tool}: false fires`, "");
      if (!score.diagnostics.falseFires.length) lines.push("(none)");
      for (const fire of score.diagnostics.falseFires) lines.push(`- ${fire.session} · ${fire.reason} · ${JSON.stringify(fire.text)} · emitted: ${fire.emitted.map((line) => JSON.stringify(line)).join("; ")}`);
    }
  }
  return lines.join("\n") + "\n";
}

export function reflexScorecardJSON(card: ReflexScorecard): string { return JSON.stringify(card, null, 2) + "\n"; }

export function reflexBaselineCounts(card: ReflexScorecard): Record<string, Record<string, number>> {
  const keys = ["shouldFire", "correctTurns", "knowToAskFailures", "silentTurns", "falseFires", "emitted", "correctEmitted", "suppressionPassed", "suppressionTotal"] as const;
  return Object.fromEntries(Object.entries(card.tools).map(([tool, score]) => [tool, Object.fromEntries(keys.map((key) => [key, score[key]]))]));
}

export function readReflexBaseline(): Record<string, Record<string, number>> {
  return JSON.parse(readFileSync(BASELINE, "utf8")) as Record<string, Record<string, number>>;
}
