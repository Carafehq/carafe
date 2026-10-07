/** User-level background capture service integration. */
import { existsSync, mkdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from "fs";
import { homedir } from "os";
import { isAbsolute, join, resolve } from "path";
import { BUILD_TARGET } from "../version";
import { readWatchStatus, watchStatusAgeMs } from "./watch-status";
import { describeStartup, judgeHeartbeat, pidAlive as realPidAlive, readHeartbeat, readWatchdogMemory, startupPhase, writeWatchdogMemory, type WatchdogVerdict } from "./watch-heartbeat";
import { displayFolder } from "../state/protected-folders";

export type ServiceRunner = (cmd: string[]) => { code: number; out: string };
export type ServicePlatform = "darwin" | "linux";

export interface ServiceOptions {
  platform?: ServicePlatform;
  home?: string;
  serviceDir?: string;
  runner?: ServiceRunner;
  intervalSeconds?: number;
  /** The command this carafe would write into the service (tests); default: this process. */
  program?: string[];
}

export interface ServicePaths {
  serviceDir: string;
  serviceFile: string;
  logPath: string;
  label: string;
  platform: ServicePlatform;
}

export interface WatchReport {
  lastTickAt: string;
  ageMs: number | null;
  indexBacklog: number;
  indexed: number;
  indexFailed: number;
  filesImported: number;
  lastIndexedTitle: string | null;
  /** an index build in progress: title, event count, seconds so far */
  busy: { title: string; eventCount: number; seconds: number } | null;
  lastError: string | null;
}

export interface ServiceStatus {
  path: string;
  present: boolean;
  loaded: boolean;
  running: boolean;
  holderPid: number | null;
  holderAlive: boolean;
  /** what the watcher reports about itself; null when no watcher has written a status file */
  watch: WatchReport | null;
  /** who owns the service: the command its definition runs (see serviceProgram) */
  program: ServiceProgram;
  /** the command this carafe would run as the service */
  thisProgram: string[];
  /** the live watcher is still starting up: "starting up — catching up (…)"; null otherwise */
  startup: string | null;
}

export const SERVICE_LABEL = "com.carafe.watch";
export const SYSTEMD_UNIT = "carafe-watch";

function defaultRunner(cmd: string[]): { code: number; out: string } {
  try {
    const result = Bun.spawnSync({ cmd, stdout: "pipe", stderr: "pipe" });
    return { code: result.exitCode, out: `${result.stdout?.toString() ?? ""}${result.stderr?.toString() ?? ""}` };
  } catch (error) {
    return { code: 127, out: error instanceof Error ? error.message : String(error) };
  }
}

function platformOf(opts: ServiceOptions): ServicePlatform {
  const platform = opts.platform ?? process.platform;
  if (platform !== "darwin" && platform !== "linux") throw new Error(`unsupported service platform: ${platform}`);
  return platform;
}

function homeOf(opts: ServiceOptions): string {
  return opts.home ?? process.env.HOME ?? homedir();
}

function carafeHome(opts: ServiceOptions = {}): string {
  return opts.home ? join(opts.home, ".carafe") : (process.env.CARAFE_HOME ?? join(process.env.HOME ?? homedir(), ".carafe"));
}

export function servicePaths(opts: ServiceOptions = {}): ServicePaths {
  const platform = platformOf(opts);
  const home = homeOf(opts);
  const serviceDir = opts.serviceDir ?? process.env.CARAFE_SERVICE_DIR ?? (
    platform === "darwin" ? join(home, "Library", "LaunchAgents") : join(home, ".config", "systemd", "user")
  );
  const serviceFile = join(serviceDir, platform === "darwin" ? `${SERVICE_LABEL}.plist` : `${SYSTEMD_UNIT}.service`);
  return {
    serviceDir,
    serviceFile,
    logPath: join(carafeHome(opts), "state", "watch-service.log"),
    label: SERVICE_LABEL,
    platform,
  };
}

/**
 * Compiled carafe binaries are self-contained: process.execPath IS the
 * installed binary, so the service execs it directly. In source mode the
 * executable is Bun and argv[1] is the .ts entry — the service must exec
 * [bun, entry, ...], never the .ts file alone (launchd would fail to spawn it).
 */
function programArgv(opts: ServiceOptions = {}): string[] {
  if (opts.program?.length) return opts.program;
  if (BUILD_TARGET !== "source") return [process.execPath];
  const sourceEntry = process.argv[1];
  if (!sourceEntry) return [process.execPath];
  return [process.execPath, isAbsolute(sourceEntry) ? sourceEntry : resolve(sourceEntry)];
}

function xml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function plist(paths: ServicePaths, intervalSeconds: number, program: string[]): string {
  const values = [...program, "watch", "--interval", String(intervalSeconds)];
  const args = values.map((value) => `    <string>${xml(value)}</string>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xml(paths.label)}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>${xml(paths.logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(paths.logPath)}</string>
</dict>
</plist>
`;
}

function systemdQuote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, "\\\"")}"`;
}

