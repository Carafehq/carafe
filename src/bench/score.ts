import type { ExtractedMoment, ExtractorInput, MomentsExtractor } from "./extractors";
import type { BenchSession, RenderedGoldUnit, RenderedDistractor } from "./corpus";
import type { GoldKind } from "./plan";
import { segmentChapters } from "../keymoments/chapters";

export interface CountRate { count: number; total: number; rate: number; }
export interface KindScore { strict: CountRate; any: CountRate; rendered: CountRate; }
export interface SessionScore {
  session: string; tool: string; seed: number; size: string;
  units: number; strictHits: number; anyHits: number; renderedHits: number;
  middleStrictHits: number; middleUnits: number; earlyStrictHits: number; earlyUnits: number; lateStrictHits: number; lateUnits: number;
  verbatimHits: number; moments: number; junk: number; hazardViolations: number; unplanted: number;
  chapters: number; coveredChapters: number; renderedByThird: { early: number; middle: number; late: number };
  distractorHits: Record<string, number>; perKind: Record<string, KindScore>;
}
export interface AggregateScore {
  tool: string; sessions: number; units: number; strictHits: number; anyHits: number; renderedHits: number;
  middleStrictHits: number; middleUnits: number; earlyStrictHits: number; earlyUnits: number; lateStrictHits: number; lateUnits: number;
  verbatimHits: number; moments: number; junk: number; hazardViolations: number; unplanted: number;
  perKind: Record<string, KindScore>; distractorHits: Record<string, number>;
  chaptersPerSession: number; chapterCoverage: CountRate; renderedByThird: { early: number; middle: number; late: number };
  recallStrict: CountRate; recallAny: CountRate; renderedRecall: CountRate; middleRecallStrict: CountRate; earlyRecallStrict: CountRate; lateRecallStrict: CountRate;
  verbatimFidelity: CountRate; junkRate: CountRate; unplantedRate: CountRate; momentsPerSession: number;
}
export interface MissedUnitDiagnostic {
  session: string; tool: string; kind: string; seq: number; endSeq: number; anchor: string;
  wrongKindMoments: Array<{ kind: string; seq: number; endSeq?: number; text: string }>;
}
export interface DistractorHitDiagnostic {
  session: string; tool: string; id: string; kind: string; seq: number; endSeq: number;
  moments: Array<{ kind: string; seq: number; endSeq?: number; text: string }>;
}

const strictKinds: Record<GoldKind, string[]> = {
  goal: ["goal"], "decision.popup": ["decision"], "decision.freetext": ["decision"], "decision.approval": ["decision"], steering: ["ask"],
  "deadend.reversal": ["deadend"], "deadend.abandoned": ["deadend"], "deadend.notrace": ["deadend"], breakthrough: ["breakthrough"], rule: ["rule"],
  "artifact.commit": ["artifact"], "artifact.pr": ["artifact"], wip: ["wip"],
};
export function acceptableMomentKinds(kind: GoldKind): string[] { return strictKinds[kind] ?? []; }
function rate(count: number, total: number): CountRate { return { count, total, rate: total ? count / total : 0 }; }
function collapse(s: string): string { return s.replace(/^\s*(?:\*\*(?:user|assistant):\*\*|→ \*\*[^*]+\*\*|⤷)\s*/i, "").replace(/\s+/g, " ").trim(); }
function containsAnchor(moment: ExtractedMoment, anchor: string): boolean { return collapse(`${moment.text} ${moment.note ?? ""}`).includes(collapse(anchor)); }
function lands(moment: ExtractedMoment, start: number, end: number): boolean { return moment.seq >= start && moment.seq <= end; }
function landsOnUnit(moment: ExtractedMoment, unit: RenderedGoldUnit): boolean {
  return unit.kind === "rule"
    ? moment.seq <= unit.endSeq && (moment.endSeq ?? moment.seq) >= unit.seq
    : lands(moment, unit.seq, unit.endSeq);
}
export function renderedSeqs(rendered: string): Set<number> {
  const out = new Set<number>();
  const re = /\[seq\s+(\d+)(?:-(\d+))?\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(rendered)) !== null) {
    const a = Number(m[1]); const b = Number(m[2] ?? m[1]);
    for (let i = a; i <= b; i++) out.add(i);
  }
  return out;
}
function kindMap(): Record<string, KindScore> { return {}; }

