/**
 * Key Moments extraction — deterministic compaction-for-resumption from the
 * already-redacted trace pieces. This selects pivotal verbatim excerpts only:
 * no summarization, no model calls, no network, no unstable clocks.
 */
import type { EventPieces } from "../handoff/pieces";
import { commandOf } from "./signals";

export type MomentKind = "goal" | "ask" | "decision" | "breakthrough" | "finding" | "deadend" | "rule" | "artifact" | "wip" | "recap" | "instruction" | "openask";

export interface KeyMoment {
  kind: MomentKind;
  seq: number;
  endSeq?: number;
  text: string;
  note?: string;
  chapter?: number;
  /** recap: the owner's request line, and the seq of the turn it was asked in */
  requestLine?: string;
  requestSeq?: number;
  /** recap: the reply at the longer cap the orientation layer quotes */
  fullText?: string;
  /** openask: the option lines the assistant offered under the question */
  options?: string[];
  /** openask (W4): the user turn the question hangs off — "spec THEM as one
   *  piece of work" says nothing without it */
  antecedent?: { text: string; seq: number };
  /** a moment lifted from a helper agent's own trace: which helper, and the
   *  seq it carries THERE (this moment's `seq` is the parent turn it belongs to) */
  via?: string;
  viaSeq?: number;
  /** the first line of the assistant's next reply — what a steer actually
   *  changed, which is the only useful thing to say about a course correction */
  nextReply?: string;
}

export interface KeyMomentSet {
  moments: KeyMoment[];
  totalEvents: number;
}

interface PendingDecision { seq: number; text: string }
interface LastAttempt { seq: number; text: string }

function clip(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n) + "…";
}

// A dead end is a resumption hazard: something the next agent should NOT re-try.
// Precision matters far more than recall here — a false "don't retry" is worse
// than a missed one — so match only high-confidence failure signals, and never
// when the same result shows a clean exit. RICH signals name the failure; EXIT
// catches non-zero process exits (covers test/build failures generically).
const RICH_FAIL_RE = /error TS\d|Traceback \(most recent call last\)|\bfatal:|\bnpm ERR!|\bAssertionError\b|panic:|✗|✖/;
const EXIT_FAIL_RE = /\bexit(?:ed with)? code [1-9]\d*\b/i;
const SUCCESS_RE = /\bexit(?:ed with)? code 0\b|\b0 failed\b/i;
const REVERSAL_RE = /\bgit\s+(revert|reset\s+--hard|checkout\s+--|stash)\b/;
const PR_LINK_RE = /\bhttps?:\/\/\S*pr-link\S*|\bpr-link(?:\s+\S+)?\s+https?:\/\/\S+/i;

function isFailResult(line: string): boolean {
  if (SUCCESS_RE.test(line)) return false;
  return RICH_FAIL_RE.test(line) || EXIT_FAIL_RE.test(line);
}

/** The most informative failure line in a (possibly multi-line, metadata-heavy)
 *  tool result — prefer the named error over a bare "exited with code N". */
function failExcerpt(resultLine: string): string {
  const body = resultLine.replace(/^\s*⤷\s*/, "");
  const lines = body.split("\n").map((l) => l.trim()).filter(Boolean);
  const rich = lines.find((l) => RICH_FAIL_RE.test(l));
  if (rich) return clip(rich, 200);
  const exit = lines.find((l) => EXIT_FAIL_RE.test(l));
  if (exit) return clip(exit, 200);
  return clip(lines[0] ?? body, 200);
}

const unescapeJson = (s: string): string =>
  s.replace(/\\n|\\t|\\r/g, " ").replace(/\\"/g, '"').replace(/\\\\/g, "\\").replace(/\s+/g, " ").trim();

export { commandOf } from "./signals";

function unescapeDecisionText(s: string): string {
  try {
    return JSON.parse('"' + s + '"') as string;
  } catch {
    return s
      .replace(/\\n/g, "\n")
      .replace(/\\r/g, "\r")
      .replace(/\\t/g, "\t")
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, "\\");
  }
}

function capText(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}

function questionHeadline(question: string): string {
  const unescaped = unescapeDecisionText(question);
  const boundaries = [/\n\s*\n/, /\bELI10:/i, /\bStakes\b/i]
    .map((re) => re.exec(unescaped)?.index)
    .filter((index): index is number => index != null);
  const end = boundaries.length ? Math.min(...boundaries) : unescaped.length;
  return capText(unescaped.slice(0, end).replace(/\s+/g, " ").trim(), 90);
}

/** Reduce an AskUserQuestion result to the decisions it records: "headline → choice",
 *  dropping the ELI10/stakes body that only mattered while deciding. */
/** A question the user cancelled is not a locked decision — a resuming agent
 *  must not read "rejected" as "settled". */
const REJECTED_RE = /doesn't want to proceed with this tool use|tool use was rejected/i;

export const isCancelledAnswer = (resultLine: string): boolean => REJECTED_RE.test(resultLine);

