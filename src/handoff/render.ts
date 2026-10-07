/**
 * Handoff rendering — two layers, all deterministic (selection, never summarization):
 *   FITS  → the full pure trace, whole.
 *   BIG   → layer 1: orientation notes + key moments + a directory (map) of
 *           the session + the verbatim tail + the keys to layer 2 (carafe show /
 *           carafe grep, which retrieve any section of the full trace on demand).
 * Nothing is lost either way: the store holds the full trace; layer 1 only
 * chooses the entry point.
 */
import { sessionCollisionLines, type PeerTrace } from "./session-collisions";
import { readFileSync, statSync } from "fs";
import { basename, dirname, join } from "path";
import type { CarafeEvent } from "../format/events";
import type { SessionDistillate } from "../format/distillate";
import { segmentChapters, chapterOf, chapterTitles, type Chapter } from "../keymoments/chapters";
import { extractMoments, type KeyMoment, type KeyMomentSet } from "../keymoments/extract";
import { renderMomentsSection } from "../keymoments/render";
import { INSTRUCTIONS_IN_HANDOFF, PROHIBITIONS_IN_HANDOFF, detectProhibitions, type Prohibition } from "../keymoments/instructions";
import { RECAP_IN_HANDOFF } from "../keymoments/recap";
import { detectOpenAsks, OPEN_ASKS_IN_HANDOFF } from "../keymoments/asks";
import { commandOf } from "../keymoments/signals";
import { firstQuotableSentence, quotableSentences } from "../keymoments/sentences";
import { isAgentStateWorkspace, isExcludedWorkspace, workspaceKey, type SiblingSession } from "../query/sessions";
import { buildBlocks, displayFileNames, renderTurnLine, type TurnBlock } from "./blocks";
import { boundCalls, commandsBySeq } from "./calls";
import { branchPurposes, envFlagsFromTrace, healthFromTrace, isNewer, mergeRepoStates, pushesFromTrace, stateFromTrace, subjectsByHash, type BranchPurpose, type EnvFlag, type HealthState, type Observed, type PushObservation, type RepoState } from "./state";
import { commandSegments, absolutePath, expandCommandVars, workspaceOf, worktreesFromCommands } from "./worktrees";
import { clip as clipPiece, extractPieces, filesOf, isSelfGenerationLine, withoutSelfGeneration, TAIL_RESULT_CAP, type EventPieces, type PieceOpts } from "./pieces";
import { checkRepo, realGitRunner, type GitRunner, liveLines, type LiveState } from "./live";
import { splitAnswerSentences, answersLines, refreshClaimsHeading, type AnswerFile, type AnswerFacts } from "./answers";
import { glossaryEntries, glossaryBlock, fileMapLines, hasCausalCue, lessonsLines, withoutDoubleLabelled, type LessonLookup } from "./orient";
import { hasShellVariable, withoutShellVariables } from "./leaks";
import { anchor as dateAnchor, beforeEnd, lapseSuffix, tsIndex } from "./dates";

import { auditFacts, auditLine, factLine, type Fact, type AuditCounts } from "./audit";
import { shell } from "./claims/types";
import { answersText, reposNamedIn, sinceSection } from "./since";

export { buildBlocks } from "./blocks";
export type { TurnBlock } from "./blocks";

export const HANDOFF_BUDGET_CHARS = 200_000; // ~50K tokens: leaves the receiving agent room to work
/**
 * …and the layered file's own ceiling. v4 was 70KB; the v5 sections took it to
 * 139KB, which is a file nobody reads to the end. 90KB is the working budget,
 * and the tail is what gives way — it is the one section a reader can fetch
 * back verbatim with `carafe show`.
 */
export const HANDOFF_MAX_CHARS = 90_000;
/** B5 — the file is readable in one sitting: the budget OUTSIDE the verbatim tail. */
export const HANDOFF_MAX_LINES = 500;
/**
 * Round 8 — the readability target outside the tail. Both judges read a
 * 700-line file whose useful part started at line ~100; above this line count
 * the optional orientation sections give way, in this order.
 */
export const ORIENT_TARGET_LINES = 200;
/** Round 9 — …and the whole file, the verbatim tail included. */
export const TOTAL_TARGET_LINES = 300;
/** Round 9 — the tail's turns: the last two or three of the last working day. */
export const HANDOFF_TAIL_TURNS = 3;
/** What a long block in the tail is clipped to, in lines, when the file is over its target. */
const TAIL_CLIP_LINES = [40, 24, 12, 6];
/** Replaced, once the file is assembled, by the footer that counts its lines. */
const LENGTH_FOOTER = "\u0000LENGTH_FOOTER\u0000";
export const ORIENT_DROP_ORDER = ["verified objects", "project log", "recaps", "file map", "half-done", "notes", "shipped", "newest recap", "key moments", "last seen in the session", "what this is", "glossary", "lessons", "standing instructions"];
/** Sibling sessions still listed once the readability target bites. */
const SIBLINGS_UNDER_TARGET = 5;
/** How much of the file the machine-readable verification record may take. */
export const MAX_FACT_LINES = 40;
export const UNPUSHED_FACTS_PER_REPO = 3;
export const HANDOFF_MAX_BYTES = 70_000;
/** No readings at all — every answer sentence stamps `?`. */
const NOTHING_READ: LiveState = { checkedAt: "", repos: [], health: [], live: false, remoteHeads: {} };
const TAIL_BUDGET_CHARS = 100_000;
/** What the tail's own framing costs, reserved out of the budget. */
const TAIL_RESERVE_CHARS = 2_000;
/**
 * What ONE turn may take out of the tail's budget.
 *
 * The session that broke this ended on a single 90-event turn — the outgoing
 * agent gathering facts for its own handoff, forty Bash calls with six
 * kilobytes of output each. It was bigger than the whole tail budget, so the
 * budget loop kept only its last few pieces: a "tail" of twelve turns that
 * rendered one, opened mid-turn on a `→ **Bash**` line, and had no user line in
 * it at all. A turn that will not fit is summarised, never allowed to eat the
 * eleven turns before it.
 */
export const TAIL_TURN_MAX_CHARS = 8_000;
/** …and the floor it may fall to when twelve turns have to share the budget.
 *  A prefix of 47 KB leaves ~41 KB for the tail, and twelve turns at 8 KB do
 *  not fit in 41 — so five rendered and seven fell off the end. The cap is a
 *  share of what there actually is. */
export const TAIL_TURN_MIN_CHARS = 1_500;

/** The per-turn cap for this render: the tail budget split twelve ways. */
export function turnCapFor(tailBudgetChars: number, turns: number = TAIL_TURNS): number {
  return Math.max(TAIL_TURN_MIN_CHARS, Math.min(TAIL_TURN_MAX_CHARS, Math.floor(tailBudgetChars / Math.max(1, turns))));
}

/** …and the share every helper block in one turn gets out of that. */
export function helperCapFor(turnCap: number): number {
  return Math.min(TAIL_HELPER_MAX_CHARS, Math.floor(turnCap / 3));
}
/** …of which the calls at the head and the tail of the turn are kept whole. */
const TAIL_TURN_HEAD_CALLS = 2;
const TAIL_TURN_LAST_CALLS = 3;
/** …and what a result is clipped to when even that is too much. */
const TAIL_TURN_RESULT_CHARS = 800;
/** What every helper block inside one turn may cost between them, and the
 *  floor one helper keeps however many of them there are. */
export const TAIL_HELPER_MAX_CHARS = 3_000;
const TAIL_HELPER_MIN_CHARS = 400;
const KEYMOMENTS_BUDGET_CHARS = 20_000;

const TAIL_TURNS = 12;
/**
 * v6 round 1 — what the tail is owed before any prefix section is written.
 *
 * Twelve turns at the adaptive per-turn floor, plus the heading, the tangent
 * lead and the closing note. The prefix is built against `HANDOFF_MAX_CHARS`
 * minus this, and gives way section by section until it fits.
 */
export const TAIL_FLOOR_CHARS = TAIL_TURNS * TAIL_TURN_MIN_CHARS + TAIL_RESERVE_CHARS;
/** How many reductions the prefix has, in order: Glossary, File map, Lessons,
 *  older key-moment chapters, Do not, What reached a remote. */
export const PREFIX_SHRINK_STEPS = 6;
/** …and what the last two shrink TO. */
export const DO_NOT_UNDER_PRESSURE = 4;
export const SHIPPED_UNDER_PRESSURE = 6;
/** How many repositories the header names, and therefore how many are principal. */
export const HEADER_REPOS = 4;
/** A non-belonging run this long inside the tail window becomes one line. */
const TANGENT_RUN_TURNS = 3;
const TANGENT_LINE_CHARS = 120;
/** In the handoff only: how many chapters keep their moments, and how much of a
 *  re-cappable moment's text is printed. */
const FULL_CHAPTERS_IN_HANDOFF = 8;
const MOMENT_TEXT_CHARS = 300;
const CHAPTER_FIRST_LINE_CHARS = 100;
/** The project's own log: how much of its last sighting is quoted. */
const LOG_TAIL_LINES = 25;
/** A reading older than this, at the session's end, is stale. */
const STALE_MS = 24 * 60 * 60 * 1000;
/** W3 — the window the moment budget leans towards, and by how much. */
export const RECENT_WINDOW_MS = 72 * 60 * 60 * 1000;
export const RECENT_MOMENT_SHARE = 0.5;
/** W3/v5 — the moment caps the handoff renders under, and how many turn lines
 *  the last chapter's own directory keeps. */
export const NEWEST_CHAPTER_MOMENTS = 24;
export const RECENT_CHAPTER_MOMENTS = 12;
const DIRECTORY_TURNS = 14;
/** A remainder this small is printed, never elided: "… 1 more turns — <command>"
 *  costs a line and hides the turn it stands for. */
export const SMALL_ELISION_TURNS = 3;

/**
 * The last chapter's turn lines under their `  turns:` header. At most `cap`
 * lines (the first three and the newest rest) unless the remainder is small
 * enough to print whole. When turns are elided the count and the command that
 * retrieves them ride on the header line; the gap itself is a bare `  …`, so no
 * line carries only a count and a command.
 */
export function turnListLines(turns: string[], cap: number, pointer: string): string[] {
  if (turns.length <= cap + SMALL_ELISION_TURNS) return [`  turns:`, ...turns.map((line) => `  ${line}`)];
  const head = Math.min(3, cap);
  const tail = cap - head;
  return [
    `  turns: first ${head} and last ${tail} of ${turns.length} — all of them: ${pointer}`,
    ...turns.slice(0, head).map((line) => `  ${line}`),
    `  …`,
    ...turns.slice(turns.length - tail).map((line) => `  ${line}`),
  ];
}
/** W3 — how many moments one helper agent may contribute, newest first. */
const HELPER_MOMENTS_EACH = 30;
/** …and how many of its own turns the tail shows under the parent turn, with
 *  the ceiling that matters when a helper never took a user turn at all and its
 *  whole trace is one block. */
const HELPER_TAIL_TURNS = 12;
const HELPER_TAIL_CHARS = 8_000;

export interface RenderOpts extends PieceOpts {
  /** Compatibility only: recipient labels never change the Markdown. */
  target?: string;
  /** ISO generation time; injected by tests so a rendering is reproducible */
  now?: string;
  /** other sessions in this workspace (resolved by the caller, which has the store) */
  siblings?: SiblingSession[];
  /** the traces of the helper sessions that ran inside this one — the work the
   *  parent only described is recorded as tool calls in these */
  helperTraces?: HelperTrace[];
  /** W1: the readings taken at generation time. The renderer never runs a
   *  command itself — the caller does, and hands the answers in, so a test and
   *  the bench can render a handoff with no git and no clock of their own. */
  live?: LiveState;
  /** W2: the outgoing agent's answers, and the facts to check them against */
  answers?: AnswerFile[];
  answerFacts?: Omit<AnswerFacts, "live">;
  peerTraces?: PeerTrace[];
}

export interface HelperTrace { sessionId: string; events: CarafeEvent[]; cwd?: string | null }

export interface RenderResult { text: string; tier: "full" | "layered"; lines: number; redactionHits: Record<string, number>; tailStartSeq: number; audit?: AuditCounts }

/**
 * Tokens per rendered character, measured on a 156,174-char handoff that cost
 * ~69K tokens to read. chars/4 is the generic English estimate; a trace is
 * denser than prose, and halving a receiving agent's cost estimate is exactly
 * the error that makes it read the wrong thing.
 */
export const CHARS_PER_TOKEN = 2.7;
export function tokenEstimate(chars: number): string {
  const tokens = Math.round(chars / CHARS_PER_TOKEN);
  return tokens < 1000
    ? `≈ ${tokens} tokens (estimate)`
    : `≈ ${Math.round(tokens / 1000)}K tokens (estimate)`;
}

/** Repositories the session actually worked in — `-C <path>` and `cd <path>`
 *  from shell commands, plus the repo roots of every file read or written —
 *  grouped by workspace. A `cwd` alone says where a session STARTED. */
/** Every `git worktree add` the session made, as worktree path → repository.
 *  Read from the events, never from the rendered lines: a `worktree add` can sit
 *  past the 400 characters a rendered call line keeps. */
export function worktreesOf(events: CarafeEvent[], cwd?: string | null): Map<string, string> {
  return worktreesFromCommands([...commandsBySeq(events).values()].flat(), cwd);
}

/**
 * A call whose directory nothing resolves, but whose command NAMES a principal
 * repository, belongs to that repository.
 *
 * The real shape: `for r in acme-api acme-web; do
 * d="/workspace/Acme Work Repos/$r"; git -C "$d" …; done`. Not one
 * `-C` resolves — the path is built from a loop variable — so the whole of the
 * session's last turns belonged to nothing, the tail label counted zero turns
 * and named no repository, while rendering those very turns. Both repository
 * basenames are written literally in the command; that is enough.
 */
export function namedPrincipals(command: string, principal: string[]): string[] {
  const found: string[] = [];
  for (const repo of principal) {
    const name = basename(repo);
    const whole = new RegExp(`(?:^|[^\\w/-])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`);
    if (command.includes(repo) || whole.test(command)) found.push(repo);
  }
  return found;
}

