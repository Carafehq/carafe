import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { CarafeStore } from "../format/store";
import { writeDistillate, type SessionDistillate } from "../format/distillate";
import { sealSession } from "../format/sessions";
import type { CarafeEvent } from "../format/events";
import { renderHandoff } from "./render";
import { runHandoff } from "./handoff";

const now = "2026-09-29T12:00:00Z";
const id = "synthetic-handoff";
const event = (seq: number, message: string): CarafeEvent => ({
  ts: now, tool: "codex", sessionId: id, seq, kind: "user",
  raw: { type: "event_msg", payload: { type: "user_message", message } },
});
const meta = (events: CarafeEvent[]): SessionDistillate => ({
  tool: "codex", sessionId: id, sourcePath: "/synthetic/session.jsonl", title: "Parser repair",
  cwd: null, gitBranch: null, startTs: now, endTs: now, eventCount: events.length,
  toolUseCount: 0, sidechain: false, rawBytes: 0, version: 1,
});
let root: string | undefined;
afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); root = undefined; });

for (const tool of ["codex", "claude-code"]) for (const layered of [false, true]) test(`${tool} ${layered ? "layered" : "full"} Markdown is independent of recipient and keeps inline work`, () => {
  const events = [event(0, "Fix the parser and preserve empty fields."),
    ...(layered ? Array.from({ length: 210 }, (_, i) => event(i + 1, `History ${i}: ${"x".repeat(1000)}`)) : []),
    event(220, "Next: verify trailing empty fields in the parser.")];
  if (tool === "claude-code") for (const e of events) {
    e.tool = tool;
    e.raw = { type: "user", message: { role: "user", content: (e.raw as any).payload.message } };
  }
  const d = { ...meta(events), tool };
  const baseline = renderHandoff(d, events, { now });
  expect(baseline.tier).toBe(layered ? "layered" : "full");
  for (const target of ["codex", "claude-code", "cursor", "devin", "Custom Tool", "label@example.com"])
    expect(renderHandoff(d, events, { now, target }).text).toBe(baseline.text);
  const body = baseline.text.split("\n").filter((line) => !line.startsWith("- session:")).join("\n");
  expect(body).not.toMatch(/codex|claude.code|cursor|devin/i);
  expect(body).toContain("if carafe is installed");
  expect(body).toContain("All carafe commands and seq pointers below are optional");
  expect(body).toContain("Next: verify trailing empty fields");
});

test("--to is an arbitrary display label and leaves the written file byte-identical", async () => {
  root = mkdtempSync(join(tmpdir(), "carafe-any-tool-"));
  const store = new CarafeStore(root);
  const events = [event(0, "Fix the parser.")];
  sealSession(store, "codex", id, events);
  writeDistillate(store, meta(events));
  const logs: string[] = [];
  const original = console.log;
  console.log = (...args) => { logs.push(args.join(" ")); };
  try {
    let baseline: string | undefined;
    for (const to of [undefined, "cursor", "devin", "Custom Tool", "label@example.com"]) {
      logs.length = 0;
      await runHandoff(id, { store, to, now, noArm: true, noLive: true, interactive: false });
      const file = join(root, "handoffs", `${id}.md`);
      const text = readFileSync(file, "utf8");
      baseline ??= text;
      expect(text).toBe(baseline);
      expect(logs.join("\n")).toContain(`handoff ready → ${to ?? "any agent"}`);
      expect(logs.join("\n")).toContain(`Read ${file} and continue the work`);
      expect(logs.join("\n")).not.toContain("to continue in");
    }
  } finally { console.log = original; }
});
