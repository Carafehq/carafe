/**
 * Round 8 — a claim is judged at the moment it was WRITTEN.
 *
 * All three ✗ stamps in round 8 were on claims that held when the outgoing
 * agent wrote them and changed afterwards. A ✗ reads as "the agent was
 * wrong", so it is now allowed only when git proves the opposite AT that
 * moment. Where git keeps history (a ref's reflog, a working tree's HEAD
 * reflog) the claim is evaluated then; where it keeps none (uncommitted
 * changes, a listening port, a file on disk) a claim that no longer holds is
 * "cannot tell", never ✗.
 */
import { branchAt, movesAfter, reflogArgs, reflogOf, utcStamp, valueAt } from "../history";
import { type Claim, type ClaimContext, type TimeSpec, type WhenWritten, command, isHash, read } from "./types";

const short = (hash: string): string => hash.slice(0, 7);
/** Beyond this many remote-tracking refs, reading every reflog back to T is not worth a stamp. */
export const REMOTE_REFS_MAX = 60;
/** A reading with no history stands for the moment of writing only this soon after it. */
export const NO_HISTORY_GRACE_MS = 60 * 60 * 1000;

/** Every remote-tracking ref this repository has, or null when the listing failed. */
function remoteTrackingRefs(ctx: ClaimContext, repo: string): string[] | null {
  const out = read(ctx, repo, ["for-each-ref", "--format=%(refname)", "refs/remotes"]);
  if (out == null) return null;
  return out.split("\n").map((line) => line.trim()).filter((line) => line && !line.endsWith("/HEAD"));
}

/** A ref's value at `at`: a commit (hash), known absence (null), or unknown (undefined). */
export function refAt(ctx: ClaimContext, repo: string, ref: string, at: number): { hash: string | null; item: string | null } | undefined {
  if (isHash(ref)) return { hash: ref, item: null };
  const args = reflogArgs(ref);
  const found = valueAt(reflogOf(ctx.git, repo, ref), at);
  if (found.state === "unknown") return undefined;
  if (found.state === "absent") return { hash: null, item: `${ref} did not exist [${command(repo, args)}]` };
  return { hash: found.hash, item: `${ref} was ${short(found.hash)} [${command(repo, args)}]` };
}

const when = (at: number, verdict: WhenWritten["verdict"], changed: boolean, evidence: Array<string | null | undefined>): WhenWritten =>
  ({ at, verdict, changed, evidence: evidence.filter((e): e is string => !!e) });

/** The same claim, judged at the moment it was written. */
export function timeAware(claim: Claim, ctx: ClaimContext): Claim {
  const at = ctx.writtenAt;
  const spec = claim.time;
  if (at == null || !Number.isFinite(at) || !spec || !claim.checkable || (claim.stamp !== "✓" && claim.stamp !== "✗")) return claim;
  const holdsNow = claim.stamp === "✓";
  const judged = judge(spec, holdsNow, ctx, at);
  if (!judged) return claim;
  return { ...claim, stamp: judged.stamp, when: judged.when };
}

type Judged = { stamp: Claim["stamp"]; when?: WhenWritten } | null;
const cannotTell = (at: number, evidence: Array<string | null | undefined>): Judged => ({ stamp: "?", when: when(at, "cannot tell", false, evidence) });
/** held then: ✓, with "changed since" when it no longer holds. */
const held = (at: number, holdsNow: boolean, evidence: Array<string | null | undefined>): Judged =>
  holdsNow ? { stamp: "✓" } : { stamp: "✓", when: when(at, "held", true, evidence) };
const falseThen = (at: number, evidence: Array<string | null | undefined>): Judged => ({ stamp: "✗", when: when(at, "false", false, evidence) });

