import { closeSync, openSync, readSync } from "fs";
import { basename, resolve } from "path";
import type { GitRunner } from "./live";
import { movesAfter, reflogOf, utcStamp, valueAt } from "./history";
import { parseWorktrees } from "./since";

export interface RefChange { repo: string; kind: "branch" | "worktree" | "commit"; name: string; hash: string; at: number; action: "new" | "moved" | "activity" }
/** The zero old-object id in the first HEAD log entry proves creation. A
 * truncated reflog starts with a nonzero id and is deliberately inconclusive. */
function headCreatedAt(repo: string, git: GitRunner): number | null {
  const path = git(["-C", repo, "rev-parse", "--git-path", "logs/HEAD"], 5000)?.trim();
  if (!path) return null;
  let fd: number | undefined;
  try {
    fd = openSync(resolve(repo, path), "r");
    const buffer = Buffer.alloc(4096);
    const line = buffer.subarray(0, readSync(fd, buffer, 0, buffer.length, 0)).toString().split("\n")[0]!;
    const m = /^0{40,64} [a-f0-9]{40,64} .* (\d+) [+-]\d{4}(?:\t|$)/.exec(line);
    return m ? Number(m[1]) * 1000 : null;
  } catch { return null; } finally { if (fd != null) closeSync(fd); }
}
/** All surviving local refs, not just names repeated in the outgoing prose. */
export function refChanges(repo: string, at: number, git: GitRunner): RefChange[] {
  const run = (args: string[]) => git(["-C", repo, ...args], 5000);
  const out: RefChange[] = [];
  const branches = (run(["for-each-ref", "--format=%(refname:short)", "refs/heads"]) ?? "").split("\n").filter(Boolean);
  for (const name of branches) {
    const entries = reflogOf(git, repo, `refs/heads/${name}`);
    const after = movesAfter(entries, at);
    const last = after.at(-1);
    if (!last) continue;
    const then = valueAt(entries, at);
    out.push({ repo, kind: "branch", name, hash: last.hash, at: last.at, action: then.state === "absent" ? "new" : "moved" });
  }
  for (const wt of parseWorktrees(run(["worktree", "list", "--porcelain"]) ?? "")) {
    const entries = reflogOf(git, wt.path, "HEAD");
    const last = movesAfter(entries, at).at(-1);
    if (!last) continue;
    const then = valueAt(entries, at);
    const created = headCreatedAt(wt.path, git);
    // HEAD's initial empty entry is not proof of creation (logs can expire).
    out.push({ repo, kind: "worktree", name: wt.path, hash: last.hash, at: last.at, action: created != null && created > at ? "new" : then.state === "value" ? "moved" : "activity" });
  }
  // Commit dates are explicitly labelled; reflogs above establish ref creation,
  // including a new branch at a years-old commit. Include detached HEAD commits.
  const commits = run(["log", "--all", "--reflog", `--since-as-filter=${new Date(at).toISOString()}`, "--format=%H%x09%ct%x09%s"]);
  for (const line of (commits ?? "").split("\n")) {
    const [hash, seconds, ...subject] = line.split("\t");
    const time = Number(seconds) * 1000;
    if (!hash || !/^[a-f0-9]{40,64}$/.test(hash) || !(time > at)) continue;
    if (!out.some((one) => one.kind === "commit" && one.hash === hash)) out.push({ repo, kind: "commit", name: subject.join("\t"), hash, at: time, action: "new" });
  }
  return out.sort((a, b) => b.at - a.at || a.name.localeCompare(b.name));
}

export function refChangeLines(changes: RefChange[], at: number): string[] {
  const groups = new Map<string, RefChange[]>();
  for (const change of changes) {
    const key = `${change.repo}:${change.kind}:${change.action}`;
    groups.set(key, [...(groups.get(key) ?? []), change]);
  }
  return [...groups.values()].sort((a, b) => b[0]!.at - a[0]!.at).map((group) => {
    const first = group[0]!;
    const label = first.kind === "branch" ? `${first.action} local branches` : first.kind === "commit" ? "commits dated" : `${first.action} worktrees`;
    const names = group.map((c) => c.kind === "commit" ? `${c.hash.slice(0, 7)} ${c.name}` : `${c.name} (${c.hash.slice(0, 7)})`);
    return `${basename(first.repo)}: ${group.length} ${label} since ${utcStamp(at)} — ${names.join(", ")} (newest ${utcStamp(first.at)})`;
  });
}
const STOP = new Set(["branch", "claude", "codex", "main", "master", "work", "none", "still", "open", "fixed", "four", "this", "that", "with", "from", "have", "been", "backend", "frontend", "helper", "review", "worktree", "project"]);
/** A name match warns of possible overlap; it never asserts that a fix landed. */
export function overtakenNotes(sentence: string, changes: RefChange[], writtenAt?: number): string[] {
  if (!/\b(?:none|not|open|outstanding|blocked|parked|pending|unfixed|needs?|next|first|review|todo|half.done)\b/i.test(sentence)) return [];
  const words = new Set(sentence.toLowerCase().match(/[a-z][a-z0-9]+/g) ?? []);
  const security = /\b(?:criticals?|security)\b/i.test(sentence);
  const matched = changes.filter((c) => c.kind === "branch" && c.at > (writtenAt ?? -Infinity) && (
    c.name.toLowerCase().split(/[^a-z0-9]+/).some((w) => w.length >= 4 && !STOP.has(w) && words.has(w))
    || (security && /(?:^|[/_-])sec(?:urity)?[-_/](?:c\d|critical)/i.test(c.name))
  ));
  const groups = new Map<string, RefChange[]>();
  for (const c of matched) groups.set(c.repo, [...(groups.get(c.repo) ?? []), c]);
  return [...groups].map(([repo, rows]) => `? possibly overtaken: ${rows.length} new or moved branches in ${basename(repo)} match this claim — ${rows.map((c) => c.name).join(", ")}; branch names suggest work in progress, not a verified fix`);
}
