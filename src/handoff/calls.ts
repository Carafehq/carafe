/**
 * Tool calls bound to THEIR OWN results.
 *
 * A rendered trace is a stream of lines, and pairing a `⤷` with the `→ **` above
 * it is only a guess: a call whose result never arrived, a sidechain, or an
 * interleaved pair silently shifts every later pairing by one — which is how a
 * handoff came to print a code-review document as a `/health` response.
 * Binding uses the harness's own identifiers (Claude Code's `tool_use_id`,
 * Codex's `call_id`) and falls back to the immediately following result only
 * when neither side carries one.
 *
 * The TEXT of every call and result still comes from the redacted pieces — the
 * events are used for identity, never for content, so nothing can reach a
 * handoff unredacted.
 */
import type { CarafeEvent } from "../format/events";
import { redactText } from "../redact/basic";
import type { EventPieces } from "./pieces";

export interface TraceCall {
  seq: number;
  /** the harness's own identifier for this call, when it has one */
  id: string | null;
  ts: string | null;
  toolName: string | null;
  /**
   * The WHOLE shell command, taken from the event and redacted — never the
   * rendered line, which is clipped at 400 characters for reading. A compound
   * command keeps its `git` parts however far along they sit.
   */
  command: string | null;
  /** the file a Read/Edit/Write/read_file call names, whole and redacted */
  filePath: string | null;
  callLine: string;
  resultSeq: number | null;
  /** the result body, redacted, without its `⤷` marker */
  result: string | null;
}

/** The same newline handling `commandOf` applies to a rendered line, so both
 *  views of a command match the same patterns. */
function flatten(text: string): string {
  return text.replace(/\\\r?\n/g, " ").replace(/\r?\n+/g, " ; ").replace(/\s+/g, " ").replace(/(?:\s*;\s*){2,}/g, " ; ").trim();
}

const redacted = (text: string): string => redactText(text).text;

function commandValue(value: unknown): string | null {
  if (typeof value === "string") return flatten(value);
  if (Array.isArray(value) && value.every((part) => typeof part === "string")) return flatten(value.join(" "));
  return null;
}

/** The command and file a tool call names, read from the event's own input. */
function inputOf(event: CarafeEvent, item: any): { command: string | null; filePath: string | null } {
  let input: any = item;
  if (typeof input === "string") {
    try { input = JSON.parse(input); } catch { return { command: null, filePath: null }; }
  }
  if (!input || typeof input !== "object") return { command: null, filePath: null };
  const command = commandValue(input.command ?? input.cmd);
  const file = typeof input.file_path === "string" ? input.file_path : typeof input.path === "string" ? input.path : null;
  return {
    command: command == null ? null : redacted(command),
    filePath: file == null ? null : redacted(file),
  };
}

interface Slot { seq: number; index: number; id: string | null; toolName?: string | null; command?: string | null; filePath?: string | null }

function slotsOf(event: CarafeEvent): { calls: Slot[]; results: Slot[] } {
  const calls: Slot[] = [];
  const results: Slot[] = [];
  const raw: any = event.raw;
  if (event.tool === "claude-code") {
    const content = raw?.message?.content;
    if (Array.isArray(content)) {
      for (const item of content) {
        if (item?.type === "tool_use") {
          calls.push({ seq: event.seq, index: calls.length, id: typeof item.id === "string" ? item.id : null, toolName: typeof item.name === "string" ? item.name : null, ...inputOf(event, item.input) });
        } else if (item?.type === "tool_result") results.push({ seq: event.seq, index: results.length, id: typeof item.tool_use_id === "string" ? item.tool_use_id : null });
      }
    }
    return { calls, results };
  }
  const payload = raw?.payload ?? {};
  const id = typeof payload.call_id === "string" ? payload.call_id : typeof payload.id === "string" ? payload.id : null;
  if (event.kind === "tool_use") {
    calls.push({ seq: event.seq, index: 0, id, toolName: typeof payload.name === "string" ? payload.name : null, ...inputOf(event, payload.arguments ?? payload.input) });
  } else if (event.kind === "tool_result") results.push({ seq: event.seq, index: 0, id });
  return { calls, results };
}

/** Every tool call's own input, whole and redacted, in trace order. */
export function toolCallInputs(events: CarafeEvent[]): Array<{ seq: number; id: string | null; toolName: string | null; command: string | null; filePath: string | null }> {
  return events.flatMap((event) => slotsOf(event).calls.map((call) => ({
    seq: call.seq, id: call.id, toolName: call.toolName ?? null, command: call.command ?? null, filePath: call.filePath ?? null,
  })));
}

/** The full commands each event issued, for the parsers that work per event. */
export function commandsBySeq(events: CarafeEvent[]): Map<number, string[]> {
  const out = new Map<number, string[]>();
  for (const call of toolCallInputs(events)) {
    if (call.command == null) continue;
    const list = out.get(call.seq) ?? [];
    list.push(call.command);
    out.set(call.seq, list);
  }
  return out;
}

const callLinesOf = (piece: EventPieces | undefined): string[] => (piece?.lines ?? []).filter((line) => line.startsWith("→ **"));
const resultLinesOf = (piece: EventPieces | undefined): string[] => (piece?.lines ?? []).filter((line) => line.trimStart().startsWith("⤷"));

/** Every tool call in the trace, each carrying the result that belongs to it. */
export function boundCalls(events: CarafeEvent[], pieces: EventPieces[]): TraceCall[] {
  const pieceBySeq = new Map(pieces.map((piece) => [piece.seq, piece]));
  const calls: Slot[] = [];
  const results: Slot[] = [];
  const tsBySeq = new Map<number, string | null>();
  for (const event of events) {
    tsBySeq.set(event.seq, event.ts ?? null);
    const slots = slotsOf(event);
    calls.push(...slots.calls);
    results.push(...slots.results);
  }
  const byId = new Map<string, Slot>();
  for (const slot of results) if (slot.id && !byId.has(slot.id)) byId.set(slot.id, slot);

  const bound = new Set<Slot>();
  const out: TraceCall[] = [];
  let fallback = 0;
  for (const call of calls) {
    let result: Slot | null = call.id ? byId.get(call.id) ?? null : null;
    if (result) bound.add(result);
    else {
      // no identifiers on either side: the next unclaimed result, and nothing else
      while (fallback < results.length && (bound.has(results[fallback]!) || results[fallback]!.seq < call.seq)) fallback++;
      const candidate = results[fallback];
      if (candidate && !candidate.id) { result = candidate; bound.add(candidate); fallback++; }
    }
    const callLine = callLinesOf(pieceBySeq.get(call.seq))[call.index] ?? "";
    const resultLine = result ? resultLinesOf(pieceBySeq.get(result.seq))[result.index] ?? null : null;
    out.push({
      seq: call.seq,
      id: call.id,
      ts: tsBySeq.get(call.seq) ?? null,
      toolName: call.toolName ?? /^→ \*\*([^*]+)\*\*/.exec(callLine)?.[1]?.trim() ?? null,
      command: call.command ?? null,
      filePath: call.filePath ?? null,
      callLine,
      resultSeq: result?.seq ?? null,
      result: resultLine == null ? null : resultLine.replace(/^\s*⤷\s*/, ""),
    });
  }
  return out;
}
