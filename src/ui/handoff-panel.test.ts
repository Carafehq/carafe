/**
 * F5 — the web handoff panel: one honest token figure and one copy button.
 */
import { describe, expect, test } from "bun:test";
import { CHARS_PER_TOKEN, tokenEstimate } from "../handoff/render";
import type { SessionDistillate } from "../format/distillate";
import { HTML } from "./html";
import { handoffTokens, recentSessions } from "./server";
import { isSpawned } from "../query/sessions";

describe("/api/handoff token figure", () => {
  test("is the shared estimate, not chars/4", () => {
    const bytes = 156_174;
    expect(handoffTokens(bytes).tokenLabel).toBe(tokenEstimate(bytes));
    expect(handoffTokens(bytes).tokens).toBe(Math.round(bytes / CHARS_PER_TOKEN));
    expect(handoffTokens(bytes).tokens).not.toBe(Math.round(bytes / 4));
  });

  test("the label matches the CLI's wording exactly", () => {
    expect(handoffTokens(156_174).tokenLabel).toBe("≈ 58K tokens (estimate)");
  });
});

describe("handoff panel markup", () => {
  const doHandoff = HTML.slice(HTML.indexOf("async function doHandoff"), HTML.indexOf("function renderPin"));

  test("offers one action from the selected source with no recipient selector", () => {
    expect(HTML).toContain("Hand off from ");
    expect(HTML).not.toContain('id="to"');
    expect(doHandoff).toContain("JSON.stringify({id})");
    expect(doHandoff).toContain("any agent</b>");
    expect(doHandoff).toContain("Paste into any agent:");
  });

  test("renders a copy button styled like the key-moments one", () => {
    expect(doHandoff).toContain('id="hcopy"');
    expect(doHandoff).toContain('class="act"');
    expect(doHandoff).toContain("⧉ Copy");
  });

  test("the copied payload is the whole sentence the owner pastes", () => {
    expect(doHandoff).toContain("'Read '+r.file+' and continue the work'");
    expect(doHandoff).toContain('copyText(instruction,"instruction copied — paste into any agent")');
  });

  test("it also copies once automatically, and a rejected clipboard shows nothing extra", () => {
    expect(doHandoff).toContain("navigator.clipboard.writeText(instruction)");
    expect(doHandoff).toContain(".catch(()=>{})");
  });

  test("the panel still reports tokens from the server's label", () => {
    expect(doHandoff).toContain("r.tokenLabel");
  });

  test("the panel is rendered on click only — no passive-scroll DOM mutation", () => {
    expect(HTML).toContain('document.getElementById("go").onclick=()=>doHandoff(id);');
  });
});

/** The sidebar (`/api/sessions`) must hide exactly what `carafe list` hides —
 *  one shared predicate, not two copies that drift. */
describe("sidebar default filtering", () => {
  const mk = (over: Partial<SessionDistillate>): SessionDistillate => ({
    tool: "codex", sessionId: "x", sourcePath: "/s.jsonl", title: "t", cwd: "/p",
    gitBranch: null, startTs: "2026-09-01T10:00:00Z", endTs: "2026-09-01T10:00:00Z",
    eventCount: 40, toolUseCount: 0, sidechain: false, rawBytes: 1, version: 1, ...over,
  });
  const live = mk({ sessionId: "live", lastActivityTs: "2026-09-20T13:00:00Z", endTs: "2026-09-20T13:00:00Z", hasUserText: true });
  // The bug from the brief: newest endTs (trailing token counts), oldest talk.
  const idle = mk({ sessionId: "idle", lastActivityTs: "2026-09-06T10:00:30Z", endTs: "2026-09-20T12:00:39Z", hasUserText: true });
  const reviewer = mk({ sessionId: "reviewer", title: null, internal: true, lastActivityTs: "2026-09-19T10:00:05Z", hasUserText: false });
  const stub = mk({ sessionId: "stub", title: null, eventCount: 3, hasUserText: false, lastActivityTs: "2026-09-18T10:00:00Z" });
  const legacy = mk({ sessionId: "legacy", eventCount: 2 }); // pre-backfill: no hasUserText
  const h = { sessions: [live, idle, reviewer, stub, legacy], parentOf: {}, orphanSpawns: {} };

  test("reviewer runs and stubs are hidden by default", () => {
    expect(recentSessions(h).map((d) => d.sessionId)).not.toContain("reviewer");
    expect(recentSessions(h).map((d) => d.sessionId)).not.toContain("stub");
  });

  test("all=1 shows them", () => {
    expect(recentSessions(h, { all: true }).map((d) => d.sessionId).sort())
      .toEqual(["idle", "legacy", "live", "reviewer", "stub"]);
  });

  test("a legacy distillate awaiting the backfill is never hidden as a stub", () => {
    expect(recentSessions(h).map((d) => d.sessionId)).toContain("legacy");
  });

  test("ordering is by lastActivityTs, so the idle-but-noisy session sinks", () => {
    expect(recentSessions(h).map((d) => d.sessionId)).toEqual(["live", "idle", "legacy"]);
  });

  test("the tool filter still applies", () => {
    expect(recentSessions(h, { tool: "claude-code" })).toEqual([]);
    expect(recentSessions(h, { tool: "codex" }).map((d) => d.sessionId)).toEqual(["live", "idle", "legacy"]);
  });
});

