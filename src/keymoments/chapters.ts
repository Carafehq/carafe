import { basename } from "path";
import type { CarafeEvent } from "../format/events";
import { buildBlocks, type TurnBlock } from "../handoff/blocks";
import { filesOf, type EventPieces } from "../handoff/pieces";
import { displayFileNames } from "../handoff/blocks";
import { extractMoments } from "./detect";
import { commandOf, type KeyMoment } from "./extract";
import { toolRuns, type ToolRun } from "./signals";
import { CcCallLedger, ccCallOf, CodexUsageMeter, codexTotalsOf, newTokens } from "../query/usage";
import { cleanSentence, firstQuotableSentence } from "./sentences";

export type ChapterBoundary = "start" | "gap" | "branch" | "cwd" | "drift" | "merge";

export interface Chapter {
  index: number;
  startSeq: number;
  endSeq: number;
  startTs: string | null;
  endTs: string | null;
  turns: number;
  toolCalls: number;
  chars: number;
  branch: string | null;
  cwd: string | null;
  /** `name` is the display name (disambiguated when two paths share a basename); `path` is the file itself */
  files: Array<{ name: string; count: number; path?: string }>;
  commits: number;
  failures: number;
  decisions: number;
  boundary: ChapterBoundary;
  strength: number;
  tokens?: number;
}

export interface ChapterOpts {
  gapHours?: number;
  softGapMinutes?: number;
  driftWindow?: number;
  driftJaccard?: number;
  /** Aliases matching the algorithm notation in the design brief. */
  W?: number;
  jaccard?: number;
  minBlocks?: number;
  minChapters?: number;
  maxChapters?: number;
  cwdPersistence?: number;
  shortSessionBlocks?: number;
  fallbackBlocks?: number;
}

interface BoundaryCandidate {
  position: number;
  strength: number;
  reason: Exclude<ChapterBoundary, "start" | "merge">;
  reasons: Set<Exclude<ChapterBoundary, "start" | "merge">>;
}

type ResolvedChapterOpts = Omit<Required<ChapterOpts>, "W" | "jaccard">;

const DEFAULTS: ResolvedChapterOpts = {
  gapHours: 4,
  softGapMinutes: 30,
  driftWindow: 6,
  driftJaccard: 0.15,
  minBlocks: 8,
  minChapters: 6,
  maxChapters: 40,
  cwdPersistence: 3,
  shortSessionBlocks: 30,
  fallbackBlocks: 50,
};

const REASON_ORDER: Record<BoundaryCandidate["reason"], number> = { branch: 0, gap: 1, cwd: 2, drift: 3 };

function validMs(ts: string | null | undefined): number | null {
  if (!ts) return null;
  const value = Date.parse(ts);
  return Number.isFinite(value) ? value : null;
}

function blockEvents(events: CarafeEvent[], blocks: TurnBlock[]): CarafeEvent[][] {
  const out = blocks.map(() => [] as CarafeEvent[]);
  let blockIndex = 0;
  for (const event of events) {
    while (blockIndex + 1 < blocks.length && event.seq >= blocks[blockIndex + 1]!.startSeq) blockIndex++;
    if (out[blockIndex]) out[blockIndex]!.push(event);
  }
  return out;
}

function firstRecordValue(events: CarafeEvent[], field: "cwd" | "branch"): string | null {
  for (const event of events) {
    const raw: any = event.raw;
    const value = field === "cwd"
      ? (typeof raw?.cwd === "string" ? raw.cwd : (raw?.type === "turn_context" || raw?.type === "session_meta") && typeof raw?.payload?.cwd === "string" ? raw.payload.cwd : null)
      : (typeof raw?.gitBranch === "string" ? raw.gitBranch : raw?.type === "session_meta" && typeof raw?.payload?.git?.branch === "string" ? raw.payload.git.branch : null);
    if (value) return value;
  }
  return null;
}

