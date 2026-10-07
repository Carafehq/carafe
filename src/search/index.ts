/**
 * Corpus search index — SQLite FTS5 over the distillate layer (fast, ranked,
 * "where was X discussed"), with optional deep-grep escalation into full session
 * traces. Same retrieval engine as the layered handoff, widened from one session
 * to all of them. Index lives at ~/.carafe/state/search.db and rebuilds cheaply.
 */
import { Database } from "bun:sqlite";
import { join } from "path";
import { statSync, readdirSync } from "fs";
import { CarafeStore } from "../format/store";
import { listSessions } from "../query/sessions";
import { readSession } from "../format/sessions";
import { extractPieces } from "../handoff/pieces";
import type { SessionDistillate } from "../format/distillate";
import { ftsQuery } from "./fts-query";

export interface SearchHit {
  sessionId: string; tool: string; title: string | null;
  cwd: string | null; gitBranch: string | null; endTs: string | null;
  eventCount: number; sidechain: boolean; snippet: string; rank: number;
}

export class SearchIndex {
  private db: Database;
  readonly path: string;
  constructor(private store: CarafeStore) {
    this.path = join(store.root, "state", "search.db");
    this.db = new Database(this.path, { create: true });
    this.db.run(`PRAGMA journal_mode = WAL`);
    this.db.run(`CREATE TABLE IF NOT EXISTS meta (sessionId TEXT PRIMARY KEY, tool TEXT, title TEXT, cwd TEXT, branch TEXT, endTs TEXT, events INTEGER, sidechain INTEGER, indexedEndTs TEXT)`);
    this.db.run(`CREATE VIRTUAL TABLE IF NOT EXISTS docs USING fts5(sessionId UNINDEXED, title, body, tokenize = 'porter unicode61')`);
  }

  /** Incremental rebuild: (re)index any session whose distillate is newer than what's indexed. */
  reindex(opts: { force?: boolean } = {}): { indexed: number; total: number } {
    const sessions = listSessions(this.store);
    const known = new Map<string, string>();
    if (!opts.force) for (const r of this.db.query(`SELECT sessionId, indexedEndTs FROM meta`).all() as any[]) known.set(r.sessionId, r.indexedEndTs ?? "");
    const upMeta = this.db.query(`INSERT OR REPLACE INTO meta VALUES (?,?,?,?,?,?,?,?,?)`);
    const delDoc = this.db.query(`DELETE FROM docs WHERE sessionId = ?`);
    const insDoc = this.db.query(`INSERT INTO docs (sessionId, title, body) VALUES (?,?,?)`);
    let indexed = 0;
    const tx = this.db.transaction((batch: SessionDistillate[]) => {
      for (const d of batch) {
        const stamp = d.endTs ?? d.startTs ?? "";
        if (!opts.force && known.get(d.sessionId) === stamp) continue;
        const body = this.bodyFor(d);
        delDoc.run(d.sessionId);
        insDoc.run(d.sessionId, d.title ?? "", body);
        upMeta.run(d.sessionId, d.tool, d.title ?? null, d.cwd ?? null, d.gitBranch ?? null, d.endTs ?? null, d.eventCount, d.sidechain ? 1 : 0, stamp);
        indexed++;
      }
    });
    // chunk so a huge corpus doesn't build one giant transaction
    for (let i = 0; i < sessions.length; i += 500) tx(sessions.slice(i, i + 500));
    return { indexed, total: sessions.length };
  }

  /** Full text a session contributes to the index: title + all user/assistant text + tool names + files. */
  private bodyFor(d: SessionDistillate): string {
    try {
      const events = readSession(this.store, d.tool, d.sessionId);
      const hits: Record<string, number> = {};
      const pieces = extractPieces(events, {}, hits);
      // cap per-session body so one 147MB monster can't bloat the index; the deep grep covers the rest
      const parts: string[] = [];
      let budget = 400_000;
      for (const p of pieces) for (const l of p.lines) {
        if (budget <= 0) break;
        parts.push(l); budget -= l.length;
      }
      return [d.cwd ?? "", d.gitBranch ?? "", ...parts].join("\n");
    } catch { return [d.title ?? "", d.cwd ?? ""].join("\n"); }
  }

  search(query: string, opts: { limit?: number; tool?: string; includeSidechain?: boolean } = {}): SearchHit[] {
    const limit = opts.limit ?? 20;
    const q = ftsQuery(query);
    if (!q.terms.length) return [];
    const run = (match: string): any[] => this.db.query(
      `SELECT d.sessionId AS sessionId, m.tool AS tool, m.title AS title, m.cwd AS cwd, m.branch AS branch,
              m.endTs AS endTs, m.events AS events, m.sidechain AS sidechain,
              snippet(docs, 2, '»', '«', '…', 12) AS snippet, bm25(docs) AS rank
       FROM docs d JOIN meta m ON m.sessionId = d.sessionId
       WHERE docs MATCH $q ${opts.tool ? "AND m.tool = $tool" : ""} ${opts.includeSidechain ? "" : "AND m.sidechain = 0"}
       ORDER BY rank LIMIT $limit`
    ).all(this.bind(match, opts, limit)) as any[];
    let rows = run(q.and);
    if (!rows.length && q.terms.length > 1) rows = run(q.or);
    return rows.map((r) => ({
      sessionId: r.sessionId, tool: r.tool, title: r.title, cwd: r.cwd, gitBranch: r.branch,
      endTs: r.endTs, eventCount: r.events, sidechain: !!r.sidechain, snippet: r.snippet, rank: r.rank,
    }));
  }

  private bind(query: string, opts: any, limit: number): any {
    const b: any = { $q: query, $limit: limit };
    if (opts.tool) b.$tool = opts.tool;
    return b;
  }

  isStale(): boolean {
    try {
      // An index with nothing in it is stale by definition: on a fresh store the database
      // is created after the import wrote every distillate, so a date comparison alone
      // would call it current and search would find nothing.
      const rows = (this.db.query(`SELECT COUNT(*) AS n FROM meta`).get() as { n: number }).n;
      if (rows === 0) return true;
      const dbTime = statSync(this.path).mtimeMs;
      // A distillate directory (or one of its per-tool folders) newer than the db means
      // sessions were written since the last reindex (cheap heuristic).
      const root = join(this.store.root, "distillate");
      const dirs = [root, ...readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => join(root, d.name))];
      return dirs.some((dir) => statSync(dir).mtimeMs > dbTime);
    } catch { return true; }
  }

  close(): void { this.db.close(); }
}