function judge(spec: TimeSpec, holdsNow: boolean, ctx: ClaimContext, at: number): Judged {
  switch (spec.kind) {
    case "head": {
      const then = refAt(ctx, spec.repo, spec.ref, at);
      if (!then) return holdsNow ? null : cannotTell(at, [`no reflog of ${spec.ref} reaches back to then`]);
      const ok = then.hash != null && then.hash.toLowerCase().startsWith(spec.hash.toLowerCase());
      return ok ? held(at, holdsNow, [then.item]) : falseThen(at, [then.item]);
    }
    case "ahead":
    case "ancestor": {
      if (isHash(spec.ref) && isHash(spec.target)) return null; // two commits: nothing moved
      const a = refAt(ctx, spec.repo, spec.ref, at), b = refAt(ctx, spec.repo, spec.target, at);
      if (!a || !b) return holdsNow ? null : cannotTell(at, [`no reflog of ${!a ? spec.ref : spec.target} reaches back to then`]);
      if (a.hash == null || b.hash == null) return falseThen(at, [a.item, b.item]);
      const args = spec.kind === "ahead" ? ["rev-list", "--count", `${b.hash}..${a.hash}`] : ["merge-base", "--is-ancestor", a.hash, b.hash];
      const out = read(ctx, spec.repo, args);
      if (spec.kind === "ahead" && out == null) return holdsNow ? null : cannotTell(at, [a.item, b.item]);
      const value = spec.kind === "ahead" ? out!.trim() : out == null ? "no" : "yes";
      const ok = spec.kind === "ahead" ? value === String(spec.count) : value === "yes";
      const evidence = [a.item, b.item, `[${command(spec.repo, args)}] → ${value}`];
      return ok ? held(at, holdsNow, evidence) : falseThen(at, evidence);
    }
    case "behind": {
      const a = refAt(ctx, spec.repo, spec.ref, at), b = refAt(ctx, spec.repo, spec.target, at);
      if (!a || !b) return holdsNow ? null : cannotTell(at, [`no reflog of ${!a ? spec.ref : spec.target} reaches back to then`]);
      if (a.hash == null || b.hash == null) return falseThen(at, [a.item, b.item]);
      const args = ["rev-list", "--count", `${a.hash}..${b.hash}`];
      const out = read(ctx, spec.repo, args);
      if (out == null) return holdsNow ? null : cannotTell(at, [a.item, b.item]);
      const value = out.trim();
      const evidence = [a.item, b.item, `[${command(spec.repo, args)}] → ${value}`];
      return value === String(spec.count) ? held(at, holdsNow, evidence) : falseThen(at, evidence);
    }
    case "clean": {
      // git keeps no record of a working tree's uncommitted state: never ✗.
      // When HEAD has not moved since, the tree reading now stands for then
      // (✓ when it agrees); once HEAD moved, what it was then is unknowable
      // either way — a tree that is clean now may have been dirty then.
      const entries = reflogOf(ctx.git, spec.repo, "HEAD");
      const moves = movesAfter(entries, at);
      if (holdsNow && !moves.length) return null;
      const cmd = command(spec.repo, reflogArgs("HEAD"));
      const then = valueAt(entries, at);
      const moved = moves.length && then.state === "value"
        ? `HEAD moved ${short(then.hash)} → ${short(moves.at(-1)!.hash)} (${utcStamp(moves.at(-1)!.at)}) [${cmd}]`
        : moves.length ? `HEAD moved to ${short(moves.at(-1)!.hash)} (${utcStamp(moves.at(-1)!.at)}) [${cmd}]`
        : `HEAD has not moved since then [${cmd}]`;
      return cannotTell(at, [moved, `now ${spec.now}`]);
    }
    case "local":
    case "on-remote": {
      // "X is local only" / "X is on origin": what did this disk's remote-tracking
      // refs hold at T? Each one's reflog says. When every reflog reaches back
      // to T, the answer is proven either way; when one does not, it is not.
      const subjects = spec.kind === "local" ? spec.hashes : [spec.ref];
      const expectsRemote = spec.kind === "on-remote";
      const remoteRefs = remoteTrackingRefs(ctx, spec.repo);
      if (remoteRefs == null) return holdsNow ? null : cannotTell(at, ["the remote-tracking refs could not be listed"]);
      if (remoteRefs.length > REMOTE_REFS_MAX) return holdsNow ? null : cannotTell(at, [`${remoteRefs.length} remote-tracking refs: too many reflogs to read back to then`]);
      const items: string[] = [];
      let unknown = false;
      let onRemoteThen = false;
      for (const subject of subjects) {
        const then = refAt(ctx, spec.repo, isHash(subject) ? subject : `refs/heads/${subject}`, at);
        if (!then) { unknown = true; continue; }
        if (then.hash == null) { items.push(then.item!); continue; }
        if (then.item) items.push(then.item);
        for (const ref of remoteRefs) {
          const remoteThen = refAt(ctx, spec.repo, ref, at);
          if (!remoteThen) { unknown = true; continue; }
          if (remoteThen.hash == null) continue;
          const args = ["merge-base", "--is-ancestor", then.hash, remoteThen.hash];
          if (read(ctx, spec.repo, args) != null) { onRemoteThen = true; items.push(`${ref.replace(/^refs\/remotes\//, "")} was ${short(remoteThen.hash)} and held it [${command(spec.repo, args)}]`); break; }
        }
        if (onRemoteThen) break;
      }
      if (onRemoteThen) return expectsRemote ? held(at, holdsNow, items) : falseThen(at, items);
      if (unknown) return holdsNow ? null : cannotTell(at, [...items, "a remote-tracking ref keeps no reflog reaching back to then"]);
      const proof = `no remote-tracking ref held it then [${command(spec.repo, ["for-each-ref", "--format=%(refname)", "refs/remotes"])}, then each ref's reflog]`;
      return expectsRemote ? falseThen(at, [...items, proof]) : held(at, holdsNow, [...items, proof]);
    }
    case "branch": {
      const current = read(ctx, spec.repo, ["branch", "--show-current"])?.trim() || null;
      const then = branchAt(reflogOf(ctx.git, spec.repo, "HEAD"), at, current);
      const cmd = command(spec.repo, reflogArgs("HEAD"));
      if (then.state === "unknown") return holdsNow ? null : cannotTell(at, [`HEAD's reflog does not say which branch was checked out then [${cmd}]`]);
      const item = `branch was ${then.branch ?? "(detached)"} [${cmd}]`;
      return then.branch === spec.branch ? held(at, holdsNow, [item]) : falseThen(at, [item]);
    }
    case "row": {
      if (holdsNow) return null;
      const then = refAt(ctx, spec.repo, spec.ref, at);
      if (!then || then.hash == null) return cannotTell(at, [then?.item ?? `no reflog of ${spec.ref} reaches back to then`]);
      const args = ["show", `${then.hash}:${spec.file}`];
      const rows = read(ctx, spec.repo, args)?.split("\n").filter((l) => new RegExp(`\\|\\s*${spec.row}\\s*\\|`).test(l)) ?? [];
      if (!rows.length) return cannotTell(at, [then.item]);
      const ok = rows.every((l) => new RegExp(`\\b${spec.hash}\\b`).test(l));
      const evidence = [then.item, `[${command(spec.repo, args)}] → ${rows.join("; ")}`];
      return ok ? held(at, false, evidence) : falseThen(at, evidence);
    }
    case "path":
      return holdsNow ? null : cannotTell(at, ["the disk keeps no record of what existed then"]);
    case "no-history": {
      // round 9 — "nothing is listening on port 8788" checked three days later
      // says nothing about then: a reading taken long after the writing is
      // not a check of it, whichever way it came out
      const checked = Date.parse(ctx.live.checkedAt);
      if (holdsNow && (!Number.isFinite(checked) || checked - at <= NO_HISTORY_GRACE_MS)) return null;
      return cannotTell(at, [`no history of ${spec.what} is kept${holdsNow ? "; it holds now" : ""}`]);
    }
  }
}

/** The line printed under a stamp that carries a judgment at the time of writing. */
export function whenLine(w: WhenWritten): string {
  const verdict = w.verdict === "held" ? `held${w.changed ? ", changed since" : ""}` : w.verdict;
  const iso = new Date(w.at).toISOString();
  return `when written (${iso.slice(0, 10)} ${iso.slice(11, 19)} UTC): ${[verdict, ...w.evidence].join(" · ")}`;
}
