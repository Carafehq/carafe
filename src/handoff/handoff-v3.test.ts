/**
 * Handoff v3: the state right now, the questions waiting on the owner, a tail
 * that follows the principal work, the project's own log, fewer and fuller key
 * moments — and the two bugs (session search recency, one failure count).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { execFileSync } from "child_process";
import { tmpdir } from "os";
import { join } from "path";
import type { SessionDistillate } from "../format/distillate";
import type { CarafeEvent } from "../format/events";
import { cannotAnswer, detectOpenAsks, isAnswer, isAskSentence } from "../keymoments/asks";
import { chapterTitles, sessionChapters } from "../keymoments/chapters";
import { chapterHeadline } from "../keymoments/render";
import { buildBlocks } from "./blocks";
import { extractPieces, isSelfGenerationLine } from "./pieces";
import { isAgentStateWorkspace, isExcludedWorkspace, workspaceKey } from "../query/sessions";
import { goalText, preparedPieces, renderHandoff, reposWorkedIn, tailSegments, turnBelonging, worktreesOf } from "./render";
import { absolutePath, commandSegments, expandCommandVars, workspaceOf, worktreesFromCommands } from "./worktrees";
import { branchFromSwitch, healthFromTrace, stateFromTrace } from "./state";

const sessionId = "handoff-v3-fixture";

function distillate(events: CarafeEvent[], over: Partial<SessionDistillate> = {}): SessionDistillate {
  return {
    tool: "codex", sessionId, sourcePath: "/tmp/session.jsonl", title: "handoff v3 fixture",
    cwd: "/tmp/project", gitBranch: "feat/test", startTs: "2026-01-01T10:00:00Z", endTs: "2026-01-01T11:00:00Z",
    eventCount: events.length, toolUseCount: events.filter((event) => event.kind === "tool_use").length,
    sidechain: false, rawBytes: 10, version: 1, ...over,
  };
}

let seq = 0;
function event(kind: string, payload: Record<string, unknown>, ts = "2026-01-01T10:30:00Z"): CarafeEvent {
  return { ts, tool: "codex", sessionId, seq: ++seq, kind, raw: { payload } };
}
const user = (message: string, ts?: string): CarafeEvent => event("user", { message }, ts);
const assistant = (message: string, ts?: string): CarafeEvent => event("assistant", { message }, ts);
const call = (command: string, output: string, ts?: string): CarafeEvent[] => [
  event("tool_use", { name: "Bash", arguments: { command } }, ts),
  event("tool_result", { output }, ts),
];
const edit = (path: string): CarafeEvent[] => [
  event("tool_use", { name: "Edit", arguments: { file_path: path } }),
  event("tool_result", { output: "ok" }),
];
const filler = (count = 240): CarafeEvent[] => Array.from({ length: count }, () => assistant(`filler ${"x".repeat(1_000)}`));

const piecesOf = (events: CarafeEvent[]) => extractPieces(events, {}, {});
const render = (events: CarafeEvent[], over: Partial<SessionDistillate> = {}, opts = {}) =>
  renderHandoff(distillate(events, over), events, { now: "2026-02-01T00:00:00Z", target: "codex", ...opts }).text;

describe("W1 right now", () => {
  const repo = "/w/project";

  test("each command shape is parsed into the last observation of its kind", () => {
    seq = 0;
    const events = [
      ...call(`git -C ${repo} branch --show-current`, "feat/exporter"),
      ...call(`git -C ${repo} log -1 --oneline`, "a1b2c3d streaming writer: never buffer"),
      ...call(`git -C ${repo} status --porcelain`, " M src/a.ts\n M LEDGER.md\n?? notes.txt"),
      ...call(`git -C ${repo} branch -vv`, "* feat/exporter a1b2c3d [origin/feat/exporter: ahead 2, behind 1] writer"),
      ...call(`git -C ${repo} ls-remote origin refs/heads/main`, "9f8e7d6c5b4a39281706f5e4d3c2b1a098765432\trefs/heads/main"),
    ];
    const [state] = stateFromTrace(events, piecesOf(events), { cwd: repo });
    expect(state!.path).toBe(repo);
    expect(state!.branch!.value).toBe("feat/exporter");
    expect(state!.head!.value).toEqual({ hash: "a1b2c3d", subject: "streaming writer: never buffer" });
    expect(state!.dirty!.value).toBe(3);
    expect(state!.tracking!.value).toEqual({ ahead: 2, behind: 1 });
    expect(state!.remote!.value.branch).toBe("main");
  });

  test("`On branch X`, a bare rev-parse, a push and a rejected push are readings too", () => {
    seq = 0;
    const events = [
      ...call(`git -C ${repo} status`, "On branch main\nnothing to commit"),
      ...call(`git -C ${repo} rev-parse HEAD`, "0123456789abcdef0123456789abcdef01234567"),
      ...call(`git -C ${repo} push origin feat/one`, "To github.com:x/y.git\n * [new branch]      feat/one -> feat/one"),
    ];
    const [pushed] = stateFromTrace(events, piecesOf(events), { cwd: repo });
    expect(pushed!.branch!.value).toBe("main");
    expect(pushed!.head!.value.hash).toBe("0123456789abcdef0123456789abcdef01234567");
    expect(pushed!.pushed!.value).toBe("feat/one");
    expect(pushed!.rejected).toBeUndefined();

    seq = 0;
    const refusedEvents = call(`git -C ${repo} push origin feat/one`, " ! [rejected]        feat/one -> feat/one (non-fast-forward)");
    const refused = stateFromTrace(refusedEvents, piecesOf(refusedEvents), { cwd: repo });
    expect(refused[0]!.rejected!.value).toBe("feat/one");
    expect(refused[0]!.pushed).toBeUndefined();
  });

  test("a repository path with spaces is one repository", () => {
    seq = 0;
    const spaced = "/w/my project";
    const spacedEvents = call(`git -C "${spaced}" branch --show-current`, "feat/spaces");
    const states = stateFromTrace(spacedEvents, piecesOf(spacedEvents), { cwd: "/w/elsewhere" });
    expect(states.map((state) => state.path)).toEqual([spaced]);
    expect(states[0]!.branch!.value).toBe("feat/spaces");
  });

  test("the last health probe is the one reported", () => {
    seq = 0;
    const events = [
      ...call("curl -s http://localhost:4319/health", '{"ok":false}'),
      ...call("curl -s http://localhost:4319/health", '{"ok":true,"sessions":3916}'),
      ...call("curl -s http://example.com/index.html", "<html>"),
    ];
    const health = healthFromTrace(events, piecesOf(events))!;
    expect(health.url).toBe("http://localhost:4319/health");
    expect(health.body).toBe('{"ok":true,"sessions":3916}');
  });

  test("the section renders the repo block, the health line and the regenerate hint", () => {
    seq = 0;
    const work = mkdtempSync(join(tmpdir(), "carafe-v3-repo-"));
    mkdirSync(join(work, ".git"), { recursive: true });
    try {
      const events = [
        user("go"),
        ...edit(join(work, "src/a.ts")),
        ...call(`git -C "${work}" branch --show-current`, "feat/exporter"),
        ...call(`git -C "${work}" log -1 --oneline`, "a1b2c3d the streaming writer"),
        ...call(`git -C "${work}" status --porcelain`, " M src/a.ts"),
        ...call("curl -s http://localhost:4319/health", '{"ok":true}'),
        ...filler(),
      ];
      const text = render(events, { cwd: work, endTs: "2026-01-01T11:00:00Z" });
      const section = text.slice(text.indexOf("## Last seen in the session"), text.indexOf("## Notes"));
      expect(section).toContain(`- ${work}`);
      expect(section).toContain(`branch feat/exporter · HEAD a1b2c3d "the streaming writer" · 1 uncommitted`);
      expect(section).toContain("- health: http://localhost:4319/health → {\"ok\":true}");
      expect(section).toContain(`regenerate with: carafe handoff ${sessionId}`);
      expect(text.indexOf("## Last seen in the session")).toBeLessThan(text.indexOf("## Notes"));
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  test("a reading more than a day older than the session's end is marked old", () => {
    seq = 0;
    const events = [...call("git -C /w/project branch --show-current", "feat/old", "2026-01-01T09:00:00Z")];
    const [state] = stateFromTrace(events, piecesOf(events), { cwd: "/w/project" });
    const text = render([user("go"), ...events, ...filler()], { cwd: "/w/project", endTs: "2026-01-03T10:00:00Z" });
    expect(state!.branch!.value).toBe("feat/old");
    expect(text).toContain("branch feat/old (old)");
  });
});

describe("W2 waiting on the owner", () => {
  const ask = "Should I park the retry wrapper for good, or keep a flag for it?";

  test("an answer token closes an ask", () => {
    expect(isAnswer(ask, "**user:** yes")).toBe(true);
    expect(isAnswer(ask, "**user:** Option B.")).toBe(true);
    expect(isAnswer(ask, "**user:** 2")).toBe(true);
  });

  test("a turn sharing a content word closes an ask", () => {
    expect(isAnswer(ask, "**user:** keep the wrapper, we will need it")).toBe(true);
  });

  test("an unrelated turn leaves the ask open, and the section lists it", () => {
    expect(isAnswer(ask, "**user:** let me think about that")).toBe(false);
    seq = 0;
    const events = [
      user("go"),
      assistant("Working."),
      user("and the ledger"),
      assistant(`Ledger updated. ${ask}\n1. Delete the wrapper\n2. Keep the flag, default off`),
      user("let me think about that"),
      assistant("Sure. While you think — do you want the export batched at 10k rows or 50k?"),
      ...filler(),
    ];
    const open = detectOpenAsks(events, piecesOf(events));
    // the whole paragraph, not the bare sentence
    // the asking sentence and the one before it — never the option lines
    expect(open[0]!.text).toBe("Ledger updated. Should I park the retry wrapper for good, or keep a flag for it?");
    expect(open[1]!.text).toContain("do you want the export batched at 10k rows or 50k?");
    expect(open[0]!.options).toEqual(["1. Delete the wrapper", "2. Keep the flag, default off"]);
    const text = render(events);
    const section = text.slice(text.indexOf("## Waiting on the owner"), text.indexOf("## Notes"));
    // newest first, options under the ask they belong to
    expect(section.indexOf("10k rows")).toBeLessThan(section.indexOf(ask));
    expect(section).toContain("  1. Delete the wrapper");
  });

  test("an answered ask is never listed", () => {
    seq = 0;
    const events = [
      user("go"),
      assistant("Working."),
      user("now push"),
      assistant("Shall I push the branch?"),
      user("yes"),
      assistant("Pushed."),
      ...filler(),
    ];
    expect(detectOpenAsks(events, piecesOf(events))).toEqual([]);
    expect(render(events)).not.toContain("## Waiting on the owner");
  });
});

describe("W3 the tail follows the principal work", () => {
  let workspace = "";
  let main = "";
  let other = "";
  // three more repositories, so `other` is the FIFTH by tool calls and the only
  // one outside the header's `repos:` line
  let alsoPrincipal: string[] = [];
  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "carafe-v3-main-"));
    main = join(workspace, "main"); other = join(workspace, "other");
    alsoPrincipal = [0, 1, 2].map((i) => join(workspace, `also-${i}`));
    for (const dir of [main, other, ...alsoPrincipal]) mkdirSync(join(dir, ".git"), { recursive: true });
  });
  afterEach(() => rmSync(workspace, { recursive: true, force: true }));

  const principalTurns = (count: number): CarafeEvent[] =>
    Array.from({ length: count }, (_, index) => [user(`principal ${index}`), assistant(`On it ${index}.`), ...edit(join(main, `src/file-${index}.ts`))]).flat();
  /** work in the other header repositories, ranked above the tangent */
  const supporting = (): CarafeEvent[] =>
    alsoPrincipal.flatMap((repo, repoIndex) =>
      [user(`support ${repoIndex}`), ...Array.from({ length: 6 }, (_, index) => edit(join(repo, `src/s-${index}.ts`))).flat()]);

  test("a session whose last turns touch another repo hands over the principal tail", () => {
    seq = 0;
    const events = [
      user("build the exporter"),
      ...supporting(),
      ...filler(),
      ...principalTurns(14),
      user("quick detour: fix the docs site"),
      ...edit(join(other, "site/build.ts")),
      user("try again"),
      ...edit(join(other, "site/theme.ts")),
      user("leave it"),
      ...edit(join(other, "site/build.ts")),
      assistant("PUSH REJECTED — NOTHING SHIPPED"),
    ];
    const text = render(events, { cwd: main });
    const tail = text.slice(text.indexOf("## The tail, verbatim"));
    expect(tail).toContain(`Tangent after seq`);
    expect(tail).toContain(`touched ${other}`);
    expect(tail).toContain("· 3 turns ·");
    expect(tail).not.toContain("PUSH REJECTED");
    expect(tail).toContain("principal 13");
  });

  test("a one-turn tangent says one turn", () => {
    seq = 0;
    const events = [
      user("build the exporter"),
      ...supporting(),
      ...filler(),
      ...principalTurns(13),
      user("one quick look at the docs site"),
      ...edit(join(other, "site/build.ts")),
      assistant("Left alone."),
    ];
    const text = render(events, { cwd: main });
    expect(text.slice(text.indexOf("## The tail, verbatim"))).toContain("· 1 turn · touched");
  });

  test("a run of three tangent turns inside the tail becomes one line", () => {
    seq = 0;
    const events = [
      user("build the exporter"),
      ...supporting(),
      ...principalTurns(10),
      ...filler(),
      user("detour one"),
      ...edit(join(other, "site/a.ts")),
      user("detour two"),
      ...edit(join(other, "site/b.ts")),
      user("detour three"),
      ...edit(join(other, "site/c.ts")),
      user("back to the exporter"),
      assistant("Resuming."),
      ...edit(join(main, "src/last.ts")),
      assistant("Done with the exporter."),
    ];
    const text = render(events, { cwd: main });
    const tail = text.slice(text.indexOf("## The tail, verbatim"));
    expect(tail).toContain("detour one");
    expect(tail).not.toContain("detour two");
    expect(tail).not.toContain("detour three");
    expect(tail).toContain("Done with the exporter.");
  });

  test("the tail ends on the assistant's last words, never on a tool result", () => {
    seq = 0;
    const events = [
      user("build the exporter"),
      ...supporting(),
      ...principalTurns(12),
      ...filler(),
      user("one more"),
      assistant("The join now keys on (order_id, line_no)."),
      ...edit(join(main, "src/join.ts")),
    ];
    const text = render(events, { cwd: main });
    const tail = text.slice(text.indexOf("## The tail, verbatim"), text.indexOf("\n## Dig deeper")).trimEnd();
    expect(tail).toContain("The join now keys on (order_id, line_no).");
    expect(tail.split("\n").at(-1)).toMatch(/^_\(last observed at seq \d+; check Right now above before acting on it\)_$/);
    expect(tail).not.toContain("src/join.ts\"}");
  });

  test("a turn in the second-ranked repository, plus /tmp, belongs", () => {
    seq = 0;
    const events = [
      user("go"),
      ...supporting(),
      ...principalTurns(3),
      user("check the frontend"),
      ...call(`cd "${alsoPrincipal[0]}" && git show HEAD:src/page.tsx > /tmp/ce.tsx; grep -n "state" /tmp/ce.tsx`, "42: const [state]"),
      assistant("Two product questions for you. Should the two loading states ship together?"),
    ];
    const pieces = piecesOf(events);
    const blocks = buildBlocks(events, pieces);
    const { belongs, principal } = turnBelonging(events, pieces, blocks, main);
    expect(principal).toContain(alsoPrincipal[0]!);
    expect(belongs.at(-1)).toBe(true);
    const open = detectOpenAsks(events, pieces, undefined, { belongs, endTs: "2026-01-01T11:00:00Z" });
    expect(open.map((moment) => moment.text).join(" ")).toContain("Should the two loading states ship together?");
  });

  test("turns with no repository of their own belong to the principal work", () => {
    seq = 0;
    const events = [user("go"), ...principalTurns(2), user("run the tests"), ...call("bun test", "12 pass")];
    const pieces = piecesOf(events);
    const blocks = buildBlocks(events, pieces);
    const { belongs, principal } = turnBelonging(events, pieces, blocks, main);
    expect(principal).toEqual([main]);
    expect(belongs.at(-1)).toBe(true);
    const segments = tailSegments(distillate(events, { cwd: main }), events, pieces, blocks);
    expect(segments.every((segment) => segment.kind === "turn")).toBe(true);
  });
});

