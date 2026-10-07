/**
 * Handoff v5 — the state checked at generation time, the outgoing agent's
 * answers verified against it, coverage of the last 72 hours, dates on every
 * quotation, the three orientation blocks, the two leaks, and the bench.
 *
 * Every git fixture is a real repository created in a temp directory by this
 * file; no test touches the real store, the real `~/.carafe`, or the network.
 */
import { describe, expect, test } from "bun:test";
import { execFileSync } from "child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { basename, dirname, join } from "path";
import type { SessionDistillate } from "../format/distillate";
import type { CarafeEvent } from "../format/events";
import type { KeyMoment } from "../keymoments/extract";
import { detectOpenAsks } from "../keymoments/asks";
import { checkLive, errorClass, liveLines, realGitRunner, relativeAge, unpushedOf, LIVE_COMMANDS, type LiveState } from "./live";
import { answersLines, parseAnswers, questionsText, readAnswerFile, verifyAnswers, verifySentence, HANDOFF_QUESTIONS } from "./answers";
import { clipAtToken, hasShellVariable } from "./leaks";
import { anchor, lapseSuffix, tsIndex } from "./dates";
import { fileMapLines, glossaryLines, hasCausalCue, isDefinitionSentence, isPlanSentence, lessonsLines, resolveInRepos } from "./orient";
import { extractPieces, type EventPieces } from "./pieces";
import { agentLabel, halfDoneLines, HANDOFF_MAX_CHARS, lessonExplainer, preparedPieces, principalWorkspaces, capHelperPieces, capTail, capTurnPieces, collapsedHelperLine, helperCapFor, isAssistantTextPiece, isCallPiece, isResultPiece, isToolPiece, isUserPiece, namedPrincipals, opensCallPiece, renderHandoff, repoCounts, rightNowData, TAIL_HELPER_MAX_CHARS, TAIL_TURN_MAX_CHARS, TAIL_TURN_MIN_CHARS, turnBelonging, turnCapFor, waitingLines } from "./render";
import { buildBlocks } from "./blocks";
import { healthUrlsFromTrace, normalizeHealthUrl } from "./state";
import { commitSubjectOf } from "../keymoments/select";
import { CLAUDE_SKILL, CODEX_PROMPT } from "../cli/skill-templates";

const sessionId = "handoff-v5-fixture";
const NOW = "2026-02-05T12:00:00Z";

function distillate(events: CarafeEvent[], over: Partial<SessionDistillate> = {}): SessionDistillate {
  return {
    tool: "codex", sessionId, sourcePath: "/tmp/session.jsonl", title: "handoff v5 fixture",
    cwd: "/tmp/project", gitBranch: "feat/test", startTs: "2026-02-01T10:00:00Z", endTs: "2026-02-05T11:00:00Z",
    eventCount: events.length, toolUseCount: events.filter((event) => event.kind === "tool_use").length,
    sidechain: false, rawBytes: 10, version: 1, ...over,
  };
}

let seq = 0;
function event(kind: string, payload: Record<string, unknown>, ts = "2026-02-05T10:30:00Z"): CarafeEvent {
  return { ts, tool: "codex", sessionId, seq: ++seq, kind, raw: { payload } };
}
const user = (message: string, ts?: string): CarafeEvent => event("user", { message }, ts);
const assistant = (message: string, ts?: string): CarafeEvent => event("assistant", { message }, ts);
const call = (command: string, output: string, ts?: string): CarafeEvent[] => [
  event("tool_use", { name: "Bash", arguments: { command } }, ts),
  event("tool_result", { output }, ts),
];
const edit = (path: string, ts?: string): CarafeEvent[] => [
  event("tool_use", { name: "Edit", arguments: { file_path: path } }, ts),
  event("tool_result", { output: "ok" }, ts),
];
const filler = (count = 240): CarafeEvent[] => Array.from({ length: count }, () => assistant(`filler ${"x".repeat(1_000)}`));

/* ------------------------------------------------------------------ *
 * Claude Code shape.
 *
 * A Claude Code trace has NO tool_use/tool_result events: a call is a
 * `tool_use` block inside an assistant event and its result is a `tool_result`
 * block inside a user event, so every event's kind is "user" or "assistant".
 * Everything the tail caps do has to work from the rendered lines, and these
 * fixtures are the proof — the Codex-shaped ones cannot show it.
 * ------------------------------------------------------------------ */

function ccEvent(kind: string, content: unknown, ts: string): CarafeEvent {
  return { ts, tool: "claude-code", sessionId, seq: ++seq, kind, raw: { type: kind, message: { role: kind, content } } };
}
const ccUser = (message: string, ts = "2026-02-05T10:00:00Z"): CarafeEvent => ccEvent("user", message, ts);
/** One assistant event carrying the assistant's words AND its calls, as Claude
 *  Code really writes them. */
const ccTurn = (text: string, commands: string[], ts = "2026-02-05T10:00:00Z"): CarafeEvent =>
  ccEvent("assistant", [
    ...(text ? [{ type: "text", text }] : []),
    ...commands.map((command, index) => ({ type: "tool_use", id: `call-${seq}-${index}`, name: "Bash", input: { command } })),
  ], ts);
const ccResult = (output: string, ts = "2026-02-05T10:00:00Z"): CarafeEvent =>
  ccEvent("user", [{ type: "tool_result", tool_use_id: `call-${seq}`, content: output }], ts);
const ccCall = (command: string, output: string, ts?: string): CarafeEvent[] => [ccTurn("", [command], ts), ccResult(output, ts)];
const ccRead = (path: string, output: string, ts?: string): CarafeEvent[] => [
  ccEvent("assistant", [{ type: "tool_use", id: `read-${seq}`, name: "Read", input: { file_path: path } }], ts ?? "2026-02-05T10:00:00Z"),
  ccResult(output, ts),
];
const ccFiller = (count = 240): CarafeEvent[] => Array.from({ length: count }, () => ccEvent("assistant", [{ type: "text", text: `filler ${"x".repeat(1_000)}` }], "2026-02-01T09:30:00Z"));

/* ------------------------------------------------------------------ *
 * temp git repositories — real ones, created here, removed after
 * ------------------------------------------------------------------ */

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
}

function newRepo(tag: string): string {
  const dir = mkdtempSync(join(tmpdir(), `carafe-v5-${tag}-`));
  execFileSync("git", ["init", "-q", "-b", "main", dir], { stdio: "ignore" });
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "config", "user.name", "carafe test");
  git(dir, "config", "commit.gpgsign", "false");
  writeFileSync(join(dir, "README.md"), "hello\n");
  git(dir, "add", "README.md");
  git(dir, "commit", "-q", "-m", "first commit");
  return dir;
}

/** A work repo with a fake `origin` (a bare repo beside it), one untracked
 *  file, one commit ahead, and a branch with no upstream at all. */
function repoWithOrigin(tag: string): { repo: string; origin: string; head: string; cleanup: () => void } {
  const workspace = mkdtempSync(join(tmpdir(), `carafe-v5-${tag}-`));
  const origin = join(workspace, "origin.git");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin], { stdio: "ignore" });
  const repo = join(workspace, "repo");
  execFileSync("git", ["init", "-q", "-b", "main", repo], { stdio: "ignore" });
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "carafe test");
  git(repo, "config", "commit.gpgsign", "false");
  writeFileSync(join(repo, "README.md"), "hello\n");
  git(repo, "add", "README.md");
  git(repo, "commit", "-q", "-m", "first commit");
  git(repo, "remote", "add", "origin", origin);
  git(repo, "push", "-q", "-u", "origin", "main");
  git(repo, "fetch", "-q", "origin");
  writeFileSync(join(repo, "README.md"), "hello again\n");
  git(repo, "commit", "-q", "-am", "the second commit");
  writeFileSync(join(repo, "scratch.txt"), "untracked\n");
  git(repo, "checkout", "-q", "-b", "feat/no-upstream");
  git(repo, "checkout", "-q", "main");
  const head = git(repo, "rev-parse", "--short", "HEAD");
  return { repo, origin, head, cleanup: () => { rmSync(workspace, { recursive: true, force: true }); } };
}

/* ================================================================== *
 * W1 — Right now, checked when the handoff is written
 * ================================================================== */

