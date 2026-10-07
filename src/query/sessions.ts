/**
 * Session lookup over the distillate layer (never touches raw). Backs
 * carafe list / handoff selection now; carafe search (SQLite FTS) is Priority 3.
 */
import { readdirSync, readFileSync, existsSync, statSync, realpathSync } from "fs";
import { dirname, join, resolve } from "path";
import { callerHook, callerProcesses, writableTranscripts } from "./caller";
import type { CarafeStore } from "../format/store";
import type { SessionDistillate } from "../format/distillate";

/** Minimum characters of an id prefix `findSession` will resolve. Shorter than
 *  this and a "prefix" is a guess, not an abbreviation. */
export const MIN_ID_PREFIX = 6;

/** More than one stored session starts with the given prefix: the caller must
 *  say which. Carries the candidates so every command can print them. */
export class AmbiguousSessionIdError extends Error {
  readonly candidates: string[];
  constructor(prefix: string, candidates: string[]) {
    super(`ambiguous session id "${prefix}" — ${candidates.length} sessions match:\n  ${candidates.join("\n  ")}\nuse more characters of the id.`);
    this.name = "AmbiguousSessionIdError";
    this.candidates = candidates;
  }
}

/** Carafe's own LLM calls (distillation via `claude -p`/`codex exec`) and dev
 *  connectivity probes get logged by the host tool as one-shot sessions. They
 *  are Carafe internals, not the user's work — hide them from every listing so
 *  the corpus stays clean. */
export function isCarafeInternal(d: SessionDistillate): boolean {
  const t = (d.title ?? "").trimStart();
  return t.startsWith("You are distilling an AI coding session")
    || t.includes("MERGE_INPUT:")
    || t.startsWith("reply with exactly:"); // runner/CLI connectivity probes
}

/** A session with fewer events than this AND no surviving owner text is an
 *  aborted start, not work anyone would recognise in a picker. */
export const STUB_EVENTS = 5;

/** The real recency of a session: when someone last SAID something in it.
 *  `endTs` is the last record of ANY kind and drifts on idle sessions — Codex
 *  keeps appending token counts to rollouts nobody is using. */
export function activityTs(d: Pick<SessionDistillate, "lastActivityTs" | "endTs" | "startTs">): string | null {
  return d.lastActivityTs ?? d.endTs ?? d.startTs ?? null;
}

/** THE default-hidden rule, shared by `carafe list` and the UI sidebar so the
 *  two surfaces can never drift: Codex's own approval-reviewer runs, and
 *  aborted starts. Legacy distillates (no `hasUserText` yet, awaiting the
 *  backfill) are never hidden as stubs — absent is not "no user text". */
export function isNoise(d: SessionDistillate): boolean {
  if (d.internal === true) return true;
  return d.eventCount < STUB_EVENTS && d.hasUserText === false;
}

/** Codex `sourceKind` values that mean "launched by another agent, not by a
 *  human sitting down to work". A RECORDED field, never inferred from content:
 *  in a real store these one-shot workers outnumber interactive sessions ~40:1
 *  and many share an identical first message, so no title rule can separate
 *  them. Claude Code helpers are already nested by the hierarchy — left alone. */
const CODEX_SPAWNED_SOURCES = new Set(["exec", "subagent"]);

/** Was this session launched by another agent? Unknown or absent `sourceKind`
 *  is NOT spawned, so legacy distillates never vanish from a listing. */
export function isSpawned(d: SessionDistillate): boolean {
  return d.tool === "codex" && d.sourceKind !== undefined && CODEX_SPAWNED_SOURCES.has(d.sourceKind);
}

export function listSessions(store: CarafeStore): SessionDistillate[] {
  const base = join(store.root, "distillate");
  const out: SessionDistillate[] = [];
  let tools: string[] = [];
  try { tools = readdirSync(base); } catch { return out; }
  for (const tool of tools) {
    const dir = join(base, tool);
    let files: string[] = [];
    try { files = readdirSync(dir); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith(".json")) continue;
      try {
        const d = JSON.parse(readFileSync(join(dir, f), "utf8")) as SessionDistillate;
        if (!isCarafeInternal(d)) out.push(d);
      } catch { /* skip */ }
    }
  }
  // Conversation activity, with a fallback for legacy or message-free sessions.
  return out.sort((a, b) => (activityTs(b) ?? "").localeCompare(activityTs(a) ?? ""));
}

function readDistillateFile(path: string): SessionDistillate | null {
  try { return JSON.parse(readFileSync(path, "utf8")) as SessionDistillate; } catch { return null; }
}

