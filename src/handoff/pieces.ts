/**
 * Piece extraction — one pass over events producing renderable, redacted lines
 * per event. Shared by: full-trace handoff, layered handoff (map/tail), carafe
 * show (sections) and carafe grep (in-session search). Deterministic, no LLM.
 */
import type { CarafeEvent } from "../format/events";
import { redactText, mergeHits } from "../redact/basic";

export const RESULT_CAP = 2000;
/** The last turns of a handoff are where the next agent starts working: the
 *  documents it must act on live in those tool results, so they get a wider cap
 *  than the body of the trace. */
export const TAIL_RESULT_CAP = 6000;

export interface EventPieces { seq: number; kind: string; lines: string[]; chars: number; ts: string | null }
export interface PieceOpts {
  includeThinking?: boolean;
  /** Cap for tool-result text. `Infinity` renders results whole (carafe show). */
  resultCap?: number;
}

/** Where a clipped piece can be read in full. */
export interface PieceRef { sessionId: string; seq: number }

/** A truncation marker is only useful if following it works: name the session
 *  and the seq, and the exact flag that lifts the cap. */
export function clip(s: string, cap: number = RESULT_CAP, ref?: PieceRef): string {
  if (!(s.length > cap)) return s;
  const where = ref ? `carafe show ${ref.sessionId} --seq ${ref.seq} --max-chars 0` : `carafe show <id> --seq <seq> --max-chars 0`;
  return s.slice(0, cap) + `\n    […${(s.length - cap).toLocaleString()} more chars — ${where}]`;
}

const asText = (v: unknown): string => (typeof v === "string" ? v : v == null ? "" : JSON.stringify(v));

/** CC injects system content as user-typed events; a faithful trace must not
 *  attribute it to the human. Detect via isMeta flag + well-known markers. */
const SYSTEM_MARKERS = ["<system-reminder", "<command-name", "<command-message", "<local-command", "<task-notification", "Caveat:", "[Request interrupted", "This session is being continued from a previous conversation"];
function isSystemInjected(raw: any, text: string): boolean {
  if (raw?.isMeta === true) return true;
  const t = text.trimStart();
  return SYSTEM_MARKERS.some((m) => t.startsWith(m));
}

function rawPieces(ev: CarafeEvent, opts: PieceOpts): string[] {
  const out: string[] = [];
  const raw: any = ev.raw;
  const ref: PieceRef = { sessionId: ev.sessionId, seq: ev.seq };
  const resultCap = opts.resultCap ?? RESULT_CAP;
  if (ev.tool === "claude-code") {
    if (raw?.type === "pr-link" && typeof raw.prUrl === "string") {
      return [`pr-link #${String(raw.prNumber)} ${raw.prUrl}`];
    }
    const content = raw?.message?.content;
    if (typeof content === "string") {
      if (!content.trim()) return out;
      out.push(isSystemInjected(raw, content) ? `**system:** ${content.trim()}` : `**${ev.kind}:** ${content.trim()}`);
      return out;
    }
    if (Array.isArray(content)) {
      for (const item of content) {
        if (!item || typeof item !== "object") continue;
        if (item.type === "text" && item.text?.trim())
          out.push(isSystemInjected(raw, item.text) ? `**system:** ${item.text.trim()}` : `**${ev.kind}:** ${item.text.trim()}`);
        else if (item.type === "thinking" && opts.includeThinking && item.thinking?.trim()) out.push(`_(thinking)_ ${clip(item.thinking.trim(), 1200, ref)}`);
        else if (item.type === "tool_use") out.push(`→ **${item.name}** ${clip(asText(item.input), 400, ref)}`);
        else if (item.type === "tool_result") {
          const c = Array.isArray(item.content) ? item.content.map((x: any) => x?.text ?? asText(x)).join("\n") : asText(item.content);
          out.push(`  ⤷ ${clip(c, resultCap, ref)}`);
        }
      }
    }
    return out;
  }
  const p = raw?.payload ?? {};
  switch (ev.kind) {
    case "user": if ((p.message ?? "").trim()) out.push(`**user:** ${String(p.message).trim()}`); break;
    case "assistant": {
      const txt = typeof p.message === "string" ? p.message
        : Array.isArray(p.content) ? p.content.map((x: any) => x?.text ?? "").join("") : asText(p.content ?? p.text);
      if (!txt.trim()) break;
      // Codex logs the model's INPUT as response_item messages too: role "developer"
      // carries harness instructions, and role "user" repeats the user's prompt (the
      // event_msg user_message already renders it) or wraps context in tags. Neither
      // is the assistant speaking, and rendering them as such makes the user's own
      // words look like the assistant's proposal.
      if (p.role === "developer") { out.push(`**system:** ${txt.trim()}`); break; }
      if (p.role === "user") { if (txt.trimStart().startsWith("<")) out.push(`**system:** ${txt.trim()}`); break; }
      out.push(`**assistant:** ${txt.trim()}`);
      break;
    }
    case "reasoning": if (opts.includeThinking) { const t = asText(p.summary ?? p.text); if (t.trim()) out.push(`_(thinking)_ ${clip(t, 1200, ref)}`); }
      break;
    case "tool_use": out.push(`→ **${p.name ?? "tool"}** ${clip(asText(p.arguments ?? p.input), 400, ref)}`); break;
    case "tool_result": out.push(`  ⤷ ${clip(asText(p.output ?? p.result ?? p.content), resultCap, ref)}`); break;
  }
  return out;
}

/** Extract + redact pieces for every event, one pass. */
export function extractPieces(events: CarafeEvent[], opts: PieceOpts, hits: Record<string, number>): EventPieces[] {
  return events.map((ev) => {
    const lines = rawPieces(ev, opts).map((l) => {
      const r = redactText(l);
      mergeHits(hits, r.hits);
      return r.text;
    });
    return { seq: ev.seq, kind: ev.kind, lines, chars: lines.reduce((a, l) => a + l.length, 0), ts: ev.ts ?? null };
  });
}

