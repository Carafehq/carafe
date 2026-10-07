import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { readCodexThreadNames } from "../adapters/codex-names";
import { isInjectedBlock } from "../adapters/types";
import type { SessionDistillate } from "../format/distillate";
import { effectiveTitleSource, mayReplaceTitle, writeDistillate } from "../format/distillate";
import { sealSession } from "../format/sessions";
import { CarafeStore } from "../format/store";
import { refreshCodexNames } from "./codex-name-refresh";
import { runImport } from "./import";
import { backfillTitles } from "./reindex-titles";

let work = "";
let codexRoot = "";
const saved: Record<string, string | undefined> = {};

const rec = (timestamp: string, type: string, payload: unknown) => JSON.stringify({ timestamp, type, payload });
const user = (timestamp: string, text: string) => rec(timestamp, "response_item", { type: "message", role: "user", content: [{ type: "input_text", text }] });
const toolTitle = (timestamp: string, title: string, asString = true) => rec(timestamp, "response_item", {
  type: "function_call", name: "set_thread_title", arguments: asString ? JSON.stringify({ title }) : { title }, call_id: `c-${timestamp}`,
});

function rollout(id: string, day: string, lines: string[]): void {
  const dir = join(codexRoot, "sessions", day.slice(0, 4), day.slice(5, 7), day.slice(8, 10));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `rollout-${day}T10-00-00-${id}.jsonl`), `${lines.join("\n")}\n`);
}

function writeIndex(lines: unknown[]): void {
  mkdirSync(codexRoot, { recursive: true });
  writeFileSync(join(codexRoot, "session_index.jsonl"), `${lines.map((line) => typeof line === "string" ? line : JSON.stringify(line)).join("\n")}\n`);
}

function distillate(id: string): SessionDistillate {
  return JSON.parse(readFileSync(new CarafeStore(work).distillatePath("codex", id), "utf8")) as SessionDistillate;
}

function storedDistillate(tool: string, id: string): SessionDistillate {
  return JSON.parse(readFileSync(new CarafeStore(work).distillatePath(tool, id), "utf8")) as SessionDistillate;
}

function seedLegacy(tool: "codex" | "claude-code", id: string, title: string | null, raws: any[], internalSessionId?: string): void {
  const store = new CarafeStore(work);
  sealSession(store, tool, id, raws.map((raw, seq) => ({
    ts: typeof raw.timestamp === "string" ? raw.timestamp : null,
    tool, sessionId: id, seq,
    kind: raw.type === "user" || raw.payload?.role === "user" ? "user" : "meta",
    raw,
  })));
  writeDistillate(store, {
    tool, sessionId: id, internalSessionId, sourcePath: `/fixture/${id}.jsonl`, title,
    cwd: "/fixture", gitBranch: null, startTs: raws[0]?.timestamp ?? null,
    endTs: raws.at(-1)?.timestamp ?? null, eventCount: raws.length,
    toolUseCount: 0, sidechain: false, rawBytes: 1, version: 1,
  });
}

const ccUser = (id: string, timestamp: string, text: string) => ({
  type: "user", sessionId: id, timestamp, message: { content: text },
});
const ccTitle = (id: string, timestamp: string, title: string) => ({
  type: "custom-title", sessionId: id, timestamp, customTitle: title,
});

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "carafe-codex-names-"));
  codexRoot = join(work, "codex");
  for (const key of ["CARAFE_HOME", "CARAFE_CODEX_ROOT", "CARAFE_CC_ROOT"]) saved[key] = process.env[key];
  process.env.CARAFE_HOME = work;
  process.env.CARAFE_CODEX_ROOT = codexRoot;
  process.env.CARAFE_CC_ROOT = join(work, "claude");
  mkdirSync(process.env.CARAFE_CC_ROOT, { recursive: true });
});

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) value === undefined ? delete process.env[key] : process.env[key] = value;
  rmSync(work, { recursive: true, force: true });
});

