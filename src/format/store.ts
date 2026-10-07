/**
 * CarafeStore — the local three-layer store under ~/.carafe/ (or $CARAFE_HOME).
 *
 * Layout:
 *   blobs/<h2>/<sha256><ext>        content-addressed store, zstd-compressed
 *   sessions/<tool>/<id>.jsonl<ext> sealed event logs (blob-extracted envelopes)
 *   distillate/<tool>/<id>.json     session summaries — the ONLY indexed layer
 *   state/import-manifest.json      source file -> {size, mtime} for incremental runs
 *   config.json
 */
import { createHash, randomUUID } from "crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "fs";
import { join } from "path";

const zstdC = (Bun as any).zstdCompressSync as (d: Uint8Array, o?: { level?: number }) => Uint8Array;
const zstdD = (Bun as any).zstdDecompressSync as (d: Uint8Array) => Uint8Array;

export const COMPRESS_EXT = ".zst";
export const compress = (buf: Uint8Array): Uint8Array => zstdC(buf, { level: 9 });
export const decompress = (buf: Uint8Array): Uint8Array => zstdD(buf);
export const sha256 = (s: string | Uint8Array): string => createHash("sha256").update(s).digest("hex");

export function atomicWriteFileSync(path: string, data: string | Uint8Array): void {
  const tempPath = `${path}.tmp.${process.pid}.${randomUUID()}`;
  try {
    writeFileSync(tempPath, data);
    renameSync(tempPath, path);
  } finally {
    try { unlinkSync(tempPath); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

export interface StoreStats {
  blobsPut: number;
  blobDedupHits: number;
  blobBytesSeen: number;      // raw bytes offered to the CAS
  blobBytesDeduped: number;   // raw bytes we did NOT store again
  blobBytesStored: number;    // compressed bytes on disk
  sessionsSealed: number;
  sessionBytesRaw: number;    // JSONL bytes before compression
  sessionBytesStored: number; // compressed bytes on disk
}

export class CarafeStore {
  readonly root: string;
  readonly stats: StoreStats = {
    blobsPut: 0, blobDedupHits: 0, blobBytesSeen: 0, blobBytesDeduped: 0,
    blobBytesStored: 0, sessionsSealed: 0, sessionBytesRaw: 0, sessionBytesStored: 0,
  };
  private known = new Set<string>();

  constructor(root?: string, opts: { readOnly?: boolean } = {}) {
    this.root = root ?? process.env.CARAFE_HOME ?? join(process.env.HOME!, ".carafe");
    if (opts.readOnly) return;
    for (const d of ["blobs", "sessions", "distillate", "state"]) mkdirSync(join(this.root, d), { recursive: true });
    const cfg = join(this.root, "config.json");
    if (!existsSync(cfg)) writeFileSync(cfg, JSON.stringify({ version: 1, created: new Date().toISOString() }, null, 2));
  }

  private blobPath(hash: string): string {
    return join(this.root, "blobs", hash.slice(0, 2), hash + COMPRESS_EXT);
  }

  /** Store a string in the CAS. Returns its hash. Dedup by content. */
  putBlob(content: string): string {
    const hash = sha256(content);
    const raw = Buffer.byteLength(content);
    this.stats.blobBytesSeen += raw;
    if (this.known.has(hash)) {
      this.stats.blobDedupHits++; this.stats.blobBytesDeduped += raw;
      return hash;
    }
    const p = this.blobPath(hash);
    if (existsSync(p)) {
      this.known.add(hash);
      this.stats.blobDedupHits++; this.stats.blobBytesDeduped += raw;
      return hash;
    }
    mkdirSync(join(this.root, "blobs", hash.slice(0, 2)), { recursive: true });
    const compressed = compress(Buffer.from(content));
    writeFileSync(p, compressed);
    this.known.add(hash);
    this.stats.blobsPut++; this.stats.blobBytesStored += compressed.length;
    return hash;
  }

  getBlob(hash: string): string {
    return Buffer.from(decompress(readFileSync(this.blobPath(hash)))).toString();
  }

  sessionPath(tool: string, sessionId: string): string {
    return join(this.root, "sessions", tool, sessionId + ".jsonl" + COMPRESS_EXT);
  }

  distillatePath(tool: string, sessionId: string): string {
    return join(this.root, "distillate", tool, sessionId + ".json");
  }

  // ---- import manifest (incremental re-runs) ----
  private manifestPath(): string { return join(this.root, "state", "import-manifest.json"); }
  loadManifest(): Record<string, { size: number; mtimeMs: number }> {
    try { return JSON.parse(readFileSync(this.manifestPath(), "utf8")); } catch { return {}; }
  }
  saveManifest(m: Record<string, { size: number; mtimeMs: number }>): void {
    atomicWriteFileSync(this.manifestPath(), JSON.stringify(m));
  }

  // ---- session-id ownership (collision-proof storage keys, stable across runs) ----
  private sourcesPath(): string { return join(this.root, "state", "session-sources.json"); }
  loadSessionSources(): Record<string, string> {
    try { return JSON.parse(readFileSync(this.sourcesPath(), "utf8")); } catch { return {}; }
  }
  saveSessionSources(m: Record<string, string>): void {
    atomicWriteFileSync(this.sourcesPath(), JSON.stringify(m));
  }
  /**
   * Resolve a unique storage id for (tool, stem, path). Clean stem for the 95%;
   * short path-hash suffix only when a *different* source already owns the stem.
   */
  resolveStorageId(sources: Record<string, string>, tool: string, stem: string, path: string): string {
    const owner = sources[`${tool}/${stem}`];
    if (!owner || owner === path) { sources[`${tool}/${stem}`] = path; return stem; }
    const id = `${stem}-${sha256(path).slice(0, 6)}`;
    sources[`${tool}/${id}`] = path;
    return id;
  }
}
