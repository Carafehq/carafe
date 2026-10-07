import { statSync } from "fs";
import { codexRoot, codexSessionIndexPath, readCodexThreadNames } from "../adapters/codex-names";
import { applyTitleCandidate, writeDistillate } from "../format/distillate";
import type { CarafeStore } from "../format/store";
import { listSessions } from "../query/sessions";

export interface FileFingerprint { mtimeMs: number; size: number }

export function codexNamesFingerprint(root = codexRoot()): FileFingerprint | null {
  try {
    const stat = statSync(codexSessionIndexPath(root));
    return { mtimeMs: stat.mtimeMs, size: stat.size };
  } catch { return null; }
}

export function sameFingerprint(a: FileFingerprint | null, b: FileFingerprint | null): boolean {
  return a?.mtimeMs === b?.mtimeMs && a?.size === b?.size;
}

/** Refresh names only. Spreading the old record and changing exactly these two
 * properties is intentional: an index-only rename cannot alter session facts. */
export function refreshCodexNames(store: CarafeStore, root = codexRoot()): Array<{ tool: string; id: string }> {
  const names = readCodexThreadNames(root);
  const changed: Array<{ tool: string; id: string }> = [];
  for (const current of listSessions(store)) {
    if (current.tool !== "codex") continue;
    const indexed = names.get(current.sessionId);
    if (!indexed) continue;
    const next = { ...current };
    applyTitleCandidate(next, indexed.name, "codex-index");
    if (next.title === current.title && next.titleSource === current.titleSource) continue;
    writeDistillate(store, next);
    changed.push({ tool: current.tool, id: current.sessionId });
  }
  return changed;
}
