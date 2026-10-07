import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { SessionDistillate } from "../format/distillate";
import { extractBlobs, type CarafeEvent } from "../format/events";
import { sealSession } from "../format/sessions";
import { CarafeStore } from "../format/store";
import { backfillTitles } from "./reindex-titles";

let workspace = "";
let oldCodexRoot: string | undefined;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "carafe-title-fast-"));
  oldCodexRoot = process.env.CARAFE_CODEX_ROOT;
  process.env.CARAFE_CODEX_ROOT = join(workspace, "codex");
  mkdirSync(process.env.CARAFE_CODEX_ROOT, { recursive: true });
});

afterEach(() => {
  if (oldCodexRoot === undefined) delete process.env.CARAFE_CODEX_ROOT;
  else process.env.CARAFE_CODEX_ROOT = oldCodexRoot;
  rmSync(workspace, { recursive: true, force: true });
});

function seed(opts: { completeMetadata: boolean }): { store: CarafeStore; id: string } {
  const store = new CarafeStore(join(workspace, "store"));
  const id = opts.completeMetadata ? "protected-fast" : "protected-fallback";
  mkdirSync(join(store.root, "distillate", "claude-code"), { recursive: true });
  const activityRaw = extractBlobs({
    type: "assistant", timestamp: "2026-09-20T10:00:01Z",
    message: { content: "useful prose ".repeat(500) },
  }, store);
  const events: CarafeEvent[] = [
    { ts: "2026-09-20T10:00:01Z", tool: "claude-code", sessionId: id, seq: 0, kind: "assistant", raw: activityRaw },
    { ts: "2026-09-20T10:00:02Z", tool: "claude-code", sessionId: id, seq: 1, kind: "user", raw: {
      type: "user", timestamp: "2026-09-20T10:00:02Z",
      message: { content: [{ type: "tool_result", content: { $carafeBlob: "missing-on-purpose", $len: 9000 } }] },
    } },
  ];
  sealSession(store, "claude-code", id, events);
  const d: SessionDistillate = {
    tool: "claude-code", sessionId: id, sourcePath: id, title: "Protected title",
    cwd: null, gitBranch: null, startTs: events[0]!.ts, endTs: events[1]!.ts,
    ...(opts.completeMetadata ? { internal: false, hasUserText: true } : {}),
    eventCount: events.length, toolUseCount: 0, sidechain: false, rawBytes: 0, version: 1,
  };
  writeFileSync(store.distillatePath(d.tool, d.sessionId), JSON.stringify(d));
  return { store, id };
}

test("protected complete records derive recency without hydrating unrelated blobs", () => {
  const { store, id } = seed({ completeMetadata: true });
  const result = backfillTitles(store, { apply: true });
  expect(result.applied).toBe(1);
  expect(result.failed).toBe(0);
  const after = JSON.parse(readFileSync(store.distillatePath("claude-code", id), "utf8")) as SessionDistillate;
  expect(after.title).toBe("Protected title");
  expect(after.titleSource).toBe("cc-title");
  expect(after.lastActivityTs).toBe("2026-09-20T10:00:01Z");
});

test("incomplete protected records retain the correctness-first full read", () => {
  const { store, id } = seed({ completeMetadata: false });
  const result = backfillTitles(store, { apply: true });
  expect(result.applied).toBe(0);
  expect(result.failed).toBe(1);
  expect(result.unreadable).toEqual([`claude-code/${id}`]);
});
