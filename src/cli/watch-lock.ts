import { randomUUID } from "crypto";
import { linkSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "fs";
import { join } from "path";

export interface WatchLock {
  lockPath: string;
  pidPath: string;
  pid: number;
  token: string;
}

export class WatchLockHeldError extends Error {
  code = "ELOCKED" as const;
  constructor(public readonly holderPid: number, lockPath: string) {
    super(holderPid > 0
      ? `Carafe session capture is already running (pid ${holderPid}); lock path: ${lockPath}`
      : `Carafe session capture is already running (pid unknown); lock path: ${lockPath}`);
    this.name = "WatchLockHeldError";
  }
}

const LOCK_STALE_MS = 60_000;
const MAX_ATTEMPTS = 3;
const pidFileOwners = new WeakSet<WatchLock>();

function processIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // The lock directory is user-owned, so a same-user watcher is always
    // signalable. EPERM therefore means this is not our live watcher.
    if (code === "EPERM") return false;
    return code !== "ESRCH";
  }
}

type LockState = { kind: "live"; pid: number } | { kind: "reclaimable"; content?: string } | { kind: "missing" };

function lockState(lockPath: string): LockState {
  let content: string;
  try {
    content = readFileSync(lockPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "missing" };
    try {
      if (Date.now() - statSync(lockPath).mtimeMs > LOCK_STALE_MS) return { kind: "reclaimable" };
    } catch (statError) {
      if ((statError as NodeJS.ErrnoException).code === "ENOENT") return { kind: "missing" };
    }
    return { kind: "live", pid: 0 };
  }

  const lines = content.split("\n");
  const pidLine = lines[0]?.trim() ?? "";
  const tokenLine = lines[1]?.trim() ?? "";
  const pid = /^\d+$/.test(pidLine) ? Number(pidLine) : 0;
  if (!Number.isSafeInteger(pid) || pid <= 0 || !tokenLine) {
    try {
      if (Date.now() - statSync(lockPath).mtimeMs > LOCK_STALE_MS) return { kind: "reclaimable", content };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "missing" };
    }
    return { kind: "live", pid: 0 };
  }
  return processIsAlive(pid) ? { kind: "live", pid } : { kind: "reclaimable", content };
}

function createLock(lockPath: string, stateDir: string, pid: number, token: string): boolean {
  const tempPath = join(stateDir, `watch.lock.${pid}.${randomUUID()}`);
  try {
    // Write the complete identity before linking: linkSync is the atomic
    // create-with-content operation, so no contender sees a torn lock.
    writeFileSync(tempPath, `${pid}\n${token}\n`, { mode: 0o600, flag: "wx" });
    try {
      linkSync(tempPath, lockPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw error;
    }
    return true;
  } finally {
    try { unlinkSync(tempPath); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

function acquire(root: string, writePidFile: boolean): WatchLock | null {
  const stateDir = join(root, "state");
  const lockPath = join(stateDir, "watch.lock");
  const pidPath = join(root, "watch.pid");
  mkdirSync(stateDir, { recursive: true });
  const pid = process.pid;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const token = randomUUID();
    try {
      if (!createLock(lockPath, stateDir, pid, token)) {
        const state = lockState(lockPath);
        if (state.kind === "missing") continue;
        if (state.kind === "live") throw new WatchLockHeldError(state.pid, lockPath);
        const reapPath = `${lockPath}.reap.${process.pid}`;
        try {
          renameSync(lockPath, reapPath);
          if (state.content !== undefined) {
            let movedContent: string;
            try { movedContent = readFileSync(reapPath, "utf8"); }
            catch (error) {
              if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
              throw error;
            }
            if (movedContent !== state.content) {
              // A contender replaced the pathname after our stale read. Do
              // not delete its fresh lock; put it back unless another winner
              // already recreated the pathname.
              try { linkSync(reapPath, lockPath); } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
              }
            }
          }
          try { unlinkSync(reapPath); } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw error;
        }
        continue;
      }

      // Confirm the pathname still carries OUR identity: a reclaimer that read
      // the previous stale lock before our create can rename our fresh lock
      // away (and a third contender may take the freed pathname). Losing here
      // must be a retry, never a false claim of ownership.
      let owned = false;
      try { owned = readFileSync(lockPath, "utf8") === `${pid}\n${token}\n`; } catch { owned = false; }
      if (!owned) continue;

      const lock: WatchLock = { lockPath, pidPath, pid, token };
      if (writePidFile) {
        writeFileSync(pidPath, `${pid}\n`, { mode: 0o600 });
        pidFileOwners.add(lock);
      }
      return lock;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
  }
  throw new Error(`could not acquire the carafe watcher lock after ${MAX_ATTEMPTS} attempts: ${lockPath}`);
}

export function acquireWatchLock(root: string, opts: { writePidFile?: boolean } = {}): WatchLock {
  const lock = acquire(root, opts.writePidFile !== false);
  if (lock) return lock;
  // acquire() only returns null for a retryable race; a final read makes the
  // public throwing API report the current holder when possible.
  const lockPath = join(root, "state", "watch.lock");
  const state = lockState(lockPath);
  throw new WatchLockHeldError(state.kind === "live" ? state.pid : 0, lockPath);
}

export function tryAcquireWatchLock(root: string, opts: { writePidFile?: boolean } = {}): WatchLock | null {
  try {
    return acquire(root, opts.writePidFile !== false);
  } catch (error) {
    if (error instanceof WatchLockHeldError) return null;
    throw error;
  }
}

/** Return the live capture-lock holder, if one exists. */
export function watchLockHolderPid(root: string): number | null {
  const state = lockState(join(root, "state", "watch.lock"));
  return state.kind === "live" && state.pid > 0 ? state.pid : null;
}

export function releaseWatchLock(lock: WatchLock): void {
  let lockGone = false;
  try {
    const content = readFileSync(lock.lockPath, "utf8");
    const [pidLine, tokenLine] = content.split("\n");
    if (Number(pidLine?.trim()) === lock.pid && tokenLine?.trim() === lock.token) {
      try { unlinkSync(lock.lockPath); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      lockGone = true;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") lockGone = true;
  }
  if (!lockGone || !pidFileOwners.has(lock)) return;
  try {
    if (Number(readFileSync(lock.pidPath, "utf8").trim()) === lock.pid) unlinkSync(lock.pidPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") { /* already gone or replaced */ }
  }
}