describe("Codex session_index.jsonl", () => {
  test("an empty import still reports every watchdog stage", async () => {
    const stages: string[] = [];
    await runImport({ quiet: true, onStage: (stage) => stages.push(stage) });
    expect(stages).toEqual(["discover", "read sources", "write sessions", "distillates", "snapshots", "index catalog"]);
  });

  test("newest append wins while malformed and empty lines are ignored", () => {
    writeIndex([
      { id: "a", thread_name: "  Old\n name ", updated_at: "2026-09-20T10:00:00Z" },
      "not json",
      { id: "a", thread_name: "  Real   renamed title  ", updated_at: "2026-09-20T11:00:00Z" },
      { id: "b", thread_name: "   ", updated_at: "2026-09-20T12:00:00Z" },
      { id: "c", thread_name: 4, updated_at: "2026-09-20T12:00:00Z" },
      { id: "d", thread_name: "whole second", updated_at: "2026-09-20T12:00:00Z" },
      { id: "d", thread_name: "fraction is newer", updated_at: "2026-09-20T12:00:00.000001Z" },
      { id: "e", thread_name: "bad timestamp", updated_at: "not-a-date" },
    ]);
    expect([...readCodexThreadNames(codexRoot)]).toEqual([
      ["a", { name: "Real renamed title", updatedAt: "2026-09-20T11:00:00Z" }],
      ["d", { name: "fraction is newer", updatedAt: "2026-09-20T12:00:00.000001Z" }],
    ]);
  });

  test("missing and unreadable indexes are silent", () => {
    expect(readCodexThreadNames(join(work, "absent")).size).toBe(0);
    mkdirSync(join(codexRoot, "session_index.jsonl"), { recursive: true });
    expect(readCodexThreadNames(codexRoot).size).toBe(0);
  });
});

describe("title source priority", () => {
  const INDEX = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
  const TOOL = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
  const DERIVED = "cccccccc-3333-4333-8333-cccccccccccc";

  async function seedPriority(): Promise<void> {
    rollout(INDEX, "2026-09-18", [rec("2026-09-18T10:00:00Z", "session_meta", { id: INDEX, cwd: "/fixture" }), user("2026-09-18T10:00:01Z", "Derived index fallback"), toolTitle("2026-09-18T10:00:02Z", "Tool loses")]);
    rollout(TOOL, "2026-09-19", [rec("2026-09-19T10:00:00Z", "session_meta", { id: TOOL, cwd: "/fixture" }), user("2026-09-19T10:00:01Z", "Derived tool fallback"), toolTitle("2026-09-19T10:00:02Z", "First tool title", false), toolTitle("2026-09-19T10:00:03Z", "Last tool title")]);
    rollout(DERIVED, "2026-09-20", [rec("2026-09-20T10:00:00Z", "session_meta", { id: DERIVED, cwd: "/fixture" }), user("2026-09-20T10:00:01Z", "Only the derived fallback")]);
    writeIndex([{ id: INDEX, thread_name: "Acme Search Indexer", updated_at: "2026-09-20T13:54:39.169656Z" }]);
    await runImport({ quiet: true });
  }

  test("index, last rollout tool call, and derived fallback are selected in order", async () => {
    await seedPriority();
    expect([distillate(INDEX).title, distillate(INDEX).titleSource]).toEqual(["Acme Search Indexer", "codex-index"]);
    expect([distillate(TOOL).title, distillate(TOOL).titleSource]).toEqual(["Last tool title", "codex-tool"]);
    expect([distillate(DERIVED).title, distillate(DERIVED).titleSource]).toEqual(["Only the derived fallback", "derived"]);
  });

  test("an index-only rename changes exactly title and titleSource", async () => {
    await seedPriority();
    const before = distillate(INDEX);
    writeIndex([
      { id: INDEX, thread_name: "Acme Search Indexer", updated_at: "2026-09-20T13:54:39Z" },
      { id: INDEX, thread_name: "Acme Search Indexer renamed", updated_at: "2026-09-21T13:54:39Z" },
    ]);
    expect(refreshCodexNames(new CarafeStore(work))).toEqual([{ tool: "codex", id: INDEX }]);
    const after = distillate(INDEX);
    expect(after.title).toBe("Acme Search Indexer renamed");
    expect(after.titleSource).toBe("codex-index");
    const strip = ({ title: _title, titleSource: _source, ...rest }: SessionDistillate) => rest;
    expect(strip(after)).toEqual(strip(before));
  });

  test("human survives an index rename and a forced re-import", async () => {
    await seedPriority();
    const human = { ...distillate(INDEX), title: "Human title", titleSource: "human" as const };
    writeDistillate(new CarafeStore(work), human);
    writeIndex([{ id: INDEX, thread_name: "A newer machine title", updated_at: "2026-09-21T13:54:39Z" }]);
    expect(refreshCodexNames(new CarafeStore(work))).toEqual([]);
    await runImport({ quiet: true, force: true });
    expect([distillate(INDEX).title, distillate(INDEX).titleSource]).toEqual(["Human title", "human"]);
  });

  test("legacy null title with recency still migrates from a rollout tool call", async () => {
    await seedPriority();
    const legacy = distillate(TOOL);
    legacy.title = null;
    delete legacy.titleSource;
    expect(legacy.lastActivityTs).toBeDefined();
    writeDistillate(new CarafeStore(work), legacy);
    const result = backfillTitles(new CarafeStore(work), { apply: true });
    expect(result.changed.some((change) => change.sessionId === TOOL)).toBe(true);
    expect([distillate(TOOL).title, distillate(TOOL).titleSource]).toEqual(["Last tool title", "codex-tool"]);
  });
});

