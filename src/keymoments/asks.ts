/**
 * Open asks — the questions the assistant put to the owner and never got an
 * answer to. They are the "what's next" of a session: the work stopped there
 * and nothing in the trace restarted it. Extraction only, verbatim,
 * seq-anchored; an ask is closed the moment a turn that could answer it does.
 *
 * Three things a first version got wrong, all from a real 38,026-event session:
 * the real asks sat 40+ turns from the end (the window was too short), the
 * decisive one never ended in a question mark ("…or keep the loading states
 * separate since it's mostly frontend."), and "Want me to?" from a detour into
 * another repository was listed as if it were the owner's next decision.
 */
import type { CarafeEvent } from "../format/events";
import type { EventPieces } from "../handoff/pieces";
import type { KeyMoment } from "./extract";
import { isRecapRequest } from "./recap";
import { buildSignalContext, clip, stripRolePrefix, type SignalContext } from "./signals";

/** The window: the last 72 hours of the session, and never fewer than this many
 *  turns. A turn count alone reached back eight days on a real session. */
export const ASK_TURNS_SCANNED = 10;
export const ASK_RECENT_MS = 72 * 60 * 60 * 1000;
export const OPEN_ASKS_IN_HANDOFF = 5;
/** The asking sentence alone is a fragment ("Or leave it with Rook. Your
 *  call…"): two sentences before it carry the subject. */
export const ASK_TEXT_CHARS = 500;
export const ASK_LEAD_SENTENCES = 2;
/** W5: a quote that still opens on a fragment takes one more sentence, and a
 *  wider cap to hold it. */
export const ASK_EXTENDED_CHARS = 600;
/** How much of one ask has to reappear in another for them to be the same ask. */
export const ASK_OVERLAP_CHARS = 80;
export const ASK_OPTION_LINES = 6;
/** W4: how much of the user turn an ask hangs off is inlined under it. */
export const ANTECEDENT_CHARS = 300;
/** …and how far back a pronoun ask may look for one before it is dropped. */
export const ANTECEDENT_TURNS = 3;
/** An ask that OPENS on one of these says nothing on its own: "Want me to have
 *  Rook spec them as one piece of work" — spec what? */
const PRONOUN_OPENING_RE = /^(?:them|it|that|these)\b/i;

/**
 * The END of a turn, not its beginning: an ask hangs off the sentence right
 * before it, and a 900-character paste rendered from the front shows the reader
 * the paragraph's opening — which is the part the question is NOT about.
 */
export function tailOf(text: string, cap: number): string {
  if (text.length <= cap) return text;
  const sentences = text.match(/[^.!?]+[.!?]?/g) ?? [text];
  const kept: string[] = [];
  let chars = 0;
  for (let index = sentences.length - 1; index >= 0; index--) {
    const sentence = sentences[index]!.trim();
    if (!sentence) continue;
    if (chars + sentence.length + 1 > cap && kept.length) break;
    chars += sentence.length + 1;
    kept.unshift(sentence);
  }
  const text2 = kept.join(" ").trim();
  // one sentence longer than the whole cap: keep its ending
  return `…${(text2 || text).slice(-cap).trim()}`;
}

/** A question aimed at the owner, not at the model's own reasoning. */
const OWNER_RE = /\byou\b|\byour\b|\bshall\b|\bshould I\b|\bdo you want\b|\bwhich\b|\bsay the word\b|\byour call\b/i;
/** An ask does not need a question mark: these openings ARE the question. */
const ASK_OPENING_RE = /^(?:do you want\b|would you like\b|should I\b|shall I\b|which (?:one|of|do)\b|your call\b|say the word\b|if you want\b|on your word\b)/i;
/** …and neither does an alternative put to the owner. */
const ASK_ALTERNATIVE_RES = [/\bwould you like\b[\s\S]*?\bor\b/i, /\bone piece of work,\s*or\b/i, /\beither\b[\s\S]*?\bor\b/i];
/** The shapes an options list starts with. */
const OPTION_LINE_RE = /^(?:\(?[a-d]\)|\d+[.)]|Option\s+[A-D]\b)/i;
/** A line of a list is never the sentence that asks: a paragraph of bullets is
 *  a summary of what was done, however many "you"s it contains. */
const LIST_MARKER_RE = /^(?:[-*•]|\d+[.)])\s/;
const BULLETS_MAKE_A_LIST = 3;
const ANSWER_TOKEN_RE = /^(?:yes|no|go|ok|okay|push|approve|approved|proceed|park|continue|do it|option [a-d]|[1-9])$/i;
/**
 * A turn that cannot answer anything: it asks for a status report, or it asks
 * for this very handoff. "Give me two handoffs" does not settle the question
 * asked above it — it is the reason the question is being handed over.
 */
