import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { CarafeStore } from "../../format/store";
import { buildSessionIndex } from "../../search/session-index";
import { reflex, type Pointer, type ReflexResult } from "../../reflex/reflex";
import type { BenchSession } from "../corpus";
import { reflexGoldTurns, type ReflexGoldTurn } from "./cases";

export interface ReflexToolScore {
  tool: string;
  sessions: number;
  shouldFire: number;
  correctTurns: number;
  knowToAskFailures: number;
  silentTurns: number;
  falseFires: number;
  emitted: number;
  correctEmitted: number;
  /** pointers inside any planted window of any kind on the asked-about file */
  relatedEmitted: number;
  pushPrecision: number;
  /** strict correct plus related, over everything emitted (reported, never gated) */
  pushPrecisionRelated: number;
  pushRecall: number;
  intrusionChars: number;
  suppressionPassed: number;
  suppressionTotal: number;
  meanRuntimeMs: number;
  maxRuntimeMs: number;
  /** know-to-ask failures by the planted reason (reported, not gated) */
  failuresByReason: Record<string, number>;
  diagnostics: { misses: ReflexMissDiagnostic[]; falseFires: ReflexFalseFireDiagnostic[] };
}

export interface ReflexMissDiagnostic {
  tool: string; session: string; turnId: string; reason: string; text: string;
  expected: Array<{ seq: number; endSeq: number }>;
  /** what fired instead (pointer lines), empty when the reflex stayed silent */
  emitted: string[];
  silentReason?: string;
}
export interface ReflexFalseFireDiagnostic { tool: string; session: string; turnId: string; reason: string; text: string; emitted: string[] }

function emptyScore(tool: string, sessions: number): ReflexToolScore {
  return {
    tool, sessions, shouldFire: 0, correctTurns: 0, knowToAskFailures: 0, silentTurns: 0, falseFires: 0, emitted: 0, correctEmitted: 0, relatedEmitted: 0,
    pushPrecision: 0, pushPrecisionRelated: 0, pushRecall: 0, intrusionChars: 0, suppressionPassed: 0, suppressionTotal: 0, meanRuntimeMs: 0, maxRuntimeMs: 0,
    failuresByReason: {}, diagnostics: { misses: [], falseFires: [] },
  };
}

function finishScore(score: ReflexToolScore, runtimeTotal: number, runtimeTurns: number): ReflexToolScore {
  score.pushPrecision = score.emitted ? score.correctEmitted / score.emitted : 0;
  score.pushPrecisionRelated = score.emitted ? (score.correctEmitted + score.relatedEmitted) / score.emitted : 0;
  score.pushRecall = score.shouldFire ? score.correctTurns / score.shouldFire : 0;
  score.intrusionChars = score.shouldFire ? score.intrusionChars / score.shouldFire : 0;
  score.meanRuntimeMs = runtimeTurns ? runtimeTotal / runtimeTurns : 0;
  return score;
}

function overlaps(pointer: Pointer, expected: { seq: number; endSeq: number }): boolean {
  return pointer.seq <= expected.endSeq && pointer.endSeq >= expected.seq;
}

/** One should-fire or stay-silent turn, scored. `gold(pointer)` supplies the gold
 * turn the pointer's own tool must satisfy (project mode answers from either
 * rendering of a seed). */
function scoreTurn(
  score: ReflexToolScore, turn: ReflexGoldTurn, result: ReflexResult, session: string,
  gold: (pointer: Pointer) => ReflexGoldTurn | undefined,
): void {
  const lines = result.pointers.map((pointer) => pointer.line);
  if (!turn.shouldFire) {
    score.silentTurns++;
    if (result.pointers.length) {
      score.falseFires++;
      score.diagnostics.falseFires.push({ tool: score.tool, session, turnId: turn.id, reason: turn.reason, text: turn.text, emitted: lines });
    }
    return;
  }
  score.shouldFire++;
  score.intrusionChars += result.text.length;
  const correct = result.pointers.filter((pointer) => gold(pointer)?.expected?.some((window) => overlaps(pointer, window)) ?? false);
  const related = result.pointers.filter((pointer) => {
    if (correct.includes(pointer)) return false;
    const counterpart = gold(pointer);
    return (counterpart?.related ?? counterpart?.expected)?.some((window) => overlaps(pointer, window)) ?? false;
  });
  if (correct.length) score.correctTurns++;
  else {
    score.knowToAskFailures++;
    score.failuresByReason[turn.reason] = (score.failuresByReason[turn.reason] ?? 0) + 1;
    score.diagnostics.misses.push({
      tool: score.tool, session, turnId: turn.id, reason: turn.reason, text: turn.text, expected: turn.expected ?? [], emitted: lines,
      ...(result.silentReason ? { silentReason: result.silentReason } : {}),
    });
  }
  score.emitted += result.pointers.length;
  score.correctEmitted += correct.length;
  score.relatedEmitted += related.length;
}

