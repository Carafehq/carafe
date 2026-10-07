import { existsSync, readFileSync, writeFileSync } from "fs";
import { join, resolve } from "path";
import type { CarafeStore } from "../format/store";
import { realExec, type ExecFn } from "../exec";

export interface CheckpointSyncEntry {
  enabled: boolean;
  remote: string;
  publicOk?: boolean;
}

interface StoreConfig {
  version?: number;
  created?: string;
  checkpointKeep?: number;
  checkpointSync?: Record<string, CheckpointSyncEntry>;
  [key: string]: unknown;
}

function configPath(store: CarafeStore): string {
  return join(store.root, "config.json");
}

export function readStoreConfig(store: CarafeStore): StoreConfig {
  try { return JSON.parse(readFileSync(configPath(store), "utf8")) as StoreConfig; }
  catch { return { version: 1 }; }
}

function writeStoreConfig(store: CarafeStore, cfg: StoreConfig): void {
  writeFileSync(configPath(store), JSON.stringify(cfg, null, 2));
}

function git(cwd: string, args: string[], exec: ExecFn) {
  return exec(["git", ...args], cwd);
}

export function remoteUrl(cwd: string, remote: string, exec: ExecFn = realExec): string | null {
  const r = git(cwd, ["config", "--get", `remote.${remote}.url`], exec);
  return r.ok && r.out ? r.out : null;
}

export function syncKey(cwd: string, remote = "origin", exec: ExecFn = realExec): string {
  return remoteUrl(cwd, remote, exec) ?? resolve(cwd);
}

function parseVisibility(out: string): "PUBLIC" | "PRIVATE" | "INTERNAL" | null {
  const text = out.trim();
  if (text === "PUBLIC" || text === "PRIVATE" || text === "INTERNAL") return text;
  try {
    const v = JSON.parse(text)?.visibility;
    return v === "PUBLIC" || v === "PRIVATE" || v === "INTERNAL" ? v : null;
  } catch {
    return null;
  }
}

export function repoVisibility(cwd: string, exec: ExecFn = realExec): "PUBLIC" | "PRIVATE" | "INTERNAL" | null {
  const r = exec(["gh", "repo", "view", "--json", "visibility"], cwd);
  if (!r.ok) return null;
  return parseVisibility(r.out);
}

export function syncEntryForCwd(store: CarafeStore, cwd: string, remote = "origin", exec: ExecFn = realExec): { key: string; entry: CheckpointSyncEntry | null } {
  const key = syncKey(cwd, remote, exec);
  const cfg = readStoreConfig(store);
  return { key, entry: cfg.checkpointSync?.[key] ?? null };
}

export function enableCheckpointSync(
  store: CarafeStore,
  cwd: string,
  opts: { remote?: string; publicOk?: boolean; yes?: boolean; exec?: ExecFn; confirm?: (message: string) => boolean } = {},
): { ok: boolean; message: string; key: string } {
  const exec = opts.exec ?? realExec;
  const remote = opts.remote ?? "origin";
  const key = syncKey(cwd, remote, exec);
  const visibility = repoVisibility(cwd, exec);
  if (visibility === "PUBLIC" && !opts.publicOk) {
    return { ok: false, key, message: "repo visibility is PUBLIC; rerun with --public-ok to allow pushing checkpoint refs" };
  }
  if (!visibility && !opts.yes) {
    const msg = "could not verify repo visibility";
    if (!opts.confirm?.(`${msg}; enable checkpoint sync anyway?`)) return { ok: false, key, message: msg };
  }
  const cfg = readStoreConfig(store);
  cfg.checkpointSync = cfg.checkpointSync ?? {};
  cfg.checkpointSync[key] = { enabled: true, remote, ...(opts.publicOk ? { publicOk: true } : {}) };
  writeStoreConfig(store, cfg);
  return { ok: true, key, message: `checkpoint sync enabled for ${key}` };
}

export function disableCheckpointSync(store: CarafeStore, cwd: string, opts: { remote?: string; exec?: ExecFn } = {}): { ok: boolean; message: string; key: string } {
  const exec = opts.exec ?? realExec;
  const remote = opts.remote ?? "origin";
  const key = syncKey(cwd, remote, exec);
  const cfg = readStoreConfig(store);
  if (cfg.checkpointSync?.[key]) cfg.checkpointSync[key] = { ...cfg.checkpointSync[key]!, enabled: false };
  writeStoreConfig(store, cfg);
  return { ok: true, key, message: `checkpoint sync disabled for ${key}` };
}

export function checkpointSyncEnabled(store: CarafeStore, cwd: string, exec: ExecFn = realExec): CheckpointSyncEntry | null {
  const cfg = readStoreConfig(store);
  const originKey = syncKey(cwd, "origin", exec);
  const entry = cfg.checkpointSync?.[originKey] ?? cfg.checkpointSync?.[resolve(cwd)] ?? null;
  return entry?.enabled ? entry : null;
}

export function syncStatus(store: CarafeStore, cwd: string | null, exec: ExecFn = realExec): Array<{ key: string; remote: string; enabled: boolean; refCount: number }> {
  const cfg = readStoreConfig(store);
  const rows: Array<{ key: string; remote: string; enabled: boolean; refCount: number }> = [];
  for (const [key, entry] of Object.entries(cfg.checkpointSync ?? {})) {
    let refCount = 0;
    if (cwd && existsSync(cwd)) {
      const r = exec(["git", "for-each-ref", "--format=%(refname)", "refs/carafe/checkpoints"], cwd);
      refCount = r.ok && r.out ? r.out.split("\n").filter(Boolean).length : 0;
    }
    rows.push({ key, remote: entry.remote, enabled: entry.enabled, refCount });
  }
  return rows;
}
