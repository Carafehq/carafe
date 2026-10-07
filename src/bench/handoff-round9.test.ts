/**
 * Round 9 — every finding both judges verified, as a fixture.
 *
 * One mkdtemp workspace whose folder name has spaces. git's own clock is set per
 * step (GIT_COMMITTER_DATE writes the reflog's timestamps too), so the moment
 * the answers were written sits between real reflog entries:
 *
 *   2026-09-20 09:00  b0, then base (with a changelog, rows 1–3); main pushed
 *   2026-09-20 11:00  worktrees acme-backend-baseline (base) and acme-backend-stale (b0)
 *   2026-09-21 10:00  a1 on codex/status-copy: a new guard file, `anon:undefined`
 *   2026-09-21 11:00  d1, d2 (changelog only) and d3 (changelog + code) on opus/docs
 *   2026-09-21 18:05  ← the answers are written (T)
 *   2026-09-22 11:08  main takes a1 and is pushed: origin/main moves by push
 *   2026-09-22 12:05  main adds changelog rows 4–5 (other work) and is pushed
 *   2026-09-22 18:35  a2 on codex/status-copy is merged into main and pushed
 *   2026-09-23 10:00  ← the handoff is generated
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { checkLive, realGitRunner, type LiveState } from "../handoff/live";
import { answersLines, parseAnswers, type AnswerFile } from "../handoff/answers";
import { sinceSection } from "../handoff/since";
import { agentLabel, clipLongLines, continued, datedTail, doNotLines, renderHandoff, uniquePrefix, waitingLines, withoutOlderDays } from "../handoff/render";
import type { EventPieces } from "../handoff/pieces";
import type { CarafeEvent } from "../format/events";
import type { SessionDistillate } from "../format/distillate";
import type { KeyMoment } from "../keymoments/extract";
import { isPrMoment, momentLabel } from "../keymoments/select";
import { anchoredExcerpts, authoredLines, verifyAnchoredExcerpts, verifyAnswerNotes, verifyLayout, verifyPrintedText, verifyStamps } from "./handoff-real";

const T = "2026-09-21T18:05:00Z";
const CHECKED = "2026-09-23T10:00:00Z";

let ws = "", repo = "", baseline = "", stale = "", status = "", frontend = "", old = "", local = "";
let b0 = "", base = "", a1 = "", a2 = "", d1 = "", d2 = "", d3 = "", l1 = "";
const short = (hash: string): string => hash.slice(0, 7);

function git(dir: string, at: string, ...args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], {
    encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_NAME: "fixture", GIT_AUTHOR_EMAIL: "author@example.com", GIT_COMMITTER_NAME: "fixture", GIT_COMMITTER_EMAIL: "author@example.com", GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at },
  }).trim();
}
const commit = (dir: string, at: string, message: string): string => {
  git(dir, at, "add", "-A");
  git(dir, at, "commit", "-q", "-m", message);
  return git(dir, at, "rev-parse", "HEAD");
};
const table = (rows: Array<[number, string]>): string => ["| row | what |", "| --- | --- |", ...rows.map(([n, hash]) => `| ${n} | acme-backend — ${hash} |`)].join("\n") + "\n";

beforeAll(() => {
  ws = mkdtempSync(join(tmpdir(), "carafe round 9 "));
  const origin = join(ws, "the origin.git");
  repo = join(ws, "acme-backend");
  baseline = join(ws, "acme-backend-baseline");
  stale = join(ws, "acme-backend-stale");
  status = join(ws, "acme-backend-status");
  frontend = join(ws, "acme-frontend");
  old = join(ws, "acme-old");
  local = join(ws, "acme-local");
  execFileSync("git", ["init", "-q", "--bare", origin]);
  for (const dir of [repo, frontend, old, local]) {
    mkdirSync(dir);
    git(dir, "2026-09-20T09:00:00Z", "init", "-q", "-b", "main");
    git(dir, "2026-09-20T09:00:00Z", "config", "commit.gpgsign", "false");
  }
  mkdirSync(join(repo, "src")); mkdirSync(join(repo, "docs"));
  writeFileSync(join(repo, "src", "routes.ts"), "export function keyFor(id: string) { return `anon:${id}`; }\n");
  writeFileSync(join(repo, "src", "other.ts"), "export const other = 1;\n");
  writeFileSync(join(repo, "docs", "CHANGELOG.md"), table([]));
  b0 = commit(repo, "2026-09-20T09:00:00Z", "b0");
  writeFileSync(join(repo, "docs", "CHANGELOG.md"), table([[1, short(b0)], [2, short(b0)], [3, short(b0)]]));
  base = commit(repo, "2026-09-20T09:30:00Z", "docs: rows 1–3");
  git(repo, "2026-09-20T10:00:00Z", "remote", "add", "origin", origin);
  git(repo, "2026-09-20T10:00:00Z", "push", "-q", "origin", "main");
  git(repo, "2026-09-20T11:00:00Z", "worktree", "add", "-q", "--detach", baseline, base);
  git(repo, "2026-09-20T11:00:00Z", "worktree", "add", "-q", "--detach", stale, b0);
  git(repo, "2026-09-21T09:00:00Z", "worktree", "add", "-q", "-b", "codex/status-copy", status, "main");
  writeFileSync(join(status, "src", "rate-guard.ts"), "export const limit = 30;\n");
  writeFileSync(join(status, "src", "routes.ts"), "export function keyFor(id: string) {\n  // never key on anon:undefined\n  if (!id) return null;\n  return `anon:${id}`;\n}\n");
  a1 = commit(status, "2026-09-21T10:00:00Z", "an explicit cancel, hardened");
  git(repo, "2026-09-21T11:00:00Z", "checkout", "-q", "-b", "opus/docs");
  writeFileSync(join(repo, "docs", "CHANGELOG.md"), table([[1, short(b0)], [2, short(b0)], [3, short(b0)], [4, "proposed"]]));
  d1 = commit(repo, "2026-09-21T11:00:00Z", "docs: row 4 draft");
  writeFileSync(join(repo, "docs", "CHANGELOG.md"), table([[1, short(b0)], [2, short(b0)], [3, short(b0)], [4, "proposed again"]]));
  d2 = commit(repo, "2026-09-21T11:10:00Z", "docs: row 4 again");
  writeFileSync(join(repo, "docs", "CHANGELOG.md"), table([[1, short(b0)], [2, short(b0)], [3, short(b0)], [4, "third"]]));
  writeFileSync(join(repo, "src", "other.ts"), "export const other = 2;\n");
  d3 = commit(repo, "2026-09-21T11:20:00Z", "docs and code");
  git(repo, "2026-09-21T11:30:00Z", "checkout", "-q", "main");
  // after the answers were written
  git(repo, "2026-09-22T11:00:00Z", "merge", "-q", "--ff-only", "codex/status-copy");
  git(repo, "2026-09-22T11:08:00Z", "push", "-q", "origin", "main");
  writeFileSync(join(repo, "docs", "CHANGELOG.md"), table([[1, short(b0)], [2, short(b0)], [3, short(b0)], [4, short(base)], [5, short(b0)]]));
  commit(repo, "2026-09-22T12:00:00Z", "docs: rows 4–5 for other work");
  git(repo, "2026-09-22T12:05:00Z", "push", "-q", "origin", "main");
  writeFileSync(join(status, "src", "rate-guard.ts"), "export const limit = 20;\n");
  a2 = commit(status, "2026-09-22T18:00:00Z", "cancel, the second pass");
  git(repo, "2026-09-22T18:30:00Z", "merge", "-q", "--no-edit", "codex/status-copy");
  git(repo, "2026-09-22T18:35:00Z", "push", "-q", "origin", "main");
  // the frontend and a third, unnamed repository both have an untracked run config
  for (const dir of [frontend, old]) {
    writeFileSync(join(dir, "README.md"), "x\n");
    commit(dir, "2026-09-20T09:00:00Z", "init");
    mkdirSync(join(dir, ".local"));
    writeFileSync(join(dir, ".local", "run.json"), "{}\n");
  }
  // a repository with no remote: its main line is only ever local
  writeFileSync(join(local, "a.txt"), "a\n");
  commit(local, "2026-09-20T09:00:00Z", "l0");
  git(local, "2026-09-20T09:05:00Z", "checkout", "-q", "-b", "feat/x");
  writeFileSync(join(local, "a.txt"), "b\n");
  l1 = commit(local, "2026-09-20T09:10:00Z", "l1");
  git(local, "2026-09-20T09:15:00Z", "checkout", "-q", "main");
});
afterAll(() => { if (ws) rmSync(ws, { recursive: true, force: true }); });

const liveNow = async (): Promise<LiveState> => checkLive([repo, frontend, old, local], { now: CHECKED });
const answersOf = (sections: Record<number, string>): AnswerFile =>
  parseAnswers(`tool: claude-code\n\n${Object.entries(sections).map(([q, body]) => `## Q${q}\n${body}\n`).join("\n")}`, join(ws, "answers.md"), T)!;

/** The answers section as carafe prints it, with the delta applied. */
async function rendered(sections: Record<number, string>): Promise<string> {
  const live = await liveNow();
  const answers = [answersOf(sections)];
  const since = sinceSection({ answers, live, git: realGitRunner, now: CHECKED });
  return answersLines(answers, { live, landed: since.landed }).join("\n");
}

