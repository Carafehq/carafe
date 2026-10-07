/**
 * Per-session SQLite index. The FTS rows provide turn-level recall; the
 * relational tables provide the chapter/file/run/moment graph used by `ask`.
 */
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "fs";
import { basename, dirname, join, resolve } from "path";
import type { SessionDistillate } from "../format/distillate";
import type { CarafeEvent } from "../format/events";
import { readSession } from "../format/sessions";
import { atomicWriteFileSync } from "../format/store";
import type { CarafeStore } from "../format/store";
import { buildBlocks, type TurnBlock } from "../handoff/blocks";
import { extractPieces, filesOf, type EventPieces } from "../handoff/pieces";
import { chapterOf, segmentChapters } from "../keymoments/chapters";
import { extractMoments } from "../keymoments/extract";
import { momentLabel, selectChapterMoments } from "../keymoments/select";
import { commandOf, failExcerpt, normalizeSentence, type SignalContext, type ToolRun } from "../keymoments/signals";
import { ftsQuery } from "./fts-query";
import { listSessions } from "../query/sessions";

const ROW_BODY_CAP = 60_000;
const DEFAULT_MOMENT_BUDGET = 20_000;
// Bumped whenever the detectors or the relations change: the index caches their output.
export const SESSION_INDEX_SCHEMA_VERSION = "8";

const RELATION_TABLES = ["chapters", "blocks", "block_files", "runs", "moments", "moment_files", "entities"] as const;
export const SESSION_INDEX_TABLES = ["docs", ...RELATION_TABLES, "meta"] as const;
export type SessionIndexTable = (typeof SESSION_INDEX_TABLES)[number];

export interface SessionSearchHit {
  startSeq: number;
  endSeq: number;
  firstLine: string;
  snippet: string;
  rank: number;
}

export interface SessionIndexDoc {
  startSeq: number;
  endSeq: number;
  body: string;
  truncated: boolean;
}

export interface SessionIndexBuildResult {
  rebuilt: boolean;
  rows: number;
  counts: Record<SessionIndexTable, number>;
}

export interface ChangedSession { tool: string; id: string }
export type SessionIndexFreshness = "missing" | "fresh" | "stale" | "unreadable";

export interface SessionIndexRefreshResult {
  built: Array<{ tool: string; id: string; title: string | null; elapsedMs: number }>;
  deferred: ChangedSession[];
  skippedFresh: number;
  skippedSmall: number;
  skippedSidechain: number;
  skippedMissing: number;
  /** Stale, but rebuilt less than `minRebuildIntervalMs` ago: deferred, not rebuilt. */
  skippedYoung: number;
  /** Builds that threw. Dropped from the queue, never retried in a loop. */
  failed: Array<ChangedSession & { error: string }>;
}

export interface SessionIndexBackfillOptions {
  cwd?: string;
  sinceDays?: number;
  minEvents?: number;
  /** Newest sessions kept per working directory; the reflex never reads more. */
  perCwd?: number;
  /** Lift every bound: every non-sidechain session in the store. */
  everything?: boolean;
  nowMs?: number;
}

export interface SessionIndexBackfillPlan {
  /** Sessions that need an index, newest first. */
  candidates: SessionDistillate[];
  totalSessions: number;
  skippedFresh: number;
  skippedSmall: number;
  skippedSidechain: number;
  skippedFiltered: number;
  skippedCapped: number;
  sinceDays: number | null;
  minEvents: number;
  perCwd: number | null;
}

export interface SessionIndexBackfillResult {
  built: number;
  failed: Array<ChangedSession & { error: string }>;
  skippedFresh: number;
  skippedSmall: number;
  skippedSidechain: number;
  skippedFiltered: number;
  skippedCapped: number;
  totalSessions: number;
  totalBytes: number;
}

export interface IndexCatalogEntry {
  tool: string;
  sessionId: string;
  internalSessionId?: string;
  cwd: string | null;
  title: string | null;
  startTs: string | null;
  endTs: string | null;
  eventCount: number;
  sidechain: boolean;
  indexedAt: string;
}

/** How much a block at the end of the session outranks the same relevance at
 *  its start. */
export const SEARCH_RECENCY_WEIGHT = 0.5;

export const ASK_KINDS = ["decision", "deadend", "breakthrough", "finding", "rule", "steering", "commit", "pr", "wip"] as const;
export type AskKind = (typeof ASK_KINDS)[number];

export interface AskOptions {
  file?: string;
  kind?: AskKind;
  chapter?: number;
  failed?: boolean;
  command?: string;
  branch?: string;
  limit?: number;
}

export interface AskRow {
  /** turn = a user-turn block that touched the file when no moment did */
  type: "moment" | "run" | "turn";
  seq: number;
  endSeq: number | null;
  kind: string | null;
  chapterIdx: number;
  blockIdx: number;
  text: string | null;
  note: string | null;
  selected: number | null;
  family: string | null;
  command: string | null;
  ok: number | null;
  excerpt: string | null;
  chapterStartSeq: number;
  chapterEndSeq: number;
  branch: string | null;
  cwd: string | null;
}

export interface AskOverviewChapter {
  chapterIdx: number;
  startSeq: number;
  endSeq: number;
  branch: string | null;
  cwd: string | null;
  turns: number;
  moments: number;
  decisions: number;
  deadends: number;
  runs: number;
  failures: number;
  files: number;
}

export interface AskEntity { kind: string; value: string; firstSeq: number; lastSeq: number; count: number }
export interface AskOverview { chapters: AskOverviewChapter[]; entities: Record<string, AskEntity[]> }

interface EntityAccumulator { firstSeq: number; lastSeq: number; count: number }

