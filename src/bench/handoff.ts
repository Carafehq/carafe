/**
 * W7 — the handoff bench.
 *
 * Every earlier round of this work was judged by reading one rendered file and
 * arguing about it. This makes the argument mechanical: a case carries a
 * `truth.json` a human verified — the branch, the HEAD, the upstream, the
 * unpushed branches, the untracked names, the health body — plus the strings
 * the handoff MUST say and the strings it must NEVER state as current (a
 * superseded health commit, a commit subject that asserts the opposite of
 * today). The bench renders the handoff with the git commands replaced by those
 * verified values (`liveOverride`), so it is hermetic: no git, no network, no
 * clock. A false statement fails the run.
 */
import { existsSync, readFileSync, readdirSync } from "fs";
import { join } from "path";
import { CarafeStore } from "../format/store";
import { readSession } from "../format/sessions";
import { listSessions } from "../query/sessions";
import { preparedPieces, renderHandoff } from "../handoff/render";
import { parseAnswers, type AnswerFile } from "../handoff/answers";
import type { LiveState } from "../handoff/live";

export interface HandoffTruth {
  /** the session to render; the only one in the case's store when absent */
  session?: string;
  /** the verified readings, fed in place of the git commands */
  live: LiveState;
  /** the URLs the trace probed, for W2's checker */
  healthUrls?: string[];
  must_mention?: string[];
  must_not_state?: string[];
  /** an answer file to carry into the render, verbatim */
  answers?: string;
}

export interface HandoffCaseResult {
  name: string;
  chars: number;
  falseStatements: string[];
  missing: string[];
  invariants: Array<{ name: string; ok: boolean; detail: string | null }>;
}

export interface HandoffBenchCard { dir: string; cases: HandoffCaseResult[] }

/** A line that is explicitly marked as a past observation cannot mislead. */
const HEDGED_RE = /\(old\)|may have lapsed|as last observed|Last seen in the session|Since the agent wrote this/;

const SECTION_RE = /^##\s+(.*)$/;

function sectionsOf(text: string): Array<{ heading: string; lines: string[] }> {
  const sections: Array<{ heading: string; lines: string[] }> = [{ heading: "(preamble)", lines: [] }];
  for (const line of text.split("\n")) {
    const match = SECTION_RE.exec(line);
    if (match) sections.push({ heading: match[1]!, lines: [] });
    else sections.at(-1)!.lines.push(line);
  }
  return sections;
}

/** Every `must_not_state` string that appears on a line nothing hedges. */
export function falseStatements(text: string, forbidden: string[]): string[] {
  const hits: string[] = [];
  for (const section of sectionsOf(text)) {
    const hedgedSection = HEDGED_RE.test(section.heading);
    for (const line of section.lines) {
      if (hedgedSection || HEDGED_RE.test(line)) continue;
      for (const phrase of forbidden) if (phrase && line.includes(phrase) && !hits.includes(phrase)) hits.push(phrase);
    }
  }
  return hits;
}

const DATED_RE = /\[(?:seq \d+|agent-[0-9a-f]+ seq \d+), \d{4}-\d{2}-\d{2}|· \d{4}-\d{2}-\d{2} ·|\[seq \d+\]/;
const QUOTED_SECTIONS = ["Standing instructions", "Waiting on the owner", "Lessons"];
const STAMP_RE = /\[[^\]]*?(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}) UTC/g;

/**
 * v6 round 1 — the sections that quote a person, and the anchor every one of
 * their lines carries.
 *
 * The real session's Do not section quoted helper-agent prompts under `[seq 0]`
 * and other seqs of a DIFFERENT trace. A seq that does not resolve in the main
 * trace, or resolves to an event that never contained the sentence, is a false
 * statement by carafe's own standard, whatever the sentence says.
 */
const QUOTING_SECTIONS = ["Do not", "Standing instructions", "Waiting on the owner"];
/** How much of a quoted sentence must be found at its anchor. A rendered line
 *  may be clipped or whitespace-collapsed; its opening never changes. */
const ANCHOR_MATCH_CHARS = 40;
const flat = (text: string): string => text.replace(/\s+/g, " ").trim();

