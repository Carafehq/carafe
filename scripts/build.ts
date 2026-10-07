#!/usr/bin/env bun
// Cross-compiles carafe into standalone binaries — one per platform — then
// tarballs each and writes checksums.txt. The output of `bun run build` is
// exactly the set of files install.sh expects to find on a GitHub release.
//
// Nothing here needs the target platform: `bun build --compile --target=...`
// downloads the matching Bun runtime and embeds it, so a Linux CI box (or a
// Mac laptop) produces every artifact.
//
//   bun run build              # every target
//   bun run build darwin-arm64 # just one, by asset suffix
//
// Version comes from CARAFE_VERSION (CI sets it from the git tag), else
// package.json. The release channel comes from CARAFE_CHANNEL (stable, the
// default): it is baked into the binary,
// shown by `carafe --version`, and decides which releases `carafe update`
// considers. No Windows target: carafe shells out to git and reads POSIX
// paths under ~/.claude and ~/.codex throughout.

import { createHash } from "crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "fs";
import { join } from "path";
import { CHANNELS, isChannel } from "../src/version";

const ROOT = join(import.meta.dir, "..");
const DIST = join(ROOT, "dist");
const ENTRY = join(ROOT, "src/cli/index.ts");

// `baseline` = no AVX2, for pre-2013 CPUs and VMs that mask the flag. `musl`
// for Alpine and friends — a glibc binary simply refuses to start there.
const TARGETS = [
  "darwin-arm64",
  "darwin-x64",
  "linux-x64",
  "linux-x64-baseline",
  "linux-arm64",
  "linux-x64-musl",
  "linux-arm64-musl",
] as const;

const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { version: string };
const version = (process.env.CARAFE_VERSION || pkg.version).replace(/^v/, "");
const channel = process.env.CARAFE_CHANNEL || "stable";
if (!isChannel(channel)) {
  console.error(`CARAFE_CHANNEL must be one of ${CHANNELS.join(", ")} (got ${channel})`);
  process.exit(1);
}

const requested = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const targets = requested.length ? TARGETS.filter((t) => requested.includes(t)) : [...TARGETS];
if (!targets.length) {
  console.error(`no matching target. known: ${TARGETS.join(", ")}`);
  process.exit(1);
}

rmSync(DIST, { recursive: true, force: true });
mkdirSync(DIST, { recursive: true });

const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(0)}MB`;
const sha256 = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

const checksums: string[] = [];
console.log(`carafe ${version} (${channel}) — ${targets.length} target${targets.length === 1 ? "" : "s"}\n`);

for (const target of targets) {
  const staging = join(DIST, target);
  mkdirSync(staging, { recursive: true });
  // The binary is named plainly so it lands as `carafe` when the tarball is
  // unpacked; the platform lives in the tarball name, not the executable's.
  const binary = join(staging, "carafe");

  const build = Bun.spawnSync({
    cmd: [
      // Do not embed a recoverable source map in the shipped binary.
      "bun", "build", "--compile", "--minify",
      // Do not load bunfig.toml from the directory where the binary runs.
      "--no-compile-autoload-bunfig",
      // Do not load .env from the directory where the binary runs.
      "--no-compile-autoload-dotenv",
      `--target=bun-${target}`,
      `--define`, `CARAFE_BUILD_VERSION="${version}"`,
      `--define`, `CARAFE_BUILD_TARGET="${target}"`,
      `--define`, `CARAFE_BUILD_CHANNEL="${channel}"`,
      ENTRY, "--outfile", binary,
    ],
    cwd: ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (build.exitCode !== 0 || !existsSync(binary)) {
    console.error(`✗ ${target}\n${build.stderr.toString()}`);
    process.exit(1);
  }

  const tarball = `carafe-${version}-${target}.tar.gz`;
  const tar = Bun.spawnSync({
    cmd: ["tar", "-czf", join(DIST, tarball), "-C", staging, "carafe"],
    stderr: "pipe",
  });
  if (tar.exitCode !== 0) {
    console.error(`✗ ${target}: tar failed\n${tar.stderr.toString()}`);
    process.exit(1);
  }
  rmSync(staging, { recursive: true, force: true });

  const digest = sha256(join(DIST, tarball));
  checksums.push(`${digest}  ${tarball}`);
  console.log(`✓ ${target.padEnd(19)} ${mb(statSync(join(DIST, tarball)).size).padStart(5)}  ${tarball}`);
}

// Same layout `sha256sum -c` emits, so the file is checkable by hand too.
writeFileSync(join(DIST, "checksums.txt"), `${checksums.join("\n")}\n`);
console.log(`\ndist/ ready — ${checksums.length} tarball(s) + checksums.txt`);
