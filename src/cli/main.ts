/**
 * Every carafe command (see ./index.ts, the entrypoint).
 */
import { runImport } from "./import";
import { runWatch } from "./watch";
import { runList } from "./list";
import { runHandoff } from "../handoff/handoff";
import { runKeyMoments } from "../keymoments/keymoments";
import { runChapters } from "../keymoments/chapters-cli";
import { CarafeStore } from "../format/store";
import { readSession } from "../format/sessions";
import { AmbiguousSessionIdError, findSession, latestSession } from "../query/sessions";
import { renderHandoff } from "../handoff/render";
import { egressScrub } from "../redact/egress";
import { listCheckpoints, mirrorCheckpointToGit, takeManualCheckpoint } from "../state/checkpoint";
import { applyGc, applyMigration, formatGcReport, formatMigrationReport, planGc, planMigration } from "../state/gc";
import { applyUndo, formatUndoPlan, planUndo, rewindBriefPath, writeRewindBrief } from "../state/undo";
import { disableCheckpointSync, enableCheckpointSync, repoVisibility, syncStatus } from "../state/sync";
import { versionLine } from "../version";
import { readToStdout } from "../mux/encrypted-transcript";
import { printMap, printSessions } from "../mux/store";
import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import { releaseWatchLock, tryAcquireWatchLock } from "./watch-lock";
import { maybeWarnUpdate, refreshUpdateCache, runUpdate } from "./update";
import { runSkills } from "./skills";
import { checkWatchdog, disableService, enableService, formatServiceStatus, formatWatchdogReport, restartService, statusService } from "./service";
import { listSessions } from "../query/sessions";
import { protectedFoldersOf, protectedFoldersOfEncodedNames } from "../state/protected-folders";
import { runLiveCommand } from "./live";
import { positionalArgs } from "./args";
import { cliUsage } from "./usage";
import { loadPro, notInBuild } from "../tier";

// An id prefix that matches more than one session is a question, not a crash:
// print the candidates and stop. (Every command resolves ids through
// findSession, so one handler covers all of them.)
const reportFatal = (error: unknown): never => {
  if (error instanceof AmbiguousSessionIdError) console.error(error.message);
  else console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exit(1);
};
process.on("uncaughtException", reportFatal);
process.on("unhandledRejection", reportFatal);

const [cmd, ...rest] = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : undefined;
};
const has = (name: string): boolean => rest.includes(`--${name}`);
const positional = positionalArgs(rest);

// Help is a pure read. Handle it before update checks, stores, locks, dynamic
// imports, or any command dispatch so every state-changing command is inert.
// (The one import is the Pro tier's manifest, for its help lines; it has no
// side effects and loads no command code.)
if (cmd === "--help" || cmd === "-h" || rest.includes("--help") || rest.includes("-h")) {
  console.log(cliUsage((await loadPro())?.usage));
  process.exit(0);
}

// Startup update warning (stderr, cache-only, never blocks). Skipped where it
// would be noise or break a contract: install.sh greps `--version` stdout, and
// `update` itself already talks to the release feed.
if (!["version", "--version", "-v", "update", "skills", "reflex", "live", "bench", "__refresh-update-cache", undefined].includes(cmd)) {
  maybeWarnUpdate();
}