const Q1 = "Two repositories drive it: `acme-backend` and `acme-frontend`.";

describe("§1 the delta is applied to the answers", () => {
  test("a commit the answers call in flight, now on origin/main, is marked inline — and the branch's newer head too", async () => {
    const text = await rendered({
      1: Q1,
      2: `The round is on \`codex/status-copy\`, head \`${short(a1)}\`; nothing is merged.`,
      4: `The round is half-done: \`${short(a1)}\` is unmerged.`,
      5: `First: finish \`codex/status-copy\` and review \`${short(a1)}\`.\nThen ask the owner.`,
    });
    const lines = text.split("\n");
    const landed = lines.filter((line) => line.includes("↳ since landed on origin/main"));
    expect(landed.some((line) => line.includes(`2026-09-22 11:08 UTC via ${short(a1)} — items here may be done (${short(a1)} in ${repo})`))).toBe(true);
    // the newer head reached origin/main on its own push
    expect(landed.some((line) => line.includes(`2026-09-22 18:35 UTC`) && line.includes(`${short(a2)}, the newer head of codex/status-copy in ${repo}`))).toBe(true);
    // Q2, Q4 and Q5 each carry it; Q5 says so at its top, with a true count
    expect(text).toContain("_↳ 1 of 2 items below names work that has since landed on origin/main: check whether it is already done before acting._");
    expect(landed.length).toBeGreaterThanOrEqual(3);
    expect(verifyAnswerNotes(text)).toEqual([]);
    // planted: the wrong landing minute, the wrong commit, a count that is not true
    expect(verifyAnswerNotes(text.replace("2026-09-22 11:08 UTC via", "2026-09-22 11:20 UTC via")).join(" | ")).toContain("did not move");
    expect(verifyAnswerNotes(text.replace(`items here may be done (${short(a1)} in`, `items here may be done (${short(base)} in`)).join(" | ")).toContain("already on origin/main");
    expect(verifyAnswerNotes(text.replace("_↳ 1 of 2 items", "_↳ 2 of 2 items")).join(" | ")).toContain("Q5 warning says 2 of 2");
  });

  test("the Since section says when a named branch's newer head is itself on origin", async () => {
    const live = await liveNow();
    const { lines } = sinceSection({ answers: [answersOf({ 2: `On \`codex/status-copy\` (\`${short(a1)}\`) in \`acme-backend\`.` })], live, git: realGitRunner, now: CHECKED });
    const text = lines.join("\n");
    expect(text).toContain(`; ${short(a2)} is on origin/main too (landed 2026-09-22 18:35 UTC via `);
    expect(verifyPrintedText(`# Handoff: x\n\n${text}\n`)).toEqual([]);
    expect(verifyPrintedText(`# Handoff: x\n\n${text.replace("18:35 UTC via", "18:00 UTC via")}\n`).join(" | ")).toContain("did not move");
  });
});

