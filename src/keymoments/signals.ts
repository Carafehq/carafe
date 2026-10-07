import type { CarafeEvent } from "../format/events";
import { buildBlocks } from "../handoff/blocks";
import { filesOf, type EventPieces } from "../handoff/pieces";

export interface SignalBlock {
  startSeq: number;
  endSeq: number;
  files: Set<string>;
  userLine: string | null;
  /** the seq of the event `userLine` was read from — a block's startSeq is the
   *  turn's first event, which is not always the one carrying the words */
  userSeq: number | null;
  assistantLines: Array<{ seq: number; text: string }>;
}

export interface ToolRun {
  toolSeq: number;
  resultSeq: number;
  toolLine: string;
  resultLine: string;
  toolName: string | null;
  command: string | null;
  family: string | null;
  files: string[];
  blockIndex: number;
  readish: boolean;
  failed: boolean;
  succeeded: boolean;
}

export interface EditAction {
  seq: number;
  endSeq: number;
  blockIndex: number;
  files: string[];
  text: string;
}

export interface FailureStreak {
  family: string;
  failures: ToolRun[];
  success: ToolRun | null;
  edits: EditAction[];
}

export interface SignalContext {
  blocks: SignalBlock[];
  runs: ToolRun[];
  edits: EditAction[];
  streaks: FailureStreak[];
}

const RICH_FAIL_RE = /error TS\d|Traceback \(most recent call last\)|\bfatal:|\bnpm ERR!|\bAssertionError\b|\bFAIL\b|panic:|✗|✖/;
const EXIT_FAIL_RE = /\bexit(?:ed with)? code [1-9]\d*\b/i;
const SUCCESS_RE = /\bexit(?:ed with)? code 0\b|\b0 failed\b/i;
const HARNESS_ERROR_RE = /<tool_use_error>|Permission for this action was denied|The user doesn't want to proceed/i;

