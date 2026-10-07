/**
 * Claude Code adapter — ~/.claude/projects/<cwd-encoded>/<session-or-agent>.jsonl
 * Format facts (task-0 spike, 0% parse errors): typed events with sessionId, cwd,
 * gitBranch, isSidechain; standalone meta events (ai-title / custom-title /
 * last-prompt / pr-link / mode) reference sessions by sessionId.
 */
import { readdirSync, statSync } from "fs";
import { join } from "path";
import { TitlePicker, type ParsedRawEvent, type ParsedSession, type SourceFile } from "./types";
import { ccUsageByModel } from "../query/usage";

export const TOOL = "claude-code";
const ROOT = () => join(process.env.CARAFE_CC_ROOT ?? join(process.env.HOME!, ".claude"), "projects");

const KIND_MAP: Record<string, string> = {
  user: "user", assistant: "assistant", system: "system", summary: "meta",
};

function walk(dir: string, out: SourceFile[]): void {
  let entries: string[] = [];
  try { entries = readdirSync(dir); } catch { return; }
  for (const e of entries) {
    const p = join(dir, e);
    let st; try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) { walk(p, out); continue; }
    if (!e.endsWith(".jsonl")) continue;
    // sessionId = filename stem (session uuids and agent ids are globally unique)
    out.push({ tool: TOOL, sessionId: e.slice(0, -6), path: p, size: st.size, mtimeMs: st.mtimeMs });
  }
}

export function discover(): SourceFile[] {
  const out: SourceFile[] = [];
  walk(ROOT(), out);
  return out;
}

/**
 * Human/agent prose carried by ONE Claude Code record: a string content, or the
 * `text` blocks of an array content. A tool_result-only user event has no text
 * blocks and yields "" — which is why it never moves `lastActivityTs`.
 * Exported so the store-only backfill re-derives with the adapter's own rules.
 */
export function ccTextContent(obj: any): string {
  const c = obj?.message?.content;
  // A string content is the shorthand shape; it occurs on assistant events too
  // (an earlier version only accepted it for `user`, which lost those turns).
  if (typeof c === "string") return c;
  if (!Array.isArray(c)) return "";
  return c.filter((i: any) => i?.type === "text" && typeof i.text === "string").map((i: any) => i.text as string).join("\n");
}

/** A conversation turn: a user event carrying human text, or an assistant
 *  event carrying a text block. Tool calls and results never qualify. */
export function ccIsActivity(obj: any): boolean {
  const t = obj?.type;
  return (t === "user" || t === "assistant") && ccTextContent(obj).trim() !== "";
}

export function parseFile(text: string): ParsedSession {
  const s: ParsedSession = {
    events: [], internalSessionId: undefined, cwd: null, gitBranch: null,
    firstUserText: null, toolUseCount: 0, sidechain: false, titleUpdates: [], codexCalls: [],
    lastActivityTs: null, internal: false, handoffSourceId: null, firstPostHandoffText: null, weakTitleText: null, codexToolTitle: null,
    originator: null, sourceKind: null, usageByModel: {}, parseErrors: 0,
  };
  const picker = new TitlePicker();
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let obj: any;
    try { obj = JSON.parse(line); } catch { s.parseErrors++; continue; }
    const t: string = typeof obj.type === "string" ? obj.type : "?";
    // session-level metadata
    if (!s.internalSessionId && typeof obj.sessionId === "string") s.internalSessionId = obj.sessionId;
    if (!s.cwd && typeof obj.cwd === "string") s.cwd = obj.cwd;
    if (!s.gitBranch && typeof obj.gitBranch === "string") s.gitBranch = obj.gitBranch;
    if (obj.isSidechain === true) s.sidechain = true;
    // title events (may reference any session by id)
    if (t === "custom-title" && typeof obj.customTitle === "string" && typeof obj.sessionId === "string")
      s.titleUpdates.push({ sessionId: obj.sessionId, title: obj.customTitle, priority: 3 });
    if (t === "ai-title" && typeof obj.aiTitle === "string" && typeof obj.sessionId === "string")
      s.titleUpdates.push({ sessionId: obj.sessionId, title: obj.aiTitle, priority: 2 });
    // first user prompt as title fallback (skip any leading boilerplate preamble)
    if (t === "user") picker.offer(ccTextContent(obj));
    if (ccIsActivity(obj) && typeof obj.timestamp === "string") s.lastActivityTs = obj.timestamp;
    // tool_use count + codex-spawn detection (Bash commands invoking codex → subsession parentage)
    const content = obj.message?.content;
    if (Array.isArray(content)) for (const i of content) if (i?.type === "tool_use") {
      s.toolUseCount++;
      const cmd = i.input?.command;
      if (i.name === "Bash" && typeof cmd === "string" && /(^|[\s;&|("'`])codex(\s|$)/.test(cmd) && typeof obj.timestamp === "string")
        s.codexCalls.push(obj.timestamp);
    }
    s.events.push({
      ts: typeof obj.timestamp === "string" ? obj.timestamp : null,
      kind: KIND_MAP[t] ?? "meta",
      sidechain: obj.isSidechain === true || undefined,
      raw: obj,
    } satisfies ParsedRawEvent);
  }
  // Renames append over time: within a file the LAST title per (session, priority)
  // is the current one. Keep only that, so an old rename ("Acme 1.0 & 2.0")
  // can't shadow the live title ("Acme 1.0") at equal priority downstream.
  const lastTitle = new Map<string, (typeof s.titleUpdates)[number]>();
  for (const tu of s.titleUpdates) lastTitle.set(`${tu.sessionId}\0${tu.priority}`, tu);
  s.titleUpdates = [...lastTitle.values()];
  // REAL usage: one call per message id — Claude Code repeats a message's
  // usage on every content-block record (query/usage.ts).
  s.usageByModel = ccUsageByModel(s.events.map((e) => e.raw));
  s.firstUserText = picker.title;
  s.handoffSourceId = picker.handoffSourceId;
  s.firstPostHandoffText = picker.firstPostHandoffText;
  s.weakTitleText = picker.weakFallback;
  return s;
}