describe("W1 the state, checked at generation time", () => {
  test("a real repository answers with branch, HEAD, upstream, counts and unpushed branches", async () => {
    const { repo, head, cleanup } = repoWithOrigin("live");
    try {
      const state = await checkLive([repo], { now: NOW });
      const one = state.repos[0]!;
      expect(one.notChecked).toBeNull();
      expect(one.branch).toBe("main");
      expect(one.head).toEqual({ hash: head, subject: "the second commit" });
      expect(one.upstream).toBe("origin/main");
      expect(one.ahead).toBe(1);
      expect(one.behind).toBe(0);
      // round 8 — freshness is the upstream ref's own reflog (a push writes it too)
      expect(one.upstreamUpdated?.how).toBe("push");
      expect(one.modified).toBe(0);
      expect(one.untracked).toBe(1);
      expect(one.untrackedNames).toEqual(["scratch.txt"]);
      expect(one.branches.sort()).toEqual(["feat/no-upstream", "main"]);
      // main is ahead of its upstream; feat/no-upstream has none at all. v6/V3
      // orders by commit date — these two share a commit, so the name decides.
      expect(one.unpushed.map((branch) => branch.branch)).toEqual(["feat/no-upstream", "main"]);
      expect(one.unpushed.every((branch) => /^\d{4}-\d{2}-\d{2}T/.test(branch.date ?? ""))).toBe(true);

      const rendered = liveLines(state).join("\n");
      expect(rendered).toContain("## Right now (checked at 2026-02-05 12:00 UTC, when this handoff was written)");
      expect(rendered).toContain(`branch main · HEAD ${head} "the second commit" · upstream origin/main: 1 ahead, 0 behind (updated`);
      expect(rendered).toContain("0 modified, 1 untracked (scratch.txt)");
      // v6/V3 — the heading says what the list means, and names every branch
      expect(rendered).toContain("on this disk only (no remote has these commits): ");
      // v6/V2 — origin/main as LOCAL refs record it, never called deployed
      expect(one.defaultRef?.ref).toBe("origin/main");
      expect(one.defaultRef?.subject).toBe("first commit");
      expect(one.defaultRef?.ahead).toBe(1);
      expect(one.defaultRef?.behind).toBe(0);
      expect(one.headDate).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(rendered).toContain(`origin/main at ${git(repo, "rev-parse", "--short", "origin/main")} "first commit" (local ref, updated`);
      expect(rendered).toContain(`· HEAD is 1 ahead, 0 behind it`);
      expect(rendered).not.toContain("deployed");
    } finally { cleanup(); }
  });

  test("a missing directory and a non-repository are `not checked`, with the reason, never a stale value", async () => {
    const plain = mkdtempSync(join(tmpdir(), "carafe-v5-plain-"));
    try {
      const state = await checkLive(["/no/such/directory/at/all", plain], { now: NOW });
      expect(state.repos.every((repo) => repo.notChecked != null)).toBe(true);
      const rendered = liveLines(state).join("\n");
      // v6/V9 REPLACES v5's single catch-all reason: a directory that is not
      // there and a directory that is not a repository are different facts
      expect(rendered).toContain("- not checked: /no/such/directory/at/all (directory missing)");
      expect(rendered).toContain("(not a git repository, or the command failed)");
      expect(rendered).toContain(plain);
    } finally { rmSync(plain, { recursive: true, force: true }); }
  });

  test("a repository that was never fetched here says so instead of guessing an age", async () => {
    const repo = newRepo("nofetch");
    try {
      const state = await checkLive([repo], { now: NOW });
      expect(state.repos[0]!.upstreamUpdated ?? null).toBeNull();
      expect(state.repos[0]!.upstream).toBeNull();
      expect(liveLines(state).join("\n")).toContain("upstream: none");
    } finally { rmSync(repo, { recursive: true, force: true }); }
  });

  test("without --live nothing reaches the network: the fetch function is never called", async () => {
    const repo = newRepo("nonet");
    try {
      let fetched = 0;
      let lsRemotes = 0;
      const spy = (args: string[], timeout: number): string | null => {
        if (args.includes("ls-remote")) lsRemotes++;
        return realGitRunner(args, timeout);
      };
      const off = await checkLive([repo], { now: NOW, healthUrls: ["https://example.invalid/health"], git: spy, fetcher: async () => { fetched++; return { body: "{}" }; } });
      expect(fetched).toBe(0);
      expect(lsRemotes).toBe(0);
      expect(off.live).toBe(false);
      // v6/V1 REPLACES v5's per-URL `health: not checked` line: unknown is said
      // once, loudly, as the FIRST line under the heading
      const offLines = liveLines(off);
      expect(offLines[2]).toBe("- **LIVE STATE UNKNOWN** — carafe did not contact any service.");
      expect(offLines[3]).toBe("  a person can allow this once per project: carafe live allow");
      expect(offLines.join("\n")).not.toContain("health: not checked");

      const on = await checkLive([repo], { now: NOW, live: true, healthUrls: ["https://example.invalid/health"], git: spy, fetcher: async () => { fetched++; return { body: '{"status":"ok"}' }; } });
      expect(fetched).toBe(1);
      expect(lsRemotes).toBe(1);
      const onRendered = liveLines(on).join("\n");
      expect(onRendered).toContain('- health: https://example.invalid/health → {"status":"ok"}');
      // a probe that ANSWERED is a live reading: no banner
      expect(onRendered).not.toContain("LIVE STATE UNKNOWN");
    } finally { rmSync(repo, { recursive: true, force: true }); }
  });

  // v6/V1 REPLACES v5's `health: not checked: <url> (<raw message>)`
  test("a probe that fails prints unreachable, with the time and the error CLASS, never a body", async () => {
    const repo = newRepo("healthfail");
    try {
      const state = await checkLive([repo], { now: NOW, live: true, healthUrls: ["https://example.invalid/health"], fetcher: async () => ({ error: "TimeoutError: the operation timed out" }) });
      const rendered = liveLines(state).join("\n");
      expect(rendered).toContain("- health: https://example.invalid/health → unreachable at 2026-02-05 12:00 UTC (timeout)");
      expect(rendered).not.toContain("LIVE STATE UNKNOWN");
      expect(rendered).not.toContain("TimeoutError");
      expect(errorClass("getaddrinfo ENOTFOUND api.example.invalid")).toBe("dns");
      expect(errorClass("connect ECONNREFUSED 127.0.0.1:443")).toBe("connection refused");
    } finally { rmSync(repo, { recursive: true, force: true }); }
  });

  test("the command list is exactly the read-only set, and `P` is the only thing substituted", () => {
    expect(LIVE_COMMANDS).toEqual([
      "git -C P rev-parse --show-toplevel",
      "git -C P rev-parse --git-common-dir",
      "git -C P branch --show-current",
      "git -C P rev-parse --short HEAD",
      "git -C P log -1 --format=%s",
      "git -C P log -1 --format=%cI",
      "git -C P rev-parse --abbrev-ref --symbolic-full-name @{upstream}",
      "git -C P rev-list --left-right --count @{upstream}...HEAD",
      "git -C P symbolic-ref --short refs/remotes/origin/HEAD",
      "git -C P rev-parse --verify --short <default ref>",
      "git -C P log -1 --format=%s <default ref>",
      "git -C P rev-list --left-right --count <default ref>...HEAD",
      "git -C P reflog show --date=unix --format=%H%x09%gd%x09%gs refs/remotes/<default ref | upstream>",
      "git -C P status --porcelain=v1",
      "git -C P for-each-ref --format='%(refname:short) %(objectname:short) %(upstream:track) %(committerdate:iso-strict)' refs/heads",
      "git -C P branch -r --contains <hash>   (once per candidate unpushed branch)",
    ]);
    expect(LIVE_COMMANDS.every((command) => !/\b(?:push|commit|fetch|pull|checkout|reset|clean)\b/.test(command))).toBe(true);
  });

  test("relative ages read the way a person would say them", () => {
    const now = Date.parse(NOW);
    expect(relativeAge(now - 12 * 60_000, now)).toBe("12 min ago");
    expect(relativeAge(now - 2 * 3_600_000, now)).toBe("2 h ago");
    expect(relativeAge(now - 5 * 86_400_000, now)).toBe("5 d ago");
  });

  test("an unpushed branch is one with no upstream or one ahead of it", () => {
    // v6/V3 REPLACES v5's current-branch-first order: newest commit first
    expect(unpushedOf({
      branches: ["main", "feat/a", "feat/b"],
      track: { main: "", "feat/a": "[ahead 3]", "feat/b": "[behind 1]" },
      hashes: { main: "aaaa111", "feat/a": "bbbb222", "feat/b": "cccc333" },
      dates: { main: "2026-02-01", "feat/a": "2026-02-04" },
    })).toEqual({
      branches: [{ branch: "feat/a", hash: "bbbb222", date: "2026-02-04" }, { branch: "main", hash: "aaaa111", date: "2026-02-01" }],
      more: 0,
    });
  });

  // ROUND 2 · item 3, as v6/V3 rewrites it
  test("a commit already on a remote is not unpushed, and the rest are listed newest commit first", () => {
    const parsed = {
      branches: ["master", "opus/sentinel-backend", "opus/eval-bugs", "claude/a", "claude/b", "claude/c", "claude/d", "claude/e", "claude/f"],
      track: Object.fromEntries(["master", "opus/sentinel-backend", "opus/eval-bugs", "claude/a", "claude/b", "claude/c", "claude/d", "claude/e", "claude/f"].map((branch) => [branch, ""])),
      hashes: {
        master: "0000aaa", "opus/sentinel-backend": "6dbdade", "opus/eval-bugs": "df85883",
        // the six worktree branches all sit on master's own commit, which IS on
        // the remote: none of them is unpushed, however their upstream reads
        "claude/a": "0000aaa", "claude/b": "0000aaa", "claude/c": "0000aaa",
        "claude/d": "0000aaa", "claude/e": "0000aaa", "claude/f": "0000aaa",
      },
      dates: {
        master: "2026-01-01", "opus/sentinel-backend": "2026-09-10", "opus/eval-bugs": "2026-09-14",
        "claude/a": "2026-01-02", "claude/b": "2026-01-02", "claude/c": "2026-01-02",
        "claude/d": "2026-01-02", "claude/e": "2026-01-02", "claude/f": "2026-01-02",
      },
    };
    const onARemote = (_branch: string, hash: string): boolean => hash === "0000aaa";
    const result = unpushedOf(parsed, { onARemote });
    // newest commit first — the branch a reviewer accepted a fix on is not
    // ranked below the branch someone happens to be standing in
    expect(result.branches.map((one) => one.branch)).toEqual(["opus/eval-bugs", "opus/sentinel-backend"]);
    expect(result.more).toBe(0);

    // …and with nothing filtered, all nine fit under the fifteen-branch cap:
    // v6/V3 forbids a `+N more` that hides fewer than fifteen named branches
    const all = unpushedOf(parsed);
    expect(all.branches[0]!.branch).toBe("opus/eval-bugs");
    expect(all.branches.length).toBe(9);
    expect(all.more).toBe(0);
  });

  // ROUND 2 · deviation 1
  test("a linked worktree finds FETCH_HEAD through the common git dir", async () => {
    const { repo, cleanup } = repoWithOrigin("worktree");
    const tree = mkdtempSync(join(tmpdir(), "carafe-v5-linked-"));
    rmSync(tree, { recursive: true, force: true });
    try {
      git(repo, "worktree", "add", "-q", "-b", "wt/one", tree);
      const state = await checkLive([tree], { now: NOW });
      const one = state.repos[0]!;
      expect(one.notChecked).toBeNull();
      expect(one.branch).toBe("wt/one");
      // the worktree's own `.git` is a FILE; the remote-tracking reflog lives with the main checkout
      expect(one.defaultRef?.updated?.how).toBe("push");
    } finally {
      try { git(repo, "worktree", "remove", "--force", tree); } catch { /* best effort */ }
      rmSync(tree, { recursive: true, force: true });
      cleanup();
    }
  });

  // ROUND 2 · item 4
  test("health URLs are normalized, de-duplicated, localhost dropped, newest first, capped at three", () => {
    seq = 0;
    const events = [
      user("check them all"),
      ...call("curl -s http://localhost:4001/health;", '{"status":"ok"}', "2026-02-05T09:00:00Z"),
      ...call("curl -s https://api-edge.example.invalid/health)", '{"status":"ok","commit":"aaa1111"}', "2026-02-05T09:01:00Z"),
      ...call('curl -s "https://api-edge.example.invalid/health"', '{"status":"ok","commit":"bbb2222"}', "2026-02-05T09:02:00Z"),
      ...call("curl -s https://one.example.invalid/health", "ok", "2026-02-05T09:03:00Z"),
      ...call("curl -s https://two.example.invalid/health", "ok", "2026-02-05T09:04:00Z"),
      ...call("curl -s https://three.example.invalid/health", "ok", "2026-02-05T09:05:00Z"),
    ];
    expect(normalizeHealthUrl('"https://x.invalid/health");')).toBe("https://x.invalid/health");
    const urls = healthUrlsFromTrace(events, extractPieces(events, {}, {}));
    expect(urls).toEqual(["https://three.example.invalid/health", "https://two.example.invalid/health", "https://one.example.invalid/health"]);
    expect(urls.some((url) => url.includes("localhost"))).toBe(false);
  });
});

/* ================================================================== *
 * W2 — the outgoing agent's answers, verified
 * ================================================================== */

describe("W2 the outgoing agent's answers, verified", () => {
  test("a realistic old checkout, other branches and linked worktree produce exactly two observed contradictions", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "carafe-answers-real-"));
    const repo = join(workspace, "main-repo");
    const origin = join(workspace, "origin.git");
    const linked = join(workspace, "linked-worktree");
    const namedRepo = join(workspace, "named-repo");
    try {
      execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin], { stdio: "ignore" });
      execFileSync("git", ["init", "-q", "-b", "main", repo], { stdio: "ignore" });
      for (const dir of [repo]) {
        git(dir, "config", "user.email", "test@example.com");
        git(dir, "config", "user.name", "carafe test");
        git(dir, "config", "commit.gpgsign", "false");
      }
      writeFileSync(join(repo, "history.txt"), "base\n");
      git(repo, "add", "history.txt");
      git(repo, "commit", "-q", "-m", "base");
      git(repo, "branch", "older-checkout");
      git(repo, "remote", "add", "origin", origin);
      for (let index = 1; index <= 8; index++) {
        writeFileSync(join(repo, "history.txt"), `${index}\n`);
        git(repo, "commit", "-q", "-am", `main ${index}`);
      }
      git(repo, "push", "-q", "-u", "origin", "main");
      const originMain = git(repo, "rev-parse", "origin/main");

      git(repo, "checkout", "-q", "-b", "feature/second");
      writeFileSync(join(repo, "second.txt"), "second\n");
      git(repo, "add", "second.txt");
      git(repo, "commit", "-q", "-m", "second branch");
      const wrongHead = git(repo, "rev-parse", "HEAD");
      git(repo, "checkout", "-q", "main");
      git(repo, "worktree", "add", "-q", "-b", "worktree/third", linked);
      git(linked, "config", "user.email", "test@example.com");
      git(linked, "config", "user.name", "carafe test");
      writeFileSync(join(linked, "worktree.txt"), "linked\n");
      git(linked, "add", "worktree.txt");
      git(linked, "commit", "-q", "-m", "linked worktree commit");
      const worktreeHash = git(linked, "rev-parse", "HEAD");

      git(repo, "checkout", "-q", "-b", "local/only");
      writeFileSync(join(repo, "local.txt"), "local\n");
      git(repo, "add", "local.txt");
      git(repo, "commit", "-q", "-m", "local only");
      git(repo, "checkout", "-q", "older-checkout");

      execFileSync("git", ["init", "-q", "-b", "named/branch", namedRepo], { stdio: "ignore" });
      git(namedRepo, "config", "user.email", "test@example.com");
      git(namedRepo, "config", "user.name", "carafe test");
      writeFileSync(join(namedRepo, "README.md"), "named\n");
      git(namedRepo, "add", "README.md");
      git(namedRepo, "commit", "-q", "-m", "named repo");

      const live = await checkLive([repo], { now: NOW });
      const answerPath = join(workspace, "answers.md");
      const baseHead = git(repo, "rev-parse", "HEAD");
      writeFileSync(answerPath, [
        "tool: codex", "", "## Q2",
        `\`${originMain}\` is the head of \`origin/main\`.`,
        `The linked worktree contains \`${worktreeHash}\` for later review.`,
        "`local/only` is local only.",
        "POST `/api/v2/jobs/abc123/cancel` takes no token.",
        `The report is at ${workspace}/handoffs/123e4567-e89b-12d3-a456-426614174000.md for review.`,
        "With `JOBS_V2_ENABLED=0` as the master kill switch, and it is live.",
        "Neither checkout is on `main`, so neither contains the code that is live.",
        "- The notes.md and brief.txt files were reviewed together. The harness stayed under one command.",
        `**Result.** The service returned {"status":"ok","commit":"${originMain}"} at 21:03 before shutdown.`,
        `\`${namedRepo}\` is on \`named/branch\`.`,
        `\`${wrongHead}\` is the head of \`origin/main\`.`,
        "`local/only` is pushed to origin.",
        `HEAD is ${baseHead}.`,
        "The team felt good about the direction.", "",
      ].join("\n"));
      const answers = readAnswerFile(answerPath)!;
      const facts = { live };
      const rendered = answersLines([answers], facts).join("\n");
      const stamps = rendered.split("\n").filter((line) => /^ {4}[✓✗?·]/.test(line));
      const quoted = rendered.split("\n").filter((line) => line.startsWith("> "));

      // PR #38's protections, on the per-claim contract:
      // ✗ ONLY for an observed opposite, and every one carries its command and value
      const contradicted = stamps.filter((line) => line.trimStart().startsWith("✗"));
      expect(contradicted).toHaveLength(2);
      for (const line of contradicted) {
        expect(line).toContain(" — checked: git -C ");
        expect(line).toContain(" → ");
      }
      // …the two planted falsehoods, and nothing else
      expect(contradicted.join(" | ")).toContain(wrongHead.slice(0, 7));
      expect(contradicted.join(" | ")).toContain("local/only");
      // the true ones are checked, not merely noted
      expect(stamps.some((line) => line.includes("✓") && line.includes(originMain.slice(0, 7)))).toBe(true);
      expect(stamps.some((line) => line.includes("✓") && line.includes("local/only local only"))).toBe(true);
      expect(stamps.some((line) => line.includes("✓") && line.includes("named/branch"))).toBe(true);
      expect(stamps.some((line) => line.includes("✓") && line.includes(`HEAD is ${baseHead}`))).toBe(true);

      // absence of evidence is no verdict: a hash that merely exists is a note
      expect(stamps.some((line) => line.trimStart().startsWith("·") && line.includes(worktreeHash.slice(0, 7)))).toBe(true);

      // a URL route is never a path, a UUID is never a commit, a bare English
      // word is never a ref, and a negated clause is not the claim
      for (const line of stamps) {
        expect(line).not.toContain("/api/v2/jobs");
        expect(line).not.toContain("123e4567");
        expect(line).not.toMatch(/\bmaster\b/);
        expect(line).not.toContain("Neither checkout");
      }
      // prose earns nothing at all
      expect(stamps.some((line) => line.includes("felt good"))).toBe(false);

      // one splitter, and it does not cut file names, versions or JSON
      expect(quoted.some((line) => line.includes("notes.md and brief.txt") && line.includes("The harness stayed under one command."))).toBe(true);
      expect(quoted.some((line) => line.includes(`{"status":"ok","commit":"${originMain}"}`))).toBe(true);

      // the reader is told what ? means
      expect(rendered).toContain("✓ held when written and still holds");
    } finally { rmSync(workspace, { recursive: true, force: true }); }
  });

  test("two tools both answer; both blocks render, with counts and a disagreements list", async () => {
    const { repo, cleanup } = repoWithOrigin("two-tools");
    try {
      const live = await checkLive([repo], { now: NOW });
      const honest = parseAnswers(`tool: claude-code\n\n## Q3\n\`feat/no-upstream\` is local only.\n`, "/tmp/a.md", NOW)!;
      const wrong = parseAnswers(`tool: codex\n\n## Q3\n\`feat/no-upstream\` is pushed to origin.\n`, "/tmp/b.md", NOW)!;
      const rendered = answersLines([honest, wrong], { live }).join("\n");
      // LAUNCH BAR L2/B4: coverage is a number, and each tool's block is dated.
      expect(rendered).toContain("## What the outgoing agent said (");
      expect(rendered).toContain("2 of 2 checkable claims checked · 1 of 2 false when written · 0 unchecked");
      expect(rendered).toContain("claude-code, written 2026-02-05 12:00 UTC");
      expect(rendered).toContain("codex, written");
      expect(rendered).toContain(`### Q3. ${HANDOFF_QUESTIONS[2]}`);
      expect(rendered).toContain("✓ held when written and still holds");
      expect(rendered).toContain("Disagreements:");
      expect(rendered).toContain("codex:");
    } finally { cleanup(); }
  });

  test("--questions prints the seven questions and the exact path", () => {
    const text = questionsText("/tmp/carafe-home", sessionId);
    expect(text).toContain(`/tmp/carafe-home/handoffs/${sessionId}.answers.md`);
    for (const question of HANDOFF_QUESTIONS) expect(text).toContain(question);
  });

  test("both skill templates tell the agent the questions and where they go", () => {
    for (const template of [CLAUDE_SKILL, CODEX_PROMPT]) {
      expect(template).toContain("--questions");
      expect(template).toContain("answers.md");
      expect(template).toContain("what is live right now (deployed, running, enforced), and how do you know?");
      // …and every sentence the templates already had is still there
      expect(template).toContain("Nothing leaves the machine.");
      expect(template).toContain("carafe handoff current");
      expect(template).toContain("Agents must not pass --live and cannot grant permission");
      expect(template.match(/Agents must not pass --live/g)).toHaveLength(1);
    }
  });
});

