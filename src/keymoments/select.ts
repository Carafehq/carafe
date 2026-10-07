import type { Chapter } from "./chapters";
import { chapterOf } from "./chapters";
import type { KeyMoment, KeyMomentSet, MomentKind } from "./extract";

export type TrimmedByKind = Partial<Record<Exclude<MomentKind, "goal">, number>>;
export type TrimmedByChapter = Record<number, number>;

export interface ChapterSelection {
  selected: KeyMoment[];
  trimmedByKind: TrimmedByKind;
  trimmedByChapter: TrimmedByChapter;
}

// Findings quote assistant prose, the one detector whose precision is a
// judgement call: they rank after everything measured from behaviour (dead
// ends, commits, the user's own turns) and get no per-chapter guarantee.
const PRIORITY: Array<Exclude<MomentKind, "goal" | "rule">> = ["decision", "breakthrough", "deadend", "artifact", "ask", "finding", "wip"];
const GUARANTEED: ReadonlyArray<(typeof PRIORITY)[number]> = PRIORITY.filter((kind) => kind !== "finding");

function stripPrefix(text: string): string {
  return text.replace(/^\*\*(user|assistant):\*\*\s*/i, "").replace(/^\s*⤷\s*/, "").trim();
}

function displayText(moment: KeyMoment): string {
  if (moment.kind === "goal" || moment.kind === "ask" || moment.kind === "decision") {
    return stripPrefix(moment.text.replace(/^→ \*\*([^*]+)\*\*\s*/, ""));
  }
  return moment.text.replace(/^→ \*\*([^*]+)\*\*\s*/, "$1: ").trim();
}

const IMPERATIVE_RE = /^(?:stop|don['’]?t|do|use|keep|make|run|check|fix|change|add|remove|switch|let['’]?s)\b/i;

export function steeringPriority(moment: KeyMoment): number {
  const text = stripPrefix(moment.text);
  if (moment.note === "trajectory changed" || IMPERATIVE_RE.test(text)) return 1;
  if (text.trimEnd().endsWith("?")) return 2;
  return 3;
}

export function momentLabel(moment: KeyMoment): string {
  if (moment.kind === "artifact") return isPrMoment(moment.text) ? "pr" : "commit";
  return costLabel(moment);
}

/**
 * Round 9 — a moment is a PR when it records one: a `pr-link` event, a PR URL,
 * or a command that RUNS `gh pr …`. A tool result that merely mentions `gh pr`
 * (a grep hit inside a bench script) is not a pull request.
 */
