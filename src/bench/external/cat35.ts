/**
 * gbrain-evals Cat 35 ("transcript distillation") corpus through carafe, scored on its
 * mechanical lane only: does each planted unit's verbatim anchor survive into what carafe
 * renders? The corpus (MIT, github.com/garrytan/gbrain-evals, eval/data/transcript-
 * distill-v1) is fetched by the user; this code reads a local directory and never touches
 * the network or a model. Their transcripts are Claude Code jsonl, so the real adapter
 * parses them unchanged.
 */
import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import * as cc from "../../adapters/claude-code";
import type { CarafeEvent } from "../../format/events";
import type { SessionDistillate } from "../../format/distillate";
import { extractPieces } from "../../handoff/pieces";
import { HANDOFF_BUDGET_CHARS } from "../../handoff/render";
import { segmentChapters } from "../../keymoments/chapters";
import { extractMoments } from "../../keymoments/detect";
import { renderResumeBlock } from "../../keymoments/render";

export interface Cat35Gold {
  transcript_id: string; scenario: string; session_id?: string;
  items: Array<{ item_id: string; kind: string; statement: string; verbatim_anchor: string; planted_turn: number; depth_bucket: string; notability?: string }>;
  distractors: Array<{ distractor_id: string; statement?: string; anchor: string; planted_turn: number }>;
  hazards?: Array<{ hazard_id: string; type: string; wrong_claim: string; anchor: string; planted_turn: number }>;
}

interface Bucket { n: number; anchor: Record<number, number> }
export interface Cat35Score {
  sessions: number; items: number; distractors: number; fullTier: number; minChars: number; maxChars: number;
  candidateAnchor: number; candidateTurn: number; findingMoments: number;
  byBudget: Record<number, { anchor: number; turn: number; junk: number; wrongClaims: number }>;
  byKind: Record<string, Bucket & { turn: number }>; byScenario: Record<string, Bucket>; byDepth: Record<string, Bucket>;
}

export const CAT35_DEFAULT_BUDGETS = [20_000, 4_000, 1_500];

export function normalizeQuote(s: string): string {
  return s.toLowerCase().replace(/[’‘]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, " ").trim();
}

function transcriptId(file: string): string {
  return file.replace(/^\d{4}-\d{2}-\d{2}-/, "").replace(/\.jsonl$/, "");
}

/** Score one transcript (jsonl text) against its gold. Exported for tests and adapters. */
export function scoreCat35Session(text: string, gold: Cat35Gold, id: string, budgets = CAT35_DEFAULT_BUDGETS): { chars: number; fullTier: boolean; candidateAnchor: number; candidateTurn: number; findingMoments: number; perBudget: Record<number, { anchor: number; turn: number; junk: number; wrongClaims: number }>; perItem: Array<{ item_id: string; kind: string; depth: string; anchor: Record<number, boolean>; covered: boolean }> } {
  const parsed = cc.parseFile(text);
  const events: CarafeEvent[] = parsed.events.map((e, seq) => ({ ts: e.ts, tool: "claude-code", sessionId: id, seq, kind: e.kind, sidechain: e.sidechain, raw: e.raw }));
  const pieces = extractPieces(events, {}, {});
  const chars = pieces.reduce((a, p) => a + p.chars, 0);
  const d: SessionDistillate = { tool: "claude-code", sessionId: id, sourcePath: `${id}.jsonl`, title: id, cwd: null, gitBranch: null, startTs: events[0]?.ts ?? null, endTs: events.at(-1)?.ts ?? null, eventCount: events.length, toolUseCount: parsed.toolUseCount, sidechain: false, rawBytes: text.length, version: 1 };
  const set = extractMoments({ events, pieces });
  const chapters = segmentChapters(events, pieces, {}, set.moments);
  const candidateText = normalizeQuote(set.moments.map((m) => `${m.text}\n${m.note ?? ""}`).join("\n"));
  const rendered: Record<number, string> = {};
  for (const b of budgets) rendered[b] = normalizeQuote(renderResumeBlock(d, set, { budgetChars: b, chapters }).text);
  const perBudget: Record<number, { anchor: number; turn: number; junk: number; wrongClaims: number }> = {};
  for (const b of budgets) perBudget[b] = { anchor: 0, turn: 0, junk: 0, wrongClaims: 0 };
  let candidateAnchor = 0, candidateTurn = 0;
  const perItem: Array<{ item_id: string; kind: string; depth: string; anchor: Record<number, boolean>; covered: boolean }> = [];
  for (const item of gold.items) {
    const anchor = normalizeQuote(item.verbatim_anchor);
    const covered = set.moments.some((m) => m.seq <= item.planted_turn && (m.endSeq ?? m.seq) >= item.planted_turn);
    if (candidateText.includes(anchor)) candidateAnchor++;
    if (covered) candidateTurn++;
    const row = { item_id: item.item_id, kind: item.kind, depth: item.depth_bucket, anchor: {} as Record<number, boolean>, covered };
    for (const b of budgets) {
      const hit = rendered[b]!.includes(anchor);
      row.anchor[b] = hit;
      if (hit) perBudget[b]!.anchor++;
      const seqs = [...rendered[b]!.matchAll(/\[seq (\d+)(?:-(\d+))?\]/g)].map((m) => [Number(m[1]), Number(m[2] ?? m[1])] as const);
      if (seqs.some(([a, z]) => a <= item.planted_turn && z >= item.planted_turn)) perBudget[b]!.turn++;
    }
    perItem.push(row);
  }
  for (const dis of gold.distractors ?? []) for (const b of budgets) if (rendered[b]!.includes(normalizeQuote(dis.anchor))) perBudget[b]!.junk++;
  for (const hz of gold.hazards ?? []) for (const b of budgets) if (rendered[b]!.includes(normalizeQuote(hz.wrong_claim))) perBudget[b]!.wrongClaims++;
  return { chars, fullTier: chars <= HANDOFF_BUDGET_CHARS, candidateAnchor, candidateTurn, findingMoments: set.moments.filter((moment) => moment.kind === "finding").length, perBudget, perItem };
}

