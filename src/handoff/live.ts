/**
 * W1 — "Right now", CHECKED when the handoff is written.
 *
 * Two judges chose a hand-written handoff over carafe's for one reason: carafe
 * replayed the newest OLD observation in the trace under the heading "Right
 * now". A fourteen-day-old health check and a commit subject saying "backend
 * still bypassed" were printed as the current state of a production system that
 * had been secured the day before.
 *
 * So this file does the cheapest thing that fixes it: it runs a fixed list of
 * READ-ONLY git commands against the repositories the trace names, at the
 * moment the handoff is written, and prints what they answer. Nothing here
 * writes. `git ls-remote` runs only behind `--live`; a health probe runs behind
 * that explicit override or stored human TTY consent. Every failure is shown
 * as a current failure rather than replaced with a stale trace value.
 */
import { existsSync } from "fs";
import { execFileSync } from "child_process";
import { VERSION } from "../version";
import { hostOfHealthUrl, type ResolvedHostConsent } from "./consent";
import { normalizeHealthUrl } from "./state";
import { howMoved, reflogOf } from "./history";

/** Every read-only command W1 may run, in order. `P` is the repository path. */
export const LIVE_COMMANDS: string[] = [
  "git -C P rev-parse --show-toplevel",
  "git -C P rev-parse --git-common-dir",
  "git -C P branch --show-current",
  "git -C P rev-parse --short HEAD",
  "git -C P log -1 --format=%s",
  // v6/V6 — the narrative's age is measured against the newest commit, so the
  // commit needs a DATE, not only a subject
  "git -C P log -1 --format=%cI",
  "git -C P rev-parse --abbrev-ref --symbolic-full-name @{upstream}",
  "git -C P rev-list --left-right --count @{upstream}...HEAD",
  // v6/V2 — the remote default branch as the LOCAL refs record it. Never
  // fetched here, never called "deployed": it is origin/main as this disk has it.
  "git -C P symbolic-ref --short refs/remotes/origin/HEAD",
  "git -C P rev-parse --verify --short <default ref>",
  "git -C P log -1 --format=%s <default ref>",
  "git -C P rev-list --left-right --count <default ref>...HEAD",
  // round 8 — when a remote-tracking ref was last written, and by what: a push
  // and a fetch both write its reflog. FETCH_HEAD's mtime saw only fetches.
  "git -C P reflog show --date=unix --format=%H%x09%gd%x09%gs refs/remotes/<default ref | upstream>",
  "git -C P status --porcelain=v1",
  "git -C P for-each-ref --format='%(refname:short) %(objectname:short) %(upstream:track) %(committerdate:iso-strict)' refs/heads",
  "git -C P branch -r --contains <hash>   (once per candidate unpushed branch)",
];
/** …and the two the `--live` flag adds, which DO make network requests. */
export const LIVE_NETWORK_COMMANDS: string[] = [
  "git -C P ls-remote --heads origin",
  "GET <health url> (the health URLs this trace probed)",
];
/** …plus the read-only commands W2 may show beside a checked assertion. */
export const LIVE_VERIFY_COMMANDS: string[] = [
  "git -C P cat-file -e <hash>^{commit}",
  "git -C P rev-parse <ref>",
  "git -C P merge-base --is-ancestor <hash> <ref>",
  "git -C P branch -r --contains <hash>",
  "git -C P branch --show-current",
  "git -C P rev-list --count <ref>..HEAD",
  "git -C P rev-list --no-walk <hash…> --not --remotes",
  "git -C P status --porcelain",
  "git -C P rev-parse --short HEAD",
  "git -C P show <ref>:<file>",
  "git -C P grep -n -F <name> <ref> -- <path>",
  "lsof -nP -iTCP:<port> -sTCP:LISTEN",
  "readdir/stat <directory> (mtime)",
  "existsSync(<absolute path>)",
];