function createRelations(db: Database): void {
  db.run(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  db.run(`CREATE TABLE IF NOT EXISTS chapters (
    idx INTEGER PRIMARY KEY, start_seq INTEGER NOT NULL, end_seq INTEGER NOT NULL,
    start_ts TEXT, end_ts TEXT, branch TEXT, cwd TEXT, boundary TEXT NOT NULL,
    strength REAL NOT NULL, turns INTEGER NOT NULL, tool_calls INTEGER NOT NULL,
    chars INTEGER NOT NULL, tokens INTEGER, commits INTEGER NOT NULL,
    failures INTEGER NOT NULL, decisions INTEGER NOT NULL, deadends INTEGER NOT NULL
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS blocks (
    idx INTEGER PRIMARY KEY, chapter_idx INTEGER NOT NULL, start_seq INTEGER NOT NULL,
    end_seq INTEGER NOT NULL, first_line TEXT NOT NULL, tool_calls INTEGER NOT NULL,
    chars INTEGER NOT NULL
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS block_files (
    block_idx INTEGER NOT NULL, file TEXT NOT NULL, basename TEXT NOT NULL,
    touches INTEGER NOT NULL, edited INTEGER NOT NULL
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS runs (
    seq INTEGER PRIMARY KEY, block_idx INTEGER NOT NULL, chapter_idx INTEGER NOT NULL,
    family TEXT NOT NULL, command TEXT NOT NULL, ok INTEGER NOT NULL, excerpt TEXT NOT NULL
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS moments (
    seq INTEGER NOT NULL, end_seq INTEGER, kind TEXT NOT NULL, chapter_idx INTEGER NOT NULL,
    block_idx INTEGER NOT NULL, text TEXT NOT NULL, note TEXT, selected INTEGER NOT NULL
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS moment_files (
    seq INTEGER NOT NULL, file TEXT NOT NULL, basename TEXT NOT NULL
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS entities (
    kind TEXT NOT NULL, value TEXT NOT NULL, first_seq INTEGER NOT NULL,
    last_seq INTEGER NOT NULL, count INTEGER NOT NULL
  )`);
  db.run(`CREATE INDEX IF NOT EXISTS block_files_basename ON block_files(basename)`);
  db.run(`CREATE INDEX IF NOT EXISTS moment_files_basename ON moment_files(basename)`);
  db.run(`CREATE INDEX IF NOT EXISTS runs_family_ok ON runs(family, ok)`);
  db.run(`CREATE INDEX IF NOT EXISTS moments_kind_chapter ON moments(kind, chapter_idx)`);
  db.run(`CREATE INDEX IF NOT EXISTS entities_kind_value ON entities(kind, value)`);
}

function dropRelations(db: Database): void {
  for (const table of RELATION_TABLES) db.run(`DROP TABLE IF EXISTS ${table}`);
  db.run(`DROP TABLE IF EXISTS meta`);
}

function metaShapeIsCurrent(db: Database): boolean {
  const exists = db.query(`SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = 'meta'`).get();
  if (!exists) return true;
  const columns = db.query(`PRAGMA table_info(meta)`).all() as Array<{ name: string }>;
  return columns.map((column) => column.name).join(",") === "key,value";
}

function momentKey(moment: { kind: string; seq: number; endSeq?: number; text: string; note?: string }): string {
  return `${moment.kind}\0${moment.seq}\0${moment.endSeq ?? ""}\0${moment.text}\0${moment.note ?? ""}`;
}

function blockIndexFor(blocks: TurnBlock[], seq: number): number {
  let low = 0;
  let high = blocks.length - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const block = blocks[middle]!;
    if (seq < block.startSeq) high = middle - 1;
    else if (seq > block.endSeq) low = middle + 1;
    else return middle;
  }
  return Math.max(0, Math.min(blocks.length - 1, low));
}

/** Paths explicitly present in commands, including mutating commands such as
 * `git rm` which intentionally are not part of pieces.filesOf's read scanner. */
