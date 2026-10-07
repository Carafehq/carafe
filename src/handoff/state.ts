/**
 * "Right now" — the working state of the repositories, read out of the trace
 * itself. Every field is the LAST observation of its kind: the result of a
 * `git branch`, `git log -1`, `git status`, `git ls-remote`, `git push` or a
 * `/health` probe the session actually ran. Nothing here touches the
 * repository: a handoff describes what was seen, at the seq where it was seen,
 * and says so. Deterministic, no model, no network.
 */
import type { CarafeEvent } from "../format/events";
import { isAgentStateWorkspace, isExcludedWorkspace, workspaceKey } from "../query/sessions";
import { boundCalls } from "./calls";
import type { EventPieces } from "./pieces";
import { commandRepoPath, commandSegments, expandCommandVars, workspaceOf } from "./worktrees";

/** One reading, with the place in the trace it was read at — and, when it came
 *  from a helper session's own trace, which session that was. */
export interface Observed<T> {
  value: T;
  seq: number;
  ts: string | null;
  via?: string;
  /**
   * v6/V9 — the directory the command that produced this reading NAMED, and
   * null when it named none. Two readings may only share a rendered line when
   * the same tool result produced both (same seq) or both named the same
   * directory: a branch read in one place welded to a HEAD read in another is
   * how "acme-backend · branch opus/row42-null-guard · HEAD 0959ebf
   * \"init empty stub\"" reached three handoffs in a row.
   */
  dir?: string | null;
}

export interface HeadReading { hash: string; subject: string | null }
export interface TrackingReading { ahead: number; behind: number }
export interface RemoteReading { branch: string; hash: string | null }

export interface RepoState {
  /** the repository, or — when nothing in the trace says which repository a
   *  checkout belongs to — the checkout's own path */
  path: string;
  /** false when this is a working copy whose repository the trace never named */
  attributed?: boolean;
  /**
   * true when every field here comes from commands that named no directory at
   * all, so the reading is only as good as the assumption that the shell was
   * still in the session's cwd. Such readings are kept in their own state:
   * a branch read in one directory must never be welded to a HEAD read in
   * another (a real handoff put an acme-api branch on a stub repo's
   * "init empty stub" commit).
   */
  cwdAssumed?: boolean;
  branch?: Observed<string>;
  /** the seq where the CURRENT branch value was first observed — a flag read
   *  before the branch was ever seen says nothing about that branch */
  branchSince?: number;
  head?: Observed<HeadReading>;
  remote?: Observed<RemoteReading>;
  tracking?: Observed<TrackingReading>;
  dirty?: Observed<number>;
  /** W3/v5: EVERY uncommitted count this repository was seen with, in order. A
   *  single count is not an alarm — a count that CHANGED is. */
  dirtySeen?: Array<Observed<number>>;
  pushed?: Observed<string>;
  rejected?: Observed<string>;
}

export interface HealthState { url: string; body: string; seq: number; ts: string | null; via?: string }

export interface StateOpts {
  /** the session's cwd — the repo a bare command ran in */
  cwd?: string | null;
  /** when given, only these workspace keys are reported, in this order */
  repos?: string[];
  /** worktree path → repository, learned from the trace */
  worktrees?: Map<string, string>;
  /** the session these observations came from, when it is not the main one */
  via?: string;
  /** branch names known to belong to a repository, pooled across traces */
  knownBranches?: Map<string, Set<string>>;
}

/** The first 200 characters of a health probe's body is the whole signal. */
export const HEALTH_BODY_CHARS = 200;

interface PendingCall { seq: number; ts: string | null; command: string; repo: string | null; via?: string; dir?: string | null }

export interface CommandWorkspace {
  /** the repository when one is known, else the working copy's own path */
  id: string | null;
  /** the directory the command ran in, with the command's variables substituted */
  path: string | null;
  attributed: boolean;
}

/**
 * Where a command ran: `-C <path>`, a leading `cd <path>`, else the session's
 * own cwd — variables substituted, worktrees attributed to their repository.
 * A checkout under an excluded workspace that no `git worktree add` in this
 * trace created is NOT dropped: it is reported under its own path until
 * something else in the trace says which repository it belongs to.
 */
export function commandWorkspace(command: string, cwd?: string | null, worktrees?: Map<string, string>): CommandWorkspace {
  const expanded = expandCommandVars(command);
  return workspaceAt(commandRepoPath(expanded, cwd) ?? cwd ?? null, worktrees);
}

/** The workspace a directory belongs to, and whether anything named it. */
export function workspaceAt(path: string | null, worktrees?: Map<string, string>): CommandWorkspace {
  if (!path) return { id: null, path: null, attributed: false };
  const key = workspaceOf(path, worktrees);
  // the agent's own state has no repository state to report
  if (isAgentStateWorkspace(key) || isAgentStateWorkspace(path)) return { id: null, path, attributed: false };
  if (key && !isExcludedWorkspace(key)) return { id: key, path, attributed: true };
  return { id: normalize(path), path, attributed: false };
}

/** The repository a command ran in, or null when the trace never named one. */
export function repoOfCommand(command: string, cwd?: string | null, worktrees?: Map<string, string>): string | null {
  const resolved = commandWorkspace(command, cwd, worktrees);
  return resolved.attributed ? resolved.id : null;
}

