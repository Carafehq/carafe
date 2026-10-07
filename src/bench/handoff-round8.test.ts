/**
 * Round 8 — every finding both judges verified, as a fixture.
 *
 * One mkdtemp workspace whose folder name has spaces; git's own clock is set
 * per step (GIT_COMMITTER_DATE writes the reflog's timestamps too), so the
 * moment the answers were written sits between real reflog entries:
 *
 *   2026-09-20 10:00  main = base, pushed (origin/main created by push)
 *   2026-09-21 09:00  worktree acme-backend-status on codex/status-copy
 *   2026-09-21 10:00  a1 "explicit cancel" on codex/status-copy
 *   2026-09-21 18:05  ← the answers are written (T)
 *   2026-09-22 11:08  main fast-forwards to a1 and is pushed: origin/main moves by push
 *   2026-09-22 18:00  a2 on codex/status-copy; the worktree is then left dirty
 *   2026-09-22 19:00  ← the handoff is generated
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { checkLive, liveLines, realGitRunner, type LiveState } from "../handoff/live";
import { answersLines, parseAnswers, type AnswerFile } from "../handoff/answers";
import { reposNamedIn, sinceSection } from "../handoff/since";
import { isDeadEndSentence } from "../handoff/orient";
import { withoutEmptyChapters } from "../handoff/render";
import { verifyPrintedText, verifyStamps } from "./handoff-real";

const T = "2026-09-21T18:05:00Z";
const CHECKED = "2026-09-22T19:00:00Z";

let ws = "", repo = "", status = "", stub = "";
let base = "", a1 = "", a2 = "";
const short = (hash: string): string => hash.slice(0, 7);

function git(dir: string, at: string, ...args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], {
    encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_NAME: "fixture", GIT_AUTHOR_EMAIL: "f@example.com", GIT_COMMITTER_NAME: "fixture", GIT_COMMITTER_EMAIL: "f@example.com", GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at },
  }).trim();
}

beforeAll(() => {
  ws = mkdtempSync(join(tmpdir(), "carafe round 8 "));
  const origin = join(ws, "the origin.git");
  repo = join(ws, "acme-backend");
  status = join(ws, "acme-backend-status");
  stub = join(ws, "empty stub");
  execFileSync("git", ["init", "-q", "--bare", origin]);
  mkdirSync(repo); mkdirSync(stub);
  git(repo, "2026-09-20T10:00:00Z", "init", "-q", "-b", "main");
  git(repo, "2026-09-20T10:00:00Z", "config", "commit.gpgsign", "false");
  mkdirSync(join(repo, "docs"));
  writeFileSync(join(repo, "docs", "notes.md"), "notes\n");
  git(repo, "2026-09-20T10:00:00Z", "add", ".");
  git(repo, "2026-09-20T10:00:00Z", "commit", "-q", "-m", "base");
  base = git(repo, "2026-09-20T10:00:00Z", "rev-parse", "HEAD");
  git(repo, "2026-09-20T10:05:00Z", "remote", "add", "origin", origin);
  git(repo, "2026-09-20T10:05:00Z", "push", "-q", "origin", "main");
  git(repo, "2026-09-21T09:00:00Z", "worktree", "add", "-q", "-b", "codex/status-copy", status, "main");
  writeFileSync(join(status, "cancel.ts"), "export const cancel = 1;\n");
  git(status, "2026-09-21T10:00:00Z", "add", ".");
  git(status, "2026-09-21T10:00:00Z", "commit", "-q", "-m", "an explicit cancel so Stop really stops the work");
  a1 = git(status, "2026-09-21T10:00:00Z", "rev-parse", "HEAD");
  // after the answers were written
  git(repo, "2026-09-22T11:00:00Z", "merge", "-q", "--ff-only", "codex/status-copy");
  git(repo, "2026-09-22T11:08:00Z", "push", "-q", "origin", "main");
  writeFileSync(join(status, "cancel.ts"), "export const cancel = 2;\n");
  git(status, "2026-09-22T18:00:00Z", "commit", "-q", "-am", "cancel, the second pass");
  a2 = git(status, "2026-09-22T18:00:00Z", "rev-parse", "HEAD");
  writeFileSync(join(status, "cancel.ts"), "export const cancel = 3;\n");
  git(stub, "2026-09-20T09:00:00Z", "init", "-q", "-b", "master");
  git(stub, "2026-09-20T09:00:00Z", "commit", "-q", "--allow-empty", "-m", "init empty stub");
});
afterAll(() => { if (ws) rmSync(ws, { recursive: true, force: true }); });

const liveNow = async (): Promise<LiveState> => checkLive([repo, stub], { now: CHECKED });
const answersOf = (body: string): AnswerFile => parseAnswers(`tool: claude-code\n\n## Q2\n${body}\n`, join(ws, "answers.md"), T)!;

describe("§1 a claim is judged at the moment it was written", () => {
  test("a ref that moved after T is ✓ held when written · changed since — never ✗", async () => {
    const live = await liveNow();
    const text = answersLines([answersOf([
      `\`${short(base)}\` is the head of \`origin/main\` in \`acme-backend\`.`,
      `The branch \`codex/status-copy\`, head \`${short(a1)}\`, one commit ahead of \`main\`.`,
    ].join("\n"))], { live }).join("\n");
    const stamps = text.split("\n").filter((line) => /^ {4}[✓✗?]/.test(line));
    expect(stamps.filter((line) => line.trimStart().startsWith("✗"))).toEqual([]);
    const head = stamps.find((line) => line.includes(`${short(base)} is the head of origin/main`))!;
    expect(head).toStartWith("    ✓ ");
    expect(head).toContain("· held when written, changed since");
    expect(text).toContain(`held, changed since · origin/main was ${short(base)}`);
    expect(stamps.find((line) => line.includes(`${short(a1)} is the head of codex/status-copy`))).toContain("changed since");
    // one commit ahead of main THEN (origin/main was base), none now — round 9:
    // "main" is checked as origin's default branch, not the local ref
    expect(stamps.find((line) => line.includes(`${short(a1)} is 1 commit ahead of origin/main`))).toContain("held when written, changed since");
    expect(text).toContain("## What the outgoing agent said (3 of 3 checkable claims checked · 0 of 3 false when written · 0 unchecked)");
    // the gate re-derives every when-written reading from the reflog itself
    expect(verifyStamps(text).failures).toEqual([]);
  });

  test("✗ only when git proves the opposite AT that moment — even when it holds now", async () => {
    const live = await liveNow();
    const text = answersLines([answersOf(`\`${short(a1)}\` is the head of \`main\` in \`acme-backend\`.`)], { live }).join("\n");
    const stamp = text.split("\n").find((line) => line.includes(`${short(a1)} is the head of origin/main`))!;
    expect(stamp).toStartWith("    ✗ ");
    expect(stamp).toContain("· false when written");
    expect(text).toContain(`false · origin/main was ${short(base)}`);
    expect(text).toContain("1 of 1 false when written");
    expect(verifyStamps(text).failures).toEqual([]);
  });

  test("a worktree that moved and got dirty after T is ? — never ✗", async () => {
    const live = await checkLive([repo, status, stub], { now: CHECKED });
    const text = answersLines([answersOf(`The worktree \`${status}\` is clean.`)], { live }).join("\n");
    const stamp = text.split("\n").find((line) => /^ {4}\S.* is clean/.test(line))!;
    expect(stamp).toStartWith("    ? ");
    expect(stamp).toContain("cannot tell whether it held when written");
    expect(text).toContain(`HEAD moved ${short(a1)} → ${short(a2)} (2026-09-22 18:00 UTC)`);
    expect(text).toContain("now 1 modified, 0 untracked");
    expect(text).not.toMatch(/^ {4}✗/m);
  });

  test("the gate refuses a ✗ on a ref with no proof at T, a ✗ on cleanliness, and evidence the reflog does not bear out", async () => {
    const live = await liveNow();
    const honest = answersLines([answersOf(`\`${short(base)}\` is the head of \`origin/main\` in \`acme-backend\`.`)], { live }).join("\n");
    // a changed-since reading rewritten as a plain ✗ (round 8's bug)
    const planted = honest.replace(/ {4}✓ (.*) · held when written, changed since/, "    ✗ $1").replace(/\n {6}↳ .*/, "");
    expect(verifyStamps(planted).failures.join(" | ")).toContain("without proof at the time of writing");
    // evidence naming the wrong value at T
    const lying = honest.replace(`origin/main was ${short(base)}`, `origin/main was ${short(a1)}`);
    expect(verifyStamps(lying).failures.join(" | ")).toContain("does not match the reflog");
  });
});

