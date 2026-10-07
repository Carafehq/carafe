import { readFileSync } from "fs";
import { join } from "path";
import { createInterface } from "readline";
import { atomicWriteFileSync } from "../format/store";

export type LiveDecision = "allow" | "deny";
export interface LiveDecisionRecord {
  decision: LiveDecision;
  decidedAt: string;
  by: "tty";
}
export interface LiveConsentConfig {
  liveChecks?: Record<string, Record<string, LiveDecisionRecord>>;
  [key: string]: unknown;
}

export type TtyReader = (timeoutMs: number) => Promise<string | null>;
export type PromptWriter = (text: string) => void;

export const CONSENT_TIMEOUT_MS = 60_000;
export const CONSENT_INTRO = "carafe can check whether this project's service is up and put the answer in the handoff.";
export const CONSENT_QUESTION = "Only these addresses, read-only, nothing from your sessions is sent. Allow for this project? [y/N/never]";

interface ConfigRead {
  config: LiveConsentConfig | null;
  /** Missing is writable. Unreadable, invalid, arrays and primitives are not. */
  writable: boolean;
}

function configPath(root: string): string { return join(root, "config.json"); }

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDecisionRecord(value: unknown): value is LiveDecisionRecord {
  return isObject(value) && (value.decision === "allow" || value.decision === "deny")
    && value.by === "tty" && typeof value.decidedAt === "string"
    && Number.isFinite(Date.parse(value.decidedAt));
}

function hasValidLiveChecks(config: Record<string, unknown>): boolean {
  if (config.liveChecks === undefined) return true;
  if (!isObject(config.liveChecks)) return false;
  for (const hosts of Object.values(config.liveChecks)) {
    if (!isObject(hosts)) return false;
    for (const record of Object.values(hosts)) {
      if (!isDecisionRecord(record)) return false;
    }
  }
  return true;
}

export function readConsentConfig(root: string): ConfigRead {
  try {
    const parsed: unknown = JSON.parse(readFileSync(configPath(root), "utf8"));
    return isObject(parsed) && hasValidLiveChecks(parsed)
      ? { config: parsed, writable: true }
      : { config: null, writable: false };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { config: {}, writable: true };
    return { config: null, writable: false };
  }
}

export function decisionFor(config: unknown, workspace: string, host: string): LiveDecision | "unknown" {
  if (!isObject(config) || !isObject(config.liveChecks)) return "unknown";
  const workspaces = config.liveChecks;
  const hosts = workspaces[workspace];
  if (!isObject(hosts)) return "unknown";
  const record = hosts[host];
  return isDecisionRecord(record) ? record.decision : "unknown";
}

export function decisionRecordFor(config: unknown, workspace: string, host: string): LiveDecisionRecord | null {
  if (!isObject(config) || !isObject(config.liveChecks)) return null;
  const hosts = config.liveChecks[workspace];
  if (!isObject(hosts)) return null;
  const record = hosts[host];
  return isDecisionRecord(record) ? record : null;
}

/** Merge decisions into valid config. Corrupt/unreadable config is never replaced. */
export function storeDecision(
  root: string,
  workspace: string,
  hosts: string[],
  decision: LiveDecision,
  decidedAt = new Date().toISOString(),
): boolean {
  const read = readConsentConfig(root);
  if (!read.writable || !read.config) return false;
  const oldChecks = isObject(read.config.liveChecks) ? read.config.liveChecks : {};
  const oldWorkspace = isObject(oldChecks[workspace]) ? oldChecks[workspace] as Record<string, unknown> : {};
  const nextWorkspace: Record<string, unknown> = { ...oldWorkspace };
  for (const host of [...new Set(hosts)].filter(Boolean)) {
    nextWorkspace[host] = { decision, decidedAt, by: "tty" } satisfies LiveDecisionRecord;
  }
  const next: LiveConsentConfig = {
    ...read.config,
    liveChecks: { ...oldChecks, [workspace]: nextWorkspace as Record<string, LiveDecisionRecord> },
  };
  atomicWriteFileSync(configPath(root), JSON.stringify(next, null, 2) + "\n");
  return true;
}