function systemdUnit(paths: ServicePaths, intervalSeconds: number, program: string[]): string {
  return `[Unit]
Description=carafe background session capture

[Service]
Type=simple
ExecStart=${program.map(systemdQuote).join(" ")} watch --interval ${intervalSeconds}
Restart=always
StandardOutput=append:${systemdQuote(paths.logPath)}
StandardError=append:${systemdQuote(paths.logPath)}

[Install]
WantedBy=default.target
`;
}

function runnerOf(opts: ServiceOptions): ServiceRunner {
  return opts.runner ?? defaultRunner;
}

function uid(): string {
  return String(typeof process.getuid === "function" ? process.getuid() : 0);
}

function serviceTarget(paths: ServicePaths): string {
  return `gui/${uid()}/${paths.label}`;
}

/**
 * A loaded agent is booted out by its service target (`gui/<uid>/<label>`; a
 * bare label after the domain is refused with "5: Input/output error"), and
 * launchd unloads it asynchronously: wait until `print` no longer finds it,
 * or a following bootstrap fails with the same error while the old agent is
 * still there. Nothing loaded is fine (first enable).
 */
function bootoutAndWait(paths: ServicePaths, runner: ServiceRunner, waitMs = 5_000): void {
  const result = runner(["launchctl", "bootout", serviceTarget(paths)]);
  if (result.code !== 0) return;
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    if (runner(["launchctl", "print", serviceTarget(paths)]).code !== 0) return;
    Bun.sleepSync(100);
  }
}

function serviceLoaded(paths: ServicePaths, runner: ServiceRunner): { loaded: boolean; running: boolean; out: string } {
  const result = paths.platform === "darwin"
    ? runner(["launchctl", "print", `gui/${uid()}/${paths.label}`])
    : runner(["systemctl", "--user", "is-active", SYSTEMD_UNIT]);
  const running = result.code === 0 && (result.out.trim() === "" || /\b(active|running)\b/i.test(result.out));
  return { loaded: result.code === 0, running, out: result.out };
}

/*
 * Ownership rule. The capture service belongs to the carafe its definition
 * runs (launchd ProgramArguments / systemd ExecStart, the arguments before
 * `watch`): the menu bar app's bundled carafe, or a CLI install. Only an
 * EXPLICIT `carafe service enable` (the user, or the app's own toggle and
 * heal) may point the service at a different carafe. Every implicit path
 * keeps the owner:
 *   - `carafe update` never rewrites the definition: when the service runs the
 *     binary it just replaced it is restarted in place (kickstart -k / systemctl
 *     restart); when it runs another carafe it is left as is; it never
 *     installs a service (refreshServiceAfterUpdate).
 *   - install.sh runs `carafe service enable --keep-owner`: a service running
 *     another carafe that still exists is left as is (enableService keepOwner).
 */

