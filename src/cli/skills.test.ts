import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { CLAUDE_SKILL, CODEX_PROMPT } from "./skill-templates";
import { runSkills } from "./skills";

let root = "";
let oldClaude: string | undefined;
let oldCodex: string | undefined;

const claudePath = (): string => join(root, "claude", "skills", "carafe", "SKILL.md");
const codexPath = (): string => join(root, "codex", "prompts", "carafe.md");

function capture<T>(fn: () => T): { result: T; output: string; errors: string } {
  const output: string[] = [];
  const errors: string[] = [];
  const log = console.log;
  const error = console.error;
  console.log = (...args: unknown[]) => output.push(args.join(" "));
  console.error = (...args: unknown[]) => errors.push(args.join(" "));
  try {
    return { result: fn(), output: output.join("\n"), errors: errors.join("\n") };
  } finally {
    console.log = log;
    console.error = error;
  }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "carafe-skills-"));
  oldClaude = process.env.CARAFE_CLAUDE_HOME;
  oldCodex = process.env.CARAFE_CODEX_HOME;
  process.env.CARAFE_CLAUDE_HOME = join(root, "claude");
  process.env.CARAFE_CODEX_HOME = join(root, "codex");
});

afterEach(() => {
  if (oldClaude === undefined) delete process.env.CARAFE_CLAUDE_HOME;
  else process.env.CARAFE_CLAUDE_HOME = oldClaude;
  if (oldCodex === undefined) delete process.env.CARAFE_CODEX_HOME;
  else process.env.CARAFE_CODEX_HOME = oldCodex;
  if (root) rmSync(root, { recursive: true, force: true });
});

describe("carafe skills", () => {
  test("both command templates teach session-scoped ranked recall", () => {
    expect(CLAUDE_SKILL).toContain('search --session <id> \\"terms\\"');
    expect(CLAUDE_SKILL).toContain("ranked recall; returns seq ranges");
    expect(CODEX_PROMPT).toContain("ranked recall; returns seq ranges");
    expect(CLAUDE_SKILL).toContain("indexed, milliseconds, returns seq ranges");
    expect(CODEX_PROMPT).toContain("reads the index too, falls back to the full trace");
    expect(CLAUDE_SKILL).toContain("carafe ask <session-id|latest|current>");
    expect(CODEX_PROMPT).toContain("carafe ask <session-id|latest|current>");
  });

  test("fresh install writes both templates with their markers", () => {
    const run = capture(() => runSkills("install"));
    expect(run.result).toBe(0);
    expect(readFileSync(claudePath(), "utf8")).toBe(CLAUDE_SKILL);
    expect(readFileSync(codexPath(), "utf8")).toBe(CODEX_PROMPT);
    expect(readFileSync(claudePath(), "utf8").match(/<!-- carafe-skill/g)).toHaveLength(1);
    expect(readFileSync(codexPath(), "utf8").match(/<!-- carafe-skill/g)).toHaveLength(1);
    expect(readFileSync(claudePath(), "utf8")).toContain("---\n<!-- carafe-skill v1 -->");
    expect(run.output).toContain("(installed)");
  });

  test("reinstall is idempotent and reports unchanged", () => {
    expect(capture(() => runSkills("install")).result).toBe(0);
    const beforeClaude = readFileSync(claudePath(), "utf8");
    const beforeCodex = readFileSync(codexPath(), "utf8");
    const run = capture(() => runSkills("install"));
    expect(run.result).toBe(0);
    expect(readFileSync(claudePath(), "utf8")).toBe(beforeClaude);
    expect(readFileSync(codexPath(), "utf8")).toBe(beforeCodex);
    expect(run.output.match(/unchanged/g)).toHaveLength(2);
  });

  test("refuses a markerless file and --force preserves it before installing", () => {
    const original = "user-owned prompt\n";
    const path = codexPath();
    const parent = join(root, "codex", "prompts");
    mkdirSync(parent, { recursive: true });
    writeFileSync(path, original);
    const refused = capture(() => runSkills("install", { codex: true }));
    expect(refused.result).toBe(1);
    expect(refused.errors).toContain("exists and is not carafe's");
    expect(readFileSync(path, "utf8")).toBe(original);

    const forced = capture(() => runSkills("install", { codex: true, force: true }));
    expect(forced.result).toBe(0);
    expect(readFileSync(path, "utf8")).toBe(CODEX_PROMPT);
    const backups = readdirSync(parent).filter((name) => name.startsWith("carafe.md.pre-carafe-"));
    expect(backups).toHaveLength(1);
    expect(readFileSync(join(parent, backups[0]!), "utf8")).toBe(original);
    expect(forced.output).toContain("set aside at");
  });

  test("uninstall removes only marker files and cleans the empty Claude skill directory", () => {
    expect(capture(() => runSkills("install")).result).toBe(0);
    writeFileSync(codexPath(), "user-owned prompt\n");
    const run = capture(() => runSkills("uninstall"));
    expect(run.result).toBe(0);
    expect(existsSync(claudePath())).toBe(false);
    expect(existsSync(join(root, "claude", "skills", "carafe"))).toBe(false);
    expect(readFileSync(codexPath(), "utf8")).toBe("user-owned prompt\n");
  });

  test("status distinguishes missing, foreign, current, and outdated files", () => {
    const fresh = capture(() => runSkills("install")).result;
    expect(fresh).toBe(0);
    writeFileSync(claudePath(), `${CLAUDE_SKILL}\nchanged\n`);
    rmSync(codexPath());
    const status = capture(() => runSkills("status"));
    expect(status.result).toBe(0);
    expect(status.output).toContain("installed · outdated (reinstall with carafe skills install)");
    expect(status.output).toContain("codex prompt");
    expect(status.output).toContain("· missing");
    writeFileSync(codexPath(), "user-owned prompt\n");
    const foreign = capture(() => runSkills("status", { codex: true }));
    expect(foreign.output).toContain("· foreign-file");
  });

  test("target flags limit installation", () => {
    const claude = capture(() => runSkills("install", { claude: true }));
    expect(claude.result).toBe(0);
    expect(existsSync(claudePath())).toBe(true);
    expect(existsSync(codexPath())).toBe(false);
    const codex = capture(() => runSkills("install", { codex: true }));
    expect(codex.result).toBe(0);
    expect(existsSync(codexPath())).toBe(true);
  });
});
