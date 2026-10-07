import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, utimesSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { CarafeStore } from "../format/store";
import { writeDistillate, type SessionDistillate } from "../format/distillate";
import { sealSession } from "../format/sessions";
import { currentSession } from "../query/sessions";
import { callerProcesses, writableTranscripts, rememberCaller } from "../query/caller";
import { answersLines, parseAnswers, refreshClaimsHeading } from "./answers";
import { checkClaims } from "./claims";
import { checkLive, liveLines, parseForEachRef, unpushedOf, realGitRunner, type LiveState } from "./live";
import { sinceSection } from "./since";
import { helperTailPieces, renderHandoff, waitingLines } from "./render";
import { sessionCollisionLines, type PeerTrace } from "./session-collisions";
import { runHandoff } from "./handoff";
import type { CarafeEvent } from "../format/events";

const T = "2026-09-27T17:34:00Z", NOW = "2026-09-28T01:00:00Z", OLD = "2026-09-20T10:00:00Z";
const root = mkdtempSync(join(tmpdir(), "carafe-round10-"));
const repo = join(root, "acme-backend-1"), other = join(root, "shopify-app"), stub = join(root, "acme-backend"), wt = join(root, "security-worktree");
const store = new CarafeStore(join(root, "store"));
let live: LiveState, base = "";
const git = (dir: string, at: string, ...args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], env: { ...process.env, GIT_AUTHOR_NAME: "fixture", GIT_AUTHOR_EMAIL: "fixture@example.com", GIT_COMMITTER_NAME: "fixture", GIT_COMMITTER_EMAIL: "fixture@example.com", GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at } }).trim();
const d = (id: string, tool = "claude-code"): SessionDistillate => ({ tool, sessionId: id, internalSessionId: `internal-${id}`, sourcePath: join(root, `${id}.jsonl`), title: `Title ${id}`, cwd: repo, gitBranch: "main", startTs: OLD, endTs: NOW, lastActivityTs: NOW, eventCount: 2, toolUseCount: 0, sidechain: false, version: 1, rawBytes: 1 });
const answers = () => [parseAnswers("tool: claude-code\n## Q1\nThis project handles commerce.\n## Q4\nFour CRITICALs, none fixed. The script `scripts/add-search-partners.mjs` is deployed.\n## Q5\nAsk the owner first.", "fixture.answers.md", T)!];
beforeAll(async () => {
  for (const p of [repo, other, stub]) {
    mkdirSync(p); git(p, OLD, "init", "-q", "-b", "main"); git(p, OLD, "config", "commit.gpgsign", "false");
    writeFileSync(join(p, "README.md"), "fixture\n"); git(p, OLD, "add", "."); git(p, OLD, "commit", "-qm", p === stub ? "init empty stub" : "initial");
  }
  base = git(repo, OLD, "rev-parse", "HEAD");
  mkdirSync(join(repo, "scripts")); writeFileSync(join(repo, "scripts/add-search-partners.mjs"), "export {};\n");
  git(repo, OLD, "add", "."); git(repo, OLD, "commit", "-qm", "partner script");
  git(repo, OLD, "update-ref", "refs/remotes/origin/master", "HEAD");
  git(repo, OLD, "branch", "existing-moved");
  for (let i = 1; i <= 4; i++) git(repo, `2026-09-27T23:3${i}:00Z`, "branch", `claude/3.0-sec-c${i}`, base);
  git(repo, "2026-09-27T23:35:00Z", "worktree", "add", "-q", wt, "claude/3.0-sec-c4");
  writeFileSync(join(wt, "fix.ts"), "export const fixed = true;\n"); git(wt, "2026-09-27T23:36:00Z", "add", "."); git(wt, "2026-09-27T23:36:00Z", "commit", "-qm", "security work");
  git(repo, "2026-09-27T23:37:00Z", "branch", "-f", "existing-moved", "claude/3.0-sec-c4");
  for (let i = 0; i < 15; i++) git(stub, OLD, "branch", `stub-${i}`);
  live = await checkLive([other, repo, stub, wt], { now: NOW });
  for (const id of ["caller-old", "other-new", "codex-caller"]) {
    const dist = d(id, id === "codex-caller" ? "codex" : "claude-code");
    writeFileSync(dist.sourcePath, "{}\n"); utimesSync(dist.sourcePath, new Date(OLD), new Date(id === "other-new" ? NOW : OLD));
    writeDistillate(store, dist); sealSession(store, dist.tool, id, []);
  }
});
afterAll(() => rmSync(root, { recursive: true, force: true }));
const opts = { env: {}, parents: [], writers: [], warn: () => {} };

