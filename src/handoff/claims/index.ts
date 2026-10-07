import { realGitRunner } from "../live";
import type { AnswerFacts } from "../answers";
import { type Claim, type ClaimContext, objectStores, read, hashesIn, negatedAt, plain } from "./types";
import { worktreeClaims } from "./worktree";
import { fileRefClaims } from "./file-ref";
import { rowClaims } from "./row";
import { remoteClaims, unpushedCommitsClaims } from "./remote";
import { portClaims } from "./port";
import { siblingClaims } from "./sibling";
import { relationClaims } from "./relations";
import { pathClaims } from "./path";
import { liveCopyClaims } from "./live-copy";
import { touchOnlyClaims } from "./touch";
import { workStatusClaims } from "./status";
import { timeAware } from "./when";
export type { Claim } from "./types";
export function checkClaims(sentence: string, facts: AnswerFacts): Claim[] {
  const written = Date.parse(facts.writtenAt ?? "");
  const ctx: ClaimContext = { live: facts.live, git: facts.git ?? realGitRunner, portReader: facts.portReader, exists: facts.exists, writtenAt: Number.isFinite(written) ? written : undefined, scope: facts.scope, readText: facts.readText };
  // Most specific first. A sentence span already claimed by one checker is not
  // re-matched by a later, looser one ("row 42 on origin/main is <hash>" is a row
  // claim, never also a branch-on-remote claim about "42 on origin").
  const claims: Claim[] = [];
  const taken: Array<[number, number]> = [];
  const text = plain(sentence);
  for (const check of [liveCopyClaims, touchOnlyClaims, worktreeClaims, rowClaims, fileRefClaims, unpushedCommitsClaims, remoteClaims, relationClaims, portClaims, siblingClaims, workStatusClaims, pathClaims]) {
    const batch = check(sentence, ctx)
      .filter((c) => !c.span || !taken.some(([a, b]) => c.span![0] < b && a < c.span![1]))
      // PR #38: "Neither checkout is on `main`" is not the claim "is on main".
      // A checker that does not model the negation itself has read it wrong.
      .filter((c) => c.negationAware || !c.span || !negatedAt(text, c.span[0]));
    claims.push(...batch);
    for (const c of batch) if (c.span) taken.push(c.span);
  }
  // round 9 — a file a work-status claim already looked for inside the commit
  // needs no second, weaker "path exists" note under the same sentence
  const looked = claims.filter((c) => c.checkable && / (?:already has|does not have|has) what this calls /.test(c.label)).map((c) => c.label).join(" ");
  if (looked) for (let i = claims.length - 1; i >= 0; i--) {
    const note = /^path (?:exists|not found now): (\S+)/.exec(claims[i]!.label);
    if (note && looked.includes(`${note[1]} (`)) claims.splice(i, 1);
  }
  // …and a hash no checker spoke for is noted where it exists. One repository
  // per object store: linked worktrees answer this identically.
  const stores = objectStores(ctx, sentence);
  for (const hash of new Set(hashesIn(text).map((h) => h.value))) {
    if (claims.some((c) => c.label.includes(hash))) continue;
    for (const repo of stores) {
      const args = ["cat-file", "-e", `${hash}^{commit}`];
      if (read(ctx, repo, args) == null) continue;
      claims.push({ label: `${hash} exists in ${repo}`, stamp: "·", checkable: false });
      break;
    }
  }
  // Existence is a narrower check than deployment, merge state or behavior.
  if (claims.some((c) => c.label.startsWith("path exists:")) && /\b(?:deployed|merged|enforces|returns|implemented|ready)\b/i.test(sentence))
    claims.push({ label: "deployment/content claim not verified by path existence", stamp: "?", checkable: true });
  if (/\b(?:PR\s*)?#\d+\b/.test(sentence) && /\b(?:open|closed|merged|conflict(?:ing)?|failing|draft)\b/i.test(sentence) && !claims.some((c) => /pull request state/.test(c.label)))
    claims.push({ label: "pull request state not checked (local git cannot establish current PR status)", stamp: "?", checkable: true });
  // round 8 — every claim is judged at the moment the answers were written
  return claims.map((claim) => timeAware(claim, ctx));
}