function branchSwitch(command: string): string | null {
  if (/\s--\s/.test(command)) return null;
  const match = /(?:^|[;&|]\s*|\n)\s*git\s+(?:checkout|switch)\s+(?:(?:-b|-c)\s+)?([^\s;&|]+)/i.exec(command);
  const name = match?.[1] ?? null;
  return name && !name.startsWith("-") ? name : null;
}

/** Commands per block from ONE pass over the pieces — a 20M-token session has
 *  thousands of blocks and hundreds of thousands of pieces, so per-block scans
 *  would be quadratic. Pieces and blocks are both seq-ordered. */
function commandsByBlock(blocks: TurnBlock[], pieces: EventPieces[]): string[][] {
  const out = blocks.map(() => [] as string[]);
  let blockIndex = 0;
  for (const piece of pieces) {
    while (blockIndex + 1 < blocks.length && piece.seq >= blocks[blockIndex + 1]!.startSeq) blockIndex++;
    if (piece.seq < blocks[blockIndex]!.startSeq || piece.seq > blocks[blockIndex]!.endSeq) continue;
    for (const line of piece.lines) {
      const command = commandOf(line);
      if (command != null) out[blockIndex]!.push(command);
    }
  }
  return out;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size && !b.size) return 1;
  let intersection = 0;
  for (const item of a) if (b.has(item)) intersection++;
  return intersection / (a.size + b.size - intersection);
}

function addSignal(
  candidates: Map<number, BoundaryCandidate>,
  position: number,
  reason: BoundaryCandidate["reason"],
  strength: number,
): void {
  if (position <= 0) return;
  const existing = candidates.get(position);
  if (!existing) {
    candidates.set(position, { position, strength, reason, reasons: new Set([reason]) });
    return;
  }
  existing.strength += strength;
  existing.reasons.add(reason);
  const currentSignal = reason === "branch" ? 3 : reason === "gap" || reason === "cwd" ? 2 : 1;
  const previousSignal = existing.reason === "branch" ? 3 : existing.reason === "gap" || existing.reason === "cwd" ? 2 : 1;
  if (currentSignal > previousSignal || (currentSignal === previousSignal && REASON_ORDER[reason] < REASON_ORDER[existing.reason])) existing.reason = reason;
}

function observedStates(
  grouped: CarafeEvent[][],
  blocks: TurnBlock[],
  pieces: EventPieces[],
): { cwd: Array<string | null>; branch: Array<string | null>; branchSwitches: Array<string | null> } {
  const cwd: Array<string | null> = [];
  const branch: Array<string | null> = [];
  const branchSwitches: Array<string | null> = [];
  const initialCwd = grouped.map((events) => firstRecordValue(events, "cwd")).find((value) => value != null) ?? null;
  const initialBranch = grouped.map((events) => firstRecordValue(events, "branch")).find((value) => value != null) ?? null;
  const commands = commandsByBlock(blocks, pieces);
  let currentCwd: string | null = initialCwd;
  let currentBranch: string | null = initialBranch;
  for (let index = 0; index < blocks.length; index++) {
    currentCwd = firstRecordValue(grouped[index]!, "cwd") ?? currentCwd;
    currentBranch = firstRecordValue(grouped[index]!, "branch") ?? currentBranch;
    cwd.push(currentCwd);
    branch.push(currentBranch);
    let switched: string | null = null;
    for (const command of commands[index]!) switched = branchSwitch(command) ?? switched;
    branchSwitches.push(switched);
    if (switched) currentBranch = switched;
  }
  // A command changes the state after its containing turn, so carry it into
  // the following block unless an explicit record says otherwise.
  currentBranch = initialBranch;
  for (let index = 0; index < blocks.length; index++) {
    const recorded = firstRecordValue(grouped[index]!, "branch");
    if (recorded && recorded !== initialBranch) currentBranch = recorded;
    branch[index] = currentBranch;
    const switched = branchSwitches[index];
    if (switched) currentBranch = switched;
  }
  return { cwd, branch, branchSwitches };
}