function commandPaths(command: string): string[] {
  const out = new Set<string>();
  const tokens = command.match(/(?:"[^"]+"|'[^']+'|[^\s;&|]+)/g) ?? [];
  for (const raw of tokens) {
    const token = raw.replace(/^['"]|['"]$/g, "").replace(/[,:)]$/g, "");
    if (!token || token.startsWith("-") || token.includes("://") || token.includes("node_modules")) continue;
    if (/^(?:\.{0,2}\/|\/)?[\p{L}\p{N}_@%+.,=-]+(?:\/[\p{L}\p{N}_@%+.,=-]+)+$/u.test(token)
      || /^[\p{L}\p{N}_@%+-]+\.[A-Za-z0-9]{1,8}$/u.test(token)) out.add(token);
  }
  return [...out];
}

function branchFromCommand(command: string): string | null {
  if (/\s--\s/.test(command)) return null;
  const match = /(?:^|[;&|]\s*|\n)\s*git\s+(?:checkout|switch)\s+(?:(?:-b|-c)\s+)?([^\s;&|]+)/i.exec(command);
  const branch = match?.[1]?.replace(/^['"]|['"]$/g, "") ?? null;
  return branch && !branch.startsWith("-") ? branch : null;
}

function resultExcerpt(run: ToolRun): string {
  if (run.failed) return failExcerpt(run.resultLine);
  const body = run.resultLine.replace(/^\s*⤷\s*/, "").trim();
  const first = body.split("\n").map((line) => line.trim()).find(Boolean) ?? body;
  return first.length <= 200 ? first : `${first.slice(0, 199)}…`;
}

function errorToken(excerpt: string): string | null {
  return /\b(TS\d+|ELIFECYCLE|AssertionError|Traceback)\b/.exec(excerpt)?.[1]
    ?? /\b([A-Z][A-Z0-9_]{2,})\b/.exec(excerpt)?.[1]
    ?? null;
}

function addEntity(map: Map<string, EntityAccumulator>, kind: string, value: string, seq: number): void {
  if (!value) return;
  const key = `${kind}\0${value}`;
  const current = map.get(key);
  if (current) {
    current.firstSeq = Math.min(current.firstSeq, seq);
    current.lastSeq = Math.max(current.lastSeq, seq);
    current.count++;
  } else map.set(key, { firstSeq: seq, lastSeq: seq, count: 1 });
}

function groupedFiles(events: CarafeEvent[], blocks: TurnBlock[], context: SignalContext): Array<Map<string, { touches: number; edited: boolean }>> {
  const grouped = blocks.map(() => new Map<string, { touches: number; edited: boolean }>());
  const edited = new Set(context.edits.flatMap((action) => action.files.map((file) => `${action.seq}\0${file}`)));
  let blockIndex = 0;
  for (const event of events) {
    while (blockIndex + 1 < blocks.length && event.seq >= blocks[blockIndex + 1]!.startSeq) blockIndex++;
    const target = grouped[blockIndex];
    if (!target) continue;
    for (const file of filesOf(event)) {
      const current = target.get(file) ?? { touches: 0, edited: false };
      current.touches++;
      current.edited ||= edited.has(`${event.seq}\0${file}`);
      target.set(file, current);
    }
  }
  return grouped;
}

function filesForMoment(moment: { seq: number; endSeq?: number }, events: CarafeEvent[], pieces: EventPieces[]): string[] {
  const endSeq = moment.endSeq ?? moment.seq;
  const files = new Set<string>();
  for (const event of events) {
    if (event.seq < moment.seq) continue;
    if (event.seq > endSeq) break;
    for (const file of filesOf(event)) files.add(file);
  }
  for (const piece of pieces) {
    if (piece.seq < moment.seq) continue;
    if (piece.seq > endSeq) break;
    for (const line of piece.lines) {
      const command = commandOf(line);
      if (command) for (const file of commandPaths(command)) files.add(file);
    }
  }
  return [...files].sort();
}

export function sessionIndexPath(store: CarafeStore, session: Pick<SessionDistillate, "tool" | "sessionId">): string {
  return join(store.root, "state", "session-index", session.tool, `${session.sessionId}.sqlite`);
}

export function sessionIndexFreshness(store: CarafeStore, session: SessionDistillate): SessionIndexFreshness {
  const path = sessionIndexPath(store, session);
  if (!existsSync(path)) return "missing";
  try {
    const db = new Database(path, { readonly: true });
    try {
      const rows = db.query(`SELECT key, value FROM meta WHERE key IN ('eventCount', 'endTs', 'builtWith')`).all() as Array<{ key: string; value: string }>;
      const meta = Object.fromEntries(rows.map((row) => [row.key, row.value]));
      return meta.eventCount === String(session.eventCount) && meta.endTs === (session.endTs ?? "") && meta.builtWith === SESSION_INDEX_SCHEMA_VERSION ? "fresh" : "stale";
    } finally { db.close(); }
  } catch { return "unreadable"; }
}

/** Stream the rendered turn blocks of a session's index in seq order, read-only.
 * This is what `carafe grep` scans instead of decoding the session: the same
 * text `search --session` ranks, one row per block, bodies capped at
 * ROW_BODY_CAP characters at build time (`truncated` says so). */
export function* readSessionIndexDocs(store: CarafeStore, session: SessionDistillate): Generator<SessionIndexDoc> {
  const db = new Database(sessionIndexPath(store, session), { readonly: true });
  try {
    const rows = db.query(`SELECT startSeq, endSeq, body FROM docs ORDER BY startSeq ASC, endSeq ASC`).iterate() as Iterable<Record<string, unknown>>;
    for (const row of rows) {
      const body = String(row.body ?? "");
      yield { startSeq: Number(row.startSeq), endSeq: Number(row.endSeq), body, truncated: body.length >= ROW_BODY_CAP };
    }
  } finally { db.close(); }
}

/** The stored distillate for one session, or null when it is not there. */
export function readStoredDistillate(store: CarafeStore, tool: string, sessionId: string): SessionDistillate | null {
  try { return JSON.parse(readFileSync(store.distillatePath(tool, sessionId), "utf8")) as SessionDistillate; }
  catch { return null; }
}

function uniqueRecent(store: CarafeStore, changed: ChangedSession[]): Array<{ changed: ChangedSession; session: SessionDistillate | null }> {
  const unique = new Map<string, ChangedSession>();
  for (const item of changed) unique.set(`${item.tool}\0${item.id}`, item);
  return [...unique.values()].map((item) => ({ changed: item, session: readStoredDistillate(store, item.tool, item.id) }))
    .sort((a, b) => (b.session?.endTs ?? b.session?.startTs ?? "").localeCompare(a.session?.endTs ?? a.session?.startTs ?? "")
      || a.changed.tool.localeCompare(b.changed.tool) || a.changed.id.localeCompare(b.changed.id));
}

function indexAgeMs(store: CarafeStore, session: Pick<SessionDistillate, "tool" | "sessionId">, nowMs: number): number | null {
  try { return Math.max(0, nowMs - statSync(sessionIndexPath(store, session)).mtimeMs); } catch { return null; }
}

/** An active session grows on every tick; rebuilding its index each time would
 * cost seconds of CPU and tens of MB of writes per tick on a large session
 * (one large real session: 4.4 s and 23 MB). Stale indexes younger than this wait. */
export const DEFAULT_REBUILD_INTERVAL_MS = 5 * 60_000;

/** Refresh a bounded slice of imported sessions, newest first. Anything left by
 * the count or time guard, and any stale index younger than
 * `minRebuildIntervalMs`, is returned to the watcher for a later tick. */
export function refreshSessionIndexes(
  store: CarafeStore,
  changed: ChangedSession[],
  opts: { maxPerTick?: number; minEvents?: number; maxTickMs?: number; minRebuildIntervalMs?: number; nowMs?: number; onBuild?: (session: SessionDistillate) => void } = {},
): SessionIndexRefreshResult {
  const maxPerTick = Math.max(0, opts.maxPerTick ?? 3);
  const minEvents = Math.max(0, opts.minEvents ?? 40);
  const maxTickMs = Math.max(0, opts.maxTickMs ?? 5_000);
  const minRebuildIntervalMs = Math.max(0, opts.minRebuildIntervalMs ?? DEFAULT_REBUILD_INTERVAL_MS);
  const nowMs = opts.nowMs ?? Date.now();
  const started = performance.now();
  const result: SessionIndexRefreshResult = { built: [], deferred: [], skippedFresh: 0, skippedSmall: 0, skippedSidechain: 0, skippedMissing: 0, skippedYoung: 0, failed: [] };
  const rows = uniqueRecent(store, changed);
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index]!;
    if (result.built.length >= maxPerTick || performance.now() - started >= maxTickMs) {
      result.deferred.push(...rows.slice(index).map((item) => item.changed));
      break;
    }
    const session = row.session;
    if (!session) { result.skippedMissing++; continue; }
    if (session.sidechain) { result.skippedSidechain++; continue; }
    if (session.eventCount < minEvents) { result.skippedSmall++; continue; }
    const freshness = sessionIndexFreshness(store, session);
    if (freshness === "fresh") { result.skippedFresh++; continue; }
    if (freshness !== "missing" && minRebuildIntervalMs > 0) {
      const age = indexAgeMs(store, session, nowMs);
      if (age != null && age < minRebuildIntervalMs) { result.skippedYoung++; result.deferred.push(row.changed); continue; }
    }
    const buildStarted = performance.now();
    opts.onBuild?.(session);
    // One session that cannot be indexed must not poison the queue behind it.
    try {
      buildSessionIndex(store, session, readSession(store, session.tool, session.sessionId));
      result.built.push({ tool: session.tool, id: session.sessionId, title: session.title, elapsedMs: performance.now() - buildStarted });
    } catch (error) {
      result.failed.push({ ...row.changed, error: (error as Error).message });
    }
  }
  return result;
}

// ─── Catalog: which sessions have an index (so the hook reads one file) ──────

export function indexCatalogPath(store: CarafeStore): string {
  return join(store.root, "state", "session-index", "catalog.json");
}

/** The catalog of indexed sessions, or null when none has been written yet
 * (callers then scan the distillate layer, which costs ~0.5 s cold on a store
 * of 4,000 sessions and is exactly what a per-prompt hook cannot afford). */
export function readIndexCatalog(store: CarafeStore): IndexCatalogEntry[] | null {
  try {
    const parsed = JSON.parse(readFileSync(indexCatalogPath(store), "utf8")) as { entries?: unknown };
    if (!Array.isArray(parsed.entries)) return null;
    return parsed.entries.filter((entry): entry is IndexCatalogEntry =>
      !!entry && typeof entry === "object" && typeof (entry as IndexCatalogEntry).tool === "string" && typeof (entry as IndexCatalogEntry).sessionId === "string");
  } catch { return null; }
}

function catalogEntry(session: SessionDistillate, indexedAt: string): IndexCatalogEntry {
  return {
    tool: session.tool, sessionId: session.sessionId,
    ...(session.internalSessionId ? { internalSessionId: session.internalSessionId } : {}),
    cwd: session.cwd ?? null, title: session.title ?? null, startTs: session.startTs ?? null, endTs: session.endTs ?? null,
    eventCount: session.eventCount, sidechain: !!session.sidechain, indexedAt,
  };
}

function writeIndexCatalog(store: CarafeStore, entries: IndexCatalogEntry[]): void {
  const path = indexCatalogPath(store);
  mkdirSync(dirname(path), { recursive: true });
  entries.sort((a, b) => (b.endTs ?? b.startTs ?? "").localeCompare(a.endTs ?? a.startTs ?? "") || a.tool.localeCompare(b.tool) || a.sessionId.localeCompare(b.sessionId));
  atomicWriteFileSync(path, JSON.stringify({ version: 1, entries }));
}

/** Record one built index. The catalog is a cache of what the index directory
 * holds; the watcher rebuilds it from that directory on every start, so a lost
 * write (two writers at once) heals itself. */
export function upsertIndexCatalog(store: CarafeStore, session: SessionDistillate, nowIso = new Date().toISOString()): void {
  const entries = (readIndexCatalog(store) ?? []).filter((entry) => !(entry.tool === session.tool && entry.sessionId === session.sessionId));
  entries.push(catalogEntry(session, nowIso));
  writeIndexCatalog(store, entries);
}

/** Rebuild the catalog from the index directory. */
export function rebuildIndexCatalog(store: CarafeStore): IndexCatalogEntry[] {
  const base = join(store.root, "state", "session-index");
  const entries: IndexCatalogEntry[] = [];
  let tools: string[] = [];
  try { tools = readdirSync(base).filter((name) => { try { return statSync(join(base, name)).isDirectory(); } catch { return false; } }); } catch { tools = []; }
  for (const tool of tools) {
    let files: string[] = [];
    try { files = readdirSync(join(base, tool)); } catch { continue; }
    for (const file of files) {
      if (!file.endsWith(".sqlite")) continue;
      const session = readStoredDistillate(store, tool, file.slice(0, -".sqlite".length));
      if (!session) continue;
      let indexedAt = "";
      try { indexedAt = new Date(statSync(join(base, tool, file)).mtimeMs).toISOString(); } catch { /* unknown age */ }
      entries.push(catalogEntry(session, indexedAt));
    }
  }
  writeIndexCatalog(store, entries);
  return entries;
}

function normalizedCwd(cwd: string): string {
  return resolve(cwd).replace(/[/\\]+$/, "") || "/";
}

function cwdContains(parent: string, child: string): boolean {
  const prefix = normalizedCwd(parent);
  const target = normalizedCwd(child);
  return target === prefix || target.startsWith(prefix === "/" ? "/" : `${prefix}/`);
}

function directoryBytes(path: string): number {
  let total = 0;
  let entries: string[] = [];
  try { entries = readdirSync(path); } catch { return 0; }
  for (const entry of entries) {
    const child = join(path, entry);
    let stat;
    try { stat = statSync(child); } catch { continue; }
    total += stat.isDirectory() ? directoryBytes(child) : stat.size;
  }
  return total;
}

export function sessionIndexesSize(store: CarafeStore): number {
  return directoryBytes(join(store.root, "state", "session-index"));
}

/** The watcher's bounds. Measured on a real store of 3,916 sessions: every
 * session with ≥ 40 events from the last 90 days is 726 indexes (~190 MB);
 * the newest 12 per working directory, which is all the reflex ever reads, is
 * 355 (~120 MB). */
export const BACKFILL_DEFAULTS = { sinceDays: 90, minEvents: 40, perCwd: 12 } as const;

/** Which sessions deserve an index, newest first. `everything` lifts every bound. */
export function planSessionIndexBackfill(store: CarafeStore, opts: SessionIndexBackfillOptions = {}): SessionIndexBackfillPlan {
  const everything = opts.everything === true;
  const minEvents = Math.max(0, opts.minEvents ?? (everything ? 0 : BACKFILL_DEFAULTS.minEvents));
  const sinceDays = opts.sinceDays ?? (everything ? null : BACKFILL_DEFAULTS.sinceDays);
  const perCwd = opts.perCwd ?? (everything ? null : BACKFILL_DEFAULTS.perCwd);
  const sessions = listSessions(store); // newest first
  // Anchor relative filters to captured data, not the wall clock: the same
  // store produces the same backfill plan. Tests may inject an explicit anchor.
  const latestCapturedMs = sessions.reduce((latest, session) => {
    const parsed = Date.parse(session.endTs ?? "");
    return Number.isFinite(parsed) ? Math.max(latest, parsed) : latest;
  }, 0);
  const cutoff = sinceDays == null ? null : (opts.nowMs ?? latestCapturedMs) - Math.max(0, sinceDays) * 86_400_000;
  const plan: SessionIndexBackfillPlan = {
    candidates: [], totalSessions: sessions.length, skippedFresh: 0, skippedSmall: 0, skippedSidechain: 0, skippedFiltered: 0, skippedCapped: 0,
    sinceDays, minEvents, perCwd,
  };
  const perDirectory = new Map<string, number>();
  for (const session of sessions) {
    if (session.sidechain) { plan.skippedSidechain++; continue; }
    if (opts.cwd && (!session.cwd || !cwdContains(session.cwd, opts.cwd))) { plan.skippedFiltered++; continue; }
    if (cutoff != null && (!session.endTs || !Number.isFinite(Date.parse(session.endTs)) || Date.parse(session.endTs) < cutoff)) { plan.skippedFiltered++; continue; }
    if (session.eventCount < minEvents) { plan.skippedSmall++; continue; }
    const directory = session.cwd ? normalizedCwd(session.cwd) : "";
    const kept = perDirectory.get(directory) ?? 0;
    if (perCwd != null && kept >= perCwd) { plan.skippedCapped++; continue; }
    perDirectory.set(directory, kept + 1);
    if (sessionIndexFreshness(store, session) === "fresh") { plan.skippedFresh++; continue; }
    plan.candidates.push(session);
  }
  return plan;
}

/** Build every index the plan calls for, synchronously (the CLI path; the
 * watcher drains the same plan a few sessions per tick instead). */
export function backfillSessionIndexes(
  store: CarafeStore,
  opts: SessionIndexBackfillOptions & { onProgress?: (processed: number, total: number) => void } = {},
): SessionIndexBackfillResult {
  const plan = planSessionIndexBackfill(store, opts);
  let built = 0;
  let processed = 0;
  const failed: Array<ChangedSession & { error: string }> = [];
  for (const session of plan.candidates) {
    processed++;
    try {
      buildSessionIndex(store, session, readSession(store, session.tool, session.sessionId), { catalog: false });
      built++;
    } catch (error) {
      failed.push({ tool: session.tool, id: session.sessionId, error: (error as Error).message });
    }
    if (processed % 20 === 0 || processed === plan.candidates.length) opts.onProgress?.(processed, plan.candidates.length);
  }
  if (built > 0) rebuildIndexCatalog(store);
  return {
    built, failed, skippedFresh: plan.skippedFresh, skippedSmall: plan.skippedSmall, skippedSidechain: plan.skippedSidechain,
    skippedFiltered: plan.skippedFiltered, skippedCapped: plan.skippedCapped, totalSessions: plan.totalSessions, totalBytes: sessionIndexesSize(store),
  };
}

export class SessionIndex {
  private db: Database;
  readonly path: string;
  readonly existed: boolean;

  constructor(private store: CarafeStore, private session: SessionDistillate) {
    this.path = sessionIndexPath(store, session);
    this.existed = existsSync(this.path);
    mkdirSync(dirname(this.path), { recursive: true });
    this.db = new Database(this.path, { create: true });
    this.db.run(`PRAGMA journal_mode = WAL`);
    if (!metaShapeIsCurrent(this.db)) dropRelations(this.db);
    this.db.run(`CREATE VIRTUAL TABLE IF NOT EXISTS docs USING fts5(startSeq UNINDEXED, endSeq UNINDEXED, firstLine, body, tokenize = 'porter unicode61')`);
    createRelations(this.db);
  }

  private meta(): Record<string, string> {
    const rows = this.db.query(`SELECT key, value FROM meta`).all() as Array<{ key: string; value: string }>;
    return Object.fromEntries(rows.map((row) => [row.key, row.value]));
  }

  isStale(): boolean {
    const meta = this.meta();
    return meta.eventCount !== String(this.session.eventCount)
      || meta.endTs !== (this.session.endTs ?? "")
      || meta.builtWith !== SESSION_INDEX_SCHEMA_VERSION;
  }

  counts(): Record<SessionIndexTable, number> {
    const counts = {} as Record<SessionIndexTable, number>;
    for (const table of SESSION_INDEX_TABLES) {
      const row = this.db.query(`SELECT count(*) AS count FROM ${table}`).get() as { count: number };
      counts[table] = Number(row.count);
    }
    return counts;
  }

  reindex(opts: { force?: boolean; events?: CarafeEvent[] } = {}): SessionIndexBuildResult {
    if (!opts.force && !this.isStale()) {
      const counts = this.counts();
      return { rebuilt: false, rows: counts.docs, counts };
    }

    const oldMeta = this.meta();
    if (oldMeta.builtWith !== SESSION_INDEX_SCHEMA_VERSION) {
      dropRelations(this.db);
      createRelations(this.db);
    }
    const events = opts.events ?? readSession(this.store, this.session.tool, this.session.sessionId);
    const pieces = extractPieces(events, {}, {});
    const blocks = buildBlocks(events, pieces);
    const set = extractMoments({ events, pieces });
    const chapters = segmentChapters(events, pieces, {}, set.moments, set.context.runs);
    const selected = new Set(selectChapterMoments(set, chapters, DEFAULT_MOMENT_BUDGET).selected.map(momentKey));
    const blockFiles = groupedFiles(events, blocks, set.context);

    const insertDoc = this.db.query(`INSERT INTO docs (startSeq, endSeq, firstLine, body) VALUES (?, ?, ?, ?)`);
    const insertChapter = this.db.query(`INSERT INTO chapters
      (idx, start_seq, end_seq, start_ts, end_ts, branch, cwd, boundary, strength, turns, tool_calls, chars, tokens, commits, failures, decisions, deadends)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const insertBlock = this.db.query(`INSERT INTO blocks (idx, chapter_idx, start_seq, end_seq, first_line, tool_calls, chars) VALUES (?, ?, ?, ?, ?, ?, ?)`);
    const insertBlockFile = this.db.query(`INSERT INTO block_files (block_idx, file, basename, touches, edited) VALUES (?, ?, ?, ?, ?)`);
    const insertRun = this.db.query(`INSERT INTO runs (seq, block_idx, chapter_idx, family, command, ok, excerpt) VALUES (?, ?, ?, ?, ?, ?, ?)`);
    const insertMoment = this.db.query(`INSERT INTO moments (seq, end_seq, kind, chapter_idx, block_idx, text, note, selected) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    const insertMomentFile = this.db.query(`INSERT INTO moment_files (seq, file, basename) VALUES (?, ?, ?)`);
    const insertEntity = this.db.query(`INSERT INTO entities (kind, value, first_seq, last_seq, count) VALUES (?, ?, ?, ?, ?)`);
    const insertMeta = this.db.query(`INSERT INTO meta (key, value) VALUES (?, ?)`);

    const rebuild = this.db.transaction(() => {
      this.db.run(`DELETE FROM docs`);
      for (const table of RELATION_TABLES) this.db.run(`DELETE FROM ${table}`);
      this.db.run(`DELETE FROM meta`);

      let pieceIndex = 0;
      for (const block of blocks) {
        const lines: string[] = [];
        while (pieceIndex < pieces.length && pieces[pieceIndex]!.seq < block.startSeq) pieceIndex++;
        while (pieceIndex < pieces.length && pieces[pieceIndex]!.seq <= block.endSeq) {
          lines.push(...pieces[pieceIndex]!.lines);
          pieceIndex++;
        }
        insertDoc.run(block.startSeq, block.endSeq, block.firstLine, lines.join("\n").slice(0, ROW_BODY_CAP));
      }

      for (const chapter of chapters) {
        const deadends = set.moments.filter((moment) => moment.kind === "deadend" && moment.seq >= chapter.startSeq && moment.seq <= chapter.endSeq).length;
        insertChapter.run(chapter.index, chapter.startSeq, chapter.endSeq, chapter.startTs, chapter.endTs,
          chapter.branch, chapter.cwd, chapter.boundary, chapter.strength, chapter.turns,
          chapter.toolCalls, chapter.chars, chapter.tokens ?? null, chapter.commits,
          chapter.failures, chapter.decisions, deadends);
      }

      for (let index = 0; index < blocks.length; index++) {
        const block = blocks[index]!;
        const chapter = chapterOf(chapters, block.startSeq);
        insertBlock.run(index, chapter.index, block.startSeq, block.endSeq, block.firstLine, block.toolCalls, block.chars);
        for (const [file, stats] of [...blockFiles[index]!.entries()].sort(([a], [b]) => a.localeCompare(b))) {
          insertBlockFile.run(index, file, basename(file), stats.touches, stats.edited ? 1 : 0);
        }
      }

      const entities = new Map<string, EntityAccumulator>();
      for (const event of events) for (const file of filesOf(event)) {
        addEntity(entities, "file", file, event.seq);
        addEntity(entities, "basename", basename(file), event.seq);
      }

      for (const run of set.context.runs) {
        if (!run.command || !run.family) continue;
        const chapter = chapterOf(chapters, run.toolSeq);
        const excerpt = resultExcerpt(run);
        insertRun.run(run.toolSeq, run.blockIndex, chapter.index, run.family, run.command, run.failed ? 0 : 1, excerpt);
        addEntity(entities, "command", run.family, run.toolSeq);
        const branch = branchFromCommand(run.command);
        if (branch) addEntity(entities, "branch", branch, run.toolSeq);
        if (run.failed) {
          const token = errorToken(excerpt);
          if (token) addEntity(entities, "error", token, run.toolSeq);
        }
      }

      const insertedMomentFiles = new Set<string>();
      // Turns that start a decision or a steering moment end the stretch of work a
      // decision is linked to; acknowledgement turns ("ok, go on") do not.
      const turningBlocks = new Set<number>();
      for (const moment of set.moments) if (moment.kind === "decision" || moment.kind === "ask") turningBlocks.add(blockIndexFor(blocks, moment.seq));
      for (const moment of set.moments) {
        const chapter = chapterOf(chapters, moment.seq);
        const blockIndex = blockIndexFor(blocks, moment.seq);
        const kind = moment.kind === "deadend" ? "deadend" : moment.kind === "goal" ? "goal" : momentLabel(moment);
        insertMoment.run(moment.seq, moment.endSeq ?? null, kind, chapter.index, blockIndex, moment.text, moment.note ?? null, selected.has(momentKey(moment)) ? 1 : 0);
        // A moment's own window names files only when it spans tool calls (dead ends,
        // breakthroughs). A user turn, decision or rule is one event with no files of
        // its own, yet the files worked on in that turn are exactly what a later
        // "which moments touched auth.ts" lookup — and the reflex — needs to find.
        const windowFiles = filesForMoment(moment, events, pieces);
        // A decision is about the work that followed it: the next turn's files always,
        // then the turns after it while they carry no new decision or steering (a
        // proposal → approval → "go on" → work stretch), three turns at most, so
        // "before editing X, why was this path chosen" resolves to the decision.
        const followingFiles: string[] = [];
        if (moment.kind === "decision") {
          for (let next = blockIndex + 1; next <= blockIndex + 3 && next < blocks.length; next++) {
            if (next > blockIndex + 1 && turningBlocks.has(next)) break;
            followingFiles.push(...(blockFiles[next]?.keys() ?? []));
          }
        }
        const momentFiles = [...new Set([...(windowFiles.length ? windowFiles : [...(blockFiles[blockIndex]?.keys() ?? [])]), ...followingFiles])].sort();
        for (const file of momentFiles) {
          const key = `${moment.seq}\0${file}`;
          if (insertedMomentFiles.has(key)) continue;
          insertedMomentFiles.add(key);
          insertMomentFile.run(moment.seq, file, basename(file));
        }
        if (moment.kind === "rule") {
          for (const term of normalizeSentence(moment.text).split(/\s+/).filter((value) => value.length >= 3)) addEntity(entities, "rule-term", term, moment.seq);
        }
      }

      for (const [key, value] of [...entities.entries()].sort(([a], [b]) => a.localeCompare(b))) {
        const split = key.indexOf("\0");
        insertEntity.run(key.slice(0, split), key.slice(split + 1), value.firstSeq, value.lastSeq, value.count);
      }
      const endTs = this.session.endTs ?? "";
      const metadata: Array<[string, string]> = [["eventCount", String(this.session.eventCount)], ["endTs", endTs], ["builtWith", SESSION_INDEX_SCHEMA_VERSION], ["builtAt", endTs]];
      for (const [key, value] of metadata) insertMeta.run(key, value);
    });
    rebuild();
    const counts = this.counts();
    return { rebuilt: true, rows: counts.docs, counts };
  }

  search(query: string, opts: { limit?: number } = {}): SessionSearchHit[] {
    const limit = opts.limit ?? 12;
    const q = ftsQuery(query);
    if (!q.terms.length) return [];
    // Recency weighting. Within ONE session, "where is the work" almost always
    // means the latest work: a block from the end of the trace outranks an
    // equally relevant block from its first day. bm25 is negative (lower is
    // better), so multiplying by a factor that grows with seq pushes later
    // blocks up, and an equal-relevance tie breaks to the later block.
    const maxSeq = Number((this.db.query(`SELECT MAX(CAST(startSeq AS INTEGER)) AS maxSeq FROM docs`).get() as { maxSeq: number | null } | null)?.maxSeq ?? 0) || 1;
    const run = (match: string): Array<Record<string, unknown>> => this.db.query(
      `SELECT startSeq, endSeq, firstLine,
              snippet(docs, 3, '»', '«', '…', 14) AS snippet,
              bm25(docs) * (1.0 + ${SEARCH_RECENCY_WEIGHT} * CAST(startSeq AS REAL) / $maxSeq) AS rank
       FROM docs WHERE docs MATCH $query
       ORDER BY rank ASC, CAST(startSeq AS INTEGER) DESC LIMIT $limit`,
    ).all({ $query: match, $limit: limit, $maxSeq: maxSeq }) as Array<Record<string, unknown>>;
    let rows = run(q.and);
    if (!rows.length && q.terms.length > 1) rows = run(q.or);
    return rows.map((row) => ({
      startSeq: Number(row.startSeq), endSeq: Number(row.endSeq),
      firstLine: String(row.firstLine ?? ""), snippet: String(row.snippet ?? ""), rank: Number(row.rank),
    }));
  }

  ask(opts: AskOptions = {}): AskRow[] {
    const limit = Math.max(1, Math.min(1_000, opts.limit ?? 60));
    const momentWhere: string[] = [];
    const runWhere: string[] = [];
    const momentParams: Record<string, string | number> = { $limit: limit };
    const runParams: Record<string, string | number> = { $limit: limit };
    if (opts.chapter != null) {
      momentWhere.push(`m.chapter_idx = $chapter`); runWhere.push(`r.chapter_idx = $chapter`);
      momentParams.$chapter = opts.chapter; runParams.$chapter = opts.chapter;
    }
    if (opts.branch) {
      momentWhere.push(`lower(COALESCE(c.branch, '')) = lower($branch)`); runWhere.push(`lower(COALESCE(c.branch, '')) = lower($branch)`);
      momentParams.$branch = opts.branch; runParams.$branch = opts.branch;
    }
    if (opts.file) {
      momentWhere.push(`EXISTS (SELECT 1 FROM moment_files mf WHERE mf.seq = m.seq AND (lower(mf.basename) = lower($file) OR lower(substr(mf.file, -length($file))) = lower($file)))`);
      runWhere.push(`EXISTS (SELECT 1 FROM block_files bf WHERE bf.block_idx = r.block_idx AND (lower(bf.basename) = lower($file) OR lower(substr(bf.file, -length($file))) = lower($file)))`);
      momentParams.$file = opts.file; runParams.$file = opts.file;
    }
    if (opts.kind) { momentWhere.push(`m.kind = $kind`); momentParams.$kind = opts.kind; }
    if (opts.failed) { momentWhere.push(`m.kind = 'deadend'`); runWhere.push(`r.ok = 0`); }
    if (opts.command) {
      momentWhere.push(`EXISTS (SELECT 1 FROM runs rr WHERE lower(rr.family) = lower($command) AND rr.seq BETWEEN m.seq AND COALESCE(m.end_seq, m.seq))`);
      runWhere.push(`lower(r.family) = lower($command)`);
      momentParams.$command = opts.command; runParams.$command = opts.command;
    }
    const where = (parts: string[]) => parts.length ? `WHERE ${parts.join(" AND ")}` : "";
    const moments = this.db.query(`SELECT 'moment' AS type, m.seq, m.end_seq AS endSeq, m.kind,
      m.chapter_idx AS chapterIdx, m.block_idx AS blockIdx, m.text, m.note, m.selected,
      NULL AS family, NULL AS command, NULL AS ok, NULL AS excerpt,
      c.start_seq AS chapterStartSeq, c.end_seq AS chapterEndSeq, c.branch, c.cwd
      FROM moments m JOIN chapters c ON c.idx = m.chapter_idx ${where(momentWhere)}
      ORDER BY m.chapter_idx DESC, m.seq ASC LIMIT $limit`).all(momentParams) as Array<Record<string, unknown>>;
    // Runs enter the result set only when the query asks about command outcomes.
    // A file-only lookup remains a moment lookup; otherwise a large turn block
    // can contribute hundreds of unrelated commands and bury its dead end.
    const includeRuns = !opts.kind && (opts.failed || !!opts.command);
    const runs = !includeRuns ? [] : this.db.query(`SELECT 'run' AS type, r.seq, NULL AS endSeq, NULL AS kind,
      r.chapter_idx AS chapterIdx, r.block_idx AS blockIdx, NULL AS text, NULL AS note, NULL AS selected,
      r.family, r.command, r.ok, r.excerpt,
      c.start_seq AS chapterStartSeq, c.end_seq AS chapterEndSeq, c.branch, c.cwd
      FROM runs r JOIN chapters c ON c.idx = r.chapter_idx ${where(runWhere)}
      ORDER BY r.chapter_idx DESC, r.seq ASC LIMIT $limit`).all(runParams) as Array<Record<string, unknown>>;
    const toRow = (row: Record<string, unknown>): AskRow => ({
      type: row.type as AskRow["type"], seq: Number(row.seq), endSeq: row.endSeq == null ? null : Number(row.endSeq),
      kind: row.kind == null ? null : String(row.kind), chapterIdx: Number(row.chapterIdx), blockIdx: Number(row.blockIdx),
      text: row.text == null ? null : String(row.text), note: row.note == null ? null : String(row.note),
      selected: row.selected == null ? null : Number(row.selected), family: row.family == null ? null : String(row.family),
      command: row.command == null ? null : String(row.command), ok: row.ok == null ? null : Number(row.ok),
      excerpt: row.excerpt == null ? null : String(row.excerpt), chapterStartSeq: Number(row.chapterStartSeq),
      chapterEndSeq: Number(row.chapterEndSeq), branch: row.branch == null ? null : String(row.branch), cwd: row.cwd == null ? null : String(row.cwd),
    });
    const rows = [...moments, ...runs].map(toRow).sort((a, b) => b.chapterIdx - a.chapterIdx || a.seq - b.seq || a.type.localeCompare(b.type)).slice(0, limit);
    // A file nobody made a moment about was still worked on somewhere: fall back to
    // the turns that touched it (edited first, then most touched, then most recent),
    // so a file lookup always lands the reader in the right part of the timeline.
    if (!rows.length && opts.file && !opts.kind && !opts.failed && !opts.command) {
      const turns = this.db.query(`SELECT 'turn' AS type, b.start_seq AS seq, b.end_seq AS endSeq, NULL AS kind,
        b.chapter_idx AS chapterIdx, b.idx AS blockIdx, b.first_line AS text,
        (CASE WHEN bf.edited THEN 'edited' ELSE 'touched' END) || ' ×' || bf.touches AS note, NULL AS selected,
        NULL AS family, NULL AS command, NULL AS ok, NULL AS excerpt,
        c.start_seq AS chapterStartSeq, c.end_seq AS chapterEndSeq, c.branch, c.cwd
        FROM block_files bf JOIN blocks b ON b.idx = bf.block_idx JOIN chapters c ON c.idx = b.chapter_idx
        WHERE (lower(bf.basename) = lower($file) OR lower(substr(bf.file, -length($file))) = lower($file))
        ${opts.chapter != null ? "AND b.chapter_idx = $chapter" : ""} ${opts.branch ? "AND lower(COALESCE(c.branch, '')) = lower($branch)" : ""}
        ORDER BY bf.edited DESC, bf.touches DESC, b.start_seq DESC LIMIT $limit`).all(momentParams) as Array<Record<string, unknown>>;
      return turns.map(toRow);
    }
    return rows;
  }

  overview(): AskOverview {
    const chapters = this.db.query(`SELECT c.idx AS chapterIdx, c.start_seq AS startSeq, c.end_seq AS endSeq,
      c.branch, c.cwd, c.turns,
      (SELECT count(*) FROM moments m WHERE m.chapter_idx = c.idx) AS moments,
      c.decisions, c.deadends,
      (SELECT count(*) FROM runs r WHERE r.chapter_idx = c.idx) AS runs,
      (SELECT count(*) FROM runs r WHERE r.chapter_idx = c.idx AND r.ok = 0) AS failures,
      (SELECT count(*) FROM block_files bf JOIN blocks b ON b.idx = bf.block_idx WHERE b.chapter_idx = c.idx) AS files
      FROM chapters c ORDER BY c.idx DESC`).all().map((raw) => {
        const row = raw as Record<string, unknown>;
        return {
          chapterIdx: Number(row.chapterIdx), startSeq: Number(row.startSeq), endSeq: Number(row.endSeq),
          branch: row.branch == null ? null : String(row.branch), cwd: row.cwd == null ? null : String(row.cwd),
          turns: Number(row.turns), moments: Number(row.moments), decisions: Number(row.decisions),
          deadends: Number(row.deadends), runs: Number(row.runs), failures: Number(row.failures), files: Number(row.files),
        } satisfies AskOverviewChapter;
      });
    const entities: Record<string, AskEntity[]> = {};
    const rows = this.db.query(`SELECT kind, value, first_seq AS firstSeq, last_seq AS lastSeq, count FROM entities ORDER BY kind, count DESC, value ASC`).all() as Array<Record<string, unknown>>;
    for (const raw of rows) {
      const kind = String(raw.kind);
      const values = entities[kind] ??= [];
      if (values.length >= 5) continue;
      values.push({ kind, value: String(raw.value), firstSeq: Number(raw.firstSeq), lastSeq: Number(raw.lastSeq), count: Number(raw.count) });
    }
    return { chapters, entities };
  }

  close(): void { this.db.close(); }
}

export function buildSessionIndex(store: CarafeStore, session: SessionDistillate, events: CarafeEvent[], opts: { force?: boolean; catalog?: boolean } = {}): SessionIndexBuildResult {
  const index = new SessionIndex(store, session);
  let result: SessionIndexBuildResult;
  try { result = index.reindex({ force: opts.force, events }); }
  finally { index.close(); }
  // The catalog is a cache; the index is the truth. Never let the cache fail a build.
  if (opts.catalog !== false) { try { upsertIndexCatalog(store, session); } catch { /* rebuilt by the watcher on its next start */ } }
  return result;
}
