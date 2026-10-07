/** The outgoing agent's answers, checked only where a deterministic command can answer. */
import { overtakenNotes, type RefChange } from "./ref-changes";
import { readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";
import { splitSentences } from "../keymoments/sentences";
import { checkClaims, type Claim } from "./claims";
import type { ClaimScope } from "./claims/types";
import { collisionNotes, reservationsIn } from "./collisions";
import { DELTA_QUESTIONS, landedNotes, type Landed } from "./since";
import { whenLine } from "./claims/when";
import { beforeEnd } from "./dates";
import { LIVE_VERIFY_COMMANDS, realGitRunner, type GitRunner, type LiveState } from "./live";

export const HANDOFF_QUESTIONS: string[] = [
  "What is this project, in three sentences, for someone who has never seen it?",
  "What happened in this session, newest first, with commit hashes or file paths where you have them?",
  "What is live right now (deployed, running, enforced), and how do you know?",
  "What is half-done, parked or blocked, and on what?",
  "What should the next session do first, and what must it not do?",
  "What will trip up the next session — the mistakes that cost you time, each with what happened?",
  "Define the terms a newcomer would not know (names of people, agents, branches-as-concepts, internal jargon), one line each.",
];

export { LIVE_VERIFY_COMMANDS };

export function answersPathFor(root: string, sessionId: string): string {
  return join(root, "handoffs", `${sessionId}.answers.md`);
}

export function findAnswerFiles(root: string, sessionId: string): string[] {
  const dir = join(root, "handoffs");
  let names: string[] = [];
  try { names = readdirSync(dir); } catch { return []; }
  return names
    .filter((name) => name === `${sessionId}.answers.md` || (name.startsWith(`${sessionId}.answers.`) && name.endsWith(".md")))
    .sort()
    .map((name) => join(dir, name));
}

export interface AnswerSection { question: number; text: string }
export interface AnswerFile { path: string; tool: string; writtenAt: string | null; sections: AnswerSection[] }

/** The file's own format: a `tool:` line, then `## Q1` … `## Q7`. */
export function parseAnswers(text: string, path: string, writtenAt: string | null = null): AnswerFile | null {
  const tool = /^\s*tool:\s*(.+)$/m.exec(text)?.[1]?.trim() ?? "unknown";
  const sections: AnswerSection[] = [];
  const re = /^##\s*Q([1-7])\b[^\n]*\n([\s\S]*?)(?=^##\s*Q[1-7]\b|$(?![\s\S]))/gm;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const body = (match[2] ?? "").trim();
    if (body) sections.push({ question: Number(match[1]), text: body });
  }
  return sections.length ? { path, tool, writtenAt, sections } : null;
}

export function readAnswerFile(path: string): AnswerFile | null {
  let text: string;
  try { text = readFileSync(path, "utf8"); } catch { return null; }
  let writtenAt: string | null = null;
  try { writtenAt = new Date(statSync(path).mtimeMs).toISOString(); } catch { writtenAt = null; }
  return parseAnswers(text, path, writtenAt);
}

export interface AnswerFacts {
  live: LiveState;
  traceBranches?: Set<string>;
  traceUrls?: Set<string>;
  git?: GitRunner;
  portReader?: (port: number) => string | null;
  lastMessageAt?: string | null;
  /** round 8 — ISO instant the answers were written; every claim is judged at that moment */
  writtenAt?: string | null;
  /** round 8 — the path checker's disk (a test seam) */
  exists?: (path: string) => boolean;
  /** round 9 — the sentence's section and the answers around it */
  scope?: ClaimScope;
  /** round 9 — a named brief's text (a test seam over readFileSync) */
  readText?: (path: string) => string | null;
  /** round 9 — what reached origin's default branch after the answers were written */
  landed?: Landed[];
  changes?: RefChange[];
}

export type Stamp = "✓" | "✗" | "?";
export interface SentenceVerdict { stamp: Stamp; text: string; detail: string | null; tokens: string[] }

export function splitAnswerSentences(text: string): string[] {
  return splitSentences(text);
}
export function verifySentence(sentence: string, facts: AnswerFacts): SentenceVerdict {
  const claims = checkClaims(sentence, facts);
  const checked = claims.filter((c) => c.checkable);
  const stamp: Stamp = checked.some((c) => c.stamp === "✗") ? "✗"
    : checked.length && checked.every((c) => c.stamp === "✓") ? "✓" : "?";
  return { stamp, text: sentence, detail: claims.map(claimLine).join(" · ") || null, tokens: checked.map((c) => c.label) };
}