/* ================================================================== *
 * W3 — coverage of the last 72 hours
 * ================================================================== */

describe("W3 coverage of the last 72 hours", () => {
  // ROUND 2 · item 1 — the shape of the session that got this wrong
  test("the principal set comes from the SAME counts the header prints, helpers included", () => {
    seq = 0;
    const stub = mkdtempSync(join(tmpdir(), "carafe-v5-stub-"));
    const backend = mkdtempSync(join(tmpdir(), "carafe-v5-backend-"));
    const frontend = mkdtempSync(join(tmpdir(), "carafe-v5-frontend-"));
    const foreign = mkdtempSync(join(tmpdir(), "carafe-v5-foreign-"));
    const agentState = join(stub, ".carafe");
    const dirs = [stub, backend, frontend, foreign, agentState];
    try {
      for (const dir of dirs) mkdirSync(join(dir, ".git"), { recursive: true });
      const calls = (dir: string, count: number, ts: string): CarafeEvent[] =>
        Array.from({ length: count }, () => call(`git -C "${dir}" log -1 --format=%s`, "a subject", ts)).flat();
      // the helper did most of the backend work, as helpers do
      const helperEvents: CarafeEvent[] = [];
      let helperSeq = 0;
      for (let index = 0; index < 1_000; index++) {
        helperEvents.push(
          { ts: "2026-02-05T10:20:00Z", tool: "codex", sessionId: "agent-ad-helper", seq: ++helperSeq, kind: "tool_use", raw: { payload: { name: "Bash", arguments: { command: `git -C "${backend}" log -1 --format=%s` } } } },
          { ts: "2026-02-05T10:20:00Z", tool: "codex", sessionId: "agent-ad-helper", seq: ++helperSeq, kind: "tool_result", raw: { payload: { output: "a subject" } } },
        );
      }
      const events = [
        user("go", "2026-02-01T09:00:00Z"),
        ...calls(stub, 142, "2026-02-01T09:01:00Z"),
        ...calls(agentState, 80, "2026-02-01T09:02:00Z"),
        ...calls(foreign, 60, "2026-02-01T09:03:00Z"),
        ...calls(frontend, 343, "2026-02-02T09:00:00Z"),
        ...calls(backend, 1_114, "2026-02-03T09:00:00Z"),
        ...filler(),
        ...Array.from({ length: 12 }, (_, index) =>
          [user(`work ${index}`, "2026-02-05T10:00:00Z"), assistant(`On it ${index}.`, "2026-02-05T10:00:00Z"),
           ...edit(join(backend, `src/file-${index}.ts`), "2026-02-05T10:00:00Z")]).flat(),
      ];
      const d = distillate(events, { cwd: stub, startTs: "2026-02-01T09:00:00Z", endTs: "2026-02-05T11:00:00Z" });
      const pieces = preparedPieces(events, sessionId);
      const helpers = [{ sessionId: "agent-ad-helper", events: helperEvents }];
      const counts = repoCounts(d, events, pieces, helpers);

      // the header's own numbers: the helper's 1,000 calls belong to the backend
      expect(counts.find((repo) => repo.path === backend)!.calls).toBe(2_126);
      expect(counts.find((repo) => repo.path === frontend)!.calls).toBe(343);
      expect(counts.find((repo) => repo.path === stub)!.calls).toBe(142);
      expect(counts.some((repo) => repo.path === agentState)).toBe(false);   // agent state is never a repository

      // …and the principal set is computed from exactly those numbers
      expect(principalWorkspaces(counts)).toEqual([backend, frontend]);

      const text = renderHandoff(d, events, { now: NOW, target: "codex", helperTraces: helpers }).text;
      const heading = /^## The tail, verbatim \([^\n]*\)$/m.exec(text)![0];
      expect(heading).toContain(basename(backend));
      expect(heading).not.toContain(".carafe");
      expect(heading).not.toContain(basename(foreign));
      expect(heading).toContain("the last 3 turns"); // round 9: the last working day, at most three turns
    } finally { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); }
  });

  test("a stub cwd full of path-less calls is not a principal workspace; two real repos are", () => {
    seq = 0;
    const stub = mkdtempSync(join(tmpdir(), "carafe-v5-stub-"));
    const a = mkdtempSync(join(tmpdir(), "carafe-v5-a-"));
    const b = mkdtempSync(join(tmpdir(), "carafe-v5-b-"));
    try {
      for (const dir of [stub, a, b]) mkdirSync(join(dir, ".git"), { recursive: true });
      const events = [
        user("go"),
        // 3,000 calls that name no directory at all: they land nowhere
        ...Array.from({ length: 1_500 }, () => call("ls -la", "a\nb")).flat(),
        ...Array.from({ length: 200 }, (_, index) => call(`git -C "${a}" log -1 --format=%s`, `subject ${index}`)).flat(),
        ...Array.from({ length: 200 }, (_, index) => call(`git -C "${b}" log -1 --format=%s`, `subject ${index}`)).flat(),
      ];
      const pieces = extractPieces(events, {}, {});
      const { reposWorkedIn } = require("./render") as typeof import("./render");
      const repos = reposWorkedIn(events, pieces, stub);
      expect(repos.map((repo) => repo.path).sort()).toEqual([a, b].sort());
      expect(principalWorkspaces(repos).sort()).toEqual([a, b].sort());
      expect(principalWorkspaces(repos)).not.toContain(stub);
    } finally { for (const dir of [stub, a, b]) rmSync(dir, { recursive: true, force: true }); }
  });

  test("the newest chapter gets at least half the moment budget, and no wip line displaces a decision", () => {
    seq = 0;
    const repo = mkdtempSync(join(tmpdir(), "carafe-v5-budget-"));
    try {
      mkdirSync(join(repo, ".git"), { recursive: true });
      const events: CarafeEvent[] = [user("start the work", "2026-01-01T09:00:00Z")];
      // ten early chapters, days apart, five moments each
      for (let chapter = 0; chapter < 10; chapter++) {
        const day = `2026-01-${String(chapter + 2).padStart(2, "0")}`;
        events.push(user(`chapter ${chapter}: carry on`, `${day}T09:00:00Z`));
        for (let index = 0; index < 5; index++) {
          events.push(assistant(`Decided: we use approach ${chapter}-${index} for the exporter.`, `${day}T09:1${index}:00Z`));
          events.push(...edit(join(repo, `src/early-${chapter}-${index}.ts`), `${day}T09:1${index}:30Z`));
        }
      }
      // the last chapter: 20 decisions and 30 wip lines, inside the 72 hours
      events.push(user("now the real work", "2026-02-04T09:00:00Z"));
      for (let index = 0; index < 20; index++) {
        events.push(user(`do ${index}`, "2026-02-04T10:00:00Z"));
        events.push(assistant(`Decided: the lockdown ships behind flag ${index}.`, "2026-02-04T10:01:00Z"));
      }
      for (let index = 0; index < 30; index++) events.push(...edit(join(repo, `src/late-${index}.ts`), "2026-02-04T11:00:00Z"));
      events.push(...filler());

      const text = renderHandoff(distillate(events, { cwd: repo, startTs: "2026-01-01T09:00:00Z", endTs: "2026-02-05T11:00:00Z" }), events, { now: NOW, target: "codex" }).text;
      const moments = text.slice(text.indexOf("## Key moments"), text.indexOf("## Directory of the session"));
      // the decisive 48 hours are represented…
      expect(moments).toContain("do 19");
      expect(moments).toContain("now the real work");
      // …and not by shell lines: a chapter with three other moments renders none
      expect(moments).not.toMatch(/^- wip: /m);
    } finally { rmSync(repo, { recursive: true, force: true }); }
  });

  test("a helper agent's turns appear in the tail, labelled with the agent and its own seqs", () => {
    seq = 0;
    const repo = mkdtempSync(join(tmpdir(), "carafe-v5-helper-"));
    try {
      mkdirSync(join(repo, ".git"), { recursive: true });
      const events = [
        user("build the exporter", "2026-02-01T10:00:00Z"),
        ...filler(),
        ...Array.from({ length: 13 }, (_, index) =>
          [user(`principal ${index}`, "2026-02-05T10:00:00Z"), assistant(`On it ${index}.`, "2026-02-05T10:00:00Z"), ...edit(join(repo, `src/file-${index}.ts`), "2026-02-05T10:00:00Z")]).flat(),
      ];
      const helperEvents: CarafeEvent[] = [
        { ts: "2026-02-05T10:30:00Z", tool: "codex", sessionId: "a4b5c6d7-helper", seq: 1, kind: "user", raw: { payload: { message: "close the hole" } } },
        { ts: "2026-02-05T10:31:00Z", tool: "codex", sessionId: "a4b5c6d7-helper", seq: 2, kind: "tool_use", raw: { payload: { name: "Edit", arguments: { file_path: join(repo, "src/lockdown.ts") } } } },
        { ts: "2026-02-05T10:31:30Z", tool: "codex", sessionId: "a4b5c6d7-helper", seq: 3, kind: "tool_result", raw: { payload: { output: "ok" } } },
      ];
      const text = renderHandoff(distillate(events, { cwd: repo }), events, {
        now: NOW, target: "codex", helperTraces: [{ sessionId: "a4b5c6d7-helper", events: helperEvents }],
      }).text;
      const tail = text.slice(text.indexOf("## The tail, verbatim"));
      expect(tail).toContain("↳ helper agent-a4b5c6d7 — its last 1 turn (seq 1–3 of its own trace)");
      // its OWN turns, verbatim — not a summary line
      expect(tail).toContain("**user:** close the hole");
      expect(tail).toContain("lockdown.ts");
      expect(tail).toContain("carafe show a4b5c6d7-helper --seq 1-3");
    } finally { rmSync(repo, { recursive: true, force: true }); }
  });

  // ROUND 2 · item 2
  test("a helper whose id already starts with `agent-` is never labelled agent-agent-", () => {
    expect(agentLabel("agent-ad12cd34")).toBe("ad12cd34");
    expect(agentLabel("1a2b3c4d5e6f")).toBe("1a2b3c4d");
    seq = 0;
    const repo = mkdtempSync(join(tmpdir(), "carafe-v5-label-"));
    try {
      mkdirSync(join(repo, ".git"), { recursive: true });
      const events = [
        user("build it", "2026-02-01T10:00:00Z"),
        ...filler(),
        ...Array.from({ length: 13 }, (_, index) =>
          [user(`principal ${index}`, "2026-02-05T10:00:00Z"), assistant(`On it ${index}.`, "2026-02-05T10:00:00Z"), ...edit(join(repo, `src/file-${index}.ts`), "2026-02-05T10:00:00Z")]).flat(),
      ];
      const helperEvents: CarafeEvent[] = [
        { ts: "2026-02-05T10:30:00Z", tool: "codex", sessionId: "agent-ad99", seq: 1, kind: "user", raw: { payload: { message: "close the hole" } } },
        { ts: "2026-02-05T10:31:00Z", tool: "codex", sessionId: "agent-ad99", seq: 2, kind: "tool_use", raw: { payload: { name: "Bash", arguments: { command: `git -C "${repo}" status --porcelain` } } } },
        { ts: "2026-02-05T10:31:30Z", tool: "codex", sessionId: "agent-ad99", seq: 3, kind: "tool_result", raw: { payload: { output: " M a.ts" } } },
      ];
      const text = renderHandoff(distillate(events, { cwd: repo }), events, {
        now: NOW, target: "codex", helperTraces: [{ sessionId: "agent-ad99", events: helperEvents }],
      }).text;
      expect(text).not.toContain("agent-agent-");
      expect(text).toContain("↳ helper agent-ad99");
      expect(text).toContain("via helper agent-ad99");
    } finally { rmSync(repo, { recursive: true, force: true }); }
  });

  // ROUND 2 · item 5
  test("a falling uncommitted count is never an alarm, and a rise seen three weeks ago is not either", () => {
    seq = 0;
    const repo = mkdtempSync(join(tmpdir(), "carafe-v5-halfdone-"));
    try {
      mkdirSync(join(repo, ".git"), { recursive: true });
      const build = (counts: Array<[number, string]>): CarafeEvent[] => {
        seq = 0;
        return [
          user("go"),
          ...call(`git -C "${repo}" branch --show-current`, "opus/lockdown", "2026-01-10T09:00:00Z"),
          ...counts.flatMap(([files, ts]) => call(`git -C "${repo}" status --porcelain`, Array.from({ length: files }, (_, index) => ` M f-${index}.ts`).join("\n"), ts)),
          ...filler(),
        ];
      };
      const halfDone = (events: CarafeEvent[]): string => {
        const d = distillate(events, { cwd: repo, startTs: "2026-01-10T09:00:00Z", endTs: "2026-02-05T11:00:00Z" });
        return halfDoneLines(d, rightNowData(d, events, preparedPieces(events, sessionId))).join("\n");
      };
      // 37 → 13 is work being SAVED
      expect(halfDone(build([[37, "2026-01-10T09:00:00Z"], [13, "2026-02-04T09:00:00Z"]]))).toBe("");
      // a rise, but three weeks before the end: it says nothing about today
      expect(halfDone(build([[2, "2026-01-10T09:00:00Z"], [13, "2026-01-12T09:00:00Z"]]))).toBe("");
      // a rise inside the last 72 hours is the finding
      expect(halfDone(build([[2, "2026-01-10T09:00:00Z"], [13, "2026-02-04T09:00:00Z"]]))).toContain("uncommitted went 2 → 13");
    } finally { rmSync(repo, { recursive: true, force: true }); }
  });

  test("a tail whose principal work ended a day early says so in its own heading", () => {
    seq = 0;
    const main = mkdtempSync(join(tmpdir(), "carafe-v5-early-main-"));
    const other = mkdtempSync(join(tmpdir(), "carafe-v5-early-other-"));
    const third = mkdtempSync(join(tmpdir(), "carafe-v5-early-third-"));
    try {
      for (const dir of [main, other, third]) mkdirSync(join(dir, ".git"), { recursive: true });
      const events = [
        user("build the exporter", "2026-02-01T10:00:00Z"),
        ...Array.from({ length: 8 }, (_, index) => edit(join(third, `src/s-${index}.ts`), "2026-02-01T10:05:00Z")).flat(),
        ...filler(),
        ...Array.from({ length: 14 }, (_, index) =>
          [user(`principal ${index}`, "2026-02-02T10:00:00Z"), assistant(`On it ${index}.`, "2026-02-02T10:00:00Z"), ...edit(join(main, `src/file-${index}.ts`), "2026-02-02T10:00:00Z")]).flat(),
        ...Array.from({ length: 4 }, (_, index) =>
          [user(`detour ${index}`, "2026-02-05T10:00:00Z"), ...edit(join(other, `site/page-${index}.ts`), "2026-02-05T10:00:00Z")]).flat(),
        assistant("Left alone.", "2026-02-05T10:30:00Z"),
      ];
      const text = renderHandoff(distillate(events, { cwd: main, startTs: "2026-02-01T10:00:00Z", endTs: "2026-02-05T11:00:00Z" }), events, { now: NOW, target: "codex" }).text;
      const heading = /^## The tail, verbatim \([^\n]*\)$/m.exec(text)![0];
      expect(heading).toContain("the last principal work ended 2026-02-02");
      expect(heading).toMatch(/\d+ later turns were tangents/);
    } finally { for (const dir of [main, other, third]) rmSync(dir, { recursive: true, force: true }); }
  });
});

