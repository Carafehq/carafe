/**
 * Round 9 — numbers the answers reserve, re-checked after they were written.
 *
 * "Rows 40–42 are already proposed in `abc1234`" was true when the outgoing
 * agent wrote it. Two days later origin/main's changelog ran ten rows further
 * and rows 40–42 belonged to other work — the same collision trap the answers warn
 * about, and nothing said so. A reserved row range is read back from the table
 * file on origin's default branch, now and as it stood when the answers were
 * written (from that ref's reflog); a row that is taken now and was not then is
 * a new collision.
 */
import { reflogOf, valueAt } from "./history";
import type { GitRunner, LiveState } from "./live";
import { hashesIn, plain } from "./claims/types";
import { tableFileIn, withoutRepoFolder } from "./claims/row";
import type { ClaimContext, ClaimScope } from "./claims/types";

export interface Reservation { from: number; to: number; hash: string; stated: boolean }

const RANGE = String.raw`(\d+)(?:\s*[–-]\s*(\d+))?`;
/** "rows 40–42 are already proposed in `abc1234`" */
const STATED_RE = new RegExp(String.raw`\brows?\s+${RANGE}\s+(?:are|is)\s+(?:already\s+)?(?:proposed|reserved|planned|claimed)\s+(?:in|by)\s+([0-9a-f]{7,40})\b`, "i");
/** "`abc1234` (a note, …, proposed changelog rows 40–42)" */
const ASIDE_RE = new RegExp(String.raw`\b([0-9a-f]{7,40})\s*\([^)]*?\bproposed\s+(?:changelog\s+)?rows?\s+${RANGE}`, "i");

export function reservationsIn(sentence: string): Reservation[] {
  const s = plain(sentence);
  const out: Reservation[] = [];
  const stated = STATED_RE.exec(s);
  if (stated) out.push({ from: Number(stated[1]), to: Number(stated[2] ?? stated[1]), hash: stated[3]!.toLowerCase(), stated: true });
  const aside = ASIDE_RE.exec(s);
  if (aside) out.push({ from: Number(aside[2]), to: Number(aside[3] ?? aside[2]), hash: aside[1]!.toLowerCase(), stated: false });
  return out.filter((one) => one.to >= one.from && one.to - one.from < 50);
}

/** The first commit a table row cites, or null. */
export function rowCites(table: string | null, row: number): string | null | undefined {
  if (table == null) return undefined;
  const line = table.split("\n").find((one) => new RegExp(`^\\s*\\|\\s*${row}\\s*\\|`).test(one));
  if (!line) return null;
  return hashesIn(line)[0]?.value ?? "";
}

export interface CollisionOpts { live: LiveState; git: GitRunner; writtenAt: number; scope: ClaimScope }

/** The `↳ since written: …` lines for one sentence, or none. */
export function collisionNotes(sentence: string, opts: CollisionOpts): string[] {
  const reservations = reservationsIn(sentence);
  if (!reservations.length) return [];
  const ctx: ClaimContext = { live: opts.live, git: opts.git, scope: opts.scope };
  const named = tableFileIn(ctx);
  if (!named) return [];
  const file = withoutRepoFolder(named, ctx);
  const out: string[] = [];
  for (const one of reservations) {
    for (const repo of opts.live.repos) {
      if (repo.notChecked || !repo.defaultRef) continue;
      if (opts.git(["-C", repo.path, "cat-file", "-e", `${one.hash}^{commit}`], 5000) == null) continue;
      const ref = repo.defaultRef.ref;
      const then = valueAt(reflogOf(opts.git, repo.path, `refs/remotes/${ref}`), opts.writtenAt);
      if (then.state !== "value") continue;
      const nowTable = opts.git(["-C", repo.path, "show", `${ref}:${file}`], 5000);
      const thenTable = opts.git(["-C", repo.path, "show", `${then.hash}:${file}`], 5000);
      if (nowTable == null) continue;
      const taken: Array<{ row: number; by: string }> = [];
      for (let row = one.from; row <= one.to; row++) {
        const now = rowCites(nowTable, row);
        const before = rowCites(thenTable, row);
        if (!now || one.hash.startsWith(now) || now.startsWith(one.hash)) continue;
        if (before && before === now) continue;
        taken.push({ row, by: now });
      }
      if (!taken.length) break;
      const rows = taken.length === one.to - one.from + 1 && taken.length > 1
        ? `rows ${one.from}–${one.to}`
        : `${taken.length === 1 ? "row" : "rows"} ${taken.map((t) => t.row).join(", ")}`;
      out.push(`↳ since written: ${rows} proposed in ${one.hash} ${taken.length === 1 ? "is" : "are"} now taken on ${ref} by ${taken.map((t) => t.by).join(", ")} (${file} in ${repo.path})`);
      break;
    }
  }
  return out;
}
