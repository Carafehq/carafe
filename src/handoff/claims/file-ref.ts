import { type Checker, acrossRepos, plain, pathsIn, read, result, owners, isConcrete, hashesIn, hashPattern, token, spanOf } from "./types";
/** "`<path>` was added in `<hash>`", "`<name>` is implemented in `<hash>`". */
export const fileRefClaims: Checker = (sentence, ctx) => {
  const s = plain(sentence);
  const file = new RegExp(`(${token}\\.[A-Za-z0-9]+)\\s+(?:(?:still )?(?:is |was )?(not |outstanding|missing)|exists|was added|is present)[^.!?]*?\\b(?:in|at)\\s+(${hashPattern})\\b`, "i").exec(s);
  const symbol = new RegExp(`(${token})\\s+is\\s+(not )?implemented\\s+in\\s+(${hashPattern})\\b`, "i").exec(s);
  const m = file ?? symbol;
  if (!m) return [];
  const name = m[1]!, ref = m[3]!;
  if (!hashesIn(s).some((one) => one.value === ref)) return [];
  // the hash is concrete by construction; the file or symbol must be too
  if (!isConcrete(sentence, name) && !/^[\w./-]+\.[A-Za-z0-9]+$/.test(name)) return [];
  const span = spanOf(m);
  const repos = owners(ctx, s, ref);
  const negative = !!m[2];
  // a path the sentence wrote out in full is used as written, never as a prefix
  const named = pathsIn(sentence).find((p) => p.path.endsWith(name));
  return acrossRepos(repos, m[0], (repo) => {
    const path = file ? (named?.path.startsWith(repo) ? named.path.slice(repo.length + 1) : name) : /\b(?:at|under|in)\s+(src\/\S+)/.exec(s)?.[1] ?? "src";
    const args = file ? ["cat-file", "-e", `${ref}:${path}`] : ["grep", "-n", "-F", "-e", name, ref, "--", path];
    // Presence is observed evidence; a failed command is not evidence of absence.
    return { ...result(m[0], repo, args, read(ctx, repo, args), !negative), negationAware: true };
  }, span);
};