test("title replacement is source-ordered and only explicit rename sources replace at equal provenance", () => {
  expect(mayReplaceTitle("codex", "same", "derived", "same", "derived")).toBe(false);
  expect(mayReplaceTitle("codex", "old", "derived", "re-derived", "derived")).toBe(false);
  expect(mayReplaceTitle("codex", "old", "continued", "re-derived", "continued")).toBe(false);
  expect(mayReplaceTitle("codex", "old", "weak", "re-derived", "weak")).toBe(false);
  expect(mayReplaceTitle("codex", "old", "codex-tool", "renamed", "codex-tool")).toBe(true);
  expect(mayReplaceTitle("codex", "old", "codex-index", "renamed", "codex-index")).toBe(true);
  expect(mayReplaceTitle("claude-code", "old", "cc-title", "renamed", "cc-title")).toBe(true);
  expect(mayReplaceTitle("codex", "old", "human", "renamed", "human")).toBe(true);
  expect(mayReplaceTitle("codex", "human", "human", "machine", "codex-index")).toBe(false);
  expect(mayReplaceTitle("codex", "index", "codex-index", "cc rename", "cc-title")).toBe(false);
  expect(mayReplaceTitle("codex", "tool", "codex-tool", "derived", "derived")).toBe(false);
});

describe("legacy title-source migration", () => {
  test("legacy Claude title survives a continuation preamble and is not a dry-run rename", () => {
    const id = "11111111-1111-4111-8111-111111111111";
    seedLegacy("claude-code", id, "Agent consumption of large sessions", [
      ccUser(id, "2026-09-20T10:00:00Z", "This session is being continued from a previous conversation…"),
    ]);
    const store = new CarafeStore(work);
    const dry = backfillTitles(store, { apply: false });
    expect(dry.renamed.map((change) => change.sessionId)).not.toContain(id);
    backfillTitles(store, { apply: true });
    expect([storedDistillate("claude-code", id).title, storedDistillate("claude-code", id).titleSource]).toEqual([
      "Agent consumption of large sessions", "cc-title",
    ]);
  });

  test("legacy Claude title survives an at-file name-this-session first message", () => {
    const id = "22222222-2222-4222-8222-222222222222";
    seedLegacy("claude-code", id, "Nova Harbor New", [
      ccUser(id, "2026-09-20T10:00:00Z", '@"/Users/k/NOVA-HANDOFF.md" Name this session "Nova Harbor New" and continue.'),
    ]);
    const store = new CarafeStore(work);
    expect(backfillTitles(store, { apply: false }).renamed.map((change) => change.sessionId)).not.toContain(id);
    backfillTitles(store, { apply: true });
    expect([storedDistillate("claude-code", id).title, storedDistillate("claude-code", id).titleSource]).toEqual([
      "Nova Harbor New", "cc-title",
    ]);
  });

  test("legacy Codex derived title upgrades to its own literal index name", () => {
    const id = "33333333-3333-4333-8333-333333333333";
    seedLegacy("codex", id, "ok where do we start", [
      JSON.parse(user("2026-09-20T10:00:00Z", "ok where do we start")),
    ]);
    writeIndex([{ id, thread_name: "Acme Search Indexer", updated_at: "2026-09-20T11:00:00Z" }]);
    backfillTitles(new CarafeStore(work), { apply: true });
    expect([storedDistillate("codex", id).title, storedDistillate("codex", id).titleSource]).toEqual([
      "Acme Search Indexer", "codex-index",
    ]);
  });

  test("legacy Codex derived title is not re-derived without stronger evidence", () => {
    const id = "44444444-4444-4444-8444-444444444444";
    seedLegacy("codex", id, "Existing derived title", [
      JSON.parse(user("2026-09-20T10:00:00Z", "Different first message after the derivation rules changed")),
    ]);
    backfillTitles(new CarafeStore(work), { apply: true });
    expect([storedDistillate("codex", id).title, storedDistillate("codex", id).titleSource]).toEqual([
      "Existing derived title", "derived",
    ]);
  });

  test("a later Claude Code title event is real rename evidence", () => {
    const id = "55555555-5555-4555-8555-555555555555";
    seedLegacy("claude-code", id, "Search Indexer", [
      ccUser(id, "2026-09-20T10:00:00Z", "You are taking over the Search Indexer project"),
      ccTitle(id, "2026-09-20T10:01:00Z", "Acme Search Indexer"),
    ]);
    const result = backfillTitles(new CarafeStore(work), { apply: true });
    expect(result.renamed.map((change) => change.sessionId)).toContain(id);
    expect([storedDistillate("claude-code", id).title, storedDistillate("claude-code", id).titleSource]).toEqual([
      "Acme Search Indexer", "cc-title",
    ]);
  });

  test("mixed-store dry run never renames a non-injected legacy Claude title", () => {
    const realA = "66666666-6666-4666-8666-666666666666";
    const realB = "77777777-7777-4777-8777-777777777777";
    const injected = "88888888-8888-4888-8888-888888888888";
    seedLegacy("claude-code", realA, "Acme AI billing flows", [ccUser(realA, "2026-09-20T10:00:00Z", "Session name: acme ai billing flows. Continue the implementation.")]);
    seedLegacy("claude-code", realB, "Search Indexer", [ccUser(realB, "2026-09-20T10:01:00Z", "You are taking over the Search Indexer project")]);
    seedLegacy("claude-code", injected, "<system-reminder>Generated context</system-reminder>", [ccUser(injected, "2026-09-20T10:02:00Z", "Replace generated context with owner text")]);
    seedLegacy("codex", "99999999-9999-4999-8999-999999999999", "old derived", [JSON.parse(user("2026-09-20T10:03:00Z", "new derived"))]);

    const dry = backfillTitles(new CarafeStore(work), { apply: false });
    const forbidden = dry.renamed.filter((change) =>
      change.tool === "claude-code" && change.oldTitle !== null && !isInjectedBlock(change.oldTitle));
    expect(forbidden).toEqual([]);
    expect(dry.renamed.map((change) => change.sessionId)).toContain(injected);
  });

  test("legacy provenance is inferred once by tool and injected-title shape", () => {
    expect(effectiveTitleSource("claude-code", "Real Claude title", undefined)).toBe("cc-title");
    expect(effectiveTitleSource("codex", "Derived Codex title", undefined)).toBe("derived");
    expect(effectiveTitleSource("claude-code", "<system-reminder>generated</system-reminder>", undefined)).toBe("weak");
  });
});

