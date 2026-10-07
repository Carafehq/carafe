import { basename } from "path";
import { type Checker, type Claim, acrossRepos, hashesIn, objectStores, plain, read, result, toPlainIndex } from "./types";

/**
 * Round 9 — "Both touch only `docs/plans/CHANGELOG.md`": what the commits
 * changed, read with `git show --name-only`. A `✓ file exists` under this
 * sentence checked nothing it said. The commits are the ones the sentence
 * names; a sentence that opens with "Both", "They", "Each" or "It" is about
 * the commits the sentence before it named.
 */
const TOUCH_RE = /\b(?:touch(?:es|ed)? only|only touch(?:es|ed)?|change(?:s|d)? only|only change(?:s|d)?)\b/i;
const PRONOUN_RE = /^\s*(?:\*\*)?(?:both|they|each|it|all|these|those|the two)\b/i;

export const touchOnlyClaims: Checker = (sentence, ctx) => {
  const s = plain(sentence);
  const m = TOUCH_RE.exec(s);
  if (!m) return [];
  // the files named AFTER the verb, between backticks
  const files: Array<{ path: string; end: number }> = [];
  for (const b of sentence.matchAll(/`([^`]+)`/g)) {
    const start = toPlainIndex(sentence, b.index! + 1);
    if (start < m.index!) continue;
    const path = b[1]!.trim().replace(/^\.\//, "");
    if (!/\.[A-Za-z0-9]+$|\/$/.test(path) || /\s/.test(path)) continue;
    files.push({ path, end: start + path.length });
  }
  if (!files.length) return [];
  let hashes = [...new Set(hashesIn(s).filter((h) => h.index < m.index!).map((h) => h.value))];
  if (!hashes.length && PRONOUN_RE.test(s) && ctx.scope?.previous) hashes = [...new Set(hashesIn(plain(ctx.scope.previous)).map((h) => h.value))];
  if (!hashes.length) return [];
  const repos = objectStores(ctx, sentence).filter((repo) => hashes.every((hash) => read(ctx, repo, ["cat-file", "-e", `${hash}^{commit}`]) != null));
  if (!repos.length) return [];
  const label = `${hashes.join(", ")} touch only ${files.map((f) => f.path).join(", ")}`;
  const args = ["show", "--name-only", "--format=%h", ...hashes];
  const span: [number, number] = [m.index!, Math.max(...files.map((f) => f.end))];
  return acrossRepos(repos, label, (repo): Claim => {
    const output = read(ctx, repo, args);
    // a named path may carry the repository's own folder name in front of it
    const named = new Set(files.map((f) => f.path.startsWith(`${basename(repo)}/`) ? f.path.slice(basename(repo).length + 1) : f.path));
    const listed = output?.split("\n").map((line) => line.trim()).filter((line) => line && !hashes.some((hash) => line === hash || hash.startsWith(line) || line.startsWith(hash))) ?? [];
    const agrees = listed.length > 0 && listed.every((file) => named.has(file) || [...named].some((dir) => dir.endsWith("/") && file.startsWith(dir)));
    return { ...result(label, repo, args, output, agrees), negationAware: true };
  }, span);
};