export function isPrMoment(text: string): boolean {
  if (/\bpr-link\b|\/pull\/\d+/i.test(text)) return true;
  const trimmed = text.trimStart();
  if (trimmed.startsWith("⤷") || trimmed.startsWith("**")) return false;
  return /(?:^|[;&|(]\s*|\$\(\s*|"command":\s*"\s*|→ \*\*\w+\*\*\s+(?:\{"command":"\s*)?)gh\s+pr\s+(?:create|merge|edit|ready|close|reopen|review|comment)\b/i.test(trimmed);
}

/** The label a moment is COSTED under: selection must not move when only a
 *  display label is corrected (the sealed benches select by cost). */
function costLabel(moment: KeyMoment): string {
  if (moment.kind === "ask") return "steering";
  if (moment.kind === "breakthrough") return "breakthrough";
  if (moment.kind === "finding") return "finding";
  if (moment.kind === "rule") return "rule";
  if (moment.kind === "deadend") return "dead end";
  if (moment.kind === "artifact") return /\bpr-link\b|\bgh\s+pr\b|\/pull\/\d+/i.test(moment.text) ? "pr" : "commit";
  return moment.kind;
}

/** "→ trajectory changed" told the reader a label; the first line of the reply
 *  tells them what actually happened. Selection still keys off the note
 *  (`steeringPriority`, `candidatesFor`), so only the rendered suffix moves. */
function displayNote(moment: KeyMoment): string | undefined {
  if (moment.note !== "trajectory changed") return moment.note ? stripPrefix(moment.note) : undefined;
  return moment.nextReply ? `then: "${moment.nextReply}"` : undefined;
}

/** The kinds whose text a caller may re-cap at render time. Everything else is
 *  already an excerpt of a command or a result, and shortening it would lose
 *  the only thing it carries. */
const CAPPABLE: ReadonlyArray<KeyMoment["kind"]> = ["ask", "decision", "recap"];

/** `textCapChars` is a RENDERING cap only: `momentCharCost` (and therefore
 *  every selection) keeps costing the stored text, so passing it cannot change
 *  which moments are chosen. Callers that pass nothing render as before. */
/**
 * The subject a commit moment carries.
 *
 * Two real lines this got wrong: `commit: && git log --oneline -1` and
 * `commit: && git log --oneline -1 && git show --stat …` — both of them the
 * text that happened to follow the heredoc OPENER on the same line. The
 * message body starts after the newline that follows `<<'EOF'`, and nothing on
 * the opener line is ever part of it. When no subject can be parsed at all
 * (`--amend --no-edit`), git's own `[branch hash] subject` line in the result
 * is the answer; failing that, the caller keeps the line it had.
 */
export function commitSubjectOf(text: string, result?: string | null): { subject: string; hash: string | null } | null {
  const fromResult = (): { subject: string; hash: string | null } | null => {
    const match = /^\s*\[[^\]\n]*?\s([0-9a-f]{7,40})\]\s*(.+)$/m.exec(result ?? "");
    return match ? { subject: match[2]!.trim(), hash: match[1]! } : null;
  };
  if (!/\bgit\b[^\n]*\bcommit\b/.test(text)) return null;
  const hashOf = (): string | null => /\b([0-9a-f]{7,40})\b/.exec(text.replace(/\bcommit\b/g, ""))?.[1] ?? null;

  const dashM = /\bcommit\b[^\n]*?\s-m\s+("([^"]+)"|'([^']+)')/.exec(text);
  const quoted = (dashM?.[2] ?? dashM?.[3] ?? "").trim();
  if (quoted) return { subject: quoted, hash: hashOf() };

  // the body begins on the line AFTER the opener; `;` is how a flattened
  // command records that newline
  const opener = /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/.exec(text);
  if (opener) {
    const after = text.slice(opener.index + opener[0].length);
    const body = after.split(/\r?\n|\s;\s/).slice(1);
    const first = body.map((line) => line.trim()).find((line) => line && line !== opener[2]);
    if (first) return { subject: first, hash: hashOf() };
  }
  return fromResult();
}

export function renderMomentLine(moment: KeyMoment, textCapChars?: number, commitSubjects = false): string {
  const note = displayNote(moment);
  const range = moment.endSeq ? `-${moment.endSeq}` : "";
  // A recap is an answer: it reads properly only with the question on it.
  const head = moment.kind === "recap" ? `recap (asked "${moment.requestLine ?? ""}")` : `${momentLabel(moment)}`;
  const commit = commitSubjects && moment.kind === "artifact" ? commitSubjectOf(moment.text, moment.note) : null;
  const body = commit
    ? `${commit.subject}${commit.hash ? ` (${commit.hash})` : ""}`
    : textCapChars != null && CAPPABLE.includes(moment.kind)
      ? clipText(displayText(moment), textCapChars)
      : displayText(moment);
  // a moment lifted from a helper agent's trace is ALWAYS labelled with that
  // agent: its seq belongs to a different trace, and a bare number would send
  // the reader to the wrong place in this one
  const anchor = moment.via ? `agent-${moment.via} seq ${moment.viaSeq ?? moment.seq}` : `seq ${moment.seq}${range}`;
  return `- ${head}: ${body}${note ? ` → ${note}` : ""}  [${anchor}]`;
}