const unescapeJson = (s: string): string =>
  s.replace(/\\n|\\t|\\r/g, " ").replace(/\\"/g, '"').replace(/\\\\/g, "\\").replace(/\s+/g, " ").trim();

/** Extract a shell command from a rendered tool line, for either harness. */
export function commandOf(line: string): string | null {
  const match = /^→ \*\*[^*]+\*\*\s*([\s\S]*)$/.exec(line);
  if (!match) return null;
  const rest = match[1] ?? "";
  // Multi-line scripts keep their line structure as `;` separators: collapsing a
  // newline into a space glues `cd "$PS"` onto the next line's command and the
  // family logic then sees one meaningless token.
  const flatten = (text: string): string => text.replace(/\\\r?\n/g, " ").replace(/\r?\n+/g, " ; ").replace(/\s+/g, " ").replace(/(?:\s*;\s*){2,}/g, " ; ").trim();
  const commandValue = (value: unknown): string | null => {
    if (typeof value === "string") return flatten(value);
    if (Array.isArray(value) && value.every((part) => typeof part === "string")) return flatten(value.join(" "));
    return null;
  };
  try {
    const parsed = JSON.parse(rest) as Record<string, unknown>;
    const command = commandValue(parsed?.cmd ?? parsed?.command);
    if (command != null) return command;
  } catch { /* clipped legacy lines fall through */ }
  const stringField = /"(?:cmd|command)"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(rest);
  return stringField?.[1] != null ? unescapeJson(stringField[1]) : null;
}

const RUNNERS = new Set(["bun", "npm", "npx", "pnpm", "yarn", "cargo", "go", "python", "pytest", "make", "git", "gh", "node", "deno", "tsc", "vitest", "jest"]);

export function commandFamily(command: string): string {
  const segments = command.split(/&&|\|\||[;|]/).map((segment) => segment.trim()).filter(Boolean);
  const skipped = /^(?:cd|pushd|export|source|set|env|true|echo|printf|sleep)$/i;
  // `FOO=1 bun test` and `PS="/x"; cd "$PS"` — assignments are not commands.
  const stripAssignments = (segment: string): string => segment.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s*)+/, "").trim();
  const wordy = (token: string): boolean => /^[A-Za-z][\w.+-]*$/.test(token.replace(/^.*\//, ""));
  const candidates = segments.map(stripAssignments).filter(Boolean);
  const segment = candidates.find((candidate) => {
    const token = candidate.match(/^(?:[^\s"']+|"[^"]*"|'[^']*')/)?.[0] ?? "";
    return wordy(token) && !skipped.test(token.replace(/^.*\//, ""));
  }) ?? candidates.find((candidate) => wordy(candidate.split(/\s+/, 1)[0] ?? "")) ?? candidates[0] ?? command.trim();
  const tokens = segment.toLowerCase().match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
  const first = (tokens[0] ?? "").replace(/^.*\//, "");
  if (!RUNNERS.has(first) || first === "pytest") return first;
  const argumentsWithoutFlags = tokens.slice(1).filter((token) => !token.startsWith("-")).map((token) => token.replace(/^['"]|['"]$/g, ""));
  if (/^(?:npm|bun|yarn)$/.test(first) && argumentsWithoutFlags[0] === "run") {
    const script = argumentsWithoutFlags[1];
    if (script && /^[a-z][a-z0-9:_-]*$/.test(script)) return `${first} run ${script}`;
  }
  // A runner's family is its subcommand (`bun test`, `git status`, `npm run`), never a
  // file or path argument (`node script.js`, `python -m pytest tests/`).
  const argument = argumentsWithoutFlags[0];
  return argument && /^[a-z][a-z0-9:_-]*$/.test(argument) ? `${first} ${argument}` : first;
}

export function toolNameOf(line: string): string | null {
  return /^→ \*\*([^*]+)\*\*/.exec(line)?.[1]?.trim() ?? null;
}

export function isReadish(command: string | null, toolName: string | null): boolean {
  if (toolName != null && /^(Read|Grep|Glob|read_file)$/i.test(toolName)) return true;
  if (!command) return false;
  const first = command.trim().split(/\s+/, 1)[0]?.replace(/^.*\//, "").toLowerCase() ?? "";
  return /^(cat|sed|head|tail|less|more|grep|rg|ls|find|awk|wc|tree|stat|file)$/.test(first);
}

export function isFailResult(line: string): boolean {
  if (SUCCESS_RE.test(line)) return false;
  return RICH_FAIL_RE.test(line) || EXIT_FAIL_RE.test(line);
}

export function isSuccessResult(line: string): boolean {
  return SUCCESS_RE.test(line) && !isFailResult(line);
}

export function isHarnessError(line: string): boolean {
  return HARNESS_ERROR_RE.test(line);
}

export function failExcerpt(resultLine: string): string {
  const body = resultLine.replace(/^\s*⤷\s*/, "");
  const lines = body.split("\n").map((line) => line.trim()).filter(Boolean);
  const rich = lines.find((line) => RICH_FAIL_RE.test(line));
  if (rich) return clip(rich, 200);
  const exit = lines.find((line) => EXIT_FAIL_RE.test(line));
  if (exit) return clip(exit, 200);
  return clip(lines[0] ?? body, 200);
}

export function isAck(userText: string): boolean {
  const text = userText.trim();
  return text.length <= 40 && /^(ok(ay)?|k(?:,? next)?|yes|yep|yeah|sure|fine|go( on| ahead)?|continue|next|proceed|do it|looks good(?:,? go on)?|sounds good|lgtm|thanks(?:,? carry on)?|ty|great|perfect|cool|👍)[.! ]*$/i.test(text);
}

export function isAffirmative(userText: string): boolean {
  const text = userText.trim();
  return isAck(text) || (text.length <= 200 && /^(yes|yeah|ok|sure|do it|go ahead|sounds good|agreed|approved|proceed|let's do|go with)\b/i.test(text));
}

export function isRefusal(userText: string): boolean {
  const text = userText.trim();
  return /^(no|nope|don't|do not|not that|stop|wait|hold on|keep)\b/i.test(text)
    || /\b(don't do that|leave it|as it is|revert that)\b/i.test(text);
}

export function hasChoiceCue(userText: string): boolean {
  return /\b(let's go with|go with|instead|rather than|switch to|we'll use|use \w+ (?:for|instead)|decided|decision|prefer|option [a-z0-9]|pick)\b/i.test(userText);
}

const STOPWORDS = new Set(["a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "in", "is", "it", "of", "on", "or", "please", "that", "the", "this", "to", "we", "with", "you"]);

export function normalizeSentence(sentence: string): string {
  return sentence.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim().split(" ").filter((word) => word && !STOPWORDS.has(word)).join(" ");
}

export function tokenJaccard(a: string | Set<string>, b: string | Set<string>): number {
  const left = typeof a === "string" ? new Set(a.split(/\s+/).filter(Boolean)) : a;
  const right = typeof b === "string" ? new Set(b.split(/\s+/).filter(Boolean)) : b;
  if (!left.size && !right.size) return 1;
  let intersection = 0;
  for (const token of left) if (right.has(token)) intersection++;
  return intersection / (left.size + right.size - intersection);
}

export function fileSetOf(blocks: SignalBlock[]): Set<string> {
  return new Set(blocks.flatMap((block) => [...block.files]));
}

export function buildSignalBlocks(events: CarafeEvent[], pieces: EventPieces[]): SignalBlock[] {
  const blocks = buildBlocks(events, pieces);
  const pieceBySeq = new Map(pieces.map((piece) => [piece.seq, piece]));
  const out: SignalBlock[] = blocks.map((block) => ({ startSeq: block.startSeq, endSeq: block.endSeq, files: new Set<string>(), userLine: null, userSeq: null, assistantLines: [] }));
  let blockIndex = 0;
  for (const event of events) {
    while (blockIndex + 1 < out.length && event.seq >= out[blockIndex + 1]!.startSeq) blockIndex++;
    const block = out[blockIndex];
    if (!block || event.seq < block.startSeq || event.seq > block.endSeq) continue;
    for (const file of filesOf(event)) block.files.add(file);
    for (const line of pieceBySeq.get(event.seq)?.lines ?? []) {
      if (block.userLine == null && line.startsWith("**user:**")) { block.userLine = line; block.userSeq = event.seq; }
      if (line.startsWith("**assistant:**")) block.assistantLines.push({ seq: event.seq, text: line });
    }
  }
  return out;
}

/** Tool/result pairs in trace order. Tool calls without a rendered result are
 * intentionally omitted because their outcome is unknown. */
export function toolRuns(events: CarafeEvent[], pieces: EventPieces[], blocks = buildSignalBlocks(events, pieces)): ToolRun[] {
  const eventBySeq = new Map(events.map((event) => [event.seq, event]));
  const pending: Array<{ seq: number; line: string; name: string | null; command: string | null; files: string[]; blockIndex: number; tool: string }> = [];
  const runs: ToolRun[] = [];
  let blockIndex = 0;
  for (const piece of pieces) {
    while (blockIndex + 1 < blocks.length && piece.seq >= blocks[blockIndex + 1]!.startSeq) blockIndex++;
    for (const line of piece.lines) {
      if (line.startsWith("→ **")) {
        const command = commandOf(line);
        const event = eventBySeq.get(piece.seq)!;
        pending.push({ seq: piece.seq, line, name: toolNameOf(line), command, files: filesOf(event).slice(), blockIndex, tool: event.tool });
      } else if (line.trimStart().startsWith("⤷") && pending.length) {
        const tool = pending.shift()!;
        const readish = isReadish(tool.command, tool.name);
        const harnessError = isHarnessError(line);
        const failed = !readish && !harnessError && isFailResult(line);
        runs.push({
          toolSeq: tool.seq,
          resultSeq: piece.seq,
          toolLine: tool.line,
          resultLine: line,
          toolName: tool.name,
          command: tool.command,
          family: tool.command ? commandFamily(tool.command) : null,
          files: tool.files,
          blockIndex: tool.blockIndex,
          readish,
          failed,
          succeeded: !readish && !harnessError && (tool.tool === "claude-code" ? !failed : isSuccessResult(line)),
        });
      }
    }
  }
  return runs;
}

function blockIndexFor(seq: number, blocks: SignalBlock[]): number {
  let low = 0;
  let high = blocks.length - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const block = blocks[middle]!;
    if (seq < block.startSeq) high = middle - 1;
    else if (seq > block.endSeq) low = middle + 1;
    else return middle;
  }
  return Math.max(0, Math.min(blocks.length - 1, low));
}

export function editActions(events: CarafeEvent[], pieces: EventPieces[], blocks = buildSignalBlocks(events, pieces)): EditAction[] {
  const eventBySeq = new Map(events.map((event) => [event.seq, event]));
  const actions: EditAction[] = [];
  for (let index = 0; index < pieces.length; index++) {
    const piece = pieces[index]!;
    const line = piece.lines.find((candidate) => candidate.startsWith("→ **"));
    if (!line) continue;
    const name = toolNameOf(line) ?? "";
    if (!/^(Edit|Write|apply_patch)$/i.test(name)) continue;
    const files = filesOf(eventBySeq.get(piece.seq)!).slice();
    if (!files.length) continue;
    const next = pieces[index + 1];
    const resultSeq = next?.lines.some((candidate) => candidate.trimStart().startsWith("⤷")) ? next.seq : piece.seq;
    actions.push({
      seq: piece.seq,
      endSeq: resultSeq,
      blockIndex: blockIndexFor(piece.seq, blocks),
      files,
      text: cleanToolExcerpt(line),
    });
  }
  return actions;
}

export function buildFailureStreaks(blocks: SignalBlock[], runs: ToolRun[], edits: EditAction[]): FailureStreak[] {
  const commandRuns = runs.filter((run) => run.family != null && !run.readish && !/^(?:git|gh)(?:\s|$)/.test(run.family));
  const streaks: FailureStreak[] = [];
  for (let index = 0; index < commandRuns.length;) {
    const first = commandRuns[index]!;
    if (!first.failed) { index++; continue; }
    const failures = [first];
    let cursor = index + 1;
    while (cursor < commandRuns.length) {
      const run = commandRuns[cursor]!;
      if (run.blockIndex !== first.blockIndex || run.family !== first.family || !run.failed) break;
      failures.push(run);
      cursor++;
    }
    if (failures.length >= 2) {
      const last = failures.at(-1)!;
      const lastAllIndex = runs.indexOf(last);
      let success: ToolRun | null = null;
      for (let look = lastAllIndex + 1; look < runs.length && look <= lastAllIndex + 12; look++) {
        const run = runs[look]!;
        if (run.blockIndex !== first.blockIndex) break;
        if (run.family === first.family && run.succeeded) { success = run; break; }
      }
      const previousCommand = index > 0 && commandRuns[index - 1]!.blockIndex === first.blockIndex ? commandRuns[index - 1] : null;
      const startSeq = previousCommand ? previousCommand.resultSeq + 1 : blocks[first.blockIndex]?.startSeq ?? first.toolSeq;
      const endSeq = success?.toolSeq ?? last.resultSeq;
      streaks.push({ family: first.family!, failures, success, edits: edits.filter((edit) => edit.blockIndex === first.blockIndex && edit.seq >= startSeq && edit.seq <= endSeq) });
    }
    index = cursor;
  }
  return streaks;
}

export function buildSignalContext(events: CarafeEvent[], pieces: EventPieces[]): SignalContext {
  const blocks = buildSignalBlocks(events, pieces);
  const runs = toolRuns(events, pieces, blocks);
  const edits = editActions(events, pieces, blocks);
  return { blocks, runs, edits, streaks: buildFailureStreaks(blocks, runs, edits) };
}

export function stripRolePrefix(line: string): string {
  return line.replace(/^\*\*(?:user|assistant):\*\*\s*/i, "").trim();
}

export function clip(text: string, length: number): string {
  return text.length <= length ? text : `${text.slice(0, Math.max(0, length - 1))}…`;
}

export function cleanToolExcerpt(line: string): string {
  const match = /^→ \*\*([^*]+)\*\*\s*([\s\S]*)$/.exec(line);
  if (!match) return clip(line, 200);
  const tool = match[1]!.trim();
  const rest = match[2] ?? "";
  const grab = (re: RegExp): string | null => {
    const found = re.exec(rest);
    return found?.[1] != null ? unescapeJson(found[1]) : null;
  };
  let salient = commandOf(line)
    ?? grab(/"pattern"\s*:\s*"((?:[^"\\]|\\.)*)"/)
    ?? grab(/"(?:file_path|path)"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  let editDetail = grab(/"(?:new_string|content)"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  if (editDetail == null && /^(?:apply_patch)$/i.test(tool)) {
    try {
      const parsed = JSON.parse(rest) as { input?: unknown };
      if (typeof parsed.input === "string") editDetail = parsed.input.split("\n").map((part) => part.trim()).find((part) => /^\+(?!\+\+)/.test(part))?.slice(1).trim() ?? null;
    } catch { /* clipped patch; the path fallback below remains useful */ }
  }
  if (salient == null) {
    const file = /\*\*\* (?:Update|Add|Delete) File:\s*(.+?)(?:\\n|\n|$)/.exec(rest)?.[1];
    if (file) salient = file.trim();
  }
  if (salient == null) salient = rest.replace(/\s+/g, " ").trim();
  if (editDetail && /^(?:Edit|Write|apply_patch)$/i.test(tool)) salient = `${salient} — ${editDetail}`;
  return `${tool}: ${clip(salient, 200)}`;
}
