import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { decrypt, generateKey } from "./encrypted-transcript";
import { newParentSession, type HandoffStorage } from "./model";
import {
  BoundedOutput,
  DeferredInject,
  HANDOFF_BYTES,
  OUTPUT_BUFFER_BYTES,
  OUTPUT_QUEUE_BYTES,
  captureOutputChunk,
  containsInterrupt,
  forwardOutput,
  injectPrompt,
  renderPtyHandoff,
  stripAnsi,
  tokenizeInput,
  type CaptureState,
  type DisplaySink,
} from "./mux";

let testWork = "";
let tempCounter = 0;
beforeEach(() => { testWork = mkdtempSync(join(tmpdir(), "carafe-mux-")); tempCounter = 0; });
afterEach(() => { rmSync(testWork, { recursive: true, force: true }); });

function tempDir(): string {
  const dir = join(testWork, String(tempCounter++));
  mkdirSync(dir, { recursive: true });
  return dir;
}

function parent(storage: HandoffStorage) {
  return newParentSession("/workspace/carafe", "claude", storage);
}

function emptyState(): CaptureState {
  return { output: new BoundedOutput(), log: null, diskTranscript: null };
}

describe("mux", () => {
  test("removes terminal colours", () => {
    expect(stripAnsi("a\x1b[31mred\x1b[0m\r\n")).toBe("ared\n");
  });

  test("output buffer is bounded and keeps tail", () => {
    const output = new BoundedOutput();
    output.push(Buffer.alloc(OUTPUT_BUFFER_BYTES, "a"));
    output.push(Buffer.from("tail"));
    expect(output.len()).toBe(OUTPUT_BUFFER_BYTES);
    expect(output.tail(4)).toEqual(Buffer.from("tail"));
  });

  test("oversized output chunk is bounded to its tail", () => {
    const output = new BoundedOutput();
    const chunk = Buffer.alloc(OUTPUT_BUFFER_BYTES + 17, "x");
    chunk.write("tail", OUTPUT_BUFFER_BYTES + 13);

    output.push(chunk);

    expect(output.len()).toBe(OUTPUT_BUFFER_BYTES);
    expect(output.tail(4)).toEqual(Buffer.from("tail"));
  });

  test("renders cross-agent handoff with clean terminal text", () => {
    const session = parent("memory");
    const childId = session.active_child;

    const rendered = renderPtyHandoff(
      session,
      childId,
      "claude",
      "codex",
      Buffer.from("working\r\n\x1b[31mdone\x1b[0m\r\n"),
    );

    expect(rendered).toContain("# Live handoff: Claude Code → Codex");
    expect(rendered).toContain(`- parent: ${session.id}`);
    expect(rendered).toContain(`- child: ${childId}`);
    expect(rendered).toContain("- cwd: /workspace/carafe");
    expect(rendered.endsWith("working\ndone\n\n")).toBeTrue();
    expect(rendered).not.toContain("\x1b[31m");
    expect(rendered).not.toContain("\r");
  });

  test("memory capture below limit does not create a disk backend", () => {
    const path = join(tempDir(), "transcript.log");
    const state = emptyState();
    const key = generateKey();

    const spill = captureOutputChunk(state, path, Buffer.from("small handoff"), key.asBytes());

    expect(spill).toBeNull();
    expect(state.log).toBeNull();
    expect(state.diskTranscript).toBeNull();
    expect(existsSync(path)).toBeFalse();
    expect(state.output.tail(32)).toEqual(Buffer.from("small handoff"));
  });

  test("crossing memory limit spills complete trace to disk", () => {
    const path = join(tempDir(), "transcript.log");
    const state = emptyState();
    const first = Buffer.alloc(HANDOFF_BYTES - 2, "a");
    const key = generateKey();

    captureOutputChunk(state, path, first, key.asBytes());
    const spill = captureOutputChunk(state, path, Buffer.from("TAIL"), key.asBytes());
    state.log!.close();

    expect(spill).toBe(path);
    expect(state.diskTranscript).toBe(path);
    const persisted = decrypt(path, key.asBytes());
    expect(persisted.length).toBe(first.length + 4);
    expect(persisted.subarray(0, first.length)).toEqual(first);
    expect(persisted.subarray(first.length)).toEqual(Buffer.from("TAIL"));
  });

  test("disk backend continues without truncating after spill", () => {
    const path = join(tempDir(), "transcript.log");
    const state = emptyState();
    const first = Buffer.alloc(HANDOFF_BYTES, "a");
    const key = generateKey();

    captureOutputChunk(state, path, first, key.asBytes());
    captureOutputChunk(state, path, Buffer.from("spill"), key.asBytes());
    captureOutputChunk(state, path, Buffer.from("-continued"), key.asBytes());
    state.log!.close();

    const persisted = decrypt(path, key.asBytes());
    expect(persisted.length).toBe(first.length + "spill-continued".length);
    expect(persisted.subarray(persisted.length - 15)).toEqual(Buffer.from("spill-continued"));
  });

  test("failed disk fallback keeps crossing chunk in bounded memory", () => {
    const path = join(tempDir(), "missing", "transcript.log");
    const state = emptyState();
    const first = Buffer.alloc(HANDOFF_BYTES, "a");
    const key = generateKey();

    captureOutputChunk(state, path, first, key.asBytes());
    expect(() =>
      captureOutputChunk(state, path, Buffer.from("not-lost"), key.asBytes()),
    ).toThrow();

    expect(state.log).toBeNull();
    expect(state.diskTranscript).toBeNull();
    expect(state.output.tail(8)).toEqual(Buffer.from("not-lost"));
  });

  test("direct prompt injection uses one bracketed paste submission", () => {
    let output = "";

    injectPrompt({ write: (data) => (output += data) }, "line one\nline two");

    expect(output).toBe("\x1b[200~line one\nline two\x1b[201~\r");
    expect([...output].filter((c) => c === "\r")).toHaveLength(1);
  });

  test("full display sink drops display copy without blocking", () => {
    const written: Buffer[] = [];
    const sink: DisplaySink = {
      destroyed: false,
      writableLength: 0,
      write: (chunk) => written.push(chunk),
    };

    expect(forwardOutput(sink, Buffer.from("first"))).toBeTrue();
    sink.writableLength = OUTPUT_QUEUE_BYTES;
    expect(forwardOutput(sink, Buffer.from("dropped-display-copy"))).toBeTrue();

    expect(written).toEqual([Buffer.from("first")]);
  });

  test("destroyed display sink stops reader forwarding", () => {
    const sink: DisplaySink = {
      destroyed: true,
      writableLength: 0,
      write: () => {
        throw new Error("must not write to a destroyed sink");
      },
    };

    expect(forwardOutput(sink, Buffer.from("output"))).toBeFalse();
  });

  test("control bytes are intercepted and text passes through", () => {
    const tokens = tokenizeInput(Buffer.from("ab\x07cd\x11"));

    expect(tokens).toEqual([
      { kind: "bytes", bytes: Buffer.from("ab") },
      { kind: "action", action: "switch" },
      { kind: "bytes", bytes: Buffer.from("cd") },
      { kind: "action", action: "quit" },
    ]);
  });

  test("enter passes through while csi-u ctrl-m opens the map", () => {
    expect(tokenizeInput(Buffer.from("\r"))).toEqual([
      { kind: "bytes", bytes: Buffer.from("\r") },
    ]);
    expect(tokenizeInput(Buffer.from("\x1b[109;5u"))).toEqual([
      { kind: "action", action: "map" },
    ]);
    // Unmodified CSI-u sequences are forwarded untouched.
    expect(tokenizeInput(Buffer.from("\x1b[109;1u"))).toEqual([
      { kind: "bytes", bytes: Buffer.from("\x1b[109;1u") },
    ]);
  });

  test("kitty event-type reports control carafe bindings", () => {
    // press and repeat act
    expect(tokenizeInput(Buffer.from("\x1b[113;5:1u"))).toEqual([
      { kind: "action", action: "quit" },
    ]);
    expect(tokenizeInput(Buffer.from("\x1b[113;5:2u"))).toEqual([
      { kind: "action", action: "quit" },
    ]);
    // release is swallowed, never forwarded to the child
    expect(tokenizeInput(Buffer.from("\x1b[113;5:3u"))).toEqual([]);
    // alternate key codes before the modifier are tolerated
    expect(tokenizeInput(Buffer.from("\x1b[103:71;5u"))).toEqual([
      { kind: "action", action: "switch" },
    ]);
  });

  test("detects interrupt in legacy and kitty encodings", () => {
    expect(containsInterrupt(Buffer.from("\x03"))).toBeTrue();
    expect(containsInterrupt(Buffer.from("\x1b[99;5u"))).toBeTrue();
    expect(containsInterrupt(Buffer.from("\x1b[99;5:1u"))).toBeTrue();
    // release of ctrl-c is not an interrupt
    expect(containsInterrupt(Buffer.from("\x1b[99;5:3u"))).toBeFalse();
    // plain c without ctrl is not an interrupt
    expect(containsInterrupt(Buffer.from("\x1b[99;1u"))).toBeFalse();
    expect(containsInterrupt(Buffer.from("plain text"))).toBeFalse();
  });
});

