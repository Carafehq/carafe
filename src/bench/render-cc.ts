import { int, mulberry32 } from "./prng";
import type { Beat, BeatId, SessionPlan } from "./plan";

export interface RenderIds { sessionId: string; }
export interface RenderedTrace { jsonl: string[]; beatSeqs: Map<BeatId, [number, number]>; }

function uuid(seed: number, n: number): string {
  const r = mulberry32(seed ^ Math.imul(n + 1, 0x45d9f3b));
  const hex = () => Math.floor(r() * 0x100000000).toString(16).padStart(8, "0");
  const h = `${hex()}${hex()}${hex()}${hex()}`;
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

function iso(ms: number): string { return new Date(ms).toISOString(); }
function toolName(name: Extract<Beat, { kind: "tool" }>['name']): string {
  return name === "shell" ? "Bash" : name === "read" ? "Read" : name === "grep" ? "Grep" : name === "edit" ? "Edit" : "Write";
}
function toolInput(beat: Extract<Beat, { kind: "tool" }>): Record<string, unknown> {
  if (beat.name === "shell") return { command: beat.input.command ?? "", description: "Run the command" };
  if (beat.name === "read") return { file_path: beat.input.path ?? "" };
  if (beat.name === "grep") return { pattern: beat.input.pattern ?? "", path: beat.input.path ?? "" };
  if (beat.name === "edit") return { file_path: beat.input.path ?? "", old_string: beat.input.oldText ?? "", new_string: beat.input.newText ?? "" };
  return { file_path: beat.input.path ?? "", content: beat.input.content ?? "" };
}

export function renderClaudeCode(plan: SessionPlan, ids: RenderIds): RenderedTrace {
  const lines: string[] = [];
  const beatSeqs = new Map<BeatId, [number, number]>();
  const rng = mulberry32(plan.seed ^ 0x9e3779b9);
  let clock = Date.parse(plan.startTs);
  let previous: string | null = null;
  let currentCwd = plan.cwd;
  const put = (obj: Record<string, unknown>): number => { lines.push(JSON.stringify(obj)); return lines.length - 1; };
  const common = (uuidValue: string, timestamp: string): Record<string, unknown> => ({ parentUuid: previous, isSidechain: false, uuid: uuidValue, timestamp, cwd: currentCwd, sessionId: ids.sessionId, version: "2.1.205", gitBranch: plan.branch });
  put({ type: "ai-title", aiTitle: plan.title, sessionId: ids.sessionId });
  put({ type: "custom-title", customTitle: plan.title, sessionId: ids.sessionId });
  put({ type: "last-prompt", lastPrompt: (plan.beats[0] as Extract<Beat, { kind: "user" }>).text, leafUuid: uuid(plan.seed, 0), sessionId: ids.sessionId });
  for (let beatId = 0; beatId < plan.beats.length; beatId++) {
    const beat = plan.beats[beatId]!;
    if (beat.kind === "gap") { clock += beat.hours * 60 * 60 * 1000; beatSeqs.set(beatId, [lines.length, lines.length - 1]); continue; }
    if (beat.kind === "token") { beatSeqs.set(beatId, [lines.length, lines.length - 1]); continue; }
    const start = lines.length;
    const nextTime = (): string => { clock += int(rng, 2, 40) * 1000; return iso(clock); };
    if (beat.kind === "user") {
      const raw = common(uuid(plan.seed, beatId * 5 + 1), nextTime());
      raw.type = "user"; raw.message = { role: "user", content: beat.text }; if (beat.systemInjected) raw.isMeta = true;
      previous = String(raw.uuid); put(raw);
    } else if (beat.kind === "assistant") {
      if (beat.thinking) {
        const thinking = common(uuid(plan.seed, beatId * 5 + 2), nextTime());
        thinking.type = "assistant"; thinking.message = { model: "claude-opus-5", id: `msg_${uuid(plan.seed, beatId).replaceAll("-", "")}`, type: "message", role: "assistant", content: [{ type: "thinking", thinking: beat.thinking }], stop_reason: null, usage: { input_tokens: 32, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: Math.ceil(beat.thinking.length / 4) } };
        thinking.requestId = `req_${uuid(plan.seed, beatId)}`; thinking.type = "assistant"; previous = String(thinking.uuid); put(thinking);
      }
      const raw = common(uuid(plan.seed, beatId * 5 + 3), nextTime());
      raw.type = "assistant"; raw.message = { model: "claude-opus-5", id: `msg_${uuid(plan.seed, beatId).replaceAll("-", "")}`, type: "message", role: "assistant", content: [{ type: "text", text: beat.text }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: Math.ceil((beat.text.length + beatId * 11) / 4), cache_creation_input_tokens: 0, cache_read_input_tokens: Math.floor((beat.text.length + beatId * 11) * 0.9 / 4), output_tokens: Math.ceil(beat.text.length / 4), cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 } } };
      raw.requestId = `req_${uuid(plan.seed, beatId)}`; previous = String(raw.uuid); put(raw);
    } else if (beat.kind === "tool") {
      const callId = `toolu_${uuid(plan.seed, beatId).replaceAll("-", "")}`;
      const call = common(uuid(plan.seed, beatId * 5 + 4), nextTime());
      call.type = "assistant"; call.message = { model: "claude-opus-5", id: `msg_${uuid(plan.seed, beatId).replaceAll("-", "")}`, type: "message", role: "assistant", content: [{ type: "tool_use", id: callId, name: toolName(beat.name), input: toolInput(beat) }], stop_reason: "tool_use", stop_sequence: null, usage: { input_tokens: Math.ceil((beat.input.command ?? beat.input.path ?? beat.input.pattern ?? "").length / 4), cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 12, cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 } } };
      call.requestId = `req_${uuid(plan.seed, beatId)}`; previous = String(call.uuid); put(call);
      const result = common(uuid(plan.seed, beatId * 5 + 5), nextTime());
      result.type = "user"; result.message = { role: "user", content: [{ tool_use_id: callId, type: "tool_result", content: beat.output, is_error: beat.exitCode !== 0 }] }; previous = String(result.uuid); put(result);
      const cwdChange = beat.name === "shell" ? beat.input.command?.match(/^cd (services\/[^ ]+) && git status --short$/) : null;
      if (cwdChange) currentCwd = `${plan.cwd}/${cwdChange[1]}`;
    } else if (beat.kind === "popup") {
      const callId = `toolu_${uuid(plan.seed, beatId).replaceAll("-", "")}`;
      const call = common(uuid(plan.seed, beatId * 5 + 6), nextTime());
      call.type = "assistant"; call.message = { model: "claude-opus-5", id: `msg_${uuid(plan.seed, beatId).replaceAll("-", "")}`, type: "message", role: "assistant", content: [{ type: "tool_use", id: callId, name: "AskUserQuestion", input: { questions: [{ question: beat.question, header: beat.header, multiSelect: false, options: beat.options.map((label) => ({ label, description: `Use ${label} for this decision` })) }] } }], stop_reason: "tool_use", stop_sequence: null, usage: { input_tokens: 40, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 30, cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 } } };
      previous = String(call.uuid); put(call);
      const result = common(uuid(plan.seed, beatId * 5 + 7), nextTime());
      result.type = "user"; result.message = { role: "user", content: [{ tool_use_id: callId, type: "tool_result", content: beat.answer == null ? "The user doesn't want to proceed with this tool use. The tool use was rejected." : `User has answered your questions: "${beat.question}"="${beat.answer}". You can now continue with the user's answers in mind.`, is_error: beat.answer == null }] };
      previous = String(result.uuid); put(result);
    } else if (beat.kind === "prlink") {
      put({ type: "pr-link", sessionId: ids.sessionId, prNumber: beat.number, prUrl: beat.url, prRepository: plan.repo, timestamp: nextTime() });
    }
    beatSeqs.set(beatId, [start, lines.length - 1]);
  }
  return { jsonl: lines, beatSeqs };
}
