#!/bin/sh
# carafe installer — POSIX sh, no dependencies beyond curl and tar.
#
#   curl -fsSL https://raw.githubusercontent.com/Carafehq/carafe/main/install.sh | sh
#
# Knobs (all optional):
#   CARAFE_VERSION       0.1.0 | latest (default)
#   CARAFE_INSTALL_DIR   default ~/.local/bin
#   CARAFE_GITHUB_TOKEN  or GITHUB_TOKEN — raises the GitHub API rate limit; also
#                        what reads the releases of a private fork
#   Release repository: Carafehq/carafe (fixed)
#   CARAFE_START_WATCHER yes (default) | no
#   CARAFE_WATCH_INTERVAL default 10 seconds
#   CARAFE_SKIP_VERIFY=1 skip release checksum verification (not recommended)
#   CARAFE_FORCE_INSTALL=1 reinstall even when a working carafe exists (else
#                        the script defers to `carafe update`)
#
# Downloading through curl is deliberate: assets fetched this way never get
# macOS's com.apple.quarantine bit, so the binary is not Gatekeeper-blocked
# the way a browser download would be.

set -eu

REPO="Carafehq/carafe"
INSTALL_DIR="${CARAFE_INSTALL_DIR:-$HOME/.local/bin}"
VERSION="${CARAFE_VERSION:-latest}"
CHANNEL="${CARAFE_CHANNEL:-stable}"
TOKEN="${CARAFE_GITHUB_TOKEN:-${GITHUB_TOKEN:-}}"
START_WATCHER="${CARAFE_START_WATCHER:-yes}"
WATCH_INTERVAL="${CARAFE_WATCH_INTERVAL:-10}"
FORCE_INSTALL="${CARAFE_FORCE_INSTALL:-0}"

while [ $# -gt 0 ]; do
  case $1 in
    --version) VERSION="${2:-}"; shift 2 ;;
    --channel) CHANNEL="${2:-}"; shift 2 ;;
    --dir)     INSTALL_DIR="${2:-}"; shift 2 ;;
    --token)   TOKEN="${2:-}"; shift 2 ;;
    --force)   FORCE_INSTALL=1; shift ;;
    --no-watcher) START_WATCHER=no; shift ;;
    -h|--help)
      echo "usage: install.sh [--version X.Y.Z] [--channel NAME] [--dir PATH] [--token GH_TOKEN] [--force] [--no-watcher]"
      echo "a token is optional (it raises the GitHub API rate limit, or reads a private fork);"
      echo "prefer CARAFE_GITHUB_TOKEN (or GITHUB_TOKEN) so the token is not passed as an argument"
      exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 1 ;;
  esac
done

say()  { printf '  %s\n' "$*"; }
die()  { printf '\ncarafe: %s\n' "$*" >&2; exit 1; }

# Validate before any download or install side effect.
# Validate the requested release channel.
case $CHANNEL in
  stable) channel_suffix="" ;;
  *) die "--channel must be a supported channel (got '$CHANNEL')" ;;
esac
case $WATCH_INTERVAL in
  ''|*[!0-9]*) die "CARAFE_WATCH_INTERVAL must be a positive number of seconds" ;;
  0) die "CARAFE_WATCH_INTERVAL must be greater than zero" ;;
esac

# ---- already installed? -----------------------------------------------------
# A working carafe updates itself: `carafe update` resolves the same release
# feed, verifies the same checksums, and swaps the binary atomically. Redirect
# there instead of re-downloading — but only when the found binary actually
# runs, so a broken install still falls through to this script as the recovery
# path. --force (or CARAFE_FORCE_INSTALL=1) skips the redirect entirely.
if [ "$FORCE_INSTALL" != 1 ]; then
  existing="$INSTALL_DIR/carafe"
  [ -x "$existing" ] || existing=$(command -v carafe 2>/dev/null || true)
  if [ -n "$existing" ] && installed_version=$("$existing" --version 2>/dev/null); then
    printf '\n%s is already installed (%s)\n\n' "$existing" "$installed_version"
    say "update it with:      carafe update   (it stays on the channel it was installed from)"
    say "reinstall anyway:    curl ... | sh -s -- --force   (or CARAFE_FORCE_INSTALL=1)"
    if [ "$CHANNEL" != stable ]; then
      say "switch to $CHANNEL:  curl ... | sh -s -- --channel $CHANNEL --force"
    fi
    printf '\n'
    exit 0
  fi
