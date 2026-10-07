/**
 * Handoff v6 — round 6.
 *
 * Two judges kept a hand-written handoff over carafe's, both for currency
 * rather than content: the file never said what was deployed, never said that
 * its own narrative was four days behind the repository, never surfaced the
 * owner's prohibitions, and hid a reviewer-accepted fix that existed only on
 * this disk inside "+4 more".
 *
 * EVERY fixture here exists in BOTH trace shapes. A Claude Code trace has no
 * `tool_use` events at all — a call is a `tool_use` block inside an `assistant`
 * event and its result a `tool_result` block inside a `user` event — and four
 * fix rounds were lost to rules that only ever ran against the Codex shape.
 *
 * No test touches the real store, the real `~/.carafe`, or the network.
 */
import { describe, expect, test } from "bun:test";
import { execFileSync } from "child_process";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { basename, join } from "path";
import type { SessionDistillate } from "../format/distillate";
import type { CarafeEvent } from "../format/events";
import { realGitRunner, type GitRunner } from "./live";
import { checkLive, defaultRefName, errorClass, liveLines, noHealthReading, parseForEachRef, unpushedOf, UNPUSHED_BRANCHES, type LiveRepo, type LiveState } from "./live";
import { pushRefFromCommand, pushesFromTrace, subjectsByHash } from "./state";
import { detectProhibitions, insideParenthetical, isInjectedTurn, isProhibitionSentence, opensClause, prohibitionClause, PROHIBITIONS_IN_HANDOFF } from "../keymoments/instructions";
import { glossaryEntries, hasCausalCue, isPlanSentence, withoutDoubleLabelled } from "./orient";
import { extractPieces, type EventPieces } from "./pieces";
import {
  doNotLines, headerRepoLine, logOnDiskLines, narrativeAgeNote, newestLiveCommit, noAnswersWarning,
  preparedPieces, readingGroupKey, renderHandoff, rightNowLines, shippedLines,
  HANDOFF_MAX_CHARS, TAIL_FLOOR_CHARS,
} from "./render";
import type { KeyMoment } from "../keymoments/extract";

const sessionId = "handoff-v6-fixture";
const NOW = "2026-09-20T12:00:00Z";
const END = "2026-09-17T11:00:00Z";

let seq = 0;
const reset = (): void => { seq = 0; };

/* ------------------------------------------------------------------ *
 * The two shapes. Every fixture below is built twice, from these.
 * ------------------------------------------------------------------ */

/** Codex: a call is its own `tool_use` event, its result a `tool_result`. */
const cxEvent = (kind: string, payload: Record<string, unknown>, ts: string): CarafeEvent =>
  ({ ts, tool: "codex", sessionId, seq: ++seq, kind, raw: { payload } });
const cxUser = (message: string, ts = "2026-09-17T10:00:00Z"): CarafeEvent => cxEvent("user", { message }, ts);
const cxAssistant = (message: string, ts = "2026-09-17T10:00:00Z"): CarafeEvent => cxEvent("assistant", { message }, ts);
const cxCall = (command: string, output: string, ts = "2026-09-17T10:00:00Z"): CarafeEvent[] => [
  cxEvent("tool_use", { name: "Bash", arguments: { command } }, ts),
  cxEvent("tool_result", { output }, ts),
];
const cxRead = (path: string, output: string, ts = "2026-09-17T10:00:00Z"): CarafeEvent[] => [
  cxEvent("tool_use", { name: "Read", arguments: { file_path: path } }, ts),
  cxEvent("tool_result", { output }, ts),
];
const cxFiller = (count = 240): CarafeEvent[] =>
  Array.from({ length: count }, () => cxAssistant(`filler ${"x".repeat(1_000)}`, "2026-09-17T09:30:00Z"));

/** Claude Code: no tool events exist — blocks inside assistant/user events do. */
const ccEvent = (kind: string, content: unknown, ts: string): CarafeEvent =>
  ({ ts, tool: "claude-code", sessionId, seq: ++seq, kind, raw: { type: kind, message: { role: kind, content } } });
const ccUser = (message: string, ts = "2026-09-17T10:00:00Z"): CarafeEvent => ccEvent("user", message, ts);
const ccAssistant = (text: string, ts = "2026-09-17T10:00:00Z"): CarafeEvent => ccEvent("assistant", [{ type: "text", text }], ts);
/** Claude Code binds a result to its call by `tool_use_id` — the id has to be
 *  the SAME string on both events, or nothing pairs and every rule that reads a
 *  bound result silently sees an empty trace. */
const ccPair = (id: string, name: string, input: Record<string, unknown>, output: string, ts: string): CarafeEvent[] => [
  ccEvent("assistant", [{ type: "tool_use", id, name, input }], ts),
  ccEvent("user", [{ type: "tool_result", tool_use_id: id, content: output }], ts),
];
const ccCall = (command: string, output: string, ts = "2026-09-17T10:00:00Z"): CarafeEvent[] =>
  ccPair(`call-${seq + 1}`, "Bash", { command }, output, ts);
const ccRead = (path: string, output: string, ts = "2026-09-17T10:00:00Z"): CarafeEvent[] =>
  ccPair(`read-${seq + 1}`, "Read", { file_path: path }, output, ts);
const ccFiller = (count = 240): CarafeEvent[] =>
  Array.from({ length: count }, () => ccAssistant(`filler ${"x".repeat(1_000)}`, "2026-09-17T09:30:00Z"));

/** The one builder every fixture below is written against, in both shapes. */
interface Shape {
  name: "codex" | "claude-code";
  user: (message: string, ts?: string) => CarafeEvent;
  assistant: (message: string, ts?: string) => CarafeEvent;
  call: (command: string, output: string, ts?: string) => CarafeEvent[];
  read: (path: string, output: string, ts?: string) => CarafeEvent[];
  filler: (count?: number) => CarafeEvent[];
}
const SHAPES: Shape[] = [
  { name: "codex", user: cxUser, assistant: cxAssistant, call: cxCall, read: cxRead, filler: cxFiller },
  { name: "claude-code", user: ccUser, assistant: ccAssistant, call: ccCall, read: ccRead, filler: ccFiller },
];

function distillate(shape: Shape, events: CarafeEvent[], over: Partial<SessionDistillate> = {}): SessionDistillate {
  return {
    tool: shape.name, sessionId, sourcePath: "/tmp/session.jsonl", title: "handoff v6 fixture",
    cwd: "/tmp/project", gitBranch: "main", startTs: "2026-09-13T10:00:00Z", endTs: END,
    eventCount: events.length, toolUseCount: events.filter((event) => event.kind === "tool_use").length,
    sidechain: false, rawBytes: 10, version: 1, ...over,
  };
}

const piecesOf = (events: CarafeEvent[]): EventPieces[] => extractPieces(events, {}, {});

/* ------------------------------------------------------------------ *
 * a real git repository, created here, removed after
 * ------------------------------------------------------------------ */

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
}

function repoWithOrigin(tag: string): { repo: string; origin: string; cleanup: () => void } {
  const origin = mkdtempSync(join(tmpdir(), `carafe-v6-${tag}-origin-`));
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin], { stdio: "ignore" });
  const repo = mkdtempSync(join(tmpdir(), `carafe-v6-${tag}-`));
  execFileSync("git", ["init", "-q", "-b", "main", repo], { stdio: "ignore" });
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "carafe test");
  git(repo, "config", "commit.gpgsign", "false");
  writeFileSync(join(repo, "README.md"), "hello\n");
  git(repo, "add", "README.md");
  git(repo, "commit", "-q", "-m", "the shipped commit");
  git(repo, "remote", "add", "origin", origin);
  git(repo, "push", "-q", "-u", "origin", "main");
  git(repo, "fetch", "-q", "origin");
  return { repo, origin, cleanup: () => { rmSync(repo, { recursive: true, force: true }); rmSync(origin, { recursive: true, force: true }); } };
}

