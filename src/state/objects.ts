/**
 * Snapshot object store — content-addressed bodies for worktree snapshots.
 *
 *   state/objects/<h2>/<sha256>.zst
 *
 * Deliberately SEPARATE from blobs/: blobs/ is referenced from sealed session
 * logs, which a garbage collector cannot cheaply mark, so blobs/ can never be
 * swept. state/objects/ is referenced only by snapshot manifests, so a
 * mark-and-sweep over those manifests is complete — every object not named by a
 * manifest is genuinely unreachable.
 */
import { createHash } from "crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, statSync } from "fs";
import { join, resolve } from "path";
import { COMPRESS_EXT, atomicWriteFileSync, compress, decompress } from "../format/store";

export type StoreLike = { root: string } | string;

const HASH_RE = /^[0-9a-f]{64}$/;
const READ_CHUNK = 4 * 1024 * 1024;
/** Files up to this size are hashed with one read; larger ones stream. */
const SLURP_MAX = 8 * 1024 * 1024;

export function storeRoot(store: StoreLike): string {
  return typeof store === "string" ? store : store.root;
}

/** A checkpoint dir is always <root>/state/<tool>/<sessionId>/<key>. */
export function storeRootFromCheckpointDir(dir: string): string {
  return resolve(dir, "..", "..", "..", "..");
}

export function objectsRoot(store: StoreLike): string {
  return join(storeRoot(store), "state", "objects");
}

export function objectPath(store: StoreLike, hash: string): string {
  return join(objectsRoot(store), hash.slice(0, 2), hash + COMPRESS_EXT);
}

export function hasObject(store: StoreLike, hash: string): boolean {
  return existsSync(objectPath(store, hash));
}

export function hashBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Streaming sha256 — a 90MB file must not need 90MB of heap to be identified. */
export function hashFile(abs: string, size?: number): string {
  const bytes = size ?? statSync(abs).size;
  if (bytes <= SLURP_MAX) return hashBytes(readFileSync(abs));
  const h = createHash("sha256");
  const fd = openSync(abs, "r");
  try {
    const buf = Buffer.allocUnsafe(READ_CHUNK);
    for (;;) {
      const n = readSync(fd, buf, 0, READ_CHUNK, null);
      if (n <= 0) break;
      h.update(buf.subarray(0, n));
    }
  } finally {
    closeSync(fd);
  }
  return h.digest("hex");
}

/** Store bytes; dedupe by existence. Returns the content hash. */
export function putObject(store: StoreLike, bytes: Uint8Array): string {
  const hash = hashBytes(bytes);
  const p = objectPath(store, hash);
  if (existsSync(p)) return hash;
  mkdirSync(join(objectsRoot(store), hash.slice(0, 2)), { recursive: true });
  atomicWriteFileSync(p, compress(bytes));
  return hash;
}

export function readObject(store: StoreLike, hash: string): Buffer {
  return Buffer.from(decompress(readFileSync(objectPath(store, hash))));
}

/** Every object on disk with its real (compressed) size. */
export function listObjects(store: StoreLike): Map<string, number> {
  const out = new Map<string, number>();
  const root = objectsRoot(store);
  let shards: string[];
  try { shards = readdirSync(root); } catch { return out; }
  for (const shard of shards) {
    if (!/^[0-9a-f]{2}$/.test(shard)) continue;
    let names: string[];
    try { names = readdirSync(join(root, shard)); } catch { continue; }
    for (const name of names) {
      if (!name.endsWith(COMPRESS_EXT)) continue;
      const hash = name.slice(0, -COMPRESS_EXT.length);
      if (!HASH_RE.test(hash)) continue;
      try { out.set(hash, statSync(join(root, shard, name)).size); } catch { /* raced away */ }
    }
  }
  return out;
}
