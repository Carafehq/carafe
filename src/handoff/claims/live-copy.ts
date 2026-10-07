import { basename } from "path";
import { reflogOf, valueAt } from "../history";
import { healthCommit } from "../since";
import { type Checker, type Claim, backticked, hashPattern, isHash, plain, read, result } from "./types";

/**
 * Round 9 — "the unstale copies are the worktrees `x-baseline` (`abc1234`) and
 * `x-feature-build` (`def5678`)": a worktree said to MATCH what is live is
 * checked against origin's default branch — `rev-list --count <its commit>..origin/main`
 * must be 0. The judges found the second one three commits behind live when it
 * was written, stamped "named, not checked".
 *
 * The worktree's commit is the one the sentence gives it in parentheses; failing
 * that, the one its HEAD reflog says it had when the answers were written.
 */
const LIVE_COPY_RE = /\b(?:unstale|current cop(?:y|ies)|live-matching|match(?:es|ing)? (?:live|production|what is live|what's live)|up to date with (?:live|production)|same as (?:live|production))\b/i;

interface Worktree { path: string; head: string | null }
function worktreesOf(ctx: Parameters<Checker>[1], repo: string): Worktree[] {
  const out = read(ctx, repo, ["worktree", "list", "--porcelain"]);
  if (!out) return [];
  const list: Worktree[] = [];
  for (const line of out.split("\n")) {
    if (line.startsWith("worktree ")) list.push({ path: line.slice(9).trim(), head: null });
    else if (line.startsWith("HEAD ") && list.length) list.at(-1)!.head = line.slice(5).trim();
  }
  return list;
}

export const liveCopyClaims: Checker = (sentence, ctx) => {
  const s = plain(sentence);
  const cue = LIVE_COPY_RE.exec(s);
  if (!cue) return [];
  const tokens = backticked(sentence).filter((token) => !isHash(token));
  if (!tokens.length) return [];
  const out: Claim[] = [];
  const seen = new Set<string>();
  for (const repo of ctx.live.repos) {
    if (repo.notChecked || !repo.defaultRef) continue;
    const trees = worktreesOf(ctx, repo.path);
    for (const token of tokens) {
      const tree = trees.find((one) => one.path === token || basename(one.path) === token);
      if (!tree || seen.has(tree.path)) continue;
      seen.add(tree.path);
      // "`name` (`def5678`)": the commit the sentence gives the worktree
      const given = new RegExp(`\`${token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\`\\s*\\(\`?(${hashPattern})\`?`, "i").exec(sentence)?.[1];
      let hash = given ?? null;
      if (!hash && ctx.writtenAt != null) {
        const then = valueAt(reflogOf(ctx.git, tree.path, "HEAD"), ctx.writtenAt);
        if (then.state === "value") hash = then.hash.slice(0, 7);
      }
      hash ??= tree.head?.slice(0, 7) ?? null;
      if (!hash) continue;
      const target = repo.defaultRef.ref;
      const args = ["rev-list", "--count", `${hash}..${target}`];
      const value = read(ctx, repo.path, args);
      const label = `${hash} is 0 commits behind ${target} (worktree ${basename(tree.path)})`;
      out.push({
        ...result(label, repo.path, args, value, value?.trim() === "0"),
        time: { kind: "behind", repo: repo.path, ref: hash, target, count: 0 },
      });
      // …and against what production reports, when a person allowed the probe:
      // a reading of now only, so it can hold now and say nothing about then
      for (const probe of ctx.live.health) {
        const commit = healthCommit(probe);
        if (!commit || read(ctx, repo.path, ["cat-file", "-e", `${commit}^{commit}`]) == null) continue;
        const healthArgs = ["rev-list", "--count", `${hash}..${commit}`];
        const behind = read(ctx, repo.path, healthArgs);
        out.push({
          ...result(`${hash} is 0 commits behind ${commit} (what ${probe.url} reports now)`, repo.path, healthArgs, behind, behind?.trim() === "0"),
          time: { kind: "no-history", what: "what a health URL reported" },
        });
      }
    }
  }
  return out;
};
