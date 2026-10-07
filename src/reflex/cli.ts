import { rememberCaller } from "../query/caller";
import { readFileSync } from "fs";
import { join } from "path";
import type { SessionDistillate } from "../format/distillate";
import { readSession } from "../format/sessions";
import { atomicWriteFileSync, CarafeStore } from "../format/store";
import { currentSession, findSession, latestSession } from "../query/sessions";
import { buildSessionIndex, sessionIndexesSize } from "../search/session-index";
import { CODEX_TRUST_NOTICE, HOOK_TARGETS, hookTargetLabel, installReflexHook, reflexHookInstalled, uninstallReflexHook, type HookTarget } from "./installer";
import { reflex } from "./reflex";
import { armReflex, disarmReflex, loadReflexState, reflexIndexFreshness, sessionsForCwd } from "./state";

const HOOK_BUDGET_MS = 800;

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
}
function has(args: string[], name: string): boolean { return args.includes(`--${name}`); }
function positionals(args: string[]): string[] { return args.filter((arg, index) => !arg.startsWith("--") && !(index > 0 && args[index - 1]!.startsWith("--"))); }

function resolveSession(store: CarafeStore, value: string): SessionDistillate | null {
  return value === "latest" ? latestSession(store) : value === "current" ? currentSession(store) : findSession(store, value);
}

function exactSession(store: CarafeStore, tool: string, sessionId: string): SessionDistillate | null {
  try { return JSON.parse(readFileSync(store.distillatePath(tool, sessionId), "utf8")) as SessionDistillate; }
  catch { return null; }
}

function logHookError(store: CarafeStore, error: unknown): void {
  try {
    const path = join(store.root, "state", "reflex.log");
    let lines: string[] = [];
    try { lines = readFileSync(path, "utf8").split(/\r?\n/).filter(Boolean); } catch { /* first error */ }
    const message = (error instanceof Error ? error.message : String(error)).replace(/[\r\n]+/g, " ").slice(0, 500);
    atomicWriteFileSync(path, [...lines, message].slice(-200).join("\n") + "\n");
  } catch { /* the hook must remain silent */ }
}

async function runHook(): Promise<number> {
  let store: CarafeStore | null = null;
  const started = performance.now();
  const overBudget = (): boolean => performance.now() - started >= HOOK_BUDGET_MS;
  try {
    store = new CarafeStore();
    const raw = await Bun.stdin.text();
    if (overBudget()) return 0;
    const input = JSON.parse(raw) as Record<string, unknown>;
    try { rememberCaller(store, input); } catch { /* identity persistence must not break the reflex */ }
    // Claude Code sends `user_prompt`; Codex sends `prompt`. Same contract otherwise.
    const tool: HookTarget = typeof input.user_prompt === "string" ? "claude" : "codex";
    const turnText = typeof input.user_prompt === "string" ? input.user_prompt : typeof input.prompt === "string" ? input.prompt : null;
    const cwd = typeof input.cwd === "string" ? input.cwd : null;
    const sessionId = typeof input.session_id === "string" ? input.session_id : null;
    if (turnText == null || cwd == null || sessionId == null) return 0;
    // The raw id finds the captured session to exclude (its own last chapter);
    // suppression state is per tool, so a Claude and a Codex session that happen
    // to share an id and a cwd never silence each other.
    const sessions = sessionsForCwd(store, cwd, { currentSessionId: sessionId });
    if (!sessions.length || overBudget()) return 0;
    const result = reflex({ store, sessions, cwd, turnText, receiverId: `${tool}:${sessionId}` });
    if (!result.text || overBudget()) return 0;
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: result.text } }));
    return 0;
  } catch (error) {
    if (store) logHookError(store, error);
    return 0;
  }
}

/** `--claude`, `--codex`, or neither for both. */
function hookTargets(args: string[]): HookTarget[] {
  const chosen = HOOK_TARGETS.filter((target) => has(args, target));
  return chosen.length ? chosen : [...HOOK_TARGETS];
}

