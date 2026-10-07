import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  EncryptedTranscriptWriter,
  decodeKey,
  decrypt,
  encodeKey,
  encryptFile,
  generateKey,
} from "./encrypted-transcript";

let testWork = "";
let tempCounter = 0;
beforeEach(() => { testWork = mkdtempSync(join(tmpdir(), "carafe-mux-")); tempCounter = 0; });
afterEach(() => { rmSync(testWork, { recursive: true, force: true }); });
function tempDir(): string {
  const dir = join(testWork, String(tempCounter++));
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("encrypted transcript", () => {
  test("compressed encrypted transcript round trips", () => {
    const path = join(tempDir(), "trace.carafe.enc");
    const key = generateKey();
    const content = "repeated terminal output\n".repeat(2_000);
    const writer = EncryptedTranscriptWriter.create(path, key.asBytes());
    writer.writeChunk(Buffer.from(content));
    writer.close();

    expect(decrypt(path, key.asBytes())).toEqual(Buffer.from(content));
    expect(statSync(path).size).toBeLessThan(content.length);
  });

  test("tampering is rejected", () => {
    const path = join(tempDir(), "trace.carafe.enc");
    const key = generateKey();
    const writer = EncryptedTranscriptWriter.create(path, key.asBytes());
    writer.writeChunk(Buffer.from("secret"));
    writer.close();
    const bytes = readFileSync(path);
    bytes[bytes.length - 1]! ^= 1;
    writeFileSync(path, bytes);

    expect(() => decrypt(path, key.asBytes())).toThrow();
  });

  test("wrong key is rejected", () => {
    const path = join(tempDir(), "trace.carafe.enc");
    const key = generateKey();
    const writer = EncryptedTranscriptWriter.create(path, key.asBytes());
    writer.writeChunk(Buffer.from("secret"));
    writer.close();

    const wrongKey = generateKey();
    expect(() => decrypt(path, wrongKey.asBytes())).toThrow();
  });

  test("truncated record is rejected", () => {
    const path = join(tempDir(), "trace.carafe.enc");
    const key = generateKey();
    const writer = EncryptedTranscriptWriter.create(path, key.asBytes());
    writer.writeChunk(Buffer.from("complete chunk"));
    writer.close();
    const bytes = readFileSync(path);
    writeFileSync(path, bytes.subarray(0, bytes.length - 3));

    expect(() => decrypt(path, key.asBytes())).toThrow();
  });

  test("key encoding round trips", () => {
    const key = generateKey();
    expect(decodeKey(encodeKey(key.asBytes()))).toEqual(key.asBytes());
    expect(() => decodeKey("short")).toThrow();
  });

  test("native archive stops at handoff byte boundary", () => {
    const dir = tempDir();
    const source = join(dir, "native.jsonl");
    const archive = join(dir, "native.carafe.enc");
    writeFileSync(source, "before-after");
    const key = generateKey();

    encryptFile(source, 6, archive, key.asBytes());

    expect(decrypt(archive, key.asBytes())).toEqual(Buffer.from("before"));
  });
});