describe("round10 caller identity", () => {
  for (const key of ["CLAUDE_SESSION_ID", "CLAUDE_CODE_SESSION_ID", "CARAFE_SESSION_ID", "CODEX_THREAD_ID", "CODEX_SESSION_ID"]) test(`${key} beats another session's recency`, () => {
    expect(currentSession(store, repo, { ...opts, env: { [key]: key.startsWith("CODEX") ? "internal-codex-caller" : "caller-old" } })?.sessionId).toBe(key.startsWith("CODEX") ? "codex-caller" : "caller-old");
  });
  test("nested harnesses prefer the nearest process and ambiguous inherited ids fail closed", () => {
    const env = { CLAUDE_SESSION_ID: "caller-old", CODEX_THREAD_ID: "codex-caller" };
    expect(currentSession(store, repo, { ...opts, env, parents: [{ pid: 9, command: "/bin/codex", start: "now" }, { pid: 8, command: "/bin/claude", start: "then" }] })?.sessionId).toBe("codex-caller");
    expect(() => currentSession(store, repo, { ...opts, env })).toThrow("conflicting");
  });
  test("hook transcript handles a Codex parent session id and internal ids", () => {
    expect(currentSession(store, repo, { ...opts, hook: { session_id: "other-new", transcript_path: d("codex-caller").sourcePath } })?.sessionId).toBe("codex-caller");
    expect(currentSession(store, repo, { ...opts, env: { CARAFE_HOOK_DATA: JSON.stringify({ session_id: "internal-caller-old" }) } })?.sessionId).toBe("caller-old");
  });
  test("process-bound hook data rejects reused pids", () => {
    const parent = { pid: 12345, start: "fixture-start", command: "/bin/claude" };
    rememberCaller(store, { session_id: "caller-old" }, [parent]);
    expect(currentSession(store, repo, { ...opts, parents: [parent] })?.sessionId).toBe("caller-old");
    expect(currentSession(store, repo, { ...opts, parents: [{ ...parent, start: "reused" }] })?.sessionId).toBe("other-new");
  });
  test("caller writer's newest transcript wins, regardless of cwd recency", () => {
    expect(currentSession(store, other, { ...opts, writers: [{ path: d("caller-old").sourcePath, mtimeMs: 2 }] })?.sessionId).toBe("caller-old");
  });
  test("transcript env, ambiguous fallback warning, and missing identity fail closed", () => {
    expect(currentSession(store, repo, { ...opts, env: { CLAUDE_TRANSCRIPT_PATH: d("caller-old").sourcePath } })?.sessionId).toBe("caller-old");
    const warnings: string[] = [];
    expect(currentSession(store, repo, { ...opts, warn: (s) => warnings.push(s) })?.sessionId).toBe("other-new");
    expect(warnings[0]).toContain("other-new"); expect(warnings[0]).toContain("carafe handoff other-new --questions");
    expect(() => currentSession(store, repo, { ...opts, env: { CODEX_THREAD_ID: "not-captured" } })).toThrow("Refusing to choose another session");
  });
  test("ps ancestry and writable descriptors use only the nearest writer, newest first", () => {
    const parents = callerProcesses((bin, args) => args.includes(String(process.ppid)) ? "42 Mon Sep 28 10:00:00 2026 /bin/zsh" : "1 Mon Sep 28 09:00:00 2026 /bin/claude");
    expect(parents).toHaveLength(2);
    const writers = writableTranscripts(parents, (_bin, args) => args.includes(String(parents[0]!.pid)) ? "f3\nar\nn/ignored.jsonl\nf4\naw\nn/old.jsonl\nf5\nau\nn/new.jsonl" : "f6\naw\nn/other-session.jsonl", (path) => path === "/new.jsonl" ? 20 : 10);
    expect(writers.map((w) => w.path)).toEqual(["/new.jsonl", "/old.jsonl"]);
    expect(callerProcesses(() => "")).toEqual([]);
  });
  test("a shared host's multiple hooks never become a latest-session pointer", () => {
    const parent = { pid: 23456, start: "shared-host", command: "/bin/codex" };
    rememberCaller(store, { session_id: "caller-old" }, [parent]);
    rememberCaller(store, { session_id: "codex-caller" }, [parent]);
    const warnings: string[] = [];
    expect(currentSession(store, repo, { ...opts, parents: [parent], warn: (s) => warnings.push(s) })?.sessionId).toBe("other-new");
    expect(warnings).toHaveLength(1);
  });
  test("single candidate fallback is quiet; a cwd with over ten newer outsiders still wins", () => {
    const single = new CarafeStore(join(root, "single")); writeDistillate(single, d("caller-old"));
    const warnings: string[] = [];
    expect(currentSession(single, repo, { ...opts, warn: (s) => warnings.push(s) })?.sessionId).toBe("caller-old");
    expect(warnings).toEqual([]);
    for (let i = 0; i < 12; i++) writeDistillate(single, { ...d(`outside-${i}`), cwd: other });
    expect(currentSession(single, repo, opts)?.sessionId).toBe("caller-old");
    expect(currentSession(single, "/unmatched", opts)).not.toBeNull();
  });
  test("questions print id and title before the answer destination", async () => {
    const lines: string[] = [], old = console.log; console.log = (...args) => { lines.push(args.join(" ")); };
    const identity = process.env.CARAFE_SESSION_ID;
    process.env.CARAFE_SESSION_ID = "caller-old";
    try { await runHandoff("current", { store, questions: true, noArm: true }); } finally { console.log = old; if (identity == null) delete process.env.CARAFE_SESSION_ID; else process.env.CARAFE_SESSION_ID = identity; }
    expect(lines[0]).toBe("Resolved session: caller-old — Title caller-old");
    expect(lines[1]).toContain("caller-old.answers.md");
  });
});