const fmtBytes = (n: number): string => {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)}MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${n}B`;
};

/** A handoff or resume block must describe the session as it IS, not as of the
 *  last time something happened to run an import — a store can silently sit
 *  days stale on a machine with no watcher. Incremental import first (cheap:
 *  unchanged files are skipped). Skipped with a note when a watcher/UI holds
 *  the capture lock; its next tick covers freshness. */
async function importForFreshness(): Promise<void> {
  const store = new CarafeStore();
  const lock = tryAcquireWatchLock(store.root);
  if (!lock) { console.error("note: capture is running elsewhere — using its most recent import"); return; }
  try { await runImport({}); } finally { releaseWatchLock(lock); }
}

function resolveSessionArg(id: string) {
  const store = new CarafeStore();
  const d = id === "latest" ? latestSession(store) : findSession(store, id);
  if (!d) { console.error(`session not found: ${id}`); process.exit(1); }
  return { store, d };
}

function confirmYes(message: string): boolean {
  const promptFn = (globalThis as any).prompt as undefined | ((message?: string) => string | null);
  if (!(process.stdin as any).isTTY || !promptFn) return false;
  const answer = promptFn(`${message} [y/N] `);
  return /^y(es)?$/i.test(answer?.trim() ?? "");
}

function allowPush(cwd: string, opts: { publicOk?: boolean; yes?: boolean }): { ok: boolean; message?: string } {
  const visibility = repoVisibility(cwd);
  if (visibility === "PUBLIC" && !opts.publicOk) return { ok: false, message: "repo visibility is PUBLIC; rerun with --public-ok to allow pushing checkpoint refs" };
  if (!visibility && !opts.yes && !confirmYes("could not verify repo visibility; push checkpoint refs anyway?")) return { ok: false, message: "could not verify repo visibility" };
  return { ok: true };
}

function printCheckpointList(store: CarafeStore, d: any): void {
  const rows = listCheckpoints(store, d.tool, d.sessionId);
  console.log(`seq · event time · files · size · git head`);
  for (const r of rows) {
    console.log(`${r.seq} · ${r.ts ?? "?"} · ${r.fileCount} · ${fmtBytes(r.totalBytes)} · ${r.gitHead ? r.gitHead.slice(0, 12) : "?"}`);
  }
}

/** A Carafe Pro command: run it from the closed tier, or say plainly that this
 *  build does not have it. */
async function runProCommand(name: string): Promise<void> {
  const command = (await loadPro())?.commands[name];
  if (!command) {
    console.error(notInBuild(`\`carafe ${name}\``));
    process.exit(1);
  }
  const code = await command.run({ positional, flag, has });
  if (typeof code === "number" && code !== 0) process.exit(code);
}

