/**
 * Round 8 — "Since the agent wrote this".
 *
 * The outgoing agent's answers were written at a moment T. Both judges said the
 * one fact that would have decided "what is going on now" was never stated:
 * the branch the answers called unmerged had landed on origin/main, the
 * worktrees it called clean had moved and were being worked in. Right now
 * printed the raw refs; nobody put them next to what the answers said.
 *
 * This section does that, for every hash, branch and worktree the answers
 * name, in every repository they name — from reflogs, so each line says what
 * moved, when, and by what operation. Nothing here fetches: the reflog of a
 * remote-tracking ref is written by pushes and fetches this machine already
 * made. Every line is re-derivable, and the real-session gate re-derives it.
 */
import { refChanges, refChangeLines, type RefChange } from "./ref-changes";
import { realpathSync } from "fs";
import { basename, isAbsolute, resolve } from "path";
import type { AnswerFile } from "./answers";
import { howMoved, movesAfter, reflogOf, utcStamp, valueAt, type ReflogEntry } from "./history";
import type { GitRunner, LiveHealth, LiveState } from "./live";
import { hashesIn, pathsIn, plain, reposNamedIn } from "./claims/types";

export interface SinceOpts {
  answers: AnswerFile[];
  live: LiveState;
  git: GitRunner;
  /** ISO instant of the check, for the heading */
  now?: string;
  exists?: (path: string) => boolean;
}

const short = (hash: string): string => hash.slice(0, 7);
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The answers as one text. */
export function answersText(answers: AnswerFile[]): string {
  return answers.flatMap((file) => file.sections.map((section) => section.text)).join("\n");
}

/** The earliest moment any of the answer files was written, in epoch ms. */
export function writtenAtOf(answers: AnswerFile[]): number | null {
  const times = answers.map((file) => Date.parse(file.writtenAt ?? "")).filter((ms) => Number.isFinite(ms));
  return times.length ? Math.min(...times) : null;
}

/** Repositories the answers name, by full path or by basename. */
export { reposNamedIn };

const BRANCH_TOKEN_RE = /^[A-Za-z][\w.\-]*(?:\/[\w.\-]+)*$/;
const FILE_EXT_RE = /\.(?:md|txt|ts|tsx|js|jsx|mjs|cjs|json|yml|yaml|toml|css|html|sh|py|rb|go|rs|sql|csv|tsv|lock|env|log|out)$/i;
const BARE_BRANCHES = new Set(["main", "master", "develop", "trunk"]);

