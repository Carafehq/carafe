/**
 * Self-update from GitHub releases, plus the startup "new version" warning.
 *
 * Egress exception (approved): this is the ONE place carafe talks to the
 * network on its own — a GET to the GitHub releases API carrying no user data.
 * The check is cached in state/update-check-public.json, throttled to once per day,
 * silent on any failure, and disabled entirely by CARAFE_NO_UPDATE_CHECK=1.
 * Session data never leaves the machine.
 */
import { createHash } from "crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { atomicWriteFileSync } from "../format/store";
import { BUILD_TARGET, CHANNEL, VERSION, type Channel } from "../version";
import { refreshServiceAfterUpdate } from "./service";

/**
 * The release feed for this build. install.sh and the menu bar use the same
 * repository; src/cli/update.test.ts checks that they stay consistent.
 */
export const DEFAULT_REPO = "Carafehq/carafe";
/** Private builds may override the feed; public builds use their fixed repository. */
export const releaseRepo = (env: Record<string, string | undefined> = process.env): string =>
  DEFAULT_REPO;
const REPO = releaseRepo();
// Overridable so tests can point the whole flow at a local fixture server.
const API_BASE = process.env.CARAFE_UPDATE_API ?? "https://api.github.com";
const CHECK_TTL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 10_000;

const token = (): string | undefined =>
  process.env.CARAFE_GITHUB_TOKEN || process.env.GITHUB_TOKEN || undefined;

/** One cache per channel: a stable and a non-stable carafe on one machine
 *  share the state folder, and neither may read the other's latest release. */
const cachePath = (channel: Channel = CHANNEL): string =>
  join(process.env.CARAFE_HOME ?? join(process.env.HOME!, ".carafe"), "state",
    channel === "stable" ? "update-check-public.json" : `update-check-${channel}.json`);

export type UpdateCache = { checkedAt: number; latest: string | null };

type ParsedVersion = { base: [number, number, number]; prerelease: string | null };

function parseVersion(value: string): ParsedVersion | null {
  const match = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-(.+))?$/.exec(value);
  if (!match) return null;
  return {
    base: [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)],
    prerelease: match[4] ?? null,
  };
}

/** The numbered prerelease of a non-stable channel: a numeric suffix. */
const CHANNEL_PRERELEASE: Record<string, RegExp> = {
};

/**
 * The channel a release belongs to, read from its version: x.y.z and main's
 * x.y.z-alpha.<sha> are stable. An unknown suffix belongs to no
 * channel, so no build ever updates to it.
 */
export function channelOf(version: string): Channel | null {
  const parsed = parseVersion(version);
  if (!parsed) return null;
  if (parsed.prerelease === null || /^alpha\.[0-9a-f]+$/.test(parsed.prerelease)) return "stable";
  for (const [channel, pattern] of Object.entries(CHANNEL_PRERELEASE)) {
    if (pattern.test(parsed.prerelease)) return channel as Channel;
  }
  return null;
}

/** The run number of a non-stable-channel prerelease, else null. */
function channelNumber(prerelease: string | null): { kind: string; n: number } | null {
  if (prerelease === null) return null;
  for (const [kind, pattern] of Object.entries(CHANNEL_PRERELEASE)) {
    const m = pattern.exec(prerelease);
    if (m) return { kind, n: Number(m[1]) };
  }
  return null;
}

/**
 * Semver-base order, with a stable build above every prerelease of the same
 * base. Two prereleases of one non-stable channel at one base are ordered by
 * their number; any other pair of prereleases at one base
 * (two distinct prerelease identifiers) is unordered.
 */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return 0;
  for (let i = 0; i < 3; i++) {
    const d = pa.base[i]! - pb.base[i]!;
    if (d !== 0) return d;
  }
  if ((pa.prerelease === null) !== (pb.prerelease === null)) return pa.prerelease !== null ? -1 : 1;
  const na = channelNumber(pa.prerelease);
  const nb = channelNumber(pb.prerelease);
  if (na && nb && na.kind === nb.kind) return na.n - nb.n;
  return 0;
}

/** Digest for `asset` from a `sha256sum`-layout checksums.txt, or null. */
export function checksumFor(text: string, asset: string): string | null {
  for (const line of text.split("\n")) {
    const [digest, name] = line.trim().split(/\s+/);
    if (name === asset && digest && /^[0-9a-f]{64}$/.test(digest)) return digest;
  }
  return null;
}

/**
 * Whether `latest` should replace `current` for a build on `channel`. Only a
 * release of the build's own channel qualifies: a stable build never moves to
 * a non-stable prerelease, and a non-stable build never moves to stable
 * (or to the other non-stable channel) on its own. Numeric cores decide when
 * they differ; stable beats alpha at the same base; numbered suffixes sort numerically;
 * two SHA alphas at one base are unordered and therefore never an update.
 */
export function updateAvailable(current: string, latest: string, channel: Channel = CHANNEL): boolean {
  if (current === "dev" || latest === current) return false;
  if (channelOf(latest) !== channel) return false;
  return compareVersions(latest, current) > 0;
}