switch (cmd) {
  case "--version":
  case "-v":
  case "version":
    // install.sh greps this line to tell an up-to-date install from a stale one.
    console.log(versionLine());
    break;
  case "import":
    {
      const store = new CarafeStore();
      const lock = tryAcquireWatchLock(store.root);
      if (!lock) {
        let holder = "unknown";
        try { holder = (readFileSync(join(store.root, "state", "watch.lock"), "utf8").split("\n")[0] ?? "unknown").trim() || "unknown"; } catch { /* lock raced away */ }
        console.error(`capture is already running (pid ${holder}) — it imports new sessions automatically; stop it first if you need a manual import`);
        process.exit(1);
      }
      try {
        await runImport({ limit: flag("limit") ? Number(flag("limit")) : undefined, tool: flag("tool"), force: has("force") });
      } finally {
        releaseWatchLock(lock);
      }
    }
    break;
  case "watch":
    await runWatch({ intervalMs: flag("interval") ? Number(flag("interval")) * 1000 : undefined, noWatchdog: has("no-watchdog") });
    break;
  case "service": {
    const sub = positional[0];
    if (sub === "enable") {
      // Explicit: points the service at this carafe. --keep-owner (install.sh)
      // leaves a service that runs another existing carafe as it is.
      const result = enableService({ intervalSeconds: flag("interval") ? Number(flag("interval")) : undefined, keepOwner: has("keep-owner") });
      console.log(result.message);
      if (!result.ok) process.exitCode = 1;
      break;
    }
    if (sub === "disable") {
      const result = disableService();
      console.log(result.message);
      if (!result.ok) process.exitCode = 1;
      break;
    }
    if (sub === "status") {
      console.log(formatServiceStatus(statusService()));
      break;
    }
    if (sub === "restart") {
      const result = restartService();
      console.log(result.message);
      if (!result.ok) process.exitCode = 1;
      break;
    }
    if (sub === "watchdog") {
      console.log(formatWatchdogReport(checkWatchdog({ autoRestart: has("auto-restart") })));
      break;
    }
    console.error("usage: carafe service enable|disable|status|restart|watchdog [--interval SECONDS] [--keep-owner] [--auto-restart]\nThe service belongs to the carafe it runs (see `carafe service status`): only an explicit `carafe service enable` re-points it; `carafe update` restarts it only when it runs the updated binary.");
    process.exit(1);
  }
  case "doctor": {
    // Read-only. `--protected-folders`: the macOS-protected folders (~/Documents,
    // ~/Desktop, ~/Downloads) that hold a captured session's working directory,
    // from the store's distillates alone — nothing under them is opened. The menu
    // bar app touches these in the foreground so the permission prompt appears
    // where the user can see it, not behind the background watcher.
    if (has("protected-folders")) {
      const store = new CarafeStore(undefined, { readOnly: true });
      const found = new Set(protectedFoldersOf(listSessions(store).map((d) => d.cwd)));
      // Sessions not captured yet (a first install): Claude Code's project
      // directory NAMES encode their working directory. Names only, never contents.
      let projects: string[] = [];
      try { projects = readdirSync(join(process.env.CARAFE_CC_ROOT ?? join(process.env.HOME ?? "", ".claude"), "projects")); } catch { /* no Claude Code */ }
      for (const folder of protectedFoldersOfEncodedNames(projects)) found.add(folder);
      for (const folder of [...found].sort()) console.log(folder);
      break;
    }
    console.error("usage: carafe doctor --protected-folders");
    process.exit(1);
  }
  case "list":
    runList({ limit: flag("limit") ? Number(flag("limit")) : undefined, tool: flag("tool"), all: has("all"), interactive: has("interactive"), json: has("json"), sources: has("sources") });
    break;
  case "live": {
    const code = await runLiveCommand(positional[0], { workspace: flag("workspace"), host: flag("host") });
    if (code) process.exitCode = code;
    break;
  }
  case "handoff":
    if (!positional[0]) { console.error(`usage: carafe handoff <id|latest|current> [--to LABEL] [--thinking] [--no-arm] [--live|--no-live] [--answers PATH] [--questions]`); process.exit(1); }
    await importForFreshness();
    // --live is the explicit per-run network override. Without it, only health
    // hosts with stored human TTY permission may be contacted; git stays local.
    await runHandoff(positional[0], { to: flag("to"), thinking: has("thinking"), noArm: has("no-arm"), live: has("live"), noLive: has("no-live"), answers: flag("answers"), questions: has("questions") });
    break;
  case "checkpoint": {
    if (!positional[0]) { console.error(`usage: carafe checkpoint <id|latest> [--list] [--push] [--remote origin] [--public-ok] [--yes]`); process.exit(1); }
    const { store, d } = resolveSessionArg(positional[0]!);
    if (has("list")) {
      printCheckpointList(store, d);
      break;
    }
    const events = readSession(store, d.tool, d.sessionId);
    const latest = events[events.length - 1];
    if (!latest) { console.error(`session has no events: ${d.sessionId}`); process.exit(1); }
    const cp = takeManualCheckpoint(store, d, latest.seq, latest.ts);
    if (!cp) { console.error(`checkpoint failed: cwd missing or snapshot guard skipped`); process.exit(1); }
    console.log(`checkpoint seq ${cp.manifest.seq}: ${cp.manifest.fileCount} files · ${fmtBytes(cp.manifest.totalBytes)} · ${cp.dir}`);
    if (has("push")) {
      if (!d.cwd) { console.error("checkpoint push failed: cwd missing"); process.exit(1); }
      const allowed = allowPush(d.cwd, { publicOk: has("public-ok"), yes: has("yes") });
      if (!allowed.ok) { console.error(allowed.message); process.exit(1); }
      const mirrored = mirrorCheckpointToGit(d, cp.manifest, { push: true, remote: flag("remote") ?? "origin" });
      if (!mirrored) { console.error("checkpoint push failed: mirror unavailable"); process.exit(1); }
      if (mirrored.pushError) { console.error(`checkpoint push failed: ${mirrored.pushError}`); process.exit(2); }
      console.log(`pushed: ${mirrored.ref}`);
    }
    break;
  }
  case "sync": {
    const sub = positional[0];
    const store = new CarafeStore();
    const cwd = process.cwd();
    if (sub === "enable") {
      const r = enableCheckpointSync(store, cwd, {
        remote: flag("remote") ?? "origin",
        publicOk: has("public-ok"),
        yes: has("yes"),
        confirm: confirmYes,
      });
      if (!r.ok) { console.error(r.message); process.exit(1); }
      console.log(r.message);
      break;
    }
    if (sub === "disable") {
      const r = disableCheckpointSync(store, cwd, { remote: flag("remote") ?? "origin" });
      console.log(r.message);
      break;
    }
    if (sub === "status") {
      const rows = syncStatus(store, cwd);
      if (!rows.length) console.log("checkpoint sync: no enabled repos");
      else {
        console.log("key · enabled · remote · refs");
        for (const r of rows) console.log(`${r.key} · ${r.enabled ? "yes" : "no"} · ${r.remote} · ${r.refCount}`);
      }
      break;
    }
    console.error(`usage: carafe sync enable [--remote origin] [--public-ok] [--yes]\n       carafe sync disable [--remote origin]\n       carafe sync status`);
    process.exit(1);
  }
  case "skills": {
    const sub = positional[0];
    process.exitCode = runSkills(sub, { claude: has("claude"), codex: has("codex"), force: has("force") });
    break;
  }
  case "reflex": {
    process.exitCode = await (await import("../reflex/cli")).runReflexCli(rest);
    break;
  }
  case "undo": {
    if (!positional[0]) { console.error(`usage: carafe undo <id|latest> --to-seq N [--apply] [--brief]`); process.exit(1); }
    const { store, d } = resolveSessionArg(positional[0]!);
    if (has("list")) {
      printCheckpointList(store, d);
      break;
    }
    const rawSeq = flag("to-seq");
    if (!rawSeq || !Number.isFinite(Number(rawSeq))) { console.error(`usage: carafe undo <id|latest> --to-seq N [--apply] [--brief]`); process.exit(1); }
    const targetSeq = Number(rawSeq);
    const events = readSession(store, d.tool, d.sessionId);
    const plan = planUndo(store, d, targetSeq);
    console.log(formatUndoPlan(plan));
    const briefPath = rewindBriefPath(store, d.sessionId, targetSeq);
    if (has("apply") || has("brief")) {
      writeRewindBrief(store, d, events, targetSeq);
      console.log(`rewind brief: ${briefPath}`);
    } else {
      console.log(`rewind brief: ${briefPath} (use --brief or --apply to write)`);
    }
    console.log(`start fresh: Read ${briefPath} and continue from where it ends.`);
    if (plan.errors.length) process.exit(1);
    if (has("apply")) {
      const applied = applyUndo(store, d, plan);
      console.log(`applied: restored ${applied.restored}, moved ${applied.moved}`);
      console.log(`pre-undo stash: ${applied.stashDir}`);
      console.log(`undo-the-undo: restore from ${applied.stashDir}`);
    }
    break;
  }
  case "gc": {
    // Dry run is the DEFAULT: a reclaiming command never removes anything a
    // user did not ask for by name.
    const store = new CarafeStore();
    const yes = has("yes");
    if (has("migrate")) {
      const plan = planMigration(store);
      console.log(formatMigrationReport(plan, { apply: yes }));
      if (yes) {
        const r = applyMigration(store, plan);
        console.log(`converted: ${r.converted} snapshot(s) to version 2`);
      } else if (plan.dirs.length) {
        console.log(`rerun with --yes to convert`);
      }
      break;
    }
    const plan = planGc(store);
    console.log(formatGcReport(plan, { apply: yes }));
    if (yes) {
      const r = applyGc(store, plan);
      console.log(`removed: ${r.removed} snapshot(s); swept ${r.sweptObjects} object(s)`);
    } else if (plan.victims.length || plan.orphanObjects) {
      console.log(`rerun with --yes to apply`);
    }
    break;
  }
  case "share":
  case "receive":
  case "pr-post":
    await runProCommand(cmd);
    break;
  case "egress-check": {
    if (!positional[0]) { console.error(`usage: carafe egress-check <id|latest>`); process.exit(1); }
    const store = new CarafeStore();
    const d = positional[0] === "latest" ? latestSession(store) : findSession(store, positional[0]!);
    if (!d) { console.error(`session not found: ${positional[0]}`); process.exit(1); }
    const events = readSession(store, d.tool, d.sessionId);
    const rendered = renderHandoff(d, events, { includeThinking: false });
    const { report } = egressScrub(rendered.text, { cwd: d.cwd });
    console.log(`kind · action · count · first masked sample`);
    for (const finding of report.findings) {
      console.log(`${finding.kind} · ${finding.action} · ${finding.count} · ${finding.samples[0] ?? ""}`);
    }
    console.log(`${report.totalRedactions} redactions · ${report.borderlineCount} borderline — review before this leaves the machine`);
    if (report.totalRedactions + report.borderlineCount > 0) process.exitCode = 2;
    break;
  }
  case "distill":
    await runProCommand(cmd);
    break;
  case "key-moments":
    if (!positional[0]) { console.error(`usage: carafe key-moments <id|latest|current> [--budget CHARS] [--thinking]`); process.exit(1); }
    await importForFreshness();
    await runKeyMoments(positional[0], { budget: flag("budget") ? Number(flag("budget")) : undefined, thinking: has("thinking") });
    break;
  case "chapters":
    if (!positional[0]) { console.error(`usage: carafe chapters <id|latest|current> [--chapter K] [--json]`); process.exit(1); }
    runChapters(positional[0], { chapter: flag("chapter") ? Number(flag("chapter")) : undefined, json: has("json") });
    break;
  case "index":
    if (has("all")) {
      // Same bounds as the watcher (90 days, ≥ 40 events, newest 12 per
      // directory); --everything lifts them all.
      (await import("./ask")).runSessionIndexBackfill({
        cwd: flag("cwd"), sinceDays: flag("since") == null ? undefined : Number(flag("since")),
        minEvents: flag("min-events") == null ? undefined : Number(flag("min-events")),
        perCwd: flag("per-cwd") == null ? undefined : Number(flag("per-cwd")),
        everything: has("everything"),
      });
      break;
    }
    if (!positional[0]) { console.error(`usage: carafe index <id|latest|current> [--rebuild]\n       carafe index --all [--cwd DIR] [--since DAYS] [--min-events N] [--per-cwd N] [--everything]`); process.exit(1); }
    (await import("./ask")).runSessionIndex(positional[0], { rebuild: has("rebuild") });
    break;
  case "ask":
    if (!positional[0]) { console.error(`usage: carafe ask <id|latest|current> [--file F] [--kind K] [--chapter N] [--failed] [--command FAMILY] [--branch B] [--limit N] [--json] [--no-build]`); process.exit(1); }
    {
      const { parseAskKind, runAsk } = await import("./ask");
      runAsk(positional[0], {
        file: flag("file"), kind: parseAskKind(flag("kind")),
        chapter: flag("chapter") ? Number(flag("chapter")) : undefined,
        failed: has("failed"), command: flag("command"), branch: flag("branch"),
        limit: flag("limit") ? Number(flag("limit")) : undefined,
        json: has("json"), noBuild: has("no-build"),
      });
    }
    break;
  case "bench": {
    if (positional[0] === "reflex") {
      const { runReflexBench, formatReflexScorecard, reflexScorecardJSON } = await import("../bench/reflex/run");
      const card = runReflexBench({ tier: (flag("tier") as "gate" | "full" | undefined) ?? "gate", updateBaseline: has("update-baseline") });
      console.log(has("json") ? reflexScorecardJSON(card) : formatReflexScorecard(card, { misses: has("misses") }));
      break;
    }
    if (positional[0] === "cat35") {
      const dir = flag("dir");
      if (!dir) { console.error("usage: carafe bench cat35 --dir DIR [--budgets 20000,4000,1500] [--json]"); process.exit(1); }
      const rawBudgets = flag("budgets");
      const budgets = rawBudgets == null ? undefined : rawBudgets.split(",").map(Number);
      if (budgets?.some((budget) => !Number.isSafeInteger(budget) || budget <= 0)) { console.error("--budgets must be a comma-separated list of positive integers"); process.exit(1); }
      const { CAT35_DEFAULT_BUDGETS, formatCat35, runCat35 } = await import("../bench/external/cat35");
      const selectedBudgets = budgets ?? CAT35_DEFAULT_BUDGETS;
      const score = runCat35(dir, selectedBudgets);
      console.log(has("json") ? JSON.stringify(score, null, 2) : formatCat35(score, selectedBudgets));
      break;
    }
    if (positional[0] === "handoff") {
      if (has("real")) {
        const { runRealHandoffBench, formatRealHandoffBench } = await import("../bench/handoff-real");
        const ids = rest.flatMap((arg, i) => arg === "--session" && rest[i + 1] ? rest[i + 1]!.split(",") : []);
        const card = await runRealHandoffBench({ n: flag("n") == null ? undefined : Number(flag("n")), sessions: ids });
        console.log(has("json") ? JSON.stringify(card, null, 2) : formatRealHandoffBench(card));
        if (!card.ok) process.exitCode = 1;
        break;
      }
      const dir = flag("dir");
      if (!dir) { console.error("usage: carafe bench handoff --dir DIR [--json]"); process.exit(1); }
      const { formatHandoffBench, runHandoffBench } = await import("../bench/handoff");
      const card = runHandoffBench(dir);
      console.log(has("json") ? JSON.stringify(card, null, 2) : formatHandoffBench(card));
      if (card.cases.some((one) => one.falseStatements.length)) process.exit(1);
      break;
    }
    if (positional[0] !== "moments") { console.error("usage: carafe bench moments [--tier gate|full] [--extractor v1|v2] [--json] [--out FILE] [--misses] [--update-baseline] [--materialize DIR]\n       carafe bench cat35 --dir DIR [--budgets 20000,4000,1500] [--json]\n       carafe bench reflex [--tier gate|full] [--json] [--update-baseline]"); process.exit(1); }
    const { runBench, formatScorecard, toJSON } = await import("../bench/run");
    const card = await runBench({ tier: (flag("tier") as "gate" | "full" | undefined) ?? "gate", extractor: flag("extractor"), out: flag("out"), json: has("json"), updateBaseline: has("update-baseline"), materialize: flag("materialize"), misses: has("misses") });
    console.log(has("json") ? toJSON(card) : formatScorecard(card));
    break;
  }
  case "show":
    if (!positional[0]) { console.error(`usage: carafe show <id> [--seq A-B] [--thinking] [--max-chars N]`); process.exit(1); }
    (await import("../query/inspect")).runShow(positional[0], { seq: flag("seq"), thinking: has("thinking"), maxChars: flag("max-chars") !== undefined ? Number(flag("max-chars")) : undefined });
    break;
  case "grep":
    if (!positional[0] || !positional[1]) { console.error(`usage: carafe grep <id> <pattern> [--limit N] [--deep]`); process.exit(1); }
    (await import("../query/inspect")).runGrep(positional[0], positional[1], { limit: flag("limit") ? Number(flag("limit")) : undefined, deep: has("deep") });
    break;
  case "search": {
    const q = positional.join(" ").trim();
    if (!q) { console.error(`usage: carafe search [--session <id|latest|current>] <query> [--tool T] [--limit N] [--deep] [--all]`); process.exit(1); }
    (await import("./search")).runSearch(q, { limit: flag("limit") ? Number(flag("limit")) : undefined, tool: flag("tool"), deep: has("deep"), all: has("all"), session: flag("session") });
    break;
  }
  case "reindex":
    if (has("titles")) {
      (await import("./reindex-titles")).runReindexTitles({ apply: has("yes") });
      break;
    }
    if (has("usage")) {
      (await import("./reindex-usage")).runReindexUsage({ apply: has("yes") });
      break;
    }
    { const { SearchIndex } = await import("../search/index"); const { CarafeStore } = await import("../format/store");
      const idx = new SearchIndex(new CarafeStore()); const r = idx.reindex({ force: has("force") }); idx.close();
      console.log(`reindexed ${r.indexed} / ${r.total} sessions`); }
    break;
  case "start": {
    const agent = positional[0] ?? "claude";
    const storage = flag("handoff-storage") ?? "memory";
    if ((agent !== "claude" && agent !== "codex") || (storage !== "memory" && storage !== "disk")) {
      console.error(`usage: carafe start [claude|codex] [--prompt P] [--cwd D] [--handoff-storage memory|disk]`);
      process.exit(1);
    }
    try {
      // Dynamic on purpose: importing mux dlopens bun-pty's native library;
      // every other command must stay PTY-free.
      await (await import("../mux/mux")).run(agent, flag("prompt") ?? null, flag("cwd") ?? process.cwd(), storage);
    } catch (error) {
      console.error(`error: ${error instanceof Error ? error.message : error}`);
      process.exit(1);
    }
    // PTY FFI read loops can outlive the mux; never let a stray handle
    // keep an already-settled Carafe process alive.
    process.exit(0);
  }
  case "map":
    if (positional[0]) printMap(positional[0]);
    else printSessions();
    break;
  case "read":
    if (!positional[0]) { console.error(`usage: carafe read <archive.carafe.enc>`); process.exit(1); }
    try {
      readToStdout(positional[0]);
    } catch (error) {
      console.error(`error: ${error instanceof Error ? error.message : error}`);
      process.exit(1);
    }
    break;
  case "ui":
    (await import("../ui/server")).runUI({ port: flag("port") ? Number(flag("port")) : undefined, open: !has("no-open") });
    break;
  case "update":
    await runUpdate({ check: has("check") });
    break;
  case "__refresh-update-cache":
    // Hidden: spawned detached by maybeWarnUpdate to fill the cache off the hot path.
    await refreshUpdateCache();
    break;
  default:
    console.log(cliUsage((await loadPro())?.usage));
}
