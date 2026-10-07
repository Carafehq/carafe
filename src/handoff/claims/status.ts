import { readFileSync } from "fs";
import { basename, dirname, isAbsolute, join } from "path";
import { reflogOf, utcStamp, valueAt } from "../history";
import { type Checker, type Claim, type ClaimContext, backticked, command, hashesIn, isHash, objectStores, plain, read, scopeRepos } from "./types";

/**
 * Round 9 — "the follow-up items (a guard in `src/middleware/guard.ts`, an
 * early return for `anon:undefined` in `keyFor`) were briefed" and "X is done
 * in `abc1234`".
 *
 * Both judges found the one false statement in the answers — work called open
 * that the named commit already contained — sitting under two `✓ file exists`
 * stamps that checked nothing it said. When a sentence calls work open (or done
 * in a commit) and names concrete things — files, identifiers, strings, or a
 * brief whose own text names them — each one is looked for in the commit the
 * sentence names, against the point where that commit's line of work left
 * origin's default branch:
 *
 *   new       — in the commit, not at that point (a file added, a string introduced)
 *   changed   — a file in both, which the line of work changed
 *   unchanged — in both, untouched
 *
 * Open work that the commit already has new AND changed evidence for (at least
 * half of what is named, one of them new) was not open: ✗ false when written,
 * because a commit's content never changes and it was committed before the
 * answers. None of it there: ✓. Anything between: ?, with what was found.
 */