export interface ServiceProgram {
  /** whether the service definition file exists */
  defined: boolean;
  /** the command before `watch`; null when the definition is missing, unreadable, or not a carafe watch service */
  argv: string[] | null;
  /** whether argv[0] exists on disk */
  exists: boolean;
}

function xmlDecode(s: string): string {
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}

/** ProgramArguments of an XML launchd plist, or null. */
export function plistProgramArguments(text: string): string[] | null {
  const match = /<key>\s*ProgramArguments\s*<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(text);
  if (!match) return null;
  const args: string[] = [];
  const re = /<string>([\s\S]*?)<\/string>|<string\s*\/>/g;
  for (let m = re.exec(match[1]!); m; m = re.exec(match[1]!)) args.push(xmlDecode(m[1] ?? ""));
  return args;
}

/** The words of a systemd unit's ExecStart (quotes and backslash escapes honoured), or null. */
export function systemdExecStart(text: string): string[] | null {
  const line = text.split("\n").map((l) => l.trim()).find((l) => /^ExecStart\s*=/.test(l));
  if (!line) return null;
  const value = line.replace(/^ExecStart\s*=\s*/, "").replace(/^[-@:+!]+/, "");
  const words: string[] = [];
  let i = 0;
  while (i < value.length) {
    while (i < value.length && /\s/.test(value[i]!)) i++;
    if (i >= value.length) break;
    let word = "";
    if (value[i] === "\"" || value[i] === "'") {
      const quote = value[i++]!;
      while (i < value.length && value[i] !== quote) {
        if (value[i] === "\\" && i + 1 < value.length) i++;
        word += value[i++];
      }
      if (value[i] !== quote) return null; // unterminated quote: unreadable
      i++;
    } else {
      while (i < value.length && !/\s/.test(value[i]!)) {
        if (value[i] === "\\" && i + 1 < value.length) i++;
        word += value[i++];
      }
    }
    words.push(word);
  }
  return words.length ? words : null;
}

/**
 * The command the installed service runs, read from its definition: the
 * arguments before `watch` (as the menu bar app reads it). Read-only; any
 * failure to read or recognise the definition gives argv null.
 */
export function serviceProgram(opts: ServiceOptions = {}): ServiceProgram {
  const paths = servicePaths(opts);
  if (!existsSync(paths.serviceFile)) return { defined: false, argv: null, exists: false };
  let args: string[] | null = null;
  try {
    const text = readFileSync(paths.serviceFile, "utf8");
    args = paths.platform === "darwin" ? plistProgramArguments(text) : systemdExecStart(text);
  } catch {
    args = null;
  }
  const watch = args ? args.indexOf("watch") : -1;
  if (!args || watch <= 0 || !args[0]) return { defined: true, argv: null, exists: false };
  const argv = args.slice(0, watch);
  return { defined: true, argv, exists: existsSync(argv[0]!) };
}

function realOrSame(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/** Two service commands are the same carafe when every word resolves to the same real path (or text). */
export function sameProgram(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length || a.length === 0) return false;
  return a.every((word, i) => word === b[i] || (isAbsolute(word) && isAbsolute(b[i]!) && realOrSame(word) === realOrSame(b[i]!)));
}

export function isServiceLoaded(opts: ServiceOptions = {}): boolean {
  const paths = servicePaths(opts);
  return serviceLoaded(paths, runnerOf(opts)).loaded;
}

/**
 * Write the service definition to run THIS carafe and (re)load it. Explicit
 * `carafe service enable` takes the service over whoever owned it. With
 * `keepOwner` (install.sh) an installed service that runs another carafe
 * which still exists — or whose definition cannot be read — is left exactly
 * as it is; an orphan (its carafe is gone) is taken over.
 */
