import { describe, expect, test } from "bun:test";
import { detectPullRequests } from "./detect";
import type { SignalContext, ToolRun } from "./signals";

function context(toolName: string): SignalContext {
  const run: ToolRun = {
    toolSeq: 7, resultSeq: 8, toolLine: `→ **${toolName}** gh pr create`,
    resultLine: "Creating pull request\nhttps://github.com/acme/widgets/pull/42\nChecks pending",
    toolName, command: "gh pr create --title ship", family: "gh pr", files: [], blockIndex: 0,
    readish: false, failed: false, succeeded: true,
  };
  return { blocks: [], runs: [run], edits: [], streaks: [] };
}

describe("pull request artifacts", () => {
  for (const tool of ["Bash", "exec_command"]) {
    test(`composes a PR artifact from a ${tool} result URL`, () => {
      expect(detectPullRequests(context(tool))).toEqual([{
        kind: "artifact", seq: 7, text: "pr-link #42 https://github.com/acme/widgets/pull/42",
      }]);
    });
  }

  test("requires both gh pr create and a GitHub pull URL", () => {
    const wrongCommand = context("exec_command"); wrongCommand.runs[0]!.command = "curl https://example.com";
    const wrongResult = context("exec_command"); wrongResult.runs[0]!.resultLine = "created without a URL";
    expect(detectPullRequests(wrongCommand)).toEqual([]);
    expect(detectPullRequests(wrongResult)).toEqual([]);
  });
});
