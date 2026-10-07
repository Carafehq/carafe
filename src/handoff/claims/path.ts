import { existsSync } from "fs";
import { basename, dirname, isAbsolute, join } from "path";
import { type Checker, type Claim, read, scopeRepos, shell, command, toPlainIndex } from "./types";

/** A path written under one of these roots is a path; `/v1` and `/api/v2/jobs` are routes. */
const ABSOLUTE_ROOT_RE = /^(?:\/Users\/|\/private\/|\/tmp\/|\/var\/|\/opt\/|\/etc\/|\/home\/|\/workspace\/)/;
/** placeholders, globs, elisions, URLs and assignments are not paths to look for */
const NOT_A_PATH_RE = /[*<>{}…$=@\s]|^https?:|^[a-z]+:\/\/|^~|^\.\.?\//i;
/** A file name: the written token is a path even when nothing on disk has it. */
const FILE_EXT_RE = /\.(?:md|txt|ts|tsx|js|jsx|mjs|cjs|json|ya?ml|toml|css|scss|html|sh|py|rb|go|rs|sql|csv|tsv|lock|env|log|out|pdf|png|jpe?g|svg)$/i;

/**
 * Round 8 — "`acme-api/specs/PLAN.md`": a named path exists.
 *
 * Where to look: an absolute path as written. A relative path whose first
 * segment names a checked repository (or a folder beside one) under that
 * folder; any other relative path under each checked repository. Found → ✓,
 * with the place it was found. Not found → "?": the disk keeps no record of
 * what existed when the answer was written, so absence now never proves the
 * agent wrong.
 *
 * What is NOT a path claim: a token that names a ref (`origin/main`,
 * `opus/row42-v2`), and a slash-token with no file name, no trailing slash and
 * no named folder that is found nowhere — a route, a ref or a label, not a
 * statement about the disk.
 *
 * Existence is counted and stamped separately from the sentence's deployment
 * or content claim. Prefer the named repository, then search every worked
 * repository, including each local origin/default snapshot, before declaring
 * a path absent. A missing/unreadable repository keeps the result uncertain.
 */
export const pathClaims: Checker = (sentence, ctx) => {
  const exists = ctx.exists ?? existsSync;
  const repos = ctx.live.repos.filter((repo) => !repo.notChecked).map((repo) => repo.path);
  if (!repos.length) return [];
  const parents = [...new Set(repos.map((repo) => dirname(repo)))];
  const isRef = (token: string): boolean => repos.some((repo) =>
    read(ctx, repo, ["rev-parse", "--verify", "--quiet", `${token}^{commit}`]) != null
    || read(ctx, repo, ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${token}^{commit}`]) != null);
  const out: Claim[] = [];
  const seen = new Set<string>();
  for (const m of sentence.matchAll(/`([^`]+)`/g)) {
    const raw = m[1]!.trim();
    const written = raw.replace(/\/+$/, "");
    const dirLike = raw.endsWith("/");
    if (seen.has(written) || NOT_A_PATH_RE.test(written) || !written.includes("/")) continue;
    if (!/[A-Za-z]/.test(written) || /^\d/.test(written)) continue;
    let candidates: string[];
    let anchored = false;
    if (isAbsolute(written)) {
      if (!ABSOLUTE_ROOT_RE.test(written)) continue;
      candidates = [written];
      anchored = true;
    } else {
      const first = written.split("/")[0]!;
      // `acme-api/specs/x.md`: the first segment names the repository to look in
      const repoNamed = parents.map((parent) => join(parent, first)).filter((dir) => repos.includes(dir));
      if (repoNamed.length) { candidates = repoNamed.map((dir) => join(dirname(dir), written)); anchored = true; }
      else {
        // a project folder beside a repository (`acme-notes/…`) — never a
        // hidden one — then the repositories the sentence names, then every other
        const beside = first.startsWith(".") ? [] : parents.map((parent) => join(parent, first)).filter((dir) => exists(dir) && !repos.includes(dir)).map((dir) => join(dirname(dir), written));
        const scoped = scopeRepos(ctx, sentence).filter((repo) => repos.includes(repo));
        candidates = [...new Set([...beside, ...[...new Set([...scoped, ...repos])].map((repo) => join(repo, written))])];
      }
    }
    if (!candidates.length) continue;
    const preferred = scopeRepos(ctx, sentence);
    let foundAll = candidates.filter((candidate) => exists(candidate));
    const preferredFound = foundAll.filter((p) => preferred.some((repo) => p.startsWith(repo + "/")));
    if (preferredFound.length) foundAll = preferredFound;
    let remoteFound: Array<{ repo: string; ref: string; file: string }> = [];
    // Check local origin/default snapshots too: a deleted or stale working
    // copy is not evidence that a merged script is missing from the project.
    for (const candidate of candidates) {
      for (const repo of ctx.live.repos) {
        if (!repo.defaultRef || repo.notChecked || !candidate.startsWith(repo.path + "/")) continue;
        const file = candidate.slice(repo.path.length + 1);
        if (read(ctx, repo.path, ["cat-file", "-e", `${repo.defaultRef.ref}:${file}`]) != null)
          remoteFound.push({ repo: repo.path, ref: repo.defaultRef.ref, file });
      }
    }
    const preferredRemote = remoteFound.filter((r) => preferred.includes(r.repo));
    if (!preferredFound.length && preferredRemote.length) { foundAll = []; remoteFound = preferredRemote; }
    const found = foundAll[0];
    if (!found && !remoteFound.length && !anchored && !dirLike && !FILE_EXT_RE.test(written)) continue;
    if (!isAbsolute(written) && !FILE_EXT_RE.test(written) && !dirLike && isRef(written)) continue;
    seen.add(written);
    const start = toPlainIndex(sentence, m.index! + 1);
    const locations = foundAll.length
      ? foundAll.map((p) => isAbsolute(written) ? p : p.slice(0, p.length - written.length - 1))
      : remoteFound.map((r) => `${r.repo} @ ${r.ref}:${r.file}`);
    const commands = found ? [`test -e ${shell(found)}`] : remoteFound.length
      ? remoteFound.slice(0, 1).map((r) => command(r.repo, ["cat-file", "-e", `${r.ref}:${r.file}`]))
      : [...candidates.map((path) => `test -e ${shell(path)}`), ...ctx.live.repos.filter((r) => r.defaultRef && !r.notChecked).flatMap((r) => candidates.filter((p) => p.startsWith(r.path + "/")).map((p) => command(r.path, ["cat-file", "-e", `${r.defaultRef!.ref}:${p.slice(r.path.length + 1)}`])))];
    out.push({
      label: locations.length ? `path exists: ${written} (in ${locations.join(" and ")})` : `${ctx.live.repos.some((r) => r.notChecked) ? "path unresolved (some repositories unreadable)" : "path not found now"}: ${written}`,
      stamp: locations.length ? "✓" : "?", checkable: true,
      command: commands.join(" ; "),
      value: locations.length ? (found ? "exists" : "(empty)") : `not found in ${candidates.length} working-tree locations or their origin default refs; existence when written unknown`,
      span: [start, start + written.length],
    });
  }
  return out;
};