function clipText(text: string, cap: number): string {
  return text.length <= cap ? text : `${text.slice(0, Math.max(0, cap - 1))}…`;
}

/** Budgeting costs a moment by its STORED note, not its rendered one: what a
 *  line says must never change which lines are chosen. */
export function momentCharCost(moment: KeyMoment): number {
  const note = moment.note ? stripPrefix(moment.note) : undefined;
  const range = moment.endSeq ? `-${moment.endSeq}` : "";
  return `- ${costLabel(moment)}: ${displayText(moment)}${note ? ` → ${note}` : ""}  [seq ${moment.seq}${range}]`.length + 1;
}

/**
 * W3 (handoff rendering only) — recency and substance.
 *
 * A real session gave chapter 40 — six days, 953 events, a production security
 * change — seven moments, three of them `du -sh` shell lines, because the
 * budget was spread evenly across five weeks. Both of these knobs are OFF
 * unless a caller passes them, so `carafe key-moments`, `carafe chapters` and
 * both sealed benches select exactly as before.
 */
export interface ChapterSelectOpts {
  /** chapters whose end is inside the recency window */
  recentChapters?: Set<number>;
  /** the least share of the budget those chapters get between them */
  recentShare?: number;
  /** a `wip:` shell line renders only where the chapter has little else */
  demoteWip?: boolean;
  /** the chapter the session ended in, and how many moments it may render */
  newestChapter?: number;
  newestCap?: number;
  /** …and the cap for every other chapter inside the recency window */
  recentCap?: number;
}

/** The kinds a shell line must never displace. A chapter that carries three
 *  moments of ANY other kind has something to say for itself, and a `du -sh`
 *  is not it. */
const WIP_CROWDS_OUT_AT = 3;

function candidatesFor(chapter: Chapter, moments: KeyMoment[], opts: ChapterSelectOpts = {}): KeyMoment[] {
  let inChapter = moments.filter((moment) => moment.kind !== "goal" && moment.kind !== "rule" && moment.chapter === chapter.index);
  if (opts.demoteWip && inChapter.filter((moment) => moment.kind !== "wip").length >= WIP_CROWDS_OUT_AT) {
    inChapter = inChapter.filter((moment) => moment.kind !== "wip");
  }
  return PRIORITY.flatMap((kind) => inChapter.filter((moment) => moment.kind === kind).sort((a, b) => {
    if (kind === "ask") {
      const changed = Number(b.note === "trajectory changed") - Number(a.note === "trajectory changed");
      if (changed) return changed;
    }
    return b.seq - a.seq;
  }));
}

