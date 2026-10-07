/**
 * The live mux — a parent session owning multiple agent children, each in its
 * own PTY, so switching never stops or closes an agent. Ctrl-G switches,
 * Ctrl-H hands off to the other agent through its PTY, Ctrl-M shows the map,
 * Ctrl-Q quits. Bindings are decoded in both legacy and kitty (CSI-u)
 * keyboard encodings, since agents like Claude Code push the enhanced
 * protocol onto the outer terminal.
 *
 * NOTE: this module dlopens bun-pty's native library on import — the CLI
 * loads it lazily so every other command stays PTY-free.
 */
import { spawn as ptySpawn } from "bun-pty";
import { statSync } from "fs";
import {
  EncryptedTranscriptWriter,
  KEY_ENV,
  encodeKey,
  encryptFile,
  generateKey,
} from "./encrypted-transcript";
import {
  agentDisplay,
  newParentSession,
  otherAgent,
  recordHandoff,
  short,
  tree,
  type Agent,
  type HandoffStorage,
  type ParentSession,
} from "./model";
import * as store from "./store";
import { discoverAndRender, snapshotLogPaths } from "./structured-handoff";

export const OUTPUT_BUFFER_BYTES = 512 * 1024;
export const HANDOFF_BYTES = 256 * 1024;
const REDRAW_BYTES = 120_000;
/** Display backlog bound; mirrors the Rust 128-chunk × 8 KiB output queue. */
export const OUTPUT_QUEUE_BYTES = 128 * 8192;
const MAX_CHILDREN = 32;

/** Keeps the newest `OUTPUT_BUFFER_BYTES` of PTY output for redraw/handoff. */
export class BoundedOutput {
  private chunks: Buffer[] = [];
  private total = 0;

  push(chunk: Buffer): void {
    if (chunk.length >= OUTPUT_BUFFER_BYTES) {
      this.chunks = [Buffer.from(chunk.subarray(chunk.length - OUTPUT_BUFFER_BYTES))];
      this.total = OUTPUT_BUFFER_BYTES;
      return;
    }
    this.chunks.push(Buffer.from(chunk));
    this.total += chunk.length;
    let overflow = this.total - OUTPUT_BUFFER_BYTES;
    while (overflow > 0) {
      const head = this.chunks[0]!;
      if (head.length <= overflow) {
        this.chunks.shift();
        this.total -= head.length;
        overflow -= head.length;
      } else {
        this.chunks[0] = head.subarray(overflow);
        this.total -= overflow;
        overflow = 0;
      }
    }
  }

  tail(limit: number): Buffer {
    const want = Math.min(limit, this.total);
    const parts: Buffer[] = [];
    let collected = 0;
    for (let i = this.chunks.length - 1; i >= 0 && collected < want; i--) {
      const chunk = this.chunks[i]!;
      const take = Math.min(chunk.length, want - collected);
      parts.push(chunk.subarray(chunk.length - take));
      collected += take;
    }
    parts.reverse();
    return Buffer.concat(parts);
  }

  len(): number {
    return this.total;
  }
}

interface Pty {
  pid: number;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  onData(listener: (data: string) => void): unknown;
  onExit(listener: (event: { exitCode: number }) => void): unknown;
}

interface LiveChild {
  metaId: string;
  agent: Agent;
  pty: Pty;
  output: BoundedOutput;
  log: EncryptedTranscriptWriter | null;
  transcriptPath: string;
  diskTranscript: string | null;
  captureFailed: boolean;
  startedAtMs: number;
  nativeLogsBefore: ReadonlySet<string>;
  deferredInject: DeferredInject | null;
}

export const INJECT_SETTLE_MS = 600;
export const INJECT_DEADLINE_MS = 5000;

/**
 * Defers a handoff injection until the destination TUI is actually reading in
 * raw mode. Writing at spawn time lands in the kernel's canonical-mode input
 * queue: the tty echoes the paste literally and MAX_CANON (1 KiB per line)
 * silently drops the rest — including the bracketed-paste terminator — leaving
 * the composer stuck in a never-ending paste with visibly empty input
 * (observed with codex 0.147). The TUI's first PTY output means it is drawing,
 * so raw mode is active; one settle delay later the paste parses as a paste.
 * A deadline from spawn keeps a TUI that never draws from swallowing the
 * handoff entirely.
 */
