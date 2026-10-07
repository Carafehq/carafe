/**
 * carafe import — backfill all existing CC + Codex history into the store.
 * Incremental (skips unchanged sources via manifest). Read-only on sources.
 */
import { CarafeStore } from "../format/store";
import { extractBlobs, type CarafeEvent } from "../format/events";
import { sealSession, readSession } from "../format/sessions";
import { applyTitleCandidate, writeDistillate, type SessionDistillate } from "../format/distillate";
import { resolveTitleCandidate } from "../format/recompute";
import { maybeAutoCheckpoint, snapshotCandidate } from "../state/checkpoint";
import { ADAPTERS, type Adapter } from "../adapters/registry";
import { readCodexThreadNames } from "../adapters/codex-names";
import type { SourceFile, ParsedSession } from "../adapters/types";
import { readFileSync } from "fs";
import { USAGE_VERSION } from "../query/usage";


const MB = (n: number) => (n / 1024 / 1024).toFixed(1) + "MB";

export interface ImportResult {
  filesImported: number;
  filesSkipped: number;
  newSessions: Array<{ tool: string; id: string; title: string | null }>;
  /** Every stored session whose source file was imported on this tick. */
  changedSessions: Array<{ tool: string; id: string }>;
  storedBytes: number;
  rawBytes: number;
  checkpointsTaken: number;
  /** Source files opened on this run (a stat-only run opens none). */
  sourcesRead: number;
  /** With `snapshot: "defer"`: the snapshots this run would have taken, newest
   *  first, for the caller to take later within its own budget. */
  deferredSnapshots: DeferredSnapshot[];
}

/** An automatic snapshot owed to a session, keyed to its newest user turn. */
export interface DeferredSnapshot { tool: string; id: string; seq: number; ts: string }

export type ImportStage = "discover" | "read sources" | "write sessions" | "distillates" | "snapshots" | "index catalog";

export interface ImportOptions {
  limit?: number; tool?: string; quiet?: boolean; force?: boolean;
  /** true: snapshot each changed session inline. "defer": capture only, and
   *  return the owed snapshots (the watcher's first import after a restart,
   *  where git probes on a loaded machine must never hold capture back). */
  snapshot?: boolean | "defer";
  onStage?: (name: ImportStage) => void;
}

