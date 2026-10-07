import { basename, dirname } from "path";
import type { CarafeEvent } from "../format/events";
import { firstLineOf, filesOf, type EventPieces } from "./pieces";

export interface TurnBlock {
  startSeq: number;
  endSeq: number;
  firstLine: string;
  toolCalls: number;
  /** basenames — the drift/jaccard signal the chapter segmenter reads */
  files: Set<string>;
  /** the same files, whole, for rendering: `render.ts` and `handoff.ts` are the
   *  only places a reader must be able to tell two same-named files apart */
  paths: Set<string>;
  chars: number;
}

/**
 * Display names for a list of paths: a basename when it is unique in the list,
 * `<parent>/<name>` when it is not. "two edits to render.ts" is a lie when one
 * of them was `ui/render.ts`.
 */
export function displayFileNames(paths: string[]): string[] {
  const counts = new Map<string, number>();
  for (const path of paths) {
    const name = basename(path);
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return paths.map((path) => {
    const name = basename(path);
    if ((counts.get(name) ?? 0) <= 1) return name;
    const parent = basename(dirname(path));
    return parent && parent !== "." && parent !== "/" ? `${parent}/${name}` : name;
  });
}

/** Shared user-turn partition used by search, chapters, and handoff maps. */
export function buildBlocks(events: CarafeEvent[], pieces: EventPieces[]): TurnBlock[] {
  const pieceBySeq = new Map(pieces.map((piece) => [piece.seq, piece]));
  const blocks: TurnBlock[] = [];
  let cur: TurnBlock | null = null;
  for (const ev of events) {
    const p = pieceBySeq.get(ev.seq) ?? { seq: ev.seq, kind: ev.kind, lines: [], chars: 0, ts: ev.ts ?? null };
    const isUserTurn = ev.kind === "user" && p.lines.some((line) => line.startsWith("**user:**"));
    if (isUserTurn || !cur) {
      if (cur) cur.endSeq = ev.seq - 1;
      cur = {
        startSeq: ev.seq,
        endSeq: ev.seq,
        firstLine: isUserTurn ? firstLineOf(p) : "(session start)",
        toolCalls: 0,
        files: new Set<string>(),
        paths: new Set<string>(),
        chars: 0,
      };
      blocks.push(cur);
    }
    cur.chars += p.chars;
    if (ev.kind === "tool_use" || p.lines.some((line) => line.startsWith("→"))) cur.toolCalls++;
    for (const file of filesOf(ev)) { cur.files.add(basename(file)); cur.paths.add(file); }
  }
  if (cur) cur.endSeq = events.at(-1)?.seq ?? cur.startSeq;
  return blocks;
}

export function formatWeight(chars: number): string {
  if (chars >= 1_000_000) return `${(chars / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (chars >= 1_000) return `${Math.round(chars / 1_000)}K`;
  return String(chars);
}

export function renderTurnLine(block: TurnBlock): string {
  const files = displayFileNames([...block.paths].slice(0, 3)).join(", ");
  return `- [seq ${block.startSeq}–${block.endSeq}] ${block.firstLine}${block.toolCalls ? ` · ${block.toolCalls} tools` : ""}${files ? ` · ${files}` : ""} · ${formatWeight(block.chars)}`;
}