export class DeferredInject {
  private timer: Timer;
  private armed = false;
  private fired = false;

  constructor(
    private readonly send: () => void,
    deadlineMs: number = INJECT_DEADLINE_MS,
    private readonly settleMs: number = INJECT_SETTLE_MS,
  ) {
    this.timer = setTimeout(() => this.fire(), deadlineMs);
  }

  /** First child output re-schedules to one settle delay; later output is a no-op. */
  onOutput(): void {
    if (this.armed || this.fired) return;
    this.armed = true;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.fire(), this.settleMs);
  }

  cancel(): void {
    this.fired = true;
    clearTimeout(this.timer);
  }

  private fire(): void {
    if (this.fired) return;
    this.fired = true;
    this.send();
  }
}

type Handoff =
  | { kind: "memory"; text: string }
  | { kind: "layered"; text: string; path: string }
  | { kind: "disk"; path: string };

/**
 * Mutable capture state shared between the PTY reader and handoff logic;
 * the standalone shape keeps the spill policy unit-testable.
 */
export interface CaptureState {
  output: BoundedOutput;
  log: EncryptedTranscriptWriter | null;
  diskTranscript: string | null;
}

/**
 * Captures one PTY chunk. While the trace fits in `HANDOFF_BYTES` it stays in
 * memory only; the first chunk that crosses the limit switches the child to
 * the encrypted disk backend, persisting the complete existing trace first.
 * Returns the transcript path when this call performed that switch. Throws if
 * the disk backend cannot be created or written — the crossing chunk is still
 * retained in bounded memory so nothing is silently lost.
 */
export function captureOutputChunk(
  state: CaptureState,
  transcriptPath: string,
  chunk: Buffer,
  ephemeralKey: Uint8Array,
): string | null {
  const needsSpill =
    state.log === null && state.output.len() + chunk.length > HANDOFF_BYTES;
  let spilled: string | null = null;

  if (needsSpill) {
    const existing = state.output.tail(state.output.len());
    let file: EncryptedTranscriptWriter;
    try {
      file = EncryptedTranscriptWriter.create(transcriptPath, ephemeralKey);
      file.writeChunk(existing);
      file.writeChunk(chunk);
    } catch (error) {
      state.output.push(chunk);
      throw new Error(
        `open disk fallback ${transcriptPath}: ${error instanceof Error ? error.message : error}`,
      );
    }
    state.diskTranscript = transcriptPath;
    spilled = transcriptPath;
    state.log = file;
  } else if (state.log !== null) {
    try {
      state.log.writeChunk(chunk);
    } catch (error) {
      state.output.push(chunk);
      throw error;
    }
  }

  state.output.push(chunk);
  return spilled;
}

/** Minimal sink contract so display forwarding is testable without a TTY. */
export interface DisplaySink {
  destroyed: boolean;
  writableLength: number;
  write(chunk: Buffer): void;
}

/**
 * Forwards a display copy of PTY output. When the sink's backlog exceeds the
 * bounded queue the copy is dropped — capture already happened, so only the
 * live redraw skips ahead. Returns false once the sink is gone.
 */
export function forwardOutput(sink: DisplaySink, bytes: Buffer): boolean {
  if (sink.destroyed) {
    return false;
  }
  if (sink.writableLength >= OUTPUT_QUEUE_BYTES) {
    return true;
  }
  sink.write(bytes);
  return true;
}

/**
 * Injects a handoff through the destination PTY. Bracketed paste makes
 * multiline handoffs one prompt instead of submitting each line separately.
 * PTY input is queued safely while the CLI starts.
 */
export function injectPrompt(writer: { write(data: string): void }, text: string): void {
  writer.write(`\x1b[200~${text}\x1b[201~\r`);
}

