import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import * as cc from "../adapters/claude-code";
import * as codex from "../adapters/codex";
import { backfillUsage } from "../cli/reindex-usage";
import type { SessionDistillate } from "../format/distillate";
import type { CarafeEvent } from "../format/events";
import { sealSession } from "../format/sessions";
import { CarafeStore } from "../format/store";
import { normalizeModelId, priceUsage, ratesFor } from "./pricing";
import { ccUsageByModel, codexUsageByModel, USAGE_VERSION } from "./usage";

const jsonl = (records: unknown[]) => records.map((r) => JSON.stringify(r)).join("\n");

// Raw Claude Code and Codex records in the shapes the tools write (numbers invented).
const T0 = Date.parse("2026-09-22T10:00:00.000Z");
const MIN = 60_000;
const iso = (ms: number) => new Date(ms).toISOString();

function ccUser(ms: number, text: string): unknown {
  return { type: "user", timestamp: iso(ms), sessionId: "s", message: { role: "user", content: text } };
}

function cxTurnContext(ms: number, model: string): unknown {
  return { timestamp: iso(ms), type: "turn_context", payload: { model, cwd: "/work/My Project" } };
}

/** A Codex `token_count` event: `total` is the session-cumulative usage. */
function cxTokenCount(ms: number, opts: { prompt: number; total: { input: number; cached: number; output: number } }): unknown {
  return {
    timestamp: iso(ms), type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: { input_tokens: opts.total.input, cached_input_tokens: opts.total.cached, output_tokens: opts.total.output },
        last_token_usage: { input_tokens: opts.prompt, cached_input_tokens: 0, output_tokens: 100 },
        model_context_window: 258_400,
      },
      rate_limits: null,
    },
  };
}

/** One assistant message the way Claude Code writes it: one record per content
 *  block, each repeating the message's usage. `finalOut` gives the last copy a
 *  larger output count, as a streamed message's later record carries. */
function ccMessage(ms: number, id: string, blocks: string[], usage: Record<string, unknown>, finalOut?: number): unknown[] {
  return blocks.map((type, i) => ({
    type: "assistant", timestamp: iso(ms), sessionId: "s", requestId: `req_${id}`,
    message: {
      id, model: "claude-opus-5", role: "assistant",
      content: [type === "tool_use" ? { type, id: `tu_${i}`, name: "Bash", input: { command: "ls" } } : { type, [type === "thinking" ? "thinking" : "text"]: "x" }],
      usage: { ...usage, ...(finalOut !== undefined && i === blocks.length - 1 ? { output_tokens: finalOut } : {}) },
    },
  }));
}

const USAGE = {
  input_tokens: 10, cache_read_input_tokens: 90_000, cache_creation_input_tokens: 3_000, output_tokens: 40,
  cache_creation: { ephemeral_5m_input_tokens: 1_000, ephemeral_1h_input_tokens: 2_000 },
};

describe("Claude Code: each API call once", () => {
  const records = [
    ccUser(T0, "please look at the build"),
    // thinking + text + two tool calls: four records, one call
    ...ccMessage(T0 + MIN, "msg_a", ["thinking", "text", "tool_use", "tool_use"], USAGE, 700),
    ...ccMessage(T0 + 2 * MIN, "msg_b", ["text"], { input_tokens: 5, cache_read_input_tokens: 1_000, output_tokens: 20 }),
  ];

  test("a message split across content blocks counts once, with its last copy's usage", () => {
    const u = ccUsageByModel(records)["claude-opus-5"]!;
    expect(u.calls).toBe(2);
    expect(u.in).toBe(15);
    expect(u.out).toBe(720); // 700 from msg_a's final copy, not 4 × 40
    expect(u.cacheR).toBe(91_000);
    expect(u.cacheW5m).toBe(1_000);
    expect(u.cacheW1h).toBe(2_000);
  });

  test("the adapter and the analytics counter agree", () => {
    const parsed = cc.parseFile(jsonl(records));
    expect(parsed.usageByModel).toEqual(ccUsageByModel(records));
    expect(parsed.usageByModel["claude-opus-5"]!.calls).toBe(2);
  });

  test("a synthetic record is never a call", () => {
    const synthetic = { type: "assistant", message: { id: "x", model: "<synthetic>", usage: { input_tokens: 0, output_tokens: 0 } } };
    expect(ccUsageByModel([synthetic])).toEqual({});
  });
});