const OPEN_RE = /\b(?:still open|(?:were|was|is|are|been|only) briefed|not (?:yet )?(?:done|implemented|finished|addressed|confirmed done)|open work|remaining work|outstanding|unfinished|to be done)\b/i;
const DONE_RE = /\b(?:done|implemented|hardened|fixed|addressed)\s+(?:in|at|by)\s+`?([0-9a-f]{7,40})\b/i;
const CODE_EXT_RE = /\.(?:ts|tsx|js|jsx|mjs|cjs|json|py|rb|go|rs|sql|sh|css|scss|html|ya?ml|toml|swift|kt|java)$/i;
const BRIEF_RE = /\.md$/i;
/** How many things a brief may add, and how much of it is read. */
export const BRIEF_ITEMS = 12;
const BRIEF_BYTES = 200_000;

type Status = "new" | "changed" | "unchanged" | "absent";
interface Item { text: string; kind: "file" | "string" }

function isFileToken(token: string): boolean {
  return !/\s/.test(token) && !token.startsWith("/") && !token.startsWith("~") && CODE_EXT_RE.test(token) && !/[*<>{}…$]/.test(token);
}
function isStringToken(token: string, ctx: ClaimContext): boolean {
  if (/\s/.test(token) || token.includes("/") || isHash(token) || BRIEF_RE.test(token) || CODE_EXT_RE.test(token)) return false;
  if (token.length < 4 || !/[A-Za-z]/.test(token) || /[…*<>]/.test(token)) return false;
  // a name that is really a branch or a repository is not something to grep for
  for (const repo of ctx.live.repos) if (repo.branches.includes(token) || basename(repo.path) === token) return false;
  // plain lower-case English is not a symbol: an identifier has a capital
  // inside it, an underscore, a colon, a dot or a digit
  return /[a-z][A-Z]|[_:.\d]|^[A-Z][A-Z0-9_]{3,}$/.test(token);
}

/** The brief files the sentence names, found where the answers put their other files. */
function briefPaths(sentence: string, ctx: ClaimContext): string[] {
  const exists = ctx.exists ?? ((p: string) => { try { readFileSync(p); return true; } catch { return false; } });
  const names = backticked(sentence).map((token) => token.trim()).filter((token) => BRIEF_RE.test(token) && !token.includes("…"));
  if (!names.length) return [];
  const roots = new Set<string>();
  for (const repo of ctx.live.repos) { if (!repo.notChecked) { roots.add(repo.path); roots.add(dirname(repo.path)); } }
  // folders the answers named files in: `notes/BRIEF-A.md` makes `notes/` a place to look for `BRIEF-B.md`
  for (const token of backticked(ctx.scope?.answers ?? "")) {
    if (!BRIEF_RE.test(token) || !token.includes("/")) continue;
    const dir = dirname(token.trim());
    if (isAbsolute(dir)) roots.add(dir);
    else for (const root of [...roots]) roots.add(join(root, dir));
  }
  const out: string[] = [];
  for (const name of names) {
    const candidates = isAbsolute(name) ? [name] : [...roots].map((root) => join(root, name));
    const found = candidates.find((candidate) => exists(candidate));
    if (found && !out.includes(found)) out.push(found);
  }
  return out;
}

function briefItems(paths: string[], ctx: ClaimContext): Item[] {
  const items: Item[] = [];
  for (const path of paths) {
    let text: string | null = null;
    try { text = ctx.readText ? ctx.readText(path) : readFileSync(path, "utf8").slice(0, BRIEF_BYTES); } catch { text = null; }
    if (!text) continue;
    const tokens = [...new Set(backticked(text).map((token) => token.trim()))];
    // the files first: they are the strongest evidence a brief carries
    for (const token of tokens.filter(isFileToken)) items.push({ text: token, kind: "file" });
    for (const token of tokens.filter((one) => isStringToken(one, ctx))) items.push({ text: token, kind: "string" });
  }
  return items.slice(0, BRIEF_ITEMS);
}

function statusOf(ctx: ClaimContext, repo: string, base: string, head: string, item: Item): Status {
  if (item.kind === "file") {
    const inHead = read(ctx, repo, ["cat-file", "-e", `${head}:${item.text}`]) != null;
    const inBase = read(ctx, repo, ["cat-file", "-e", `${base}:${item.text}`]) != null;
    if (!inHead) return "absent";
    if (!inBase) return "new";
    return (read(ctx, repo, ["diff", "--name-only", base, head, "--", item.text]) ?? "").trim() ? "changed" : "unchanged";
  }
  const count = (rev: string): number => (read(ctx, repo, ["grep", "-c", "-F", "-e", item.text, rev]) ?? "")
    .split("\n").map((line) => Number(line.split(":").at(-1))).filter(Number.isFinite).reduce((a, b) => a + b, 0);
  const inHead = count(head), inBase = count(base);
  if (!inHead) return "absent";
  if (!inBase) return "new";
  return inHead !== inBase ? "changed" : "unchanged";
}

export const workStatusClaims: Checker = (sentence, ctx) => {
  const s = plain(sentence);
  const open = OPEN_RE.test(s);
  const done = DONE_RE.exec(s);
  if (!open && !done) return [];
  const own: Item[] = [];
  for (const token of new Set(backticked(sentence).map((one) => one.trim()))) {
    if (isFileToken(token)) own.push({ text: token, kind: "file" });
    else if (isStringToken(token, ctx)) own.push({ text: token, kind: "string" });
  }
  const items = [...own, ...briefItems(briefPaths(sentence, ctx), ctx).filter((item) => !own.some((one) => one.text === item.text))];
  if (!items.length) return [];
  const heads = done ? [done[1]!] : [...new Set(hashesIn(s).map((h) => h.value))];
  if (!heads.length) return [];
  const scoped = new Set(scopeRepos(ctx, sentence));
  const out: Claim[] = [];
  for (const repo of objectStores(ctx, sentence)) {
    for (const head of heads) {
      if (read(ctx, repo, ["cat-file", "-e", `${head}^{commit}`]) == null) continue;
      // where this line of work left the main line, as the main line stood when written
      const main = ctx.live.repos.find((one) => one.path === repo)?.defaultRef?.ref
        ?? ctx.live.repos.find((one) => scoped.has(one.path) && one.defaultRef)?.defaultRef?.ref;
      if (!main) continue;
      const then = ctx.writtenAt != null ? valueAt(reflogOf(ctx.git, repo, `refs/remotes/${main}`), ctx.writtenAt) : null;
      const mainThen = then?.state === "value" ? then.hash : read(ctx, repo, ["rev-parse", "--verify", "--quiet", `${main}^{commit}`])?.trim();
      if (!mainThen) continue;
      const base = read(ctx, repo, ["merge-base", head, mainThen])?.trim();
      if (!base || head.length >= 7 && base.startsWith(head)) continue;
      const statuses = items.map((item) => ({ item, status: statusOf(ctx, repo, base, head, item) }));
      const known = statuses.filter((one) => one.status !== "absent");
      // nothing named is in this commit's tree at all: it is not the commit the items are about
      if (!known.length) continue;
      const fresh = known.filter((one) => one.status === "new");
      const inHead = known.filter((one) => one.status === "new" || one.status === "changed");
      // in-the-commit first, then the untouched ones: every item with its status
      const list = (group: typeof known): string => [...group].sort((a, b) => Number(a.status === "unchanged") - Number(b.status === "unchanged")).map((one) => `${one.item.text} (${one.status})`).join(", ");
      // the command printed is the one that fixes the comparison point; every
      // status in the label is re-derivable from it (the gate re-derives them)
      const args = ["merge-base", head, mainThen];
      const value = base;
      const committed = read(ctx, repo, ["log", "-1", "--format=%cI", head])?.trim() ?? null;
      const before = committed != null && ctx.writtenAt != null && Date.parse(committed) <= ctx.writtenAt;
      let stamp: Claim["stamp"];
      let label: string;
      if (done) {
        stamp = inHead.length === known.length ? "✓" : "?";
        label = `${head} has what this calls done: ${list(known)}`;
      } else if (!inHead.length) {
        stamp = "✓";
        label = `${head} does not have what this calls open: ${list(known)}`;
      } else {
        stamp = fresh.length && inHead.length * 2 >= known.length && before ? "✗" : "?";
        label = `${head} already has what this calls open: ${list(known)}`;
      }
      const claim: Claim = { label, stamp, checkable: true, command: command(repo, args), value: value ?? "unavailable", negationAware: true };
      if (stamp === "✗" && ctx.writtenAt != null && committed) {
        claim.when = { at: ctx.writtenAt, verdict: "false", changed: false, evidence: [`${head} was committed ${utcStamp(Date.parse(committed))}, before the answers were written [${command(repo, ["log", "-1", "--format=%cI", head])}]`] };
      }
      out.push(claim);
    }
  }
  return out;
};
