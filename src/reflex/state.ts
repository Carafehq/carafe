import { existsSync, mkdirSync, readFileSync } from "fs";
import { dirname, join, resolve } from "path";
import type { SessionDistillate } from "../format/distillate";
import { atomicWriteFileSync, type CarafeStore } from "../format/store";
import { listSessions } from "../query/sessions";
import { readIndexCatalog, readStoredDistillate, sessionIndexFreshness, sessionIndexPath, type SessionIndexFreshness } from "../search/session-index";

export interface ArmedReflex {
  sessionId: string;
  tool: string;
  cwd: string;
  armedAtSeq: number;
  tailStartSeq: number;
  receiverHints: string[];
}

export interface ReflexState { armed: ArmedReflex[] }

export function reflexStatePath(store: CarafeStore): string {
  return join(store.root, "state", "reflex.json");
}

export function loadReflexState(store: CarafeStore): ReflexState {
  try {
    const parsed = JSON.parse(readFileSync(reflexStatePath(store), "utf8")) as { armed?: unknown };
    if (!Array.isArray(parsed.armed)) return { armed: [] };
    const armed = parsed.armed.filter((item): item is ArmedReflex => {
      if (!item || typeof item !== "object") return false;
      const row = item as Record<string, unknown>;
      return typeof row.sessionId === "string" && typeof row.tool === "string" && typeof row.cwd === "string"
        && typeof row.armedAtSeq === "number" && typeof row.tailStartSeq === "number" && Array.isArray(row.receiverHints);
    });
    return { armed };
  } catch { return { armed: [] }; }
}

function saveReflexState(store: CarafeStore, state: ReflexState): void {
  const path = reflexStatePath(store);
  mkdirSync(dirname(path), { recursive: true });
  atomicWriteFileSync(path, JSON.stringify(state));
}

function normalizedCwd(cwd: string): string {
  return resolve(cwd).replace(/[/\\]+$/, "") || "/";
}

function containsCwd(parent: string, child: string): boolean {
  const prefix = normalizedCwd(parent);
  const target = normalizedCwd(child);
  return target === prefix || target.startsWith(prefix === "/" ? "/" : `${prefix}/`);
}

export function armReflex(store: CarafeStore, session: SessionDistillate, opts: { cwd?: string; armedAtSeq: number; tailStartSeq: number }): ArmedReflex {
  const cwd = normalizedCwd(opts.cwd ?? session.cwd ?? "");
  if (!cwd || !session.cwd && !opts.cwd) throw new Error("session has no cwd; pass --cwd DIR");
  const state = loadReflexState(store);
  state.armed = state.armed.filter((item) => !(item.sessionId === session.sessionId && normalizedCwd(item.cwd) === cwd));
  const armed: ArmedReflex = {
    sessionId: session.sessionId, tool: session.tool, cwd,
    armedAtSeq: opts.armedAtSeq, tailStartSeq: opts.tailStartSeq, receiverHints: [],
  };
  state.armed.push(armed);
  saveReflexState(store, state);
  return armed;
}

export function disarmReflex(store: CarafeStore, opts: { sessionId?: string; cwd?: string; all?: boolean }): number {
  const state = loadReflexState(store);
  const before = state.armed.length;
  const cwd = opts.cwd ? normalizedCwd(opts.cwd) : undefined;
  state.armed = opts.all ? [] : state.armed.filter((item) => {
    if (opts.sessionId && item.sessionId === opts.sessionId) return false;
    if (cwd && normalizedCwd(item.cwd) === cwd) return false;
    return true;
  });
  if (state.armed.length !== before) saveReflexState(store, state);
  return before - state.armed.length;
}

export function resolveArmedReflex(store: CarafeStore, cwd: string): ArmedReflex | null {
  const target = normalizedCwd(cwd);
  let best: { row: ArmedReflex; index: number } | null = null;
  const rows = loadReflexState(store).armed;
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index]!;
    const prefix = normalizedCwd(row.cwd);
    if (target !== prefix && !target.startsWith(prefix === "/" ? "/" : `${prefix}/`)) continue;
    if (!best || prefix.length > normalizedCwd(best.row.cwd).length || (prefix.length === normalizedCwd(best.row.cwd).length && index > best.index)) best = { row, index };
  }
  return best?.row ?? null;
}

export type IndexFreshness = SessionIndexFreshness;

export function reflexIndexFreshness(store: CarafeStore, session: SessionDistillate): IndexFreshness {
  return sessionIndexFreshness(store, session);
}

export interface ReflexSessionSource {
  session: SessionDistillate;
  tailStartSeq?: number;
  excludeLastChapter?: boolean;
  bonus?: number;
}

interface SessionRow { tool: string; sessionId: string; cwd?: string | null; sidechain?: boolean; endTs?: string | null; startTs?: string | null }

/** All indexed project sessions that can answer for a cwd: armed ones first,
 * then newest first. Stale indexes are deliberately eligible: stale memory is
 * more useful than silent memory. */
export function sessionsForCwd(
  store: CarafeStore,
  cwd: string,
  opts: { maxSessions?: number; currentSessionId?: string } = {},
): ReflexSessionSource[] {
  const maxSessions = Math.max(0, opts.maxSessions ?? 12);
  const target = normalizedCwd(cwd);
  const armedRows = loadReflexState(store).armed.filter((row) => containsCwd(row.cwd, target));
  const armedBySession = new Map<string, ArmedReflex>();
  for (const row of armedRows) armedBySession.set(`${row.tool}\0${row.sessionId}`, row);
  const key = (row: SessionRow): string => `${row.tool}\0${row.sessionId}`;
  const eligible = (row: SessionRow): boolean => !row.sidechain && !!row.cwd && containsCwd(row.cwd, target) && existsSync(sessionIndexPath(store, row));
  const order = (a: SessionRow, b: SessionRow): number => (Number(armedBySession.has(key(b))) - Number(armedBySession.has(key(a))))
    || (b.endTs ?? b.startTs ?? "").localeCompare(a.endTs ?? a.startTs ?? "")
    || a.tool.localeCompare(b.tool) || a.sessionId.localeCompare(b.sessionId);
  // The watcher keeps a catalog of indexed sessions so a per-prompt hook reads
  // one file instead of every distillate (≈0.5 s cold on 4,000 sessions).
  // Without a catalog (no watcher has run yet) scan the store.
  const catalog = readIndexCatalog(store);
  const sessions: SessionDistillate[] = catalog
    ? catalog.filter(eligible).sort(order).slice(0, maxSessions)
        .map((entry) => readStoredDistillate(store, entry.tool, entry.sessionId))
        .filter((session): session is SessionDistillate => session != null)
    : listSessions(store).filter(eligible).sort(order).slice(0, maxSessions);
  return sessions.map((session) => {
    const armed = armedBySession.get(key(session));
    const current = opts.currentSessionId != null
      && (session.sessionId === opts.currentSessionId || session.internalSessionId === opts.currentSessionId);
    return {
      session,
      ...(armed ? { tailStartSeq: armed.tailStartSeq, bonus: 2 } : {}),
      ...(current ? { excludeLastChapter: true } : {}),
    } satisfies ReflexSessionSource;
  });
}
