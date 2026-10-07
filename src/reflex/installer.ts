import { existsSync, mkdirSync, readFileSync } from "fs";
import { homedir } from "os";
import { dirname, isAbsolute, join, resolve } from "path";
import { atomicWriteFileSync } from "../format/store";

/** Where a `UserPromptSubmit` hook can be installed. Claude Code reads
 *  `~/.claude/settings.json`; Codex CLI reads `~/.codex/hooks.json`. Both use
 *  the same `hooks.UserPromptSubmit[].hooks[]` shape and the same stdin/stdout
 *  contract, so one hook command serves both. */
export type HookTarget = "claude" | "codex";
export const HOOK_TARGETS: readonly HookTarget[] = ["claude", "codex"];

interface HookCommand { type: "command"; command: string; timeout: number; statusMessage?: string }
// Neither schema is ours: no marker keys. Our entry is recognised by its
// command, which always ends in `reflex --hook`.
interface CarafeHook { hooks: HookCommand[] }
const OURS_RE = /(?:^|\s)reflex --hook$/;

interface TargetSpec { label: string; env: string; dir: string; file: string; statusMessage?: string }
const TARGETS: Record<HookTarget, TargetSpec> = {
  claude: { label: "Claude Code", env: "CARAFE_CLAUDE_HOME", dir: ".claude", file: "settings.json" },
  // Codex shows statusMessage while the hook runs; Claude Code has no such field.
  codex: { label: "Codex", env: "CARAFE_CODEX_HOME", dir: ".codex", file: "hooks.json", statusMessage: "carafe reflex" },
};

function targetRoot(target: HookTarget): { actual: string; display: string } {
  const spec = TARGETS[target];
  const configured = process.env[spec.env];
  if (configured !== undefined) return { actual: configured, display: configured };
  return { actual: join(process.env.HOME ?? homedir(), spec.dir), display: `~/${spec.dir}` };
}

export function hookTargetLabel(target: HookTarget): string { return TARGETS[target].label; }
export function hookConfigPath(target: HookTarget = "claude"): string { return join(targetRoot(target).actual, TARGETS[target].file); }
export function displayHookConfigPath(target: HookTarget = "claude"): string { return join(targetRoot(target).display, TARGETS[target].file); }
export function claudeSettingsPath(): string { return hookConfigPath("claude"); }
export function displayClaudeSettingsPath(): string { return displayHookConfigPath("claude"); }

function shellQuote(value: string): string {
  return /^[A-Za-z0-9_./-]+$/.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;
}

/** The command line that reaches THIS carafe again from a hook: the compiled
 *  binary is its own entrypoint; under `bun run` the script needs the runtime. */
export function runningEntrypoint(): string {
  const script = process.argv[1] ?? "";
  if (/\.(?:ts|js|mjs|cjs)$/.test(script)) {
    const path = isAbsolute(script) ? script : resolve(script);
    return `${shellQuote(process.execPath)} run ${shellQuote(path)}`;
  }
  return shellQuote(process.execPath);
}

export function reflexHookEntry(entrypoint = runningEntrypoint(), target: HookTarget = "claude"): CarafeHook {
  const spec = TARGETS[target];
  return { hooks: [{ type: "command", command: `${entrypoint} reflex --hook`, timeout: 5, ...(spec.statusMessage ? { statusMessage: spec.statusMessage } : {}) }] };
}

function parseConfig(target: HookTarget, path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(path, "utf8")); }
  catch { throw new Error(`refusing to modify ${displayHookConfigPath(target)}: file is not valid JSON`); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`refusing to modify ${displayHookConfigPath(target)}: top level must be a JSON object`);
  return parsed as Record<string, unknown>;
}

function promptHooks(target: HookTarget, settings: Record<string, unknown>, create: boolean): unknown[] | null {
  let hooks = settings.hooks;
  if (hooks == null && create) settings.hooks = hooks = {};
  if (!hooks || typeof hooks !== "object" || Array.isArray(hooks)) throw new Error(`refusing to modify ${displayHookConfigPath(target)}: hooks must be a JSON object`);
  const record = hooks as Record<string, unknown>;
  let entries = record.UserPromptSubmit;
  if (entries == null && create) record.UserPromptSubmit = entries = [];
  if (entries == null) return null;
  if (!Array.isArray(entries)) throw new Error(`refusing to modify ${displayHookConfigPath(target)}: hooks.UserPromptSubmit must be an array`);
  return entries;
}

function isOurs(value: unknown): value is CarafeHook {
  if (!value || typeof value !== "object") return false;
  const hooks = (value as Record<string, unknown>).hooks;
  return Array.isArray(hooks) && hooks.length > 0 && hooks.every((hook) => !!hook && typeof hook === "object" && typeof (hook as Record<string, unknown>).command === "string" && OURS_RE.test((hook as Record<string, unknown>).command as string));
}

export function reflexHookInstalled(target: HookTarget = "claude"): boolean {
  try {
    const settings = parseConfig(target, hookConfigPath(target));
    return promptHooks(target, settings, false)?.some(isOurs) ?? false;
  } catch { return false; }
}

export function installReflexHook(entrypoint = runningEntrypoint(), target: HookTarget = "claude"): { changed: boolean; message: string } {
  const path = hookConfigPath(target);
  const settings = parseConfig(target, path);
  const entries = promptHooks(target, settings, true)!;
  const desired = reflexHookEntry(entrypoint, target);
  const ours = entries.filter(isOurs);
  const label = `${hookTargetLabel(target)} reflex hook → ${displayHookConfigPath(target)}`;
  if (ours.length === 1 && JSON.stringify(ours[0]) === JSON.stringify(desired)) return { changed: false, message: `${label} (unchanged)` };
  const next = entries.filter((entry) => !isOurs(entry));
  next.push(desired);
  (settings.hooks as Record<string, unknown>).UserPromptSubmit = next;
  mkdirSync(dirname(path), { recursive: true });
  atomicWriteFileSync(path, JSON.stringify(settings, null, 2) + "\n");
  return { changed: true, message: `${label} (installed)` };
}

export function uninstallReflexHook(target: HookTarget = "claude"): { changed: boolean; message: string } {
  const path = hookConfigPath(target);
  const settings = parseConfig(target, path);
  const entries = promptHooks(target, settings, false);
  const label = `${hookTargetLabel(target)} reflex hook → ${displayHookConfigPath(target)}`;
  if (!entries || !entries.some(isOurs)) return { changed: false, message: `${label} (already missing)` };
  const remaining = entries.filter((entry) => !isOurs(entry));
  const hooks = settings.hooks as Record<string, unknown>;
  if (remaining.length) hooks.UserPromptSubmit = remaining;
  else delete hooks.UserPromptSubmit;
  atomicWriteFileSync(path, JSON.stringify(settings, null, 2) + "\n");
  return { changed: true, message: `${label} (removed)` };
}

/** Codex skips a new or changed hook until the user trusts it inside Codex. */
export const CODEX_TRUST_NOTICE = "Codex requires you to trust new hooks: run /hooks inside Codex and trust the carafe entry (it is skipped until you do).";