describe("§2 Since the agent wrote this", () => {
  test("names what landed, what moved, and a worktree someone is working in", async () => {
    const live = await checkLive([repo, status, stub], { now: CHECKED });
    live.health = [{ url: "https://api.example.invalid/health", body: `{"status":"ok","commit":"${short(a2)}"}`, error: null, decision: "allow" }];
    const answers = [answersOf(`The work is on branch \`codex/status-copy\`, head \`${short(a1)}\`, in \`acme-backend\`; nothing is merged.`)];
    const { lines } = sinceSection({ answers, live, git: realGitRunner, now: CHECKED });
    const text = lines.join("\n");
    expect(lines[0]).toBe("## Since the agent wrote this (2026-09-21 18:05 UTC → checked 2026-09-22 19:00 UTC)");
    expect(text).toContain(`- ${repo}`);
    expect(text).toContain(`origin/main moved ${short(base)} → ${short(a1)} (2026-09-22 11:08 UTC, by push)`);
    expect(text).toContain(`${short(a1)} (codex/status-copy) is now on origin/main (landed 2026-09-22 11:08 UTC via ${short(a1)}, by push)`);
    // git prints a linked worktree's real path (macOS: /private/var/… for /var/…)
    const moved = `codex/status-copy moved ${short(a1)} → ${short(a2)} (+1, 2026-09-22 18:00 UTC); its worktree `;
    const tail = ` now has 1 uncommitted file (1 modified, 0 untracked) — someone is working there`;
    expect([status, realpathSync(status)].some((path) => text.includes(`${moved}${path}${tail}`))).toBe(true);
    expect(text).toContain(`https://api.example.invalid/health reports ${short(a2)}, which contains ${short(a1)}`);
    // linked worktrees share one object store: the repository is reported once
    expect(text.split("\n").filter((line) => line.startsWith("- /")).length).toBe(1);
    // every line re-derives
    expect(verifyPrintedText(`# Handoff: x\n\n${text}\n`)).toEqual([]);
    // …and a planted line does not
    const planted = text.replace(`${short(a1)} (codex/status-copy) is now on`, `${short(base)} is now on`);
    expect(verifyPrintedText(`# Handoff: x\n\n${planted}\n`).join(" | ")).toContain("already on origin/main");
    const wrongThen = text.replace(`codex/status-copy moved ${short(a1)} →`, `codex/status-copy moved ${short(base)} →`);
    expect(verifyPrintedText(`# Handoff: x\n\n${wrongThen}\n`).join(" | ")).toContain("when the answers were written");
  });

  test("a plain word is not a repository name", () => {
    const repos = [{ path: "/w/carafe", notChecked: null }, { path: "/w/acme-api", notChecked: null }];
    expect(reposNamedIn("the Mac ran out of disk, traced to carafe's snapshot store", repos)).toEqual([]);
    expect(reposNamedIn("the carafe repo `carafe` has it", repos)).toEqual(["/w/carafe"]);
    expect(reposNamedIn("row 44 on origin/main in acme-api", repos)).toEqual(["/w/acme-api"]);
    expect(reposNamedIn("in /w/acme-api-status", repos)).toEqual([]);
  });
});

