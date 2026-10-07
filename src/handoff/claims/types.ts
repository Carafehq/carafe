import { existsSync } from "fs";
import { basename } from "path";
import type { GitRunner, LiveState } from "../live";
/** `span` is the [start, end) range of the sentence a checker consumed; a more
 *  specific checker claims its span first and later checkers may not re-match it. */
export interface Claim {
  label: string; stamp: "✓" | "✗" | "?" | "·"; command?: string; value?: string; checkable: boolean; span?: [number, number]; negationAware?: boolean;
  /** round 8 — how this claim is evaluated at the moment the answers were written */
  time?: TimeSpec;
  /** round 8 — the claim at that moment: printed on its own line under the stamp */
  when?: WhenWritten;
}
/**
 * What a claim says, in the terms git history can answer at a past moment.
 * A checker that knows its claim is about a ref says so; `timeAware` does the
 * rest. A claim with no spec is about something that never changes (a commit's
 * content, one commit's ancestry) and needs no history.
 */
export type TimeSpec =
  | { kind: "head"; repo: string; ref: string; hash: string }
  | { kind: "ahead"; repo: string; ref: string; target: string; count: number }
  /** round 9 — `ref` is `count` commits behind `target` (a live copy: 0) */
  | { kind: "behind"; repo: string; ref: string; target: string; count: number }
  | { kind: "ancestor"; repo: string; ref: string; target: string }
  | { kind: "clean"; repo: string; expectsClean: boolean; now: string }
  | { kind: "local"; repo: string; hashes: string[] }
  | { kind: "on-remote"; repo: string; ref: string }
  | { kind: "branch"; repo: string; branch: string }
  | { kind: "row"; repo: string; ref: string; file: string; row: string; hash: string }
  | { kind: "path"; path: string }
  | { kind: "no-history"; what: string };
export interface WhenWritten {
  /** epoch ms of the answers file */
  at: number;
  verdict: "held" | "false" | "cannot tell";
  /** held when written, and no longer holds */
  changed: boolean;
  /** `ref was abc1234 [git …]`, `[git …] → 6`, free notes — each re-checkable */
  evidence: string[];
}
export const spanOf = (m: RegExpMatchArray): [number, number] | undefined =>
  typeof m.index === "number" ? [m.index, m.index + m[0]!.length] : undefined;
/**
 * Round 9 — where a sentence sits. A path or a row number the sentence does
 * not anchor itself is resolved against what its SECTION names, then what the
 * whole answers name — never against a third repository nobody mentioned.
 */
export interface ClaimScope {
  /** the whole answer section the sentence belongs to */
  section: string;
  /** every answer, as one text */
  answers: string;
  /** the sentence before this one in the same section ("Both touch only …") */
  previous?: string;
}
export interface ClaimContext {
  live: LiveState; git: GitRunner; portReader?: (port: number) => string | null;
  /** round 8 — epoch ms the answers were written; claims are judged at this moment */
  writtenAt?: number;
  exists?: (path: string) => boolean;
  /** round 9 — the sentence's section and the answers around it */
  scope?: ClaimScope;
  /** round 9 — a named file's text (a brief); a test seam over readFileSync */
  readText?: (path: string) => string | null;
}
export type Checker = (sentence: string, ctx: ClaimContext) => Claim[];

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Repositories a text names, by full path or by basename. */
export function reposNamedIn(text: string, repos: Array<{ path: string; notChecked?: string | null }>): string[] {
  return repos.filter((repo) => {
    if (repo.notChecked) return false;
    if (new RegExp(`${escapeRe(repo.path)}(?![\\w-])`).test(text)) return true;
    // `acme-api` names the repository; `.carafe` does not name the carafe
    // repository, and `acme-api-status` is a different folder. A plain
    // word ("carafe's snapshot store") names the product, not the checkout: a
    // bare name counts only between backticks, as a path's first segment, or
    // when it is a distinctive name (a hyphen, a dot, a digit).
    const name = escapeRe(basename(repo.path));
    if (new RegExp(`\`${name}(?:\`|/)`).test(text)) return true;
    if (!/[-_.\d]/.test(basename(repo.path))) return false;
    return new RegExp(`(?:^|[\\s\`"'(/])${name}(?![\\w-])`).test(text);
  }).map((repo) => repo.path);
}
/**
 * Round 9 — the repositories a sentence is about: the ones it names; failing
 * that, the ones its section names; failing that, the ones the answers name.
 * Empty when nothing names any — the caller decides what that means, and it
 * never silently means "whichever repository happens to have the file".
 */