/* ================================================================== *
 * W4 — time passes
 * ================================================================== */

describe("W4 time passes", () => {
  const tsBySeq = new Map<number, string | null>([[10, "2026-02-01T09:12:00Z"], [20, "2026-02-05T10:00:00Z"], [30, null]]);
  const endTs = "2026-02-05T11:00:00Z";

  test("every quoted line carries its date and how long before the end it was said", () => {
    expect(anchor(10, tsBySeq, endTs)).toBe("[seq 10, 2026-02-01 09:12 UTC, 4 d before the end]");
    expect(anchor(20, tsBySeq, endTs)).toBe("[seq 20, 2026-02-05 10:00 UTC, 1 h before the end]");
    // a timestamp carafe does not have is never invented
    expect(anchor(30, tsBySeq, endTs)).toBe("[seq 30]");
  });

  test("a time-bound sentence older than 48 hours may have lapsed; a fresh one does not", () => {
    expect(lapseSuffix("The arrangement runs until 2 pm today.", 10, tsBySeq, endTs)).toBe(" (said 2026-02-01; may have lapsed)");
    expect(lapseSuffix("The arrangement runs until 2 pm today.", 20, tsBySeq, endTs)).toBe("");
    expect(lapseSuffix("Never push without asking me.", 10, tsBySeq, endTs)).toBe("");
  });

  test("an open ask carries the turn it hangs off; a pronoun ask with no antecedent is dropped", () => {
    seq = 0;
    const withAntecedent = [
      user("the two eval bugs are both about ordering", "2026-02-05T10:00:00Z"),
      assistant("Both fixes are ready on the branch. Do you want me to spec them as one piece of work, or ship them separately?", "2026-02-05T10:01:00Z"),
      user("hold on", "2026-02-05T10:02:00Z"),
    ];
    const pieces = extractPieces(withAntecedent, {}, {});
    const asks = detectOpenAsks(withAntecedent, pieces, undefined, { endTs });
    expect(asks.length).toBe(1);
    expect(asks[0]!.antecedent!.text).toBe("the two eval bugs are both about ordering");
    const rendered = waitingLines(asks, tsIndex(withAntecedent), endTs).join("\n");
    expect(rendered).toContain(`after you said: "the two eval bugs are both about ordering"`);

    // ROUND 3 · item 8 — the antecedent is the END of the turn
    seq = 0;
    const long = `${"Here is a very long paste of context that the owner dropped in. ".repeat(14)}The two eval bugs are both about ordering.`;
    const withLongLead = [
      user(long, "2026-02-05T10:00:00Z"),
      assistant("Both fixes are ready. Do you want me to spec them as one piece of work, or ship them separately?", "2026-02-05T10:01:00Z"),
    ];
    expect(long.length).toBeGreaterThan(900);
    const fromLong = detectOpenAsks(withLongLead, extractPieces(withLongLead, {}, {}), undefined, { endTs })[0]!;
    expect(fromLong.antecedent!.text.length).toBeLessThanOrEqual(301);
    expect(fromLong.antecedent!.text.endsWith("The two eval bugs are both about ordering.")).toBe(true);
    expect(fromLong.antecedent!.text.startsWith("Here is a very long paste")).toBe(false);

    // the quote is cut from the text as written: a real one printed
    // "github. com", "Apache-2." for "Apache-2.0." and "**Final yes? ** Once"
    seq = 0;
    const said = "Backend PR [#523](https://github.com/acme/api/pull/523) is merged. It ships under Apache-2.0. **Final yes to publish?** Once pushed it's public.\n\nOr keep it private?";
    const cut = [user("where are we", "2026-02-05T10:00:00Z"), assistant(`It is ready. ${said.split("\n\n")[0]!} Do you want it public now?`, "2026-02-05T10:01:00Z")];
    const quote = detectOpenAsks(cut, extractPieces(cut, {}, {}), undefined, { endTs })[0]!.text;
    expect(`It is ready. ${said.split("\n\n")[0]!} Do you want it public now?`).toContain(quote);
    expect(quote).toBe("**Final yes to publish?** Once pushed it's public. Do you want it public now?");
    seq = 0;
    const url = [assistant("Backend PR [#523](https://github.com/acme/api/pull/523) ships under Apache-2.0. Do you authorize the merge?", "2026-02-05T10:01:00Z")];
    expect(detectOpenAsks(url, extractPieces(url, {}, {}), undefined, { endTs })[0]!.text).toBe("Backend PR [#523](https://github.com/acme/api/pull/523) ships under Apache-2.0. Do you authorize the merge?");

    seq = 0;
    const orphan = [
      assistant("Them as one piece of work, or separately?", "2026-02-05T10:01:00Z"),
    ];
    expect(detectOpenAsks(orphan, extractPieces(orphan, {}, {}), undefined, { endTs }).length).toBe(0);
  });
});

/* ================================================================== *
 * W5 — orientation blocks
 * ================================================================== */

describe("W5 orientation blocks", () => {
  // ROUND 2 · item 6
  test("a term is in the glossary only when a sentence puts it in SUBJECT position", () => {
    seq = 0;
    const events: CarafeEvent[] = [];
    for (let index = 0; index < 9; index++) {
      events.push(user(`what about the row and the widget, running full and quiet for item ${index}?`));
      events.push(assistant(`Looking at the row and the widget for item ${index}, running quiet.`));
    }
    events.push(assistant("A row is an entry in the release changelog that records one deployed change."));
    // a sentence that merely CONTAINS the word is not a definition
    events.push(assistant("We kept the widget out of the build because nothing good comes of it."));
    const rendered = glossaryLines(extractPieces(events, {}, {})).join("\n");
    expect(rendered).toContain("A row is an entry in the release changelog");
    expect(rendered).not.toContain("- widget");
    // and none of the junk the first version printed
    for (const junk of ["running", "hold", "quiet", "nothing", "real", "full", "word"]) {
      expect(rendered).not.toContain(`- ${junk} (`);
    }
  });

  test("a proper noun and a backticked token are terms even below the word threshold", () => {
    seq = 0;
    const events = [
      user("get Rook to review it"),
      assistant("We asked Rook for a review. Rook is the reviewer agent that signs off every row."),
      assistant("The `input-gate` is the last check a request passes before a worker sees it."),
    ];
    const rendered = glossaryLines(extractPieces(events, {}, {})).join("\n");
    expect(rendered).toContain("Rook is the reviewer agent");
    expect(rendered).toContain("input-gate");
  });

  // ROUND 3 · item 3
  test("a state of the world is not a definition: the predicate must name a thing", () => {
    expect(isDefinitionSentence("beat", "The beat is stopped.")).toBe(false);
    expect(isDefinitionSentence("Codex", "Codex is worse")).toBe(false);
    expect(isDefinitionSentence("Prod", "Prod is genuinely degraded this minute")).toBe(false);
    expect(isDefinitionSentence("beat", "The beat is the 30-minute check-in loop.")).toBe(true);
    expect(isDefinitionSentence("beat", "The beat is just a cron entry that pings the API.")).toBe(true);
    expect(isDefinitionSentence("row", "A row is not a commit, it is an entry in the changelog.")).toBe(true);

    seq = 0;
    const events: CarafeEvent[] = [];
    for (let index = 0; index < 9; index++) {
      events.push(user(`is the beat running for item ${index}?`), assistant(`Checking the beat for item ${index}.`));
    }
    events.push(assistant("The beat is stopped."));
    expect(glossaryLines(extractPieces(events, {}, {})).join("\n")).not.toContain("- beat");
    events.push(assistant("The beat is the 30-minute check-in loop that posts to the ledger."));
    expect(glossaryLines(extractPieces(events, {}, {})).join("\n")).toContain("The beat is the 30-minute check-in loop");
  });

  // ROUND 3 · item 4
  test("a lesson needs a STRONG causal cue; narration does not qualify", () => {
    expect(hasCausalCue("If the probe delivers products, the gate is satisfied.")).toBe(false);
    expect(hasCausalCue("Results land in grade-v10 and the summary is written at the end.")).toBe(false);
    expect(hasCausalCue("I ran it instead and it never finished.")).toBe(false);
    expect(hasCausalCue("That one's on my review — I probed with a category query but never a bare gift query.")).toBe(true);
    expect(hasCausalCue("The problem was that Render applies env on deploy.")).toBe(true);
    expect(hasCausalCue("It turned out the widget was a fake.")).toBe(true);
    expect(hasCausalCue("A green log is not evidence that the request reached the API.")).toBe(true);
  });

  // ROUND 2 · item 7
  test("a relative path is resolved against the Right now repos and merged with its absolute twin", () => {
    seq = 0;
    const repo = mkdtempSync(join(tmpdir(), "carafe-v5-map-"));
    try {
      mkdirSync(join(repo, "src/lib/llm"), { recursive: true });
      mkdirSync(join(repo, ".git"), { recursive: true });
      writeFileSync(join(repo, "src/lib/llm/runtime.ts"), "export const x = 1;\n");
      expect(resolveInRepos("src/lib/llm/runtime.ts", [{ path: repo, calls: 10 }])!.repo).toBe(repo);
      expect(resolveInRepos("src/never/written.ts", [{ path: repo, calls: 10 }])).toBeNull();

      const events = [
        user("work on the runtime"),
        // the definition must be in subject position: this one is not
        assistant("The build order is strict: src/lib/llm/runtime.ts is not allowed to grow."),
        assistant("src/lib/llm/runtime.ts is the model runtime: every call to a provider goes through it."),
        ...Array.from({ length: 3 }, () => edit(join(repo, "src/lib/llm/runtime.ts"))).flat(),
        ...Array.from({ length: 2 }, () => edit("src/lib/llm/runtime.ts")).flat(),
        ...Array.from({ length: 4 }, () => edit("src/never/written.ts")).flat(),
      ];
      const lines = fileMapLines(events, extractPieces(events, {}, {}), [{ path: repo, calls: 100 }]).join("\n");
      expect(lines).toContain(`- ${repo}`);
      // 3 absolute + 2 relative, one entry
      expect(lines).toContain("  - src/lib/llm/runtime.ts (5)");
      expect(lines).toContain("is the model runtime");
      expect(lines).not.toContain("is not allowed to grow");
      expect(lines).not.toContain("(repository not recorded)");
      expect(lines).not.toContain("never/written.ts");
    } finally { rmSync(repo, { recursive: true, force: true }); }
  });

  test("an absolute path under no known repository renders under `elsewhere`", () => {
    seq = 0;
    const events = [user("look"), ...Array.from({ length: 2 }, () => edit("/somewhere/else/tool.ts")).flat()];
    expect(fileMapLines(events, extractPieces(events, {}, {}), []).join("\n")).toContain("- elsewhere");
  });

  // ROUND 2 · item 8
  test("a lesson is the sentence that says WHY, never the command", () => {
    seq = 0;
    const repo = mkdtempSync(join(tmpdir(), "carafe-v5-lesson-"));
    try {
      mkdirSync(join(repo, ".git"), { recursive: true });
      const events = [
        user("undo that", "2026-02-04T10:00:00Z"),
        ...call(`cd "${repo}" && git reset -q --soft HEAD~1`, "", "2026-02-04T10:01:00Z"),
        assistant("Reset done. The problem was that Render applies environment variables on deploy, not on restart, so the restart never picked them up.", "2026-02-04T10:02:00Z"),
        user("and the other one", "2026-02-04T11:00:00Z"),
        ...call(`cd "${repo}" && git revert -n abc1234`, "", "2026-02-04T11:01:00Z"),
        assistant("Reverted it and moved on to the next item on the list.", "2026-02-04T11:02:00Z"),
      ];
      const pieces = preparedPieces(events, sessionId);
      const d = distillate(events, { cwd: repo, startTs: "2026-02-04T10:00:00Z", endTs: "2026-02-04T12:00:00Z" });
      const moments: KeyMoment[] = [
        { kind: "deadend", seq: 2, text: "Bash: cd … && git reset -q --soft HEAD~1", note: "explicit reversal" },
        { kind: "deadend", seq: 8, text: "Bash: cd … && git revert -n abc1234", note: "explicit reversal" },
      ];
      const lines = lessonsLines(moments, tsIndex(events), lessonExplainer(d, events, pieces, [])).join("\n");
      expect(lines).toContain("Render applies environment variables on deploy");
      expect(lines).not.toContain("git reset");
      // the second dead end has no explanation in the next two turns: omitted
      expect(lines).not.toContain("git revert");
      expect(lines.split("\n").filter((line) => line.startsWith("- ")).length).toBe(1);
    } finally { rmSync(repo, { recursive: true, force: true }); }
  });

  test("no explained moment at all, no Lessons section", () => {
    seq = 0;
    const events = [user("go"), assistant("Done and dusted, nothing more to report on that one.")];
    const d = distillate(events);
    const explain = lessonExplainer(d, events, preparedPieces(events, sessionId), []);
    expect(lessonsLines([{ kind: "deadend", seq: 2, text: "Bash: rm -rf build" }], tsIndex(events), explain)).toEqual([]);
  });

  // ROUND 2 · item 9
  test("a commit moment renders its subject, not the shell line that made it", () => {
    expect(commitSubjectOf(`Bash: cd /r && git add -A && git commit -q -m "close the hole on every write endpoint"`))
      .toEqual({ subject: "close the hole on every write endpoint", hash: null });
    const heredoc = commitSubjectOf(`Bash: cd /r && git commit -q -F - <<'EOF' ; row 43: sentinel lockdown ; more body`);
    expect(heredoc!.subject).toBe("row 43: sentinel lockdown");
    // nothing parseable → the caller keeps the line it already had
    expect(commitSubjectOf("Bash: git commit -q --amend --no-edit")).toBeNull();
    expect(commitSubjectOf("Bash: git status --porcelain")).toBeNull();
  });
});