export function diagnoseSession(session: BenchSession, extractor: MomentsExtractor): { misses: MissedUnitDiagnostic[]; distractorHits: DistractorHitDiagnostic[] } {
  const pieces = awaitlessExtractPieces(session.events, {}, {});
  const input: ExtractorInput = { events: session.events, pieces, distillate: session.distillate };
  const moments = extractor.extract(input).moments;
  const misses = session.gold.units.flatMap((unit) => {
    const inWindow = moments.filter((moment) => landsOnUnit(moment, unit));
    if (inWindow.some((moment) => acceptableMomentKinds(unit.kind).includes(moment.kind))) return [];
    return [{
      session: session.name, tool: session.tool, kind: unit.kind, seq: unit.seq, endSeq: unit.endSeq, anchor: unit.anchor,
      wrongKindMoments: inWindow.map(({ kind, seq, endSeq, text }) => ({ kind, seq, ...(endSeq == null ? {} : { endSeq }), text })),
    } satisfies MissedUnitDiagnostic];
  });
  const distractorHits = session.gold.distractors.flatMap((distractor) => {
    const hits = moments.filter((moment) => lands(moment, distractor.seq, distractor.endSeq));
    if (!hits.length) return [];
    return [{
      session: session.name, tool: session.tool, id: distractor.id, kind: distractor.kind, seq: distractor.seq, endSeq: distractor.endSeq,
      moments: hits.map(({ kind, seq, endSeq, text }) => ({ kind, seq, ...(endSeq == null ? {} : { endSeq }), text })),
    } satisfies DistractorHitDiagnostic];
  });
  return { misses, distractorHits };
}

export function scoreSession(session: BenchSession, extractor: MomentsExtractor, budgetChars = 20_000): SessionScore {
  const hits: Record<string, number> = {};
  const pieces = awaitlessExtractPieces(session.events, {}, hits);
  const input: ExtractorInput = { events: session.events, pieces, distillate: session.distillate };
  const moments = extractor.extract(input).moments;
  const rendered = extractor.render(input, moments, budgetChars);
  const renderedSet = renderedSeqs(rendered);
  const chapters = segmentChapters(session.events, pieces);
  const renderedMoments = moments.filter((moment) => renderedSet.has(moment.seq));
  const coveredChapters = chapters.filter((chapter) => renderedMoments.some((moment) => moment.seq >= chapter.startSeq && moment.seq <= chapter.endSeq)).length;
  const maxSeq = session.events.at(-1)?.seq ?? 0;
  const renderedByThird = { early: 0, middle: 0, late: 0 };
  for (const moment of renderedMoments) {
    const third = moment.seq < maxSeq / 3 ? "early" : moment.seq < maxSeq * 2 / 3 ? "middle" : "late";
    renderedByThird[third]++;
  }
  const perKind = kindMap();
  let strictHits = 0, anyHits = 0, renderedHits = 0, middleStrictHits = 0, middleUnits = 0, earlyStrictHits = 0, earlyUnits = 0, lateStrictHits = 0, lateUnits = 0, verbatimHits = 0;
  for (const unit of session.gold.units) {
    const inWindow = moments.filter((m) => landsOnUnit(m, unit));
    const strict = inWindow.some((m) => acceptableMomentKinds(unit.kind).includes(m.kind));
    const any = inWindow.length > 0;
    const renderedHit = [...renderedSet].some((seq) => seq >= unit.seq && seq <= unit.endSeq);
    if (strict) strictHits++;
    if (any) anyHits++;
    if (renderedHit) renderedHits++;
    if (unit.third === "middle") { middleUnits++; if (strict) middleStrictHits++; }
    if (unit.third === "early") { earlyUnits++; if (strict) earlyStrictHits++; }
    if (unit.third === "late") { lateUnits++; if (strict) lateStrictHits++; }
    if (strict && inWindow.some((m) => acceptableMomentKinds(unit.kind).includes(m.kind) && containsAnchor(m, unit.anchor))) verbatimHits++;
    const k = perKind[unit.kind] ??= { strict: rate(0, 0), any: rate(0, 0), rendered: rate(0, 0) };
    k.strict.total++; k.any.total++; k.rendered.total++;
    if (strict) k.strict.count++;
    if (any) k.any.count++;
    if (renderedHit) k.rendered.count++;
  }
  for (const k of Object.values(perKind)) { k.strict.rate = k.strict.total ? k.strict.count / k.strict.total : 0; k.any.rate = k.any.total ? k.any.count / k.any.total : 0; k.rendered.rate = k.rendered.total ? k.rendered.count / k.rendered.total : 0; }
  const distractorHits: Record<string, number> = {};
  let junk = 0, hazardViolations = 0;
  for (const moment of moments) {
    const ds = session.gold.distractors.filter((d) => lands(moment, d.seq, d.endSeq));
    if (ds.length) junk++;
    if (ds.some((d) => d.hazard)) hazardViolations++;
  }
  for (const d of session.gold.distractors) if (moments.some((m) => lands(m, d.seq, d.endSeq))) distractorHits[d.kind] = (distractorHits[d.kind] ?? 0) + 1;
  let unplanted = 0;
  for (const moment of moments) if (!session.gold.units.some((u) => lands(moment, u.seq, u.endSeq)) && !session.gold.distractors.some((d) => lands(moment, d.seq, d.endSeq))) unplanted++;
  return { session: session.name, tool: session.tool, seed: session.seed, size: session.size, units: session.gold.units.length, strictHits, anyHits, renderedHits, middleStrictHits, middleUnits, earlyStrictHits, earlyUnits, lateStrictHits, lateUnits, verbatimHits, moments: moments.length, junk, hazardViolations, unplanted, chapters: chapters.length, coveredChapters, renderedByThird, distractorHits, perKind };
}

