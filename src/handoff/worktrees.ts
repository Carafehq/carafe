/**
 * Where a command actually worked.
 *
 * Two things hid a whole week of work from a handoff: the session addressed its
 * checkout through a shell variable (`S="/…/scratchpad"; cd "$S/wt-be4"`), so
 * no literal path was ever written down; and the checkout was a git WORKTREE
 * living under the scratch directory, which the workspace rules exclude. Both
 * are recoverable from the trace itself, deterministically: the assignment sits
 * in the same command as its use, and the worktree was created by a
 * `git worktree add` whose repository is named on that same line.
 */
import { existsSync, readFileSync, statSync } from "fs";
import { dirname, join, resolve } from "path";
import { isExcludedWorkspace, workspaceKey } from "../query/sessions";

const unquote = (value: string): string => value.replace(/^["']|["']$/g, "");
/** `New\ project` is one directory, not two arguments. */
const unescapeSpaces = (value: string): string => value.replace(/\\(.)/g, "$1");
/** A path argument: quoted, or an unquoted run that may escape its spaces. */
const PATH_ARG = `"[^"]+"|'[^']+'|(?:\\\\.|[^\\s;&|])+`;
export const pathArgument = (value: string): string => unescapeSpaces(unquote(value));

/**
 * Substitute `$NAME` / `${NAME}` with an assignment made EARLIER IN THE SAME
 * command. Nothing is guessed from the environment: a variable the command did
 * not set is left exactly as it was written.
 */
export function expandCommandVars(command: string): string {
  const TOKEN = /([A-Za-z_][A-Za-z0-9_]*)=("[^"]*"|'[^']*'|[^\s;&|()]*)|\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g;
  const values = new Map<string, string>();
  let out = "";
  let cursor = 0;
  let match: RegExpExecArray | null;
  const substitute = (text: string): string =>
    text.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (whole, braced, bare) => values.get(braced ?? bare) ?? whole);
  while ((match = TOKEN.exec(command)) !== null) {
    out += command.slice(cursor, match.index);
    cursor = match.index + match[0].length;
    if (match[1] != null) {
      values.set(match[1], substitute(unquote(match[2] ?? "")));
      out += match[0];
      continue;
    }
    const name = match[3] ?? match[4]!;
    out += values.get(name) ?? match[0];
  }
  return out + command.slice(cursor);
}

/**
 * An absolute path, or nothing. `-C .`, `cd src` and `cd $UNSET/x` name a place
 * only relative to where the shell already was: resolved against the session's
 * cwd when there is one, and otherwise dropped — a relative path must never
 * become a workspace of its own (a header that reads `. (216 tool calls)` is
 * the symptom).
 */
export function absolutePath(path: string | null | undefined, cwd?: string | null): string | null {
  if (!path) return null;
  if (path.startsWith("/")) return path;
  // an unexpanded variable, a flag, or `-` is not a path at all
  if (/^[-$~]/.test(path)) return null;
  if (!cwd || !cwd.startsWith("/")) return null;
  return resolve(cwd, path);
}

/** The repository a command ran in, from its own text: `-C <path>` or a leading
 *  `cd <path>`, made absolute against the session's cwd. */
export function commandRepoPath(command: string, cwd?: string | null): string | null {
  const dashC = new RegExp(`(?:^|\\s)-C\\s+(${PATH_ARG})`).exec(command);
  if (dashC?.[1]) return absolutePath(pathArgument(dashC[1]), cwd);
  const cd = new RegExp(`(?:^|[;&|]\\s*)cd\\s+(${PATH_ARG})`).exec(command);
  return absolutePath(cd?.[1] ? pathArgument(cd[1]) : null, cwd);
}

export interface CommandSegment {
  text: string;
  dir: string | null;
  /** true when a `cd`/`-C` in this command named the directory; false when the
   *  directory is only where the session happened to start */
  named: boolean;
}

/**
 * A command, cut into the segments a shell would run in order, each carrying
 * the directory in force WHEN IT RAN.
 *
 * A newline is a separator like `;` — a script whose `cd` sits on line one and
 * whose `git log` sits on line three has changed directory before the log runs,
 * and flattening the newline to a space hid that: one real session reported
 * another repository's commit under its own folder. A reading belongs to the
 * NEAREST preceding `cd`/`-C`, never to an earlier one across a change.
 *
 * A `cd` whose target cannot be resolved — a loop variable, an unexpanded
 * `$HOME`, `~`, a relative path with no cwd — leaves the directory UNKNOWN
 * (`dir: null`) until the next resolvable `cd`. The shell moved somewhere this
 * file cannot name, so every reading after it is discarded rather than credited
 * to wherever the session started: `for R in …; do cd "$R"; git log -1; done`
 * is how another repository's release commit ended up reported as this one's.
 * A `-C <absolute>` still names its own directory inside such a segment.
 */
export function commandSegments(command: string, cwd?: string | null): CommandSegment[] {
  const flat = command.replace(/\\\r?\n/g, " ").replace(/\r?\n/g, " ; ");
  const cdRe = new RegExp(`^cd\\s+(${PATH_ARG})`);
  const dashCRe = new RegExp(`(?:^|\\s)-C\\s+(${PATH_ARG})`);
  const out: CommandSegment[] = [];
  let dir: string | null = cwd ?? null;
  let named = false;
  for (const raw of flat.split(/\s*(?:&&|\|\||[;|])\s*/)) {
    const text = raw.trim();
    if (!text) continue;
    const cd = cdRe.exec(text);
    if (cd?.[1]) {
      dir = absolutePath(pathArgument(cd[1]), dir);
      named = true;
      out.push({ text, dir, named });
      continue;
    }
    // `-C` applies to its own command only, and does not move the shell
    const dashC = dashCRe.exec(text);
    if (dashC?.[1]) { out.push({ text, dir: absolutePath(pathArgument(dashC[1]), dir), named: true }); continue; }
    out.push({ text, dir, named });
  }
  return out;
}

const normalize = (path: string): string => (path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path);

/**
 * worktree path → repository workspace key, learned from the
 * `git worktree add <path>` calls the session itself made.
 */
export function worktreesFromCommands(commands: Iterable<string>, cwd?: string | null): Map<string, string> {
  const map = new Map<string, string>();
  for (const raw of commands) {
    const command = expandCommandVars(raw);
    const add = /\bgit\b[^\n;&|]*\bworktree\s+add\b([^\n;&|]*)/.exec(command);
    if (!add) continue;
    const tokens = (add[1] ?? "").match(/"[^"]+"|'[^']+'|\S+/g) ?? [];
    let path: string | null = null;
    for (let index = 0; index < tokens.length; index++) {
      const token = tokens[index]!;
      if (token.startsWith("-")) { if (/^(?:-b|-B|--reason)$/.test(token)) index++; continue; }
      path = unquote(token);
      break;
    }
    const absolute = absolutePath(path, cwd);
    if (!absolute) continue;
    const repo = workspaceKey(commandRepoPath(command, cwd) ?? cwd ?? null);
    if (repo) map.set(normalize(absolute), repo);
  }
  return map;
}

/** A `.git` FILE pointing at `gitdir: …/worktrees/<name>` — the repository it belongs to. */
function repoOfGitFile(path: string): string | null {
  let dir = normalize(path);
  for (;;) {
    const gitPath = join(dir, ".git");
    if (existsSync(gitPath)) {
      let stats;
      try { stats = statSync(gitPath); } catch { return null; }
      if (stats.isDirectory()) return null;
      let pointer = "";
      try { pointer = readFileSync(gitPath, "utf8"); } catch { return null; }
      const target = /^gitdir:\s*(.+)$/m.exec(pointer)?.[1]?.trim();
      if (!target) return null;
      const marker = target.indexOf("/.git/worktrees/");
      if (marker > 0) return target.slice(0, marker);
      return target.endsWith("/.git") ? target.slice(0, -"/.git".length) : null;
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * The workspace a path belongs to. A path under an excluded workspace (scratch,
 * /tmp, the home directory) is still real work when it is a worktree of a real
 * repository — by the trace's own `git worktree add`, or by a `.git` file that
 * still resolves on disk.
 */
export function workspaceOf(path: string, worktrees?: Map<string, string>): string | null {
  const key = workspaceKey(path);
  if (key && !isExcludedWorkspace(key)) return key;
  const normalized = normalize(path);
  if (worktrees) {
    for (const [worktree, repo] of worktrees) {
      if (normalized === worktree || normalized.startsWith(worktree + "/")) return repo;
    }
  }
  return repoOfGitFile(normalized) ?? key;
}