describe("Codex: cumulative totals are never summed", () => {
  const readings = [
    cxTurnContext(T0, "gpt-5"),
    cxTokenCount(T0 + MIN, { prompt: 1, total: { input: 1_000, cached: 800, output: 100 } }),
    cxTokenCount(T0 + MIN, { prompt: 1, total: { input: 1_000, cached: 800, output: 100 } }), // repeated reading
    cxTokenCount(T0 + 2 * MIN, { prompt: 1, total: { input: 3_000, cached: 2_500, output: 300 } }),
    cxTurnContext(T0 + 3 * MIN, "o3"),
    cxTokenCount(T0 + 4 * MIN, { prompt: 1, total: { input: 4_000, cached: 3_000, output: 450 } }),
  ];

  test("usage is the growth between readings, attributed to the model in force", () => {
    const u = codexUsageByModel(readings);
    expect(u["gpt-5"]).toEqual({ in: 500, cacheR: 2_500, cacheW5m: 0, cacheW1h: 0, out: 300, calls: 2 });
    expect(u["o3"]).toEqual({ in: 500, cacheR: 500, cacheW5m: 0, cacheW1h: 0, out: 150, calls: 1 });
    const all = Object.values(u).reduce((a, m) => ({ in: a.in + m.in + m.cacheR, out: a.out + m.out }), { in: 0, out: 0 });
    expect(all).toEqual({ in: 4_000, out: 450 }); // equals the final totals, not their sum
  });

  test("a counter that goes backwards is re-based, never re-counted", () => {
    const reset = [...readings, cxTokenCount(T0 + 5 * MIN, { prompt: 1, total: { input: 100, cached: 0, output: 10 } }),
      cxTokenCount(T0 + 6 * MIN, { prompt: 1, total: { input: 300, cached: 0, output: 30 } })];
    expect(codexUsageByModel(reset)["o3"]).toEqual({ in: 700, cacheR: 500, cacheW5m: 0, cacheW1h: 0, out: 170, calls: 2 });
  });

  test("the adapter and the analytics counter agree", () => {
    const parsed = codex.parseFile(jsonl(readings));
    expect(parsed.usageByModel).toEqual(codexUsageByModel(readings));
  });
});

