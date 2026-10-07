/**
 * Title/recency backfill for sessions captured before F1/F2 existed.
 *
 * Reads conversation events from CARAFE'S OWN STORE and the read-only Codex
 * name index. It migrates metadata and replaces titles only under the shared
 * source-strength rule. Every write is atomic, so interruption leaves whole
 * records behind and a second run is a no-op.
 */
import { readCodexThreadNames } from "../adapters/codex-names";
import { ccIsActivity } from "../adapters/claude-code";
import { codexIsActivity } from "../adapters/codex";
import { isInjectedBlock } from "../adapters/types";
import type { SessionDistillate, TitleSource } from "../format/distillate";
import { applyTitleCandidate, effectiveTitleSource, mayReplaceTitle, writeDistillate } from "../format/distillate";
import { isBlobMarker, rehydrate, type CarafeEvent } from "../format/events";
import { recomputeFields, resolveTitleCandidate } from "../format/recompute";
import { readSession, readSessionEnvelopes } from "../format/sessions";
import { CarafeStore } from "../format/store";
import { listSessions } from "../query/sessions";

export interface TitleBackfillChange {
  tool: string;
  sessionId: string;
  oldTitle: string | null;
  newTitle: string | null;
  newTitleSource: TitleSource;
  internal: boolean;
  lastActivityTs: string | null;
}

export interface TitleBackfillResult {
  scanned: number;      // legacy title/recency migration candidates
  changed: TitleBackfillChange[];
  /** The subset whose displayed title would actually change. */
  renamed: TitleBackfillChange[];
  applied: number;
  failed: number;
  /** Sessions whose events could not be read. The caller carries these across
   *  passes: a permanently unreadable session at the head of the store would
   *  otherwise consume a slot on every pass and starve the readable tail. */
  unreadable: string[];
}

/** Stable identity for the in-memory skip set. */
export function skipKey(tool: string, sessionId: string): string { return `${tool}/${sessionId}`; }

export function needsTitleBackfill(d: SessionDistillate): boolean {
  return d.lastActivityTs === undefined || d.titleSource === undefined;
}

/** Compatibility helper for callers/tests: provenance, not text shape, decides. */
export function titleIsReplaceable(
  title: string | null | undefined,
  source: TitleSource | undefined = undefined,
  nextTitle = "replacement",
  nextSource: TitleSource = "derived",
  tool = "codex",
): boolean {
  return mayReplaceTitle(tool, title, source, nextTitle, nextSource);
}

const FAST_TITLE_SOURCES: ReadonlySet<TitleSource> = new Set(["human", "cc-title", "codex-index"]);

/** Whether a stored Claude event is activity without resolving blob bodies.
 * `null` means a text field is a blob marker; hydrate only that one candidate. */
function storedCcActivity(raw: any): boolean | null {
  if (raw?.type !== "user" && raw?.type !== "assistant") return false;
  const content = raw?.message?.content;
  if (typeof content === "string") return content.trim() !== "";
  if (isBlobMarker(content)) return null;
  if (!Array.isArray(content)) return false;
  let ambiguous = false;
  for (const part of content) {
    if (part?.type !== "text") continue;
    if (typeof part.text === "string" && part.text.trim()) return true;
    if (isBlobMarker(part?.text)) ambiguous = true;
  }
  return ambiguous ? null : false;
}

/** Last conversational activity from stored envelopes. Large tool results are
 * never opened; an ambiguous Claude text marker hydrates just that event. */
export function lastActivityFromEnvelopes(store: CarafeStore, tool: string, events: readonly CarafeEvent[]): string | null {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]!;
    const raw = event.raw as any;
    let activity: boolean;
    if (tool === "codex") activity = codexIsActivity(raw);
    else {
      const stored = storedCcActivity(raw);
      activity = stored === null ? ccIsActivity(rehydrate(raw, store)) : stored;
    }
    if (!activity) continue;
    if (typeof raw?.timestamp === "string") return raw.timestamp;
    if (typeof event.ts === "string") return event.ts;
  }
  return null;
}