function selectBoundaries(candidates: BoundaryCandidate[], blockCount: number, opts: ResolvedChapterOpts): BoundaryCandidate[] {
  const accepted: BoundaryCandidate[] = [];
  const canFit = (position: number): boolean => {
    const positions = [0, ...accepted.map((candidate) => candidate.position).sort((a, b) => a - b), blockCount];
    let rightIndex = positions.findIndex((value) => value > position);
    if (rightIndex < 0) rightIndex = positions.length - 1;
    return position - positions[rightIndex - 1]! >= opts.minBlocks && positions[rightIndex]! - position >= opts.minBlocks;
  };
  for (const candidate of candidates.slice().sort((a, b) => b.strength - a.strength || a.position - b.position)) {
    if (accepted.length >= opts.maxChapters - 1) break;
    if (canFit(candidate.position)) accepted.push(candidate);
  }
  if (blockCount > 200 && accepted.length + 1 < opts.minChapters) {
    const fallbackPositions: number[] = [];
    for (let position = opts.fallbackBlocks; position < blockCount; position += opts.fallbackBlocks) fallbackPositions.push(position);
    fallbackPositions.sort((a, b) => {
      const center = blockCount / 2;
      return Math.abs(a - center) - Math.abs(b - center) || a - b;
    });
    for (const position of fallbackPositions) {
      if (accepted.length + 1 >= opts.minChapters || accepted.length >= opts.maxChapters - 1) break;
      if (canFit(position)) accepted.push({ position, strength: 0, reason: "drift", reasons: new Set(["drift"]) });
    }
  }
  return accepted.sort((a, b) => a.position - b.position);
}

