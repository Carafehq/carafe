/**
 * Handoff v4: what each branch is FOR, work left half-done across two
 * repositories, chapter titles that say something, the product before the
 * trace, asks that carry their subject, and a tail that says what it is.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "child_process";
import { mkdirSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join, basename } from "path";
import type { SessionDistillate } from "../format/distillate";
import type { CarafeEvent } from "../format/events";
import type { KeyMoment } from "../keymoments/extract";
import { dedupeAsks, detectOpenAsks } from "../keymoments/asks";
import { chapterTitles, type Chapter } from "../keymoments/chapters";
import { cleanSentence, isQuotableSentence, quotableSentences, splitSentences } from "../keymoments/sentences";
import { buildBlocks } from "./blocks";
import { extractPieces } from "./pieces";
import { branchPurposes, envFlagsFromTrace, hasOwnPurpose } from "./state";
import { halfDoneLines, preparedPieces, renderHandoff, rightNowData, rightNowLines, whatThisIsLines } from "./render";

const sessionId = "handoff-v4-fixture";

function distillate(events: CarafeEvent[], over: Partial<SessionDistillate> = {}): SessionDistillate {
  return {
    tool: "codex", sessionId, sourcePath: "/tmp/session.jsonl", title: "handoff v4 fixture",
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
const read = (path: string, output: string): CarafeEvent[] => [
  event("tool_use", { name: "Read", arguments: { file_path: path } }),
  event("tool_result", { output }),
];
const edit = (path: string): CarafeEvent[] => [
  event("tool_use", { name: "Edit", arguments: { file_path: path } }),
  event("tool_result", { output: "ok" }),
];
const filler = (count = 240): CarafeEvent[] => Array.from({ length: count }, () => assistant(`filler ${"x".repeat(1_000)}`));

const piecesOf = (events: CarafeEvent[]) => extractPieces(events, {}, {});
const render = (events: CarafeEvent[], over: Partial<SessionDistillate> = {}, opts = {}) =>
  renderHandoff(distillate(events, over), events, { now: "2026-02-01T00:00:00Z", target: "codex", ...opts }).text;

function repoDir(tag: string): string {
  const dir = mkdtempSync(join(tmpdir(), `carafe-v4-${tag}-`));
  mkdirSync(join(dir, ".git"), { recursive: true });
  return dir;
}
/** round 8 — a purpose line is printed only when git confirms the branch (and its listed commits) in that repository */
function realRepo(tag: string, branch: string, subjects: string[] = []): string {
  const dir = mkdtempSync(join(tmpdir(), `carafe v4 ${tag} `));
  const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
  const git = (...args: string[]): void => { execFileSync("git", ["-C", dir, ...args], { env, stdio: "ignore" }); };
  git("init", "-q", "-b", "main");
  git("commit", "-q", "--allow-empty", "-m", "first");
  git("checkout", "-q", "-b", branch);
  for (const subject of [...subjects].reverse()) git("commit", "-q", "--allow-empty", "-m", subject);
  return dir;
}

