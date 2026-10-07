/** Release acceptance gate: read the local store; build only in memory. */
import type { SessionDistillate } from "../format/distillate";
import { CarafeStore } from "../format/store";
import { readSession } from "../format/sessions";
import { findSession, helperSessionsOf, isNoise, isSpawned, listSessions, siblingSessions } from "../query/sessions";
import { HANDOFF_MAX_BYTES, HANDOFF_MAX_LINES, agentLabel, preparedPieces, renderHandoff, type HelperTrace, type RenderResult } from "../handoff/render";
import type { EventPieces } from "../handoff/pieces";
import { findAnswerFiles, readAnswerFile, type AnswerFile } from "../handoff/answers";
import { realGitRunner, checkRepo, type GitRunner } from "../handoff/live";
import type { CarafeEvent } from "../format/events";
import { commandSegments, expandCommandVars } from "../handoff/worktrees";
import { boundCalls } from "../handoff/calls";
import { existsSync } from "fs";
import { basename, isAbsolute, resolve } from "path";

export interface RealRow {
  session: string; tool: string; printed: number; rehomed: number; dropped: number;
  falseStatements: string[]; badQuotes: string[]; found: number; checked: number; contradicted: number; answers: number;
  stampsChecked: number; stampsSkipped: number; excerpts: number;
  lines: number; bytes: number; stubs: number; failures: string[]; ms: number;
}
export interface RealCard { sessions: RealRow[]; total: Omit<RealRow, "session" | "tool">; ok: boolean }

/**
 * Everything carafe wrote in its own voice: the file minus the verbatim trace.
 * Two shapes carry a trace — the layered tail, and the full tier, whose whole
 * body after the `---` separator is the trace itself.
 */
export function outsideTail(text: string): string {
  return text
    .replace(/^## The tail, verbatim[^\n]*\n[\s\S]*?(?=^## Dig deeper\b|$(?![\s\S]))/m, "")
    .replace(/^_Faithful full trace\.[^\n]*\n[\s\S]*$/m, "");
}

/**
 * The lines carafe AUTHORED, as opposed to the trace text it carries: quotation
 * lines, their `[seq N]` anchors and indented trace excerpts are the outgoing
 * session's own words, and a `$VAR` in them is source text, not a leak.
 *
 * An ANCHORED EXCERPT (see `anchoredExcerpts`) is authored only in its frame —
 * the label, carafe's own notes, the anchor — and the excerpt inside it is
 * replaced by a placeholder. It is not left unchecked: `verifyAnchoredExcerpts`
 * finds every one of them in the event its anchor names.
 */
export function authoredLines(text: string): string[] {
  const out: string[] = [];
  let quoting = false;
  const lines = outsideTail(text).split("\n");
  const entries = new Map(anchoredExcerpts(text).map((entry) => [entry.line, entry]));
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const entry = entries.get(i);
    if (entry) { out.push(entry.residue); i += entry.lines - 1; quoting = false; continue; }
    if (/^\[seq \d+\]$/.test(line)) { quoting = true; continue; }
    if (line.startsWith(">")) continue;
    if (quoting && (line.startsWith("    ") || line.startsWith("\t"))) continue;
    if (line.trim() === "") { quoting = false; continue; }
    out.push(line);
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Anchored excerpts — trace text printed on a list line that ends in the
 * anchor of the event it came from:
 *
 *   `  [seq N]`, `  [seq N-M]`, `  [seq N, <date> UTC, …]`, `  [agent-XXXX seq N]`
 *
 * The rule is by SHAPE, per section, never "any line with a bracket":
 *
 *   Key moments   `- <label>: <excerpt>[ → <excerpt or carafe note>]…  [anchor]`
 *                 (label: steering, finding, dead end, breakthrough, rule,
 *                 decision, commit, pr, wip, openask, instruction, goal, or
 *                 `recap (asked "<excerpt>")`). The body may run over several
 *                 lines — a tool result with newlines — up to the anchor.
 *                 Carafe's notes (`explicit reversal`, `removed|reverted at seq
 *                 N`, `restated ×N (seq …)`, the `after N failed runs of` and
 *                 `then: "…"` frames, a `pr-link #N` prefix, a commit's
 *                 ` (hash)`) stay carafe's words.
 *   Lessons       `- <date> · dead end|breakthrough: <excerpt>  [anchor]`
 *   What this is, Standing instructions, Do not
 *                 `- "<excerpt>"[ (the assistant's rule)|( said after an
 *                 incident [seq N])][ (said <date>; may have lapsed)]  [anchor]`
 *   Glossary      `- <term> (N turns): "<excerpt>"  [anchor]`
 *   File map      `  - <path> (<touches>): "<excerpt>"  [anchor]`
 *   Waiting on the owner
 *                 `- <excerpt>[ (said <date>; may have lapsed)]  [anchor]` and
 *                 `  after you said: "<excerpt>"  [anchor]`
 *   Notes         `- goal (first prompt): <excerpt>  [anchor]`
 *
 * A line of these sections that does not have its section's shape — or an
 * entry that never reaches its anchor — stays carafe's own prose.
 * ------------------------------------------------------------------ */

export interface AnchoredExcerpt {
  section: string;
  /** index of the entry's first line in `outsideTail(text).split("\n")` */
  line: number;
  /** how many printed lines the entry spans */
  lines: number;
  /** the helper agent label the anchor names, or null for the main trace */
  via: string | null;
  seq: number;
  /** the verbatim excerpts the entry carries (each may carry the clip marker …) */
  segments: string[];
  /** the entry with every excerpt replaced: the words carafe wrote itself */
  residue: string;
  text: string;
}

const EXCERPT_ANCHOR_RE = /  \[(?:agent-([0-9A-Za-z]+) )?seq (\d+)(?:[-–]\d+)?(?:, [^\]\n]*)?\]$/;
const EXCERPT_PLACEHOLDER = "‹excerpt›";
const KM_LABEL = String.raw`steering|finding|dead end|breakthrough|rule|decision|commit|pr|wip|openask|instruction|goal|recap \(asked "`;
const LAPSED = String.raw`(?: \(said \d{4}-\d\d-\d\d; may have lapsed\))?`;

type Piece = { excerpt: string } | { authored: string };
interface ExcerptShape { section: RegExp; start: RegExp; parse: (body: string) => Piece[] | null }

