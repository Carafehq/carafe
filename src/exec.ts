export type ExecResult = { ok: boolean; out: string; stdout?: Buffer; stderr?: Buffer; timedOut?: boolean };
/** `input` feeds the child's stdin — used to BATCH git plumbing (hash-object
 *  --stdin-paths, update-index --index-info) instead of one spawn per file. */
export type ExecFn = (cmd: string[], cwd: string, env?: Record<string, string>, input?: string | Buffer) => ExecResult;

export interface ExecOptions {
  /** Use only for operations that are safe to abandon. */
  timeoutMs?: number;
  onTimeout?: (cmd: readonly string[], timeoutMs: number) => void;
}

export function realExec(cmd: string[], cwd: string, env: Record<string, string> = {}, input?: string | Buffer, opts: ExecOptions = {}): ExecResult {
  try {
    const r = Bun.spawnSync(cmd, {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
      stdin: input !== undefined ? Buffer.from(input) : undefined,
      env: { ...process.env, ...env, GH_PROMPT_DISABLED: "1" },
      ...(opts.timeoutMs === undefined ? {} : { timeout: opts.timeoutMs, killSignal: "SIGKILL" }),
    });
    const stdout = Buffer.from(r.stdout);
    const stderr = Buffer.from(r.stderr);
    if (r.exitedDueToTimeout && opts.timeoutMs !== undefined) opts.onTimeout?.(cmd, opts.timeoutMs);
    return {
      ok: r.exitCode === 0,
      out: (r.exitCode === 0 ? stdout : (stderr.length ? stderr : stdout)).toString().trim(),
      stdout,
      stderr,
      ...(r.exitedDueToTimeout ? { timedOut: true } : {}),
    };
  } catch {
    return { ok: false, out: "" };
  }
}
