/**
 * Sealed session logs: one zstd-compressed JSONL file of CarafeEvent envelopes
 * per session. Active/append handling arrives with the daemon (task 4);
 * the backfill importer seals directly since historical sessions are closed.
 */
import { mkdirSync, readFileSync } from "fs";
import { dirname } from "path";
import { atomicWriteFileSync, compress, decompress, type CarafeStore } from "./store";
import { rehydrate, type CarafeEvent } from "./events";

export function sealSession(store: CarafeStore, tool: string, sessionId: string, events: CarafeEvent[]): void {
  const jsonl = events.map((e) => JSON.stringify(e)).join("\n");
  const raw = Buffer.from(jsonl);
  const compressed = compress(raw);
  const p = store.sessionPath(tool, sessionId);
  mkdirSync(dirname(p), { recursive: true });
  atomicWriteFileSync(p, compressed);
  store.stats.sessionsSealed++;
  store.stats.sessionBytesRaw += raw.length;
  store.stats.sessionBytesStored += compressed.length;
}

/** Read only the stored envelopes. Blob markers stay markers. This is for
 * metadata scans that can prove they do not need every large body. */
export function readSessionEnvelopes(store: CarafeStore, tool: string, sessionId: string): CarafeEvent[] {
  const text = Buffer.from(decompress(readFileSync(store.sessionPath(tool, sessionId)))).toString();
  return text.split("\n").filter(Boolean).map((line) => JSON.parse(line) as CarafeEvent);
}

/** Read a sealed session back, fully rehydrated (blobs resolved). */
export function readSession(store: CarafeStore, tool: string, sessionId: string): CarafeEvent[] {
  return readSessionEnvelopes(store, tool, sessionId).map((event) => ({ ...event, raw: rehydrate(event.raw, store) }));
}