export function runCat35(dir: string, budgets = CAT35_DEFAULT_BUDGETS): Cat35Score {
  const score: Cat35Score = { sessions: 0, items: 0, distractors: 0, fullTier: 0, minChars: Number.POSITIVE_INFINITY, maxChars: 0, candidateAnchor: 0, candidateTurn: 0, findingMoments: 0, byBudget: {}, byKind: {}, byScenario: {}, byDepth: {} };
  for (const b of budgets) score.byBudget[b] = { anchor: 0, turn: 0, junk: 0, wrongClaims: 0 };
  for (const file of readdirSync(join(dir, "transcripts")).filter((f) => f.endsWith(".jsonl")).sort()) {
    const id = transcriptId(file);
    const gold = JSON.parse(readFileSync(join(dir, "gold", `${id}.json`), "utf8")) as Cat35Gold;
    const text = readFileSync(join(dir, "transcripts", file), "utf8");
    const result = scoreCat35Session(text, gold, id, budgets);
    score.sessions++; score.items += gold.items.length; score.distractors += (gold.distractors ?? []).length;
    if (result.fullTier) score.fullTier++;
    score.minChars = Math.min(score.minChars, result.chars); score.maxChars = Math.max(score.maxChars, result.chars);
    score.candidateAnchor += result.candidateAnchor; score.candidateTurn += result.candidateTurn; score.findingMoments += result.findingMoments;
    for (const b of budgets) { const t = score.byBudget[b]!; const r = result.perBudget[b]!; t.anchor += r.anchor; t.turn += r.turn; t.junk += r.junk; t.wrongClaims += r.wrongClaims; }
    for (const row of result.perItem) {
      const k = score.byKind[row.kind] ??= { n: 0, anchor: {}, turn: 0 }; k.n++; if (row.covered) k.turn++;
      const s = score.byScenario[gold.scenario] ??= { n: 0, anchor: {} }; s.n++;
      const dp = score.byDepth[row.depth] ??= { n: 0, anchor: {} }; dp.n++;
      for (const b of budgets) if (row.anchor[b]) { k.anchor[b] = (k.anchor[b] ?? 0) + 1; s.anchor[b] = (s.anchor[b] ?? 0) + 1; dp.anchor[b] = (dp.anchor[b] ?? 0) + 1; }
    }
  }
  if (!Number.isFinite(score.minChars)) score.minChars = 0;
  return score;
}

const pct = (a: number, b: number): string => `${a}/${b} (${b ? ((100 * a) / b).toFixed(1) : "0.0"}%)`;

export function formatCat35(score: Cat35Score, budgets = CAT35_DEFAULT_BUDGETS): string {
  const lines = [
    `# gbrain Cat 35 corpus through carafe — mechanical anchor lane`, ``,
    `sessions ${score.sessions} · planted units ${score.items} · distractors ${score.distractors} · rendered chars per session ${score.minChars}–${score.maxChars} · sessions fitting the FULL handoff tier verbatim: ${score.fullTier}/${score.sessions}`, ``,
    `candidate moments (pre-budget): anchor present ${pct(score.candidateAnchor, score.items)} · planted turn covered by a moment ${pct(score.candidateTurn, score.items)} · findings emitted ${score.findingMoments}`, ``,
    `| resume-block budget | anchor survives verbatim | planted turn cited | distractor anchors leaked | wrong claims |`, `| --- | --- | --- | --- | --- |`,
  ];
  for (const b of budgets) lines.push(`| ${b} chars | ${pct(score.byBudget[b]!.anchor, score.items)} | ${pct(score.byBudget[b]!.turn, score.items)} | ${pct(score.byBudget[b]!.junk, score.distractors)} | ${score.byBudget[b]!.wrongClaims} |`);
  const head = budgets.map((b) => `@${b}`).join(" | ");
  lines.push(``, `| kind | n | ${head} | turn covered (pre-budget) |`, `| --- | ---: | ${budgets.map(() => "---").join(" | ")} | --- |`);
  for (const [kind, k] of Object.entries(score.byKind).sort()) lines.push(`| ${kind} | ${k.n} | ${budgets.map((b) => pct(k.anchor[b] ?? 0, k.n)).join(" | ")} | ${pct(k.turn, k.n)} |`);
  lines.push(``, `| scenario | n | ${head} |`, `| --- | ---: | ${budgets.map(() => "---").join(" | ")} |`);
  for (const [sc, s] of Object.entries(score.byScenario).sort()) lines.push(`| ${sc} | ${s.n} | ${budgets.map((b) => pct(s.anchor[b] ?? 0, s.n)).join(" | ")} |`);
  lines.push(``, `| depth | n | ${head} |`, `| --- | ---: | ${budgets.map(() => "---").join(" | ")} |`);
  for (const [dp, s] of Object.entries(score.byDepth).sort()) lines.push(`| ${dp} | ${s.n} | ${budgets.map((b) => pct(s.anchor[b] ?? 0, s.n)).join(" | ")} |`);
  return lines.join("\n") + "\n";
}
