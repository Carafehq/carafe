/**
 * Native-trace handoffs for the live mux. Reads the source agent's own
 * structured session log (the same files the capture daemon tails), renders
 * a deterministic secret-redacted brief, and never LLM-summarizes. Sessions
 * within the full budget transfer a faithful structured trace; larger ones
 * transfer extracted orientation notes, a turn directory, and a verbatim
 * structured tail while retaining the complete native JSONL for retrieval.
 */
import { readFileSync, readdirSync, statSync } from "fs";
import { basename, join } from "path";
import { mergeHits, redactText } from "../redact/basic";
import { agentDisplay, type Agent } from "./model";

export const FULL_BUDGET_CHARS = 200_000;
const TAIL_BUDGET_CHARS = 100_000;
const MAP_MAX_LINES = 500;
const RESULT_CAP = 2_000;

export interface CanonicalEvent {
  seq: number;
  kind: string;
  lines: string[];
  files: string[];
}

export type Tier = "full" | "layered";

export interface RenderedHandoff {
  text: string;
  tier: Tier;
  events: number;
  redactions: Record<string, number>;
  sourcePath: string;
  sourceBytes: number;
}

export interface ParsedNativeSession {
  path: string;
  cwd: string | null;
  events: CanonicalEvent[];
  sourceBytes: number;
}

export function discoverAndRender(
  agent: Agent,
  cwd: string,
  startedAtMs: number,
  knownBeforeSpawn: ReadonlySet<string>,
  destination: Agent,
): RenderedHandoff | null {
  const parsed = discoverInRoot(agent, agentRoot(agent), cwd, startedAtMs, knownBeforeSpawn);
  if (parsed === null) return null;
  return render(agent, destination, cwd, parsed);
}

export function snapshotLogPaths(agent: Agent): Set<string> {
  const paths: string[] = [];
  walkJsonl(agentRoot(agent), paths);
  return new Set(paths);
}

/** Same roots and override env vars as the capture adapters. */
function agentRoot(agent: Agent): string {
  if (agent === "claude") {
    return join(process.env.CARAFE_CC_ROOT ?? join(process.env.HOME!, ".claude"), "projects");
  }
  return join(process.env.CARAFE_CODEX_ROOT ?? join(process.env.HOME!, ".codex"), "sessions");
}

export function discoverInRoot(
  agent: Agent,
  root: string,
  cwd: string,
  startedAtMs: number,
  knownBeforeSpawn: ReadonlySet<string>,
): ParsedNativeSession | null {
  const candidates: string[] = [];
  walkJsonl(root, candidates);
  const modifiedAt = new Map<string, number>();
  for (const path of candidates) {
    try {
      modifiedAt.set(path, statSync(path).mtimeMs);
    } catch {
      // Files that disappear or cannot be inspected are skipped below.
    }
  }
  candidates.sort((a, b) => (modifiedAt.get(b) ?? 0) - (modifiedAt.get(a) ?? 0));

  // A CLI can create its log shortly before or after Carafe records the spawn.
  const earliest = startedAtMs - 5_000;
  for (const path of candidates) {
    if (knownBeforeSpawn.has(path)) continue;
    const modified = modifiedAt.get(path);
    if (modified === undefined) continue;
    if (modified < earliest) break;
    let parsed: ParsedNativeSession;
    try {
      parsed = agent === "claude" ? parseClaude(path) : parseCodex(path);
    } catch {
      continue;
    }
    if (parsed.cwd === cwd && parsed.events.length > 0) {
      return parsed;
    }
  }
  return null;
}

function walkJsonl(dir: string, out: string[]): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      walkJsonl(path, out);
    } else if (entry.name.endsWith(".jsonl")) {
      out.push(path);
    }
  }
}

/** Reads at most the byte size observed at open time, like Rust's `take`. */
function boundedLines(path: string): { lines: string[]; sourceBytes: number } {
  const boundary = statSync(path).size;
  const content = readFileSync(path).subarray(0, boundary);
  return { lines: content.toString("utf8").split("\n"), sourceBytes: boundary };
}