export function enableService(opts: ServiceOptions & { keepOwner?: boolean } = {}): { ok: boolean; message: string; paths: ServicePaths; left?: boolean } {
  const paths = servicePaths(opts);
  const runner = runnerOf(opts);
  const interval = opts.intervalSeconds ?? Number(process.env.CARAFE_WATCH_INTERVAL ?? 10);
  if (!Number.isFinite(interval) || interval <= 0) throw new Error("watch interval must be greater than zero");
  const program = programArgv(opts);

  if (opts.keepOwner) {
    const owner = serviceProgram(opts);
    if (owner.defined && !owner.argv) {
      return { ok: true, left: true, paths, message: `capture service definition ${paths.serviceFile} could not be read — left as is (run \`carafe service enable\` to replace it)` };
    }
    if (owner.argv && owner.exists && !sameProgram(owner.argv, program)) {
      return { ok: true, left: true, paths, message: `capture service runs ${owner.argv.join(" ")} — left as is (run \`carafe service enable\` to point it at this carafe)` };
    }
  }

  mkdirSync(paths.serviceDir, { recursive: true });
  mkdirSync(join(carafeHome(opts), "state"), { recursive: true });
  writeFileSync(paths.serviceFile, paths.platform === "darwin" ? plist(paths, interval, program) : systemdUnit(paths, interval, program), { mode: 0o644 });

  if (paths.platform === "darwin") {
    bootoutAndWait(paths, runner);
    let loaded = runner(["launchctl", "bootstrap", `gui/${uid()}`, paths.serviceFile]);
    // launchd can still be finishing the unload: a short retry, not a failure.
    for (let attempt = 0; attempt < 3 && loaded.code !== 0; attempt++) {
      Bun.sleepSync(200);
      loaded = runner(["launchctl", "bootstrap", `gui/${uid()}`, paths.serviceFile]);
    }
    if (loaded.code !== 0) return { ok: false, message: `service file installed but launchctl bootstrap failed: ${loaded.out.trim() || `exit ${loaded.code}`}`, paths };
    return { ok: true, message: `capture service enabled (${paths.serviceFile})`, paths };
  }

  const reload = runner(["systemctl", "--user", "daemon-reload"]);
  if (reload.code === 127) {
    return { ok: true, message: `capture service installed but systemctl is unavailable: ${paths.serviceFile}\nrun: systemctl --user daemon-reload && systemctl --user enable --now ${SYSTEMD_UNIT}`, paths };
  }
  if (reload.code !== 0) return { ok: false, message: `service file installed but systemctl daemon-reload failed: ${reload.out.trim() || `exit ${reload.code}`}`, paths };
  const started = runner(["systemctl", "--user", "enable", "--now", SYSTEMD_UNIT]);
  if (started.code !== 0) return { ok: false, message: `service file installed but systemctl enable failed: ${started.out.trim() || `exit ${started.code}`}`, paths };
  return { ok: true, message: `capture service enabled (${paths.serviceFile})`, paths };
}

export function disableService(opts: ServiceOptions = {}): { ok: boolean; message: string; paths: ServicePaths } {
  const paths = servicePaths(opts);
  const runner = runnerOf(opts);
  if (paths.platform === "darwin") {
    bootoutAndWait(paths, runner);
  } else {
    runner(["systemctl", "--user", "disable", "--now", SYSTEMD_UNIT]);
  }
  // This is the exact, name-safe path generated by servicePaths; logs are kept.
  if (existsSync(paths.serviceFile)) unlinkSync(paths.serviceFile);
  return { ok: true, message: `capture service disabled (removed ${paths.serviceFile}; logs kept)`, paths };
}

function lockHolder(root: string): { pid: number | null; alive: boolean } {
  try {
    const raw = readFileSync(join(root, "state", "watch.lock"), "utf8").split("\n")[0]?.trim() ?? "";
    const pid = /^\d+$/.test(raw) ? Number(raw) : 0;
    if (!Number.isSafeInteger(pid) || pid <= 0) return { pid: null, alive: false };
    try {
      process.kill(pid, 0);
      return { pid, alive: true };
    } catch (error) {
      return { pid, alive: (error as NodeJS.ErrnoException).code !== "ESRCH" && (error as NodeJS.ErrnoException).code !== "EPERM" };
    }
  } catch {
    return { pid: null, alive: false };
  }
}