test("forks never inherit an index name through a shared internal session id", async () => {
  const original = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const forkOne = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const forkTwo = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  for (const [id, day, text] of [
    [original, "2026-09-18", "Original conversation prompt"],
    [forkOne, "2026-09-19", "First fork prompt"],
    [forkTwo, "2026-09-20", "Second fork prompt"],
  ] as const) {
    rollout(id, day, [
      rec(`${day}T10:00:00Z`, "session_meta", { id: original, cwd: "/fixture" }),
      user(`${day}T10:00:01Z`, text),
    ]);
  }
  writeIndex([{ id: original, thread_name: "Review rejected profile progress", updated_at: "2026-09-20T11:00:00Z" }]);
  await runImport({ quiet: true });
  expect(distillate(original).title).toBe("Review rejected profile progress");
  expect(distillate(forkOne).title).toBe("First fork prompt");
  expect(distillate(forkTwo).title).toBe("Second fork prompt");

  for (const id of [forkOne, forkTwo]) {
    const legacy = distillate(id);
    delete legacy.titleSource;
    writeDistillate(new CarafeStore(work), legacy);
  }
  backfillTitles(new CarafeStore(work), { apply: true });
  expect(distillate(forkOne).title).toBe("First fork prompt");
  expect(distillate(forkTwo).title).toBe("Second fork prompt");

  writeIndex([{ id: original, thread_name: "Original renamed again", updated_at: "2026-09-21T11:00:00Z" }]);
  expect(refreshCodexNames(new CarafeStore(work))).toEqual([{ tool: "codex", id: original }]);
  expect(distillate(forkOne).title).toBe("First fork prompt");
  expect(distillate(forkTwo).title).toBe("Second fork prompt");
});

test("a short first post-handoff message is prefixed with the source title", async () => {
  const source = "dddddddd-4444-4444-8444-dddddddddddd";
  const child = "eeeeeeee-5555-4555-8555-eeeeeeeeeeee";
  rollout(source, "2026-09-18", [rec("2026-09-18T10:00:00Z", "session_meta", { id: source, cwd: "/fixture" }), user("2026-09-18T10:00:01Z", "Acme Platform production readiness")]);
  rollout(child, "2026-09-19", [
    rec("2026-09-19T10:00:00Z", "session_meta", { id: child, cwd: "/fixture" }),
    user("2026-09-19T10:00:01Z", `Read /fixture/handoffs/${source}.md and continue the work`),
    user("2026-09-19T10:00:02Z", "can you test them first"),
    user("2026-09-19T10:00:03Z", "This later text must not be used"),
  ]);
  await runImport({ quiet: true });
  expect([distillate(child).title, distillate(child).titleSource]).toEqual([
    "Acme Platform production readiness — can you test them first", "derived",
  ]);
});