const GIT_TIMEOUT_MS = 5_000;
const LS_REMOTE_TIMEOUT_MS = 10_000;
const HEALTH_TIMEOUT_MS = 5_000;
export const HEALTH_BODY_CHARS = 200;
export const UNTRACKED_NAMES = 8;
/**
 * v6/V3 — how many single-disk branches are NAMED before the line turns into a
 * count. It was six, and the one branch the reviewer had accepted a fix on —
 * which existed on this disk and nowhere else — was inside "+4 more". Nothing
 * that exists only here may be hidden behind a number.
 */
export const UNPUSHED_BRANCHES = 15;

/** Runs one command and returns its stdout, or null when it failed/timed out. */
export type GitRunner = (args: string[], timeoutMs: number) => string | null;
/** Fetches one URL and returns the head of its body, or an error string. */
export type HealthFetcher = (url: string, timeoutMs: number) => Promise<{ body: string } | { error: string }>;
export type FetchFunction = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export const realGitRunner: GitRunner = (args, timeoutMs) => {
  try {
    return execFileSync("git", args, { timeout: timeoutMs, encoding: "utf8", env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0" }, stdio: ["ignore", "pipe", "ignore"] }).toString();
  } catch {
    return null;
  }
};

const REDIRECT_LIMIT = 3;

/** The sole HTTP implementation used by handoffs. Redirects are manual so a
 * health host can never confer permission on a second host. */
export function healthFetcher(fetchFn: FetchFunction = globalThis.fetch): HealthFetcher {
  return async (raw, timeoutMs) => {
    try {
      const first = new URL(raw);
      let current = first;
      const deadline = Date.now() + timeoutMs;
      for (let redirects = 0; redirects <= REDIRECT_LIMIT; redirects++) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) return { error: "timeout" };
        const response = await fetchFn(current, {
          method: "GET",
          headers: { "User-Agent": `carafe/${VERSION}` },
          redirect: "manual",
          signal: AbortSignal.timeout(remaining),
        });
        if (response.status < 300 || response.status >= 400) {
          const body = (await response.text()).replace(/\s+/g, " ").trim();
          return { body: body.slice(0, HEALTH_BODY_CHARS) };
        }
        const location = response.headers.get("location");
        if (!location) return { error: `redirect ${response.status} without location` };
        const next = new URL(location, current);
        if (next.host !== first.host) return { error: "redirect to different host" };
        if (!isAllowedHealthUrl(next.toString())) return { error: "redirect target is not an allowed health URL" };
        current = next;
      }
      return { error: "too many redirects" };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  };
}

export const realHealthFetcher: HealthFetcher = (url, timeoutMs) => healthFetcher(globalThis.fetch)(url, timeoutMs);

export interface UnpushedBranch { branch: string; hash: string; date: string | null }

/** v6/V2 — the remote default branch, as the LOCAL refs record it. */
export interface DefaultRef {
  /** `origin/main` — the ref name, never the word "deployed" */
  ref: string;
  hash: string;
  subject: string | null;
  /** HEAD's position relative to that ref */
  ahead: number | null;
  behind: number | null;
  /** the newest entry of the ref's own reflog; null when it has none */
  updated?: RefUpdate | null;
}

/** When a local ref was last written, and by which operation. */
export interface RefUpdate { at: string; how: string }

export interface LiveRepo {
  path: string;
  /** branches beyond the fifteen the block names */
  unpushedMore?: number;
  /** null when the reading succeeded; the reason it did not, otherwise */
  notChecked: string | null;
  branch: string | null;
  head: { hash: string; subject: string | null } | null;
  /** the ISO commit date of HEAD, for V6's "this recap is N days older" note */
  headDate: string | null;
  /** v6/V2 — origin/HEAD (or origin/main, or origin/master) as local refs have it */
  defaultRef: DefaultRef | null;
  upstream: string | null;
  ahead: number | null;
  behind: number | null;
  /** round 8 — the upstream ref's newest reflog entry (push or fetch) */
  upstreamUpdated?: RefUpdate | null;
  modified: number | null;
  untracked: number | null;
  untrackedNames: string[];
  unpushed: UnpushedBranch[];
  unpushedAll?: UnpushedBranch[];
  /** every local branch name for-each-ref reported — W2 checks names against it */
  branches: string[];
  /** branch → the `[ahead 2]` / `[gone]` track for-each-ref reported ("" = in sync) */
  track: Record<string, string>;
}

export interface LiveHealth {
  url: string;
  body: string | null;
  error: string | null;
  decision?: "allow" | "deny" | "unknown";
  permission?: { host: string; decidedAt: string } | null;
}

export interface LiveState {
  /** ISO instant the checks were run */
  checkedAt: string;
  repos: LiveRepo[];
  health: LiveHealth[];
  /** true when `--live` was given: ls-remote and the health GETs ran */
  live: boolean;
  /** the remote heads `--live` read, per repository path */
  remoteHeads: Record<string, Record<string, string>>;
}

export interface LiveOpts {
  live?: boolean;
  /** the health URLs this trace saw; only these are ever probed */
  healthUrls?: string[];
  /** Standing per-host decisions. `live` remains the explicit per-run override. */
  healthConsent?: Map<string, ResolvedHostConsent>;
  /** branch names the trace named — they sort above the ones it never did */
  knownBranches?: Set<string>;
  git?: GitRunner;
  fetcher?: HealthFetcher;
  now?: string;
  /** injected by the bench so a case renders hermetically, without git at all */
  liveOverride?: LiveState;
}

/** "3 d", "2 h", "12 min" — the age of a reading, for a reader in a hurry. */
export function relativeAge(fromMs: number, toMs: number): string {
  const ms = Math.max(0, toMs - fromMs);
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(ms / 3_600_000);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(ms / 86_400_000)} d ago`;
}

function statusCounts(porcelain: string): { modified: number; untracked: number; untrackedNames: string[] } {
  let modified = 0;
  const untrackedNames: string[] = [];
  for (const line of porcelain.split("\n")) {
    if (!line.trim()) continue;
    if (line.startsWith("??")) untrackedNames.push(line.slice(3).trim());
    else modified++;
  }
  return { modified, untracked: untrackedNames.length, untrackedNames: untrackedNames.slice(0, UNTRACKED_NAMES) };
}

export interface ParsedRefs { branches: string[]; track: Record<string, string>; hashes: Record<string, string>; dates: Record<string, string> }

/**
 * `<name> <hash> [<track>] <YYYY-MM-DD>` — the committer date is the LAST field,
 * because the `[ahead 2]` track in the middle is the one that can be empty.
 */
export function parseForEachRef(text: string): ParsedRefs {
  const branches: string[] = [];
  const track: Record<string, string> = {};
  const hashes: Record<string, string> = {};
  const dates: Record<string, string> = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim().replace(/^'|'$/g, "");
    if (!line) continue;
    const match = /^(\S+)\s+(\S+)(?:\s+(.*))?$/.exec(line);
    if (!match) continue;
    const branch = match[1]!;
    branches.push(branch);
    hashes[branch] = match[2]!;
    let rest = (match[3] ?? "").trim();
    const dated = /(?:^|\s)(\d{4}-\d{2}-\d{2}(?:T[\d:]+(?:Z|[+-][\d:]+))?)$/.exec(rest);
    if (dated) { dates[branch] = dated[1]!; rest = rest.slice(0, dated.index).trim(); }
    track[branch] = rest;
  }
  return { branches, track, hashes, dates };
}

/** The branches with no upstream, or ahead of the one they have. */
export interface UnpushedOpts {
  limit?: number;
  /** the branch the repository is on: the single most important line here */
  current?: string | null;
  /** branch names this session's trace named anywhere */
  named?: Set<string>;
  /** true when this branch's commit already sits on some remote ref */
  onARemote?: (branch: string, hash: string) => boolean;
}

/**
 * The branches whose commits exist on NO remote — newest commit first.
 *
 * v5 capped this at six and ranked the current branch first; round 6 found a
 * reviewer-accepted fix that lived only on this disk sitting inside "+4 more".
 * A branch nobody else has is the one thing a handoff cannot leave out, so the
 * cap is fifteen and the order is recency: the newest commit is the one the
 * last session was standing on.
 */
export function unpushedOf(
  parsed: { branches: string[]; track: Record<string, string>; hashes: Record<string, string>; dates?: Record<string, string> },
  opts: UnpushedOpts = {},
): { branches: UnpushedBranch[]; more: number } {
  const candidates: UnpushedBranch[] = [];
  for (const branch of parsed.branches) {
    const track = parsed.track[branch] ?? "";
    // for-each-ref prints nothing at all for a branch with no upstream, and
    // `[ahead N]` / `[gone]` for one that has moved past it
    if (track !== "" && !/\bahead\b|\bgone\b/.test(track)) continue;
    const hash = parsed.hashes[branch] ?? "?";
    if (opts.onARemote?.(branch, hash)) continue;
    candidates.push({ branch, hash, date: parsed.dates?.[branch] ?? null });
  }
  // newest commit first; a branch with no recorded date sorts last, then by name
  candidates.sort((a, b) => (Date.parse(b.date ?? "") || 0) - (Date.parse(a.date ?? "") || 0) || a.branch.localeCompare(b.branch));
  return { branches: candidates.slice(0, opts.limit ?? UNPUSHED_BRANCHES), more: Math.max(0, candidates.length - (opts.limit ?? UNPUSHED_BRANCHES)) };
}

function emptyRepo(path: string, reason: string): LiveRepo {
  return {
    path, notChecked: reason, branch: null, head: null, headDate: null, defaultRef: null, upstream: null, ahead: null, behind: null,
    modified: null, untracked: null, untrackedNames: [], unpushed: [], branches: [], track: {},
  };
}

/**
 * v6/V2 — the remote default branch NAME, from local refs only.
 * `origin/HEAD` when this clone records one, else `origin/main`, else
 * `origin/master`, and only when the ref actually exists here. Nothing fetches.
 */
export function defaultRefName(run: (args: string[]) => string | null): string | null {
  const symbolic = run(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"])?.trim();
  if (symbolic) return symbolic;
  for (const candidate of ["origin/main", "origin/master"]) {
    if (run(["rev-parse", "--verify", "--quiet", `refs/remotes/${candidate}`])?.trim()) return candidate;
  }
  return null;
}

/** The read-only readings for one repository, taken now. */
/** The newest reflog entry of a ref, or null when it has no reflog here. */
export function refUpdated(git: GitRunner, repo: string, ref: string): RefUpdate | null {
  const newest = reflogOf(git, repo, ref)?.[0];
  return newest ? { at: new Date(newest.at).toISOString(), how: howMoved(newest.message) } : null;
}

export function checkRepo(path: string, git: GitRunner, _now: number, named?: Set<string>): LiveRepo {
  const run = (args: string[], timeoutMs = GIT_TIMEOUT_MS): string | null => git(["-C", path, ...args], timeoutMs);
  const toplevel = run(["rev-parse", "--show-toplevel"]);
  // v6/V9 — a directory that is not there and a directory that is not a
  // repository are different facts, and the header prints the first one as
  // `not checked: <path> (directory missing)`.
  if (toplevel == null) return emptyRepo(path, existsSync(path) ? "not a git repository, or the command failed" : "directory missing");
  const branch = run(["branch", "--show-current"])?.trim() || null;
  const hash = run(["rev-parse", "--short", "HEAD"])?.trim() || null;
  const subject = run(["log", "-1", "--format=%s"])?.trim() || null;
  const headDate = run(["log", "-1", "--format=%cI"])?.trim() || null;
  const upstream = run(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"])?.trim() || null;
  let ahead: number | null = null;
  let behind: number | null = null;
  if (upstream) {
    const counts = run(["rev-list", "--left-right", "--count", "@{upstream}...HEAD"])?.trim();
    const parts = counts ? counts.split(/\s+/).map(Number) : [];
    if (parts.length === 2 && parts.every((value) => Number.isFinite(value))) { behind = parts[0]!; ahead = parts[1]!; }
  }
  // v6/V2 — where origin/main stands, as this disk records it
  let defaultRef: DefaultRef | null = null;
  const defaultName = defaultRefName((args) => run(args));
  if (defaultName) {
    const refHash = run(["rev-parse", "--verify", "--short", defaultName])?.trim() || null;
    if (refHash) {
      const refSubject = run(["log", "-1", "--format=%s", defaultName])?.trim() || null;
      const counts = run(["rev-list", "--left-right", "--count", `${defaultName}...HEAD`])?.trim();
      const parts = counts ? counts.split(/\s+/).map(Number) : [];
      const ok = parts.length === 2 && parts.every((value) => Number.isFinite(value));
      defaultRef = { ref: defaultName, hash: refHash, subject: refSubject, behind: ok ? parts[0]! : null, ahead: ok ? parts[1]! : null, updated: refUpdated(git, path, `refs/remotes/${defaultName}`) };
    }
  }
  const upstreamUpdated = upstream ? refUpdated(git, path, `refs/remotes/${upstream}`) : null;

  const porcelain = run(["status", "--porcelain=v1"]);
  const counts = porcelain == null ? null : statusCounts(porcelain);
  const refs = run(["for-each-ref", "--format=%(refname:short) %(objectname:short) %(upstream:track) %(committerdate:iso-strict)", "refs/heads"]);
  const parsed: ParsedRefs = refs == null ? { branches: [], track: {}, hashes: {}, dates: {} } : parseForEachRef(refs);
  // One read for the whole repository instead of one per local branch: the
  // tips no remote ref contains. `git branch -r --contains <hash>` per branch
  // cost 130 spawns on a repository with 130 branches — 43 s of a 57 s
  // handoff. The fallback keeps the old reading when rev-list cannot answer.
  const tips = [...new Set(parsed.branches.map((name) => parsed.hashes[name]).filter((hash): hash is string => !!hash))];
  const unreachable = tips.length ? run(["rev-list", "--no-walk", ...tips, "--not", "--remotes"]) : "";
  const onlyHere = unreachable == null ? null : unreachable.split("\n").map((line) => line.trim()).filter(Boolean);
  const unpushed = unpushedOf(parsed, {
    limit: Infinity,
    current: branch,
    named,
    onARemote: (_branch, hash) => onlyHere == null
      ? (run(["branch", "-r", "--contains", hash])?.trim() ?? "") !== ""
      : !onlyHere.some((full) => full.startsWith(hash)),
  });

  return {
    path, notChecked: null, branch,
    head: hash ? { hash, subject } : null,
    headDate, defaultRef,
    upstream, ahead, behind, upstreamUpdated,
    modified: counts?.modified ?? null,
    untracked: counts?.untracked ?? null,
    untrackedNames: counts?.untrackedNames ?? [],
    unpushed: unpushed.branches.slice(0, UNPUSHED_BRANCHES),
    unpushedAll: unpushed.branches,
    ...(unpushed.branches.length > UNPUSHED_BRANCHES ? { unpushedMore: unpushed.branches.length - UNPUSHED_BRANCHES } : {}),
    branches: parsed.branches,
    track: parsed.track,
  };
}

/**
 * Check every repository path the trace named. With neither `--live` nor an
 * allowed per-host decision, nothing here can reach the network.
 */
export async function checkLive(paths: string[], opts: LiveOpts = {}): Promise<LiveState> {
  if (opts.liveOverride) return opts.liveOverride;
  const git = opts.git ?? realGitRunner;
  const checkedAt = opts.now ?? new Date().toISOString();
  const now = Date.parse(checkedAt);
  const repos = paths.map((path) => checkRepo(path, git, Number.isFinite(now) ? now : Date.now(), opts.knownBranches));
  const remoteHeads: Record<string, Record<string, string>> = {};
  const health: LiveHealth[] = [];
  // Defence in depth: even a caller that bypasses trace extraction cannot make
  // this function contact a non-health, local/private, malformed, or fourth URL.
  const urls = [...new Set((opts.healthUrls ?? []).map(normalizeHealthUrl))].filter(isAllowedHealthUrl).slice(0, 3);

  if (opts.live) {
    for (const repo of repos) {
      if (repo.notChecked) continue;
      const text = git(["-C", repo.path, "ls-remote", "--heads", "origin"], LS_REMOTE_TIMEOUT_MS);
      if (text == null) continue;
      const heads: Record<string, string> = {};
      for (const line of text.split("\n")) {
        const match = /^([0-9a-f]{7,40})\s+refs\/heads\/(\S+)$/.exec(line.trim());
        if (match) heads[match[2]!] = match[1]!;
      }
      remoteHeads[repo.path] = heads;
    }
  }
  const fetcher = opts.fetcher ?? realHealthFetcher;
  for (const url of urls) {
    const host = hostOfHealthUrl(url)!;
    const consent = opts.healthConsent?.get(host);
    const decision = opts.live ? "allow" : consent?.decision ?? "unknown";
    if (decision !== "allow") {
      health.push({ url, body: null, error: null, decision, permission: null });
      continue;
    }
    const result = await fetcher(url, HEALTH_TIMEOUT_MS);
    const permission = !opts.live && consent?.record
      ? { host, decidedAt: consent.record.decidedAt }
      : null;
    health.push("body" in result
      ? { url, body: result.body.slice(0, HEALTH_BODY_CHARS), error: null, decision, permission }
      : { url, body: null, error: result.error, decision, permission });
  }
  return { checkedAt, repos, health, live: opts.live === true, remoteHeads };
}

function ipv4Parts(host: string): number[] | null {
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) return null;
  const parts = host.split(".").map(Number);
  return parts.every((part) => part >= 0 && part <= 255) ? parts : null;
}

/** Public HTTP(S), health-shaped URLs only. This is checked immediately before
 * dispatch as well as when trace URLs are extracted. */
export function isAllowedHealthUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    if (url.username || url.password || !url.hostname) return false;
    if (!url.pathname.toLowerCase().includes("/health") && !url.pathname.toLowerCase().includes("/status")) return false;
    const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase().replace(/\.$/, "");
    if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host === "::" || host === "::1" || host.startsWith("::ffff:")) return false;
    if (/^(?:fc|fd)[0-9a-f]{2}:|^fe[89ab][0-9a-f]:/i.test(host)) return false;
    const ip = ipv4Parts(host);
    if (ip) {
      const [a = 0, b = 0] = ip;
      if (a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return false;
    }
    return true;
  } catch { return false; }
}

const stampOf = (iso: string): string => `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;

/** How many URLs the LIVE STATE UNKNOWN banner names. */
export const UNKNOWN_URLS = 3;

/**
 * v6/V1 — the class of a failed probe, in one word a reader can act on.
 * The raw message ("TimeoutError: The operation was aborted due to timeout")
 * is noise; what matters is whether the address resolved, refused, or hung.
 */
export function errorClass(message: string): string {
  const text = message.toLowerCase();
  if (/timeout|timed out|aborted/.test(text)) return "timeout";
  if (/enotfound|getaddrinfo|dns|unable to resolve/.test(text)) return "dns";
  if (/econnrefused|connection refused/.test(text)) return "connection refused";
  if (/econnreset|socket hang up|connection closed/.test(text)) return "connection reset";
  if (/certificate|self-signed|tls|ssl/.test(text)) return "tls";
  return "request failed";
}

/** True when nothing in this state is a reading of a running service: either
 *  `--live` was off, or every probe failed. */
export function noHealthReading(state: LiveState): boolean {
  return !state.health.some((probe) => probe.error == null && probe.body != null);
}

/**
 * v6/V1 — unknown, said loudly.
 *
 * v5 printed `health: not checked` once per URL, in the middle of a list of git
 * readings, and both judges read past it. Nothing else in the file said what was
 * deployed or running, so the reader was left to assume. The first line under
 * the heading now says carafe contacted nothing at all, and names the command
 * that would answer the question.
 */
export function unknownLines(state: LiveState): string[] {
  if (!state.health.some((probe) => (probe.decision ?? (!state.live ? "unknown" : "allow")) === "unknown")) return [];
  return [
    `- **LIVE STATE UNKNOWN** — carafe did not contact any service.`,
    `  a person can allow this once per project: carafe live allow`,
  ];
}

/** The rendered W1 block: the first thing in the handoff, above everything. */
/**
 * Round 8 — "last updated" comes from the ref's OWN reflog: a push and a fetch
 * both write it. FETCH_HEAD's mtime saw only fetches, and printed "last fetched
 * 2 d ago" beside refs that a push had updated that morning.
 */
export function freshness(update: RefUpdate | null | undefined, checkedAt: string): string {
  if (!update) return "no reflog here, so when it was last updated is unknown";
  const day = update.at.slice(0, 10), clock = update.at.slice(11, 16);
  if (checkedAt && day === checkedAt.slice(0, 10)) return `updated today ${clock} UTC by ${update.how}`;
  const age = checkedAt ? `, ${relativeAge(Date.parse(update.at), Date.parse(checkedAt))}` : "";
  return `updated ${day} ${clock} UTC by ${update.how}${age}`;
}

/** Which repositories Right now prints in full; every other one is counted. */
export interface LiveLinesOpts {
  /** paths printed in full; undefined = every readable repository */
  focus?: Set<string>;
}

/**
 * "N other repositories … not shown", and the directories that were not
 * repositories — never one per line. A few unreadable directories are named
 * with their reason; many are counted.
 */
export function othersLine(others: string[], unreadable: Array<{ path: string; reason: string }> | number): string[] {
  const parts: string[] = [];
  if (others.length) {
    const named = others.slice(0, OTHER_REPOS_NAMED).join(", ") + (others.length > OTHER_REPOS_NAMED ? ", …" : "");
    parts.push(`+ ${others.length} other ${others.length === 1 ? "repository" : "repositories"} touched earlier in the session, not shown here: ${named}`);
  }
  const list = typeof unreadable === "number" ? null : unreadable;
  const count = list ? list.length : (unreadable as number);
  if (list && count && count <= UNREADABLE_NAMED) parts.push(`not checked: ${list.map((one) => `${one.path} (${one.reason})`).join(", ")}`);
  else if (count) parts.push(`${count} other ${count === 1 ? "directory" : "directories"} the session named ${count === 1 ? "is" : "are"} gone or not a repository`);
  return parts.length ? [`- ${parts.join("; ")}`] : [];
}
/** Up to this many unreadable directories are named on the one line; more are counted. */
export const UNREADABLE_NAMED = 3;
/** How many of the other repositories the one-line summary names. */
export const OTHER_REPOS_NAMED = 6;

/** The rendered W1 block: the first thing in the handoff, above everything. */
export function liveLines(state: LiveState, opts: LiveLinesOpts = {}): string[] {
  const body: string[] = [...unknownLines(state)];
  if (state.health.some((probe) => probe.decision === "deny")) {
    body.push(`- live state not checked: you declined network checks for this project (carafe live status)`);
  }
  // round 8 — "not checked" / "directory missing" rows are never one per line
  const unreadable = state.repos.filter((repo) => repo.notChecked).map((repo) => ({ path: repo.path, reason: repo.notChecked! }));
  const others: string[] = [];
  for (const repo of state.repos) {
    if (repo.notChecked) continue;
    if (opts.focus && !opts.focus.has(repo.path)) { others.push(repo.path); continue; }
    const fields: string[] = [];
    fields.push(`branch ${repo.branch ?? "not checked (detached or no branch)"}`);
    if (repo.head) fields.push(`HEAD ${repo.head.hash}${repo.head.subject ? ` "${repo.head.subject}"` : ""}`);
    if (repo.upstream) {
      const counts = repo.ahead != null && repo.behind != null ? `${repo.ahead} ahead, ${repo.behind} behind` : "not checked (rev-list failed)";
      fields.push(`upstream ${repo.upstream}: ${counts} (${freshness(repo.upstreamUpdated, state.checkedAt)})`);
    } else {
      fields.push(`upstream: none`);
    }
    // v6/V2 — where origin/main stands on this disk, and where HEAD stands
    // against it. It is never called deployed or live: it is a local ref, and
    // the line says when it was last written.
    if (repo.defaultRef) {
      const ref = repo.defaultRef;
      const against = ref.ahead != null && ref.behind != null ? ` · HEAD is ${ref.ahead} ahead, ${ref.behind} behind it` : "";
      fields.push(`${ref.ref} at ${ref.hash}${ref.subject ? ` "${ref.subject}"` : ""} (local ref, ${freshness(ref.updated, state.checkedAt)})${against}`);
    }
    if (repo.modified != null && repo.untracked != null) {
      const names = repo.untrackedNames.length ? ` (${repo.untrackedNames.join(", ")}${repo.untracked > repo.untrackedNames.length ? ", …" : ""})` : "";
      fields.push(`${repo.modified} modified, ${repo.untracked} untracked${names}`);
    }
    body.push(`- ${repo.path}`, `  ${fields.join(" · ")}`);
    // v6/V3 — what exists on this disk and nowhere else, all of it
    if (repo.unpushed.length) {
      const groups = new Map<string, UnpushedBranch[]>();
      for (const one of [...(repo.unpushedAll ?? repo.unpushed)].sort((a, b) => (Date.parse(b.date ?? "") || 0) - (Date.parse(a.date ?? "") || 0))) groups.set(one.hash, [...(groups.get(one.hash) ?? []), one]);
      const shown = [...groups.values()].slice(0, UNPUSHED_BRANCHES).map((group) => {
        const one = group[0]!;
        const stub = repo.head?.hash === one.hash && /empty stub/i.test(repo.head.subject ?? "");
        return group.length > 1
          ? `${group.length} branches all at ${stub ? "the empty stub " : ""}${one.hash} (${group.slice(0, 3).map((b) => b.branch).join(", ")}${group.length > 3 ? ", …" : ""})`
          : `${one.branch} ${one.hash}${one.date ? ` (${one.date})` : ""}`;
      }).join(" · ");
      body.push(`  on this disk only (no remote has these commits): ${shown}`);
      const more = repo.unpushedAll ? [...groups.values()].slice(UNPUSHED_BRANCHES).reduce((sum, g) => sum + g.length, 0) : repo.unpushedMore;
      if (more) {
        body.push(`  +${more} more — git -C ${repo.path} for-each-ref --no-merged origin/main refs/heads`);
      }
    }
  }
  body.push(...othersLine(others, unreadable));
  for (const probe of state.health) {
    if (probe.decision === "deny" || (probe.decision ?? (!state.live ? "unknown" : "allow")) === "unknown") continue;
    if (probe.error != null) {
      body.push(`- health: ${probe.url} → unreachable at ${stampOf(state.checkedAt)} (${errorClass(probe.error)})`);
      continue;
    }
    body.push(`- health: ${probe.url} → ${probe.body}`);
  }
  const permissions = new Map<string, string>();
  for (const probe of state.health) {
    if (probe.permission && probe.error == null && probe.body != null) {
      permissions.set(probe.permission.host, probe.permission.decidedAt.slice(0, 10));
    }
  }
  for (const [host, date] of permissions) {
    body.push(`_Checked with your standing permission for ${host}, granted ${date} (carafe live status)._`);
  }
  if (!body.length) return [];
  return [
    `## Right now (checked at ${stampOf(state.checkedAt)}, when this handoff was written)`,
    ``,
    ...body,
    ``,
  ];
}
