#!/usr/bin/env bun
/**
 * Task 0 — capture-format spike.
 * Reads real Claude Code + Codex session files (READ-ONLY) and reports:
 *   - file layout + event schemas (type histograms, top-level keys, parse-error rate)
 *   - dedup floor + gzip ratio (validates the storage-cost math)
 *   - secrets-shaped hit COUNTS (validates redaction urgency)
 * Privacy rule: this script never prints or persists captured content — only
 * shapes, counts, sizes, and paths. Report is gitignored.
 */
import { createHash } from "crypto";
import { readdirSync, statSync } from "fs";
import { join } from "path";
import { gzipSync } from "bun";

const HOME = process.env.HOME!;
const REPORT = join(import.meta.dir, "../../SPIKE-REPORT.md");

// ---------- secrets-shaped detectors (counts only, values never surfaced) ----------
const SECRET_RULES: Array<[string, RegExp]> = [
  ["aws-access-key", /\bAKIA[0-9A-Z]{16}\b/],
  ["github-token", /\bgh[pousr]_[A-Za-z0-9]{20,}\b/],
  ["stripe-live-key", /\bsk_live_[A-Za-z0-9]{10,}\b/],
  ["slack-token", /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/],
  ["private-key-block", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["jwt-shaped", /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{6,}/],
  ["conn-string-with-creds", /\b(?:mongodb(?:\+srv)?|postgres(?:ql)?|mysql|redis|amqp):\/\/[^\s:@/]+:[^\s@/]+@/],
  ["sendgrid-key", /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b/],
  ["assignment-context (noisy)", /(?:api[_-]?key|client[_-]?secret|password|passwd|auth[_-]?token)["']?\s*[:=]\s*["'][^"']{12,}["']/i],
];

// ---------- fs walking ----------
function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return out; }
  for (const e of entries) {
    const p = join(dir, e);
    let st; try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) walk(p, out);
    else if (e.endsWith(".jsonl")) out.push(p);
  }
  return out;
}

interface FileMeta { path: string; size: number; mtime: number }
function meta(paths: string[]): FileMeta[] {
  return paths.map((p) => { const s = statSync(p); return { path: p, size: s.size, mtime: s.mtimeMs }; });
}

/** recent + largest, walked until byte budget */
function pickSample(files: FileMeta[], maxBytes: number): FileMeta[] {
  const byRecent = [...files].sort((a, b) => b.mtime - a.mtime).slice(0, 40);
  const byLargest = [...files].sort((a, b) => b.size - a.size).slice(0, 10);
  const seen = new Set<string>(); const picked: FileMeta[] = []; let budget = 0;
  for (const f of [...byRecent, ...byLargest]) {
    if (seen.has(f.path)) continue;
    if (budget + f.size > maxBytes && picked.length > 0) continue;
    seen.add(f.path); picked.push(f); budget += f.size;
  }
  return picked;
}

// ---------- analysis ----------
interface ToolStats {
  tool: string; root: string;
  totalFiles: number; totalBytes: number;
  sampledFiles: number; sampledBytes: number;
  lines: number; parseErrors: number;
  typeCounts: Map<string, number>;
  keysByType: Map<string, Set<string>>;
  uniqueLineBytes: number; dupLineBytes: number;
  gzipInBytes: number; gzipOutBytes: number;
  secretCounts: Map<string, number>;
  filesWithSecrets: Set<string>;
  maxLineBytes: number;
}

function newStats(tool: string, root: string): ToolStats {
  return {
    tool, root, totalFiles: 0, totalBytes: 0, sampledFiles: 0, sampledBytes: 0,
    lines: 0, parseErrors: 0, typeCounts: new Map(), keysByType: new Map(),
    uniqueLineBytes: 0, dupLineBytes: 0, gzipInBytes: 0, gzipOutBytes: 0,
    secretCounts: new Map(), filesWithSecrets: new Set(), maxLineBytes: 0,
  };
}

const GZIP_SAMPLE_CAP = 32 * 1024 * 1024;