describe("W4 the project's own log", () => {
  test("the most touched markdown file is quoted as it was last seen", () => {
    seq = 0;
    const repo = mkdtempSync(join(tmpdir(), "carafe-v3-ledger-"));
    mkdirSync(join(repo, ".git"), { recursive: true });
    const ledger = join(repo, "LEDGER.md");
    try {
      const events = [
        user("write the ledger"),
        ...call(`cat ${ledger}`, "# Ledger\n1. old entry"),
        ...edit(ledger),
        ...call(`tail -20 ${ledger}`, "# Ledger\n1. old entry\n2. the orders join keys on (order_id, line_no)"),
        ...edit(ledger),
        ...filler(),
      ];
      const text = render(events, { cwd: repo });
      const section = text.slice(text.indexOf("## LEDGER.md, as last seen"));
      expect(section).toContain("> 2. the orders join keys on (order_id, line_no)");
      expect(section).not.toContain("> ok");
      expect(section).toContain(`carafe show ${sessionId} --seq`);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("no sighting of its content, no section", () => {
    seq = 0;
    const repo = mkdtempSync(join(tmpdir(), "carafe-v3-noledger-"));
    mkdirSync(join(repo, ".git"), { recursive: true });
    try {
      const events = [user("write the ledger"), ...edit(join(repo, "LEDGER.md")), ...filler()];
      expect(render(events, { cwd: repo })).not.toContain("as last seen");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe("W5 fewer, fuller key moments", () => {
  test("older chapters collapse to one retrievable line; the last eight stay whole", () => {
    seq = 0;
    const events: CarafeEvent[] = [user("go")];
    for (let index = 0; index < 100; index++) {
      events.push(user(`work item ${index}`), assistant(`Working. ${"detail ".repeat(400)}`), ...edit(`/w/project/src/file-${index}.ts`));
    }
    const text = render(events, { cwd: "/w/project" });
    const moments = text.slice(text.indexOf("## Key moments"), text.indexOf("## Lessons"));
    const headings = moments.split("\n").filter((line) => line.startsWith("### Ch "));
    const collapsed = headings.filter((line) => line.includes("carafe chapters "));
    // round 8 — a collapsed chapter is a heading with nothing under it: it is
    // not printed (the chapter list in Dig deeper retrieves every chapter)
    expect(collapsed.length).toBe(0);
    expect(headings.length).toBeGreaterThan(0);
    expect(headings.length).toBeLessThanOrEqual(8);
    expect(text).toMatch(/^Ch \d+ · \d{4}-\d{2}-\d{2} → \d{4}-\d{2}-\d{2} · .* · carafe chapters /m);

    // v5: the standalone chapter directory is gone — it repeated every
    // collapsed header verbatim. The last chapter's turn lines live under that
    // chapter's own moments now.
    expect(text).not.toContain("## Directory of the session");
    const lastChapter = moments.slice(moments.lastIndexOf("### Ch "));
    expect(lastChapter).toContain("  turns:");
    expect(lastChapter.split("\n").filter((line) => line.startsWith("  - [seq ")).length).toBeGreaterThan(0);
  });

  test("a steering moment's text is capped at 300 characters in the handoff only", () => {
    seq = 0;
    const long = `please ${"reconsider the exporter ".repeat(40)}`;
    const events = [user("go"), user(long), assistant("Understood."), ...filler()];
    const text = render(events);
    const line = text.split("\n").find((candidate) => candidate.startsWith("- steering: please reconsider"))!;
    expect(line).toContain("…");
    expect(line.length).toBeLessThan(340);
  });
});

describe("W6 two bugs", () => {
  test("`carafe chapters` and the handoff count the same failures", async () => {
    seq = 0;
    const repo = "/w/project";
    const events: CarafeEvent[] = [user("go"), ...filler()];
    for (let index = 0; index < 40; index++) {
      events.push(user(`work ${index}`), assistant("Working."), ...edit(`${repo}/src/file-${index}.ts`));
    }
    for (const failure of ["error TS2307: Cannot find module './theme'\nexited with code 1", "AssertionError: expected 3 to be 4", "npm ERR! build failed"]) {
      events.push(...call(`cd ${repo} && bun run build`, failure));
    }
    events.push(user("hand it over"), assistant("Ready."));
    const cliChapters = sessionChapters(events, preparedPieces(events, sessionId));
    const totalFailures = cliChapters.reduce((sum, chapter) => sum + chapter.failures, 0);
    expect(totalFailures).toBe(3);
    const text = render(events, { cwd: repo });
    // the handoff's headline carries a W3 title; every other field is the same
    const titles = chapterTitles(events, preparedPieces(events, sessionId), cliChapters, buildBlocks(events, preparedPieces(events, sessionId)));
    for (const chapter of cliChapters) {
      if (!chapter.failures) continue;
      expect(text).toContain(chapterHeadline(chapter, "###", titles.get(chapter.index)));
      expect(chapterHeadline(chapter, "###", titles.get(chapter.index))).toContain(chapterHeadline(chapter).replace("### Ch " + chapter.index, ""));
    }
  });

  test("session search ranks the later of two equally matching blocks first", async () => {
    const root = mkdtempSync(join(tmpdir(), "carafe-v3-store-"));
    const previous = process.env.CARAFE_HOME;
    process.env.CARAFE_HOME = root;
    try {
      seq = 0;
      const { CarafeStore } = await import("../format/store");
      const { SessionIndex } = await import("../search/session-index");
      const events = [
        user("the exporter join keeps dropping rows"),
        assistant("Looking at it."),
        ...Array.from({ length: 30 }, (_, index) => [user(`unrelated ${index}`), assistant(`noted ${index}`)]).flat(),
        user("the exporter join keeps dropping rows"),
        assistant("Looking again."),
      ];
      const store = new CarafeStore(root);
      const { sealSession } = await import("../format/sessions");
      const { writeDistillate } = await import("../format/distillate");
      const d = distillate(events, { sessionId: "search-recency" });
      sealSession(store, d.tool, d.sessionId, events);
      writeDistillate(store, d);
      const index = new SessionIndex(store, d);
      index.reindex();
      const hits = index.search("exporter join dropping");
      index.close();
      expect(hits.length).toBeGreaterThanOrEqual(2);
      expect(hits[0]!.startSeq).toBeGreaterThan(hits[1]!.startSeq);
    } finally {
      if (previous === undefined) delete process.env.CARAFE_HOME;
      else process.env.CARAFE_HOME = previous;
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("R1 a worktree reached through a shell variable is the repository's work", () => {
  test("same-command assignments are substituted; no environment is guessed", () => {
    expect(expandCommandVars(`S="/w/scratch"; cd "$S/wt-be4" && git status`)).toBe(`S="/w/scratch"; cd "/w/scratch/wt-be4" && git status`);
    expect(expandCommandVars(`S=/w/scratch; cd ${"${S}"}/wt && ls`)).toBe(`S=/w/scratch; cd /w/scratch/wt && ls`);
    // a variable this command never set stays exactly as written
    expect(expandCommandVars(`cd "$HOME/secret" && ls`)).toBe(`cd "$HOME/secret" && ls`);
  });

  test("`git worktree add` teaches the trace which repository a scratch path belongs to", () => {
    const repo = mkdtempSync(join(tmpdir(), "carafe-v3-wt-repo-"));
    mkdirSync(join(repo, ".git"), { recursive: true });
    const scratch = "/private/tmp/claude-501/session/scratchpad";
    try {
      const commands = [`cd "${repo}" && git worktree add "${scratch}/wt-be4" abc1234`];
      const map = worktreesFromCommands(commands);
      expect(map.get(`${scratch}/wt-be4`)).toBe(repo);
      expect(isExcludedWorkspace(workspaceKey(`${scratch}/wt-be4`)!)).toBe(true);
      expect(workspaceOf(`${scratch}/wt-be4/src`, map)).toBe(repo);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("Right now reports the worktree's readings under the repository", () => {
    seq = 0;
    const repo = mkdtempSync(join(tmpdir(), "carafe-v3-wt-main-"));
    mkdirSync(join(repo, ".git"), { recursive: true });
    const scratch = "/private/tmp/claude-501/session/scratchpad";
    try {
      const events = [
        user("set up a worktree and finish there"),
        ...call(`cd "${repo}" && git worktree add "${scratch}/wt-be4" abc1234`, "Preparing worktree (detached HEAD abc1234)"),
        ...call(`S="${scratch}"; cd "$S/wt-be4" && git status`, "On branch feat/worktree\nnothing to commit"),
        ...call(`S="${scratch}"; cd "$S/wt-be4" && git branch -vv`, "* feat/worktree abc1234 [origin/feat/worktree: ahead 3] the worktree work"),
        ...call(`S="${scratch}"; cd "$S/wt-be4" && git status --porcelain`, " M src/api.ts\n M src/db.ts"),
        ...filler(),
      ];
      const text = render(events, { cwd: scratch });
      const section = text.slice(text.indexOf("## Last seen in the session"), text.indexOf("## Notes"));
      expect(section).toContain(`- ${repo}`);
      expect(section).toContain("branch feat/worktree");
      expect(section).toContain("3 ahead / 0 behind");
      expect(section).toContain("2 uncommitted");
      expect(section).not.toContain(scratch);
      // and the worktree's calls count as work in that repository
      expect(reposWorkedIn(events, piecesOf(events), scratch).map((entry) => entry.path)).toEqual([repo]);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe("R2 a result belongs to its own call", () => {
  const cc = (seqNumber: number, content: unknown[]): CarafeEvent =>
    ({ ts: "2026-01-01T10:30:00Z", tool: "claude-code", sessionId, seq: seqNumber, kind: "assistant", raw: { message: { content } } });

  test("the health line is the body the curl itself received, bound by tool_use_id", () => {
    const events: CarafeEvent[] = [
      cc(1, [{ type: "tool_use", id: "call_a", name: "Bash", input: { command: "curl -s https://api-edge.example.com/health" } }]),
      cc(2, [{ type: "tool_use", id: "call_b", name: "Bash", input: { command: "cat REVIEW.md" } }]),
      // the results arrive out of order, as a sidechain or a queued call can make them
      cc(3, [{ type: "tool_result", tool_use_id: "call_b", content: "rook: done # Rook review 11 ## Defects" }]),
      cc(4, [{ type: "tool_result", tool_use_id: "call_a", content: '{"status":"ok","version":"2.1"}' }]),
    ];
    const health = healthFromTrace(events, piecesOf(events))!;
    expect(health.url).toBe("https://api-edge.example.com/health");
    expect(health.body).toBe('{"status":"ok","version":"2.1"}');
  });

  test("a body that is not an answer from a health endpoint omits the line entirely", () => {
    const events: CarafeEvent[] = [
      cc(1, [{ type: "tool_use", id: "call_a", name: "Bash", input: { command: "curl -s https://api-edge.example.com/health" } }]),
      cc(2, [{ type: "tool_result", tool_use_id: "call_a", content: "rook: done # Rook review 11" }]),
    ];
    expect(healthFromTrace(events, piecesOf(events))).toBe(null);
  });

  test("a URL inside a heredoc is not a probe", () => {
    seq = 0;
    const events = call("cat <<'EOF' > note.md\nsee https://api.example.com/health for the check\nEOF", "ok");
    expect(healthFromTrace(events, piecesOf(events))).toBe(null);
  });

  test("git readings are bound by id too", () => {
    const events: CarafeEvent[] = [
      cc(1, [{ type: "tool_use", id: "g1", name: "Bash", input: { command: "git -C /w/project branch --show-current" } }]),
      cc(2, [{ type: "tool_use", id: "g2", name: "Bash", input: { command: "cat NOTES.md" } }]),
      cc(3, [{ type: "tool_result", tool_use_id: "g2", content: "feat/not-a-branch-reading" }]),
      cc(4, [{ type: "tool_result", tool_use_id: "g1", content: "feat/real" }]),
    ];
    const [state] = stateFromTrace(events, piecesOf(events), { cwd: "/w/project" });
    expect(state!.branch!.value).toBe("feat/real");
  });
});

describe("R3 the right ask, in the right window, from the right turn", () => {
  test("an ask without a question mark, 40 turns back, asked before a handoff request, stays open", () => {
    seq = 0;
    const askParagraph = "The two loading states overlap with the spec work, so would you like to have Rook spec them as one piece of work, or keep the loading states separate since it's mostly frontend and could go sooner.";
    const events: CarafeEvent[] = [user("start"), ...filler()];
    events.push(user("what about the loading states"), assistant(askParagraph));
    for (let index = 0; index < 40; index++) events.push(user(`follow up ${index}`), assistant(`Noted ${index}.`));
    events.push(user("hand this off: give me two handoffs, one for each repo"), assistant("Preparing both."));
    const open = detectOpenAsks(events, piecesOf(events), undefined, { endTs: "2026-01-01T11:00:00Z" });
    expect(open.map((moment) => moment.text)).toContain(askParagraph);
  });

  test("a turn asking for a handoff or a brief, or a recap request, never answers an ask", () => {
    expect(cannotAnswer("**user:** hand this off to codex")).toBe(true);
    expect(cannotAnswer("**user:** give me two handoffs")).toBe(true);
    expect(cannotAnswer("**user:** write the brief for codex")).toBe(true);
    expect(cannotAnswer("**user:** where are we?")).toBe(true);
    expect(cannotAnswer("**user:** keep them separate")).toBe(false);
  });

  test("question-less openings are asks; a tangent's ask is not listed", () => {
    expect(isAskSentence("Would you like me to spec them as one piece of work, or keep them separate.")).toBe(true);
    expect(isAskSentence("Should I park the wrapper.")).toBe(true);
    expect(isAskSentence("I will now run the tests.")).toBe(false);

    seq = 0;
    const main = mkdtempSync(join(tmpdir(), "carafe-v3-ask-main-"));
    const other = mkdtempSync(join(tmpdir(), "carafe-v3-ask-other-"));
    const also = [0, 1, 2].map(() => mkdtempSync(join(tmpdir(), "carafe-v3-ask-also-")));
    for (const dir of [main, other, ...also]) mkdirSync(join(dir, ".git"), { recursive: true });
    try {
      const events: CarafeEvent[] = [user("build the exporter")];
      for (const [repoIndex, repo] of also.entries()) {
        events.push(user(`support ${repoIndex}`));
        for (let index = 0; index < 6; index++) events.push(...edit(join(repo, `src/s-${index}.ts`)));
      }
      events.push(...filler());
      for (let index = 0; index < 12; index++) {
        events.push(user(`principal ${index}`), assistant(`On it ${index}.`), ...edit(join(main, `src/file-${index}.ts`)));
      }
      events.push(user("detour: the docs site"), ...edit(join(other, "site/build.ts")), assistant("I can fix the theme import. Want me to?"));
      const pieces = piecesOf(events);
      const blocks = buildBlocks(events, pieces);
      const { belongs } = turnBelonging(events, pieces, blocks, main);
      const open = detectOpenAsks(events, pieces, undefined, { belongs, endTs: "2026-01-01T11:00:00Z" });
      expect(open.map((moment) => moment.text)).not.toContain("I can fix the theme import. Want me to?");
      const text = render(events, { cwd: main });
      expect(text).not.toContain("Want me to?");
    } finally {
      for (const dir of [main, other, ...also]) rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("R4 a tool result in the tail is preformatted, never markdown", () => {
  test("a review document's headings cannot become sections of the handoff", () => {
    seq = 0;
    const repo = mkdtempSync(join(tmpdir(), "carafe-v3-doc-"));
    mkdirSync(join(repo, ".git"), { recursive: true });
    try {
      const review = "# Rook review 11\n## Defects\n- one\n## Decisions\n- two\n## Notes\n- three";
      const events = [
        user("read the review"),
        ...filler(),
        ...edit(join(repo, "src/a.ts")),
        user("show me the review"),
        ...call(`cat ${join(repo, "REVIEW.md")}`, review),
        assistant("Read it."),
      ];
      const text = render(events, { cwd: repo });
      const tail = text.slice(text.indexOf("## The tail, verbatim"), text.indexOf("\n## Dig deeper"));
      expect(tail).toContain("    ## Defects");
      expect(tail).toContain("    ## Decisions");
      // no line of a quoted document is a heading of this file
      expect(tail.split("\n").filter((line) => /^#{1,6} /.test(line))).toEqual([/^## The tail, verbatim \([^)]*\)/.exec(tail)![0]]);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe("R5 a worktree the trace never created is never dropped", () => {
  const scratch = "/private/tmp/claude-501/helper-session/scratchpad";

  test("a branch a known repository knows attributes the worktree to it", () => {
    seq = 0;
    const repo = mkdtempSync(join(tmpdir(), "carafe-v3-known-"));
    mkdirSync(join(repo, ".git"), { recursive: true });
    try {
      const events = [
        user("continue in the worktree the helper made"),
        ...call(`git -C "${repo}" ls-remote --heads origin`, "9f8e7d6c5b4a39281706f5e4d3c2b1a098765432\trefs/heads/opus/row42-null-guard\n1111111111111111111111111111111111111111\trefs/heads/main"),
        ...call(`S="${scratch}"; cd "$S/wt-be4" && git rev-parse --abbrev-ref HEAD`, "opus/row42-null-guard"),
        ...call(`S="${scratch}"; cd "$S/wt-be4" && git log --oneline -1`, "4f2a1b9 guard row 42 against the missing null check"),
        ...call(`S="${scratch}"; cd "$S/wt-be4" && git status --porcelain`, " M src/guard.ts\n?? notes.md"),
        ...filler(),
      ];
      const states = stateFromTrace(events, piecesOf(events), { cwd: scratch });
      expect(states).toHaveLength(1);
      expect(states[0]!.path).toBe(repo);
      expect(states[0]!.attributed).not.toBe(false);
      expect(states[0]!.branch!.value).toBe("opus/row42-null-guard");
      expect(states[0]!.head!.value.hash).toBe("4f2a1b9");
      expect(states[0]!.dirty!.value).toBe(2);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("a worktree on a branch nobody else has is reported under its own path", () => {
    seq = 0;
    const repo = mkdtempSync(join(tmpdir(), "carafe-v3-known2-"));
    mkdirSync(join(repo, ".git"), { recursive: true });
    try {
      const events = [
        user("two worktrees"),
        ...edit(join(repo, "src/a.ts")),
        ...call(`git -C "${repo}" branch --show-current`, "main"),
        ...call(`S="${scratch}"; cd "$S/wt-unknown" && git checkout -q -B nobody/knows-this origin/main`, "Switched to a new branch 'nobody/knows-this'"),
        ...call(`S="${scratch}"; cd "$S/wt-unknown" && git rev-parse --abbrev-ref HEAD`, "nobody/knows-this"),
        ...call(`S="${scratch}"; cd "$S/wt-unknown" && git status --porcelain`, " M src/x.ts"),
        ...filler(),
      ];
      const states = stateFromTrace(events, piecesOf(events), { cwd: repo, repos: [repo] });
      expect(states.map((state) => state.path)).toEqual([repo, `${scratch}/wt-unknown`]);
      expect(states[1]!.attributed).toBe(false);
      expect(states[1]!.branch!.value).toBe("nobody/knows-this");

      const text = render(events, { cwd: repo });
      const section = text.slice(text.indexOf("## Last seen in the session"), text.indexOf("## Notes"));
      expect(section).toContain(`- worktree ${scratch}/wt-unknown (repository not recorded in this trace)`);
      expect(section).toContain("branch nobody/knows-this");
      expect(section).toContain("1 uncommitted");
      // the named repository still comes first
      expect(section.indexOf(`- ${repo}`)).toBeLessThan(section.indexOf("- worktree "));
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("an old health probe and an old push are marked old", () => {
    seq = 0;
    // round 8 — a push is filed under a repository only when the branch
    // resolves there: the fixture repository really has feat/one
    const root = mkdtempSync(join(tmpdir(), "carafe v3 push "));
    const repo = join(root, "the project");
    mkdirSync(repo);
    const git = (...args: string[]): string => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
    try {
      git("init", "-q", "-b", "main");
      git("commit", "-q", "--allow-empty", "-m", "first");
      git("branch", "feat/one");
      const events = [
        user("go"),
        ...call(`git -C "${repo}" push origin feat/one`, " * [new branch]      feat/one -> feat/one", "2026-01-01T09:00:00Z"),
        ...call("curl -s http://localhost:4319/health", '{"ok":true}', "2026-01-01T09:00:00Z"),
        ...filler(),
      ];
      const text = render(events, { cwd: repo, endTs: "2026-01-04T10:00:00Z" });
      expect(text).toContain("pushed: feat/one (old)");
      expect(text).toContain('{"ok":true} (old)');
      // the same push filed under a repository that has no such branch is dropped
      const other = render([user("go"), ...call(`git -C "${repo}" push origin feat/nowhere`, " * [new branch]      feat/nowhere -> feat/nowhere", "2026-01-01T09:00:00Z"), ...filler()], { cwd: repo, endTs: "2026-01-04T10:00:00Z" });
      expect(other).not.toContain("pushed: feat/nowhere");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("R6 the ask window and the list rule", () => {
  const hoursAgo = (hours: number): string => new Date(Date.parse("2026-01-05T12:00:00Z") - hours * 3_600_000).toISOString();

  test("72 hours back is in the window; eight days back is not", () => {
    seq = 0;
    const events: CarafeEvent[] = [
      user("start", hoursAgo(200)),
      assistant("Should I delete the legacy exporter?", hoursAgo(200)),
    ];
    for (let index = 0; index < 20; index++) events.push(user(`middle ${index}`, hoursAgo(190 - index)), assistant(`Noted ${index}.`, hoursAgo(190 - index)));
    events.push(user("recent work", hoursAgo(10)), assistant("Should I keep the retry wrapper for the nightly job?", hoursAgo(10)));
    events.push(user("no idea yet", hoursAgo(9)));
    const open = detectOpenAsks(events, piecesOf(events), undefined, { endTs: hoursAgo(0) });
    const texts = open.map((moment) => moment.text).join(" | ");
    expect(texts).toContain("retry wrapper for the nightly job");
    expect(texts).not.toContain("legacy exporter");
  });

  test("the last ten turns are in the window however old they are", () => {
    seq = 0;
    const events: CarafeEvent[] = [user("start", hoursAgo(400)), assistant("Working.", hoursAgo(400))];
    for (let index = 0; index < 4; index++) events.push(user(`old ${index}`, hoursAgo(390 - index)), assistant(`Noted ${index}.`, hoursAgo(390 - index)));
    events.push(user("last thing", hoursAgo(380)), assistant("Should I tag the release now?", hoursAgo(380)));
    const open = detectOpenAsks(events, piecesOf(events), undefined, { endTs: hoursAgo(0) });
    expect(open.map((moment) => moment.text).join(" ")).toContain("Should I tag the release now?");
  });

  test("a paragraph of bullets is a report, not a question", () => {
    seq = 0;
    const report = "- **/beta** opens on the landing: your hero, your nav, your footer\n- **/** behaves the same for you\n- **/pricing** is unchanged for your team";
    const events = [user("what did you change"), assistant(report), user("thanks"), assistant("Done."), ...filler()];
    const open = detectOpenAsks(events, piecesOf(events), undefined, { endTs: "2026-01-01T11:00:00Z" });
    expect(open.map((moment) => moment.text).join(" ")).not.toContain("/beta");
  });
});

describe("R7 the agent's own state is not a repository", () => {
  const home = process.env.HOME ?? "/nonexistent-home";
  const memory = `${home}/.claude/projects/-Users-x-project/memory`;

  test("agent-state paths are recognised, and are neither excluded nor repositories", () => {
    for (const key of [`${home}/.claude`, memory, `${home}/.codex/sessions`, `${home}/.agents/x`, `${home}/.carafe/handoffs`, "/w/project/.claude/skills"]) {
      expect(isAgentStateWorkspace(key)).toBe(true);
      expect(isExcludedWorkspace(key)).toBe(false);
    }
    expect(isAgentStateWorkspace("/w/project/src")).toBe(false);
  });

  test("a closing run that only reads the agent's memory is a tangent, its ask is dropped, and the tail ends before it", () => {
    seq = 0;
    const main = mkdtempSync(join(tmpdir(), "carafe-v3-agentstate-"));
    mkdirSync(join(main, ".git"), { recursive: true });
    try {
      const events: CarafeEvent[] = [user("build the exporter"), ...filler()];
      for (let index = 0; index < 12; index++) {
        events.push(user(`principal ${index}`), assistant(`On it ${index}.`), ...edit(join(main, `src/file-${index}.ts`)));
      }
      events.push(assistant("The exporter is done."));
      for (let index = 0; index < 3; index++) {
        events.push(user(`what did we write down ${index}`), ...call(`cat ${memory}/carafe-state.md`, "# state\n- notes"));
      }
      events.push(assistant("There's one running called `carafe-5d`. Want me to?"));

      const pieces = piecesOf(events);
      const blocks = buildBlocks(events, pieces);
      const { belongs, principal } = turnBelonging(events, pieces, blocks, main);
      expect(principal).toEqual([main]);
      expect(belongs.at(-1)).toBe(false);

      const text = render(events, { cwd: main });
      expect(text).not.toContain(`${memory} (`);
      expect(reposWorkedIn(events, pieces, main).map((entry) => entry.path)).toEqual([main]);
      const open = detectOpenAsks(events, pieces, undefined, { belongs, endTs: "2026-01-01T11:00:00Z" });
      expect(open.map((moment) => moment.text).join(" ")).not.toContain("carafe-5d");
      const tail = text.slice(text.indexOf("## The tail, verbatim"));
      expect(tail).toContain("The exporter is done.");
      expect(tail).toContain("Tangent after seq");
      expect(tail).not.toContain("carafe-5d");
    } finally {
      rmSync(main, { recursive: true, force: true });
    }
  });
});

describe("R8 compound git commands are observations too", () => {
  const scratch = "/private/tmp/claude-501/helper/scratchpad";

  test("a checkout that creates a branch, and a log --oneline, give branch and HEAD", () => {
    seq = 0;
    const repo = mkdtempSync(join(tmpdir(), "carafe-v3-compound-"));
    mkdirSync(join(repo, ".git"), { recursive: true });
    try {
      const events = [
        user("carry on in the helper's worktree"),
        ...call(`git -C "${repo}" ls-remote --heads origin`, "9f8e7d6c5b4a39281706f5e4d3c2b1a098765432\trefs/heads/opus/row42-null-guard"),
        ...call(`S="${scratch}"; cd "$S/wt-be4" && git fetch -q origin && git checkout -q -B opus/row42-null-guard origin/main && echo "branch from $(git rev-parse --abbrev-ref HEAD)"`,
          "branch from opus/row42-null-guard"),
        ...call(`S="${scratch}"; cd "$S/wt-be4" && echo "branch: $(git rev-parse --abbrev-ref HEAD) at $(git rev-parse --short HEAD)" && git log --oneline 66eeb58..HEAD`,
          "branch: opus/row42-null-guard at 4f2a1b9\n4f2a1b9 guard row 42 against the missing null check\n66eeb58 earlier work"),
        ...filler(),
      ];
      const states = stateFromTrace(events, piecesOf(events), { cwd: scratch });
      expect(states).toHaveLength(1);
      expect(states[0]!.path).toBe(repo);
      expect(states[0]!.branch!.value).toBe("opus/row42-null-guard");
      expect(states[0]!.head!.value).toEqual({ hash: "4f2a1b9", subject: "guard row 42 against the missing null check" });

      const text = render(events, { cwd: scratch });
      expect(text).toContain(`branch opus/row42-null-guard · HEAD 4f2a1b9 "guard row 42 against the missing null check"`);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("a fetch result on its own says nothing", () => {
    seq = 0;
    const events = call(`git -C /w/project fetch -q origin`, "From github.com:x/y\n * branch   main -> FETCH_HEAD");
    expect(stateFromTrace(events, piecesOf(events), { cwd: "/w/project" })).toEqual([]);
  });

  test("branchFromSwitch reads the branch the command creates", () => {
    expect(branchFromSwitch("git checkout -q -B opus/row42 origin/main")).toBe("opus/row42");
    expect(branchFromSwitch("git switch -c feat/new")).toBe("feat/new");
    expect(branchFromSwitch("git checkout main")).toBe(null);
  });
});

describe("R9 the tail opens on the owner's turn", () => {
  test("a budget cut that lands mid-turn is trimmed forward to the next user turn", () => {
    seq = 0;
    const repo = mkdtempSync(join(tmpdir(), "carafe-v3-boundary-"));
    mkdirSync(join(repo, ".git"), { recursive: true });
    try {
      const events: CarafeEvent[] = [user("build it"), ...filler()];
      for (let index = 0; index < 12; index++) {
        events.push(user(`turn ${index}`), assistant(`All five seams are clear ${index}. ${"detail ".repeat(9_000)}`), ...edit(join(repo, `src/f-${index}.ts`)));
      }
      const text = render(events, { cwd: repo });
      const tail = text.slice(text.indexOf("## The tail, verbatim"));
      // round 9: each turn carries its date on the line above it
      const [dateLine = "", firstBodyLine = ""] = tail.split("\n").filter((line) => line.trim()).slice(1);
      expect(dateLine).toMatch(/^_\d{4}-\d\d-\d\d \d\d:\d\d UTC(?: → [^·]+)? · seq \d+(?:–\d+)?_$/);
      expect(firstBodyLine).toStartWith("**user:**");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe("R10 parsing never depends on the rendered line's 400-character clip", () => {
  const scratch = "/private/tmp/claude-501/helper/scratchpad";
  const padding = `echo "${"pad ".repeat(300)}"`;

  test("a git checkout and a git log past character 400 still give branch and HEAD", () => {
    seq = 0;
    const repo = mkdtempSync(join(tmpdir(), "carafe-v3-clip-"));
    mkdirSync(join(repo, ".git"), { recursive: true });
    try {
      const long = `S="${scratch}"; cd "$S/wt-be4" && ${padding} && git fetch -q origin && git checkout -q -B opus/row42-null-guard origin/main && git log --oneline 66eeb58..HEAD`;
      expect(long.length).toBeGreaterThan(1_200);
      const events = [
        user("carry on"),
        ...call(`git -C "${repo}" ls-remote --heads origin`, "9f8e7d6c5b4a39281706f5e4d3c2b1a098765432\trefs/heads/opus/row42-null-guard"),
        ...call(long, "4f2a1b9 guard row 42 against the missing null check\n66eeb58 earlier"),
      ];
      const pieces = piecesOf(events);
      // the rendered line really is clipped — the parser must not be reading it
      const rendered = pieces.flatMap((piece) => piece.lines).find((line) => line.startsWith("→ **Bash**") && line.includes("wt-be4"))!;
      expect(rendered).not.toContain("git checkout");
      expect(rendered).toContain("more chars");

      const states = stateFromTrace(events, pieces, { cwd: scratch });
      expect(states).toHaveLength(1);
      expect(states[0]!.path).toBe(repo);
      expect(states[0]!.branch!.value).toBe("opus/row42-null-guard");
      expect(states[0]!.head!.value).toEqual({ hash: "4f2a1b9", subject: "guard row 42 against the missing null check" });
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("a `-C <path>` past character 400 still counts as work in that repository", () => {
    seq = 0;
    const repo = mkdtempSync(join(tmpdir(), "carafe-v3-clip2-"));
    mkdirSync(join(repo, ".git"), { recursive: true });
    try {
      const long = `${padding} && git -C "${repo}" status --porcelain`;
      expect(long.length).toBeGreaterThan(400);
      const events = [user("look"), ...call(long, " M src/a.ts")];
      const pieces = piecesOf(events);
      expect(pieces.flatMap((piece) => piece.lines).find((line) => line.startsWith("→ **Bash**"))).not.toContain(repo);
      expect(reposWorkedIn(events, pieces).map((entry) => entry.path)).toEqual([repo]);
      expect(stateFromTrace(events, pieces, { cwd: "/w/elsewhere" })[0]!.dirty!.value).toBe(1);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("a health probe past the clip is still a probe, and a worktree add past it is still learned", () => {
    seq = 0;
    const repo = mkdtempSync(join(tmpdir(), "carafe-v3-clip3-"));
    mkdirSync(join(repo, ".git"), { recursive: true });
    try {
      const probe = `${padding} && curl -s https://api.example.com/health`;
      const added = `${padding} && cd "${repo}" && git worktree add "${scratch}/wt-late" abc1234`;
      const events = [
        user("check"),
        ...call(probe, '{"ok":true}'),
        ...call(added, "Preparing worktree"),
        ...call(`S="${scratch}"; cd "$S/wt-late" && git status --porcelain`, " M src/x.ts"),
      ];
      const pieces = piecesOf(events);
      expect(healthFromTrace(events, pieces)!.url).toBe("https://api.example.com/health");
      expect(worktreesOf(events).get(`${scratch}/wt-late`)).toBe(repo);
      const states = stateFromTrace(events, pieces, { cwd: scratch, worktrees: worktreesOf(events) });
      expect(states.map((state) => state.path)).toEqual([repo]);
      expect(states[0]!.dirty!.value).toBe(1);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe("R11 a long tool call is not mistaken for this handoff's own making", () => {
  test("the clip marker names the session, and must not delete the call that carries it", () => {
    seq = 0;
    const long = `cd /w/project && ${`echo "${"pad ".repeat(300)}"`} && git status --porcelain`;
    const events = [user("look"), ...call(long, " M src/a.ts")];
    const rendered = piecesOf(events).flatMap((piece) => piece.lines).find((line) => line.startsWith("→ **Bash**"))!;
    // the marker really is there, and really does name this session
    expect(rendered).toContain(`carafe show ${sessionId} --seq`);
    expect(isSelfGenerationLine(rendered, sessionId)).toBe(false);
    // a real generation call is still recognised
    expect(isSelfGenerationLine(`→ **Bash** {"command":"carafe handoff ${sessionId} --to codex"}`, sessionId)).toBe(true);

    const kept = preparedPieces(events, sessionId).flatMap((piece) => piece.lines);
    expect(kept.some((line) => line.startsWith("→ **Bash**"))).toBe(true);
    expect(kept.some((line) => line.trimStart().startsWith("⤷"))).toBe(true);
  });
});

describe("R12 helper sessions hold the latest observations", () => {
  test("a helper's git reading appears under the repository, marked via helper", () => {
    seq = 0;
    const repo = mkdtempSync(join(tmpdir(), "carafe-v3-helper-"));
    mkdirSync(join(repo, ".git"), { recursive: true });
    try {
      // the parent only DESCRIBES the work: the git commands live in prose
      const parent = [
        user("have the helpers finish the guard"),
        ...edit(join(repo, "src/a.ts")),
        assistant("Dispatching an agent to run `git -C <repo> branch --show-current` in the worktree."),
        ...filler(),
      ];
      const parentD = distillate(parent, { cwd: repo, endTs: "2026-01-01T11:00:00Z" });

      // the helper's own trace holds the tool call
      seq = 0;
      const helperEvents = [
        user("finish the guard"),
        ...call(`git -C "${repo}" branch --show-current`, "opus/row42-null-guard", "2026-01-01T10:59:00Z"),
        ...call(`git -C "${repo}" status --porcelain`, " M src/guard.ts\n M src/a.ts", "2026-01-01T10:59:30Z"),
      ].map((event) => ({ ...event, sessionId: "agent-1a2b3c4d-helper" }));

      const text = renderHandoff(parentD, parent, {
        now: "2026-02-01T00:00:00Z",
        target: "codex",
        helperTraces: [{ sessionId: "agent-1a2b3c4d-helper", events: helperEvents }],
      }).text;
      const section = text.slice(text.indexOf("## Last seen in the session"), text.indexOf("## Notes"));
      expect(section).toContain(`- ${repo}`);
      expect(section).toContain("branch opus/row42-null-guard");
      expect(section).toContain("2 uncommitted");
      expect(section).toContain("via helper agent-1a");
      // without the helper there is nothing to report at all
      const alone = renderHandoff(parentD, parent, { now: "2026-02-01T00:00:00Z", target: "codex" }).text;
      expect(alone).not.toContain("opus/row42-null-guard");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("the parent's own newer reading wins over an older helper's", () => {
    seq = 0;
    const repo = "/w/project";
    const parent = [user("go"), ...call(`git -C ${repo} branch --show-current`, "feat/parent-latest", "2026-01-01T12:00:00Z"), ...filler()];
    seq = 0;
    const helper = [...call(`git -C ${repo} branch --show-current`, "feat/older-helper", "2026-01-01T09:00:00Z")]
      .map((event) => ({ ...event, sessionId: "agent-9999-helper" }));
    const text = renderHandoff(distillate(parent, { cwd: repo, endTs: "2026-01-01T12:30:00Z" }), parent, {
      now: "2026-02-01T00:00:00Z", target: "codex", helperTraces: [{ sessionId: "agent-9999-helper", events: helper }],
    }).text;
    expect(text).toContain("branch feat/parent-latest");
    expect(text).not.toContain("feat/older-helper");
  });

  test("helperSessionsOf folds the agent sessions of this session's cwd and window", async () => {
    const root = mkdtempSync(join(tmpdir(), "carafe-v3-store-h-"));
    const repo = mkdtempSync(join(tmpdir(), "carafe-v3-repo-h-"));
    mkdirSync(join(repo, ".git"), { recursive: true });
    const previous = process.env.CARAFE_HOME;
    process.env.CARAFE_HOME = root;
    try {
      const { CarafeStore } = await import("../format/store");
      const { sealSession } = await import("../format/sessions");
      const { writeDistillate } = await import("../format/distillate");
      const { helperSessionsOf } = await import("../query/sessions");
      const store = new CarafeStore(root);
      const seed = (id: string, over: Partial<SessionDistillate>): void => {
        seq = 0;
        const events = [user("work")].map((event) => ({ ...event, sessionId: id }));
        const seeded = distillate(events, { sessionId: id, ...over });
        sealSession(store, seeded.tool, seeded.sessionId, events);
        writeDistillate(store, seeded);
      };
      const window = { cwd: repo, startTs: "2026-01-01T10:00:00Z", endTs: "2026-01-01T12:00:00Z" };
      seed("parent-0001", window);
      seed("agent-inside", { ...window, startTs: "2026-01-01T10:30:00Z", endTs: "2026-01-01T11:00:00Z", sidechain: true });
      seed("agent-elsewhere", { ...window, cwd: "/tmp/other-place", sidechain: true });
      seed("agent-later", { cwd: repo, startTs: "2026-02-01T10:00:00Z", endTs: "2026-02-01T11:00:00Z", sidechain: true });
      seed("plain-sibling", window);
      const parent = distillate([], { sessionId: "parent-0001", ...window });
      expect(helperSessionsOf(store, parent).map((helper) => helper.sessionId)).toEqual(["agent-inside"]);
    } finally {
      if (previous === undefined) delete process.env.CARAFE_HOME;
      else process.env.CARAFE_HOME = previous;
      for (const dir of [root, repo]) rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("R13 a relative path is not a workspace", () => {
  test("`-C .` and `cd src` resolve against the session cwd, or are dropped", () => {
    const repo = mkdtempSync(join(tmpdir(), "carafe-v3-rel-"));
    mkdirSync(join(repo, ".git"), { recursive: true });
    try {
      expect(absolutePath(".", repo)).toBe(repo);
      expect(absolutePath("src/x", repo)).toBe(join(repo, "src/x"));
      expect(absolutePath(".", null)).toBe(null);
      expect(absolutePath("$S/wt", repo)).toBe(null);
      expect(absolutePath("-", repo)).toBe(null);

      seq = 0;
      const events = [user("go"), ...call("git -C . status --porcelain", " M src/a.ts"), ...call("cd . && bun test", "ok")];
      const pieces = piecesOf(events);
      expect(reposWorkedIn(events, pieces, repo).map((entry) => entry.path)).toEqual([repo]);
      // with no cwd to resolve against, a relative path is nobody's workspace
      expect(reposWorkedIn(events, pieces, null).map((entry) => entry.path)).toEqual([]);
      expect(reposWorkedIn(events, pieces, null).some((entry) => entry.path === ".")).toBe(false);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe("R14 the tail ends where the session turned away", () => {
  test("path-less chat after a tangent is out, and the tangent line counts it", () => {
    seq = 0;
    const main = mkdtempSync(join(tmpdir(), "carafe-v3-endmain-"));
    mkdirSync(join(main, ".git"), { recursive: true });
    const memory = `${process.env.HOME ?? "/nonexistent-home"}/.claude/projects/-Users-x-p/memory`;
    try {
      const events: CarafeEvent[] = [user("build it"), ...filler()];
      for (let index = 0; index < 12; index++) {
        events.push(user(`principal ${index}`), assistant(`On it ${index}.`), ...edit(join(main, `src/f-${index}.ts`)));
      }
      events.push(assistant("The exporter is done."));
      // the turn away: a memory read, then five turns of chat that name no path
      events.push(user("what did we note about the desktop app"), ...call(`cat ${memory}/notes.md`, "# notes"));
      for (let index = 0; index < 5; index++) {
        events.push(user(`chat ${index}`), assistant(`About the desktop app ${index}.`), ...call("echo hello", "hello"));
      }
      const pieces = piecesOf(events);
      const blocks = buildBlocks(events, pieces);
      const { belongs } = turnBelonging(events, pieces, blocks, main);
      expect(belongs.slice(-6).every((value) => value === false)).toBe(true);

      const text = render(events, { cwd: main });
      const tail = text.slice(text.indexOf("## The tail, verbatim"));
      expect(tail).toContain("The exporter is done.");
      expect(tail).not.toContain("About the desktop app");
      expect(tail).toContain("· 6 turns · touched");
    } finally {
      rmSync(main, { recursive: true, force: true });
    }
  });

  test("path-less turns after the principal work, with no tangent, still belong", () => {
    seq = 0;
    const main = mkdtempSync(join(tmpdir(), "carafe-v3-endmain2-"));
    mkdirSync(join(main, ".git"), { recursive: true });
    try {
      const events: CarafeEvent[] = [user("build it"), ...filler()];
      for (let index = 0; index < 12; index++) {
        events.push(user(`principal ${index}`), assistant(`On it ${index}.`), ...edit(join(main, `src/f-${index}.ts`)));
      }
      events.push(user("run the tests once more"), ...call("bun test", "12 pass"), assistant("All green."));
      const text = render(events, { cwd: main });
      const tail = text.slice(text.indexOf("## The tail, verbatim"));
      expect(tail).toContain("All green.");
      expect(tail).not.toContain("Tangent after seq");
    } finally {
      rmSync(main, { recursive: true, force: true });
    }
  });
});

describe("R15 a newline is a command separator, and a reading belongs to the nearest cd", () => {
  test("a three-line command yields one reading per repository", () => {
    seq = 0;
    const a = mkdtempSync(join(tmpdir(), "carafe-v3-two-a-"));
    const b = mkdtempSync(join(tmpdir(), "carafe-v3-two-b-"));
    for (const dir of [a, b]) mkdirSync(join(dir, ".git"), { recursive: true });
    try {
      const command = [
        `cd "${a}"`,
        "git log --oneline 4be825d..origin/main -- src/state",
        `cd "${b}"`,
        "git status --porcelain",
      ].join("\n");
      const events = [user("look at both"), ...call(command, "4be825d Release 0.1.0\n M src/one.ts\n M src/two.ts")];
      const states = stateFromTrace(events, piecesOf(events), { cwd: "/w/session" });
      const byPath = new Map(states.map((state) => [state.path, state]));
      expect(byPath.get(a)!.head!.value.hash).toBe("4be825d");
      expect(byPath.get(a)!.dirty).toBeUndefined();
      expect(byPath.get(b)!.dirty!.value).toBe(3);
      expect(byPath.get(b)!.head).toBeUndefined();
      // and the session's own cwd is never credited with either reading
      expect(states.some((state) => state.path === "/w/session")).toBe(false);
    } finally {
      for (const dir of [a, b]) rmSync(dir, { recursive: true, force: true });
    }
  });

  test("segments carry the directory in force, and escaped spaces are one path", () => {
    const segments = commandSegments(`cd /w/New\\ project/carafe && git log -1`, "/w/session");
    expect(segments.map((segment) => segment.dir)).toEqual(["/w/New project/carafe", "/w/New project/carafe"]);
    const lines = commandSegments("cd /w/a\ngit status\ncd /w/b\ngit status", "/w/session");
    expect(lines.filter((segment) => segment.text.startsWith("git")).map((segment) => segment.dir)).toEqual(["/w/a", "/w/b"]);
    // `-C` names a directory for its own command and does not move the shell
    const dashC = commandSegments(`cd /w/a && git -C /w/b status && git log -1`, "/w/session");
    expect(dashC.map((segment) => segment.dir)).toEqual(["/w/a", "/w/b", "/w/a"]);
  });

  test("a `cd` with an escaped space is attributed to that repository, not the session cwd", () => {
    seq = 0;
    const events = [user("go"), ...call(`cd /w/New\\ project/carafe\ngit log --oneline -1`, "4be825d Release 0.1.0")];
    const states = stateFromTrace(events, piecesOf(events), { cwd: "/w/acme-backend" });
    expect(states.map((state) => state.path)).toEqual(["/w/New project/carafe"]);
    expect(states[0]!.head!.value.subject).toBe("Release 0.1.0");
  });
});

describe("R16 helpers are matched by workspace", () => {
  test("a helper in a worktree of the parent's repository is a helper; one elsewhere is not", async () => {
    const root = mkdtempSync(join(tmpdir(), "carafe-v3-store-w-"));
    const repo = mkdtempSync(join(tmpdir(), "carafe-v3-repo-w-"));
    const elsewhere = mkdtempSync(join(tmpdir(), "carafe-v3-elsewhere-"));
    mkdirSync(join(repo, ".git", "worktrees", "wt-one"), { recursive: true });
    mkdirSync(join(elsewhere, ".git"), { recursive: true });
    // the desktop app's shape: a real worktree directory pointing back at the repo
    const worktree = join(repo, ".claude", "worktrees", "wt-one");
    mkdirSync(worktree, { recursive: true });
    writeFileSync(join(worktree, ".git"), `gitdir: ${repo}/.git/worktrees/wt-one\n`);
    const previous = process.env.CARAFE_HOME;
    process.env.CARAFE_HOME = root;
    try {
      const { CarafeStore } = await import("../format/store");
      const { sealSession } = await import("../format/sessions");
      const { writeDistillate } = await import("../format/distillate");
      const { helperSessionsOf, workspaceKey } = await import("../query/sessions");
      expect(workspaceKey(worktree)).toBe(repo);
      const store = new CarafeStore(root);
      const seed = (id: string, over: Partial<SessionDistillate>): void => {
        seq = 0;
        const events = [user("work")].map((event) => ({ ...event, sessionId: id }));
        const seeded = distillate(events, { sessionId: id, ...over });
        sealSession(store, seeded.tool, seeded.sessionId, events);
        writeDistillate(store, seeded);
      };
      const window = { startTs: "2026-01-01T10:00:00Z", endTs: "2026-01-01T12:00:00Z" };
      seed("parent-0001", { cwd: repo, ...window });
      seed("agent-in-worktree", { cwd: worktree, sidechain: true, startTs: "2026-01-01T10:30:00Z", endTs: "2026-01-01T11:00:00Z" });
      seed("agent-in-another-repo", { cwd: elsewhere, sidechain: true, ...window });
      const parent = distillate([], { sessionId: "parent-0001", cwd: repo, ...window });
      expect(helperSessionsOf(store, parent).map((helper) => helper.sessionId)).toEqual(["agent-in-worktree"]);
      // a principal key the parent worked in counts as its workspace too
      seed("agent-in-principal", { cwd: elsewhere, sidechain: true, startTs: "2026-01-01T10:15:00Z", endTs: "2026-01-01T10:45:00Z" });
      const withPrincipal = helperSessionsOf(store, parent, undefined, [elsewhere]).map((helper) => helper.sessionId).sort();
      expect(withPrincipal).toContain("agent-in-principal");
      expect(withPrincipal).toContain("agent-in-worktree");
    } finally {
      if (previous === undefined) delete process.env.CARAFE_HOME;
      else process.env.CARAFE_HOME = previous;
      for (const dir of [root, repo, elsewhere]) rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("R17 an unresolvable cd makes the directory unknown, never the session cwd", () => {
  const loop = `for R in "$HOME/Work/side project/carafe" "$HOME/Work/side project/coffee-cli"; do echo "== $R"; cd "$R" || continue; git log --oneline -1 --date=short; done`;

  test("the loop's readings are discarded, and a later plain command still attributes", () => {
    seq = 0;
    const cwd = "/Users/k/Acme Work Repos/acme-backend";
    const events = [
      user("check both carafe repos"),
      ...call(loop, "== /Users/k/Work/side project/carafe\n4be825d Release 0.1.0"),
      ...call("git status --porcelain", " M src/api.ts"),
    ];
    const states = stateFromTrace(events, piecesOf(events), { cwd });
    expect(states.map((state) => state.path)).toEqual([cwd]);
    // the loop gave nothing at all; the plain command still counts
    expect(states[0]!.head).toBeUndefined();
    expect(states[0]!.dirty!.value).toBe(1);
  });

  test("segment directories go unknown at an unresolvable cd and recover at the next one", () => {
    const segments = commandSegments(`cd /w/a && git log -1 ; cd "$R" ; git status ; cd /w/b ; git status --porcelain`, "/w/session");
    expect(segments.map((segment) => segment.dir)).toEqual(["/w/a", "/w/a", null, null, "/w/b", "/w/b"]);
    // `~` and a relative path with no cwd are unresolvable too
    expect(commandSegments("cd ~/project ; git status", "/w/session").at(-1)!.dir).toBe(null);
    expect(commandSegments("cd src ; git status", null).at(-1)!.dir).toBe(null);
    // an absolute `-C` still names its own directory inside an unknown stretch
    expect(commandSegments(`cd "$R" ; git -C /w/known status`, "/w/session").at(-1)!.dir).toBe("/w/known");
  });

  test("a `for` body is segmented like anything else", () => {
    const segments = commandSegments(loop, "/w/session");
    expect(segments.some((segment) => segment.text.startsWith("git log"))).toBe(true);
    expect(segments.filter((segment) => segment.text.startsWith("git")).every((segment) => segment.dir === null)).toBe(true);
  });
});

describe("R18 a reading is filed only where it was taken", () => {
  test("a helper's reading in the frontend directory never reaches the backend line", () => {
    seq = 0;
    const backend = mkdtempSync(join(tmpdir(), "carafe-v3-be-"));
    const frontend = mkdtempSync(join(tmpdir(), "carafe-v3-fe-"));
    for (const dir of [backend, frontend]) mkdirSync(join(dir, ".git"), { recursive: true });
    try {
      const parent = [user("both services"), ...edit(join(backend, "src/api.ts")), ...edit(join(frontend, "src/page.tsx")), ...filler()];
      const parentD = distillate(parent, { cwd: backend, endTs: "2026-01-01T11:00:00Z" });
      seq = 0;
      const helper = [
        ...call(`git -C "${frontend}" rev-parse HEAD`, "b25746ed5aa1c0ffee0123456789abcdef012345", "2026-01-01T10:59:00Z"),
        ...call(`git -C "${backend}" rev-parse HEAD`, "0959ebf0000000000000000000000000000000aa", "2026-01-01T10:58:00Z"),
      ].map((event) => ({ ...event, sessionId: "agent-a9b8c7d6-helper" }));
      const text = renderHandoff(parentD, parent, {
        now: "2026-02-01T00:00:00Z", target: "codex",
        helperTraces: [{ sessionId: "agent-a9b8c7d6-helper", events: helper }],
      }).text;
      const section = text.slice(text.indexOf("## Last seen in the session"), text.indexOf("## Notes"));
      const backendBlock = section.slice(section.indexOf(`- ${backend}`), section.indexOf(`- ${frontend}`) > 0 ? section.indexOf(`- ${frontend}`) : undefined);
      expect(backendBlock).toContain("0959ebf");
      expect(backendBlock).not.toContain("b25746e");
      expect(section.slice(section.indexOf(`- ${frontend}`))).toContain("b25746e");
    } finally {
      for (const dir of [backend, frontend]) rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a branch two repositories both list is never used to attribute a checkout", () => {
    seq = 0;
    const one = mkdtempSync(join(tmpdir(), "carafe-v3-one-"));
    const two = mkdtempSync(join(tmpdir(), "carafe-v3-two-"));
    for (const dir of [one, two]) mkdirSync(join(dir, ".git"), { recursive: true });
    const scratch = "/private/tmp/claude-501/helper/scratchpad";
    try {
      const shared = "9f8e7d6c5b4a39281706f5e4d3c2b1a098765432\trefs/heads/shared/work";
      const events = [
        user("two repos, one branch name"),
        ...call(`git -C "${one}" ls-remote --heads origin`, shared),
        ...call(`git -C "${two}" ls-remote --heads origin`, shared),
        ...call(`cd "${scratch}/wt-x" && git rev-parse --abbrev-ref HEAD`, "shared/work"),
        ...call(`cd "${scratch}/wt-x" && git status --porcelain`, " M src/a.ts"),
      ];
      const states = stateFromTrace(events, piecesOf(events), { cwd: one });
      const checkout = states.find((state) => state.path === `${scratch}/wt-x`)!;
      expect(checkout.attributed).toBe(false);
      expect(checkout.branch!.value).toBe("shared/work");
      // and neither repository absorbed it
      for (const repo of [one, two]) expect(states.find((state) => state.path === repo)?.branch).toBeUndefined();
    } finally {
      for (const dir of [one, two]) rmSync(dir, { recursive: true, force: true });
    }
  });

  test("`main` never attributes a checkout, however many repositories know it", () => {
    seq = 0;
    const repo = mkdtempSync(join(tmpdir(), "carafe-v3-mainonly-"));
    mkdirSync(join(repo, ".git"), { recursive: true });
    const scratch = "/private/tmp/claude-501/helper/scratchpad";
    try {
      const events = [
        user("go"),
        ...call(`git -C "${repo}" ls-remote --heads origin`, "1111111111111111111111111111111111111111\trefs/heads/main"),
        ...call(`cd "${scratch}/wt-m" && git rev-parse --abbrev-ref HEAD`, "main"),
      ];
      const states = stateFromTrace(events, piecesOf(events), { cwd: repo });
      expect(states.find((state) => state.path === `${scratch}/wt-m`)?.attributed).toBe(false);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("a reading from a command that named no directory is marked, and never welded to one that did", () => {
    seq = 0;
    const repo = mkdtempSync(join(tmpdir(), "carafe-v3-assumed-"));
    mkdirSync(join(repo, ".git"), { recursive: true });
    try {
      const events = [
        user("state please"),
        ...call(`git -C "${repo}" log -1 --oneline`, "0959ebf init empty stub"),
        ...call("git rev-parse --abbrev-ref HEAD", "opus/row42-null-guard"),
        ...filler(),
      ];
      const text = render(events, { cwd: repo });
      const section = text.slice(text.indexOf("## Last seen in the session"), text.indexOf("## Notes"));
      expect(section).toContain("branch opus/row42-null-guard (cwd assumed)");
      expect(section).toContain(`HEAD 0959ebf "init empty stub"`);
      // one heading for the repository, and the two readings on separate lines
      expect(section.split("\n").filter((line) => line === `- ${repo}`)).toHaveLength(1);
      const welded = section.split("\n").find((line) => line.includes("0959ebf"))!;
      expect(welded).not.toContain("opus/row42-null-guard");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe("R19 fuller quotes", () => {
  test("an ask carries up to two sentences before it", () => {
    seq = 0;
    const paragraph = "The spec work and the loading states are the same surface.\nRook can take the whole thing.\nOr leave it with Rook. Your call.";
    const events = [user("what now"), assistant(paragraph), ...filler()];
    const open = detectOpenAsks(events, piecesOf(events), undefined, { endTs: "2026-01-01T11:00:00Z" });
    expect(open[0]!.text).toContain("Rook can take the whole thing");
    expect(open[0]!.text).toContain("Your call");
    expect(open[0]!.text.length).toBeLessThanOrEqual(500);
  });

  test("the goal keeps 2,500 characters of the first prompt", () => {
    seq = 0;
    const events = [user(`Build the thing.\n${"Product detail. ".repeat(300)}`), ...filler()];
    const text = render(events);
    expect(goalText(piecesOf(events))!.text.length).toBe(2_500);
    expect(text).toContain("Product detail.");
  });
});

describe("R20 one result, several readings of the same shape", () => {
  const frontendHash = "b25746ed5aa1c0ffee0123456789abcdef012345";
  const backendHash = "0959ebf112233445566778899001122334455667";

  test("two `rev-parse HEAD` segments take their own line, in order", () => {
    seq = 0;
    const harness = mkdtempSync(join(tmpdir(), "carafe-v3-harness-"));
    const frontend = mkdtempSync(join(tmpdir(), "carafe-v3-r20-fe-"));
    const backend = mkdtempSync(join(tmpdir(), "carafe-v3-r20-be-"));
    for (const dir of [frontend, backend]) mkdirSync(join(dir, ".git"), { recursive: true });
    try {
      const command = `cd "${harness}/" && git -C "${frontend}" rev-parse HEAD && git -C "${backend}" rev-parse HEAD`;
      const events = [user("both hashes"), ...call(command, `${frontendHash}\n${backendHash}`)];
      const states = stateFromTrace(events, piecesOf(events), { cwd: harness });
      const byPath = new Map(states.map((state) => [state.path, state]));
      expect(byPath.get(frontend)!.head!.value.hash).toBe(frontendHash);
      expect(byPath.get(backend)!.head!.value.hash).toBe(backendHash);
    } finally {
      for (const dir of [harness, frontend, backend]) rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a missing line drops every reading of that shape rather than guessing", () => {
    seq = 0;
    const frontend = mkdtempSync(join(tmpdir(), "carafe-v3-r20b-fe-"));
    const backend = mkdtempSync(join(tmpdir(), "carafe-v3-r20b-be-"));
    for (const dir of [frontend, backend]) mkdirSync(join(dir, ".git"), { recursive: true });
    try {
      const command = `git -C "${frontend}" rev-parse HEAD && git -C "${backend}" rev-parse HEAD`;
      const events = [user("both hashes"), ...call(command, frontendHash)];
      const states = stateFromTrace(events, piecesOf(events), { cwd: "/w/session" });
      for (const repo of [frontend, backend]) expect(states.find((state) => state.path === repo)?.head).toBeUndefined();
    } finally {
      for (const dir of [frontend, backend]) rmSync(dir, { recursive: true, force: true });
    }
  });

  test("porcelain blocks and branch names are consumed in order too", () => {
    seq = 0;
    const one = mkdtempSync(join(tmpdir(), "carafe-v3-r20c-one-"));
    const two = mkdtempSync(join(tmpdir(), "carafe-v3-r20c-two-"));
    for (const dir of [one, two]) mkdirSync(join(dir, ".git"), { recursive: true });
    try {
      const events = [
        user("state of both"),
        ...call(`git -C "${one}" status --porcelain && git -C "${two}" status --porcelain`, " M a.ts\n M b.ts\n\n M only-one.ts"),
        ...call(`git -C "${one}" branch --show-current && git -C "${two}" branch --show-current`, "feat/one\nfeat/two"),
      ];
      const states = stateFromTrace(events, piecesOf(events), { cwd: "/w/session" });
      const byPath = new Map(states.map((state) => [state.path, state]));
      expect(byPath.get(one)!.dirty!.value).toBe(2);
      expect(byPath.get(two)!.dirty!.value).toBe(1);
      expect(byPath.get(one)!.branch!.value).toBe("feat/one");
      expect(byPath.get(two)!.branch!.value).toBe("feat/two");
    } finally {
      for (const dir of [one, two]) rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a single reading of a shape still reads the whole result, as before", () => {
    seq = 0;
    const repo = mkdtempSync(join(tmpdir(), "carafe-v3-r20d-"));
    mkdirSync(join(repo, ".git"), { recursive: true });
    try {
      const events = [user("go"), ...call(`cd "${repo}" && echo "branch: $(git rev-parse --abbrev-ref HEAD)" && git log --oneline -1`, "branch: feat/x\n7e5c9a1 the subject line")];
      const states = stateFromTrace(events, piecesOf(events), { cwd: repo });
      expect(states[0]!.head!.value).toEqual({ hash: "7e5c9a1", subject: "the subject line" });
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