export function scopeRepos(ctx: ClaimContext, sentence: string): string[] {
  const repos = ctx.live.repos;
  for (const text of [sentence, ctx.scope?.section, ctx.scope?.answers]) {
    if (!text) continue;
    const named = reposNamedIn(text, repos);
    if (named.length) return named;
  }
  return [];
}
export const hashPattern = "[a-f0-9]{7,40}";
/** PR #38: a UUID is not a commit, and neither is `run #4212` or a path segment. */
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const RAW_HASH_RE = /[0-9a-f]{7,40}/gi;
export function hashesIn(sentence: string): Array<{ value: string; index: number }> {
  const uuids = [...sentence.matchAll(UUID_RE)].map((m) => [m.index!, m.index! + m[0].length] as const);
  const out: Array<{ value: string; index: number }> = [];
  for (const m of sentence.matchAll(RAW_HASH_RE)) {
    const value = m[0], index = m.index!;
    if (!/[0-9]/.test(value) || !/[a-f]/i.test(value)) continue;
    if (uuids.some(([start, end]) => index >= start && index < end)) continue;
    const before = sentence[index - 1] ?? "", after = sentence[index + value.length] ?? "";
    if (/[0-9a-f-]/i.test(before) || /[0-9a-f-]/i.test(after)) continue;
    const left = sentence.slice(0, index).split(/\s/).at(-1) ?? "", right = sentence.slice(index + value.length).split(/\s/)[0] ?? "";
    if (`${left}${value}${right}`.includes("/")) continue;               // a path segment, not a commit
    if (/(?:\brun|\bissue)\s+#?$/i.test(sentence.slice(Math.max(0, index - 16), index)) || before === "#") continue;
    out.push({ value, index });
  }
  return out;
}
/**
 * PR #38: a bare English word is never a ref. A ref is either written between
 * backticks, or it is one the trace/live state knows AND is shaped like a ref.
 */
export function refAllowed(sentence: string, ref: string, ctx: ClaimContext): boolean {
  if (sentence.includes(`\`${ref}\``)) return true;
  if (!/[\/_-]|\d/.test(ref)) return false;
  const known = new Set<string>();
  for (const repo of ctx.live.repos) {
    for (const branch of repo.branches) known.add(branch);
    if (repo.upstream) known.add(repo.upstream);
    if (repo.defaultRef) known.add(repo.defaultRef.ref);
  }
  return known.has(ref) || isHash(ref);
}
/** PR #38: a claim inside a negated clause is not the claim the pattern read. */
const NEGATED_RE = /\b(?:not|neither|never|no longer|isn't|wasn't|aren't|weren't|doesn't|don't|didn't|can't|cannot|won't|n't)\b/i;
export function negatedAt(sentence: string, index: number): boolean {
  const clause = sentence.slice(0, index).split(/[,;:]/).at(-1) ?? "";
  return NEGATED_RE.test(clause);
}
export const token = "[A-Za-z0-9_./-]+";
/** A ref captured from prose keeps no sentence punctuation: `origin/main.` is `origin/main`. */
export const trimRef = (s: string): string => s.replace(/[.,;:!?)\]]+$/, "");
export const isHash = (s: string): boolean => new RegExp(`^${hashPattern}$`, "i").test(s);
/** Patterns are matched against the sentence WITHOUT its backticks; every span
 *  in a Claim is in these coordinates. */
export const plain = (s: string): string => s.replace(/`/g, "");
/** raw index → plain index: one character is lost per backtick before it. */
export const toPlainIndex = (raw: string, index: number): number => index - (raw.slice(0, index).match(/`/g)?.length ?? 0);
export const shell = (s: string): string => /^[A-Za-z0-9_./:@{}~-]+$/.test(s) ? s : `'${s.replace(/'/g, "'\\''")}'`;
export const command = (repo: string, args: string[]): string => `git -C ${shell(repo)} ${args.map(shell).join(" ")}`;
export function read(ctx: ClaimContext, repo: string, args: string[]): string | null { return ctx.git(["-C", repo, ...args], 5000); }

/**
 * One repository per OBJECT STORE. A session that works in eight linked
 * worktrees of the same repository names eight paths that answer "does this
 * commit exist" identically, and asking all of them costs eight processes for
 * one answer. The path a sentence writes out wins; otherwise the shortest.
 */
export function objectStores(ctx: ClaimContext, sentence: string): string[] {
  const groups = new Map<string, string[]>();
  for (const repo of ctx.live.repos) {
    if (repo.notChecked) continue;
    const common = ctx.git(["-C", repo.path, "rev-parse", "--git-common-dir"], 5000)?.trim() ?? repo.path;
    const key = common.startsWith("/") ? common : `${repo.path}/${common}`;
    groups.set(key, [...(groups.get(key) ?? []), repo.path]);
  }
  return [...groups.values()].map((paths) => paths.find((p) => sentence.includes(p)) ?? [...paths].sort((a, b) => a.length - b.length)[0]!);
}

