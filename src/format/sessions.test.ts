import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { extractBlobs, rehydrate, type CarafeEvent } from "./events";
import { readSession, readSessionEnvelopes, sealSession } from "./sessions";
import { CarafeStore, compress, decompress } from "./store";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixtureStore(): CarafeStore {
  const root = mkdtempSync(join(tmpdir(), "carafe-session-codec-"));
  roots.push(root);
  return new CarafeStore(root);
}

function legacyReadSession(store: CarafeStore, tool: string, sessionId: string): CarafeEvent[] {
  const text = Buffer.from(decompress(readFileSync(store.sessionPath(tool, sessionId)))).toString();
  return text.split("\n").filter(Boolean).map((line) => {
    const event = JSON.parse(line) as CarafeEvent;
    event.raw = rehydrate(event.raw, store);
    return event;
  });
}

describe("session decoder", () => {
  test("is deep-equal to the previous decoder for three frames including UTF-8", () => {
    const store = fixtureStore();
    const events: CarafeEvent[] = [
      { ts: "2026-01-01T00:00:00Z", tool: "codex", sessionId: "framed", seq: 0, kind: "user", raw: { payload: { message: "first" } } },
      { ts: "2026-01-01T00:00:01Z", tool: "codex", sessionId: "framed", seq: 1, kind: "assistant", raw: { payload: { message: "café العربية 日本語" } } },
      { ts: "2026-01-01T00:00:02Z", tool: "codex", sessionId: "framed", seq: 2, kind: "tool_result", raw: { payload: { output: "third" } } },
    ];
    const frames = events.map((event, index) => compress(Buffer.from(`${JSON.stringify(event)}${index < events.length - 1 ? "\n" : ""}`)));
    const path = store.sessionPath("codex", "framed");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, Buffer.concat(frames));

    expect(readSession(store, "codex", "framed")).toEqual(legacyReadSession(store, "codex", "framed"));
  });

  test("rehydrates a large batch of blob frames exactly", () => {
    const store = fixtureStore();
    const expected = Array.from({ length: 80 }, (_, seq) => ({
      ts: null, tool: "codex", sessionId: "blobs", seq, kind: "tool_result",
      raw: { payload: { output: `${seq}: café ${"x".repeat(4_200 + seq)}` } },
    })) satisfies CarafeEvent[];
    const stored = expected.map((event) => ({ ...event, raw: extractBlobs(event.raw, store) }));
    sealSession(store, "codex", "blobs", stored);

    expect(readSession(store, "codex", "blobs")).toEqual(expected);
    expect(readSessionEnvelopes(store, "codex", "blobs")[0]!.raw).not.toEqual(expected[0]!.raw);
  });
});