describe("§2 what the sentence says is checked, not that a path exists", () => {
  test("work called open that the named commit already has is ✗ false when written, from a grep of what it names", async () => {
    const text = await rendered({ 1: Q1, 4: `The hardenings (a guard in \`src/rate-guard.ts\`, return early for \`anon:undefined\` in \`keyFor\` at \`src/routes.ts\`) were briefed for \`${short(a1)}\`.` });
    const stamp = text.split("\n").find((line) => line.includes("already has what this calls open"))!;
    expect(stamp).toStartWith(`    ✗ ${short(a1)} already has what this calls open: `);
    expect(stamp).toContain("src/rate-guard.ts (new)");
    expect(stamp).toContain("anon:undefined (new)");
    expect(stamp).toContain("src/routes.ts (changed)");
    expect(stamp).toContain("keyFor (unchanged)");
    expect(text).toContain(`was committed 2026-09-21 10:00 UTC, before the answers were written`);
    // no "path exists" note repeats what the grep already looked at
    expect(text).not.toContain("path exists: src/routes.ts");
    expect(verifyStamps(text).failures).toEqual([]);
    expect(verifyStamps(text.replace("anon:undefined (new)", "anon:undefined (unchanged)")).failures.join(" | ")).toContain("anon:undefined is new");
  });

  test("open work the commit does not touch is ✓; the named brief's own items count", async () => {
    const brief = join(ws, "notes", "BRIEF-B.md");
    mkdirSync(join(ws, "notes"), { recursive: true });
    writeFileSync(brief, "Change `src/other.ts` and add `retryBudgetMs` there.\n");
    const text = await rendered({ 1: Q1, 2: "The briefs are in `notes/BRIEF-A.md`.", 4: `The B items in \`BRIEF-B.md\` are still open in \`${short(a1)}\`.` });
    const stamp = text.split("\n").find((line) => line.includes("what this calls open"))!;
    expect(stamp).toStartWith(`    ✓ ${short(a1)} does not have what this calls open: src/other.ts (unchanged)`);
    expect(verifyStamps(text).failures).toEqual([]);
  });

  test("\"touch only\" is read with git show; the pronoun reaches the commits of the sentence before", async () => {
    const text = await rendered({ 1: Q1, 4: `Two unpushed docs commits sit on \`opus/docs\`: \`${short(d1)}\` and \`${short(d2)}\`.\nBoth touch only \`docs/CHANGELOG.md\`.\n\`${short(d3)}\` touches only \`docs/CHANGELOG.md\`.` });
    expect(text).toContain(`✓ ${short(d1)}, ${short(d2)} touch only docs/CHANGELOG.md — checked: git -C '${repo}' show --name-only '--format=%h' ${short(d1)} ${short(d2)}`);
    expect(text).toContain(`✗ ${short(d3)} touch only docs/CHANGELOG.md`);
    expect(text).not.toContain("path exists: docs/CHANGELOG.md");
    expect(verifyStamps(text).failures).toEqual([]);
    const planted = text.replace(`✗ ${short(d3)} touch only`, `✓ ${short(d3)} touch only`);
    expect(verifyStamps(planted).failures.join(" | ")).toContain("touch-only stamp ✓ disagrees");
  });

  test("a worktree said to match live is compared with origin/main as it stood then", async () => {
    const text = await rendered({ 1: Q1, 3: `The unstale copies are the worktrees \`acme-backend-baseline\` (\`${short(base)}\`) and \`acme-backend-stale\` (\`${short(b0)}\`).` });
    const lines = text.split("\n");
    const good = lines.find((line) => line.includes(`${short(base)} is 0 commits behind origin/main (worktree acme-backend-baseline)`))!;
    const bad = lines.find((line) => line.includes(`${short(b0)} is 0 commits behind origin/main (worktree acme-backend-stale)`))!;
    expect(good).toStartWith("    ✓ ");
    expect(good).toContain("held when written, changed since");
    expect(bad).toStartWith("    ✗ ");
    expect(bad).toContain("· false when written");
    expect(text).toContain(`rev-list --count ${short(b0)}..${base}] → 1`);
    expect(verifyStamps(text).failures).toEqual([]);
    // a ✗ with its proof removed is refused
    expect(verifyStamps(text.replace(/( {4}✗ [^\n]*)\n {6}↳ [^\n]*/, "$1")).failures.join(" | ")).toContain("without proof");
  });

  test("with a consented health reading, the worktree is compared with what production reports too", async () => {
    const live = await liveNow();
    live.health = [{ url: "https://api.example.invalid/health", body: `{"status":"ok","commit":"${short(a2)}"}`, error: null, decision: "allow" }];
    const answers = [answersOf({ 1: Q1, 3: `The current copy is the worktree \`acme-backend-baseline\` (\`${short(base)}\`).` })];
    const text = answersLines(answers, { live }).join("\n");
    const line = text.split("\n").find((one) => one.includes(`${short(base)} is 0 commits behind ${short(a2)} (what https://api.example.invalid/health reports now)`))!;
    // a reading of now says nothing about the moment of writing
    expect(line).toStartWith("    ? ");
    expect(verifyStamps(text).failures).toEqual([]);
  });

  test("\"N ahead of main\" is checked against origin/main; a repository with no remote says it read local main, and when", async () => {
    const text = await rendered({ 1: Q1, 2: `\`${short(a1)}\` is one commit ahead of \`main\`.\nIn \`acme-local\`, \`${short(l1)}\` is one commit ahead of \`main\`.` });
    expect(text).toContain(`✓ ${short(a1)} is 1 commit ahead of origin/main · held when written, changed since`);
    expect(text).toContain(`✓ ${short(l1)} is 1 commit ahead of main (local branch, last updated 2026-09-20 09:00 UTC by commit)`);
    expect(verifyStamps(text).failures).toEqual([]);
    expect(verifyStamps(text.replace("last updated 2026-09-20 09:00 UTC", "last updated 2026-09-22 09:00 UTC")).failures.join(" | ")).toContain("local branch label does not match");
  });

  test("the header counts existence checks, without claiming to verify file contents", async () => {
    const text = await rendered({ 1: Q1, 4: "The notes live in `docs/CHANGELOG.md`." });
    expect(text).toContain("## What the outgoing agent said (1 of 1 checkable claims checked · 0 of 1 false when written · 0 unchecked)");
    expect(text).toContain(`✓ path exists: docs/CHANGELOG.md (in ${repo}) — checked: test -e '${join(repo, "docs/CHANGELOG.md")}' → exists`);
    expect(verifyAnswerNotes(text)).toEqual([]);
  });
});