/** What the answers name: commits, refs written in backticks, paths that exist. */
export function namedInAnswers(text: string, exists?: (path: string) => boolean): { hashes: string[]; refs: string[]; paths: string[] } {
  const hashes = [...new Set(hashesIn(plain(text)).map((one) => one.value.toLowerCase()))];
  const refs = new Set<string>();
  for (const m of text.matchAll(/`([^`\n]{1,80})`/g)) {
    const token = m[1]!.trim().replace(/[.,;:!?)]+$/, "");
    if (!BRANCH_TOKEN_RE.test(token) || FILE_EXT_RE.test(token) || token.includes("…")) continue;
    if (hashes.includes(token.toLowerCase())) continue;
    if (!token.includes("/") && !token.includes("-") && !BARE_BRANCHES.has(token)) continue;
    refs.add(token);
  }
  const paths = new Set<string>();
  for (const sentence of text.split("\n")) for (const found of pathsIn(sentence, exists)) paths.add(found.path.replace(/\/$/, ""));
  return { hashes, refs: [...refs], paths: [...paths] };
}

interface Worktree { path: string; branch: string | null; head: string | null }

/** `git worktree list --porcelain`, parsed. */
export function parseWorktrees(output: string): Worktree[] {
  const out: Worktree[] = [];
  let current: Worktree | null = null;
  for (const line of output.split("\n")) {
    if (line.startsWith("worktree ")) { current = { path: line.slice(9).trim(), branch: null, head: null }; out.push(current); continue; }
    if (!current) continue;
    if (line.startsWith("branch ")) current.branch = line.slice(7).trim().replace(/^refs\/heads\//, "");
    else if (line.startsWith("HEAD ")) current.head = line.slice(5).trim();
  }
  return out;
}

/** The commit a health body reports, if it reports one. */
export function healthCommit(probe: LiveHealth): string | null {
  const body = probe.body ?? "";
  const m = /"(?:commit|sha|gitSha|git_sha|revision|version_sha|build)"\s*:\s*"([0-9a-f]{7,40})"/i.exec(body) ?? /\b(?:commit|sha|revision)[=: ]+([0-9a-f]{7,40})\b/i.exec(body);
  return m?.[1]?.toLowerCase() ?? null;
}

function uncommitted(porcelain: string | null): { modified: number; untracked: number } | null {
  if (porcelain == null) return null;
  const rows = porcelain.split("\n").filter((row) => row.trim());
  return { modified: rows.filter((row) => !row.startsWith("??")).length, untracked: rows.filter((row) => row.startsWith("??")).length };
}
const dirtyPhrase = (counts: { modified: number; untracked: number }): string =>
  `${counts.modified + counts.untracked} uncommitted file${counts.modified + counts.untracked === 1 ? "" : "s"} (${counts.modified} modified, ${counts.untracked} untracked)`;

/**
 * Round 9 — a commit the answers name (or the head a named branch had when they
 * were written, or that branch's NEWER head) which reached origin's default
 * branch after the answers were written. The answers themselves are annotated
 * with these: "Since" said the round had landed, and both judges still had to
 * connect it to the Q4/Q5 sentences calling it unmerged by hand.
 */
export interface Landed {
  repo: string;
  /** `origin/main` */
  ref: string;
  /** the full object name of the commit that landed */
  hash: string;
  /** the ref update that brought it: when, and the commit the ref moved to */
  at: number;
  via: string;
  /** a named branch whose head this was (when the answers were written, or later: `newer`) */
  branch?: string;
  newer?: boolean;
}
export interface SinceResult { lines: string[]; writtenAt: number | null; checked: number; landed: Landed[]; changes: RefChange[] }

/**
 * The section's lines, or none when the answers name nothing carafe can read.
 * `checked` counts the repositories examined, so a caller can tell "nothing
 * moved" from "nothing looked at".
 */
export function sinceSection(opts: SinceOpts): SinceResult {
  const at = writtenAtOf(opts.answers);
  if (at == null) return { lines: [], writtenAt: null, checked: 0, landed: [], changes: [] };
  const text = answersText(opts.answers);
  const named = namedInAnswers(text, opts.exists);
  // one repository per object store: a linked worktree shares its refs, and
  // its own HEAD is covered where the answers name its branch or its path
  const byStore = new Map<string, string>();
  for (const repo of opts.live.repos.filter((r) => !r.notChecked).map((r) => r.path)) {
    const common = opts.git(["-C", repo, "rev-parse", "--git-common-dir"], 5000)?.trim() ?? repo;
    let key = isAbsolute(common) ? resolve(common) : resolve(repo, common);
    try { key = realpathSync(key); } catch { /* synthetic or unavailable store */ }
    const held = byStore.get(key);
    // the main checkout (whose .git IS the store) wins over a linked worktree
    if (!held || common === ".git") byStore.set(key, repo);
  }
  const repos = [...new Set(byStore.values())];
  if (!repos.length) return { lines: [], writtenAt: at, checked: 0, landed: [], changes: [] };
  const body: string[] = [];
  const moved: string[] = [];
  const landed: Landed[] = [];
  const changes = repos.flatMap((repo) => refChanges(repo, at, opts.git)).sort((a, b) => b.at - a.at);
  body.push(...refChangeLines(changes, at).map((line) => `- ${line}`));
  for (const repo of repos) {
    const items = sinceForRepo(repo, named, at, opts, landed);
    if (items.length) body.push(`- ${repo}`, ...items.map((item) => `  ${item}`));
    else if (!changes.some((c) => c.repo === repo)) moved.push(basename(repo));
  }
  if (moved.length) body.push(`- no recorded changes in ${[...new Set(moved)].join(", ")} since the answers (local reflogs; unavailable or expired history is inconclusive)`);
  const checkedAt = opts.now ?? opts.live.checkedAt;
  const heading = `## Since the agent wrote this (${utcStamp(at)} → checked ${utcStamp(Date.parse(checkedAt) || Date.now())})`;
  return { lines: [heading, ``, ...body, ``], writtenAt: at, checked: repos.length, landed, changes };
}