const NOT_AN_ANSWER_RE = /\bcarafe\s+(?:handoff|key-moments)\b|\bhand (?:this|it) off\b|\bhandoffs?\b|\bspin (?:this |it )?off\b|\b(?:write|draft|make|do|give me|prepare)\b[^.\n]{0,40}\bbrief\b/i;

/** The whole turn as the answer matcher sees it: lowercased, punctuation off. */
export function answerKey(userText: string): string {
  return stripRolePrefix(userText).replace(/[\p{P}\p{S}]/gu, " ").replace(/\s+/g, " ").trim().toLowerCase();
}

/** A turn that could not be an answer to anything, whatever words it shares. */
export function cannotAnswer(userText: string): boolean {
  const text = stripRolePrefix(userText);
  return isRecapRequest(text) || NOT_AN_ANSWER_RE.test(text);
}

function contentWords(text: string): Set<string> {
  return new Set((text.toLowerCase().match(/[\p{L}]{5,}/gu) ?? []));
}

/** An ask is answered when the next turn that CAN answer says yes/no/pick, or
 *  speaks about the same thing (a shared content word of five or more letters). */
export function isAnswer(askSentence: string, nextUserText: string | null): boolean {
  if (nextUserText == null) return false;
  const key = answerKey(nextUserText);
  if (!key) return false;
  if (ANSWER_TOKEN_RE.test(key)) return true;
  const askWords = contentWords(askSentence);
  for (const word of contentWords(key)) if (askWords.has(word)) return true;
  return false;
}

/** Each sentence with where it sits in `text`, so a quote can be cut from the
 *  text itself rather than rebuilt from the pieces. */
function sentencesOf(text: string): Array<{ text: string; start: number; end: number }> {
  const out: Array<{ text: string; start: number; end: number }> = [];
  for (const match of text.matchAll(/[^.!?\n]+[.!?]?/g)) {
    const raw = match[0];
    const lead = raw.length - raw.trimStart().length;
    const sentence = raw.trim();
    if (sentence) out.push({ text: sentence, start: match.index! + lead, end: match.index! + lead + sentence.length });
  }
  return out.length ? out : text.trim() ? [{ text: text.trim(), start: text.indexOf(text.trim()), end: text.indexOf(text.trim()) + text.trim().length }] : [];
}

export function isAskSentence(sentence: string): boolean {
  const text = sentence.trim();
  if (!text || LIST_MARKER_RE.test(text)) return false;
  if (text.endsWith("?")) return true;
  if (ASK_OPENING_RE.test(text)) return true;
  return OWNER_RE.test(text) && ASK_ALTERNATIVE_RES.some((re) => re.test(text));
}

/**
 * A paragraph that is mostly bullets is a report, not a question. Numbered
 * lines are NOT counted: "1. / 2. / 3." under a question is the options list
 * the question offers, and a numbered line that is really a report sentence is
 * already rejected by `isAskSentence`'s own list-marker rule.
 */
/** A quote that opens on one of these is hanging off the sentence before it. */
const LEADING_FRAGMENT_RE = /^(?:or|and|them|it|that)\b/;

const PROSE_BULLET_RE = /^[-*•]\s/;
function isBulletList(paragraph: string): boolean {
  return paragraph.split("\n").filter((line) => PROSE_BULLET_RE.test(line.trim())).length >= BULLETS_MAKE_A_LIST;
}

/**
 * The ask: the sentence that asks, and the one before it — which is where the
 * two options usually get their meaning — never the whole paragraph, and never
 * the option lines, which are rendered under it.
 */
function askOf(text: string): { quote: string; options: string[] } | null {
  const plain = stripRolePrefix(text);
  const paragraphs = plain.split(/\n\s*\n/);
  for (let index = paragraphs.length - 1; index >= 0; index--) {
    const paragraph = paragraphs[index]!;
    if (isBulletList(paragraph)) continue;
    const sentences = sentencesOf(paragraph).filter((sentence) => !OPTION_LINE_RE.test(sentence.text));
    const askAt = sentences.map((sentence, position) => (isAskSentence(sentence.text) ? position : -1)).filter((position) => position >= 0).at(-1);
    if (askAt == null) continue;
    // the quote is the owner-facing text AS WRITTEN, from the first lead
    // sentence to the end of the ask. Rejoining the split sentences printed
    // `github. com`, `Apache-2.` for "Apache-2.0." and `**Who speaks first. **`
    // under a heading that says verbatim.
    const take = (lead: number): string => paragraph.slice(sentences[Math.max(0, askAt - lead)]!.start, sentences[askAt]!.end).replace(/\s+/g, " ").trim();
    let quote = take(ASK_LEAD_SENTENCES);
    let cap = ASK_TEXT_CHARS;
    // "or keep the flag." with two sentences already in front of it is still a
    // fragment: the subject is one sentence further back.
    if (LEADING_FRAGMENT_RE.test(quote) && askAt - ASK_LEAD_SENTENCES > 0) {
      quote = take(ASK_LEAD_SENTENCES + 1);
      cap = ASK_EXTENDED_CHARS;
    }
    const options = paragraphs.slice(index).join("\n").split("\n").map((line) => line.trim())
      .filter((line) => OPTION_LINE_RE.test(line)).slice(0, ASK_OPTION_LINES);
    return { quote: clip(quote, cap), options };
  }
  return null;
}

