import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { ADAPTERS } from "../adapters/registry";
import { CarafeStore } from "../format/store";
import { writeDistillate, type SessionDistillate } from "../format/distillate";
import { handoffSources } from "./list";

const original = process.env.CARAFE_HOME;
let root: string | undefined;
afterEach(() => {
  if (original === undefined) delete process.env.CARAFE_HOME; else process.env.CARAFE_HOME = original;
  if (root) rmSync(root, { recursive: true, force: true });
});

test("capture registry supplies empty sources and per-source recent session limits", () => {
  root = mkdtempSync(join(tmpdir(), "carafe-sources-"));
  process.env.CARAFE_HOME = root;
  const store = new CarafeStore(root);
  ADAPTERS.push({ tool: "future-tool", name: "Future Tool", discover: () => [], parseFile: () => { throw new Error("not called"); } });
  try {
    expect(handoffSources().map(({ tool, name, sessions }) => [tool, name, sessions.length]))
      .toEqual([["claude-code", "Claude Code", 0], ["codex", "Codex", 0], ["future-tool", "Future Tool", 0]]);
    for (const [id, tool, date] of [["older", "codex", "28"], ["newer", "codex", "29"], ["future", "future-tool", "27"]]) {
      const d: SessionDistillate = {
        tool: tool!, sessionId: id!, sourcePath: "/synthetic/session", title: id!, cwd: null, gitBranch: null,
        startTs: null, endTs: `2026-09-${date}T12:00:00Z`, lastActivityTs: `2026-09-${date}T12:00:00Z`,
        hasUserText: true, eventCount: 2, toolUseCount: 0, sidechain: false, rawBytes: 0, version: 1,
      };
      writeDistillate(store, d);
    }
    expect(handoffSources({ limit: 1, interactive: true }).map((s) => s.sessions.map((row) => row.id)))
      .toEqual([[], ["newer"], ["future"]]);
  } finally { ADAPTERS.pop(); }
});