/** Every stamp shows what was run and what it answered (PR #38's contract). */
export function claimLine(c: Claim): string {
  return `${c.stamp} ${c.label}${verdictSuffix(c)}${c.command ? ` — checked: ${c.command} → ${c.value ?? ""}` : c.value ? ` — ${c.value}` : ""}`;
}
/** round 8 — the verdict at the time of writing, on the stamp line itself. */
function verdictSuffix(c: Claim): string {
  if (!c.when) return "";
  if (c.when.verdict === "held") return c.when.changed ? " · held when written, changed since" : "";
  if (c.when.verdict === "false") return " · false when written";
  return " · cannot tell whether it held when written";
}
/** The stamp line, then (when the claim was judged at the time of writing) its evidence. */
export function claimLines(c: Claim): string[] {
  return c.when ? [`    ${claimLine(c)}`, `      ↳ ${whenLine(c.when)}`] : [`    ${claimLine(c)}`];
}
/**
 * round 8 — `· a645c32 exists in <repo>` is a note, not a check of anything the
 * sentence said. One sentence's notes collapse into one line, grouped by the
 * repository holding them: `· named, not checked: 6700f19, f89f3c6 (in <repo>)`.
 */
const EXISTS_NOTE_RE = /^([0-9a-f]{7,40}) exists in (.+)$/i;
export function sentenceClaimLines(claims: Claim[]): string[] {
  const lines: string[] = [];
  const byRepo = new Map<string, string[]>();
  for (const claim of claims) {
    const note = claim.stamp === "·" && !claim.command ? EXISTS_NOTE_RE.exec(claim.label) : null;
    if (note) { byRepo.set(note[2]!, [...(byRepo.get(note[2]!) ?? []), note[1]!]); continue; }
    lines.push(...claimLines(claim));
  }
  if (byRepo.size) lines.push(`    · named, not checked: ${[...byRepo].map(([repo, hashes]) => `${hashes.join(", ")} (in ${repo})`).join("; ")}`);
  return lines;
}
/**
 * round 8 — a sentence with a concrete subject (a commit, a path, a ref that a
 * `·` note located) and a predicate, which no checker could test, is a claim
 * carafe FOUND and did not check. It counts in the denominator: "6 of 11
 * claims checked", never "6 of 6".
 */
const PREDICATE_RE = /\b(?:is|are|was|were|has|have|had|contains?|returns?|reached|went|took|sits?|stops?|points?|shows?|carr(?:y|ies)|holds?|lives?|exists?|introduces?|enforces?|touch(?:es)?|collides?|stands?|remains?|landed|merged|pushed|deployed|shipped)\b/i;
export function foundNotChecked(sentence: string, claims: Claim[]): boolean {
  if (claims.some((c) => c.checkable)) return false;
  if (!claims.some((c) => c.stamp === "·")) return false;
  return PREDICATE_RE.test(sentence);
}
export interface ClaimCounts { found: number; checked: number; falseWhenWritten: number; changedSince: number }
export function countClaims(rows: Array<{ text: string; claims: Claim[] }>): ClaimCounts {
  const counts: ClaimCounts = { found: 0, checked: 0, falseWhenWritten: 0, changedSince: 0 };
  for (const { text, claims } of rows) {
    for (const c of claims) {
      if (!c.checkable) continue;
      counts.found++;
      if (c.stamp !== "?") counts.checked++;
      if (c.stamp === "✗") counts.falseWhenWritten++;
      if (c.when?.verdict === "held" && c.when.changed) counts.changedSince++;
    }
    if (foundNotChecked(text, claims)) counts.found++;
  }
  return counts;
}
/**
 * Round 9 — the header says what it covers: "0 false when written" read as a
 * verdict on the whole document, and two false sentences sat among the
 * unchecked ones. The false count is OF the checked claims, and the unchecked
 * ones are counted beside it. Path existence is counted independently from
 * unverified deployment/content predicates.
 */
export const claimsHeading = (c: ClaimCounts): string =>
  `## What the outgoing agent said (${c.checked} of ${c.found} checkable claims checked · ${c.falseWhenWritten} of ${c.checked} false when written · ${c.found - c.checked} unchecked)`;
