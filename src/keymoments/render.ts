/**
 * Key Moments resume-block rendering — fixed-order markdown for pasting into a
 * fresh session. The output stays grounded in verbatim moment excerpts and seq
 * anchors while trimming only lower-priority material to fit a character budget.
 */
import type { SessionDistillate } from "../format/distillate";
import type { KeyMoment, KeyMomentSet, MomentKind } from "./extract";
import type { Chapter } from "./chapters";
import { renderMomentLine as renderOneMoment, selectChapterMoments, type ChapterSelectOpts, type TrimmedByChapter, type TrimmedByKind } from "./select";

export interface ResumeBlock {
  text: string;
  chars: number;
  momentCount: number;
  trimmed: number;
  moments: KeyMoment[];
  trimmedByKind: TrimmedByKind;
  trimmedByChapter: TrimmedByChapter;
}
export interface MomentsSection extends Omit<ResumeBlock, "chars"> { chars: number }

const DEFAULT_BUDGET_CHARS = 12_000;
const SHARES: Record<MomentKind, number> = {
  goal: 0,
  decision: 0.35,
  breakthrough: 0,
  finding: 0,
  deadend: 0.20,
  rule: 0,
  wip: 0.20,
  ask: 0.15,
  artifact: 0.10,
  recap: 0,
  instruction: 0,
  openask: 0,
};
const MIN_PER_KIND = 2;
const BUDGETED_KINDS = ["decision", "deadend", "wip", "ask", "artifact"] as const;
type BudgetedKind = (typeof BUDGETED_KINDS)[number];

function stripPrefix(text: string): string {
  return text
    .replace(/^\*\*(user|assistant):\*\*\s*/i, "")
    .replace(/^\s*⤷\s*/, "")
    .trim();
}

function stripToolPrefix(text: string): string {
  return text.replace(/^→ \*\*([^*]+)\*\*\s*/, "").trim();
}

function keepToolPrefix(text: string): string {
  return text.replace(/^→ \*\*([^*]+)\*\*\s*/, "$1: ").trim();
}

function displayText(moment: KeyMoment): string {
  if (moment.kind === "goal" || moment.kind === "ask" || moment.kind === "decision") return stripPrefix(stripToolPrefix(moment.text));
  return keepToolPrefix(moment.text);
}

function displayNote(note: string | undefined): string | undefined {
  if (!note) return undefined;
  return stripPrefix(note);
}

function momentCharCost(moment: KeyMoment): number {
  const text = displayText(moment);
  const note = displayNote(moment.note);
  const range = moment.endSeq ? `-${moment.endSeq}` : "";
  return `- ${text}${note ? ` → ${note}` : ""}  [seq ${moment.seq}${range}]\n`.length;
}

interface BudgetedMoments {
  moments: KeyMoment[],
  trimmed: number,
  trimmedByKind: Partial<Record<BudgetedKind, number>>,
}

function selectBudgetedMoments(set: KeyMomentSet, budgetChars: number): BudgetedMoments {
  const selected = new Set<KeyMoment>(set.moments.filter((moment) => moment.kind === "goal"));
  const byKind = new Map<BudgetedKind, KeyMoment[]>();
  let leftover = 0;

  for (const kind of BUDGETED_KINDS) {
    const candidates = set.moments
      .filter((moment) => moment.kind === kind)
      .sort((a, b) => b.seq - a.seq);
    byKind.set(kind, candidates);
    const allowance = budgetChars * SHARES[kind];
    const minimum = Math.min(MIN_PER_KIND, candidates.length);
    let used = 0;
    let kept = 0;

    while (kept < candidates.length) {
      const candidate = candidates[kept]!;
      const cost = momentCharCost(candidate);
      if (kept >= minimum && used + cost > allowance) break;
      selected.add(candidate);
      used += cost;
      kept++;
    }
    leftover += Math.max(0, allowance - used);
  }

  for (const kind of BUDGETED_KINDS) {
    const candidates = byKind.get(kind) ?? [];
    let kept = candidates.filter((moment) => selected.has(moment)).length;
    while (kept < candidates.length) {
      const candidate = candidates[kept]!;
      const cost = momentCharCost(candidate);
      if (cost > leftover) break;
      selected.add(candidate);
      leftover -= cost;
      kept++;
    }
  }

  const moments = set.moments.filter((moment) => selected.has(moment));
  const trimmedByKind: Partial<Record<BudgetedKind, number>> = {};
  for (const kind of BUDGETED_KINDS) {
    const dropped = (byKind.get(kind)?.length ?? 0) - moments.filter((moment) => moment.kind === kind).length;
    if (dropped > 0) trimmedByKind[kind] = dropped;
  }
  const trimmed = BUDGETED_KINDS.reduce((sum, kind) => sum + (trimmedByKind[kind] ?? 0), 0);
  return { moments, trimmed, trimmedByKind };
}