describe("W6 leaks", () => {
  test("anything still carrying a shell variable is dropped, never printed", () => {
    expect(hasShellVariable("the final turns were about $r")).toBe(true);
    expect(hasShellVariable("cd ${WORK}/wt-be4")).toBe(true);
    expect(hasShellVariable("a price of $40")).toBe(false);
  });

  test("a row is clipped at the last separator, never mid-token", () => {
    expect(clipAtToken("| 43 | a1b2c3d | opus/sentinel | closed the hole |", 24)).toBe("| 43 | a1b2c3d |…");
    expect(clipAtToken("the quick brown fox jumps", 12)).toBe("the quick…");
    expect(clipAtToken("short", 40)).toBe("short");
  });
});

/* ================================================================== *
 * The whole file — and the bench
 * ================================================================== */

/** A session that exercises W1–W6 at once, with its temp repositories.
 *  The bench test builds its synthetic case from this same fixture. */
export function fixtureSession(): { events: CarafeEvent[]; d: SessionDistillate; repo: string; origin: string; head: string; cleanup: () => void } {
  seq = 0;
  const { repo, origin, head, cleanup } = repoWithOrigin("fixture");
  const other = join(dirname(repo), "fixture-docs");
  mkdirSync(join(other, ".git"), { recursive: true });
  const events: CarafeEvent[] = [
    user("Build the lockdown: the jobs API is open to anyone with curl. A row is an entry in RELEASE-CHANGELOG.md.", "2026-02-01T09:00:00Z"),
    assistant("A row is an entry in the release changelog that records one deployed change.", "2026-02-01T09:01:00Z"),
    assistant("src/core/engine.ts is the input gate: nothing reaches a worker without passing it.", "2026-02-01T09:02:00Z"),
    user("never push without asking me first", "2026-02-01T09:03:00Z"),
    user("never leave the beat running past 2 pm today", "2026-02-01T09:04:00Z"),
    ...call(`git -C "${repo}" branch --show-current`, "opus/lockdown", "2026-02-01T09:05:00Z"),
    ...call(`git -C "${repo}" status --porcelain`, " M a.ts\n M b.ts", "2026-02-01T09:06:00Z"),
    ...call(`git status --porcelain`, " M somewhere.ts", "2026-02-01T09:07:00Z"),
    ...call(`cd "$WORK" && git log -1 --format=%s`, "an unexpandable reading", "2026-02-01T09:08:00Z"),
    ...call(`git -C "${repo}" status --porcelain`, " M a.ts\n M b.ts\n M c.ts\n M d.ts\n M e.ts\n M f.ts", "2026-02-03T09:00:00Z"),
    ...call("curl -s https://example.invalid/health", '{"status":"ok","commit":"e857941"}', "2026-02-01T09:09:00Z"),
  ];
  for (let index = 0; index < 9; index++) {
    events.push(user(`what about the row for item ${index}?`, "2026-02-01T09:10:00Z"));
    events.push(assistant(`Looking at the row for item ${index}.`, "2026-02-01T09:11:00Z"));
  }
  events.push(...filler());
  for (let index = 0; index < 14; index++) {
    events.push(user(`do ${index}`, "2026-02-05T10:00:00Z"));
    events.push(assistant(`Decided: the lockdown ships behind flag ${index}.`, "2026-02-05T10:01:00Z"));
    events.push(...edit(join(repo, "src/core/engine.ts"), "2026-02-05T10:02:00Z"));
  }
  events.push(assistant("Do you want me to spec the two eval bugs as one piece of work, or ship them separately?", "2026-02-05T10:40:00Z"));
  const d = distillate(events, { cwd: repo, startTs: "2026-02-01T09:00:00Z", endTs: "2026-02-05T11:00:00Z" });
  return { events, d, repo, origin, head, cleanup: () => { cleanup(); rmSync(other, { recursive: true, force: true }); } };
}