describe("§3 a relative path is checked in the repository the answers name", () => {
  test("`.local/run.json` is found in the named frontend, never in a third repository", async () => {
    const text = await rendered({ 1: Q1, 4: "The frontend has an untracked `.local/run.json`." });
    expect(text).toContain(`✓ path exists: .local/run.json (in ${frontend}) — checked: test -e '${join(frontend, ".local/run.json")}' → exists`);
    expect(text).not.toContain(join(old, ".local"));
    expect(verifyAnswerNotes(text)).toEqual([]);
    // the round-9 wrong evidence, planted: checked in a repository nobody named
    const planted = text.replace(join(frontend, ".local/run.json"), join(old, ".local/run.json"));
    expect(verifyAnswerNotes(planted).join(" | ")).toContain("which the answers do not name");
  });

  test("named in two repositories, both are listed", async () => {
    const text = await rendered({ 1: "It is `acme-frontend` and `acme-old`.", 4: "Both have `.local/run.json`." });
    expect(text).toContain(`✓ path exists: .local/run.json (in ${frontend} and ${old})`);
  });
});

describe("§5 numbers reserved in the answers, re-checked on origin", () => {
  test("rows proposed in a commit and taken on origin/main since are named, with the commits that took them", async () => {
    const text = await rendered({ 1: Q1, 4: `The changelog is \`docs/CHANGELOG.md\`.\nRows 4–5 are already proposed in \`${short(a1)}\`.` });
    expect(text).toContain(`↳ since written: rows 4–5 proposed in ${short(a1)} are now taken on origin/main by ${short(base)}, ${short(b0)} (docs/CHANGELOG.md in ${repo})`);
    expect(verifyAnswerNotes(text)).toEqual([]);
    expect(verifyAnswerNotes(text.replace(`by ${short(base)}, ${short(b0)}`, `by ${short(b0)}, ${short(base)}`)).join(" | ")).toContain("row 4 on origin/main is not");
  });
});