function sinceForRepo(repo: string, named: { hashes: string[]; refs: string[]; paths: string[] }, at: number, opts: SinceOpts, landedOut: Landed[] = []): string[] {
  const run = (args: string[]): string | null => opts.git(["-C", repo, ...args], 5000);
  const live = opts.live.repos.find((one) => one.path === repo);
  const items: string[] = [];
  const has = (hash: string): boolean => run(["cat-file", "-e", `${hash}^{commit}`]) != null;
  const isAncestor = (hash: string, of: string): boolean => run(["merge-base", "--is-ancestor", hash, of]) != null;
  const hashesHere = named.hashes.filter(has);

  // 1. the remote default branch, then and now
  const defaultRef = live?.defaultRef?.ref ?? null;
  let thenDefault: ReturnType<typeof valueAt> | null = null;
  let movesDefault: ReflogEntry[] = [];
  if (defaultRef) {
    const full = `refs/remotes/${defaultRef}`;
    const entries = reflogOf(opts.git, repo, full);
    thenDefault = valueAt(entries, at);
    movesDefault = movesAfter(entries, at);
    const nowHash = run(["rev-parse", "--verify", "--quiet", `${full}^{commit}`])?.trim() ?? null;
    if (thenDefault.state === "value" && nowHash && nowHash !== thenDefault.hash) {
      const last = movesDefault.at(-1);
      items.push(`${defaultRef} moved ${short(thenDefault.hash)} → ${short(nowHash)}${last ? ` (${utcStamp(last.at)}, by ${howMoved(last.message)})` : ""}`);
    }
    // 2. every commit the answers name: on the default branch now, and then?
    // Commits that landed together (same branch, same ref update) share a line.
    const landedGroups = new Map<string, { hashes: string[]; tail: string }>();
    for (const hash of hashesHere) {
      const now = isAncestor(hash, full);
      const then = thenDefault.state === "value" ? isAncestor(hash, thenDefault.hash) : thenDefault.state === "absent" ? false : null;
      if (now && then === false) {
        const landed = movesDefault.find((entry) => isAncestor(hash, entry.hash));
        const full = run(["rev-parse", "--verify", "--quiet", `${hash}^{commit}`])?.trim();
        if (landed && full) landedOut.push({ repo, ref: defaultRef, hash: full, at: landed.at, via: landed.hash });
        const via = landed ? ` (landed ${utcStamp(landed.at)} via ${short(landed.hash)}, by ${howMoved(landed.message)})` : "";
        const tail = `${branchesHolding(run, hash, named.refs)}\u0000${via}`;
        const group = landedGroups.get(tail);
        if (group) group.hashes.push(hash);
        else { landedGroups.set(tail, { hashes: [hash], tail }); items.push(`\u0000landed:${tail}`); }
      } else if (now && then == null) {
        items.push(`${hash} is on ${defaultRef} now; its reflog does not reach back to say whether it already was`);
      } else if (!now && then === true) {
        items.push(`${hash} was on ${defaultRef} when the answers were written and is not now`);
      }
    }
    for (let i = 0; i < items.length; i++) {
      if (!items[i]!.startsWith("\u0000landed:")) continue;
      const group = landedGroups.get(items[i]!.slice("\u0000landed:".length))!;
      const [branches, via] = group.tail.split("\u0000");
      items[i] = `${group.hashes.join(", ")}${branches} ${group.hashes.length === 1 ? "is" : "are"} now on ${defaultRef}${via}`;
    }
  }

  // 3. every branch the answers name that lives here
  const worktrees = parseWorktrees(run(["worktree", "list", "--porcelain"]) ?? "");
  const covered = new Set<string>();
  for (const ref of named.refs) {
    if (ref === defaultRef || ref.startsWith("origin/")) continue;
    const full = `refs/heads/${ref}`;
    const nowHash = run(["rev-parse", "--verify", "--quiet", `${full}^{commit}`])?.trim() ?? null;
    if (!nowHash) continue;
    const entries = reflogOf(opts.git, repo, full);
    const then = valueAt(entries, at);
    const worktree = worktrees.find((one) => one.branch === ref) ?? null;
    const dirty = worktree ? uncommitted(opts.git(["-C", worktree.path, "status", "--porcelain"], 5000)) : null;
    if (worktree) covered.add(worktree.path);
    const where = worktree ? `its worktree ${worktree.path}` : null;
    // round 9 — the head the branch had then, and its newer head, each on the
    // main line now while it was not then
    const mainRef = defaultRef ? `refs/remotes/${defaultRef}` : null;
    const mainThen = thenDefault?.state === "value" ? thenDefault.hash : null;
    const landedOf = (hash: string): ReflogEntry | null => {
      if (!mainRef || !mainThen) return null;
      if (!isAncestor(hash, mainRef) || isAncestor(hash, mainThen)) return null;
      return movesDefault.find((entry) => isAncestor(hash, entry.hash)) ?? null;
    };
    if (then.state === "value" && defaultRef) {
      const landedThen = landedOf(then.hash);
      if (landedThen) landedOut.push({ repo, ref: defaultRef, hash: then.hash, at: landedThen.at, via: landedThen.hash, branch: ref });
    }
    if (then.state === "value" && then.hash !== nowHash) {
      const count = run(["rev-list", "--count", `${then.hash}..${nowHash}`])?.trim();
      const last = movesAfter(entries, at).at(-1);
      let line = `${ref} moved ${short(then.hash)} → ${short(nowHash)}${count ? ` (+${count}` : "("}${last ? `${count ? ", " : ""}${utcStamp(last.at)}` : ""})`;
      const newer = landedOf(nowHash);
      if (newer && defaultRef) {
        landedOut.push({ repo, ref: defaultRef, hash: nowHash, at: newer.at, via: newer.hash, branch: ref, newer: true });
        line += `; ${short(nowHash)} is on ${defaultRef} too (landed ${utcStamp(newer.at)} via ${short(newer.hash)})`;
      }
      if (where && dirty && dirty.modified + dirty.untracked) line += `; ${where} now has ${dirtyPhrase(dirty)} — someone is working there`;
      else if (where && dirty) line += `; ${where} is clean`;
      items.push(line);
    } else if (then.state === "absent") {
      items.push(`${ref} was created after the answers were written (now ${short(nowHash)})`);
    } else if (where && dirty && dirty.modified + dirty.untracked) {
      items.push(`${ref} has not moved (${short(nowHash)}); ${where} has ${dirtyPhrase(dirty)}`);
    }
  }

  // 4. every worktree the answers name by path, not already covered by its branch
  for (const path of named.paths) {
    if (covered.has(path)) continue;
    const worktree = worktrees.find((one) => one.path === path);
    if (!worktree) continue;
    covered.add(path);
    const entries = reflogOf(opts.git, path, "HEAD");
    const then = valueAt(entries, at);
    const nowHash = opts.git(["-C", path, "rev-parse", "HEAD"], 5000)?.trim() ?? null;
    const dirty = uncommitted(opts.git(["-C", path, "status", "--porcelain"], 5000));
    const dirt = dirty && dirty.modified + dirty.untracked ? `; now has ${dirtyPhrase(dirty)}` : dirty ? "; clean" : "";
    if (then.state === "value" && nowHash && then.hash !== nowHash) {
      const last = movesAfter(entries, at).at(-1);
      items.push(`worktree ${path}: HEAD moved ${short(then.hash)} → ${short(nowHash)}${last ? ` (${utcStamp(last.at)})` : ""}${dirt} — someone is working there`);
    } else if (dirty && dirty.modified + dirty.untracked) {
      items.push(`worktree ${path}: HEAD has not moved${nowHash ? ` (${short(nowHash)})` : ""}${dirt}`);
    }
  }

  // 5. what production reports, against the commits the answers name
  for (const probe of opts.live.health) {
    const commit = healthCommit(probe);
    if (!commit || !has(commit)) continue;
    const contained = hashesHere.filter((hash) => isAncestor(hash, commit));
    const missing = hashesHere.filter((hash) => !contained.includes(hash));
    const parts = [contained.length ? `which contains ${contained.join(", ")}` : "", missing.length ? `which does not contain ${missing.join(", ")}` : ""].filter(Boolean);
    items.push(`${probe.url} reports ${commit}${parts.length ? `, ${parts.join(" and ")}` : ""}`);
  }
  return items;
}

/** ` (codex/status-copy)` — the local branches holding a commit, the ones the answers named first. */
function branchesHolding(run: (args: string[]) => string | null, hash: string, named: string[]): string {
  const out = run(["branch", "--contains", hash, "--format=%(refname:short)"]);
  if (!out) return "";
  const branches = out.split("\n").map((line) => line.trim()).filter(Boolean);
  const preferred = branches.filter((branch) => named.includes(branch));
  const shown = (preferred.length ? preferred : branches).slice(0, 2);
  return shown.length ? ` (${shown.join(", ")})` : "";
}

/** Round 9 — the questions whose sentences say what is in flight and what to do next. */
export const DELTA_QUESTIONS = new Set([2, 4, 5]);

/**
 * The inline notes for one answer sentence: every commit it names (by hash,
 * even inside a file name like `…-REBUILD-1a2b3c4.md`), and every branch it
 * names, that reached origin's default branch after the answers were written.
 * One line per ref update, so each note carries one time and one commit:
 *
 *   ↳ since landed on origin/main 2026-09-22 11:08 UTC via def5678 — items here may be done (abc1234 in /repo)
 */
export function landedNotes(sentence: string, landed: Landed[]): string[] {
  const text = plain(sentence);
  const tokens = [...text.matchAll(/(?<![0-9a-f])([0-9a-f]{7,40})(?![0-9a-f])/gi)].map((m) => m[1]!.toLowerCase());
  const names = (branch: string): boolean => new RegExp(`(?:^|[\\s\`"'(])${branch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w/-])`).test(sentence);
  const groups = new Map<string, { first: Landed; items: string[] }>();
  for (const one of landed) {
    const byHash = tokens.some((token) => one.hash.startsWith(token));
    const byBranch = one.branch != null && names(one.branch);
    if (!byHash && !byBranch) continue;
    const item = one.newer ? `${short(one.hash)}, the newer head of ${one.branch}` : short(one.hash);
    const key = `${one.repo}\u0000${one.ref}\u0000${one.via}`;
    const group = groups.get(key) ?? { first: one, items: [] };
    if (!group.items.includes(item)) group.items.push(item);
    groups.set(key, group);
  }
  return [...groups.values()]
    .sort((a, b) => a.first.at - b.first.at || a.first.repo.localeCompare(b.first.repo))
    .map(({ first, items }) => `↳ since landed on ${first.ref} ${utcStamp(first.at)} via ${short(first.via)} — items here may be done (${items.join("; ")} in ${first.repo})`);
}
