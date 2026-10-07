/** Deterministic session summary for the UI detail pane: analytics + notes. No LLM. */
import { basename } from "path";
import type { CarafeEvent } from "../format/events";
import type { SessionDistillate } from "../format/distillate";
import { filesOf } from "../handoff/pieces";
import { priceUsage } from "./pricing";

export interface SessionSummary {
  analytics: {
    events: number; tools: number; tokensEst: number; costEst: number; agentSpawns: number;
    costSource: "usage" | "estimate";
    costByModel: Array<{ model: string; usd: number; matched: boolean; pricedAs: string | null }>;
    durationMin: number | null; sidechain: boolean; tool: string;
    runs: number; activeDays: number; // a resumed CC file is many work sessions in one id
    spend: { output: number; reasoning: number; tools: number; input: number };
  };
  notes: { goal: string | null; state: string | null; topFiles: { name: string; count: number }[]; prLinks: string[] };
}

// Fallback ONLY for sessions with no usage records: blended ~$8/Mtok on stored bytes.
const RATE_PER_TOKEN = 8 / 1_000_000;
const AGENT_TOOLS = new Set(["Task", "Agent"]);

type Spend = { output: number; reasoning: number; tools: number; input: number };
const len = (v: unknown) => { try { return JSON.stringify(v ?? "").length; } catch { return 0; } };

/** Distribute an event's bytes across spend buckets by CONTENT, not event kind —
 *  CC nests tool_use/tool_result/thinking inside user/assistant messages. */
function spendOf(ev: CarafeEvent, acc: Spend): void {
  const raw: any = ev.raw;
  if (ev.tool === "claude-code") {
    const content = raw?.message?.content;
    if (typeof content === "string") { acc[ev.kind === "assistant" ? "output" : "input"] += len(content); return; }
    if (Array.isArray(content)) for (const i of content) {
      if (!i || typeof i !== "object") continue;
      if (i.type === "thinking") acc.reasoning += len(i);
      else if (i.type === "tool_use" || i.type === "tool_result") acc.tools += len(i);
      else if (i.type === "text") acc[ev.kind === "assistant" ? "output" : "input"] += len(i);
    }
    return;
  }
  // codex: event kind already distinguishes
  const w = len(raw?.payload);
  if (ev.kind === "reasoning") acc.reasoning += w;
  else if (ev.kind === "tool_use" || ev.kind === "tool_result") acc.tools += w;
  else if (ev.kind === "assistant") acc.output += w;
  else if (ev.kind === "user") acc.input += w;
}

/** Count CC-style sub-agent spawns (Task/Agent tool calls) inside a session. */
function agentSpawnsIn(ev: CarafeEvent): number {
  const raw: any = ev.raw;
  let n = 0;
  const content = raw?.message?.content;
  if (Array.isArray(content)) for (const i of content) if (i?.type === "tool_use" && AGENT_TOOLS.has(i.name)) n++;
  return n;
}

const SYS = ["<system-reminder", "<command-name", "<command-message", "<local-command", "<task-notification", "Caveat:", "[Request interrupted"];
const isSys = (raw: any, t: string) => raw?.isMeta === true || SYS.some((m) => t.trimStart().startsWith(m));

function textOf(ev: CarafeEvent): string {
  const raw: any = ev.raw;
  const c = raw?.message?.content ?? raw?.payload?.message ?? raw?.payload?.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.filter((x: any) => x?.type === "text" && x.text).map((x: any) => x.text).join(" ");
  return "";
}

export function summarize(d: SessionDistillate, events: CarafeEvent[]): SessionSummary {
  const fileCounts = new Map<string, number>();
  const prLinks = new Set<string>();
  let goal: string | null = null;
  let state: string | null = null;
  let agentSpawns = 0;
  const bytes = { output: 0, reasoning: 0, tools: 0, input: 0 };
  // A CC session file is appended across many `--resume` runs. Count "runs"
  // (idle gaps ≥ 4h) and distinct active days so a huge id reads as what it is.
  const RUN_GAP_MS = 4 * 60 * 60 * 1000;
  const days = new Set<string>();
  let prevTs: number | null = null;
  let runs = 0;
  for (const ev of events) {
    if (ev.ts) {
      const t = Date.parse(ev.ts);
      if (Number.isFinite(t)) {
        days.add(ev.ts.slice(0, 10));
        if (prevTs === null || t - prevTs >= RUN_GAP_MS) runs++;
        prevTs = t;
      }
    }
    for (const f of filesOf(ev)) fileCounts.set(basename(f), (fileCounts.get(basename(f)) ?? 0) + 1);
    const raw: any = ev.raw;
    if (raw?.type === "pr-link" && raw.prUrl) prLinks.add(raw.prUrl);
    agentSpawns += agentSpawnsIn(ev);
    spendOf(ev, bytes);
    if (!goal && ev.kind === "user") {
      const txt = textOf(ev);
      if (txt.trim() && !isSys(raw, txt)) goal = txt.trim().replace(/\s+/g, " ").slice(0, 220);
    }
    if (ev.kind === "assistant") {
      const txt = textOf(ev);
      if (txt.trim()) state = txt.trim().replace(/\s+/g, " ").slice(0, 220); // keep last non-empty
    }
  }
  const dur = d.startTs && d.endTs ? (Date.parse(d.endTs) - Date.parse(d.startTs)) / 60000 : null;
  const totBytes = bytes.output + bytes.reasoning + bytes.tools + bytes.input || 1;
  const pct = (n: number) => Math.round((n / totBytes) * 100);
  // Cost: REAL usage records when the trace has them; byte-estimate only as fallback
  let tokensEst: number, costEst: number, costSource: "usage" | "estimate";
  let costByModel: Array<{ model: string; usd: number; matched: boolean; pricedAs: string | null }> = [];
  if (d.usage && Object.keys(d.usage).length) {
    const priced = priceUsage(d.usage);
    costEst = priced.usd; costSource = "usage";
    costByModel = priced.byModel.map((b) => ({ model: b.model, usd: b.usd, matched: b.matched, pricedAs: b.pricedAs }));
    tokensEst = priced.byModel.reduce((a, b) => a + b.contentTokens, 0); // exclude cache re-reads

  } else {
    tokensEst = Math.round((d.rawBytes ?? 0) / 4);
    costEst = tokensEst * RATE_PER_TOKEN; costSource = "estimate";
  }
  return {
    analytics: {
      events: d.eventCount, tools: d.toolUseCount,
      tokensEst, costEst, costSource, costByModel, agentSpawns,
      durationMin: dur != null && dur >= 0 ? Math.round(dur) : null,
      sidechain: d.sidechain, tool: d.tool,
      runs: Math.max(runs, 1), activeDays: days.size || 1,
      spend: { output: pct(bytes.output), reasoning: pct(bytes.reasoning), tools: pct(bytes.tools), input: pct(bytes.input) },
    },
    notes: {
      goal,
      state,
      topFiles: [...fileCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([name, count]) => ({ name, count })),
      prLinks: [...prLinks].slice(0, 6),
    },
  };
}