describe("pricing", () => {
  test("current Anthropic models have their own rows", () => {
    const at = (model: string) => ratesFor(model);
    expect(at("claude-fable-5-1")).toMatchObject({ matched: true, rates: { in: 10, out: 50, cacheR: 0.25, cacheW5m: 12.5, cacheW1h: 20 } });
    expect(at("claude-fable-5")).toMatchObject({ matched: true, rates: { in: 10, out: 50, cacheR: 1 } });
    expect(at("claude-mythos-5-1")).toMatchObject({ matched: true, rates: { in: 10, out: 50 } });
    expect(at("claude-opus-5-5")).toMatchObject({ matched: true, rates: { in: 4, out: 20, cacheR: 0.2, cacheW5m: 5, cacheW1h: 8 } });
    expect(at("claude-opus-5")).toMatchObject({ matched: true, rates: { in: 5, out: 25, cacheR: 0.5 } });
    for (const m of ["claude-opus-4-8", "claude-opus-4-7", "claude-opus-4-6"]) expect(at(m)).toMatchObject({ matched: true, rates: { in: 5, out: 25, cacheR: 0.5 } });
    expect(at("claude-sonnet-5")).toMatchObject({ matched: true, rates: { in: 2, out: 10, cacheR: 0.2 } });
    expect(at("claude-sonnet-4-6")).toMatchObject({ matched: true, rates: { in: 3, out: 15, cacheR: 0.3 } });
    expect(at("claude-haiku-4-5")).toMatchObject({ matched: true, rates: { in: 1, out: 5, cacheR: 0.1 } });
  });

  test("ids match through dates, context tags and provider prefixes", () => {
    expect(normalizeModelId("claude-opus-5-5[1m]")).toBe("claude-opus-5-5");
    expect(normalizeModelId("claude-haiku-4-5-20251001")).toBe("claude-haiku-4-5");
    expect(normalizeModelId("us.anthropic.claude-sonnet-4-5-20250929-v1:0")).toBe("claude-sonnet-4-5");
    expect(normalizeModelId("claude-opus-4-1@20250805")).toBe("claude-opus-4-1");
    expect(normalizeModelId("anthropic/claude-fable-5-1")).toBe("claude-fable-5-1");
    expect(ratesFor("claude-opus-4-1-20250805")).toMatchObject({ matched: true, rates: { in: 15 } });
  });

  test("an unknown model is never silently priced", () => {
    expect(ratesFor("claude-opus-5-9")).toMatchObject({ matched: false, pricedAs: "claude-opus-5" });
    expect(ratesFor("gpt-5.6-sol")).toMatchObject({ matched: false, pricedAs: "gpt-5" });
    expect(ratesFor("some-local-model")).toMatchObject({ matched: false, pricedAs: null });
    const priced = priceUsage({ "some-local-model": { in: 1_000_000, cacheR: 0, cacheW5m: 0, cacheW1h: 0, out: 0, calls: 1 } });
    expect(priced.unmatchedShare).toBe(1);
    expect(priced.byModel[0]).toMatchObject({ matched: false, pricedAs: null });
  });

  test("5-minute and 1-hour cache writes are priced separately", () => {
    const u = { in: 0, cacheR: 0, cacheW5m: 1_000_000, cacheW1h: 1_000_000, out: 0, calls: 1 };
    expect(priceUsage({ "claude-opus-5": u }).usd).toBeCloseTo(6.25 + 10, 6);
  });
});

describe("usage backfill", () => {
  let dir = "";
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  test("a legacy record that counted every usage line is re-counted from the store, once", () => {
    dir = mkdtempSync(join(tmpdir(), "carafe-usage-"));
    const store = new CarafeStore(join(dir, "store"));
    const raws = ccMessage(T0, "msg_a", ["thinking", "text", "tool_use"], { input_tokens: 10, cache_read_input_tokens: 100, output_tokens: 40 });
    const events: CarafeEvent[] = raws.map((raw, seq) => ({ ts: iso(T0), tool: "claude-code", sessionId: "legacy", seq, kind: "assistant", raw }));
    sealSession(store, "claude-code", "legacy", events);
    mkdirSync(join(store.root, "distillate", "claude-code"), { recursive: true });
    const d: SessionDistillate = {
      tool: "claude-code", sessionId: "legacy", sourcePath: "legacy", title: "t", cwd: null, gitBranch: null,
      startTs: iso(T0), endTs: iso(T0), eventCount: 3, toolUseCount: 1, sidechain: false, rawBytes: 0, version: 1,
      usage: { "claude-opus-5": { in: 30, cacheR: 300, cacheW5m: 0, cacheW1h: 0, out: 120, calls: 3 } },
    };
    writeFileSync(store.distillatePath("claude-code", "legacy"), JSON.stringify(d));

    expect(backfillUsage(store, { apply: true })).toMatchObject({ scanned: 1, applied: 1, failed: 0 });
    const after = JSON.parse(readFileSync(store.distillatePath("claude-code", "legacy"), "utf8")) as SessionDistillate;
    expect(after.usage).toEqual({ "claude-opus-5": { in: 10, cacheR: 100, cacheW5m: 0, cacheW1h: 0, out: 40, calls: 1 } });
    expect(after.usageV).toBe(USAGE_VERSION);
    expect(after.title).toBe("t");
    expect(backfillUsage(store, { apply: true }).scanned).toBe(0); // a second run is a no-op
  });
});
