import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { dirname, join, resolve } from "path";
import { RULES } from "./basic";

export type EgressAction = "redacted" | "borderline";

export interface Detection {
  kind: string;
  action: EgressAction;
  start: number;
  end: number;
}

const MAX_ENV_BYTES = 1024 * 1024;

function cloneGlobal(re: RegExp): RegExp {
  let flags = re.flags;
  if (!flags.includes("g")) flags += "g";
  if (!flags.includes("d")) flags += "d"; // hasIndices: exact capture-group spans
  return new RegExp(re.source, flags);
}

function addSpan(out: Detection[], kind: string, start: number, end: number, action: EgressAction = "redacted"): void {
  if (start >= 0 && end > start) out.push({ kind, action, start, end });
}

function captureSpan(match: RegExpExecArray, capture: string | undefined, captureIndex: number): [number, number] | null {
  if (!capture) return null;
  // hasIndices gives the group's true position. indexOf would find the FIRST
  // occurrence of the captured string — masking the username in admin:admin@.
  const span = (match as RegExpExecArray & { indices?: Array<[number, number]> }).indices?.[captureIndex];
  if (span) return [span[0], span[1]];
  const from = match[0].indexOf(capture);
  if (from < 0) return null;
  const start = match.index + from;
  return [start, start + match[captureIndex]!.length];
}

function sorted(spans: Detection[]): Detection[] {
  return spans.sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start) || a.kind.localeCompare(b.kind));
}

function detectCapture(text: string, kind: string, re: RegExp, captureIndex: number): Detection[] {
  const out: Detection[] = [];
  const r = cloneGlobal(re);
  for (let m = r.exec(text); m; m = r.exec(text)) {
    const span = captureSpan(m, m[captureIndex], captureIndex);
    if (span) addSpan(out, kind, span[0], span[1]);
  }
  return out;
}