export interface OpenAskOpts {
  /** per-turn principal-work flags: asks from a tangent are not the owner's next decision */
  belongs?: boolean[];
  /** the session's end, for the 72-hour window */
  endTs?: string | null;
}

/**
 * Every question in the window that the owner never answered, oldest first.
 * Deliberately NOT part of `extractMoments`: the sealed MomentsBench scores
 * every moment in that set, and a section only the handoff renders must not
 * move one of its counts.
 */
export function detectOpenAsks(
  events: CarafeEvent[],
  pieces: EventPieces[],
  context: SignalContext = buildSignalContext(events, pieces),
  opts: OpenAskOpts = {},
): KeyMoment[] {
  const blocks = context.blocks;
  if (!blocks.length) return [];
  const tsBySeq = new Map(events.map((event) => [event.seq, event.ts ?? null]));
  const endMs = Date.parse(opts.endTs ?? events.at(-1)?.ts ?? "");
  // the last 72 hours, extended backwards only far enough to hold ten turns
  const byTurns = Math.max(0, blocks.length - ASK_TURNS_SCANNED);
  let byTime = byTurns;
  if (Number.isFinite(endMs)) {
    byTime = blocks.length;
    for (let index = 0; index < blocks.length; index++) {
      const started = Date.parse(tsBySeq.get(blocks[index]!.startSeq) ?? "");
      if (Number.isFinite(started) && endMs - started <= ASK_RECENT_MS) { byTime = index; break; }
    }
  }
  const from = Math.min(byTurns, byTime);

  const userTurns = blocks.map((block) => block.userLine);
  const moments: KeyMoment[] = [];
  for (let index = from; index < blocks.length; index++) {
    if (opts.belongs?.[index] === false) continue;
    const block = blocks[index]!;
    for (const reply of block.assistantLines) {
      const ask = askOf(reply.text);
      if (!ask) continue;
      // the first turn after it that could answer at all
      let answer: string | null = null;
      for (let next = index + 1; next < blocks.length; next++) {
        const line = userTurns[next];
        if (!line || cannotAnswer(line)) continue;
        answer = line;
        break;
      }
      if (isAnswer(ask.quote, answer)) continue;
      // W4 — the ask carries the turn it answers. A question that opens on a
      // bare pronoun with nothing to bind it to is not handed over at all.
      let antecedent: { text: string; seq: number } | undefined;
      for (let back = index; back > index - ANTECEDENT_TURNS && back >= 0; back--) {
        const line = userTurns[back];
        if (!line) continue;
        const text = tailOf(stripRolePrefix(line).replace(/\s+/g, " ").trim(), ANTECEDENT_CHARS);
        if (!text) continue;
        antecedent = { text, seq: blocks[back]!.startSeq };
        break;
      }
      if (!antecedent && PRONOUN_OPENING_RE.test(ask.quote.trim())) continue;
      moments.push({
        kind: "openask",
        seq: reply.seq,
        text: ask.quote,
        ...(antecedent ? { antecedent } : {}),
        ...(ask.options.length ? { options: ask.options } : {}),
      });
    }
  }
  return dedupeAsks(moments);
}

/** The same question asked twice — a re-ask, or a paragraph quoted again with
 *  one more sentence in front of it — is one open ask: keep the newest. */
export function dedupeAsks(moments: KeyMoment[]): KeyMoment[] {
  const head = (text: string): string => text.slice(0, ASK_OVERLAP_CHARS);
  const kept: KeyMoment[] = [];
  for (const moment of [...moments].sort((a, b) => b.seq - a.seq)) {
    if (kept.some((other) => other.text.includes(head(moment.text)) || moment.text.includes(head(other.text)))) continue;
    kept.push(moment);
  }
  return kept.sort((a, b) => a.seq - b.seq);
}