async function analyzeTool(tool: string, root: string, maxBytes: number): Promise<ToolStats> {
  const s = newStats(tool, root);
  const files = meta(walk(root));
  s.totalFiles = files.length;
  s.totalBytes = files.reduce((a, f) => a + f.size, 0);
  const sample = pickSample(files, maxBytes);
  const seenHashes = new Set<string>();
  let gzipBuf: Buffer[] = []; let gzipBuffered = 0;

  for (const f of sample) {
    s.sampledFiles++; s.sampledBytes += f.size;
    let text: string;
    try { text = await Bun.file(f.path).text(); } catch { continue; }
    if (gzipBuffered < GZIP_SAMPLE_CAP) {
      const b = Buffer.from(text); gzipBuf.push(b); gzipBuffered += b.length;
    }
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      s.lines++;
      const bytes = Buffer.byteLength(line);
      if (bytes > s.maxLineBytes) s.maxLineBytes = bytes;
      // dedup floor: whole-line content hashing (CAS chunking will beat this)
      const h = createHash("sha256").update(line).digest("hex");
      if (seenHashes.has(h)) s.dupLineBytes += bytes;
      else { seenHashes.add(h); s.uniqueLineBytes += bytes; }
      // secrets-shaped scan (counts only)
      for (const [name, re] of SECRET_RULES) {
        if (re.test(line)) {
          s.secretCounts.set(name, (s.secretCounts.get(name) ?? 0) + 1);
          s.filesWithSecrets.add(f.path);
        }
      }
      // schema discovery
      try {
        const obj = JSON.parse(line);
        let t: string = typeof obj.type === "string" ? obj.type : (typeof obj.role === "string" ? `role:${obj.role}` : "?");
        if (obj.payload && typeof obj.payload.type === "string") t = `${t}/${obj.payload.type}`;
        s.typeCounts.set(t, (s.typeCounts.get(t) ?? 0) + 1);
        if (!s.keysByType.has(t)) s.keysByType.set(t, new Set());
        const ks = s.keysByType.get(t)!;
        for (const k of Object.keys(obj)) if (ks.size < 30) ks.add(k);
        // nested content-block types (CC message.content[])
        const content = obj.message?.content;
        if (Array.isArray(content)) {
          for (const item of content) {
            if (item && typeof item.type === "string") {
              const ct = `${t} » msg.${item.type}`;
              s.typeCounts.set(ct, (s.typeCounts.get(ct) ?? 0) + 1);
            }
          }
        }
      } catch { s.parseErrors++; }
    }
  }
  const joined = Buffer.concat(gzipBuf);
  s.gzipInBytes = joined.length;
  s.gzipOutBytes = joined.length ? gzipSync(joined).length : 0;
  return s;
}

// ---------- report ----------
const MB = (n: number) => (n / 1024 / 1024).toFixed(1) + "MB";
const pct = (a: number, b: number) => (b ? ((a / b) * 100).toFixed(1) + "%" : "n/a");

function section(s: ToolStats): string {
  const types = [...s.typeCounts.entries()].sort((a, b) => b[1] - a[1]);
  const dupRatio = s.dupLineBytes / Math.max(1, s.dupLineBytes + s.uniqueLineBytes);
  const gzipRatio = s.gzipOutBytes / Math.max(1, s.gzipInBytes);
  const effective = (1 - dupRatio) * gzipRatio; // unique-then-compress estimate
  const secrets = [...s.secretCounts.entries()].sort((a, b) => b[1] - a[1]);
  return `## ${s.tool}

Root: \`${s.root}\`
Files: ${s.totalFiles} (${MB(s.totalBytes)} total) — sampled ${s.sampledFiles} files / ${MB(s.sampledBytes)}
Lines parsed: ${s.lines.toLocaleString()} | parse errors: ${s.parseErrors} (${pct(s.parseErrors, s.lines)}) | max line: ${MB(s.maxLineBytes)}

### Storage math (measured on this sample)
- Duplicate-line bytes (dedup floor — CAS chunking will do better): **${pct(s.dupLineBytes, s.dupLineBytes + s.uniqueLineBytes)}**
- gzip ratio on raw sample: **${(1 / Math.max(gzipRatio, 1e-9)).toFixed(1)}:1**
- Estimated effective reduction (dedup → compress): **${(1 / Math.max(effective, 1e-9)).toFixed(1)}:1**

### Secrets-shaped content (COUNTS ONLY — values never read out)
${secrets.length === 0 ? "- none detected in sample" : secrets.map(([n, c]) => `- ${n}: ${c} line hits`).join("\n")}
- files containing ≥1 hit: ${s.filesWithSecrets.size} / ${s.sampledFiles}

### Event types (top 25)
| type | count | top-level keys seen |
|---|---|---|
${types.slice(0, 25).map(([t, c]) => `| \`${t}\` | ${c.toLocaleString()} | ${[...(s.keysByType.get(t.split(" » ")[0]!) ?? [])].slice(0, 12).join(", ")} |`).join("\n")}
`;
}

// ---------- main ----------
const cc = await analyzeTool("Claude Code", join(HOME, ".claude/projects"), 120 * 1024 * 1024);
const cx = await analyzeTool("Codex", join(HOME, ".codex/sessions"), 60 * 1024 * 1024);

const report = `# Carafe — Task 0 capture-format spike report

Generated: ${new Date().toISOString()} (local machine, read-only; this file is gitignored)

${section(cc)}
${section(cx)}

## Layout notes for the daemon
- Claude Code: \`~/.claude/projects/<cwd-encoded-dir>/<session-uuid>.jsonl\` — project dir encodes the working directory; one file per session; append-only during a session.
- Codex: \`~/.codex/sessions/YYYY/MM/DD/rollout-<timestamp>-<uuid>.jsonl\` — date-partitioned; also \`~/.codex/history.jsonl\` (global command history, separate concern).
- Parse-error rate is the format-drift tripwire: alert if it rises after a tool update.
`;

await Bun.write(REPORT, report);
console.log(report);
console.log(`\nWritten to ${REPORT}`);