export function segmentChapters(events: CarafeEvent[], pieces: EventPieces[], options: ChapterOpts = {}, suppliedMoments?: KeyMoment[], suppliedRuns?: ToolRun[]): Chapter[] {
  if (!events.length) return [];
  const opts: ResolvedChapterOpts = {
    ...DEFAULTS,
    ...options,
    driftWindow: options.driftWindow ?? options.W ?? DEFAULTS.driftWindow,
    driftJaccard: options.driftJaccard ?? options.jaccard ?? DEFAULTS.driftJaccard,
  };
  const blocks = buildBlocks(events, pieces);
  if (!blocks.length) return [];
  const grouped = blockEvents(events, blocks);
  const states = observedStates(grouped, blocks, pieces);
  const candidates = new Map<number, BoundaryCandidate>();

  if (blocks.length > opts.shortSessionBlocks) {
    for (let position = 1; position < blocks.length; position++) {
      const beforeTimes = grouped[position - 1]!.map((event) => validMs(event.ts)).filter((value): value is number => value != null);
      const afterTimes = grouped[position]!.map((event) => validMs(event.ts)).filter((value): value is number => value != null);
      const before = beforeTimes.at(-1);
      const after = afterTimes[0];
      if (before != null && after != null) {
        const gap = after - before;
        if (gap >= opts.gapHours * 60 * 60 * 1000) addSignal(candidates, position, "gap", 2);
        else if (gap >= opts.softGapMinutes * 60 * 1000) addSignal(candidates, position, "gap", 0.5);
      }

      if (states.branchSwitches[position - 1]) addSignal(candidates, position, "branch", 3);
      const previousRecordedBranch = firstRecordValue(grouped[position - 1]!, "branch");
      const nextRecordedBranch = firstRecordValue(grouped[position]!, "branch");
      if (previousRecordedBranch && nextRecordedBranch && previousRecordedBranch !== nextRecordedBranch) addSignal(candidates, position, "branch", 3);

      const previousCwd = states.cwd[position - 1];
      const nextCwd = states.cwd[position];
      if (previousCwd && nextCwd && previousCwd !== nextCwd) {
        const persists = Array.from({ length: opts.cwdPersistence }, (_, offset) => states.cwd[position + offset]).every((value) => value === nextCwd);
        let previousRun = 0;
        for (let index = position - 1; index >= 0 && states.cwd[index] === previousCwd; index--) previousRun++;
        if (persists && previousRun >= opts.cwdPersistence) addSignal(candidates, position, "cwd", 2);
      }

      const beforeFiles = new Set(blocks.slice(Math.max(0, position - opts.driftWindow), position).flatMap((block) => [...block.files]));
      const afterFiles = new Set(blocks.slice(position, position + opts.driftWindow).flatMap((block) => [...block.files]));
      if (beforeFiles.size && afterFiles.size && jaccard(beforeFiles, afterFiles) < opts.driftJaccard) addSignal(candidates, position, "drift", 1);
    }
  }

  const selected = blocks.length <= opts.shortSessionBlocks ? [] : selectBoundaries([...candidates.values()], blocks.length, opts);
  const starts = [0, ...selected.map((boundary) => boundary.position)];
  const extracted = suppliedMoments ? null : extractMoments({ events, pieces });
  const moments = suppliedMoments ?? extracted!.moments;
  const failedRuns = (suppliedRuns ?? extracted?.context.runs ?? toolRuns(events, pieces)).filter((run) => run.failed);
  const callTokens = newTokensBySeq(events);
  const chapters: Chapter[] = [];

  for (let chapterIndex = 0; chapterIndex < starts.length; chapterIndex++) {
    const startBlockIndex = starts[chapterIndex]!;
    const endBlockIndex = (starts[chapterIndex + 1] ?? blocks.length) - 1;
    const chapterBlocks = blocks.slice(startBlockIndex, endBlockIndex + 1);
    const startSeq = chapterBlocks[0]!.startSeq;
    const endSeq = chapterBlocks.at(-1)!.endSeq;
    const rangeEvents = events.filter((event) => event.seq >= startSeq && event.seq <= endSeq);
    const rangePieces = pieces.filter((piece) => piece.seq >= startSeq && piece.seq <= endSeq);
    const rangeMoments = moments.filter((moment) => moment.seq >= startSeq && moment.seq <= endSeq);
    const fileCounts = new Map<string, number>();
    for (const event of rangeEvents) for (const file of filesOf(event)) {
      fileCounts.set(file, (fileCounts.get(file) ?? 0) + 1);
    }
    const timestamps = rangeEvents.map((event) => event.ts).filter((ts): ts is string => ts != null && validMs(ts) != null);
    const boundary = chapterIndex === 0 ? null : selected[chapterIndex - 1]!;
    const chapter: Chapter = {
      index: chapterIndex + 1,
      startSeq,
      endSeq,
      startTs: timestamps[0] ?? null,
      endTs: timestamps.at(-1) ?? null,
      turns: chapterBlocks.length,
      toolCalls: chapterBlocks.reduce((sum, block) => sum + block.toolCalls, 0),
      chars: rangePieces.reduce((sum, piece) => sum + piece.chars, 0),
      branch: states.branch[startBlockIndex] ?? null,
      cwd: states.cwd[startBlockIndex] ?? null,
      files: (() => {
        const top = [...fileCounts.entries()].sort((a, b) => b[1] - a[1] || basename(a[0]).localeCompare(basename(b[0])) || a[0].localeCompare(b[0])).slice(0, 4);
        const names = displayFileNames(top.map(([path]) => path));
        return top.map(([path, count], index) => ({ name: names[index]!, count, path }));
      })(),
      commits: rangeMoments.filter((moment) => moment.kind === "artifact" && /\bgit\s+commit\b/.test(moment.text)).length,
      failures: failedRuns.filter((run) => run.toolSeq >= startSeq && run.toolSeq <= endSeq).length,
      decisions: rangeMoments.filter((moment) => moment.kind === "decision").length,
      boundary: boundary?.reason ?? "start",
      strength: boundary?.strength ?? 0,
    };
    if (rangeEvents.some((event) => event.tool === "claude-code" || event.tool === "codex")) {
      chapter.tokens = rangeEvents.reduce((sum, event) => sum + (callTokens.get(event.seq) ?? 0), 0);
    }
    chapters.push(chapter);
  }
  return chapters;
}