/** A LiveRepo with everything filled in, for the render-level fixtures. */
function liveRepo(over: Partial<LiveRepo> & { path: string }): LiveRepo {
  return {
    notChecked: null, branch: "main", head: { hash: "ea249dd", subject: "close the hole" },
    headDate: "2026-09-19T08:00:00Z", defaultRef: null, upstream: "origin/main", ahead: 0, behind: 0,
    upstreamUpdated: { at: "2026-09-20T10:00:00Z", how: "fetch" }, modified: 0, untracked: 0, untrackedNames: [], unpushed: [],
    branches: ["main"], track: { main: "" }, ...over,
  };
}
function liveState(repos: LiveRepo[], over: Partial<LiveState> = {}): LiveState {
  return { checkedAt: NOW, repos, health: [], live: false, remoteHeads: {}, ...over };
}

/* ================================================================== *
 * V1 — unknown is said loudly
 * ================================================================== */

describe("V1 the live state is UNKNOWN, and the file says so first", () => {
  test("no --live: the banner is the first line under the heading, and no `not checked` line survives", () => {
    const state = liveState([liveRepo({ path: "/tmp/p" })], {
      health: [{ url: "https://api.example.invalid/health", body: null, error: null }],
    });
    const lines = liveLines(state);
    expect(lines[0]).toBe("## Right now (checked at 2026-09-20 12:00 UTC, when this handoff was written)");
    // Consent gives one human action beneath the banner.
    expect(lines[2]).toBe("- **LIVE STATE UNKNOWN** — carafe did not contact any service.");
    expect(lines[3]).toBe("  a person can allow this once per project: carafe live allow");
    expect(lines.join("\n")).not.toContain("not checked (run with --live");
    expect(noHealthReading(state)).toBe(true);
  });

  test("the banner and human consent instruction are each said once", () => {
    const urls = ["a", "b", "c", "d"].map((name) => `https://${name}.example.invalid/health`);
    const rendered = liveLines(liveState([liveRepo({ path: "/tmp/p" })], {
      health: urls.map((url) => ({ url, body: null, error: null })),
    }));
    expect(rendered.filter((line) => line.includes("LIVE STATE UNKNOWN")).length).toBe(1);
    expect(rendered.filter((line) => line === "  a person can allow this once per project: carafe live allow")).toHaveLength(1);
    expect(rendered.join("\n")).not.toContain("d.example.invalid");
  });

  test("with --live a failed probe says unreachable, with the time and the error class", async () => {
    const { repo, cleanup } = repoWithOrigin("probe");
    try {
      const state = await checkLive([repo], {
        now: NOW, live: true, healthUrls: ["https://api.example.invalid/health"],
        fetcher: async () => ({ error: "getaddrinfo ENOTFOUND api.example.invalid" }),
      });
      const rendered = liveLines(state).join("\n");
      expect(rendered).toContain("- health: https://api.example.invalid/health → unreachable at 2026-09-20 12:00 UTC (dns)");
      expect(rendered).not.toContain("LIVE STATE UNKNOWN");
      // the raw message is not the fact; the class is
      expect(rendered).not.toContain("getaddrinfo");
    } finally { cleanup(); }
  });

  test("a probe that ANSWERED is a reading: no banner", async () => {
    const { repo, cleanup } = repoWithOrigin("answered");
    try {
      const state = await checkLive([repo], {
        now: NOW, live: true, healthUrls: ["https://api.example.invalid/health"],
        fetcher: async () => ({ body: '{"status":"ok"}' }),
      });
      expect(noHealthReading(state)).toBe(false);
      expect(liveLines(state).join("\n")).not.toContain("LIVE STATE UNKNOWN");
    } finally { cleanup(); }
  });

  test("error classes are one actionable word each", () => {
    expect(errorClass("TimeoutError: The operation was aborted due to timeout")).toBe("timeout");
    expect(errorClass("connect ECONNREFUSED 127.0.0.1:8080")).toBe("connection refused");
    expect(errorClass("unable to verify the first certificate")).toBe("tls");
    expect(errorClass("something nobody has seen")).toBe("request failed");
  });
});

/* ================================================================== *
 * V2 — deployed vs local, from LOCAL refs only
 * ================================================================== */

describe("V2 origin/main as the local refs record it", () => {
  test("a real repository reports the default ref, its subject, and where HEAD stands against it", async () => {
    const { repo, cleanup } = repoWithOrigin("default");
    try {
      writeFileSync(join(repo, "README.md"), "changed\n");
      git(repo, "commit", "-q", "-am", "the local commit");
      const state = await checkLive([repo], { now: NOW });
      const one = state.repos[0]!;
      expect(one.defaultRef?.ref).toBe("origin/main");
      expect(one.defaultRef?.hash).toBe(git(repo, "rev-parse", "--short", "origin/main"));
      expect(one.defaultRef?.subject).toBe("the shipped commit");
      expect(one.defaultRef?.ahead).toBe(1);
      expect(one.defaultRef?.behind).toBe(0);
      const rendered = liveLines(state).join("\n");
      expect(rendered).toContain(`origin/main at ${one.defaultRef!.hash} "the shipped commit" (local ref, updated`);
      expect(rendered).toContain("· HEAD is 1 ahead, 0 behind it");
      // the word carafe may never use about a ref it read off this disk
      expect(rendered).not.toContain("deployed");
      expect(rendered).not.toContain("live ref");
    } finally { cleanup(); }
  });

  test("with no origin/HEAD symbolic ref it falls back to origin/main, then origin/master, then says nothing", async () => {
    const { repo, cleanup } = repoWithOrigin("fallback");
    try {
      // a clone made by `git init` + `remote add` has no origin/HEAD at all
      expect(defaultRefName((args) => { try { return git(repo, ...args); } catch { return null; } })).toBe("origin/main");
      const bare = mkdtempSync(join(tmpdir(), "carafe-v6-noremote-"));
      execFileSync("git", ["init", "-q", "-b", "main", bare], { stdio: "ignore" });
      try {
        expect(defaultRefName((args) => { try { return git(bare, ...args); } catch { return null; } })).toBeNull();
        const state = await checkLive([bare], { now: NOW });
        expect(state.repos[0]!.defaultRef).toBeNull();
        expect(liveLines(state).join("\n")).not.toContain("origin/main at");
      } finally { rmSync(bare, { recursive: true, force: true }); }
    } finally { cleanup(); }
  });

  test("HEAD carries its own commit date, which is what the narrative is measured against", async () => {
    const { repo, cleanup } = repoWithOrigin("headdate");
    try {
      const state = await checkLive([repo], { now: NOW });
      expect(state.repos[0]!.headDate).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(newestLiveCommit(state)?.hash).toBe(state.repos[0]!.head!.hash);
    } finally { cleanup(); }
  });
});

/* ================================================================== *
 * V3 — nothing that exists only on this disk is hidden
 * ================================================================== */

