/** The open build's help. Carafe Pro adds its own lines (see cliUsage). */
export const CLI_USAGE = `carafe — the continuity layer for AI coding agents

usage:
  carafe import [--limit N] [--tool T]        backfill existing sessions
  carafe watch  [--interval SECONDS] [--no-watchdog]  continuous capture (default 4s)
  carafe service enable|disable|status        background capture OS service (status names the carafe it runs)
    [--keep-owner]                            enable: leave a service that runs another carafe as it is
  carafe service restart                      restart the watcher (kickstart -k; bootstraps it if not loaded)
  carafe service watchdog [--auto-restart]    judge the watcher's heartbeat from outside it
  carafe doctor --protected-folders           macOS-protected folders holding session directories (read-only)
  carafe list   [--limit N] [--tool T] [--interactive] [--all] [--json] [--sources]  recent sessions (⚙ = agent-spawned; --interactive hides them)
  carafe start [claude|codex] [--prompt P]    live mux: agents in PTYs — Ctrl-G switch, Ctrl-H handoff, Ctrl-Q quit
  carafe map [id]                             persisted live-mux parent/child session maps
  carafe read <archive.carafe.enc>            decrypt a live-mux transcript (inside a managed agent)
  carafe handoff <id|latest|current> [--to LABEL]  handoff ready → any agent (optional display label only)
    [--live]                                  ...and re-check the remotes and health URLs (MAKES NETWORK REQUESTS)
    [--no-live]                               skip all network checks for this run
    [--questions] [--answers PATH]            ...the five questions to answer first, or a written answer file
  carafe live status|allow|deny|forget        inspect or change per-workspace health-check consent
    [--workspace PATH] [--host H]
  carafe checkpoint <id|latest> [--list]      snapshot or list worktree checkpoints
  carafe sync enable|disable|status           opt in/out of git-backed checkpoint sync
  carafe skills install|status|uninstall      install Carafe skills for Claude Code and Codex
  carafe reflex <id> --turn "<text>"          volunteer suppressed, seq-anchored pointers relevant to a turn
  carafe reflex arm|disarm|status             manage the handed-off session for each working directory
  carafe reflex install|uninstall [--claude]  manage the fail-silent Claude Code prompt hook
  carafe undo <id|latest> --to-seq N [--apply] restore files to a checkpoint plan-first
  carafe gc [--migrate] [--yes]               snapshot retention + object sweep (dry run by default)
  carafe egress-check <id|latest>             scan a rendered handoff before cross-person sharing
  carafe key-moments <id|latest> [--budget N]   compaction-for-resumption: key moments + a copyable resume block
  carafe chapters <id|latest> [--chapter K]    chapter skeleton or one chapter's complete weighted turn directory
  carafe index <id|latest> [--rebuild]         build the per-session text + relations index
  carafe ask <id|latest> [structured filters]  query chapters, files, moments, commands, and failures
  carafe bench moments [--tier gate|full]       deterministic key-moments benchmark
  carafe bench cat35 --dir DIR                  gbrain Cat 35 mechanical anchor benchmark
  carafe bench reflex [--tier gate|full]        deterministic retrieval-reflex benchmark
  carafe bench handoff --dir DIR                handoff corpus: false statements, missing facts, invariants
  carafe grep <id> <pattern> [--limit N] [--deep] search within a session (indexed; --deep scans the trace)
  carafe show <id> [--seq A-B] [--max-chars N] print a section verbatim (default cap 60K; 0 is unlimited)
  carafe search [--session <id>] <query>      ranked recall across the corpus or one session's turns
  carafe ui [--port N] [--no-open]            the switcher (search · sessions · handoff)
  carafe reindex [--force]                    rebuild the search index
  carafe update [--check]                     update to the latest release (--check only reports)
  carafe --version                            print version and build target
`;

/** The help text with the Pro tier's lines, each block placed after the open
 *  command it names (and after that command's indented continuation lines). */
export function cliUsage(extra: ReadonlyArray<{ after: string; text: string }> = []): string {
  const lines = CLI_USAGE.split("\n");
  for (const block of extra) {
    let at = lines.findIndex((line) => line.startsWith(`  carafe ${block.after} `));
    if (at < 0) at = lines.length - 1; // before the trailing newline
    else { at += 1; while (at < lines.length && lines[at]!.startsWith("    ")) at += 1; }
    lines.splice(at, 0, ...block.text.split("\n"));
  }
  return lines.join("\n");
}