describe("DeferredInject", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test("injects one settle delay after the first output, not at spawn", () => {
    let fired = 0;
    const d = new DeferredInject(() => fired++, 5000, 600);
    expect(fired).toBe(0);
    d.onOutput();
    expect(fired).toBe(0); // settle delay still pending
    vi.advanceTimersByTime(600);
    expect(fired).toBe(1);
  });

  test("later output never re-arms or double-fires", () => {
    let fired = 0;
    const d = new DeferredInject(() => fired++, 5000, 600);
    d.onOutput();
    vi.advanceTimersByTime(600);
    d.onOutput();
    d.onOutput();
    vi.advanceTimersByTime(10_000);
    expect(fired).toBe(1);
  });

  test("fires at the deadline when the TUI never draws", () => {
    let fired = 0;
    new DeferredInject(() => fired++, 5000, 600);
    vi.advanceTimersByTime(4999);
    expect(fired).toBe(0);
    vi.advanceTimersByTime(1);
    expect(fired).toBe(1);
  });

  test("cancel prevents both paths", () => {
    let fired = 0;
    const viaOutput = new DeferredInject(() => fired++, 5000, 600);
    viaOutput.onOutput();
    viaOutput.cancel();
    const viaDeadline = new DeferredInject(() => fired++, 5000, 600);
    viaDeadline.cancel();
    vi.advanceTimersByTime(10_000);
    expect(fired).toBe(0);
  });
});
