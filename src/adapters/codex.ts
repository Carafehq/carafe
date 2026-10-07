/**
 * Codex adapter — ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl
 * Format facts (task-0 spike, 0% parse errors): {timestamp, type, payload}
 * envelopes; session_meta / turn_context carry cwd; event_msg/user_message
 * carries the prompt text.
 */
import { readdirSync, statSync } from "fs";
import { join } from "path";
import { CODEX_REVIEW_PREFIX, TitlePicker, type ParsedRawEvent, type ParsedSession, type SourceFile } from "./types";
import { normalizeCodexThreadName } from "./codex-names";
import { CODEX_UNKNOWN_MODEL, codexUsageByModel } from "../query/usage";

export const TOOL = "codex";
const ROOT = () => join(process.env.CARAFE_CODEX_ROOT ?? join(process.env.HOME!, ".codex"), "sessions");
const FILE_RE = /^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-(.+)\.jsonl$/;

function walk(dir: string, out: SourceFile[]): void {
  let entries: string[] = [];
  try { entries = readdirSync(dir); } catch { return; }
  for (const e of entries) {
    const p = join(dir, e);
    let st; try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) { walk(p, out); continue; }
    const m = e.match(FILE_RE);
    if (m) out.push({ tool: TOOL, sessionId: m[1]!, path: p, size: st.size, mtimeMs: st.mtimeMs });
  }
}

export function discover(): SourceFile[] {
  const out: SourceFile[] = [];
  walk(ROOT(), out);
  return out;
}

function kindOf(t: string, payloadType: string | undefined, role?: string): string {
  if (t === "response_item") {
    switch (payloadType) {
      // role "developer" (Codex's injected context) has always counted as
      // assistant-side narration; only role "user" is the owner talking.
      case "message": return role === "user" ? "user" : "assistant";
      case "function_call": case "custom_tool_call": return "tool_use";
      case "function_call_output": case "custom_tool_call_output": return "tool_result";
      case "reasoning": return "reasoning";
      default: return "meta";
    }
  }
  if (t === "event_msg") {
    if (payloadType === "user_message") return "user";
    if (payloadType === "agent_message") return "assistant";
    return "meta";
  }
  return "meta"; // session_meta, turn_context, compacted, ...
}

/**
 * The owner's words in ONE Codex record, across both shapes that carry them:
 * the older `event_msg/user_message` (`payload.message`) and the newer
 * `response_item` message item with role `user` (its `input_text` parts). Null
 * when the record is not owner text at all. Exported so the store-only title
 * backfill re-derives titles with exactly the adapter's rules.
 */
export function codexUserText(obj: any): string | null {
  const p = obj?.payload ?? {};
  const t = obj?.type;
  const pt = typeof p.type === "string" ? p.type : undefined;
  if (t === "event_msg" && pt === "user_message" && typeof p.message === "string") return p.message;
  if (t === "response_item" && pt === "message" && p.role === "user" && Array.isArray(p.content)) {
    return p.content
      .filter((part: any) => part?.type === "input_text" && typeof part.text === "string")
      .map((part: any) => part.text as string)
      .join("\n");
  }
  return null;
}

/** True when this record is a conversation turn (owner or agent message) —
 *  the only kind of record that may move `lastActivityTs`. Token counts,
 *  settings, tool calls and meta records never do. */
export function codexIsActivity(obj: any): boolean {
  const p = obj?.payload ?? {};
  const kind = kindOf(typeof obj?.type === "string" ? obj.type : "?", typeof p.type === "string" ? p.type : undefined, p.role);
  if (kind === "user") return true;
  // A response_item assistant message counts; an event_msg/agent_message counts.
  if (obj?.type === "event_msg" && p.type === "agent_message") return true;
  return obj?.type === "response_item" && p.type === "message" && p.role === "assistant";
}

/** A valid title carried by one set_thread_title call, otherwise null. */
export function codexThreadTitleCall(obj: any): string | null {
  const p = obj?.payload ?? {};
  if (obj?.type !== "response_item" || (p.type !== "function_call" && p.type !== "custom_tool_call") || p.name !== "set_thread_title") return null;
  let args = p.arguments;
  if (typeof args === "string") {
    try { args = JSON.parse(args); } catch { return null; }
  }
  if (!args || typeof args.title !== "string") return null;
  return normalizeCodexThreadName(args.title) || null;
}

export function parseFile(text: string): ParsedSession {
  const s: ParsedSession = {
    events: [], internalSessionId: undefined, cwd: null, gitBranch: null,
    firstUserText: null, toolUseCount: 0, sidechain: false, titleUpdates: [], codexCalls: [],
    lastActivityTs: null, internal: false, handoffSourceId: null, firstPostHandoffText: null, weakTitleText: null, codexToolTitle: null,
    originator: null, sourceKind: null, usageByModel: {}, parseErrors: 0,
  };
  let model = CODEX_UNKNOWN_MODEL;
  const picker = new TitlePicker();
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let obj: any;
    try { obj = JSON.parse(line); } catch { s.parseErrors++; continue; }
    const t: string = typeof obj.type === "string" ? obj.type : "?";
    const p = obj.payload ?? {};
    const pt: string | undefined = typeof p.type === "string" ? p.type : undefined;
    if (t === "session_meta") {
      if (typeof p.id === "string") s.internalSessionId = p.id;
      if (typeof p.cwd === "string") s.cwd = p.cwd;
      if (typeof p.originator === "string") s.originator = p.originator;
      if (typeof p.source === "string") s.sourceKind = p.source;
      else if (p.source && typeof p.source === "object") s.sourceKind = Object.keys(p.source)[0] ?? null;
    }
    if (t === "turn_context") {
      if (!s.cwd && typeof p.cwd === "string") s.cwd = p.cwd;
      if (typeof p.model === "string") model = p.model;
    }
    const kind = kindOf(t, pt, p.role);
    const toolTitle = codexThreadTitleCall(obj);
    if (toolTitle) s.codexToolTitle = toolTitle;
    const userText = codexUserText(obj);
    if (userText !== null) {
      // The reviewer banner sits among the leading injected blocks, not
      // necessarily in the very first record — so look until real text appears.
      if (!picker.title && userText.trimStart().startsWith(CODEX_REVIEW_PREFIX)) s.internal = true;
      picker.offer(userText);
    }
    if (codexIsActivity(obj) && typeof obj.timestamp === "string")
      s.lastActivityTs = obj.timestamp;
    if (kind === "tool_use") s.toolUseCount++;
    s.events.push({
      ts: typeof obj.timestamp === "string" ? obj.timestamp : null,
      kind,
      raw: obj,
    } satisfies ParsedRawEvent);
  }
  s.firstUserText = picker.title;
  s.handoffSourceId = picker.handoffSourceId;
  s.firstPostHandoffText = picker.firstPostHandoffText;
  s.weakTitleText = picker.weakFallback;
  // token_count info.total_token_usage is session-CUMULATIVE: a call's usage
  // is the growth since the previous reading, never the sum (query/usage.ts).
  s.usageByModel = codexUsageByModel(s.events.map((e) => e.raw));
  return s;
}
