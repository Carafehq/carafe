import { basename } from "path";
import { type Checker, type ClaimContext, acrossRepos, plain, pathsIn, read, result, owners, isConcrete, hashesIn, trimRef, token, spanOf } from "./types";
/**
 * "Row 44 on `origin/main` is the deploy commit (`b9521b4`)" — the row number,
 * the ref and the hash need not sit next to each other; the file is the one the
 * sentence names.
 */
export const rowClaims: Checker = (sentence, ctx) => {
  const s = plain(sentence);
  const m = new RegExp(`\\b(?:row|line)\\s+(\\d+)\\s+(?:on|in)\\s+(${token})`, "i").exec(s);
  if (!m) return [];
  const ref = trimRef(m[2]!);
  if (!isConcrete(sentence, ref)) return [];
  const hash = hashesIn(s)[0]?.value;
  const file = pathsIn(sentence).map((p) => p.path).find((p) => /\.(?:md|txt|csv|tsv)$/i.test(p))
    ?? /\b([\w./-]+\.(?:md|txt|csv|tsv))\b/.exec(s)?.[1]
    // round 9 — "Row 89 on `origin/main` is …" with the file named one sentence
    // earlier, or elsewhere in the same answer: the table the rows live in
    ?? tableFileIn(ctx);
  const span = spanOf(m);
  if (!file || !hash) return [];
  const repos = owners(ctx, s, hash);
  const inRepo = withoutRepoFolder(file.replace(/^.*?([\w./-]+\.(?:md|txt|csv|tsv))$/i, "$1"), ctx);
  const args = ["show", `${ref}:${inRepo}`];
  return acrossRepos(repos, `row ${m[1]} on ${ref}`, (repo) => {
    const output = read(ctx, repo, args);
    const rows = output?.split("\n").filter((l) => new RegExp(`\\|\\s*${m[1]}\\s*\\|`).test(l));
    // round 9 — the row as far as the cell that carries the commit: a whole
    // changelog row is a paragraph, and the stamp is about one hash in it
    const clip = (row: string): string => {
      const at = row.search(new RegExp(`\\b${hash}\\b`));
      const end = at < 0 ? -1 : row.indexOf("|", at);
      return (end < 0 ? row.slice(0, ROW_VALUE_CHARS) : row.slice(0, end + 1)).trimEnd();
    };
    const value = rows?.length ? rows.map(clip).join("; ") : null;
    return { ...result(`row ${m[1]} on ${ref} is ${hash}`, repo, args, value, !!rows?.every((l) => new RegExp(`\\b${hash}\\b`).test(l))), time: { kind: "row" as const, repo, ref, file: inRepo, row: m[1]!, hash } };
  }, span);
};

const ROW_VALUE_CHARS = 120;
const TABLE_FILE_RE = /[\w./-]+\.(?:md|txt|csv|tsv)\b/g;
/** The table file the sentence's neighbourhood names — a changelog first. */
export function tableFileIn(ctx: ClaimContext): string | undefined {
  for (const text of [ctx.scope?.previous, ctx.scope?.section, ctx.scope?.answers]) {
    const found = [...plain(text ?? "").matchAll(TABLE_FILE_RE)].map((m) => m[0]).filter((one) => !one.includes("…"));
    const chosen = found.find((one) => /changelog/i.test(one)) ?? (text === ctx.scope?.previous ? found[0] : undefined);
    if (chosen) return chosen;
  }
  return undefined;
}
/** `acme-api/docs/CHANGELOG.md` is `docs/CHANGELOG.md` inside `acme-api`. */
export function withoutRepoFolder(file: string, ctx: ClaimContext): string {
  const first = file.split("/")[0]!;
  return ctx.live.repos.some((repo) => basename(repo.path) === first) ? file.slice(first.length + 1) : file;
}