export function statusService(opts: ServiceOptions = {}): ServiceStatus {
  const paths = servicePaths(opts);
  const loaded = serviceLoaded(paths, runnerOf(opts));
  const holder = lockHolder(carafeHome(opts));
  const reported = readWatchStatus(carafeHome(opts));
  const watch: WatchReport | null = reported ? {
    lastTickAt: reported.lastTickAt, ageMs: watchStatusAgeMs(reported), indexBacklog: reported.indexBacklog, indexed: reported.indexed,
    indexFailed: reported.indexFailed, filesImported: reported.filesImported, lastIndexedTitle: reported.lastIndexed?.title ?? reported.lastIndexed?.id ?? null,
    busy: reported.busy ? {
      title: reported.busy.title ?? reported.busy.id, eventCount: reported.busy.eventCount,
      seconds: Math.max(0, Math.round((Date.now() - (Date.parse(reported.busy.since) || Date.now())) / 1000)),
    } : null,
    lastError: reported.lastError,
  } : null;
  // Only the live lock holder's own heartbeat speaks for the watcher now.
  const hb = holder.alive ? readHeartbeat(carafeHome(opts)) : null;
  const phase = hb && hb.pid === holder.pid ? startupPhase(hb) : null;
  return {
    path: paths.serviceFile, present: existsSync(paths.serviceFile), loaded: loaded.loaded, running: loaded.running,
    holderPid: holder.pid, holderAlive: holder.alive, watch, program: serviceProgram(opts), thisProgram: programArgv(opts),
    startup: phase ? describeStartup(phase) : null,
  };
}

function formatServiceBinary(status: ServiceStatus): string {
  const program = status.program;
  if (!program.defined) return "none (no service installed)";
  if (!program.argv) return "unknown (the service definition could not be read)";
  const command = program.argv.join(" ");
  if (!program.exists) return `${command} (missing — \`carafe service enable\` points the service at this carafe)`;
  if (sameProgram(program.argv, status.thisProgram)) return `${command} (this carafe)`;
  return `${command} (another carafe; this one is ${status.thisProgram.join(" ")})`;
}

/** The first four lines are a contract (the menu bar app parses them); the
 * rest describe the watcher's own report and keep the same `key: value` shape. */
export function formatServiceStatus(status: ServiceStatus): string {
  const holder = status.holderAlive && status.holderPid !== null ? `pid ${status.holderPid} alive` : "no live holder";
  const lines = [
    `service file: ${status.present ? "present" : "missing"} (${status.path})`,
    `service loaded: ${status.loaded ? "yes" : "no"}`,
    `service running: ${status.running ? "yes" : "no"}`,
    `watch lock: ${holder}`,
    `service binary: ${formatServiceBinary(status)}`,
  ];
  const watch = status.watch;
  if (!watch) {
    lines.push("last tick: unknown", "index backlog: unknown (no watcher status file; a watcher started before this version reports nothing until restarted with `carafe service enable`)");
  } else {
    lines.push(
      `last tick: ${watch.ageMs == null ? "unknown" : `${Math.round(watch.ageMs / 1000)}s ago`}`,
      `index backlog: ${watch.indexBacklog > 0 ? `${watch.indexBacklog} session${watch.indexBacklog === 1 ? "" : "s"}` : "none"}`,
      `indexed this run: ${watch.indexed}${watch.indexFailed ? ` (${watch.indexFailed} failed)` : ""}${watch.lastIndexedTitle ? ` · last: ${watch.lastIndexedTitle.slice(0, 64)}` : ""}`,
    );
    if (watch.busy) lines.push(`indexing now: ${watch.busy.title.slice(0, 64)} (${watch.busy.eventCount} events, ${watch.busy.seconds}s so far)`);
    if (watch.lastError) lines.push(`last error: ${watch.lastError}`);
  }
  // The menu bar reads this line: while it is present, an old "last tick" is
  // a watcher catching up after a restart, not a stalled one.
  if (status.startup) lines.push(`startup: ${status.startup}`);
  return lines.join("\n");
}

