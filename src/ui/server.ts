/**
 * carafe ui — the switcher, served locally. Structure (founder-confirmed):
 * search on top, sessions below, detail on the right with the pure trace and a
 * hand-off-to-individual picker where agents are first-class recipients.
 * Reuses the same engine as the CLI (search index, session queries, handoff).
 */
import { existsSync, readdirSync } from "fs";
import { join, resolve } from "path";
import { CarafeStore } from "../format/store";
import type { SessionDistillate } from "../format/distillate";
import { SearchIndex } from "../search/index";
import { activityTs, findSession, isNoise, isSpawned, listWithHierarchy } from "../query/sessions";
import { readSession } from "../format/sessions";
import { extractPieces } from "../handoff/pieces";
import { runHandoff } from "../handoff/handoff";
import { CHARS_PER_TOKEN, tokenEstimate } from "../handoff/render";
import { summarize } from "../query/summary";
import { runImport } from "../cli/import";
import { releaseWatchLock, tryAcquireWatchLock, watchLockHolderPid, type WatchLock } from "../cli/watch-lock";
import { isServiceLoaded, servicePaths } from "../cli/service";
import { computeAnalytics } from "../query/analytics";
import { listCheckpoints } from "../state/checkpoint";
import { listRefCheckpoints } from "../state/gitrefs";
import { applyUndo, planUndo, writeRewindBrief, type UndoPlan } from "../state/undo";
import { pageHtml } from "./html";
import { loadPro, notInBuild, proRouteFeature } from "../tier";

const PIECE_BUDGET = 300_000; // chars of trace to ship to the detail pane before "grep for the rest"

// pieces cache: paging/grep through a big session must not re-read + re-extract
// the whole session per request. Keyed by sessionId+thinking, invalidated by endTs.
const pieceCache = new Map<string, { stamp: string; events: ReturnType<typeof readSession>; pieces: ReturnType<typeof extractPieces>; allPieces: ReturnType<typeof extractPieces>; summary: ReturnType<typeof summarize> }>();
function getPieces(store: CarafeStore, d: any, thinking: boolean) {
  const key = d.sessionId + (thinking ? ":t" : "");
  const stamp = d.endTs ?? "";
  const hit = pieceCache.get(key);
  if (hit && hit.stamp === stamp) return hit;
  const events = readSession(store, d.tool, d.sessionId);
  const allPieces = extractPieces(events, { includeThinking: thinking }, {});
  const pieces = allPieces.filter((p) => p.lines.length > 0);
  const summary = summarize(d, events);
  if (pieceCache.size > 4) pieceCache.delete(pieceCache.keys().next().value!);
  const entry = { stamp, events, pieces, allPieces, summary };
  pieceCache.set(key, entry);
  return entry;
}