/* ------------------------------------------------------------------ *
 * §4 — length: the tail, stale lists, the footer
 * ------------------------------------------------------------------ */

const sessionId = "round9-fixture";
let seq = 0;
const cc = (kind: string, content: unknown, ts: string): CarafeEvent => ({ ts, tool: "claude-code", sessionId, seq: ++seq, kind, raw: { type: kind, message: { role: kind, content } } });
const user = (text: string, ts: string): CarafeEvent => cc("user", text, ts);
const said = (text: string, ts: string): CarafeEvent => cc("assistant", [{ type: "text", text }], ts);
const distillate = (events: CarafeEvent[]): SessionDistillate => ({
  tool: "claude-code", sessionId, sourcePath: "/tmp/s.jsonl", title: "round 9 fixture", cwd: "/tmp/project", gitBranch: "main",
  startTs: events[0]!.ts!, endTs: events.at(-1)!.ts!, eventCount: events.length, toolUseCount: 0, sidechain: false, rawBytes: 10, version: 1,
});

describe("§4 the tail is the last working day, dated; the file's length footer is true", () => {
  test("three turns at most, none from before the last working day, each with its date; the footer counts the file", () => {
    seq = 0;
    const events: CarafeEvent[] = [
      user("start the program", "2026-09-10T09:00:00Z"),
      ...Array.from({ length: 260 }, (_, index) => said(`filler ${index} ${"x".repeat(900)}`, "2026-09-10T09:30:00Z")),
      ...Array.from({ length: 6 }, (_, index) => [user(`old turn ${index}`, `2026-09-1${index}T10:00:00Z`), said(`old answer ${index}`, `2026-09-1${index}T10:01:00Z`)]).flat(),
      user("the last day, first ask", "2026-09-21T09:00:00Z"), said("done with the first ask", "2026-09-21T09:05:00Z"),
      user("the last day, second ask", "2026-09-21T15:00:00Z"), said("done with the second ask", "2026-09-21T15:05:00Z"),
    ];
    const d = distillate(events);
    const { text } = renderHandoff(d, events, { now: "2026-09-22T10:00:00Z" });
    const tail = text.slice(text.indexOf("## The tail, verbatim"), text.indexOf("## Dig deeper"));
    // the older turns (5 d before the end and more) are not in it, the last day's two are
    expect(tail).not.toContain("old turn");
    expect(tail).toContain("**user:** the last day, first ask");
    expect(tail).toContain("the last 2 turns");
    expect(tail).toContain("_2026-09-21 09:00 UTC · seq ");
    expect(tail).toContain("_2026-09-21 15:00 UTC · seq ");
    const footer = /^_Length: (\d+) lines outside the verbatim tail, (\d+) in all/m.exec(text)!;
    expect(Number(footer[2])).toBe((text.match(/\n/g) ?? []).length);
    expect(Number(footer[2])).toBeLessThanOrEqual(300);
    expect(verifyLayout(text, events)).toEqual([]);
    // planted: a wrong date, a wrong count
    expect(verifyLayout(text.replace("_2026-09-21 15:00 UTC · seq", "_2026-09-20 15:00 UTC · seq"), events).join(" | ")).toContain("tail date");
    expect(verifyLayout(text.replace(/^_Length: \d+/m, "_Length: 1"), events).join(" | ")).toContain("lines outside the tail");
  });

  test("one turn that ran for days keeps only its last day, the owner's ask and one line for the rest", () => {
    const pieces: EventPieces[] = [
      { seq: 10, kind: "user", lines: ["**user:** do it"], chars: 15, ts: "2026-09-17T10:00:00Z" },
      { seq: 11, kind: "assistant", lines: ["**assistant:** on the 17th"], chars: 25, ts: "2026-09-17T10:05:00Z" },
      { seq: 12, kind: "meta", lines: [], chars: 0, ts: null },
      { seq: 13, kind: "assistant", lines: ["**assistant:** still the 17th"], chars: 25, ts: "2026-09-17T11:00:00Z" },
      { seq: 14, kind: "assistant", lines: ["**assistant:** on the 21st"], chars: 25, ts: "2026-09-21T18:00:00Z" },
    ];
    const out = withoutOlderDays(sessionId, pieces);
    expect(out.map((piece) => piece.lines.join(""))).toEqual([
      "**user:** do it",
      `    […3 events from 2026-09-17, older than the last working day, omitted — carafe show ${sessionId} --seq 11-13]`,
      "**assistant:** on the 21st",
    ]);
    expect(datedTail(out)[0]!.lines[0]).toBe("_2026-09-17 10:00 UTC → 2026-09-21 18:00 UTC · seq 10–14_");
    const clipped = clipLongLines(sessionId, { seq: 14, kind: "user", lines: [`    ⤷ ${Array.from({ length: 50 }, (_, i) => `row ${i}`).join("\n    ")}`], chars: 400, ts: null }, 6);
    expect(clipped.lines[0]!.split("\n")).toHaveLength(7);
    expect(clipped.lines[0]).toContain(`[…44 more lines — carafe show ${sessionId} --seq 14]`);
  });

  test("questions older than a week before the end are dropped, and counted", () => {
    const ask = (seqNo: number, text: string): KeyMoment => ({ kind: "openask", seq: seqNo, text } as KeyMoment);
    const ts = new Map<number, string | null>([[5, "2026-09-10T10:00:00Z"], [6, "2026-09-12T10:00:00Z"], [7, "2026-09-20T10:00:00Z"]]);
    const lines = waitingLines([ask(5, "Ship it?"), ask(6, "Park it?"), ask(7, "Keep the flag?")], ts, "2026-09-21T18:00:00Z", sessionId);
    expect(lines).toContain(`_2 questions asked more than 7 days before the session ended were dropped as stale (the newest: carafe show ${sessionId} --seq 6)._`);
    expect(lines.some((line) => line.startsWith("- Keep the flag?"))).toBe(true);
    expect(lines.some((line) => line.includes("Park it?"))).toBe(false);
    // the gate re-derives "older than 7 days" from the trace
    const events = [5, 6, 7].map((n) => ({ ts: ts.get(n)!, tool: "claude-code", sessionId, seq: n, kind: "assistant", raw: {} }) as CarafeEvent);
    const file = [`# Handoff: x`, ``, `- session: ${sessionId} (claude-code) · 3 events · 0 tool calls · 2026-09-10T10:00:00Z → 2026-09-21T18:00:00Z`, ``, ...lines].join("\n");
    expect(verifyLayout(file, events)).toEqual([]);
    expect(verifyLayout(file.replace("--seq 6)", "--seq 7)"), events).join(" | ")).toContain("not older than 7 days");
  });

  test("rules said over 30 days before the end fold under one collapsed line with their count, unless repeated", () => {
    const ts = new Map<number, string | null>([[1, "2026-08-01T10:00:00Z"], [2, "2026-09-15T10:00:00Z"], [3, "2026-08-02T10:00:00Z"]]);
    const rules = [{ text: "do not push", seq: 2 }, { text: "never delete anything", seq: 1 }, { text: "do not spend credit", seq: 3 }];
    const lines = doNotLines(rules, ts, "2026-09-21T18:00:00Z", 8, (text) => text === "do not spend credit");
    expect(lines[2]).toStartWith(`- "do not push"`);
    expect(lines.some((line) => line.startsWith(`- "do not spend credit"`))).toBe(true);
    expect(lines).toContain("<details><summary>1 more, said over 30 days before the end and not repeated since</summary>");
    expect(lines.indexOf(`<details><summary>1 more, said over 30 days before the end and not repeated since</summary>`)).toBeLessThan(lines.findIndex((line) => line.startsWith(`- "never delete anything"`)));
  });
});

