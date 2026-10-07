import type { CarafeEvent } from "../format/events";
import type { EventPieces } from "../handoff/pieces";
import type { KeyMoment } from "./extract";
import { buildSignalContext, clip, fileSetOf, hasChoiceCue, isAck, isAffirmative, isRefusal, stripRolePrefix, tokenJaccard, type SignalContext } from "./signals";

const PROPOSAL_RE = /\bI(?:'d| would)? (?:recommend|suggest|propose)\b|\bI(?:'d| would) proceed with\b|\bmy recommendation\b|\brecommendation:|\bproposal:|\bshall I\b|\bshould I\b|\bwant me to\b|\bis that the direction\b|\bproceed\?/i;

/** A self-contained choice that names both the selected and rejected alternatives. */
export function hasContrastiveChoice(text: string): boolean {
  const plain = stripRolePrefix(text).replace(/\s+/g, " ").trim();
  const linked = /\b(?:let['’]?s go with|we(?:['’]ll| will) use|decision\s*:|going with)\s+[^,.!?;]{1,100}?\s+(?:instead of|rather than|over|and dropping)\s+[^,.!?;]{1,100}/i;
  const rejected = /\bswitch to\s+[^,]{1,100},\s*[^,.!?;]{1,100}\s+isn['’]?t\b/i;
  return linked.test(plain) || rejected.test(plain);
}

function proposalSentence(text: string): string | null {
  const plain = stripRolePrefix(text);
  const sentences = plain.match(/[^.!?\n]+[.!?]?/g) ?? [plain];
  const trimmed = sentences.map((sentence) => sentence.trim());
  // Pasted logs carry timestamps and can contain a cue by accident ("…should I…"
  // inside a build log); a proposal is prose, not a log line.
  return trimmed.find((sentence) => PROPOSAL_RE.test(sentence) && !/^\d{1,2}:\d{2}(?::\d{2})?(?:\s*[AP]M)?\b/i.test(sentence) && sentence.length <= 400) ?? null;
}

interface OptionsQuestion { headline: string; options: string[] }

function optionsQuestion(text: string): OptionsQuestion | null {
  const plain = stripRolePrefix(text).replace(/\s+/g, " ").trim();
  const explicit = /^(.*?)\s+Options:\s*(.+)$/i.exec(plain);
  const implicit = explicit == null ? /^(.*?\?)\s+((?:`[^`]+`|[A-Z][\w-]*(?: [\w-]+)*)(?:\s*,\s*(?:`[^`]+`|[A-Z][\w-]*(?: [\w-]+)*)){1,})[.!]?$/u.exec(plain) : null;
  const headline = (explicit?.[1] ?? implicit?.[1] ?? "").trim();
  const list = (explicit?.[2] ?? implicit?.[2] ?? "").replace(/[.!?]+$/, "").trim();
  if (!headline || !list) return null;
  const options = list.split(/\s*,\s*|\s+or\s+/i).map((option) => option.replace(/^`|`$/g, "").trim()).filter(Boolean);
  return options.length >= 2 ? { headline, options } : null;
}

function selectedOption(question: OptionsQuestion | null, reply: string): string | null {
  if (!question) return null;
  const normalized = stripRolePrefix(reply).toLocaleLowerCase();
  return question.options.slice().sort((a, b) => b.length - a.length).find((option) => {
    const exact = option.toLocaleLowerCase();
    const nounPhrase = exact.replace(/^(?:a|an|the)\s+/, "");
    return normalized.includes(exact) || normalized.includes(nounPhrase);
  }) ?? null;
}

/** The first line of the reply a turn actually produced, capped — the honest
 *  answer to "what did this steer change?". */
export const NEXT_REPLY_CHARS = 100;
function nextReplyOf(block: { assistantLines: Array<{ seq: number; text: string }> }): string | undefined {
  const reply = block.assistantLines[0];
  if (!reply) return undefined;
  const line = (stripRolePrefix(reply.text).split("\n").map((part) => part.trim()).find(Boolean) ?? "").trim();
  return line ? clip(line, NEXT_REPLY_CHARS) : undefined;
}

