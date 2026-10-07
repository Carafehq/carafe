import { type Checker, acrossRepos, plain, read, result, owners, refAllowed, isConcrete, isHash, hashesIn, trimRef, hashPattern, token, spanOf } from "./types";
/**
 * "X is on origin" / "X is local only". X must be something the sentence really
 * names — a hash, or a ref it put between backticks. The word before "unpushed"
 * is not a ref, so when the phrase names nothing concrete the nearest hash in
 * the same sentence is the subject, and failing that there is no claim.
 */
export const remoteClaims: Checker = (sentence, ctx) => {
  const s = plain(sentence);
  const direct = new RegExp(`(${token})\\s+(?:is\\s+)?(on origin|local only|unpushed|not pushed|pushed(?: to origin)?)\\b`, "i").exec(s);
  const reverse = new RegExp(`\\bpushed\\s+(?!to\\b)(${token})\\s+to\\s+(origin\\S*)`, "i").exec(s);
  const m = (reverse ? Object.assign([reverse[0], reverse[1]!, "pushed to origin"], { index: reverse.index }) as unknown as RegExpExecArray : null) ?? direct;
  if (!m) return [];
  const span = spanOf(m);
  let ref = trimRef(m[1]!);
  // PR #38: a bare English word is never a ref.
  let repos = refAllowed(sentence, ref, ctx) ? owners(ctx, s, ref) : [];
  if (!repos.length && !isConcrete(sentence, ref)) {
    // The phrase named nothing that resolves ("Two unpushed", "src/ on
    // origin", "which is local only"): the nearest hash BEFORE it is what the
    // sentence is about, and if there is none there is no claim.
    const hashes = hashesIn(s).filter((h) => h.index < (m.index ?? 0));
    const nearest = hashes.at(-1)?.value;
    if (!nearest) return [];
    ref = nearest;
    repos = owners(ctx, s, ref);
  }
  const args = ["branch", "-r", "--contains", ref];
  const local = /local only|unpushed|not pushed/.test(m[2]!);
  return acrossRepos(repos, `${ref} ${m[2]}`, (repo) => {
    const output = read(ctx, repo, args);
    const matches = output?.split("\n").filter((l) => /\borigin\//.test(l)) ?? [];
    const time = local ? { kind: "local" as const, repo, hashes: [ref] } : { kind: "on-remote" as const, repo, ref };
    return { ...result(`${ref} ${m[2]} (per this disk's remote-tracking refs)`, repo, args, output, local ? !output?.trim() : matches.length > 0), negationAware: local, time };
  }, span);
};

/**
 * "Two unpushed commits sit on `branch`: `h1` and `h2`" — the subjects are the
 * hashes, and one read answers for all of them at once.
 */
export const unpushedCommitsClaims: Checker = (sentence, ctx) => {
  const s = plain(sentence);
  const m = /\b(?:unpushed|not (?:yet )?pushed|only (?:exist|sit)s? (?:here|locally)|on this disk only)\b/i.exec(s);
  if (!m) return [];
  const hashes = [...new Set(hashesIn(s).map((h) => h.value))];
  if (!hashes.length) return [];
  const repos = owners(ctx, s, hashes[0]);
  const label = `${hashes.join(", ")} ${hashes.length === 1 ? "is" : "are"} unpushed`;
  const args = ["rev-list", "--no-walk", ...hashes, "--not", "--remotes"];
  return acrossRepos(repos, label, (repo) => {
    const output = read(ctx, repo, args);
    const listed = output?.split("\n").map((l) => l.trim()).filter(Boolean) ?? [];
    return { ...result(label, repo, args, output, hashes.every((h) => listed.some((full) => full.startsWith(h)))), time: { kind: "local" as const, repo, hashes } };
  }, [m.index!, m.index! + m[0].length]);
};
