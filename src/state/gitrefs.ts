import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { tmpdir } from "os";
import { realExec, type ExecFn } from "../exec";
import {
  chunkThreshold,
  descriptorPath,
  packLargeFile,
  partPath,
  partsDir,
  type LargeFileDescriptor,
  unpackLargeFile,
} from "./chunks";

export interface MirrorFile {
  path: string;
  abs: string;
  size: number;
  mode?: number;
  mtimeMs?: number;
}

interface ManifestFile {
  path: string;
  size: number;
  mtimeMs: number;
  mode: number;
  treePaths: string[];
}

interface RefManifest {
  version: 1;
  seq: number;
  tool: string;
  sessionId: string;
  ts: string | null;
  takenAt: string;
  cwd: string;
  gitHead: string | null;
  gitBranch: string | null;
  dirtyCount: number | null;
  fileCount: number;
  totalBytes: number;
  manual?: boolean;
  files: ManifestFile[];
}

const MANIFEST_MARKER = "carafe-manifest-base64:";

function git(cwd: string, args: string[], exec: ExecFn, env?: Record<string, string>, input?: string | Buffer) {
  return exec(["git", ...args], cwd, env, input);
}

function slashPath(path: string): string {
  return path.replace(/\\/g, "/");
}

function refPart(s: string): string {
  return encodeURIComponent(s).replace(/%/g, "~");
}

export function checkpointRef(tool: string, sessionId: string, seq: number): string {
  return `refs/carafe/checkpoints/${refPart(tool)}/${refPart(sessionId)}/${seq}`;
}

function tempArea(): string {
  return mkdtempSync(join(tmpdir(), "carafe-gitrefs-"));
}

function modeFor(f: MirrorFile): number {
  return (f.mode ?? 0o100644) & 0o111 ? 0o100755 : 0o100644;
}

function addBlob(cwd: string, indexFile: string, mode: number, sha: string, path: string, exec: ExecFn): void {
  const r = git(cwd, ["update-index", "--add", "--cacheinfo", `${mode.toString(8)},${sha},${path}`], exec, { GIT_INDEX_FILE: indexFile });
  if (!r.ok) throw new Error(`git update-index failed for ${path}: ${r.out}`);
}

function removePath(cwd: string, indexFile: string, path: string, exec: ExecFn): void {
  git(cwd, ["update-index", "--force-remove", path], exec, { GIT_INDEX_FILE: indexFile });
}

function hashPath(cwd: string, path: string, exec: ExecFn): string {
  const r = git(cwd, ["hash-object", "-w", path], exec);
  if (!r.ok || !r.out) throw new Error(`git hash-object failed for ${path}: ${r.out}`);
  return r.out;
}

function hashBuffer(cwd: string, area: string, name: string, buf: Buffer, exec: ExecFn): string {
  const p = join(area, name);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, buf);
  return hashPath(cwd, p, exec);
}

function encodeManifest(m: RefManifest): string {
  return Buffer.from(JSON.stringify(m)).toString("base64");
}

function decodeManifest(commitText: string): RefManifest | null {
  const line = commitText.split("\n").find((l) => l.startsWith(MANIFEST_MARKER));
  if (!line) return null;
  try {
    const parsed = JSON.parse(Buffer.from(line.slice(MANIFEST_MARKER.length), "base64").toString("utf8")) as RefManifest;
    return parsed?.version === 1 ? parsed : null;
  } catch {
    return null;
  }
}

function readCommitManifest(cwd: string, sha: string, exec: ExecFn): RefManifest | null {
  const r = git(cwd, ["cat-file", "commit", sha], exec);
  if (!r.ok) return null;
  return decodeManifest(r.stdout?.toString("utf8") ?? r.out);
}

function commitTree(cwd: string, tree: string, parent: string | null, msg: string, exec: ExecFn): string {
  const area = tempArea();
  try {
    const msgPath = join(area, "message.txt");
    writeFileSync(msgPath, msg);
    const args = ["commit-tree", tree, "-F", msgPath];
    if (parent) args.push("-p", parent);
    const r = git(cwd, args, exec);
    if (!r.ok || !r.out) throw new Error(`git commit-tree failed: ${r.out}`);
    return r.out;
  } finally {
    rmSync(area, { recursive: true, force: true });
  }
}

