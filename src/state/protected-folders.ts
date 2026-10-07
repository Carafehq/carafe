/**
 * macOS privacy protection (TCC) guards ~/Documents, ~/Desktop and ~/Downloads
 * per app. The FIRST time a process opens something inside one of them, macOS
 * shows "… would like to access files in your Documents folder" and the kernel
 * blocks that open() until the user answers; a denial then returns EPERM.
 *
 * The background watcher is the process that meets this, and nobody is looking
 * at it. So it opens each protected folder exactly once, deliberately, after
 * announcing that it is about to (the heartbeat's stage says so, which is how
 * the menu bar app can tell "waiting for a permission prompt" from a hang), and
 * a folder it was refused is logged once and skipped for the life of the
 * process — never retried in a loop. Nothing here writes anywhere.
 */
import { readdirSync } from "fs";
import { homedir } from "os";
import { resolve, sep } from "path";

export const PROTECTED_FOLDER_NAMES = ["Documents", "Desktop", "Downloads"] as const;

function homeDir(): string {
  return process.env.HOME || homedir();
}

/** The protected folder (absolute) that contains `path`, or null. */
export function protectedFolderOf(path: string, home: string = homeDir()): string | null {
  if (!path || !home) return null;
  const abs = resolve(path);
  const base = resolve(home);
  for (const name of PROTECTED_FOLDER_NAMES) {
    const folder = `${base}${sep}${name}`;
    if (abs === folder || abs.startsWith(folder + sep)) return folder;
  }
  return null;
}

/** Every protected folder that contains one of `paths`, sorted, each once. */
export function protectedFoldersOf(paths: Iterable<string | null | undefined>, home: string = homeDir()): string[] {
  const found = new Set<string>();
  for (const path of paths) {
    if (!path) continue;
    const folder = protectedFolderOf(path, home);
    if (folder) found.add(folder);
  }
  return [...found].sort();
}

/**
 * Claude Code names each project directory after its working directory with
 * every non-alphanumeric character turned into `-`
 * (`<home>/Documents/app` → its encoded project directory). The encoding is
 * lossy, but the protected parent survives it, which covers sessions not yet
 * captured into the store (a first install). `~/Documents-old` would read as
 * `~/Documents`: the cost is one unneeded explanation, never a missed prompt.
 */
export function protectedFoldersOfEncodedNames(names: Iterable<string>, home: string = homeDir()): string[] {
  const base = resolve(home);
  const encoded = PROTECTED_FOLDER_NAMES.map((name) => ({ folder: `${base}${sep}${name}`, prefix: `${base}/${name}`.replace(/[^a-zA-Z0-9]/g, "-") }));
  const found = new Set<string>();
  for (const name of names) {
    for (const { folder, prefix } of encoded) if (name === prefix || name.startsWith(`${prefix}-`)) found.add(folder);
  }
  return [...found].sort();
}

/** `~/Documents` for a message a human reads. */
export function displayFolder(folder: string, home: string = homeDir()): string {
  const base = resolve(home);
  return folder === base || folder.startsWith(base + sep) ? `~${folder.slice(base.length)}` : folder;
}

export type AccessResult = "ok" | "denied" | "missing";
export type AccessProbe = (folder: string) => AccessResult;

/** Lists the folder: the one open that raises the macOS prompt, if any. */
export const realAccessProbe: AccessProbe = (folder) => {
  try {
    readdirSync(folder);
    return "ok";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EPERM" || code === "EACCES") return "denied";
    return "missing";
  }
};

export interface ProtectedFolderGateOptions {
  home?: string;
  probe?: AccessProbe;
  /** called just before the first open of `folder` in this process (it may block on a prompt) */
  onFirstOpen?: (folder: string) => void;
  /** called once that open returned */
  onFirstOpenDone?: (folder: string, result: AccessResult) => void;
  log?: (message: string) => void;
}

/** One per watcher process: which protected folders it may open. */
export class ProtectedFolderGate {
  private readonly verdicts = new Map<string, AccessResult>();

  constructor(private readonly opts: ProtectedFolderGateOptions = {}) {}

  /** False when `cwd` sits in a protected folder this process was refused. */
  allow(cwd: string | null | undefined): boolean {
    if (!cwd) return true;
    const folder = protectedFolderOf(cwd, this.opts.home ?? homeDir());
    if (!folder) return true;
    let verdict = this.verdicts.get(folder);
    if (verdict === undefined) {
      this.opts.onFirstOpen?.(folder);
      verdict = (this.opts.probe ?? realAccessProbe)(folder);
      this.verdicts.set(folder, verdict);
      this.opts.onFirstOpenDone?.(folder, verdict);
      if (verdict === "denied") {
        const shown = displayFolder(folder, this.opts.home ?? homeDir());
        (this.opts.log ?? console.error)(`no access to ${shown} (macOS privacy settings) — sessions there are skipped until capture restarts; allow it in System Settings → Privacy & Security → Files and Folders`);
      }
    }
    return verdict !== "denied";
  }

  /** Protected folders this process was refused, sorted. */
  denied(): string[] {
    return [...this.verdicts].filter(([, v]) => v === "denied").map(([f]) => f).sort();
  }
}

/** The gate the capture pipeline consults; only the watcher installs one. */
let activeGate: ProtectedFolderGate | null = null;

export function setProtectedFolderGate(gate: ProtectedFolderGate | null): void {
  activeGate = gate;
}

export function protectedFolderGate(): ProtectedFolderGate | null {
  return activeGate;
}