/** A chapter's token volume per event seq — a selection weight, never shown —
 *  with each model call counted once (query/usage.ts). Claude Code: the NEW
 *  tokens (input + output) of a message, on the seq of its first record, with
 *  its last record's usage. Codex: a reading's growth in total processed
 *  tokens (input incl. cached + output), on its own seq. */
function newTokensBySeq(events: CarafeEvent[]): Map<number, number> {
  const out = new Map<number, number>();
  const ledger = new CcCallLedger();
  const firstSeq: number[] = [];
  const meter = new CodexUsageMeter();
  for (const event of events) {
    if (event.tool === "claude-code") {
      const call = ccCallOf(event.raw);
      if (!call) continue;
      const { index, copy } = ledger.add(call);
      if (!copy) firstSeq[index] = event.seq;
    } else if (event.tool === "codex") {
      const totals = codexTotalsOf(event.raw);
      const delta = totals ? meter.next(totals) : null;
      if (delta) out.set(event.seq, (out.get(event.seq) ?? 0) + delta.in + delta.cacheR + delta.out);
    }
  }
  ledger.calls.forEach((call, index) => {
    const seq = firstSeq[index]!;
    out.set(seq, (out.get(seq) ?? 0) + newTokens(call.usage));
  });
  return out;
}

/** The session's chapters, moments and failure counts in one call — the shared
 *  entry point behind `carafe chapters` and the handoff's chapter headers, so
 *  the two can never disagree about how many things failed in a chapter. */
export function sessionChapters(events: CarafeEvent[], pieces: EventPieces[], options: ChapterOpts = {}): Chapter[] {
  const set = extractMoments({ events, pieces });
  return segmentChapters(events, pieces, options, set.moments, set.context.runs);
}

/* ------------------------------------------------------------------ *
 * W3 — a chapter title that says something.
 *
 * A chapter headed by the owner's first words ("Go", "Push", "Run it") tells a
 * reader nothing. The content is already in the chapter: the recap the
 * assistant wrote in it, the commit it produced, or a user line long enough to
 * carry a subject. Rendering only — `carafe chapters` keeps its own headline,
 * and nothing here touches selection, counts or the bench.
 * ------------------------------------------------------------------ */

export const CHAPTER_TITLE_CHARS = 90;
/** A word that steers the work without naming it. Defined once, beside the
 *  title rules that share it. */
import { BARE_COMMAND_RE } from "../adapters/types";
const MIN_TITLE_USER_CHARS = 24;
const COMMIT_MESSAGE_RE = /\bgit\b[^\n]*\bcommit\b[^\n]*?-m\s+(?:"([^"]+)"|'([^']+)')/;
const COMMIT_RESULT_RE = /^\[[\w./+-]+\s+(?:\(root-commit\)\s+)?[0-9a-f]{7,40}\]\s+(.+)$/;

/** A commit subject or a user line, cleaned the way a quoted sentence is —
 *  markers and emphasis off, trailers cut — but not required to be a sentence. */
function titleOf(text: string, cap: number): string {
  const first = cleanSentence(text.split("\n")[0] ?? "");
  return first.slice(0, cap).trim();
}

/**
 * One title per chapter index, in the brief's order: the chapter's first recap
 * reply's first sentence, else the subject of the first commit made in it, else
 * the first user line with something in it, else the first user line as it is.
 */
