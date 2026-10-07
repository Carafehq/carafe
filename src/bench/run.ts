import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { buildCorpus, corpusHash, materialize, type BenchSession, type CorpusTier } from "./corpus";
import { EXTRACTORS } from "./extractors";
import { aggregateScores, diagnoseSession, scoreSession, type AggregateScore, type CountRate, type DistractorHitDiagnostic, type MissedUnitDiagnostic } from "./score";

export interface Scorecard {
  extractor: string; tier: CorpusTier; corpus: string; sessions: number; runtimeMs: number;
  tools: Record<string, AggregateScore>;
  diagnostics?: { misses: MissedUnitDiagnostic[]; distractorHits: DistractorHitDiagnostic[] };
}
export interface RunBenchOptions {
  tier?: CorpusTier; extractor?: string; out?: string; json?: boolean; updateBaseline?: boolean; materialize?: string; misses?: boolean;
}

const HERE = import.meta.dir;
const pct = (n: CountRate): string => `${n.count}/${n.total} (${(n.rate * 100).toFixed(1)}%)`;
const count = (n: number, total: number): string => `${n}/${total}`;

export function formatScorecard(card: Scorecard): string {
  const tools = Object.values(card.tools);
  const lines = [`# MomentsBench · extractor ${card.extractor} · tier ${card.tier} · corpus ${card.corpus.slice(0, 8)} · ${card.sessions} sessions`, ``, `| tool | units | strict R | any R | rendered R | early / middle / late | junk | hazards | verbatim | moments/session | chapters/session | chapter coverage | rendered by third | ms |`, `| --- | ---: | --- | --- | --- | --- | ---: | ---: | --- | ---: | ---: | --- | --- | ---: |`];
  for (const s of tools) lines.push(`| ${s.tool} | ${s.units} | ${pct(s.recallStrict)} | ${pct(s.recallAny)} | ${pct(s.renderedRecall)} | ${pct(s.earlyRecallStrict)} / ${pct(s.middleRecallStrict)} / ${pct(s.lateRecallStrict)} | ${s.junk} | ${s.hazardViolations} | ${pct(s.verbatimFidelity)} | ${s.momentsPerSession.toFixed(1)} | ${s.chaptersPerSession.toFixed(1)} | ${pct(s.chapterCoverage)} | ${s.renderedByThird.early} / ${s.renderedByThird.middle} / ${s.renderedByThird.late} | ${card.runtimeMs.toFixed(1)} |`);
  lines.push(``, `## Per kind (strict / any / rendered)`, ``, `| kind | claude-code | codex |`, `| --- | --- | --- |`);
  const kinds = [...new Set(tools.flatMap((s) => Object.keys(s.perKind)))].sort();
  for (const kind of kinds) {
    const cc = card.tools["claude-code"]?.perKind[kind]; const codex = card.tools.codex?.perKind[kind];
    const f = (k: typeof cc): string => k ? `${pct(k.strict)} / ${pct(k.any)} / ${pct(k.rendered)}` : "0/0 (0.0%) / 0/0 (0.0%) / 0/0 (0.0%)";
    lines.push(`| ${kind} | ${f(cc)} | ${f(codex)} |`);
  }
  lines.push(``, `## Distractors hit`, ``, `| distractor | claude-code | codex |`, `| --- | ---: | ---: |`);
  const distractors = [...new Set(tools.flatMap((s) => Object.keys(s.distractorHits)))].sort();
  for (const kind of distractors) lines.push(`| ${kind} | ${card.tools["claude-code"]?.distractorHits[kind] ?? 0} | ${card.tools.codex?.distractorHits[kind] ?? 0} |`);
  if (card.diagnostics) {
    lines.push(``, `## Missed planted units`, ``);
    if (!card.diagnostics.misses.length) lines.push(`(none)`);
    for (const miss of card.diagnostics.misses) {
      const wrong = miss.wrongKindMoments.length
        ? miss.wrongKindMoments.map((moment) => `${moment.kind} [${moment.seq}${moment.endSeq == null ? "" : `–${moment.endSeq}`}] ${JSON.stringify(moment.text)}`).join(`; `)
        : `none`;
      lines.push(`- ${miss.session} · ${miss.kind} · [${miss.seq}–${miss.endSeq}] · anchor ${JSON.stringify(miss.anchor)} · wrong-kind moments: ${wrong}`);
    }
    lines.push(``, `## Distractor hits`, ``);
    if (!card.diagnostics.distractorHits.length) lines.push(`(none)`);
    for (const hit of card.diagnostics.distractorHits) {
      const moments = hit.moments.map((moment) => `${moment.kind} [${moment.seq}${moment.endSeq == null ? "" : `–${moment.endSeq}`}] ${JSON.stringify(moment.text)}`).join(`; `);
      lines.push(`- ${hit.session} · ${hit.kind} (${hit.id}) · [${hit.seq}–${hit.endSeq}] · moments: ${moments}`);
    }
  }
  return lines.join("\n") + "\n";
}

