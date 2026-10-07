/** Cross-session ownership needs trace evidence, not just overlapping timestamps. */
import { realpathSync } from "fs";
import { basename, dirname } from "path";
import type { CarafeEvent } from "../format/events";
import { workspaceKey } from "../query/sessions";
import { boundCalls } from "./calls";
import { extractPieces } from "./pieces";
import { absolutePath, commandSegments, expandCommandVars, pathArgument, worktreesFromCommands } from "./worktrees";
import type { RefChange } from "./ref-changes";

const canonical = (path: string): string => { try { return realpathSync(path); } catch { return path; } };
export interface PeerTrace { sessionId: string; title: string | null; tool: string; cwd: string | null; events: CarafeEvent[] }
export function sessionCollisionLines(peers: PeerTrace[], repos: string[], at: number | null, changes: RefChange[]): string[] {
  if (at == null) return [];
  const keyOf = (path: string | null): string | null => { const key = workspaceKey(path); return key ? canonical(key) : null; };
  const keys = new Set(repos.map(keyOf));
  const rows: Array<{ at: number; line: string }> = [];
  for (const peer of peers) {
    const active = peer.events.filter((e) => Date.parse(e.ts ?? "") > at && ["user", "assistant", "tool_use", "tool_result"].includes(e.kind));
    if (!active.length) continue;
    const pieces = extractPieces(peer.events, {}, {});
    const touched = new Set<string>();
    if (keys.has(keyOf(peer.cwd)) && peer.cwd) touched.add(keyOf(peer.cwd)!);
    const created = new Set<string>();
    for (const call of boundCalls(peer.events, pieces)) {
      if (!(Date.parse(call.ts ?? "") > at)) continue;
      if (call.filePath) {
        const file = absolutePath(call.filePath, peer.cwd);
        const key = file ? keyOf(dirname(file)) : null;
        if (key && keys.has(key)) touched.add(key);
      }
      if (!call.command) continue;
      const command = expandCommandVars(call.command);
      for (const segment of commandSegments(command, peer.cwd)) {
        const key = keyOf(segment.dir);
        if (!key || !keys.has(key)) continue;
        touched.add(key);
        if (call.result == null || /(?:fatal:|error:|exit(?:ed with)? code[: ]+[1-9])/i.test(call.result)) continue;
        const branch = /^git\s+(?:-C\s+(?:"[^"]+"|'[^']+'|\S+)\s+)?(?:checkout\s+-b|switch\s+-c|branch(?:\s+--)?|worktree\s+add\s+(?:-q\s+)?-b)\s+("[^"]+"|'[^']+'|[^\s;&|]+)/.exec(segment.text)?.[1];
        if (branch && !branch.startsWith("-")) {
          const name = pathArgument(branch);
          const proven = changes.some((c) => c.kind === "branch" && c.action === "new" && c.name === name && keyOf(c.repo) === key);
          if (proven) created.add(`${basename(key)} branch ${name} (creation call seq ${call.seq})`);
        }
        for (const [path, repo] of worktreesFromCommands([segment.text], segment.dir)) {
          if (keys.has(keyOf(repo)) && changes.some((c) => c.kind === "worktree" && canonical(c.name) === canonical(path))) created.add(`${basename(repo)} worktree ${path} (creation call seq ${call.seq})`);
        }
      }
    }
    if (!touched.size) continue;
    rows.push({ at: Math.max(...active.map((e) => Date.parse(e.ts!))), line: `- ${peer.tool} ${peer.sessionId} · "${peer.title ?? peer.sessionId}" · ${[...new Set([...touched].map((p) => basename(p)))].join(", ")} — ${created.size ? [...created].join("; ") : "active since answers; no branch/worktree creation confirmed in captured calls"}` });
  }
  return rows.length ? ["## Collision map (other sessions active since the answers)", "", ...rows.sort((a, b) => b.at - a.at).map((r) => r.line), ""] : [];
}