test("round10 Since includes unnamed repositories, new old-tip branches, moved refs, worktrees and commits newest first", () => {
  const since = sinceSection({ answers: answers(), live, git: realGitRunner });
  const text = since.lines.join("\n");
  expect(since.checked).toBe(3); // linked worktree shares one object store
  expect(text).toContain("4 new local branches since 2026-09-27 17:34 UTC");
  expect(text).toContain("existing-moved"); expect(text).toContain("new worktrees since"); expect(text).toContain("security work");
  expect(text.indexOf("claude/3.0-sec-c4")).toBeLessThan(text.indexOf("claude/3.0-sec-c1"));
  const rendered = answersLines(answers(), { live, changes: since.changes }).join("\n");
  expect(rendered).toContain("? possibly overtaken: 4 new or moved branches");
  expect(rendered.indexOf("? possibly overtaken:")).toBeGreaterThan(rendered.indexOf("Four CRITICALs"));
  expect(rendered).toContain("not a verified fix");
});

test("round10 relative paths try the named repo, all worked repos, then origin/default; never a false negative", () => {
  const sentence = "In `shopify-app`, `scripts/add-search-partners.mjs` is ready.";
  const claims = checkClaims(sentence, { live });
  expect(claims[0]?.stamp).toBe("✓"); expect(claims[0]?.label).toContain(repo);
  expect(claims[0]?.label).not.toContain("not found");
  const remote = checkClaims(sentence, { live, exists: () => false });
  expect(remote[0]?.stamp).toBe("✓"); expect(remote[0]?.command).toContain("cat-file -e origin/master:scripts/add-search-partners.mjs");
  const absent = checkClaims("See `scripts/absent.mjs`.", { live });
  expect(checkClaims("See `scripts/absent.mjs`.", { live: { ...live, repos: [...live.repos, { ...live.repos[0]!, path: "/unreadable", notChecked: "missing" }] } })[0]?.label).not.toContain("not found");
  expect(absent[0]?.stamp).toBe("?"); expect(absent[0]?.command).toContain(other); expect(absent[0]?.command).toContain(repo);
});