// Kept as a local import boundary so the scorer cannot accidentally score an
// unredacted representation in a future extractor.
import { extractPieces as awaitlessExtractPieces } from "../handoff/pieces";

function add(a: AggregateScore, s: SessionScore): void {
  a.sessions++; a.units += s.units; a.strictHits += s.strictHits; a.anyHits += s.anyHits; a.renderedHits += s.renderedHits; a.middleStrictHits += s.middleStrictHits; a.middleUnits += s.middleUnits; a.earlyStrictHits += s.earlyStrictHits; a.earlyUnits += s.earlyUnits; a.lateStrictHits += s.lateStrictHits; a.lateUnits += s.lateUnits; a.verbatimHits += s.verbatimHits; a.moments += s.moments; a.junk += s.junk; a.hazardViolations += s.hazardViolations; a.unplanted += s.unplanted;
  a.chaptersPerSession += s.chapters; a.chapterCoverage.count += s.coveredChapters; a.chapterCoverage.total += s.chapters;
  a.renderedByThird.early += s.renderedByThird.early; a.renderedByThird.middle += s.renderedByThird.middle; a.renderedByThird.late += s.renderedByThird.late;
  for (const [kind, k] of Object.entries(s.perKind)) {
    const out = a.perKind[kind] ??= { strict: rate(0, 0), any: rate(0, 0), rendered: rate(0, 0) };
    out.strict.total += k.strict.total; out.strict.count += k.strict.count; out.any.total += k.any.total; out.any.count += k.any.count; out.rendered.total += k.rendered.total; out.rendered.count += k.rendered.count;
  }
  for (const [kind, n] of Object.entries(s.distractorHits)) a.distractorHits[kind] = (a.distractorHits[kind] ?? 0) + n;
}
export function aggregateScores(scores: SessionScore[], tool: string): AggregateScore {
  const a: AggregateScore = { tool, sessions: 0, units: 0, strictHits: 0, anyHits: 0, renderedHits: 0, middleStrictHits: 0, middleUnits: 0, earlyStrictHits: 0, earlyUnits: 0, lateStrictHits: 0, lateUnits: 0, verbatimHits: 0, moments: 0, junk: 0, hazardViolations: 0, unplanted: 0, chaptersPerSession: 0, chapterCoverage: rate(0, 0), renderedByThird: { early: 0, middle: 0, late: 0 }, perKind: {}, distractorHits: {}, recallStrict: rate(0, 0), recallAny: rate(0, 0), renderedRecall: rate(0, 0), middleRecallStrict: rate(0, 0), earlyRecallStrict: rate(0, 0), lateRecallStrict: rate(0, 0), verbatimFidelity: rate(0, 0), junkRate: rate(0, 0), unplantedRate: rate(0, 0), momentsPerSession: 0 };
  for (const s of scores) add(a, s);
  a.recallStrict = rate(a.strictHits, a.units); a.recallAny = rate(a.anyHits, a.units); a.renderedRecall = rate(a.renderedHits, a.units);
  a.middleRecallStrict = rate(a.middleStrictHits, a.middleUnits); a.earlyRecallStrict = rate(a.earlyStrictHits, a.earlyUnits); a.lateRecallStrict = rate(a.lateStrictHits, a.lateUnits); a.verbatimFidelity = rate(a.verbatimHits, a.strictHits); a.junkRate = rate(a.junk, a.moments); a.unplantedRate = rate(a.unplanted, a.moments); a.momentsPerSession = a.sessions ? a.moments / a.sessions : 0;
  a.chaptersPerSession = a.sessions ? a.chaptersPerSession / a.sessions : 0; a.chapterCoverage.rate = a.chapterCoverage.total ? a.chapterCoverage.count / a.chapterCoverage.total : 0;
  for (const k of Object.values(a.perKind)) { k.strict.rate = k.strict.total ? k.strict.count / k.strict.total : 0; k.any.rate = k.any.total ? k.any.count / k.any.total : 0; k.rendered.rate = k.rendered.total ? k.rendered.count / k.rendered.total : 0; }
  return a;
}