export function parseClaude(path: string): ParsedNativeSession {
  const { lines: rawLines, sourceBytes } = boundedLines(path);
  let cwd: string | null = null;
  const events: CanonicalEvent[] = [];
  for (const line of rawLines) {
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof raw !== "object" || raw === null) continue;
    const record = raw as Record<string, unknown>;
    if (cwd === null && typeof record.cwd === "string") {
      cwd = record.cwd;
    }
    const kind = typeof record.type === "string" ? record.type : "meta";
    if (kind !== "user" && kind !== "assistant" && kind !== "system") continue;
    const content = (record.message as Record<string, unknown> | undefined)?.content;
    const lines: string[] = [];
    const files: string[] = [];
    if (typeof content === "string") {
      if (content.trim().length > 0) {
        const role = isSystemText(record, content) ? "system" : kind;
        lines.push(`**${role}:** ${content.trim()}`);
      }
    } else if (Array.isArray(content)) {
      for (const entry of content) {
        const item = entry as Record<string, unknown>;
        switch (item.type) {
          case "text": {
            const text = item.text;
            if (typeof text === "string" && text.trim().length > 0) {
              const role = isSystemText(record, text) ? "system" : kind;
              lines.push(`**${role}:** ${text.trim()}`);
            }
            break;
          }
          case "tool_use": {
            const name = typeof item.name === "string" ? item.name : "tool";
            collectFiles(item.input, files);
            lines.push(`→ **${name}** ${clip(valueText(item.input), 400)}`);
            break;
          }
          case "tool_result":
            lines.push(`  ⤷ ${clip(valueText(item.content), RESULT_CAP)}`);
            break;
        }
      }
    }
    if (lines.length > 0) {
      events.push({ seq: events.length, kind, lines, files });
    }
  }
  return { path, cwd, events, sourceBytes };
}

export function parseCodex(path: string): ParsedNativeSession {
  const { lines: rawLines, sourceBytes } = boundedLines(path);
  let cwd: string | null = null;
  const events: CanonicalEvent[] = [];
  for (const line of rawLines) {
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof raw !== "object" || raw === null) continue;
    const record = raw as Record<string, unknown>;
    const envelope = typeof record.type === "string" ? record.type : "";
    const payload = (record.payload ?? {}) as Record<string, unknown>;
    if (
      cwd === null &&
      (envelope === "session_meta" || envelope === "turn_context") &&
      typeof payload.cwd === "string"
    ) {
      cwd = payload.cwd;
    }
    const payloadType = typeof payload.type === "string" ? payload.type : "";
    const lines: string[] = [];
    const files: string[] = [];
    let kind = "meta";
    if (envelope === "event_msg" && payloadType === "user_message") {
      if (typeof payload.message === "string") {
        lines.push(`**user:** ${payload.message.trim()}`);
      }
      kind = "user";
    } else if (envelope === "event_msg" && payloadType === "agent_message") {
      if (typeof payload.message === "string") {
        lines.push(`**assistant:** ${payload.message.trim()}`);
      }
      kind = "assistant";
    } else if (envelope === "response_item" && payloadType === "function_call") {
      const name = typeof payload.name === "string" ? payload.name : "tool";
      let parsedArguments: unknown = payload.arguments;
      if (typeof payload.arguments === "string") {
        try {
          parsedArguments = JSON.parse(payload.arguments);
        } catch {
          // Unparseable argument strings are rendered verbatim.
        }
      }
      collectFiles(parsedArguments, files);
      lines.push(`→ **${name}** ${clip(valueText(parsedArguments), 400)}`);
      kind = "tool_use";
    } else if (envelope === "response_item" && payloadType === "function_call_output") {
      lines.push(`  ⤷ ${clip(valueText(payload.output), RESULT_CAP)}`);
      kind = "tool_result";
    }
    if (lines.length > 0) {
      events.push({ seq: events.length, kind, lines, files });
    }
  }
  return { path, cwd, events, sourceBytes };
}

function stripUserPrefix(line: string): string {
  let text = line;
  while (text.startsWith("**user:** ")) {
    text = text.slice("**user:** ".length);
  }
  return text;
}