function detectAgents(store: CarafeStore): string[] {
  try {
    const tools = readdirSync(join(store.root, "distillate")).filter((t) => !t.startsWith("."));
    const set = new Set(tools);
    set.add("claude-code"); set.add("codex");
    return [...set];
  } catch { return ["claude-code", "codex"]; }
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

function planDetail(plan: UndoPlan) {
  const human = (n: number | null) => {
    if (n === null) return "not present";
    if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)}MB`;
    if (n >= 1024) return `${(n / 1024).toFixed(1)}KB`;
    return `${n}B`;
  };
  const restore = (f: string) => {
    const d = plan.detail[f];
    return d ? `${f} (now ${human(d.cur)} → becomes ${human(d.snap)})` : f;
  };
  const move = (f: string) => {
    const d = plan.detail[f];
    return d ? `${f} (${human(d.cur)} — set aside in stash)` : f;
  };
  return {
    restore: plan.restore.map(restore),
    unchanged: plan.unchanged,
    moveToStash: plan.moveToStash.map(move),
  };
}

function checkpointSummary(store: CarafeStore, d: any) {
  const local = listCheckpoints(store, d.tool, d.sessionId);
  let refs: Array<{ seq: number; sha: string }> = [];
  if (d.cwd) {
    try { refs = listRefCheckpoints(d.cwd, d.tool, d.sessionId); } catch { refs = []; }
  }
  const seqs = [...local.map((c) => c.seq), ...refs.map((c) => c.seq)];
  if (!seqs.length) return { count: 0, latestSeq: null, firstSeq: null };
  return { count: new Set(seqs).size, latestSeq: Math.max(...seqs), firstSeq: Math.min(...seqs) };
}

function withCheckpointError(store: CarafeStore, d: any, plan: UndoPlan): UndoPlan {
  if (!plan.errors.some((e) => e.startsWith("no checkpoint at or before seq "))) return plan;
  const summary = checkpointSummary(store, d);
  return {
    ...plan,
    errors: [`no checkpoint at or before seq ${plan.targetSeq} — ${summary.firstSeq == null ? "no checkpoints exist yet" : `checkpoints began ${summary.firstSeq}`}`],
  };
}

/** What an open build answers on a Carafe Pro endpoint: a 404 that says why. */
export function proRouteMissing(feature: "share" | "distill"): { error: string; tier: "pro"; feature: string } {
  const what = feature === "share" ? "Person-to-person share and receive" : "Decision-ledger distillation";
  return { error: notInBuild(what), tier: "pro", feature };
}

/** The sidebar's default rows. Same hidden-by-default rule as `carafe list`
 *  via the shared `isNoise` predicate — a reviewer run or an aborted start is
 *  noise on every surface — plus the agent-spawned workers that would otherwise
 *  bury a human's own sessions, and the same honest recency order. `?all=1`
 *  shows everything. Server-side only: the sidebar must never be re-filtered by DOM
 *  mutation during a passive scroll. */
export function recentSessions(
  h: { sessions: SessionDistillate[]; parentOf: Record<string, unknown>; orphanSpawns: Record<string, unknown> },
  opts: { all?: boolean; tool?: string } = {},
): SessionDistillate[] {
  return h.sessions
    .filter((d) => (opts.all ? true : !d.sidechain && !h.parentOf[d.sessionId] && !h.orphanSpawns[d.sessionId] && !isNoise(d) && !isSpawned(d))
      && (opts.tool ? d.tool === opts.tool : true))
    .sort((a, b) => (activityTs(b) ?? "").localeCompare(activityTs(a) ?? ""));
}

/** What `/api/handoff` reports a handoff costs to read. THE SHARED estimate:
 *  a trace is denser than prose, and the old chars/4 halved what the receiving
 *  agent actually pays — exactly the error that makes it read the wrong thing. */
export function handoffTokens(bytes: number): { tokens: number; tokenLabel: string } {
  return { tokens: Math.round(bytes / CHARS_PER_TOKEN), tokenLabel: tokenEstimate(bytes) };
}

export async function runUI(opts: { port?: number; open?: boolean } = {}): Promise<void> {
  const store = new CarafeStore();
  const idx = new SearchIndex(store);
  const serviceFilePresent = existsSync(servicePaths().serviceFile);
  if (watchLockHolderPid(store.root) === null && (!serviceFilePresent || !isServiceLoaded())) {
    process.stderr.write("capture is not running as a service — run `carafe service enable` so history stays fresh when the UI is closed\n");
  }
  // The UI captures when no dedicated watcher is active. Both paths share one
  // lock, so opening the UI never creates a second importer. If the owner exits,
  // the UI retries and takes over freshness on its next six-second tick.
  let captureLock: WatchLock | undefined;
  const ownsCapture = () => {
    if (captureLock) return true;
    captureLock = tryAcquireWatchLock(store.root, { writePidFile: false }) ?? undefined;
    return !!captureLock;
  };
  process.once("exit", () => { if (captureLock) releaseWatchLock(captureLock); });
  const stop = () => process.exit(0);
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  let syncing = false;
  const sync = async (label?: string) => {
    if (syncing) return; syncing = true;
    try {
      if (!ownsCapture()) {
        if (label) process.stderr.write(`${label}: capture already handled by another Carafe process\n`);
        return;
      }
      const r = await runImport({ quiet: true, snapshot: true });
      if (r.filesImported > 0 || idx.isStale()) idx.reindex();
      if (label || r.filesImported > 0) process.stderr.write(`${label ?? "sync"}: ${r.filesImported} new session file(s)\n`);
    } catch (e) { process.stderr.write(`sync error (will retry): ${(e as Error).message}\n`); }
    finally { syncing = false; }
  };
  process.stderr.write("capturing latest + indexing corpus… ");
  await sync("boot");
  setInterval(() => { sync(); }, 6000).unref?.();
  const port = opts.port ?? 4319;
  const pro = await loadPro();
  const page = pageHtml(pro?.features ?? []);

  const server = Bun.serve({
    port,
    async fetch(req) {
      const url = new URL(req.url);
      const p = url.pathname;
      try {
        if (p === "/" || p === "/index.html") return new Response(page, { headers: { "content-type": "text/html" } });

        const proFeature = proRouteFeature(p);
        if (proFeature) {
          if (!pro || !pro.features.includes(proFeature)) return json(proRouteMissing(proFeature), 404);
          const handled = await pro.handleUi(req, {
            store, url, json,
            pieces: (d) => getPieces(store, d, false).pieces,
            afterReceive: () => { idx.reindex(); pieceCache.clear(); },
          });
          if (handled) return handled;
        }

        if (p === "/api/agents") return json({ agents: detectAgents(store) });

        if (p === "/api/analytics") {
          const days = url.searchParams.get("days") === "30" ? 30 : 7;
          return json(computeAnalytics(listWithHierarchy(store), days));
        }

        if (p === "/api/sessions") {
          const q = (url.searchParams.get("q") ?? "").trim();
          const tool = url.searchParams.get("tool") || undefined;
          const all = url.searchParams.get("all") === "1";
          const limit = Number(url.searchParams.get("limit") ?? 30);
          const h = listWithHierarchy(store);
          if (!q) {
            const s = recentSessions(h, { all, tool }).slice(0, limit);
            return json({
              mode: "recent",
              results: s.map((d) => ({
                ...toCard(d),
                subCount: (h.childrenOf[d.sessionId] ?? []).length,
                subs: (h.childrenOf[d.sessionId] ?? []).map((c) => ({ id: c.sessionId, title: c.title, endTs: c.endTs, events: c.eventCount })),
              })),
            });
          }
          const hits = idx.search(q, { limit, tool, includeSidechain: all });
          return json({ mode: "search", results: hits.map((x) => ({ ...toCardFromHit(x), snippet: x.snippet, sub: !!h.parentOf[x.sessionId] || !!h.orphanSpawns[x.sessionId] })) });
        }

        const mSes = p.match(/^\/api\/session\/([^/]+)$/);
        if (mSes) {
          const d = findSession(store, decodeURIComponent(mSes[1]!));
          if (!d) return json({ error: "not found" }, 404);
          const { pieces, summary } = getPieces(store, d, url.searchParams.get("thinking") === "1");
          pieces.forEach((p, i) => { (p as any).idx = i; }); // stable position within the full session
          const totalChars = pieces.reduce((a, p) => a + p.chars, 0);
          // Windowed view with chunked continuation: full when it fits; otherwise
          // tail by default (the working state), start on request, and
          // ?before=seq / ?after=seq page through adjacent chunks so scrolling
          // can walk the WHOLE session, and search hits can jump anywhere.
          const takeFront = (src: typeof pieces) => { let b = PIECE_BUDGET; const w: typeof pieces = []; for (const pc of src) { if (b - pc.chars < 0 && w.length) break; b -= pc.chars; w.push(pc); } return w; };
          const takeBack = (src: typeof pieces) => { let b = PIECE_BUDGET; const w: typeof pieces = []; for (let i = src.length - 1; i >= 0; i--) { const pc = src[i]!; if (b - pc.chars < 0 && w.length) break; b -= pc.chars; w.unshift(pc); } return w; };
          const beforeQ = url.searchParams.get("before"); const afterQ = url.searchParams.get("after"); const atQ = url.searchParams.get("at");
          let view = "full"; let windowPieces = pieces;
          if (beforeQ != null) { view = "chunk"; windowPieces = takeBack(pieces.filter((p) => p.seq < Number(beforeQ))); }
          else if (afterQ != null) { view = "chunk"; windowPieces = takeFront(pieces.filter((p) => p.seq >= Number(afterQ))); }
          else if (atQ != null) { // fraction 0..1 → jump anywhere on the scrubber
            const f = Math.min(1, Math.max(0, Number(atQ) || 0));
            view = "chunk"; windowPieces = takeFront(pieces.slice(Math.floor(f * Math.max(0, pieces.length - 1))));
          }
          else if (totalChars > PIECE_BUDGET) {
            view = url.searchParams.get("view") === "start" ? "start" : "tail";
            windowPieces = view === "start" ? takeFront(pieces) : takeBack(pieces);
          }
          const hasBefore = windowPieces.length > 0 && pieces.length > 0 && windowPieces[0]!.seq > pieces[0]!.seq;
          const hasAfter = windowPieces.length > 0 && pieces.length > 0 && windowPieces[windowPieces.length - 1]!.seq < pieces[pieces.length - 1]!.seq;
          const hier = listWithHierarchy(store);
          const parentId = hier.parentOf[d.sessionId];
          const parentD = parentId ? findSession(store, parentId) : null;
          const subs = (hier.childrenOf[d.sessionId] ?? []).map((c) => ({ id: c.sessionId, title: c.title, endTs: c.endTs, events: c.eventCount }));
          const checkpoints = checkpointSummary(store, d);
          return json({
            meta: toCard(d), analytics: summary.analytics, notes: summary.notes,
            resumeId: d.internalSessionId || d.sessionId,
            parent: parentD ? { id: parentD.sessionId, title: parentD.title } : null,
            subsessions: subs,
            checkpoints,
            pieces: windowPieces.map((p) => ({ seq: p.seq, kind: p.kind, lines: p.lines, ts: p.ts, idx: (p as any).idx })),
            view, total: pieces.length, hasBefore, hasAfter,
            windowStart: windowPieces[0]?.seq ?? 0, windowEnd: windowPieces[windowPieces.length - 1]?.seq ?? 0,
          });
        }

        const mUndoPlan = p.match(/^\/api\/session\/([^/]+)\/undo\/plan$/);
        if (mUndoPlan && req.method === "GET") {
          const d = findSession(store, decodeURIComponent(mUndoPlan[1]!));
          if (!d) return json({ error: "not found" }, 404);
          const seq = Number(url.searchParams.get("seq"));
          if (!Number.isFinite(seq)) return json({ error: "seq is required" }, 400);
          const plan = withCheckpointError(store, d, planUndo(store, d, seq));
          return json({ plan: { ...plan, detailLines: planDetail(plan) } });
        }

        const mUndo = p.match(/^\/api\/session\/([^/]+)\/undo$/);
        if (mUndo && req.method === "POST") {
          const d = findSession(store, decodeURIComponent(mUndo[1]!));
          if (!d) return json({ error: "not found" }, 404);
          const body = await req.json() as { seq?: number };
          const seq = Number(body.seq);
          if (!Number.isFinite(seq)) return json({ error: "seq is required" }, 400);
          const plan = withCheckpointError(store, d, planUndo(store, d, seq));
          if (plan.errors.length) return json({ error: plan.errors.join("\n"), plan }, 400);
          const result = applyUndo(store, d, plan);
          const brief = writeRewindBrief(store, d, readSession(store, d.tool, d.sessionId), seq);
          return json({ restored: result.restored, moved: result.moved, stashDir: result.stashDir, briefPath: brief });
        }

        const mKm = p.match(/^\/api\/session\/([^/]+)\/key-moments$/);
        if (mKm && req.method === "GET") {
          const d = findSession(store, decodeURIComponent(mKm[1]!));
          if (!d) return json({ error: "not found" }, 404);
          const { events, allPieces: pieces } = getPieces(store, d, false);
          const { extractMoments } = await import("../keymoments/extract");
          const { segmentChapters } = await import("../keymoments/chapters");
          const { renderResumeBlock } = await import("../keymoments/render");
          const set = extractMoments({ events, pieces });
          const chapters = segmentChapters(events, pieces, {}, set.moments, set.context.runs);
          const block = renderResumeBlock(d, set, { chapters });
          return json({ moments: block.moments, chapters, resumeBlock: block.text, trimmed: block.trimmed });
        }

        const mAsk = p.match(/^\/api\/session\/([^/]+)\/ask$/);
        if (mAsk && req.method === "GET") {
          const d = findSession(store, decodeURIComponent(mAsk[1]!));
          if (!d) return json({ error: "not found" }, 404);
          const { ASK_KINDS } = await import("../search/session-index");
          const { openFreshSessionIndex } = await import("../cli/ask");
          const kind = url.searchParams.get("kind") || undefined;
          if (kind && !ASK_KINDS.includes(kind as (typeof ASK_KINDS)[number])) return json({ error: `unknown kind: ${kind}` }, 400);
          const chapterText = url.searchParams.get("chapter");
          const limitText = url.searchParams.get("limit");
          const opts = {
            file: url.searchParams.get("file") || undefined,
            kind: kind as (typeof ASK_KINDS)[number] | undefined,
            chapter: chapterText == null ? undefined : Number(chapterText),
            failed: url.searchParams.get("failed") === "1" || url.searchParams.get("failed") === "true",
            command: url.searchParams.get("command") || undefined,
            branch: url.searchParams.get("branch") || undefined,
            limit: limitText == null ? undefined : Number(limitText),
          };
          const index = openFreshSessionIndex(store, d, {
            noBuild: url.searchParams.get("no-build") === "1",
            onBuild: (reason) => process.stderr.write(`session index ${reason}; building ${d.sessionId}…\n`),
          });
          try {
            const filtered = !!(opts.file || opts.kind || opts.chapter != null || opts.failed || opts.command || opts.branch);
            return json(filtered ? index.ask(opts) : index.overview());
          } finally { index.close(); }
        }

        const mChapters = p.match(/^\/api\/session\/([^/]+)\/chapters$/);
        if (mChapters && req.method === "GET") {
          const d = findSession(store, decodeURIComponent(mChapters[1]!));
          if (!d) return json({ error: "not found" }, 404);
          const { events, allPieces } = getPieces(store, d, false);
          const { segmentChapters } = await import("../keymoments/chapters");
          return json(segmentChapters(events, allPieces));
        }

        const mGrep = p.match(/^\/api\/session\/([^/]+)\/grep$/);
        if (mGrep) {
          const d = findSession(store, decodeURIComponent(mGrep[1]!));
          if (!d) return json({ error: "not found" }, 404);
          const q = (url.searchParams.get("q") ?? "").trim();
          if (!q) return json({ hits: [] });
          let re: RegExp; try { re = new RegExp(q, "i"); } catch { return json({ error: "bad pattern" }, 400); }
          const { pieces } = getPieces(store, d, false);
          const hits: any[] = [];
          for (const pc of pieces) for (const line of pc.lines) {
            if (re.test(line) && hits.length < 60) {
              const i = line.search(re);
              hits.push({ seq: pc.seq, snippet: line.slice(Math.max(0, i - 40), i + 90).replace(/\n/g, " ") });
            }
          }
          return json({ hits });
        }

        if (p === "/api/handoff" && req.method === "POST") {
          const body = await req.json() as { id: string; to?: string };
          // runHandoff writes the file + logs; capture the outcome by re-deriving it cheaply
          const d = findSession(store, body.id);
          if (!d) return json({ error: "not found" }, 404);
          await runHandoff(body.id, { store, to: body.to, interactive: false });
          const file = resolve(store.root, "handoffs", `${d.sessionId}.md`);
          const bytes = (await Bun.file(file).text()).length;
          return json({ ok: true, file, ...handoffTokens(bytes), to: body.to });
        }

        return new Response("not found", { status: 404 });
      } catch (e) {
        return json({ error: (e as Error).message }, 500);
      }
    },
  });

  const addr = `http://localhost:${server.port}`;
  console.log(`carafe ui → ${addr}  (ctrl-c to stop)`);
  if (opts.open !== false) { try { Bun.spawn(["open", addr]); } catch { /* non-mac */ } }
}

function toCard(d: any) {
  return { id: d.sessionId, tool: d.tool, title: d.title, cwd: d.cwd, branch: d.gitBranch,
    startTs: d.startTs, endTs: d.endTs, events: d.eventCount, tools: d.toolUseCount, sidechain: d.sidechain };
}
function toCardFromHit(h: any) {
  return { id: h.sessionId, tool: h.tool, title: h.title, cwd: h.cwd, branch: h.gitBranch,
    endTs: h.endTs, events: h.eventCount, tools: 0, sidechain: h.sidechain };
}