/** Every stored id, as `<tool>/<id>` pairs — the search space for a prefix. */
function storedIds(store: CarafeStore): Array<{ tool: string; id: string }> {
  const base = join(store.root, "distillate");
  const out: Array<{ tool: string; id: string }> = [];
  let tools: string[] = [];
  try { tools = readdirSync(base); } catch { return out; }
  for (const tool of tools) {
    let files: string[] = [];
    try { files = readdirSync(join(base, tool)); } catch { continue; }
    for (const file of files) if (file.endsWith(".json")) out.push({ tool, id: file.slice(0, -".json".length) });
  }
  return out;
}

/**
 * Find one session by storage id (searches every tool dir). An exact id always
 * wins; otherwise any unique prefix of at least MIN_ID_PREFIX characters
 * resolves, and an ambiguous one throws with the candidates listed — nobody
 * should have to paste 36 characters to read their own session.
 */
export function findSession(store: CarafeStore, id: string): SessionDistillate | null {
  const base = join(store.root, "distillate");
  let tools: string[] = [];
  try { tools = readdirSync(base); } catch { return null; }
  for (const tool of tools) {
    const p = join(base, tool, id + ".json");
    if (existsSync(p)) return readDistillateFile(p);
  }
  if (id.length < MIN_ID_PREFIX) return null;
  const matches = storedIds(store).filter((entry) => entry.id.startsWith(id));
  if (!matches.length) return null;
  const unique = [...new Set(matches.map((m) => m.id))];
  if (unique.length > 1) throw new AmbiguousSessionIdError(id, unique.sort());
  const first = matches[0]!;
  return readDistillateFile(join(base, first.tool, first.id + ".json"));
}

export function latestSession(store: CarafeStore, tool?: string): SessionDistillate | null {
  const all = listSessions(store).filter((d) => (tool ? d.tool === tool : true) && !d.sidechain);
  return all[0] ?? null;
}

export interface CurrentSessionOpts {
  env?: NodeJS.ProcessEnv;
  hook?: import("./caller").CallerHook;
  parents?: import("./caller").CallerProcess[];
  writers?: Array<{ path: string; mtimeMs: number }>;
  warn?: (message: string) => void;
}

/** Exact caller identity wins even when another session in this cwd is newer. */
export function currentSession(store: CarafeStore, cwd = process.cwd(), opts: CurrentSessionOpts = {}): SessionDistillate | null {
  const all = listSessions(store);
  const env = opts.env ?? process.env;
  const byId = (id: string | undefined): SessionDistillate | undefined => id
    ? all.find((d) => d.sessionId === id || d.internalSessionId === id) : undefined;
  const canonical = (path: string): string => { try { return realpathSync(path); } catch { return resolve(path); } };
  const byPath = (path: string | null | undefined): SessionDistillate | undefined => path
    ? all.find((d) => canonical(d.sourcePath) === canonical(path)) : undefined;
  const fail = (identity: string): never => { throw new Error(`caller session ${identity} is not captured; capture it or pass an explicit session id (carafe handoff <id> --questions). Refusing to choose another session.`); };
  if (env.CARAFE_SESSION_ID) return byId(env.CARAFE_SESSION_ID) ?? fail(env.CARAFE_SESSION_ID);
  const claude = env.CLAUDE_SESSION_ID ?? env.CLAUDE_CODE_SESSION_ID;
  const codex = env.CODEX_THREAD_ID ?? env.CODEX_SESSION_ID;
  let parents = opts.parents;
  if (claude && codex && claude !== codex) {
    parents ??= callerProcesses();
    const owner = parents.find((p) => /(?:^|\/)(?:claude|codex)(?:$|[- ])/i.test(p.command));
    if (!owner) throw new Error("conflicting Claude Code and Codex caller ids; pass an explicit session id or CARAFE_SESSION_ID rather than guessing");
    const id = /(?:^|\/)codex(?:$|[- ])/i.test(owner.command) ? codex : claude;
    return byId(id) ?? fail(id);
  }
  const identity = claude ?? codex;
  if (identity) return byId(identity) ?? fail(identity);
  parents ??= callerProcesses();
  let hook = opts.hook;
  if (!hook && env.CARAFE_HOOK_DATA) { try { hook = JSON.parse(env.CARAFE_HOOK_DATA); } catch { /* malformed optional data */ } }
  hook ??= callerHook(store, parents);
  if (hook?.session_id || hook?.transcript_path) return byPath(hook.transcript_path) ?? byId(hook.session_id) ?? fail(hook.session_id ?? hook.transcript_path!);
  for (const key of ["CLAUDE_TRANSCRIPT_PATH", "CODEX_TRANSCRIPT_PATH"]) {
    if (env[key]) return byPath(env[key]) ?? fail(env[key]!);
  }
  for (const writer of [...(opts.writers ?? writableTranscripts(parents))].sort((a, b) => b.mtimeMs - a.mtimeMs)) {
    const d = byPath(writer.path);
    if (d) return d;
  }
  const candidates = all.filter((d) => !d.sidechain && d.cwd && (cwd === d.cwd || cwd.startsWith(d.cwd.replace(/\/$/, "") + "/")));
  const newest = (pool: SessionDistillate[]): SessionDistillate | null => pool.map((d) => {
    let at = Date.parse(activityTs(d) ?? "") || 0;
    try { at = statSync(d.sourcePath).mtimeMs; } catch { /* captured activity is the fallback */ }
    return { d, at };
  }).sort((a, b) => b.at - a.at)[0]?.d ?? null;
  const chosen = newest(candidates) ?? newest(all.filter((d) => !d.sidechain));
  if (chosen && candidates.length > 1) (opts.warn ?? console.error)(`current: caller identity unavailable; chose ${chosen.sessionId} "${chosen.title ?? chosen.sessionId}" by recency from ${candidates.length} sessions in ${cwd}. Use carafe handoff ${chosen.sessionId} --questions (or another explicit id).`);
  return chosen;
}

