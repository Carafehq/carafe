/**
 * Usage backfill: re-derive each session's per-model usage from events ALREADY
 * IN CARAFE'S OWN STORE, with the current counting rules (query/usage.ts).
 *
 * Distillates written before USAGE_VERSION counted every Claude Code usage line
 * (one per content block, so a call ~2x) and priced Codex from the last
 * cumulative reading only. An import rewrites a distillate only when its source
 * changes, so an old session would keep the inflated numbers forever; this pass
 * fixes them in place. Sealed envelopes are read without resolving blobs: the
 * usage numbers and message ids are never large enough to be extracted. Every
 * write is atomic, and a migrated record is stamped, so a second run is a no-op.
 */
import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import type { SessionDistillate } from "../format/distillate";
import { writeDistillate } from "../format/distillate";
import { readSessionEnvelopes } from "../format/sessions";
import { CarafeStore } from "../format/store";
import type { UsageByModel } from "../query/pricing";
import { ccUsageByModel, codexUsageByModel, USAGE_VERSION } from "../query/usage";

export interface UsageBackfillResult {
  scanned: number;
  applied: number;
  failed: number;
  /** `<tool>/<id>` of sessions whose events could not be read (the caller skips them next pass) */
  unreadable: string[];
}

const TOOLS = ["claude-code", "codex"] as const;

export function needsUsageBackfill(d: SessionDistillate): boolean {
  return (d.tool === "claude-code" || d.tool === "codex") && d.usageV !== USAGE_VERSION;
}

/** Usage per model from a session's stored records, by the current rules. */
export function usageFromRecords(tool: string, records: unknown[]): UsageByModel {
  return tool === "codex" ? codexUsageByModel(records) : ccUsageByModel(records);
}

export function backfillUsage(
  store: CarafeStore,
  opts: { apply?: boolean; limit?: number; maxMs?: number; skip?: ReadonlySet<string>; now?: () => number } = {},
): UsageBackfillResult {
  const limit = opts.limit ?? Number.MAX_SAFE_INTEGER;
  const now = opts.now ?? Date.now;
  const started = now();
  const result: UsageBackfillResult = { scanned: 0, applied: 0, failed: 0, unreadable: [] };
  for (const tool of TOOLS) {
    const dir = join(store.root, "distillate", tool);
    let files: string[] = [];
    try { files = readdirSync(dir); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith(".json")) continue;
      if (result.scanned >= limit) return result;
      if (result.scanned > 0 && opts.maxMs !== undefined && now() - started >= opts.maxMs) return result;
      let d: SessionDistillate;
      try { d = JSON.parse(readFileSync(join(dir, f), "utf8")) as SessionDistillate; } catch { continue; }
      if (!needsUsageBackfill(d)) continue;
      const key = `${d.tool}/${d.sessionId}`;
      if (opts.skip?.has(key)) continue;
      result.scanned++;
      let usage: UsageByModel;
      try { usage = usageFromRecords(d.tool, readSessionEnvelopes(store, d.tool, d.sessionId).map((e) => e.raw)); }
      catch { result.failed++; result.unreadable.push(key); continue; }
      // No usage records in the stored events (a package received without
      // them): keep what the record already says rather than erase it.
      const next: SessionDistillate = {
        ...d,
        usage: Object.keys(usage).length ? usage : d.usage,
        usageV: USAGE_VERSION,
      };
      if (!opts.apply) continue;
      try { writeDistillate(store, next); result.applied++; }
      catch { result.failed++; }
    }
  }
  return result;
}

export function runReindexUsage(opts: { apply?: boolean } = {}): void {
  const r = backfillUsage(new CarafeStore(), { apply: opts.apply });
  if (!opts.apply) {
    console.log(`${r.scanned} session(s) would have their usage re-counted (each API call once).${r.failed ? ` ${r.failed} unreadable.` : ""}`);
    console.log(`\nre-run with --yes to write.`);
    return;
  }
  console.log(`re-counted usage for ${r.applied} / ${r.scanned} session(s)${r.failed ? `, ${r.failed} skipped` : ""}.`);
}
