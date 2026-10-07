import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { CarafeEvent } from "../format/events";
import { CarafeStore } from "../format/store";
import { sealSession } from "../format/sessions";
import { writeDistillate, type SessionDistillate } from "../format/distillate";
import { VERSION } from "../version";
import { runLiveCommand } from "../cli/live";
import {
  CONSENT_INTRO,
  CONSENT_QUESTION,
  decisionFor,
  readConsentConfig,
  resolveHealthConsent,
  storeDecision,
} from "./consent";
import { checkLive, healthFetcher, isAllowedHealthUrl, liveLines } from "./live";
import { extractPieces } from "./pieces";
import { healthUrlsFromTrace } from "./state";
import { runHandoff } from "./handoff";

const NOW = "2026-09-21T12:00:00.000Z";
const URL_A = "https://api.example.invalid/health";
const URL_B = "https://status.example.invalid/status/ready";
let workspace = "";

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "carafe-consent-workspace-"));
  writeFileSync(join(workspace, "config.json"), JSON.stringify({ version: 1, unknown: { nested: [1, "two", { three: true }] } }, null, 2));
});

afterEach(() => { rmSync(workspace, { recursive: true, force: true }); });

const config = (): unknown => JSON.parse(readFileSync(join(workspace, "config.json"), "utf8"));
describe("stored live-check consent", () => {
  test("no consent never calls even an injected fetch that throws", async () => {
    const decisions = await resolveHealthConsent({ root: workspace, workspace, urls: [URL_A], interactive: false });
    let calls = 0;
    const state = await checkLive([], {
      healthUrls: [URL_A], healthConsent: decisions,
      fetcher: async () => { calls++; throw new Error("real fetch must not be referenced"); },
      now: NOW,
    });
    expect(calls).toBe(0);
    expect(state.health[0]?.decision).toBe("unknown");
  });

  test("the main handoff path is non-networking without consent", async () => {
    const store = new CarafeStore(workspace);
    const project = join(workspace, "project");
    mkdirSync(project, { recursive: true });
    const events: CarafeEvent[] = [
      { ts: NOW, tool: "codex", sessionId: "main-no-consent", seq: 1, kind: "user", raw: { payload: { message: "check the service" } } },
      { ts: NOW, tool: "codex", sessionId: "main-no-consent", seq: 2, kind: "tool_use", raw: { payload: { name: "Bash", arguments: { command: `curl -s ${URL_A}` } } } },
      { ts: NOW, tool: "codex", sessionId: "main-no-consent", seq: 3, kind: "tool_result", raw: { payload: { output: "ok" } } },
    ];
    const d: SessionDistillate = {
      tool: "codex", sessionId: "main-no-consent", sourcePath: join(workspace, "source.jsonl"), title: "consent fixture",
      cwd: project, gitBranch: null, startTs: NOW, endTs: NOW, eventCount: events.length, toolUseCount: 1,
      sidechain: false, rawBytes: 1, version: 1,
    };
    sealSession(store, d.tool, d.sessionId, events);
    writeDistillate(store, d);
    let calls = 0;
    await runHandoff(d.sessionId, {
      store, interactive: false, noArm: true, now: NOW,
      fetcher: async () => { calls++; throw new Error("network called without consent"); },
    });
    expect(calls).toBe(0);
    expect(readFileSync(join(workspace, "handoffs", `${d.sessionId}.md`), "utf8")).toContain("LIVE STATE UNKNOWN");
  });

  test("TTY y stores allow, checks once per URL, and the next run does not ask", async () => {
    let prompts = 0;
    const first = await resolveHealthConsent({
      root: workspace, workspace, urls: [URL_A], interactive: true, now: NOW,
      reader: async () => "y", write: () => { prompts++; },
    });
    let calls = 0;
    await checkLive([], { healthUrls: [URL_A], healthConsent: first, fetcher: async () => { calls++; return { body: "ok" }; }, now: NOW });
    const second = await resolveHealthConsent({
      root: workspace, workspace, urls: [URL_A], interactive: true,
      reader: async () => { throw new Error("must not ask twice"); }, write: () => { prompts++; },
    });
    await checkLive([], { healthUrls: [URL_A], healthConsent: second, fetcher: async () => { calls++; return { body: "ok" }; }, now: NOW });
    expect(prompts).toBe(1);
    expect(calls).toBe(2);
    expect(decisionFor(config(), workspace, "api.example.invalid")).toBe("allow");
  });

  test("TTY never stores deny and never asks or fetches again", async () => {
    const first = await resolveHealthConsent({ root: workspace, workspace, urls: [URL_A], interactive: true, reader: async () => "never", write: () => {}, now: NOW });
    let calls = 0;
    await checkLive([], { healthUrls: [URL_A], healthConsent: first, fetcher: async () => { calls++; return { body: "no" }; } });
    const second = await resolveHealthConsent({ root: workspace, workspace, urls: [URL_A], interactive: true, reader: async () => { throw new Error("asked again"); } });
    await checkLive([], { healthUrls: [URL_A], healthConsent: second, fetcher: async () => { calls++; return { body: "no" }; } });
    expect(calls).toBe(0);
    expect(decisionFor(config(), workspace, "api.example.invalid")).toBe("deny");
  });

  for (const [name, answer] of [["Enter", ""], ["EOF", null], ["timeout", null]] as const) {
    test(`${name} stores nothing and does not fetch`, async () => {
      const decisions = await resolveHealthConsent({ root: workspace, workspace, urls: [URL_A], interactive: true, reader: async () => answer, write: () => {} });
      let calls = 0;
      await checkLive([], { healthUrls: [URL_A], healthConsent: decisions, fetcher: async () => { calls++; return { body: "no" }; } });
      expect(calls).toBe(0);
      expect(decisionFor(config(), workspace, "api.example.invalid")).toBe("unknown");
    });
  }

  test("a new host asks again while the allowed host is still checked", async () => {
    expect(storeDecision(workspace, workspace, ["api.example.invalid"], "allow", NOW)).toBe(true);
    let prompt = "";
    const decisions = await resolveHealthConsent({
      root: workspace, workspace, urls: [URL_A, URL_B], interactive: true,
      reader: async () => "", write: (text) => { prompt = text; },
    });
    const fetched: string[] = [];
    await checkLive([], { healthUrls: [URL_A, URL_B], healthConsent: decisions, fetcher: async (url) => { fetched.push(url); return { body: "ok" }; } });
    expect(prompt).toContain(`  GET ${URL_B}`);
    expect(prompt).not.toContain(`  GET ${URL_A}`);
    expect(fetched).toEqual([URL_A]);
  });

  test("config merge preserves unrelated nested values", () => {
    const before = (config() as any).unknown;
    expect(storeDecision(workspace, workspace, ["api.example.invalid"], "allow", NOW)).toBe(true);
    expect((config() as any).unknown).toEqual(before);
  });

  test("malformed decision records fail closed", () => {
    expect(decisionFor({ liveChecks: { [workspace]: { "api.example.invalid": { decision: "allow" } } } }, workspace, "api.example.invalid")).toBe("unknown");
  });

  test("corrupt config is unknown and is never rewritten", async () => {
    const path = join(workspace, "config.json");
    writeFileSync(path, "{ definitely not json\n");
    const before = readFileSync(path, "utf8");
    const decisions = await resolveHealthConsent({ root: workspace, workspace, urls: [URL_A], interactive: true, reader: async () => "yes", write: () => {} });
    expect(decisions.get("api.example.invalid")?.decision).toBe("unknown");
    expect(readConsentConfig(workspace).config).toBeNull();
    expect(readFileSync(path, "utf8")).toBe(before);
  });
});

