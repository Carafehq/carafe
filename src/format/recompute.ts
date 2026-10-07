/**
 * Re-derive the fields F1/F2 added (title, internal, lastActivityTs,
 * hasUserText) from events ALREADY IN CARAFE'S OWN STORE. The source roots are
 * never touched: a sealed event keeps its original `raw`, so the adapters'
 * own helpers give exactly the answer a fresh import would.
 */
import { ccIsActivity, ccTextContent } from "../adapters/claude-code";
import { codexIsActivity, codexThreadTitleCall, codexUserText } from "../adapters/codex";
import { CODEX_REVIEW_PREFIX, isInjectedBlock, TitlePicker } from "../adapters/types";
import type { CarafeEvent } from "./events";
import type { SessionDistillate } from "./distillate";
import type { TitleSource } from "./distillate";
import type { CarafeStore } from "./store";
import { readSession } from "./sessions";
import { readdirSync, readFileSync } from "fs";
import { join } from "path";

export interface RecomputedFields {
  title: string | null;
  internal: boolean;
  lastActivityTs: string | null;
  hasUserText: boolean;
  /** First short/steering user text, verbatim — the last-resort title. */
  weakTitleText: string | null;
  /** The session this one was continued FROM, when it opened with a carafe
   *  handoff instruction. Resolve it with `continuedTitle`. */
  handoffSourceId: string | null;
  firstPostHandoffText: string | null;
  codexToolTitle: string | null;
  /** Last highest-priority Claude Code title event targeting this session. */
  ccTitle: string | null;
}

export function recomputeFields(tool: string, events: CarafeEvent[], sessionIds: readonly string[] = []): RecomputedFields {
  const out: RecomputedFields = { title: null, internal: false, lastActivityTs: null, hasUserText: false, handoffSourceId: null, firstPostHandoffText: null, weakTitleText: null, codexToolTitle: null, ccTitle: null };
  const codex = tool === "codex";
  const ownIds = new Set(sessionIds.length ? sessionIds : events.map((event) => event.sessionId));
  let ccTitlePriority = -1;
  const picker = new TitlePicker();
  for (const e of events) {
    const raw = e.raw as any;
    if (codex) {
      const toolTitle = codexThreadTitleCall(raw);
      if (toolTitle) out.codexToolTitle = toolTitle;
    } else if (typeof raw?.sessionId === "string" && ownIds.has(raw.sessionId)) {
      const priority = raw.type === "custom-title" ? 3 : raw.type === "ai-title" ? 2 : -1;
      const title = raw.type === "custom-title" ? raw.customTitle : raw.type === "ai-title" ? raw.aiTitle : null;
      if (priority >= ccTitlePriority && typeof title === "string" && title.trim()) {
        out.ccTitle = title;
        ccTitlePriority = priority;
      }
    }
    const userText = codex ? codexUserText(raw) : (raw?.type === "user" ? ccTextContent(raw) : null);
    if (userText !== null) {
      if (codex && !picker.title && userText.trimStart().startsWith(CODEX_REVIEW_PREFIX)) out.internal = true;
      picker.offer(userText);
    }
    const activity = codex ? codexIsActivity(raw) : ccIsActivity(raw);
    if (activity && typeof raw?.timestamp === "string") out.lastActivityTs = raw.timestamp;
    else if (activity && typeof e.ts === "string") out.lastActivityTs = e.ts;
  }
  out.title = picker.title;
  out.handoffSourceId = picker.handoffSourceId;
  out.firstPostHandoffText = picker.firstPostHandoffText;
  out.weakTitleText = picker.weakFallback;
  out.hasUserText = picker.resolved !== null || picker.handoffSourceId !== null;
  return out;
}

/** A session's distillate looked up by id alone, across every tool directory.
 *  A literal lookup: no prefix matching, no guessing. */
export function findDistillateById(store: CarafeStore, sessionId: string): SessionDistillate | null {
  const base = join(store.root, "distillate");
  let tools: string[] = [];
  try { tools = readdirSync(base); } catch { return null; }
  for (const tool of tools) {
    try { return JSON.parse(readFileSync(join(base, tool, `${sessionId}.json`), "utf8")) as SessionDistillate; }
    catch { /* not this tool */ }
  }
  return null;
}

/** The title for a session that OPENED with a carafe handoff and said nothing
 *  of its own afterwards. Names the work it continues, so several sessions
 *  continued from one source are still told apart by what they continue —
 *  never by carafe's own instruction, which is identical for all of them. */
export function continuedTitle(store: CarafeStore, sourceId: string): string {
  const source = findDistillateById(store, sourceId);
  let title = source?.title?.trim() || "";
  // The backfill walks newest-first, so the SOURCE (older) may still be
  // carrying its own un-repaired title when we get here. Re-derive it from its
  // stored events rather than letting pass order decide the name.
  if (source && (!title || isInjectedBlock(title))) {
    try {
      const own = recomputeFields(source.tool, readSession(store, source.tool, source.sessionId), [source.internalSessionId ?? source.sessionId, source.sessionId]);
      title = own.title?.trim() || "";
    } catch { /* unreadable source: fall through to the id */ }
  }
  return title ? `Continued: ${title}` : `Continued from ${sourceId.slice(0, 8)}`;
}

function sourceTitle(store: CarafeStore, sourceId: string): string {
  const source = findDistillateById(store, sourceId);
  let title = source?.title?.trim() || "";
  if (source && (!title || isInjectedBlock(title))) {
    try { title = recomputeFields(source.tool, readSession(store, source.tool, source.sessionId), [source.internalSessionId ?? source.sessionId, source.sessionId]).title?.trim() || ""; }
    catch { /* unreadable source */ }
  }
  return title;
}

export interface ResolvedTitle { title: string | null; source: TitleSource }

/** Resolve the weaker derived/handoff candidates. Strong Codex/CC names are
 * applied by their callers before this function participates. */
export function resolveTitleCandidate(
  store: CarafeStore,
  ownTitle: string | null,
  handoffSourceId: string | null,
  weakTitleText: string | null = null,
  firstPostHandoffText: string | null = null,
): ResolvedTitle {
  if (handoffSourceId && firstPostHandoffText && firstPostHandoffText.length < 40) {
    const parent = sourceTitle(store, handoffSourceId);
    if (parent) return { title: `${parent} — ${firstPostHandoffText}`.replace(/\s+/g, " ").trim().slice(0, 120), source: "derived" };
  }
  if (ownTitle) return { title: ownTitle, source: "derived" };
  if (handoffSourceId) return { title: continuedTitle(store, handoffSourceId), source: "continued" };
  return { title: weakTitleText, source: "weak" };
}

/** The title to store: the session's own words when it has any, otherwise the
 *  handoff it continues. Null only when neither exists. */
export function resolveTitle(
  store: CarafeStore,
  ownTitle: string | null,
  handoffSourceId: string | null,
  weakTitleText: string | null = null,
  firstPostHandoffText: string | null = null,
): string | null {
  return resolveTitleCandidate(store, ownTitle, handoffSourceId, weakTitleText, firstPostHandoffText).title;
}