/** The sentence and the anchoring seq of one quoted line, or null. */
export function quotedAnchor(line: string): { text: string; seq: number } | null {
  if (!line.startsWith("- ")) return null;
  // the LAST `[…seq N…]` on the line is the anchor; an `(said after an incident
  // [seq S])` mark sits before it and is a different claim
  const anchors = [...line.matchAll(/\[(?:(agent-[0-9a-z]+) )?seq (\d+)[,\]]/g)];
  const last = anchors.at(-1);
  if (!last) return null;
  // a line anchored to a HELPER's trace names the helper; the main trace cannot
  // be asked about it, so it is not this invariant's business
  if (last[1]) return null;
  const body = line.slice(2, last.index).trim();
  const quoted = /^"([\s\S]*)"/.exec(body) ?? /^"([\s\S]*)"\s*\(/.exec(body);
  const text = quoted?.[1] ?? body.replace(/\s*\([^)]*\)\s*$/, "");
  return text ? { text: flat(text), seq: Number(last[2]) } : null;
}

export function checkInvariants(text: string, traceText?: Map<number, string>): Array<{ name: string; ok: boolean; detail: string | null }> {
  const out: Array<{ name: string; ok: boolean; detail: string | null }> = [];

  const leak = /\$[A-Za-z{]/.exec(text);
  out.push({ name: "no $ leaks", ok: leak == null, detail: leak ? text.slice(Math.max(0, leak.index - 60), leak.index + 20) : null });

  const undated: string[] = [];
  for (const section of sectionsOf(text)) {
    if (!QUOTED_SECTIONS.some((name) => section.heading.startsWith(name))) continue;
    for (const line of section.lines) {
      if (!line.startsWith("- ")) continue;
      if (!DATED_RE.test(line)) undated.push(line.slice(0, 90));
    }
  }
  out.push({ name: "every quoted sentence dated", ok: undated.length === 0, detail: undated[0] ?? null });

  const checkedAt = /## Right now \(checked at (\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}) UTC/.exec(text);
  let newest: string | null = null;
  const lastSeen = sectionsOf(text).find((section) => section.heading.startsWith("Last seen in the session"));
  for (const line of lastSeen?.lines ?? []) {
    for (const match of line.matchAll(STAMP_RE)) {
      const stamp = `${match[1]} ${match[2]}`;
      if (!newest || stamp > newest) newest = stamp;
    }
  }
  const ok = checkedAt == null || newest == null || `${checkedAt[1]} ${checkedAt[2]}` >= newest;
  out.push({ name: "Right now newer than every Last seen entry", ok, detail: ok ? null : `checked ${checkedAt?.[1]} ${checkedAt?.[2]}, last seen ${newest}` });

  const tail = /^## The tail, verbatim \(seq (\d+) → (\d+): the last (\d+) turns? of work in ([^)]*)\)(.*)$/m.exec(text);
  const tailOk = tail != null && Number(tail[2]) >= Number(tail[1]) && Number(tail[3]) >= 1;
  out.push({ name: "tail label truthful", ok: tailOk, detail: tailOk ? null : "no parseable tail heading" });

  /* ---------------- v6 ---------------- */

  // V3 — nothing that exists only on this disk may hide behind a number until
  // there are more than fifteen of them
  const hidden: string[] = [];
  for (const line of text.split("\n")) {
    const more = /^\s*\+(\d+) more — git -C /.exec(line);
    if (!more) continue;
    const named = /on this disk only \(no remote has these commits\): (.*)$/.exec(previousDiskLine(text, line) ?? "");
    const count = named ? named[1]!.split(" · ").length : 0;
    if (count < UNPUSHED_NAMED_MIN) hidden.push(`${count} named before "+${more[1]} more"`);
  }
  out.push({ name: "no +N more under 15 single-disk branches", ok: hidden.length === 0, detail: hidden[0] ?? null });

  // A live-state outcome is explicit: unknown, denied, failed, or answered.
  // Mixed-host projects may legitimately contain more than one outcome.
  const banner = text.includes("**LIVE STATE UNKNOWN**");
  const reading = /^- health: .* → (?!unreachable)/m.test(text);
  const failed = /^- health: .* → unreachable /m.test(text);
  const denied = text.includes("live state not checked: you declined network checks");
  const outcome = banner || reading || failed || denied;
  out.push({ name: "LIVE STATE UNKNOWN iff no health reading", ok: outcome, detail: outcome ? null : "no live-state outcome" });

  // V9 — the header names the repositories Right now checked, and only those
  const headerRepos = reposInHeader(text);
  const nowRepos = reposInRightNow(text);
  const sameRepos = headerRepos.join(" ") === nowRepos.join(" ");
  out.push({ name: "header repo list equals Right now repo list", ok: sameRepos, detail: sameRepos ? null : `header [${headerRepos.join(", ")}] vs right now [${nowRepos.join(", ")}]` });

  // V9 — one seq, one kind
  const kinds = new Map<string, Set<string>>();
  for (const line of text.split("\n")) {
    const labelled = /\b(dead end|breakthrough)\b[^[]*\[(?:(agent-[0-9a-z]+) )?seq (\d+)/.exec(line);
    if (!labelled) continue;
    const key = `${labelled[2] ?? ""}:${labelled[3]}`;
    kinds.set(key, (kinds.get(key) ?? new Set()).add(labelled[1]!));
  }
  const doubled = [...kinds].find(([, set]) => set.size > 1);
  out.push({ name: "no seq labelled with two kinds", ok: doubled == null, detail: doubled ? `seq ${doubled[0]} is ${[...doubled[1]].join(" and ")}` : null });

  // V8 — when nobody answered, the reader is told before anything else
  const lines = text.split("\n");
  const stub = text.includes("_No answers file.") || text.includes("No outgoing-agent answers.");
  const early = lines.slice(0, 5).some((line) => line.includes("No outgoing-agent answers."));
  out.push({ name: "missing answers warned in the first five lines", ok: !stub || early, detail: !stub || early ? null : lines.slice(0, 5).join(" / ").slice(0, 120) });

  // PR #38, on the per-claim contract: a stamp is an indented line under the
  // sentence it is about, and the sentence itself is quoted with "> ".
  // Contradicting the agent still needs a reproducible observation, and a
  // stamp still may not sit on a fragment of a split sentence.
  const bareContradictions: string[] = [];
  const splitStamps: string[] = [];
  for (const section of sectionsOf(text)) {
    if (!section.heading.startsWith("What the outgoing agent said")) continue;
    for (const line of section.lines) {
      const quoted = /^> (.*)$/.exec(line);
      if (quoted) {
        const body = quoted[1]!;
        const backtickFragment = body.startsWith("`") && !/^`[^`]+`\s+(?:is|was|has|contains|exists)\b/i.test(body);
        if (/^[a-z\]\})]/.test(body) || backtickFragment) splitStamps.push(line.slice(0, 100));
        continue;
      }
      const stamp = /^(?:\s{2,}|- )([✓✗?·]) /.exec(line);
      if (!stamp) continue;
      if (stamp[1] === "✗" && !/ — checked: (?:git -C \S|existsSync\(|lsof |readdir\/stat )[^\n]* → \S/.test(line)) bareContradictions.push(line.slice(0, 120));
    }
  }
  out.push({ name: "every contradicted answer shows checked command and observed value", ok: bareContradictions.length === 0, detail: bareContradictions[0] ?? null });
  out.push({ name: "answer stamps attach to whole sentences", ok: splitStamps.length === 0, detail: splitStamps[0] ?? null });

  // v6 round 1 — every quoted sentence is findable at the seq it claims
  if (traceText) {
    const unresolved: string[] = [];
    for (const section of sectionsOf(text)) {
      if (!QUOTING_SECTIONS.some((name) => section.heading.startsWith(name))) continue;
      for (const line of section.lines) {
        const anchor = quotedAnchor(line);
        if (!anchor) continue;
        const at = traceText.get(anchor.seq);
        if (at == null) { unresolved.push(`seq ${anchor.seq} is not in the main trace: "${anchor.text.slice(0, 50)}"`); continue; }
        const needle = anchor.text.slice(0, ANCHOR_MATCH_CHARS);
        if (!flat(at).includes(needle)) unresolved.push(`seq ${anchor.seq} does not contain "${needle}"`);
      }
    }
    out.push({ name: "every quoted sentence resolves at its own seq", ok: unresolved.length === 0, detail: unresolved[0] ?? null });
  }

  return out;
}

/** How many single-disk branches must be named before a `+N more` is honest. */
const UNPUSHED_NAMED_MIN = 15;

/** The `on this disk only:` line a `+N more` hangs off. */
function previousDiskLine(text: string, marker: string): string | null {
  const lines = text.split("\n");
  const at = lines.indexOf(marker);
  for (let index = at - 1; index >= 0 && index > at - 4; index--) {
    if (lines[index]!.includes("on this disk only")) return lines[index]!;
  }
  return null;
}

/** The repository paths the header's `- repos:` line names, in its order. */
export function reposInHeader(text: string): string[] {
  const line = /^- repos: (.*)$/m.exec(text)?.[1] ?? "";
  if (!line || line.startsWith("none recorded")) return [];
  return line.replace(/ — the codebase is NOT in this file.*$/, "").replace(/ · branch [^,]*$/, "").split(", ")
    .map((entry) => entry.replace(/^not checked: /, "").replace(/\s*\([^)]*\)\s*$/, "").trim())
    .filter(Boolean);
}

/** …and the ones the Right now section reports on, in its order. */
export function reposInRightNow(text: string): string[] {
  const section = sectionsOf(text).find((one) => one.heading.startsWith("Right now (checked at"));
  const out: string[] = [];
  for (const line of section?.lines ?? []) {
    const notChecked = /^- not checked: (.*?) \(/.exec(line);
    if (notChecked) { out.push(notChecked[1]!); continue; }
    const path = /^- (\/\S.*)$/.exec(line);
    if (path) out.push(path[1]!.trim());
  }
  return out;
}

export function renderCase(dir: string): { text: string; truth: HandoffTruth; traceText: Map<number, string> } {
  const truth = JSON.parse(readFileSync(join(dir, "truth.json"), "utf8")) as HandoffTruth;
  const store = new CarafeStore(join(dir, "trace"));
  const sessions = listSessions(store);
  const d = truth.session ? sessions.find((one) => one.sessionId.startsWith(truth.session!)) : sessions[0];
  if (!d) throw new Error(`no session in ${join(dir, "trace")}`);
  const events = readSession(store, d.tool, d.sessionId);
  const answers: AnswerFile[] = [];
  if (truth.answers) {
    const parsed = parseAnswers(truth.answers, `${dir}/truth.json`, truth.live.checkedAt);
    if (parsed) answers.push(parsed);
  }
  const branches = new Set<string>();
  for (const repo of truth.live.repos) for (const branch of repo.branches) branches.add(branch);
  const { text } = renderHandoff(d, events, {
    now: truth.live.checkedAt,
    target: "codex",
    live: truth.live,
    answers,
    answerFacts: { traceBranches: branches, traceUrls: new Set(truth.healthUrls ?? []), git: () => null },
  });
  // the MAIN trace's own text, per seq, for the anchor invariant
  const traceText = new Map<number, string>();
  for (const piece of preparedPieces(events, d.sessionId)) {
    traceText.set(piece.seq, `${traceText.get(piece.seq) ?? ""}\n${piece.lines.join("\n")}`);
  }
  return { text, truth, traceText };
}

export function runHandoffBench(dir: string): HandoffBenchCard {
  const names = existsSync(dir)
    ? readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory() && existsSync(join(dir, entry.name, "truth.json"))).map((entry) => entry.name).sort()
    : [];
  const cases: HandoffCaseResult[] = [];
  for (const name of names) {
    const { text, truth, traceText } = renderCase(join(dir, name));
    cases.push({
      name,
      chars: text.length,
      falseStatements: falseStatements(text, truth.must_not_state ?? []),
      missing: (truth.must_mention ?? []).filter((phrase) => !text.includes(phrase)),
      invariants: checkInvariants(text, traceText),
    });
  }
  return { dir, cases };
}

export function formatHandoffBench(card: HandoffBenchCard): string {
  const lines = [`# HandoffBench · ${card.cases.length} case(s) · ${card.dir}`, ``];
  if (!card.cases.length) { lines.push(`_no cases: a case is a directory holding trace/ and truth.json_`); return lines.join("\n"); }
  lines.push(`| case | chars | false statements | missing must_mention | invariants |`, `| --- | ---: | ---: | ---: | --- |`);
  for (const one of card.cases) {
    const failed = one.invariants.filter((invariant) => !invariant.ok);
    lines.push(`| ${one.name} | ${one.chars} | ${one.falseStatements.length} | ${one.missing.length} | ${failed.length ? `FAIL: ${failed.map((invariant) => invariant.name).join(", ")}` : `${one.invariants.length}/${one.invariants.length}`} |`);
  }
  lines.push(``);
  for (const one of card.cases) {
    for (const phrase of one.falseStatements) lines.push(`- ${one.name}: STATED AS CURRENT: "${phrase}"`);
    for (const phrase of one.missing) lines.push(`- ${one.name}: never mentioned: "${phrase}"`);
    for (const invariant of one.invariants) if (!invariant.ok) lines.push(`- ${one.name}: invariant "${invariant.name}" failed${invariant.detail ? ` — ${invariant.detail}` : ""}`);
  }
  return lines.join("\n");
}
