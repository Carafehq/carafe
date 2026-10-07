/**
 * Distillate — the small, per-session summary record. THE ONLY LAYER THAT EVER
 * GETS INDEXED (search index in task 5 builds from these). Everything here is
 * cheap and deterministic; LLM-distilled handoffs are a different, closed-tier
 * artifact (Phase 2).
 */
import { mkdirSync } from "fs";
import { dirname } from "path";
import { isInjectedBlock } from "../adapters/types";
import { atomicWriteFileSync, type CarafeStore } from "./store";

export type TitleSource = "codex-index" | "codex-tool" | "derived" | "continued" | "weak" | "cc-title" | "human";

const TITLE_STRENGTH: Record<TitleSource, number> = {
  weak: 0,
  continued: 1,
  derived: 2,
  "codex-tool": 3,
  "codex-index": 4,
  "cc-title": 4,
  human: 5,
};

const RENAME_SOURCES: ReadonlySet<TitleSource> = new Set(["codex-index", "codex-tool", "cc-title", "human"]);

/** Infer provenance for records written before `titleSource` existed. Claude
 * Code's stored titles came from its own title events; Codex's came from the
 * first user message. Injected machinery is weak regardless of tool. */
export function effectiveTitleSource(
  tool: string,
  title: string | null | undefined,
  source: TitleSource | undefined,
): TitleSource {
  if (source !== undefined) return source;
  if (!title || isInjectedBlock(title)) return "weak";
  return tool === "claude-code" ? "cc-title" : "derived";
}

/** True exactly when the proposed title wins the documented source order.
 * Equal provenance is a rename only for sources that carry an explicit rename
 * event. Re-deriving fallback text is never evidence that a title changed. */
export function mayReplaceTitle(
  tool: string,
  currentTitle: string | null | undefined,
  currentSource: TitleSource | undefined,
  nextTitle: string | null | undefined,
  nextSource: TitleSource,
): boolean {
  if (!nextTitle) return false;
  if (!currentTitle) return true;
  const current = effectiveTitleSource(tool, currentTitle, currentSource);
  const delta = TITLE_STRENGTH[nextSource] - TITLE_STRENGTH[current];
  if (delta !== 0) return delta > 0;
  return current === nextSource && RENAME_SOURCES.has(nextSource) && nextTitle !== currentTitle;
}

export function applyTitleCandidate(
  distillate: SessionDistillate,
  title: string | null,
  source: TitleSource,
): void {
  if (mayReplaceTitle(distillate.tool, distillate.title, distillate.titleSource, title, source)) {
    distillate.title = title;
    distillate.titleSource = source;
  } else if (distillate.titleSource === undefined) {
    distillate.titleSource = effectiveTitleSource(distillate.tool, distillate.title, undefined);
  }
}

export interface SessionDistillate {
  tool: string;
  sessionId: string;
  internalSessionId?: string;  // when file stem differs from the id inside events
  sourcePath: string;
  title: string | null;        // custom-title > ai-title > first user prompt (truncated)
  /** Provenance controls whether later imports/backfills may replace `title`. */
  titleSource?: TitleSource;
  cwd: string | null;
  gitBranch: string | null;
  startTs: string | null;
  endTs: string | null;
  /** Absent only in legacy distillates awaiting the store-only backfill. */
  lastActivityTs?: string | null;
  internal?: boolean;
  hasUserText?: boolean;
  eventCount: number;
  toolUseCount: number;
  sidechain: boolean;          // sub-agent session (CC isSidechain)
  codexCalls?: string[];       // timestamps of codex-spawning tool calls (parent→subsession links)
  originator?: string;         // codex: how launched ("codex_exec" = spawned, "Codex Desktop" = interactive)
  sourceKind?: string;         // codex: "exec" | "subagent" | "vscode" | ...
  /** REAL token usage per model, from the trace's own usage records (cache-tiered) */
  usage?: Record<string, { in: number; cacheR: number; cacheW5m: number; cacheW1h: number; out: number; calls: number }>;
  /** the counting rules `usage` was derived with (query/usage.ts USAGE_VERSION); absent = legacy, re-counted by the backfill */
  usageV?: number;
  received?: { from: string | null; at: string };
  rawBytes: number;
  version: 1;
}

export function writeDistillate(store: CarafeStore, d: SessionDistillate): void {
  const p = store.distillatePath(d.tool, d.sessionId);
  mkdirSync(dirname(p), { recursive: true });
  atomicWriteFileSync(p, JSON.stringify(d));
}
