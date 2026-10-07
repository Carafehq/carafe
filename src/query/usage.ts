/**
 * One API call, counted once. The single place that turns trace records into
 * model-call usage, shared by every view of it (the adapters' usageByModel,
 * `carafe show`, the UI spend view, chapter token counts), so no two can ever
 * disagree about what a call cost.
 *
 * Claude Code writes one record per content block of an assistant message
 * (thinking, text, each tool_use), and every copy repeats the message's usage
 * object; a streamed message's later copy carries the final output count.
 * Counting every usage line counts a call ~2x. One call per message id (the
 * request id when the message has none); the LAST copy's usage wins.
 *
 * Codex writes `token_count` events whose `total_token_usage` is the
 * session-CUMULATIVE total, repeated on every event. A call's usage is the
 * growth since the previous reading — never the sum of the totals.
 */
import type { ModelUsage, UsageByModel } from "./pricing";

export type CallUsage = Omit<ModelUsage, "calls">;

/** The counting rules a distillate's `usage` was derived with. 2: each API call
 *  once (1 counted every Claude Code usage line). Older records are re-counted
 *  from the store by the usage backfill. */
export const USAGE_VERSION = 2;

/** NEW tokens: uncached input + output. Cache reads and writes re-count context already seen. */
export const newTokens = (u: CallUsage): number => u.in + u.out;

export interface CcCall {
  /** message id, else request id, else "" (no id: never merged with another record) */
  id: string;
  model: string;
  usage: CallUsage;
}

/** The API call one Claude Code record carries, or null (not an assistant
 *  record, no usage, or a synthetic message Claude Code wrote itself). */
export function ccCallOf(obj: any): CcCall | null {
  if (obj?.type !== "assistant") return null;
  const u = obj.message?.usage;
  const model = obj.message?.model;
  if (!u || typeof u !== "object" || typeof model !== "string" || model === "<synthetic>") return null;
  const cc = u.cache_creation;
  // Usage records that carry the 5m/1h split are priced per tier; an older
  // record without it reports one cache-write number, priced at the 5m rate.
  const split = cc && typeof cc === "object" && (cc.ephemeral_5m_input_tokens != null || cc.ephemeral_1h_input_tokens != null);
  const n = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const id = typeof obj.message?.id === "string" && obj.message.id ? obj.message.id
    : typeof obj.requestId === "string" ? obj.requestId : "";
  return {
    id, model,
    usage: {
      in: n(u.input_tokens), cacheR: n(u.cache_read_input_tokens), out: n(u.output_tokens),
      cacheW5m: split ? n(cc.ephemeral_5m_input_tokens) : n(u.cache_creation_input_tokens),
      cacheW1h: split ? n(cc.ephemeral_1h_input_tokens) : 0,
    },
  };
}

/**
 * Claude Code calls in first-seen order, one per message id. `add` returns the
 * call's stable index and whether this record was a later copy of it (whose
 * usage has replaced the earlier copy's).
 */
export class CcCallLedger {
  readonly calls: CcCall[] = [];
  private byId = new Map<string, number>();
  add(call: CcCall): { index: number; copy: boolean } {
    const at = call.id ? this.byId.get(call.id) : undefined;
    if (at !== undefined) { this.calls[at] = call; return { index: at, copy: true }; }
    if (call.id) this.byId.set(call.id, this.calls.length);
    this.calls.push(call);
    return { index: this.calls.length - 1, copy: false };
  }
}

export function addUsage(acc: UsageByModel, model: string, u: CallUsage, calls = 1): void {
  const m = (acc[model] ??= { in: 0, cacheR: 0, cacheW5m: 0, cacheW1h: 0, out: 0, calls: 0 });
  m.in += u.in; m.cacheR += u.cacheR; m.cacheW5m += u.cacheW5m; m.cacheW1h += u.cacheW1h; m.out += u.out;
  m.calls += calls;
}

export function usageByModelOf(calls: Iterable<{ model: string; usage: CallUsage }>): UsageByModel {
  const acc: UsageByModel = {};
  for (const c of calls) addUsage(acc, c.model, c.usage);
  return acc;
}

/** Claude Code records → usage per model, each API call once. */
export function ccUsageByModel(records: Iterable<unknown>): UsageByModel {
  const ledger = new CcCallLedger();
  for (const r of records) { const c = ccCallOf(r); if (c) ledger.add(c); }
  return usageByModelOf(ledger.calls);
}

/**
 * Codex: turns the cumulative `total_token_usage` readings into per-reading
 * deltas. OpenAI's input_tokens INCLUDES the cached input; reasoning is billed
 * as output. A repeated reading yields nothing; a counter that goes backwards
 * is re-based without pricing anything (under-count rather than double-count).
 */
export class CodexUsageMeter {
  private last: { input: number; cached: number; output: number } | null = null;
  /** The usage since the previous reading, or null when there is none. */
  next(totals: any): CallUsage | null {
    if (!totals || typeof totals !== "object" || typeof totals.input_tokens !== "number") return null;
    const cur = {
      input: totals.input_tokens,
      cached: typeof totals.cached_input_tokens === "number" ? totals.cached_input_tokens : 0,
      output: typeof totals.output_tokens === "number" ? totals.output_tokens : 0,
    };
    const prev = this.last ?? { input: 0, cached: 0, output: 0 };
    this.last = cur;
    const dIn = cur.input - prev.input, dOut = cur.output - prev.output;
    if (dIn < 0 || dOut < 0) return null; // a counter reset: nothing to price
    if (dIn === 0 && dOut === 0) return null; // the same reading again
    const cached = Math.max(0, Math.min(cur.cached - prev.cached, dIn));
    return { in: dIn - cached, cacheR: cached, cacheW5m: 0, cacheW1h: 0, out: dOut };
  }
}

/** The cumulative totals a Codex record carries, when it is a token_count event. */
export function codexTotalsOf(obj: any): unknown | null {
  if (obj?.type !== "event_msg" || obj.payload?.type !== "token_count") return null;
  return obj.payload.info?.total_token_usage ?? null;
}

/** The model a Codex record switches to (turn_context), else null. */
export function codexModelOf(obj: any): string | null {
  return obj?.type === "turn_context" && typeof obj.payload?.model === "string" ? obj.payload.model : null;
}

export const CODEX_UNKNOWN_MODEL = "gpt-unknown";

/** Codex records → usage per model: the sum of per-reading deltas, each priced
 *  at the model in force when it was read. */
export function codexUsageByModel(records: Iterable<unknown>): UsageByModel {
  const acc: UsageByModel = {};
  const meter = new CodexUsageMeter();
  let model = CODEX_UNKNOWN_MODEL;
  for (const r of records) {
    const m = codexModelOf(r);
    if (m) { model = m; continue; }
    const totals = codexTotalsOf(r);
    if (!totals) continue;
    const u = meter.next(totals);
    if (u) addUsage(acc, model, u);
  }
  return acc;
}