export function detectBends(events: CarafeEvent[], pieces: EventPieces[], goalSeq?: number, context: SignalContext = buildSignalContext(events, pieces)): KeyMoment[] {
  const blocks = context.blocks;
  const moments: KeyMoment[] = [];
  for (let index = 0; index < blocks.length; index++) {
    const block = blocks[index]!;
    if (!block.userLine || block.startSeq === goalSeq) continue;
    const userText = stripRolePrefix(block.userLine);
    // A pasted log ("3:31:24 PM: build-image version …") is evidence, not a choice,
    // however many cue words it happens to contain.
    const pastedLog = /^\d{1,2}:\d{2}(?::\d{2})?(?:\s*[AP]M)?\b|^\[\d{4}-\d{2}-\d{2}T/i.test(userText);

    const before = fileSetOf(blocks.slice(Math.max(0, index - 4), index));
    const after = fileSetOf(blocks.slice(index, index + 4));
    const bend = before.size >= 2 && after.size >= 2 && tokenJaccard(before, after) < 0.2;
    const previous = index > 0 ? blocks[index - 1]!.assistantLines.at(-1) : undefined;
    const proposal = previous ? proposalSentence(previous.text) : null;
    const options = previous ? optionsQuestion(previous.text) : null;
    const chosen = selectedOption(options, userText);

    // A bare acknowledgement carries no new information, but the same short
    // answer locks a decision when it directly accepts a proposal.
    if (isAck(userText) && !proposal) continue;

    if (pastedLog) {
      moments.push({ kind: "ask", seq: block.startSeq, text: clip(block.userLine, 800), ...(bend ? { note: "trajectory changed" } : {}) });
    } else if (chosen && options && previous && !isRefusal(userText)) {
      moments.push({
        kind: "decision",
        seq: previous.seq,
        endSeq: block.startSeq,
        text: `${clip(options.headline, 160)} → ${clip(chosen, 120)}`,
        ...(bend ? { note: "trajectory changed" } : {}),
      });
      moments.push({ kind: "ask", seq: block.startSeq, text: clip(block.userLine, 800), ...(bend ? { note: "trajectory changed" } : {}) });
    } else if (proposal && isAffirmative(userText) && !isRefusal(userText)) {
      moments.push({
        kind: "decision",
        seq: previous!.seq,
        endSeq: block.startSeq,
        text: `${clip(proposal, 300)} → ${clip(userText, 120)}`,
        ...(bend ? { note: "trajectory changed" } : {}),
      });
    } else if (proposal && isRefusal(userText)) {
      moments.push({ kind: "ask", seq: block.startSeq, text: clip(block.userLine, 800), ...(bend ? { note: "trajectory changed" } : {}) });
    } else if (isRefusal(userText)) {
      moments.push({ kind: "ask", seq: block.startSeq, text: clip(block.userLine, 800), ...(bend ? { note: "trajectory changed" } : {}) });
    } else if (hasContrastiveChoice(userText)) {
      moments.push({ kind: "decision", seq: block.startSeq, text: clip(block.userLine, 400), ...(bend ? { note: "trajectory changed" } : {}) });
    } else if (bend && hasChoiceCue(userText)) {
      moments.push({ kind: "decision", seq: block.startSeq, text: clip(block.userLine, 400), note: "trajectory changed" });
    } else {
      moments.push({ kind: "ask", seq: block.startSeq, text: clip(block.userLine, 800), ...(bend ? { note: "trajectory changed" } : {}) });
    }
    // Rendering replaces the bare "trajectory changed" label with what the
    // assistant did next; selection still keys off the note, unchanged.
    const reply = nextReplyOf(block);
    if (reply) for (const moment of moments) if (moment.note === "trajectory changed" && moment.nextReply == null && (moment.seq === block.startSeq || moment.endSeq === block.startSeq)) moment.nextReply = reply;
  }
  return moments;
}
