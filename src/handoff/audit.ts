/** Fail closed over the assembled document's typed facts, before rendering. */
import { existsSync } from "fs";
import { isAbsolute, resolve } from "path";
import { realGitRunner, type GitRunner } from "./live";

export interface Fact {
  repo: string;
  branch?: string;
  hash?: string;
  path?: string;
  /** A branch tip is stronger than containment. */
  pairing?: "tip" | "ancestor";
  foundIn?: string;
}
export interface AuditCounts { printed: number; rehomed: number; dropped: number }
export interface AuditResult { facts: Fact[]; counts: AuditCounts }
const safe = (s: string): boolean => !!s && !/[\n\r`$\0]/.test(s) && !s.startsWith("-");

export function verifies(fact: Fact, git: GitRunner = realGitRunner): boolean {
  if (![fact.repo, fact.branch, fact.hash, fact.path].filter((v): v is string => v != null).every(safe)) return false;
  // Cheapest first: a path that is not there needs no git at all.
  if (fact.path && !existsSync(isAbsolute(fact.path) ? fact.path : resolve(fact.repo, fact.path))) return false;
  const run = (...args: string[]): string | null => git(["-C", fact.repo, ...args], 5000);
  if (run("rev-parse", "--show-toplevel") == null) return false;
  if (fact.branch && run("rev-parse", "--verify", "--quiet", `${fact.branch}^{commit}`) == null) return false;
  if (fact.hash && (!/^[a-f0-9]{7,40}$/i.test(fact.hash) || run("cat-file", "-e", `${fact.hash}^{commit}`) == null)) return false;
  if (fact.branch && fact.hash) {
    if (fact.pairing === "tip") {
      const tip = run("rev-parse", "--verify", "--quiet", `${fact.branch}^{commit}`)?.trim();
      const hash = run("rev-parse", "--verify", "--quiet", `${fact.hash}^{commit}`)?.trim();
      if (!tip || tip !== hash) return false;
    } else if (run("merge-base", "--is-ancestor", fact.hash, fact.branch) == null) return false;
  }
  return true;
}

/** Every answer is the same for the length of one handoff (one CLI process): ask git once per question.
 * Per repository, one `for-each-ref` answers "is this a branch here" without a process
 * per fact, which is what made re-homing across many repositories take minutes. */
const cachedRunners = new WeakMap<GitRunner, GitRunner>();
function cachedGit(git: GitRunner): GitRunner {
  const existing = cachedRunners.get(git);
  if (existing) return existing;
  const memo = new Map<string, string | null>();
  const refs = new Map<string, Set<string> | null>();
  const refsOf = (repo: string): Set<string> | null => {
    if (!refs.has(repo)) {
      const out = git(["-C", repo, "for-each-ref", "--format=%(refname:short)", "refs/heads", "refs/remotes", "refs/tags"], 5000);
      refs.set(repo, out == null ? null : new Set(out.split("\n").filter(Boolean)));
    }
    return refs.get(repo)!;
  };
  const runner: GitRunner = (args, timeoutMs) => {
    // `-C <repo> rev-parse --verify --quiet <name>^{commit}` for a plain branch name that
    // the repository does not have is a known miss; anything else goes to git.
    if (args[0] === "-C" && args[2] === "rev-parse" && args[3] === "--verify" && args[5]?.endsWith("^{commit}")) {
      const name = args[5].slice(0, -"^{commit}".length);
      const known = refsOf(args[1]!);
      if (known && !/^[a-f0-9]{7,40}$/i.test(name) && !name.includes("~") && !name.includes("^") && name !== "HEAD" && !known.has(name)) return null;
    }
    const key = args.join("\0");
    if (!memo.has(key)) memo.set(key, git(args, timeoutMs));
    return memo.get(key)!;
  };
  cachedRunners.set(git, runner);
  return runner;
}

export function auditFacts(facts: Fact[], checkedRepos: string[], rawGit: GitRunner = realGitRunner): AuditResult {
  const git = cachedGit(rawGit);
  const repos = new Set(checkedRepos);
  // Worktrees share one repository's branches and commits; only files differ. The first
  // `worktree` line is the main working tree.
  const mainOf = new Map<string, string>();
  const treesOf = new Map<string, string[]>();
  for (const repo of checkedRepos) {
    const output = git(["-C", repo, "worktree", "list", "--porcelain"], 5000);
    const trees = (output?.split("\n") ?? []).filter((line) => line.startsWith("worktree /")).map((line) => line.slice(9));
    for (const tree of trees) {
      repos.add(tree);
      if (mainOf.has(tree)) continue;
      mainOf.set(tree, trees[0]!);
      treesOf.set(trees[0]!, [...(treesOf.get(trees[0]!) ?? []), tree]);
    }
  }
  const mainFor = (repo: string) => mainOf.get(repo) ?? repo;
  const mains = [...new Set([...repos].map(mainFor))];
  /** Every checkout where the fact holds, other than fact.repo. A fact without a path holds
   * in all of a repository's worktrees or in none, so git is asked once per repository and
   * each of its worktrees still counts: two checkouts that both verify are ambiguous. */
  const homesOf = (fact: Fact): string[] => {
    if (fact.path) {
      return [...repos].filter((repo) => repo !== fact.repo
        && existsSync(isAbsolute(fact.path!) ? fact.path! : resolve(repo, fact.path!))
        && verifies({ ...fact, repo }, git));
    }
    return mains.filter((main) => main !== mainFor(fact.repo) && verifies({ ...fact, repo: main }, git))
      .flatMap((main) => treesOf.get(main) ?? [main])
      .filter((repo) => repo !== fact.repo);
  };
  const kept: Fact[] = [];
  const counts: AuditCounts = { printed: 0, rehomed: 0, dropped: 0 };
  for (const fact of facts) {
    if (verifies(fact, git)) { kept.push(fact); continue; }
    const homes = homesOf(fact);
    if (homes.length === 1) { kept.push({ ...fact, repo: homes[0]!, foundIn: homes[0]! }); counts.rehomed++; }
    else counts.dropped++;
  }
  counts.printed = kept.length;
  return { facts: kept, counts };
}

/** Explicit, machine-readable visible prose; the independent bench reads this text. */
export function factLine(f: Fact): string {
  return `- repo \`${f.repo}\`${f.branch ? ` · branch \`${f.branch}\`` : ""}${f.hash ? ` · ${f.pairing === "tip" ? "tip" : "commit"} \`${f.hash}\`` : ""}${f.path ? ` · path \`${f.path}\`` : ""}${f.foundIn ? ` (found in ${f.foundIn})` : ""}`;
}
export const auditLine = (c: AuditCounts): string => `audit: ${c.printed} facts printed, ${c.rehomed} re-homed, ${c.dropped} dropped as unverifiable`;