export function chapterTitles(
  events: CarafeEvent[],
  pieces: EventPieces[],
  chapters: Chapter[],
  blocks: TurnBlock[],
  moments: KeyMoment[] = [],
): Map<number, string> {
  const titles = new Map<number, string>();
  const commandsBySeq = new Map<number, string[]>();
  for (const event of events) {
    for (const command of commandsOfEvent(event)) {
      commandsBySeq.set(event.seq, [...(commandsBySeq.get(event.seq) ?? []), command]);
    }
  }
  const resultsBySeq = new Map<number, string[]>();
  for (const piece of pieces) {
    const results = piece.lines.filter((line) => line.trimStart().startsWith("⤷")).map((line) => line.replace(/^\s*⤷\s*/, ""));
    if (results.length) resultsBySeq.set(piece.seq, results);
  }
  const inRange = (chapter: Chapter, seq: number): boolean => seq >= chapter.startSeq && seq <= chapter.endSeq;

  for (const chapter of chapters) {
    const recap = moments.filter((moment) => moment.kind === "recap" && inRange(chapter, moment.seq)).sort((a, b) => a.seq - b.seq)[0];
    if (recap) {
      // a recap's first line is prose or it is nothing: a heading, a ledger row
      // or a fragment is not a title
      const title = firstQuotableSentence(recap.fullText ?? recap.text);
      if (title) { titles.set(chapter.index, title.slice(0, CHAPTER_TITLE_CHARS)); continue; }
    }
    let commit: string | null = null;
    for (const [seq, commands] of commandsBySeq) {
      if (!inRange(chapter, seq)) continue;
      for (const command of commands) {
        const match = COMMIT_MESSAGE_RE.exec(command);
        const subject = match?.[1] ?? match?.[2];
        if (subject) { commit = titleOf(subject, CHAPTER_TITLE_CHARS); break; }
      }
      if (commit) break;
    }
    if (!commit) {
      for (const [seq, results] of resultsBySeq) {
        if (!inRange(chapter, seq)) continue;
        for (const result of results) {
          for (const line of result.split("\n")) {
            const match = COMMIT_RESULT_RE.exec(line.trim());
            if (match?.[1]) { commit = titleOf(match[1], CHAPTER_TITLE_CHARS); break; }
          }
          if (commit) break;
        }
        if (commit) break;
      }
    }
    if (commit) { titles.set(chapter.index, commit); continue; }

    const own = blocks.filter((block) => inRange(chapter, block.startSeq));
    const speaking = own.map((block) => titleOf(block.firstLine, CHAPTER_TITLE_CHARS))
      .find((line) => line.length > MIN_TITLE_USER_CHARS && !BARE_COMMAND_RE.test(line)
        && line !== "(session start)" && !line.startsWith("|") && !/^\d/.test(line));
    const title = speaking ?? titleOf(own[0]?.firstLine ?? "", CHAPTER_TITLE_CHARS);
    if (title) titles.set(chapter.index, title.slice(0, CHAPTER_TITLE_CHARS));
  }
  return titles;
}

/** The shell commands one event issued, read from the event's own input. */
function commandsOfEvent(event: CarafeEvent): string[] {
  const raw: any = event.raw;
  const out: string[] = [];
  const take = (input: unknown): void => {
    let value: any = input;
    if (typeof value === "string") { try { value = JSON.parse(value); } catch { return; } }
    const command = value?.command ?? value?.cmd;
    if (typeof command === "string") out.push(command);
    else if (Array.isArray(command) && command.every((part) => typeof part === "string")) out.push(command.join(" "));
  };
  const content = raw?.message?.content;
  if (Array.isArray(content)) for (const item of content) if (item?.type === "tool_use") take(item.input);
  if (raw?.payload) take(raw.payload.arguments ?? raw.payload.input);
  return out;
}

export function chapterOf(chapters: Chapter[], seq: number): Chapter {
  if (!chapters.length) throw new Error("cannot locate a sequence in an empty chapter list");
  let low = 0;
  let high = chapters.length - 1;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const chapter = chapters[mid]!;
    if (seq < chapter.startSeq) high = mid - 1;
    else if (seq > chapter.endSeq) low = mid + 1;
    else return chapter;
  }
  return seq < chapters[0]!.startSeq ? chapters[0]! : chapters.at(-1)!;
}
