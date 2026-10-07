import { createHash } from "crypto";
import { readFileSync } from "fs";

export const CHUNK_THRESHOLD = envBytes("CARAFE_CHUNK_THRESHOLD", 90 * 1024 * 1024);
export const CHUNK_PART_BYTES = envBytes("CARAFE_CHUNK_PART_BYTES", 64 * 1024 * 1024);

const gzipSync = (Bun as any).gzipSync as (d: Uint8Array) => Uint8Array;
const gunzipSync = (Bun as any).gunzipSync as (d: Uint8Array) => Uint8Array;

function envBytes(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

export function chunkThreshold(): number {
  return envBytes("CARAFE_CHUNK_THRESHOLD", CHUNK_THRESHOLD);
}

export function chunkPartBytes(): number {
  return envBytes("CARAFE_CHUNK_PART_BYTES", CHUNK_PART_BYTES);
}

export interface LargeFileDescriptor {
  carafeChunked: 1;
  path: string;
  originalBytes: number;
  sha256: string;
  codec: "gzip";
  partCount: number;
  mode?: number;
}

export function sha256Buffer(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

export function packLargeFile(absPath: string, snapshotPath = absPath, mode?: number): { descriptor: LargeFileDescriptor; parts: Buffer[] } {
  const original = readFileSync(absPath);
  const threshold = chunkThreshold();
  const packed = Buffer.from(gzipSync(original));
  const partSize = chunkPartBytes();
  const parts: Buffer[] = [];
  if (packed.length < threshold) {
    parts.push(packed);
  } else {
    for (let off = 0; off < packed.length; off += partSize) parts.push(packed.subarray(off, off + partSize));
  }
  return {
    descriptor: {
      carafeChunked: 1,
      path: snapshotPath,
      originalBytes: original.length,
      sha256: sha256Buffer(original),
      codec: "gzip",
      partCount: parts.length,
      ...(mode === undefined ? {} : { mode }),
    },
    parts,
  };
}

export function unpackLargeFile(descriptor: LargeFileDescriptor, parts: Buffer[]): Buffer {
  if (descriptor.carafeChunked !== 1 || descriptor.codec !== "gzip") throw new Error("unsupported carafe large-file descriptor");
  if (parts.length !== descriptor.partCount) throw new Error(`packed file ${descriptor.path} expected ${descriptor.partCount} parts, got ${parts.length}`);
  const original = Buffer.from(gunzipSync(Buffer.concat(parts)));
  if (original.length !== descriptor.originalBytes) throw new Error(`packed file ${descriptor.path} size mismatch`);
  const got = sha256Buffer(original);
  if (got !== descriptor.sha256) throw new Error(`packed file ${descriptor.path} sha256 mismatch`);
  return original;
}

export function descriptorPath(path: string): string {
  return `${path}.carafe-large.json`;
}

export function partsDir(path: string): string {
  return `${path}.carafe-large`;
}

export function partPath(path: string, i: number): string {
  return `${partsDir(path)}/part-${String(i).padStart(3, "0")}`;
}