describe("V3 what exists only on this disk", () => {
  const many = (count: number): { branches: string[]; track: Record<string, string>; hashes: Record<string, string>; dates: Record<string, string> } => {
    const branches = Array.from({ length: count }, (_, index) => `opus/fix-${String(index).padStart(2, "0")}`);
    return {
      branches,
      track: Object.fromEntries(branches.map((branch) => [branch, ""])),
      hashes: Object.fromEntries(branches.map((branch, index) => [branch, `${index}`.padStart(7, "a")])),
      // oldest first in the ref listing; newest first in the rendered line
      dates: Object.fromEntries(branches.map((branch, index) => [branch, `2026-09-${String(index + 1).padStart(2, "0")}`])),
    };
  };

  test("fifteen are named before a +N more may appear at all", () => {
    expect(UNPUSHED_BRANCHES).toBe(15);
    const under = unpushedOf(many(14));
    expect(under.branches.length).toBe(14);
    expect(under.more).toBe(0);
    const over = unpushedOf(many(20));
    expect(over.branches.length).toBe(15);
    expect(over.more).toBe(5);
  });

  test("newest commit first — a reviewer-accepted fix is never ranked below where someone is standing", () => {
    const result = unpushedOf({
      branches: ["opus/old", "opus/eval-bugs-1-2", "opus/middle"],
      track: { "opus/old": "", "opus/eval-bugs-1-2": "", "opus/middle": "" },
      hashes: { "opus/old": "1111111", "opus/eval-bugs-1-2": "df85883", "opus/middle": "2222222" },
      dates: { "opus/old": "2026-09-01", "opus/eval-bugs-1-2": "2026-09-14", "opus/middle": "2026-09-07" },
    }, { current: "opus/old" });
    expect(result.branches.map((one) => one.branch)).toEqual(["opus/eval-bugs-1-2", "opus/middle", "opus/old"]);
  });

  test("the rendered line carries the heading, every hash and every commit date, and the recovery command", () => {
    const rendered = liveLines(liveState([liveRepo({
      path: "/tmp/backend",
      unpushed: [{ branch: "opus/eval-bugs-1-2", hash: "df85883", date: "2026-09-14" }],
    })])).join("\n");
    expect(rendered).toContain("  on this disk only (no remote has these commits): opus/eval-bugs-1-2 df85883 (2026-09-14)");
    expect(rendered).not.toContain("unpushed:");
    expect(rendered).not.toContain("+");

    const capped = liveLines(liveState([liveRepo({
      path: "/tmp/backend",
      unpushed: unpushedOf(many(20)).branches,
      unpushedMore: 5,
    })])).join("\n");
    expect(capped).toContain("  +5 more — git -C /tmp/backend for-each-ref --no-merged origin/main refs/heads");
  });

  test("for-each-ref's committer date is read off the END of the line, past the optional [ahead N] track", () => {
    const parsed = parseForEachRef([
      "main aaaa111 [ahead 2] 2026-09-14",
      "opus/no-upstream bbbb222  2026-09-12",
    ].join("\n"));
    expect(parsed.track).toEqual({ main: "[ahead 2]", "opus/no-upstream": "" });
    expect(parsed.dates).toEqual({ main: "2026-09-14", "opus/no-upstream": "2026-09-12" });
  });
});

/* ================================================================== *
 * V4 — the owner's prohibitions
 * ================================================================== */

describe.each(SHAPES)("V4 Do not · $name shape", (shape) => {
  /** A failing tool call, then the owner saying what must never happen again. */
  function prohibitionTrace(): { events: CarafeEvent[]; d: SessionDistillate } {
    reset();
    const events = [
      shape.user("build the lockdown", "2026-09-13T10:00:00Z"),
      shape.user("never push without asking me first", "2026-09-13T10:01:00Z"),
      shape.user("always answer in plain english", "2026-09-13T10:02:00Z"),
      shape.assistant("starting", "2026-09-13T10:03:00Z"),
      // the incident: a failed run, twice, so the streak detector sees it too
      ...shape.call("bun test", "exit code 1\nFAIL 3 tests", "2026-09-13T10:04:00Z"),
      ...shape.call("bun test", "exit code 1\nFAIL 3 tests", "2026-09-13T10:05:00Z"),
      // …and the rule it cost
      shape.user("never talk to production chat to test it", "2026-09-13T10:06:00Z"),
      shape.assistant("Never POST to production chat because it writes a real conversation.", "2026-09-13T10:07:00Z"),
      // a decoy: a feeling, a question, and an order about one file
      shape.user("I never remember which one is which", "2026-09-13T10:08:00Z"),
      shape.user("should we never do that?", "2026-09-13T10:09:00Z"),
      shape.user("never touch src/handoff/render.ts again", "2026-09-13T10:10:00Z"),
      ...shape.filler(),
    ];
    return { events, d: distillate(shape, events) };
  }

  test("prohibitions are detected, incident-adjacent ones lead, and each is marked for what it is", () => {
    const { events } = prohibitionTrace();
    const found = detectProhibitions(events, piecesOf(events), undefined, hasCausalCue);
    const texts = found.map((one) => one.text);
    expect(texts).toContain("never talk to production chat to test it");
    expect(texts).toContain("never push without asking me first");
    // an assistant sentence qualifies only with a prohibition AND a causal cue
    expect(texts).toContain("Never POST to production chat because it writes a real conversation.");
    expect(found.find((one) => one.text.startsWith("Never POST"))!.assistant).toBe(true);
    // the rule said within three turns of the failing run leads the list
    expect(found[0]!.text).toBe("Never POST to production chat because it writes a real conversation.");
    expect(found.some((one) => one.text === "never talk to production chat to test it" && one.incidentSeq != null)).toBe(true);
    // decoys
    expect(texts).not.toContain("I never remember which one is which");
    expect(texts).not.toContain("should we never do that?");
    // …but an order about ONE file is still a prohibition: it is not a standing
    // rule (that section screens it out), and the next agent must still not
    // break it, so this section keeps it
    expect(texts).toContain("never touch src/handoff/render.ts again");
    expect(found.length).toBeLessThanOrEqual(PROHIBITIONS_IN_HANDOFF);
  });

  test("an assistant sentence with no causal cue is NOT a rule carafe will quote", () => {
    const { events } = prohibitionTrace();
    // the brief's own example sentence — "Never POST to production chat — it
    // writes a real conversation" — carries no cue from v5's strong-cue list,
    // and is therefore correctly left out rather than promoted
    const bare = detectProhibitions(events, piecesOf(events), undefined, () => false);
    expect(bare.some((one) => one.assistant)).toBe(false);
    expect(bare.some((one) => one.text === "never talk to production chat to test it")).toBe(true);
  });

  test("the section sits directly after the newest recap, and Standing instructions stops repeating it", () => {
    const { events, d } = prohibitionTrace();
    const { text } = renderHandoff(d, events, { now: NOW, target: "codex" });
    const doNot = text.indexOf("## Do not (the owner's prohibitions, verbatim)");
    expect(doNot).toBeGreaterThan(-1);
    // it leads everything the trace says about state
    expect(doNot).toBeLessThan(text.indexOf("## Notes (deterministic"));
    const section = text.slice(doNot, text.indexOf("## Notes (deterministic"));
    expect(section).toContain(`- "never talk to production chat to test it" (said after an incident [seq `);
    expect(section).toContain(`(the assistant's rule)`);
    // …and every line is dated with the v5 anchor
    for (const line of section.split("\n").filter((line) => line.startsWith("- \""))) expect(line).toEndWith("]");
    const from = text.indexOf("## Standing instructions");
    const standing = text.slice(from, from + text.slice(from + 2).indexOf("\n## ") + 2);
    expect(standing).toContain("always answer in plain english");
    expect(standing).not.toContain("never push without asking me first");
    expect(standing).not.toContain("never talk to production chat");
  });

  test("a sentence is a prohibition on the words that forbid, never on the words that feel", () => {
    for (const yes of ["never push to main", "do not run the seeder", "don't touch the queue", "must not deploy on a Friday", "no more silent retries"]) {
      expect(isProhibitionSentence(yes)).toBe(true);
    }
    for (const no of ["I never remember the flag", "we don't have a staging box", "should I never retry?", "**never** do this"]) {
      expect(isProhibitionSentence(no)).toBe(false);
    }
    // v6 round 2: a prohibition word that follows its SUBJECT opens no clause.
    // This is what rejects "…you never presented them"; it costs "you must not
    // deploy on a Friday" too, and that cost is real — see the report.
    expect(isProhibitionSentence("you must not deploy on a Friday")).toBe(false);
  });
});

/* ================================================================== *
 * V5 — what reached a remote
 * ================================================================== */