function buildMomentSectionLines(
  moments: KeyMoment[],
  trimmed: number,
  trimmedByKind: Partial<Record<BudgetedKind, number>>,
  budgetChars: number,
  heading = "##",
): string[] {
  const byKind = (kind: MomentKind) => moments.filter((m) => m.kind === kind);
  const decisions = byKind("decision");
  const asks = byKind("ask");
  const deadends = byKind("deadend");
  const artifacts = byKind("artifact");
  const wips = byKind("wip");
  const lines: string[] = [];

  if (decisions.length) {
    lines.push(`${heading} Decisions locked`);
    for (const m of decisions) {
      const note = displayNote(m.note);
      lines.push(`- ${displayText(m)}${note ? ` → ${note}` : ""}  [seq ${m.seq}]`);
    }
    lines.push(``);
  }

  if (asks.length) {
    lines.push(`${heading} Steering / course corrections`);
    for (const m of asks) lines.push(`- ${displayText(m)}  [seq ${m.seq}]`);
    lines.push(``);
  }

  if (deadends.length) {
    lines.push(`${heading} Dead ends — do NOT re-attempt`);
    for (const m of deadends) {
      const note = displayNote(m.note);
      lines.push(`- ${displayText(m)}${note ? ` → ${note}` : ""}  [seq ${m.seq}]`);
    }
    lines.push(``);
  }

  if (artifacts.length) {
    lines.push(`${heading} Durable artifacts`);
    for (const m of artifacts) lines.push(`- ${displayText(m)}  [seq ${m.seq}]`);
    lines.push(``);
  }

  if (wips.length) {
    lines.push(`${heading} Where it stands (work in flight)`);
    for (const m of wips) lines.push(`- ${displayText(m)}  [seq ${m.seq}${m.endSeq ? `-${m.endSeq}` : ""}]`);
    lines.push(``);
  }

  if (trimmed > 0) {
    const counts = BUDGETED_KINDS
      .filter((kind) => (trimmedByKind[kind] ?? 0) > 0)
      .map((kind) => `${trimmedByKind[kind]} ${kind}`)
      .join(", ");
    lines.push(`_(${trimmed} lower-priority moment(s) trimmed to fit ${budgetChars} chars — ${counts} — raise with --budget)_`, ``);
  }

  return lines;
}

/** The block's own note about itself. A plain italic line on purpose: a markdown
 * blockquote reads as a quotation, and outside scorers (gbrain-evals' quote
 * fidelity) check every `>` line against the transcript. Only the trace is
 * ever quoted here. Same reason the command hints use single quotes: a `"…"`
 * span is read as a quotation too. */
function headerNote(sessionId: string): string {
  return `_Reconstructed from the COMPLETE local trace, not an in-context summary. Every item cites a [seq N] you can expand verbatim with \`carafe show ${sessionId} --seq N\`._`;
}

function buildText(
  d: SessionDistillate,
  moments: KeyMoment[],
  trimmed: number,
  trimmedByKind: Partial<Record<BudgetedKind, number>>,
  budgetChars: number,
): string {
  const goal = moments.find((moment) => moment.kind === "goal");
  const lines: string[] = [
    `# Resume context — ${d.title ?? d.sessionId}`,
    `<!-- carafe key-moments · ${d.sessionId} (${d.tool}) · ${d.eventCount} events · ${d.startTs ?? "?"}→${d.endTs ?? "?"} -->`,
    headerNote(d.sessionId),
    ``,
  ];

  if (goal) lines.push(`## The goal`, displayText(goal) + `  [seq ${goal.seq}]`, ``);
  lines.push(...buildMomentSectionLines(moments, trimmed, trimmedByKind, budgetChars));
  lines.push(
    `---`,
    `Continue from here. Pull any earlier section on demand: \`carafe show ${d.sessionId} --seq A-B\` ·`,
    `\`carafe grep ${d.sessionId} '<pattern>'\`.`,
  );
  return lines.join("\n") + "\n";
}

export function renderResumeBlockV1(
  d: SessionDistillate,
  set: KeyMomentSet,
  opts?: { budgetChars?: number },
): ResumeBlock {
  const budgetChars = opts?.budgetChars ?? DEFAULT_BUDGET_CHARS;
  const { moments, trimmed, trimmedByKind } = selectBudgetedMoments(set, budgetChars);
  const text = buildText(d, moments, trimmed, trimmedByKind, budgetChars);
  return { text, chars: text.length, momentCount: moments.length, trimmed, moments, trimmedByKind, trimmedByChapter: {} };
}

/** Render only embeddable, budgeted moment categories. The goal and resume
 * framing intentionally stay with renderResumeBlock. */
