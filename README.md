# Carafe

Carafe keeps your AI coding sessions available on your own machine.
Find past work, replay its history, and hand context between Claude Code and Codex.
Use the CLI, a local browser UI, or the macOS menu bar app.

## 60-second quickstart

Install the standalone binary (macOS or Linux; no Node or Bun required):

```sh
curl -fsSL https://raw.githubusercontent.com/Carafehq/carafe/main/install.sh | sh
export PATH="$HOME/.local/bin:$PATH"
carafe list
carafe ui
```

Run a session in a supported tool first if your list is empty. Installation starts
local background capture; use `--no-watcher` to opt out, or `carafe service disable`
to stop it. `carafe --help` lists the commands. Git is needed for checkpoints and undo.

No token or GitHub account is needed. Releases and source are public.

The installer verifies release checksums and installs to `~/.local/bin` (override
with `--dir`). macOS and Linux, x64 and arm64 are supported, including Linux musl
and x64 baseline builds. There is no Windows binary.

## Supported tools

| Tool | Local session capture | Session search and replay | Agent handoff |
| --- | --- | --- | --- |
| Claude Code | Yes | Yes | Yes |
| Codex | Yes | Yes | Yes |

Carafe reads the structured session files these tools already write. Source
session files are never modified. Prompt reflex hooks are optional; enable them
with `carafe reflex install` and follow its tool-specific trust instructions.

## Privacy

Carafe is local-first. It never uploads your session data. Capture, indexing,
search, replay, and handoff files stay on your machine under `~/.carafe`.
Secret-shaped text is redacted at egress, and a failed egress check blocks output.
A share file is an explicit export: writing one does not upload it; you decide
whether to send it. Sharing is part of Pro. Agent handoffs provide context to the
agent you launch, whose own network and privacy settings apply.

Installation and update checks contact GitHub for release metadata and binaries;
these requests contain no session content. Disable the daily background release
check with `CARAFE_NO_UPDATE_CHECK=1`. Explicit updates still contact the release
feed. Project health checks run only with explicit consent for that project.

## Find, replay, and hand off

`carafe list` lists captured sessions; `carafe search <query>` finds past work.
`carafe ui` opens the local switcher and replay view. To hand off, use **Hand Off →
From Claude Code / From Codex → session** in the menu bar, or run `carafe handoff <session-id>`.
The result is a self-contained Markdown file; paste the copied
`Read <path> and continue the work` into any agent that can read files (Claude Code,
Codex, Cursor, Devin, …). Handoffs are deterministic and secret-redacted,
with source references instead of LLM summaries.

`carafe start claude --prompt "Investigate the failing tests"` starts a managed
terminal session. `Ctrl-G` switches between live children; `Ctrl-H` hands context
to the other agent while keeping the original process alive; `Ctrl-Q` exits the
parent and its owned terminals. `Ctrl-M` shows the session map on terminals that
report enhanced CSI-u keys. Inspect saved maps with `carafe map`.

The default handoff storage is memory. Above 256 KiB, a child's transcript moves
to authenticated encrypted disk storage with a visible warning. The encryption
key lives only in the parent and managed children; these archives become
unreadable after all of them exit. `--handoff-storage disk` selects disk storage
up front. Capture pauses and handoff is refused if storage fails.

## macOS app

Download `Carafe-VERSION.zip` from
[Releases](https://github.com/Carafehq/carafe/releases), extract it, and open
Carafe. The app offers session handoffs, capture status, and prompt reflex controls.
The unsigned/ad-hoc signed app is not notarized: after attempting to open it,
go to **System Settings → Privacy & Security → Open Anyway**, then confirm Open.
Only do this for a download you trust. See [app documentation](apps/menubar/README.md).

## Updates and releases

`carafe update` checks the release feed, verifies checksums, and replaces the CLI
atomically. `carafe update --check` reports only (exit 2 means an update exists).
The app's Check for Updates opens its releases page. A service is restarted only
when it runs the updated binary. Re-running the installer does not replace a
working installation unless `--force` is passed.

Public version numbering starts at **0.1.0**. Stable tags are `vX.Y.Z`; pushes to
`main` build `vX.Y.Z-alpha.<short-sha>` releases. Source builds use the package's
public version. Download a platform tarball from Releases for offline installation.

## Open source

Carafe's open build is licensed under Apache-2.0; see [LICENSE](LICENSE).
Pro adds share/receive files, PR stories and pins, and LLM decision-ledger distillation.

## Development

```sh
bun install --frozen-lockfile
bun run typecheck
bun run test
bun run src/cli/index.ts --help
bun run build                 # standalone binaries for all supported platforms
```

Tests use temporary stores and synthetic sessions. Never point tests at your
real session folders. See [CONTRIBUTING.md](CONTRIBUTING.md) and
[MomentsBench](docs/moments-v2/BENCH.md) for benchmark commands.

To audit your own local handoffs explicitly, run `carafe bench handoff --real`.
It reads up to eight recent stored sessions, renders handoffs in memory, verifies
source facts and quotes, and fails on false statements or exceeded budgets.
It does not launch agents or write handoffs.