/**
 * Session hierarchy: a codex session spawned FROM another session (the parent's
 * trace contains a codex-invoking tool call within ±2 min of the child's start)
 * is a SUBSESSION, not a top-level peer. Interactive codex sessions (no matching
 * spawn call) stay top-level. Precise by construction — naive time/cwd
 * containment would swallow real sessions, since parent sessions span weeks.
 */
export interface Hierarchy {
  sessions: SessionDistillate[];
  parentOf: Record<string, string>;
  childrenOf: Record<string, SessionDistillate[]>;
  /** codex_exec sessions with no matched parent — spawned by definition (session_meta
   *  originator), parent unknown. Hidden from top-level by default. */
  orphanSpawns: Record<string, true>;
}

const SPAWN_TOLERANCE_MS = 120_000;

export function listWithHierarchy(store: CarafeStore): Hierarchy {
  const sessions = listSessions(store);
  const spawners = sessions.filter((s) => s.codexCalls && s.codexCalls.length && s.tool !== "codex");
  const parentOf: Record<string, string> = {};
  const childrenOf: Record<string, SessionDistillate[]> = {};
  for (const c of sessions) {
    if (c.tool !== "codex" || !c.startTs) continue;
    const ct = Date.parse(c.startTs);
    let best: SessionDistillate | null = null; let bestDt = Infinity; let bestRank = 2;
    for (const p of spawners) {
      const rank = p.sidechain ? 1 : 0; // prefer visible parents over sub-agent parents
      for (const ts of p.codexCalls!) {
        const dt = Math.abs(Date.parse(ts) - ct);
        if (dt <= SPAWN_TOLERANCE_MS && (rank < bestRank || (rank === bestRank && dt < bestDt))) {
          best = p; bestDt = dt; bestRank = rank;
        }
      }
    }
    if (best) {
      parentOf[c.sessionId] = best.sessionId;
      (childrenOf[best.sessionId] ??= []).push(c);
    }
  }
  const orphanSpawns: Record<string, true> = {};
  for (const s of sessions) {
    if (s.tool === "codex" && !parentOf[s.sessionId] && s.originator === "codex_exec") orphanSpawns[s.sessionId] = true;
  }
  return { sessions, parentOf, childrenOf, orphanSpawns };
}

/**
 * The workspace a session belongs to: the nearest ancestor of its cwd that is a
 * repository root, else THE CWD ITSELF. (Falling back to the parent made every
 * unrelated project in a projects folder a sibling of every other.)
 *
 * A git worktree's `.git` is a FILE pointing into the main repository — both
 * resolve to the main root, so a worktree session and its main-repo session
 * share one workspace.
 */
