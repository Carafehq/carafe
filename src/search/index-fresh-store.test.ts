import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, utimesSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { SessionDistillate } from "../format/distillate";
import { writeDistillate } from "../format/distillate";
import { CarafeStore } from "../format/store";
import { SearchIndex } from "./index";

let root = "";
let oldHome: string | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "carafe-fresh-search-"));
  oldHome = process.env.CARAFE_HOME;
  process.env.CARAFE_HOME = root;
});
afterEach(() => {
  if (oldHome === undefined) delete process.env.CARAFE_HOME; else process.env.CARAFE_HOME = oldHome;
  rmSync(root, { recursive: true, force: true });
});

const distillate = (sessionId: string): SessionDistillate => ({
  tool: "codex", sessionId, sourcePath: "fixture.jsonl", title: "fresh store fixture",
  cwd: "/tmp/project", gitBranch: "main", startTs: "2026-01-01T00:00:00Z", endTs: "2026-01-01T00:05:00Z",
  eventCount: 1, toolUseCount: 0, sidechain: false, rawBytes: 1, version: 1,
});

// A brand-new user: `carafe import` writes every distillate, THEN the first `carafe search`
// creates the database. The database is newer than the distillates, so a date comparison
// alone called the empty index current and search found nothing.
test("an empty index is stale even when the database is newer than every distillate", () => {
  const store = new CarafeStore();
  writeDistillate(store, distillate("s1"));
  // Make the distillate tree unmistakably OLDER than the database created next.
  const old = new Date(Date.now() - 60_000);
  for (const dir of [join(root, "distillate"), join(root, "distillate", "codex")]) utimesSync(dir, old, old);

  const idx = new SearchIndex(store);
  expect(idx.isStale()).toBe(true);
  const r = idx.reindex();
  expect(r.indexed).toBe(1);
  expect(idx.search("fresh store", {}).length).toBe(1);
  idx.close();

  // Reopened with rows and nothing newer on disk, it is current.
  const again = new SearchIndex(store);
  expect(again.isStale()).toBe(false);
  again.close();
});

test("a new distillate inside a per-tool folder makes the index stale", () => {
  const store = new CarafeStore();
  writeDistillate(store, distillate("s1"));
  const idx = new SearchIndex(store);
  idx.reindex();
  idx.close();
  const future = new Date(Date.now() + 60_000);
  writeDistillate(store, distillate("s2"));
  utimesSync(join(root, "distillate", "codex"), future, future);
  const again = new SearchIndex(store);
  expect(again.isStale()).toBe(true);
  again.close();
});
