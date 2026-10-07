/**
 * Layer 2 — section retrieval over a stored session. This is what the layered
 * handoff hands the receiving agent the keys to, and it's the seed of
 * corpus-wide search (Priority 3): same engine, session-scoped.
 */
import { CarafeStore } from "../format/store";
import { readSession } from "../format/sessions";
import { findSession } from "./sessions";
import { extractPieces } from "../handoff/pieces";
import { readSessionIndexDocs, sessionIndexFreshness } from "../search/session-index";

export function runShow(id: string, opts: { seq?: string; thinking?: boolean; maxChars?: number } = {}): void {
  const store = new CarafeStore();
  const d = findSession(store, id);
  if (!d) { console.error(`no session "${id}". try: carafe list`); process.exit(1); }
  let [a, b] = [0, Number.MAX_SAFE_INTEGER];
  if (opts.seq) {
    const m = opts.seq.match(/^(\d+)-(\d+)$/);
    if (!m) { console.error(`--seq wants A-B (e.g. 120-180)`); process.exit(1); }
    a = Number(m[1]); b = Number(m[2]);
  }
  const events = readSession(store, d.tool, d.sessionId).filter((e) => e.seq >= a && e.seq <= b);
  const hits: Record<string, number> = {};
  // `show` is the thing every clip marker points at: it must never clip again.
  // --max-chars is the only cap here, and it is the caller's.
  const pieces = extractPieces(events, { includeThinking: opts.thinking, resultCap: Infinity }, hits);
  const maxChars = opts.maxChars ?? 60_000;
  if (!Number.isFinite(maxChars) || maxChars < 0) { console.error(`--max-chars wants a non-negative number`); process.exit(1); }
  console.log(`# ${d.title ?? d.sessionId} — seq ${a}${b === Number.MAX_SAFE_INTEGER ? "→end" : `-${b}`}\n`);
  let printedChars = 0;
  let shown = 0;
  let lastShown = events[0]?.seq ?? a;
  for (const p of pieces) {
    const eventText = p.lines.map((line) => `[${p.seq}] ${line}`).join("\n\n");
    const outputChars = eventText ? eventText.length + 1 : 0;
    if (maxChars > 0 && printedChars + outputChars > maxChars) {
      const first = events[0]?.seq ?? a;
      const notice = `…output capped at ${maxChars} chars: ${shown} of ${events.length} events in range shown (seq ${first}–${lastShown}) — narrow --seq or pass --max-chars N`;
      console.error(notice);
      console.log(notice);
      return;
    }
    if (eventText) console.log(eventText);
    printedChars += outputChars;
    shown++;
    lastShown = p.seq;
  }
}

export function runGrep(id: string, pattern: string, opts: { limit?: number; deep?: boolean } = {}): void {
  const store = new CarafeStore();
  const d = findSession(store, id);
  if (!d) { console.error(`no session "${id}". try: carafe list`); process.exit(1); }
  const limit = opts.limit ?? 40;
  let re: RegExp;
  try { re = new RegExp(pattern, "i"); } catch { console.error(`bad pattern`); process.exit(1); }
  if (!opts.deep && sessionIndexFreshness(store, d) === "fresh") {
    try {
      let shown = 0, total = 0, matchedTruncatedBlock = false;
      for (const block of readSessionIndexDocs(store, d)) {
        let matchedBlock = false;
        for (const line of block.body.split("\n")) {
          if (!re.test(line)) continue;
          matchedBlock = true;
          total++;
          if (shown < limit) {
            const idx = line.search(re);
            const snip = line.slice(Math.max(0, idx - 60), idx + 120).replace(/\n/g, " ");
            console.log(`seq ${block.startSeq}-${block.endSeq} [block]  …${snip}…`);
            shown++;
          }
        }
        if (matchedBlock && block.truncated) matchedTruncatedBlock = true;
      }
      printGrepSummary(d.sessionId, total, shown);
      if (matchedTruncatedBlock) console.log(`some blocks were truncated in the index; rerun with --deep for the full trace`);
      return;
    } catch { /* an unreadable index is a fallback, never a reason for grep to fail */ }
  }
  if (!opts.deep) console.error(`note: no fresh index for ${id}; scanning the full trace (slow on big sessions; carafe index ${id} builds one)`);
  const events = readSession(store, d.tool, d.sessionId);
  const hits: Record<string, number> = {};
  const pieces = extractPieces(events, {}, hits);
  let shown = 0, total = 0;
  for (const p of pieces) {
    for (const line of p.lines) {
      if (!re.test(line)) continue;
      total++;
      if (shown < limit) {
        const idx = line.search(re);
        const snip = line.slice(Math.max(0, idx - 60), idx + 120).replace(/\n/g, " ");
        console.log(`seq ${p.seq} [${p.kind}]  …${snip}…`);
        shown++;
      }
    }
  }
  printGrepSummary(d.sessionId, total, shown);
}

function printGrepSummary(sessionId: string, total: number, shown: number): void {
  console.log(`\n${total} match(es)${total > shown ? ` (showing ${shown} — narrow the pattern or raise --limit)` : ""}`);
  if (total > 0) console.log(`read a section:  carafe show ${sessionId} --seq A-B`);
}
