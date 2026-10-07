import type { CarafeEvent } from "../format/events";
import type { EventPieces } from "../handoff/pieces";
import type { KeyMoment } from "./extract";
import { buildSignalContext, isAck, normalizeSentence, stripRolePrefix, tokenJaccard, type SignalContext } from "./signals";

const NORMATIVE_RE = /(?:\b(?:never|always|don't|do not|must|should not|shouldn't|no longer|from now on|stop (?:doing|using|touching)|only ever)\b|\brule:)/i;
const FEELING_RE = /\b(?:i|we)\s+(?:don't|do not|never)\s+(?:get|know|understand|think|see|remember|care|want|have|need|like|mind)\b|\bwhy don't you\b/i;
// A rule the user states once but marks as standing ("never ever", "from now on",
// "add that to CLAUDE.md") is a rule on the first telling; repetition is only one
// of the ways a user signals it. Kept narrow on purpose — precision over recall.
const STRONG_RE = /\bnever ever\b|\bfrom now on\b|\badd (?:that|this|it) to (?:the )?(?:claude\.?md|memory|the rules)\b|\brule:/i;

interface Candidate {
  seq: number;
  text: string;
  normalized: string;
}

export function detectRules(events: CarafeEvent[], pieces: EventPieces[], maxRules = 12, context: SignalContext = buildSignalContext(events, pieces)): KeyMoment[] {
  const candidates: Candidate[] = [];
  for (const block of context.blocks) {
    if (!block.userLine) continue;
    const userText = stripRolePrefix(block.userLine);
    if (isAck(userText)) continue;
    for (const raw of userText.split(/[.!\n]+/)) {
      const sentence = raw.trim();
      if (sentence.length < 15 || sentence.length > 200 || !NORMATIVE_RE.test(sentence) || FEELING_RE.test(sentence)) continue;
      candidates.push({ seq: block.startSeq, text: sentence, normalized: normalizeSentence(sentence) });
    }
  }

  const groups: Candidate[][] = [];
  for (const candidate of candidates) {
    const group = groups.find((members) => members.some((member) => member.normalized === candidate.normalized || tokenJaccard(member.normalized, candidate.normalized) >= 0.6));
    if (group) group.push(candidate);
    else groups.push([candidate]);
  }

  return groups
    .filter((members) => new Set(members.map((member) => member.seq)).size >= 2 || members.some((member) => STRONG_RE.test(member.text)))
    .sort((a, b) => b.length - a.length || a[0]!.seq - b[0]!.seq)
    .slice(0, maxRules)
    .map((members) => {
      const seqs = [...new Set(members.map((member) => member.seq))].sort((a, b) => a - b);
      const note = seqs.length >= 2 ? `restated ×${members.length} (seq ${seqs.join(", ")})` : "stated as a standing rule";
      return { kind: "rule", seq: seqs[0]!, endSeq: seqs.length >= 2 ? seqs.at(-1) : undefined, text: members[0]!.text, note } satisfies KeyMoment;
    });
}
