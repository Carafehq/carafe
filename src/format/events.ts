/**
 * Normalized event envelope + CAS blob extraction.
 *
 * Envelope keeps the ORIGINAL event under `raw` (semantic normalization across
 * tools is Approach B, deferred) — but any string field >= BLOB_THRESHOLD is
 * extracted into the CAS and replaced with a {"$carafeBlob", "$len"} marker.
 * File re-reads, base64 images, and repeated tool outputs dedup this way.
 */
import type { CarafeStore } from "./store";

export const BLOB_THRESHOLD = 4096;

export interface CarafeEvent {
  ts: string | null;
  tool: string;
  sessionId: string;
  seq: number;
  kind: string;       // user | assistant | tool_use | tool_result | reasoning | meta | system | ...
  sidechain?: boolean;
  raw: unknown;       // original event, blob-extracted
}

export interface BlobMarker { $carafeBlob: string; $len: number }
export const isBlobMarker = (v: unknown): v is BlobMarker =>
  !!v && typeof v === "object" && typeof (v as any).$carafeBlob === "string";

/** Recursively replace large strings with CAS markers. Returns a transformed copy. */
export function extractBlobs(value: unknown, store: CarafeStore): unknown {
  if (typeof value === "string") {
    if (Buffer.byteLength(value) >= BLOB_THRESHOLD) {
      return { $carafeBlob: store.putBlob(value), $len: value.length } satisfies BlobMarker;
    }
    return value;
  }
  if (Array.isArray(value)) return value.map((v) => extractBlobs(v, store));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = extractBlobs(v, store);
    return out;
  }
  return value;
}

/** Inverse of extractBlobs — rehydrates markers back into full strings. */
export function rehydrate(value: unknown, store: CarafeStore): unknown {
  if (isBlobMarker(value)) return store.getBlob(value.$carafeBlob);
  if (Array.isArray(value)) return value.map((v) => rehydrate(v, store));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = rehydrate(v, store);
    return out;
  }
  return value;
}