export function renderMomentsSectionV1(
  set: KeyMomentSet,
  opts?: { budgetChars?: number },
): MomentsSection {
  const budgetChars = opts?.budgetChars ?? DEFAULT_BUDGET_CHARS;
  const { moments, trimmed, trimmedByKind } = selectBudgetedMoments(set, budgetChars);
  const sectionMoments = moments.filter((moment) => moment.kind !== "goal");
  const lines = buildMomentSectionLines(sectionMoments, trimmed, trimmedByKind, budgetChars, "###");
  const text = lines.length ? lines.join("\n") + "\n" : "";
  return { text, chars: text.length, momentCount: sectionMoments.length, trimmed, moments: sectionMoments, trimmedByKind, trimmedByChapter: {} };
}

function fallbackChapter(set: KeyMomentSet, d?: SessionDistillate): Chapter[] {
  const seqs = set.moments.map((moment) => moment.endSeq ?? moment.seq);
  const startSeq = Math.min(...set.moments.map((moment) => moment.seq), 0);
  const endSeq = Math.max(...seqs, set.totalEvents - 1, 0);
  return [{
    index: 1, startSeq, endSeq, startTs: d?.startTs ?? null, endTs: d?.endTs ?? null,
    turns: 0, toolCalls: 0, chars: 0, branch: d?.gitBranch ?? null, cwd: d?.cwd ?? null,
    files: [], commits: set.moments.filter((moment) => moment.kind === "artifact" && /\bgit\s+commit\b/.test(moment.text)).length,
    failures: set.moments.filter((moment) => moment.kind === "deadend").length,
    decisions: set.moments.filter((moment) => moment.kind === "decision").length,
    boundary: "start", strength: 0,
  }];
}

function datePart(ts: string | null): string | null {
  return ts && /^\d{4}-\d{2}-\d{2}/.test(ts) ? ts.slice(0, 10) : null;
}

/** `title` is the handoff's W3 chapter title: a headline that says what the
 *  chapter was about. `carafe chapters` passes none and is unchanged. */
export function chapterHeadline(chapter: Chapter, heading = "###", title?: string): string {
  const fields: string[] = [`${heading} Ch ${chapter.index}`];
  if (title) fields.push(`"${title}"`);
  const count = (value: number, noun: string): string => `${value} ${noun}${value === 1 ? "" : "s"}`;
  const start = datePart(chapter.startTs);
  const end = datePart(chapter.endTs);
  if (start && end) fields.push(start === end ? start : `${start} → ${start.slice(0, 5) === end.slice(0, 5) ? end.slice(5) : end}`);
  else if (start || end) fields.push(start ?? end!);
  if (chapter.branch) fields.push(chapter.branch);
  fields.push(count(chapter.turns, "turn"));
  if (chapter.commits) fields.push(count(chapter.commits, "commit"));
  if (chapter.failures) fields.push(count(chapter.failures, "failure"));
  if (chapter.files.length) fields.push(chapter.files.map((file) => file.name).join(", "));
  fields.push(`[seq ${chapter.startSeq}–${chapter.endSeq}]`);
  return fields.join(" · ");
}

function trimNotice(trimmedByKind: TrimmedByKind, trimmedByChapter: TrimmedByChapter): string | null {
  const order: Array<Exclude<MomentKind, "goal">> = ["rule", "decision", "breakthrough", "finding", "deadend", "artifact", "ask", "wip"];
  const counts = order.filter((kind) => (trimmedByKind[kind] ?? 0) > 0).map((kind) => `${trimmedByKind[kind]} ${kind}`).join(", ");
  const total = Object.values(trimmedByKind).reduce((sum, value) => sum + (value ?? 0), 0);
  if (!total) return null;
  return `_(${total} moments trimmed — ${counts} — across ${Object.keys(trimmedByChapter).length} chapters; raise with --budget)_`;
}

/** Rendering-only shaping the handoff asks for and nothing else passes: keep
 *  the last `fullChapters` chapters whole and collapse every older one to the
 *  line `collapsedLine` returns, and cap re-cappable moment text. Selection,
 *  costing and counts are untouched, so the bench renders exactly as before. */
export interface ChapterRenderOpts {
  fullChapters?: number;
  collapsedLine?: (chapter: Chapter, moments: number) => string;
  textCapChars?: number;
  /** W3: chapter index → the title its headline carries (handoff only) */
  titles?: Map<number, string>;
  /** v5: exactly which chapters keep their moments; every other one collapses */
  fullChapterIndexes?: Set<number>;
  /** v5: render a commit moment as its subject, not as the shell line that made it */
  commitSubjects?: boolean;
  /** v5: extra lines to print under a chapter's moments (the last chapter's turns) */
  turnLines?: (chapter: Chapter) => string[];
  /** round 9: a multi-line moment keeps its later lines indented under it, so a
   *  quoted `## ` or `- ` line cannot become a heading or a bullet of the file */
  indentContinuations?: boolean;
}