export function render(
  agent: Agent,
  destination: Agent,
  cwd: string,
  parsed: ParsedNativeSession,
): RenderedHandoff {
  const hits: Record<string, number> = {};
  for (const event of parsed.events) {
    event.lines = event.lines.map((line) => {
      const r = redactText(line);
      mergeHits(hits, r.hits);
      return r.text;
    });
  }
  let total = 0;
  for (const event of parsed.events) {
    for (const line of event.lines) total += line.length;
  }
  const firstUserLine = parsed.events.find((e) => e.kind === "user")?.lines[0];
  const goal =
    firstUserLine !== undefined
      ? [...(stripUserPrefix(firstUserLine).split("\n")[0] ?? "?")].slice(0, 100).join("")
      : "?";
  let redactionCount = 0;
  for (const count of Object.values(hits)) redactionCount += count;
  const header = `# Handoff: ${agentDisplay(agent)} → ${agentDisplay(destination)}\n\n- source: ${agent}\n- cwd: ${cwd}\n- events: ${parsed.events.length}\n- redactions: ${redactionCount}\n- complete native trace: ${parsed.path}\n\n`;
  if (total <= FULL_BUDGET_CHARS) {
    const body = parsed.events.flatMap((e) => e.lines).join("\n\n");
    return {
      text: `${header}> Faithful structured trace. Read it and continue the work.\n\n---\n\n${body}\n`,
      tier: "full",
      events: parsed.events.length,
      redactions: hits,
      sourcePath: parsed.path,
      sourceBytes: parsed.sourceBytes,
    };
  }

  const fileCounts = new Map<string, number>();
  for (const event of parsed.events) {
    for (const file of event.files) {
      fileCounts.set(file, (fileCounts.get(file) ?? 0) + 1);
    }
  }
  const files = [...fileCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([file, count]) => `${basename(file) || file}(${count})`)
    .join(", ");
  const turns = parsed.events.filter((event) => event.kind === "user").length;
  const map = turnMap(parsed.events);
  const tail: string[] = [];
  let tailChars = 0;
  for (let i = parsed.events.length - 1; i >= 0; i--) {
    const event = parsed.events[i]!;
    let chars = 0;
    for (const line of event.lines) chars += line.length;
    if (tailChars + chars > TAIL_BUDGET_CHARS) break;
    tailChars += chars;
    tail.push(event.lines.join("\n\n"));
  }
  tail.reverse();
  const text = `${header}> LARGE SESSION: deterministic orientation + turn directory + verbatim structured tail. The complete native trace remains at the path above.\n\n## Notes (extracted, not summarized)\n\n- goal: ${goal}\n- turns: ${turns}\n- files touched most: ${files.length === 0 ? "none" : files}\n\n## Turn directory\n\n${map.join("\n")}\n\n## Retrieve complete evidence\n\nThe complete source trace is retained at the path above. Follow the retrieval command included by Carafe to inspect exact evidence.\n\n## Verbatim tail\n\n${tail.join("\n\n")}\n`;
  return {
    text,
    tier: "layered",
    events: parsed.events.length,
    redactions: hits,
    sourcePath: parsed.path,
    sourceBytes: parsed.sourceBytes,
  };
}

function turnMap(events: CanonicalEvent[]): string[] {
  const blocks: string[] = [];
  for (const event of events) {
    if (event.kind === "user" || blocks.length === 0) {
      const title =
        event.lines.length > 0
          ? (stripUserPrefix(event.lines[0]!).split("\n")[0] ?? "?")
          : "?";
      blocks.push(`- [seq ${event.seq}] ${[...title].slice(0, 90).join("")}`);
    }
  }
  if (blocks.length <= MAP_MAX_LINES) {
    return blocks;
  }
  const omitted = blocks.length - MAP_MAX_LINES;
  const compact = blocks.slice(0, 100);
  compact.push(`- … ${omitted} turns omitted from this directory …`);
  compact.push(...blocks.slice(blocks.length - (MAP_MAX_LINES - 100)));
  return compact;
}

function clip(value: string, cap: number): string {
  if (value.length <= cap) {
    return value;
  }
  let boundary = cap;
  // Never split a surrogate pair.
  const last = value.charCodeAt(boundary - 1);
  if (last >= 0xd800 && last <= 0xdbff) {
    boundary -= 1;
  }
  return `${value.slice(0, boundary)}\n    […${value.length - boundary} more bytes clipped; complete native trace retained…]`;
}

function valueText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(valueText).join("\n");
  if (value === null || value === undefined) return "";
  return JSON.stringify(value);
}

function collectFiles(value: unknown, files: string[]): void {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return;
  const object = value as Record<string, unknown>;
  for (const key of ["file_path", "path"]) {
    if (typeof object[key] === "string") {
      files.push(object[key] as string);
    }
  }
}

const SYSTEM_MARKERS = [
  "<system-reminder",
  "<command-name",
  "<command-message",
  "<local-command",
  "<task-notification",
  "Caveat:",
  "[Request interrupted",
];

function isSystemText(raw: Record<string, unknown>, text: string): boolean {
  if (raw.isMeta === true) return true;
  const trimmed = text.trimStart();
  return SYSTEM_MARKERS.some((marker) => trimmed.startsWith(marker));
}
