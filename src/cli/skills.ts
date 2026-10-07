import { lstatSync, mkdirSync, readFileSync, renameSync, rmdirSync, unlinkSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";
import { atomicWriteFileSync } from "../format/store";
import { CLAUDE_SKILL, CODEX_PROMPT } from "./skill-templates";

const MARKER_PREFIX = "<!-- carafe-skill";

type TargetName = "claude" | "codex";
type Target = {
  name: TargetName;
  label: string;
  root: string;
  displayRoot: string;
  path: string;
  content: string;
};

type TargetState = "missing" | "carafe" | "foreign";

export type SkillsOptions = {
  claude?: boolean;
  codex?: boolean;
  force?: boolean;
};

function configuredRoot(variable: string, suffix: string): { actual: string; display: string } {
  const configured = process.env[variable];
  if (configured !== undefined) return { actual: configured, display: configured };
  return { actual: join(process.env.HOME ?? homedir(), suffix), display: `~/${suffix}` };
}

function targets(options: SkillsOptions): Target[] {
  const claude = configuredRoot("CARAFE_CLAUDE_HOME", ".claude");
  const codex = configuredRoot("CARAFE_CODEX_HOME", ".codex");
  const all: Target[] = [
    {
      name: "claude",
      label: "claude code skill",
      root: claude.actual,
      displayRoot: claude.display,
      path: join(claude.actual, "skills", "carafe", "SKILL.md"),
      content: CLAUDE_SKILL,
    },
    {
      name: "codex",
      label: "codex prompt",
      root: codex.actual,
      displayRoot: codex.display,
      path: join(codex.actual, "prompts", "carafe.md"),
      content: CODEX_PROMPT,
    },
  ];
  if (!options.claude && !options.codex) return all;
  return all.filter((target) => (target.name === "claude" ? options.claude : options.codex));
}

function displayPath(target: Target, path = target.path): string {
  const relative = path.slice(target.root.length).replace(/^[/\\]/, "");
  return join(target.displayRoot, relative);
}

function hasMarker(content: string): boolean {
  return content.split(/\r?\n/).some((line) => line.startsWith(MARKER_PREFIX));
}

function pathExists(path: string): boolean {
  try { lstatSync(path); return true; } catch { return false; }
}

function readTarget(path: string): { state: TargetState; content: string | null } {
  if (!pathExists(path)) return { state: "missing", content: null };
  try {
    const content = readFileSync(path, "utf8");
    return { state: hasMarker(content) ? "carafe" : "foreign", content };
  } catch {
    return { state: "foreign", content: null };
  }
}

function today(): string {
  const date = new Date();
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
}

function backupPath(path: string): string {
  const base = `${path}.pre-carafe-${today()}`;
  if (!pathExists(base)) return base;
  for (let n = 1; ; n++) {
    const candidate = `${base}-${n}`;
    if (!pathExists(candidate)) return candidate;
  }
}

function writeTarget(target: Target): void {
  mkdirSync(dirname(target.path), { recursive: true });
  atomicWriteFileSync(target.path, target.content);
}

function install(target: Target, force: boolean): boolean {
  const current = readTarget(target.path);
  if (current.state === "foreign") {
    if (!force) {
      console.error(`✗ ${target.label} → ${displayPath(target)} exists and is not carafe's — rerun with --force to set it aside`);
      return false;
    }
    const moved = backupPath(target.path);
    renameSync(target.path, moved);
    console.log(`↪ ${target.label} existing file set aside at ${displayPath(target, moved)}`);
    writeTarget(target);
    console.log(`✓ ${target.label} → ${displayPath(target)} (installed)`);
    return true;
  }
  if (current.state === "missing") {
    writeTarget(target);
    console.log(`✓ ${target.label} → ${displayPath(target)} (installed)`);
    return true;
  }
  if (current.content === target.content) {
    console.log(`✓ ${target.label} → ${displayPath(target)} (unchanged)`);
  } else {
    writeTarget(target);
    console.log(`✓ ${target.label} → ${displayPath(target)} (updated)`);
  }
  return true;
}

function status(target: Target): void {
  const current = readTarget(target.path);
  if (current.state === "missing") {
    console.log(`${target.label} → ${displayPath(target)} · missing`);
  } else if (current.state === "foreign") {
    console.log(`${target.label} → ${displayPath(target)} · foreign-file`);
  } else {
    console.log(`${target.label} → ${displayPath(target)} · installed · ${current.content === target.content ? "up to date" : "outdated (reinstall with carafe skills install)"}`);
  }
}

function uninstall(target: Target): void {
  const current = readTarget(target.path);
  if (current.state === "carafe") {
    unlinkSync(target.path);
    if (target.name === "claude") {
      try { rmdirSync(dirname(target.path)); } catch { /* non-empty or already gone */ }
    }
    console.log(`✓ ${target.label} → ${displayPath(target)} (removed)`);
  } else if (current.state === "foreign") {
    console.log(`✓ ${target.label} → ${displayPath(target)} (foreign-file left untouched)`);
  } else {
    console.log(`✓ ${target.label} → ${displayPath(target)} (already missing)`);
  }
}

export function runSkills(subcommand: string | undefined, options: SkillsOptions = {}): number {
  const selected = targets(options);
  if (!selected.length) {
    console.error("usage: carafe skills install|status|uninstall [--claude] [--codex] [--force]");
    return 1;
  }
  if (subcommand === "install") {
    let ok = true;
    for (const target of selected) {
      if (!install(target, options.force === true)) ok = false;
    }
    return ok ? 0 : 1;
  }
  if (subcommand === "status") {
    for (const target of selected) status(target);
    return 0;
  }
  if (subcommand === "uninstall") {
    for (const target of selected) uninstall(target);
    return 0;
  }
  console.error("usage: carafe skills install [--claude] [--codex] [--force]\n       carafe skills status [--claude] [--codex]\n       carafe skills uninstall [--claude] [--codex]");
  return 1;
}
