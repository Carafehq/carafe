/**
 * The release workflow creates each branch release's tag itself. Without an
 * explicit target, GitHub creates a missing tag on the default branch, so an
 * branch release's tag, source archives and notes described main, not
 * the commit its binaries were built from.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

interface Step { uses?: string; with?: Record<string, unknown> }
interface Workflow { jobs: Record<string, { steps?: Step[] }> }

const workflow = Bun.YAML.parse(readFileSync(join(import.meta.dir, "..", ".github", "workflows", "release.yml"), "utf8")) as Workflow;

describe("release workflow", () => {
  test("every release step tags the commit that was built, not the default branch", () => {
    const releaseSteps = Object.entries(workflow.jobs).flatMap(([job, j]) =>
      (j.steps ?? []).filter((s) => s.uses?.startsWith("softprops/action-gh-release@")).map((s) => ({ job, target: s.with?.target_commitish })));
    expect(releaseSteps.map((s) => s.job)).toEqual(["release", "app"]);
    for (const step of releaseSteps) expect(step).toEqual({ job: step.job, target: "${{ github.sha }}" });
  });
});