export function workspaceKey(cwd: string | null | undefined): string | null {
  if (!cwd) return null;
  const normalized = cwd.length > 1 && cwd.endsWith("/") ? cwd.slice(0, -1) : cwd;
  let dir = normalized;
  for (;;) {
    const gitPath = join(dir, ".git");
    if (existsSync(gitPath)) return resolveWorktree(gitPath) ?? dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return normalized;
}

/** `gitdir: /repo/.git/worktrees/<name>` → `/repo`. */
function resolveWorktree(gitPath: string): string | null {
  let stats;
  try { stats = statSync(gitPath); } catch { return null; }
  if (stats.isDirectory()) return null;
  let pointer = "";
  try { pointer = readFileSync(gitPath, "utf8"); } catch { return null; }
  const target = /^gitdir:\s*(.+)$/m.exec(pointer)?.[1]?.trim();
  if (!target) return null;
  const marker = target.indexOf("/.git/worktrees/");
  if (marker > 0) return target.slice(0, marker);
  return target.endsWith("/.git") ? target.slice(0, -"/.git".length) : null;
}

/** Directories that are never a workspace: shared roots, scratch space, and
 *  the home directory itself. A repo list containing "/" tells the reader
 *  nothing and crowds out the repos that matter. */
const EXCLUDED_KEYS = new Set(["/", "/tmp", "/private/tmp", "/private/var", "/var", "/usr", "/etc"]);
const EXCLUDED_PREFIXES = ["/private/tmp/claude-501/", "/tmp/claude-"];
export function isExcludedWorkspace(key: string | null | undefined): boolean {
  if (!key) return true;
  if (EXCLUDED_KEYS.has(key)) return true;
  const home = process.env.HOME;
  if (home && (key === home || key === (home.endsWith("/") ? home.slice(0, -1) : home))) return true;
  return EXCLUDED_PREFIXES.some((prefix) => key.startsWith(prefix));
}

/**
 * The agent's own state, not the user's work: `~/.claude`, `~/.codex`,
 * `~/.agents`, `~/.carafe`, and the `.claude` directory a project keeps for its
 * agents. A session that reads its own memory files is not working in a fourth
 * repository — and a run of turns that ONLY reads them is a detour, which is
 * why these are kept distinct from excluded workspaces rather than folded into
 * them: an excluded-only turn belongs to the surrounding work, an
 * agent-state-only turn does not.
 */
const AGENT_STATE_DIRS = [".claude", ".codex", ".agents", ".carafe"];
export function isAgentStateWorkspace(key: string | null | undefined): boolean {
  if (!key) return false;
  const home = process.env.HOME;
  if (home) {
    const root = home.endsWith("/") ? home.slice(0, -1) : home;
    for (const dir of AGENT_STATE_DIRS) {
      if (key === `${root}/${dir}` || key.startsWith(`${root}/${dir}/`)) return true;
    }
  }
  // …and an agent-state directory wherever it lives: a `.carafe` or `.claude`
  // beside a project is still the agent's own memory, not a repository the
  // session worked in. (A real handoff named `.carafe` as a principal
  // workspace and put it in the tail's label.)
  return new RegExp(`(?:^|/)(?:${AGENT_STATE_DIRS.map((dir) => dir.replace(".", "\\.")).join("|")})(?:/|$)`).test(key);
}

export interface SiblingSession {
  sessionId: string;
  tool: string;
  title: string | null;
  startTs: string | null;
  endTs: string | null;
  eventCount: number;
  cwd: string | null;
  /** helper (`agent-*` / sub-agent) sessions folded into this one */
  helpers: number;
  /** most-touched file paths; filled by the caller that can read the trace */
  topFiles: string[];
}

const SIBLING_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
export const SIBLING_MAX = 12;

const isHelper = (d: SessionDistillate): boolean => d.sessionId.startsWith("agent-") || d.sidechain === true;

function overlaps(a: SessionDistillate, b: { startMs: number; endMs: number }): boolean {
  const start = Date.parse(a.startTs ?? a.endTs ?? "");
  const end = Date.parse(a.endTs ?? a.startTs ?? "");
  if (!Number.isFinite(start) || !Number.isFinite(end)) return false;
  return end >= b.startMs && start <= b.endMs;
}

/**
 * Other sessions (any tool) in the same workspace as `d`, whose time range
 * overlaps the last 14 days of `d`. Helper sessions fold into the session they
 * ran under (by cwd and time) instead of taking a line of their own.
 */
/** How many helper sessions a handoff will read for observations. */
export const HELPER_MAX = 40;

/**
 * The helper sessions that ran INSIDE this one: `agent-*` ids or sidechains in
 * the same workspace, overlapping in time. The parent's trace records their
 * work as prompts and prose; the helpers' own traces record the tool calls, so
 * the latest state of a repository often lives only in one of these.
 */
export function helperSessionsOf(
  store: CarafeStore,
  d: SessionDistillate,
  all = listSessions(store),
  principalKeys: string[] = [],
  childIds?: Set<string>,
): SessionDistillate[] {
  const window = {
    startMs: Date.parse(d.startTs ?? d.endTs ?? ""),
    endMs: Date.parse(d.endTs ?? d.startTs ?? ""),
  };
  if (!Number.isFinite(window.startMs) || !Number.isFinite(window.endMs)) return [];
  // The hierarchy knows a child outright; otherwise a helper is recognised by
  // WORKSPACE, not by an identical cwd. A desktop-app helper runs in a fresh
  // worktree of the parent's repository (`…/.claude/worktrees/<name>`), which
  // resolves through its `.git` file to the repository itself — matching on the
  // literal cwd found none of them.
  const children = childIds ?? new Set(Object.entries(listWithHierarchy(store).parentOf)
    .filter(([, parent]) => parent === d.sessionId).map(([child]) => child));
  const keys = new Set([workspaceKey(d.cwd), ...principalKeys.map((key) => workspaceKey(key))]
    .filter((key): key is string => !!key && !isExcludedWorkspace(key)));
  return all
    .filter((candidate) => {
      if (candidate.sessionId === d.sessionId) return false;
      if (!overlaps(candidate, window)) return false;
      if (children.has(candidate.sessionId)) return true;
      if (!isHelper(candidate)) return false;
      const key = workspaceKey(candidate.cwd);
      return !!key && keys.has(key);
    })
    .sort((a, b) => (b.endTs ?? b.startTs ?? "").localeCompare(a.endTs ?? a.startTs ?? ""))
    .slice(0, HELPER_MAX);
}

export function siblingSessions(store: CarafeStore, d: SessionDistillate, all = listSessions(store), extraKeys: string[] = []): SiblingSession[] {
  // An orchestrator's cwd is often a stub folder while the work goes to other
  // repos via `git -C`: the workspace is the union of where it sat and where
  // it worked.
  const keys = new Set([workspaceKey(d.cwd), ...extraKeys].filter((key): key is string => !!key && !isExcludedWorkspace(key)));
  if (!keys.size) return [];
  const endMs = Date.parse(d.endTs ?? d.startTs ?? "");
  if (!Number.isFinite(endMs)) return [];
  const window = { startMs: endMs - SIBLING_WINDOW_MS, endMs };
  const inWorkspace = all.filter((s) => {
    const key = workspaceKey(s.cwd);
    return s.sessionId !== d.sessionId && !!key && keys.has(key) && overlaps(s, window);
  });
  const principals = inWorkspace.filter((s) => !isHelper(s));
  const helpers = inWorkspace.filter(isHelper);

  const rows = new Map<string, SiblingSession>();
  for (const s of principals) {
    rows.set(s.sessionId, {
      sessionId: s.sessionId, tool: s.tool, title: s.title ?? null,
      startTs: s.startTs ?? null, endTs: s.endTs ?? null, eventCount: s.eventCount, cwd: s.cwd ?? null, helpers: 0, topFiles: [],
    });
  }
  // A helper belongs to the principal it ran inside: same cwd, overlapping time,
  // nearest start. One that ran inside THIS session is already accounted for.
  const hosts = [d, ...principals];
  for (const helper of helpers) {
    const helperStart = Date.parse(helper.startTs ?? helper.endTs ?? "");
    const host = hosts
      .filter((candidate) => candidate.cwd === helper.cwd && overlaps(helper, {
        startMs: Date.parse(candidate.startTs ?? candidate.endTs ?? ""),
        endMs: Date.parse(candidate.endTs ?? candidate.startTs ?? ""),
      }))
      .sort((a, b) => Math.abs(Date.parse(a.startTs ?? "") - helperStart) - Math.abs(Date.parse(b.startTs ?? "") - helperStart))[0];
    if (!host) {
      rows.set(helper.sessionId, {
        sessionId: helper.sessionId, tool: helper.tool, title: helper.title ?? null,
        startTs: helper.startTs ?? null, endTs: helper.endTs ?? null, eventCount: helper.eventCount, cwd: helper.cwd ?? null, helpers: 0, topFiles: [],
      });
      continue;
    }
    const row = rows.get(host.sessionId);
    if (row) row.helpers++;
  }
  return [...rows.values()]
    .sort((a, b) => (b.endTs ?? b.startTs ?? "").localeCompare(a.endTs ?? a.startTs ?? ""))
    .slice(0, SIBLING_MAX);
}
