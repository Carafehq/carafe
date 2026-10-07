/**
 * carafe search — corpus-wide "where was X discussed / decided" across every
 * session and both tools. FTS ranking by default; --deep escalates into full
 * traces (grep across sessions) when you need the exact line, not just the session.
 */
import { CarafeStore } from "../format/store";
import { SearchIndex } from "../search/index";
import { currentSession, findSession, latestSession, listSessions } from "../query/sessions";
import { readSession } from "../format/sessions";
import { extractPieces } from "../handoff/pieces";
import { SessionIndex } from "../search/session-index";

const TAG: Record<string, string> = { "claude-code": "CC", codex: "CX" };

export function runSearch(query: string, opts: { limit?: number; tool?: string; deep?: boolean; all?: boolean; session?: string } = {}): void {
  const store = new CarafeStore();
  if (opts.session) return sessionSearch(store, query, opts.session, opts.limit);
  if (opts.deep) return deepSearch(store, query, opts);

  const idx = new SearchIndex(store);
  if (idx.isStale()) { process.stderr.write("indexing… "); const r = idx.reindex(); process.stderr.write(`${r.indexed} updated / ${r.total} sessions\n`); }
  const hits = idx.search(query, { limit: opts.limit, tool: opts.tool, includeSidechain: opts.all });
  idx.close();

  if (!hits.length) { console.log(`no sessions match "${query}". try --deep for a line-level search across full traces.`); return; }
  console.log(`${hits.length} sessions match "${query}" (ranked):\n`);
  for (const h of hits) {
    const when = (h.endTs ?? "").slice(0, 10);
    const snip = h.snippet.replace(/\s+/g, " ").trim().slice(0, 130);
    console.log(`  ${TAG[h.tool] ?? h.tool}  ${when}  ${h.sessionId.slice(0, 10)}  ${(h.title ?? "").slice(0, 56)}`);
    if (snip) console.log(`        …${snip}…`);
  }
  console.log(`\nopen the trace:  carafe show <id>   ·   hand it off:  carafe handoff <id>`);
}

function sessionSearch(store: CarafeStore, query: string, sessionArg: string, limit?: number): void {
  const d = sessionArg === "latest"
    ? latestSession(store)
    : sessionArg === "current"
      ? currentSession(store)
      : findSession(store, sessionArg);
  if (!d) { console.error(`session not found: ${sessionArg}`); process.exit(1); }

  const index = new SessionIndex(store, d);
  index.reindex();
  const hits = index.search(query, { limit: limit ?? 12 });
  index.close();

  if (!hits.length) {
    console.log(`no turns in ${d.sessionId} match "${query}". try carafe grep ${d.sessionId} "<pattern>" for an exact line.`);
    return;
  }
  for (const hit of hits) {
    const snippet = hit.snippet.replace(/\s+/g, " ").trim();
    console.log(`[seq ${hit.startSeq}–${hit.endSeq}]  ${hit.firstLine}${snippet ? `  …${snippet}…` : ""}`);
  }
  const first = hits[0]!;
  console.log(`\nread one: carafe show ${d.sessionId} --seq ${first.startSeq}-${first.endSeq}`);
}

/** Deep escalation: line-level grep across every session's full trace. Slower, exact. */
function deepSearch(store: CarafeStore, query: string, opts: { limit?: number; tool?: string; all?: boolean }): void {
  let re: RegExp;
  try { re = new RegExp(query, "i"); } catch { console.error("bad pattern"); process.exit(1); }
  let sessions = listSessions(store).filter((d) => (opts.all ? true : !d.sidechain) && (opts.tool ? d.tool === opts.tool : true));
  const limit = opts.limit ?? 40;
  let shown = 0, sessionsWith = 0, scanned = 0;
  process.stderr.write(`deep-scanning ${sessions.length} sessions…\n`);
  for (const d of sessions) {
    scanned++;
    let hitInSession = false;
    try {
      const events = readSession(store, d.tool, d.sessionId);
      const pieces = extractPieces(events, {}, {});
      for (const p of pieces) {
        for (const line of p.lines) {
          if (!re.test(line)) continue;
          hitInSession = true;
          if (shown < limit) {
            const i = line.search(re);
            const snip = line.slice(Math.max(0, i - 50), i + 100).replace(/\n/g, " ");
            console.log(`${TAG[d.tool] ?? d.tool} ${d.sessionId.slice(0, 10)} seq ${p.seq}  …${snip}…`);
            shown++;
          }
        }
      }
    } catch { /* skip unreadable */ }
    if (hitInSession) sessionsWith++;
    if (shown >= limit) { console.log(`\n(stopped at ${limit} lines; ${sessions.length - scanned} sessions unscanned — narrow the pattern or raise --limit)`); break; }
  }
  console.log(`\n${sessionsWith} session(s) contained "${query}"${shown < limit ? ` across the full corpus` : ""}.`);
}