fi

command -v curl >/dev/null 2>&1 || die "curl is required"
command -v tar  >/dev/null 2>&1 || die "tar is required"

# ---- which binary does this machine need -----------------------------------

os=$(uname -s)
arch=$(uname -m)

case $os in
  Darwin) os=darwin ;;
  Linux)  os=linux ;;
  *) die "unsupported OS: $os (carafe ships macOS and Linux binaries)" ;;
esac

case $arch in
  x86_64|amd64)  arch=x64 ;;
  arm64|aarch64) arch=arm64 ;;
  *) die "unsupported architecture: $arch" ;;
esac

target="$os-$arch"

if [ "$os" = linux ]; then
  # A glibc binary does not merely run slowly on musl — it fails to exec at all,
  # so this check has to happen before download, not after.
  if (ldd --version 2>&1 || true) | grep -qi musl; then
    target="$target-musl"
  elif [ "$arch" = x64 ]; then
    # Bun's default x64 build assumes AVX2. Older CPUs and some VMs that mask
    # the flag need the baseline build or the binary dies on SIGILL.
    if [ -r /proc/cpuinfo ] && grep -qm1 avx2 /proc/cpuinfo; then
      :
    else
      target="$target-baseline"
    fi
  fi
fi

# ---- talk to GitHub --------------------------------------------------------

tmp=$(mktemp -d)
# Leave nothing behind on failure — this runs on someone else's laptop.
trap 'rm -rf "$tmp"' EXIT INT TERM
curl_cfg="$tmp/curl.conf"
if [ -n "$TOKEN" ]; then
  # umask makes the config 0600 before the token is written to it.
  (umask 077; printf 'header = "Authorization: Bearer %s"\n' "$TOKEN" > "$curl_cfg")
  chmod 600 "$curl_cfg"
fi

api() {
  # $1 = path under the repo. Auth header only when a token exists: a public
  # repository needs none.
  if [ -n "$TOKEN" ]; then
    curl -fsSL -K "$curl_cfg" \
         -H "X-GitHub-Api-Version: 2022-11-28" "https://api.github.com/repos/$REPO/$1"
  else
    curl -fsSL -H "X-GitHub-Api-Version: 2022-11-28" "https://api.github.com/repos/$REPO/$1"
  fi
}

if [ "$VERSION" != latest ]; then
  rel_path="releases/tags/v${VERSION#v}"
elif [ "$CHANNEL" = stable ]; then
  rel_path="releases/latest"
fi

release=$(api "$rel_path" 2>/dev/null) || release=""
if [ -z "$release" ]; then
  hint="  Check the network connection and the version asked for. A private repository
  (CARAFE_REPO pointing at a private fork) needs CARAFE_GITHUB_TOKEN with read access
  to its releases; a token also lifts the GitHub API rate limit."
  die "could not read $rel_path from $REPO.
$hint"
fi

resolved=$(printf '%s' "$release" | tr -d '\n' | sed -n 's/.*"tag_name":[ ]*"\([^"]*\)".*/\1/p')
[ -n "$resolved" ] || die "no tag_name in the release response for $rel_path"
resolved="${resolved#v}"

asset="carafe-$resolved-$target.tar.gz"

printf '\ncarafe %s — %s\n\n' "$resolved" "$target"

# Each asset object in the JSON begins with '{', so splitting on '{' isolates
# one asset per line and lets a line-based grep pair a name with its id.
asset_id_for() {
  printf '%s' "$release" | tr -d '\n' | tr '{' '\n' \
    | grep -E "\"name\"[[:space:]]*:[[:space:]]*\"$1\"" \
    | sed -n 's/.*"id":[ ]*\([0-9]*\).*/\1/p' | head -1
}

fetch_asset() {
  # $1 = asset name, $2 = destination path
  if [ -n "$TOKEN" ]; then
    id=$(asset_id_for "$1")
    [ -n "$id" ] || return 1
    curl -fsSL -K "$curl_cfg" -H "Accept: application/octet-stream" \
         -o "$2" "https://api.github.com/repos/$REPO/releases/assets/$id"
  else
    curl -fsSL -o "$2" "https://github.com/$REPO/releases/download/v$resolved/$1"
  fi
}

