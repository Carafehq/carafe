/**
 * Standing instructions — the short, general orders an owner repeats across a
 * session ("never commit without asking", "plain english"). They are the rules
 * a receiving agent breaks first, and a steering index buries them among the
 * one-line steers. Extraction only: the owner's own words, deduplicated.
 */
import type { CarafeEvent } from "../format/events";
import type { EventPieces } from "../handoff/pieces";
import type { KeyMoment } from "./extract";
import { buildSignalContext, normalizeSentence, stripRolePrefix, type SignalContext } from "./signals";
import { splitSentences, cleanSentence } from "./sentences";

export const INSTRUCTION_MAX_CHARS = 240;
export const INSTRUCTIONS_IN_HANDOFF = 15;

const INSTRUCTION_RE = /\bnever\b|\balways\b|\bdo not\b|\bdon['’]t\b|\bstop doing\b|\bfrom now on\b|\bevery time\b|\bplain english\b|\bask (?:me )?(?:first|before)\b|\btell me before\b/i;
// An order about one file, one commit or one link is an instruction for that
// thing, not a standing rule — and a standing rule is what this section claims.
const SPECIFIC_RE = /https?:\/\/|\b[\w~.-]*\/[\w.-]+|\b[\w-]+\.(?:ts|tsx|js|jsx|json|md|py|rs|go|java|rb|sh|yml|yaml|toml|html|css|sql)\b|\b[0-9a-f]{7,40}\b/i;

// A line inside a long turn is a PASTE — a review document, a spec, somebody
// else's writing quoted for comment. A standing rule is something the owner
// typed, short, as an order; that is the only shape this section may claim.
const MARKDOWN_START_RE = /^(?:[#>*\-`]|\d+[.)])/;
// "I never remember", "we don't understand" — a feeling, not an order. The
// pronoun binds when it sits just before the matched word.
const FIRST_PERSON_NEAR = 12;

/**
 * Text a harness put inside a "user" turn: a tool result, a task notification,
 * a system reminder, a delegating brief. None of it was typed by the owner.
 *
 * v6 round 1: the Do not section came back with 164 entries and 24 KB of a
 * 90 KB budget, and its contents were helper-agent task prompts ("Do NOT
 * deploy.", "TASK: git fetch origin … do NOT rebase"), review documents and
 * assistant prose — quoted as the owner's words, 89 of them claiming to have
 * been said after an incident.
 */
const INJECTED_RE = /<system-reminder|<\/system-reminder>|<tool_use_error|<local-command|<command-name|<command-message|\[Request interrupted|^\s*Caveat:|^\s*⤷|^\s*(?:TASK|RULES|CONTEXT|GOAL|SCOPE|BRIEF|DELIVERABLE|CONSTRAINTS)\s*:/im;

export function isInjectedTurn(turn: string): boolean {
  return INJECTED_RE.test(turn);
}

/**
 * The screen v2 wrote for standing instructions, shared.
 *
 * A paste, a markdown heading, a bolded quotation, a question and a feeling
 * are not orders. `turnCap` is the only thing the two callers differ on: a
 * standing RULE is short, a typed prohibition may sit inside a slightly longer
 * message, and past `PROHIBITION_TURN_CHARS` it is a brief or a paste either
 * way. There is exactly one of these screens on purpose — round 1 asked for
 * the second one not to be written.
 */
export function isTypedOrderLine(line: string, wholeTurn: string, match: RegExpExecArray | null, turnCap: number): boolean {
  const text = line.trim();
  if (!match || !text || text.length >= INSTRUCTION_MAX_CHARS) return false;
  if (wholeTurn.trim().length >= turnCap) return false;
  if (isInjectedTurn(wholeTurn)) return false;
  if (MARKDOWN_START_RE.test(text) || text.includes("**")) return false;
  if (text.endsWith("?")) return false;
  const before = text.slice(Math.max(0, match.index - FIRST_PERSON_NEAR), match.index);
  return !/\b(?:i|we)\b/i.test(before);
}

export function isStandingInstruction(line: string, wholeTurn: string = line): boolean {
  const text = line.trim();
  if (!isTypedOrderLine(text, wholeTurn, INSTRUCTION_RE.exec(text), INSTRUCTION_MAX_CHARS)) return false;
  return !SPECIFIC_RE.test(text);
}

/* ------------------------------------------------------------------ *
 * v6/V4 — the owner's prohibitions.
 *
 * Round 6: "never talk to production chat to test it" was said in this session
 * and appeared nowhere in the handoff — it was one line among fifteen standing
 * instructions, and the standing instructions sat below the notes. A receiving
 * agent breaks a prohibition before it breaks anything else, so the things it
 * must not do get their own section, directly under the newest recap, ordered by
 * how expensively they were learned.
 * ------------------------------------------------------------------ */

/** The words that make a sentence a prohibition. */
export const PROHIBITION_RE = /\bnever\b|\bdo not\b|\bdon['’]t\b|\bmust not\b|\bstop\s|\bno more\b/i;
/** …and how many the section prints, HARD, after ranking. */
export const PROHIBITIONS_IN_HANDOFF = 8;
/** How many turns after an incident a sentence still counts as said after it. */
export const INCIDENT_TURNS = 3;
/** A user turn longer than this is a brief, a paste or a document — not a rule
 *  somebody typed at a prompt. */
export const PROHIBITION_TURN_CHARS = 600;
/** How many of the section's entries may be the assistant quoting its own rule. */
export const ASSISTANT_RULES_MAX = 3;

export interface Prohibition {
  text: string;
  seq: number;
  /** the seq of the dead end or failed call this was said within three turns of */
  incidentSeq?: number;
  /** true when the assistant — not the owner — stated the rule */
  assistant?: boolean;
}

/* ------------------------------------------------------------------ *
 * v6 round 2 — a prohibition is an IMPERATIVE CLAUSE, not a word.
 *
 * Matching the word alone put four sentences under "Do not" that forbid
 * nothing: a complaint ("…you never presented them"), an instruction to CARRY
 * ON ("…and don't stop until the work is done"), and two pieces of narration
 * ("production never blinked", "the contract (code verifies, never speaks)").
 * What the four real prohibitions share is grammar: the word OPENS a clause.
 * ------------------------------------------------------------------ */

/** Every prohibition word in a sentence, not just the first: `don't stop` is
 *  not one, and the `stop` inside it is not a second chance. */
const PROHIBITION_GLOBAL_RE = /\bnever\b|\bdo not\b|\bdon['’]t\b|\bmust not\b|\bstop\s|\bno more\b/gi;
/** What may sit immediately before the word and still leave it opening a clause. */
const CLAUSE_BOUNDARY_RE = /[,;:—–\-(]$/;
const COORDINATORS = new Set(["and", "but", "so", "then", "also", "please", "plus", "or"]);
/**
 * `don't stop`, `never hesitate`, `don't worry` — the same words, used to push
 * somebody on rather than hold them back. A handoff that files these under
 * "Do not" tells the next agent the opposite of what was said.
 */
const ENCOURAGEMENT_RE = /^\s*(?:stop|hesitate|worry|forget|be afraid|give up)\b/i;

/** True when the character at `index` sits inside an unclosed `(`. */
export function insideParenthetical(text: string, index: number): boolean {
  let depth = 0;
  for (let at = 0; at < index; at++) {
    if (text[at] === "(") depth++;
    else if (text[at] === ")" && depth > 0) depth--;
  }
  return depth > 0;
}

/** True when the prohibition word at `index` opens a clause rather than
 *  following its subject. */
export function opensClause(text: string, index: number): boolean {
  const before = text.slice(0, index).replace(/\s+$/, "");
  if (!before) return true;                                  // the sentence starts here
  if (CLAUSE_BOUNDARY_RE.test(before)) return true;          // directly after a boundary
  const word = /([A-Za-z'’]+)$/.exec(before)?.[1]?.toLowerCase();
  return word != null && COORDINATORS.has(word);             // …or after a coordinator
}

/**
 * The grammar test, shared by the owner's sentences and the assistant's rules.
 * `mustOpenSentence` is the assistant's stricter form: its rule has to BE the
 * sentence, not a clause somewhere inside a paragraph about something else.
 */
export function prohibitionClause(text: string, mustOpenSentence = false): { index: number } | null {
  const line = text.trim();
  PROHIBITION_GLOBAL_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = PROHIBITION_GLOBAL_RE.exec(line)) !== null) {
    const index = match.index;
    if (mustOpenSentence ? index !== 0 : !opensClause(line, index)) continue;
    // narration about how something behaves, parked in a parenthesis
    if (insideParenthetical(line, index)) continue;
    // "don't stop", "never hesitate" — an encouragement, not a prohibition
    if (ENCOURAGEMENT_RE.test(line.slice(index + match[0].length))) continue;
    return { index };
  }
  return null;
}

/**
 * An owner sentence that forbids something: the shared typed-order screen, the
 * prohibition words, the longer turn cap, and the clause test.
 */
export function isProhibitionSentence(text: string, wholeTurn: string = text, mustOpenSentence = false): boolean {
  const line = text.trim();
  const clause = prohibitionClause(line, mustOpenSentence);
  if (!clause) return false;
  // the shared screen wants the match it is judging the context of
  return isTypedOrderLine(line, wholeTurn, { index: clause.index } as RegExpExecArray, PROHIBITION_TURN_CHARS);
}

/**
 * Every prohibition this session recorded, in the order a reader needs them:
 * the ones said within three turns of something going wrong first — those were
 * paid for — then the rest, newest first.
 *
 * The assistant's own sentences qualify only when they state a rule AND say
 * why: a prohibition with no reason attached, in the voice of the agent rather
 * than the owner, is the agent quoting itself.
 */
export function detectProhibitions(
  events: CarafeEvent[],
  pieces: EventPieces[],
  context: SignalContext = buildSignalContext(events, pieces),
  hasCause: (sentence: string) => boolean = () => false,
): Prohibition[] {
  // where something went wrong: a failed tool call, and the block it sat in
  const incidents: Array<{ seq: number; blockIndex: number }> = context.runs
    .filter((run) => run.failed)
    .map((run) => ({ seq: run.toolSeq, blockIndex: run.blockIndex }));
  const incidentFor = (blockIndex: number): number | undefined => {
    let best: number | undefined;
    for (const incident of incidents) {
      if (incident.blockIndex > blockIndex) continue;
      if (blockIndex - incident.blockIndex > INCIDENT_TURNS) continue;
      if (best == null || incident.seq > best) best = incident.seq;
    }
    return best;
  };

  const found: Prohibition[] = [];
  const seen = new Set<string>();
  const offer = (text: string, seq: number, blockIndex: number, assistant: boolean): void => {
    const clean = text.replace(/\s+/g, " ").trim();
    const key = normalizeSentence(clean);
    if (!key || seen.has(key)) return;
    seen.add(key);
    const incidentSeq = incidentFor(blockIndex);
    found.push({ text: clean, seq, ...(incidentSeq != null ? { incidentSeq } : {}), ...(assistant ? { assistant: true } : {}) });
  };

  for (const [blockIndex, block] of context.blocks.entries()) {
    // The owner's words: a HUMAN-TYPED user turn, anchored to the event that
    // actually carries them — a block's startSeq is the turn's first event, and
    // quoting a sentence under a seq whose text does not contain it is a false
    // statement by carafe's own standard.
    if (block.userLine && block.userSeq != null) {
      const turn = stripRolePrefix(block.userLine);
      for (const raw of turn.split("\n")) {
        const line = raw.trim();
        if (!line) continue;
        const candidates = isProhibitionSentence(line, turn)
          ? [line]
          : splitSentences(line).map(cleanSentence).filter((sentence) => isProhibitionSentence(sentence, turn));
        for (const candidate of candidates) offer(candidate, block.userSeq, blockIndex, false);
      }
    }
    for (const said of block.assistantLines) {
      for (const raw of splitSentences(stripRolePrefix(said.text))) {
        const sentence = cleanSentence(raw);
        // the assistant's rule has to BE the sentence: a prohibition word in a
        // later clause is the agent describing something, not stating a rule
        if (!isProhibitionSentence(sentence, sentence, true) || !hasCause(sentence)) continue;
        offer(sentence, said.seq, blockIndex, true);
      }
    }
  }

  // said after an incident first, newest first; then the rest, newest first
  const rank = (one: Prohibition): number => (one.incidentSeq != null ? 0 : 1);
  const ordered = found.sort((a, b) => rank(a) - rank(b) || b.seq - a.seq);
  // the assistant quoting its own rules is a footnote, never the section
  const owner = ordered.filter((one) => !one.assistant);
  const theirs = ordered.filter((one) => one.assistant).slice(0, ASSISTANT_RULES_MAX);
  return [...owner, ...theirs]
    .sort((a, b) => rank(a) - rank(b) || b.seq - a.seq)
    .slice(0, PROHIBITIONS_IN_HANDOFF);
}

export function detectInstructions(events: CarafeEvent[], pieces: EventPieces[], context: SignalContext = buildSignalContext(events, pieces)): KeyMoment[] {
  const moments: KeyMoment[] = [];
  const seen = new Set<string>();
  for (const block of context.blocks) {
    if (!block.userLine) continue;
    const turn = stripRolePrefix(block.userLine);
    for (const raw of turn.split("\n")) {
      const line = raw.trim();
      if (!isStandingInstruction(line, turn)) continue;
      const key = normalizeSentence(line);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      moments.push({ kind: "instruction", seq: block.startSeq, text: line.replace(/\s+/g, " ").trim() });
    }
  }
  return moments;
}