export function stripAnsi(input: string): string {
  let out = "";
  const chars = [...input];
  let i = 0;
  while (i < chars.length) {
    const c = chars[i++]!;
    if (c === "\x1b") {
      if (chars[i] === "[") {
        i++;
        while (i < chars.length) {
          const x = chars[i++]!;
          if (x >= "@" && x <= "~") break;
        }
      }
      continue;
    }
    if (c !== "\r") out += c;
  }
  return out;
}

export function renderPtyHandoff(
  session: ParentSession,
  childId: string,
  from: Agent,
  to: Agent,
  snapshot: Buffer,
): string {
  const trace = stripAnsi(snapshot.toString("utf8"));
  return `# Live handoff: ${agentDisplay(from)} → ${agentDisplay(to)}\n\n- parent: ${session.id}\n- child: ${childId}\n- cwd: ${session.cwd}\n- created: ${new Date().toISOString()}\n\n> Bounded terminal tail captured directly from the live PTY. The source process is still running. No handoff file was used unless disk storage was explicitly selected.\n\n---\n\n${trace}\n`;
}

function readCommand(path: string): string {
  // Compiled binaries embed their entry under /$bunfs; then the executable
  // alone is the command, matching the Rust `current_exe` behaviour.
  const script = Bun.main.startsWith("/$bunfs") ? null : Bun.main;
  return script !== null
    ? `"${process.execPath}" "${script}" read "${path}"`
    : `"${process.execPath}" read "${path}"`;
}

const CONTROL_KEYS: Record<number, "switch" | "handoff" | "quit"> = {
  0x07: "switch", // Ctrl-G
  0x08: "handoff", // Ctrl-H
  0x11: "quit", // Ctrl-Q
};

/**
 * CSI-u (kitty protocol) codes for terminals that report enhanced keys.
 * Claude Code pushes this protocol onto the outer terminal through the
 * forwarded PTY stream, so Carafe's own bindings must decode it too.
 */
const CSI_U_KEYS: Record<number, "switch" | "handoff" | "map" | "quit"> = {
  103: "switch", // g
  104: "handoff", // h
  109: "map", // m
  113: "quit", // q
};

