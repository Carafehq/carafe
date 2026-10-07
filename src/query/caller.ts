/** Caller identity comes from the process, never from workspace-wide recency. */
import { execFileSync } from "child_process";
import { readFileSync, statSync, mkdirSync } from "fs";
import { join } from "path";
import { atomicWriteFileSync, type CarafeStore } from "../format/store";

export interface CallerHook { session_id?: string; transcript_path?: string | null }
export interface CallerProcess { pid: number; start: string; command: string }
const command = (bin: string, args: string[]): string => {
  try { return execFileSync(bin, args, { encoding: "utf8", timeout: 1000, maxBuffer: 256 * 1024, stdio: ["ignore", "pipe", "ignore"] }); } catch { return ""; }
};
export function callerProcesses(run = command): CallerProcess[] {
  const out: CallerProcess[] = [];
  let pid = process.ppid;
  for (let depth = 0; pid > 1 && depth < 12; depth++) {
    const row = run("ps", ["-p", String(pid), "-o", "ppid=", "-o", "lstart=", "-o", "comm="]).trim();
    const m = /^(\d+)\s+(\w+\s+\w+\s+\d+\s+[\d:]+\s+\d+)\s+(.+)$/.exec(row);
    if (!m) break;
    out.push({ pid, start: m[2]!, command: m[3]! });
    pid = Number(m[1]);
  }
  return out;
}
/** Hook records are process-bound and guarded against PID reuse. No cwd-global pointer. */
export function rememberCaller(store: CarafeStore, hook: CallerHook, parents = callerProcesses()): void {
  const owner = parents.find((p) => /(?:^|\/)(?:claude|codex)(?:$|[- ])/i.test(p.command));
  if (!owner || (!hook.session_id && !hook.transcript_path)) return;
  mkdirSync(join(store.root, "state", "callers"), { recursive: true });
  const path = join(store.root, "state", "callers", `${owner.pid}.json`);
  let sessions: CallerHook[] = [];
  try { const old = JSON.parse(readFileSync(path, "utf8")); if (old.start === owner.start) sessions = old.sessions ?? []; } catch { /* first hook */ }
  sessions = sessions.filter((one) => one.session_id !== hook.session_id || one.transcript_path !== hook.transcript_path);
  sessions.push({ session_id: hook.session_id, transcript_path: hook.transcript_path });
  atomicWriteFileSync(path, JSON.stringify({ sessions: sessions.slice(-64), start: owner.start }));
}
export function callerHook(store: CarafeStore, parents: CallerProcess[]): CallerHook | undefined {
  for (const p of parents) {
    try {
      const data = JSON.parse(readFileSync(join(store.root, "state", "callers", `${p.pid}.json`), "utf8"));
      if (data.start === p.start && data.sessions?.length === 1) return data.sessions[0];
    } catch { /* no hook registered */ }
  }
}
/** Only writable descriptors owned by an ancestor count. Reading another trace does not. */
export function writableTranscripts(parents: CallerProcess[], run = command, modified = (path: string) => statSync(path).mtimeMs): Array<{ path: string; mtimeMs: number }> {
  const found: Array<{ path: string; mtimeMs: number }> = [];
  for (const parent of parents) {
    const output = run("lsof", ["-a", "-p", String(parent.pid), "-Ffan"]);
    let writable = false;
    for (const line of output.split("\n")) {
      if (line.startsWith("f")) writable = false;
      if (line.startsWith("a")) writable = /^a[wu]/.test(line);
      if (writable && line.startsWith("n") && line.endsWith(".jsonl")) {
        const path = line.slice(1);
        try { found.push({ path, mtimeMs: modified(path) }); } catch { /* closed meanwhile */ }
      }
    }
    // The nearest writer is the caller; a parent may own a different session.
    if (found.length) break;
  }
  return found.sort((a, b) => b.mtimeMs - a.mtimeMs);
}
