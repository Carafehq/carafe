# Carafe Menu Bar

A thin shell in Swift: one
`NSStatusItem`, no dock icon, no windows, zero business logic — every action shells
out to the `carafe` CLI, and every line it shows is a `key: value` line the CLI printed.

- **Which carafe.** The app carries its own: `make-app.sh` compiles carafe for this Mac
  (as `scripts/build.ts` does for releases) into `Carafe.app/Contents/MacOS/carafe`, and the
  app runs that for everything. Why not the repo source: macOS privacy protection denies an
  app any file under `~/Documents`, `~/Desktop` or `~/Downloads` until the user grants it,
  so bundling avoids dependence on access to the source checkout. The bundled binary touches only `~/.carafe`, `~/.claude` and `~/.codex`.
  Under `swift run` (no bundle) it falls back to the capture service's own command from
  the launchd plist, then to the command remembered from the last time the service existed
  (`~/.carafe/state/menubar-carafe.json`), then to an installed binary. The menu names it
  ("carafe: bundled · carafe 0.1.0-app.abc1234"). Every command the app runs is logged with
  its exit code and output in `~/.carafe/state/menubar.log`; `CarafeMenuBar --capture-toggle
  enable|disable` and `--probe-read PATH` drive those paths from a terminal.
- **Icon = capture health**, from `carafe service status` every 15 s, two states: the
  Carafe mark mostly full while capture is running · the empty outline whenever it is not
  (no service installed, service not running, no live watcher lock, or a watcher whose last
  tick is older than 90 s; 15 min while an index build is in progress). When capture becomes
  running (Start clicked and confirmed, or found running at launch) the carafe fills from
  empty over 1.4 s, the design's brewing motion once; Pause empties it at once. The status line adds
  what the watcher reports about itself: "indexing 37 sessions left", "indexing “<session>” ·
  12 more queued", or "indexes current". Right after the watcher (re)starts, while it captures
  and then drains the snapshots and indexes a restart owes, `service status` prints a
  `startup:` line and the menu shows "Catching up after restart…" with what is left
  ("catching up (snapshots 12 left, index 40 left)") instead of an old last tick reading as
  stalled; a startup that stops moving is still caught by the watchdog below.
- **Folder access, asked in the foreground.** Every build is a new client to macOS privacy
  protection, and the background watcher's first open of `~/Documents` (or Desktop, Downloads)
  blocks on a permission prompt nobody sees. So on first launch, and on every launch after the
  bundled carafe's version changed, the app asks `carafe doctor --protected-folders` which
  protected folders hold session directories (read-only, from the store and Claude Code's
  project names), explains in one line, lists each folder itself so macOS asks while the user
  is looking, and only then restarts the capture service. A refused folder shows as "No access
  to Documents — sessions there are skipped" with "Open Privacy Settings…"; the watcher logs
  a refusal once per folder and skips it until it restarts.
- **Watchdog outside the watcher.** The watcher writes `~/.carafe/state/watch-heartbeat.json`
  (pid, last completed tick, stage) at every tick and stage; its in-process watchdog cannot fire
  while its thread is blocked in the kernel. Every 60 s the app runs `carafe service watchdog
  --auto-restart`: a heartbeat older than 5 minutes (15 during an index build) from a live
  watcher shows "Carafe's watcher is stuck (last activity N min ago)", the likely cause, and
  "Restart Watcher" (`carafe service restart`: `launchctl kickstart -k`, or `launchctl bootstrap`
  when launchd no longer has the service loaded). The automatic restart happens at most once per
  30 minutes and never while the stage is a first open of a protected folder (a restart cannot
  answer a dialog).
- **Prompt reflex line**, from `carafe reflex status`: on (Claude Code + Codex) / one of
  them / off, with "Enable Prompt Reflex (Claude Code + Codex)" (runs `carafe reflex
  install`; the alert shows carafe's output verbatim, including Codex's requirement to
  trust the hook via `/hooks`) or "Disable Prompt Reflex".
- **Hand off**: one “Hand Off ▸” menu contains “From Claude Code ▸” and
  “From Codex ▸”, supplied by the capture registry via `carafe list --sources --json`.
  Each source lists its own recent interactive sessions (active first, marked ●,
  with age, tool and title), or “No sessions captured yet”. New capture adapters
  add source submenus without menu code changes. Picking one runs
  `carafe handoff <id>` and copies `Read <absolute path> and continue the work`.
  The notification says “Paste into any agent (Claude Code, Codex, Cursor, Devin, …)”.
- Menu: status lines · Open Carafe (UI) · Hand Off ▸ source ▸ sessions ·
  Pause/Start capture · Enable/Disable prompt reflex · Check for updates · Quit.

Design (`apps/menubar/Design/`): the mark depicts a coffee server filling with coffee; `carafe-mark-fill-bare.svg`
is the static reference and `main.swift` draws the same path natively, so the status item
is crisp at any size; its coffee level is the state: mostly full while capture is running,
empty when it is not.
`CarafeMenuBar --render-icons DIR` writes the mark as PNGs;
`python3 Design/make-icons.py` composes `Carafe.icns` from that rendering on the design's
dark tile. No PNG exports are kept in the repo.

Dev:

    swift build && swift run

Packaging (`make-app.sh`):

- `./make-app.sh` builds this Mac's architecture, ad-hoc signs, and installs to
  `~/Applications/Carafe.app`; `--no-install` only stages.
- `./make-app.sh --release VERSION` builds a universal app (arm64 + x86_64; one carafe binary
  per architecture, the app picks its own), signs the nested binaries with the hardened
  runtime and Bun's JIT entitlements (`carafe.entitlements`), then the bundle, and zips it to
  `dist/Carafe-VERSION.zip` with a `.sha256`. With `CARAFE_SIGN_IDENTITY` ("Developer ID
  Application: …") it signs with that identity, and with `CARAFE_NOTARY_PROFILE` (a
  `notarytool store-credentials` profile) or `NOTARY_APPLE_ID` + `NOTARY_TEAM_ID` +
  `NOTARY_PASSWORD` it notarizes and staples. Without them the zip is ad-hoc signed and macOS
  may block the first launch. After attempting to open it, use System Settings →
  Privacy & Security → Open Anyway, then confirm Open.
- The release workflow builds the same zip on a macOS runner for every release and attaches
  it; add the secrets `MACOS_CERT_P12` (base64 .p12), `MACOS_CERT_PASSWORD`, and the notary
  trio to get Gatekeeper-clean downloads. That needs an Apple Developer Program membership.

Why staging happens outside the repo: cloud-synced folders can add file-provider attributes that codesign refuses;
staging in a temporary folder avoids those attributes.

A normal install, as a user sees it: download the zip, open Carafe, accept "Move to your
Applications folder?" (it copies itself, relaunches from there, and trashes the copy it was
opened from), accept or decline "Start at login?", and the icon is in the menu bar with
capture running. Moving or updating the app re-points the capture service at the new copy
on the next launch. "Check for Updates" asks the release feed and opens the releases page
when a newer version exists; the bundled carafe itself never self-updates.