describe("isSpawned — a recorded field, never inferred", () => {
  const d = (over: Partial<SessionDistillate>): SessionDistillate => ({
    tool: "codex", sessionId: "x", sourcePath: "/s.jsonl", title: "t", cwd: "/p",
    gitBranch: null, startTs: null, endTs: null, eventCount: 40, toolUseCount: 0,
    sidechain: false, rawBytes: 1, version: 1, ...over,
  });

  test("codex exec and subagent are spawned", () => {
    expect(isSpawned(d({ sourceKind: "exec" }))).toBe(true);
    expect(isSpawned(d({ sourceKind: "subagent" }))).toBe(true);
  });

  test("interactive codex sources are not", () => {
    for (const k of ["vscode", "cli"]) expect(isSpawned(d({ sourceKind: k })), k).toBe(false);
  });

  test("an absent or unknown sourceKind is NOT spawned — legacy rows never vanish", () => {
    expect(isSpawned(d({}))).toBe(false);
    expect(isSpawned(d({ sourceKind: "something-new" }))).toBe(false);
  });

  test("claude code is never spawned by this rule (its helpers nest instead)", () => {
    expect(isSpawned(d({ tool: "claude-code", sourceKind: "exec" }))).toBe(false);
  });
});

describe("sidebar hides agent-spawned workers", () => {
  const mk = (over: Partial<SessionDistillate>): SessionDistillate => ({
    tool: "codex", sessionId: "x", sourcePath: "/s.jsonl", title: "t", cwd: "/p",
    gitBranch: null, startTs: null, endTs: "2026-09-01T10:00:00Z", lastActivityTs: "2026-09-01T10:00:00Z",
    eventCount: 40, toolUseCount: 0, sidechain: false, hasUserText: true, rawBytes: 1, version: 1, ...over,
  });
  const human = mk({ sessionId: "human", sourceKind: "vscode", lastActivityTs: "2026-09-20T10:00:00Z" });
  const worker1 = mk({ sessionId: "worker1", sourceKind: "exec", lastActivityTs: "2026-09-19T10:00:00Z" });
  const worker2 = mk({ sessionId: "worker2", sourceKind: "subagent", lastActivityTs: "2026-09-18T10:00:00Z" });
  const legacy = mk({ sessionId: "legacy", lastActivityTs: "2026-09-17T10:00:00Z" }); // no sourceKind
  const h = { sessions: [human, worker1, worker2, legacy], parentOf: {}, orphanSpawns: {} };

  test("default: only sessions a human opened (plus legacy rows)", () => {
    expect(recentSessions(h).map((x) => x.sessionId)).toEqual(["human", "legacy"]);
  });

  test("?all=1 shows every worker", () => {
    expect(recentSessions(h, { all: true }).map((x) => x.sessionId)).toEqual(["human", "worker1", "worker2", "legacy"]);
  });
});
