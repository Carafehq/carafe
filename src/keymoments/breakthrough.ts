import type { CarafeEvent } from "../format/events";
import type { EventPieces } from "../handoff/pieces";
import type { KeyMoment } from "./extract";
import { buildSignalContext, cleanToolExcerpt, clip, stripRolePrefix, type SignalContext } from "./signals";

function precedingAssistant(pieces: EventPieces[], seq: number): string | null {
  const index = pieces.findIndex((piece) => piece.seq === seq);
  if (index <= 0) return null;
  for (let cursor = index - 1; cursor >= 0; cursor--) {
    const previous = pieces[cursor]!;
    if (!previous.lines.length) continue;
    const line = previous.lines.find((candidate) => candidate.startsWith("**assistant:**"));
    if (!line) return null;
    const plain = stripRolePrefix(line);
    const sentences = plain.match(/[^.!?\n]+[.!?]?/g) ?? [plain];
    return clip(sentences.at(-1)?.trim() ?? plain, 200);
  }
  return null;
}

export function detectBreakthroughs(events: CarafeEvent[], pieces: EventPieces[], context: SignalContext = buildSignalContext(events, pieces)): KeyMoment[] {
  const moments: KeyMoment[] = [];
  for (const streak of context.streaks) {
    if (!streak.success) continue;
    const lastFailure = streak.failures.at(-1)!;
    const edit = streak.edits.filter((candidate) => candidate.seq > lastFailure.resultSeq && candidate.seq < streak.success!.toolSeq).at(-1);
    const carrierSeq = edit?.seq ?? streak.success.toolSeq;
    const excerpt = edit?.text ?? cleanToolExcerpt(streak.success.toolLine);
    const assistant = edit ? precedingAssistant(pieces, edit.seq) : null;
    moments.push({
      kind: "breakthrough",
      seq: carrierSeq,
      endSeq: streak.success.resultSeq,
      text: assistant ? `${assistant} → ${excerpt}` : excerpt,
      note: `after ${streak.failures.length} failed runs of ${streak.failures[0]!.command ?? streak.family}`,
    });
  }
  return moments;
}