const normalize = (path: string): string => (path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path);

/**
 * Branch names a result attributes to a repository: the remote refs of an
 * `ls-remote`, the locals and remotes of `branch -vv` / `branch -a`, the refs of
 * a `for-each-ref`, and the branch a push moved. They are how a checkout with no
 * recorded repository is matched to one: a branch is a name two places share.
 */
export function branchesInResult(command: string, body: string): string[] {
  const names = new Set<string>();
  const add = (name: string | undefined): void => { if (name && BRANCH_NAME_RE.test(name) && name !== "HEAD") names.add(name.replace(/^origin\//, "")); };
  if (/\bgit\b[^\n]*\b(?:ls-remote|for-each-ref)\b/.test(command)) {
    for (const match of body.matchAll(/refs\/(?:heads|remotes\/[^/]+)\/(\S+)/g)) add(match[1]);
  }
  if (/\bgit\b[^\n]*\bbranch\b/.test(command)) {
    for (const line of body.split("\n")) {
      const local = /^[*+]?\s*(?:remotes\/[^/\s]+\/)?([\w./-]+)\s/.exec(line.trim());
      add(local?.[1]);
    }
  }
  if (/\bgit\b[^\n]*\bpush\b/.test(command)) {
    for (const match of body.matchAll(/->\s+([\w./-]+)/g)) add(match[1]);
  }
  return [...names];
}

const resultBody = (line: string): string => line.replace(/^\s*⤷\s*/, "");
const nonEmptyLines = (body: string): string[] => body.split("\n").map((line) => line.trim()).filter(Boolean);

const BRANCH_NAME_RE = /^[\w./-]+$/;
/** Every repository has these: they identify nothing. */
const GENERIC_BRANCHES = new Set(["main", "master", "develop", "head", "trunk"]);
const HASH_RE = /^[0-9a-f]{7,40}$/i;

const bucketOf = (repo: string, cwdAssumed: boolean): string => `${repo}\u0000${cwdAssumed ? "cwd" : "dir"}`;

function stateOf(states: Map<string, RepoState>, repo: string, cwdAssumed = false): RepoState {
  const key = bucketOf(repo, cwdAssumed);
  const existing = states.get(key);
  if (existing) return existing;
  const created: RepoState = cwdAssumed ? { path: repo, cwdAssumed: true } : { path: repo };
  states.set(key, created);
  return created;
}

/**
 * Every repository state the trace observed, keyed by workspace. Later
 * observations overwrite earlier ones field by field, so each field is the
 * last reading of its own kind — a `git status` seen after a `git log` does not
 * erase the commit.
 */
export function stateFromTrace(events: CarafeEvent[], pieces: EventPieces[], opts: StateOpts = {}): RepoState[] {
  const states = new Map<string, RepoState>();
  const branchesByRepo = new Map<string, Set<string>>(
    [...(opts.knownBranches ?? new Map())].map(([repo, branches]) => [repo, new Set(branches)]),
  );
  for (const call of boundCalls(events, pieces)) {
    if (call.command == null) continue;
    // Segment by segment, each with the directory in force when it ran: one
    // command can visit two repositories, and a reading belongs to the one it
    // was actually taken in.
    const segments = commandSegments(expandCommandVars(call.command), opts.cwd).filter((segment) => /\bgit\b/.test(segment.text));
    // a result shared by several readings of one shape is consumed in order
    const repeated = new Map<ReadingShape, string[] | null>();
    const counts = new Map<ReadingShape, number>();
    for (const segment of segments) {
      const shape = shapeOf(segment.text);
      if (shape) counts.set(shape, (counts.get(shape) ?? 0) + 1);
    }
    for (const [shape, count] of counts) {
      if (count < 2) continue;
      const matches = shapeMatches(shape, call.result ?? "");
      repeated.set(shape, matches.length === count ? matches : null);
    }
    const taken = new Map<ReadingShape, number>();

    for (const segment of segments) {
      const command = segment.text;
      if (call.result == null && branchFromSwitch(command) == null) continue;
      const shape = shapeOf(command);
      let body: string | null = call.result;
      if (shape && repeated.has(shape)) {
        const matches = repeated.get(shape) ?? null;
        const index = taken.get(shape) ?? 0;
        taken.set(shape, index + 1);
        // the lines did not number the same as the readings: no guess
        body = matches === null ? null : matches[index] ?? null;
      }
      const where = workspaceAt(segment.dir, opts.worktrees);
      if (!where.id) continue;
      const state = stateOf(states, where.id, !segment.named);
      if (!where.attributed) state.attributed = false;
      // the directory the command NAMED — null when it only assumed the cwd
      const namedDir = segment.named ? segment.dir ?? null : null;
      const switched = branchFromSwitch(command);
      if (switched) setBranch(state, { value: switched, seq: call.seq, ts: call.ts, ...(opts.via ? { via: opts.via } : {}), dir: namedDir });
      if (body != null) readInto(state, { seq: call.seq, ts: call.ts, command, repo: where.id, via: opts.via, dir: namedDir }, body);
      if (where.attributed) {
        const known = branchesByRepo.get(where.id) ?? new Set<string>();
        for (const branch of branchesInResult(command, body ?? "")) known.add(branch);
        branchesByRepo.set(where.id, known);
        if (opts.knownBranches) opts.knownBranches.set(where.id, new Set(known));
      }
    }
  }

  // A checkout whose repository the trace never named still belongs somewhere:
  // if the branch it is on is a branch a known repository has, it is that
  // repository's working copy, and its readings are that repository's state.
  for (const [id, state] of [...states]) {
    if (state.attributed !== false) continue;
    const branch = state.branch?.value?.replace(/^origin\//, "");
    if (!branch || GENERIC_BRANCHES.has(branch.toLowerCase())) continue;
    const owners = [...branchesByRepo].filter(([, branches]) => branches.has(branch)).map(([repo]) => repo);
    // a branch two repositories both have says nothing about where this
    // checkout came from, and a guess here files a reading under a repository
    // it was never taken in
    if (owners.length !== 1) continue;
    mergeState(stateOf(states, owners[0]!, state.cwdAssumed === true), state);
    states.delete(id);
  }

  const all = [...states.values()].filter((state) => Object.keys(state).length > (state.attributed === false ? 2 : 1));
  const unattributed = all.filter((state) => state.attributed === false);
  const attributed = all.filter((state) => state.attributed !== false);
  if (!opts.repos) return [...attributed, ...unattributed];
  const order = new Map(opts.repos.map((repo, index) => [repo, index]));
  // the named repositories first, in the header's order; a checkout with no
  // recorded repository follows them — a reading is never dropped in silence
  return [...attributed.filter((state) => order.has(state.path)).sort((a, b) => order.get(a.path)! - order.get(b.path)!), ...unattributed];
}

const STATE_FIELDS = ["branch", "head", "remote", "tracking", "dirty", "pushed", "rejected"] as const;

/** Which of two readings is the later one. Sequence numbers are per-session, so
 *  two traces can only be compared by the clock; within one trace the sequence
 *  is the truth. */
export function isNewer(incoming: { seq: number; ts: string | null; via?: string }, current: { seq: number; ts: string | null; via?: string }): boolean {
  const a = Date.parse(incoming.ts ?? "");
  const b = Date.parse(current.ts ?? "");
  if (Number.isFinite(a) && Number.isFinite(b) && a !== b) return a > b;
  if ((incoming.via ?? null) === (current.via ?? null)) return incoming.seq > current.seq;
  return false;
}

/** Field-by-field, newest observation wins. */
export function mergeState(target: RepoState, source: RepoState): void {
  if (source.dirtySeen?.length) {
    const seen = new Map((target.dirtySeen ?? []).map((one) => [`${one.via ?? ""}:${one.seq}`, one]));
    for (const one of source.dirtySeen) seen.set(`${one.via ?? ""}:${one.seq}`, one);
    target.dirtySeen = [...seen.values()].sort((a, b) => Date.parse(a.ts ?? "") - Date.parse(b.ts ?? "") || a.seq - b.seq);
  }
  for (const field of STATE_FIELDS) {
    const incoming = source[field] as Observed<unknown> | undefined;
    if (!incoming) continue;
    const current = target[field] as Observed<unknown> | undefined;
    if (!current || isNewer(incoming, current)) {
      (target as unknown as Record<string, unknown>)[field] = incoming;
      if (field === "branch") {
        const since = source.branchSince ?? (incoming as Observed<string>).seq;
        target.branchSince = (current as Observed<string> | undefined)?.value === (incoming as Observed<string>).value && target.branchSince != null
          ? Math.min(target.branchSince, since)
          : since;
      }
    }
  }
}

/**
 * One state per repository out of several traces — this session's and its
 * helpers'. The helpers did the work the parent only talked about, so their
 * readings are usually the newest ones.
 */
export function mergeRepoStates(lists: RepoState[][]): RepoState[] {
  const byPath = new Map<string, RepoState>();
  const order: string[] = [];
  for (const list of lists) {
    for (const state of list) {
      const key = bucketOf(state.path, state.cwdAssumed === true);
      const existing = byPath.get(key);
      if (!existing) {
        byPath.set(key, { ...state });
        order.push(key);
        continue;
      }
      if (state.attributed === false && existing.attributed !== false) existing.attributed = undefined;
      mergeState(existing, state);
    }
  }
  return order.map((key) => byPath.get(key)!);
}

/**
 * The shape of a reading — what KIND of line in a result answers it.
 *
 * One command can ask the same question of two repositories:
 * `cd X && git -C <frontend> rev-parse HEAD && git -C <backend> rev-parse HEAD`
 * returns two hashes in one result, and "the first hash-shaped line" filed the
 * frontend's commit under the backend. When a result serves several segments of
 * the same shape, each takes its OWN line, in order — and if the lines do not
 * number the same as the segments, every reading of that shape is dropped
 * rather than guessed.
 */
export type ReadingShape = "head-hash" | "branch-name" | "log" | "porcelain" | "ls-remote";

export function shapeOf(command: string): ReadingShape | null {
  if (!/\bgit\b/.test(command)) return null;
  if (/\bls-remote\b/.test(command)) return "ls-remote";
  if (/\bstatus\b[^\n]*--porcelain\b/.test(command)) return "porcelain";
  if (/\brev-parse\s+--abbrev-ref\s+HEAD\b/.test(command) || /\bbranch\s+--show-current\b/.test(command)) return "branch-name";
  if (/\brev-parse\b(?![^\n]*--abbrev-ref)/.test(command)) return "head-hash";
  if (/\blog\b/.test(command)) return "log";
  return null;
}

/** The parts of a result that answer a reading of this shape, in order. */
export function shapeMatches(shape: ReadingShape, body: string): string[] {
  if (shape === "porcelain") return body.split(/\n\s*\n/).map((block) => block.trimEnd()).filter((block) => block.trim());
  const lines = body.split("\n").map((line) => line.trim()).filter(Boolean);
  switch (shape) {
    case "head-hash": return lines.filter((line) => HASH_RE.test(line));
    case "branch-name": return lines.filter((line) => BRANCH_NAME_RE.test(line) && !HASH_RE.test(line));
    case "log": return lines.filter((line) => /^[0-9a-f]{7,40}\s+\S/i.test(line) || /^commit [0-9a-f]{7,40}/i.test(line));
    case "ls-remote": return lines.filter((line) => /^[0-9a-f]{40}\s+refs\/(?:heads|remotes)\//.test(line));
  }
}

/** `git checkout -B <name>` / `git switch -c <name>` — the command itself says
 *  what the branch became; its output says nothing and is not needed. */
export function branchFromSwitch(command: string): string | null {
  if (/\s--\s/.test(command)) return null;
  const match = /\bgit\s+(?:checkout|switch)\b((?:\s+-{1,2}[\w-]+)*)\s+-[bBcC]\s+([\w./-]+)/.exec(command)
    ?? /\bgit\s+(?:checkout|switch)\s+-[bBcC]\s+([\w./-]+)/.exec(command);
  const name = match?.[2] ?? match?.[1] ?? null;
  return name && !name.startsWith("-") ? name : null;
}

/** The branch reading, and the seq this branch value was first seen at. */
function setBranch(state: RepoState, observed: Observed<string>): void {
  if (state.branch?.value !== observed.value) state.branchSince = observed.seq;
  else state.branchSince = Math.min(state.branchSince ?? observed.seq, observed.seq);
  state.branch = observed;
}

function readInto(state: RepoState, call: PendingCall, body: string): void {
  const { command, seq, ts, via, dir } = call;
  const at = <T>(value: T): Observed<T> => ({ value, seq, ts, ...(via ? { via } : {}), dir: dir ?? null });
  const lines = nonEmptyLines(body);
  const first = lines[0] ?? "";

  // branch — the command asked for it, or a status result announced it
  if (/\bgit\b[^\n]*\b(?:branch\s+--show-current|rev-parse\s+--abbrev-ref\s+HEAD)\b/.test(command)
    && BRANCH_NAME_RE.test(first) && !/^(?:exit|error|fatal)/i.test(first)) setBranch(state, at(first));
  // `On branch X` is a reading of the command that printed it, not of every
  // command that shares the result blob with it.
  if (/\bgit\b[^\n]*\b(?:status|checkout|switch|branch|pull|merge|stash)\b/.test(command)) {
    const onBranch = /^On branch (\S+)$/m.exec(body);
    if (onBranch?.[1]) setBranch(state, at(onBranch[1]));
  }

  // HEAD — a bare hash, or the first line of a log. Independent tests, never a
  // chain: a compound command carries several of these shapes at once, and one
  // of them matching must not silence the rest.
  if (/\bgit\b[^\n]*\brev-parse\b(?![^\n]*--abbrev-ref)/.test(command) && HASH_RE.test(first)) {
    state.head = at({ hash: first, subject: null });
  }
  if (/\bgit\b[^\n]*\blog\b/.test(command) && !/\bgit\s+log\b[^\n]*(?<!\.\.)\borigin\/\S+/.test(command)) {
    // the log's own first line, which a compound command can push below an echo
    const logLine = lines.find((line) => /^[0-9a-f]{7,40}\s+\S/i.test(line) || /^commit [0-9a-f]{7,40}/i.test(line)) ?? "";
    const logged = /^([0-9a-f]{7,40})\s+(.*)$/i.exec(logLine) ?? /^commit ([0-9a-f]{7,40})/i.exec(logLine);
    if (logged) state.head = at({ hash: logged[1]!, subject: (logged[2] ?? "").trim() || null });
  }

  // the remote's tip — ls-remote, or a log of origin/<branch>
  const lsRemote = /\bgit\b[^\n]*\bls-remote\b/.test(command)
    ? /^([0-9a-f]{40})\s+refs\/heads\/(\S+)/im.exec(body)
    : null;
  if (lsRemote) state.remote = at({ branch: lsRemote[2]!, hash: lsRemote[1]! });
  else if (/\bgit\b[^\n]*\blog\b[^\n]*(?<!\.\.)\borigin\/(\S+)/.test(command)) {
    const branch = /\borigin\/([\w./-]+)/.exec(command)?.[1] ?? "main";
    const logged = /^([0-9a-f]{7,40})\s/i.exec(first) ?? /^commit ([0-9a-f]{7,40})/i.exec(first);
    if (logged) state.remote = at({ branch, hash: logged[1]! });
  }

  // ahead / behind — `branch -vv`, `status -sb`, `for-each-ref`
  // `[ahead 2]`, `[origin/x: ahead 2, behind 1]`, `[behind 3]`
  if (/\bgit\b[^\n]*\b(?:branch|status|for-each-ref)\b/.test(command)) {
    const ahead = /\[[^\]]*?\bahead (\d+)(?:,\s*behind (\d+))?\]/.exec(body);
    const behindOnly = ahead ? null : /\[[^\]]*?\bbehind (\d+)\]/.exec(body);
    const forEachRef = ahead || behindOnly ? null : /\bahead[= ](\d+)\b/.exec(body);
    if (ahead) state.tracking = at({ ahead: Number(ahead[1]), behind: Number(ahead[2] ?? 0) });
    else if (behindOnly) state.tracking = at({ ahead: 0, behind: Number(behindOnly[1]) });
    else if (forEachRef && /\bfor-each-ref\b/.test(command)) state.tracking = at({ ahead: Number(forEachRef[1]), behind: 0 });
  }

  // a push that landed, and a push that was refused
  if (/\bgit\b[^\n]*\bpush\b/.test(command)) {
    if (/\brejected\b|\bnon-fast-forward\b/i.test(body)) {
      state.rejected = at(pushTarget(command, body) ?? state.branch?.value ?? "?");
    } else {
      const target = pushTarget(command, body);
      if (target) state.pushed = at(target);
    }
  }

  // the dirty count is the porcelain line count, whatever it contains
  if (/\bgit\b[^\n]*\bstatus\b[^\n]*--porcelain\b/.test(command)) {
    const reading = at(lines.length);
    state.dirty = reading;
    state.dirtySeen = [...(state.dirtySeen ?? []), reading];
  }
}

/** The branch a push moved: the `-> <branch>` mark, a `[new branch]` line, or
 *  the refspec on the command itself. */
function pushTarget(command: string, body: string): string | null {
  const arrow = /->\s+([\w./-]+)/.exec(body);
  if (arrow?.[1]) return arrow[1].replace(/^origin\//, "");
  // `git -C <path> push [-flags] <remote> [HEAD:]<branch>`
  const refspec = /\bpush\b(?:\s+-{1,2}[\w-]+)*\s+\S+\s+(?:HEAD:)?([\w./-]+)/.exec(command);
  return refspec?.[1] ?? null;
}

/* ------------------------------------------------------------------ *
 * v6/V5 — what reached a remote.
 *
 * Round 6: the production lockdown appeared twenty times in the file, as branch
 * names and commit subjects, and the file never once said that it had shipped.
 * Every `git push` whose RESULT says it moved `main`, `master` or created a new
 * branch is one observed fact, quoted with its own seq and clock. Nothing here
 * says "deployed": carafe cannot see a deploy, only a push result.
 * ------------------------------------------------------------------ */

export interface PushObservation {
  /** the repository the push ran in */
  repo: string;
  /** the ref it moved, as the result printed it */
  ref: string;
  /** the new commit, when the result printed a range */
  hash: string | null;
  /** that commit's subject, when the trace shows it somewhere */
  subject: string | null;
  seq: number;
  ts: string | null;
  via?: string;
  /** true when the result announced `[new branch]` rather than a range */
  newBranch: boolean;
  /**
   * true when the push command aimed at main/master, the result carried no
   * error, and there was nothing to read — `git push -q`, or a chain ending in
   * `| tail -1` that swallowed the summary. The push RAN; carafe says exactly
   * that and no hash.
   */
  noOutput: boolean;
}

/** `main`, `master`, or a brand-new branch: the refs a handoff must name. */
const SHIPPED_REF_RE = /->\s+(?:origin\/)?(main|master)\b/;
const NEW_BRANCH_RE = /\[new branch\]\s+\S+\s+->\s+(?:origin\/)?([\w./-]+)/;
/** `ea249dd..bbbbbbb  main -> main` — the right-hand side is what landed. */
const PUSH_RANGE_RE = /\b([0-9a-f]{7,40})\.\.([0-9a-f]{7,40})\s+(\S+)\s+->\s+(\S+)/;
/** Anything that says the push did not land. */
const PUSH_ERROR_RE = /\brejected\b|\bnon-fast-forward\b|^\s*error:|\berror:\s|\bfatal:|\bfailed\b|\[remote rejected\]|\beverything up-to-date\b/im;
/** The branch a push COMMAND aims at: `push [-flags] <remote> [HEAD:]<branch>`,
 *  `push -u origin main`, `push origin HEAD:main`. */
const PUSH_REFSPEC_RE = /\bpush\b((?:\s+-{1,2}[\w-]+(?:=\S+)?)*)\s+(\S+)(?:\s+(?:HEAD:)?(?:refs\/heads\/)?([\w./-]+))?/;
const MAIN_REFS = new Set(["main", "master"]);

/** What ref a push command itself names, when its result does not say. */
export function pushRefFromCommand(command: string): string | null {
  const match = PUSH_REFSPEC_RE.exec(command);
  if (!match) return null;
  const explicit = match[3];
  if (explicit) return explicit.replace(/^origin\//, "");
  // `git push` / `git push origin` with no refspec pushes the current branch,
  // which this command does not name: carafe says nothing rather than guess
  return null;
}

/** Every commit subject the trace ever printed beside a hash — used only to put
 *  a subject on a push the result itself did not describe. Verbatim, or absent. */
export function subjectsByHash(events: CarafeEvent[], pieces: EventPieces[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const call of boundCalls(events, pieces)) {
    if (call.result == null) continue;
    for (const raw of call.result.split("\n")) {
      const match = /^\s*([0-9a-f]{7,40})\s+(\S.*)$/.exec(raw);
      if (!match) continue;
      const subject = match[2]!.trim();
      // a diffstat or a second hash is not a subject
      if (/^[0-9a-f]{7,40}\b/.test(subject) || /^\|/.test(subject)) continue;
      if (!out.has(match[1]!)) out.set(match[1]!, subject.slice(0, 160));
    }
  }
  return out;
}

/**
 * Every push in this trace that reached a remote.
 *
 * v6 round 1: the real session ran its 09-15 and 09-16 pushes to `main` as
 * `cd "<repo>" && … && git push origin main 2>&1 | tail -1`, as `git push -q`,
 * and as `git push origin HEAD:main`, several of them inside helper traces —
 * and the section listed ONE push, from five days earlier. Three shapes are
 * read now: the summary line, the `[new branch]` line, and a push at main or
 * master whose result carries no error and no summary at all.
 */
export function pushesFromTrace(events: CarafeEvent[], pieces: EventPieces[], opts: StateOpts = {}): PushObservation[] {
  const out: PushObservation[] = [];
  for (const call of boundCalls(events, pieces)) {
    if (call.command == null) continue;
    // `-q` prints nothing, and a chain ending in `| tail -1` can swallow the
    // summary: an empty result is a real shape, not a missing call
    const body = call.result ?? "";
    for (const segment of commandSegments(expandCommandVars(call.command), opts.cwd)) {
      if (!/\bgit\b[^\n]*\bpush\b/.test(segment.text)) continue;
      if (PUSH_ERROR_RE.test(body)) continue;
      const where = workspaceAt(segment.dir, opts.worktrees);
      // the command's recorded directory is the only thing that says which
      // repository this was: unknown means the line is omitted, never guessed
      if (!where.id) continue;
      const newBranch = NEW_BRANCH_RE.exec(body);
      const shipped = SHIPPED_REF_RE.exec(body);
      const range = PUSH_RANGE_RE.exec(body);
      const commanded = pushRefFromCommand(segment.text);
      const base = { repo: where.id, subject: null, seq: call.seq, ts: call.ts, ...(opts.via ? { via: opts.via } : {}) };
      if (newBranch) { out.push({ ...base, ref: newBranch[1]!, hash: null, newBranch: true, noOutput: false }); continue; }
      if (shipped) { out.push({ ...base, ref: shipped[1]!, hash: range?.[2] ?? null, newBranch: false, noOutput: false }); continue; }
      // nothing in the result names a ref — but the command named main or
      // master and nothing failed, so the push ran
      if (commanded && MAIN_REFS.has(commanded.toLowerCase())) {
        out.push({ ...base, ref: commanded, hash: null, newBranch: false, noOutput: true });
      }
    }
  }
  return out;
}

/** A health probe: a real curl (never a URL inside a heredoc or a pasted
 *  document) at a health-shaped path. */
export const HEALTH_CURL_RE = /\bcurl\b[^|;&]*?(https?:\/\/[^\s"'`]*\/(?:health|status)[^\s"'`]*)/i;
/** What an answer from such an endpoint looks like. Anything else is a document
 *  that happened to follow a curl, and a handoff says nothing rather than that. */
const HEALTH_BODY_RE = /^(?:\{|\[|HTTP\/|ok\b)/i;

/* ------------------------------------------------------------------ *
 * W1 — what each branch is FOR.
 *
 * A branch's last commit subject says what was done last; it does not say why
 * the branch exists. The trace usually does, in one of three places: a
 * changelog/ledger row the session read, the branch's own first commits, or the
 * sentence the assistant wrote when it created the branch. Extraction only,
 * quoted, seq-anchored — nothing here touches a repository.
 * ------------------------------------------------------------------ */

export interface BranchPurpose { text: string; seq: number; source: "changelog" | "commits" }
/** A ledger row is quoted whole. */
export const BRANCH_PURPOSE_CHARS = 200;
/** How many of a branch's own commit subjects stand in for its purpose. */
export const BRANCH_LOG_SUBJECTS = 3;

/** The branch (and its HEAD, when known) a purpose is wanted for. */
export interface PurposeTarget { branch: string; hash?: string | null; repo?: string | null }

/** `| 12 | a1b2c3d | … |` — a ledger row. */
const LEDGER_ROW_RE = /^\s*\|[^|]*\|.*\|/;
/** `- 2026-09-15 …` — a dated ledger line. */
const LEDGER_DATE_RE = /^\s*-\s+\d{4}-\d{2}-\d{2}\b/;
const LOG_SUBJECT_RE = /^([0-9a-f]{7,40})\s+(.+)$/i;
const escapeRe = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim();

/** The first sentence of a piece of prose, capped. */
export function firstSentence(text: string, cap: number): string {
  const flat = oneLine(text);
  const match = /^[^.!?\n]+[.!?]?/.exec(flat);
  return (match?.[0] ?? flat).slice(0, cap).trim();
}

const PURPOSE_RANK: Record<BranchPurpose["source"], number> = { changelog: 0, commits: 1 };

/**
 * A branch name as a WHOLE TOKEN of a ledger row — bounded by the row's start
 * or end, whitespace, a backtick, a pipe, a quote or a bracket. "the main
 * chat's ChatExperience" does not name the branch `main`, and a row that
 * contains `feat/exporter-v2` does not name `feat/exporter`.
 */
const TOKEN_EDGE = "[\\s`|'\"\\[\\](){}]";
const namesBranch = (text: string, branch: string): boolean =>
  new RegExp(`(?:^|${TOKEN_EDGE})${escapeRe(branch)}(?:$|${TOKEN_EDGE})`).test(text);

/** Every repository has these: a row that mentions one says nothing about the
 *  work on it, and a `for:` line built from one is noise. */
const GENERIC_PURPOSE_BRANCHES = new Set(["main", "master", "develop", "trunk", "head"]);
export const hasOwnPurpose = (branch: string): boolean =>
  branch.trim().length > 0 && !GENERIC_PURPOSE_BRANCHES.has(branch.trim().toLowerCase());

/** A command that logs a NAMED branch: `git log <branch>`, `log origin/<b>`,
 *  `log main..<b>`, `log <b> -n 3`, `for-each-ref … <b>`. A bare `git log` names
 *  no branch and says nothing about one. */
function loggedBranches(command: string, targets: PurposeTarget[]): string[] {
  if (!/\bgit\b/.test(command) || !/\b(?:log|for-each-ref)\b/.test(command)) return [];
  const after = command.slice(command.search(/\b(?:log|for-each-ref)\b/) + 3);
  // every ref an argument could be: a range's two ends, a remote-qualified name,
  // a full ref path — each compared to the branch name WHOLE
  const refs = new Set<string>();
  for (const token of after.split(/\s+/)) {
    if (!token || token.startsWith("-")) continue;
    for (const part of token.split(/\.\.\.?/)) {
      const ref = part.replace(/^\^/, "").replace(/^refs\/(?:heads|remotes)\//, "").replace(/^[\w.-]+\//, (prefix) => (/^(?:origin|upstream|remotes)\//.test(prefix) ? "" : prefix));
      if (ref) refs.add(ref);
    }
  }
  return targets.filter((target) => refs.has(target.branch)).map((target) => target.branch);
}

/**
 * What each named branch is for, read out of the trace. Two sources only, and
 * both are literal:
 *
 *   (a) a changelog / ledger row whose text writes the branch's NAME out;
 *   (b) the subjects of a `git log` that NAMES that branch, from that command's
 *       own bound result.
 *
 * Everything looser was tried and was wrong on a real session: a HEAD hash
 * matched an unrelated ledger row, a bare `git log` in the repository attached
 * another feature's commit, and a `git checkout -b` took the purpose from
 * whatever the assistant happened to be saying. A result shared by two
 * branch-naming log commands is attributed to neither — the same rule the state
 * readings follow. No source, no line.
 */
export function branchPurposes(
  events: CarafeEvent[],
  pieces: EventPieces[],
  targets: PurposeTarget[],
  _opts: { cwd?: string | null; worktrees?: Map<string, string> } = {},
): Map<string, BranchPurpose> {
  const out = new Map<string, BranchPurpose>();
  // a branch every repository has cannot have a purpose of its own
  targets = targets.filter((target) => hasOwnPurpose(target.branch));
  if (!targets.length) return out;
  const offer = (branch: string, source: BranchPurpose["source"], text: string, seq: number): void => {
    const clean = oneLine(text);
    if (!clean) return;
    const current = out.get(branch);
    if (current && PURPOSE_RANK[current.source] < PURPOSE_RANK[source]) return;
    if (current && PURPOSE_RANK[current.source] === PURPOSE_RANK[source] && current.seq > seq) return;
    out.set(branch, { text: clean, seq, source });
  };
  for (const call of boundCalls(events, pieces)) {
    const command = call.command ?? "";
    const body = call.result;
    if (!body) continue;
    for (const line of body.split("\n")) {
      if (!LEDGER_ROW_RE.test(line) && !LEDGER_DATE_RE.test(line)) continue;
      for (const target of targets) {
        if (namesBranch(line, target.branch)) offer(target.branch, "changelog", line.trim().slice(0, BRANCH_PURPOSE_CHARS), call.seq);
      }
    }
    // one result, one logged branch — a compound command that logs two of them
    // cannot say which subjects belong to which
    const logged = [...new Set(loggedBranches(command, targets))];
    if (logged.length !== 1) continue;
    const subjects = body.split("\n").map((line) => LOG_SUBJECT_RE.exec(line.trim()))
      .filter((match): match is RegExpExecArray => match != null)
      .map((match) => match[2]!.trim()).slice(0, BRANCH_LOG_SUBJECTS);
    if (subjects.length) offer(logged[0]!, "commits", subjects.join(" · "), call.seq);
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * W2 — a configuration flag the trace saw, for the half-done section.
 * ------------------------------------------------------------------ */

export interface EnvFlag { name: string; value: string; line: string; repo: string | null; seq: number; ts: string | null }

/** `SENTINEL_DISABLED=true` on a line of its own, in a result. */
const ENV_FLAG_RE = /^([A-Z][A-Z0-9_]{3,})=(true|false|1|0)$/;

/** Every boolean-shaped configuration line the trace saw: the last reading of
 *  each name, per repository. */
export function envFlagsFromTrace(
  events: CarafeEvent[],
  pieces: EventPieces[],
  opts: { cwd?: string | null; worktrees?: Map<string, string> } = {},
): EnvFlag[] {
  const last = new Map<string, EnvFlag>();
  for (const call of boundCalls(events, pieces)) {
    if (call.result == null) continue;
    const repo = call.command == null ? null : repoOfCommand(call.command, opts.cwd, opts.worktrees);
    for (const raw of call.result.split("\n")) {
      const match = ENV_FLAG_RE.exec(raw.trim().replace(/^export\s+/, ""));
      if (!match) continue;
      last.set(`${repo ?? ""}::${match[1]}`, { name: match[1]!, value: match[2]!, line: raw.trim(), repo, seq: call.seq, ts: call.ts });
    }
  }
  return [...last.values()];
}

/** The last health/status probe the session ran, with the head of the answer
 *  that probe itself received. */
export function healthFromTrace(events: CarafeEvent[], pieces: EventPieces[], via?: string): HealthState | null {
  let last: HealthState | null = null;
  for (const call of boundCalls(events, pieces)) {
    if (call.command == null || call.result == null) continue;
    // a heredoc body is a document the command CARRIES, not the command
    const command = expandCommandVars(call.command).split(/<<-?\s*['"]?[A-Za-z_]/)[0] ?? "";
    const url = HEALTH_CURL_RE.exec(command)?.[1];
    if (!url || url.includes("$")) continue;
    const body = call.result.replace(/\s+/g, " ").trim();
    if (!HEALTH_BODY_RE.test(body)) continue;
    last = { url: normalizeHealthUrl(url), body: body.slice(0, HEALTH_BODY_CHARS), seq: call.seq, ts: call.ts, ...(via ? { via } : {}) };
  }
  return last;
}

/** Every distinct health/status URL this trace ever probed, oldest first. The
 *  `--live` re-check (W1) probes these and nothing else: a URL the session
 *  never touched is not this session's to call. */
export const HEALTH_URLS_KEPT = 3;

/** A URL as the shell left it: `…/health;`, `…/health)`, `"…/health"`. The
 *  punctuation belongs to the command line, not to the address. */
export function normalizeHealthUrl(url: string): string {
  return url.replace(/^["'`]+/, "").replace(/["'`;,)\]}>.]+$/, "");
}

/** A machine-local address is not a deployment: a handoff that lists
 *  `http://localhost:4001/health` is telling the next session about a server
 *  that stopped when the last one did. */
export function isLocalHealthUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase().replace(/\.$/, "");
    if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host === "::" || host === "::1" || host.startsWith("::ffff:")) return true;
    if (/^(?:fc|fd)[0-9a-f]{2}:|^fe[89ab][0-9a-f]:/i.test(host)) return true;
    if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) return false;
    const parts = host.split(".").map(Number);
    if (!parts.every((part) => part >= 0 && part <= 255)) return true;
    const [a = 0, b = 0] = parts;
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  } catch { return true; }
}

/**
 * Every distinct health/status URL this trace probed, NEWEST SEEN FIRST, capped
 * at three. A real handoff printed sixteen of these, two of them the same
 * address with a stray `;` and `)` attached.
 */
export function healthUrlsFromTrace(events: CarafeEvent[], pieces: EventPieces[]): string[] {
  const lastSeen = new Map<string, number>();
  for (const call of boundCalls(events, pieces)) {
    if (call.command == null) continue;
    const command = expandCommandVars(call.command).split(/<<-?\s*['"]?[A-Za-z_]/)[0] ?? "";
    const raw = HEALTH_CURL_RE.exec(command)?.[1];
    if (!raw) continue;
    const url = normalizeHealthUrl(raw);
    // `https://$TYPESENSE_HOST/health` is not an address: nothing in the trace
    // says what the variable held
    let parsed: URL;
    try { parsed = new URL(url); } catch { continue; }
    const path = parsed.pathname.toLowerCase();
    if (!url || url.includes("$") || !["http:", "https:"].includes(parsed.protocol)
      || (!path.includes("/health") && !path.includes("/status")) || isLocalHealthUrl(url)) continue;
    lastSeen.set(url, call.seq);
  }
  return [...lastSeen.entries()].sort((a, b) => b[1] - a[1]).slice(0, HEALTH_URLS_KEPT).map(([url]) => url);
}
