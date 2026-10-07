import { resolve } from "path";
import { CarafeStore } from "../format/store";
import { readSession } from "../format/sessions";
import { listWithHierarchy, workspaceKey } from "../query/sessions";
import { extractPieces } from "../handoff/pieces";
import { healthUrlsFromTrace } from "../handoff/state";
import {
  CONSENT_TIMEOUT_MS,
  consentPrompt,
  decisionRecordFor,
  forgetWorkspaceDecisions,
  hostOfHealthUrl,
  readConsentConfig,
  realTtyReader,
  storeDecision,
  type PromptWriter,
  type TtyReader,
} from "../handoff/consent";

export interface LiveCommandOptions {
  workspace?: string;
  host?: string;
  store?: CarafeStore;
  isTty?: boolean;
  reader?: TtyReader;
  stdout?: PromptWriter;
  stderr?: PromptWriter;
  now?: string;
}

function normalizeHost(raw: string): string | null {
  try { return new URL(raw.includes("://") ? raw : `https://${raw}`).host || null; }
  catch { return null; }
}

function workspaceFrom(path: string): string | null {
  return workspaceKey(resolve(path));
}

/** Trace-observed URLs only, across sessions belonging to this workspace. */
export function healthUrlsForWorkspace(store: CarafeStore, workspace: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const session of listWithHierarchy(store).sessions) {
    if (workspaceKey(session.cwd) !== workspace) continue;
    try {
      const events = readSession(store, session.tool, session.sessionId);
      for (const url of healthUrlsFromTrace(events, extractPieces(events, {}, {}))) {
        if (!seen.has(url)) { seen.add(url); out.push(url); }
      }
    } catch { /* one unreadable session must not hide the others */ }
  }
  return out;
}

function knownHostsFor(config: unknown, workspace: string): string[] {
  if (typeof config !== "object" || config === null || Array.isArray(config)) return [];
  const checks = (config as { liveChecks?: unknown }).liveChecks;
  if (typeof checks !== "object" || checks === null || Array.isArray(checks)) return [];
  const hosts = (checks as Record<string, unknown>)[workspace];
  return typeof hosts === "object" && hosts !== null && !Array.isArray(hosts) ? Object.keys(hosts) : [];
}

function targetsFor(store: CarafeStore, workspace: string, requestedHost?: string): { hosts: string[]; urls: string[] } | null {
  const discovered = healthUrlsForWorkspace(store, workspace);
  const byHost = new Map<string, string>();
  for (const url of discovered) {
    const host = hostOfHealthUrl(url);
    if (host && !byHost.has(host)) byHost.set(host, url);
  }
  if (requestedHost) {
    const host = normalizeHost(requestedHost);
    if (!host) return null;
    return { hosts: [host], urls: byHost.has(host) ? [byHost.get(host)!] : [] };
  }
  return { hosts: [...byHost.keys()], urls: [...byHost.values()] };
}

export async function runLiveCommand(subcommand: string | undefined, opts: LiveCommandOptions = {}): Promise<number> {
  const out = opts.stdout ?? ((text) => process.stdout.write(text));
  const err = opts.stderr ?? ((text) => process.stderr.write(text));
  const isTty = opts.isTty ?? (process.stdin.isTTY === true && process.stdout.isTTY === true);
  // Refuse before constructing the store: even creating config.json would make
  // the non-human path observably state-changing.
  if (subcommand === "allow" && !isTty) {
    err("Allowing network checks needs a person at a terminal. Run this yourself: carafe live allow\n");
    return 1;
  }
  const store = opts.store ?? new CarafeStore();
  const selectedWorkspace = opts.workspace ? workspaceFrom(opts.workspace) : null;
  const read = readConsentConfig(store.root);

  if (subcommand === "status") {
    if (!read.config) { out("live checks: unknown (config is unreadable or corrupt)\n"); return 0; }
    const workspaces = selectedWorkspace ? [selectedWorkspace] : Object.keys(read.config.liveChecks ?? {});
    let count = 0;
    for (const workspace of workspaces) {
      for (const host of knownHostsFor(read.config, workspace).sort()) {
        const record = decisionRecordFor(read.config, workspace, host);
        if (!record) continue;
        out(`${workspace}\t${host}\t${record.decision}\t${record.decidedAt}\t${record.by}\n`);
        count++;
      }
    }
    if (!count) out("no stored live-check decisions\n");
    return 0;
  }

  const workspace = selectedWorkspace ?? workspaceFrom(process.cwd());
  if (!workspace) { err("could not determine a workspace\n"); return 1; }

  if (subcommand === "forget") {
    if (!forgetWorkspaceDecisions(store.root, workspace)) {
      err("config is unreadable or corrupt; it was left untouched\n");
      return 1;
    }
    out(`forgot live-check decisions for ${workspace}\n`);
    return 0;
  }

  if (subcommand !== "allow" && subcommand !== "deny") {
    err("usage: carafe live status|allow|deny|forget [--workspace PATH] [--host H]\n");
    return 1;
  }

  const targets = targetsFor(store, workspace, opts.host);
  if (!targets) { err(`invalid host: ${opts.host}\n`); return 1; }
  if (subcommand === "deny") {
    const hosts = targets.hosts.length ? targets.hosts : knownHostsFor(read.config, workspace);
    if (!hosts.length) { err("no health hosts found for this workspace\n"); return 1; }
    if (!storeDecision(store.root, workspace, hosts, "deny", opts.now)) {
      err("config is unreadable or corrupt; it was left untouched\n");
      return 1;
    }
    out(`denied live checks for ${hosts.join(", ")} in ${workspace}\n`);
    return 0;
  }

  if (!targets.hosts.length || !targets.urls.length) {
    err("no trace-observed health addresses found for this workspace\n");
    return 1;
  }
  err(consentPrompt(targets.urls));
  const answer = (await (opts.reader ?? realTtyReader)(CONSENT_TIMEOUT_MS))?.trim().toLowerCase();
  if (answer !== "yes") { err("\npermission not stored\n"); return 1; }
  if (!storeDecision(store.root, workspace, targets.hosts, "allow", opts.now)) {
    err("\nconfig is unreadable or corrupt; it was left untouched\n");
    return 1;
  }
  out(`allowed live checks for ${targets.hosts.join(", ")} in ${workspace}\n`);
  return 0;
}
