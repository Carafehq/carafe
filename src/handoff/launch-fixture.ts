/** Shared isolated fixture builder. Callers own ONE temporary workspace. */
import { mkdirSync, writeFileSync, utimesSync } from "fs";
import { join } from "path";
import { execFileSync } from "child_process";
import type { CarafeEvent } from "../format/events";
import type { SessionDistillate } from "../format/distillate";
import { CarafeStore } from "../format/store";
import { sealSession } from "../format/sessions";
import { writeDistillate } from "../format/distillate";
export const fixtureGit = (repo: string, ...args: string[]): string => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
export function launchFixture(root: string, tool: "codex" | "claude-code", id: string) {
  const base = join(root, `${id} workspace`); mkdirSync(base, { recursive: true });
  const repo = join(base, "acme backend"), stub = join(base, "empty stub"), worktree = join(base, "backend review");
  for (const dir of [repo, stub]) {
    mkdirSync(dir); fixtureGit(dir, "init", "-q", "-b", "main");
    fixtureGit(dir, "config", "user.email", "test@example.com"); fixtureGit(dir, "config", "user.name", "Fixture"); fixtureGit(dir, "config", "commit.gpgsign", "false");
    writeFileSync(join(dir, "README.md"), "Fixture project.\n"); fixtureGit(dir, "add", "."); fixtureGit(dir, "commit", "-qm", dir === stub ? "init empty stub" : "initial backend");
  }
  const first = fixtureGit(repo, "rev-parse", "HEAD");
  mkdirSync(join(repo, "src/lib/core"), { recursive: true });
  writeFileSync(join(repo, "src/lib/core/engine.ts"), "export function launchEngine() { return true; }\n");
  writeFileSync(join(repo, "CHANGELOG.md"), `| 42 | ${first} | previous change |\n`);
  fixtureGit(repo, "add", "."); fixtureGit(repo, "commit", "-qm", "implement launch engine");
  const head = fixtureGit(repo, "rev-parse", "HEAD");
  fixtureGit(repo, "update-ref", "refs/remotes/origin/main", head);
  fixtureGit(repo, "branch", "helper/backend-only");
  fixtureGit(repo, "worktree", "add", "-q", "-b", "review/engine", worktree);
  writeFileSync(join(worktree, "src/lib/core/engine.ts"), "export function launchEngine() { return false; }\n");
  writeFileSync(join(base, "brief-1.md"), "Old brief.\n"); writeFileSync(join(base, "brief-2.md"), "New brief.\n");
  utimesSync(join(base, "brief-1.md"), new Date("2026-09-18T10:00:00Z"), new Date("2026-09-18T10:00:00Z"));
  utimesSync(join(base, "brief-2.md"), new Date("2026-09-19T10:00:00Z"), new Date("2026-09-19T10:00:00Z"));
  let seq = 0;
  const event = (kind: string, raw: unknown): CarafeEvent => ({ seq: ++seq, tool, sessionId: id, kind, ts: "2026-09-20T12:00:00Z", raw });
  const say = (role: string, text: string): CarafeEvent => event(role, tool === "codex" ? { payload: { message: text } } : { type: role, message: { role, content: role === "user" ? text : [{ type: "text", text }] } });
  const call = (command: string, output: string): CarafeEvent[] => {
    const callId = `call-${seq}`;
    return tool === "codex" ? [event("tool_use", { payload: { call_id: callId, name: "exec_command", arguments: { command } } }), event("tool_result", { payload: { call_id: callId, output } })]
      : [event("assistant", { message: { role: "assistant", content: [{ type: "tool_use", id: callId, name: "Bash", input: { command } }] } }), event("user", { message: { role: "user", content: [{ type: "tool_result", tool_use_id: callId, content: output }] } })];
  };
  const events = [say("user", "Prepare the backend launch handoff. Do not push without my approval."), ...call(`git -C '${stub}' branch --show-current`, "helper/backend-only"), ...call(`git -C '${stub}' rev-parse HEAD`, fixtureGit(stub, "rev-parse", "HEAD")), ...call(`git -C '${repo}' branch --show-current`, "main"), ...call(`git -C '${repo}' rev-parse HEAD`, head), ...call(`git -C '${worktree}' status --porcelain`, " M src/lib/core/engine.ts"), say("assistant", "The engine check is complete. The review worktree still needs attention.")];
  // Past HANDOFF_BUDGET_CHARS, so the fixture exercises the orientation layer
  // (the launch bar is about that document), not the faithful full-trace tier.
  while (events.length < 260) events.push(say("assistant", `Routine progress note ${events.length}. ${"Nothing to decide here. ".repeat(60)}`));
  const d: SessionDistillate = { version: 1, tool, sessionId: id, sourcePath: join(base, "trace.jsonl"), title: "Backend launch handoff", cwd: stub, gitBranch: "main", startTs: events[0]!.ts!, endTs: events.at(-1)!.ts!, lastActivityTs: "2026-09-20T12:00:00Z", eventCount: events.length, toolUseCount: 5, sidechain: false, rawBytes: 1, hasUserText: true };
  const answers = `tool: ${tool}\n\n## Q1\nThe backend serves the launch engine.\n\n## Q2\nIn \`${repo}\`, \`src/lib/core/engine.ts\` is outstanding in ${head}.\nIn \`${repo}\`, \`launchEngine\` is implemented in ${head}.\nIn \`${repo}\`, row 42 on \`origin/main\` is ${head} in \`CHANGELOG.md\`.\n\n## Q3\n\`${worktree}\` is committed and clean.\nIn \`${repo}\`, ${head} is on origin.\n\n## Q4\nThe latest brief is \`${join(base, "brief-1.md")}\`.\n\n## Q5\nReview the modified engine before pushing.\n\n## Q6\nI mistook the review worktree for a clean checkout; the engine edit was still present.\n\n## Q7\nThe launch engine is the backend request handler.\n`;
  return { repo, stub, worktree, head, first, d, events, answers, call, say };
}
export function storeFixture(store: CarafeStore, fixture: ReturnType<typeof launchFixture>): void {
  sealSession(store, fixture.d.tool, fixture.d.sessionId, fixture.events); writeDistillate(store, fixture.d);
  mkdirSync(join(store.root, "handoffs"), { recursive: true });
  const path = join(store.root, "handoffs", `${fixture.d.sessionId}.answers.md`);
  writeFileSync(path, fixture.answers); utimesSync(path, new Date("2026-09-20T10:00:00Z"), new Date("2026-09-20T10:00:00Z"));
}