export function forgetWorkspaceDecisions(root: string, workspace: string): boolean {
  const read = readConsentConfig(root);
  if (!read.writable || !read.config) return false;
  const oldChecks = isObject(read.config.liveChecks) ? read.config.liveChecks : {};
  if (!(workspace in oldChecks)) return true;
  const liveChecks = { ...oldChecks };
  delete liveChecks[workspace];
  atomicWriteFileSync(configPath(root), JSON.stringify({ ...read.config, liveChecks }, null, 2) + "\n");
  return true;
}

export function hostOfHealthUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    return url.host || null;
  } catch { return null; }
}

/** One representative trace-observed address per host. */
export function urlsByHost(urls: string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const raw of urls) {
    const host = hostOfHealthUrl(raw);
    if (host && !out.has(host)) out.set(host, raw);
  }
  return out;
}

export function consentPrompt(urls: string[]): string {
  return [CONSENT_INTRO, ...[...urlsByHost(urls).values()].map((url) => `  GET ${url}`), CONSENT_QUESTION].join("\n");
}

export const realTtyReader: TtyReader = async (timeoutMs) => {
  const input = createInterface({ input: process.stdin, terminal: true });
  return await new Promise<string | null>((resolve) => {
    let finished = false;
    const done = (answer: string | null): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      input.close();
      resolve(answer);
    };
    const timer = setTimeout(() => done(null), timeoutMs);
    input.once("line", (line) => done(line));
    input.once("close", () => done(null));
  });
};

export async function askForConsent(
  urls: string[],
  opts: { reader?: TtyReader; write?: PromptWriter; timeoutMs?: number } = {},
): Promise<LiveDecision | "unanswered"> {
  (opts.write ?? ((text) => process.stderr.write(text)))(consentPrompt(urls));
  const answer = (await (opts.reader ?? realTtyReader)(opts.timeoutMs ?? CONSENT_TIMEOUT_MS))?.trim().toLowerCase();
  if (answer === "y" || answer === "yes") return "allow";
  if (answer === "never") return "deny";
  return "unanswered";
}

export interface ResolvedHostConsent {
  decision: LiveDecision | "unknown";
  record: LiveDecisionRecord | null;
}

/** Resolve and, only on an interactive TTY, ask once for all unknown hosts. */
export async function resolveHealthConsent(opts: {
  root: string;
  workspace: string | null;
  urls: string[];
  interactive: boolean;
  noLive?: boolean;
  liveOverride?: boolean;
  reader?: TtyReader;
  write?: PromptWriter;
  now?: string;
}): Promise<Map<string, ResolvedHostConsent>> {
  const byHost = urlsByHost(opts.urls);
  const result = new Map<string, ResolvedHostConsent>();
  if (opts.noLive || opts.liveOverride || !opts.workspace) {
    for (const host of byHost.keys()) result.set(host, { decision: "unknown", record: null });
    return result;
  }

  const read = readConsentConfig(opts.root);
  for (const host of byHost.keys()) {
    const record = decisionRecordFor(read.config, opts.workspace, host);
    result.set(host, { decision: record?.decision ?? "unknown", record });
  }
  const unknown = [...byHost].filter(([host]) => result.get(host)?.decision === "unknown");
  if (!unknown.length || !opts.interactive || !read.writable) return result;

  const answer = await askForConsent(unknown.map(([, url]) => url), { reader: opts.reader, write: opts.write });
  if (answer === "unanswered") return result;
  const hosts = unknown.map(([host]) => host);
  const decidedAt = opts.now ?? new Date().toISOString();
  if (!storeDecision(opts.root, opts.workspace, hosts, answer, decidedAt)) return result;
  for (const host of hosts) {
    const record: LiveDecisionRecord = { decision: answer, decidedAt, by: "tty" };
    result.set(host, { decision: answer, record });
  }
  return result;
}
