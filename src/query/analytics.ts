import type { SessionDistillate } from "../format/distillate";
import { priceUsage, type UsageByModel } from "./pricing";
import type { Hierarchy } from "./sessions";

export interface AnalyticsWindow {
  days: number;
  /** estimatedUsdShare: priced from bytes (no usage records); unpricedUsdShare:
   *  priced from usage but not at the model's own table row. */
  totals: { usd: number; estimatedUsdShare: number; unpricedUsdShare: number; tokens: number; sessions: number; subRuns: number };
  daily: Array<{ date: string; usd: number; sessions: number }>;
  byTool: Array<{ tool: string; usd: number; sessions: number }>;
  byModel: Array<{ model: string; usd: number; matched: boolean; pricedAs: string | null }>;
  topDrains: Array<{ id: string; title: string | null; tool: string; usd: number; subs: number; endTs: string | null }>;
  maxFanout: { id: string; title: string | null; count: number; usd: number } | null;
}

interface SessionCost {
  usd: number;
  estimatedUsd: number;
  unpricedUsd: number;
  tokens: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function localDate(ts: number): string {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function startOfLocalDay(ts: number): number {
  const d = new Date(ts);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

function sessionCost(s: SessionDistillate): SessionCost {
  if (s.usage) {
    const priced = priceUsage(s.usage as UsageByModel);
    return {
      usd: priced.usd,
      estimatedUsd: 0,
      unpricedUsd: priced.usd * priced.unmatchedShare,
      tokens: priced.byModel.reduce((sum, m) => sum + m.contentTokens, 0), // exclude cache re-reads
    };
  }
  const tokens = s.rawBytes / 4;
  const usd = tokens * 8 / 1_000_000;
  return { usd, estimatedUsd: usd, unpricedUsd: 0, tokens };
}

function isSubRun(h: Hierarchy, s: SessionDistillate): boolean {
  return !!h.parentOf[s.sessionId] || !!s.sidechain || !!h.orphanSpawns[s.sessionId];
}

export function computeAnalytics(h: Hierarchy, days: number, now = Date.now()): AnalyticsWindow {
  const todayStart = startOfLocalDay(now);
  const windowStart = todayStart - (days - 1) * DAY_MS;
  const daily = new Map<string, { date: string; usd: number; sessions: number }>();
  for (let i = 0; i < days; i++) {
    const date = localDate(windowStart + i * DAY_MS);
    daily.set(date, { date, usd: 0, sessions: 0 });
  }

  const byTool = new Map<string, { tool: string; usd: number; sessions: number }>();
  const byModel = new Map<string, { model: string; usd: number; matched: boolean; pricedAs: string | null }>();
  const topDrains: AnalyticsWindow["topDrains"] = [];

  let totalUsd = 0;
  let estimatedUsd = 0;
  let unpricedUsd = 0;
  let tokens = 0;
  let sessions = 0;
  let subRuns = 0;

  const inWindow = h.sessions.filter((s) => {
    if (!s.endTs) return false;
    const t = Date.parse(s.endTs);
    return Number.isFinite(t) && t >= windowStart && t <= now;
  });

  for (const s of inWindow) {
    const cost = sessionCost(s);
    const subRun = isSubRun(h, s);
    totalUsd += cost.usd;
    estimatedUsd += cost.estimatedUsd;
    unpricedUsd += cost.unpricedUsd;
    tokens += cost.tokens;
    if (subRun) subRuns++;
    else sessions++;

    const date = localDate(Date.parse(s.endTs!));
    const d = daily.get(date);
    if (d) {
      d.usd += cost.usd;
      if (!subRun) d.sessions++;
    }

    const tool = byTool.get(s.tool) ?? { tool: s.tool, usd: 0, sessions: 0 };
    tool.usd += cost.usd;
    tool.sessions++;
    byTool.set(s.tool, tool);

    if (s.usage) {
      for (const m of priceUsage(s.usage as UsageByModel).byModel) {
        const cur = byModel.get(m.model) ?? { model: m.model, usd: 0, matched: m.matched, pricedAs: m.pricedAs };
        cur.usd += m.usd;
        cur.matched = cur.matched && m.matched;
        byModel.set(m.model, cur);
      }
    }

    topDrains.push({
      id: s.sessionId,
      title: s.title,
      tool: s.tool,
      usd: cost.usd,
      subs: (h.childrenOf[s.sessionId] ?? []).length,
      endTs: s.endTs,
    });
  }

  let maxFanout: AnalyticsWindow["maxFanout"] = null;
  for (const s of inWindow) {
    if (isSubRun(h, s)) continue;
    const children = h.childrenOf[s.sessionId] ?? [];
    if (!children.length) continue;
    if (!maxFanout || children.length > maxFanout.count) {
      const own = sessionCost(s).usd;
      const childUsd = children.reduce((sum, c) => sum + sessionCost(c).usd, 0);
      maxFanout = { id: s.sessionId, title: s.title, count: children.length, usd: own + childUsd };
    }
  }

  return {
    days,
    totals: {
      usd: totalUsd,
      estimatedUsdShare: totalUsd > 0 ? estimatedUsd / totalUsd : 0,
      unpricedUsdShare: totalUsd > 0 ? unpricedUsd / totalUsd : 0,
      tokens: Math.round(tokens),
      sessions,
      subRuns,
    },
    daily: [...daily.values()],
    byTool: [...byTool.values()].sort((a, b) => b.usd - a.usd),
    byModel: [...byModel.values()].sort((a, b) => b.usd - a.usd).slice(0, 8),
    topDrains: topDrains.sort((a, b) => b.usd - a.usd).slice(0, 6),
    maxFanout,
  };
}