/** The startup warning line, or null when there is nothing newer. Pure for tests. */
export function warningFromCache(cache: UpdateCache | null, current: string, channel: Channel = CHANNEL): string | null {
  if (!cache?.latest || !updateAvailable(current, cache.latest, channel)) return null;
  return `carafe ${cache.latest} is available (installed ${current}) — run \`carafe update\``;
}

export function cacheIsStale(cache: UpdateCache | null, now: number): boolean {
  return !cache || now - cache.checkedAt > CHECK_TTL_MS;
}

function readCache(): UpdateCache | null {
  try {
    const parsed = JSON.parse(readFileSync(cachePath(), "utf8"));
    if (typeof parsed?.checkedAt !== "number") return null;
    return { checkedAt: parsed.checkedAt, latest: typeof parsed.latest === "string" ? parsed.latest : null };
  } catch {
    return null;
  }
}

function writeCache(latest: string | null): void {
  const path = cachePath();
  mkdirSync(dirname(path), { recursive: true });
  atomicWriteFileSync(path, JSON.stringify({ checkedAt: Date.now(), latest } satisfies UpdateCache));
}

export type Release = {
  version: string;
  assets: { name: string; url: string; browser_download_url: string }[];
};

/** The newest release of `channel` (every other channel's releases are ignored). */
export function preferredRelease(releases: Release[], channel: Channel = CHANNEL): Release | null {
  let best: Release | null = null;
  for (const release of releases) {
    if (channelOf(release.version) !== channel) continue;
    if (!best || compareVersions(release.version, best.version) > 0) best = release;
  }
  return best;
}

/** Pages of 100 releases read before giving up on finding one of this channel. */
const MAX_RELEASE_PAGES = 3;