export function backfillTitles(
  store: CarafeStore,
  opts: { apply?: boolean; limit?: number; skip?: ReadonlySet<string>; maxMs?: number; now?: () => number } = {},
): TitleBackfillResult {
  const limit = opts.limit ?? 50;
  const now = opts.now ?? Date.now;
  const started = now();
  const skip = opts.skip;
  const codexNames = readCodexThreadNames();
  const result: TitleBackfillResult = { scanned: 0, changed: [], renamed: [], applied: 0, failed: 0, unreadable: [] };
  for (const d of listSessions(store)) {
    if (result.scanned >= limit) break;
    // At least one candidate is always attempted, even when the first read has
    // already exhausted a fake or heavily-loaded wall-clock budget.
    if (result.scanned > 0 && opts.maxMs !== undefined && now() - started >= opts.maxMs) break;
    if (!needsTitleBackfill(d)) continue;
    if (skip?.has(skipKey(d.tool, d.sessionId))) continue;
    result.scanned++;
    const effectiveSource = effectiveTitleSource(d.tool, d.title, d.titleSource);
    // These records already carry every non-recency migration field and their
    // title cannot be displaced by a weaker derived candidate. Scan the sealed
    // envelopes backwards and hydrate at most one ambiguous text blob. Older
    // records, replaceable titles, and incomplete metadata keep the full read.
    if (FAST_TITLE_SOURCES.has(effectiveSource) && d.internal !== undefined && d.hasUserText !== undefined) {
      try {
        const next: SessionDistillate = {
          ...d,
          titleSource: effectiveSource,
          lastActivityTs: lastActivityFromEnvelopes(store, d.tool, readSessionEnvelopes(store, d.tool, d.sessionId)),
        };
        if (effectiveSource === "codex-index") {
          const indexed = codexNames.get(d.sessionId);
          if (indexed) applyTitleCandidate(next, indexed.name, "codex-index");
        }
        const change: TitleBackfillChange = {
          tool: d.tool, sessionId: d.sessionId,
          oldTitle: d.title ?? null, newTitle: next.title ?? null,
          newTitleSource: effectiveSource,
          internal: next.internal ?? false, lastActivityTs: next.lastActivityTs ?? null,
        };
        result.changed.push(change);
        if (change.oldTitle !== change.newTitle) result.renamed.push(change);
        if (opts.apply) {
          try { writeDistillate(store, next); result.applied++; }
          catch { result.failed++; }
        }
        continue;
      } catch {
        // A corrupt envelope or missing blob falls back to the established full
        // decoder below, preserving its failure and skip behavior.
      }
    }
    let fields;
    const titleEventIds = d.sidechain ? [d.sessionId] : [d.internalSessionId ?? d.sessionId, d.sessionId];
    try { fields = recomputeFields(d.tool, readSession(store, d.tool, d.sessionId), titleEventIds); }
    catch { result.failed++; result.unreadable.push(skipKey(d.tool, d.sessionId)); continue; }
    const next: SessionDistillate = {
      ...d,
      internal: fields.internal,
      hasUserText: fields.hasUserText,
      lastActivityTs: fields.lastActivityTs,
    };
    // Mark every legacy record migrated, then layer candidates weakest to
    // strongest. This also catches null-title records whose recency was already
    // backfilled but whose rollout contains a set_thread_title call.
    next.titleSource = effectiveTitleSource(next.tool, next.title, next.titleSource);
    if (next.titleSource === "weak" && next.title && isInjectedBlock(next.title)) next.title = null;
    const derived = resolveTitleCandidate(store, fields.title, fields.handoffSourceId, fields.weakTitleText, fields.firstPostHandoffText);
    applyTitleCandidate(next, derived.title, derived.source);
    if (fields.codexToolTitle) applyTitleCandidate(next, fields.codexToolTitle, "codex-tool");
    if (fields.ccTitle) applyTitleCandidate(next, fields.ccTitle, "cc-title");
    if (d.tool === "codex") {
      const indexed = codexNames.get(d.sessionId);
      if (indexed) applyTitleCandidate(next, indexed.name, "codex-index");
    }
    const change: TitleBackfillChange = {
      tool: d.tool, sessionId: d.sessionId,
      oldTitle: d.title ?? null, newTitle: next.title ?? null,
      newTitleSource: next.titleSource,
      internal: fields.internal, lastActivityTs: fields.lastActivityTs,
    };
    result.changed.push(change);
    if (change.oldTitle !== change.newTitle) result.renamed.push(change);
    if (opts.apply) {
      try { writeDistillate(store, next); result.applied++; }
      catch { result.failed++; }
    }
  }
  return result;
}

export function runReindexTitles(opts: { apply?: boolean; limit?: number } = {}): void {
  const store = new CarafeStore();
  const r = backfillTitles(store, { apply: opts.apply, limit: opts.limit ?? Number.MAX_SAFE_INTEGER });
  if (!opts.apply) {
    console.log(`${r.changed.length} session(s) would be updated; ${r.renamed.length} title(s) would change (of ${r.scanned} title/recency migration candidates).`);
    for (const c of r.renamed.slice(0, 5)) {
      console.log(`  ${c.tool} ${c.sessionId.slice(0, 10)}  "${(c.oldTitle ?? "null").slice(0, 40)}" → "${(c.newTitle ?? "null").slice(0, 40)}" (${c.newTitleSource})${c.internal ? "  [internal]" : ""}`);
    }
    if (r.failed) console.log(`  ${r.failed} session(s) unreadable, skipped`);
    console.log(`\nre-run with --yes to write.`);
    return;
  }
  console.log(`updated ${r.applied} / ${r.changed.length} session(s)${r.failed ? `, ${r.failed} skipped` : ""}.`);
}