export function workspaceKeysByEvent(events: CarafeEvent[], pieces: EventPieces[], cwd?: string | null, worktrees: Map<string, string> = worktreesOf(events, cwd), principal?: string[]): Map<number, Set<string>> {
  // Work done UNDER a scratch cwd is scratch work too, however deep it sits —
  // unless it is a worktree of a real repository, which `workspaceOf` has
  // already attributed to that repository.
  const scratchRoot = cwd && isExcludedWorkspace(workspaceKey(cwd)) ? (cwd.endsWith("/") ? cwd : cwd + "/") : null;
  // W6 — a key that still carries a shell variable is not a place. Dropping it
  // here is what lets the "named in the command" fallback below see the turn as
  // unresolved at all: `-C "$d"` where `d="…/$r"` resolves to a literal `$r`
  // directory that exists nowhere.
  const excluded = (key: string): boolean => isExcludedWorkspace(key) || hasShellVariable(key) || (scratchRoot != null && key.startsWith(scratchRoot));
  const quoted = (value: string): string => value.replace(/^["']|["']$/g, "");
  const commands = commandsBySeq(events);
  const out = new Map<number, Set<string>>();
  for (const event of events) {
    const keys = new Set<string>();
    for (const raw of commands.get(event.seq) ?? []) {
      // a path the command built out of its own variables is still a path
      const command = expandCommandVars(raw);
      for (const match of command.matchAll(/-C\s+("[^"]+"|'[^']+'|\S+)/g)) {
        const path = absolutePath(quoted(match[1] ?? ""), cwd);
        const key = path ? workspaceOf(path, worktrees) : null;
        if (key) keys.add(key);
      }
      for (const match of command.matchAll(/(?:^|[;&|]\s*)cd\s+("[^"]+"|'[^']+'|\S+)/g)) {
        const path = absolutePath(quoted(match[1] ?? ""), cwd);
        const key = path ? workspaceOf(path, worktrees) : null;
        if (key) keys.add(key);
      }
    }
    for (const file of filesOf(event)) {
      if (!file.startsWith("/")) continue;
      const key = workspaceOf(dirname(file), worktrees);
      if (key) keys.add(key);
    }
    const kept = new Set([...keys].filter((key) => !excluded(key)));
    // nothing resolved — but the command may still say where it worked
    if (!kept.size && principal?.length) {
      for (const raw of commands.get(event.seq) ?? []) {
        for (const repo of namedPrincipals(expandCommandVars(raw), principal)) kept.add(repo);
      }
    }
    if (kept.size) out.set(event.seq, kept);
  }
  return out;
}

export function reposWorkedIn(events: CarafeEvent[], pieces: EventPieces[], cwd?: string | null, worktrees?: Map<string, string>): Array<{ path: string; calls: number }> {
  const counts = new Map<string, number>();
  for (const keys of workspaceKeysByEvent(events, pieces, cwd, worktrees ?? worktreesOf(events, cwd)).values()) {
    // the agent's own memory is not a repository the session worked in
    for (const key of keys) if (!isAgentStateWorkspace(key)) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([path, calls]) => ({ path, calls }));
}

/**
 * The workspaces that carry the session: the ones named in the header — the top
 * `HEADER_REPOS` by tool calls. A coverage cut is the wrong instrument: on a
 * real session (backend 732, frontend 98, product-search 36 calls) 60% made the
 * backend the ONLY principal workspace, and the turn that asked the owner two
 * product questions happened to run one `git show` in the frontend, so the
 * question was thrown away as a tangent. Every repository the header claims the
 * session worked in is the session's work.
 */
/**
 * The per-repository call counts EVERYTHING uses: the header line, the
 * principal set, the tail's belonging test. A real handoff counted
 * `acme-api` at 2,126 calls in its header and then labelled its tail
 * "work in acme-backend, carafe, .carafe", because the header and the
 * principal set were computed from two different numbers. They are one number
 * now, and it includes the helper traces — the work a session delegates is
 * still its work.
 */
export function repoCounts(d: SessionDistillate, events: CarafeEvent[], pieces: EventPieces[], helpers: HelperTrace[] = []): Array<{ path: string; calls: number }> {
  const worktrees = new Map<string, string>();
  for (const [path, repo] of worktreesOf(events, d.cwd)) worktrees.set(path, repo);
  for (const helper of helpers) {
    try { for (const [path, repo] of worktreesOf(helper.events, helper.cwd)) worktrees.set(path, repo); } catch { /* an unreadable helper costs nothing */ }
  }
  const counts = new Map<string, number>();
  const add = (list: Array<{ path: string; calls: number }>): void => {
    for (const repo of list) counts.set(repo.path, (counts.get(repo.path) ?? 0) + repo.calls);
  };
  add(reposWorkedIn(events, pieces, d.cwd, worktrees));
  for (const helper of helpers) {
    try { add(reposWorkedIn(helper.events, preparedPieces(helper.events, helper.sessionId), helper.cwd, worktrees)); } catch { /* skip */ }
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([path, calls]) => ({ path, calls }));
}

/** How much of the recorded work the principal set must cover. */
export const PRINCIPAL_COVERAGE = 0.8;
export function principalWorkspaces(repos: Array<{ path: string; calls: number }>): string[] {
  // Only calls whose directory was RECORDED count — `reposWorkedIn` attributes
  // a call by an explicit `-C`, a `cd`, a worktree map hit or an absolute file
  // path, and never by the session's cwd alone. That is the whole fix for the
  // round-5 failure: an empty stub repo was the cwd, every path-less call
  // landed in it, and the two repositories the work actually happened in were
  // demoted to tangents.
  const total = repos.reduce((sum, repo) => sum + repo.calls, 0);
  if (!total) return repos.slice(0, HEADER_REPOS).map((repo) => repo.path);
  const chosen: string[] = [];
  let covered = 0;
  for (const repo of repos.slice(0, HEADER_REPOS)) {
    if (covered >= total * PRINCIPAL_COVERAGE && chosen.length >= Math.min(2, repos.length)) break;
    chosen.push(repo.path);
    covered += repo.calls;
  }
  return chosen;
}

const BRANCH_RES = [
  /^On branch ([^\s]+)$/m,
  /\bbranch --show-current\b/,
];

/** The branch the work ended on, read out of the trace itself: a distillate
 *  branch is the one capture happened to see first. */
export function branchFromTrace(pieces: EventPieces[]): string | null {
  let branch: string | null = null;
  let expectBranchResult = false;
  for (const piece of pieces) {
    for (const line of piece.lines) {
      if (line.startsWith("→ **")) {
        const command = commandOf(line) ?? "";
        // `git -C <path> rev-parse …` is the same reading as a bare one
        expectBranchResult = /\bgit\b[^\n]*\b(?:rev-parse\s+--abbrev-ref\s+HEAD|branch\s+--show-current)\b/.test(command);
        continue;
      }
      if (!line.trimStart().startsWith("⤷")) continue;
      const body = line.replace(/^\s*⤷\s*/, "");
      const onBranch = BRANCH_RES[0]!.exec(body);
      if (onBranch?.[1]) branch = onBranch[1];
      else if (expectBranchResult) {
        const first = body.split("\n").map((part) => part.trim()).find(Boolean) ?? "";
        if (/^[\w./-]+$/.test(first) && !/^(?:exit|error)/i.test(first)) branch = first;
      }
      expectBranchResult = false;
    }
  }
  return branch;
}

/**
 * v6/V8 — the second line of the file, when nobody answered the questions.
 *
 * The stub section ("_No answers file. Ask the outgoing agent…_") sat seven
 * screens down and one judge never saw it at all. A handoff built only out of
 * extraction is a weaker artefact than one with the outgoing agent's own
 * answers in it, and the reader is told that before anything else. It never
 * refuses: a session whose agent is gone must still hand off.
 */
export function noAnswersWarning(sessionId: string): string {
  return `> **No outgoing-agent answers.** This file is extraction only: nobody who did the work said what is live, what is half-done or what not to do. Ask the outgoing agent: carafe handoff ${sessionId} --questions`;
}

/**
 * v6/V9 — the header's repositories are the SAME list Right now checked, in
 * the same order, and its `· branch x` is printed only when every one of them
 * really is on that branch. v5 read the branch out of the trace and stamped it
 * on a header naming four repositories, three of which were on something else.
 */
export function headerRepoLine(
  live: LiveState | undefined,
  counts: Array<{ path: string; calls: number }>,
  focus?: string[],
): { repos: string; branch: string | null } {
  const callsOf = new Map(counts.map((repo) => [repo.path, repo.calls]));
  const checked = live?.repos ?? [];
  if (!checked.length) {
    const top = counts.slice(0, HEADER_REPOS);
    return { repos: top.map((repo) => `${repo.path} (${repo.calls} tool calls)`).join(", "), branch: null };
  }
  // round 8 — the header names the repositories Right now prints in full, most
  // worked in first; never a 45-entry list of "not checked" folders
  const shown = focus ? focus.flatMap((path) => checked.filter((repo) => repo.path === path)) : checked;
  const rendered = shown.map((repo) => {
    if (repo.notChecked) return `not checked: ${repo.path} (${repo.notChecked})`;
    const calls = callsOf.get(repo.path);
    return `${repo.path}${calls != null ? ` (${calls} tool calls)` : ""}`;
  });
  const readable = shown.filter((repo) => !repo.notChecked);
  const branches = new Set(readable.map((repo) => repo.branch ?? ""));
  const branch = readable.length && branches.size === 1 && !branches.has("") ? [...branches][0]! : null;
  return { repos: rendered.join(", "), branch };
}

/**
 * Round 8 — three lines. The session, the repositories it worked in (most tool
 * calls first — never the stub folder it happened to start in), and how this
 * file was made. The 45-entry list of "not checked" folders is gone: Right now
 * counts them in one line.
 */
function header(d: SessionDistillate, events: CarafeEvent[], pieces: EventPieces[], opts: RenderOpts, focus?: string[]): string[] {
  const counts = repoCounts(d, events, pieces, opts.helperTraces);
  const { repos, branch } = headerRepoLine(opts.live, counts, focus);
  const lastSeq = events.at(-1)?.seq ?? 0;
  return [
    `# Handoff: ${d.title ?? d.sessionId}`,
    ...(opts.answers?.length ? [] : [noAnswersWarning(d.sessionId)]),
    ``,
    `- session: ${d.sessionId} (${d.tool}) · ${d.eventCount} events · ${d.toolUseCount} tool calls · ${d.startTs ?? "?"} → ${d.endTs ?? "?"}`,
    `- repos: ${repos || "none recorded"}${branch ? ` · branch ${branch}` : ""} — the codebase is NOT in this file; it's at the destination`,
    `- generated ${opts.now ?? new Date().toISOString()} from events up to seq ${lastSeq}; optional regeneration if carafe is installed: carafe handoff ${d.sessionId}`,
    `All carafe commands and seq pointers below are optional lookups if carafe is installed and the source store is available. Continue from the inline context and trace; no receiving-tool integration is required.`,
    ``,
  ];
}

/**
 * Round 8 — the repositories Right now prints in full and the header names,
 * most tool calls first: the ones the outgoing agent's answers name (the agent
 * is the authority on what matters); with no answers naming one, the ones the
 * session touched in its last chapter; with neither, the top repositories by
 * tool calls. A stub folder the session merely started in is none of these.
 */
export function focusRepos(
  live: LiveState | undefined,
  counts: Array<{ path: string; calls: number }>,
  namedInAnswers: Set<string>,
  lastChapter: Set<string>,
): string[] {
  const readable = (live?.repos ?? []).filter((repo) => !repo.notChecked).map((repo) => repo.path);
  const callsOf = new Map(counts.map((repo) => [repo.path, repo.calls]));
  const byCalls = (a: string, b: string): number => (callsOf.get(b) ?? 0) - (callsOf.get(a) ?? 0) || a.localeCompare(b);
  const named = readable.filter((path) => namedInAnswers.has(path));
  const chosen = named.length ? named : readable.filter((path) => lastChapter.has(path));
  return (chosen.length ? chosen : [...readable].sort(byCalls).slice(0, HEADER_REPOS)).sort(byCalls);
}

/** The workspaces the session's last chapter touched. */
export function lastChapterRepos(events: CarafeEvent[], pieces: EventPieces[], cwd: string | null | undefined, chapters: Chapter[], principal?: string[]): Set<string> {
  const last = chapters.at(-1);
  const out = new Set<string>();
  if (!last) return out;
  const keys = workspaceKeysByEvent(events, pieces, cwd, undefined, principal);
  for (const event of events) if (event.seq >= last.startSeq) for (const key of keys.get(event.seq) ?? []) out.add(key);
  return out;
}

/**
 * Round 8 — a chapter heading with nothing under it is not a key moment. The
 * collapsed "N moments · carafe chapters …" lines are counts, not moments;
 * both judges read 39 of them and learned nothing.
 */
export function withoutEmptyChapters(lines: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.startsWith("### ")) { out.push(line); continue; }
    let end = i + 1;
    while (end < lines.length && !lines[end]!.startsWith("### ") && !lines[end]!.startsWith("## ")) end++;
    const body = lines.slice(i + 1, end);
    if (body.some((one) => one.trim())) out.push(line, ...body);
    i = end - 1;
  }
  return out;
}

/** The goal is the first prompt's CONTENT. When that prompt opens with an
 *  `@file` reference, the reference is the attachment and the text under it is
 *  the ask — printing only the first line prints the attachment. */
export const GOAL_CHARS = 2_500;
export function goalText(pieces: EventPieces[]): { text: string; seq: number } | null {
  for (const piece of pieces) {
    const line = piece.lines.find((candidate) => candidate.startsWith("**user:**"));
    if (!line) continue;
    const body = line.replace(/^\*\*user:\*\*\s*/, "").trim();
    if (!body) continue;
    const lines = body.split("\n");
    const first = (lines[0] ?? "").trim();
    const rest = lines.slice(1).join("\n").trim();
    const isAttachment = /^@(?:"[^"]+"|'[^']+'|\S+)$/.test(first);
    const chosen = isAttachment && rest ? rest : body;
    return { text: chosen.slice(0, GOAL_CHARS), seq: piece.seq };
  }
  return null;
}

/** Trace text quoted inside the orientation layer is QUOTED: every line gets
 *  "> " so a heading or a bullet the owner wrote cannot become a section of
 *  this file. (Notes ABOUT the file stay italic lines — never blockquotes.) */
function quoted(text: string): string[] {
  return text.split("\n").map((line) => (line.trim() ? `> ${line}` : ">"));
}

function instructionLines(moments: KeyMoment[], tsBySeq: Map<number, string | null>, endTs: string | null | undefined, claimed: Set<string> = new Set(), restated?: (text: string) => boolean): string[] {
  const instructions = moments
    // v6/V4 — the prohibitions have their own section now; repeating them here
    // is the noise that hid them in the first place
    .filter((moment) => moment.kind === "instruction" && !claimed.has(moment.text.replace(/\s+/g, " ").trim().toLowerCase()))
    .sort((a, b) => a.seq - b.seq).slice(-INSTRUCTIONS_IN_HANDOFF);
  if (!instructions.length) return [];
  return [
    `## Standing instructions from the owner (verbatim)`,
    ``,
    // W4 — a rule with no date reads as a rule that still holds
    ...withOldFolded(instructions, (moment) => `- "${continued(moment.text)}"${lapseSuffix(moment.text, moment.seq, tsBySeq, endTs)}  ${dateAnchor(moment.seq, tsBySeq, endTs)}`, tsBySeq, endTs, restated),
    ``,
  ];
}

/**
 * The newest recap, at the top of the file.
 *
 * The best prose in a handoff is the session's own last status report, and it
 * was sitting two thirds of the way down under three older ones. It leads now,
 * with its date on it.
 */
function newestRecapLines(moments: KeyMoment[], tsBySeq: Map<number, string | null>, endTs: string | null | undefined, live?: LiveState): string[] {
  const newest = newestRecap(moments);
  if (!newest) return [];
  const ts = tsBySeq.get(newest.seq) ?? null;
  const date = ts ? ts.slice(0, 10) : "date not recorded";
  const end = endTs ? Date.parse(endTs) : NaN;
  const at = ts ? Date.parse(ts) : NaN;
  const before = Number.isFinite(end) && Number.isFinite(at) ? `, ${beforeEnd(Math.max(0, end - at))} before the end` : "";
  const age = narrativeAgeNote(ts, live);
  return [
    `## The newest recap (asked "${newest.requestLine ?? ""}", ${date}${before})`,
    ``,
    ...(age.length ? [...age, ``] : []),
    ...quoted(newest.fullText ?? newest.text),
    ``,
    `${dateAnchor(newest.seq, tsBySeq, endTs)}${lapseSuffix(newest.fullText ?? newest.text, newest.seq, tsBySeq, endTs)}`,
    ``,
  ];
}

/* ------------------------------------------------------------------ *
 * v6/V4 — what the owner said not to do.
 * ------------------------------------------------------------------ */

/** The sentences the Do not section claims, so Standing instructions can stop
 *  repeating them. */
function prohibitionKeys(prohibitions: Prohibition[]): Set<string> {
  return new Set(prohibitions.map((one) => one.text.replace(/\s+/g, " ").trim().toLowerCase()));
}

/**
 * v6 round 1 — the whole section's ceiling.
 *
 * The cap of eight was a cap on the DETECTOR, and the real session still put
 * 24 KB and 167 lines under this heading, which pushed the tail from ten turns
 * to four. A section that costs the tail six turns has to be bounded in
 * characters too, and it drops from the bottom: the entries that survive are
 * the ones ranked highest.
 */
export const DO_NOT_MAX_CHARS = 2_500;

/** Round 9 — a rule said this long before the end, and not said again since, is folded away. */
export const OLD_RULE_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Round 9 — a multi-line excerpt printed on a list line keeps its own lines
 * under the item: a quoted line that starts `## ` or `- ` must not become a
 * heading or a bullet of this file.
 */
export function continued(text: string): string {
  return text.includes("\n") ? text.replace(/\n/g, "\n    ") : text;
}

/**
 * Round 9 — the rows of a verbatim list, the ones said more than 30 days
 * before the end (and never restated in the last 30) folded under one
 * collapsed line with their count. Nothing is dropped and nothing is reworded.
 */
export function withOldFolded<T extends { text: string; seq: number }>(items: T[], render: (one: T) => string, tsBySeq: Map<number, string | null>, endTs: string | null | undefined, restated: (text: string) => boolean = () => false): string[] {
  const end = Date.parse(endTs ?? "");
  const old = (one: T): boolean => {
    const at = Date.parse(tsBySeq.get(one.seq) ?? "");
    return Number.isFinite(end) && Number.isFinite(at) && end - at > OLD_RULE_MS && !restated(one.text);
  };
  const recent = items.filter((one) => !old(one));
  const older = items.filter(old);
  if (!older.length) return recent.map(render);
  return [
    ...recent.map(render),
    ...(recent.length ? [``] : []),
    `<details><summary>${older.length} more, said over 30 days before the end and not repeated since</summary>`,
    ``,
    ...older.map(render),
    ``,
    `</details>`,
  ];
}

/** Round 9 — the owner said it again within the last 30 days (a user turn carries its words). */
export function restatedSince(pieces: EventPieces[], endTs: string | null | undefined): (text: string) => boolean {
  const end = Date.parse(endTs ?? "");
  const norm = (text: string): string => text.replace(/\s+/g, " ").trim().toLowerCase();
  const recent = pieces.filter((piece) => {
    const at = Date.parse(piece.ts ?? "");
    return Number.isFinite(end) && Number.isFinite(at) && end - at <= OLD_RULE_MS;
  }).flatMap((piece) => piece.lines.filter((line) => line.startsWith("**user:**")).map(norm));
  return (text) => { const needle = norm(text); return needle.length > 0 && recent.some((line) => line.includes(needle)); };
}

export function doNotLines(prohibitions: Prohibition[], tsBySeq: Map<number, string | null>, endTs: string | null | undefined, limit = PROHIBITIONS_IN_HANDOFF, restated?: (text: string) => boolean): string[] {
  if (!prohibitions.length) return [];
  const heading = `## Do not (the owner's prohibitions, verbatim)`;
  const render = (one: Prohibition): string => {
    const mark = one.assistant
      ? ` (the assistant's rule)`
      : one.incidentSeq != null ? ` (said after an incident [seq ${one.incidentSeq}])` : "";
    return `- "${continued(one.text)}"${mark}${lapseSuffix(one.text, one.seq, tsBySeq, endTs)}  ${dateAnchor(one.seq, tsBySeq, endTs)}`;
  };
  const kept: Prohibition[] = [];
  let chars = heading.length + 2;
  for (const one of prohibitions.slice(0, Math.max(0, limit))) {
    const row = render(one);
    if (kept.length && chars + row.length > DO_NOT_MAX_CHARS) break;
    kept.push(one);
    chars += row.length + 1;
  }
  if (!kept.length) return [];
  return [heading, ``, ...withOldFolded(kept, render, tsBySeq, endTs, restated), ``];
}

/* ------------------------------------------------------------------ *
 * v6/V5 — what reached a remote.
 * ------------------------------------------------------------------ */

/** How far back the shipped list looks, and how many entries it prints. */
export const SHIPPED_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
export const SHIPPED_MAX = 12;

export function shippedLines(pushes: PushObservation[], subjects: Map<string, string>, endTs: string | null | undefined, limit = SHIPPED_MAX, verify?: PushVerifier, peers: readonly string[] = []): string[] {
  const end = endTs ? Date.parse(endTs) : NaN;
  const seen = new Set<string>();
  const rows: string[] = [];
  const recent = pushes
    .filter((push) => {
      const at = Date.parse(push.ts ?? "");
      return Number.isFinite(end) && Number.isFinite(at) && end - at <= SHIPPED_WINDOW_MS && at <= end + SHIPPED_WINDOW_MS;
    })
    .sort((a, b) => Date.parse(b.ts ?? "") - Date.parse(a.ts ?? "") || b.seq - a.seq);
  for (const push of recent) {
    if (rows.length >= Math.max(0, limit)) break;
    // a push with no output cannot be told apart by hash, so the seq keeps it
    // distinct from the one before it
    const key = `${push.repo} ${push.ref} ${push.hash ?? (push.noOutput ? `seq${push.seq}` : "")}`;
    if (seen.has(key)) continue;
    // round 8 — filed under a repository only when the ref (and the pushed
    // commit) resolve there; the file names the repository by its full path
    if (verify && (!verify.resolves(push.repo, push.ref) || (push.hash && !verify.resolves(push.repo, push.hash)))) continue;
    seen.add(key);
    const subject = push.hash ? subjects.get(push.hash) ?? null : null;
    const anchor = push.via ? `agent-${agentLabel(push.via, peers)} seq ${push.seq}` : `seq ${push.seq}`;
    const what = push.hash
      ? ` · ${push.hash}${subject ? ` "${subject}"` : ""}`
      : push.newBranch ? ` · new branch`
        : push.noOutput ? ` · push ran, no output captured` : ``;
    rows.push(`- ${stamp(push.ts)} · ${push.repo} · ${push.ref}${what}  [${anchor}]`);
  }
  if (!rows.length) return [];
  return [`## What reached a remote, last 7 days (from the trace)`, ``, ...rows, ``];
}

/* ------------------------------------------------------------------ *
 * v6/V6 — how old the narrative is.
 * ------------------------------------------------------------------ */

/** A recap or a tail more than this much older than the newest commit on disk
 *  is describing a different day's repository. */
export const NARRATIVE_STALE_MS = 48 * 60 * 60 * 1000;

/** The newest commit Right now read, with its date. */
export function newestLiveCommit(live: LiveState | undefined): { hash: string; date: string } | null {
  let best: { hash: string; date: string } | null = null;
  for (const repo of live?.repos ?? []) {
    if (repo.notChecked || !repo.head || !repo.headDate) continue;
    if (!best || repo.headDate > best.date) best = { hash: repo.head.hash, date: repo.headDate };
  }
  return best;
}

/**
 * The note under a heading whose text is older than the repository it describes.
 *
 * Round 6: the newest recap, the tail and the last chapter all ended four days
 * before the state Right now printed, and nothing in the file said so. Both
 * judges called it a margin on currency. This is the whole inference — a
 * subtraction of two dates carafe read itself — and nothing is said about what
 * changed in between.
 */
export function narrativeAgeNote(atTs: string | null | undefined, live: LiveState | undefined, subject: "recap" | "tail" = "recap"): string[] {
  const newest = newestLiveCommit(live);
  const at = atTs ? Date.parse(atTs) : NaN;
  const commitAt = newest ? Date.parse(newest.date) : NaN;
  if (!newest || !Number.isFinite(at) || !Number.isFinite(commitAt)) return [];
  const gap = commitAt - at;
  if (gap <= NARRATIVE_STALE_MS) return [];
  const days = Math.round(gap / 86_400_000);
  return [`_This ${subject} is ${days} day${days === 1 ? "" : "s"} older than the newest commit below (${newest.hash}, ${newest.date.slice(0, 10)}). Read "What reached a remote" and Right now first._`];
}

function newestRecap(moments: KeyMoment[]): KeyMoment | undefined {
  return moments.filter((moment) => moment.kind === "recap").sort((a, b) => a.seq - b.seq).at(-1);
}

function recapLines(moments: KeyMoment[], tsBySeq: Map<number, string | null>, endTs: string | null | undefined): string[] {
  const newest = newestRecap(moments);
  // newest first, and never the one already quoted in full at the top
  const recaps = moments.filter((moment) => moment.kind === "recap").sort((a, b) => a.seq - b.seq).slice(-RECAP_IN_HANDOFF)
    .filter((moment) => moment !== newest).reverse();
  if (!recaps.length) return [];
  const lines = [`## Recaps the assistant wrote (verbatim)`, ``];
  for (const recap of recaps) {
    lines.push(`_asked "${recap.requestLine ?? ""}" — ${dateAnchor(recap.seq, tsBySeq, endTs)}${lapseSuffix(recap.fullText ?? recap.text, recap.seq, tsBySeq, endTs)}_`, ``, ...quoted(recap.fullText ?? recap.text), ``);
  }
  return lines;
}

/** "2026-09-15 17:30 UTC" — the reading's own moment, not the file's. */
function stamp(ts: string | null): string {
  if (!ts || ts.length < 16) return "?";
  return `${ts.slice(0, 10)} ${ts.slice(11, 16)} UTC`;
}

/** A field read long before the session stopped may have been overtaken by the
 *  work that followed it; say so rather than let it read as current. */
function staleMark(observed: { ts: string | null }, endTs: string | null | undefined): string {
  const end = endTs ? Date.parse(endTs) : NaN;
  const at = observed.ts ? Date.parse(observed.ts) : NaN;
  return Number.isFinite(end) && Number.isFinite(at) && end - at >= STALE_MS ? " (old)" : "";
}

/** The shortest prefix of `id`, eight characters or more, that no other id in `ids` shares. */
export function uniquePrefix(id: string, ids: readonly string[]): string {
  const others = ids.filter((other) => other !== id);
  let length = 8;
  while (length < id.length && others.some((other) => other.startsWith(id.slice(0, length)))) length++;
  return id.slice(0, length);
}
/** The BARE label a helper agent gets — always written with an explicit
 *  `agent-` in front of it. The id often already begins with `agent-`, and
 *  `agent-agent-ad` is a tell that nobody read the output. */
export function agentLabel(id: string, peers: readonly string[] = []): string {
  // round 9 — a Codex id starts with a timestamp, so eight characters can name
  // two helpers (`agent-01a0c52e`); the label grows until it names one only
  const bare = (one: string): string => one.replace(/^agent-/, "").replace(/-/g, "");
  const mine = bare(id);
  const others = [...new Set(peers.map(bare))].filter((other) => other !== mine);
  let length = 8;
  while (length < mine.length && others.some((other) => other.startsWith(mine.slice(0, length)))) length++;
  return mine.slice(0, length);
}

/**
 * Round 8 — a push is filed under a repository only when the ref resolves
 * there and every commit listed for it is on it. A real handoff filed
 * `pushed: opus/row42-v2` and that branch's commits under an empty stub
 * repository that has no such branch. Without a readable repository to ask,
 * the push is dropped rather than guessed.
 */
export interface PushVerifier {
  resolves(repo: string, ref: string): boolean;
  subjectsOn(repo: string, ref: string, subjects: string[]): boolean;
}
export const PURPOSE_LOG_DEPTH = 500;
export function pushVerifier(git: GitRunner): PushVerifier {
  const resolves = (repo: string, ref: string): boolean => /^[\w./-]+$/.test(ref) && !ref.startsWith("-")
    && (git(["-C", repo, "rev-parse", "--verify", "--quiet", `${ref}^{commit}`], 5000) != null
      || git(["-C", repo, "rev-parse", "--verify", "--quiet", `refs/remotes/origin/${ref}^{commit}`], 5000) != null);
  const subjectsOn = (repo: string, ref: string, subjects: string[]): boolean => {
    if (!resolves(repo, ref)) return false;
    const target = git(["-C", repo, "rev-parse", "--verify", "--quiet", `${ref}^{commit}`], 5000) != null ? ref : `refs/remotes/origin/${ref}`;
    const log = git(["-C", repo, "log", "--format=%s", "-n", String(PURPOSE_LOG_DEPTH), target], 5000);
    if (log == null) return false;
    const lines = new Set(log.split("\n").map((line) => line.trim()));
    return subjects.every((subject) => lines.has(subject));
  };
  return { resolves, subjectsOn };
}
/** The commit subjects a purpose line lists (a `refs/heads/x` piece is a ref, not a subject). */
export const purposeSubjects = (text: string): string[] => text.split(" · ").map((piece) => piece.trim()).filter((piece) => piece && !piece.startsWith("refs/"));

/** A state with its pushes kept only where the verifier says they belong. */
function withVerifiedPushes(path: string, state: RepoState, verify?: PushVerifier): RepoState {
  if (!verify) return state;
  const keep = (observed: Observed<string> | undefined): Observed<string> | undefined => observed && verify.resolves(path, observed.value) ? observed : undefined;
  return { ...state, pushed: keep(state.pushed), rejected: keep(state.rejected) };
}

/** The state lines for one repository: the readings taken in a named directory
 *  first, then the ones that only assumed the shell never moved. */
function repoBlockLines(path: string, states: RepoState[], endTs: string | null | undefined, purposes?: Map<string, BranchPurpose>, superseded = false, verify?: PushVerifier, peers: readonly string[] = []): string[] {
  const heading = states[0]!.attributed === false
    ? `- worktree ${path} (repository not recorded in this trace)`
    : `- ${path}`;
  const verified = states.map((state) => withVerifiedPushes(path, state, verify));
  const body = verified.flatMap((state) => repoStateLines(state, endTs, superseded, peers));
  if (!body.length) return [];
  // W1 — what each branch named in this block is FOR
  const named = branchesOf(verified);
  const purposeLines = named.flatMap((branch) => {
    const purpose = purposes?.get(branch);
    if (!purpose) return [];
    // round 8 — the branch resolves in this repository, and the commits a
    // purpose lists (its own subjects) are on it; a changelog row is a quote
    if (verify && !(purpose.source === "commits" ? verify.subjectsOn(path, branch, purposeSubjects(purpose.text)) : verify.resolves(path, branch))) return [];
    return [`  for ${branch}: ${purpose.text}  [seq ${purpose.seq}]`];
  });
  return [heading, ...body, ...purposeLines];
}

/** Every branch this repository's block names: the one it is on, and the ones a
 *  push moved or failed to move. */
function branchesOf(states: RepoState[]): string[] {
  const names: string[] = [];
  const add = (name: string | undefined): void => { if (name && !names.includes(name)) names.push(name); };
  for (const state of states) add(state.branch?.value);
  for (const state of states) { add(state.pushed?.value); add(state.rejected?.value); }
  return names.filter((name) => name !== "?");
}

/**
 * v6/V9 — which readings may share a line.
 *
 * Only two readings the SAME tool result produced (one seq) or two taken by
 * commands that both NAMED the same directory. Everything else gets its own
 * line with its own seq. Three rounds running, the file welded a branch read in
 * a real repository to a HEAD read wherever the shell happened to be, and
 * printed `branch opus/row42-null-guard · HEAD 0959ebf "init empty stub"`
 * as one fact about one repository.
 */
export function readingGroupKey(observed: Observed<unknown>): string {
  return observed.dir ? `dir:${observed.dir}` : `seq:${observed.via ?? ""}:${observed.seq}`;
}

/** v6/V9 — the fields Right now re-reads itself. When it did, the trace's older
 *  copy of the same field is superseded and is not printed twice. */
const LIVE_SUPERSEDES = ["branch", "head", "tracking", "remote", "dirty"] as const;

function repoStateLines(state: RepoState, endTs: string | null | undefined, superseded = false, peers: readonly string[] = []): string[] {
  interface Field { text: string; observed: Observed<unknown> }
  const fields: Field[] = [];
  const note = (observed: Observed<unknown> | undefined, text: string, field: (typeof LIVE_SUPERSEDES)[number]): void => {
    if (!observed) return;
    // Right now read this very field a moment ago: the trace's copy of it is
    // not a second opinion, it is an older one
    if (superseded && LIVE_SUPERSEDES.includes(field)) return;
    fields.push({ text: `${text}${staleMark(observed, endTs)}`, observed });
  };
  if (state.branch) note(state.branch, `branch ${state.branch.value}`, "branch");
  if (state.head) note(state.head, `HEAD ${state.head.value.hash}${state.head.value.subject ? ` "${state.head.value.subject}"` : ""}`, "head");
  if (state.tracking) {
    const remote = state.remote ? `origin/${state.remote.value.branch}` : "origin";
    note(state.tracking, `${state.tracking.value.ahead} ahead / ${state.tracking.value.behind} behind ${remote}`, "tracking");
  } else if (state.remote) {
    note(state.remote, `origin/${state.remote.value.branch} at ${state.remote.value.hash ?? "?"}`, "remote");
  }
  if (state.dirty) note(state.dirty, `${state.dirty.value} uncommitted`, "dirty");
  if (!fields.length && !state.pushed && !state.rejected) return [];
  const lines: string[] = [];
  // one line per group of readings that may legitimately share one
  const groups = new Map<string, Field[]>();
  for (const field of fields) {
    const key = readingGroupKey(field.observed);
    groups.set(key, [...(groups.get(key) ?? []), field]);
  }
  for (const group of groups.values()) {
    const seen = group.map((field) => field.observed);
    const vias = seen.map((observed) => observed.via);
    const newest = seen.reduce((best, observed) => (isNewer(observed, best) ? observed : best), seen[0]!);
    // when every observation on the line came from one helper, the line says so
    // once; when they disagree, each helper-sourced field says it for itself
    const uniform = vias.every((via) => via === vias[0]);
    const shown = (uniform ? group.map((field) => field.text) : group.map((field, index) => (vias[index] ? `${field.text} (via helper agent-${agentLabel(vias[index]!, peers)})` : field.text)))
      // the command named no directory: the reading is as good as the guess
      // that the shell never moved, and it says so
      .map((text) => (state.cwdAssumed ? `${text} (cwd assumed)` : text));
    const provenance = uniform && vias[0] ? `via helper agent-${agentLabel(vias[0], peers)}, ` : "";
    lines.push(`  ${shown.join(" · ")}  [${provenance}seq ${newest.seq}, ${stamp(newest.ts)}]`);
  }
  const pushes: string[] = [];
  const mark = (observed: Observed<unknown>): string => (observed.via ? `via helper agent-${agentLabel(observed.via, peers)}, ` : "");
  const assumed = state.cwdAssumed ? " (cwd assumed)" : "";
  if (state.pushed) pushes.push(`pushed: ${state.pushed.value}${staleMark(state.pushed, endTs)}${assumed} [${mark(state.pushed)}seq ${state.pushed.seq}]`);
  if (state.rejected) pushes.push(`rejected push: ${state.rejected.value}${staleMark(state.rejected, endTs)}${assumed} [${mark(state.rejected)}seq ${state.rejected.seq}]`);
  if (pushes.length) lines.push(`  ${pushes.join("   ")}`);
  return lines;
}

/**
 * W1 — the working state as the trace last SAW it. Never computed fresh: a
 * handoff reads the store, never the repository, so every line here is a
 * quotation of a command this session already ran.
 */
export interface RightNowData {
  /** repository path → its states (named-directory readings first) */
  grouped: Map<string, RepoState[]>;
  health: HealthState | null;
  /** branch name → what the trace says that branch is for */
  purposes: Map<string, BranchPurpose>;
  /** boolean-shaped configuration lines the trace saw */
  envFlags: EnvFlag[];
  lastSeq: number;
}

export function rightNowData(d: SessionDistillate, events: CarafeEvent[], pieces: EventPieces[], helpers: HelperTrace[] = []): RightNowData {
  // The helpers did the work this session delegated: their traces hold the tool
  // calls, and therefore the newest readings. Their worktree paths and branch
  // names pool with this session's, so a checkout created in one trace can be
  // recognised in another.
  const traces = [{ sessionId: d.sessionId, events, pieces, cwd: d.cwd, via: undefined as string | undefined },
    ...helpers.map((helper) => ({ sessionId: helper.sessionId, events: helper.events, pieces: preparedPieces(helper.events, helper.sessionId), cwd: helper.cwd, via: helper.sessionId }))];
  const worktrees = new Map<string, string>();
  for (const trace of traces) for (const [path, repo] of worktreesOf(trace.events, trace.cwd)) worktrees.set(path, repo);
  const repos = reposWorkedIn(events, pieces, d.cwd, worktrees).slice(0, HEADER_REPOS);
  const repoPaths = repos.map((repo) => repo.path);
  const knownBranches = new Map<string, Set<string>>();
  for (const trace of traces) stateFromTrace(trace.events, trace.pieces, { cwd: trace.cwd, worktrees, via: trace.via, knownBranches });
  const states = mergeRepoStates(traces.map((trace) =>
    stateFromTrace(trace.events, trace.pieces, { cwd: trace.cwd, repos: repoPaths, worktrees, via: trace.via, knownBranches })));
  const health: HealthState | null = traces
    .map((trace) => healthFromTrace(trace.events, trace.pieces, trace.via))
    .filter((probe): probe is HealthState => probe != null)
    .reduce<HealthState | null>((best, probe) => (best == null || isNewer(probe, best) ? probe : best), null);
  const grouped = new Map<string, RepoState[]>();
  for (const state of states) grouped.set(state.path, [...(grouped.get(state.path) ?? []), state]);
  // readings taken in a named directory lead; assumed ones follow them
  for (const group of grouped.values()) group.sort((a, b) => Number(a.cwdAssumed === true) - Number(b.cwdAssumed === true));
  const targets = [...grouped].flatMap(([path, group]) =>
    branchesOf(group).map((branch) => ({ branch, repo: path, hash: group.find((state) => state.branch?.value === branch)?.head?.value.hash ?? null })));
  const purposes = new Map<string, BranchPurpose>();
  for (const trace of traces) {
    for (const [branch, purpose] of branchPurposes(trace.events, trace.pieces, targets, { cwd: d.cwd, worktrees })) {
      if (!purposes.has(branch)) purposes.set(branch, purpose);
    }
  }
  const envFlags = traces.flatMap((trace) => envFlagsFromTrace(trace.events, trace.pieces, { cwd: trace.cwd, worktrees }));
  return { grouped, health, purposes, envFlags, lastSeq: events.at(-1)?.seq ?? 0 };
}

export function rightNowLines(d: SessionDistillate, events: CarafeEvent[], pieces: EventPieces[], helpers: HelperTrace[] = [], data?: RightNowData, liveRepos?: Set<string>, verify?: PushVerifier): string[] {
  const { grouped, health, purposes, lastSeq } = data ?? rightNowData(d, events, pieces, helpers);
  const peers = helpers.map((helper) => helper.sessionId);
  // v5 — a reading taken by a command that named no directory is not this
  // repository's reading: it is a reading of wherever the shell happened to be.
  // It gets its own sub-list and never sits under a repository heading.
  const body: string[] = [];
  const assumed: string[] = [];
  for (const [path, group] of grouped) {
    // v6/V9 — Right now checked this repository a moment ago. What survives
    // here is only what a live reading cannot reproduce: pushes, rejected
    // pushes, health as the session saw it, a helper's own worktree.
    const superseded = liveRepos?.has(path) === true;
    const named = group.filter((state) => state.cwdAssumed !== true);
    const floating = group.filter((state) => state.cwdAssumed === true);
    if (named.length) body.push(...repoBlockLines(path, named, d.endTs, purposes, superseded, verify, peers));
    // round 8 — a push read where no directory was recorded cannot be filed
    // under any repository: it is dropped, never guessed
    for (const state of floating) assumed.push(...repoStateLines(verify ? { ...state, pushed: undefined, rejected: undefined } : state, d.endTs, superseded, peers));
  }
  if (assumed.length) body.push(`- readings without a recorded directory:`, ...assumed);
  if (health) body.push(`- health: ${health.url} → ${health.body}${staleMark(health, d.endTs)}  [${health.via ? `via helper agent-${agentLabel(health.via, peers)}, ` : ""}seq ${health.seq}, ${stamp(health.ts)}]`);
  // W6 — a path that still carries a shell variable is not a path
  const clean = withoutShellVariables(body);
  if (!clean.length) return [];
  return [
    `## Last seen in the session (from the trace, may be stale)`,
    ``,
    ...clean,
    `- observed at seq ${lastSeq}; regenerate with: carafe handoff ${d.sessionId}`,
    ``,
  ];
}

/* ------------------------------------------------------------------ *
 * W2 — half-done across repositories.
 *
 * The dangerous state is not a branch that moved: it is one half of a change
 * that shipped while the other half did not. Everything here is read from the
 * observations Right now already made — two of them put side by side, with
 * their seq stamps. No cause is inferred, and a finding that cannot be stated
 * from two observations is not stated at all.
 * ------------------------------------------------------------------ */

/** The side of a split a branch name says it is: `…-backend` / `…-fe` / … */
const SIDE_SUFFIX_RE = /-(?:backend|frontend|be|fe|api|web|server|client)$/i;
const branchStem = (branch: string): string => branch.replace(SIDE_SUFFIX_RE, "");
/** N uncommitted files is a lot of unsaved work. */
const HALF_DONE_DIRTY = 5;
const MAIN_BRANCHES = new Set(["main", "master", "develop", "trunk"]);
/** A flag name is about a branch only when they share a WHOLE word this long.
 *  `SINGLE_CALL_SENT` and `opus/sentinel-backend` share the letters "sent";
 *  they have nothing to do with each other. */
const FLAG_WORD_CHARS = 5;
const wordsOf = (text: string): string[] => text.toLowerCase().split(/[^a-z0-9]+/i).filter((word) => word.length >= FLAG_WORD_CHARS);

interface RepoSummary { path: string; branch?: Observed<string>; branchSince?: number; pushed?: Observed<string>; rejected?: Observed<string>; dirty?: Observed<number>; dirtySeen?: Array<Observed<number>> }

function summaries(grouped: Map<string, RepoState[]>): RepoSummary[] {
  return [...grouped].map(([path, group]) => ({
    path,
    branch: group.find((state) => state.branch)?.branch,
    branchSince: group.find((state) => state.branch)?.branchSince,
    pushed: group.find((state) => state.pushed)?.pushed,
    rejected: group.find((state) => state.rejected)?.rejected,
    dirty: group.find((state) => state.dirty)?.dirty,
    dirtySeen: group.flatMap((state) => state.dirtySeen ?? []).sort((a, b) => Date.parse(a.ts ?? "") - Date.parse(b.ts ?? "") || a.seq - b.seq),
  }));
}

export function halfDoneLines(d: SessionDistillate, data: RightNowData, liveRepos?: Set<string>): string[] {
  const repos = summaries(data.grouped);
  const findings: string[] = [];

  // one side pushed, the sibling side not pushed at all
  for (const moved of repos) {
    if (!moved.pushed || !moved.branch) continue;
    for (const still of repos) {
      if (still.path === moved.path || still.pushed || !still.branch) continue;
      if (branchStem(moved.branch.value) !== branchStem(still.branch.value)) continue;
      findings.push(`- ${moved.path} on ${moved.branch.value}: pushed ${moved.pushed.value}  [seq ${moved.pushed.seq}]  ·  ${still.path} on ${still.branch.value}: no push seen in this trace  [branch read at seq ${still.branch.seq}]`);
    }
  }

  // a push that was refused after one that landed
  for (const repo of repos) {
    if (!repo.rejected || !repo.pushed) continue;
    if (!isNewer(repo.rejected, repo.pushed)) continue;
    findings.push(`- ${repo.path}: rejected push ${repo.rejected.value}  [seq ${repo.rejected.seq}]  ·  last push that landed: ${repo.pushed.value}  [seq ${repo.pushed.seq}]`);
  }

  // a flag whose name is the branch's name
  for (const repo of repos) {
    const branch = repo.branch?.value;
    if (!branch) continue;
    const since = repo.branchSince ?? repo.branch!.seq;
    const branchWords = new Set(wordsOf(branch));
    for (const flag of data.envFlags) {
      if (flag.repo != null && flag.repo !== repo.path) continue;
      // a flag read before this branch existed says nothing about this branch
      if (flag.seq <= since) continue;
      if (!wordsOf(flag.name).some((word) => branchWords.has(word))) continue;
      findings.push(`- ${repo.path} on ${branch}: "${flag.line}"  [seq ${flag.seq}]  ·  branch first read at seq ${since}`);
    }
  }

  // v5 — uncommitted work is only a finding when the COUNT MOVED between two
  // observations of the same repository. "13 uncommitted" on its own was a
  // false alarm in a real handoff: the files were dead scratch from three weeks
  // earlier, and nothing about them was half-done.
  const endMs = Date.parse(d.endTs ?? "");
  for (const repo of repos) {
    // W1 counted this repository a moment ago: the trace's old counts are not
    // evidence of anything, and printing "went 4 → 11" beside a checked
    // "0 modified, 6 untracked" is the file arguing with itself.
    if (liveRepos?.has(repo.path)) continue;
    const seen = repo.dirtySeen ?? [];
    if (seen.length < 2) continue;
    const first = seen[0]!;
    const last = seen.at(-1)!;
    // A DECREASE is work being saved, not work being lost — never an alarm.
    // And an increase seen three weeks before the session ended says nothing
    // about what the next session will find: the later reading has to be
    // recent enough to still be true.
    if (last.value <= first.value) continue;
    if (last.value < HALF_DONE_DIRTY) continue;
    const at = Date.parse(last.ts ?? "");
    if (!Number.isFinite(endMs) || !Number.isFinite(at) || endMs - at > RECENT_WINDOW_MS) continue;
    const branch = repo.branch?.value;
    if (!branch || MAIN_BRANCHES.has(branch.toLowerCase())) continue;
    findings.push(`- ${repo.path} on ${branch}: uncommitted went ${first.value} → ${last.value}  [seq ${first.seq} → ${last.seq}, ${stamp(first.ts)} → ${stamp(last.ts)}]`);
  }

  if (!findings.length) return [];
  return [`## Half-done (one side moved, the other did not)`, ``, ...findings, ``];
}

/** W2 — the questions the owner never answered. The work stopped on these.
 *  The open-ask detector is deliberately NOT part of `extractMoments`: the
 *  sealed MomentsBench scores every moment in that set, and a section that only
 *  the handoff renders must not move one of its counts. */
/** Round 9 — a question asked this long before the session ended has lapsed. */
export const WAITING_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export function waitingLines(open_: KeyMoment[], tsBySeq: Map<number, string | null> = new Map(), endTs?: string | null, sessionId?: string): string[] {
  const end = Date.parse(endTs ?? "");
  // round 9 — both judges read three 12–13 September questions offered as
  // open on the 24th, one of them already overtaken by shipped work. A
  // question older than a week before the end is dropped, and counted.
  const stale = (ask: KeyMoment): boolean => {
    const at = Date.parse(tsBySeq.get(ask.seq) ?? "");
    return Number.isFinite(end) && Number.isFinite(at) && end - at > WAITING_MAX_AGE_MS;
  };
  const dropped = open_.filter(stale).sort((a, b) => b.seq - a.seq);
  const open = open_.filter((ask) => !stale(ask)).sort((a, b) => b.seq - a.seq).slice(0, OPEN_ASKS_IN_HANDOFF);
  if (!open.length && !dropped.length) return [];
  const lines = [`## Waiting on the owner (asked, never answered)`, ``];
  if (dropped.length) {
    const newest = dropped[0]!;
    lines.push(`_${dropped.length} ${dropped.length === 1 ? "question" : "questions"} asked more than 7 days before the session ended ${dropped.length === 1 ? "was" : "were"} dropped as stale (the newest: ${sessionId ? `carafe show ${sessionId} --seq ${newest.seq}` : `seq ${newest.seq}`})._`);
    if (open.length) lines.push(``);
  }
  for (const ask of open) {
    lines.push(`- ${continued(ask.text)}${lapseSuffix(ask.text, ask.seq, tsBySeq, endTs)}  ${dateAnchor(ask.seq, tsBySeq, endTs)}`);
    // W4 — the question carries the turn it hangs off, or it is not a question
    if (ask.antecedent) lines.push(`  after you said: "${continued(ask.antecedent.text)}"  ${dateAnchor(ask.antecedent.seq, tsBySeq, endTs)}`);
    for (const option of ask.options ?? []) lines.push(`  ${option}`);
  }
  lines.push(``);
  return lines;
}

const MARKDOWN_PATH_RE = /\.md$/i;
const LOG_READ_RE = /\b(?:cat|tail|sed|grep)\b/;

/** W4 — the project's own log: the markdown file this session read and wrote
 *  most, quoted as it was last seen. Five lines of a LEDGER can be worth more
 *  than any summary, and they are already in the trace. */
export interface DocSighting { path: string; seq: number; body: string }

/** v6/V7 — how many of the log's own dated rows are read back off the disk, and
 *  how much of each one survives. */
export const LOG_DISK_ENTRIES = 10;
export const LOG_DISK_LINE_CHARS = 300;
/** `- 2026-…`, `## 2026-…`, `| 2026-…` — a dated entry in a ledger. */
const DATED_ENTRY_RE = /^\s*(?:-\s+20|##\s+20|\|\s*20)/;

/** Where a logged file might actually be, at generation time. */
export function resolveLogPath(file: string, roots: string[]): string | null {
  const candidates = file.startsWith("/") ? [file] : roots.map((root) => join(root, file));
  return candidates.find((candidate) => { try { return statSync(candidate).isFile(); } catch { return false; } }) ?? null;
}

/**
 * v6/V7 — the ledger's own tail, read from the disk when this handoff is
 * written.
 *
 * The trace's excerpt is what the session SAW; a session that ended four days
 * before the repository did saw a file four days out of date. This is a
 * read-only `tail` of the same file as it is now, dated rows only, and it is
 * omitted when the file is not there or has no dated rows.
 */
export function logOnDiskLines(file: string, roots: string[]): string[] {
  const path = resolveLogPath(file, roots);
  if (!path) return [];
  let text: string;
  try { text = readFileSync(path, "utf8"); } catch { return []; }
  const dated = text.split("\n").filter((line) => DATED_ENTRY_RE.test(line)).slice(-LOG_DISK_ENTRIES);
  if (!dated.length) return [];
  return [
    `### ${basename(path)}, last ${dated.length} dated entries (read from disk when this handoff was written)`,
    ``,
    ...quoted(dated.map((line) => line.trimEnd().slice(0, LOG_DISK_LINE_CHARS)).join("\n")),
    ``,
  ];
}

export function projectLogLines(d: SessionDistillate, events: CarafeEvent[], pieces: EventPieces[], roots: string[] = []): string[] {
  const sighting = projectLogSighting(d, events, pieces);
  if (!sighting) return [];
  const tail = sighting.body.split("\n").slice(-LOG_TAIL_LINES);
  return [
    `## ${basename(sighting.path)}, as last seen [seq ${sighting.seq}]`,
    ``,
    ...quoted(tail.join("\n")),
    ``,
    ...logOnDiskLines(sighting.path, [...roots, ...(d.cwd ? [d.cwd] : [])]),
    `carafe show ${d.sessionId} --seq ${sighting.seq}`,
    ``,
  ];
}

/** The markdown file this session read and wrote most, as it was last seen. */
export function projectLogSighting(d: SessionDistillate, events: CarafeEvent[], pieces: EventPieces[]): DocSighting | null {
  const scratchRoot = d.cwd && isExcludedWorkspace(workspaceKey(d.cwd)) ? (d.cwd.endsWith("/") ? d.cwd : d.cwd + "/") : null;
  const counts = new Map<string, number>();
  for (const event of events) {
    for (const file of filesOf(event)) {
      if (!MARKDOWN_PATH_RE.test(file)) continue;
      if (file.startsWith("/")) {
        const key = workspaceKey(dirname(file));
        if (!key || isExcludedWorkspace(key) || (scratchRoot != null && key.startsWith(scratchRoot))) continue;
      }
      counts.set(file, (counts.get(file) ?? 0) + 1);
    }
  }
  const target = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0];
  if (!target) return null;

  let last: { seq: number; body: string } | null = null;
  for (const call of boundCalls(events, pieces)) {
    if (call.result == null) continue;
    // only a call whose RESULT is the file's content: a Read, or a shell command
    // that prints it. An Edit's result is "ok", not the ledger.
    const reads = /^(?:Read|read_file)$/i.test(call.toolName ?? "") && (call.filePath ?? "").includes(target);
    const prints = call.command != null && LOG_READ_RE.test(call.command) && call.command.includes(target);
    if (!reads && !prints) continue;
    const body = call.result.trimEnd();
    if (body.trim()) last = { seq: call.seq, body };
  }
  return last ? { path: target, seq: last.seq, body: last.body } : null;
}

/* ------------------------------------------------------------------ *
 * W4 — what the product IS, before the trace.
 *
 * A reader who does not know the product cannot read the trace. The trace
 * already says what it is, in the owner's first prompt and in the assistant's
 * own words. (A "most-touched markdown file" was tried and was noise: the file
 * a session edits most is a ledger, and its opening line is a heading.) Quoted verbatim, seq-anchored,
 * never composed: when fewer than two such sentences exist, the section is
 * omitted rather than filled.
 * ------------------------------------------------------------------ */

export const OPENER_MAX_LINES = 6;
export const OPENER_MIN_LINES = 2;
const PRODUCT_CLAIM_RE = /\bis (?:a|the)\b/;

export function whatThisIsLines(
  d: SessionDistillate,
  events: CarafeEvent[],
  pieces: EventPieces[],
  chapters: Chapter[],
  moments: KeyMoment[],
): string[] {
  const chosen: Array<{ text: string; seq: number }> = [];
  const push = (text: string | null | undefined, seq: number): void => {
    if (!text || chosen.length >= OPENER_MAX_LINES) return;
    if (chosen.some((line) => line.text === text)) return;
    chosen.push({ text, seq });
  };

  const goal = goalText(pieces);
  if (goal) for (const sentence of quotableSentences(goal.text).slice(0, 2)) push(sentence, goal.seq);

  const recap = moments.filter((moment) => moment.kind === "recap").sort((a, b) => a.seq - b.seq)[0];
  if (recap) push(firstQuotableSentence(recap.fullText ?? recap.text), recap.seq);

  // an assistant sentence that says what the thing IS, in the opening chapter
  const first = chapters[0];
  const nouns = [d.cwd ? basename(d.cwd) : null, goal ? /[A-Za-z][\w-]{2,}/.exec(goal.text)?.[0] ?? null : null]
    .filter((noun): noun is string => noun != null).map((noun) => noun.toLowerCase());
  if (first && nouns.length) {
    for (const piece of pieces) {
      if (piece.seq < first.startSeq) continue;
      if (piece.seq > first.endSeq) break;
      for (const line of piece.lines) {
        if (!line.startsWith("**assistant:**")) continue;
        const said = quotableSentences(line.replace(/^\*\*assistant:\*\*\s*/, ""))
          .find((sentence) => PRODUCT_CLAIM_RE.test(sentence) && nouns.some((noun) => sentence.toLowerCase().includes(noun)));
        if (said) { push(said, piece.seq); break; }
      }
      if (chosen.length >= OPENER_MAX_LINES) break;
    }
  }

  if (chosen.length < OPENER_MIN_LINES) return [];
  return [
    `## What this is (from the trace, verbatim)`,
    ``,
    ...chosen.map((line) => `- "${line.text}"  [seq ${line.seq}]`),
    ``,
  ];
}

function siblingLines(siblings: SiblingSession[] | undefined, all: SiblingSession[] | undefined = siblings): string[] {
  if (!siblings?.length) return [];
  // round 9 — two Codex sessions started in the same second share eight characters
  const ids = (all ?? siblings).map((one) => one.sessionId);
  const day = (ts: string | null): string => (ts ?? "?").slice(0, 10);
  const lines = [
    `## Other sessions in this workspace`,
    ``,
    ...siblings.map((sibling) => {
      const top = displayFileNames(sibling.topFiles.slice(0, 3)).join(", ");
      return `- ${sibling.tool} ${uniquePrefix(sibling.sessionId, ids)} · "${sibling.title ?? sibling.sessionId}" · ${day(sibling.startTs)} → ${day(sibling.endTs)} · ${sibling.eventCount} events${top ? ` · ${top}` : ""}${sibling.helpers ? ` (+${sibling.helpers} helper sessions)` : ""}`;
    }),
    ``,
    `carafe handoff <id> for any of them`,
    ``,
  ];
  return lines;
}

function notes(d: SessionDistillate, events: CarafeEvent[], pieces: EventPieces[], blocks: TurnBlock[], chapters: Chapter[]): string[] {
  // (the basename-only "files touched most" line lived here; W5's File map
  // replaced it — `llm/runtime.ts` listed twice with no directory was the
  // judge's example of a line that looks like information and is not)
  const prLinks = events.filter((e) => (e.raw as any)?.type === "pr-link").map((e) => (e.raw as any)?.prUrl).filter(Boolean);
  const goal = goalText(pieces);
  const gapSittings = chapters.slice(1).filter((chapter) => {
    const index = events.findIndex((event) => event.seq === chapter.startSeq);
    const before = index > 0 ? Date.parse(events[index - 1]?.ts ?? "") : NaN;
    const after = index >= 0 ? Date.parse(events[index]?.ts ?? "") : NaN;
    return Number.isFinite(before) && Number.isFinite(after) && after - before >= 4 * 60 * 60 * 1000;
  }).length;
  return [
    `## Notes (deterministic — extracted, not summarized)`,
    ``,
    // A trace with no first prompt has no goal to print. "? [seq 0]" is a line
    // that looks like information, anchored to a seq that does not exist.
    ...(!goal ? []
      : goal.text.includes("\n")
      ? [`- goal (first prompt):  [seq ${goal.seq}]`, ``, ...quoted(goal.text), ``]
      : [`- goal (first prompt): ${goal.text}  [seq ${goal.seq}]`]),
    `- turns: ${blocks.length} · tool calls: ${d.toolUseCount}`,
    `- chapters: ${chapters.length} (${gapSittings} gap sittings, ${chapters.filter((chapter) => chapter.boundary === "branch").length} branch switches, ${chapters.filter((chapter) => chapter.boundary === "drift").length} topic shifts)`,
    ...(prLinks.length ? [`- PRs: ${[...new Set(prLinks)].join(", ")}`] : []),
    ``,
  ];
}

function keys(sessionId: string): string[] {
  return [
    `## How to read the rest (layer 2)`,
    ``,
    `Optional, if carafe is installed and the source store is available: the full trace can supply additional history. The context and recent work are inline above; continue from those without these commands:`,
    ``,
    `    carafe chapters ${sessionId} [--chapter K]       map every chapter; drill into its complete weighted turn directory`,
    `    carafe ask ${sessionId} [--file F] [--kind K]    structured lookup: which chapters/dead ends/decisions touched a file, what failed`,
    `    carafe search --session ${sessionId} '<terms>'   find turns about something when you don't know the exact wording (ranked, returns seq ranges)`,
    `    carafe grep ${sessionId} '<pattern>'             find the exact line (regex; returns seq numbers)`,
    `    carafe show ${sessionId} --seq A-B               read that section verbatim (capped at 60K chars; narrow the range or --max-chars)`,
    ``,
  ];
}

/** Harness context the sending tool injected (Codex's developer messages, the
 *  app-context / skills / permissions blocks, Claude Code's system reminders)
 *  is not the work and the receiving tool has its own: a handoff keeps only a
 *  one-line stub with the seq, so the full text stays one `carafe show` away.
 *  Short system lines (interruptions, notices) are kept as they are. */
const HARNESS_STUB_OVER_CHARS = 240;
export function withoutHarnessContext(lines: string[], seq: number, sessionId: string): string[] {
  return lines.map((line) => {
    if (!line.startsWith("**system:**") || line.length <= HARNESS_STUB_OVER_CHARS) return line;
    const head = line.slice("**system:**".length).trim().split("\n")[0]?.slice(0, 60) ?? "";
    return `**system:** [harness context omitted — ${line.length.toLocaleString("en-US")} chars starting "${head}…"; carafe show ${sessionId} --seq ${seq}]`;
  });
}

/**
 * The pieces every view of a session is built from: harness context stubbed,
 * the session's own generation calls removed. `carafe chapters` and the
 * handoff MUST prepare the trace the same way — chapter boundaries, and the
 * failure counts inside them, are computed from these pieces, and two callers
 * preparing them differently is two different answers to the same question.
 */
export function preparedPieces(events: CarafeEvent[], sessionId: string, opts: PieceOpts = {}, hits: Record<string, number> = {}): EventPieces[] {
  return withoutSelfGeneration(withoutHarnessOnAll(extractPieces(events, opts, hits), sessionId), sessionId);
}

/**
 * W5 — the key moments of the WHOLE session: the last chapters whole, the older
 * ones collapsed to one retrievable line each. Rendering only; `carafe
 * key-moments` and `carafe chapters` keep their own output.
 */
function momentsSection(
  d: SessionDistillate, events: CarafeEvent[], pieces: EventPieces[], blocks: TurnBlock[],
  chapters: Chapter[], titles: Map<number, string>, set: KeyMomentSet, helpers: HelperTrace[],
): string[] {
  const chapterFirstLines = new Map<number, string>();
  for (const block of blocks) {
    const index = chapterOf(chapters, block.startSeq).index;
    if (!chapterFirstLines.has(index) && block.firstLine) chapterFirstLines.set(index, block.firstLine);
  }
  // W3 — the work the parent delegated is recorded in the helpers' own traces;
  // their moments are ALWAYS labelled with the agent, because their seqs belong
  // to a different trace. v6/V9 — and no seq is both a dead end and a breakthrough.
  const helperMoments = helperMomentPool(d, events, helpers);
  const pooled: KeyMomentSet = {
    ...set,
    moments: withoutDoubleLabelled(helperMoments.length ? [...set.moments, ...helperMoments] : set.moments),
  };
  const endMs = Date.parse(d.endTs ?? "");
  const recentChapters = new Set(
    chapters.filter((chapter) => {
      const end = Date.parse(chapter.endTs ?? "");
      return Number.isFinite(endMs) && Number.isFinite(end) && endMs - end <= RECENT_WINDOW_MS;
    }).map((chapter) => chapter.index),
  );
  const lastChapter = chapters.at(-1);
  const turnLinesFor = (chapter: Chapter): string[] => {
    if (!lastChapter || chapter.index !== lastChapter.index) return [];
    const own = blocks.filter((block) => chapterOf(chapters, block.startSeq).index === chapter.index);
    if (!own.length) return [];
    return turnListLines(own.map(renderTurnLine), DIRECTORY_TURNS, `carafe chapters ${d.sessionId} --chapter ${chapter.index}`);
  };
  const rendered = renderMomentsSection(pooled, {
    budgetChars: KEYMOMENTS_BUDGET_CHARS,
    chapters,
    fullChapterIndexes: recentChapters,
    fullChapters: FULL_CHAPTERS_IN_HANDOFF,
    textCapChars: MOMENT_TEXT_CHARS,
    titles,
    commitSubjects: true,
    indentContinuations: true,
    turnLines: turnLinesFor,
    select: {
      recentChapters, recentShare: RECENT_MOMENT_SHARE, demoteWip: true,
      newestChapter: lastChapter?.index, newestCap: NEWEST_CHAPTER_MOMENTS, recentCap: RECENT_CHAPTER_MOMENTS,
    },
    collapsedLine: (chapter, count) => {
      const date = (chapter.startTs ?? "").slice(0, 10);
      const first = (titles.get(chapter.index) ?? chapterFirstLines.get(chapter.index) ?? "").slice(0, CHAPTER_FIRST_LINE_CHARS);
      return `### Ch ${chapter.index}${date ? ` · ${date}` : ""} · "${first}" · ${count} moments · carafe chapters ${d.sessionId} --chapter ${chapter.index}`;
    },
  });
  return rendered.text
    ? [`## Key moments (deterministic, seq-anchored — selected from the WHOLE session, not just the tail)`, ``, ...rendered.text.trimEnd().split("\n"), ``]
    : [];
}

export function renderHandoff(d: SessionDistillate, events: CarafeEvent[], opts: RenderOpts = {}): RenderResult {
  const hits: Record<string, number> = {};
  const pieces = preparedPieces(events, d.sessionId, opts, hits);
  const total = pieces.reduce((a, p) => a + p.chars, 0);

  if (total <= HANDOFF_BUDGET_CHARS) {
    const body = pieces.flatMap((p) => p.lines);
    const since = opts.answers?.length && opts.live ? sinceSection({ answers: opts.answers, live: opts.live, git: opts.answerFacts?.git ?? realGitRunner, exists: opts.answerFacts?.exists }) : null;
    const answers = opts.answers?.length ? answersLines(opts.answers, { ...opts.answerFacts, live: opts.live ?? NOTHING_READ, landed: since?.landed, changes: since?.changes }) : [];
    const collisions = sessionCollisionLines(opts.peerTraces ?? [], opts.live?.repos.filter((r) => !r.notChecked).map((r) => r.path) ?? [], since?.writtenAt ?? null, since?.changes ?? []);
    // Notes about the file are italic lines, never blockquotes: a `>` line reads
    // as a quotation, and only the trace is quoted in a handoff.
    const text = [
      ...header(d, events, pieces, opts),
      ...answers,
      ...(since?.lines ?? []),
      ...(opts.live ? liveLines(opts.live) : []),
      ...collisions,
      `_Faithful full trace. Read it and continue the work._`, ``, `---`, ``,
    ].join("\n") + body.join("\n\n") + "\n";
    return { text, tier: "full", lines: body.length, redactionHits: hits, tailStartSeq: events[0]?.seq ?? 0 };
  }

  const git = opts.answerFacts?.git ?? realGitRunner;
  const helperIds = (opts.helperTraces ?? []).map((helper) => helper.sessionId);
  // Memoize only within this generation. The bench's second pass has its own reads.
  const cache = new Map<string, string | null>();
  const run: GitRunner = (args, timeout) => {
    const key = JSON.stringify(args);
    if (!cache.has(key)) cache.set(key, git(args, timeout));
    return cache.get(key)!;
  };
  const now = opts.now ?? opts.live?.checkedAt ?? new Date().toISOString();
  const traces = [{ sessionId: d.sessionId, events, pieces, cwd: d.cwd }, ...(opts.helperTraces ?? []).map((h) => ({ ...h, pieces: preparedPieces(h.events, h.sessionId) }))];
  // L1 root cause — a helper's command resolves its repository from its OWN
  // `cd`/`-C`/worktree, never from the parent session's cwd.
  const states = traces.flatMap((t) => stateFromTrace(t.events, t.pieces, { cwd: t.cwd, via: t.sessionId === d.sessionId ? undefined : t.sessionId }));
  const paths = new Set<string>(opts.live?.repos.map((r) => r.path) ?? []);
  for (const state of states) paths.add(state.path);
  for (const t of traces) for (const c of boundCalls(t.events, t.pieces)) {
    if (!c.command) continue;
    for (const segment of commandSegments(expandCommandVars(c.command), t.cwd)) if (segment.dir && segment.named && /\bgit\b/.test(segment.text) && !hasShellVariable(segment.dir)) paths.add(segment.dir);
  }
  const live = opts.live;
  // Every (repo, branch, hash, path) triple this file is about to print outside
  // a verbatim quote or the agent's answers, verified against git right here.
  const current: Fact[] = [];
  // A repository with ninety local branches would spend the whole readable file
  // on its own verification record. Newest first, a few per repository, and the
  // rest is reported as a count.
  let omittedFacts = 0;
  for (const r of live?.repos ?? []) {
    if (r.notChecked) continue;
    current.push({ repo: r.path, branch: r.branch ?? undefined, hash: r.head?.hash, pairing: "tip" });
    if (r.defaultRef) current.push({ repo: r.path, branch: r.defaultRef.ref, hash: r.defaultRef.hash, pairing: "tip" });
    const unpushed = [...r.unpushed].sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""));
    for (const b of unpushed.slice(0, UNPUSHED_FACTS_PER_REPO)) current.push({ repo: r.path, branch: b.branch, hash: b.hash, pairing: "tip" });
    omittedFacts += Math.max(0, unpushed.length - UNPUSHED_FACTS_PER_REPO);
  }
  const historical: Fact[] = states.flatMap((s) => s.branch || s.head ? [{ repo: s.path, branch: s.branch?.value, hash: s.head?.value.hash, pairing: "ancestor" as const }] : []);
  // The same tuple is observed over and over in a long trace; verify each ONCE.
  const unique = (list: Fact[]): Fact[] => {
    const seenFacts = new Set<string>();
    return list.filter((f) => { const k = JSON.stringify([f.repo, f.branch, f.hash, f.path, f.pairing]); if (seenFacts.has(k)) return false; seenFacts.add(k); return true; });
  };
  const auditedNow = auditFacts(unique(current), [...paths], run);
  const auditedThen = auditFacts(unique(historical), [...paths], run);
  const counts: AuditCounts = { printed: 0, rehomed: 0, dropped: auditedNow.counts.dropped + auditedThen.counts.dropped };

  const blocks = buildBlocks(events, pieces);
  const set = extractMoments({ events, pieces });
  const chapters = segmentChapters(events, pieces, {}, set.moments, set.context.runs);
  const titles = chapterTitles(events, pieces, chapters, blocks, set.moments);
  const tsBySeq = tsIndex(events);
  const source = new Map(pieces.map((p) => [p.seq, p.lines.join("\n")]));
  // Entire literal strings, not a 40-character prefix or a normalized approximation.
  const quote = (text: string, seq: number): string[] => seq > 0 && source.get(seq)?.includes(text) && !hasShellVariable(text)
    ? [`[seq ${seq}]`, ...text.split("\n").map((l) => `> ${l}`), ""] : [];
  const repoTotals = repoCounts(d, events, pieces, opts.helperTraces);
  const principal = principalWorkspaces(repoTotals);
  const liveRepoPaths = new Set((live?.repos ?? []).filter((repo) => !repo.notChecked).map((repo) => repo.path));
  const answers = opts.answers ?? [];
  // round 8 — which repositories the file prints in full
  const namedByAnswers = new Set(answers.length ? reposNamedIn(answersText(answers), live?.repos ?? []) : []);
  const focus = focusRepos(live, repoTotals, namedByAnswers, lastChapterRepos(events, pieces, d.cwd, chapters, principal));
  const focusSet = new Set(focus);
  const groups: string[][] = [];
  const addLines = (body: string[]): void => { if (body.some(Boolean)) groups.push([...body, ...(body.at(-1) === "" ? [] : [""])]); };
  const add = (heading: string, body: string[]): void => { if (body.some(Boolean)) groups.push([`## ${heading}`, "", ...body, ""]); };
  const seen = new Set<string>();
  const printedFacts: Fact[] = [];
  const facts = (list: Fact[]): string[] => list.flatMap((f) => {
    const key = JSON.stringify([f.repo, f.branch, f.hash, f.path]);
    if (seen.has(key)) return [];
    seen.add(key); printedFacts.push(f);
    return [factLine(f)];
  });
  // Round 10: orientation and first move lead the answers, then Since,
  // prohibitions, Right now and the collision map.
  const since = answers.length && live ? sinceSection({ answers, live, git: run, now, exists: opts.answerFacts?.exists }) : null;

  // L4/B3 — what the outgoing agent said, every sentence stamped.
  const lastMessageAt = pieces.filter((p) => p.lines.some((l) => /^\*\*(?:user|assistant):\*\*/.test(l))).at(-1)?.ts ?? d.lastActivityTs ?? d.endTs;
  addLines(answers.length
    ? answersLines(answers, { ...opts.answerFacts, git: run, live: live ?? NOTHING_READ, lastMessageAt, landed: since?.landed, changes: since?.changes })
    : [`## What the outgoing agent said`, ``, `_No answers file. Ask the outgoing agent to run: carafe handoff ${d.sessionId} --questions_`]);
  const answersIndex = answers.length ? groups.length - 1 : -1;
  if (since) addLines(since.lines);
  const prohibitions = detectProhibitions(events, pieces, set.context, hasCausalCue);
  const restated = restatedSince(pieces, d.endTs);
  addLines(doNotLines(prohibitions, tsBySeq, d.endTs, PROHIBITIONS_IN_HANDOFF, restated));
  // L4 — Right now, with the audit line. Round 8: only the focus repositories
  // in full, every other one counted on one line; the verified-tip list is
  // not printed (the audit line still says how many tips were verified).
  const rightNow = live ? liveLines(live, { focus: focusSet }) : [];
  const body = rightNow.length ? rightNow.slice(2) : [];
  const machine = facts(auditedNow.facts);
  if (machine.length > MAX_FACT_LINES) { omittedFacts += machine.length - MAX_FACT_LINES; machine.length = MAX_FACT_LINES; }
  for (const repo of new Set(auditedNow.facts.map((f) => f.repo))) {
    if (!focusSet.has(repo) || live?.repos.some((r) => r.path === repo && r.modified != null && r.untracked != null)) continue;
    const status = run(["-C", repo, "status", "--porcelain"], 5000);
    if (status == null) continue;
    const rows = status.split("\n").filter(Boolean);
    body.push(`- status \`${repo}\`: ${rows.filter((l) => !l.startsWith("??")).length} modified, ${rows.filter((l) => l.startsWith("??")).length} untracked — git -C ${shell(repo)} status --porcelain`);
  }
  body.push("AUDIT_PLACEHOLDER");
  const rightNowIndex = groups.length;
  if (rightNow.length) groups.push([rightNow[0]!, ``, ...body, ``]);
  else add(`Right now (checked at ${now})`, body);
  addLines(sessionCollisionLines(opts.peerTraces ?? [], live?.repos.filter((r) => !r.notChecked).map((r) => r.path) ?? [], since?.writtenAt ?? null, since?.changes ?? []));
  const asks = detectOpenAsks(events, pieces, set.context, {
    belongs: turnBelonging(events, pieces, blocks, d.cwd, principal).belongs,
    endTs: d.endTs,
  });
  addLines(waitingLines(asks, tsBySeq, d.endTs, d.sessionId));
  // round 8 — everything after this point is optional orientation: under the
  // readability target it gives way, least useful first (ORIENT_DROP_ORDER).
  const optional = new Map<string[], string>();
  const requiredEnd = groups.length;
  const addOptional = (name: string, body: string[]): void => { const before = groups.length; addLines(body); if (groups.length > before) optional.set(groups.at(-1)!, name); };
  const pushes: PushObservation[] = [
    ...pushesFromTrace(events, pieces, { cwd: d.cwd }),
    ...traces.slice(1).flatMap((helper) => {
      try { return pushesFromTrace(helper.events, helper.pieces, { cwd: d.cwd, via: helper.sessionId }); } catch { return []; }
    }),
  ];
  addOptional("shipped", shippedLines(pushes, subjectsByHash(events, pieces), d.endTs, SHIPPED_MAX, pushVerifier(run), helperIds));
  // L4 — the newest recap only when it is newer than the answers.
  const recap = newestRecap(set.moments);
  if (recap) {
    const answerTime = Math.max(...answers.map((a) => Date.parse(a.writtenAt ?? "") || 0), 0);
    if ((Date.parse(tsBySeq.get(recap.seq) ?? "") || 0) > answerTime) addOptional("newest recap", newestRecapLines(set.moments, tsBySeq, d.endTs, live));
    else groups.push([`_Newest recap: carafe show ${d.sessionId} --seq ${recap.seq}_`, ""]);
  }
  // A historical tuple survives only when Right now did not reproduce it.
  addOptional("verified objects", (() => { const body = facts(auditedThen.facts); return body.length ? [`## Last seen (verified objects from the trace; not current checkout state)`, ``, ...body, ``] : []; })());
  // L3 — mined orientation only where the agent did not answer for it.
  // L3 — only where the outgoing agent did not define the terms itself, and
  // then only definitions that really are definitions and were not truncated.
  if (!answers.some((a) => a.sections.some((s) => s.question === 7))) {
    const defines = (e: { term: string; definition: string }): boolean => {
      const term = e.term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return new RegExp(`^(The |A |An )?${term} (is|are|means) (a|an|the) `, "i").test(e.definition) && !/…|\.\.\./.test(e.definition);
    };
    // ONE pass: the term scan walks every turn of the session, and on a large
    // trace asking for it twice cost a minute of the handoff's generation.
    // round 8 — a plain English word earns an entry only from a GENERIC
    // definition ("A row is an entry in the changelog", "row means …"). "The
    // disk is the new problem" says something about one disk; "Cards are the
    // main chat's cards" defines nothing. A name written in backticks or
    // capitalised mid-sentence keeps the looser rule.
    const genericDefinition = (e: { term: string; definition: string }): boolean => {
      const term = e.term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return new RegExp(`^(?:(?:A|An) ${term} (?:is|means)|${term} means) `, "i").test(e.definition);
    };
    const entries = glossaryEntries(pieces).filter(defines).filter((entry) => entry.kind !== "word" || genericDefinition(entry));
    const body = entries.length ? glossaryBlock(entries) : [];
    addOptional("glossary", body.some((l) => l.startsWith("- ")) ? body : []);
  }
  if (!answers.some((a) => a.sections.some((s) => s.question === 6))) {
    const explain = lessonExplainer(d, events, pieces, opts.helperTraces ?? []);
    const pool = withoutDoubleLabelled([...set.moments, ...helperMomentPool(d, events, opts.helperTraces ?? [])]);
    addOptional("lessons", lessonsLines(pool, tsBySeq, explain));
  }
  // Orientation the L4 order does not name. It follows every required section
  // and is the FIRST thing the readability budget takes away.
  const rightNowInfo = rightNowData(d, events, pieces, opts.helperTraces);
  addOptional("what this is", whatThisIsLines(d, events, pieces, chapters, set.moments));
  addOptional("last seen in the session", rightNowLines(d, events, pieces, opts.helperTraces, rightNowInfo, liveRepoPaths, pushVerifier(run)));
  addOptional("half-done", halfDoneLines(d, rightNowInfo, liveRepoPaths));
  addOptional("notes", notes(d, events, pieces, blocks, chapters));
  addOptional("standing instructions", instructionLines(set.moments, tsBySeq, d.endTs, prohibitionKeys(prohibitions), restated));
  addOptional("file map", fileMapLines(events, pieces, repoTotals.filter((repo) => principal.includes(repo.path))));
  addOptional("key moments", withoutEmptyChapters(momentsSection(d, events, pieces, blocks, chapters, titles, set, opts.helperTraces ?? [])));
  addOptional("recaps", recapLines(set.moments, tsBySeq, d.endTs));
  addOptional("project log", projectLogLines(d, events, pieces, [...liveRepoPaths]));
  // L4 — the retrieval block, last. Round 8: its heading is the section's own
  // (no empty "Dig deeper" over a second heading).
  const deepCore = [`## Dig deeper`, "", ...keys(d.sessionId).filter((l) => l !== "---" && l !== "" && !l.startsWith("## How to read the rest"))];
  const deepSiblings = siblingLines(opts.siblings);
  const goal = goalText(pieces);
  const deepGoal = goal ? ["", ...quote(goal.text, goal.seq)] : [];
  const deepChapters: string[] = [];
  for (const ch of chapters) {
    const title = titles.get(ch.index);
    if (title && !hasShellVariable(title) && !/^\(?session start\)?$/.test(title)) deepChapters.push(`Ch ${ch.index} · ${(ch.startTs ?? "").slice(0, 10)} → ${(ch.endTs ?? "").slice(0, 10)} · ${title} · carafe chapters ${d.sessionId} --chapter ${ch.index}`);
  }
  const deep = [...deepCore, ...deepSiblings, ...deepGoal, ...deepChapters];
  const head = [
    ...header(d, events, pieces, opts, focus),
    `_BIG SESSION (${(total / 1024).toFixed(0)}KB rendered ${tokenEstimate(total)} — exceeds a context window)._`,
    `_This is the ORIENTATION LAYER: the state right now + what the outgoing agent said + notes + key moments from the whole session + the verbatim tail._`,
    ``,
  ];
  // Round 8 — the readability target: a reader should reach the end of the
  // orientation in one sitting. Required sections (Since, the answers, Do not,
  // Right now, Waiting on the owner) never give way here; the optional ones do,
  // least useful first, and the file names what it left out. Round 9: the
  // target is 200 lines outside the tail, and the footer that says so is true —
  // it is written last, from the file itself.
  const flatLines = (parts: string[][]): number => parts.flat().join("\n").split("\n").length;
  const leftOut: string[] = [];
  deep.push(``, LENGTH_FOOTER);
  const over = (): boolean => flatLines([head, ...groups, deep]) > ORIENT_TARGET_LINES;
  if (over() && deepGoal.length) { const at = deep.indexOf(deepGoal[1]!); if (at > 0) deep.splice(at - 1, deepGoal.length); }
  if (over() && deepSiblings.length > SIBLINGS_UNDER_TARGET + 3) {
    const at = deep.indexOf(deepSiblings[0]!);
    const kept = siblingLines(opts.siblings?.slice(0, SIBLINGS_UNDER_TARGET), opts.siblings);
    if (at >= 0) deep.splice(at, deepSiblings.length, ...kept);
  }
  for (const name of ORIENT_DROP_ORDER) {
    if (!over()) break;
    const index = groups.findIndex((group) => optional.get(group) === name);
    if (index < 0) continue;
    groups.splice(index, 1);
    leftOut.push(name);
  }
  // round 9 — the chapter list is the earlier context once the tail is only
  // the last working day: it gives way last, oldest chapter first
  if (over() && deepChapters.length) {
    const at = deep.indexOf(deepChapters[0]!);
    let keep = deepChapters.length;
    const shown = (): string[] => keep >= deepChapters.length ? deepChapters
      : keep > 0 ? [`Chapters, newest ${keep} of ${deepChapters.length} (every one: carafe chapters ${d.sessionId}):`, ...deepChapters.slice(-keep)] : [];
    let current = deepChapters.length;
    while (over() && keep > 0) {
      keep--;
      const next = shown();
      deep.splice(at, current, ...next);
      current = next.length;
    }
    if (!keep) leftOut.push("the chapter list (carafe chapters)");
    else if (keep < deepChapters.length) leftOut.push(`${deepChapters.length - keep} older chapters`);
  }
  // B5 — whole blocks give way; never cut a quotation or leave a count-only stub.
  // +1: the rendered file terminates with a newline, so the text the reader (and
  // the launch gate) measures outside the tail carries one line more than this join.
  const fits = (parts: string[][]): boolean => { const t = parts.flat().join("\n"); return t.split("\n").length + 1 <= HANDOFF_MAX_LINES && Buffer.byteLength(t) + 1 <= HANDOFF_MAX_BYTES; };
  while (!fits([head, ...groups, deep]) && deep.length > 7) deep.splice(deep.length - 3, 1);
  // the required sections (Since, answers, Do not, Right now, Waiting) outlast every optional one
  while (!fits([head, ...groups, deep]) && groups.length > Math.max(1, requiredEnd)) groups.pop();
  // B3 — the answers are the normal path, so they are never dropped whole to
  // make room. An enormous answers file gives way one QUESTION at a time, and
  // the file says where the rest is.
  if (answersIndex >= 0) {
    const block = groups[answersIndex]!;
    while (!fits([head, ...groups, deep])) {
      const cut = block.map((line, i) => [line, i] as const).filter(([line, i]) => i > 2 && line.startsWith("### Q")).pop();
      if (!cut) break;
      block.length = cut[1];
      block.push(`_… the remaining answers did not fit here; they are in ${answers[0]!.path}._`, ``);
      if (fits([head, ...groups, deep])) break;
      block.length = cut[1];
    }
  }
  while (!fits([head, ...groups, deep]) && groups.length > 1) groups.pop();
  // Pathological state size: retain complete fact/status lines, not fragments.
  const stateBlock = groups[Math.min(rightNowIndex, groups.length - 1)]!;
  while (!fits([head, ...groups, deep]) && stateBlock.length > 5) stateBlock.splice(2, 1);
  for (let index = 0; index < groups.length; index++) groups[index] = refreshClaimsHeading(groups[index]!);
  const outside = [head, ...groups, deep].flat().join("\n");
  const surviving = printedFacts.filter((f) => outside.includes(factLine(f)));
  // round 8 — the verified tips are no longer printed; the audit line counts
  // what was verified (the tips) plus what Last seen printed
  counts.printed = machine.length + surviving.length;
  counts.rehomed = auditedNow.facts.filter((f) => f.foundIn).length + surviving.filter((f) => f.foundIn).length;
  const prefixLines = [head, ...groups].flat().map((l) => l === "AUDIT_PLACEHOLDER" ? auditLine(counts) : l);
  const prefixChars = prefixLines.join("\n").length;
  const tailBudgetChars = Math.max(0, Math.min(TAIL_BUDGET_CHARS, HANDOFF_MAX_CHARS - prefixChars - deep.join("\n").length - TAIL_RESERVE_CHARS));
  // round 9 — the tail is the last two or three turns of the last working day,
  // each dated; everything older is the chapter list's job
  const window: TailWindow = { maxTurns: HANDOFF_TAIL_TURNS, tsBySeq };
  let turnCap = turnCapFor(tailBudgetChars, HANDOFF_TAIL_TURNS);
  const rendering = tailRendering(d, events, blocks, pieces, { ...opts, principal, turnCap, window }, hits);
  const { lead: tailLead, leadWorkspace } = rendering;
  const opensTurn = (piece: EventPieces): boolean => piece.kind === "tangent" || piece.lines.some((line) => line.startsWith("**user:**"));
  const pick = (tailPieces: EventPieces[]): EventPieces[] => {
    const chosen: EventPieces[] = [];
    let tailChars = 0;
    let firstChosen = tailPieces.length;
    for (let i = tailPieces.length - 1; i >= 0; i--) {
      const p = tailPieces[i]!;
      if (tailChars + p.chars > tailBudgetChars) break;
      tailChars += p.chars;
      chosen.unshift(p);
      firstChosen = i;
    }
    // The budget cuts by character, which lands mid-turn: a tail that opens on an
    // assistant's reply reads as if the owner never said anything. Trim forward to
    // the turn boundary. A tangent note stands in for the turns it replaces, so it
    // is a boundary too.
    const firstUser = chosen.findIndex(opensTurn);
    const picked = firstUser > 0 ? chosen.slice(firstUser) : chosen;
    if (!picked.some(opensTurn)) {
      for (let i = firstChosen - 1; i >= 0; i--) {
        const piece = tailPieces[i]!;
        if (!opensTurn(piece)) continue;
        picked.unshift(piece);
        break;
      }
    }
    return picked;
  };
  // what is older than the last working day goes BEFORE the per-turn cap, so
  // the cap is spent on the working day and the old run is one line
  const fresh = withoutOlderDays(d.sessionId, rendering.raw, tsBySeq);
  let tail = pick(capTail(d.sessionId, fresh, turnCap));
  const lastBlockEnd = blocks.at(-1)?.endSeq ?? 0;
  const assemble = (chosenTail: EventPieces[]): { text: string; tailLines: string[]; tailStartSeq: number } => {
    const shownTail = datedTail(chosenTail);
    const tailLines = shownTail.flatMap((piece) => piece.lines);
    const tailStartSeq = chosenTail[0]?.seq ?? rendering.pieces[rendering.pieces.length - 1]?.seq ?? events[events.length - 1]?.seq ?? 0;
    const tailEndSeq = chosenTail.at(-1)?.seq ?? tailStartSeq;
    const userLines = chosenTail.filter((piece) => piece.lines.some((line) => line.startsWith("**user:**"))).length;
    const midTurnOpen = chosenTail.length > 0 && !opensTurn(chosenTail[0]!);
    const tailTurns = userLines + (midTurnOpen ? 1 : 0);
    const where = tailWorkspaces(events, pieces, blocks, d.cwd, tailStartSeq, tailEndSeq, principal).join(", ");
    const workspaceName = leadWorkspace == null || leadWorkspace === "no repository" || hasShellVariable(leadWorkspace)
      ? "another workspace"
      : basename(leadWorkspace);
    const cutTangent = leadWorkspace != null && lastBlockEnd > tailEndSeq
      ? [`_The session's final turns (seq ${tailEndSeq + 1} → end) were about ${workspaceName}; see the tangent line above._`]
      : [];
    const endedEarly = staleTailNote(d, events, blocks, tailEndSeq);
    const tailAge = narrativeAgeNote(tsBySeq.get(tailEndSeq) ?? null, live, "tail");
    const text = [
      ...prefixLines,
      `## The tail, verbatim (seq ${tailStartSeq} → ${tailEndSeq}: ${tailTurns === 1 ? "the last turn" : `the last ${tailTurns} turns`}${where ? ` of work in ${where}` : ` (no workspace attributed)`}, dated; earlier work is in the chapter list)${endedEarly}`,
      ``,
      ...(tailAge.length ? [...tailAge, ``] : []),
      ...(tailLead.length ? [...tailLead, ``] : []),
      ...(cutTangent.length ? [...cutTangent, ``] : []),
      ...(tailLead.length || cutTangent.length ? [``] : []),
    ].join("\n") + tailLines.join("\n\n") + `\n\n${deep.join("\n")}\n`;
    return { text, tailLines, tailStartSeq };
  };
  // round 9 — the whole file inside its line target: older turns go first,
  // then the last turn is capped harder, then its longest blocks are clipped
  // to a few lines each (with the command that shows the rest)
  const newlines = (text: string): number => (text.match(/\n/g) ?? []).length;
  let built = assemble(tail);
  let clipAt = Number.POSITIVE_INFINITY;
  for (let guard = 0; guard < 40 && newlines(built.text) > TOTAL_TARGET_LINES; guard++) {
    const starts = tail.map((piece, index) => (opensTurn(piece) ? index : -1)).filter((index) => index >= 0);
    if (starts.length > 1) tail = tail.slice(starts[1]);
    else if (turnCap > TAIL_TURN_MIN_CHARS) {
      turnCap = Math.max(TAIL_TURN_MIN_CHARS, Math.floor(turnCap / 2));
      const from = tail[0]?.seq ?? 0;
      tail = pick(capTail(d.sessionId, fresh, turnCap).filter((piece) => piece.seq >= from));
    } else {
      const next = TAIL_CLIP_LINES.find((lines) => lines < clipAt);
      if (next == null) break;
      clipAt = next;
      tail = tail.map((piece) => clipLongLines(d.sessionId, piece, clipAt));
    }
    built = assemble(tail);
  }
  // the footer, from the file as it is: lines outside the tail and in all
  const allLines = newlines(built.text);
  const outsideCount = newlines(built.text.replace(/^## The tail, verbatim[^\n]*\n[\s\S]*?(?=^## Dig deeper\b)/m, ""));
  const footer = `_Length: ${outsideCount} lines outside the verbatim tail, ${allLines} in all (targets ${ORIENT_TARGET_LINES} and ${TOTAL_TARGET_LINES}).${leftOut.length ? ` Left out for length: ${leftOut.join(", ")} — all of it is in the trace: carafe chapters / ask / show ${d.sessionId}.` : ""}_`;
  const text = built.text.replace(LENGTH_FOOTER, () => footer);
  const { tailLines, tailStartSeq } = built;
  return { text, tier: "layered", lines: tailLines.length + blocks.length, redactionHits: hits, tailStartSeq, audit: counts };
}

/**
 * The parent turn a helper agent ran under: the last event of this session that
 * started no later than the helper's own first event. Clock only — the two
 * traces have separate sequence spaces, and nothing else relates them.
 */
export function parentSeqOf(events: CarafeEvent[], helper: HelperTrace): number | null {
  const started = Date.parse(helper.events[0]?.ts ?? "");
  if (!Number.isFinite(started)) return null;
  let best: number | null = null;
  for (const event of events) {
    const at = Date.parse(event.ts ?? "");
    if (!Number.isFinite(at) || at > started) continue;
    best = event.seq;
  }
  return best;
}

/**
 * W3 — the moments the helpers found, anchored to the parent turn that launched
 * them. Their own seq travels with them as `viaSeq`, so every rendered line
 * says `agent-xx seq N` and never a number that means something else here.
 */
export function helperMomentPool(d: SessionDistillate, events: CarafeEvent[], helpers: HelperTrace[]): KeyMoment[] {
  const out: KeyMoment[] = [];
  for (const helper of helpers) {
    const parent = parentSeqOf(events, helper);
    if (parent == null) continue;
    let moments: KeyMoment[] = [];
    try {
      const pieces = preparedPieces(helper.events, helper.sessionId);
      moments = extractMoments({ events: helper.events, pieces }).moments;
    } catch { continue; }
    const chosen = moments
      .filter((moment) => moment.kind !== "goal" && moment.kind !== "rule" && moment.kind !== "recap" && moment.kind !== "instruction")
      .sort((a, b) => b.seq - a.seq)
      .slice(0, HELPER_MOMENTS_EACH);
    for (const moment of chosen) out.push({ ...moment, seq: parent, via: agentLabel(helper.sessionId, helpers.map((one) => one.sessionId)), viaSeq: moment.seq });
  }
  return out;
}

/**
 * The helper's own last turns, verbatim, anchored to the turn that launched it.
 *
 * The first version of this printed one summary line per helper and stacked
 * seven of them under a single user turn — a list of agents, not a record of
 * what they did. What the next session needs is the same thing the tail gives
 * it for the parent: the turns.
 */
export function helperTailPieces(d: SessionDistillate, events: CarafeEvent[], helpers: HelperTrace[], opts: RenderOpts, hits: Record<string, number>): EventPieces[] {
  const out: EventPieces[] = [];
  for (const helper of helpers) {
    const parent = parentSeqOf(events, helper);
    if (parent == null) continue;
    let prepared: EventPieces[] = [];
    let blocks: TurnBlock[] = [];
    try {
      prepared = withoutSelfGeneration(withoutHarnessOnAll(extractPieces(helper.events, { ...opts, resultCap: TAIL_RESULT_CAP }, hits), helper.sessionId), helper.sessionId).map(indentResults);
      blocks = buildBlocks(helper.events, prepared);
    } catch { continue; }
    const lastAssistant = prepared.flatMap((p) => p.lines).filter((line) => /^\*\*assistant:\*\*/.test(line)).at(-1)?.replace(/^\*\*assistant:\*\*\s*/, "").trim();
    if (lastAssistant && /^(?:you(?:'|’)ve hit (?:your |the )?(?:session|usage) limit|session limit reached)[.!]?(?:\s*[·—-]?\s*(?:resets?|try again|please try|your limit)[^\n]*)?$/i.test(lastAssistant)) continue;
    if (!blocks.length) continue;
    const shown = blocks.slice(-HELPER_TAIL_TURNS);
    const fromSeq = shown[0]!.startSeq;
    const toSeq = shown.at(-1)!.endSeq;
    const inWindow = prepared.filter((piece) => piece.seq >= fromSeq && piece.seq <= toSeq);
    // newest first until the ceiling, then back into trace order
    const kept: EventPieces[] = [];
    let chars = 0;
    for (let index = inWindow.length - 1; index >= 0; index--) {
      const piece = inWindow[index]!;
      if (chars + piece.chars > HELPER_TAIL_CHARS && kept.length) break;
      chars += piece.chars;
      kept.unshift(piece);
    }
    const body = kept.flatMap((piece) => piece.lines);
    if (!body.length) continue;
    const shownFrom = kept[0]!.seq;
    const label = agentLabel(helper.sessionId, helpers.map((one) => one.sessionId));
    const lines = [
      `_↳ helper agent-${label} — its last ${shown.length} turn${shown.length === 1 ? "" : "s"} (seq ${shownFrom}–${toSeq} of its own trace)_`,
      ...withoutShellVariables(body).map((line) => `  ${line}`),
      `  _carafe show ${helper.sessionId} --seq ${blocks[0]!.startSeq}-${toSeq}_`,
    ];
    out.push({ seq: parent, kind: "helper", lines, chars: lines.reduce((sum, line) => sum + line.length, 0), ts: helper.events[0]?.ts ?? null });
  }
  return out;
}

/**
 * The truthful suffix for the tail's heading when the principal work ended more
 * than a day before the session did: the date it ended, how many turns came
 * after it, and where those turns went.
 */
export function staleTailNote(d: SessionDistillate, events: CarafeEvent[], blocks: TurnBlock[], tailEndSeq: number): string {
  const tsBySeq = tsIndex(events);
  const endedAt = Date.parse(tsBySeq.get(tailEndSeq) ?? "");
  const sessionEnd = Date.parse(d.endTs ?? "");
  if (!Number.isFinite(endedAt) || !Number.isFinite(sessionEnd) || sessionEnd - endedAt < STALE_MS) return "";
  const later = blocks.filter((block) => block.startSeq > tailEndSeq);
  if (!later.length) return "";
  const names = [...new Set(later.flatMap((block) => [...block.paths]).map((path) => basename(dirname(path))))]
    .filter((name) => name && !hasShellVariable(name)).slice(0, 3);
  const date = (tsBySeq.get(tailEndSeq) ?? "").slice(0, 10);
  return ` (the last principal work ended ${date}; ${later.length} later turn${later.length === 1 ? "" : "s"} were tangents${names.length ? `: ${names.join(", ")}` : ""})`;
}

/** How far past a moment the sentence that explains it may sit. */
const LESSON_LOOKAHEAD_TURNS = 2;

/**
 * The lesson lookup the Lessons section uses: for one moment, the first
 * assistant sentence within the next two turns of the moment's OWN trace that
 * says WHY. A helper's moment is explained by the helper's own words.
 */
export function lessonExplainer(d: SessionDistillate, events: CarafeEvent[], pieces: EventPieces[], helpers: HelperTrace[]): LessonLookup {
  interface Trace { blocks: TurnBlock[]; pieces: EventPieces[] }
  const main: Trace = { blocks: buildBlocks(events, pieces), pieces };
  const byLabel = new Map<string, Trace>();
  for (const helper of helpers) {
    try {
      const prepared = preparedPieces(helper.events, helper.sessionId);
      byLabel.set(agentLabel(helper.sessionId, helpers.map((one) => one.sessionId)), { blocks: buildBlocks(helper.events, prepared), pieces: prepared });
    } catch { /* an unreadable helper simply explains nothing */ }
  }
  return (moment) => {
    const trace = moment.via ? byLabel.get(moment.via) : main;
    if (!trace) return null;
    const at = moment.via ? moment.viaSeq ?? moment.seq : moment.seq;
    const start = trace.blocks.findIndex((block) => at >= block.startSeq && at <= block.endSeq);
    const from = start < 0 ? at : trace.blocks[start]!.startSeq;
    const last = start < 0 ? at : (trace.blocks[Math.min(trace.blocks.length - 1, start + LESSON_LOOKAHEAD_TURNS)]!.endSeq);
    for (const piece of trace.pieces) {
      if (piece.seq < from || piece.seq > last) continue;
      for (const line of piece.lines) {
        if (!line.startsWith("**assistant:**")) continue;
        for (const raw of quotableSentences(line.replace(/^\*\*assistant:\*\*\s*/, ""))) {
          if (hasCausalCue(raw)) return { text: raw, seq: piece.seq };
        }
      }
    }
    return null;
  };
}

/** How many repositories the tail's label can name. */
const TAIL_LABEL_REPOS = 3;

/**
 * The repositories the rendered tail's own turns touched, busiest first, as
 * basenames. A label that names the session's principal repositories is a claim
 * about turns that may have gone nowhere near them — on a real session the last
 * turn touched neither of the two the label named.
 */
export function tailWorkspaces(
  events: CarafeEvent[],
  pieces: EventPieces[],
  blocks: TurnBlock[],
  cwd: string | null | undefined,
  fromSeq: number,
  toSeq: number,
  principal?: string[],
): string[] {
  const { keys } = turnBelonging(events, pieces, blocks, cwd, principal);
  const counts = new Map<string, number>();
  for (const [position, block] of blocks.entries()) {
    // a tail that opens mid-turn still worked in that turn's repositories
    if (block.endSeq < fromSeq || block.startSeq > toSeq) continue;
    // the agent's own memory is not a repository the tail worked in
    for (const key of keys[position] ?? []) if (!isAgentStateWorkspace(key)) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, TAIL_LABEL_REPOS).map(([path]) => basename(path));
}

/** Which turns belong to the principal work, and which workspace each turn
 *  touched. A turn with no tool calls is pure conversation: it always belongs. */
export function turnBelonging(
  events: CarafeEvent[],
  pieces: EventPieces[],
  blocks: TurnBlock[],
  cwd?: string | null,
  principalOverride?: string[],
): { belongs: boolean[]; keys: Array<Set<string>>; principal: string[] } {
  // Two passes. The first resolves the directories that CAN be resolved and
  // decides the principal set; the second re-reads every unresolvable call with
  // that set in hand, so a command that spells a principal repository's name is
  // attributed to it.
  const principal = principalOverride ?? principalWorkspaces(reposWorkedIn(events, pieces, cwd));
  const byEvent = workspaceKeysByEvent(events, pieces, cwd, undefined, principal);
  const keys = blocks.map(() => new Set<string>());
  let index = 0;
  for (const event of events) {
    while (index + 1 < blocks.length && event.seq >= blocks[index + 1]!.startSeq) index++;
    for (const key of byEvent.get(event.seq) ?? []) keys[index]!.add(key);
  }
  const principalSet = new Set(principal);
  // A turn is a tangent ONLY when its repo-attributed calls touch no principal
  // key and at least one real, non-principal one. Conversation, a test run, and
  // work in /tmp or the scratch directory (which never survive `workspaceKeysByEvent`)
  // leave a turn with no keys at all — that is the surrounding work, not a detour.
  const belongs = blocks.map((block, position) => {
    if (block.toolCalls === 0 || keys[position]!.size === 0) return true;
    for (const key of keys[position]!) if (principalSet.has(key)) return true;
    return false;
  });
  // (a turn that only read the agent's own state keeps its key here, so it
  // falls through to `false` above — that is the point of not excluding it)

  // After the last turn that actually touched the principal work, a turn with no
  // paths at all is still that work — until the session turns away. From the
  // first tangent onwards nothing is the working state, however much
  // conversation follows it: that whole stretch is what the tangent line stands
  // for. (The real symptom: a tail that was entirely a closing chat about a
  // desktop-app failure, because none of those turns named a path.)
  const touched = blocks.map((_, position) => [...keys[position]!].some((key) => principalSet.has(key)));
  const last = touched.lastIndexOf(true);
  if (last >= 0) {
    const tangentAfter = belongs.findIndex((value, position) => position > last && !value);
    if (tangentAfter > 0) for (let position = tangentAfter; position < belongs.length; position++) belongs[position] = false;
  }
  return { belongs, keys, principal };
}

interface TailSegment { kind: "turn" | "tangent"; block?: TurnBlock; line?: string; anchorSeq: number; touched?: string }

function tangentOf(sessionId: string, run: TurnBlock[], keys: Array<Set<string>>, positions: number[], afterSeq: number): { line: string; touched: string } {
  const counts = new Map<string, number>();
  for (const position of positions) for (const key of keys[position]!) counts.set(key, (counts.get(key) ?? 0) + 1);
  const touched = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? "no repository";
  const first = (run[0]?.firstLine ?? "").slice(0, TANGENT_LINE_CHARS);
  return {
    line: `Tangent after seq ${afterSeq}: "${first}" · ${run.length} turn${run.length === 1 ? "" : "s"} · touched ${touched} · carafe show ${sessionId} --seq ${run[0]!.startSeq}-${run.at(-1)!.endSeq}`,
    touched,
  };
}

/**
 * The tail follows the PRINCIPAL work. A session whose last hours wandered into
 * another repository must not hand that wandering over as "the working state":
 * the tangent becomes one retrievable line, and the verbatim turns are the last
 * twelve that belong.
 */
export interface TailWindow {
  /** how many turns of the principal work the tail keeps (default: twelve) */
  maxTurns?: number;
  /** round 9 — with the events' clock: no turn that started more than a day
   *  before the last one ("the last working day"); the last one always stays */
  tsBySeq?: Map<number, string | null>;
}
/** Round 9 — "the last working day": how far before the last turn the tail may reach. */
export const TAIL_DAY_MS = 24 * 60 * 60 * 1000;

export function tailSegments(d: SessionDistillate, events: CarafeEvent[], pieces: EventPieces[], blocks: TurnBlock[], principal?: string[], window: TailWindow = {}): TailSegment[] {
  const maxTurns = window.maxTurns ?? TAIL_TURNS;
  const { belongs, keys } = turnBelonging(events, pieces, blocks, d.cwd, principal);
  const lastBelong = belongs.lastIndexOf(true);
  if (lastBelong < 0) return blocks.slice(-maxTurns).map((block) => ({ kind: "turn" as const, block, anchorSeq: block.startSeq }));

  const belonging: number[] = [];
  for (let position = 0; position <= lastBelong; position++) if (belongs[position]) belonging.push(position);
  let kept = belonging.slice(-maxTurns);
  if (window.tsBySeq) {
    // the last working day ends with the last turn's last event, not its first
    const lastBlock = blocks[kept.at(-1)!]!;
    let lastAt = Number.NaN;
    for (let seq = lastBlock.endSeq; seq >= lastBlock.startSeq && !Number.isFinite(lastAt); seq--) lastAt = Date.parse(window.tsBySeq.get(seq) ?? "");
    if (Number.isFinite(lastAt)) kept = kept.filter((position, index) => index === kept.length - 1 || !(lastAt - Date.parse(window.tsBySeq!.get(blocks[position]!.startSeq) ?? "") > TAIL_DAY_MS));
  }
  const windowStart = kept[0] ?? lastBelong;

  const segments: TailSegment[] = [];
  // the work that came after the principal work: one line, before the tail
  if (lastBelong < blocks.length - 1) {
    const run = blocks.slice(lastBelong + 1);
    const positions = run.map((_, offset) => lastBelong + 1 + offset);
    segments.push({ kind: "tangent", ...tangentOf(d.sessionId, run, keys, positions, blocks[lastBelong]!.endSeq), anchorSeq: blocks[lastBelong]!.endSeq });
  }
  for (let position = windowStart; position <= lastBelong;) {
    if (belongs[position]) {
      segments.push({ kind: "turn", block: blocks[position]!, anchorSeq: blocks[position]!.startSeq });
      position++;
      continue;
    }
    let end = position;
    while (end <= lastBelong && !belongs[end]) end++;
    const run = blocks.slice(position, end);
    const positions = run.map((_, offset) => position + offset);
    if (run.length >= TANGENT_RUN_TURNS) {
      segments.push({ kind: "tangent", ...tangentOf(d.sessionId, run, keys, positions, blocks[position - 1]?.endSeq ?? run[0]!.startSeq), anchorSeq: run[0]!.startSeq });
    } else {
      for (const block of run) segments.push({ kind: "turn", block, anchorSeq: block.startSeq });
    }
    position = end;
  }
  return segments;
}

/**
 * The pieces the tail is built from. The tail's turns get a wider tool-result
 * cap — they hold the documents the next agent must act on — it stops before
 * the command that generated this handoff, and it ends on the last thing the
 * assistant SAID, never on a tool result, with a line saying so.
 */
function tailRendering(d: SessionDistillate, events: CarafeEvent[], blocks: TurnBlock[], basePieces: EventPieces[], opts: RenderOpts & { principal?: string[]; turnCap?: number; window?: TailWindow }, hits: Record<string, number>): { pieces: EventPieces[]; raw: EventPieces[]; lead: string[]; leadWorkspace: string | null; turnStarts: number[] } {
  const segments = tailSegments(d, events, basePieces, blocks, opts.principal, opts.window);
  const turns = segments.filter((segment) => segment.kind === "turn");
  const fromSeq = turns[0]?.block!.startSeq ?? blocks.at(-1)?.startSeq ?? events[0]?.seq ?? 0;
  const inTail = (seq: number): boolean => turns.some((segment) => seq >= segment.block!.startSeq && seq <= segment.block!.endSeq);
  const wide = extractPieces(events.filter((event) => event.seq >= fromSeq && inTail(event.seq)), { ...opts, resultCap: TAIL_RESULT_CAP }, hits);
  const stripped = withoutHarnessOnAll(wide, d.sessionId).map(indentResults);
  const bounded = stripped.filter((piece) => piece.seq < trailingGenerationSeq(stripped, d.sessionId));
  // Only the chosen turns: the tail is the last turns of the PRINCIPAL work,
  // not "as much of the end as the budget holds".
  const cleaned = withoutSelfGeneration(bounded, d.sessionId);

  // A tangent inside the tail window sits in trace order, as a note about the
  // file (never a quotation). The tangent the session ENDED on is not part of
  // the working state at all: it goes above the tail, once.
  const lastTurnEnd = turns.at(-1)?.block!.endSeq ?? fromSeq;
  const inline = segments.filter((segment) => segment.kind === "tangent" && segment.anchorSeq < lastTurnEnd).sort((a, b) => a.anchorSeq - b.anchorSeq);
  const leadSegments = segments.filter((segment) => segment.kind === "tangent" && segment.anchorSeq >= lastTurnEnd);
  const lead = leadSegments.map((segment) => `_${segment.line}_`);
  const leadWorkspace = leadSegments[0]?.touched ?? null;
  const withTangents: EventPieces[] = [];
  let next = 0;
  for (const piece of cleaned) {
    while (next < inline.length && inline[next]!.anchorSeq < piece.seq) {
      const line = `_${inline[next]!.line}_`;
      withTangents.push({ seq: inline[next]!.anchorSeq, kind: "tangent", lines: [line], chars: line.length, ts: null });
      next++;
    }
    withTangents.push(piece);
  }
  // W3 — a helper agent's turns sit in the tail where its parent launched it.
  // The work of the last two days ran inside helpers on the session that lost
  // this comparison, and the tail showed none of it.
  const helperPieces = helperTailPieces(d, events, opts.helperTraces ?? [], opts, hits)
    .filter((piece) => piece.seq >= fromSeq && piece.seq <= lastTurnEnd);
  // …after the tail has been trimmed to the last thing the assistant said:
  // a helper's block is not "trailing tool results", and cutting it would throw
  // away the only record of the work this session delegated.
  const trimmed = endOnAssistantText(withTangents, turns.at(-1)?.block!.startSeq ?? fromSeq);
  const merged: EventPieces[] = [];
  let helperNext = 0;
  const ordered = helperPieces.slice().sort((a, b) => a.seq - b.seq);
  for (const piece of trimmed) {
    merged.push(piece);
    while (helperNext < ordered.length && ordered[helperNext]!.seq <= piece.seq) merged.push(ordered[helperNext++]!);
  }
  while (helperNext < ordered.length) merged.push(ordered[helperNext++]!);
  return {
    // no single turn may spend more than its share of the tail budget
    pieces: capTail(d.sessionId, merged, opts.turnCap ?? TAIL_TURN_MAX_CHARS),
    raw: merged,
    lead,
    leadWorkspace,
    turnStarts: turns.map((segment) => segment.block!.startSeq),
  };
}

/**
 * Hold one turn inside `TAIL_TURN_MAX_CHARS`.
 *
 * What survives is what a reader needs: what the owner said, what the assistant
 * said back, the first two calls (how the turn started) and the last three (how
 * it ended). The calls in between become one retrievable line. If that is still
 * too much, the surviving results are clipped — with the same marker the rest
 * of the trace uses, so following it works.
 */
export function capTurnPieces(sessionId: string, turn: EventPieces[], turnCap: number = TAIL_TURN_MAX_CHARS): EventPieces[] {
  if (sizeOfPieces(turn) <= turnCap) return turn;

  // The calls the omission may drop. A helper's block is NOT one of them: it is
  // the work the turn delegated, it is already held to its own budget by
  // `capHelperPieces`, and a turn that drops it loses the only record of what
  // the helper did. It still counts against the turn's total.
  const calls: EventPieces[][] = [];
  for (const piece of turn) {
    if (!isOmissiblePiece(piece)) continue;
    if (opensCallPiece(piece) || !calls.length) calls.push([piece]);
    else calls.at(-1)!.push(piece);
  }

  // One Claude Code assistant event can carry three calls and be followed by
  // three 6 KB results, so "two calls at the head and three at the end" is not
  // a fixed size: keep shrinking the window until the turn really fits.
  let last: EventPieces[] = turn;
  for (const [head, tail] of TAIL_TURN_WINDOWS) {
    last = clipResults(sessionId, capHelperPieces(withOmission(sessionId, turn, calls, head, tail), helperCapFor(turnCap)));
    if (sizeOfPieces(last) <= turnCap) return last;
  }
  // Six helpers at the 400-char floor still do not fit: the OLDEST become one
  // line each until the turn does. The cap is a promise, not a preference.
  return dropOldestHelpers(sessionId, last, turnCap);
}

/**
 * The last resort: helper blocks become ONE line, oldest first, until the turn
 * fits. A real turn listed twenty-one helper lines, twenty of them the same
 * "omitted" sentence — a list of agents where a reader wanted a turn — so the
 * omitted ones are collapsed into a single line that names the newest three.
 */
function dropOldestHelpers(sessionId: string, turn: EventPieces[], turnCap: number): EventPieces[] {
  const dropped = new Set<number>();
  const render = (): EventPieces[] => {
    const out: EventPieces[] = [];
    let placed = false;
    for (const [index, piece] of turn.entries()) {
      if (!dropped.has(index)) { out.push(piece); continue; }
      if (placed) continue;
      placed = true;
      out.push(collapsedHelperLine(sessionId, [...dropped].sort((a, b) => a - b).map((at) => turn[at]!)));
    }
    return out;
  };
  for (const [index, piece] of turn.entries()) {
    if (sizeOfPieces(render()) <= turnCap) break;
    if (piece.kind !== "helper" || piece.lines.length <= 1) continue;
    dropped.add(index);
  }
  return render();
}

/** How many helper ids the collapsed line names. */
const HELPERS_NAMED = 3;

export function collapsedHelperLine(sessionId: string, pieces: EventPieces[]): EventPieces {
  if (pieces.length === 1) return helperOmittedLine(pieces[0]!);
  const labels = pieces.map(HELPER_LABEL);
  const newest = labels.slice(-HELPERS_NAMED).reverse();
  const more = labels.length - newest.length;
  const line = `_↳ ${labels.length} helper agents omitted (${newest.join(", ")}${more > 0 ? `, +${more} more` : ""}) — carafe handoff ${sessionId} lists them; carafe show <helper-id> for any_`;
  return { seq: pieces[0]!.seq, kind: "helper", lines: [line], chars: line.length, ts: null };
}

const sizeOfPieces = (pieces: EventPieces[]): number => pieces.reduce((sum, piece) => sum + piece.chars, 0);

/** The windows tried in order: generous first, then as tight as it takes. */
const TAIL_TURN_WINDOWS: ReadonlyArray<readonly [number, number]> = [[2, 3], [1, 2], [1, 1], [0, 1]];

/** The turn with the middle calls replaced by one retrievable line. */
function withOmission(sessionId: string, turn: EventPieces[], calls: EventPieces[][], head: number, tail: number): EventPieces[] {
  const keepHead = new Set(calls.slice(0, head).flat());
  const keepLast = new Set(tail ? calls.slice(-tail).flat() : []);
  const omitted = calls.filter((call) => !call.some((piece) => keepHead.has(piece) || keepLast.has(piece)));
  if (!omitted.length) return turn;

  const out: EventPieces[] = [];
  let markerPlaced = false;
  for (const piece of turn) {
    if (!isOmissiblePiece(piece) || keepHead.has(piece) || keepLast.has(piece)) { out.push(piece); continue; }
    // A Claude Code assistant event carries the assistant's WORDS in the same
    // piece as its calls. Dropping the piece whole would drop what it said —
    // the one thing in a turn that is never recoverable by re-running a
    // command. The calls go; the sentences stay.
    const said = piece.lines.filter((line) => line.startsWith("**assistant:**"));
    if (said.length) out.push(withLines(piece, said));
    if (markerPlaced) continue;
    markerPlaced = true;
    const seqs = omitted.flat().map((one) => one.seq);
    const line = `    […${omitted.length} tool call${omitted.length === 1 ? "" : "s"} omitted — carafe show ${sessionId} --seq ${Math.min(...seqs)}-${Math.max(...seqs)}]`;
    out.push({ seq: Math.min(...seqs), kind: "omitted", lines: [line], chars: line.length, ts: null });
  }
  return out;
}

/** Every result line in the turn, clipped — including the ones inside a
 *  helper's block, whose marker points at the HELPER's trace. */
function clipResults(sessionId: string, pieces: EventPieces[]): EventPieces[] {
  return pieces.map((piece) => {
    if (!isResultPiece(piece)) return piece;
    const ref = piece.kind === "helper" ? helperRef(piece) ?? { sessionId, seq: piece.seq } : { sessionId, seq: piece.seq };
    return withLines(piece, piece.lines.map((line) => (RESULT_LINE_RE.test(line)
      ? clipPiece(withoutClipMarker(line), TAIL_TURN_RESULT_CHARS, ref)
      : line)));
  });
}

/* ------------------------------------------------------------------ *
 * What a piece IS, read from its rendered lines.
 *
 * Never from `piece.kind`. A Claude Code trace has no `tool_use` events at
 * all: a call is a `tool_use` BLOCK inside an assistant event and its result is
 * a `tool_result` block inside a user event, so `kind` is only ever "user",
 * "assistant", "meta" or "system". Classifying by kind meant none of the caps
 * below ever fired on a Claude Code session — the very sessions this was
 * written for — and one real last turn rendered at 42 KB with nothing omitted
 * and nothing clipped. The rendered lines are the same for both tools.
 * ------------------------------------------------------------------ */

/** `→ **Bash** {…}` — indented when it sits inside a helper's block. */
const CALL_LINE_RE = /^\s*→ \*\*/;
/** A result line, whatever it is nested under. */
const RESULT_LINE_RE = /^\s*\u2937/;

export const isCallPiece = (piece: EventPieces): boolean => piece.lines.some((line) => CALL_LINE_RE.test(line));
export const isResultPiece = (piece: EventPieces): boolean => piece.lines.some((line) => RESULT_LINE_RE.test(line));
export const isUserPiece = (piece: EventPieces): boolean => piece.lines.some((line) => line.startsWith("**user:**"));
export const isAssistantTextPiece = (piece: EventPieces): boolean => piece.lines.some((line) => line.startsWith("**assistant:**"));

/**
 * A piece the head/last selection may drop. A helper's block is a tool call by
 * another name — it is what the turn spent its time on — and one Claude Code
 * assistant event can hold the assistant's words AND three calls in a single
 * piece: that piece is a call, kept or dropped as one unit.
 */
export const isToolPiece = (piece: EventPieces): boolean =>
  !isUserPiece(piece) && (piece.kind === "helper" || isCallPiece(piece) || isResultPiece(piece));

export const opensCallPiece = (piece: EventPieces): boolean =>
  !isUserPiece(piece) && (piece.kind === "helper" || isCallPiece(piece));

/** …and the ones the omission is allowed to replace with a line. */
export const isOmissiblePiece = (piece: EventPieces): boolean => isToolPiece(piece) && piece.kind !== "helper";

/** A piece's `chars` is always what its lines actually cost. */
function withLines(piece: EventPieces, lines: string[]): EventPieces {
  return { ...piece, lines, chars: lines.reduce((sum, line) => sum + line.length, 0) };
}

/**
 * The helper blocks inside one turn, held to `TAIL_HELPER_MAX_CHARS` between
 * them. Each keeps its header (which agent, which seqs) and as much of its END
 * as the share allows — the last thing a helper did is the useful thing — with
 * one line saying what was dropped and how to read it.
 */
export function capHelperPieces(turn: EventPieces[], budget: number = TAIL_HELPER_MAX_CHARS): EventPieces[] {
  const helpers = turn.filter((piece) => piece.kind === "helper");
  if (!helpers.length) return turn;
  if (helpers.reduce((sum, piece) => sum + piece.chars, 0) <= budget) return turn;
  const share = Math.max(TAIL_HELPER_MIN_CHARS, Math.floor(budget / helpers.length));
  return turn.map((piece) => (piece.kind === "helper" ? clipHelperPiece(piece, share) : piece));
}

const HELPER_HEADER_RE = /↳ helper (agent-\S+)/;
const HELPER_FOOTER_RE = /carafe show (\S+) --seq (\d+)-(\d+)/;

/** The helper's own session and seq range, read back off its footer line. */
export function helperRef(piece: EventPieces): { sessionId: string; seq: number } | null {
  const match = HELPER_FOOTER_RE.exec(piece.lines.at(-1) ?? "");
  return match ? { sessionId: match[1]!, seq: Number(match[2]) } : null;
}

const HELPER_LABEL = (piece: EventPieces): string => HELPER_HEADER_RE.exec(piece.lines[0] ?? "")?.[1] ?? "agent";
const HELPER_WHERE = (piece: EventPieces): string => {
  const match = HELPER_FOOTER_RE.exec(piece.lines.at(-1) ?? "");
  return match ? `carafe show ${match[1]} --seq ${match[2]}-${match[3]}` : "carafe show <helper-id>";
};

/** The one line a helper block becomes when even its floor will not fit. */
export function helperOmittedLine(piece: EventPieces): EventPieces {
  const line = `_↳ helper ${HELPER_LABEL(piece)} omitted — ${HELPER_WHERE(piece)}_`;
  return { ...piece, kind: "helper", lines: [line], chars: line.length };
}

const CALL_LINE_ANY = /^\s*→ \*\*/;
const SPEECH_LINE = /^\s*\*\*(?:user|assistant):\*\*/;
const ASSISTANT_LINE = /^\s*\*\*assistant:\*\*/;
/** How much of a helper's closing words survive its own cap. */
const HELPER_LAST_SAID_CHARS = 600;

/**
 * One helper block, bounded by CHARACTERS — hard.
 *
 * The turn-granular version of this was defeated by the real shape: a helper
 * launched by the Agent tool has exactly ONE user turn (its prompt) and then
 * hundreds of tool calls with no further user line, so "keep whole trailing
 * turns" kept the whole helper. Six of them rendered 38.2 KB inside a single
 * turn. Now the block keeps its header, the last thing the helper SAID, and as
 * much of its ending as its share allows — and nothing else.
 */
export function clipHelperPiece(piece: EventPieces, budget: number): EventPieces {
  if (piece.chars <= budget) return piece;
  const [header = "", ...rest] = piece.lines;
  const footer = rest.at(-1) ?? "";
  // …and what it said is clipped with a marker that points at the HELPER's own
  // trace, never at an unfilled `<id>` placeholder
  const ref = helperRef(piece);
  const body = rest.slice(0, -1).map((line) => (ASSISTANT_LINE.test(line) ? clipPiece(line, HELPER_LAST_SAID_CHARS, ref ?? undefined) : line));
  const marker = (calls: number): string =>
    `  […helper ${HELPER_LABEL(piece)}: ${calls} more tool call${calls === 1 ? "" : "s"} — ${HELPER_WHERE(piece)}]`;

  const room = Math.max(0, budget - header.length - footer.length - marker(0).length - 8);
  const kept: string[] = [];
  let chars = 0;
  // the last thing it said comes first, whatever else fits
  const lastSaid = body.map((line, index) => (ASSISTANT_LINE.test(line) ? index : -1)).filter((index) => index >= 0).at(-1);
  if (lastSaid != null) { kept.push(body[lastSaid]!); chars += body[lastSaid]!.length; }
  for (let index = (lastSaid ?? body.length) - 1; index >= 0; index--) {
    const line = body[index]!;
    if (chars + line.length > room) break;
    chars += line.length;
    kept.unshift(line);
  }
  // a block that opens on a bare result shows an answer to a question nobody
  // can see: drop leading results until a call or a spoken line leads
  while (kept.length && !CALL_LINE_ANY.test(kept[0]!) && !SPEECH_LINE.test(kept[0]!)) kept.shift();

  const shown = new Set(kept);
  const omittedCalls = body.filter((line) => CALL_LINE_ANY.test(line) && !shown.has(line)).length;
  return withLines(piece, [header, marker(omittedCalls), ...kept, footer]);
}

/**
 * Round 9 — the date a tail turn was said on, on the line above it, and the
 * date its last event came in when that is an hour or more later. A tail with
 * no dates put a push from nine days earlier beside the last day's work.
 */
export function datedTail(pieces: EventPieces[]): EventPieces[] {
  const out = pieces.slice();
  const opens = (piece: EventPieces): boolean => isUserPiece(piece) && !isResultPiece(piece);
  for (let index = 0; index < out.length; index++) {
    const piece = out[index]!;
    if (!opens(piece) || !piece.ts || piece.ts.length < 16) continue;
    let last: EventPieces = piece;
    for (let next = index + 1; next < out.length && !opens(out[next]!) && out[next]!.kind !== "tangent"; next++) {
      const one = out[next]!;
      if (one.kind !== "helper" && one.ts && one.ts.length >= 16 && Date.parse(one.ts) >= Date.parse(last.ts!)) last = one;
    }
    const later = Date.parse(last.ts!) - Date.parse(piece.ts) >= 60 * 60 * 1000;
    const line = later ? `_${stamp(piece.ts)} → ${stamp(last.ts)} · seq ${piece.seq}–${last.seq}_` : `_${stamp(piece.ts)} · seq ${piece.seq}_`;
    out[index] = withLines(piece, [line, ...piece.lines]);
  }
  return out;
}

/**
 * Round 9 — "never material older than the last working day": one turn can
 * run for days (a session resumed without a new message), and its first days
 * are not the working state. Everything in the tail that happened more than a
 * day before its newest event — except the owner's own opening line — becomes
 * one line per run, with the command that shows it.
 */
export function withoutOlderDays(sessionId: string, pieces: EventPieces[], tsBySeq: Map<number, string | null> = new Map()): EventPieces[] {
  // a helper's block sits at the parent turn that launched it: it is as old as that turn
  const when = (piece: EventPieces): number => Date.parse((piece.kind === "helper" ? tsBySeq.get(piece.seq) ?? piece.ts : piece.ts) ?? "");
  const times = pieces.map(when).filter(Number.isFinite);
  if (!times.length) return pieces;
  const cutoff = Math.max(...times) - TAIL_DAY_MS;
  const keep = (piece: EventPieces): boolean => (isUserPiece(piece) && !isResultPiece(piece)) || piece.kind === "tangent";
  const old = pieces.map((piece) => { const at = when(piece); return Number.isFinite(at) && at < cutoff && !keep(piece); });
  // a piece with no clock of its own (a marker) goes with the old run around it
  for (let index = 0; index < pieces.length; index++) {
    if (old[index] || keep(pieces[index]!) || Number.isFinite(when(pieces[index]!))) continue;
    let next = index + 1;
    while (next < pieces.length && !Number.isFinite(when(pieces[next]!)) && !keep(pieces[next]!)) next++;
    if (index > 0 && old[index - 1] && next < pieces.length && old[next]) old[index] = true;
  }
  old[pieces.length - 1] = false;
  const out: EventPieces[] = [];
  let run: EventPieces[] = [];
  const flush = (): void => {
    if (!run.length) return;
    const seqs = run.map((one) => one.seq);
    const days = [...new Set(run.map((one) => (Number.isFinite(when(one)) ? new Date(when(one)).toISOString().slice(0, 10) : "")).filter(Boolean))];
    const line = `    […${run.length} event${run.length === 1 ? "" : "s"}${days.length ? ` from ${days.join(", ")}` : ""}, older than the last working day, omitted — carafe show ${sessionId} --seq ${Math.min(...seqs)}-${Math.max(...seqs)}]`;
    out.push({ seq: Math.min(...seqs), kind: "omitted", lines: [line], chars: line.length, ts: null });
    run = [];
  };
  for (const [index, piece] of pieces.entries()) {
    if (old[index]) { run.push(piece); continue; }
    flush();
    out.push(piece);
  }
  flush();
  return out;
}

/** One block of the tail held to `maxLines` lines, with the command that shows the rest. */
export function clipLongLines(sessionId: string, piece: EventPieces, maxLines: number): EventPieces {
  if (piece.kind === "helper") return piece;
  let changed = false;
  const lines = piece.lines.map((line) => {
    const rows = line.split("\n");
    if (rows.length <= maxLines) return line;
    changed = true;
    const indent = /^\s*/.exec(rows[1] ?? "")?.[0] ?? "";
    return [...rows.slice(0, maxLines), `${indent}[…${rows.length - maxLines} more lines — carafe show ${sessionId} --seq ${piece.seq}]`].join("\n");
  });
  return changed ? withLines(piece, lines) : piece;
}

/** Every turn in a rendered tail, capped. */
export function capTail(sessionId: string, pieces: EventPieces[], turnCap: number = TAIL_TURN_MAX_CHARS): EventPieces[] {
  const turns: EventPieces[][] = [];
  for (const piece of pieces) {
    // a Claude Code tool RESULT is a user event; it does not open a turn
    if ((isUserPiece(piece) && !isResultPiece(piece)) || !turns.length) turns.push([piece]);
    else turns.at(-1)!.push(piece);
  }
  return turns.flatMap((turn) => capTurnPieces(sessionId, turn, turnCap));
}

/** A result already clipped once must not collect a second marker. */
function withoutClipMarker(line: string): string {
  return line.replace(/\n?\s*\[…[^\]]*?more chars[^\]]*?\]\s*$/, "");
}

/**
 * A tool result quoted in the tail is a DOCUMENT, not structure: a review file
 * whose lines begin with `##` turned five of its own headings into sections of
 * the handoff. Indenting every line of a result by four spaces makes markdown
 * treat it as preformatted text. The tail only — moment rendering and
 * everything the bench renders are untouched.
 */
function indentResults(piece: EventPieces): EventPieces {
  if (!piece.lines.some((line) => line.trimStart().startsWith("\u2937"))) return piece;
  const lines = piece.lines.map((line) => {
    if (!line.trimStart().startsWith("\u2937")) return line;
    // the marker line loses its two-space lead; every other line keeps its own
    // indentation under the four spaces that make the block preformatted
    const [first, ...rest] = line.split("\n");
    return [`    ${(first ?? "").trimStart()}`, ...rest.map((part) => `    ${part}`)].join("\n");
  });
  return { ...piece, lines, chars: lines.reduce((sum, line) => sum + line.length, 0) };
}

/**
 * End the tail on the last thing the assistant SAID in the last turn — a tail
 * that trails off into tool results hands over a half-finished thought. When
 * that turn never spoke (it ends mid-work), nothing is cut: a handoff drops no
 * work to make its ending tidy. Either way the last line says where it stops.
 */
function endOnAssistantText(pieces: EventPieces[], lastTurnStartSeq: number): EventPieces[] {
  if (!pieces.length) return pieces;
  let lastIndex = -1;
  let lastLine = -1;
  for (let index = 0; index < pieces.length; index++) {
    const piece = pieces[index]!;
    if (piece.seq < lastTurnStartSeq) continue;
    for (let line = 0; line < piece.lines.length; line++) {
      if (piece.lines[line]!.startsWith("**assistant:**")) { lastIndex = index; lastLine = line; }
    }
  }
  const kept = lastIndex < 0 ? pieces.slice() : pieces.slice(0, lastIndex + 1);
  const endIndex = kept.length - 1;
  const last = kept[endIndex]!;
  const body = lastIndex < 0 ? last.lines : last.lines.slice(0, lastLine + 1);
  const lines = [...body, `_(last observed at seq ${last.seq}; check Right now above before acting on it)_`];
  kept[endIndex] = { ...last, lines, chars: lines.reduce((sum, line) => sum + line.length, 0) };
  return kept;
}

/**
 * Where the tail must stop. A session that generated a handoff mid-way and then
 * worked for three more days has a generation call in its middle, not at its
 * end: cutting there would throw the work away. Only a TRAILING call shortens
 * the tail — one after which nothing remains but its own result and empty
 * pieces. Mid-tail calls are removed line-by-line by `withoutSelfGeneration`
 * and change nothing else.
 */
export function trailingGenerationSeq(pieces: EventPieces[], sessionId: string): number {
  let cut = Number.MAX_SAFE_INTEGER;
  for (let index = pieces.length - 1; index >= 0; index--) {
    const piece = pieces[index]!;
    if (piece.lines.some((line) => isSelfGenerationLine(line, sessionId))) { cut = piece.seq; continue; }
    if (!piece.lines.length) continue;
    // a result belongs to the call above it; anything else is real work, and
    // real work after a generation call means that call was not trailing
    if (piece.lines.every((line) => line.trimStart().startsWith("⤷"))) continue;
    break;
  }
  return cut;
}

function withoutHarnessOnAll(pieces: EventPieces[], sessionId: string): EventPieces[] {
  return pieces.map((p) => {
    const lines = withoutHarnessContext(p.lines, p.seq, sessionId);
    return lines === p.lines ? p : { ...p, lines, chars: lines.reduce((a, l) => a + l.length, 0) };
  });
}
