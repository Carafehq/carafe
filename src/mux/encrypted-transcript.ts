/**
 * Encrypted live-mux transcripts. Append-only archive format shared with the
 * original archive implementation: `CARAFE01` magic, then per chunk an 8-byte
 * big-endian sequence (also the AAD), 4-byte big-endian ciphertext length,
 * 24-byte nonce, and the XChaCha20-Poly1305 ciphertext of the zlib-compressed
 * plaintext. The key is random per parent session, inherited by managed
 * children via CARAFE_EPHEMERAL_KEY, and never written to disk — archives
 * become unreadable after the parent and its children exit.
 */
import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { closeSync, openSync, readSync, writeSync } from "fs";
import { deflateSync, inflateSync } from "zlib";

const MAGIC = Buffer.from("CARAFE01");
const NONCE_BYTES = 24;
const MAX_CIPHERTEXT_BYTES = 1024 * 1024;
const MAX_PLAINTEXT_CHUNK_BYTES = 1024 * 1024;
export const KEY_ENV = "CARAFE_EPHEMERAL_KEY";

/**
 * Random per-parent-session key. JavaScript cannot guarantee that copies are
 * scrubbed from memory, but `zeroize` gives the same best-effort erasure the
 * Rust implementation performs on drop.
 */
export class EphemeralKey {
  constructor(private readonly key: Uint8Array) {}

  asBytes(): Uint8Array {
    return this.key;
  }

  zeroize(): void {
    this.key.fill(0);
  }
}

export function generateKey(): EphemeralKey {
  const key = new Uint8Array(32);
  crypto.getRandomValues(key);
  return new EphemeralKey(key);
}

export function encodeKey(key: Uint8Array): string {
  return Buffer.from(key).toString("hex");
}

export function decodeKey(value: string): Uint8Array {
  if (value.length !== 64) {
    throw new Error("invalid ephemeral key length");
  }
  if (!/^[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error("invalid ephemeral key encoding");
  }
  return Uint8Array.from(Buffer.from(value, "hex"));
}

export class EncryptedTranscriptWriter {
  private sequence = 0n;

  private constructor(
    private readonly fd: number,
    private readonly key: Uint8Array,
  ) {}

  static create(path: string, key: Uint8Array): EncryptedTranscriptWriter {
    let fd: number;
    try {
      fd = openSync(path, "w");
    } catch (error) {
      throw new Error(
        `create encrypted transcript ${path}: ${error instanceof Error ? error.message : error}`,
      );
    }
    writeSync(fd, MAGIC);
    // The cipher key is copied so later zeroize calls cannot corrupt writes.
    return new EncryptedTranscriptWriter(fd, Uint8Array.from(key));
  }

  writeChunk(plaintext: Uint8Array): void {
    const compressed = deflateSync(plaintext);
    const nonce = new Uint8Array(NONCE_BYTES);
    crypto.getRandomValues(nonce);
    const aad = Buffer.alloc(8);
    aad.writeBigUInt64BE(this.sequence);
    const ciphertext = xchacha20poly1305(this.key, nonce, aad).encrypt(compressed);
    if (ciphertext.length > 0xffff_ffff) {
      throw new Error("encrypted chunk too large");
    }
    const length = Buffer.alloc(4);
    length.writeUInt32BE(ciphertext.length);
    writeSync(this.fd, aad);
    writeSync(this.fd, length);
    writeSync(this.fd, nonce);
    writeSync(this.fd, ciphertext);
    this.sequence += 1n;
  }

  close(): void {
    closeSync(this.fd);
    this.key.fill(0);
  }
}

/** Encrypts exactly `sourceBytes` of `source`, the handoff byte boundary. */
export function encryptFile(
  source: string,
  sourceBytes: number,
  destination: string,
  key: Uint8Array,
): void {
  let fd: number;
  try {
    fd = openSync(source, "r");
  } catch (error) {
    throw new Error(
      `open native trace ${source}: ${error instanceof Error ? error.message : error}`,
    );
  }
  const writer = EncryptedTranscriptWriter.create(destination, key);
  try {
    const buffer = Buffer.alloc(64 * 1024);
    let remaining = sourceBytes;
    while (remaining > 0) {
      const read = readSync(fd, buffer, 0, Math.min(buffer.length, remaining), null);
      if (read === 0) break;
      writer.writeChunk(buffer.subarray(0, read));
      remaining -= read;
    }
  } finally {
    closeSync(fd);
    writer.close();
  }
}

function readExact(fd: number, target: Buffer, offset: number, length: number): void {
  let done = 0;
  while (done < length) {
    const read = readSync(fd, target, offset + done, length - done, null);
    if (read === 0) {
      throw new Error("encrypted transcript is truncated");
    }
    done += read;
  }
}

export function decryptToWriter(
  path: string,
  key: Uint8Array,
  output: (chunk: Buffer) => void,
): void {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch (error) {
    throw new Error(
      `open encrypted transcript ${path}: ${error instanceof Error ? error.message : error}`,
    );
  }
  try {
    const magic = Buffer.alloc(MAGIC.length);
    readExact(fd, magic, 0, magic.length);
    if (!magic.equals(MAGIC)) {
      throw new Error("not a supported Carafe encrypted transcript");
    }
    let expectedSequence = 0n;
    const header = Buffer.alloc(8 + 4 + NONCE_BYTES);
    for (;;) {
      // A clean end of archive is only valid on a chunk boundary.
      if (readSync(fd, header, 0, 1, null) === 0) break;
      readExact(fd, header, 1, header.length - 1);
      const aad = header.subarray(0, 8);
      if (aad.readBigUInt64BE() !== expectedSequence) {
        throw new Error("transcript chunk sequence is invalid");
      }
      const length = header.readUInt32BE(8);
      if (length > MAX_CIPHERTEXT_BYTES) {
        throw new Error("encrypted transcript chunk is too large");
      }
      const nonce = header.subarray(12);
      const ciphertext = Buffer.alloc(length);
      readExact(fd, ciphertext, 0, length);
      let compressed: Uint8Array;
      try {
        compressed = xchacha20poly1305(key, nonce, aad).decrypt(ciphertext);
      } catch {
        throw new Error("transcript authentication failed");
      }
      let decoded: Buffer;
      try {
        decoded = inflateSync(compressed, {
          maxOutputLength: MAX_PLAINTEXT_CHUNK_BYTES,
        });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ERR_BUFFER_TOO_LARGE") {
          throw new Error("decompressed transcript chunk is too large");
        }
        throw error;
      }
      output(decoded);
      expectedSequence += 1n;
    }
  } finally {
    closeSync(fd);
  }
}

export function decrypt(path: string, key: Uint8Array): Buffer {
  const chunks: Buffer[] = [];
  decryptToWriter(path, key, (chunk) => chunks.push(chunk));
  return Buffer.concat(chunks);
}

export function readToStdout(path: string): void {
  const encoded = process.env[KEY_ENV];
  if (encoded === undefined) {
    throw new Error(
      "ephemeral handoff key is unavailable; run this command inside the active Carafe-managed agent",
    );
  }
  const key = decodeKey(encoded);
  try {
    decryptToWriter(path, key, (chunk) => writeSync(1, chunk));
  } finally {
    key.fill(0);
  }
}
