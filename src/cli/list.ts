/** carafe list — recent sessions, for picking one to hand off. */
import { ADAPTERS } from "../adapters/registry";
import { CarafeStore } from "../format/store";
import { activityTs, isNoise, isSpawned, listWithHierarchy } from "../query/sessions";
import type { SessionDistillate } from "../format/distillate";

const TOOL_TAG: Record<string, string> = { "claude-code": "CC", codex: "CX" };

export interface SessionListRow {
  id: string; tool: string; title: string | null; cwd: string | null;
  startTs: string | null; endTs: string | null; lastActivityTs: string | null;
  internal: boolean; sourceKind: string | null; spawned: boolean;
  eventCount: number; subsessions: number;
}

function selected(opts: { tool?: string; all?: boolean; interactive?: boolean }): { sessions: SessionDistillate[]; h: ReturnType<typeof listWithHierarchy> } {
  const store = new CarafeStore();
  const h = listWithHierarchy(store);
  let sessions = h.sessions;
  // hide sub-agent + spawned-subsession noise by default
  if (!opts.all) sessions = sessions.filter((d) => !d.sidechain && !h.parentOf[d.sessionId] && !isNoise(d));
  // Spawned workers stay VISIBLE by default — agents search this list for past
  // work — but `--interactive` narrows it to sessions a human actually opened.
  if (opts.interactive && !opts.all) sessions = sessions.filter((d) => !isSpawned(d));
  if (opts.tool) sessions = sessions.filter((d) => d.tool === opts.tool);
  return { sessions, h };
}

/** The rows `carafe list` shows, as data: newest first, sub-agent and spawned
 *  subsession noise hidden unless `all`. The menu bar app's session picker reads this. */
export function listRows(opts: { limit?: number; tool?: string; all?: boolean; interactive?: boolean } = {}): SessionListRow[] {
  const { sessions, h } = selected(opts);
  return sessions.slice(0, opts.limit ?? 25).map((d) => ({
    id: d.sessionId, tool: d.tool, title: d.title ?? null, cwd: d.cwd ?? null,
    startTs: d.startTs ?? null, endTs: d.endTs ?? null,
    lastActivityTs: d.lastActivityTs ?? null, internal: d.internal === true,
    sourceKind: d.sourceKind ?? null, spawned: isSpawned(d),
    eventCount: d.eventCount, subsessions: (h.childrenOf[d.sessionId] ?? []).length,
  }));
}

/** One group per capture adapter, including sources with no sessions. Limit per
 * source so a busy adapter cannot crowd every other source out of the picker. */
export function handoffSources(opts: { limit?: number; all?: boolean; interactive?: boolean } = {}) {
  const rows = listRows({ ...opts, limit: Infinity });
  return ADAPTERS.map(({ tool, name }) => ({
    tool, name, sessions: rows.filter((row) => row.tool === tool).slice(0, opts.limit ?? 12),
  }));
}

/** "3 min ago" from the last thing said in the session. */
function ago(ts: string | null, now = Date.now()): string {
  if (!ts) return "?";
  const s = (now - Date.parse(ts)) / 1000;
  if (!Number.isFinite(s)) return "?";
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86_400)} d ago`;
}

export function runList(opts: { limit?: number; tool?: string; all?: boolean; interactive?: boolean; json?: boolean; sources?: boolean } = {}): void {
  if (opts.sources) { console.log(JSON.stringify(handoffSources(opts), null, 2)); return; }
  if (opts.json) { console.log(JSON.stringify(listRows(opts), null, 2)); return; }
  const { sessions, h } = selected(opts);
  const limit = opts.limit ?? 25;
  console.log(`${sessions.length} sessions in ~/.carafe (showing ${Math.min(limit, sessions.length)})\n`);
  for (const d of sessions.slice(0, limit)) {
    const when = ago(activityTs(d)).padEnd(11);
    const tag = TOOL_TAG[d.tool] ?? d.tool;
    // "⚙" = launched by another agent, not by a human opening a session.
    const gear = isSpawned(d) ? "⚙ " : "";
    const title = gear + (d.title ?? d.sessionId).slice(0, 62);
    const subs = (h.childrenOf[d.sessionId] ?? []).length;
    console.log(`  ${tag}  ${when}  ${d.sessionId.slice(0, 10)}  ${title}${subs ? `  [+${subs} sub]` : ""}`);
  }
  console.log(`\nhand one off:  carafe handoff <id>`);
}