/** A Key moments body: segments joined by ` → `, each an excerpt or one of carafe's notes. */
function momentPieces(body: string): Piece[] | null {
  const m = new RegExp(String.raw`^(- (${KM_LABEL.replace(/\|recap.*$/, "")}): |- recap \(asked ")`).exec(body);
  if (!m) return null;
  const out: Piece[] = [{ authored: m[1]! }];
  let rest = body.slice(m[1]!.length);
  const label = m[2] ?? "recap";
  if (label === "recap") {
    const close = rest.indexOf(`"): `);
    if (close < 0) return null;
    out.push({ excerpt: rest.slice(0, close) }, { authored: `"): ` });
    rest = rest.slice(close + 4);
  }
  rest.split(" → ").forEach((segment, index) => {
    if (index) out.push({ authored: " → " });
    let s: RegExpExecArray | null;
    if (/^(?:explicit reversal|(?:removed|reverted) at seq \d+|restated ×\d+ \(seq [\d, ]+\))$/.test(segment)) out.push({ authored: segment });
    else if ((s = /^(after \d+ failed runs? of )([\s\S]+)$/.exec(segment))) out.push({ authored: s[1]! }, { excerpt: s[2]! });
    else if ((s = /^(then: ")([\s\S]*)(")$/.exec(segment))) out.push({ authored: s[1]! }, { excerpt: s[2]! }, { authored: s[3]! });
    else if (index === 0 && label === "pr" && (s = /^(pr-link #\d+ )(\S+)$/.exec(segment))) out.push({ authored: s[1]! }, { excerpt: s[2]! });
    else if (index === 0 && label === "commit" && (s = /^([\s\S]+)( \()([0-9a-f]{7,40})(\))$/.exec(segment))) out.push({ excerpt: s[1]! }, { authored: s[2]! }, { excerpt: s[3]! }, { authored: s[4]! });
    else out.push({ excerpt: segment });
  });
  return out;
}

/** `<open><excerpt><close>` where open and close are carafe's frame. */
function framed(re: RegExp): (body: string) => Piece[] | null {
  return (body) => {
    const m = re.exec(body);
    return m ? [{ authored: m[1]! }, { excerpt: m[2]! }, { authored: m[3] ?? "" }] : null;
  };
}

const EXCERPT_SHAPES: ExcerptShape[] = [
  { section: /^## Key moments\b/, start: new RegExp(String.raw`^- (?:${KM_LABEL})`), parse: momentPieces },
  { section: /^## Lessons\b/, start: /^- (?:\d{4}-\d\d-\d\d|date not recorded) · (?:dead end|breakthrough): /, parse: framed(/^(- (?:\d{4}-\d\d-\d\d|date not recorded) · (?:dead end|breakthrough): )([\s\S]+)()$/) },
  { section: /^## (?:What this is|Standing instructions|Do not)\b/, start: /^- "/, parse: framed(new RegExp(String.raw`^(- ")([\s\S]*)("(?: \((?:the assistant's rule|said after an incident \[seq \d+\])\))?${LAPSED})$`)) },
  { section: /^## Glossary\b/, start: /^- .+? \(\d+ turns?\): "/, parse: framed(/^(- .+? \(\d+ turns?\): ")([\s\S]*)(")$/) },
  { section: /^## File map\b/, start: /^  - .+?: "/, parse: framed(/^(  - .+?: ")([\s\S]*)(")$/) },
  { section: /^## Waiting on the owner\b/, start: /^  after you said: "/, parse: framed(/^(  after you said: ")([\s\S]*)(")$/) },
  { section: /^## Waiting on the owner\b/, start: /^- \S/, parse: framed(new RegExp(String.raw`^(- )([\s\S]+?)(${LAPSED})$`)) },
  { section: /^## Notes\b/, start: /^- goal \(first prompt\): \S/, parse: framed(/^(- goal \(first prompt\): )([\s\S]+)()$/) },
];

const TURN_LINE_RE = /^  - \[seq (\d+)[–-](\d+)\] (.+)$/;
/**
 * The turn's own first line, out of `<first line>[ · N tools][ · files] · <weight>`.
 * `(session start)` is carafe's placeholder, not trace text.
 */
export function turnLineExcerpt(rest: string): string | null {
  let body = rest.replace(/ · \d+(?:\.\d)?[KM]?$/, "");
  body = body.replace(/ · \d+ tools(?: · [^·]+)?$/, "");
  return body && body !== "(session start)" ? body : null;
}

/** Every anchored excerpt the file prints, by the shapes above. */
export function anchoredExcerpts(text: string): AnchoredExcerpt[] {
  const lines = outsideTail(text).split("\n");
  const out: AnchoredExcerpt[] = [];
  let section = "";
  const shapeAt = (i: number): ExcerptShape | undefined => EXCERPT_SHAPES.find((shape) => shape.section.test(section) && shape.start.test(lines[i]!));
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.startsWith("## ")) { section = lines[i]!; continue; }
    // round 9 — a Key moments turn line carries its anchor FIRST:
    // `  - [seq A–B] <the turn's first line> · N tools · files · weight`
    const turn = /^Key moments/.test(section.slice(3)) ? TURN_LINE_RE.exec(lines[i]!) : null;
    if (turn) {
      const excerpt = turnLineExcerpt(turn[3]!);
      if (excerpt) {
        const at = turn[3]!.indexOf(excerpt);
        out.push({ section, line: i, lines: 1, via: null, seq: Number(turn[1]), segments: [excerpt], residue: `  - [seq ${turn[1]}–${turn[2]}] ${EXCERPT_PLACEHOLDER}${turn[3]!.slice(at + excerpt.length)}`, text: lines[i]! });
      }
      continue;
    }
    const shape = shapeAt(i);
    if (!shape) continue;
    // the body runs up to the first line that ends in an anchor; a heading or
    // the next entry first means this line is not an anchored excerpt
    let end = -1;
    for (let j = i; j < lines.length && j < i + 80; j++) {
      if (j > i && (lines[j]!.startsWith("#") || shapeAt(j))) break;
      if (EXCERPT_ANCHOR_RE.test(lines[j]!)) { end = j; break; }
    }
    if (end < 0) continue;
    const printed = lines.slice(i, end + 1).join("\n");
    const anchor = EXCERPT_ANCHOR_RE.exec(printed)!;
    const pieces = shape.parse(printed.slice(0, anchor.index));
    if (!pieces?.some((piece) => "excerpt" in piece)) continue;
    out.push({
      section, line: i, lines: end - i + 1, via: anchor[1] ?? null, seq: Number(anchor[2]),
      segments: pieces.flatMap((piece) => ("excerpt" in piece ? [piece.excerpt] : [])),
      residue: pieces.map((piece) => ("excerpt" in piece ? EXCERPT_PLACEHOLDER : piece.authored)).join("") + anchor[0],
      text: printed,
    });
    i = end;
  }
  return out;
}

const normalize = (s: string): string => s.replace(/\s+/g, " ").trim();
/** A tool call's input is JSON in the trace; the moment printed its value. */
/** One pass, left to right, so an escaped backslash before an `n` stays a
 *  backslash and an `n` (round 9: a command running `tr` on a newline read as
 *  a fabricated excerpt when the escapes were undone one kind at a time). */
const jsonUnescaped = (s: string): string => s.replace(/\\(u[0-9a-fA-F]{4}|["\\/bfnrt])/g, (_, c: string) =>
  c[0] === "u" ? String.fromCharCode(parseInt(c.slice(1), 16)) : "nrt".includes(c) ? " " : "bf".includes(c) ? "" : c);
/**
 * The text with the renderer's formatting-only rewrites undone on both sides:
 * the markers the sentence extractor strips from a quoted sentence (bold,
 * backticks, `_emphasis_` — keymoments/sentences `cleanSentence`), and the
 * ` ; ` a flattened shell command writes for a newline (keymoments/signals
 * `commandOf`). A word dropped or added is still a mismatch.
 */
const loose = (s: string): string => normalize(s.replace(/\*\*/g, "").replace(/`/g, "").replace(/(^|\s)_([^_]+)_(?=\s|$)/g, "$1$2").replace(/\s*;\s*/g, " "));

interface Haystack { plain: string; loose: string[] }
function haystackOf(piece: EventPieces): Haystack {
  const raw = piece.lines.join("\n");
  return { plain: normalize(raw), loose: [loose(raw), loose(jsonUnescaped(raw))] };
}

/**
 * An excerpt occurs in an event when every run of it between clip markers (…)
 * occurs there, whitespace collapsed — as printed, or in the loose form above
 * (against the event's text and its JSON-unescaped text). Three renderer
 * framings are allowed for: a tool moment prints `<Tool>: <value>`, an edit
 * prints `<path> — <content>`, and a decision joins its answers with ` · ` and
 * may end ` (+N more)`.
 */
function excerptIn(excerpt: string, hay: Haystack): boolean {
  const runIn = (run: string): boolean => {
    if (hay.plain.includes(run)) return true;
    const bare = loose(run);
    return bare !== "" && hay.loose.some((one) => one.includes(bare));
  };
  const all = (s: string): boolean => { const runs = s.split("…").map(normalize).filter(Boolean); return runs.length > 0 && runs.every(runIn); };
  const unToolled = (s: string): string | null => /^[A-Za-z][\w.-]*: ([\s\S]+)$/.exec(s)?.[1] ?? null;
  const one = (s: string): boolean => all(s) || ((rest) => rest != null && all(rest))(unToolled(s));
  if (one(excerpt)) return true;
  const body = unToolled(excerpt) ?? excerpt;
  for (const joiner of [" · ", " — "]) {
    const parts = body.replace(/ \(\+\d+ more\)$/, "").split(joiner);
    if (parts.length > 1 && parts.every(one)) return true;
  }
  return false;
}

export interface ExcerptAudit { failures: string[]; checked: number }

/**
 * Every anchored excerpt is found in the trace its anchor names — the main
 * trace, or the helper `agent-XXXX` — and at least one of its excerpts is in
 * the anchored event itself. An entry with ONE excerpt (a finding, a lesson, a
 * quoted instruction) must therefore be in exactly the event it cites. The
 * others the renderer composes from neighbouring events (a steer and the reply
 * that followed it, a failure and the run that finally passed): each part must
 * still be verbatim trace text of that same trace. Deliberately independent of
 * the renderer: it re-reads the pieces and knows only the printed shapes.
 *
 * `traces` maps "" to the main trace and each helper label to its trace(s). A
 * label two helpers share (Codex ids that begin with the same timestamp) is
 * ambiguous on the page; the entry passes when one of those traces holds it.
 */
export function verifyAnchoredExcerpts(text: string, traces: Map<string, EventPieces[][]>): ExcerptAudit {
  const audit: ExcerptAudit = { failures: [], checked: 0 };
  const hay = new Map<EventPieces, Haystack>();
  const haystackFor = (piece: EventPieces): Haystack => {
    let h = hay.get(piece);
    if (!h) { h = haystackOf(piece); hay.set(piece, h); }
    return h;
  };
  const bySeq = new Map<EventPieces[], Map<number, EventPieces>>();
  const eventAt = (pieces: EventPieces[], seq: number): EventPieces | undefined => {
    if (!bySeq.has(pieces)) bySeq.set(pieces, new Map(pieces.map((piece) => [piece.seq, piece])));
    return bySeq.get(pieces)!.get(seq);
  };
  /** why the entry does not hold in this one trace, or null when it does */
  const checkIn = (entry: AnchoredExcerpt, pieces: EventPieces[], where: string, shown: string): string | null => {
    const anchored = eventAt(pieces, entry.seq);
    if (!anchored) return `excerpt anchored to an event that is not in the trace [${where}]: ${shown}`;
    const inAnchored = entry.segments.map((segment) => excerptIn(segment, haystackFor(anchored)));
    if (!inAnchored.some(Boolean)) return `excerpt is not in the event it is anchored to [${where}]: ${shown}`;
    const missing = entry.segments.find((segment, index) => !inAnchored[index] && !pieces.some((piece) => excerptIn(segment, haystackFor(piece))));
    return missing == null ? null : `excerpt is not in the trace [${where}]: ${normalize(missing).slice(0, 100)}`;
  };
  for (const entry of anchoredExcerpts(text)) {
    audit.checked++;
    const where = entry.via ? `agent-${entry.via} seq ${entry.seq}` : `seq ${entry.seq}`;
    const shown = normalize(entry.text).slice(0, 100);
    const candidates = traces.get(entry.via ?? "") ?? [];
    if (!candidates.length) { audit.failures.push(`excerpt anchored to a trace the gate cannot read [${where}]: ${shown}`); continue; }
    const reasons = candidates.map((pieces) => checkIn(entry, pieces, where, shown));
    if (!reasons.includes(null)) audit.failures.push(reasons[0]!);
  }
  return audit;
}

/**
 * The sections whose `- repo \`…\`` lines are carafe's machine facts. Anywhere
 * else a line may start `- repo ` for another reason — a Glossary entry for the
 * word "repo" (`- repo (49 turns): "…"`) is prose, not a fact to re-verify.
 */
const FACT_SECTION_RE = /^## (?:Right now|Last seen)\b/;

/* ------------------------------------------------------------------ *
 * Round 8 — three more classes of statement the gate re-derives itself.
 *
 * 1. A freshness label: `(local ref, updated today 11:08 UTC by push)` is
 *    read back from the ref's own reflog, newest entry, and must agree on
 *    the day, the clock and the operation.
 * 2. A push filed under a repository: `pushed: x`, `rejected push: x` and
 *    `for x: subject · subject` in EVERY section, not only `- repo` lines.
 *    The ref must resolve in that repository and each subject must be on it.
 * 3. A "Since the agent wrote this" line: what it says is now must be so.
 * Nothing here is imported from the producer.
 * ------------------------------------------------------------------ */

/** The newest reflog entry of a ref, read by the gate itself. */
function newestReflog(git: GitRunner, repo: string, ref: string): { at: number; message: string } | null {
  const out = git(["-C", repo, "reflog", "show", "--date=unix", "--format=%H%x09%gd%x09%gs", ref], 5000);
  const first = out?.split("\n").find((line) => line.trim());
  if (!first) return null;
  const [, selector, ...rest] = first.split("\t");
  const at = /@\{(\d+)\}$/.exec(selector ?? "")?.[1];
  return at ? { at: Number(at) * 1000, message: rest.join("\t").trim() } : null;
}
/** The operation a reflog message records, in the gate's own words. */
function gateHowMoved(message: string): string {
  const known = ["push", "fetch", "pull", "clone", "commit", "merge", "reset", "rebase", "checkout", "branch"];
  if (/^update by push/.test(message)) return "push";
  return known.find((word) => new RegExp(`^${word}\\b`).test(message)) ?? (message.split(":")[0]!.trim().slice(0, 24) || "update");
}
const FRESHNESS_RE = /\((?:local ref, )?(updated (?:today (\d\d:\d\d) UTC|(\d{4}-\d\d-\d\d) (\d\d:\d\d) UTC) by ([^,)]+)(?:, [^)]*)?|no reflog here, so when it was last updated is unknown)\)/g;

/** Every freshness label on a Right now line, re-derived from the reflog. */
export function verifyFreshness(line: string, repo: string, checkedDay: string | null, git: GitRunner): string[] {
  const failures: string[] = [];
  // round 8 — "last fetched N ago" came from FETCH_HEAD's mtime, which a push
  // never touches: the label class itself is a false statement
  if (/\blast fetched\b/.test(line)) failures.push(`freshness label read from FETCH_HEAD: ${repo}`);
  // the ref the label is about is the token before ` at <hash>` or after `upstream `
  const refs: Array<{ ref: string; index: number }> = [];
  for (const m of line.matchAll(/(?:^|· )upstream (\S+): /g)) refs.push({ ref: m[1]!, index: m.index! });
  for (const m of line.matchAll(/(?:^|· )(\S+) at [0-9a-f]{7,40}(?: "[^"]*")? \(local ref, /g)) refs.push({ ref: m[1]!, index: m.index! });
  for (const m of line.matchAll(FRESHNESS_RE)) {
    const owner = refs.filter((one) => one.index < m.index!).sort((a, b) => b.index - a.index)[0];
    if (!owner) { failures.push(`freshness label with no ref: ${m[0]}`); continue; }
    const newest = newestReflog(git, repo, `refs/remotes/${owner.ref}`);
    if (m[1]!.startsWith("no reflog")) { if (newest) failures.push(`label says no reflog, the ref has one: ${owner.ref} in ${repo}`); continue; }
    if (!newest) { failures.push(`label says updated, the ref has no reflog: ${owner.ref} in ${repo}`); continue; }
    const iso = new Date(newest.at).toISOString();
    const day = m[3] ?? checkedDay, clock = m[2] ?? m[4];
    if (day !== iso.slice(0, 10) || clock !== iso.slice(11, 16) || m[5] !== gateHowMoved(newest.message)) {
      failures.push(`freshness label does not match the reflog: ${owner.ref} in ${repo} — printed "${m[1]}", reflog ${iso.slice(0, 16)} by ${gateHowMoved(newest.message)}`);
    }
  }
  return failures;
}

const resolvesIn = (git: GitRunner, repo: string, ref: string): boolean =>
  git(["-C", repo, "rev-parse", "--verify", "--quiet", `${ref}^{commit}`], 5000) != null
  || git(["-C", repo, "rev-parse", "--verify", "--quiet", `refs/remotes/origin/${ref}^{commit}`], 5000) != null;
const ancestorIn = (git: GitRunner, repo: string, hash: string, of: string): boolean => git(["-C", repo, "merge-base", "--is-ancestor", hash, of], 5000) != null;

/** `pushed: x`, `rejected push: x`, `for x: a · b` — under the repository they are filed in. */
export function verifyPushLine(line: string, repo: string | null, git: GitRunner): string[] {
  const failures: string[] = [];
  const named = [...line.matchAll(/\b(?:pushed|rejected push): (\S+)/g)].map((m) => m[1]!);
  const purpose = /^\s+for (\S+): (.*?)\s+\[seq \d+\]$/.exec(line);
  if (!named.length && !purpose) return failures;
  if (!repo) { failures.push(`push filed under no repository: ${line.trim().slice(0, 80)}`); return failures; }
  for (const ref of named) if (!resolvesIn(git, repo, ref)) failures.push(`pushed ref does not resolve in the repository it is filed under: ${ref} in ${repo}`);
  if (purpose) {
    const ref = purpose[1]!;
    if (!resolvesIn(git, repo, ref)) { failures.push(`branch does not resolve in the repository it is filed under: ${ref} in ${repo}`); return failures; }
    const target = git(["-C", repo, "rev-parse", "--verify", "--quiet", `${ref}^{commit}`], 5000) != null ? ref : `refs/remotes/origin/${ref}`;
    // a changelog row (`| 12 | … |`) is a quote, not a list of commits on the branch
    if (purpose[2]!.trim().startsWith("|")) return failures;
    const log = new Set((git(["-C", repo, "log", "--format=%s", "-n", "500", target], 5000) ?? "").split("\n").map((one) => one.trim()));
    for (const subject of purpose[2]!.split(" · ").map((one) => one.trim()).filter((one) => one && !one.startsWith("refs/"))) {
      if (!log.has(subject)) failures.push(`commit listed for ${ref} is not on it in ${repo}: ${subject.slice(0, 60)}`);
    }
  }
  return failures;
}

/**
 * The value a ref held at a minute printed as `YYYY-MM-DD HH:MM UTC`, from its
 * reflog, read by the gate itself. null when the reflog does not say, or when
 * an entry falls inside that minute (the printed time cannot tell them apart).
 */
export function gateValueAt(git: GitRunner, repo: string, ref: string, minuteMs: number): string | null {
  const out = git(["-C", repo, "reflog", "show", "--date=unix", "--format=%H%x09%gd", ref], 5000);
  if (out == null) return null;
  const entries = out.split("\n").map((line) => line.split("\t")).flatMap(([hash, selector]) => {
    const at = /@\{(\d+)\}$/.exec(selector ?? "")?.[1];
    return hash && at ? [{ hash, at: Number(at) * 1000 }] : [];
  });
  if (entries.some((entry) => entry.at >= minuteMs && entry.at < minuteMs + 60_000)) return null;
  return entries.find((entry) => entry.at < minuteMs)?.hash ?? null;
}

/**
 * Round 9 — "landed on <ref> <minute> UTC via <commit>": the ref's own reflog
 * has an entry in that minute moving it to that commit, the commit is on the
 * ref now, and each named commit is in it — and was NOT on the ref when the
 * answers were written.
 */
export function verifyLanding(git: GitRunner, repo: string, ref: string, minuteIso: string, via: string, hashes: string[], writtenMinute: number | null): string[] {
  const failures: string[] = [];
  const full = `refs/remotes/${ref}`;
  const minute = Date.parse(minuteIso);
  const out = git(["-C", repo, "reflog", "show", "--date=unix", "--format=%H%x09%gd", full], 5000);
  const entries = (out ?? "").split("\n").map((line) => line.split("\t")).flatMap(([hash, selector]) => {
    const at = /@\{(\d+)\}$/.exec(selector ?? "")?.[1];
    return hash && at ? [{ hash, at: Number(at) * 1000 }] : [];
  });
  if (!entries.some((entry) => entry.hash.startsWith(via) && entry.at >= minute && entry.at < minute + 60_000)) failures.push(`landing: ${ref} did not move to ${via} at ${minuteIso.slice(0, 16)} in ${repo}`);
  if (!ancestorIn(git, repo, via, full)) failures.push(`landing: ${via} is not on ${ref} in ${repo}`);
  const then = writtenMinute == null ? null : gateValueAt(git, repo, full, writtenMinute);
  for (const hash of hashes) {
    if (!ancestorIn(git, repo, hash, via)) failures.push(`landing: ${hash} is not in ${via} (${repo})`);
    if (then && ancestorIn(git, repo, hash, then)) failures.push(`landing: ${hash} was already on ${ref} when the answers were written (${repo})`);
  }
  return failures;
}

/** A "Since the agent wrote this" line: what it states as now, and as then, re-read. */
export function verifySinceLine(line: string, repo: string, git: GitRunner, sinceAt: number | null = null): string[] {
  const failures: string[] = [];
  const body = line.trim();
  const refOf = (ref: string): string => git(["-C", repo, "rev-parse", "--verify", "--quiet", `refs/remotes/${ref}^{commit}`], 5000) != null ? `refs/remotes/${ref}` : `refs/heads/${ref}`;
  // what a line says the ref held THEN must be what its reflog says
  const thenIs = (path: string, ref: string, expected: string): void => {
    if (sinceAt == null) return;
    const then = gateValueAt(git, path, ref, sinceAt);
    if (then && !then.startsWith(expected)) failures.push(`since: ${ref} was ${then.slice(0, 7)} when the answers were written, not ${expected} (${path})`);
  };
  const fullRef = (ref: string): string => git(["-C", repo, "rev-parse", "--verify", "--quiet", `refs/remotes/${ref}^{commit}`], 5000) != null ? `refs/remotes/${ref}` : `refs/heads/${ref}`;
  const nowOf = (ref: string): string | null => git(["-C", repo, "rev-parse", "--verify", "--quiet", `${fullRef(ref)}^{commit}`], 5000)?.trim() ?? null;
  let m: RegExpExecArray | null;
  if ((m = /^worktree (\/.+?): HEAD (?:moved [0-9a-f]{7} → ([0-9a-f]{7})|has not moved \(([0-9a-f]{7})\))/.exec(body))) {
    const head = git(["-C", m[1]!, "rev-parse", "HEAD"], 5000)?.trim();
    const expected = m[2] ?? m[3];
    if (!head || !head.startsWith(expected!)) failures.push(`since: worktree HEAD is not ${expected}: ${m[1]}`);
    const was = /HEAD moved ([0-9a-f]{7}) →/.exec(body)?.[1];
    if (was) thenIs(m[1]!, "HEAD", was);
  } else if ((m = /^(\S+) moved ([0-9a-f]{7}) → ([0-9a-f]{7})\b/.exec(body))) {
    const now = nowOf(m[1]!);
    if (!now || !now.startsWith(m[3]!)) failures.push(`since: ${m[1]} is not at ${m[3]} in ${repo}`);
    thenIs(repo, refOf(m[1]!), m[2]!);
    // round 9 — "; <newer head> is on origin/main too (landed <minute> UTC via <commit>)"
    const too = /; ([0-9a-f]{7,40}) is on (\S+) too \(landed (\d{4}-\d\d-\d\d) (\d\d:\d\d) UTC via ([0-9a-f]{7,40})\)/.exec(body);
    if (too) failures.push(...verifyLanding(git, repo, too[2]!, `${too[3]}T${too[4]}:00Z`, too[5]!, [too[1]!], sinceAt));
  } else if ((m = /^([0-9a-f]{7,40}(?:, [0-9a-f]{7,40})*)(?: \([^)]*\))? (?:is|are) now on (\S+)/.exec(body))) {
    const ref = fullRef(m[2]!);
    const then = sinceAt == null ? null : gateValueAt(git, repo, ref, sinceAt);
    for (const hash of m[1]!.split(", ")) {
      if (!ancestorIn(git, repo, hash, ref)) failures.push(`since: ${hash} is not on ${m[2]} in ${repo}`);
      // "now on" says it was NOT on it when the answers were written
      if (then && ancestorIn(git, repo, hash, then)) failures.push(`since: ${hash} was already on ${m[2]} when the answers were written (${repo})`);
    }
  } else if ((m = /^([0-9a-f]{7,40}) is on (\S+) now;/.exec(body))) {
    if (!ancestorIn(git, repo, m[1]!, fullRef(m[2]!))) failures.push(`since: ${m[1]} is not on ${m[2]} in ${repo}`);
  } else if ((m = /^([0-9a-f]{7,40}) was on (\S+) when the answers were written and is not now/.exec(body))) {
    if (ancestorIn(git, repo, m[1]!, fullRef(m[2]!))) failures.push(`since: ${m[1]} is on ${m[2]} in ${repo}`);
  } else if ((m = /^(\S+) has not moved \(([0-9a-f]{7})\)/.exec(body))) {
    const now = nowOf(m[1]!);
    if (!now || !now.startsWith(m[2]!)) failures.push(`since: ${m[1]} is not at ${m[2]} in ${repo}`);
  } else if ((m = /^(\S+) reports ([0-9a-f]{7,40})(?:, which contains ([^;]+?))?(?:(?:, | and )which does not contain (.+?))?$/.exec(body))) {
    for (const hash of (m[3] ?? "").split(", ").map((one) => one.trim()).filter(Boolean)) if (!ancestorIn(git, repo, hash, m[2]!)) failures.push(`since: ${hash} is not in ${m[2]}`);
    for (const hash of (m[4] ?? "").split(", ").map((one) => one.trim()).filter(Boolean)) if (ancestorIn(git, repo, hash, m[2]!)) failures.push(`since: ${hash} is in ${m[2]}`);
  }
  return failures;
}

/** Independent parsing AND verification. Deliberately does not import audit.ts. */
export function verifyPrintedText(text: string, git: GitRunner = realGitRunner): string[] {
  const failures: string[] = [];
  let inAnswers = false;
  let inFacts = false;
  let inRightNow = false, inLastSeen = false, inSince = false, inShipped = false;
  let checkedDay: string | null = null;
  let sinceAt: number | null = null;
  // the repository the current block is filed under, in the sections that file things under one
  let blockRepo: string | null = null;
  for (const line of outsideTail(text).split("\n")) {
    if (line.startsWith("## ")) {
      inAnswers = line.startsWith("## What the outgoing agent said");
      inFacts = FACT_SECTION_RE.test(line);
      inRightNow = line.startsWith("## Right now (checked at");
      inLastSeen = line.startsWith("## Last seen in the session");
      inSince = line.startsWith("## Since the agent wrote this");
      inShipped = line.startsWith("## What reached a remote");
      if (inRightNow) checkedDay = /checked at (\d{4}-\d\d-\d\d)/.exec(line)?.[1] ?? null;
      if (inSince) { const t = /^## Since the agent wrote this \((\d{4}-\d\d-\d\d) (\d\d:\d\d) UTC/.exec(line); sinceAt = t ? Date.parse(`${t[1]}T${t[2]}:00Z`) : null; }
      blockRepo = null;
    }
    if (inAnswers || line.startsWith(">")) continue;
    // round 8 — a push filed under a repository, in the section that lists them by path
    if (inShipped) {
      const push = /^- \d{4}-\d\d-\d\d \d\d:\d\d UTC · (\/.+?) · (\S+)(?: · ([0-9a-f]{7,40})\b)?/.exec(line);
      if (push) {
        if (!resolvesIn(git, push[1]!, push[2]!)) failures.push(`pushed ref does not resolve in the repository it is filed under: ${push[2]} in ${push[1]}`);
        if (push[3] && git(["-C", push[1]!, "cat-file", "-e", `${push[3]}^{commit}`], 5000) == null) failures.push(`pushed commit is not in the repository it is filed under: ${push[3]} in ${push[1]}`);
      } else if (line.startsWith("- ")) failures.push(`push line not filed under a repository path: ${line.slice(0, 80)}`);
    }
    if (inRightNow || inLastSeen || inSince) {
      const block = /^- (?:worktree )?(\/.*?)(?: \(repository not recorded in this trace\))?$/.exec(line);
      if (block) blockRepo = block[1]!;
      else if (/^- /.test(line)) blockRepo = null;
      if (inRightNow && blockRepo && line.startsWith("  ")) failures.push(...verifyFreshness(line, blockRepo, checkedDay, git));
      if (line.startsWith("  ")) failures.push(...verifyPushLine(line, blockRepo, git));
      if (inSince && blockRepo && line.startsWith("  ")) failures.push(...verifySinceLine(line, blockRepo, git, sinceAt));
    }
    if (inFacts && line.startsWith("- repo `")) {
      const m = /^- repo `([^`]+)`(?: · branch `([^`]+)`)?(?: · (tip|commit) `([^`]+)`)?(?: · path `([^`]+)`)?(?: \(found in .+\))?$/.exec(line);
      if (!m) { failures.push(line); continue; }
      const [, repo, branch, relation, hash, path] = m;
      const run = (...args: string[]): string | null => git(["-C", repo!, ...args], 5000);
      let ok = run("rev-parse", "--show-toplevel") != null;
      const tip = branch ? run("rev-parse", "--verify", "--quiet", `${branch}^{commit}`)?.trim() : undefined;
      if (branch && !tip) ok = false;
      if (hash && run("cat-file", "-e", `${hash}^{commit}`) == null) ok = false;
      if (branch && hash && (relation === "tip" ? tip !== run("rev-parse", "--verify", "--quiet", `${hash}^{commit}`)?.trim() : run("merge-base", "--is-ancestor", hash, branch) == null)) ok = false;
      if (path && !existsSync(isAbsolute(path) ? path : resolve(repo!, path))) ok = false;
      if (!ok) failures.push(line);
    }
    const status = /^- status `([^`]+)`: (\d+) modified, (\d+) untracked/.exec(line);
    if (status) {
      const raw = git(["-C", status[1]!, "status", "--porcelain"], 5000);
      const rows = raw?.split("\n").filter(Boolean);
      if (!rows || rows.filter((r) => !r.startsWith("??")).length !== Number(status[2]) || rows.filter((r) => r.startsWith("??")).length !== Number(status[3])) failures.push(line);
    }
  }
  return failures;
}

/* ------------------------------------------------------------------ *
 * Round 9 — what carafe now prints beside the agent's sentences, re-derived.
 *
 *   ↳ since landed on <ref> <minute> UTC via <commit> — items here may be done (<items> in <repo>)
 *   ↳ since written: rows 40–42 proposed in <hash> are now taken on <ref> by <hashes> (<file> in <repo>)
 *   _↳ N of M items below name work that has since landed on <ref>: …_
 *   · path exists: <written> — checked: test -e <path> → exists
 *
 * Nothing here is imported from the producer.
 * ------------------------------------------------------------------ */

const hexTokens = (text: string): string[] => [...text.replace(/`/g, "").matchAll(/(?<![0-9a-f])([0-9a-f]{7,40})(?![0-9a-f])/gi)].map((m) => m[1]!.toLowerCase());
const namesWord = (text: string, word: string): boolean => new RegExp(`(?:^|[\\s\`"'(/])${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`).test(text);

/** Table rows as the gate reads them: the first commit-shaped token of `| n | … |`. */
function gateRowCites(table: string | null, row: number): string | null {
  const line = (table ?? "").split("\n").find((one) => new RegExp(`^\\s*\\|\\s*${row}\\s*\\|`).test(one));
  if (!line) return null;
  return [...line.matchAll(/(?<![0-9a-z/-])([0-9a-f]{7,40})(?![0-9a-z/-])/g)].map((m) => m[1]!).find((one) => /\d/.test(one) && /[a-f]/.test(one)) ?? "";
}

export function verifyAnswerNotes(text: string, git: GitRunner = realGitRunner, exists: (p: string) => boolean = existsSync): string[] {
  const failures: string[] = [];
  const lines = outsideTail(text).split("\n");
  const start = lines.findIndex((line) => line.startsWith("## What the outgoing agent said"));
  if (start < 0) return failures;
  let end = lines.findIndex((line, index) => index > start && line.startsWith("## "));
  if (end < 0) end = lines.length;
  const section = lines.slice(start, end);
  const answers = section.filter((line) => line.startsWith("> ")).map((line) => line.slice(2)).join("\n");
  let written: number | null = null;
  let question = 0;
  let unit = "";
  // Q5's warning, checked when Q5 ends
  let warning: { n: number; m: number } | null = null;
  let units = 0, landedUnits = 0, unitHasLanding = false;
  const closeQuestion = (): void => {
    if (question === 5 && warning && (warning.n !== landedUnits || warning.m !== units)) failures.push(`Q5 warning says ${warning.n} of ${warning.m}, the section has ${landedUnits} of ${units}`);
    if (question === 5 && !warning && landedUnits) failures.push(`Q5 names landed work and carries no warning`);
    warning = null; units = 0; landedUnits = 0; unitHasLanding = false;
  };
  for (const line of section) {
    const file = /^\S.*, written (\d{4}-\d\d-\d\d) (\d\d:\d\d) UTC/.exec(line);
    if (file) { closeQuestion(); question = 0; written = Date.parse(`${file[1]}T${file[2]}:00Z`); continue; }
    const q = /^### Q(\d)\./.exec(line);
    if (q) { closeQuestion(); question = Number(q[1]); continue; }
    // one `> ` line is one sentence of the answers (the splitter works per line)
    if (line.startsWith("> ")) { unit = line.slice(2); units++; unitHasLanding = false; continue; }
    const warn = /^_↳ (\d+) of (\d+) items? below names? work that has since landed on (\S+?): /.exec(line);
    if (warn) { warning = { n: Number(warn[1]), m: Number(warn[2]) }; continue; }
    const landed = /^\s+↳ since landed on (\S+) (\d{4}-\d\d-\d\d) (\d\d:\d\d) UTC via ([0-9a-f]{7,40}) — items here may be done \((.+) in (\/.+)\)$/.exec(line);
    if (landed) {
      if (![2, 4, 5].includes(question)) failures.push(`since-landed note outside Q2/Q4/Q5: ${line.trim().slice(0, 80)}`);
      if (!unitHasLanding) { unitHasLanding = true; landedUnits++; }
      const [, ref, day, clock, via, items, repo] = landed;
      const hashes: string[] = [];
      for (const item of items!.split("; ")) {
        const m = /^([0-9a-f]{7,40})(?:, the newer head of (\S+))?$/.exec(item);
        if (!m) { failures.push(`since-landed item not understood: ${item}`); continue; }
        hashes.push(m[1]!);
        const named = hexTokens(unit).some((token) => m[1]!.startsWith(token) || token.startsWith(m[1]!));
        if (m[2]) {
          // a newer head: the unit names the branch, and the head it had then is older
          if (!namesWord(unit, m[2])) failures.push(`since-landed: the sentence does not name ${m[2]}`);
          const then = written == null ? null : gateValueAt(git, repo!, `refs/heads/${m[2]}`, written);
          if (!then || then.startsWith(m[1]!) || !ancestorIn(git, repo!, then, m[1]!)) failures.push(`since-landed: ${m[1]} is not a newer head of ${m[2]} than when written (${repo})`);
        } else if (!named) {
          // …or the head a branch the unit names had when the answers were written
          const branch = [...unit.matchAll(/`([^`\s]+)`/g)].map((b) => b[1]!).find((b) => written != null && gateValueAt(git, repo!, `refs/heads/${b}`, written)?.startsWith(m[1]!));
          if (!branch) failures.push(`since-landed: the sentence names neither ${m[1]} nor a branch it was the head of`);
        }
      }
      failures.push(...verifyLanding(git, repo!, ref!, `${day}T${clock}:00Z`, via!, hashes, written));
      continue;
    }
    const taken = /^\s+↳ since written: rows? ([\d–, ]+) proposed in ([0-9a-f]{7,40}) (?:is|are) now taken on (\S+) by ([0-9a-f, ]+) \((\S+) in (\/.+)\)$/.exec(line);
    if (taken) {
      const [, rowText, hash, ref, byText, file, repo] = taken;
      const range = /^(\d+)–(\d+)$/.exec(rowText!.trim());
      const rows = range ? Array.from({ length: Number(range[2]) - Number(range[1]) + 1 }, (_, i) => Number(range[1]) + i) : rowText!.split(", ").map(Number);
      const by = byText!.split(", ");
      if (rows.length !== by.length) failures.push(`collision note: ${rows.length} rows, ${by.length} commits`);
      if (!/\b(?:rows?)\b[^.]*\bproposed\b|\bproposed\b[^.]*\brows?\b/i.test(unit) || !hexTokens(unit).some((token) => hash!.startsWith(token))) failures.push(`collision note: the sentence does not reserve rows in ${hash}`);
      const now = git(["-C", repo!, "show", `${ref}:${file}`], 5000);
      const thenHash = written == null ? null : gateValueAt(git, repo!, `refs/remotes/${ref}`, written);
      const then = thenHash ? git(["-C", repo!, "show", `${thenHash}:${file}`], 5000) : null;
      rows.forEach((row, i) => {
        const cites = gateRowCites(now, row);
        if (!cites || !by[i] || !(cites.startsWith(by[i]!) || by[i]!.startsWith(cites))) failures.push(`collision note: row ${row} on ${ref} is not ${by[i]} (${repo})`);
        const before = gateRowCites(then, row);
        if (thenHash == null || (before && before === cites)) failures.push(`collision note: row ${row} was already ${cites} when the answers were written (${repo})`);
      });
      continue;
    }
    const path = /^\s+[·✓?] path (exists|not found now): (\S+)(?: \(in .+\))? — checked: test -e (?:'((?:[^']|'\\'')*)'|(\S+)) → (.*)$/.exec(line);
    if (path) {
      const [, verdict, writtenPath] = path;
      const tested = path[3] != null ? path[3].replace(/'\\''/g, "'") : path[4]!;
      if (exists(tested) !== (path[5] === "exists") || (verdict === "exists") !== (path[5] === "exists")) failures.push(`path note no longer holds: ${tested} ${path[5]}`);
      if (!writtenPath!.startsWith("/")) {
        if (!tested.endsWith(`/${writtenPath}`)) { failures.push(`path note tested a different path: ${tested} for ${writtenPath}`); continue; }
        // round 9 — a relative path is checked in a repository the answers
        // name, or in a folder the sentence itself names as its first segment
        const prefix = tested.slice(0, tested.length - writtenPath!.length - 1);
        const first = writtenPath!.split("/")[0]!;
        // Round 10: fallback evidence may come from any repository the
        // handoff checked, even if the outgoing answers omitted its name.
        const repoNamed = namesWord(answers, basename(prefix)) || answers.includes(prefix)
          || text.split("\n").some((l) => l === `- ${prefix}`);
        const folderNamed = !first.startsWith(".") && exists(`${prefix}/${first}`) && namesWord(unit, first) && !exists(`${prefix}/.git`);
        if (!repoNamed && !folderNamed) failures.push(`path note checked ${writtenPath} in ${prefix}, which the answers do not name`);
      }
    }
  }
  closeQuestion();
  return failures;
}

/**
 * Round 9 — the file's own length footer, the tail's date lines, the "older
 * than the last working day" markers and the stale-question count, re-derived
 * from the text and the trace.
 */
export function verifyLayout(text: string, events: CarafeEvent[]): string[] {
  const failures: string[] = [];
  const newlines = (value: string): number => (value.match(/\n/g) ?? []).length;
  const footer = /^_Length: (\d+) lines outside the verbatim tail, (\d+) in all/m.exec(text);
  if (footer) {
    if (Number(footer[2]) !== newlines(text)) failures.push(`length footer says ${footer[2]} lines in all, the file has ${newlines(text)}`);
    if (Number(footer[1]) !== newlines(outsideTail(text))) failures.push(`length footer says ${footer[1]} lines outside the tail, the file has ${newlines(outsideTail(text))}`);
  } else if (/^_Left out to keep this file under/m.test(text)) failures.push("length footer without line counts");
  const ts = new Map(events.map((event) => [event.seq, event.ts ?? null]));
  const minute = (seq: number): string | null => { const at = ts.get(seq); return at && at.length >= 16 ? `${at.slice(0, 10)} ${at.slice(11, 16)}` : null; };
  const tail = /^## The tail, verbatim \(seq (\d+) → (\d+)[^\n]*\n([\s\S]*?)(?=^## Dig deeper\b|$(?![\s\S]))/m.exec(text);
  if (tail) {
    const [, fromText, toText, body] = tail;
    for (const m of body!.matchAll(/^_(\d{4}-\d\d-\d\d \d\d:\d\d) UTC(?: → (\d{4}-\d\d-\d\d \d\d:\d\d) UTC)? · seq (\d+)(?:–(\d+))?_$/gm)) {
      if (minute(Number(m[3])) !== m[1]) failures.push(`tail date: seq ${m[3]} is ${minute(Number(m[3])) ?? "undated"}, not ${m[1]}`);
      if (m[2] && minute(Number(m[4])) !== m[2]) failures.push(`tail date: seq ${m[4]} is ${minute(Number(m[4])) ?? "undated"}, not ${m[2]}`);
    }
    const inTail = events.filter((event) => event.seq >= Number(fromText) && event.seq <= Number(toText)).map((event) => Date.parse(event.ts ?? "")).filter(Number.isFinite);
    const newest = inTail.length ? Math.max(...inTail) : NaN;
    for (const m of body!.matchAll(/\[…\d+ events?(?: from [\d, -]+)?, older than the last working day, omitted — carafe show \S+ --seq (\d+)-(\d+)\]/g)) {
      const young = events.filter((event) => event.seq >= Number(m[1]) && event.seq <= Number(m[2])).find((event) => { const at = Date.parse(event.ts ?? ""); return Number.isFinite(at) && !(newest - at > 24 * 60 * 60 * 1000); });
      if (young) failures.push(`tail omitted seq ${young.seq} as older than the last working day; it is not`);
    }
  }
  const end = /^- session: .* → (\S+)$/m.exec(text)?.[1];
  const stale = /^_(\d+) questions? asked more than 7 days before the session ended (?:was|were) dropped as stale \(the newest: (?:carafe show \S+ --seq |seq )(\d+)\)\._$/m.exec(text);
  if (stale && end) {
    const at = Date.parse(ts.get(Number(stale[2])) ?? "");
    if (!Number.isFinite(at) || !(Date.parse(end) - at > 7 * 24 * 60 * 60 * 1000)) failures.push(`stale question seq ${stale[2]} is not older than 7 days before the end`);
  }
  return failures;
}

/** Every quote block resolves in full, with whitespace and punctuation intact. */
export function verifyQuotes(text: string, events: CarafeEvent[], id: string): string[] {
  const sources = new Map(preparedPieces(events, id).map((p) => [p.seq, p.lines.join("\n")]));
  const bad: string[] = [];
  const lines = outsideTail(text).split("\n");
  let answers = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.startsWith("## ")) answers = line.startsWith("## What the outgoing agent said");
    if (answers || !/^\[seq \d+\]$/.test(line)) continue;
    const seq = Number(/\d+/.exec(line)![0]);
    const quoted: string[] = [];
    while (lines[i + 1]?.startsWith("> ")) quoted.push(lines[++i]!.slice(2));
    const quote = quoted.join("\n");
    if (!quote || !sources.get(seq)?.includes(quote)) bad.push(`seq ${seq}: ${quote}`);
  }
  return bad;
}

/**
 * A stub is a line whose only content is a COUNT and the command that would
 * retrieve what it stands for. A pointer to a step nobody took is not one.
 */
export function stubLines(text: string): number {
  return text.split("\n").filter((l) => /^(?:\s*[-_*…]?\s*)?\+?\d+ (?:more|turns?|moments?|events?)\b.*\bcarafe [a-z]/.test(l)).length;
}

/* ------------------------------------------------------------------ *
 * The stamps are carafe's OWN statements about the agent's sentences, so the
 * gate re-derives them from scratch: the subject must be a whole token of the
 * sentence above it, and the command it printed must still answer what it
 * printed. Deliberately shares nothing with `src/handoff/claims`.
 * ------------------------------------------------------------------ */

/** The longest path that exists on disk starting at `from` — never a prefix. */
function longestPathAt(text: string, from: number, exists: (p: string) => boolean): string | null {
  const rest = text.slice(from);
  if (!rest.startsWith("/")) return null;
  const ends = [rest.length, ...[...rest.matchAll(/\s+/g)].map((m) => m.index!).reverse()];
  for (const end of ends) {
    const candidate = rest.slice(0, end).replace(/[.,;:!?)\]`]+$/, "");
    if (candidate.startsWith("/") && exists(candidate)) return candidate;
  }
  return null;
}

/** `git -C '/a b/c' status --porcelain` → ["-C", "/a b/c", "status", …]. */
function splitCommand(command: string): string[] | null {
  if (!command.startsWith("git ")) return null;
  const args: string[] = [];
  const re = /'((?:[^']|'\\'')*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(command.slice(4))) !== null) args.push(m[1] != null ? m[1].replace(/'\\''/g, "'") : m[2]!);
  return args.length ? args : null;
}

const squash = (s: string): string => s.replace(/\s+/g, " ").trim();

export interface StampAudit { failures: string[]; checked: number; skipped: number }

/**
 * Round 8 — the gate's own reading of a stamp at the moment the answers were
 * written. ✗ means "false when written": a ✗ about a REF (a branch head, a
 * count or ancestry against a branch) must carry a `↳ when written … false`
 * line whose reflog evidence, re-read here, proves it; a ✗ about a working
 * tree's cleanliness is never allowed (git keeps no past for it); a ✓ that
 * says "changed since" must carry a `↳ … held` line that the reflog confirms.
 */
const WHEN_RE = /^\s+↳ when written \((\d{4}-\d\d-\d\d) (\d\d:\d\d:\d\d) UTC\): (held, changed since|held|false|cannot tell)(.*)$/;
export function verifyWhenWritten(mark: string, label: string, next: string, git: GitRunner): string[] {
  const failures: string[] = [];
  const when = WHEN_RE.exec(next);
  const subject = label.replace(/ · (?:held when written, changed since|false when written|cannot tell whether it held when written)$/, "");
  const aboutRef = /(?:is the head of|commits? ahead of|commits? behind|is an ancestor of) (\S+)(?: \((?:worktree|local branch)[^)]*\))?$/.exec(subject)?.[1];
  const refSubject = aboutRef != null && aboutRef !== "HEAD" && !/^[0-9a-f]{7,40}$/i.test(aboutRef);
  if (mark === "✗" && / is (?:not )?clean$/.test(subject)) failures.push(`✗ on a working tree's cleanliness, which git cannot know at the time of writing: ${subject.slice(0, 80)}`);
  if (mark === "✗" && refSubject && when?.[3] !== "false") failures.push(`✗ on a ref claim without proof at the time of writing: ${subject.slice(0, 80)}`);
  if (/changed since$/.test(label) && (mark !== "✓" || when?.[3] !== "held, changed since")) failures.push(`"changed since" without a held-when-written reading: ${subject.slice(0, 80)}`);
  if (!when || when[3] === "cannot tell") return failures;
  const at = Date.parse(`${when[1]}T${when[2]}Z`);
  // `<ref> was <hash> [git … reflog show … <ref>]` — the ref's value at that moment
  for (const piece of when[4]!.matchAll(/(\S+) (was ([0-9a-f]{7,40})|did not exist) \[(git [^\]]*reflog show[^\]]*)\]/g)) {
    const args = splitCommand(piece[4]!);
    if (!args) continue;
    const out = git(args, 10_000);
    if (out == null) { failures.push(`when-written evidence no longer reads: ${piece[4]!.slice(0, 80)}`); continue; }
    const entries = out.split("\n").flatMap((row) => {
      const [hash, selector] = row.split("\t");
      const t = /@\{(\d+)\}$/.exec(selector ?? "")?.[1];
      return hash && t ? [{ hash, at: Number(t) * 1000 }] : [];
    });
    const held = entries.find((entry) => entry.at <= at);
    if (piece[3] ? !held?.hash.startsWith(piece[3]) : held != null) failures.push(`when-written evidence does not match the reflog: ${piece[1]} ${piece[2]} at ${when[1]} ${when[2]}`);
  }
  return failures;
}

/**
 * Round 9 — what a stamp's LABEL asserts, re-derived with the gate's own reads:
 * "touch only", "already has / does not have what this calls open", and a
 * count against a local main line labelled with when that ref was last written.
 */
export function verifyStampMeaning(mark: string, label: string, command: string, next: string, written: number | null, git: GitRunner): string[] {
  const failures: string[] = [];
  const args = splitCommand(command);
  const repo = args?.[0] === "-C" ? args[1]! : null;
  const subject = label.replace(/ · (?:held when written, changed since|false when written|cannot tell whether it held when written)$/, "");
  let m: RegExpExecArray | null;
  if (repo && (m = /^([0-9a-f]{7,40}(?:, [0-9a-f]{7,40})*) touch only (.+)$/.exec(subject))) {
    const hashes = m[1]!.split(", ");
    const named = new Set(m[2]!.split(", ").map((file) => file.startsWith(`${basename(repo)}/`) ? file.slice(basename(repo).length + 1) : file));
    const files = (git(["-C", repo, "diff-tree", "--no-commit-id", "--name-only", "-r", ...hashes.flatMap((hash) => [hash])], 5000) ?? "").split("\n").map((one) => one.trim()).filter(Boolean);
    const per = hashes.map((hash) => (git(["-C", repo, "diff-tree", "--no-commit-id", "--name-only", "-r", hash], 5000) ?? "").split("\n").map((one) => one.trim()).filter(Boolean));
    const only = per.every((list) => list.length > 0) && [...files, ...per.flat()].every((file) => named.has(file) || [...named].some((dir) => dir.endsWith("/") && file.startsWith(dir)));
    if ((mark === "✓") !== only) failures.push(`touch-only stamp ${mark} disagrees with the commits' files: ${per.flat().join(", ").slice(0, 80)}`);
  }
  if (repo && (m = /^([0-9a-f]{7,40}) (already has|does not have|has) what this calls (open|done): (.+)$/.exec(subject))) {
    const [, head, verb, claim, list] = m;
    const base = git(args!, 5000)?.trim();
    if (!base || args![2] !== "merge-base") { failures.push(`work-status stamp without its comparison point: ${subject.slice(0, 80)}`); return failures; }
    const items = list!.split(", ").map((item) => /^(.+) \((new|changed|unchanged)\)$/.exec(item)).filter((one): one is RegExpExecArray => one != null);
    const statusOf = (item: string): string => {
      // a source file (by its extension) is looked up as a path; anything else is text
      const file = /\.(?:ts|tsx|js|jsx|mjs|cjs|json|py|rb|go|rs|sql|sh|css|scss|html|ya?ml|toml|swift|kt|java)$/i.test(item);
      if (file) {
        const inHead = git(["-C", repo, "cat-file", "-e", `${head}:${item}`], 5000) != null;
        const inBase = git(["-C", repo, "cat-file", "-e", `${base}:${item}`], 5000) != null;
        if (!inHead) return "absent";
        if (!inBase) return "new";
        return (git(["-C", repo, "diff", "--name-only", base, head!, "--", item], 5000) ?? "").trim() ? "changed" : "unchanged";
      }
      const count = (rev: string): number => (git(["-C", repo, "grep", "-c", "-F", "-e", item, rev], 5000) ?? "").split("\n").map((line) => Number(line.split(":").at(-1))).filter(Number.isFinite).reduce((a, b) => a + b, 0);
      const h = count(head!), b = count(base);
      return !h ? "absent" : !b ? "new" : h !== b ? "changed" : "unchanged";
    };
    let fresh = 0, moved = 0;
    for (const item of items) {
      const status = statusOf(item[1]!);
      if (status !== item[2]) failures.push(`work-status: ${item[1]} is ${status} in ${head}, not ${item[2]}`);
      if (status === "new") fresh++;
      if (status === "new" || status === "changed") moved++;
    }
    if (items.length !== list!.split(", ").length) failures.push(`work-status list not understood: ${list!.slice(0, 80)}`);
    const committed = Date.parse(git(["-C", repo, "log", "-1", "--format=%cI", head!], 5000)?.trim() ?? "");
    const before = written != null && Number.isFinite(committed) && committed <= written + 60_000;
    const expected = claim === "done" ? (moved === items.length ? "✓" : "?")
      : !moved ? "✓" : fresh && moved * 2 >= items.length && before ? "✗" : "?";
    if (verb === "does not have" ? moved !== 0 : moved === 0 && claim === "open") failures.push(`work-status wording disagrees with the items: ${subject.slice(0, 80)}`);
    if (mark !== expected) failures.push(`work-status stamp is ${mark}, the items make it ${expected}: ${subject.slice(0, 80)}`);
    if (mark === "✗" && !/↳ when written .*: false · [0-9a-f]{7,40} was committed \d{4}-\d\d-\d\d \d\d:\d\d UTC, before the answers were written/.test(next)) failures.push(`work-status ✗ without the commit's date: ${subject.slice(0, 80)}`);
  }
  if (repo && (m = /(?:ahead of|the head of) (\S+) \(local branch, last updated (\d{4}-\d\d-\d\d) (\d\d:\d\d) UTC by (\S+)\)$/.exec(subject))) {
    const newest = newestReflog(git, repo, `refs/heads/${m[1]}`);
    const iso = newest ? new Date(newest.at).toISOString() : "";
    if (!newest || iso.slice(0, 10) !== m[2] || iso.slice(11, 16) !== m[3] || gateHowMoved(newest.message) !== m[4]) failures.push(`local branch label does not match its reflog: ${m[1]} in ${repo}`);
  }
  return failures;
}

export function verifyStamps(text: string, git: GitRunner = realGitRunner, exists: (p: string) => boolean = existsSync): StampAudit {
  const audit: StampAudit = { failures: [], checked: 0, skipped: 0 };
  let sentence = "";
  let written: number | null = null;
  const all = outsideTail(text).split("\n");
  for (let index = 0; index < all.length; index++) {
    const line = all[index]!;
    const file = /^\S.*, written (\d{4}-\d\d-\d\d) (\d\d:\d\d) UTC/.exec(line);
    if (file) written = Date.parse(`${file[1]}T${file[2]}:00Z`);
    if (line.startsWith("> ")) { sentence = sentence ? `${sentence}\n${line.slice(2)}` : line.slice(2); continue; }
    const stamp = /^\s{2,}([✓✗]) (.*)$/.exec(line);
    // a `·` note, a `?` stamp and a `↳ when written` line all sit under the same sentence
    if (!stamp) { if (!/^\s{2,}[·?↳]/.test(line)) sentence = ""; continue; }
    const body = stamp[2]!;
    const cut = body.indexOf(" — ");
    const label = cut < 0 ? body : body.slice(0, cut);
    // round 8 — a stamp is a judgment AT THE TIME OF WRITING: re-derived here
    audit.failures.push(...verifyWhenWritten(stamp[1]!, label, all[index + 1] ?? "", git));
    // a named path: `test -e <path> → exists` is re-run like a git command
    const testE = /— checked: test -e (?:'((?:[^']|'\\'')*)'|(\S+)) → (.*)$/.exec(body);
    if (testE) {
      const path = testE[1] != null ? testE[1].replace(/'\\''/g, "'") : testE[2]!;
      audit.checked++;
      if (exists(path) !== (testE[3] === "exists")) audit.failures.push(`stamp no longer holds: ${path} ${testE[3]}`);
      continue;
    }
    if (label.startsWith("path exists:")) {
      const cmd = /— checked: (git .+) → \(empty\)$/.exec(body)?.[1];
      const args = cmd ? splitCommand(cmd) : null;
      audit.checked++;
      if (!args || !args.includes("cat-file") || git(args, 10000) == null) audit.failures.push(`path stamp no longer holds: ${label}`);
      continue;
    }
    // every stamp carries "— checked: <command> → <value>" (PR #38's contract)
    const rest = (cut < 0 ? "" : body.slice(cut + 3)).replace(/^checked:\s*/, "");
    const arrow = rest.lastIndexOf(" → ");
    const command = arrow < 0 ? rest : rest.slice(0, arrow);
    const value = arrow < 0 ? "" : rest.slice(arrow + 3);
    if (!sentence) { audit.failures.push(`stamp with no sentence above it: ${label}`); continue; }
    audit.failures.push(...verifyStampMeaning(stamp[1]!, label, command, all[index + 1] ?? "", written, git));

    // (1) every token the stamp is about is a WHOLE token of that sentence
    for (let i = 0; i < label.length; i++) {
      if (label[i] !== "/" || (i > 0 && !/\s/.test(label[i - 1]!))) continue;
      const path = longestPathAt(label, i, exists);
      if (!path) continue;
      i += path.length;
      const at = sentence.indexOf(path);
      if (at < 0) { audit.failures.push(`stamp names ${path}, the sentence does not`); continue; }
      const whole = longestPathAt(sentence, at, exists);
      if (whole && whole !== path) audit.failures.push(`stamp shortened a path: took ${path}, the sentence says ${whole}`);
    }
    for (const hash of new Set(label.match(/\b[0-9a-f]{7,40}\b/g) ?? [])) {
      if (!new RegExp(`(?:^|[^0-9a-f])${hash}(?![0-9a-f])`).test(sentence)) audit.failures.push(`stamp names ${hash}, the sentence does not`);
    }

    // (2) the command it printed still answers what it printed
    const args = splitCommand(command);
    if (!args) { audit.skipped++; continue; }
    audit.checked++;
    const output = git(args, 10_000);
    const counts = /^(\d+) modified/.exec(value);
    let ok: boolean;
    if (value === "unavailable") ok = output == null;
    else if (value === "(empty)") ok = output != null && output.trim() === "";
    else if (counts && args.includes("--porcelain")) {
      const rows = output?.split("\n").filter(Boolean) ?? [];
      ok = output != null && rows.filter((r) => !r.startsWith("??")).length === Number(counts[1]);
    } else ok = output != null && value.split("; ").every((part) => squash(output).includes(squash(part))); // a multi-line reading is printed joined by "; "
    if (!ok) audit.failures.push(`stamp no longer holds: ${squash(label).slice(0, 80)} — ${squash(value).slice(0, 60)}`);
  }
  return audit;
}

/**
 * One read per (repo, args) for a whole bench run. The repositories do not
 * change while the gate runs, and the audit, the claim checkers and this file
 * ask many of the same questions.
 */
export function memoGit(git: GitRunner = realGitRunner): GitRunner {
  const cache = new Map<string, string | null>();
  return (args, timeout) => {
    const key = JSON.stringify(args);
    if (!cache.has(key)) cache.set(key, git(args, timeout));
    return cache.get(key)!;
  };
}

export async function buildRealHandoff(store: CarafeStore, d: SessionDistillate, git: GitRunner = realGitRunner): Promise<{ rendered: RenderResult; events: CarafeEvent[]; helpers: HelperTrace[]; coverage: { found: number; checked: number; contradicted: number; answers: number } }> {
  const events = readSession(store, d.tool, d.sessionId);
  const helpers: HelperTrace[] = helperSessionsOf(store, d).flatMap((h) => {
    try { return [{ sessionId: h.sessionId, cwd: h.cwd, events: readSession(store, h.tool, h.sessionId) }]; } catch { return []; }
  });
  const paths = new Set<string>();
  for (const t of [{ events, sessionId: d.sessionId, cwd: d.cwd }, ...helpers]) {
    for (const c of boundCalls(t.events, preparedPieces(t.events, t.sessionId))) {
      if (!c.command) continue;
      for (const s of commandSegments(expandCommandVars(c.command), t.cwd)) if (s.dir && /\bgit\b/.test(s.text) && !s.dir.includes("$")) paths.add(s.dir);
    }
  }
  if (!paths.size && d.cwd) paths.add(d.cwd);
  const now = new Date().toISOString();
  const live = { checkedAt: now, repos: [...paths].map((p) => checkRepo(p, git, Date.now())), health: [], live: false, remoteHeads: {} };
  const answers = findAnswerFiles(store.root, d.sessionId).map(readAnswerFile).filter((f): f is AnswerFile => f != null);
  const rendered = renderHandoff(d, events, { now, live, answers, helperTraces: helpers, siblings: siblingSessions(store, d), answerFacts: { git } });
  // B4 is what the FILE says, read back from it: a coverage number computed a
  // second way would report on a document nobody was handed.
  const heading = /^## What the outgoing agent said \((\d+) of (\d+) checkable claims checked · (\d+) of \d+ false when written · \d+ unchecked\)/m.exec(rendered.text);
  const coverage = { checked: Number(heading?.[1] ?? 0), found: Number(heading?.[2] ?? 0), contradicted: Number(heading?.[3] ?? 0), answers: answers.length };
  return { rendered, events, helpers, coverage };
}

export async function runRealHandoffBench(opts: { store?: CarafeStore; n?: number; sessions?: string[] } = {}): Promise<RealCard> {
  const store = opts.store ?? new CarafeStore(undefined, { readOnly: true });
  const n = opts.n ?? 8;
  if (!Number.isSafeInteger(n) || n < 0) throw new Error("--n must be a nonnegative integer");
  const candidates = listSessions(store).filter((d) => d.eventCount >= 200 && !d.sidechain && !d.sessionId.startsWith("agent-") && !isSpawned(d) && !isNoise(d) && d.originator !== "codex_exec");
  const selected: SessionDistillate[] = [];
  // Round-robin tools preserves both trace shapes without privileging one tool's volume.
  const tools = [...new Set(candidates.map((d) => d.tool))];
  const queues = tools.map((t) => candidates.filter((d) => d.tool === t));
  while (selected.length < n && queues.some((q) => q.length)) for (const q of queues) { if (selected.length >= n) break; const d = q.shift(); if (d) selected.push(d); }
  for (const id of opts.sessions ?? []) {
    const d = findSession(store, id);
    if (!d) throw new Error(`session not found: ${id}`);
    if (!selected.some((s) => s.sessionId === d.sessionId && s.tool === d.tool)) selected.push(d);
  }
  const sessions: RealRow[] = [];
  const gate = memoGit();
  for (const d of selected) {
    const started = performance.now();
    try {
      const { rendered, events, helpers, coverage } = await buildRealHandoff(store, d, gate);
      // every anchored excerpt is found in the event it cites, in its own trace
      const traces = new Map<string, EventPieces[][]>([["", [preparedPieces(events, d.sessionId)]]]);
      const helperIds = helpers.map((helper) => helper.sessionId);
      for (const helper of helpers) {
        const label = agentLabel(helper.sessionId, helperIds);
        traces.set(label, [...(traces.get(label) ?? []), preparedPieces(helper.events, helper.sessionId)]);
      }
      const excerpts = verifyAnchoredExcerpts(rendered.text, traces);
      const outside = outsideTail(rendered.text);
      const headings = outside.match(/^#{2,3} .+$/gm) ?? [];
      const failures: string[] = [];
      // Only what carafe wrote itself: the trace it quotes may legitimately
      // contain `$VAR`, and a handoff that refuses to carry it is lying.
      const authored = authoredLines(rendered.text).join("\n");
      for (const [name, re] of [["unexpanded variable", /\$[A-Za-z{]/], ["agent-agent-", /agent-agent-/], ["seq 0", /\[seq 0\]/]] as const) if (re.test(authored)) failures.push(name);
      if (new Set(headings).size !== headings.length) failures.push("duplicate heading");
      const lines = outside.split("\n").length, bytes = Buffer.byteLength(outside);
      const stubs = stubLines(outside);
      if (lines > HANDOFF_MAX_LINES || bytes > HANDOFF_MAX_BYTES) failures.push("budget exceeded");
      if (stubs) failures.push("stub lines");
      // Carafe's stamps are statements too: they are re-derived here, and a
      // stamp that no longer holds is a false statement like any other.
      const stamps = verifyStamps(rendered.text, gate);
      sessions.push({ session: d.sessionId, tool: d.tool, printed: rendered.audit?.printed ?? 0, rehomed: rendered.audit?.rehomed ?? 0, dropped: rendered.audit?.dropped ?? 0,
        falseStatements: [...verifyPrintedText(rendered.text, gate), ...stamps.failures, ...verifyAnswerNotes(rendered.text, gate), ...verifyLayout(rendered.text, events)], badQuotes: [...verifyQuotes(rendered.text, events, d.sessionId), ...excerpts.failures], ...coverage,
        stampsChecked: stamps.checked, stampsSkipped: stamps.skipped, excerpts: excerpts.checked, lines, bytes, stubs, failures, ms: Math.round(performance.now() - started) });
    } catch (error) {
      sessions.push({ session: d.sessionId, tool: d.tool, printed: 0, rehomed: 0, dropped: 0, falseStatements: [], badQuotes: [], found: 0, checked: 0, contradicted: 0, answers: 0, stampsChecked: 0, stampsSkipped: 0, excerpts: 0, lines: 0, bytes: 0, stubs: 0, failures: [String(error)], ms: Math.round(performance.now() - started) });
    }
  }
  const total = sessions.reduce((a, r) => {
    for (const k of ["printed", "rehomed", "dropped", "found", "checked", "contradicted", "answers", "stampsChecked", "stampsSkipped", "excerpts", "lines", "bytes", "stubs", "ms"] as const) a[k] += r[k];
    for (const k of ["falseStatements", "badQuotes", "failures"] as const) a[k].push(...r[k]);
    return a;
  }, { printed: 0, rehomed: 0, dropped: 0, found: 0, checked: 0, contradicted: 0, answers: 0, stampsChecked: 0, stampsSkipped: 0, excerpts: 0, lines: 0, bytes: 0, stubs: 0, ms: 0, falseStatements: [] as string[], badQuotes: [] as string[], failures: [] as string[] });
  return { sessions, total, ok: sessions.length > 0 && !total.falseStatements.length && !total.badQuotes.length && !total.failures.length };
}
export function formatRealHandoffBench(card: RealCard): string {
  const row = (name: string, r: Omit<RealRow, "session" | "tool">): string => `| ${name} | ${r.printed}/${r.rehomed}/${r.dropped} | ${r.falseStatements.length} | ${r.badQuotes.length} | ${r.answers ? `${r.checked}/${r.found} · ${r.contradicted}` : "no answers file"} | ${r.stampsChecked}/${r.stampsSkipped} | ${r.excerpts} | ${r.lines}/${r.bytes} | ${r.stubs} | ${r.failures.join("; ") || "pass"} | ${r.ms} |`;
  return ["| session | B1 printed/re-homed/dropped | false statements | B2 bad quotes | B4 checked/found · false when written | stamps re-run/skipped | anchored excerpts verified | B5 lines/bytes | stubs | checks | ms |", "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | ---: |", ...card.sessions.map((r) => row(`${r.tool}/${r.session}`, r)), row("TOTAL", card.total)].join("\n");
}