describe.each(SHAPES)("V5 what reached a remote · $name shape", (shape) => {
  function pushTrace(repo: string): { events: CarafeEvent[]; d: SessionDistillate } {
    reset();
    const events = [
      shape.user("ship it", "2026-09-16T21:10:00Z"),
      // the subject, printed beside its hash somewhere in the trace
      ...shape.call(`git -C ${repo} log -1 --oneline`, "ea249dd close the hole in the jobs API", "2026-09-16T21:11:00Z"),
      ...shape.call(`git -C ${repo} push origin main`, "To github.invalid:x/y.git\n   8f2a11c..ea249dd  main -> main", "2026-09-16T21:12:00Z"),
      ...shape.call(`git -C ${repo} push -u origin opus/eval-bugs`, "To github.invalid:x/y.git\n * [new branch]      opus/eval-bugs -> opus/eval-bugs", "2026-09-16T21:20:00Z"),
      // a push that was REFUSED is not something that reached a remote
      ...shape.call(`git -C ${repo} push origin main`, "! [rejected]        main -> main (non-fast-forward)", "2026-09-16T21:30:00Z"),
      // …and a push to a feature branch that is neither main nor new
      ...shape.call(`git -C ${repo} push origin opus/other`, "   1111111..2222222  opus/other -> opus/other", "2026-09-16T21:40:00Z"),
      // …and one from outside the seven-day window
      ...shape.call(`git -C ${repo} push origin main`, "   0000000..1111111  main -> main", "2026-08-01T10:00:00Z"),
      ...shape.filler(),
    ];
    return { events, d: distillate(shape, events) };
  }

  test("only pushes whose RESULT says main, master or [new branch] are counted, and a rejection never is", () => {
    const { events } = pushTrace("/tmp/acme-api");
    const pushes = pushesFromTrace(events, piecesOf(events), { cwd: "/tmp/project" });
    expect(pushes.map((push) => push.ref).sort()).toEqual(["main", "main", "opus/eval-bugs"]);
    expect(pushes.find((push) => push.ref === "opus/eval-bugs")!.newBranch).toBe(true);
    expect(pushes.find((push) => push.hash === "ea249dd")!.repo).toBe("/tmp/acme-api");
    expect(pushes.some((push) => push.ref === "opus/other")).toBe(false);
  });

  test("the section quotes the clock, the repo, the ref, the hash, the subject and the seq — newest first, nothing about deploys", () => {
    const { events, d } = pushTrace("/tmp/acme-api");
    const pieces = piecesOf(events);
    const lines = shippedLines(pushesFromTrace(events, pieces, { cwd: "/tmp/project" }), subjectsByHash(events, pieces), d.endTs);
    const text = lines.join("\n");
    expect(lines[0]).toBe("## What reached a remote, last 7 days (from the trace)");
    // round 8 — the repository by its full path: the gate re-verifies each push there
    expect(text).toContain(`- 2026-09-16 21:20 UTC · /tmp/acme-api · opus/eval-bugs · new branch  [seq `);
    expect(text).toContain(`- 2026-09-16 21:12 UTC · /tmp/acme-api · main · ea249dd "close the hole in the jobs API"  [seq `);
    // the August push is outside the seven-day window
    expect(text).not.toContain("2026-08-01");
    // carafe cannot see a deploy; it saw a push result
    expect(text.toLowerCase()).not.toContain("deploy");
    // newest first
    expect(text.indexOf("21:20")).toBeLessThan(text.indexOf("21:12"));
  });

  test("the section is omitted when nothing reached a remote", () => {
    expect(shippedLines([], new Map(), END)).toEqual([]);
  });

  test("it renders into the file directly after Do not", () => {
    // round 8 — a push is filed under a repository only when git confirms the
    // ref there: a real repository with the pushed branch
    const root = mkdtempSync(join(tmpdir(), "carafe v6 shipped "));
    const repo = join(root, "acme-api");
    try {
      execFileSync("git", ["init", "-q", "-b", "main", repo]);
      execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "first"]);
      execFileSync("git", ["-C", repo, "branch", "opus/eval-bugs"]);
      const { events, d } = pushTrace(`"${repo}"`);
      const { text } = renderHandoff(d, events, { now: NOW, target: "codex" });
      expect(text).toContain("## What reached a remote, last 7 days (from the trace)");
      expect(text).toContain(`· ${repo} · opus/eval-bugs · new branch`);
      // ea249dd is not a commit of this repository: that push is not filed here
      const shipped = text.slice(text.indexOf("## What reached a remote"), text.indexOf("\n## ", text.indexOf("## What reached a remote") + 3));
      expect(shipped).not.toContain("ea249dd");
      expect(text.indexOf("## What reached a remote")).toBeLessThan(text.indexOf("## Notes (deterministic"));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

/* ================================================================== *
 * V6 — the narrative's age
 * ================================================================== */

describe.each(SHAPES)("V6 the narrative's age · $name shape", (shape) => {
  function recapTrace(): { events: CarafeEvent[]; d: SessionDistillate } {
    reset();
    const events = [
      shape.user("build it", "2026-09-13T10:00:00Z"),
      shape.user("where are we?", "2026-09-13T10:05:00Z"),
      shape.assistant("The lockdown is in. The backend is still bypassed. Three of five waves are done.", "2026-09-13T10:06:00Z"),
      // the whole session — tail included — ended six days before the newest
      // commit Right now finds on the disk
      ...Array.from({ length: 240 }, () => shape.assistant(`filler ${"x".repeat(1_000)}`, "2026-09-13T10:07:00Z")),
    ];
    return { events, d: distillate(shape, events, { endTs: "2026-09-13T11:00:00Z" }) };
  }

  test("a recap older than the newest commit by more than 48 h carries the note, with the hash and the date", () => {
    const live = liveState([liveRepo({ path: "/tmp/backend", headDate: "2026-09-19T08:00:00Z", head: { hash: "ea249dd", subject: "close the hole" } })]);
    expect(narrativeAgeNote("2026-09-13T10:06:00Z", live)).toEqual([
      `_This recap is 6 days older than the newest commit below (ea249dd, 2026-09-19). Read "What reached a remote" and Right now first._`,
    ]);
    // …and the tail heading says the same thing about itself
    expect(narrativeAgeNote("2026-09-13T10:06:00Z", live, "tail")[0]).toContain("_This tail is 6 days older");
  });

  test("a recap inside 48 h of the newest commit says nothing, and neither does one with no commit to compare", () => {
    const close = liveState([liveRepo({ path: "/tmp/backend", headDate: "2026-09-14T08:00:00Z" })]);
    expect(narrativeAgeNote("2026-09-13T10:06:00Z", close)).toEqual([]);
    expect(narrativeAgeNote("2026-09-13T10:06:00Z", liveState([liveRepo({ path: "/tmp/backend", headDate: null })]))).toEqual([]);
    expect(narrativeAgeNote(null, close)).toEqual([]);
    expect(narrativeAgeNote("2026-09-13T10:06:00Z", undefined)).toEqual([]);
  });

  test("it renders directly under the newest recap's heading, and on the tail heading", () => {
    const { events, d } = recapTrace();
    const live = liveState([liveRepo({ path: "/tmp/backend", headDate: "2026-09-19T08:00:00Z" })]);
    const { text } = renderHandoff(d, events, { now: NOW, target: "codex", live });
    const heading = text.indexOf("## The newest recap (asked");
    expect(heading).toBeGreaterThan(-1);
    const after = text.slice(heading, heading + 400);
    expect(after).toContain("_This recap is 6 days older than the newest commit below (ea249dd, 2026-09-19).");
    const tail = text.indexOf("## The tail, verbatim");
    expect(text.slice(tail, tail + 400)).toContain("_This tail is 6 days older");
  });
});

/* ================================================================== *
 * V7 — the project log's own tail, from the disk
 * ================================================================== */

describe.each(SHAPES)("V7 the log as it is NOW · $name shape", (shape) => {
  test("the last ten dated entries are read off the disk, clipped, and the trace excerpt is kept above them", () => {
    const { repo, cleanup } = repoWithOrigin("log");
    try {
      const ledger = join(repo, "CHANGELOG.md");
      const rows = Array.from({ length: 14 }, (_, index) => `- 2026-09-${String(index + 1).padStart(2, "0")} row ${index} ${"y".repeat(400)}`);
      writeFileSync(ledger, ["# Changelog", "not a dated row at all", ...rows].join("\n"));

      const lines = logOnDiskLines(ledger, []);
      expect(lines[0]).toBe("### CHANGELOG.md, last 10 dated entries (read from disk when this handoff was written)");
      const body = lines.join("\n");
      expect(body).toContain("> - 2026-09-14 row 13");
      // the four oldest fall off the end
      expect(body).not.toContain("row 0 ");
      expect(body).not.toContain("not a dated row at all");
      // every row is clipped
      for (const line of body.split("\n").filter((line) => line.startsWith("> - 2026"))) {
        expect(line.length).toBeLessThanOrEqual(LOG_LINE_MAX);
      }

      // a relative path is resolved against the repositories Right now checked
      expect(logOnDiskLines("CHANGELOG.md", [repo])[0]).toContain("### CHANGELOG.md, last 10 dated entries");
      // …and a file that is not there, or has no dated rows, says nothing
      expect(logOnDiskLines("NOPE.md", [repo])).toEqual([]);
      writeFileSync(join(repo, "PLAIN.md"), "# Plain\njust prose\n");
      expect(logOnDiskLines("PLAIN.md", [repo])).toEqual([]);
    } finally { cleanup(); }
  });

  test("the rendered section carries the trace's own sighting AND the disk's tail", () => {
    const { repo, cleanup } = repoWithOrigin("logrender");
    try {
      const ledger = join(repo, "CHANGELOG.md");
      writeFileSync(ledger, ["# Changelog", "- 2026-09-19 the row written after this session ended"].join("\n"));
      reset();
      const events = [
        shape.user("read the ledger", "2026-09-13T10:00:00Z"),
        ...shape.read(ledger, "# Changelog\n- 2026-09-12 the row this session saw", "2026-09-13T10:01:00Z"),
        ...shape.read(ledger, "# Changelog\n- 2026-09-12 the row this session saw", "2026-09-13T10:02:00Z"),
        ...shape.filler(),
      ];
      const d = distillate(shape, events, { cwd: repo });
      const { text } = renderHandoff(d, events, { now: NOW, target: "codex", live: liveState([liveRepo({ path: repo })]) });
      expect(text).toContain("## CHANGELOG.md, as last seen [seq ");
      expect(text).toContain("> - 2026-09-12 the row this session saw");
      expect(text).toContain("### CHANGELOG.md, last 1 dated entries (read from disk when this handoff was written)");
      expect(text).toContain("> - 2026-09-19 the row written after this session ended");
    } finally { cleanup(); }
  });
});
const LOG_LINE_MAX = 302; // 300 characters plus the "> " quote prefix

/* ================================================================== *
 * V8 — missing answers are a warning, not a footnote
 * ================================================================== */

describe.each(SHAPES)("V8 no answers · $name shape", (shape) => {
  function smallTrace(): { events: CarafeEvent[]; d: SessionDistillate } {
    reset();
    const events = [shape.user("do the thing", "2026-09-13T10:00:00Z"), shape.assistant("done", "2026-09-13T10:01:00Z"), ...shape.filler()];
    return { events, d: distillate(shape, events) };
  }

  test("the warning is the SECOND line of the whole file, under the title", () => {
    const { events, d } = smallTrace();
    const { text } = renderHandoff(d, events, { now: NOW, target: "codex" });
    const lines = text.split("\n");
    expect(lines[0]).toStartWith("# Handoff:");
    expect(lines[1]).toBe(noAnswersWarning(sessionId));
    expect(lines[1]).toContain("This file is extraction only");
    expect(lines[1]).toContain(`carafe handoff ${sessionId} --questions`);
    // it never refuses: the file is still a whole handoff
    expect(text).toContain("## The tail, verbatim");
    // …and the stub section stays where it was
    expect(text).toContain(`_No answers file. Ask the outgoing agent to run: carafe handoff ${sessionId} --questions_`);
  });

  test("with answers there is no warning at all", () => {
    const { events, d } = smallTrace();
    const answers = [{
      path: "/tmp/a.md", tool: "claude-code", writtenAt: NOW,
      sections: [{ question: 1, text: "It is a shop assistant." }],
    }];
    const { text } = renderHandoff(d, events, { now: NOW, target: "codex", answers });
    expect(text.split("\n")[1]).not.toContain("No outgoing-agent answers");
  });
});

/* ================================================================== *
 * V9 — the round-6 bugs
 * ================================================================== */

describe("V9 the header's repo list and its branch claim", () => {
  test("the header names exactly the repositories Right now checked, in their order", () => {
    const live = liveState([
      liveRepo({ path: "/tmp/backend", branch: "main" }),
      liveRepo({ path: "/tmp/frontend", branch: "main" }),
    ]);
    const { repos, branch } = headerRepoLine(live, [{ path: "/tmp/backend", calls: 732 }, { path: "/tmp/frontend", calls: 98 }, { path: "/tmp/never-checked", calls: 5 }]);
    expect(repos).toBe("/tmp/backend (732 tool calls), /tmp/frontend (98 tool calls)");
    expect(branch).toBe("main");
  });

  test("a branch is claimed ONLY when every checked repository is on it", () => {
    const mixed = liveState([liveRepo({ path: "/tmp/a", branch: "main" }), liveRepo({ path: "/tmp/b", branch: "opus/fix" })]);
    expect(headerRepoLine(mixed, []).branch).toBeNull();
    // …and never from the trace alone, when nothing was checked
    expect(headerRepoLine(undefined, [{ path: "/tmp/a", calls: 3 }]).branch).toBeNull();
    expect(headerRepoLine(liveState([liveRepo({ path: "/tmp/a", branch: null })]), []).branch).toBeNull();
  });

  test("a top-set repository whose directory is gone renders as `not checked: <path> (directory missing)`", async () => {
    const state = await checkLive(["/no/such/directory/at/all"], { now: NOW });
    expect(state.repos[0]!.notChecked).toBe("directory missing");
    const { repos } = headerRepoLine(state, []);
    expect(repos).toBe("not checked: /no/such/directory/at/all (directory missing)");
    expect(liveLines(state).join("\n")).toContain("- not checked: /no/such/directory/at/all (directory missing)");
  });

});

describe.each(SHAPES)("V9 a branch reading is never welded to a HEAD read elsewhere · $name shape", (shape) => {
  test("a -C reading and a no--C reading are two lines, the second marked (cwd assumed), never joined", () => {
    const { repo, cleanup } = repoWithOrigin("weld");
    try {
      reset();
      const events = [
        shape.user("where are we", "2026-09-17T10:00:00Z"),
        // one call NAMES the repository …
        ...shape.call(`git -C ${repo} branch --show-current`, "opus/row42-null-guard", "2026-09-17T10:01:00Z"),
        // … the other names nothing, and ran wherever the shell happened to be
        ...shape.call(`git log -1`, `0959ebf init empty stub`, "2026-09-17T10:02:00Z"),
        ...shape.filler(),
      ];
      const d = distillate(shape, events, { cwd: repo });
      const pieces = preparedPieces(events, sessionId);
      // no live state: nothing here is superseded, so both readings must show
      const lines = rightNowLines(d, events, pieces).join("\n");
      expect(lines).toContain("branch opus/row42-null-guard");
      expect(lines).toContain("HEAD 0959ebf");
      // the whole bug, in one assertion: they are never one field list
      expect(lines).not.toContain(`branch opus/row42-null-guard · HEAD 0959ebf`);
      // …and the assumed one says it is assumed, on its own line with its own seq
      const assumed = lines.split("\n").find((line) => line.includes("HEAD 0959ebf"))!;
      expect(assumed).toContain("(cwd assumed)");
      expect(assumed).not.toContain("opus/row42-null-guard");
    } finally { cleanup(); }
  });

  test("two readings may share a line only on one seq, or on one NAMED directory", () => {
    expect(readingGroupKey({ value: 1, seq: 4, ts: null, dir: "/tmp/a" })).toBe(readingGroupKey({ value: 2, seq: 9, ts: null, dir: "/tmp/a" }));
    expect(readingGroupKey({ value: 1, seq: 4, ts: null, dir: null })).toBe(readingGroupKey({ value: 2, seq: 4, ts: null, dir: null }));
    expect(readingGroupKey({ value: 1, seq: 4, ts: null, dir: null })).not.toBe(readingGroupKey({ value: 2, seq: 5, ts: null, dir: null }));
    expect(readingGroupKey({ value: 1, seq: 4, ts: null, dir: "/tmp/a" })).not.toBe(readingGroupKey({ value: 2, seq: 4, ts: null, dir: "/tmp/b" }));
  });
});

describe.each(SHAPES)("V9 Last seen drops what Right now re-read · $name shape", (shape) => {
  function stateTrace(repo: string): { events: CarafeEvent[]; d: SessionDistillate } {
    reset();
    const events = [
      shape.user("status", "2026-09-17T10:00:00Z"),
      ...shape.call(`git -C ${repo} branch --show-current`, "opus/fix", "2026-09-17T10:01:00Z"),
      ...shape.call(`git -C ${repo} status --porcelain`, "M one.ts\nM two.ts", "2026-09-17T10:02:00Z"),
      // …and one thing a live reading can NEVER reproduce
      ...shape.call(`git -C ${repo} push origin main`, "   1111111..ea249dd  main -> main", "2026-09-17T10:03:00Z"),
      ...shape.filler(),
    ];
    return { events, d: distillate(shape, events, { cwd: "/tmp/project" }) };
  }

  test("branch, HEAD, tracking and uncommitted go; the push stays", () => {
    const repo = "/tmp/acme-api";
    const { events, d } = stateTrace(repo);
    const pieces = preparedPieces(events, sessionId);
    const superseded = rightNowLines(d, events, pieces, [], undefined, new Set([repo])).join("\n");
    expect(superseded).not.toContain("branch opus/fix");
    expect(superseded).not.toContain("2 uncommitted");
    expect(superseded).toContain("pushed: main");

    // …and with no live reading for that repository, everything survives
    const kept = rightNowLines(d, events, pieces).join("\n");
    expect(kept).toContain("branch opus/fix");
    expect(kept).toContain("2 uncommitted");
  });
});

describe("V9 one seq is never two kinds", () => {
  const moment = (kind: KeyMoment["kind"], seq: number, over: Partial<KeyMoment> = {}): KeyMoment =>
    ({ kind, seq, text: `${kind} at ${seq}`, ...over } as KeyMoment);

  test("when both detectors fire on one seq the dead end stays and the breakthrough goes", () => {
    const kept = withoutDoubleLabelled([moment("deadend", 42), moment("breakthrough", 42), moment("breakthrough", 43)]);
    expect(kept.map((one) => `${one.kind}:${one.seq}`)).toEqual(["deadend:42", "breakthrough:43"]);
  });

  test("a helper's seq belongs to the helper's trace, and never collides with the parent's", () => {
    const kept = withoutDoubleLabelled([moment("deadend", 42), moment("breakthrough", 42, { via: "ab12cd" })]);
    expect(kept.length).toBe(2);
  });

});

describe("V9 the Lessons plan filter and the glossary", () => {
  test("a sentence about what someone is ABOUT to do is not a lesson", () => {
    for (const plan of [
      "I'll rerun the suite once the fix lands, because the last run was dirty.",
      "I will check the root cause after lunch.",
      "when it reports green, the problem was never the index",
      "Status after the fix: the cause was a stale cache.",
    ]) {
      expect(isPlanSentence(plan)).toBe(true);
      expect(hasCausalCue(plan)).toBe(false);
    }
    // …and a real lesson still is one
    expect(hasCausalCue("The problem was a stale cache, not the index.")).toBe(true);
  });

  test("the glossary folds casing, keeps the more frequent spelling, and `one` is no longer a definition determiner", () => {
    reset();
    const events = [
      cxUser("what is a row"),
      // `Row` once, `row` many times: one entry, spelled the way the session
      // mostly spelled it, with the counts added up
      cxAssistant("A row is an entry in the changelog that records one shipped change."),
      ...Array.from({ length: 9 }, () => cxUser("another row please")),
      cxUser("Row handling again"),
      // `gap` is defined by a sentence whose predicate opens on `one`: not a
      // definition, and no longer accepted as one
      cxAssistant("The gap is one we already knew about."),
      ...Array.from({ length: 9 }, () => cxUser("mind the gap")),
    ];
    const entries = glossaryEntries(piecesOf(events));
    const terms = entries.map((entry) => entry.term);
    expect(terms.filter((term) => term.toLowerCase() === "row").length).toBe(1);
    expect(terms).toContain("row");
    expect(terms).not.toContain("Row");
    expect(entries.find((entry) => entry.term === "row")!.turns).toBeGreaterThanOrEqual(10);
    expect(terms).not.toContain("gap");
  });
});


/* ================================================================== *
 * ROUND 1 — the three defects the real 38K-event session exposed
 * ================================================================== */

describe.each(SHAPES)("round 1 · the Do not section is the OWNER's, and it is bounded · $name shape", (shape) => {
  /**
   * The real shape that produced 164 entries and 24 KB: a main trace with a few
   * typed rules and a lot of noise, and a helper trace whose every "user" turn
   * is a delegating brief full of "Do NOT …".
   */
  function floodedTrace(): { events: CarafeEvent[]; helper: CarafeEvent[]; d: SessionDistillate } {
    reset();
    const events: CarafeEvent[] = [
      shape.user("build the lockdown", "2026-09-13T10:00:00Z"),
      shape.user("never push without asking me first", "2026-09-13T10:01:00Z"),
      // …and 150 more sentences that LOOK like prohibitions and are not the
      // owner typing a rule
      ...Array.from({ length: 50 }, (_, index) => shape.user(
        `<system-reminder>\nDo not edit file ${index}.ts without reading it first.\n</system-reminder>`,
        "2026-09-13T10:02:00Z")),
      ...Array.from({ length: 50 }, (_, index) => shape.user(
        `TASK: run the migration ${index}\nRULES: do not modify any file in src/closed/**\nCONTEXT: the branch is opus/fix`,
        "2026-09-13T10:03:00Z")),
      ...Array.from({ length: 50 }, (_, index) => shape.user(
        // a pasted review document: long, so not a typed rule
        `Review of wave ${index}\n${"Do not ship this as it stands. ".repeat(40)}`,
        "2026-09-13T10:04:00Z")),
      ...shape.call("bun test", "exit code 1\nFAIL", "2026-09-13T10:05:00Z"),
      shape.user("never talk to production chat to test it", "2026-09-13T10:06:00Z"),
      // …and ten assistant sentences that all state a rule with a cue
      ...Array.from({ length: 10 }, (_, index) => shape.assistant(
        `Never retry wave ${index} in place because it double-writes the ledger.`,
        "2026-09-13T10:07:00Z")),
      ...shape.filler(),
    ];
    reset();
    const helper: CarafeEvent[] = [
      shape.user("Do NOT deploy.", "2026-09-13T10:03:00Z"),
      shape.user("Do NOT edit any file.", "2026-09-13T10:03:30Z"),
      shape.assistant("understood", "2026-09-13T10:03:40Z"),
    ];
    return { events, helper, d: distillate(shape, events) };
  }

  test("a helper's delegating prompt is never the owner's word, and nothing is anchored outside the main trace", () => {
    const { events, helper, d } = floodedTrace();
    const { text } = renderHandoff(d, events, {
      now: NOW, target: "codex",
      helperTraces: [{ sessionId: "agent-ab12cd34", events: helper }],
    });
    const section = doNotSection(text);
    expect(section).not.toContain("Do NOT deploy.");
    expect(section).not.toContain("Do NOT edit any file.");
    // nor the briefs, the reminders or the pasted review
    expect(section).not.toContain("do not modify any file in src/closed");
    expect(section).not.toContain("without reading it first");
    expect(section).not.toContain("Do not ship this as it stands");
    // and never `[seq 0]`, which resolves to nothing at all
    expect(section).not.toContain("[seq 0]");
    // what DOES survive is what the owner typed
    expect(section).toContain("never push without asking me first");
    expect(section).toContain("never talk to production chat to test it");
  });

  test("the cap of eight is hard, and the whole section fits 2,500 characters", () => {
    const { events, helper, d } = floodedTrace();
    const { text } = renderHandoff(d, events, {
      now: NOW, target: "codex",
      helperTraces: [{ sessionId: "agent-ab12cd34", events: helper }],
    });
    const section = doNotSection(text);
    const rows = section.split("\n").filter((line) => line.startsWith("- "));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThanOrEqual(8);
    expect(section.length).toBeLessThanOrEqual(2_500);
    // …at most three of them are the assistant quoting its own rule
    expect(rows.filter((line) => line.includes("(the assistant's rule)")).length).toBeLessThanOrEqual(3);
  });

  test("a rule typed inside a 600-character message counts; one inside a longer message is a paste", () => {
    const short = "please never run the seeder against prod";
    expect(isProhibitionSentence(short, `context first. ${short}`)).toBe(true);
    expect(isProhibitionSentence(short, `${"x".repeat(700)} ${short}`)).toBe(false);
    // an injected turn is never the owner speaking, however short the sentence
    expect(isProhibitionSentence("Do NOT deploy.", "<system-reminder>Do NOT deploy.</system-reminder>")).toBe(false);
    expect(isProhibitionSentence("do not rebase", "TASK: git fetch origin\ndo not rebase")).toBe(false);
    expect(isInjectedTurn("RULES: do not modify any file in src/closed/**")).toBe(true);
    expect(isInjectedTurn("never push without asking me first")).toBe(false);
  });

  test("every anchor in the quoting sections resolves, in the main trace, to text containing the sentence", () => {
    const { events, helper, d } = floodedTrace();
    const { text } = renderHandoff(d, events, {
      now: NOW, target: "codex",
      helperTraces: [{ sessionId: "agent-ab12cd34", events: helper }],
    });
    const traceText = new Map<number, string>();
    for (const piece of preparedPieces(events, sessionId)) {
      traceText.set(piece.seq, `${traceText.get(piece.seq) ?? ""}\n${piece.lines.join("\n")}`);
    }
    for (const section of ["Do not", "Standing instructions", "Waiting on the owner"]) {
      const at = text.indexOf(`## ${section}`);
      if (at < 0) continue;
      const body = text.slice(at, at + 2 + text.slice(at + 2).indexOf("\n## "));
      for (const line of body.split("\n")) {
        const anchor = anchorOf(line);
        if (!anchor) continue;
        const found = traceText.get(anchor.seq);
        expect(found, `${section}: seq ${anchor.seq} is not in the main trace`).toBeDefined();
        expect(found!.replace(/\s+/g, " ")).toContain(anchor.text.slice(0, 40));
      }
    }
  });
});

/**
 * The sentence and the anchoring seq of one quoted line. The bench has the same
 * reader (`quotedAnchor`), and `src/handoff/**` may not import the bench — this
 * is the assertion made against the rendered file, not against the bench.
 */
function anchorOf(line: string): { text: string; seq: number } | null {
  if (!line.startsWith("- ")) return null;
  const anchors = [...line.matchAll(/\[(?:(agent-[0-9a-z]+) )?seq (\d+)[,\]]/g)];
  const last = anchors.at(-1);
  if (!last || last[1]) return null;
  const body = line.slice(2, last.index).trim();
  const quoted = /^"([\s\S]*)"/.exec(body);
  const text = (quoted?.[1] ?? body.replace(/\s*\([^)]*\)\s*$/, "")).replace(/\s+/g, " ").trim();
  return text ? { text, seq: Number(last[2]) } : null;
}

/** The Do not section of a rendered handoff, up to the next heading. */
function doNotSection(text: string): string {
  const at = text.indexOf("## Do not (the owner's prohibitions, verbatim)");
  if (at < 0) return "";
  return text.slice(at, at + 2 + text.slice(at + 2).indexOf("\n## "));
}

describe.each(SHAPES)("round 1 · every real push shape reaches the section · $name shape", (shape) => {
  const REPO = "/tmp/acme-api";
  const OTHER = "/tmp/acme-web";

  function pushShapes(): { events: CarafeEvent[]; helper: CarafeEvent[]; d: SessionDistillate } {
    reset();
    const events = [
      shape.user("ship everything", "2026-09-15T21:00:00Z"),
      // 1. the summary swallowed by `| tail -1`, inside an && chain after a cd
      ...shape.call(`cd "${REPO}" && bun test && git push origin main 2>&1 | tail -1`,
        "   940f646..c6834d0  main -> main", "2026-09-15T21:05:00Z"),
      // 2. `-q`: the command succeeded and printed nothing at all
      ...shape.call(`cd "${OTHER}" && git push -q origin main`, "", "2026-09-16T09:00:00Z"),
      // 3. `HEAD:main`, with the summary present
      ...shape.call(`git -C ${REPO} push origin HEAD:main`,
        "To github.invalid:x/y.git\n   c6834d0..ea249dd  HEAD -> main", "2026-09-16T10:00:00Z"),
      // 4. a push that FAILED is never listed, however quiet
      ...shape.call(`cd "${OTHER}" && git push origin main`,
        "error: failed to push some refs to 'github.invalid:x/y.git'", "2026-09-16T11:00:00Z"),
      // 5. a quiet push to a FEATURE branch is not main and is not listed
      ...shape.call(`cd "${REPO}" && git push -q origin opus/fix`, "", "2026-09-16T12:00:00Z"),
      ...shape.filler(),
    ];
    reset();
    const helper = [
      shape.user("push the backend", "2026-09-16T13:00:00Z"),
      ...shape.call(`cd "${REPO}" && git push -q origin main`, "", "2026-09-16T13:05:00Z"),
    ];
    return { events, helper, d: distillate(shape, events, { endTs: "2026-09-16T14:00:00Z" }) };
  }

  test("the summary line, the empty -q result and the HEAD:main refspec are all detected; a failure is not", () => {
    const { events } = pushShapes();
    const pushes = pushesFromTrace(events, piecesOf(events), { cwd: "/tmp/project" });
    expect(pushes.map((push) => `${basename(push.repo)}:${push.ref}:${push.hash ?? (push.noOutput ? "no-output" : "?")}`)).toEqual([
      "acme-api:main:c6834d0",
      "acme-web:main:no-output",
      "acme-api:main:ea249dd",
    ]);
    // the refspec reader, on its own
    expect(pushRefFromCommand("git push origin HEAD:main")).toBe("main");
    expect(pushRefFromCommand("git push -q -u origin main")).toBe("main");
    expect(pushRefFromCommand("git push origin refs/heads/master")).toBe("master");
    // `git push` with no refspec names no branch, so carafe says nothing
    expect(pushRefFromCommand("git push")).toBeNull();
    expect(pushRefFromCommand("git push origin")).toBeNull();
  });

  test("a helper's push is the session's push, labelled with the agent", () => {
    const { events, helper, d } = pushShapes();
    // round 8 — a push is filed under a repository only when git confirms the
    // ref and the pushed commit there; these two fixture repositories confirm them
    const confirming: GitRunner = (args, timeout) => args[0] === "-C" && [REPO, OTHER].includes(args[1]!) && args[2] === "rev-parse" && args.includes("--verify")
      ? "0".repeat(40) : realGitRunner(args, timeout);
    const { text } = renderHandoff(d, events, {
      now: NOW, target: "codex",
      helperTraces: [{ sessionId: "agent-ab12cd34", events: helper }],
      answerFacts: { git: confirming },
    });
    const at = text.indexOf("## What reached a remote, last 7 days (from the trace)");
    expect(at).toBeGreaterThan(-1);
    const section = text.slice(at, at + 2 + text.slice(at + 2).indexOf("\n## "));
    expect(section).toContain(`· ${REPO} · main · ea249dd`);
    expect(section).toContain(`· ${REPO} · main · c6834d0`);
    expect(section).toContain(`· ${OTHER} · main · push ran, no output captured`);
    expect(section).toContain("[agent-ab12cd34 seq ");
    // the failed push and the feature-branch push stay out
    expect(section).not.toContain("opus/fix");
    expect(section.split("\n").filter((line) => line.startsWith("- 2026-09-16 11:")).length).toBe(0);
  });

  test("a push whose directory nothing recorded is omitted rather than guessed", () => {
    reset();
    const events = [
      shape.user("push", "2026-09-16T10:00:00Z"),
      ...shape.call(`git push origin main`, "   1111111..2222222  main -> main", "2026-09-16T10:01:00Z"),
    ];
    // no cwd at all: nothing says which repository this was
    expect(pushesFromTrace(events, piecesOf(events), {})).toEqual([]);
  });
});

describe.each(SHAPES)("round 1 · the tail is reserved before any prefix section · $name shape", (shape) => {
  test("an oversized prefix gives way — Glossary, File map, Lessons, older chapters, Do not, What reached a remote — and the last turns still render", () => {
    reset();
    const events: CarafeEvent[] = [
      shape.user("build it", "2026-09-13T10:00:00Z"),
      shape.assistant("A row is an entry in the changelog that records one shipped change.", "2026-09-13T10:01:00Z"),
      // a prefix the sections will happily fill: many chapters, many rules,
      // many terms, many files
      ...Array.from({ length: 40 }, (_, index) => [
        shape.user(`never skip wave ${index}`, `2026-09-${String(13 + (index % 4)).padStart(2, "0")}T1${index % 10}:00:00Z`),
        shape.assistant(`The row failed because wave ${index} double-wrote the ledger.`, `2026-09-${String(13 + (index % 4)).padStart(2, "0")}T1${index % 10}:01:00Z`),
        ...shape.call(`bun test wave-${index}`, "exit code 1\nFAIL", `2026-09-${String(13 + (index % 4)).padStart(2, "0")}T1${index % 10}:02:00Z`),
      ]).flat(),
      ...Array.from({ length: 200 }, () => shape.assistant(`filler ${"x".repeat(1_000)}`, "2026-09-16T09:00:00Z")),
      // …and twelve real turns at the end, each big enough to matter
      ...Array.from({ length: 12 }, (_, index) => [
        shape.user(`do ${index}`, `2026-09-17T10:${String(index).padStart(2, "0")}:00Z`),
        shape.assistant(`Decided: wave ${index} ships behind the flag. ${"y".repeat(1_200)}`, `2026-09-17T10:${String(index).padStart(2, "0")}:30Z`),
      ]).flat(),
    ];
    const d = distillate(shape, events, { endTs: "2026-09-17T10:12:00Z" });
    const { text } = renderHandoff(d, events, { now: NOW, target: "codex" });

    expect(text.length).toBeLessThanOrEqual(HANDOFF_MAX_CHARS);
    const tail = text.slice(text.indexOf("## The tail, verbatim"));
    // the label and the body agree (round 9: the last working day, at most three turns)
    expect(tail).toContain(": the last 3 turns");
    expect(tail.split("\n").filter((line) => line.startsWith("**user:** do ")).length).toBe(3);
    // the prefix was held below the ceiling that leaves the tail its reserve
    expect(text.length - tail.length).toBeLessThanOrEqual(HANDOFF_MAX_CHARS - TAIL_FLOOR_CHARS);
  });

  test("the reserve is twelve turns at the adaptive floor, plus the framing", () => {
    expect(TAIL_FLOOR_CHARS).toBe(12 * 1_500 + 2_000);
  });
});

/* ================================================================== *
 * ROUND 2 — a prohibition is a clause, and the banner is said once
 * ================================================================== */

/** The eight sentences the real session judged this rule on. */
const CLAUSE_CASES: Array<{ who: "owner" | "assistant"; text: string; prohibition: boolean; why: string }> = [
  { who: "owner", prohibition: false, why: "a complaint: the word follows its subject",
    text: "i dont understand what the results from ox alpha are you never presented them" },
  { who: "owner", prohibition: false, why: "an instruction to CARRY ON: don't + stop",
    text: "ok kick off the rebuild and don't stop until the work is done and give codex as much to do as possible" },
  { who: "assistant", prohibition: false, why: "narration, and inside a parenthetical",
    text: "Health check done — one scare that turned out to be my own machine's DNS cache (production never blinked; all good)" },
  { who: "assistant", prohibition: false, why: "description: the word opens no sentence and sits in a parenthetical",
    text: "This is roughly a one-week build, not a patch — but it's the *last* rebuild, because the contract (code verifies, never speaks) structurally can't regress" },
  { who: "owner", prohibition: true, why: "the word opens the sentence",
    text: "NEVER IMPLEMENT ANYTHING YOURSELF UNLESS I EXPLICITLY SAY SO" },
  { who: "owner", prohibition: true, why: "the word opens the sentence",
    text: "do not do anything yourself use codex" },
  { who: "owner", prohibition: true, why: "the word opens a clause after the coordinator `and`",
    text: "ok follow that path BUT report back and do not go on any tangents on your own" },
  { who: "assistant", prohibition: true, why: "the word opens the sentence, and the sentence says why",
    text: "Never an impostor answer, because impostor answers are how the product got useless" },
];

describe("round 2 · a prohibition is an imperative clause, not a word", () => {
  test.each(CLAUSE_CASES)("$who: $why", ({ who, text, prohibition }) => {
    expect(isProhibitionSentence(text, text, who === "assistant")).toBe(prohibition);
  });

  test("the grammar, piece by piece", () => {
    // opens a clause: start, after a boundary, after a coordinator
    expect(opensClause("never push", 0)).toBe(true);
    expect(opensClause("report back, do not go on", 13)).toBe(true);
    expect(opensClause("report back and do not go on", 16)).toBe(true);
    expect(opensClause("you never presented them", 4)).toBe(false);
    expect(opensClause("production never blinked", 11)).toBe(false);
    // a parenthetical is somebody describing behaviour, not forbidding it
    expect(insideParenthetical("the contract (code verifies, never speaks) holds", 29)).toBe(true);
    expect(insideParenthetical("(closed) never ship this", 10)).toBe(false);
    // the encouragements
    for (const push of ["don't stop until it's done", "never hesitate to ask", "don't worry about the lint", "never give up on it"]) {
      expect(isProhibitionSentence(push)).toBe(false);
    }
    // …and `stop` inside `don't stop` is not a second chance at a match
    expect(prohibitionClause("and don't stop until the work is done")).toBeNull();
  });
});

describe.each(SHAPES)("round 2 · the eight sentences through a whole render · $name shape", (shape) => {
  test("the four prohibitions are quoted and the four non-prohibitions are not", () => {
    reset();
    const events: CarafeEvent[] = [
      shape.user("build it", "2026-09-13T10:00:00Z"),
      ...CLAUSE_CASES.flatMap(({ who, text }, index) => [
        who === "owner"
          ? shape.user(text, `2026-09-13T10:${String(index + 1).padStart(2, "0")}:00Z`)
          : shape.assistant(text, `2026-09-13T10:${String(index + 1).padStart(2, "0")}:00Z`),
      ]),
      ...shape.filler(),
    ];
    const d = distillate(shape, events);
    const { text } = renderHandoff(d, events, { now: NOW, target: "codex" });
    const section = doNotSection(text);
    for (const one of CLAUSE_CASES) {
      const present = section.includes(one.text.slice(0, 60));
      expect(present, `${one.why}: ${one.text.slice(0, 60)}`).toBe(one.prohibition);
    }
  });
});

describe("round 2 · the banner is said once", () => {
  test("the bench still requires it, and a two-URL file no longer stutters", () => {
    const rendered = liveLines(liveState([liveRepo({ path: "/tmp/p" })], {
      health: [
        { url: "https://one.example.invalid/health", body: null, error: null },
        { url: "https://two.example.invalid/health", body: null, error: null },
      ],
    })).join("\n");
    expect(rendered.split("carafe did not contact any service").length - 1).toBe(1);
    expect(rendered).toContain("  a person can allow this once per project: carafe live allow");
  });
});
