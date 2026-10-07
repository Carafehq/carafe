/**
 * Recaps — when the owner asks "where are we", the assistant writes the one
 * thing a handoff otherwise cannot carry: the state of the work in its own
 * words, at that moment. Those replies already exist in the trace; this
 * detector only finds them. Verbatim, seq-anchored, no model.
 */
import type { CarafeEvent } from "../format/events";
import type { EventPieces } from "../handoff/pieces";
import type { KeyMoment } from "./extract";
import { buildSignalContext, clip, stripRolePrefix, type SignalContext } from "./signals";

export const RECAP_TEXT_CHARS = 600;
/** The orientation layer quotes the last few recaps at length. */
export const RECAP_FULL_CHARS = 2_500;
export const RECAP_IN_HANDOFF = 3;

const EXACT_RECAP_REQUESTS = new Set([
  "where are we", "where were we", "status", "recap", "summary", "summarize",
  "sum up", "what is happening", "what's happening", "what is the state",
]);
const RECAP_PREFIX_RE = /^give me a (?:full )?(?:summary|recap)\b/;

/** The request line as the matcher sees it: first line, lowercased, stripped of
 *  surrounding punctuation (a "where are we?" is the same ask as "where are we"). */
export function recapRequestKey(userText: string): string {
  const firstLine = stripRolePrefix(userText).split("\n")[0] ?? "";
  return firstLine.toLowerCase().replace(/^[\s\p{P}]+|[\s\p{P}]+$/gu, "").replace(/\s+/g, " ").trim();
}

export function isRecapRequest(userText: string): boolean {
  const key = recapRequestKey(userText);
  return EXACT_RECAP_REQUESTS.has(key) || RECAP_PREFIX_RE.test(key);
}

export function detectRecaps(events: CarafeEvent[], pieces: EventPieces[], context: SignalContext = buildSignalContext(events, pieces)): KeyMoment[] {
  const moments: KeyMoment[] = [];
  for (const block of context.blocks) {
    if (!block.userLine || !isRecapRequest(block.userLine)) continue;
    const reply = block.assistantLines[0];
    if (!reply) continue;
    // A moment is ONE line in an index: a quoted reply's own headings and
    // bullets must not become structure in the file that quotes it.
    const replyText = stripRolePrefix(reply.text).trim();
    const oneLine = replyText.replace(/\s+/g, " ").trim();
    if (!replyText) continue;
    const request = (stripRolePrefix(block.userLine).split("\n")[0] ?? "").trim();
    moments.push({
      kind: "recap",
      seq: reply.seq,
      text: clip(oneLine, RECAP_TEXT_CHARS),
      requestLine: request,
      requestSeq: block.startSeq,
      fullText: clip(replyText, RECAP_FULL_CHARS),
    });
  }
  return moments;
}