describe("the human-only CLI boundary", () => {
  test("carafe live allow without a TTY refuses and leaves config unchanged", async () => {
    const before = readFileSync(join(workspace, "config.json"), "utf8");
    let stderr = "";
    const code = await runLiveCommand("allow", {
      store: new CarafeStore(workspace), workspace, host: "api.example.invalid", isTty: false,
      stderr: (text) => { stderr += text; }, stdout: () => {},
    });
    expect(code).toBeGreaterThan(0);
    expect(stderr).toBe("Allowing network checks needs a person at a terminal. Run this yourself: carafe live allow\n");
    expect(readFileSync(join(workspace, "config.json"), "utf8")).toBe(before);
  });
});

describe("the only HTTP boundary", () => {
  test("private, local, non-health, and fourth URLs are never fetched even with permission", async () => {
    const unsafe = [
      "http://localhost/health", "http://127.9.8.7/health", "http://0.0.0.0/status",
      "http://10.2.3.4/health", "http://172.31.4.5/status", "http://192.168.1.2/health",
      "http://169.254.1.1/health", "https://service.local/health", "ftp://api.example.invalid/health",
      "https://api.example.invalid/not-ready",
    ];
    for (const url of unsafe) expect(isAllowedHealthUrl(url)).toBe(false);
    const urls = [...unsafe, URL_A, URL_B, "https://third.example.invalid/health", "https://fourth.example.invalid/health"];
    const consent = new Map<string, any>();
    for (const url of urls) {
      const host = (() => { try { return new URL(url).host; } catch { return ""; } })();
      if (host) consent.set(host, { decision: "allow", record: { decision: "allow", decidedAt: NOW, by: "tty" } });
    }
    const fetched: string[] = [];
    await checkLive([], { healthUrls: urls, healthConsent: consent, fetcher: async (url) => { fetched.push(url); return { body: "x".repeat(300) }; } });
    expect(fetched).toEqual([URL_A, URL_B, "https://third.example.invalid/health"]);
  });

  test("GET has only the versioned user-agent and a cross-host redirect is not followed", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetcher = healthFetcher(async (input, init) => {
      calls.push({ url: String(input), init });
      return new Response(null, { status: 302, headers: { location: "https://other.example.invalid/health" } });
    });
    const result = await fetcher(URL_A, 5_000);
    expect(result).toEqual({ error: "redirect to different host" });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.init?.method).toBe("GET");
    expect(calls[0]?.init?.body).toBeUndefined();
    expect(calls[0]?.init?.redirect).toBe("manual");
    expect(calls[0]?.init?.headers).toEqual({ "User-Agent": `carafe/${VERSION}` });
  });
});