export async function runImport(opts: ImportOptions = {}): Promise<ImportResult> {
  const t0 = performance.now();
  opts.onStage?.("discover");
  const store = new CarafeStore();
  const manifest = store.loadManifest();
  const sources = store.loadSessionSources();
  const log = (m: string) => { if (!opts.quiet) console.log(m); };
  log(`carafe import → ${store.root}`);

  let rawBytesRead = 0, filesImported = 0, filesSkipped = 0, parseErrors = 0, totalEvents = 0, checkpointsTaken = 0, sourcesRead = 0;
  const deferredSnapshots: DeferredSnapshot[] = [];
  const titleMap = new Map<string, { title: string; priority: number }>(); // sessionId -> best title
  const drafts: SessionDistillate[] = [];
  const parsedBySession = new Map<string, ParsedSession>();
  // sessions that opened with a carafe handoff → the session they continue.
  const handoffSources = new Map<string, string>();
  // last-resort titles: a short steering line beats an unnamed row.
  const weakTitles = new Map<string, string>();
  const firstPostHandoff = new Map<string, string>();
  const verifyPick: Array<{ tool: string; sessionId: string; eventCount: number }> = [];
  const newSessions: ImportResult["newSessions"] = [];
  const changedSessions: ImportResult["changedSessions"] = [];

  // Codex's name index is a source file too: read only when a Codex session
  // is actually imported, so a tick (or restart) with nothing new reads nothing.
  let codexNamesCache: ReturnType<typeof readCodexThreadNames> | null = null;
  const codexNames = () => {
    if (!codexNamesCache) { sourcesRead++; codexNamesCache = readCodexThreadNames(); }
    return codexNamesCache;
  };
  // Newest first across every tool: after a restart the sessions someone was
  // just working in are captured before the long tail.
  const queue: Array<{ adapter: Adapter; f: SourceFile }> = [];
  for (const adapter of ADAPTERS) {
    if (opts.tool && adapter.tool !== opts.tool) continue;
    let files = adapter.discover().sort((a, b) => b.mtimeMs - a.mtimeMs);
    if (opts.limit) files = files.slice(0, opts.limit);
    log(`[${adapter.tool}] ${files.length} source files`);
    for (const f of files) queue.push({ adapter, f });
  }
  queue.sort((a, b) => b.f.mtimeMs - a.f.mtimeMs);

  opts.onStage?.("read sources");
  for (const { adapter, f } of queue) {
    // Unchanged since the store last saw it (the manifest is on disk, so this
    // holds across restarts): a stat, never a read.
    const m = manifest[f.path];
    if (!opts.force && m && m.size === f.size && m.mtimeMs === f.mtimeMs) { filesSkipped++; continue; }
    opts.onStage?.("read sources");
    let text: string;
    sourcesRead++;
    try { text = await Bun.file(f.path).text(); } catch { continue; }
    rawBytesRead += Buffer.byteLength(text);
    const parsed = adapter.parseFile(text);
    parseErrors += parsed.parseErrors;
    const sid = store.resolveStorageId(sources, adapter.tool, f.sessionId, f.path);
    for (const tu of parsed.titleUpdates) {
      const cur = titleMap.get(tu.sessionId);
      if (!cur || tu.priority > cur.priority) titleMap.set(tu.sessionId, { title: tu.title, priority: tu.priority });
    }
    const events: CarafeEvent[] = parsed.events.map((e, i) => ({
      ts: e.ts, tool: adapter.tool, sessionId: sid, seq: i,
      kind: e.kind, sidechain: e.sidechain, raw: extractBlobs(e.raw, store),
    }));
    opts.onStage?.("write sessions");
    sealSession(store, adapter.tool, sid, events);
    totalEvents += events.length;
    let existing: SessionDistillate | null = null;
    try { existing = JSON.parse(readFileSync(store.distillatePath(adapter.tool, sid), "utf8")) as SessionDistillate; }
    catch { /* first import */ }
    const d: SessionDistillate = {
      tool: adapter.tool, sessionId: sid,
      internalSessionId: parsed.internalSessionId !== sid ? parsed.internalSessionId : undefined,
      sourcePath: f.path,
      title: existing?.title ?? null,
      titleSource: existing?.titleSource,
      cwd: parsed.cwd, gitBranch: parsed.gitBranch,
      startTs: events.find((e) => e.ts)?.ts ?? null,
      endTs: [...events].reverse().find((e) => e.ts)?.ts ?? null,
      lastActivityTs: parsed.lastActivityTs, internal: parsed.internal,
      hasUserText: !!parsed.firstUserText || !!parsed.weakTitleText || !!parsed.handoffSourceId,
      eventCount: events.length, toolUseCount: parsed.toolUseCount,
      sidechain: parsed.sidechain,
      codexCalls: parsed.codexCalls.length ? parsed.codexCalls : undefined,
      originator: parsed.originator ?? undefined,
      sourceKind: parsed.sourceKind ?? undefined,
      usage: Object.keys(parsed.usageByModel).length ? parsed.usageByModel : undefined,
      usageV: USAGE_VERSION,
      rawBytes: Buffer.byteLength(text), version: 1,
    };
    // Handoff-opened sessions are resolved in the store-aware second pass,
    // where a new session may compose "<source> — <own short text>". Do not
    // first install the uncomposed text at equal derived provenance.
    if (parsed.firstUserText && !parsed.handoffSourceId) applyTitleCandidate(d, parsed.firstUserText, "derived");
    if (adapter.tool === "codex" && parsed.codexToolTitle) applyTitleCandidate(d, parsed.codexToolTitle, "codex-tool");
    if (adapter.tool === "codex") {
      const indexed = codexNames().get(f.sessionId);
      if (indexed) applyTitleCandidate(d, indexed.name, "codex-index");
    }
    drafts.push(d);
    parsedBySession.set(sid, parsed);
    if (parsed.handoffSourceId) handoffSources.set(sid, parsed.handoffSourceId);
    if (parsed.weakTitleText) weakTitles.set(sid, parsed.weakTitleText);
    if (parsed.firstPostHandoffText) firstPostHandoff.set(sid, parsed.firstPostHandoffText);
    if (opts.snapshot === "defer") {
      const owed = snapshotCandidate(events);
      if (owed && d.cwd) deferredSnapshots.push({ tool: adapter.tool, id: sid, seq: owed.seq, ts: owed.ts });
    } else if (opts.snapshot) {
      opts.onStage?.("snapshots");
      if (maybeAutoCheckpoint(store, d, events)) checkpointsTaken++;
    }
    manifest[f.path] = { size: f.size, mtimeMs: f.mtimeMs };
    changedSessions.push({ tool: adapter.tool, id: sid });
    filesImported++;
    if (verifyPick.length < 2 || verifyPick[verifyPick.length - 1]!.tool !== adapter.tool)
      verifyPick.push({ tool: adapter.tool, sessionId: sid, eventCount: events.length });
    if (filesImported % 200 === 0) log(`  ...${filesImported} files, ${MB(rawBytesRead)} read`);
  }

  if (filesImported === 0) opts.onStage?.("write sessions");
  opts.onStage?.("distillates");
  // Apply best titles (CC title > Codex tool > first-prompt fallback).
  // Sub-agents carry the PARENT's sessionId internally — inheriting via that key
  // would title every sub-agent with the parent's title ("Acme 1.0 & 2.0"), so
  // for sidechains only an explicitly-own title counts; else keep the task prompt.
  for (const d of drafts) {
    const t = d.sidechain
      ? titleMap.get(d.sessionId)
      : (titleMap.get(d.internalSessionId ?? d.sessionId) ?? titleMap.get(d.sessionId));
    if (t) applyTitleCandidate(d, t.title, "cc-title");
    writeDistillate(store, d);
  }
  // SECOND pass: a session started FROM a handoff, whose own words never
  // appear, is named for the work it continues. It runs only once every draft
  // is on disk, so a source imported in this same run is already findable —
  // and so the result never depends on the order files happened to be read.
  for (const d of drafts) {
    const sourceId = handoffSources.get(d.sessionId);
    const parsed = parsedBySession.get(d.sessionId)!;
    const fallback = resolveTitleCandidate(
      store,
      parsed.firstUserText,
      sourceId ?? null,
      weakTitles.get(d.sessionId) ?? null,
      firstPostHandoff.get(d.sessionId) ?? null,
    );
    applyTitleCandidate(d, fallback.title, fallback.source);
    writeDistillate(store, d);
    newSessions.push({ tool: d.tool, id: d.sessionId, title: d.title });
  }

  if (opts.snapshot !== "defer") opts.onStage?.("snapshots");
  opts.onStage?.("index catalog");
  // Nothing imported: nothing to record (a quiet tick writes nothing).
  if (filesImported > 0) {
    store.saveManifest(manifest);
    store.saveSessionSources(sources);
  }
  deferredSnapshots.sort((a, b) => b.ts.localeCompare(a.ts) || a.tool.localeCompare(b.tool) || a.id.localeCompare(b.id));

  // ---- round-trip verification (one session per tool) ----
  let verified = 0;
  for (const v of verifyPick.slice(0, 2)) {
    const back = readSession(store, v.tool, v.sessionId);
    if (back.length !== v.eventCount) throw new Error(`round-trip FAILED for ${v.tool}/${v.sessionId}: ${back.length} != ${v.eventCount}`);
    verified++;
  }

  const s = store.stats;
  const storedTotal = s.sessionBytesStored + s.blobBytesStored;
  const secs = ((performance.now() - t0) / 1000).toFixed(1);
  log(`
==== carafe import report ====
files imported:     ${filesImported} (skipped unchanged: ${filesSkipped})
events:             ${totalEvents.toLocaleString()} | parse errors: ${parseErrors}
raw read:           ${MB(rawBytesRead)}
CAS blobs:          ${s.blobsPut.toLocaleString()} stored, ${s.blobDedupHits.toLocaleString()} dedup hits
  dedup savings:    ${MB(s.blobBytesDeduped)} raw bytes NOT stored again (${((s.blobBytesDeduped / Math.max(1, s.blobBytesSeen)) * 100).toFixed(1)}% of blob bytes)
stored on disk:     ${MB(storedTotal)}  (sessions ${MB(s.sessionBytesStored)} + blobs ${MB(s.blobBytesStored)})
effective ratio:    ${(rawBytesRead / Math.max(1, storedTotal)).toFixed(2)}:1  raw → stored
${checkpointsTaken > 0 ? `checkpoints:        ${checkpointsTaken} taken\n` : ""}round-trip:         ${verified}/2 sessions verified (event-count exact after rehydration)
time:               ${secs}s
`);
  return { filesImported, filesSkipped, newSessions, changedSessions, storedBytes: storedTotal, rawBytes: rawBytesRead, checkpointsTaken, sourcesRead, deferredSnapshots };
}
