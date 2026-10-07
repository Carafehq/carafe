import { extractPieces, filesOf } from "../../handoff/pieces";
import { segmentChapters } from "../../keymoments/chapters";
import { normalizeSentence } from "../../keymoments/signals";
import type { BenchSession, RenderedGoldUnit } from "../corpus";

export interface ReflexGoldTurn {
  id: string;
  text: string;
  shouldFire: boolean;
  /** every window a correct pointer may land in — several planted units can share
   *  the same file (the corpus reuses area files) and one turn cannot expect a
   *  different answer for each; a branch spans every chapter it was active in */
  expected?: Array<{ seq: number; endSeq: number }>;
  /** every planted window of ANY kind on the same file: a pointer landing there
   *  is related to what was asked, not wrong (reported, never gated) */
  related?: Array<{ seq: number; endSeq: number }>;
  file?: string;
  reason: string;
}

function firstFile(session: BenchSession, start: number, end: number): string | null {
  for (const event of session.events) {
    if (event.seq < start || event.seq > end) continue;
    const file = filesOf(event)[0];
    if (file) return file;
  }
  return null;
}

interface TurnSeed { family: string; reason: string; file: string; window: { seq: number; endSeq: number }; text: string }

function seedForUnit(session: BenchSession, unit: RenderedGoldUnit): TurnSeed | null {
  const window = { seq: unit.seq, endSeq: unit.endSeq };
  if (unit.kind.startsWith("deadend.") || unit.kind === "breakthrough") {
    const file = firstFile(session, unit.seq, unit.endSeq) ?? (unit.anchor.includes(".") ? unit.anchor : null);
    return file ? { family: "failure", reason: unit.kind, file, window, text: `Tests keep failing in ${file} — check that path before rerunning bun test.` } : null;
  }
  if (unit.kind.startsWith("decision.")) {
    const file = firstFile(session, unit.seq, unit.endSeq + 120);
    return file ? { family: "decision", reason: unit.kind, file, window, text: `Before editing ${file}, recall why this path was chosen.` } : null;
  }
  if (unit.kind === "rule") {
    const terms = normalizeSentence(unit.anchor).split(/\s+/).filter((word) => word.length >= 3).slice(0, 4);
    return terms.length >= 2 ? { family: "rule", reason: unit.kind, file: unit.anchor, window, text: `Keep ${terms.join(" ")} as the standing constraint for this change.` } : null;
  }
  return null;
}

export function reflexGoldTurns(session: BenchSession): ReflexGoldTurn[] {
  // One turn per (family, file): the turn text is the same for every unit of that
  // family on that file, so every one of their windows is an acceptable answer.
  const groups = new Map<string, { seed: TurnSeed; windows: Array<{ seq: number; endSeq: number }>; ids: string[] }>();
  const windowsByFile = new Map<string, Array<{ seq: number; endSeq: number }>>();
  for (const unit of session.gold.units) {
    const seed = seedForUnit(session, unit);
    if (!seed) continue;
    windowsByFile.set(seed.file, [...(windowsByFile.get(seed.file) ?? []), seed.window]);
    const key = `${seed.family}\0${seed.file}`;
    const group = groups.get(key);
    if (group) { group.windows.push(seed.window); group.ids.push(unit.id); }
    else groups.set(key, { seed, windows: [seed.window], ids: [unit.id] });
  }
  const shouldFire: ReflexGoldTurn[] = [...groups.values()].map(({ seed, windows, ids }) => ({
    id: ids.join("+"), text: seed.text, shouldFire: true, expected: windows, related: windowsByFile.get(seed.file), file: seed.file, reason: seed.reason,
  }));
  const pieces = extractPieces(session.events, {}, {});
  const chapters = segmentChapters(session.events, pieces);
  const byBranch = new Map<string, Array<{ seq: number; endSeq: number }>>();
  for (const chapter of chapters) {
    if (!chapter.branch) continue;
    byBranch.set(chapter.branch, [...(byBranch.get(chapter.branch) ?? []), { seq: chapter.startSeq, endSeq: chapter.endSeq }]);
  }
  for (const [branch, windows] of byBranch) {
    shouldFire.push({ id: `branch-${branch}`, text: `Continue the work on branch ${branch}.`, shouldFire: true, expected: windows, reason: "branch" });
  }
  return [
    ...shouldFire,
    { id: "silent-ack", text: "okay", shouldFire: false, reason: "ack" },
    { id: "silent-entity-free", text: "what's the plan for today?", shouldFire: false, reason: "entity-free" },
    { id: "silent-missing-file", text: "Please inspect src/reports/summary.ts before continuing.", shouldFire: false, reason: "missing-file" },
    { id: "silent-missing-error", text: "The command now fails with TS9999.", shouldFire: false, reason: "missing-error" },
  ];
}