describe("prompt, trace shapes, and rendered variants", () => {
  const shapes: Array<[string, () => CarafeEvent[]]> = [
    ["codex", () => [
      { ts: NOW, tool: "codex", sessionId: "s", seq: 1, kind: "tool_use", raw: { payload: { name: "Bash", arguments: { command: `curl -s ${URL_A}` } } } },
      { ts: NOW, tool: "codex", sessionId: "s", seq: 2, kind: "tool_result", raw: { payload: { output: "ok" } } },
    ]],
    ["claude-code", () => [
      { ts: NOW, tool: "claude-code", sessionId: "s", seq: 1, kind: "assistant", raw: { type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "u1", name: "Bash", input: { command: `curl -s ${URL_A}` } }] } } },
      { ts: NOW, tool: "claude-code", sessionId: "s", seq: 2, kind: "user", raw: { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "u1", content: "ok" }] } } },
    ]],
  ];

  for (const [shape, build] of shapes) {
    test(`${shape} trace yields the same four Right now states`, async () => {
      const events = build();
      const urls = healthUrlsFromTrace(events, extractPieces(events, {}, {}));
      expect(urls).toEqual([URL_A]);
      const base = { checkedAt: NOW, repos: [], live: false, remoteHeads: {} };
      const checked = liveLines({ ...base, health: [{ url: URL_A, body: "ok", error: null, decision: "allow", permission: { host: "api.example.invalid", decidedAt: NOW } }] }).join("\n");
      const denied = liveLines({ ...base, health: [{ url: URL_A, body: null, error: null, decision: "deny" }] }).join("\n");
      const unknown = liveLines({ ...base, health: [{ url: URL_A, body: null, error: null, decision: "unknown" }] }).join("\n");
      const failed = liveLines({ ...base, health: [{ url: URL_A, body: null, error: "TimeoutError", decision: "allow", permission: { host: "api.example.invalid", decidedAt: NOW } }] }).join("\n");
      expect(checked).toContain(`- health: ${URL_A} → ok`);
      expect(checked).toContain("_Checked with your standing permission for api.example.invalid, granted 2026-09-21 (carafe live status)._");
      expect(denied).toContain("- live state not checked: you declined network checks for this project (carafe live status)");
      expect(unknown).toContain("- **LIVE STATE UNKNOWN** — carafe did not contact any service.\n  a person can allow this once per project: carafe live allow");
      expect(failed).toContain(`- health: ${URL_A} → unreachable at 2026-09-21 12:00 UTC (timeout)`);
      expect(failed).not.toContain("LIVE STATE UNKNOWN");
    });
  }

  test("the prompt text is exact and appears once", async () => {
    let prompt = "";
    await resolveHealthConsent({ root: workspace, workspace, urls: [URL_A, URL_B], interactive: true, reader: async () => "", write: (text) => { prompt += text; } });
    expect(prompt).toBe(`${CONSENT_INTRO}\n  GET ${URL_A}\n  GET ${URL_B}\n${CONSENT_QUESTION}`);
  });
});