function printStatus(store: CarafeStore, targets: HookTarget[]): void {
  for (const target of targets) console.log(`${hookTargetLabel(target)} hook: ${reflexHookInstalled(target) ? "installed" : "not installed"}`);
  const bytes = sessionIndexesSize(store);
  const size = bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)}MB` : bytes >= 1024 ? `${(bytes / 1024).toFixed(1)}KB` : `${bytes}B`;
  console.log(`session indexes: ${size}`);
  const armed = loadReflexState(store).armed;
  if (!armed.length) console.log("armed sessions: none");
  else {
    console.log("armed sessions:");
    for (const row of armed) {
      const session = exactSession(store, row.tool, row.sessionId);
      const freshness = session ? reflexIndexFreshness(store, session) : "missing-session";
      console.log(`  ${row.tool} ${row.sessionId} · ${row.cwd} · tail >= ${row.tailStartSeq} · index ${freshness}`);
    }
  }
  const cwds = [...new Set([process.cwd(), ...armed.map((row) => row.cwd)])];
  for (const cwd of cwds) {
    console.log(`answering for ${cwd}:`);
    const sessions = sessionsForCwd(store, cwd);
    if (!sessions.length) { console.log("  none"); continue; }
    for (const source of sessions) {
      const session = source.session;
      console.log(`  ${session.tool} ${session.sessionId} · ${(session.title ?? "untitled").replace(/\s+/g, " ").slice(0, 64)} · index ${reflexIndexFreshness(store, session)}${source.bonus ? " · armed" : ""}`);
    }
  }
}

const USAGE = `usage: carafe reflex <id|latest|current> --turn "<text>" [--receiver R] [--k N] [--json]
       carafe reflex --cwd DIR --turn "<text>" [--receiver R] [--k N] [--json]
       carafe reflex arm <id|latest|current> [--cwd DIR]
       carafe reflex disarm [<id>|--cwd DIR|--all]
       carafe reflex install|uninstall|status [--claude] [--codex]   (neither flag = both)`;

export async function runReflexCli(args: string[]): Promise<number> {
  if (has(args, "hook")) return runHook();
  const positional = positionals(args);
  const sub = positional[0];
  const store = new CarafeStore();
  try {
    if (sub === "install") {
      for (const target of hookTargets(args)) {
        console.log(installReflexHook(undefined, target).message);
        if (target === "codex") console.log(CODEX_TRUST_NOTICE);
      }
      return 0;
    }
    if (sub === "uninstall") {
      for (const target of hookTargets(args)) console.log(uninstallReflexHook(target).message);
      return 0;
    }
    if (sub === "status") { printStatus(store, hookTargets(args)); return 0; }
    if (sub === "arm") {
      const id = positional[1];
      if (!id) { console.error(USAGE); return 1; }
      const session = resolveSession(store, id);
      if (!session) { console.error(`session not found: ${id}`); return 1; }
      const events = readSession(store, session.tool, session.sessionId);
      buildSessionIndex(store, session, events);
      const endSeq = events.at(-1)?.seq ?? 0;
      const armed = armReflex(store, session, { cwd: option(args, "cwd"), armedAtSeq: endSeq, tailStartSeq: endSeq + 1 });
      console.log(`armed ${armed.tool} ${armed.sessionId} for ${armed.cwd}`);
      return 0;
    }
    if (sub === "disarm") {
      const id = positional[1];
      if (!id && !option(args, "cwd") && !has(args, "all")) { console.error(USAGE); return 1; }
      const removed = disarmReflex(store, { sessionId: id, cwd: option(args, "cwd"), all: has(args, "all") });
      console.log(`disarmed ${removed} session${removed === 1 ? "" : "s"}`);
      return 0;
    }
    const turnText = option(args, "turn");
    if (turnText == null) { console.error(USAGE); return 1; }
    const projectCwd = option(args, "cwd");
    if (!sub && projectCwd) {
      const sessions = sessionsForCwd(store, projectCwd);
      const result = reflex({
        store, sessions, cwd: projectCwd, turnText, receiverId: option(args, "receiver") ?? "cli",
        k: option(args, "k") == null ? undefined : Number(option(args, "k")),
      });
      if (has(args, "json")) console.log(JSON.stringify(result, null, 2));
      else if (result.text) console.log(result.text);
      return 0;
    }
    if (!sub) { console.error(USAGE); return 1; }
    const session = resolveSession(store, sub);
    if (!session) { console.error(`session not found: ${sub}`); return 1; }
    // The CLI form may pay for a rebuild; the hook never does (it stays silent instead).
    if (reflexIndexFreshness(store, session) !== "fresh") {
      process.stderr.write(`session index stale or missing; building ${session.sessionId}…\n`);
      buildSessionIndex(store, session, readSession(store, session.tool, session.sessionId));
    }
    const armed = loadReflexState(store).armed.slice().reverse().find((row) => row.sessionId === session.sessionId);
    const result = reflex({
      store, session, turnText, receiverId: option(args, "receiver") ?? "cli",
      k: option(args, "k") == null ? undefined : Number(option(args, "k")),
      tailStartSeq: armed?.tailStartSeq,
    });
    if (has(args, "json")) console.log(JSON.stringify(result, null, 2));
    else if (result.text) console.log(result.text);
    return 0;
  } catch (error) {
    console.error(`error: ${error instanceof Error ? error.message : error}`);
    return 1;
  }
}
