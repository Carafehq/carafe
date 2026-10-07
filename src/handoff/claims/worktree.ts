import { type Checker, plain, pathsIn, read, result } from "./types";
export const worktreeClaims: Checker = (sentence, ctx) => {
  const text = plain(sentence);
  if (!/\bclean\b/i.test(text)) return [];
  // Paths come from the RAW sentence: a backticked path is whole, and a bare
  // one is never shortened past what exists on disk.
  return pathsIn(sentence).flatMap(({ path: repo, span }) => {
    if (read(ctx, repo, ["rev-parse", "--is-inside-work-tree"])?.trim() !== "true") return [];
    const args = ["status", "--porcelain"];
    const status = read(ctx, repo, args);
    const lines = status?.split("\n").filter(Boolean);
    const modified = lines?.filter((l) => !l.startsWith("??")) ?? [];
    const untracked = lines?.filter((l) => l.startsWith("??")) ?? [];
    const value = status == null ? null : `${modified.length} modified${modified.length ? ` (${modified.map((l) => l.slice(3)).join(", ")})` : ""}, ${untracked.length} untracked${untracked.length ? ` (${untracked.map((l) => l.slice(3)).join(", ")})` : ""}`;
    const expectsClean = !/\b(?:not clean|dirty)\b/i.test(text);
    // round 8 — the branch/HEAD notes that sat under this stamp were not checks of
    // anything; what moved since the answers were written is in the Since section
    return [{ ...result(`${repo} is ${expectsClean ? "clean" : "not clean"}`, repo, args, value, (lines?.length === 0) === expectsClean), span, negationAware: true,
      time: { kind: "clean" as const, repo, expectsClean, now: lines?.length === 0 ? "clean" : `${modified.length} modified, ${untracked.length} untracked` } }];
  });
};
