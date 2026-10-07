import { int, mulberry32 } from "./prng";
import type { Beat, BeatId, SessionPlan } from "./plan";
import type { RenderIds, RenderedTrace } from "./render-cc";

function iso(ms: number): string { return new Date(ms).toISOString(); }
function uuid(seed: number, n: number): string {
  const r = mulberry32(seed ^ Math.imul(n + 9, 0x27d4eb2d));
  const h = Array.from({ length: 4 }, () => Math.floor(r() * 0x100000000).toString(16).padStart(8, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-b${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
function commandFor(beat: Extract<Beat, { kind: "tool" }>): string {
  if (beat.name === "shell") return beat.input.command ?? "";
  if (beat.name === "read") return `sed -n '1,200p' ${beat.input.path ?? ""}`;
  if (beat.name === "grep") return `rg -n "${beat.input.pattern ?? ""}" ${beat.input.path ?? ""}`;
  if (beat.name === "edit") return `*** Begin Patch\n*** Update File: ${beat.input.path ?? ""}\n@@\n-${beat.input.oldText ?? ""}\n+${beat.input.newText ?? ""}\n*** End Patch\n`;
  return `*** Begin Patch\n*** Add File: ${beat.input.path ?? ""}\n@@\n+${beat.input.content ?? ""}\n*** End Patch\n`;
}
function payload(timestamp: string, type: string, p: Record<string, unknown>): string { return JSON.stringify({ timestamp, type, payload: p }); }

export function renderCodex(plan: SessionPlan, ids: RenderIds): RenderedTrace {
  const lines: string[] = [];
  const beatSeqs = new Map<BeatId, [number, number]>();
  const rng = mulberry32(plan.seed ^ 0x85ebca6b);
  let clock = Date.parse(plan.startTs);
  let previousTurn = "";
  let totalInput = 0, totalCached = 0, totalOutput = 0, turnCount = 0;
  let currentCwd = plan.cwd;
  const put = (type: string, p: Record<string, unknown>, advance = true): number => { if (advance) clock += int(rng, 2, 40) * 1000; lines.push(payload(iso(clock), type, p)); return lines.length - 1; };
  put("session_meta", { id: ids.sessionId, timestamp: plan.startTs, cwd: plan.cwd, originator: "codex_cli_rs", cli_version: "0.125.0", model_provider: "openai", git: { commit_hash: "4d2c1ab".repeat(8).slice(0, 40), branch: plan.branch, repository_url: `https://github.com/${plan.repo}.git` } }, false);
  for (let beatId = 0; beatId < plan.beats.length; beatId++) {
    const beat = plan.beats[beatId]!;
    if (beat.kind === "gap") { clock += beat.hours * 60 * 60 * 1000; beatSeqs.set(beatId, [lines.length, lines.length - 1]); continue; }
    if (beat.kind === "token") {
      totalCached = Math.floor(totalInput * 0.9);
      put("event_msg", { type: "token_count", info: { total_token_usage: { input_tokens: totalInput + totalCached, cached_input_tokens: totalCached, output_tokens: totalOutput, reasoning_output_tokens: 0, total_tokens: totalInput + totalCached + totalOutput }, last_token_usage: { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0, total_tokens: 0 } }, rate_limits: null });
      beatSeqs.set(beatId, [lines.length - 1, lines.length - 1]); continue;
    }
    const start = lines.length;
    if (beat.kind === "user") {
      if (beat.systemInjected) {
        put("response_item", { type: "message", role: "developer", content: [{ type: "input_text", text: beat.text }] });
      } else {
        turnCount++;
        previousTurn = uuid(plan.seed, beatId);
        put("turn_context", { turn_id: previousTurn, cwd: currentCwd, model: "gpt-5.5", effort: "medium", summary: "none" });
        put("event_msg", { type: "user_message", message: beat.text, images: [], local_images: [], text_elements: [] });
      }
    } else if (beat.kind === "assistant") {
      put("event_msg", { type: "agent_message", message: beat.text });
      totalOutput += Math.ceil(beat.text.length / 4);
    } else if (beat.kind === "tool") {
      const callId = `call_${uuid(plan.seed, beatId).replaceAll("-", "")}`;
      const fn = beat.name === "edit" || beat.name === "write" ? "apply_patch" : "exec_command";
      const args = fn === "apply_patch" ? { input: commandFor(beat) } : { cmd: commandFor(beat), workdir: currentCwd, yield_time_ms: 30000, max_output_tokens: 50000 };
      put("response_item", { type: "function_call", name: fn, arguments: JSON.stringify(args), call_id: callId });
      const output = `Chunk ID: ${uuid(plan.seed, beatId + 200).slice(0, 8)}\nProcess exited with code ${beat.exitCode}\nOriginal token count: ${Math.ceil(beat.output.length / 4)}\nOutput:\n${beat.output}`;
      put("response_item", { type: "function_call_output", call_id: callId, output });
      const cwdChange = beat.name === "shell" ? beat.input.command?.match(/^cd (services\/[^ ]+) && git status --short$/) : null;
      if (cwdChange) currentCwd = `${plan.cwd}/${cwdChange[1]}`;
      totalInput += Math.ceil((beat.input.command ?? beat.input.path ?? beat.input.pattern ?? "").length / 4);
      totalOutput += Math.ceil(beat.output.length / 4);
    } else if (beat.kind === "popup") {
      put("event_msg", { type: "agent_message", message: `${beat.question} Options: ${beat.options.join(", ")}.` });
      if (beat.answer != null) {
        const answer = [`Let's go with ${beat.answer}.`, `${beat.answer}, please.`, `Use ${beat.answer}.`, `Go with ${beat.answer}.`][int(rng, 0, 3)]!;
        put("turn_context", { turn_id: uuid(plan.seed, beatId + 500), cwd: currentCwd, model: "gpt-5.5", effort: "medium", summary: "none" });
        put("event_msg", { type: "user_message", message: answer, images: [], local_images: [], text_elements: [] });
      }
      totalOutput += 20;
    } else if (beat.kind === "prlink") {
      // Codex has no separate PR-link meta record; the preceding shell output is the evidence.
    }
    beatSeqs.set(beatId, [start, lines.length - 1]);
  }
  void previousTurn;
  return { jsonl: lines, beatSeqs };
}