/** launchctl's words (and exit 113) for "no such service in this domain". */
function launchdSaysNotLoaded(result: { code: number; out: string }): boolean {
  return result.code === 113 || /could not find service|service not found/i.test(result.out);
}

/**
 * Restart the watcher whether or not launchd has it loaded. Loaded: `launchctl
 * kickstart -k` (launchd kills it and starts it again from the same plist).
 * Not loaded (booted out, e.g. around an app swap) but the plist is installed:
 * `launchctl bootstrap`, which starts it (RunAtLoad). No plist: one line saying
 * it is not installed. Nothing is written.
 */
export function restartService(opts: ServiceOptions = {}): { ok: boolean; message: string } {
  const paths = servicePaths(opts);
  const runner = runnerOf(opts);
  const notInstalled = { ok: false, message: `watcher not restarted: the capture service is not installed (no ${paths.serviceFile}) — run \`carafe service enable\`` };
  if (paths.platform !== "darwin") {
    const result = runner(["systemctl", "--user", "restart", SYSTEMD_UNIT]);
    if (result.code === 0) return { ok: true, message: "watcher restarted" };
    if (!existsSync(paths.serviceFile)) return notInstalled;
    return { ok: false, message: `watcher restart failed: ${result.out.trim() || `exit ${result.code}`}` };
  }
  const kicked = runner(["launchctl", "kickstart", "-k", serviceTarget(paths)]);
  if (kicked.code === 0) return { ok: true, message: "watcher restarted" };
  // Kickstart failed: only a service launchd does not have is bootstrapped;
  // any other failure of a loaded service is reported as it is.
  const notLoaded = launchdSaysNotLoaded(kicked) || runner(["launchctl", "print", serviceTarget(paths)]).code !== 0;
  if (!notLoaded) return { ok: false, message: `watcher restart failed: ${kicked.out.trim() || `exit ${kicked.code}`}` };
  if (!existsSync(paths.serviceFile)) return notInstalled;
  let loaded = runner(["launchctl", "bootstrap", `gui/${uid()}`, paths.serviceFile]);
  // launchd can still be finishing an unload: a short retry, not a failure.
  for (let attempt = 0; attempt < 3 && loaded.code !== 0; attempt++) {
    Bun.sleepSync(200);
    loaded = runner(["launchctl", "bootstrap", `gui/${uid()}`, paths.serviceFile]);
  }
  if (loaded.code !== 0) return { ok: false, message: `watcher not restarted: the service was not loaded and launchctl bootstrap failed: ${loaded.out.trim() || `exit ${loaded.code}`}` };
  return { ok: true, message: "watcher started (the service was not loaded; bootstrapped from its plist)" };
}

/**
 * After `carafe update` replaced `binary` (a real path; the swap keeps it):
 * restart the service in place when it runs that binary, so the new version
 * runs — the definition is never rewritten. A service that runs another carafe
 * (e.g. Carafe.app's bundled one) is left as is; a missing, unreadable or
 * not-loaded service is left alone. Update never installs a service.
 */
export function refreshServiceAfterUpdate(opts: ServiceOptions & { binary: string; version: string }): { ok: boolean; message: string | null; action: "restarted" | "left" | "none" | "failed" } {
  const paths = servicePaths(opts);
  const owner = serviceProgram(opts);
  if (!owner.argv) return { ok: true, message: null, action: "none" };
  if (!sameProgram(owner.argv, [opts.binary])) {
    return { ok: true, action: "left", message: `capture service runs ${owner.argv[0]} — left as is (update that copy, e.g. Carafe.app, to update the service)` };
  }
  const runner = runnerOf(opts);
  if (!serviceLoaded(paths, runner).loaded) return { ok: true, message: null, action: "none" };
  const result = paths.platform === "darwin"
    ? runner(["launchctl", "kickstart", "-k", serviceTarget(paths)])
    : runner(["systemctl", "--user", "restart", SYSTEMD_UNIT]);
  if (result.code !== 0) {
    return { ok: false, action: "failed", message: `capture service not restarted: ${result.out.trim() || `exit ${result.code}`} — run \`carafe service restart\`` };
  }
  return { ok: true, action: "restarted", message: `capture service restarted on ${opts.version}` };
}

