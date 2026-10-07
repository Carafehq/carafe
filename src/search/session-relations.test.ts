import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { basename, join } from "path";
import { buildCorpus, type BenchSession } from "../bench/corpus";
import { writeDistillate } from "../format/distillate";
import { sealSession } from "../format/sessions";
import { CarafeStore } from "../format/store";
import { buildBlocks } from "../handoff/blocks";
import { extractPieces, filesOf } from "../handoff/pieces";
import { segmentChapters } from "../keymoments/chapters";
import { extractMoments } from "../keymoments/extract";
import { renderMomentsSection } from "../keymoments/render";
import { momentLabel } from "../keymoments/select";
import { failExcerpt, normalizeSentence } from "../keymoments/signals";
import { SessionIndex } from "./session-index";

let root = "";
let store: CarafeStore;
let large: BenchSession;
let queryFixture: BenchSession;
let largeIndex: SessionIndex;
let queryIndex: SessionIndex;
let largeBuildMs = 0;

function materialize(session: BenchSession): void {
  sealSession(store, session.tool, session.distillate.sessionId, session.events);
  writeDistillate(store, session.distillate);
}

function key(moment: { kind: string; seq: number; endSeq?: number; text: string; note?: string }): string {
  return `${moment.kind}\0${moment.seq}\0${moment.endSeq ?? ""}\0${moment.text}\0${moment.note ?? ""}`;
}

function storedKind(moment: { kind: string; text: string }): string {
  if (moment.kind === "deadend" || moment.kind === "goal") return moment.kind;
  return momentLabel(moment as Parameters<typeof momentLabel>[0]);
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "carafe-session-relations-"));
  store = new CarafeStore(root);
  const corpus = buildCorpus("gate");
  large = corpus.find((session) => session.name === "L-31-codex")!;
  queryFixture = corpus.find((session) => session.name === "S-11-codex")!;
  materialize(large);
  materialize(queryFixture);
  largeIndex = new SessionIndex(store, large.distillate);
  const started = performance.now();
  largeIndex.reindex({ events: large.events });
  largeBuildMs = performance.now() - started;
  queryIndex = new SessionIndex(store, queryFixture.distillate);
  queryIndex.reindex({ events: queryFixture.events });
});

afterAll(() => {
  largeIndex?.close();
  queryIndex?.close();
  if (root) rmSync(root, { recursive: true, force: true });
});