function chapterLines(chapters: Chapter[], moments: KeyMoment[], trimmedByKind: TrimmedByKind, trimmedByChapter: TrimmedByChapter, render: ChapterRenderOpts = {}): string[] {
  const lines: string[] = [];
  const cap = render.textCapChars;
  const renderMomentLine = (moment: KeyMoment, textCap?: number, commitSubjects = false): string => {
    const line = renderOneMoment(moment, textCap, commitSubjects);
    return render.indentContinuations && line.includes("\n") ? line.replace(/\n/g, "\n    ") : line;
  };
  const rules = moments.filter((moment) => moment.kind === "rule");
  if (rules.length) {
    lines.push("### Standing rules");
    for (const rule of rules) lines.push(renderMomentLine(rule, cap));
    lines.push("");
  }
  const firstFull = render.fullChapters != null && render.collapsedLine ? chapters.length - render.fullChapters : 0;
  for (const [position, chapter] of chapters.entries()) {
    const own = moments.filter((candidate) => candidate.kind !== "goal" && candidate.chapter === chapter.index);
    // a chapter keeps its moments only when it is BOTH recent enough to matter
    // and near enough to the end to be worth the space
    const full = (render.fullChapterIndexes ? render.fullChapterIndexes.has(chapter.index) : true) && position >= firstFull;
    if (!full && render.collapsedLine) {
      lines.push(render.collapsedLine(chapter, own.length), "");
      continue;
    }
    lines.push(chapterHeadline(chapter, "###", render.titles?.get(chapter.index)));
    for (const moment of own) lines.push(renderMomentLine(moment, cap, render.commitSubjects === true));
    lines.push(...(render.turnLines?.(chapter) ?? []));
    lines.push("");
  }
  const notice = trimNotice(trimmedByKind, trimmedByChapter);
  if (notice) lines.push(notice, "");
  return lines;
}

export function renderResumeBlock(
  d: SessionDistillate,
  set: KeyMomentSet,
  opts?: { budgetChars?: number; chapters?: Chapter[] },
): ResumeBlock {
  const budgetChars = opts?.budgetChars ?? DEFAULT_BUDGET_CHARS;
  const chapters = opts?.chapters ?? fallbackChapter(set, d);
  const selection = selectChapterMoments(set, chapters, budgetChars);
  const goal = selection.selected.find((moment) => moment.kind === "goal");
  const lines = [
    `# Resume context — ${d.title ?? d.sessionId}`,
    `<!-- carafe key-moments · ${d.sessionId} (${d.tool}) · ${d.eventCount} events · ${d.startTs ?? "?"}→${d.endTs ?? "?"} -->`,
    headerNote(d.sessionId),
    "",
  ];
  if (goal) lines.push("## The goal", `${stripPrefix(goal.text)}  [seq ${goal.seq}]`, "");
  lines.push(...chapterLines(chapters, selection.selected, selection.trimmedByKind, selection.trimmedByChapter));
  lines.push("---", `Continue from here. Map or retrieve earlier work with: \`carafe chapters ${d.sessionId} [--chapter K]\` ·`, `\`carafe search --session ${d.sessionId} '<terms>'\` · \`carafe grep ${d.sessionId} '<pattern>'\` ·`, `\`carafe show ${d.sessionId} --seq A-B\`.`);
  const text = lines.join("\n") + "\n";
  const trimmed = Object.values(selection.trimmedByKind).reduce((sum, value) => sum + (value ?? 0), 0);
  return { text, chars: text.length, momentCount: selection.selected.length, trimmed, moments: selection.selected, trimmedByKind: selection.trimmedByKind, trimmedByChapter: selection.trimmedByChapter };
}

export function renderMomentsSection(
  set: KeyMomentSet,
  opts?: { budgetChars?: number; chapters?: Chapter[]; select?: ChapterSelectOpts } & ChapterRenderOpts,
): MomentsSection {
  const budgetChars = opts?.budgetChars ?? DEFAULT_BUDGET_CHARS;
  const chapters = opts?.chapters ?? fallbackChapter(set);
  const selection = selectChapterMoments(set, chapters, budgetChars, opts?.select ?? {});
  const sectionMoments = selection.selected.filter((moment) => moment.kind !== "goal");
  const lines = chapterLines(chapters, sectionMoments, selection.trimmedByKind, selection.trimmedByChapter, opts ?? {});
  const text = lines.length ? lines.join("\n") + "\n" : "";
  const trimmed = Object.values(selection.trimmedByKind).reduce((sum, value) => sum + (value ?? 0), 0);
  return { text, chars: text.length, momentCount: sectionMoments.length, trimmed, moments: sectionMoments, trimmedByKind: selection.trimmedByKind, trimmedByChapter: selection.trimmedByChapter };
}