export function selectChapterMoments(set: KeyMomentSet, chapters: Chapter[], budgetChars: number, opts: ChapterSelectOpts = {}): ChapterSelection {
  if (!chapters.length) return { selected: [], trimmedByKind: {}, trimmedByChapter: {} };
  const assigned = set.moments.map((moment) => ({ ...moment, chapter: moment.kind === "rule" ? undefined : moment.kind === "wip" ? chapters.at(-1)!.index : chapterOf(chapters, moment.seq).index }));
  const goals = assigned.filter((moment) => moment.kind === "goal");
  // Recaps are the session's own status reports and standing instructions are
  // rendered by the handoff's own section: neither competes for, nor consumes,
  // the per-chapter budget — so adding them cannot change any other selection.
  const recaps = assigned.filter((moment) => moment.kind === "recap");
  const rules = assigned.filter((moment) => moment.kind === "rule").sort((a, b) => a.seq - b.seq);
  const selectedRules: KeyMoment[] = [];
  let ruleCost = "### Standing rules\n".length + 1;
  for (const rule of rules.slice(0, 12)) {
    const cost = momentCharCost(rule);
    if (ruleCost + cost > Math.min(2_400, budgetChars)) continue;
    selectedRules.push(rule);
    ruleCost += cost;
  }
  if (!selectedRules.length) ruleCost = 0;
  const nonGoals = assigned.filter((moment) => moment.kind !== "goal" && moment.kind !== "rule" && moment.kind !== "recap" && moment.kind !== "instruction" && moment.kind !== "openask");
  const active = chapters.filter((chapter) => nonGoals.some((moment) => moment.chapter === chapter.index));
  const chapterBudget = Math.max(0, budgetChars - ruleCost);
  const floor = Math.min(700, Math.floor((chapterBudget * 0.5) / chapters.length));
  const reserved = floor * active.length;
  const remaining = Math.max(0, chapterBudget - reserved);
  const eventfulness = new Map<number, number>();
  let totalEventfulness = 0;
  for (const chapter of chapters) {
    const moments = nonGoals.filter((moment) => moment.chapter === chapter.index);
    const deadends = moments.filter((moment) => moment.kind === "deadend").length;
    const breakthroughs = moments.filter((moment) => moment.kind === "breakthrough").length;
    const findings = moments.filter((moment) => moment.kind === "finding").length;
    const asks = moments.filter((moment) => moment.kind === "ask").length;
    const score = 1 + chapter.commits + chapter.decisions + breakthroughs + findings + deadends + asks * 0.5 + chapter.failures + (chapter.tokens ?? 0) / 50_000;
    eventfulness.set(chapter.index, score);
    totalEventfulness += score;
  }
  const allowances = new Map<number, number>();
  let distributed = 0;
  for (const chapter of chapters) {
    const share = Math.floor(remaining * (eventfulness.get(chapter.index)! / totalEventfulness));
    allowances.set(chapter.index, (active.includes(chapter) ? floor : 0) + share);
    distributed += share;
  }
  allowances.set(chapters.at(-1)!.index, allowances.get(chapters.at(-1)!.index)! + remaining - distributed);

  // W3 — the decisive days get at least their share. Everything below is
  // unchanged when no caller asks for it.
  if (opts.recentChapters?.size && (opts.recentShare ?? 0) > 0) {
    const recent = chapters.filter((chapter) => opts.recentChapters!.has(chapter.index));
    const older = chapters.filter((chapter) => !opts.recentChapters!.has(chapter.index));
    const recentNow = recent.reduce((sum, chapter) => sum + (allowances.get(chapter.index) ?? 0), 0);
    const target = Math.floor(chapterBudget * opts.recentShare!);
    const olderNow = older.reduce((sum, chapter) => sum + (allowances.get(chapter.index) ?? 0), 0);
    if (recent.length && recentNow < target && olderNow > 0) {
      const moved = Math.min(olderNow, target - recentNow);
      for (const chapter of older) {
        const had = allowances.get(chapter.index) ?? 0;
        allowances.set(chapter.index, had - Math.floor((had / olderNow) * moved));
      }
      for (const chapter of recent) {
        const had = allowances.get(chapter.index) ?? 0;
        allowances.set(chapter.index, had + Math.floor(moved / recent.length));
      }
    }
  }

  const selected = new Set<KeyMoment>();
  const pending = new Map<number, KeyMoment[]>();
  let usedTotal = ruleCost;
  for (const chapter of chapters) {
    const candidates = candidatesFor(chapter, nonGoals, opts);
    const allowance = allowances.get(chapter.index) ?? 0;
    let used = 0;
    // One newest item from every guaranteed kind present comes before the
    // normal priority fill; "where it stands" (WIP) keeps a three-line tail
    // quorum because the last uncommitted edits are what a resumer acts on
    // first. With the default floor this also gives every active chapter a
    // voice. Findings are not guaranteed: on a 43-chapter real session the
    // guarantee alone put 43 of them in the block.
    for (const kind of GUARANTEED) {
      // a shell line has no guaranteed place when the chapter has real content
      if (opts.demoteWip && kind === "wip" && !candidates.some((moment) => moment.kind === "wip")) continue;
      const minimum = kind === "wip" ? 3 : 1;
      for (const candidate of candidates.filter((moment) => moment.kind === kind && !selected.has(moment)).slice(0, minimum)) {
        selected.add(candidate);
        used += momentCharCost(candidate);
      }
    }
    for (const candidate of candidates) {
      if (selected.has(candidate)) continue;
      const cost = momentCharCost(candidate);
      if (used + cost > allowance) continue;
      selected.add(candidate);
      used += cost;
    }
    usedTotal += used;
    pending.set(chapter.index, candidates.filter((candidate) => !selected.has(candidate)));
  }

  let slack = Math.max(0, budgetChars - usedTotal);
  for (let index = chapters.length - 1; index >= 0; index--) {
    const chapter = chapters[index]!;
    for (const candidate of pending.get(chapter.index) ?? []) {
      const cost = momentCharCost(candidate);
      if (cost > slack) continue;
      selected.add(candidate);
      slack -= cost;
    }
  }

  // Whenever steering turns were trimmed, trade only within the steering
  // category and chapter: a higher-signal turn (one that steered, an
  // imperative, a question) replaces the lowest-signal selected turn
  // (narrative). Counts and every other moment stay untouched, so this is safe
  // at any budget, including the handoff's own 20K moments budget.
  {
    for (const chapter of chapters) {
      const asks = nonGoals.filter((moment) => moment.kind === "ask" && moment.chapter === chapter.index);
      const replacements = asks.filter((moment) => !selected.has(moment)).sort((a, b) => steeringPriority(a) - steeringPriority(b) || b.seq - a.seq);
      for (const replacement of replacements) {
        const displaced = asks
          .filter((moment) => selected.has(moment) && steeringPriority(moment) > steeringPriority(replacement))
          .sort((a, b) => steeringPriority(b) - steeringPriority(a) || a.seq - b.seq)[0];
        if (!displaced) continue;
        selected.delete(displaced);
        selected.add(replacement);
      }
    }
  }

  // W3/v5 — a hard per-chapter cap. The budget alone let one chapter spend
  // 30KB; a reader wants the newest chapter in full and the ones before it in
  // outline, and the trimmed lines stay one `carafe chapters` away.
  if (opts.newestCap != null || opts.recentCap != null) {
    for (const chapter of chapters) {
      const cap = chapter.index === opts.newestChapter ? opts.newestCap : opts.recentChapters?.has(chapter.index) ? opts.recentCap : undefined;
      if (cap == null) continue;
      const own = candidatesFor(chapter, nonGoals, opts).filter((moment) => selected.has(moment));
      for (const moment of own.slice(cap)) selected.delete(moment);
    }
  }

  const selectedMoments = [
    ...goals.sort((a, b) => a.seq - b.seq),
    ...selectedRules,
    ...chapters.flatMap((chapter) => [
      // a chapter's recaps lead it: a status report outranks the steers it summarises
      ...recaps.filter((moment) => moment.chapter === chapter.index).sort((a, b) => a.seq - b.seq),
      ...candidatesFor(chapter, nonGoals, opts).filter((moment) => selected.has(moment)),
    ]),
  ];
  const trimmedByKind: TrimmedByKind = {};
  const trimmedByChapter: TrimmedByChapter = {};
  for (const moment of nonGoals) {
    if (selected.has(moment)) continue;
    const kind = moment.kind as Exclude<MomentKind, "goal">;
    trimmedByKind[kind] = (trimmedByKind[kind] ?? 0) + 1;
    trimmedByChapter[moment.chapter!] = (trimmedByChapter[moment.chapter!] ?? 0) + 1;
  }
  const droppedRules = rules.length - selectedRules.length;
  if (droppedRules > 0) trimmedByKind.rule = droppedRules;
  return { selected: selectedMoments, trimmedByKind, trimmedByChapter };
}
