/**
 * Cost from REAL usage records (not byte estimates), priced per model with
 * cache-tier awareness. Prices are $/Mtok and DRIFT — treat output as
 * "API-equivalent value" (what this usage would bill on the API), not an
 * invoice. Table is data: extend/correct freely; a model without its own row is
 * priced at its family's row or a blended rate, and always surfaced as such.
 * Usage in: each API call counted once (query/usage.ts).
 */

export interface ModelUsage {
  in: number;        // uncached input tokens
  cacheR: number;    // cache-read input tokens
  cacheW5m: number;  // cache-write (5m tier)
  cacheW1h: number;  // cache-write (1h tier)
  out: number;       // output tokens (incl. reasoning)
  calls: number;
}
export type UsageByModel = Record<string, ModelUsage>;

interface Rates { in: number; out: number; cacheR: number; cacheW5m: number; cacheW1h: number }
const M = 1_000_000;

/** Anthropic first-party rate: cache write = 1.25x input (5-minute TTL), 2x input (1-hour TTL). */
const anthropic = (input: number, output: number, cacheRead: number): Rates =>
  ({ in: input, out: output, cacheR: cacheRead, cacheW5m: input * 1.25, cacheW1h: input * 2 });

/**
 * $/Mtok, keyed by model id (see `normalizeModelId`: dates, "[1m]" and provider
 * prefixes are stripped before the lookup).
 *
 * Anthropic rates: first-party API prices from Anthropic's Claude API reference,
 * cached 2026-06-24. Cache writes are priced per tier where the usage record
 * carries the 5m/1h split (cache_creation.ephemeral_5m/1h_input_tokens), and at
 * the 5m rate (1.25x) where it does not. Older entries predate that source.
 */
const PRICE_TABLE: Record<string, Rates> = {
  "claude-fable-5-1": anthropic(10, 50, 0.25),
  "claude-fable-5": anthropic(10, 50, 1),
  // Same 10/50 tier as Fable. The 0.25 cache-read rate is stated for Fable 5.1
  // only; Mythos keeps the standard 0.1x until a source says otherwise.
  "claude-mythos-5-1": anthropic(10, 50, 1),
  "claude-mythos-5": anthropic(10, 50, 1),
  "claude-opus-5-5": anthropic(4, 20, 0.2),
  "claude-opus-5": anthropic(5, 25, 0.5),
  "claude-opus-4-8": anthropic(5, 25, 0.5),
  "claude-opus-4-7": anthropic(5, 25, 0.5),
  "claude-opus-4-6": anthropic(5, 25, 0.5),
  "claude-opus-4-5": anthropic(5, 25, 0.5),
  "claude-opus-4-1": anthropic(15, 75, 1.5),
  "claude-opus-4": anthropic(15, 75, 1.5),
  "claude-sonnet-5": anthropic(2, 10, 0.2),
  "claude-sonnet-4-6": anthropic(3, 15, 0.3),
  "claude-sonnet-4-5": anthropic(3, 15, 0.3),
  "claude-sonnet-4": anthropic(3, 15, 0.3),
  "claude-haiku-4-5": anthropic(1, 5, 0.1),
  "claude-3-5-haiku": anthropic(0.8, 4, 0.08),
  // OpenAI (cached input ~0.1x; no write charge)
  "gpt-5": { in: 1.25, out: 10, cacheR: 0.125, cacheW5m: 0, cacheW1h: 0 },
  "o3": { in: 2, out: 8, cacheR: 0.5, cacheW5m: 0, cacheW1h: 0 },
  "gpt-4.1": { in: 2, out: 8, cacheR: 0.5, cacheW5m: 0, cacheW1h: 0 },
};
/** A model in no table row and no known family: priced at a blended rate and flagged. */
const FALLBACK: Rates = { in: 3, out: 15, cacheR: 0.3, cacheW5m: 3.75, cacheW1h: 6 };

/**
 * The table key for a model id as traces write it: lower-cased, without a
 * "[1m]"-style context tag, a provider prefix ("anthropic/", "us.anthropic.",
 * "openai/"), a Vertex "@version", a Bedrock "-v1:0", or a release date.
 */
export function normalizeModelId(model: string): string {
  let m = model.trim().toLowerCase().replace(/\[[^\]]*\]$/, "");
  if (m.includes("/")) m = m.slice(m.lastIndexOf("/") + 1);
  const claude = m.indexOf("claude-");
  if (claude > 0) m = m.slice(claude);
  return m
    .replace(/@.*$/, "")
    .replace(/-v\d+(:\d+)?$/, "")
    .replace(/-\d{4}-\d{2}-\d{2}$/, "")
    .replace(/-\d{8}$/, "");
}

/**
 * exact: the model's own row. family: an unlisted member of a listed family
 * ("gpt-5.6-sol" → "gpt-5"), priced at that row and flagged. none: the blended
 * fallback, flagged. Never a silent guess.
 */
export function ratesFor(model: string): { rates: Rates; matched: boolean; pricedAs: string | null } {
  const id = normalizeModelId(model);
  const exact = PRICE_TABLE[id];
  if (exact) return { rates: exact, matched: true, pricedAs: id };
  let best: string | null = null;
  for (const key of Object.keys(PRICE_TABLE)) {
    if (id.length > key.length && id.startsWith(key) && /[-.@_]/.test(id[key.length]!) && (!best || key.length > best.length)) best = key;
  }
  return best ? { rates: PRICE_TABLE[best]!, matched: false, pricedAs: best } : { rates: FALLBACK, matched: false, pricedAs: null };
}

export interface CostResult {
  usd: number;
  // tokens        = billed/processed units incl. cache traffic (drives cost)
  // contentTokens = NEW tokens only (uncached input + output). Cache writes are
  //                 excluded too: the same context gets re-cached on every 5-min
  //                 TTL lapse, so across a resumed session they re-count the
  //                 transcript ~10x. in+out tracks the real transcript size.
  // matched: priced at the model's own table row. Otherwise pricedAs names the
  // family row used ("priced as gpt-5"), or is null for the blended fallback.
  byModel: Array<{ model: string; usd: number; matched: boolean; pricedAs: string | null; tokens: number; contentTokens: number }>;
  unmatchedShare: number; // 0..1 of dollars NOT priced at the model's own row
}

export function priceUsage(usage: UsageByModel): CostResult {
  const byModel: CostResult["byModel"] = [];
  let total = 0, unmatched = 0;
  for (const [model, u] of Object.entries(usage)) {
    const { rates, matched, pricedAs } = ratesFor(model);
    const usd = (u.in * rates.in + u.out * rates.out + u.cacheR * rates.cacheR
      + u.cacheW5m * rates.cacheW5m + u.cacheW1h * rates.cacheW1h) / M;
    const tokens = u.in + u.out + u.cacheR + u.cacheW5m + u.cacheW1h;
    const contentTokens = u.in + u.out; // no cache tiers: both re-count already-seen context
    byModel.push({ model, usd, matched, pricedAs, tokens, contentTokens });
    total += usd;
    if (!matched) unmatched += usd;
  }
  byModel.sort((a, b) => b.usd - a.usd);
  return { usd: total, byModel, unmatchedShare: total > 0 ? unmatched / total : 0 };
}

export const emptyUsage = (): ModelUsage => ({ in: 0, cacheR: 0, cacheW5m: 0, cacheW1h: 0, out: 0, calls: 0 });
