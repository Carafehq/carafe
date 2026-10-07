/**
 * W4 — time passes.
 *
 * "The arrangement you set up runs until 2 pm today" was quoted as a live open
 * question four days after that Sunday. A quoted sentence carries no date of
 * its own, so the file must put one on it: every ask, instruction and recap
 * gets `[seq S, <date> UTC, N d before the end]`, and a sentence that speaks
 * about a day or a clock time and is older than 48 hours says it may have
 * lapsed. That is the whole inference — nothing guesses whether it DID.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
export const LAPSE_MS = 48 * HOUR;

/** Words that make a sentence about a particular day or hour. */
const TIME_BOUND_RE = /\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|today|tonight|tomorrow|this week|until|by \d{1,2}\s*(?:am|pm)\b|by (?:noon|midnight)\b)\b|\b\d{1,2}(?::\d{2})?\s*(?:am|pm)\b|\b\d{1,2}:\d{2}\b/i;

export function isTimeBound(text: string): boolean {
  return TIME_BOUND_RE.test(text);
}

export function tsIndex(events: Array<{ seq: number; ts?: string | null }>): Map<number, string | null> {
  return new Map(events.map((event) => [event.seq, event.ts ?? null]));
}

const stamp = (ts: string): string => `${ts.slice(0, 10)} ${ts.slice(11, 16)} UTC`;

/** "4 d", "3 h", "12 min" — how long before the session's end this was said. */
export function beforeEnd(ms: number): string {
  if (ms < HOUR) return `${Math.max(0, Math.round(ms / MINUTE))} min`;
  if (ms < 2 * DAY) return `${Math.round(ms / HOUR)} h`;
  return `${Math.round(ms / DAY)} d`;
}

/**
 * The anchor a quoted line carries: `[seq 4012, 2026-09-13 09:12 UTC, 4 d
 * before the end]`. When the trace recorded no timestamp, the seq alone — a
 * date carafe does not have is never invented.
 */
export function anchor(seq: number, tsBySeq: Map<number, string | null>, endTs: string | null | undefined): string {
  const ts = tsBySeq.get(seq) ?? null;
  if (!ts || ts.length < 16) return `[seq ${seq}]`;
  const end = endTs ? Date.parse(endTs) : NaN;
  const at = Date.parse(ts);
  if (!Number.isFinite(end) || !Number.isFinite(at)) return `[seq ${seq}, ${stamp(ts)}]`;
  return `[seq ${seq}, ${stamp(ts)}, ${beforeEnd(Math.max(0, end - at))} before the end]`;
}

/** The suffix a time-bound sentence older than 48 h carries, or "". */
export function lapseSuffix(text: string, seq: number, tsBySeq: Map<number, string | null>, endTs: string | null | undefined): string {
  if (!isTimeBound(text)) return "";
  const ts = tsBySeq.get(seq) ?? null;
  const end = endTs ? Date.parse(endTs) : NaN;
  const at = ts ? Date.parse(ts) : NaN;
  if (!Number.isFinite(end) || !Number.isFinite(at) || end - at < LAPSE_MS) return "";
  return ` (said ${ts!.slice(0, 10)}; may have lapsed)`;
}
