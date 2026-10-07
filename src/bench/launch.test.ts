import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { fixtureGit, launchFixture } from "../handoff/launch-fixture";
import { auditFacts } from "../handoff/audit";
import { checkRepo, realGitRunner } from "../handoff/live";
import { parseAnswers, answersLines, HANDOFF_QUESTIONS, splitAnswerSentences } from "../handoff/answers";
import { renderHandoff, HANDOFF_MAX_LINES, HANDOFF_MAX_BYTES, SMALL_ELISION_TURNS, turnListLines } from "../handoff/render";
import { authoredLines, outsideTail, stubLines, verifyPrintedText, verifyQuotes, verifyStamps } from "./handoff-real";
import { checkClaims } from "../handoff/claims";

for (const tool of ["codex", "claude-code"] as const) {
  test(`${tool}: launch audit rejects the planted branch/hash pairing, retains seven answers and checks each claim`, () => {
    const root = mkdtempSync(join(tmpdir(), "carafe-launch-"));
    try {
      const f = launchFixture(root, tool, `launch-${tool}`);
      const live = { checkedAt: "2026-09-21T12:00:00Z", repos: [f.repo, f.stub, f.worktree].map((p) => checkRepo(p, realGitRunner, Date.now())), health: [], live: false, remoteHeads: {} };
      const answers = parseAnswers(f.answers, "answers.md", "2026-09-20T10:00:00Z")!;
      const out = renderHandoff(f.d, f.events, { live, answers: [answers] });
      expect(out.audit!.dropped).toBeGreaterThan(0);
      expect(verifyPrintedText(out.text)).toEqual([]);
      expect(verifyQuotes(out.text, f.events, f.d.sessionId)).toEqual([]);
      expect(out.text).not.toContain(`repo \`${f.stub}\` · branch \`helper/backend-only\``);
      // round 8 — judged at the moment the answers were written (2026-09-20),
      // before this fixture's refs existed: the commit-content claim is still
      // false then; the cleanliness and the row on origin/main cannot be told
      // Round 10: existence checks and possible overlaps each carry a stamp;
      // the header must account for every printed claim, not a stale fixed six.
      const heading = /\((\d+) of (\d+) checkable claims checked · (\d+) of/.exec(out.text)!;
      const stamps = out.text.split("\n").filter((line) => /^    [✓✗?] /.test(line));
      expect(Number(heading[2])).toBe(stamps.length);
      expect(Number(heading[1])).toBe(stamps.filter((line) => /^    [✓✗] /.test(line)).length);
      expect(Number(heading[3])).toBe(1);
      expect(out.text).toContain("cannot tell whether it held when written");
      expect(out.text).toContain("1 modified (src/lib/core/engine.ts)");
      expect(out.text).toContain("newer file in that folder: brief-2.md (2026-09-19T10:00:00.000Z)");
      expect(out.text).toContain("written 2 h before the session's last message");
      expect(out.text).not.toContain("## Glossary"); expect(out.text).not.toContain("## Lessons");
      for (let n = 1; n <= 7; n++) expect(out.text).toContain(`### Q${n}.`);
      expect(outsideTail(out.text).split("\n").length).toBeLessThanOrEqual(HANDOFF_MAX_LINES);
      expect(Buffer.byteLength(outsideTail(out.text))).toBeLessThanOrEqual(HANDOFF_MAX_BYTES);
      const rehome = auditFacts([{ repo: f.stub, branch: "helper/backend-only" }], [f.repo]);
      // Two linked checkouts both verify: ambiguity must drop, never guess.
      expect(rehome.counts.dropped).toBe(1);
      const unique = auditFacts([{ repo: f.stub, branch: "helper/backend-only" }], [f.repo], (args, ms) => args.includes("worktree") ? "" : realGitRunner(args, ms));
      expect(unique.counts.rehomed).toBe(1);
      const helper = { sessionId: `agent-helper-${tool}`, events: [...f.call(`git -C '${f.repo}' branch --show-current`, "helper/backend-only")], cwd: f.stub };
      const helperOut = renderHandoff(f.d, f.events, { live, helperTraces: [helper] });
      expect(helperOut.text).not.toContain(`repo \`${f.stub}\` · branch \`helper/backend-only\``);
      expect(verifyPrintedText(helperOut.text)).toEqual([]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}
test("answer sentence splitting preserves file paths and all seven questions", () => {
  expect(HANDOFF_QUESTIONS).toHaveLength(7);
  expect(splitAnswerSentences("src/lib/core/engine.ts exists in a645c32. Next sentence.")).toEqual(["src/lib/core/engine.ts exists in a645c32.", "Next sentence."]);
});

/**
 * The three shapes the launch gate found on real sessions, as fixtures:
 * a full-tier file whose whole body is the trace, a layered file whose prefix
 * wants more than the budget, and a trace with no opening prompt.
 */
for (const tool of ["codex", "claude-code"] as const) {
  test(`${tool}: the budget and the authored-line checks hold on every rendered shape`, () => {
    const root = mkdtempSync(join(tmpdir(), "carafe-shapes-"));
    try {
      const f = launchFixture(root, tool, `shapes-${tool}`);
      const live = { checkedAt: "2026-09-21T12:00:00Z", repos: [f.repo, f.stub, f.worktree].map((p) => checkRepo(p, realGitRunner, Date.now())), health: [], live: false, remoteHeads: {} };

      // 1. FULL TIER — a short session renders the faithful whole trace. Its
      // body is verbatim, so it is not the readable-in-one-sitting budget's.
      const short = { ...f.d, sessionId: `${f.d.sessionId}-short` };
      const shortEvents = f.events.slice(0, 13).map((e) => ({ ...e, sessionId: short.sessionId }));
      const full = renderHandoff(short, shortEvents, { live });
      expect(full.tier).toBe("full");
      const fullOutside = outsideTail(full.text);
      expect(fullOutside).not.toContain("Prepare the backend launch handoff");
      expect(fullOutside.split("\n").length).toBeLessThanOrEqual(HANDOFF_MAX_LINES);
      expect(Buffer.byteLength(fullOutside)).toBeLessThanOrEqual(HANDOFF_MAX_BYTES);

      // 2. LAYERED, oversized prefix — one answer of 400 sentences, each of
      // which is checked and stamped. Whole blocks give way; the budget holds
      // exactly as the gate measures it, trailing newline included.
      const many = Array.from({ length: 400 }, (_, i) => `In ${f.repo}, ${f.head} is on origin (note ${i}).`).join("\n");
      const answers = parseAnswers(`tool: ${tool}\n\n## Q2\n${many}\n`, "answers.md", "2026-09-20T10:00:00Z")!;
      const big = renderHandoff(f.d, f.events, { live, answers: [answers] });
      const outside = outsideTail(big.text);
      expect(outside.split("\n").length).toBeLessThanOrEqual(HANDOFF_MAX_LINES);
      expect(Buffer.byteLength(outside)).toBeLessThanOrEqual(HANDOFF_MAX_BYTES);
      expect(outside).toContain("## Right now");
      // B3: the answers give way one question at a time, never as a whole block
      expect(outside).toContain("## What the outgoing agent said (");
      expect(outside).toContain("the remaining answers did not fit here");
      expect(stubLines(outside)).toBe(0);
      expect(verifyPrintedText(big.text)).toEqual([]);

      // 3. no opening prompt — nothing is anchored to a sequence that is not there
      const headless = { ...f.d, sessionId: `${f.d.sessionId}-headless` };
      const noPrompt = renderHandoff(headless, f.events.slice(1).map((e) => ({ ...e, sessionId: headless.sessionId })), { live });
      expect(authoredLines(noPrompt.text).join("\n")).not.toContain("[seq 0]");
      expect(verifyQuotes(noPrompt.text, f.events.slice(1), headless.sessionId)).toEqual([]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}

test("a shell variable in the trace is carried; one in a line carafe wrote is a leak", () => {
  const carried = ["## Do not", "", "[seq 4]", "> never run $DEPLOY without asking", "", "## Dig deeper", "", "carafe chapters x"].join("\n");
  expect(authoredLines(carried).join("\n")).not.toContain("$DEPLOY");
  const leaked = ["## Right now", "", "- repo `/srv/$APP` · branch `main`", "", "## Dig deeper", ""].join("\n");
  expect(authoredLines(leaked).join("\n")).toContain("$APP");
  const lesson = ["## Lessons", "", "- 2026-09-21 · dead end: Bash: export PATH=\"$HOME/.bun/bin\" && bun test → failed  [seq 9]", ""].join("\n");
  expect(authoredLines(lesson).join("\n")).not.toContain("$HOME");
});

test("only `- repo \`…\`` lines under Right now / Last seen are machine facts; a Glossary entry for the word repo is prose", () => {
  const missing = "/nonexistent/carafe-gate-repo";
  const text = [
    "## Right now (checked at 2026-09-22 10:00 UTC, when this handoff was written)", "",
    `- repo \`${missing}\` · branch \`main\``, "",
    "## Glossary", "",
    `- repo (49 turns): "the repo is where the work lives"`,
    `- repo \`${missing}\` · branch \`not-a-fact-here\``, "",
    "## Last seen (verified objects from the trace; not current checkout state)", "",
    `- repo \`${missing}\` · branch \`old\``, "",
  ].join("\n");
  const failures = verifyPrintedText(text, () => null);
  expect(failures).toEqual([`- repo \`${missing}\` · branch \`main\``, `- repo \`${missing}\` · branch \`old\``]);
  // A Glossary alone yields nothing to verify, and nothing false.
  expect(verifyPrintedText(["## Glossary", "", `- repo (49 turns): "…"`].join("\n"), () => null)).toEqual([]);
});

test("a small elided remainder is printed; a large one puts its pointer on the header, never on a line of its own", () => {
  const turns = (n: number) => Array.from({ length: n }, (_, i) => `- [seq ${i + 1}] turn ${i + 1}`);
  const pointer = "carafe chapters abc --chapter 5";
  // 15 turns under a cap of 14: the one extra turn is printed, not replaced by "… 1 more turns — …"
  const small = turnListLines(turns(14 + SMALL_ELISION_TURNS), 14, pointer);
  expect(small).toHaveLength(1 + 14 + SMALL_ELISION_TURNS);
  expect(small.join("\n")).not.toContain(pointer);
  expect(stubLines(small.join("\n"))).toBe(0);
  const large = turnListLines(turns(40), 14, pointer);
  expect(large[0]).toBe(`  turns: first 3 and last 11 of 40 — all of them: ${pointer}`);
  expect(large).toContain("  …");
  expect(large.filter((l) => l.startsWith("  - [seq "))).toHaveLength(14);
  expect(large.at(-1)).toBe("  - [seq 40] turn 40");
  expect(stubLines(large.join("\n"))).toBe(0);
  expect(turnListLines(turns(2), 14, pointer)).toEqual(["  turns:", "  - [seq 1] turn 1", "  - [seq 2] turn 2"]);
});

test("a count with a retrieval command is a stub; a pointer to a missing step is not", () => {
  expect(stubLines("  … 12 more turns — carafe chapters abc --chapter 1")).toBe(1);
  expect(stubLines("  +4 more — git -C /srv/app for-each-ref --no-merged origin/main refs/heads")).toBe(0);
  expect(stubLines(`_No answers file. Ask the outgoing agent to run: carafe handoff abc --questions_`)).toBe(0);
});

test("the batched unpushed reading answers exactly what the per-branch one did", () => {
  const root = mkdtempSync(join(tmpdir(), "carafe-unpushed-"));
  try {
    const f = launchFixture(root, "codex", "unpushed");
    // one branch on the remote, one only here, one behind the remote tip
    fixtureGit(f.repo, "checkout", "-q", "-b", "only-here");
    writeFileSync(join(f.repo, "local-only.txt"), "only on this disk\n");
    fixtureGit(f.repo, "add", "."); fixtureGit(f.repo, "commit", "-qm", "a commit no remote has");
    fixtureGit(f.repo, "checkout", "-q", "main");
    fixtureGit(f.repo, "branch", "also-there", "origin/main");
    fixtureGit(f.repo, "branch", "older", f.first);
    const batched = checkRepo(f.repo, realGitRunner, Date.now());
    const perBranch = checkRepo(f.repo, (args, ms) => args.includes("--no-walk") ? null : realGitRunner(args, ms), Date.now());
    expect(batched.unpushed).toEqual(perBranch.unpushed);
    expect(batched.unpushed.map((b) => b.branch)).toContain("only-here");
    expect(batched.unpushed.map((b) => b.branch)).not.toContain("also-there");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the gate fails a stamp that shortened a path at a space, and one whose reading has moved", () => {
  const root = mkdtempSync(join(tmpdir(), "carafe-truncation-"));
  try {
    // two real repositories, one of whose paths is a prefix of the other's
    const short = join(root, "acme"), long = join(root, "acme work repos");
    for (const dir of [short, long]) {
      mkdirSync(dir); fixtureGit(dir, "init", "-q", "-b", "main");
      fixtureGit(dir, "config", "user.email", "test@example.com"); fixtureGit(dir, "config", "user.name", "Fixture"); fixtureGit(dir, "config", "commit.gpgsign", "false");
      writeFileSync(join(dir, "a.txt"), "one\n"); fixtureGit(dir, "add", "."); fixtureGit(dir, "commit", "-qm", "initial");
    }
    writeFileSync(join(short, "a.txt"), "changed\n");
    // round 8 — a ✗ on cleanliness is itself refused (git keeps no past for a
    // working tree), so the planted stamp is a ✓ whose reading is re-run
    const file = (stampPath: string, value: string, mark = "✓"): string => [
      "# Handoff: planted", "", "## What the outgoing agent said (1 of 1 checkable claims checked · 0 of 1 false when written · 0 unchecked)", "",
      `> the worktree \`${long}\` is clean`,
      `    ${mark} ${stampPath} is clean — checked: git -C '${stampPath}' status --porcelain → ${value}`,
      "", "## The tail, verbatim (seq 1 → 2)", "", "nothing", "", "## Dig deeper", "", "carafe chapters planted", "",
    ].join("\n");

    // the exact bug: the stamp is about a DIFFERENT repository, reached by
    // cutting the sentence's path at its first space
    const truncated = verifyStamps(file(short, "1 modified (a.txt)"));
    expect(truncated.failures.join(" | ")).toContain("shortened a path");

    // the same stamp about the path the sentence really names, and true
    writeFileSync(join(long, "a.txt"), "changed\n");
    expect(verifyStamps(file(long, "1 modified (a.txt)")).failures).toEqual([]);

    // …and a reading that no longer holds is a false statement too
    const stale = verifyStamps(file(long, "0 modified"));
    expect(stale.failures.join(" | ")).toContain("no longer holds");
    expect(stale.checked).toBe(1);
    // …and a ✗ on a working tree's cleanliness is a false statement about the past
    expect(verifyStamps(file(long, "1 modified (a.txt)", "✗")).failures.join(" | ")).toContain("cleanliness");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a claim's subject is a token the sentence names, or there is no claim", () => {
  const root = mkdtempSync(join(tmpdir(), "carafe-subjects-"));
  try {
    const f = launchFixture(root, "codex", "subjects");
    fixtureGit(f.repo, "checkout", "-q", "-b", "only-here");
    writeFileSync(join(f.repo, "local-only.txt"), "only here\n");
    fixtureGit(f.repo, "add", "."); fixtureGit(f.repo, "commit", "-qm", "a commit no remote has");
    const local = fixtureGit(f.repo, "rev-parse", "HEAD"); // full hash: a 7-char one may lack a digit or a letter and is rightly not a hash
    fixtureGit(f.repo, "checkout", "-q", "main");
    const live = { checkedAt: "2026-09-21T12:00:00Z", repos: [f.repo, f.stub].map((p) => checkRepo(p, realGitRunner, Date.now())), health: [], live: false, remoteHeads: {} };
    const check = (sentence: string) => checkClaims(sentence, { live, git: realGitRunner }).filter((c) => c.checkable);

    // bare prose is not a subject: no claim, nothing counted
    expect(check("Only src/ on origin matters now.")).toEqual([]);
    expect(check("Two unpushed things remain.")).toEqual([]);
    expect(check("…which is local only.")).toEqual([]);

    // the hashes in the sentence are the subjects, and one read answers for them
    const unpushed = check(`Two unpushed commits sit on \`only-here\`: \`${local}\` and nothing else.`);
    expect(unpushed).toHaveLength(1);
    expect(unpushed[0]!.stamp).toBe("✓");
    expect(unpushed[0]!.command).toContain("rev-list --no-walk");

    // a hash that IS on the remote, claimed local only, is contradicted
    const wrong = check(`The deploy commit ${f.head} is local only.`);
    expect(wrong[0]!.stamp).toBe("✗");
    expect(wrong[0]!.command).toContain("branch -r --contains");

    // the row, the ref and the hash need not sit next to each other
    const row = check(`Row 42 on \`origin/main\` is the deploy commit (${f.head}) in \`CHANGELOG.md\`.`);
    expect(row).toHaveLength(1);
    expect(row[0]!.stamp).toBe("✗");
    expect(row[0]!.value).toContain("| 42 |");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
