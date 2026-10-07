import type { CarafeEvent } from "../format/events";
import type { EventPieces } from "../handoff/pieces";
import type { KeyMoment } from "./extract";
import { buildSignalContext, cleanToolExcerpt, commandOf, failExcerpt, type EditAction, type FailureStreak, type SignalContext } from "./signals";

export type { FailureStreak } from "./signals";

export function failureStreaks(events: CarafeEvent[], pieces: EventPieces[]): FailureStreak[] {
  return buildSignalContext(events, pieces).streaks;
}

function abandonedMoments(context: SignalContext): KeyMoment[] {
  const moments: KeyMoment[] = [];
  for (const streak of context.streaks) {
    if (streak.success) continue;
    const last = streak.failures.at(-1)!;
    const first = streak.failures[0]!;
    const command = cleanToolExcerpt(first.toolLine);
    const edit = streak.edits[0];
    moments.push({ kind: "deadend", seq: first.toolSeq, endSeq: last.resultSeq, text: edit ? `${edit.text} → ${command}` : command, note: failExcerpt(last.resultLine) });
  }
  return moments;
}

function noTraceMoments(pieces: EventPieces[], context: SignalContext): KeyMoment[] {
  const edits = context.edits;
  const toolLines = pieces
    .flatMap((piece) => piece.lines.map((line) => ({ seq: piece.seq, command: commandOf(line) })))
    .filter((item): item is { seq: number; command: string } => item.command != null)
    .filter((item) => /\bgit\s+(?:commit\b|checkout\s+--|restore\b|reset\s+--hard\b)|(?:^|\s)(?:git\s+)?rm\s/i.test(item.command));
  const affected: Array<{ action: EditAction; outcome: { seq: number; note: string } }> = [];

  for (const action of edits) {
    for (const file of action.files) {
      const candidates: Array<{ seq: number; note: string }> = [];
      let committed = false;
      for (const tool of toolLines) {
        if (tool.seq <= action.endSeq) continue;
        if (/\bgit\s+commit\b/i.test(tool.command)) committed = true;
        const deleted = /(?:^|\s)(?:git\s+)?rm\s/.test(tool.command) && tool.command.includes(file);
        const pathRevert = /\bgit\s+(?:checkout\s+--|restore)\b/i.test(tool.command) && tool.command.includes(file);
        const hardReset = /\bgit\s+reset\s+--hard\b/i.test(tool.command);
        if (deleted) candidates.push({ seq: tool.seq, note: `removed at seq ${tool.seq}` });
        if (pathRevert || (!committed && hardReset)) candidates.push({ seq: tool.seq, note: `reverted at seq ${tool.seq}` });
      }
      const outcome = candidates.sort((a, b) => a.seq - b.seq)[0];
      if (outcome) affected.push({ action: { ...action, files: [file] }, outcome });
    }
  }

  const byOutcome = new Map<string, Array<{ action: EditAction; outcome: { seq: number; note: string } }>>();
  for (const item of affected) {
    byOutcome.set(item.outcome.note, [...(byOutcome.get(item.outcome.note) ?? []), item]);
  }
  const groups: Array<Array<{ action: EditAction; outcome: { seq: number; note: string } }>> = [];
  for (const items of byOutcome.values()) {
    const ordered = items.slice().sort((a, b) => a.action.seq - b.action.seq);
    let group: typeof ordered = [];
    for (const item of ordered) {
      const previous = group.at(-1);
      if (previous && item.action.seq > previous.action.endSeq + 1) {
        groups.push(group);
        group = [];
      }
      group.push(item);
    }
    if (group.length) groups.push(group);
  }
  return groups.map((items) => {
    const actions = items.map((item) => item.action).sort((a, b) => a.seq - b.seq);
    const first = actions[0]!;
    const last = actions.at(-1)!;
    return { kind: "deadend", seq: first.seq, endSeq: last.endSeq, text: first.text, note: items[0]!.outcome.note } satisfies KeyMoment;
  });
}

function reversalMoments(pieces: EventPieces[]): KeyMoment[] {
  const tools = pieces.flatMap((piece) => piece.lines.filter((line) => line.startsWith("→ **")).map((line) => ({ seq: piece.seq, line, command: commandOf(line) }))).filter((tool) => tool.command != null) as Array<{ seq: number; line: string; command: string }>;
  const moments: KeyMoment[] = [];
  for (let index = 0; index < tools.length; index++) {
    const tool = tools[index]!;
    const command = tool.command;
    const explicit = /\bgit\s+(?:revert\b|reset\s+--hard\b|checkout\s+--\s|restore\s)/i.test(command);
    const stash = /\bgit\s+stash(?:\s+(?!pop\b|apply\b).*)?$/i.test(command);
    if (!explicit && !stash) continue;
    if (stash && tools.slice(index + 1).some((later) => /\bgit\s+stash\s+(?:pop|apply)\b/i.test(later.command))) continue;
    moments.push({ kind: "deadend", seq: tool.seq, text: cleanToolExcerpt(tool.line), note: "explicit reversal" });
  }
  return moments;
}

export function detectDeadends(events: CarafeEvent[], pieces: EventPieces[], maxDeadends = 12, context = buildSignalContext(events, pieces)): KeyMoment[] {
  // The cap applies to effort-based dead ends (streaks and no-trace groups), longest
  // span first. Explicit reversals are one line each and rare; capping them alongside
  // multi-event streaks evicted them first, which is backwards for a resuming agent.
  const longestFirst = (moments: KeyMoment[]): KeyMoment[] => moments.slice().sort((a, b) => ((b.endSeq ?? b.seq) - b.seq) - ((a.endSeq ?? a.seq) - a.seq) || a.seq - b.seq);
  // Failure streaks already require repeated same-family failures and no recovery;
  // reserve their place before lower-confidence file-history inference reaches the cap.
  const selected = [...longestFirst(abandonedMoments(context)), ...longestFirst(noTraceMoments(pieces, context))].slice(0, maxDeadends);
  return [...selected, ...reversalMoments(pieces)].sort((a, b) => a.seq - b.seq);
}
