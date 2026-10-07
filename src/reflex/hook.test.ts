import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { CarafeStore } from "../format/store";
import { writeDistillate } from "../format/distillate";
import { sealSession } from "../format/sessions";
import { buildSessionIndex } from "../search/session-index";
import { fixtureSession } from "./reflex.test";
import { armReflex } from "./state";

let root = "";
let oldHome: string | undefined;
const cli = join(import.meta.dir, "..", "cli", "index.ts");

function hook(stdin: string): { stdout: string; stderr: string; exitCode: number; ms: number } {
  const started = performance.now();
  const result = Bun.spawnSync([process.execPath, "run", cli, "reflex", "--hook"], {
    env: { ...process.env, CARAFE_HOME: root, CARAFE_NO_UPDATE_CHECK: "1" },
    stdin: new TextEncoder().encode(stdin), stdout: "pipe", stderr: "pipe",
  });
  return { stdout: new TextDecoder().decode(result.stdout), stderr: new TextDecoder().decode(result.stderr), exitCode: result.exitCode, ms: performance.now() - started };
}

beforeEach(() => { root = mkdtempSync(join(tmpdir(), "carafe-reflex-hook-")); oldHome = process.env.CARAFE_HOME; process.env.CARAFE_HOME = root; });
afterEach(() => { if (oldHome === undefined) delete process.env.CARAFE_HOME; else process.env.CARAFE_HOME = oldHome; rmSync(root, { recursive: true, force: true }); });

describe("carafe reflex --hook (Claude Code UserPromptSubmit seam)", () => {
  test("an armed cwd answers with additionalContext JSON; everything else is silent with exit 0", () => {
    const store = new CarafeStore(root);
    const { session, events } = fixtureSession(store);
    armReflex(store, session, { armedAtSeq: events.at(-1)!.seq, tailStartSeq: events.at(-1)!.seq + 1 });

    const fired = hook(JSON.stringify({ session_id: "receiver-1", transcript_path: "/tmp/t.jsonl", cwd: "/tmp/reflex-project/packages/api", hook_event_name: "UserPromptSubmit", user_prompt: "I'm about to change src/auth/service.ts again", prompt_char_count: 46 }));
    expect(fired.exitCode).toBe(0);
    const parsed = JSON.parse(fired.stdout) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } };
    expect(parsed.hookSpecificOutput.hookEventName).toBe("UserPromptSubmit");
    expect(parsed.hookSpecificOutput.additionalContext).toContain("carafe show");
    expect(parsed.hookSpecificOutput.additionalContext.length).toBeLessThanOrEqual(600);

    // The legacy field name is accepted too.
    const legacy = hook(JSON.stringify({ session_id: "receiver-2", cwd: "/tmp/reflex-project", hook_event_name: "UserPromptSubmit", prompt: "src/auth/service.ts keeps failing" }));
    expect(legacy.exitCode).toBe(0);
    expect(legacy.stdout).toContain("additionalContext");

    const unarmed = hook(JSON.stringify({ session_id: "receiver-3", cwd: "/somewhere/else", hook_event_name: "UserPromptSubmit", user_prompt: "src/auth/service.ts keeps failing" }));
    expect(unarmed.exitCode).toBe(0);
    expect(unarmed.stdout).toBe("");

    const malformed = hook("this is not json");
    expect(malformed.exitCode).toBe(0);
    expect(malformed.stdout).toBe("");

    const ack = hook(JSON.stringify({ session_id: "receiver-4", cwd: "/tmp/reflex-project", hook_event_name: "UserPromptSubmit", user_prompt: "ok" }));
    expect(ack.exitCode).toBe(0);
    expect(ack.stdout).toBe("");
  });

  test("a Codex-shaped payload answers on the same contract and keeps its own suppression", () => {
    const store = new CarafeStore(root);
    const { session, events } = fixtureSession(store);
    armReflex(store, session, { armedAtSeq: events.at(-1)!.seq, tailStartSeq: events.at(-1)!.seq + 1 });
    const codexPayload = JSON.stringify({ session_id: "shared-id", cwd: "/tmp/reflex-project", hook_event_name: "UserPromptSubmit", prompt: "src/auth/service.ts keeps failing", transcript_path: "/tmp/rollout.jsonl", permission_mode: "default", model: "gpt-5", turn_id: "turn-1" });
    const fromCodex = hook(codexPayload);
    expect(fromCodex.exitCode).toBe(0);
    expect(fromCodex.stderr).toBe("");
    const parsed = JSON.parse(fromCodex.stdout) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } };
    expect(parsed.hookSpecificOutput.hookEventName).toBe("UserPromptSubmit");
    expect(parsed.hookSpecificOutput.additionalContext).toContain("carafe show");
    // The same session id arriving from Claude Code is another receiver: it fires too.
    const fromClaude = hook(JSON.stringify({ session_id: "shared-id", cwd: "/tmp/reflex-project", hook_event_name: "UserPromptSubmit", user_prompt: "src/auth/service.ts keeps failing" }));
    expect(fromClaude.stdout).toContain("additionalContext");
    // Codex's own repeat is suppressed.
    expect(hook(codexPayload).stdout).toBe("");
  });

  test("the hook never blocks: exit 0 and no output when the index is missing", () => {
    const store = new CarafeStore(root);
    const { session, events } = fixtureSession(store);
    armReflex(store, session, { armedAtSeq: events.at(-1)!.seq, tailStartSeq: events.at(-1)!.seq + 1 });
    rmSync(join(root, "state", "session-index"), { recursive: true, force: true });
    const result = hook(JSON.stringify({ session_id: "r", cwd: "/tmp/reflex-project", hook_event_name: "UserPromptSubmit", user_prompt: "src/auth/service.ts keeps failing" }));
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
  });

  test("the hook stays below 800ms with twelve project indexes", () => {
    const store = new CarafeStore(root);
    const base = fixtureSession(store);
    for (let index = 1; index < 12; index++) {
      const id = `hook-session-${index}`;
      const events = base.events.map((event) => ({ ...event, sessionId: id, ts: event.ts?.replace("2026-01-01", `2026-01-${String(index + 1).padStart(2, "0")}`) ?? null }));
      const session = { ...base.session, sessionId: id, sourcePath: `${id}.jsonl`, startTs: events[0]!.ts, endTs: events.at(-1)!.ts };
      sealSession(store, session.tool, id, events);
      writeDistillate(store, session);
      buildSessionIndex(store, session, events, { force: true });
    }
    const result = hook(JSON.stringify({ session_id: "live-claude-session", cwd: "/tmp/reflex-project", hook_event_name: "UserPromptSubmit", user_prompt: "src/auth/service.ts keeps failing again" }));
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("additionalContext");
    expect(result.ms).toBeLessThan(800);
    console.log(`reflex hook subprocess 12 indexes: ${result.ms.toFixed(1)}ms`);
  });
});