export function summarizeAnswers(resultLine: string): string | null {
  const pairRe = /"((?:[^"\\]|\\.)*)"\s*=\s*"((?:[^"\\]|\\.)*)"/g;
  const pairs: string[] = [];
  let match: RegExpExecArray | null;

  while ((match = pairRe.exec(resultLine)) !== null) {
    const question = questionHeadline(match[1] ?? "");
    const answer = capText(unescapeDecisionText(match[2] ?? "").replace(/\s+/g, " ").trim(), 90);
    pairs.push(question + " → " + answer);
  }

  if (pairs.length === 0) return null;
  const shown = pairs.slice(0, 3).join(" · ");
  const suffix = pairs.length > 3 ? " (+" + (pairs.length - 3) + " more)" : "";
  return capText(shown + suffix, 320);
}

/** Reduce a "→ **Tool** {…json…}" line to its salient bit — the command, path,
 *  pattern, or question — so a moment reads "Bash: git commit …" instead of a
 *  wall of harness params. Still verbatim (the real value, un-paraphrased); the
 *  full input is always one `carafe show --seq` away. Prose lines pass through. */
function cleanToolExcerpt(line: string): string {
  const m = /^→ \*\*([^*]+)\*\*\s*([\s\S]*)$/.exec(line);
  if (!m) return line;
  const tool = (m[1] ?? "").trim();
  const rest = m[2] ?? "";
  const grab = (re: RegExp): string | null => {
    const g = re.exec(rest);
    return g && g[1] != null ? unescapeJson(g[1]) : null;
  };
  let salient: string | null = null;
  if (tool === "AskUserQuestion") {
    const question = /"question"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(rest);
    if (question?.[1] != null) salient = questionHeadline(question[1]);
  }
  if (salient == null) salient = commandOf(line);
  if (salient == null) salient = grab(/"pattern"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  if (salient == null) salient = grab(/"(?:file_path|path)"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  if (salient == null) {
    const fm = /\*\*\* (?:Update|Add|Delete) File:\s*(.+)/.exec(rest);
    if (fm && fm[1] != null) salient = fm[1].trim();
  }
  if (salient == null) salient = clip(rest.replace(/\s+/g, " ").trim(), 160);
  return `${tool}: ${clip(salient, 200)}`;
}

export function extractKeyMoments(
  pieces: EventPieces[],
  opts?: { tailFraction?: number; wipCount?: number; maxDeadends?: number },
): KeyMomentSet {
  const moments: KeyMoment[] = [];
  const seen = new Set<string>();
  const maxSeq = pieces[pieces.length - 1]?.seq ?? 0;
  const tailStart = maxSeq * (1 - (opts?.tailFraction ?? 0.2));
  const maxDeadends = opts?.maxDeadends ?? 8;

  let emittedGoal = false;
  let pendingDecision: PendingDecision | null = null;
  let lastAttempt: LastAttempt | null = null;

  const add = (moment: KeyMoment): void => {
    const key = `${moment.kind}|${moment.seq}|${moment.text.slice(0, 60)}`;
    if (seen.has(key)) return;
    seen.add(key);
    moments.push(moment);
  };

  for (const p of pieces) {
    for (const line of p.lines) {
      if (line.startsWith("**system:**")) continue;

      if (line.startsWith("**user:**")) {
        if (!emittedGoal) {
          add({ kind: "goal", seq: p.seq, text: clip(line, 2000) });
          emittedGoal = true;
        } else {
          add({ kind: "ask", seq: p.seq, text: clip(line, 800) });
        }
      }

      if (line.startsWith("→ **AskUserQuestion**")) {
        pendingDecision = { seq: p.seq, text: cleanToolExcerpt(clip(line, 800)) };
      } else if (pendingDecision && line.trimStart().startsWith("⤷")) {
        if (!isCancelledAnswer(line)) {
          const summary = summarizeAnswers(line);
          add(summary
            ? { kind: "decision", seq: pendingDecision.seq, text: summary }
            : { kind: "decision", seq: pendingDecision.seq, text: pendingDecision.text, note: clip(line, 500) });
        }
        pendingDecision = null;
      }

      const command = commandOf(line);
      if (command != null && /\bgit\s+commit\b/.test(command)) {
        add({ kind: "artifact", seq: p.seq, text: cleanToolExcerpt(line) });
      }

      if (PR_LINK_RE.test(line)) {
        add({ kind: "artifact", seq: p.seq, text: clip(line, 400) });
      }

      if (command != null && REVERSAL_RE.test(command)) {
        add({ kind: "deadend", seq: p.seq, text: cleanToolExcerpt(line), note: "explicit reversal" });
      }

      if (line.trimStart().startsWith("⤷") && isFailResult(line) && p.seq >= tailStart) {
        add({
          kind: "deadend",
          seq: lastAttempt?.seq ?? p.seq,
          text: lastAttempt ? cleanToolExcerpt(lastAttempt.text) : failExcerpt(line),
          note: failExcerpt(line),
        });
      }

      if (line.startsWith("→ **")) {
        lastAttempt = { seq: p.seq, text: line };
      }
    }
  }

  const wipCount = opts?.wipCount ?? 8;
  const toolPieces = pieces
    .filter((p) => p.lines.some((line) => line.startsWith("→ ")))
    .slice(-wipCount);

  for (const p of toolPieces) {
    const firstToolLine = p.lines.find((line) => line.startsWith("→ "));
    if (firstToolLine) add({ kind: "wip", seq: p.seq, text: cleanToolExcerpt(clip(firstToolLine, 500)) });
  }

  const deadends = moments.filter((m) => m.kind === "deadend");
  if (deadends.length <= maxDeadends) return { moments, totalEvents: pieces.length };

  const keepDeadendKeys = new Set(
    deadends
      .slice()
      .sort((a, b) => b.seq - a.seq)
      .slice(0, maxDeadends)
      .map((m) => `${m.kind}|${m.seq}|${m.text.slice(0, 60)}`),
  );
  return {
    moments: moments.filter((m) => m.kind !== "deadend" || keepDeadendKeys.has(`${m.kind}|${m.seq}|${m.text.slice(0, 60)}`)),
    totalEvents: pieces.length,
  };
}

export { extractMoments } from "./detect";