export function listRefCheckpoints(cwd: string, tool: string, sessionId: string, exec: ExecFn = realExec): Array<{ seq: number; sha: string }> {
  const prefix = checkpointRef(tool, sessionId, 0).replace(/\/0$/, "/");
  const r = git(cwd, ["for-each-ref", "--format=%(refname) %(objectname)", prefix], exec);
  if (!r.ok) return [];
  const out: Array<{ seq: number; sha: string }> = [];
  for (const line of r.out.split("\n").filter(Boolean)) {
    const [ref, sha] = line.split(" ");
    const raw = ref?.slice(prefix.length);
    if (!ref || !sha || !raw || !/^\d+$/.test(raw)) continue;
    out.push({ seq: Number(raw), sha });
  }
  return out.sort((a, b) => a.seq - b.seq);
}

export function mirrorCheckpoint(
  cwd: string,
  tool: string,
  sessionId: string,
  seq: number,
  files: MirrorFile[],
  opts: {
    exec?: ExecFn;
    ts?: string | null;
    takenAt?: string;
    gitHead?: string | null;
    gitBranch?: string | null;
    dirtyCount?: number | null;
    manual?: boolean;
  } = {},
): { ref: string; commit: string; tree: string } {
  const exec = opts.exec ?? realExec;
  const area = tempArea();
  const indexFile = join(area, "index");
  const existing = listRefCheckpoints(cwd, tool, sessionId, exec).filter((c) => c.seq < seq).at(-1) ?? null;
  const previousManifest = existing ? readCommitManifest(cwd, existing.sha, exec) : null;
  const previousByPath = new Map((previousManifest?.files ?? []).map((f) => [f.path, f]));
  const currentByPath = new Map(files.map((f) => [slashPath(f.path), f]));
  const manifestFiles: ManifestFile[] = [];

  try {
    const init = existing
      ? git(cwd, ["read-tree", `${existing.sha}^{tree}`], exec, { GIT_INDEX_FILE: indexFile })
      : git(cwd, ["read-tree", "--empty"], exec, { GIT_INDEX_FILE: indexFile });
    if (!init.ok) throw new Error(`git read-tree failed: ${init.out}`);

    // BATCHED plumbing: one hash-object for every blob, one update-index for the
    // whole delta. Per-file spawns cost ~40ms each — 8s for a 200-file repo.
    const removals: string[] = [];
    for (const old of previousManifest?.files ?? []) {
      const cur = currentByPath.get(old.path);
      const curMode = cur ? modeFor(cur) : 0;
      const unchanged = cur && old.size === cur.size && old.mtimeMs === (cur.mtimeMs ?? 0) && old.mode === curMode && existsSync(cur.abs);
      if (!unchanged) removals.push(...old.treePaths);
    }

    interface Pending { indexPath: string; hashSrc: string; mode: number; sha?: string }
    const pending: Pending[] = [];
    for (const f of files) {
      const path = slashPath(f.path);
      const mode = modeFor(f);
      const mtimeMs = f.mtimeMs ?? 0;
      const old = previousByPath.get(path);
      const unchanged = old && old.size === f.size && old.mtimeMs === mtimeMs && old.mode === mode && existsSync(f.abs);
      if (unchanged) {
        manifestFiles.push(old);
        continue;
      }

      const treePaths: string[] = [];
      if (f.size >= chunkThreshold()) {
        const packed = packLargeFile(f.abs, path, mode);
        const descPath = descriptorPath(path);
        const descTmp = join(area, `${descPath.replace(/\//g, "__")}.tmp`);
        mkdirSync(dirname(descTmp), { recursive: true });
        writeFileSync(descTmp, JSON.stringify(packed.descriptor, null, 2));
        pending.push({ indexPath: descPath, hashSrc: descTmp, mode: 0o100644 });
        treePaths.push(descPath);
        for (let i = 0; i < packed.parts.length; i++) {
          const p = partPath(path, i);
          const partTmp = join(area, `${p.replace(/\//g, "__")}.tmp`);
          writeFileSync(partTmp, packed.parts[i]!);
          pending.push({ indexPath: p, hashSrc: partTmp, mode: 0o100644 });
          treePaths.push(p);
        }
      } else {
        pending.push({ indexPath: path, hashSrc: f.abs, mode });
        treePaths.push(path);
      }
      manifestFiles.push({ path, size: f.size, mtimeMs, mode, treePaths });
    }

    // one spawn: hash every blob (paths on stdin, shas out in order).
    // --stdin-paths is newline-delimited, so the rare path containing \n
    // falls back to a per-file hash.
    const sane = pending.filter((p) => !p.hashSrc.includes("\n"));
    if (sane.length) {
      const r = git(cwd, ["hash-object", "-w", "--stdin-paths"], exec, {}, sane.map((p) => p.hashSrc).join("\n") + "\n");
      if (!r.ok) throw new Error(`git hash-object --stdin-paths failed: ${r.out}`);
      const shas = r.out.split("\n").filter(Boolean);
      if (shas.length !== sane.length) throw new Error(`git hash-object output mismatch: ${shas.length} shas for ${sane.length} paths`);
      sane.forEach((p, i) => { p.sha = shas[i]!; });
    }
    for (const p of pending) if (!p.sha) p.sha = hashPath(cwd, p.hashSrc, exec);

    // one spawn: apply removals + additions to the temp index together
    const shaLen = (existing?.sha ?? pending[0]?.sha ?? "0".repeat(40)).length;
    const records = [
      ...removals.map((p) => `0 ${"0".repeat(shaLen)}\t${p}`),
      ...pending.map((p) => `${p.mode.toString(8)} ${p.sha}\t${p.indexPath}`),
    ];
    if (records.length) {
      const r = git(cwd, ["update-index", "-z", "--index-info"], exec, { GIT_INDEX_FILE: indexFile }, records.join("\0") + "\0");
      if (!r.ok) throw new Error(`git update-index --index-info failed: ${r.out}`);
    }

    const treeResult = git(cwd, ["write-tree"], exec, { GIT_INDEX_FILE: indexFile });
    if (!treeResult.ok || !treeResult.out) throw new Error(`git write-tree failed: ${treeResult.out}`);
    const totalBytes = files.reduce((n, f) => n + f.size, 0);
    const manifest: RefManifest = {
      version: 1,
      seq,
      tool,
      sessionId,
      ts: opts.ts ?? null,
      takenAt: opts.takenAt ?? new Date().toISOString(),
      cwd,
      gitHead: opts.gitHead ?? null,
      gitBranch: opts.gitBranch ?? null,
      dirtyCount: opts.dirtyCount ?? null,
      fileCount: files.length,
      totalBytes,
      ...(opts.manual ? { manual: true } : {}),
      files: manifestFiles.sort((a, b) => a.path.localeCompare(b.path)),
    };
    const msg = `carafe checkpoint ${tool}/${sessionId} seq ${seq}\n\n${MANIFEST_MARKER}${encodeManifest(manifest)}\n`;
    const commit = commitTree(cwd, treeResult.out, existing?.sha ?? null, msg, exec);
    const ref = checkpointRef(tool, sessionId, seq);
    const upd = git(cwd, ["update-ref", ref, commit], exec);
    if (!upd.ok) throw new Error(`git update-ref failed: ${upd.out}`);
    return { ref, commit, tree: treeResult.out };
  } finally {
    rmSync(area, { recursive: true, force: true });
  }
}