describe("W1 what each branch is for", () => {
  test("a changelog row that names the branch is the purpose", () => {
    seq = 0;
    const repo = realRepo("changelog", "opus/sentinel-backend");
    try {
      const events = [
        user("carry on"),
        ...call(`git -C "${repo}" branch --show-current`, "opus/sentinel-backend"),
        ...call(`git -C "${repo}" log --oneline -3`, "a1b2c3d wire the middleware\ne4f5a6b add the settings"),
        ...read(join(repo, "CHANGELOG.md"), "| 12 | a1b2c3d | opus/sentinel-backend | Sentinel on every write endpoint |"),
        ...filler(),
      ];
      const purposes = branchPurposes(events, piecesOf(events), [{ branch: "opus/sentinel-backend", repo }], { cwd: repo });
      expect(purposes.get("opus/sentinel-backend")!.source).toBe("changelog");
      expect(purposes.get("opus/sentinel-backend")!.text).toContain("Sentinel on every write endpoint");
      const text = render(events, { cwd: repo });
      expect(text).toContain("  for opus/sentinel-backend: | 12 | a1b2c3d | opus/sentinel-backend | Sentinel on every write endpoint |  [seq");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("with no changelog, the branch's own commit subjects say what it is for", () => {
    seq = 0;
    const repo = realRepo("log", "feat/exporter", ["streaming writer", "batch the rows", "drop the buffer"]);
    try {
      const events = [
        user("carry on"),
        ...call(`git -C "${repo}" branch --show-current`, "feat/exporter"),
        ...call(`git -C "${repo}" log --oneline feat/exporter -5`, "a1b2c3d streaming writer\nb2c3d4e batch the rows\nc3d4e5f drop the buffer\nd4e5f6a older still"),
        ...filler(),
      ];
      const purposes = branchPurposes(events, piecesOf(events), [{ branch: "feat/exporter", repo }], { cwd: repo });
      expect(purposes.get("feat/exporter")).toEqual({ text: "streaming writer · batch the rows · drop the buffer", seq: 4, source: "commits" });
      expect(render(events, { cwd: repo })).toContain("  for feat/exporter: streaming writer · batch the rows · drop the buffer  [seq 4]");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("no changelog row and no log that names the branch: no line at all", () => {
    seq = 0;
    const repo = repoDir("nosource");
    try {
      const events = [
        user("start the rewrite"),
        assistant("The exporter needs its own branch: the rewrite touches every writer. Starting it now."),
        ...call(`cd "${repo}" && git checkout -b feat/rewrite`, "Switched to a new branch 'feat/rewrite'"),
        // a bare log in the repository is NOT a log of this branch
        ...call(`git -C "${repo}" log --oneline -3`, "a1b2c3d something else entirely\nb2c3d4e and another project's commit"),
        ...filler(),
      ];
      expect(branchPurposes(events, piecesOf(events), [{ branch: "feat/rewrite", repo }], { cwd: repo }).size).toBe(0);
      expect(render(events, { cwd: repo })).not.toContain("  for:");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("a ledger row that carries only the HEAD hash is not a purpose", () => {
    seq = 0;
    const repo = repoDir("hashonly");
    try {
      const events = [
        user("go"),
        ...call(`git -C "${repo}" branch --show-current`, "opus/row42-null-guard"),
        ...call(`git -C "${repo}" log -1 --oneline`, "a1b2c3d guard the row"),
        ...read(join(repo, "CHANGELOG.md"), "| 12 | a1b2c3d | Release 0.1.0 |"),
        ...filler(),
      ];
      expect(branchPurposes(events, piecesOf(events), [{ branch: "opus/row42-null-guard", hash: "a1b2c3d", repo }], { cwd: repo }).size).toBe(0);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("a log that names the branch — plainly, as origin/<b>, or as a range — is the source", () => {
    for (const command of ["git log --oneline feat/exporter", "git log --oneline origin/feat/exporter", "git log --oneline main..feat/exporter -n 3"]) {
      seq = 0;
      const events = call(command, "a1b2c3d streaming writer\nb2c3d4e batch the rows");
      const purposes = branchPurposes(events, piecesOf(events), [{ branch: "feat/exporter" }]);
      expect(purposes.get("feat/exporter")!.text).toBe("streaming writer · batch the rows");
    }
  });

  test("one result shared by two branch-naming logs is attributed to neither", () => {
    seq = 0;
    const events = call("git log --oneline feat/one -n 2 && git log --oneline feat/two -n 2",
      "a1b2c3d one's work\nb2c3d4e two's work");
    const purposes = branchPurposes(events, piecesOf(events), [{ branch: "feat/one" }, { branch: "feat/two" }]);
    expect(purposes.size).toBe(0);
  });

  test("a branch every repository has never gets a for-line", () => {
    seq = 0;
    const repo = repoDir("mainbranch");
    try {
      const events = [
        user("go"),
        ...call(`git -C "${repo}" branch --show-current`, "main"),
        ...read(join(repo, "LEDGER.md"), "- 2026-09-03: /beta ROLLOUT DEPLOYED (02855e1) — /beta now renders through the main app's SettingsPanel"),
        ...call(`git -C "${repo}" log --oneline main -3`, "a1b2c3d something\nb2c3d4e something else"),
        ...filler(),
      ];
      expect(branchPurposes(events, piecesOf(events), [{ branch: "main", repo }], { cwd: repo }).size).toBe(0);
      expect(hasOwnPurpose("develop")).toBe(false);
      expect(hasOwnPurpose("")).toBe(false);
      expect(hasOwnPurpose("opus/sentinel-backend")).toBe(true);
      expect(render(events, { cwd: repo })).not.toContain("  for");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("a ledger row names the branch as a whole token or not at all", () => {
    seq = 0;
    const events = [
      ...read("/w/p/LEDGER.md", "- 2026-09-03: feat/exporter-v2 landed"),
      ...read("/w/p/LEDGER.md", "| 7 | c0ffee1 | `feat/exporter` | the streaming rewrite |"),
    ];
    const purposes = branchPurposes(events, piecesOf(events), [{ branch: "feat/exporter" }]);
    expect(purposes.get("feat/exporter")!.text).toContain("the streaming rewrite");
    expect(purposes.get("feat/exporter")!.text).not.toContain("exporter-v2");
  });

  test("a branch the trace says nothing about gets no line", () => {
    seq = 0;
    const repo = repoDir("silent");
    try {
      const events = [user("go"), ...call(`git -C "${repo}" branch --show-current`, "feat/quiet"), ...filler()];
      expect(branchPurposes(events, piecesOf(events), [{ branch: "feat/quiet", repo }], { cwd: repo }).size).toBe(0);
      expect(render(events, { cwd: repo })).not.toContain("  for:");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe("W2 half-done across repositories", () => {
  test("one side pushed, the sibling side not, and the flag that is still off", () => {
    seq = 0;
    const backend = repoDir("backend");
    const frontend = repoDir("frontend");
    try {
      const events = [
        user("ship the sentinel change"),
        ...edit(join(backend, "src/mw.ts")),
        ...edit(join(frontend, "src/form.ts")),
        ...call(`git -C "${backend}" branch --show-current`, "opus/sentinel-backend"),
        ...call(`git -C "${backend}" push origin opus/sentinel-backend`, "To github.com:x/api.git\n * [new branch]      opus/sentinel-backend -> opus/sentinel-backend"),
        ...call(`git -C "${frontend}" branch --show-current`, "opus/sentinel-frontend"),
        ...call(`cd "${backend}" && cat .env`, "SENTINEL_DISABLED=true\nPORT=8080"),
        ...filler(),
      ];
      const data = rightNowData(distillate(events, { cwd: backend }), events, preparedPieces(events, sessionId));
      const lines = halfDoneLines(distillate(events, { cwd: backend }), data).join("\n");
      expect(lines).toContain("## Half-done (one side moved, the other did not)");
      expect(lines).toContain(`${backend} on opus/sentinel-backend: pushed opus/sentinel-backend`);
      expect(lines).toContain(`${frontend} on opus/sentinel-frontend: no push seen in this trace`);
      expect(lines).toContain(`"SENTINEL_DISABLED=true"`);
      const text = render(events, { cwd: backend });
      expect(text.indexOf("## Last seen in the session")).toBeLessThan(text.indexOf("## Half-done"));
      expect(text.indexOf("## Half-done")).toBeLessThan(text.indexOf("## Notes"));
    } finally {
      rmSync(backend, { recursive: true, force: true });
      rmSync(frontend, { recursive: true, force: true });
    }
  });

  test("a rejected push newer than the last one that landed", () => {
    seq = 0;
    const repo = repoDir("rejected");
    try {
      const events = [
        user("push it"),
        ...call(`git -C "${repo}" branch --show-current`, "feat/one", "2026-01-01T10:00:00Z"),
        ...call(`git -C "${repo}" push origin feat/one`, " * [new branch]      feat/one -> feat/one", "2026-01-01T10:10:00Z"),
        ...call(`git -C "${repo}" push origin feat/one`, " ! [rejected]        feat/one -> feat/one (non-fast-forward)", "2026-01-01T10:20:00Z"),
        ...filler(),
      ];
      const d = distillate(events, { cwd: repo });
      const lines = halfDoneLines(d, rightNowData(d, events, preparedPieces(events, sessionId))).join("\n");
      expect(lines).toContain("rejected push feat/one");
      expect(lines).toContain("last push that landed: feat/one");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  // v5: a single uncommitted count is NOT an alarm. Two judges read
  // "13 uncommitted" under "Half-done" and found nine dead scratch files from
  // three weeks earlier. Only a count that MOVED is a finding.
  test("an uncommitted count that moved is a finding; one that never moved is not", () => {
    seq = 0;
    const repo = repoDir("dirty");
    try {
      const dirty = (files: number, ts: string): CarafeEvent[] =>
        call(`git -C "${repo}" status --porcelain`, Array.from({ length: files }, (_, index) => ` M f-${index}.ts`).join("\n"), ts);
      const moved = [
        user("go"),
        ...call(`git -C "${repo}" branch --show-current`, "feat/wip", "2026-01-01T09:00:00Z"),
        ...dirty(2, "2026-01-01T09:00:00Z"),
        ...dirty(6, "2026-01-01T09:30:00Z"),
        ...filler(),
      ];
      const d = distillate(moved, { cwd: repo, endTs: "2026-01-03T10:00:00Z" });
      expect(halfDoneLines(d, rightNowData(d, moved, preparedPieces(moved, sessionId))).join("\n"))
        .toContain("uncommitted went 2 → 6");

      seq = 0;
      const still = [
        user("go"),
        ...call(`git -C "${repo}" branch --show-current`, "feat/wip", "2026-01-01T09:00:00Z"),
        ...dirty(6, "2026-01-01T09:00:00Z"),
        ...dirty(6, "2026-01-01T09:30:00Z"),
        ...filler(),
      ];
      const same = distillate(still, { cwd: repo, endTs: "2026-01-03T10:00:00Z" });
      expect(halfDoneLines(same, rightNowData(same, still, preparedPieces(still, sessionId)))).toEqual([]);
      expect(render(still, { cwd: repo, endTs: "2026-01-03T10:00:00Z" })).not.toContain("## Half-done");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("a flag whose name merely shares letters with the branch is not a finding", () => {
    seq = 0;
    const repo = repoDir("letters");
    try {
      const events = [
        user("go"),
        ...call(`git -C "${repo}" branch --show-current`, "opus/sentinel-backend"),
        ...call(`cd "${repo}" && cat .envrc`, "export SINGLE_CALL_SENT=1"),
        ...filler(),
      ];
      const d = distillate(events, { cwd: repo });
      const lines = halfDoneLines(d, rightNowData(d, events, preparedPieces(events, sessionId))).join("\n");
      expect(lines).not.toContain("SINGLE_CALL_SENT");
      expect(lines).toBe("");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("a flag read before the branch was ever seen is not about that branch", () => {
    seq = 0;
    const repo = repoDir("older");
    try {
      const events = [
        user("go"),
        ...call(`cd "${repo}" && cat .env`, "SENTINEL_DISABLED=true"),
        ...call(`git -C "${repo}" branch --show-current`, "opus/sentinel-backend"),
        ...filler(),
      ];
      const d = distillate(events, { cwd: repo });
      expect(halfDoneLines(d, rightNowData(d, events, preparedPieces(events, sessionId)))).toEqual([]);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("a flag line is read from a result, last reading per name", () => {
    seq = 0;
    const events = [...call("cat .env", "FEATURE_X=true"), ...call("cat .env", "FEATURE_X=false")];
    const flags = envFlagsFromTrace(events, piecesOf(events), { cwd: "/w/project" });
    expect(flags.map((flag) => `${flag.name}=${flag.value}`)).toEqual(["FEATURE_X=false"]);
  });
});

describe("W3 chapter titles that say something", () => {
  const chapter = (index: number, startSeq: number, endSeq: number): Chapter => ({
    index, startSeq, endSeq, startTs: "2026-01-01T10:00:00Z", endTs: "2026-01-01T11:00:00Z",
    turns: 2, toolCalls: 1, chars: 100, branch: null, cwd: null, files: [], commits: 0, failures: 0,
    decisions: 0, boundary: "start", strength: 0,
  });

  test("(a) a recap, (b) a commit subject, (c) a user line with something in it, (d) the first line", () => {
    seq = 0;
    const events = [
      // ch 1 — a recap reply
      user("where are we"),
      assistant("The exporter streams now, and the ledger is current. Two things left."),
      // ch 2 — a commit
      user("go"),
      ...call(`git commit -m "drop the buffer from the writer"`, "[feat/x a1b2c3d] drop the buffer from the writer"),
      // ch 3 — a long user line
      user("rewrite the exporter so it never buffers a whole batch"),
      assistant("On it."),
      // ch 4 — nothing but a bare command word
      user("push"),
      assistant("Pushed."),
    ];
    const pieces = piecesOf(events);
    const blocks = buildBlocks(events, pieces);
    const recap: KeyMoment = {
      kind: "recap", seq: 2, text: "The exporter streams now, and the ledger is current. Two things left.",
      fullText: "The exporter streams now, and the ledger is current. Two things left.",
    };
    const chapters = [chapter(1, 1, 2), chapter(2, 3, 5), chapter(3, 6, 7), chapter(4, 8, 9)];
    const titles = chapterTitles(events, pieces, chapters, blocks, [recap]);
    expect(titles.get(1)).toBe("The exporter streams now, and the ledger is current.");
    expect(titles.get(2)).toBe("drop the buffer from the writer");
    expect(titles.get(3)).toBe("rewrite the exporter so it never buffers a whole batch");
    expect(titles.get(4)).toBe("push");
  });

  test("the handoff's headers carry the title; `carafe chapters` is untouched", () => {
    seq = 0;
    const repo = repoDir("titles");
    try {
      const events = [
        user("go"),
        ...call(`git commit -m "the exporter streams its rows"`, "[feat/x a1b2c3d] the exporter streams its rows"),
        ...edit(join(repo, "src/a.ts")),
        ...filler(),
      ];
      const text = render(events, { cwd: repo });
      expect(text).toContain(`### Ch 1 · "the exporter streams its rows" ·`);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe("W4 the product, before the trace", () => {
  const chapters = (endSeq: number): Chapter[] => [{
    index: 1, startSeq: 1, endSeq, startTs: null, endTs: null, turns: 1, toolCalls: 0, chars: 10,
    branch: null, cwd: null, files: [], commits: 0, failures: 0, decisions: 0, boundary: "start", strength: 0,
  }];

  test("two sentences of the goal are enough for the section", () => {
    seq = 0;
    const events = [user("Carafe is the continuity layer for every coding agent on this machine. Make the handoff say what each branch is for."), assistant("On it.")];
    const pieces = piecesOf(events);
    const lines = whatThisIsLines(distillate(events), events, pieces, chapters(2), []);
    expect(lines[0]).toBe("## What this is (from the trace, verbatim)");
    expect(lines.filter((line) => line.startsWith("- "))).toEqual([
      `- "Carafe is the continuity layer for every coding agent on this machine."  [seq 1]`,
      `- "Make the handoff say what each branch is for."  [seq 1]`,
    ]);
  });

  test("one sentence and nothing else: the section is omitted rather than filled", () => {
    seq = 0;
    const events = [user("go"), assistant("Working.")];
    expect(whatThisIsLines(distillate(events), events, piecesOf(events), chapters(2), [])).toEqual([]);
  });

  test("a ledger the session read most is NOT an opener line", () => {
    seq = 0;
    const cwd = "/w/carafe";
    const events = [
      user("Ship the exporter to production this week. Keep the project ledger honest while you are doing it."),
      ...read(`${cwd}/LEDGER.md`, "# Acme Platform — Project Goal\n\n512 - 2026-09-13 23:2x: **AUDIT-7 PREP COMPLETE — ALL THREE ITEMS.**"),
      ...read(`${cwd}/LEDGER.md`, "# Acme Platform — Project Goal\n\n512 - 2026-09-13 23:2x: **AUDIT-7 PREP COMPLETE — ALL THREE ITEMS.**"),
    ];
    const lines = whatThisIsLines(distillate(events, { cwd }), events, piecesOf(events), chapters(6), []).join("\n");
    expect(lines).not.toContain("Acme Platform");
    expect(lines).not.toContain("AUDIT-7");
    expect(lines).toContain("Ship the exporter to production this week.");
  });

  test("the recap and the assistant's own 'is a' sentence join the goal, capped at six", () => {
    seq = 0;
    const cwd = "/w/carafe";
    const events = [
      user("Ship the exporter to production this week. Keep the project ledger honest while you are doing it."),
      assistant("carafe is a local-first store for every agent session on this machine."),
      user("where are we"),
      assistant("The exporter is green and the ledger is current in both repositories."),
    ];
    const pieces = piecesOf(events);
    const recap: KeyMoment = { kind: "recap", seq: 4, text: "The exporter is green and the ledger is current in both repositories.", fullText: "The exporter is green and the ledger is current in both repositories." };
    const lines = whatThisIsLines(distillate(events, { cwd }), events, pieces, chapters(10), [recap]);
    const quotes = lines.filter((line) => line.startsWith("- "));
    expect(quotes.length).toBeLessThanOrEqual(6);
    expect(quotes[0]).toContain("Ship the exporter to production this week.");
    expect(quotes.join("\n")).toContain("The exporter is green and the ledger is current in both repositories.");
    expect(quotes.join("\n")).toContain("carafe is a local-first store for every agent session on this machine.");
  });

  test("the section sits between the header and Right now", () => {
    seq = 0;
    const repo = repoDir("opener");
    try {
      const events = [
        user("Carafe is the continuity layer for every coding agent on this machine. Make the tail label say which repositories it is really about."),
        ...call(`git -C "${repo}" branch --show-current`, "feat/opener"),
        ...edit(join(repo, "src/a.ts")),
        ...filler(),
      ];
      const text = render(events, { cwd: repo });
      expect(text.indexOf("# Handoff:")).toBeLessThan(text.indexOf("## What this is"));
      expect(text.indexOf("## What this is")).toBeLessThan(text.indexOf("## Last seen in the session"));
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe("the shared sentence extractor", () => {
  test("a URL, a domain, a backtick span and a decimal are never split", () => {
    expect(splitSentences("Act as the lead, bringing https://staging.acme.app/dashboard up. Then stop."))
      .toEqual(["Act as the lead, bringing https://staging.acme.app/dashboard up.", "Then stop."]);
    expect(splitSentences("Bring staging.acme.ai up first. Then stop."))
      .toEqual(["Bring staging.acme.ai up first.", "Then stop."]);
    expect(splitSentences("Probe api-edge.acme.ai/health once. Done."))
      .toEqual(["Probe api-edge.acme.ai/health once.", "Done."]);
    expect(splitSentences("Open settings-panel.tsx next.")).toEqual(["Open settings-panel.tsx next."]);
    expect(splitSentences("Bump to 0.1.2 today.")).toEqual(["Bump to 0.1.2 today."]);
    expect(splitSentences("Read `src/a.ts` first.")).toEqual(["Read `src/a.ts` first."]);
    expect(splitSentences("Edit README.md now.")).toEqual(["Edit README.md now."]);
  });

  test("markers, emphasis and commit trailers come off", () => {
    expect(cleanSentence("## **AUDIT PREP** is done")).toBe("AUDIT PREP is done");
    expect(cleanSentence("- 3. `carafe` writes the file")).toBe("carafe writes the file");
    expect(cleanSentence("gateway: verify the token Co-Authored-By: Claude")).toBe("gateway: verify the token");
    expect(cleanSentence("fix the exporter (#412)")).toBe("fix the exporter");
  });

  test("a heading, a table row, a numbered ledger line and a fragment are not quotable", () => {
    expect(isQuotableSentence("# Acme Platform — Project Goal")).toBe(false);
    expect(isQuotableSentence("| 41 | a1b2c3d | opus/sentinel-backend | shipped |")).toBe(false);
    expect(isQuotableSentence("512 - 2026-09-13 23:2x: AUDIT-7 PREP COMPLETE.")).toBe(false);
    expect(isQuotableSentence("Too short.")).toBe(false);
    expect(isQuotableSentence("A sentence long enough to say something but with no ending")).toBe(false);
    expect(isQuotableSentence("Carafe is the continuity layer for every coding agent here.")).toBe(true);
  });

  test("quotableSentences keeps only what survives all of it", () => {
    expect(quotableSentences("# Heading\n\nCarafe captures every coding session on this machine locally. no."))
      .toEqual(["Carafe captures every coding session on this machine locally."]);
  });
});

describe("W5 the asks carry their subject", () => {
  test("a quote that opens on a conjunction takes one more sentence", () => {
    seq = 0;
    const events = [
      user("go"),
      assistant("The wrapper is the last thing standing. it swallows the 429s that the new backoff already handles. I can delete it now. Or should I keep a flag for it?"),
      user("noted"),
      ...filler(),
    ];
    const open = detectOpenAsks(events, piecesOf(events));
    expect(open[0]!.text.startsWith("The wrapper is the last thing standing.")).toBe(true);
    expect(open[0]!.text).toContain("Or should I keep a flag for it?");
  });

  test("two asks quoting the same text are one ask — the newest", () => {
    const asks: KeyMoment[] = [
      { kind: "openask", seq: 10, text: "Should I park the retry wrapper for good, or keep a flag for it that defaults off?" },
      { kind: "openask", seq: 40, text: "Asked again: Should I park the retry wrapper for good, or keep a flag for it that defaults off?" },
      { kind: "openask", seq: 50, text: "Do you want the export batched at 10k rows or 50k?" },
    ];
    expect(dedupeAsks(asks).map((ask) => ask.seq)).toEqual([40, 50]);
  });
});

describe("W6 the tail says what it is", () => {
  let workspace = "";
  let main = "";
  let other = "";
  // three more repositories, so `other` is the fifth by tool calls and the only
  // one the header does not name
  let alsoPrincipal: string[] = [];
  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "carafe-v4-tail-main-"));
    main = join(workspace, "main"); other = join(workspace, "other");
    alsoPrincipal = [0, 1, 2].map((i) => join(workspace, `also-${i}`));
    for (const dir of [main, other, ...alsoPrincipal]) mkdirSync(join(dir, ".git"), { recursive: true });
  });
  afterEach(() => rmSync(workspace, { recursive: true, force: true }));
  const supporting = (edits = 6): CarafeEvent[] =>
    alsoPrincipal.flatMap((repo, repoIndex) =>
      [user(`support ${repoIndex}`), ...Array.from({ length: edits }, (_, index) => edit(join(repo, `src/s-${index}.ts`))).flat()]);
  const principalTurns = (count: number): CarafeEvent[] =>
    Array.from({ length: count }, (_, index) => [user(`principal ${index}`), assistant(`On it ${index}.`), ...edit(join(main, `src/file-${index}.ts`))]).flat();

  test("the label names the range, the turns and the repository", () => {
    seq = 0;
    const events = [user("build the exporter"), ...filler(), ...principalTurns(14)];
    const text = render(events, { cwd: main });
    const heading = /^## The tail, verbatim \([^\n]*\)$/m.exec(text)![0];
    expect(heading).toMatch(/^## The tail, verbatim \(seq \d+ → \d+: the last \d+ turns of work in [^)]+\)$/);
    expect(heading).toContain(basename(main));
    expect(heading).not.toContain("the working state");
    expect(text).not.toContain("The session's final turns");
  });

  test("the label names the repositories the TAIL's turns touched, not the principal set", () => {
    seq = 0;
    // the principal set is main + the three supporting repos; the tail's own
    // turns are pure conversation and touch nothing
    const events = [
      user("build the exporter"),
      ...supporting(2),
      ...principalTurns(12),
      ...filler(),
      ...Array.from({ length: 13 }, (_, index) => [user(`talk ${index}`), assistant(`Said ${index}.`)]).flat(),
    ];
    const text = render(events, { cwd: main });
    const heading = /^## The tail, verbatim \([^\n]*\)$/m.exec(text)![0];
    // v5 round 3: the label never claims zero turns, and says plainly when it
    // could attribute no workspace at all
    expect(heading).toContain("(no workspace attributed)");
    expect(heading).toMatch(/the last \d+ turns/);
    expect(heading).not.toContain("the last 0 turns");
    expect(heading).not.toContain(basename(main));
  });

  test("the label does not name the agent's own state directory", () => {
    seq = 0;
    const events = [
      user("build the exporter"),
      ...supporting(),
      ...filler(),
      ...principalTurns(12),
      user("note it"),
      ...edit(join(main, ".claude/memory/MEMORY.md")),
      ...edit(join(main, "src/last.ts")),
      assistant("Noted."),
    ];
    const heading = /^## The tail, verbatim \([^\n]*\)$/m.exec(render(events, { cwd: main }))![0];
    expect(heading).not.toContain("memory");
    expect(heading).toContain(basename(main));
  });

  test("a cut trailing tangent is named under the label", () => {
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
      assistant("Left alone."),
    ];
    const text = render(events, { cwd: main });
    const tail = text.slice(text.indexOf("## The tail, verbatim"));
    expect(tail).toContain("Tangent after seq");
    expect(tail).toMatch(/_The session's final turns \(seq \d+ → end\) were about [^;]+; see the tangent line above\._/);
    expect(tail).toContain(basename(other));
  });
});