/** `\x1b[code(:alternates);modifier(:event-type)u` — kitty CSI-u key report. */
const CSI_U_PATTERN = /^\x1b\[(\d+)(?::\d+)*;(\d+)(?::(\d+))?u/;

type InputToken =
  | { kind: "action"; action: "switch" | "handoff" | "map" | "quit" }
  | { kind: "bytes"; bytes: Buffer };

/**
 * Splits terminal input into control actions and passthrough bytes. Legacy
 * terminals cannot distinguish Ctrl-M from Enter, so `0x0d` always passes
 * through; the map binding relies on CSI-u reporting, mirroring crossterm.
 * CSI-u reports for Carafe's own bindings are swallowed entirely: presses
 * and repeats act, releases are dropped so they never leak to the child.
 */
export function tokenizeInput(chunk: Buffer): InputToken[] {
  const tokens: InputToken[] = [];
  let plain: number[] = [];
  const flush = () => {
    if (plain.length > 0) {
      tokens.push({ kind: "bytes", bytes: Buffer.from(plain) });
      plain = [];
    }
  };
  let i = 0;
  while (i < chunk.length) {
    const byte = chunk[i]!;
    const control = CONTROL_KEYS[byte];
    if (control !== undefined) {
      flush();
      tokens.push({ kind: "action", action: control });
      i++;
      continue;
    }
    if (byte === 0x1b) {
      const rest = chunk.subarray(i).toString("latin1");
      const csiU = CSI_U_PATTERN.exec(rest);
      if (csiU !== null) {
        const action = CSI_U_KEYS[Number(csiU[1])];
        const ctrl = (Number(csiU[2]) - 1) & 0x04;
        const eventType = csiU[3] === undefined ? 1 : Number(csiU[3]);
        if (action !== undefined && ctrl !== 0) {
          flush();
          if (eventType === 1 || eventType === 2) {
            tokens.push({ kind: "action", action });
          }
          i += csiU[0].length;
          continue;
        }
      }
    }
    plain.push(byte);
    i++;
  }
  flush();
  return tokens;
}

/** Detects Ctrl-C in both legacy (0x03) and kitty CSI-u (code 99) encodings. */
export function containsInterrupt(chunk: Buffer): boolean {
  if (chunk.includes(0x03)) {
    return true;
  }
  const text = chunk.toString("latin1");
  for (const match of text.matchAll(/\x1b\[99(?::\d+)*;(\d+)(?::(\d+))?u/g)) {
    const ctrl = (Number(match[1]) - 1) & 0x04;
    const eventType = match[2] === undefined ? 1 : Number(match[2]);
    if (ctrl !== 0 && (eventType === 1 || eventType === 2)) {
      return true;
    }
  }
  return false;
}

interface ChildCallbacks {
  onData(child: LiveChild, chunk: Buffer): void;
  onExit(child: LiveChild): void;
}

function spawnChild(
  id: string,
  agent: Agent,
  prompt: string | null,
  session: ParentSession,
  ephemeralKey: Uint8Array,
  callbacks: ChildCallbacks,
): LiveChild {
  const cols = process.stdout.columns || 120;
  const rows = process.stdout.rows || 40;
  if (Bun.which(agent) === null) {
    throw new Error(`start ${agent}; is it installed and on PATH?`);
  }
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  env[KEY_ENV] = encodeKey(ephemeralKey);
  const nativeLogsBefore = snapshotLogPaths(agent);
  const startedAtMs = Date.now();
  const pty = ptySpawn(agent, prompt !== null ? [prompt] : [], {
    name: "xterm-256color",
    cols,
    rows,
    cwd: session.cwd,
    env,
  }) as Pty;
  const transcriptPath = store.transcriptPath(session.id, id);
  let log: EncryptedTranscriptWriter | null = null;
  let diskTranscript: string | null = null;
  if (session.handoff_storage === "disk") {
    log = EncryptedTranscriptWriter.create(transcriptPath, ephemeralKey);
    diskTranscript = transcriptPath;
  }
  const child: LiveChild = {
    metaId: id,
    agent,
    pty,
    output: new BoundedOutput(),
    log,
    transcriptPath,
    diskTranscript,
    captureFailed: false,
    startedAtMs,
    nativeLogsBefore,
    deferredInject: null,
  };
  pty.onData((data) => callbacks.onData(child, Buffer.from(data, "utf8")));
  pty.onExit(() => callbacks.onExit(child));
  return child;
}

function createHandoff(
  session: ParentSession,
  child: LiveChild,
  to: Agent,
  ephemeralKey: Uint8Array,
): Handoff {
  const rendered = discoverAndRender(
    child.agent,
    session.cwd,
    child.startedAtMs,
    child.nativeLogsBefore,
    to,
  );
  if (rendered !== null) {
    if (rendered.tier === "full") {
      return { kind: "memory", text: rendered.text };
    }
    const archive = store.nativeArchivePath(session.id, child.metaId);
    encryptFile(rendered.sourcePath, rendered.sourceBytes, archive, ephemeralKey);
    const text =
      rendered.text.replaceAll(rendered.sourcePath, archive) +
      `\n## Read the complete encrypted trace\n\nRun \`${readCommand(archive)}\` inside this Carafe-managed agent. The archive is compressed and authenticated; its key exists only for the lifetime of the parent session.\n`;
    return { kind: "layered", text, path: archive };
  }

  // Provider-native logs are authoritative. Raw PTY capture is a compatibility
  // fallback for unknown formats or sessions that cannot be discovered.
  if (child.captureFailed) {
    throw new Error(
      `lossless capture is paused for child ${short(child.metaId)}; resolve the disk backend error before handing off`,
    );
  }
  if (child.diskTranscript !== null) {
    return { kind: "disk", path: child.diskTranscript };
  }
  if (child.output.len() > HANDOFF_BYTES) {
    throw new Error(
      "handoff exceeds the memory limit without a disk transcript; refusing a lossy handoff",
    );
  }
  const snapshot = child.output.tail(child.output.len());
  return {
    kind: "memory",
    text: renderPtyHandoff(session, child.metaId, child.agent, to, snapshot),
  };
}

function drawBanner(session: ParentSession, active: number): void {
  const c = session.children[active]!;
  process.stdout.write(
    `\x1b[48;5;24m\x1b[97m Carafe ${short(session.id)} │ ${agentDisplay(c.agent)} ${short(c.id)} │ handoff:${session.handoff_storage} │ Ctrl-G switch │ Ctrl-H handoff │ Ctrl-M map │ Ctrl-Q quit \x1b[0m\r\n`,
  );
}

export function run(
  first: Agent,
  prompt: string | null,
  cwd: string,
  handoffStorage: HandoffStorage,
): Promise<void> {
  let isDirectory = false;
  try {
    isDirectory = statSync(cwd).isDirectory();
  } catch {
    // Missing paths fall through to the error below.
  }
  if (!isDirectory) {
    throw new Error(`working directory does not exist: ${cwd}`);
  }
  const session = newParentSession(cwd, first, handoffStorage);
  store.save(session);
  const ephemeralKey = generateKey();
  const children: LiveChild[] = [];
  let active = 0;
  let mapMode = false;
  let finished = false;

  return new Promise<void>((resolve, reject) => {
    const settle = (error: Error | null) => {
      if (finished) return;
      finished = true;
      for (const child of children) {
        child.deferredInject?.cancel();
        try {
          child.pty.kill();
        } catch {
          // Already exited.
        }
      }
      process.stdin.removeListener("data", onStdin);
      process.removeListener("SIGWINCH", onResize);
      process.removeListener("SIGINT", onSignal);
      process.removeListener("SIGTERM", onSignal);
      process.removeListener("SIGHUP", onSignal);
      try {
        process.stdin.setRawMode(false);
      } catch {
        // stdin may already be closed.
      }
      // Leave the alternate screen, then clear modes a child may have leaked
      // to the outer terminal before dying: show cursor, SGR reset, mouse
      // reporting off, bracketed paste off, kitty keyboard protocol popped.
      // Each is a no-op when the mode was never set.
      process.stdout.write(
        "\x1b[?1049l\x1b[?25h\x1b[0m\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?2004l\x1b[<u",
      );
      process.stdin.pause();
      store.save(session);
      ephemeralKey.zeroize();
      if (error !== null) reject(error);
      else resolve();
    };

    const redraw = (child: LiveChild) => {
      process.stdout.write("\x1b[2J\x1b[H");
      const index = session.children.findIndex((c) => c.id === child.metaId);
      drawBanner(session, index >= 0 ? index : 0);
      process.stdout.write(child.output.tail(REDRAW_BYTES));
    };

    const callbacks: ChildCallbacks = {
      onData: (child, chunk) => {
        // The destination TUI is drawing, so its stdin is in raw mode —
        // a queued handoff can now be pasted without the canonical-mode queue
        // echoing it or truncating it at MAX_CANON.
        child.deferredInject?.onOutput();
        if (finished || child.captureFailed) return;
        let spilled: string | null = null;
        try {
          spilled = captureOutputChunk(child, child.transcriptPath, chunk, ephemeralKey.asBytes());
        } catch (error) {
          child.captureFailed = true;
          process.stdout.write(
            `\x07\r\n✗ Carafe could not preserve child ${short(child.metaId)} on disk: ${error instanceof Error ? error.message : error}\r\n  Output capture is paused to prohibit silent handoff data loss.\r\n`,
          );
          return;
        }
        if (spilled !== null) {
          process.stdout.write(
            `\x07\r\n⚠ Carafe child ${short(child.metaId)} exceeded the ${HANDOFF_BYTES / 1024} KiB memory handoff limit.\r\n  Switched losslessly to compressed, ephemeral encrypted storage: ${spilled}\r\n`,
          );
        }
        if (children[active] === child && !mapMode) {
          forwardOutput(process.stdout, chunk);
        }
      },
      onExit: (child) => {
        child.deferredInject?.cancel();
        const meta = session.children.find((c) => c.id === child.metaId);
        if (meta !== undefined) {
          meta.status = "exited";
        }
        // The final screen stays visible, but a silent corpse looks like a
        // freeze — say what happened and how to leave.
        if (!finished && children[active] === child && !mapMode) {
          process.stdout.write(
            `\x07\r\n[Carafe] ${agentDisplay(child.agent)} ${short(child.metaId)} exited — Ctrl-G switch │ Ctrl-H handoff │ Ctrl-Q quit\r\n`,
          );
        }
      },
    };

    const actions = {
      quit: () => settle(null),
      switch: () => {
        active = (active + 1) % children.length;
        session.active_child = children[active]!.metaId;
        store.save(session);
        redraw(children[active]!);
      },
      map: () => {
        mapMode = true;
        process.stdout.write(
          `\x1b[2J\x1b[H${tree(session).replaceAll("\n", "\r\n")}\r\nPress any key to return…`,
        );
      },
      handoff: () => {
        if (children.length >= MAX_CHILDREN) {
          process.stdout.write(
            `\x07\r\nCarafe supports at most ${MAX_CHILDREN} live children in one parent session.\r\n`,
          );
          return;
        }
        const source = children[active]!;
        const toAgent = otherAgent(source.agent);
        const handoff = createHandoff(session, source, toAgent, ephemeralKey.asBytes());
        const id = crypto.randomUUID();
        const diskPrompt =
          handoff.kind === "disk"
            ? `Run \`${readCommand(handoff.path)}\` to decrypt and decompress the complete terminal trace from ${agentDisplay(source.agent)}. Continue the work from where it ends. The key is ephemeral and inherited from the active Carafe parent.`
            : null;
        const child = spawnChild(id, toAgent, diskPrompt, session, ephemeralKey.asBytes(), callbacks);
        if (handoff.kind === "memory" || handoff.kind === "layered") {
          if (handoff.kind === "layered") {
            process.stdout.write(
              `\x07\r\n⚠ Structured session exceeds the full inline budget.\r\n  Sending a deterministic orientation layer; complete trace is compressed and ephemeral encrypted: ${handoff.path}\r\n`,
            );
          }
          const text = handoff.text;
          child.deferredInject = new DeferredInject(() => injectPrompt(child.pty, text));
        }
        recordHandoff(
          session,
          id,
          toAgent,
          source.metaId,
          handoff.kind === "memory" ? null : handoff.path,
        );
        children.push(child);
        active = children.length - 1;
        store.save(session);
        redraw(child);
      },
    };

    const onStdin = (chunk: Buffer) => {
      if (finished) return;
      if (mapMode) {
        mapMode = false;
        redraw(children[active]!);
        return;
      }
      // Once every child has exited there is nothing left to forward to, so
      // Ctrl-C quits instead of typing into a corpse.
      if (
        session.children.every((c) => c.status === "exited") &&
        containsInterrupt(chunk)
      ) {
        settle(null);
        return;
      }
      try {
        for (const token of tokenizeInput(chunk)) {
          if (token.kind === "bytes") {
            children[active]!.pty.write(token.bytes.toString("utf8"));
          } else {
            actions[token.action]();
            if (finished) return;
          }
        }
      } catch (error) {
        settle(error instanceof Error ? error : new Error(String(error)));
      }
    };

    // Keyboard Ctrl-C never raises SIGINT in raw mode; these fire only for
    // external kills and terminal hangups, where restoring the outer
    // terminal and persisting the session map still matter.
    const onSignal = () => settle(null);

    const onResize = () => {
      const cols = process.stdout.columns || 120;
      const rows = process.stdout.rows || 40;
      for (const child of children) {
        try {
          child.pty.resize(cols, rows);
        } catch {
          // Exited children cannot be resized.
        }
      }
    };

    try {
      children.push(
        spawnChild(
          session.children[0]!.id,
          first,
          prompt,
          session,
          ephemeralKey.asBytes(),
          callbacks,
        ),
      );
      process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdout.write("\x1b[?1049h\x1b[2J\x1b[H");
      drawBanner(session, active);
      process.stdin.on("data", onStdin);
      process.on("SIGWINCH", onResize);
      process.on("SIGINT", onSignal);
      process.on("SIGTERM", onSignal);
      process.on("SIGHUP", onSignal);
    } catch (error) {
      settle(error instanceof Error ? error : new Error(String(error)));
    }
  });
}
