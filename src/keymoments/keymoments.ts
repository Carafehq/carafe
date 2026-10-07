/**
 * carafe key-moments — write a deterministic resume block from pivotal,
 * trace-anchored excerpts. OPEN tier only: selection and rendering are local
 * and deterministic, with no model/API/network dependency.
 */
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { CarafeStore } from "../format/store";
import { readSession } from "../format/sessions";
import { extractPieces } from "../handoff/pieces";
import { currentSession, findSession, latestSession } from "../query/sessions";
import { buildSessionIndex } from "../search/session-index";
import { extractMoments } from "./extract";
import { segmentChapters } from "./chapters";
import { renderResumeBlock } from "./render";
import { tokenEstimate } from "../handoff/render";

export async function runKeyMoments(sessionArg: string, opts?: { budget?: number; thinking?: boolean }): Promise<void> {
  const store = new CarafeStore();
  const d = sessionArg === "latest"
    ? latestSession(store)
    : sessionArg === "current"
      ? currentSession(store)
      : findSession(store, sessionArg);
  if (!d) { console.error(`no session found for "${sessionArg}". try: carafe list`); process.exit(1); }

  const events = readSession(store, d.tool, d.sessionId);
  buildSessionIndex(store, d, events);
  const pieces = extractPieces(events, { includeThinking: opts?.thinking }, {});
  const set = extractMoments({ events, pieces });
  const chapters = segmentChapters(events, pieces, {}, set.moments, set.context.runs);
  const block = renderResumeBlock(d, set, { budgetChars: opts?.budget, chapters });

  const dir = join(store.root, "keymoments");
  mkdirSync(dir, { recursive: true });
  const outPath = join(dir, `${d.sessionId}.md`);
  writeFileSync(outPath, block.text);

  for (const m of block.moments) console.log(`[ch ${m.chapter} · ${m.kind}] ${m.text}  (seq ${m.seq})`);

  console.log(`
key moments ready
  session: ${d.tool} "${d.title ?? d.sessionId}"
  moments: ${block.momentCount}/${set.moments.length}${block.trimmed ? ` · ${block.trimmed} trimmed from resume block` : ""} · ${chapters.length} chapters
  file: ${outPath}
  ${tokenEstimate(block.chars)}
`);
}
