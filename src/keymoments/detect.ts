import type { CarafeEvent } from "../format/events";
import type { EventPieces } from "../handoff/pieces";
import { detectBends } from "./bend";
import { detectBreakthroughs } from "./breakthrough";
import { detectDeadends } from "./deadends";
import { detectFindings } from "./findings";
import { extractKeyMoments, type KeyMoment, type KeyMomentSet } from "./extract";
import { detectInstructions } from "./instructions";
import { detectRecaps } from "./recap";
import { detectRules } from "./rules";
import { buildSignalContext, type SignalContext } from "./signals";

// Real GitHub URLs carry owner/repo. The one-segment form is retained for old
// imported traces and the sealed MomentsBench renderer.
const GITHUB_PR_RE = /\bhttps:\/\/github\.com\/(?:[A-Za-z0-9_.-]+\/){1,2}pull\/(\d+)\b/;

export function detectPullRequests(context: SignalContext): KeyMoment[] {
  return context.runs.flatMap((run) => {
    if (!run.command || !/\bgh\s+pr\s+create\b/i.test(run.command)) return [];
    const match = GITHUB_PR_RE.exec(run.resultLine);
    if (!match) return [];
    return [{ kind: "artifact", seq: run.toolSeq, text: `pr-link #${match[1]} ${match[0]}` } satisfies KeyMoment];
  });
}

export interface ExtractMomentsInput {
  events: CarafeEvent[];
  pieces: EventPieces[];
}

export interface ExtractMomentsResult extends KeyMomentSet {
  context: SignalContext;
}

export function extractMoments({ events, pieces }: ExtractMomentsInput): ExtractMomentsResult {
  const context = buildSignalContext(events, pieces);
  const legacy = extractKeyMoments(pieces);
  const kept = legacy.moments.filter((moment) => moment.kind === "goal" || moment.kind === "decision" || moment.kind === "artifact" || moment.kind === "wip");
  const goalSeq = kept.find((moment) => moment.kind === "goal")?.seq;
  const pullRequests = detectPullRequests(context).filter((moment) => !kept.some((existing) => existing.kind === "artifact" && existing.text.includes(moment.text.match(GITHUB_PR_RE)?.[0] ?? "\0")));
  const breakthroughs = detectBreakthroughs(events, pieces, context);
  const findings = detectFindings(context).filter((finding) => !breakthroughs.some((breakthrough) => breakthrough.text.includes(finding.text)));
  const recaps = detectRecaps(events, pieces, context);
  // A recap says everything the one-line request did, and more: listing both
  // would index the same turn twice.
  const recapRequestSeqs = new Set(recaps.map((recap) => recap.requestSeq));
  const bends = detectBends(events, pieces, goalSeq, context).filter((moment) => !(moment.kind === "ask" && recapRequestSeqs.has(moment.seq)));
  const moments: KeyMoment[] = [
    ...kept, ...pullRequests, ...bends, ...recaps, ...detectInstructions(events, pieces, context),
    ...findings, ...detectDeadends(events, pieces, 12, context), ...breakthroughs, ...detectRules(events, pieces, 12, context),
  ];
  return { moments: moments.sort((a, b) => a.seq - b.seq), totalEvents: pieces.length, context };
}
