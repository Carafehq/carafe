/**
 * Findings — outcomes the ASSISTANT reports in prose ("duplicates went from
 * about three percent to zero on the replay run", "the root cause was the stale
 * cache key"). Tool results are covered by breakthroughs and dead ends; this is
 * the only detector that quotes assistant text, so it is precision first: an
 * explicit outcome cue, or a measurement tied to an outcome verb, in one clean
 * prose sentence. Never a heading, list item, table row, log line, question or
 * plan. Measured on a real 24K-event session, the number-plus-unit rule alone
 * produced 511 candidates ("Dev server up (ready in 542ms)", "Phase 0 (1 day)");
 * these rules keep the handful that a resuming agent would want to know.
 */
import type { KeyMoment } from "./extract";
import { clip, stripRolePrefix, type SignalContext } from "./signals";

const WORD_NUMBER = String.raw`(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million)`;
const NUMBER = String.raw`(?:~?\d+(?:[.,]\d+)?[kKmM]?|${WORD_NUMBER}(?:[- ]${WORD_NUMBER})*)`;
// Generic units only: never a corpus's own domain nouns.
const UNIT = String.raw`(?:%|percent|ms|milliseconds?|seconds?|secs?|minutes?|mins?|hours?|days?|weeks?|months?|years?|bytes?|kb|mb|gb|tokens?|tests?|specs?|cases?|requests?|rows?|records?|files?|lines?|errors?|failures?|warnings?|retries|users?|events?|messages?|calls?|queries|items?|x)`;
const MEASUREMENT_RE = new RegExp(String.raw`\b${NUMBER}\s*${UNIT}\b`, "i");
/** A measurement is a finding only when the sentence says what happened to it. */
const OUTCOME_VERB_RE = new RegExp(String.raw`\b(?:now|took|takes|taking|ran|runs|run|went|goes|dropped|fell|reduced|decreased|increased|rose|grew|improved|regressed|passes|passed|fails|failed|finished|completed|returned|returns|down to|up to|from\s+(?:~?\d|${WORD_NUMBER})[^.]*?\bto\s+(?:~?\d|${WORD_NUMBER}))\b`, "i");
/** Instructions and proposals start with a verb; outcomes do not. */
const IMPERATIVE_START_RE = /^(?:now\s+)?(?:stop|don['’]?t|do|use|keep|make|run|check|fix|change|add|remove|drop|switch|let['’]?s|convert|update|create|delete|move|rename|set|install|open|close|wire|refactor|migrate|replace|split|merge|write|read|test|deploy|revert|try|start|apply|implement|extract|inline|rewrite)\b/i;
const EXPLICIT_CUES = [
  /\bwent from\b.+\bto\b/i,
  /\broot cause\b/i,
  /\bturns out\b/i,
  /\bconfirmed (?:that|:|the|it|this)\b/i,
  /\bthe fix (?:is|was)\b/i,
  /\bno longer\b/i,
  /\bnow (?:passes|fails|returns|takes|runs|works|succeeds)\b/i,
  /\b(?:all|every)\s+(?:\d+\s+)?tests?\s+(?:pass|passing|fail|failing)\b/i,
  /\bis (?:now )?(?:green|passing|failing)\b/i,
];
/** Headings, list items, table rows, numbered steps, timestamps and log lines. */
const NOT_PROSE_RE = /^(?:[-*+|#>]|\d+[.)]\s|\d{1,2}:\d{2}(?::\d{2})?(?:\s*[AP]M)?\b|\[?\d{4}-\d{2}-\d{2}T|(?:PASS|FAIL|ERROR|WARN|INFO)\b|at\s+\S+\s+\(|Process exited\b|Test Suites?:|Tests?:|Snapshots?:|Time:)/i;
/** Plans, proposals, hypotheticals and hedges are not outcomes. */
const PLAN_RE = /\b(?:phase|step|option|day)\s+\d+\b|\bwould\b|\bcould\b|\bshould\b|\bplan\b|\blet['’]?s\b|\bI(?:['’]ll| will|['’]d|['’]m| am)\b|\bI recommend\b|\bif you\b|\bprobably\b|\blikely\b|\bmaybe\b|\bperhaps\b|\bTODO\b/i;

interface Candidate { seq: number; text: string; score: number; order: number }

function candidate(seq: number, raw: string, order: number): Candidate | null {
  const text = raw.replace(/\s+/g, " ").trim();
  // Rules are judged on the sentence without markdown emphasis; the moment
  // keeps the sentence exactly as the assistant wrote it.
  const sentence = text.replace(/\*\*|__|`/g, "");
  if (sentence.length < 20 || sentence.length > 240) return null;
  if (/[?:]$/.test(sentence) || NOT_PROSE_RE.test(sentence) || sentence.includes("|")) return null;
  if (sentence.split(/\s+/).length < 5) return null;
  if (PLAN_RE.test(sentence) || IMPERATIVE_START_RE.test(sentence)) return null;
  const cueCount = EXPLICIT_CUES.filter((cue) => cue.test(sentence)).length;
  const measured = MEASUREMENT_RE.test(sentence) && OUTCOME_VERB_RE.test(sentence);
  if (!cueCount && !measured) return null;
  return { seq, text, score: cueCount * 10 + Number(measured), order };
}

/** At most one finding per assistant message: its highest-cue sentence. A
 * message the adapter surfaced twice (Codex records some replies as both an
 * item and an event) yields one finding, at the first occurrence. */
export function detectFindings(context: SignalContext): KeyMoment[] {
  const moments: KeyMoment[] = [];
  let previous: string | null = null;
  for (const block of context.blocks) {
    for (const assistant of block.assistantLines) {
      const plain = stripRolePrefix(assistant.text);
      const sentences = plain.split(/(?<=[.!?])\s+|\n+/).map((sentence) => sentence.trim()).filter(Boolean);
      const best = sentences
        .map((sentence, order) => candidate(assistant.seq, sentence, order))
        .filter((item): item is Candidate => item != null)
        .sort((a, b) => b.score - a.score || a.order - b.order)[0];
      if (!best || best.text === previous) continue;
      previous = best.text;
      moments.push({ kind: "finding", seq: best.seq, text: clip(best.text, 240) });
    }
  }
  return moments;
}