describe("the whole file", () => {
  test("renders W1–W6 together, in order, with no leaks", async () => {
    const fixture = fixtureSession();
    try {
      const live = await checkLive([fixture.repo], { now: NOW, healthUrls: ["https://example.invalid/health"] });
      const answers = parseAnswers(
        `tool: claude-code\n\n## Q1\nThe project is a shop assistant.\n\n## Q3\nHEAD is ${git(fixture.repo, "rev-parse", "HEAD")} on main.\nc0ffee1 is the head of origin/main.\n`,
        "/tmp/answers.md", NOW)!;
      const { text } = renderHandoff(fixture.d, fixture.events, {
        now: NOW, target: "codex", live, answers: [answers],
        answerFacts: { traceUrls: new Set(["https://example.invalid/health"]) },
      });

      // round 8 — the agent's answers first, then Do not, then Right now, then
      // the trace's own (renamed, demoted) block
      expect(text.indexOf("## What the outgoing agent said")).toBeGreaterThan(text.indexOf("# Handoff:"));
      expect(text.indexOf("## What the outgoing agent said")).toBeLessThan(text.indexOf("## Do not (the owner's prohibitions, verbatim)"));
      expect(text.indexOf("## Do not (the owner's prohibitions, verbatim)")).toBeLessThan(text.indexOf("## Right now (checked at"));
      expect(text.indexOf("## Right now (checked at")).toBeLessThan(text.indexOf("## Last seen in the session (from the trace, may be stale)"));
      expect(text).not.toContain("## Right now (as last observed in this trace)");

      // W1's own content
      expect(text).toContain(`HEAD ${fixture.head} "the second commit"`);
      expect(text).toContain("0 modified, 1 untracked (scratch.txt)");
      // v6/V1 REPLACES the per-URL `health: not checked` line
      expect(text).toContain("- **LIVE STATE UNKNOWN** — carafe did not contact any service.\n  a person can allow this once per project: carafe live allow");
      expect(text).not.toContain("health: not checked");

      // W2's stamps
      expect(text).toContain("✓ HEAD is ");
      // L2 + PR #38: origin/main is READ, so a wrong head is an observed
      // opposite; the sentence itself is quoted verbatim above its stamps.
      expect(text).toContain("> c0ffee1 is the head of origin/main.");
      expect(text).toContain("✗ c0ffee1 is the head of origin/main");
      // an opinion carries no mechanically checkable claim: quoted, unstamped
      expect(text).toContain("> The project is a shop assistant.");

      // v6/V9 REPLACES v5's "the cwd-assumed readings stand apart HERE": Right
      // now re-read this very repository a moment ago, so every field it
      // reproduces — branch, HEAD, tracking, uncommitted — is superseded and
      // not printed a second time under Last seen, assumed directory or not.
      // (`src/handoff/handoff-v6.test.ts` proves they survive when it did not.)
      expect(text).not.toContain("- readings without a recorded directory:");
      // L4 moved Waiting on the owner above Last seen; slice to the NEXT heading.
      const lastSeenAt = text.indexOf("## Last seen in the session");
      const lastSeen = text.slice(lastSeenAt, text.indexOf("\n## ", lastSeenAt + 1));
      expect(lastSeen).not.toContain("branch main");
      expect(lastSeen).toContain("- health: https://example.invalid/health");
      // W6 — nothing that still carries a shell variable is printed
      expect(/\$[A-Za-z{]/.test(text)).toBe(false);

      // ROUND 3 · item 6 — W1 counted this repository a moment ago, so the
      // trace's own uncommitted counts are not printed beside it
      expect(text).not.toContain("uncommitted went");
      expect(text).toContain("0 modified, 1 untracked (scratch.txt)");

      // W4 — dates on the quotations, and the lapse note
      // (v6/V4 moved this prohibition to the Do not section; it is still dated)
      expect(text).toContain(`- "never push without asking me first"  [seq 4, 2026-02-01 09:03 UTC, 4 d before the end]`);
      expect(text.indexOf("## Do not (the owner's prohibitions, verbatim)")).toBeGreaterThan(text.indexOf("## What the outgoing agent said"));
      expect(text).toContain("(said 2026-02-01; may have lapsed)");
      expect(text).toContain(`after you said: "`);

      // W5 — the three blocks
      expect(text).toContain("## Glossary (terms this session used, with the sentence that first defined them)");
      expect(text).toContain("A row is an entry in the release changelog");
      expect(text).toContain("## File map");
      expect(text).toContain("src/core/engine.ts");
      expect(text).toContain("is the input gate");
      expect(text).not.toContain("- files touched most:");

      // ROUND 2 · item 10 — the chapter directory repeated every collapsed
      // header verbatim; the last chapter's turns live with its moments now
      expect(text).not.toContain("## Directory of the session");
      const moments = text.slice(text.indexOf("## Key moments"));
      expect(moments.slice(moments.lastIndexOf("### Ch "))).toContain("  turns:");

      // ROUND 2 · item 11 — the file has a ceiling
      expect(text.length).toBeLessThanOrEqual(HANDOFF_MAX_CHARS);
    } finally { fixture.cleanup(); }
  });

  // ROUND 2 · item 12
  test("with no answers file the reader is told the step exists", async () => {
    const fixture = fixtureSession();
    try {
      const live = await checkLive([fixture.repo], { now: NOW });
      const { text } = renderHandoff(fixture.d, fixture.events, { now: NOW, target: "codex", live });
      expect(text).toContain("## What the outgoing agent said");
      expect(text).toContain(`_No answers file. Ask the outgoing agent to run: carafe handoff ${fixture.d.sessionId} --questions_`);
      // round 8 — the answers' place comes first, even when it is empty
      expect(text.indexOf("## What the outgoing agent said")).toBeLessThan(text.indexOf("## Right now (checked at"));
    } finally { fixture.cleanup(); }
  });

  // ROUND 2 · deviation 8
  test("the answers still render when no repository could be read — every sentence unchecked", async () => {
    const fixture = fixtureSession();
    try {
      const live = await checkLive(["/no/such/directory/at/all"], { now: NOW });
      const answers = parseAnswers(`tool: codex\n\n## Q3\nHEAD is deadbee1 on main.\nThe backend is live.\n`, "/tmp/a.md", NOW)!;
      const { text } = renderHandoff(fixture.d, fixture.events, { now: NOW, target: "codex", live, answers: [answers] });
      expect(text).toContain("(no repository readable; nothing verified)");
      // nothing readable, so nothing is a claim: the coverage says exactly that
      expect(text).toContain("0 of 0 checkable claims checked · 0 of 0 false when written · 0 unchecked");
      // L2 stamps the CLAIM, under the verbatim sentence
      expect(text).toContain("> HEAD is deadbee1 on main.");
      const block = text.slice(text.indexOf("### Q3."), text.indexOf("## What this is"));
      expect(block).not.toContain("✗");
    } finally { fixture.cleanup(); }
  });

  // ROUND 3 · item 1
  test("a shell loop that names its repos only through a variable still belongs to them", () => {
    seq = 0;
    // One workspace folder holding both repos, like a real projects folder. The session's cwd is THIS
    // folder, never the system temp dir itself: on Linux that is /tmp, which carafe treats as scratch,
    // so two repos loose in it were excluded and these tests passed on macOS and failed on CI.
    const workspace = mkdtempSync(join(tmpdir(), "carafe-v5-loop-ws-"));
    const backend = join(workspace, "carafe-v5-loop-be");
    const frontend = join(workspace, "carafe-v5-loop-fe");
    try {
      for (const dir of [backend, frontend]) mkdirSync(join(dir, ".git"), { recursive: true });
      const parent = dirname(backend);
      const loop = `for r in ${basename(backend)} ${basename(frontend)}; do d="${parent}/$r"; git -C "$d" status --porcelain; done`;
      const events = [
        user("check both", "2026-02-01T09:00:00Z"),
        // the resolvable calls that make them principal in the first place
        ...Array.from({ length: 30 }, () => call(`git -C "${backend}" log -1 --format=%s`, "s", "2026-02-01T09:01:00Z")).flat(),
        ...Array.from({ length: 30 }, () => call(`git -C "${frontend}" log -1 --format=%s`, "s", "2026-02-01T09:02:00Z")).flat(),
        ...filler(),
        // …and the last twelve turns, whose directories resolve to nothing
        ...Array.from({ length: 12 }, (_, index) =>
          [user(`sweep ${index}`, "2026-02-05T10:00:00Z"), ...call(loop, " M a.ts", "2026-02-05T10:00:00Z"),
           assistant(`Swept ${index}.`, "2026-02-05T10:00:00Z")]).flat(),
      ];
      const pieces = preparedPieces(events, sessionId);
      expect(namedPrincipals(loop, [backend, frontend])).toEqual([backend, frontend]);

      const d = distillate(events, { cwd: parent, startTs: "2026-02-01T09:00:00Z", endTs: "2026-02-05T11:00:00Z" });
      const blocks = buildBlocks(events, pieces);
      const principal = principalWorkspaces(repoCounts(d, events, pieces));
      const { belongs } = turnBelonging(events, pieces, blocks, parent, principal);
      expect(belongs.at(-1)).toBe(true);

      const heading = /^## The tail, verbatim \([^\n]*\)$/m.exec(renderHandoff(d, events, { now: NOW, target: "codex" }).text)![0];
      expect(heading).toContain("the last 3 turns of work in");
      expect(heading).toContain(basename(backend));
      expect(heading).toContain(basename(frontend));
      expect(heading).not.toContain("the last 0 turns");
    } finally { rmSync(workspace, { recursive: true, force: true }); }
  });

  test("a turn whose calls resolve to nothing and name no principal repo is a tangent", () => {
    seq = 0;
    const repo = mkdtempSync(join(tmpdir(), "carafe-v5-tangent-"));
    try {
      mkdirSync(join(repo, ".git"), { recursive: true });
      const events = [
        user("work", "2026-02-01T09:00:00Z"),
        ...Array.from({ length: 30 }, () => call(`git -C "${repo}" log -1 --format=%s`, "s", "2026-02-01T09:01:00Z")).flat(),
      ];
      const pieces = preparedPieces(events, sessionId);
      const blocks = buildBlocks(events, pieces);
      // a command naming a repository that is NOT principal attributes nothing
      expect(namedPrincipals(`for r in something-else; do git -C "/x/$r" status; done`, [repo])).toEqual([]);
      expect(turnBelonging(events, pieces, blocks, repo, [repo]).belongs[0]).toBe(true);
    } finally { rmSync(repo, { recursive: true, force: true }); }
  });

  // ROUND 4 · items 1–4 — the turn that ate the tail
  test("one enormous final turn cannot eat the turns before it", () => {
    seq = 0;
    // One workspace folder holding both repos, like a real projects folder. The session's cwd is THIS
    // folder, never the system temp dir itself: on Linux that is /tmp, which carafe treats as scratch,
    // so two repos loose in it were excluded and these tests passed on macOS and failed on CI.
    const workspace = mkdtempSync(join(tmpdir(), "carafe-v5-huge-ws-"));
    const backend = join(workspace, "carafe-v5-huge-be");
    const frontend = join(workspace, "carafe-v5-huge-fe");
    try {
      for (const dir of [backend, frontend]) mkdirSync(join(dir, ".git"), { recursive: true });
      const parent = dirname(backend);
      const loop = `for r in ${basename(backend)} ${basename(frontend)}; do d="${parent}/$r"; git -C "$d" status --porcelain; done`;
      const big = "OUTPUT ".repeat(900);                       // ~6 KB per result
      const events = [
        user("start", "2026-02-01T09:00:00Z"),
        ...Array.from({ length: 30 }, () => call(`git -C "${backend}" log -1 --format=%s`, "s", "2026-02-01T09:01:00Z")).flat(),
        ...Array.from({ length: 30 }, () => call(`git -C "${frontend}" log -1 --format=%s`, "s", "2026-02-01T09:02:00Z")).flat(),
        ...filler(),
        // eleven short turns…
        ...Array.from({ length: 11 }, (_, index) =>
          [user(`sweep ${index}`, "2026-02-05T10:00:00Z"), ...call(loop, " M a.ts", "2026-02-05T10:00:00Z"),
           assistant(`Swept ${index}.`, "2026-02-05T10:00:00Z")]).flat(),
        // …and one final turn of forty 6 KB calls
        user("gather everything for the handoff", "2026-02-05T10:30:00Z"),
        ...Array.from({ length: 40 }, (_, index) => call(`${loop} # probe ${index}`, big, "2026-02-05T10:31:00Z")).flat(),
        assistant("Gathered.", "2026-02-05T10:40:00Z"),
      ];
      const d = distillate(events, { cwd: parent, startTs: "2026-02-01T09:00:00Z", endTs: "2026-02-05T11:00:00Z" });
      const { text } = renderHandoff(d, events, { now: NOW, target: "codex" });
      const tail = text.slice(text.indexOf("## The tail, verbatim"));
      const heading = tail.split("\n")[0]!;

      // (2) it opens on a user line, never on a tool call
      expect(tail.split("\n").find((line) => line.startsWith("**"))).toStartWith("**user:**");
      // (4) the count is the user lines it actually rendered
      expect(heading).toContain("the last 3 turns of work in");
      expect(tail.split("\n").filter((line) => line.startsWith("**user:**")).length).toBe(3);
      // (3) the label names the repositories the loop command spelled out
      expect(heading).toContain(basename(backend));
      expect(heading).toContain(basename(frontend));
      expect(heading).not.toContain("no workspace attributed");
      // (1) the huge turn is summarised, not allowed to displace the others
      expect(tail).toMatch(/\[…\d+ tool calls omitted — carafe show handoff-v5-fixture --seq \d+-\d+\]/);
      expect(tail).toContain("**user:** sweep 9");
      expect(tail).toContain("**user:** gather everything for the handoff");
      expect(text.length).toBeLessThanOrEqual(HANDOFF_MAX_CHARS);
    } finally { rmSync(workspace, { recursive: true, force: true }); }
  });

  // ROUND 5 · the real shape: a huge final turn AND three huge helpers
  test("three 30 KB helper blocks in the final turn cannot swallow the tail either", () => {
    seq = 0;
    // One workspace folder holding both repos, like a real projects folder. The session's cwd is THIS
    // folder, never the system temp dir itself: on Linux that is /tmp, which carafe treats as scratch,
    // so two repos loose in it were excluded and these tests passed on macOS and failed on CI.
    const workspace = mkdtempSync(join(tmpdir(), "carafe-v5-swallow-ws-"));
    const backend = join(workspace, "carafe-v5-swallow-be");
    const frontend = join(workspace, "carafe-v5-swallow-fe");
    try {
      for (const dir of [backend, frontend]) mkdirSync(join(dir, ".git"), { recursive: true });
      const parent = dirname(backend);
      const loop = `for r in ${basename(backend)} ${basename(frontend)}; do d="${parent}/$r"; git -C "$d" status --porcelain; done`;
      const big = "OUTPUT ".repeat(900);                        // ~6 KB per result
      const events = [
        user("start", "2026-02-01T09:00:00Z"),
        ...Array.from({ length: 30 }, () => call(`git -C "${backend}" log -1 --format=%s`, "s", "2026-02-01T09:01:00Z")).flat(),
        ...Array.from({ length: 30 }, () => call(`git -C "${frontend}" log -1 --format=%s`, "s", "2026-02-01T09:02:00Z")).flat(),
        ...filler(),
        ...Array.from({ length: 11 }, (_, index) =>
          [user(`sweep ${index}`, "2026-02-05T10:00:00Z"), ...call(loop, " M a.ts", "2026-02-05T10:00:00Z"),
           assistant(`Swept ${index}.`, "2026-02-05T10:00:00Z")]).flat(),
        user("gather everything for the handoff", "2026-02-05T10:30:00Z"),
        ...Array.from({ length: 60 }, (_, index) => call(`${loop} # probe ${index}`, big, "2026-02-05T10:31:00Z")).flat(),
        assistant("Gathered.", "2026-02-05T10:40:00Z"),
      ];
      // three helpers, each ~30 KB of its own trace, all launched inside that turn
      const helperTraces = ["agent-aad22355", "agent-bbd33466", "agent-ccd44577"].map((id) => {
        let helperSeq = 0;
        const helperEvents: CarafeEvent[] = [];
        for (let index = 0; index < 20; index++) {
          helperEvents.push(
            { ts: "2026-02-05T10:32:00Z", tool: "codex", sessionId: id, seq: ++helperSeq, kind: "user", raw: { payload: { message: `browse step ${index}` } } },
            { ts: "2026-02-05T10:32:00Z", tool: "codex", sessionId: id, seq: ++helperSeq, kind: "tool_use", raw: { payload: { name: "Bash", arguments: { command: `dig +short ${index}.example.invalid` } } } },
            { ts: "2026-02-05T10:32:00Z", tool: "codex", sessionId: id, seq: ++helperSeq, kind: "tool_result", raw: { payload: { output: "DNS ".repeat(400) } } },
          );
        }
        return { sessionId: id, events: helperEvents };
      });

      const d = distillate(events, { cwd: parent, startTs: "2026-02-01T09:00:00Z", endTs: "2026-02-05T11:00:00Z" });
      const { text } = renderHandoff(d, events, { now: NOW, target: "codex", helperTraces });
      const tail = text.slice(text.indexOf("## The tail, verbatim"));

      // round 9: three turns (the last working day), opening on a user line, not one
      expect(tail.split("\n").find((line) => line.startsWith("**"))).toStartWith("**user:**");
      expect(tail.split("\n").filter((line) => line.startsWith("**user:**")).length).toBe(3);
      expect(tail.split("\n")[0]!).toContain("the last 3 turns of work in");
      expect(tail).toContain("**user:** sweep 9");

      // the last turn — everything from its user line to the end — fits the cap
      const lastTurn = tail.slice(tail.indexOf("**user:** gather everything for the handoff"), tail.indexOf("\n## Dig deeper"));
      expect(lastTurn.length).toBeLessThanOrEqual(TAIL_TURN_MAX_CHARS);
      // the helpers are present, named, and summarised rather than quoted whole
      expect(lastTurn).toContain("↳ helper agent-aad22355");
      expect(lastTurn).toMatch(/\[…helper agent-\w+: \d+ more tool calls? — carafe show \S+ --seq \d+-\d+\]/);
      expect(lastTurn).toMatch(/\[…\d+ tool calls omitted — carafe show handoff-v5-fixture --seq \d+-\d+\]/);
      // …and the DNS tables inside them are clipped like any other result
      expect(lastTurn).toContain("more chars — carafe show");

      expect(tail.length).toBeLessThanOrEqual(20_000);
      expect(text.length).toBeLessThanOrEqual(HANDOFF_MAX_CHARS);
    } finally { rmSync(workspace, { recursive: true, force: true }); }
  });

  // ROUND 6 · the same invariants on a CLAUDE CODE trace, where no event has
  // kind tool_use or tool_result at all
  test("a Claude Code last turn of 60 calls and three helpers is capped exactly as a Codex one", () => {
    seq = 0;
    // One workspace folder holding both repos, like a real projects folder. The session's cwd is THIS
    // folder, never the system temp dir itself: on Linux that is /tmp, which carafe treats as scratch,
    // so two repos loose in it were excluded and these tests passed on macOS and failed on CI.
    const workspace = mkdtempSync(join(tmpdir(), "carafe-v5-cc-ws-"));
    const backend = join(workspace, "carafe-v5-cc-be");
    const frontend = join(workspace, "carafe-v5-cc-fe");
    try {
      for (const dir of [backend, frontend]) mkdirSync(join(dir, ".git"), { recursive: true });
      const parent = dirname(backend);
      const loop = `for r in ${basename(backend)} ${basename(frontend)}; do d="${parent}/$r"; git -C "$d" status --porcelain; done`;
      const big = "OUTPUT ".repeat(900);
      const events: CarafeEvent[] = [
        ccUser("start", "2026-02-01T09:00:00Z"),
        ...Array.from({ length: 30 }, () => ccCall(`git -C "${backend}" log -1 --format=%s`, "s", "2026-02-01T09:01:00Z")).flat(),
        ...Array.from({ length: 30 }, () => ccCall(`git -C "${frontend}" log -1 --format=%s`, "s", "2026-02-01T09:02:00Z")).flat(),
        ...ccFiller(),
        ...Array.from({ length: 11 }, (_, index) =>
          [ccUser(`sweep ${index}`, "2026-02-05T10:00:00Z"), ...ccCall(loop, " M a.ts", "2026-02-05T10:00:00Z"),
           ccTurn(`Swept ${index}.`, [], "2026-02-05T10:00:00Z")]).flat(),
        ccUser("gather everything for the handoff", "2026-02-05T10:30:00Z"),
        // the real shape: ONE assistant event carrying text and three calls…
        ...Array.from({ length: 20 }, (_, index) =>
          [ccTurn(index === 0 ? "Gathering." : "", [`${loop} # probe ${index}a`, `${loop} # probe ${index}b`, `${loop} # probe ${index}c`], "2026-02-05T10:31:00Z"),
           ccResult(big, "2026-02-05T10:31:00Z"), ccResult(big, "2026-02-05T10:31:00Z"), ccResult(big, "2026-02-05T10:31:00Z")]).flat(),
        ccTurn("Gathered.", [], "2026-02-05T10:40:00Z"),
      ];
      const helperTraces = ["agent-aad22355", "agent-bbd33466", "agent-ccd44577"].map((id) => {
        let helperSeq = 0;
        const helperEvents: CarafeEvent[] = [];
        for (let index = 0; index < 20; index++) {
          helperEvents.push(
            { ts: "2026-02-05T10:32:00Z", tool: "claude-code", sessionId: id, seq: ++helperSeq, kind: "user", raw: { type: "user", message: { role: "user", content: `browse step ${index}` } } },
            { ts: "2026-02-05T10:32:00Z", tool: "claude-code", sessionId: id, seq: ++helperSeq, kind: "assistant", raw: { type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: `h${index}`, name: "Bash", input: { command: `dig +short ${index}.example.invalid` } }] } } },
            { ts: "2026-02-05T10:32:00Z", tool: "claude-code", sessionId: id, seq: ++helperSeq, kind: "user", raw: { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: `h${index}`, content: "DNS ".repeat(400) }] } } },
          );
        }
        return { sessionId: id, events: helperEvents };
      });

      const d = distillate(events, { tool: "claude-code", cwd: parent, startTs: "2026-02-01T09:00:00Z", endTs: "2026-02-05T11:00:00Z" });
      const { text } = renderHandoff(d, events, { now: NOW, target: "codex", helperTraces });
      const tail = text.slice(text.indexOf("## The tail, verbatim"));

      expect(tail.split("\n").find((line) => line.startsWith("**"))).toStartWith("**user:**");
      expect(tail.split("\n").filter((line) => line.startsWith("**user:**")).length).toBe(3);
      expect(tail.split("\n")[0]!).toContain("the last 3 turns of work in");
      expect(tail).toContain("**user:** sweep 9");

      const lastTurn = tail.slice(tail.indexOf("**user:** gather everything for the handoff"), tail.indexOf("\n## Dig deeper"));
      expect(lastTurn.length).toBeLessThanOrEqual(TAIL_TURN_MAX_CHARS);
      expect(lastTurn).toMatch(/\[…\d+ tool calls omitted — carafe show handoff-v5-fixture --seq \d+-\d+\]/);
      expect(lastTurn).toContain("↳ helper agent-aad22355");
      expect(lastTurn).toMatch(/\[…helper agent-\w+: \d+ more tool calls? — carafe show \S+ --seq \d+-\d+\]/);
      expect(lastTurn).toContain("more chars — carafe show");
      // a result must never collect two clip markers
      expect(lastTurn).not.toMatch(/more chars[^\n]*\n\s*\[…[^\]]*more chars/);

      expect(tail.length).toBeLessThanOrEqual(20_000);
      expect(text.length).toBeLessThanOrEqual(HANDOFF_MAX_CHARS);
    } finally { rmSync(workspace, { recursive: true, force: true }); }
  });

  // ROUND 7 · the shape that was still 38.7 KB: six Agent-tool helpers, each
  // ONE user turn and 150 calls, inside one Claude Code turn
  test("six Agent-tool helpers of 150 calls each cannot keep the tail to one turn", () => {
    seq = 0;
    // One workspace folder holding both repos, like a real projects folder. The session's cwd is THIS
    // folder, never the system temp dir itself: on Linux that is /tmp, which carafe treats as scratch,
    // so two repos loose in it were excluded and these tests passed on macOS and failed on CI.
    const workspace = mkdtempSync(join(tmpdir(), "carafe-v5-agents-ws-"));
    const backend = join(workspace, "carafe-v5-agents-be");
    const frontend = join(workspace, "carafe-v5-agents-fe");
    try {
      for (const dir of [backend, frontend]) mkdirSync(join(dir, ".git"), { recursive: true });
      const parent = dirname(backend);
      const loop = `for r in ${basename(backend)} ${basename(frontend)}; do d="${parent}/$r"; git -C "$d" status --porcelain; done`;
      const events: CarafeEvent[] = [
        ccUser("start", "2026-02-01T09:00:00Z"),
        ...Array.from({ length: 30 }, () => ccCall(`git -C "${backend}" log -1 --format=%s`, "s", "2026-02-01T09:01:00Z")).flat(),
        ...Array.from({ length: 30 }, () => ccCall(`git -C "${frontend}" log -1 --format=%s`, "s", "2026-02-01T09:02:00Z")).flat(),
        ...ccFiller(),
        ...Array.from({ length: 11 }, (_, index) =>
          [ccUser(`sweep ${index}`, "2026-02-05T10:00:00Z"), ...ccCall(loop, " M a.ts", "2026-02-05T10:00:00Z"),
           ccTurn(`Swept ${index}.`, [], "2026-02-05T10:00:00Z")]).flat(),
        ccUser("gather everything for the handoff", "2026-02-05T10:30:00Z"),
        ccTurn("Launching six agents.", [loop], "2026-02-05T10:31:00Z"),
        ccResult("ok", "2026-02-05T10:31:00Z"),
        ccTurn("Gathered.", [], "2026-02-05T10:40:00Z"),
      ];
      // six helpers: ONE user turn (the prompt), then 150 calls with 1 KB
      // results and no further user line — turn granularity cannot bound this
      const helperTraces = Array.from({ length: 6 }, (_, which) => {
        const id = `agent-a${which}d2235${which}`;
        let helperSeq = 0;
        const helperEvents: CarafeEvent[] = [
          { ts: "2026-02-05T10:32:00Z", tool: "claude-code", sessionId: id, seq: ++helperSeq, kind: "user", raw: { type: "user", message: { role: "user", content: `go and find out ${which}` } } },
        ];
        for (let index = 0; index < 150; index++) {
          helperEvents.push(
            { ts: "2026-02-05T10:32:00Z", tool: "claude-code", sessionId: id, seq: ++helperSeq, kind: "assistant", raw: { type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: `h${index}`, name: "Bash", input: { command: `dig +short ${index}.example.invalid` } }] } } },
            { ts: "2026-02-05T10:32:00Z", tool: "claude-code", sessionId: id, seq: ++helperSeq, kind: "user", raw: { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: `h${index}`, content: "DNS ".repeat(250) }] } } },
          );
        }
        helperEvents.push({ ts: "2026-02-05T10:33:00Z", tool: "claude-code", sessionId: id, seq: ++helperSeq, kind: "assistant", raw: { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: `Agent ${which} report: ${"the record is long. ".repeat(60)}` }] } } });
        return { sessionId: id, events: helperEvents };
      });

      const d = distillate(events, { tool: "claude-code", cwd: parent, startTs: "2026-02-01T09:00:00Z", endTs: "2026-02-05T11:00:00Z" });
      const { text } = renderHandoff(d, events, { now: NOW, target: "codex", helperTraces });
      const tail = text.slice(text.indexOf("## The tail, verbatim"));
      const lastTurn = tail.slice(tail.indexOf("**user:** gather everything for the handoff"), tail.indexOf("\n## Dig deeper"));

      // the two earlier turns of the last working day still render
      expect(tail.split("\n").filter((line) => line.startsWith("**user:**")).length).toBe(3);
      expect(tail).toContain("**user:** sweep 9");
      // THE hard invariant, on the turn's final rendered characters
      expect(lastTurn.length).toBeLessThanOrEqual(TAIL_TURN_MAX_CHARS);
      expect(tail.length).toBeLessThanOrEqual(20_000);
      expect(text.length).toBeLessThanOrEqual(HANDOFF_MAX_CHARS);
      // every helper is either capped with its marker or replaced by one line
      for (let which = 0; which < 6; which++) {
        const label = `agent-a${which}d2235${which}`;
        const capped = new RegExp(`\\[…helper ${label}: \\d+ more tool calls`).test(lastTurn);
        const dropped = new RegExp(`↳ helper ${label} omitted`).test(lastTurn);
        expect(capped || dropped).toBe(true);
      }
      // and no helper block opens on a bare result line
      expect(lastTurn).not.toMatch(/more tool calls[^\n]*\]\n\s*⤷/);
    } finally { rmSync(workspace, { recursive: true, force: true }); }
  });

  test("a Claude Code assistant event carrying text AND calls is one unit to the cap", () => {
    seq = 0;
    const pieces = extractPieces([
      ccUser("gather"),
      ccTurn("Gathering.", ["probe 0", "probe 1", "probe 2"]),
      ccResult("x".repeat(3_000)),
    ], {}, {});
    // …and none of these events has kind tool_use or tool_result
    expect(pieces.map((piece) => piece.kind)).toEqual(["user", "assistant", "user"]);
    expect(isUserPiece(pieces[0]!)).toBe(true);
    expect(isCallPiece(pieces[1]!)).toBe(true);
    expect(isAssistantTextPiece(pieces[1]!)).toBe(true);
    expect(isToolPiece(pieces[1]!)).toBe(true);
    expect(opensCallPiece(pieces[1]!)).toBe(true);
    expect(isResultPiece(pieces[2]!)).toBe(true);
    // a result is a USER event in Claude Code and must never open a turn
    expect(isUserPiece(pieces[2]!)).toBe(false);
    expect(capTail("sid", pieces).length).toBeGreaterThan(0);
  });

  // ROUND 7 — the real shape of an Agent-tool helper: ONE user turn (its
  // prompt) and then hundreds of calls with no further user line. Turn
  // granularity cannot bound that; characters can.
  const agentHelper = (id: string, calls: number, said = true): EventPieces => {
    const lines = [
      `_↳ helper agent-${id} — its last 1 turn (seq 1–${calls * 2 + 1} of its own trace)_`,
      `  **user:** go and find out`,
      ...Array.from({ length: calls }, (_, index) => [
        `  → **Bash** {"command":"probe ${index}"}`,
        `      ⤷ ${"DATA ".repeat(200)}`,
      ]).flat(),
      ...(said ? [`  **assistant:** ${"Done, and here is the long report. ".repeat(40)}`] : []),
      `  _carafe show ${id}-session --seq 1-${calls * 2 + 1}_`,
    ];
    return { seq: 100, kind: "helper", lines, chars: lines.reduce((sum, line) => sum + line.length, 0), ts: null };
  };

  test("a helper with one user turn and 150 calls is bounded by characters, not by turns", () => {
    const turn: EventPieces[] = [
      { seq: 1, kind: "user", lines: ["**user:** go"], chars: 12, ts: null },
      agentHelper("aad22355", 150), agentHelper("bbd33466", 150),
    ];
    const capped = capHelperPieces(turn);
    const helpers = capped.filter((piece) => piece.kind === "helper");
    const text = helpers.flatMap((piece) => piece.lines).join("\n");
    // hard, in characters
    expect(helpers.reduce((sum, piece) => sum + piece.chars, 0)).toBeLessThanOrEqual(TAIL_HELPER_MAX_CHARS);
    expect(text).toContain("↳ helper agent-aad22355");
    expect(text).toMatch(/\[…helper agent-aad22355: \d+ more tool calls — carafe show aad22355-session --seq 1-301\]/);
    // the count is the calls it dropped, and it dropped most of them
    expect(Number(/agent-aad22355: (\d+) more tool calls/.exec(text)![1])).toBeGreaterThan(140);
    // it ends on what the helper SAID, clipped
    expect(text).toContain("**assistant:** Done, and here is the long report.");
    expect(text).toContain("more chars — carafe show");
    // …and never opens on a bare result
    for (const piece of helpers) {
      const first = piece.lines[2] ?? "";
      expect(/^\s*⤷/.test(first)).toBe(false);
    }
    // a helper already inside the budget is untouched
    const small = [{ seq: 1, kind: "helper", lines: ["_↳ helper agent-x — its last 1 turn (seq 1–2 of its own trace)_", "  ok"], chars: 70, ts: null }];
    expect(capHelperPieces(small)).toEqual(small);
  });

  test("six 150-call helpers in one turn: each capped with its marker, the turn under 8 KB", () => {
    const turn: EventPieces[] = [
      { seq: 1, kind: "user", lines: ["**user:** gather"], chars: 16, ts: null },
      ...Array.from({ length: 6 }, (_, index) => agentHelper(`agent-${index}`, 150)),
    ];
    const capped = capTurnPieces("sid", turn);
    const text = capped.flatMap((piece) => piece.lines).join("\n");
    expect(capped.reduce((sum, piece) => sum + piece.chars, 0)).toBeLessThanOrEqual(TAIL_TURN_MAX_CHARS);
    // every helper is either capped with its marker or replaced by one line
    for (let index = 0; index < 6; index++) {
      const capped_ = new RegExp(`\\[…helper agent-agent-${index}: \\d+ more tool calls`).test(text);
      const dropped = new RegExp(`↳ helper agent-agent-${index} omitted`).test(text);
      expect(capped_ || dropped).toBe(true);
    }
  });

  // ROUND 8 · a turn that listed twenty-one helper lines, twenty of them the
  // same "omitted" sentence, is one line now
  test("when even the floor will not fit, the omitted helpers collapse to ONE line naming the newest three", () => {
    const turn: EventPieces[] = [
      { seq: 1, kind: "user", lines: ["**user:** gather"], chars: 16, ts: null },
      ...Array.from({ length: 20 }, (_, index) => agentHelper(`agent-${index}`, 150)),
    ];
    const capped = capTurnPieces("sid", turn);
    const text = capped.flatMap((piece) => piece.lines).join("\n");
    expect(capped.reduce((sum, piece) => sum + piece.chars, 0)).toBeLessThanOrEqual(TAIL_TURN_MAX_CHARS);

    const collapsed = text.split("\n").filter((line) => /helper agents omitted/.test(line));
    expect(collapsed.length).toBe(1);
    // …naming the three NEWEST of the ones it dropped, and counting the rest
    expect(collapsed[0]).toMatch(/^_↳ \d+ helper agents omitted \(agent-agent-\d+, agent-agent-\d+, agent-agent-\d+, \+\d+ more\) — carafe handoff sid lists them; carafe show <helper-id> for any_$/);
    const dropped = Number(/↳ (\d+) helper agents omitted/.exec(collapsed[0]!)![1]);
    const named = [...collapsed[0]!.matchAll(/agent-agent-(\d+)/g)].map((match) => Number(match[1]));
    expect(named).toEqual([dropped - 1, dropped - 2, dropped - 3]);
    expect(collapsed[0]).toContain(`+${dropped - 3} more`);
    // never twenty separate "omitted" lines again
    expect(text.split("\n").filter((line) => /↳ helper \S+ omitted/.test(line)).length).toBe(0);
  });

  test("one omitted helper keeps its own line; two or more collapse", () => {
    const one = collapsedHelperLine("sid", [agentHelper("agent-0", 150)]);
    expect(one.lines[0]).toBe("_↳ helper agent-agent-0 omitted — carafe show agent-0-session --seq 1-301_");
    const two = collapsedHelperLine("sid", [agentHelper("agent-0", 150), agentHelper("agent-1", 150)]);
    expect(two.lines[0]).toContain("_↳ 2 helper agents omitted (agent-agent-1, agent-agent-0) — carafe handoff sid lists them");
    expect(two.lines[0]).not.toContain("more)");
  });

  // ROUND 8 · item 1 — twelve turns fit whatever the prefix costs
  test("a large prefix shrinks the per-turn cap instead of dropping turns", () => {
    expect(turnCapFor(41_000)).toBe(3_416);                    // the real budget: 41K split twelve ways
    expect(turnCapFor(120_000)).toBe(TAIL_TURN_MAX_CHARS);     // never more than the ceiling
    expect(turnCapFor(30_000)).toBe(2_500);
    expect(turnCapFor(6_000)).toBe(TAIL_TURN_MIN_CHARS);       // never less than the floor
    expect(helperCapFor(2_500)).toBe(833);
    expect(helperCapFor(TAIL_TURN_MAX_CHARS)).toBe(2_666);

    seq = 0;
    const repo = mkdtempSync(join(tmpdir(), "carafe-v5-prefix-"));
    try {
      mkdirSync(join(repo, ".git"), { recursive: true });
      const big = "OUTPUT ".repeat(900);                        // ~6 KB per result
      const events: CarafeEvent[] = [
        // a long goal and many standing instructions: an expensive prefix
        ccUser(`Build the whole thing. ${"This is the mandate, at length, and it goes on. ".repeat(40)}`, "2026-02-01T09:00:00Z"),
        ...Array.from({ length: 15 }, (_, index) =>
          ccUser(`never ship step ${index} without asking me first, and always say why`, "2026-02-01T09:0${index}:00Z")).flat(),
        // …and the project's own log, quoted at length: this is what really
        // makes a prefix expensive on a real session
        ...ccRead(join(repo, "LEDGER.md"), Array.from({ length: 30 }, (_, index) => `${index} — ${"the ledger row is long and detailed. ".repeat(55)}`).join("\n"), "2026-02-01T09:20:00Z"),
        ...ccFiller(),
        // twelve belonging turns, each ~8 KB raw
        ...Array.from({ length: 12 }, (_, index) =>
          [ccUser(`turn ${index}`, "2026-02-05T10:00:00Z"),
           ccTurn(`Working on ${index}.`, [`git -C "${repo}" status --porcelain`], "2026-02-05T10:00:00Z"),
           ccResult(big, "2026-02-05T10:00:00Z"),
           ccTurn("", [`git -C "${repo}" log -1 --format=%s`], "2026-02-05T10:00:00Z"),
           ccResult(big, "2026-02-05T10:00:00Z")]).flat(),
      ];
      const d = distillate(events, { tool: "claude-code", cwd: repo, startTs: "2026-02-01T09:00:00Z", endTs: "2026-02-05T11:00:00Z" });
      const { text } = renderHandoff(d, events, { now: NOW, target: "codex" });
      const tail = text.slice(text.indexOf("## The tail, verbatim"));
      // Twelve turns of ~24 KB raw each cannot fit any budget this file has:
      // under the old FIXED 8 KB per-turn cap they would have cost 96 KB and
      // only the last few would have rendered. Under the adaptive cap they all
      // do, each one smaller.
      const userLines = tail.split("\n").filter((line) => line.startsWith("**user:**")).length;
      expect(userLines).toBe(3);
      const turns = tail.split(/^\*\*user:\*\*/m).slice(1);
      expect(turns.length).toBe(3);
      for (const one of turns) expect(one.length).toBeLessThanOrEqual(TAIL_TURN_MAX_CHARS);
      expect(Math.max(...turns.map((one) => one.length))).toBeLessThan(TAIL_TURN_MAX_CHARS);
      // …and they are real turns, not stubs
      expect(Math.min(...turns.map((one) => one.length))).toBeGreaterThan(80);
      expect(tail.split("\n")[0]!).toContain("the last 3 turns");
      expect(tail).toContain("**user:** turn 9");
      expect(tail).toContain("**user:** turn 11");
      expect(text.length).toBeLessThanOrEqual(HANDOFF_MAX_CHARS);
    } finally { rmSync(repo, { recursive: true, force: true }); }
  });

  test("a turn inside the cap is left exactly as it was", () => {
    seq = 0;
    const turn = [
      { seq: 1, kind: "user", lines: ["**user:** do it"], chars: 14, ts: null },
      { seq: 2, kind: "tool_use", lines: ["→ **Bash** {}"], chars: 13, ts: null },
      { seq: 3, kind: "tool_result", lines: ["    ⤷ ok"], chars: 8, ts: null },
    ];
    expect(capTurnPieces("sid", turn)).toEqual(turn);
  });

  test("an over-cap turn keeps the user line, the assistant text, two calls at the head and three at the end", () => {
    seq = 0;
    const body = "x".repeat(1_800);
    const turn = [
      { seq: 1, kind: "user", lines: ["**user:** gather"], chars: 16, ts: null },
      ...Array.from({ length: 10 }, (_, index) => [
        { seq: 2 + index * 2, kind: "tool_use", lines: [`→ **Bash** {"command":"probe ${index}"}`], chars: 40, ts: null },
        { seq: 3 + index * 2, kind: "tool_result", lines: [`    ⤷ ${body}`], chars: body.length, ts: null },
      ]).flat(),
      { seq: 30, kind: "assistant", lines: ["**assistant:** Gathered."], chars: 24, ts: null },
    ];
    const capped = capTurnPieces("sid", turn);
    const text = capped.flatMap((piece) => piece.lines).join("\n");
    expect(text).toContain("**user:** gather");
    expect(text).toContain("**assistant:** Gathered.");
    expect(text).toContain("probe 0");
    expect(text).toContain("probe 1");
    expect(text).not.toContain("probe 4");
    expect(text).toContain("probe 9");
    expect(text).toContain("[…5 tool calls omitted — carafe show sid --seq 6-15]");
    // still over after the omission, so the survivors are clipped with the
    // marker the rest of the trace uses
    expect(text).toContain("more chars — carafe show sid --seq");
    expect(capped.reduce((sum, piece) => sum + piece.chars, 0)).toBeLessThanOrEqual(TAIL_TURN_MAX_CHARS);
  });

  // ROUND 4 · item 5
  test("a plan is not a lesson, however many causal words it carries", () => {
    expect(hasCausalCue("Codex is working right now, on its own branch, under a repro-first brief: find the root cause, fix it")).toBe(false);
    expect(hasCausalCue("Codex is directed to find the root cause")).toBe(false);
    expect(hasCausalCue("I will find the root cause tomorrow.")).toBe(false);
    expect(hasCausalCue("We are going to fix the root cause.")).toBe(false);
    expect(hasCausalCue("The reason is simple:")).toBe(false);
    expect(hasCausalCue("The screencapture PNGs captured the user's foreground Chrome window, not the Browser pane — they're not evidence.")).toBe(true);
    expect(isPlanSentence("The problem was that Render applies env on deploy.")).toBe(false);
  });

  // ROUND 3 · item 2
  test("a commit subject comes from the line AFTER the heredoc opener, or from git's own result line", () => {
    // the text trailing the opener on the SAME line is not the message
    const heredoc = commitSubjectOf(`Bash: cd /r && git commit -q -F - <<'EOF' && git log --oneline -1 && git show --stat ; row 43: sentinel lockdown ; the body continues ; EOF`);
    expect(heredoc!.subject).toBe("row 43: sentinel lockdown");
    expect(commitSubjectOf(`Bash: git commit -F - <<EOF\nclose the hole\nbody\nEOF`)!.subject).toBe("close the hole");
    expect(commitSubjectOf(`Bash: git commit -F - <<'MSG'\nrow 44: the grace window\nMSG`)!.subject).toBe("row 44: the grace window");
    // an amend has no subject of its own: git's result line has it
    const amend = commitSubjectOf("Bash: git commit -q --amend --no-edit", "[opus/sentinel-backend 6dbdade] row 43: sentinel lockdown\n 3 files changed");
    expect(amend).toEqual({ subject: "row 43: sentinel lockdown", hash: "6dbdade" });
    // nothing parseable anywhere: the caller keeps the line it had
    expect(commitSubjectOf("Bash: git commit -q --amend --no-edit")).toBeNull();
    expect(commitSubjectOf("Bash: git status --porcelain")).toBeNull();
  });

  // ROUND 3 · item 5
  test("a health URL carrying a shell variable is dropped before anything else", () => {
    seq = 0;
    const events = [
      user("probe"),
      ...call("curl -s https://$TYPESENSE_HOST/health", '{"ok":true}', "2026-02-05T09:00:00Z"),
      ...call("curl -s https://real.example.invalid/health", '{"ok":true}', "2026-02-05T09:01:00Z"),
    ];
    expect(healthUrlsFromTrace(events, extractPieces(events, {}, {}))).toEqual(["https://real.example.invalid/health"]);
  });

  // ROUND 3 · item 6
  test("a checked repository silences the trace's uncommitted finding; an unchecked one keeps it", async () => {
    seq = 0;
    const repo = mkdtempSync(join(tmpdir(), "carafe-v5-live-halfdone-"));
    try {
      mkdirSync(join(repo, ".git"), { recursive: true });
      const events = [
        user("go"),
        ...call(`git -C "${repo}" branch --show-current`, "opus/lockdown", "2026-02-01T09:00:00Z"),
        ...call(`git -C "${repo}" status --porcelain`, " M a.ts\n M b.ts\n M c.ts\n M d.ts", "2026-02-01T09:01:00Z"),
        ...call(`git -C "${repo}" status --porcelain`, Array.from({ length: 11 }, (_, index) => ` M f-${index}.ts`).join("\n"), "2026-02-04T09:00:00Z"),
        ...filler(),
      ];
      const d = distillate(events, { cwd: repo, startTs: "2026-02-01T09:00:00Z", endTs: "2026-02-05T11:00:00Z" });
      const data = rightNowData(d, events, preparedPieces(events, sessionId));
      expect(halfDoneLines(d, data).join("\n")).toContain("uncommitted went 4 → 11");
      expect(halfDoneLines(d, data, new Set([repo]))).toEqual([]);
      // …and the branch-pair / rejected-push / env-flag rules are untouched
      expect(halfDoneLines(d, data, new Set([repo]))).toEqual([]);
    } finally { rmSync(repo, { recursive: true, force: true }); }
  });

  // ROUND 3 · item 7
  test("the newest recap leads the file; the others follow it, newest first", () => {
    seq = 0;
    const repo = mkdtempSync(join(tmpdir(), "carafe-v5-recaps-"));
    try {
      mkdirSync(join(repo, ".git"), { recursive: true });
      const events: CarafeEvent[] = [user("build it", "2026-02-01T09:00:00Z")];
      for (const [index, day] of ["2026-02-01", "2026-02-03", "2026-02-05"].entries()) {
        events.push(user("where are we", `${day}T09:00:00Z`));
        events.push(assistant(`RECAP-${index}: the state of play on ${day}.`, `${day}T09:01:00Z`));
      }
      events.push(...filler());
      const text = renderHandoff(distillate(events, { cwd: repo, startTs: "2026-02-01T09:00:00Z", endTs: "2026-02-05T11:00:00Z" }), events, { now: NOW, target: "codex" }).text;
      const lead = text.slice(text.indexOf("## The newest recap"), text.indexOf("## Last seen in the session") >= 0 ? text.indexOf("## Last seen in the session") : text.indexOf("## Notes"));
      expect(lead).toContain(`## The newest recap (asked "where are we", 2026-02-05`);
      expect(lead).toMatch(/before the end\)/);
      expect(lead).toContain("RECAP-2");
      const rest = text.slice(text.indexOf("## Recaps the assistant wrote"), text.indexOf("## How to read the rest"));
      expect(rest).not.toContain("RECAP-2");
      expect(rest.indexOf("RECAP-1")).toBeGreaterThan(0);
      expect(rest.indexOf("RECAP-1")).toBeLessThan(rest.indexOf("RECAP-0"));
    } finally { rmSync(repo, { recursive: true, force: true }); }
  });

  // ROUND 2 · item 11 — a big session still lands inside the budget
  test("a session with forty chapters still fits the 90KB budget", () => {
    seq = 0;
    const repo = mkdtempSync(join(tmpdir(), "carafe-v5-big-"));
    try {
      mkdirSync(join(repo, ".git"), { recursive: true });
      const events: CarafeEvent[] = [user("start", "2026-01-01T09:00:00Z")];
      for (let chapter = 0; chapter < 40; chapter++) {
        const day = new Date(Date.parse("2026-01-01T09:00:00Z") + chapter * 86_400_000).toISOString();
        events.push(user(`chapter ${chapter}`, day));
        for (let index = 0; index < 12; index++) {
          events.push(assistant(`Decided: approach ${chapter}-${index} for the exporter, because the previous one was wrong.`, day));
          events.push(...edit(join(repo, `src/f-${chapter}-${index}.ts`), day));
        }
      }
      events.push(...filler(300));
      const d = distillate(events, { cwd: repo, startTs: "2026-01-01T09:00:00Z", endTs: events.at(-1)!.ts! });
      const { text, tier } = renderHandoff(d, events, { now: NOW, target: "codex" });
      expect(tier).toBe("layered");
      expect(text.length).toBeLessThanOrEqual(HANDOFF_MAX_CHARS);
    } finally { rmSync(repo, { recursive: true, force: true }); }
  });
});
