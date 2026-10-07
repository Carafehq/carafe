import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { installReflexHook, reflexHookEntry, reflexHookInstalled, uninstallReflexHook } from "./installer";

let root = "";
let oldRoot: string | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "carafe-reflex-installer-"));
  mkdirSync(join(root, ".claude"), { recursive: true });
  oldRoot = process.env.CARAFE_CLAUDE_HOME;
  process.env.CARAFE_CLAUDE_HOME = join(root, ".claude");
});
afterEach(() => {
  if (oldRoot === undefined) delete process.env.CARAFE_CLAUDE_HOME; else process.env.CARAFE_CLAUDE_HOME = oldRoot;
  rmSync(root, { recursive: true, force: true });
});

const settingsPath = () => join(root, ".claude", "settings.json");
const read = () => JSON.parse(readFileSync(settingsPath(), "utf8")) as Record<string, any>;

describe("reflex hook installer", () => {
  test("installs one entry, preserves everything else, is idempotent, and removes only itself", () => {
    writeFileSync(settingsPath(), JSON.stringify({ permissions: { allow: ["Bash(ls)"] }, hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo pre" }] }], UserPromptSubmit: [{ hooks: [{ type: "command", command: "/usr/local/bin/other-tool prompt" }] }] } }));
    expect(reflexHookInstalled()).toBe(false);
    expect(installReflexHook("/opt/carafe/bin/carafe").changed).toBe(true);
    let settings = read();
    expect(settings.permissions).toEqual({ allow: ["Bash(ls)"] });
    expect(settings.hooks.PreToolUse).toHaveLength(1);
    expect(settings.hooks.UserPromptSubmit).toHaveLength(2);
    const ours = settings.hooks.UserPromptSubmit[1];
    expect(ours).toEqual({ hooks: [{ type: "command", command: "/opt/carafe/bin/carafe reflex --hook", timeout: 5 }] });
    expect(Object.keys(ours)).toEqual(["hooks"]); // no marker keys in Claude Code's schema
    expect(reflexHookInstalled()).toBe(true);

    expect(installReflexHook("/opt/carafe/bin/carafe").changed).toBe(false);
    expect(read().hooks.UserPromptSubmit).toHaveLength(2);

    expect(uninstallReflexHook().changed).toBe(true);
    settings = read();
    expect(settings.hooks.UserPromptSubmit).toEqual([{ hooks: [{ type: "command", command: "/usr/local/bin/other-tool prompt" }] }]);
    expect(settings.hooks.PreToolUse).toHaveLength(1);
    expect(reflexHookInstalled()).toBe(false);
    expect(uninstallReflexHook().changed).toBe(false);
  });

  test("creates the settings file when missing and refuses invalid JSON", () => {
    expect(installReflexHook("/opt/carafe/bin/carafe").changed).toBe(true);
    expect(read().hooks.UserPromptSubmit).toHaveLength(1);
    expect(uninstallReflexHook().changed).toBe(true);
    expect(read().hooks.UserPromptSubmit).toBeUndefined(); // an emptied array is not left behind
    writeFileSync(settingsPath(), "{ not json");
    expect(() => installReflexHook("/opt/carafe/bin/carafe")).toThrow(/not valid JSON/);
    expect(readFileSync(settingsPath(), "utf8")).toBe("{ not json");
  });

  test("the hook command is quoted for paths with spaces and points at a runnable entrypoint", () => {
    const entry = reflexHookEntry("'/Users/Someone/My Tools/carafe'");
    expect(entry.hooks[0]!.command).toBe("'/Users/Someone/My Tools/carafe' reflex --hook");
    const dev = reflexHookEntry(); // under `bun run`/`bun test` this is `<bun> run <script>`; compiled, the binary itself
    expect(dev.hooks[0]!.command).toMatch(/reflex --hook$/);
    expect(dev.hooks[0]!.command).toMatch(/ run '?.*\.(?:ts|js)'? reflex --hook$|carafe reflex --hook$/);
  });
});

describe("reflex hook installer, Codex target (~/.codex/hooks.json)", () => {
  let codexRoot = "";
  let oldCodexRoot: string | undefined;
  beforeEach(() => {
    codexRoot = join(root, ".codex");
    oldCodexRoot = process.env.CARAFE_CODEX_HOME;
    process.env.CARAFE_CODEX_HOME = codexRoot;
  });
  afterEach(() => { if (oldCodexRoot === undefined) delete process.env.CARAFE_CODEX_HOME; else process.env.CARAFE_CODEX_HOME = oldCodexRoot; });
  const hooksPath = () => join(codexRoot, "hooks.json");
  const readHooks = () => JSON.parse(readFileSync(hooksPath(), "utf8")) as Record<string, any>;

  test("installs Codex's shape with a status message, preserves other hooks, is idempotent, removes only itself", () => {
    mkdirSync(codexRoot, { recursive: true });
    writeFileSync(hooksPath(), JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "echo pre" }] }], UserPromptSubmit: [{ hooks: [{ type: "command", command: "/usr/local/bin/other-tool prompt", timeout: 30 }] }] } }));
    expect(reflexHookInstalled("codex")).toBe(false);
    expect(installReflexHook("/opt/carafe/bin/carafe", "codex")).toEqual({ changed: true, message: `Codex reflex hook → ${codexRoot}/hooks.json (installed)` });
    let hooks = readHooks();
    expect(hooks.hooks.PreToolUse).toHaveLength(1);
    expect(hooks.hooks.UserPromptSubmit).toHaveLength(2);
    expect(hooks.hooks.UserPromptSubmit[1]).toEqual({ hooks: [{ type: "command", command: "/opt/carafe/bin/carafe reflex --hook", timeout: 5, statusMessage: "carafe reflex" }] });
    expect(reflexHookInstalled("codex")).toBe(true);
    expect(reflexHookInstalled("claude")).toBe(false); // the targets never touch each other
    expect(installReflexHook("/opt/carafe/bin/carafe", "codex").changed).toBe(false);
    expect(uninstallReflexHook("codex").changed).toBe(true);
    hooks = readHooks();
    expect(hooks.hooks.UserPromptSubmit).toEqual([{ hooks: [{ type: "command", command: "/usr/local/bin/other-tool prompt", timeout: 30 }] }]);
    expect(uninstallReflexHook("codex").changed).toBe(false);
  });

  test("creates hooks.json when missing, drops an emptied array, refuses invalid JSON", () => {
    expect(installReflexHook("/opt/carafe/bin/carafe", "codex").changed).toBe(true);
    expect(readHooks()).toEqual({ hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: "/opt/carafe/bin/carafe reflex --hook", timeout: 5, statusMessage: "carafe reflex" }] }] } });
    expect(uninstallReflexHook("codex").changed).toBe(true);
    expect(readHooks().hooks.UserPromptSubmit).toBeUndefined();
    writeFileSync(hooksPath(), "{ not json");
    expect(() => installReflexHook("/opt/carafe/bin/carafe", "codex")).toThrow(/hooks\.json: file is not valid JSON/);
    expect(readFileSync(hooksPath(), "utf8")).toBe("{ not json");
  });
});