function baselineData(card: Scorecard): Record<string, Record<string, number>> {
  const gated = ["strictHits", "anyHits", "renderedHits", "middleStrictHits", "junk", "hazardViolations", "verbatimHits"];
  const out: Record<string, Record<string, number>> = {};
  for (const [tool, score] of Object.entries(card.tools)) {
    out[tool] = {};
    for (const key of gated) out[tool]![key] = score[key as keyof AggregateScore] as number;
  }
  return out;
}

function updateBaseline(card: Scorecard): void {
  let existing: Record<string, Record<string, Record<string, number>>> = {};
  try {
    const raw = JSON.parse(readFileSync(join(HERE, "baseline.json"), "utf8")) as Record<string, unknown>;
    existing = "v1" in raw ? raw as typeof existing : { v1: raw as Record<string, Record<string, number>> };
  } catch { /* first baseline */ }
  existing[card.extractor] = baselineData(card);
  writeFileSync(join(HERE, "baseline.json"), JSON.stringify(existing, null, 2) + "\n");
  writeFileSync(join(HERE, "gold", "gate.hash"), `${corpusHash("gate")}\n`);
}

export async function runBench(opts: RunBenchOptions = {}): Promise<Scorecard> {
  const tier = opts.tier ?? "gate";
  const extractorId = opts.extractor ?? "v2";
  const extractor = EXTRACTORS[extractorId];
  if (!extractor) throw new Error(`unknown moments extractor: ${extractorId}`);
  const t0 = performance.now();
  const sessions = buildCorpus(tier);
  const byTool = new Map<string, ReturnType<typeof scoreSession>[]>();
  for (const session of sessions) {
    const score = scoreSession(session, extractor, 20_000);
    (byTool.get(session.tool) ?? (byTool.set(session.tool, []), byTool.get(session.tool)!)).push(score);
  }
  const tools: Record<string, AggregateScore> = {};
  for (const [tool, scores] of byTool) tools[tool] = aggregateScores(scores, tool);
  const diagnostics = opts.misses
    ? sessions.map((session) => diagnoseSession(session, extractor)).reduce((out, item) => ({ misses: [...out.misses, ...item.misses], distractorHits: [...out.distractorHits, ...item.distractorHits] }), { misses: [] as MissedUnitDiagnostic[], distractorHits: [] as DistractorHitDiagnostic[] })
    : undefined;
  const card: Scorecard = { extractor: extractorId, tier, corpus: corpusHash(tier), sessions: sessions.length, runtimeMs: performance.now() - t0, tools, ...(diagnostics ? { diagnostics } : {}) };
  if (opts.materialize) materialize(tier, opts.materialize);
  if (opts.updateBaseline) {
    if (tier !== "gate") throw new Error("--update-baseline is only valid for the gate tier");
    updateBaseline(card);
  }
  const output = opts.json ? JSON.stringify(card, null, 2) + "\n" : formatScorecard(card);
  if (opts.out) writeFileSync(opts.out, output);
  return card;
}

export function toJSON(card: Scorecard): string { return JSON.stringify(card, null, 2) + "\n"; }
export function readBaseline(): Record<string, Record<string, Record<string, number>>> {
  const raw = JSON.parse(readFileSync(join(HERE, "baseline.json"), "utf8")) as Record<string, unknown>;
  return "v1" in raw ? raw as Record<string, Record<string, Record<string, number>>> : { v1: raw as Record<string, Record<string, number>> };
}
export function sessionEventCounts(sessions: BenchSession[]): string[] { return sessions.map((s) => `${s.name}: ${s.events.length}`); }
