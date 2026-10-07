import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { buildCorpus } from "../corpus";
import { CarafeStore } from "../../format/store";
import { buildSessionIndex, sessionIndexPath } from "../../search/session-index";
import { reflex } from "../../reflex/reflex";
import { reflexGoldTurns } from "./cases";
import { readReflexBaseline, reflexBaselineCounts, runReflexBench } from "./run";

describe("ReflexBench", () => {
  test("the committed gate counts match exactly, silence is never broken, suppression always holds", () => {
    const card = runReflexBench({ tier: "gate" });
    const current = reflexBaselineCounts(card);
    const baseline = readReflexBaseline();
    expect(Object.keys(current).sort()).toEqual(Object.keys(baseline).sort());
    for (const [tool, expected] of Object.entries(baseline)) {
      for (const [metric, value] of Object.entries(expected)) {
        expect(current[tool]?.[metric], `${tool}.${metric}: baseline ${value}, current ${String(current[tool]?.[metric])}; run \`carafe bench reflex --update-baseline\` if intended`).toBe(value);
      }
    }
    for (const score of Object.values(card.tools)) {
      expect(score.falseFires, `${score.tool} false fires`).toBe(0);
      expect(score.suppressionPassed, `${score.tool} suppression`).toBe(score.suppressionTotal);
      expect(score.maxRuntimeMs, `${score.tool} max ms per turn`).toBeLessThan(200);
    }
  // Wall-clock ceiling only. What this test gates is above: the committed counts, zero false fires, full
  // suppression, and < 200 ms per turn. On the Linux CI runner the whole run took 15.9 s, 17.5 s, 22.3 s and
  // 17.2 s across four runs of unchanged reflex code, so a 20 s ceiling failed a pull request on runner
  // variance alone, and would block a release the same way.
  }, 60_000);

  test("the current L session excludes its last chapter while earlier memory still fires", () => {
    const root = mkdtempSync(join(tmpdir(), "carafe-reflex-current-bench-"));
    try {
      const store = new CarafeStore(root);
      const session = buildCorpus("gate").find((item) => item.name === "L-31-claude-code")!;
      buildSessionIndex(store, session.distillate, session.events, { force: true });
      const db = new Database(sessionIndexPath(store, session.distillate), { readonly: true });
      const lastChapter = Number((db.query(`SELECT max(idx) AS idx FROM chapters`).get() as { idx: number }).idx);
      db.close();
      let fired = false;
      for (const turn of reflexGoldTurns(session).filter((item) => item.shouldFire)) {
        const result = reflex({
          store,
          sessions: [{ session: session.distillate, excludeLastChapter: true }],
          cwd: session.distillate.cwd ?? undefined,
          turnText: turn.text,
          receiverId: session.distillate.sessionId,
        });
        expect(result.pointers.every((pointer) => pointer.chapterIdx !== lastChapter)).toBe(true);
        if (result.pointers.length) { fired = true; break; }
      }
      expect(fired).toBe(true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