test("round10 coverage counts each path check and marks uncertainty explicitly", () => {
  const file = parseAnswers("## Q4\nSee `scripts/add-search-partners.mjs` and `scripts/absent.mjs`.", "paths", T)!;
  const text = answersLines([file], { live }).join("\n");
  expect(text).toContain("1 of 2 checkable claims checked");
  expect(text.split("\n").filter((l) => /^    [✓✗?] /.test(l))).toHaveLength(2);
  expect(text).toContain("existence now only");
});

test("round10 coverage follows retained checks after question truncation", () => {
  const lines = answersLines([parseAnswers("## Q1\nSee `scripts/add-search-partners.mjs`.\n## Q4\nSee `scripts/absent.mjs`.", "fixture", T)!], { live });
  const retained = refreshClaimsHeading(lines.slice(0, lines.findIndex((l) => l.startsWith("### Q4"))));
  expect(retained[0]).toContain("1 of 1 checkable claims checked");
});

test("round10 local-only ordering preserves time of day and timezones", () => {
  const refs = parseForEachRef("aaa-old abc1111 2026-09-27T23:31:00+03:00\nzzz-new abc2222 2026-09-27T21:34:00Z");
  expect(unpushedOf(refs).branches.map((r) => r.branch)).toEqual(["zzz-new", "aaa-old"]);
});

test("round10 answers lead Since, identical tips collapse, branches sort, and empty waiting stays hidden", () => {
  const events: CarafeEvent[] = [{ seq: 1, sessionId: "caller-old", tool: "codex", ts: T, kind: "assistant", raw: { payload: { message: "Ready." } } }];
  const text = renderHandoff(d("caller-old"), events, { answers: answers(), live }).text;
  expect(text.indexOf("### Q1")).toBeLessThan(text.indexOf("### Q5"));
  expect(text.indexOf("### Q5")).toBeLessThan(text.indexOf("## Since"));
  expect(text).toContain("16 branches all at the empty stub");
  expect(waitingLines([], new Map(), NOW, "caller-old")).toEqual([]);
  const sorted = liveLines({ ...live, repos: [{ ...live.repos[0]!, unpushedAll: undefined, unpushed: [{ branch: "old", hash: "111aaaa", date: OLD }, { branch: "new", hash: "222bbbb", date: NOW }] }] }).join("\n");
  expect(sorted.indexOf("new 222bbbb")).toBeLessThan(sorted.indexOf("old 111aaaa"));
});