describe("session relation index", () => {
  test("stores every chapter and candidate moment with the default-budget selection flag", () => {
    const pieces = extractPieces(large.events, {}, {});
    const set = extractMoments({ events: large.events, pieces });
    const chapters = segmentChapters(large.events, pieces, {}, set.moments, set.context.runs);
    const db = new Database(largeIndex.path, { readonly: true });
    const storedChapters = db.query(`SELECT idx, start_seq AS startSeq, end_seq AS endSeq FROM chapters ORDER BY idx`).all();
    expect(storedChapters).toEqual(chapters.map((chapter) => ({ idx: chapter.index, startSeq: chapter.startSeq, endSeq: chapter.endSeq })));

    const rendered = renderMomentsSection(set, { budgetChars: 20_000, chapters }).moments;
    const selected = new Set([
      ...rendered.map(key),
      ...set.moments.filter((moment) => moment.kind === "goal").map(key),
    ]);
    const rows = db.query(`SELECT seq, end_seq AS endSeq, kind, text, note, selected FROM moments ORDER BY rowid`).all() as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(set.moments.length);
    for (let index = 0; index < set.moments.length; index++) {
      const expected = set.moments[index]!;
      const row = rows[index]!;
      expect(row.seq).toBe(expected.seq);
      expect(row.endSeq).toBe(expected.endSeq ?? null);
      expect(row.kind).toBe(storedKind(expected));
      expect(row.text).toBe(expected.text);
      expect(row.note).toBe(expected.note ?? null);
      expect(row.selected).toBe(selected.has(key(expected)) ? 1 : 0);
    }
    db.close();
  });

  test("block files equal filesOf over each block and edits are marked", () => {
    const pieces = extractPieces(large.events, {}, {});
    const blocks = buildBlocks(large.events, pieces);
    const db = new Database(largeIndex.path, { readonly: true });
    const rows = db.query(`SELECT block_idx AS blockIdx, file, edited FROM block_files ORDER BY block_idx, file`).all() as Array<{ blockIdx: number; file: string; edited: number }>;
    const actual = new Map<number, string[]>();
    for (const row of rows) (actual.get(row.blockIdx) ?? (actual.set(row.blockIdx, []), actual.get(row.blockIdx)!)).push(row.file);
    for (let index = 0; index < blocks.length; index++) {
      const block = blocks[index]!;
      const expected = [...new Set(large.events.filter((event) => event.seq >= block.startSeq && event.seq <= block.endSeq).flatMap(filesOf))].sort();
      expect(actual.get(index) ?? [], `block ${index}`).toEqual(expected);
    }
    expect(rows.some((row) => row.edited === 1)).toBe(true);
    db.close();
  });

  test("runs use the detector failure rules, including read-ish error output", () => {
    const pieces = extractPieces(large.events, {}, {});
    const context = extractMoments({ events: large.events, pieces }).context;
    const expected = context.runs.filter((run) => run.command && run.family);
    const db = new Database(largeIndex.path, { readonly: true });
    const rows = db.query(`SELECT seq, family, command, ok FROM runs ORDER BY seq`).all() as Array<{ seq: number; family: string; command: string; ok: number }>;
    expect(rows).toHaveLength(expected.length);
    expect(rows.map((row) => [row.seq, row.family, row.command, row.ok])).toEqual(expected.map((run) => [run.toolSeq, run.family!, run.command!, run.failed ? 0 : 1]));
    const quoted = expected.find((run) => run.readish && /error TS|AssertionError|Traceback|npm ERR!/.test(run.resultLine));
    expect(quoted).toBeDefined();
    expect(rows.find((row) => row.seq === quoted!.toolSeq)?.ok).toBe(1);
    db.close();
  });

  test("entities contain standing-rule terms and planted failure tokens", () => {
    const pieces = extractPieces(large.events, {}, {});
    const set = extractMoments({ events: large.events, pieces });
    const db = new Database(largeIndex.path, { readonly: true });
    const ruleTerms = new Set((db.query(`SELECT value FROM entities WHERE kind = 'rule-term'`).all() as Array<{ value: string }>).map((row) => row.value));
    for (const rule of set.moments.filter((moment) => moment.kind === "rule")) {
      for (const term of normalizeSentence(rule.text).split(/\s+/).filter((value) => value.length >= 3)) expect(ruleTerms.has(term), term).toBe(true);
    }
    const expectedErrors = new Set(set.context.runs.filter((run) => run.failed).flatMap((run) => {
      const excerpt = failExcerpt(run.resultLine);
      const token = /\b(TS\d+|ELIFECYCLE|AssertionError|Traceback)\b/.exec(excerpt)?.[1] ?? /\b([A-Z][A-Z0-9_]{2,})\b/.exec(excerpt)?.[1];
      return token ? [token] : [];
    }));
    const storedErrors = new Set((db.query(`SELECT value FROM entities WHERE kind = 'error'`).all() as Array<{ value: string }>).map((row) => row.value));
    expect(expectedErrors.size).toBeGreaterThan(0);
    for (const token of expectedErrors) expect(storedErrors.has(token), token).toBe(true);
    db.close();
  });

  test("structured filters find a no-trace file, abandoned bun runs, and one chapter's decisions", () => {
    const noTrace = queryFixture.gold.units.find((unit) => unit.kind === "deadend.notrace")!;
    const byFile = queryIndex.ask({ file: basename(noTrace.anchor), limit: 1_000 });
    expect(byFile.some((row) => row.type === "moment" && row.kind === "deadend")).toBe(true);

    const queryPieces = extractPieces(queryFixture.events, {}, {});
    const context = extractMoments({ events: queryFixture.events, pieces: queryPieces }).context;
    const abandoned = context.streaks.find((streak) => !streak.success && streak.family === "bun test")!;
    expect(abandoned).toBeDefined();
    const failed = queryIndex.ask({ failed: true, command: "bun test", limit: 1_000 });
    for (const run of abandoned.failures) expect(failed.some((row) => row.type === "run" && row.seq === run.toolSeq && row.ok === 0)).toBe(true);

    const decision = queryIndex.ask({ kind: "decision", limit: 1_000 })[0]!;
    const inChapter = queryIndex.ask({ kind: "decision", chapter: decision.chapterIdx, limit: 1_000 });
    expect(inChapter.length).toBeGreaterThan(0);
    expect(inChapter.every((row) => row.kind === "decision" && row.chapterIdx === decision.chapterIdx)).toBe(true);
  });

  test("CLI index reports table counts and ask uses the standard not-found message", () => {
    const cli = join(import.meta.dir, "..", "cli", "index.ts");
    const env = { ...process.env, CARAFE_HOME: root, CARAFE_NO_UPDATE_CHECK: "1" };
    const indexed = Bun.spawnSync([process.execPath, "run", cli, "index", queryFixture.distillate.sessionId], { env, stdout: "pipe", stderr: "pipe" });
    expect(indexed.exitCode).toBe(0);
    const output = new TextDecoder().decode(indexed.stdout);
    for (const table of ["docs", "chapters", "blocks", "block_files", "runs", "moments", "moment_files", "entities", "meta"]) expect(output).toContain(`  ${table}:`);

    const asked = Bun.spawnSync([process.execPath, "run", cli, "ask", queryFixture.distillate.sessionId, "--failed", "--command", "bun test", "--json"], { env, stdout: "pipe", stderr: "pipe" });
    expect(asked.exitCode).toBe(0);
    const rows = JSON.parse(new TextDecoder().decode(asked.stdout)) as Array<Record<string, unknown>>;
    expect(rows.length).toBeGreaterThan(0);
    for (const column of ["type", "seq", "endSeq", "kind", "chapterIdx", "blockIdx", "text", "note", "selected", "family", "command", "ok", "excerpt", "chapterStartSeq", "chapterEndSeq", "branch", "cwd"]) expect(column in rows[0]!).toBe(true);

    const missing = Bun.spawnSync([process.execPath, "run", cli, "ask", "missing-session", "--failed"], { env, stdout: "pipe", stderr: "pipe" });
    expect(missing.exitCode).toBe(1);
    expect(new TextDecoder().decode(missing.stderr)).toContain("session not found: missing-session");
  });

  test("records (but does not gate on) the L-session build duration", () => {
    expect(Number.isFinite(largeBuildMs)).toBe(true);
    console.log(`session-index L build: ${largeBuildMs.toFixed(1)}ms`);
  });
});