export function detectFormat(text: string): Detection[] {
  const out: Detection[] = [];

  for (const [kind, rule] of RULES) {
    if (kind === "conn-string") continue;
    const r = cloneGlobal(rule);
    for (let m = r.exec(text); m; m = r.exec(text)) addSpan(out, kind, m.index, m.index + m[0].length);
  }

  out.push(...detectCapture(text, "conn-string", /\b(?:mongodb(?:\+srv)?|postgres(?:ql)?|mysql|redis|amqp):\/\/[^\s:@/]+:([^\s@/]+)@/g, 1));
  out.push(...detectCapture(text, "aws-secret-access-key", /\b(?:aws[_-]?secret(?:[_-]?access)?[_-]?key|secret[_-]?access[_-]?key)\b[^\r\n]{0,40}?\s*[:=]\s*["']?([A-Za-z0-9/+=]{40})["']?/gi, 1));
  out.push(...detectCapture(text, "twilio-token", /\b(?:AC|SK)[0-9a-fA-F]{32}\b/g, 0));
  // assignment-secret: mask VALUES after secret-ish keys — but never code. AI
  // coding traces are full of `token = jwt.sign(...)`; masking identifiers and
  // call chains would shred the handoff. Code shapes: a call `name(...)`, or a
  // digit-free dotted chain `config.headers.authorization`.
  {
    const re = /\b(?:api[_-]?key|secret|token|password|authorization)\b\s*[:=]\s*["']?([^\s'",;`()<>{}$]{12,})/gid;
    const isCodeShape = (v: string, followedByParen: boolean) =>
      followedByParen
      || (!/\d/.test(v) && /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+$/.test(v));
    for (let m = re.exec(text); m; m = re.exec(text)) {
      const span = captureSpan(m, m[1], 1);
      if (!span) continue;
      if (isCodeShape(m[1]!, text[span[1]] === "(")) continue;
      addSpan(out, "assignment-secret", span[0], span[1]);
    }
  }
  out.push(...detectCapture(text, "bearer-token", /\bBearer\s+([A-Za-z0-9._~+/=-]{20,})\b/g, 1));
  out.push(...detectCapture(text, "basic-auth-url", /\bhttps?:\/\/[^\s:@/]+:([^\s@/]+)@/gi, 1));

  return sorted(out);
}

function shannonEntropy(s: string): number {
  const counts = new Map<string, number>();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let h = 0;
  for (const n of counts.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

function classCount(s: string): number {
  let upper = false, lower = false, digit = false, other = false;
  for (const ch of s) {
    if (/[A-Z]/.test(ch)) upper = true;
    else if (/[a-z]/.test(ch)) lower = true;
    else if (/[0-9]/.test(ch)) digit = true;
    else other = true;
  }
  return Number(upper) + Number(lower) + Number(digit) + Number(other);
}

function extendedToken(text: string, start: number, end: number): string {
  let a = start;
  let b = end;
  while (a > 0 && !/\s/.test(text[a - 1]!)) a--;
  while (b < text.length && !/\s/.test(text[b]!)) b++;
  return text.slice(a, b).replace(/^[("'`<]+|[),."'`>]+$/g, "");
}

function isUuid(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(s);
}

function isIsoTimestamp(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?$/.test(s);
}

function isDomain(s: string): boolean {
  return /^[a-z0-9](?:[a-z0-9-]{0,62}\.)+[a-z]{2,}$/i.test(s);
}

function isUrlWithoutCredentials(s: string): boolean {
  try {
    const u = new URL(s);
    return (u.protocol === "http:" || u.protocol === "https:") && !u.username && !u.password;
  } catch {
    return false;
  }
}

function isPathLike(s: string): boolean {
  return s.startsWith("./")
    || s.startsWith("../")
    || s.startsWith("~/")
    || s.startsWith("/")
    || /^[A-Za-z]:[\\/]/.test(s)
    || /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+\.[A-Za-z0-9]{1,8}$/.test(s);
}

function isEntropyGuarded(candidate: string, context: string): boolean {
  if (isUuid(candidate)) return true;
  if (/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(candidate)) return true;
  if (/^\d+$/.test(candidate)) return true;
  if (isIsoTimestamp(candidate)) return true;
  if (context.startsWith("data:")) return true;
  if (isPathLike(context)) return true;
  if (isUrlWithoutCredentials(context)) return true;
  if (isDomain(candidate) || isDomain(context)) return true;
  if (/^[a-z]+$/i.test(candidate) && candidate.length <= 64 && shannonEntropy(candidate) < 4.2) return true;
  return false;
}

export function detectEntropy(text: string): Detection[] {
  const out: Detection[] = [];
  const re = /[A-Za-z0-9+/=_.-]{24,}/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const candidate = m[0];
    const context = extendedToken(text, m.index, m.index + candidate.length);
    if (isEntropyGuarded(candidate, context)) continue;
    const entropy = shannonEntropy(candidate);
    if (entropy >= 4.0 || (candidate.length >= 32 && classCount(candidate) >= 3)) {
      addSpan(out, "entropy", m.index, m.index + candidate.length, "borderline");
    }
  }
  return sorted(out);
}

function envDirs(cwd?: string | null): string[] {
  const home = process.env.HOME ? resolve(process.env.HOME) : null;
  const dirs: string[] = [];
  const seen = new Set<string>();
  const add = (d: string) => {
    const r = resolve(d);
    if (!seen.has(r)) {
      seen.add(r);
      dirs.push(r);
    }
  };

  if (cwd) {
    let cur = resolve(cwd);
    add(cur);
    if (home && (cur === home || cur.startsWith(`${home}/`))) {
      while (cur !== home) {
        cur = dirname(cur);
        add(cur);
      }
    }
  }
  if (home) add(home);
  return dirs;
}

function envFiles(cwd?: string | null): string[] {
  const files: string[] = [];
  for (const dir of envDirs(cwd)) {
    let names: string[];
    try { names = readdirSync(dir).sort(); } catch { continue; }
    for (const name of names) {
      if (!/^\.env(?:\..+)?$/.test(name)) continue;
      const p = join(dir, name);
      try {
        const st = statSync(p);
        if (st.isFile() && st.size <= MAX_ENV_BYTES) files.push(p);
      } catch { /* skip */ }
    }
  }
  return files;
}

function stripQuotes(raw: string): string {
  const v = raw.trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) return v.slice(1, -1);
  return v;
}

function isBenignEnvValue(value: string): boolean {
  const v = value.trim();
  const lower = v.toLowerCase();
  if (["true", "false", "yes", "no", "null", "undefined", "none"].includes(lower)) return true;
  if (/^\d+$/.test(v)) return true;
  if (/^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:\/.*)?$/i.test(v)) return true;
  // NOTE: only a genuinely path-shaped value is benign. A bare `includes("/")`
  // test would skip base64 secrets and slash-containing passphrases entirely.
  if (/^(?:localhost|127\.0\.0\.1|::1)(?::\d+)?$/i.test(v)) return true;
  if (isPathLike(v)) return true;
  if (isDomain(v)) return true;
  return false;
}

export interface EnvSecret {
  key: string;
  variants: string[];
}

/** Exported so callers scrubbing MANY texts for one session (per-line fallback
 *  in packaging) can collect once instead of re-reading .env files per call. */
export function collectEnvSecrets(cwd?: string | null): EnvSecret[] {
  const out: EnvSecret[] = [];
  for (const file of envFiles(cwd)) {
    let text: string;
    try {
      if (!existsSync(file)) continue;
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const line of text.split(/\r?\n/)) {
      const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
      if (!m) continue;
      const key = m[1]!;
      const value = stripQuotes(m[2]!);
      if (value.length < 8 || isBenignEnvValue(value)) continue;
      const variants = new Set([value]);
      variants.add(JSON.stringify(value).slice(1, -1));
      variants.add(encodeURIComponent(value));
      out.push({ key, variants: [...variants].filter((v) => v.length >= 8) });
    }
  }
  return out;
}

export function detectEnvValues(text: string, cwd?: string | null, pre?: EnvSecret[]): Detection[] {
  const out: Detection[] = [];
  for (const secret of pre ?? collectEnvSecrets(cwd)) {
    for (const variant of secret.variants) {
      let at = text.indexOf(variant);
      while (at >= 0) {
        addSpan(out, `env:${secret.key}`, at, at + variant.length);
        at = text.indexOf(variant, at + Math.max(1, variant.length));
      }
    }
  }
  return sorted(out);
}
