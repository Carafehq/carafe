/**
 * Round 8 — what git remembers about a moment in the past.
 *
 * The outgoing agent's answers were written at a time T. Every ✗ carafe
 * stamped in round 8 was on a claim that was TRUE at T and changed afterwards:
 * the world moved, the agent was not wrong. Git keeps the past of a ref in its
 * reflog (a push and a fetch both write one entry), so a claim about a ref can
 * be evaluated at T. Git keeps no past for a working tree, so a claim about
 * one can not — and then carafe says so instead of guessing.
 *
 * Everything here is a read-only `git reflog show`; nothing fetches.
 */
import type { GitRunner } from "./live";

export interface ReflogEntry {
  /** the full object name the ref held from `at` on */
  hash: string;
  /** epoch milliseconds the entry was written */
  at: number;
  /** "update by push", "fetch: fast-forward", "checkout: moving from a to b", … */
  message: string;
}

/** The exact arguments, so the file can print the command it ran. */
export const reflogArgs = (ref: string): string[] => ["reflog", "show", "--date=unix", "--format=%H%x09%gd%x09%gs", ref];

/** Newest entry first, as git prints them. null when the command failed. */
export function reflogOf(git: GitRunner, repo: string, ref: string): ReflogEntry[] | null {
  const out = git(["-C", repo, ...reflogArgs(ref)], 5000);
  if (out == null) return null;
  return parseReflog(out);
}

export function parseReflog(out: string): ReflogEntry[] {
  const entries: ReflogEntry[] = [];
  for (const line of out.split("\n")) {
    const [hash, selector, ...rest] = line.split("\t");
    const at = /@\{(\d+)\}$/.exec(selector ?? "")?.[1];
    if (!hash || !/^[0-9a-f]{7,64}$/.test(hash) || !at) continue;
    entries.push({ hash, at: Number(at) * 1000, message: rest.join("\t").trim() });
  }
  return entries;
}

/** A reflog entry that CREATED the ref: before it, the ref did not exist. */
const CREATION_RE = /^(?:branch: Created from|clone: from|fetch\b.*storing head|update by push$)/;

export type AtTime =
  | { state: "value"; hash: string; since: ReflogEntry }
  | { state: "absent" }
  | { state: "unknown"; why: string };

/**
 * The value a ref held at `atMs`, from its reflog. "unknown" is the honest
 * answer when the reflog does not reach back that far.
 */
export function valueAt(entries: ReflogEntry[] | null, atMs: number): AtTime {
  if (entries == null) return { state: "unknown", why: "no reflog could be read" };
  if (!entries.length) return { state: "unknown", why: "the ref has no reflog" };
  const held = entries.find((entry) => entry.at <= atMs);
  if (held) return { state: "value", hash: held.hash, since: held };
  const oldest = entries.at(-1)!;
  // the ref's first ever entry is after T and it is the entry that made it
  if (CREATION_RE.test(oldest.message)) return { state: "absent" };
  return { state: "unknown", why: "the reflog starts after that time" };
}

/** The entries written after `atMs`, oldest first. */
export function movesAfter(entries: ReflogEntry[] | null, atMs: number): ReflogEntry[] {
  return (entries ?? []).filter((entry) => entry.at > atMs).reverse();
}

/** "2026-09-22 11:08 UTC" */
export const utcStamp = (ms: number): string => {
  const iso = new Date(ms).toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
};

/** How a reflog entry moved the ref, in a word or two a reader can act on. */
export function howMoved(message: string): string {
  if (/^update by push/.test(message)) return "push";
  if (/^fetch\b/.test(message)) return "fetch";
  if (/^pull\b/.test(message)) return "pull";
  if (/^clone\b/.test(message)) return "clone";
  if (/^commit\b/.test(message)) return "commit";
  if (/^merge\b/.test(message)) return "merge";
  if (/^reset\b/.test(message)) return "reset";
  if (/^rebase\b/.test(message)) return "rebase";
  if (/^checkout\b/.test(message)) return "checkout";
  if (/^branch\b/.test(message)) return "branch";
  return message.split(":")[0]!.trim().slice(0, 24) || "update";
}

/**
 * The branch a working tree had checked out at `atMs`, from its HEAD reflog.
 * With no HEAD movement since T, it is the branch now. Otherwise the first
 * `checkout: moving from A to B` after T names A.
 */
export function branchAt(entries: ReflogEntry[] | null, atMs: number, current: string | null): { state: "value"; branch: string | null } | { state: "unknown" } {
  if (entries == null) return { state: "unknown" };
  const after = movesAfter(entries, atMs);
  if (!after.length) return entries.length ? { state: "value", branch: current } : { state: "unknown" };
  // a commit, amend, reset or merge moves HEAD without changing the branch;
  // anything else before the first checkout (a rebase) leaves it unknown
  const keeps = (entry: ReflogEntry): boolean => /^(?:commit|reset|merge|pull|cherry-pick)\b/.test(entry.message);
  for (const entry of after) {
    const checkout = /^checkout: moving from (\S+) to (\S+)$/.exec(entry.message);
    if (checkout) return { state: "value", branch: /^[0-9a-f]{7,40}$/.test(checkout[1]!) ? null : checkout[1]! };
    if (!keeps(entry)) return { state: "unknown" };
  }
  return { state: "value", branch: current };
}
