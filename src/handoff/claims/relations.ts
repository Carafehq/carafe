import { refUpdated } from "../live";
import { type Checker, type Claim, type ClaimContext, acrossRepos, plain, pathsIn, read, result, owners, refAllowed, isHash, hashesIn, trimRef, hashPattern, token, spanOf, backticked } from "./types";

/** "six commits ahead" is a count as much as "6 commits ahead". */
const NUMBER_WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen", "twenty"];
const COUNT = `(\\d+|${NUMBER_WORDS.join("|")})`;
const countOf = (word: string): number => /^\d+$/.test(word) ? Number(word) : NUMBER_WORDS.indexOf(word.toLowerCase());

type Kind = "ahead" | "ancestor" | "head" | "reverse-head" | "bare-head" | "near-ahead";

const LOCAL_MAIN = new Set(["main", "master", "trunk", "develop"]);

/** `main` is the short name of this repository's remote default branch (`origin/main`). */
function isDefaultName(ctx: ClaimContext, repo: string, target: string): boolean {
  if (target.includes("/") || isHash(target) || target === "HEAD") return false;
  return ctx.live.repos.find((one) => one.path === repo)?.defaultRef?.ref === `origin/${target}`;
}

export const relationClaims: Checker = (sentence, ctx) => {
  const s = plain(sentence), out: Claim[] = [];
  const hashes = new Set(hashesIn(s).map((one) => one.value));
  // `X (a note) is an ancestor of Y`: the note between the subject and the verb is not the subject
  const aside = `(?: \\([^)]{0,60}\\))?`;
  const patterns: Array<{ re: RegExp; kind: Kind }> = [
    { re: new RegExp(`(${token})${aside} is ${COUNT} (?:commits? )?ahead of (${token})`, "gi"), kind: "ahead" },
    { re: new RegExp(`(${token})${aside} is (?:an? )?ancestor of (${token})`, "gi"), kind: "ancestor" },
    { re: new RegExp(`(${hashPattern}) is (?:the )?(?:HEAD|head|tip) of (${token})`, "gi"), kind: "head" },
    { re: new RegExp(`(${token}) (?:is at|points to|points at|has HEAD) (${hashPattern})`, "gi"), kind: "reverse-head" },
    // round 8 — "branch `x`, head `a645c32`", "`main` = `a1316ae`", "`origin/main` is
    // `a1316ae`", "on `opus/x` at `f16816d`", "`opus/x` (`c5508d3`, …)": a ref and the
    // commit the sentence says it points at
    { re: new RegExp(`(${token}),? (?:head|HEAD|tip|at|=|is) (${hashPattern})\\b`, "g"), kind: "reverse-head" },
    { re: new RegExp(`(${token}) \\((${hashPattern})[,)]`, "g"), kind: "reverse-head" },
    // "HEAD is a645c32", "the HEAD of main is a645c32" — the head of a ref.
    { re: new RegExp(`(?:HEAD|head) (?:of (${token}) )?is (?:at )?(${hashPattern})`, "gi"), kind: "bare-head" },
    // round 8 — "head `a645c32` "subject", six commits ahead of `main`": the subject
    // of the count is the nearest commit or ref the sentence named before it
    { re: new RegExp(`\\b${COUNT} commits? ahead of (${token})`, "gi"), kind: "near-ahead" },
  ];
  const seen = new Set<string>();
  const taken: Array<[number, number]> = [];
  for (const { re, kind } of patterns) for (const m of s.matchAll(re)) {
    const span = spanOf(m);
    if (span && taken.some(([a, b]) => span[0] < b && a < span[1])) continue;
    let ref: string, target: string, count: number | undefined;
    if (kind === "near-ahead") {
      const before = s.slice(0, m.index);
      const candidates = [...hashesIn(before).map((h) => ({ value: h.value, index: h.index })),
        ...backticked(sentence).filter((b) => !isHash(b) && refAllowed(sentence, b, ctx)).map((b) => ({ value: b, index: before.lastIndexOf(b) }))]
        .filter((c) => c.index >= 0).sort((a, b) => b.index - a.index);
      if (!candidates.length) continue;
      ref = candidates[0]!.value; target = trimRef(m[2]!); count = countOf(m[1]!);
    } else if (kind === "ahead") {
      ref = trimRef(m[1]!); target = trimRef(m[3]!); count = countOf(m[2]!);
    } else {
      ref = trimRef(kind === "reverse-head" || kind === "bare-head" ? m[2]! : m[1]!);
      target = trimRef(kind === "reverse-head" ? m[1]! : kind === "bare-head" ? (m[1] ?? "HEAD") : m[2]!);
    }
    const shape = kind === "near-ahead" ? "ahead" : kind === "ahead" || kind === "ancestor" ? kind : "head";
    if (shape === "head" && !isHash(ref)) continue;

    // Both ends must be things the repository really has; a word that resolves
    // to nothing is prose, not a ref, and prose is not a claim.
    if (![ref, target].every((one) => one === "HEAD" || refAllowed(sentence, one, ctx))) continue;
    // a hash-shaped token that is really a UUID or a path segment is not a hash
    if ([ref, target].some((one) => isHash(one) && !hashes.has(one))) continue;
    if (shape === "head" && isHash(target)) continue;
    const key = `${shape}:${ref}:${target}`;
    if (seen.has(key)) continue;
    seen.add(key);
    // PR #38: "`c0ffee1` is the head of `origin/main`" is refuted by READING
    // origin/main, so the repository is resolved by the REF being described,
    // not by the hash the sentence asserts for it. For a relation between two
    // commits both ends must exist, or there is nothing to read.
    const relation = shape === "ahead" || shape === "ancestor";
    let repos = relation
      ? owners(ctx, s, ref).filter((repo) => target === "HEAD" || read(ctx, repo, ["rev-parse", "--verify", "--quiet", `${target}^{commit}`]) != null)
      : owners(ctx, s, target === "HEAD" ? undefined : target);
    // `main` is in every repository; the commit the sentence gives it is in
    // one. When that narrows the field, the repository holding it is the one
    // meant — and when it holds nowhere, the ref alone still decides.
    if (shape === "head" && repos.length > 1) {
      const holding = repos.filter((repo) => read(ctx, repo, ["cat-file", "-e", `${ref}^{commit}`]) != null);
      if (holding.length) repos = holding;
    }
    // round 9 — "six commits ahead of `main`" is a claim about the project's
    // main line, and the local `main` is whatever this disk last pulled: the
    // judges found it two days stale. Such a count, or a head, is checked
    // against origin's default branch where `main` is that branch's name.
    if (shape !== "ancestor" && repos.length && repos.every((repo) => isDefaultName(ctx, repo, target))) target = `origin/${target}`;
    const args = shape === "ahead" ? ["rev-list", "--count", `${target}..${ref}`]
      : shape === "ancestor" ? ["merge-base", "--is-ancestor", ref, target]
      : ["rev-parse", "--verify", "--quiet", `${target}^{commit}`];
    const label = shape === "ahead" ? `${ref} is ${count} ${count === 1 ? "commit" : "commits"} ahead of ${target}`
      : shape === "ancestor" ? `${ref} is an ancestor of ${target}`
      : target === "HEAD" ? `HEAD is ${ref}` : `${ref} is the head of ${target}`;
    const claims = acrossRepos(repos, label, (repo) => {
      let value = read(ctx, repo, args);
      const agrees = shape === "ahead" ? value?.trim() === String(count) : shape === "ancestor" ? value != null : !!value?.trim().startsWith(ref);
      if (shape === "ancestor" && value == null) {
        // A merge-base from both verified commits proves a non-ancestor. A
        // command failure alone cannot be called a contradiction.
        const base = read(ctx, repo, ["merge-base", ref, target]);
        if (base != null) value = `merge-base ${base.trim()} (not ${ref})`;
      }
      const time = shape === "ahead" ? { kind: "ahead" as const, repo, ref, target, count: count! }
        : shape === "ancestor" ? { kind: "ancestor" as const, repo, ref, target }
        : { kind: "head" as const, repo, ref: target, hash: ref };
      // round 9 — a count or head read off a LOCAL main line says so, with
      // the moment that local ref was last written
      const local = shape !== "ancestor" && LOCAL_MAIN.has(target) ? refUpdated(ctx.git, repo, `refs/heads/${target}`) : null;
      const shown = local ? `${label} (local branch, last updated ${local.at.slice(0, 10)} ${local.at.slice(11, 16)} UTC by ${local.how})` : label;
      return { ...result(shown, repo, args, value, agrees), time };
    }, span);
    if (claims.length && span) taken.push(span);
    out.push(...claims);
  }
  // "the current branch of <path> is x" — the path is read whole, never cut at
  // its first space.
  for (const { path, span } of pathsIn(sentence)) {
    const before = s.slice(Math.max(0, span[0] - 40), span[0]);
    const after = s.slice(span[1]);
    const named = /\bcurrent branch (?:of|in)\s*$/i.test(before) ? /^\s+is\s+([\w./-]+)/.exec(after) : /^\s+is\s+on(?:\s+branch)?\s+([\w./-]+)/.exec(after);
    if (!named) continue;
    const branch = trimRef(named[1]!);
    if (!refAllowed(sentence, branch, ctx)) continue;
    const args = ["branch", "--show-current"];
    const value = read(ctx, path, args);
    out.push({ ...result(`${path} is on ${branch}`, path, args, value, value?.trim() === branch), span: [span[0], span[1] + named[0].length] as [number, number], time: { kind: "branch", repo: path, branch } });
  }
  return out;
};