/** First meaningful line of a user event, for map/directory entries. */
export function firstLineOf(p: EventPieces): string {
  const l = p.lines[0] ?? "";
  return l.replace(/^\*\*[a-z]+:\*\*\s*/i, "").split("\n")[0]!.slice(0, 90);
}

/** Deterministic file-path extraction from a tool_use event (CC + Codex). */
export function filesOf(ev: CarafeEvent): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (path: string): void => {
    if (!path || seen.has(path)) return;
    seen.add(path);
    out.push(path);
  };
  const scanPatch = (patch: string): void => {
    if (!patch.includes("*** Begin Patch")) return;
    const re = /^\*\*\* (?:Update File|Add File|Delete File|Move to):\s*(.+?)\s*$/gm;
    let match: RegExpExecArray | null;
    while ((match = re.exec(patch)) !== null) add(match[1] ?? "");
  };
  const scanCommand = (command: string): void => {
    const commandRe = /(?:^|[;&|]\s*|\n)\s*(?:sudo\s+)?(?:[A-Za-z_][A-Za-z0-9_]*=\S+\s+)*(?:sed|cat|head|tail|rg|grep)\b([^;&|\n]*)/gim;
    let commandMatch: RegExpExecArray | null;
    let found = 0;
    while (found < 3 && (commandMatch = commandRe.exec(command)) !== null) {
      const tokens = (commandMatch[1] ?? "").match(/[^\s]+/g) ?? [];
      for (const token of tokens) {
        if (found >= 3) break;
        if (token.includes("://") || token.includes("node_modules")) continue;
        const pathRe = /[\w./-]+\.[a-z0-9]{1,6}/gi;
        let pathMatch: RegExpExecArray | null;
        while (found < 3 && (pathMatch = pathRe.exec(token)) !== null) {
          const path = pathMatch[0];
          if (path.includes("node_modules") || seen.has(path)) continue;
          add(path);
          found++;
        }
      }
    }
  };
  const scan = (input: any): void => {
    if (!input || typeof input !== "object") return;
    if (typeof input.file_path === "string") add(input.file_path);
    if (typeof input.path === "string") add(input.path);
    if (typeof input.input === "string") scanPatch(input.input);
    if (typeof input.patch === "string") scanPatch(input.patch);
    const command = input.cmd ?? input.command;
    if (typeof command === "string") scanCommand(command);
    else if (Array.isArray(command) && command.every((part) => typeof part === "string")) scanCommand(command.join(" "));
  };
  const raw: any = ev.raw;
  if (ev.tool === "claude-code") {
    const content = raw?.message?.content;
    if (Array.isArray(content)) for (const i of content) if (i?.type === "tool_use") scan(i.input);
  } else if (ev.kind === "tool_use") {
    const p = raw?.payload ?? {};
    let args = p.arguments ?? p.input;
    if (typeof args === "string") {
      const rawArguments = args;
      try { args = JSON.parse(args); } catch { args = null; }
      if (typeof args === "string") scanPatch(args);
      else scan(args);
      if (rawArguments.includes("*** Begin Patch")) scanPatch(rawArguments);
    } else scan(args);
  }
  return out;
}

/** A handoff must not quote its own making. These are the commands that render
 *  this session (`carafe handoff|key-moments|show`), aimed at THIS session —
 *  by id, by a ≥6-char prefix of it, or by the `current`/`latest` aliases that
 *  resolve to it when the session is the one being worked in. */
const SELF_COMMAND_RE = /\bcarafe\s+(?:handoff|key-moments|show)\b([^\n]*)/gi;
/**
 * The truncation marker this very module writes — `[…N more chars — carafe show
 * <id> --seq N --max-chars 0]`. It names the session, so a LONG tool call ended
 * up looking exactly like a call that generates this handoff, and the whole call
 * (and its result) was deleted from the file. A marker is the renderer talking
 * about the trace; it is never part of the command.
 */
const CLIP_MARKER_RE = /\[…[^\]]*?more chars[^\]]*?\]/g;
export function isSelfGenerationLine(line: string, sessionId: string): boolean {
  if (!line.startsWith("→ **")) return false;
  const text = line.replace(CLIP_MARKER_RE, " ");
  SELF_COMMAND_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = SELF_COMMAND_RE.exec(text)) !== null) {
    const args = match[1] ?? "";
    if (/\b(?:current|latest)\b/.test(args)) return true;
    if (sessionId.length >= 6) {
      for (const token of args.match(/[A-Za-z0-9_-]{6,}/g) ?? []) {
        if (sessionId.startsWith(token) || token.startsWith(sessionId)) return true;
      }
    }
  }
  return false;
}

/**
 * Drop every self-generation tool call and the result it produced. Results
 * arrive in a later piece than their call, so the drop carries across pieces.
 */
export function withoutSelfGeneration(pieces: EventPieces[], sessionId: string): EventPieces[] {
  let dropNextResult = false;
  let changed = false;
  const out = pieces.map((piece) => {
    const kept: string[] = [];
    for (const line of piece.lines) {
      if (isSelfGenerationLine(line, sessionId)) { dropNextResult = true; changed = true; continue; }
      if (dropNextResult && line.trimStart().startsWith("⤷")) { dropNextResult = false; changed = true; continue; }
      if (line.startsWith("→ **")) dropNextResult = false;
      kept.push(line);
    }
    if (kept.length === piece.lines.length) return piece;
    return { ...piece, lines: kept, chars: kept.reduce((sum, line) => sum + line.length, 0) };
  });
  return changed ? out : pieces;
}