async function fetchLatestRelease(channel: Channel = CHANNEL): Promise<Release | null> {
  const headers: Record<string, string> = { "X-GitHub-Api-Version": "2022-11-28" };
  const t = token();
  if (t) headers.Authorization = `Bearer ${t}`;
  try {
    // Releases come newest first. Another channel's run of releases can fill a
    // whole page, so read on until this channel has appeared (a few pages at most).
    for (let page = 1; page <= MAX_RELEASE_PAGES; page++) {
      const resp = await fetch(`${API_BASE}/repos/${REPO}/releases?per_page=100&page=${page}`, {
        headers,
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!resp.ok) return null;
      const body = (await resp.json()) as Array<{ tag_name?: string; assets?: Release["assets"]; draft?: boolean }>;
      if (!Array.isArray(body)) return null;
      const best = preferredRelease(body
        .filter((release) => release.draft !== true && typeof release.tag_name === "string")
        .map((release) => ({ version: release.tag_name!.replace(/^v/, ""), assets: release.assets ?? [] })), channel);
      if (best || body.length < 100) return best;
    }
    return null;
  } catch {
    return null;
  }
}

async function downloadAsset(release: Release, name: string, dest: string): Promise<boolean> {
  const asset = release.assets.find((a) => a.name === name);
  if (!asset) return false;
  // Private repo: the browser URL 404s without a session, but the API asset URL
  // honors a token. Public repo: the browser URL works with no auth at all.
  const t = token();
  const headers: Record<string, string> = t
    ? { Authorization: `Bearer ${t}`, Accept: "application/octet-stream" }
    : {};
  try {
    const resp = await fetch(t ? asset.url : asset.browser_download_url, {
      headers,
      signal: AbortSignal.timeout(120_000),
    });
    if (!resp.ok || !resp.body) return false;
    // Consume the body explicitly, chunk by chunk. Bun.write(dest, Response)
    // stalls forever on GitHub's redirected CDN stream
    // (release-assets.githubusercontent.com) — observed on Bun 1.3.14 — and it
    // detaches from the abort signal, so not even the timeout fires. A reader
    // loop honors the signal, and its chunks drive the progress line.
    const total = Number(resp.headers.get("content-length")) || 0;
    const showProgress = process.stdout.isTTY === true && total > 1024 * 1024;
    const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)}MB`;
    const reader = resp.body.getReader();
    const chunks: Uint8Array[] = [];
    let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.length;
      if (showProgress) {
        process.stdout.write(`\r  ${mb(received)} / ${mb(total)} (${Math.floor((received / total) * 100)}%)`);
      }
    }
    if (showProgress) process.stdout.write("\n");
    writeFileSync(dest, Buffer.concat(chunks));
    return true;
  } catch {
    return false;
  }
}

/** Silent background check — writes the cache even on failure so a missing
 *  token or offline machine throttles to one attempt per TTL, not per run. */
export async function refreshUpdateCache(): Promise<void> {
  const release = await fetchLatestRelease();
  writeCache(release?.version ?? null);
}

/**
 * Called on CLI startup. Never touches the network on the hot path: it reads
 * the cache synchronously and, when stale, hands the actual check to a
 * detached child so this process exits on its own schedule.
 */
/** A carafe compiled into Carafe.app (build target "<platform>-app"): the app is the
 *  unit of update, so this binary never nags and `carafe update` defers to it. */
export function isBundledBuild(target: string = BUILD_TARGET): boolean {
  return target.endsWith("-app");
}

export function maybeWarnUpdate(): void {
  if (VERSION === "dev" || isBundledBuild() || process.env.CARAFE_NO_UPDATE_CHECK) return;
  const cache = readCache();
  const warning = warningFromCache(cache, VERSION);
  if (warning) console.error(warning);
  if (cacheIsStale(cache, Date.now())) {
    try {
      const child = Bun.spawn({
        cmd: [process.execPath, "__refresh-update-cache"],
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      });
      child.unref();
    } catch {
      /* background check is best-effort */
    }
  }
}

function die(message: string): never {
  console.error(`carafe update: ${message}`);
  process.exit(1);
}

export async function runUpdate(opts: { check?: boolean } = {}): Promise<void> {
  if (BUILD_TARGET === "source") {
    die("running from source — update your checkout instead:\n  git pull && bun run build\nor install a release binary with install.sh");
  }

  if (isBundledBuild() && !opts.check) {
    die("this carafe is part of Carafe.app — update the app instead (menu bar → Check for Updates, or the latest Carafe zip on the releases page)");
  }

  const release = await fetchLatestRelease();
  if (!release) {
    const hint = token()
      ? "check your network connection and token scopes"
      : "check your network connection; a private repository needs CARAFE_GITHUB_TOKEN (or GITHUB_TOKEN) with read access to its releases";
    const none = CHANNEL === "stable" ? "" : ` (or no ${CHANNEL} release has been published there yet)`;
    die(`could not read the latest ${CHANNEL === "stable" ? "" : `${CHANNEL} `}release of ${REPO}${none} — ${hint}`);
  }
  writeCache(release.version);

  const available = updateAvailable(VERSION, release.version);
  if (opts.check) {
    const label = CHANNEL === "stable" ? "latest" : `latest ${CHANNEL}`;
    console.log(`installed ${VERSION} · ${label} ${release.version}${available ? " — run `carafe update`" : ""}`);
    process.exitCode = available ? 2 : 0; // scriptable: 2 = update available
    return;
  }
  if (!available) {
    console.log(`carafe ${VERSION} is up to date`);
    return;
  }

  const asset = `carafe-${release.version}-${BUILD_TARGET}.tar.gz`;
  const tmp = mkdtempSync(join(tmpdir(), "carafe-update-"));
  try {
    console.log(`downloading ${asset}`);
    if (!(await downloadAsset(release, asset, join(tmp, asset)))) {
      die(`no asset named ${asset} on release v${release.version}`);
    }
    if (!(await downloadAsset(release, "checksums.txt", join(tmp, "checksums.txt")))) {
      die(`checksums.txt was not published for v${release.version} — refusing to update without verification`);
    }
    const expected = checksumFor(readFileSync(join(tmp, "checksums.txt"), "utf8"), asset);
    if (!expected) die(`checksums.txt does not list ${asset} — refusing to update without verification`);
    const actual = createHash("sha256").update(readFileSync(join(tmp, asset))).digest("hex");
    if (actual !== expected) die(`checksum mismatch for ${asset}\n  expected ${expected}\n  got      ${actual}`);

    const untar = Bun.spawnSync(["tar", "-xzf", join(tmp, asset), "-C", tmp], { stderr: "pipe" });
    if (untar.exitCode !== 0) die(`could not unpack ${asset}: ${untar.stderr.toString().trim()}`);
    const fresh = join(tmp, "carafe");
    chmodSync(fresh, 0o755);

    // Prove the new binary runs on this machine before it replaces anything.
    const smoke = Bun.spawnSync([fresh, "--version"], { stdout: "pipe", stderr: "pipe" });
    if (smoke.exitCode !== 0 || !smoke.stdout.toString().includes(release.version)) {
      die(`the new binary would not run — wrong build for this machine?`);
    }

    // Swap via rename in the same directory: atomic, and the running process
    // keeps its old inode, so an active `carafe watch` is never half-replaced.
    const current = realpathSync(process.execPath);
    const staged = join(dirname(current), ".carafe.update");
    try {
      renameSync(fresh, staged); // may be cross-device
    } catch {
      const bytes = readFileSync(fresh);
      atomicWriteFileSync(staged, bytes);
      chmodSync(staged, 0o755);
    }
    renameSync(staged, current);
    console.log(`updated: ${VERSION} → ${release.version}`);
    // Never rewrite the service definition here (see the ownership rule in
    // service.ts): restart it in place only when it runs the binary just
    // replaced (`current`, same path after the swap); a service owned by
    // another carafe, e.g. Carafe.app's, is left as is.
    const service = refreshServiceAfterUpdate({ binary: current, version: release.version });
    if (service.message) console.log(service.message);
    if (!service.ok) process.exitCode = 1;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