test("round10 layered rendering keeps orientation before Since and drops duplicate status blocks", () => {
  const events: CarafeEvent[] = [
    { seq: 1, sessionId: "caller-old", tool: "codex", ts: T, kind: "user", raw: { payload: { message: "Inspect commerce." } } },
    { seq: 2, sessionId: "caller-old", tool: "codex", ts: T, kind: "tool_use", raw: { payload: { name: "exec_command", arguments: { command: `git -C '${repo}' rev-parse HEAD` } } } },
    { seq: 3, sessionId: "caller-old", tool: "codex", ts: T, kind: "tool_result", raw: { payload: { output: base } } },
    ...Array.from({ length: 220 }, (_, i): CarafeEvent => ({ seq: i + 4, sessionId: "caller-old", tool: "codex", ts: T, kind: "assistant", raw: { payload: { message: "Routine fixture progress. " + "x".repeat(1000) } } })),
  ];
  const out = renderHandoff(d("caller-old", "codex"), events, { answers: answers(), live });
  expect(out.tier).toBe("layered");
  expect(out.text.indexOf("### Q5")).toBeLessThan(out.text.indexOf("## Since"));
  expect(out.text).not.toContain(`- status \`${repo}\``);
  expect(out.text).not.toContain("## Waiting on the owner");
});

for (const tool of ["codex", "claude-code"]) test(`round10 ${tool} drops helper tails ending only in a session-limit notice`, () => {
  const say = (seq: number, message: string): CarafeEvent => ({ seq, tool, sessionId: "helper", ts: T, kind: "assistant", raw: tool === "codex" ? { payload: { message } } : { message: { role: "assistant", content: [{ type: "text", text: message }] } } });
  const parent = [say(1, "Delegate work.")];
  expect(helperTailPieces(d("caller-old"), parent, [{ sessionId: "helper", cwd: repo, events: [say(1, "You've hit your session limit · resets 5pm")] }], {}, {})).toEqual([]);
  expect(helperTailPieces(d("caller-old"), parent, [{ sessionId: "helper", cwd: repo, events: [say(1, "Implemented the fix; session limit is near.")] }], {}, {})).not.toEqual([]);
});

for (const tool of ["codex", "claude-code"]) test(`round10 ${tool} collision map ties creation calls to peers, excludes old/unrelated/failed calls`, () => {
  const events: CarafeEvent[] = [];
  const call = (command: string, output: string) => {
    const id = `call-${events.length}`;
    const base = { tool, sessionId: "peer", ts: "2026-09-27T23:35:00Z" };
    events.push({ ...base, seq: events.length + 1, kind: tool === "codex" ? "tool_use" : "assistant", raw: tool === "codex" ? { payload: { name: "exec_command", call_id: id, arguments: { command } } } : { message: { content: [{ type: "tool_use", id, name: "Bash", input: { command } }] } } });
    events.push({ ...base, seq: events.length + 1, kind: tool === "codex" ? "tool_result" : "user", raw: tool === "codex" ? { payload: { call_id: id, output } } : { message: { content: [{ type: "tool_result", tool_use_id: id, content: output }] } } });
  };
  call(`git -C '${repo}' branch claude/3.0-sec-c4`, "");
  call(`git -C '${repo}' worktree add '${wt}' claude/3.0-sec-c4`, "Preparing worktree");
  call(`git -C '${repo}' branch claude/3.0-sec-c1`, "fatal: failed");
  const peer: PeerTrace = { sessionId: "peer", tool, title: "Security fixes", cwd: repo, events };
  const changes = sinceSection({ answers: answers(), live, git: realGitRunner }).changes;
  const text = sessionCollisionLines([peer, { ...peer, sessionId: "old", events: events.map((e) => ({ ...e, ts: OLD })) }, { ...peer, sessionId: "unrelated", cwd: "/unrelated", events: [ { ...events[0]!, kind: "assistant", raw: {} } ] }], [repo], Date.parse(T), changes).join("\n");
  expect(text).toContain("Security fixes"); expect(text).toContain("branch claude/3.0-sec-c4"); expect(text).toContain(`worktree ${wt}`);
  const rendered = renderHandoff(d("caller-old"), [], { answers: answers(), live, peerTraces: [peer] }).text;
  expect(rendered.indexOf("## Collision map")).toBeGreaterThan(rendered.indexOf("## Right now"));
  expect(rendered).toContain("Security fixes");
  expect(text).not.toContain("sec-c1"); expect(text).not.toContain("unrelated"); expect(text).not.toContain('"old"');
});