interface TreeEntry {
  mode: number;
  type: string;
  sha: string;
  size: number | null;
  path: string;
}

function parseLsTree(buf: Buffer): TreeEntry[] {
  const text = buf.toString("utf8");
  const entries: TreeEntry[] = [];
  for (const rec of text.split("\0").filter(Boolean)) {
    const tab = rec.indexOf("\t");
    if (tab < 0) continue;
    const meta = rec.slice(0, tab).trim().split(/\s+/);
    const path = rec.slice(tab + 1);
    if (meta.length < 4) continue;
    entries.push({ mode: Number.parseInt(meta[0]!, 8), type: meta[1]!, sha: meta[2]!, size: meta[3] === "-" ? null : Number(meta[3]), path });
  }
  return entries;
}

function catBlob(cwd: string, sha: string, exec: ExecFn): Buffer {
  const r = git(cwd, ["cat-file", "blob", sha], exec);
  if (!r.ok) throw new Error(`git cat-file blob failed for ${sha}: ${r.out}`);
  return r.stdout ?? Buffer.from(r.out);
}

export function materializeCheckpoint(cwd: string, sha: string, destDir: string, exec: ExecFn = realExec): void {
  const filesRoot = join(destDir, "files");
  rmSync(destDir, { recursive: true, force: true });
  mkdirSync(filesRoot, { recursive: true });
  const listed = git(cwd, ["ls-tree", "-r", "-z", "--long", `${sha}^{tree}`], exec);
  if (!listed.ok) throw new Error(`git ls-tree failed: ${listed.out}`);
  const entries = parseLsTree(listed.stdout ?? Buffer.from(listed.out));
  const byPath = new Map(entries.map((e) => [e.path, e]));
  const descriptors = entries.filter((e) => e.path.endsWith(".carafe-large.json"));

  for (const e of entries) {
    if (e.type !== "blob") continue;
    if (e.path.endsWith(".carafe-large.json")) continue;
    if (e.path.includes(".carafe-large/part-")) continue;
    const dst = join(filesRoot, e.path);
    mkdirSync(dirname(dst), { recursive: true });
    writeFileSync(dst, catBlob(cwd, e.sha, exec));
    chmodSync(dst, e.mode & 0o777);
  }

  for (const e of descriptors) {
    const descriptor = JSON.parse(catBlob(cwd, e.sha, exec).toString("utf8")) as LargeFileDescriptor;
    const parts: Buffer[] = [];
    for (let i = 0; i < descriptor.partCount; i++) {
      const pe = byPath.get(partPath(descriptor.path, i));
      if (!pe) throw new Error(`packed file ${descriptor.path} missing part ${i}`);
      parts.push(catBlob(cwd, pe.sha, exec));
    }
    const unpacked = unpackLargeFile(descriptor, parts);
    const dst = join(filesRoot, descriptor.path);
    mkdirSync(dirname(dst), { recursive: true });
    writeFileSync(dst, unpacked);
    chmodSync(dst, descriptor.mode ?? 0o644);
  }

  const m = readCommitManifest(cwd, sha, exec);
  if (m) {
    const { files: _files, ...manifest } = m;
    writeFileSync(join(destDir, "manifest.json"), JSON.stringify({ ...manifest, skipped: [] }, null, 2));
  }
}

export function pushCheckpointRefs(cwd: string, remote: string, refspecs: string[], exec: ExecFn = realExec): { ok: boolean; message: string } {
  if (!refspecs.length) return { ok: true, message: "" };
  const args = ["push", remote, ...refspecs.map((r) => `${r}:${r}`)];
  const r = git(cwd, args, exec);
  return { ok: r.ok, message: r.out };
}

export function deleteRemoteRefs(cwd: string, remote: string, refs: string[], exec: ExecFn = realExec): { ok: boolean; message: string } {
  if (!refs.length) return { ok: true, message: "" };
  const r = git(cwd, ["push", remote, ...refs.map((ref) => `:${ref}`)], exec);
  return { ok: r.ok, message: r.out };
}

export function deleteLocalRef(cwd: string, ref: string, exec: ExecFn = realExec): void {
  git(cwd, ["update-ref", "-d", ref], exec);
}

export function packedPartsDirForPath(path: string): string {
  return partsDir(path);
}
