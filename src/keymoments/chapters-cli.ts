import { CarafeStore } from "../format/store";
import { readSession } from "../format/sessions";
import { buildBlocks, formatWeight, renderTurnLine } from "../handoff/blocks";
import { preparedPieces } from "../handoff/render";
import { currentSession, findSession, latestSession } from "../query/sessions";
import { sessionChapters } from "./chapters";
import { chapterHeadline } from "./render";

export function runChapters(sessionArg: string, opts: { chapter?: number; json?: boolean } = {}): void {
  const store = new CarafeStore();
  const d = sessionArg === "latest" ? latestSession(store) : sessionArg === "current" ? currentSession(store) : findSession(store, sessionArg);
  if (!d) { console.error(`no session found for "${sessionArg}". try: carafe list`); process.exit(1); }
  const events = readSession(store, d.tool, d.sessionId);
  const pieces = preparedPieces(events, d.sessionId);
  const blocks = buildBlocks(events, pieces);
  const chapters = sessionChapters(events, pieces);
  if (opts.chapter != null) {
    const chapter = chapters.find((candidate) => candidate.index === opts.chapter);
    if (!chapter) { console.error(`chapter ${opts.chapter} not found; choose 1-${chapters.length}`); process.exit(1); }
    const turnBlocks = blocks.filter((block) => block.startSeq >= chapter.startSeq && block.startSeq <= chapter.endSeq);
    if (opts.json) {
      console.log(JSON.stringify({ chapter, turns: turnBlocks.map((block) => ({ ...block, files: [...block.files] })) }, null, 2));
      return;
    }
    console.log(chapterHeadline(chapter));
    for (const block of turnBlocks) console.log(`  ${renderTurnLine(block)}`);
    return;
  }
  if (opts.json) {
    console.log(JSON.stringify(chapters, null, 2));
    return;
  }
  for (const chapter of chapters) console.log(`${chapterHeadline(chapter)} · ${formatWeight(chapter.chars)} chars`);
}