say "downloading $asset"
fetch_asset "$asset" "$tmp/$asset" \
  || die "no asset named $asset on release v$resolved.
  Built targets are listed at https://github.com/$REPO/releases/tag/v$resolved"

# ---- verify ----------------------------------------------------------------

if [ "${CARAFE_SKIP_VERIFY:-0}" = 1 ]; then
  say "WARNING: SHA256 verification skipped because CARAFE_SKIP_VERIFY=1"
else
  fetch_asset "checksums.txt" "$tmp/checksums.txt" 2>/dev/null \
    || die "checksums.txt was not published for release v$resolved — refusing to install without verification"
  expected=$(grep -E "[[:space:]]$asset[[:space:]]*$" "$tmp/checksums.txt" | awk '{print $1}' | head -1)
  [ -n "$expected" ] || die "checksums.txt does not list $asset — refusing to install without verification"
  if command -v sha256sum >/dev/null 2>&1; then
    actual=$(sha256sum "$tmp/$asset" | awk '{print $1}')
  elif command -v shasum >/dev/null 2>&1; then
    actual=$(shasum -a 256 "$tmp/$asset" | awk '{print $1}')
  else
    die "sha256sum or shasum is required to verify $asset"
  fi
  if [ "$actual" != "$expected" ]; then
    die "checksum mismatch for $asset
  expected $expected
  got      $actual"
  fi
  say "checksum ok"
fi

# ---- install ---------------------------------------------------------------

tar -xzf "$tmp/$asset" -C "$tmp" || die "could not unpack $asset"
[ -f "$tmp/carafe" ] || die "$asset did not contain a carafe binary"

mkdir -p "$INSTALL_DIR" || die "could not create $INSTALL_DIR"
chmod +x "$tmp/carafe"
# Belt and braces: if this file ever arrives via a browser instead, clear the
# quarantine bit rather than letting Gatekeeper refuse to launch it.
[ "$os" = darwin ] && xattr -d com.apple.quarantine "$tmp/carafe" 2>/dev/null || true

# mv across filesystems can fail; cp then remove is portable. Writing to a temp
# name first means a running carafe is never a half-written file.
cp "$tmp/carafe" "$INSTALL_DIR/carafe.new" || die "could not write to $INSTALL_DIR"
mv -f "$INSTALL_DIR/carafe.new" "$INSTALL_DIR/carafe" || die "could not install to $INSTALL_DIR"

say "installed $INSTALL_DIR/carafe"

# ---- optional background capture ------------------------------------------

case $START_WATCHER in
  yes|true|1) start_watcher=yes ;;
  no|false|0) start_watcher=no ;;
  *) die "CARAFE_START_WATCHER must be yes or no" ;;
esac

if [ "$start_watcher" = yes ]; then
  printf '\ncarafe will keep capturing sessions in the background (local only, nothing transmitted).\n'
  printf 'Disable anytime: carafe service disable   [--no-watcher to skip]\n\n'
  # --keep-owner: a service that already runs another carafe (e.g. Carafe.app's
  # bundled one) is left as is; only an explicit `carafe service enable` re-points it.
  CARAFE_WATCH_INTERVAL="$WATCH_INTERVAL" "$INSTALL_DIR/carafe" service enable --keep-owner
else
  say "background capture skipped (--no-watcher / CARAFE_START_WATCHER=no)"
fi

# ---- PATH ------------------------------------------------------------------

case ":${PATH}:" in
  *":$INSTALL_DIR:"*) on_path=yes ;;
  *) on_path=no ;;
esac

printf '\n'
if [ "$on_path" = yes ]; then
  "$INSTALL_DIR/carafe" --version >/dev/null 2>&1 \
    || die "the binary installed but would not run — wrong build for this machine?"
  printf 'carafe is ready. Start with:\n\n  carafe import\n  carafe ui\n\n'
else
  printf '%s is not on your PATH. Add it:\n\n' "$INSTALL_DIR"
  printf '  echo '\''export PATH="%s:$PATH"'\'' >> ~/.zshrc   # or ~/.bashrc\n' "$INSTALL_DIR"
  printf '  export PATH="%s:$PATH"\n\nThen: carafe import && carafe ui\n\n' "$INSTALL_DIR"
fi