/** Recount after the renderer removes questions to meet its size budget. */
export function refreshClaimsHeading(lines: string[]): string[] {
  if (!lines[0]?.startsWith("## What the outgoing agent said (")) return lines;
  const stamps = lines.flatMap((line) => /^    ([✓✗?]) /.exec(line)?.[1] ?? []);
  const counts: ClaimCounts = { found: stamps.length, checked: stamps.filter((s) => s !== "?").length, falseWhenWritten: stamps.filter((s) => s === "✗").length, changedSince: 0 };
  return [lines[0].replace(/^## What the outgoing agent said \([^)]*\)/, claimsHeading(counts)), ...lines.slice(1)];
}
export const STAMP_LEGEND = `✓ path exists: existence now only (not deployment or content) · ✓ held when written and still holds (checked against git) · ✓ … held when written, changed since — true then, different now (both readings shown) · ✗ false when written (git proves the opposite at that moment; the command is shown) · ? carafe could not check this, or cannot tell what held then — it says nothing about whether it is true`;
export function answerCoverage(files: AnswerFile[], facts: AnswerFacts): { found: number; checked: number; contradicted: number } {
  const rows = files.flatMap((f) => f.sections.flatMap((s) => splitAnswerSentences(s.text).map((text) => ({ text, claims: checkClaims(text, { ...facts, writtenAt: f.writtenAt }) }))));
  const counts = countClaims(rows);
  return { found: counts.found, checked: counts.checked, contradicted: counts.falseWhenWritten };
}

export interface VerifiedAnswers { file: AnswerFile; verdicts: Array<{ question: number; sentences: SentenceVerdict[] }>; counts: { ok: number; bad: number; unchecked: number } }

export function verifyAnswers(file: AnswerFile, facts: AnswerFacts): VerifiedAnswers {
  const counts = { ok: 0, bad: 0, unchecked: 0 };
  const verdicts = file.sections.map((section) => {
    const sentences = splitAnswerSentences(section.text).map((sentence) => verifySentence(sentence, { ...facts, writtenAt: file.writtenAt }));
    for (const verdict of sentences) {
      if (verdict.stamp === "✓") counts.ok++;
      else if (verdict.stamp === "✗") counts.bad++;
      else counts.unchecked++;
    }
    return { question: section.question, sentences };
  });
  return { file, verdicts, counts };
}

const stampAt = (iso: string | null): string => (iso && iso.length >= 16 ? `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC` : "unknown time");

export function answersLines(files: AnswerFile[], facts: AnswerFacts): string[] {
  if (!files.length) return [];
  // round 8 — each file's claims are judged at the moment THAT file was written;
  // round 9 — and each sentence knows its section and the one before it
  const allText = files.flatMap((file) => file.sections.map((section) => section.text)).join("\n");
  const rows = files.map((file) => ({ file, sections: file.sections.map((section) => {
    const texts = splitAnswerSentences(section.text);
    return { ...section, sentences: texts.map((text, index) => {
      const scope = { section: section.text, answers: allText, previous: texts[index - 1] };
      const claims = checkClaims(text, { ...facts, writtenAt: file.writtenAt, scope });
      if (DELTA_QUESTIONS.has(section.question)) {
        for (const note of overtakenNotes(text, facts.changes ?? [], Date.parse(file.writtenAt ?? "")))
          claims.push({ label: note.slice(2), stamp: "?", checkable: true });
      }
      return { text, claims };
    }) };
  }) }));
  // round 9 — a reserved number is re-checked once, under the sentence that
  // states it (an aside naming the same range defers to it)
  const reserved = new Map<string, number>();
  for (const { sections } of rows) for (const section of sections) for (const sentence of section.sentences) {
    for (const one of reservationsIn(sentence.text)) {
      const key = `${one.from}-${one.to}-${one.hash}`;
      if (!reserved.has(key) || one.stated) reserved.set(key, one.stated ? 1 : 0);
    }
  }
  const noted = new Set<string>();
  const counts = countClaims(rows.flatMap((r) => r.sections.flatMap((s) => s.sentences)));
  const nothingReadable = !facts.live.repos.some((repo) => !repo.notChecked);
  const lines = [`${claimsHeading(counts)}${nothingReadable ? " (no repository readable; nothing verified)" : ""}`, "", STAMP_LEGEND, ""];
  for (const { file, sections } of rows) {
    const age = Date.parse(facts.lastMessageAt ?? "") - Date.parse(file.writtenAt ?? "");
    lines.push(`${file.tool}, written ${stampAt(file.writtenAt)}${age > 30 * 60_000 ? ` (written ${beforeEnd(age)} before the session's last message)` : ""}`, "");
    const writtenAt = Date.parse(file.writtenAt ?? "");
    for (const section of [...sections].sort((a, b) => ([1, 5, 2, 3, 4, 6, 7].indexOf(a.question) - [1, 5, 2, 3, 4, 6, 7].indexOf(b.question)))) {
      lines.push(`### Q${section.question}. ${HANDOFF_QUESTIONS[section.question - 1] ?? ""}`, "");
      const body: string[] = [];
      let superseded = 0;
      for (const [index, sentence] of section.sentences.entries()) {
        body.push(...sentence.text.split("\n").map((l) => `> ${l}`));
        body.push(...sentenceClaimLines(sentence.claims));
        if (foundNotChecked(sentence.text, sentence.claims)) body.push("    ? claim not checked beyond locating the named objects");
        // round 9 — what landed since, on the sentence that calls it in flight
        const landed = DELTA_QUESTIONS.has(section.question) && facts.landed?.length ? landedNotes(sentence.text, facts.landed) : [];
        if (landed.length) superseded++;
        body.push(...landed.map((note) => `    ${note}`));
        if (Number.isFinite(writtenAt)) {
          const own = reservationsIn(sentence.text).filter((one) => { const key = `${one.from}-${one.to}-${one.hash}`; return !noted.has(key) && reserved.get(key) === (one.stated ? 1 : 0); });
          if (own.length) {
            for (const one of own) noted.add(`${one.from}-${one.to}-${one.hash}`);
            const notes = collisionNotes(sentence.text, { live: facts.live, git: facts.git ?? realGitRunner, writtenAt, scope: { section: section.text, answers: allText, previous: section.sentences[index - 1]?.text } });
            body.push(...notes.map((note) => `    ${note}`));
          }
        }
      }
      // round 9 — the first-move list says at its top when part of it is overtaken
      if (section.question === 5 && superseded) {
        const refs = [...new Set((facts.landed ?? []).map((one) => one.ref))];
        lines.push(`_↳ ${superseded} of ${section.sentences.length} ${section.sentences.length === 1 ? "item" : "items"} below ${superseded === 1 ? "names" : "name"} work that has since landed on ${refs.length === 1 ? refs[0] : "origin's default branch"}: check whether ${superseded === 1 ? "it is" : "they are"} already done before acting._`, "");
      }
      lines.push(...body, "");
    }
  }
  // Two tools answering is the cheapest cross-check there is: where one is
  // contradicted on a claim the other is verified on, the file says so.
  if (rows.length > 1) {
    const disagreements: string[] = [];
    for (const row of rows) {
      for (const section of row.sections) for (const sentence of section.sentences) {
        for (const claim of sentence.claims) {
          if (claim.stamp !== "✗") continue;
          const agrees = rows.some((other) => other !== row && other.sections.some((s) => s.sentences.some((t) => t.claims.some((c) => c.stamp === "✓" && c.command != null && c.command === claim.command))));
          if (agrees) disagreements.push(`- ${row.file.tool}: "${sentence.text}" — ${claimLine(claim)}`);
        }
      }
    }
    if (disagreements.length) lines.push(`Disagreements:`, ``, ...disagreements, ``);
  }
  return lines;
}

export function questionsText(root: string, sessionId: string): string {
  return [
    `Answer these seven questions and write them to:`,
    ``,
    `  ${answersPathFor(root, sessionId)}`,
    ``,
    `Format: a first line "tool: claude-code" (or codex, or whatever you are), then`,
    `one "## Q1" … "## Q7" heading per answer, with free prose under each.`,
    ``,
    ...HANDOFF_QUESTIONS.map((question, index) => `## Q${index + 1}. ${question}`),
    ``,
    `carafe checks the mechanically recognizable claims in what you write against`,
    `read-only local commands, judged at the moment you wrote them: ✓ held when`,
    `written (and "changed since" when the world moved afterwards), ✗ false when`,
    `written (with the command and the observed value), ? not checked — which says`,
    `nothing about whether it is true. Guessing is worse than omitting.`,
    ``,
  ].join("\n");
}