describe("§3 the two falsehood classes the gate missed", () => {
  test("a remote ref updated today by push is labelled today, from its own reflog", async () => {
    const text = liveLines(await liveNow()).join("\n");
    expect(text).toContain(`origin/main at ${short(a1)} "an explicit cancel so Stop really stops the work" (local ref, updated today 11:08 UTC by push)`);
    expect(text).not.toContain("last fetched");
    expect(verifyPrintedText(text)).toEqual([]);
    // the round-8 label, planted, fails; so does a date the reflog does not bear out
    expect(verifyPrintedText(text.replace("updated today 11:08 UTC by push", "last fetched 2 d ago")).join(" | ")).toContain("FETCH_HEAD");
    expect(verifyPrintedText(text.replace("updated today 11:08 UTC by push", "updated 2026-09-20 10:05 UTC by push, 2 d ago")).join(" | ")).toContain("does not match the reflog");
  });

  test("a push filed under a repository without that branch fails the gate; one that resolves passes", () => {
    const section = (under: string, body: string): string => ["# Handoff: x", "", "## Last seen in the session (from the trace, may be stale)", "", `- ${under}`, body, ""].join("\n");
    expect(verifyPrintedText(section(stub, "  pushed: codex/status-copy (old) [seq 5]")).join(" | ")).toContain("does not resolve");
    expect(verifyPrintedText(section(repo, "  pushed: codex/status-copy (old) [seq 5]"))).toEqual([]);
    // the commits listed for a branch must be on it, in that repository
    expect(verifyPrintedText(section(repo, `  for codex/status-copy: an explicit cancel so Stop really stops the work  [seq 7]`))).toEqual([]);
    expect(verifyPrintedText(section(repo, `  for codex/status-copy: a correction note nobody committed  [seq 7]`)).join(" | ")).toContain("is not on it");
    expect(verifyPrintedText(section(stub, `  for codex/status-copy: an explicit cancel so Stop really stops the work  [seq 7]`)).join(" | ")).toContain("does not resolve");
    // …and in the section that lists pushes by repository path
    const shipped = (under: string): string => ["# Handoff: x", "", "## What reached a remote, last 7 days (from the trace)", "", `- 2026-09-22 11:08 UTC · ${under} · main · ${short(a1)} "an explicit cancel so Stop really stops the work"  [seq 9]`, ""].join("\n");
    expect(verifyPrintedText(shipped(repo))).toEqual([]);
    const planted = verifyPrintedText(shipped(stub)).join(" | ");
    expect(planted).toContain("does not resolve");
    expect(planted).toContain("is not in the repository it is filed under");
  });
});