export function scoreReflexSessions(sessions: BenchSession[], tool: string): ReflexToolScore {
  const root = mkdtempSync(join(tmpdir(), "carafe-reflex-bench-"));
  const score = emptyScore(tool, sessions.length);
  let runtimeTotal = 0;
  let runtimeTurns = 0;
  try {
    const store = new CarafeStore(root);
    for (const session of sessions) {
      buildSessionIndex(store, session.distillate, session.events, { force: true });
      for (const turn of reflexGoldTurns(session)) {
        const started = performance.now();
        const result = reflex({ store, session: session.distillate, turnText: turn.text, receiverId: `${session.name}-${turn.id}`, tailStartSeq: Number.POSITIVE_INFINITY });
        const elapsed = performance.now() - started;
        runtimeTotal += elapsed; runtimeTurns++; score.maxRuntimeMs = Math.max(score.maxRuntimeMs, elapsed);
        scoreTurn(score, turn, result, session.name, () => turn);
        if (turn.shouldFire) {
          const suppressionReceiver = `${session.name}-${turn.id}-suppression`;
          reflex({ store, session: session.distillate, turnText: turn.text, receiverId: suppressionReceiver, tailStartSeq: Number.POSITIVE_INFINITY });
          const repeated = reflex({ store, session: session.distillate, turnText: turn.text, receiverId: suppressionReceiver, tailStartSeq: Number.POSITIVE_INFINITY });
          score.suppressionTotal++;
          if (!repeated.text) score.suppressionPassed++;
        }
      }
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
  return finishScore(score, runtimeTotal, runtimeTurns);
}

/** Score one tool's gold turns against both native renderings of each seed. */
export function scoreProjectReflexSessions(sessions: BenchSession[], tool: "claude-code" | "codex"): ReflexToolScore {
  const root = mkdtempSync(join(tmpdir(), "carafe-reflex-project-bench-"));
  const primaries = sessions.filter((session) => session.tool === tool);
  const score = emptyScore(`${tool} project`, primaries.length);
  let runtimeTotal = 0;
  let runtimeTurns = 0;
  try {
    const store = new CarafeStore(root);
    for (const primary of primaries) {
      const pair = sessions.filter((session) => session.seed === primary.seed);
      for (const session of pair) buildSessionIndex(store, session.distillate, session.events, { force: true });
      const turnsByTool = new Map<string, Map<string, ReflexGoldTurn>>(
        pair.map((session) => [session.tool, new Map(reflexGoldTurns(session).map((turn) => [turn.id, turn]))]),
      );
      const projectSessions = pair.map((session) => ({ session: session.distillate }));
      for (const turn of reflexGoldTurns(primary)) {
        const started = performance.now();
        const result = reflex({ store, sessions: projectSessions, cwd: primary.distillate.cwd ?? undefined, turnText: turn.text, receiverId: `project-${tool}-${primary.seed}-${turn.id}` });
        const elapsed = performance.now() - started;
        runtimeTotal += elapsed; runtimeTurns++; score.maxRuntimeMs = Math.max(score.maxRuntimeMs, elapsed);
        scoreTurn(score, turn, result, primary.name, (pointer) => turnsByTool.get(pointer.tool)?.get(turn.id));
        if (turn.shouldFire) {
          const suppressionReceiver = `project-${tool}-${primary.seed}-${turn.id}-suppression`;
          reflex({ store, sessions: projectSessions, cwd: primary.distillate.cwd ?? undefined, turnText: turn.text, receiverId: suppressionReceiver });
          const repeated = reflex({ store, sessions: projectSessions, cwd: primary.distillate.cwd ?? undefined, turnText: turn.text, receiverId: suppressionReceiver });
          score.suppressionTotal++;
          if (!repeated.text) score.suppressionPassed++;
        }
      }
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
  return finishScore(score, runtimeTotal, runtimeTurns);
}