/** Everything the sentence wrote between backticks — a ref, a path or a file. */
export function backticked(sentence: string): string[] {
  return [...sentence.matchAll(/`([^`]+)`/g)].map((m) => m[1]!);
}
/**
 * A claim's subject must be a token the sentence really names: a commit hash,
 * or something it put between backticks. Bare prose ("Two unpushed", "which")
 * is not a subject, and a checker that cannot name one has found no claim.
 */
export function isConcrete(sentence: string, ref: string): boolean {
  return isHash(ref) || backticked(sentence).includes(ref);
}

/**
 * The paths a sentence names. Inside backticks a path is taken WHOLE. Outside
 * them it runs to the end of the sentence and is shortened at whitespace only
 * until it exists on disk — the LONGEST reading wins, so a directory whose name
 * contains a space is never reported as the different repository that happens
 * to sit at its first word.
 */
const ABSOLUTE_PREFIX_RE = /^(?:\/Users\/|\/private\/|\/tmp\/|\/var\/|\/opt\/|\/etc\/|\/home\/|\/workspace\/)/;
export function pathsIn(sentence: string, exists: (p: string) => boolean = existsSync): Array<{ path: string; span: [number, number] }> {
  const out: Array<{ path: string; span: [number, number] }> = [];
  const masked = sentence.replace(/`[^`]*`/g, (m) => " ".repeat(m.length));
  for (const m of sentence.matchAll(/`([^`]+)`/g)) {
    const value = m[1]!;
    // PR #38: `/v1`, `/api/v2/jobs/abc/cancel`, `POST /x` are routes. A path is a
    // path when the disk has it, or when it is written under a real root.
    if (!value.startsWith("/") || !(exists(value) || ABSOLUTE_PREFIX_RE.test(value))) continue;
    out.push({ path: value, span: [toPlainIndex(sentence, m.index! + 1), toPlainIndex(sentence, m.index! + 1 + value.length)] });
  }
  for (const m of masked.matchAll(/(^|\s)(\/\S+)/g)) {
    const start = m.index! + m[1]!.length;
    const rest = masked.slice(start);
    // longest first: the whole remainder, then back one whitespace-run at a time
    const ends = [rest.length, ...[...rest.matchAll(/\s+/g)].map((w) => w.index!).reverse()];
    for (const end of ends) {
      const candidate = rest.slice(0, end).replace(/[.,;:!?)\]]+$/, "");
      if (!candidate.startsWith("/") || !exists(candidate)) continue;
      out.push({ path: candidate, span: [toPlainIndex(sentence, start), toPlainIndex(sentence, start + candidate.length)] });
      break;
    }
  }
  return out;
}

/**
 * The repositories a claim can be about. A hash or a backticked ref in the SAME
 * sentence names one; failing that, a repository the sentence writes out in
 * full; failing that, every repository that was checked.
 */
export function owners(ctx: ClaimContext, s: string, ref?: string): string[] {
  const named = ctx.live.repos.filter((r) => s.includes(r.path));
  let pool = named.length ? named : ctx.live.repos.filter((r) => !r.notChecked);
  if (!named.length && ref && !isHash(ref)) {
    // resolve through the hashes the sentence carries: they belong to ONE repo
    const hashes = [...new Set(plain(s).match(new RegExp(`\\b${hashPattern}\\b`, "gi")) ?? [])];
    const stores = new Set(objectStores(ctx, s));
    const byHash = pool.filter((r) => stores.has(r.path) && hashes.some((h) => read(ctx, r.path, ["cat-file", "-e", `${h}^{commit}`]) != null));
    if (byHash.length === 1) pool = byHash;
  }
  return pool.map((r) => r.path).filter((r) => !ref || read(ctx, r, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]) != null);
}
/**
 * "?" belongs to real ambiguity ONLY: several checked repositories answer to the
 * same name, and the file says which. A subject no checked repository holds at
 * all is not a claim — carafe has nothing to say about it, and saying "?" about
 * a sentence fragment is noise in a coverage number.
 */
export function unresolved(label: string, repos: string[], span?: [number, number]): Claim[] {
  if (repos.length < 2) return [];
  return [{ label, stamp: "?", checkable: true, span, value: `named in ${repos.length} checked repositories: ${repos.join(", ")}` }];
}
/**
 * When several checked repositories hold the subject — a clone and its fork
 * both carry the commit — ask each of them. Agreement IS the answer; only a
 * disagreement is genuinely unresolved, and then the file names them.
 */
export function acrossRepos(repos: string[], label: string, make: (repo: string) => Claim, span?: [number, number]): Claim[] {
  if (!repos.length) return [];
  const claims = repos.map(make);
  const stamps = new Set(claims.map((c) => c.stamp));
  if (stamps.size === 1 && claims[0]!.stamp !== "?") {
    const one = claims[0]!;
    return [{ ...one, span, label: repos.length > 1 ? `${one.label} (same in ${repos.length} checked repositories)` : one.label }];
  }
  return unresolved(label, repos, span);
}

export function result(label: string, repo: string, args: string[], value: string | null, agrees: boolean): Claim {
  return { label, stamp: value == null ? "?" : agrees ? "✓" : "✗", command: command(repo, args), value: value?.trim().split(/\s*\n\s*/).join("; ") || (value === "" ? "(empty)" : "unavailable"), checkable: true };
}