describe("§5 more checkable claims, honest coverage", () => {
  test("ancestry, word counts and named paths are checked; a bare hash is found, not checked", async () => {
    const live = await liveNow();
    const text = answersLines([answersOf([
      `\`${short(base)}\` is an ancestor of \`${short(a1)}\`.`,
      "The plan is in `acme-backend/specs/PLAN.md`, and the notes are in `docs/notes.md`.",
      `\`${short(a1)}\` introduced the cancel endpoint.`,
    ].join("\n"))], { live }).join("\n");
    expect(text).toContain(`✓ ${short(base)} is an ancestor of ${short(a1)}`);
    // a path relative to the repository it names, missing now — round 9: an
    // existence reading is a note, never a checked claim
    expect(text).toContain("? path not found now: acme-backend/specs/PLAN.md — checked: test -e ");
    expect(text).toContain("not found now");
    expect(text).toContain("✓ path exists: docs/notes.md");
    // a hash that merely exists is a note on one line, and the sentence counts as found-not-checked
    expect(text).toContain(`· named, not checked: ${short(a1)} (in ${repo})`);
    expect(text).toMatch(/\((\d+) of (\d+) checkable claims checked/);
    const [, checked, found] = /\((\d+) of (\d+) checkable claims checked/.exec(text)!;
    expect(Number(found)).toBeGreaterThan(Number(checked));
    expect(verifyStamps(text).failures).toEqual([]);
  });

  test("a ref is never read as a path", async () => {
    const live = await liveNow();
    const text = answersLines([answersOf("Row 44 on `origin/main` is taken, and `codex/status-copy` is the branch.")], { live }).join("\n");
    expect(text).not.toContain("origin/main exists");
    expect(text).not.toContain("codex/status-copy exists");
  });
});

describe("§4 noise", () => {
  test("a dead end says something was tried and dropped", () => {
    expect(isDeadEndSentence("Vacuous tests: found none")).toBe(false);
    expect(isDeadEndSentence("This layer exists because conversations are stateful")).toBe(false);
    expect(isDeadEndSentence("Rail tile label must never reach a tile")).toBe(false);
    expect(isDeadEndSentence("It took two rounds because the first fix tested the wrong layer.")).toBe(true);
    expect(isDeadEndSentence("We tried the cache first and backed out.")).toBe(true);
  });

  test("a chapter heading with nothing under it is dropped", () => {
    expect(withoutEmptyChapters(["## Key moments", "", "### Ch 1 · empty · 3 moments · carafe chapters x --chapter 1", "### Ch 2 · full", "- decision: ship it  [seq 4]", ""]))
      .toEqual(["## Key moments", "", "### Ch 2 · full", "- decision: ship it  [seq 4]", ""]);
  });
});
