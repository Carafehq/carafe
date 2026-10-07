/**
 * W7 — the handoff bench, on the synthetic case the v5 fixture builds.
 *
 * It lives under `src/bench/` on purpose: the open extractor layers may never
 * import the benchmark, and the bench's own tests are the only place that may
 * import both.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { CarafeStore } from "../format/store";
import { sealSession } from "../format/sessions";
import { writeDistillate } from "../format/distillate";
import type { LiveState } from "../handoff/live";
import { fixtureSession } from "../handoff/handoff-v5.test";
import { checkInvariants, falseStatements, formatHandoffBench, runHandoffBench } from "./handoff";

const NOW = "2026-02-05T12:00:00Z";

describe("HandoffBench", () => {
  test("renders a synthetic case hermetically — no git, no network, no clock", () => {
    const fixture = fixtureSession();
    const corpus = mkdtempSync(join(tmpdir(), "carafe-v5-bench-"));
    try {
      const caseDir = join(corpus, "synthetic");
      const home = join(caseDir, "trace");
      mkdirSync(home, { recursive: true });
      const store = new CarafeStore(home);
      sealSession(store, fixture.d.tool, fixture.d.sessionId, fixture.events);
      writeDistillate(store, fixture.d);

      // the readings a judge verified, fed in place of the git commands
      const live: LiveState = {
        checkedAt: NOW, live: false, remoteHeads: {},
        health: [{ url: "https://example.invalid/health", body: null, error: null }],
        repos: [{
          path: fixture.repo, notChecked: null, branch: "main",
          head: { hash: "ea249dd", subject: "close the hole" }, headDate: "2026-02-05T09:00:00Z",
          // v6/V2 — origin/main as the LOCAL refs record it, never called deployed
          defaultRef: { ref: "origin/main", hash: "c0ffee1", subject: "the commit before it", ahead: 1, behind: 0 },
          upstream: "origin/main", ahead: 1, behind: 0, upstreamUpdated: { at: "2026-02-05T10:00:00Z", how: "fetch" },
          modified: 0, untracked: 1, untrackedNames: ["scratch.txt"],
          unpushed: [{ branch: "feat/no-upstream", hash: "df85883", date: "2026-02-04" }],
          branches: ["feat/no-upstream", "main"], track: { main: "[ahead 1]", "feat/no-upstream": "" },
        }],
      };
      writeFileSync(join(caseDir, "truth.json"), JSON.stringify({
        live,
        healthUrls: ["https://example.invalid/health"],
        must_mention: ["ea249dd", "close the hole", "feat/no-upstream", "scratch.txt", "2026-02-05"],
        // the superseded health commit the trace saw: it may be quoted as an old
        // observation and must never be stated as current
        must_not_state: ["e857941"],
      }, null, 2));

      const card = runHandoffBench(corpus);
      expect(card.cases.length).toBe(1);
      const one = card.cases[0]!;
      expect(one.missing).toEqual([]);
      expect(one.falseStatements).toEqual([]);
      expect(one.invariants.filter((invariant) => !invariant.ok)).toEqual([]);
      expect(formatHandoffBench(card)).toContain("| synthetic |");
      expect(formatHandoffBench(card)).toContain("12/12");
    } finally { fixture.cleanup(); rmSync(corpus, { recursive: true, force: true }); }
  });

  test("a superseded value stated outside a hedged line is a false statement; inside one it is not", () => {
    const hedged = ["## Last seen in the session (from the trace, may be stale)", "", "- health: old → e857941  [seq 9]"].join("\n");
    expect(falseStatements(hedged, ["e857941"])).toEqual([]);
    const bare = ["## Right now (checked at 2026-02-05 12:00 UTC, when this handoff was written)", "", "- health → e857941"].join("\n");
    expect(falseStatements(bare, ["e857941"])).toEqual(["e857941"]);
  });

  test("the invariants catch a $ leak, an undated quotation and a Last-seen entry newer than Right now", () => {
    const leaky = ["## Notes", "", "the final turns were about $r"].join("\n");
    expect(checkInvariants(leaky).find((one) => one.name === "no $ leaks")!.ok).toBe(false);

    const undated = ["## Standing instructions from the owner (verbatim)", "", `- "never push without asking"`].join("\n");
    expect(checkInvariants(undated).find((one) => one.name === "every quoted sentence dated")!.ok).toBe(false);

    const backwards = [
      "## Right now (checked at 2026-02-01 12:00 UTC, when this handoff was written)",
      "",
      "## Last seen in the session (from the trace, may be stale)",
      "",
      "- health: x  [seq 9, 2026-02-05 10:00 UTC]",
    ].join("\n");
    expect(checkInvariants(backwards).find((one) => one.name === "Right now newer than every Last seen entry")!.ok).toBe(false);
  });

  test("answer contradictions need a command and observed value, and fragments cannot receive stamps", () => {
    const heading = "## What the outgoing agent said (codex, written now)";
    const good = [heading, "", "> `abc1234` is the head of `origin/main`.", "    ✗ abc1234 is the head of origin/main — checked: git -C /tmp/repo rev-parse origin/main → def5678"].join("\n");
    expect(checkInvariants(good).find((one) => one.name === "every contradicted answer shows checked command and observed value")!.ok).toBe(true);

    const unexplained = [heading, "", "> The claim is false.", "    ✗ the claim is false"].join("\n");
    expect(checkInvariants(unexplained).find((one) => one.name === "every contradicted answer shows checked command and observed value")!.ok).toBe(false);

    const fragment = [heading, "", "> `fragment from a split sentence"].join("\n");
    expect(checkInvariants(fragment).find((one) => one.name === "answer stamps attach to whole sentences")!.ok).toBe(false);
  });
});