export interface WatchdogReport { verdict: WatchdogVerdict; restarted: boolean; restartError: string | null }

/**
 * The outside watchdog, one check: judge the heartbeat and, only when asked
 * (`--auto-restart`, the menu bar app's minute poll), restart a stuck watcher
 * — at most once per 30 minutes and never while it waits on a permission
 * prompt. The only file written is the watchdog's own memory of when it last
 * checked and last restarted.
 */
export function checkWatchdog(opts: ServiceOptions & { autoRestart?: boolean; nowMs?: number; pidAlive?: (pid: number) => boolean } = {}): WatchdogReport {
  const root = carafeHome(opts);
  const nowMs = opts.nowMs ?? Date.now();
  const memory = readWatchdogMemory(root);
  // Alive means: that pid lives AND still holds the watch lock — a paused
  // service's stale heartbeat whose pid was reused by something else is not a stuck watcher.
  const holderAlive = (pid: number): boolean => realPidAlive(pid) && lockHolder(root).pid === pid;
  const verdict = judgeHeartbeat(readHeartbeat(root), { nowMs, pidAlive: opts.pidAlive ?? holderAlive, memory, mayRestart: opts.autoRestart === true });
  let restarted = false;
  let restartError: string | null = null;
  const nowIso = new Date(nowMs).toISOString();
  const next = { ...memory, lastCheckAt: nowIso };
  if (verdict.autoRestart) {
    const result = restartService(opts);
    restarted = result.ok;
    if (!result.ok) restartError = result.message;
    // A failed attempt counts too: retrying a failing kickstart every minute is the loop this forbids.
    next.lastAutoRestartAt = nowIso;
  }
  if (opts.autoRestart) {
    try { writeWatchdogMemory(root, next); } catch { /* the next check simply forgives less */ }
  }
  return { verdict, restarted, restartError };
}

/** `key: value` lines: the menu bar app parses them (see apps/menubar). */
export function formatWatchdogReport(report: WatchdogReport): string {
  const v = report.verdict;
  const age = v.ageMs == null ? "unknown" : `${Math.round(v.ageMs / 1000)}s ago`;
  const lines = [`watcher: ${v.state}`, `heartbeat: ${age}${v.stage ? ` · stage ${v.stage}${v.detail ? ` (${v.stage === "protected-folder" ? displayFolder(v.detail) : v.detail})` : ""}` : ""}`];
  if (v.state === "stuck") {
    const minutes = Math.max(1, Math.round((v.ageMs ?? 0) / 60_000));
    lines.push(`stuck: Carafe's watcher is stuck (last activity ${minutes} min ago)`);
    if (v.cause === "permission prompt") lines.push(`likely cause: waiting for a macOS permission prompt for ${v.detail ? displayFolder(v.detail) : "a protected folder"} — look for a dialog, or open Privacy settings`);
    else if (v.cause === "index build") lines.push(`likely cause: one index build has run for over 15 minutes`);
    else lines.push(`likely cause: unknown`);
  }
  if (v.startup && v.state !== "stuck") lines.push(`startup: ${describeStartup(v.startup)}`);
  lines.push(`auto restart: ${report.restarted ? "done" : report.restartError ? `failed (${report.restartError})` : v.withheld ? `withheld (${v.withheld})` : "not needed"}`);
  lines.push(`denied folders: ${v.deniedFolders.length ? v.deniedFolders.map((f) => displayFolder(f)).join(", ") : "none"}`);
  return lines.join("\n");
}