/* ------------------------------------------------------------------ *
 * §7 — leftovers from the gate fix
 * ------------------------------------------------------------------ */

describe("§7 labels, the pr label, turn lines, multi-line bodies", () => {
  test("two helpers whose ids share eight characters get labels that tell them apart", () => {
    const ids = ["01a0c52e-1111-7000-8000-000000000001", "01a0c52e-2222-7000-8000-000000000002", "agent-ad12cd34"];
    expect(agentLabel(ids[0]!, ids)).toBe("01a0c52e1");
    expect(agentLabel(ids[1]!, ids)).toBe("01a0c52e2");
    expect(agentLabel(ids[2]!, ids)).toBe("ad12cd34");
    expect(agentLabel("agent-ad12cd34")).toBe("ad12cd34");
    expect(uniquePrefix(ids[0]!, ids)).toBe("01a0c52e-1");
  });

  test("a tool result that mentions `gh pr` is not a pull request; a command that runs it is", () => {
    expect(isPrMoment("⤷ src/bench/generate.ts:89: const a = shell(`gh pr create --title x`)")).toBe(false);
    expect(isPrMoment("→ **Bash** gh pr create --title ship")).toBe(true);
    expect(isPrMoment(`→ **Bash** {"command":"git push && gh pr create --fill"}`)).toBe(true);
    expect(isPrMoment("→ **Bash** grep -rn 'gh pr' src")).toBe(false);
    expect(momentLabel({ kind: "artifact", seq: 1, text: "⤷ found: gh pr create in docs" } as KeyMoment)).toBe("commit");
  });

  test("a Key moments turn line is an anchored excerpt: its first line must be the turn's own", () => {
    const piece = (seqNo: number, ...lines: string[]): EventPieces => ({ seq: seqNo, kind: "user", lines, chars: 10, ts: null });
    const traces = new Map<string, EventPieces[][]>([["", [[piece(40, "**user:** ship the ${FLAG} change now")]]]]);
    const section = (line: string): string => ["## Key moments (deterministic, seq-anchored — selected from the WHOLE session, not just the tail)", "", "### Ch 3 · x", "  turns:", line, "", "## Dig deeper", ""].join("\n");
    const good = section("  - [seq 40–44] ship the ${FLAG} change now · 2 tools · a.ts · 3K");
    expect(anchoredExcerpts(good)).toHaveLength(1);
    expect(authoredLines(good).join("\n")).not.toContain("${FLAG}");
    expect(verifyAnchoredExcerpts(good, traces)).toEqual({ failures: [], checked: 1 });
    const fabricated = section("  - [seq 40–44] ship the ${OTHER} change now · 2 tools · a.ts · 3K");
    expect(verifyAnchoredExcerpts(fabricated, traces).failures).toHaveLength(1);
  });

  test("a multi-line excerpt keeps its later lines indented under its item", () => {
    expect(continued("first\n## not a heading\n- not a bullet")).toBe("first\n    ## not a heading\n    - not a bullet");
    const lines = waitingLines([{ kind: "openask", seq: 9, text: "Which one?\n## Option A\n- Option B" } as KeyMoment], new Map(), null);
    const body = lines.join("\n");
    expect(body).not.toMatch(/^## Option A/m);
    expect(body).not.toMatch(/^- Option B/m);
  });
});
