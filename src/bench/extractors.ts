import type { SessionDistillate } from "../format/distillate";
import type { CarafeEvent } from "../format/events";
import { extractKeyMoments, extractMoments, type KeyMoment } from "../keymoments/extract";
import { segmentChapters } from "../keymoments/chapters";
import { renderMomentsSection, renderMomentsSectionV1 } from "../keymoments/render";
import type { EventPieces } from "../handoff/pieces";
import type { SignalContext } from "../keymoments/signals";

export interface ExtractorInput { events: CarafeEvent[]; pieces: EventPieces[]; distillate: SessionDistillate; }
export interface ExtractedMoment { kind: string; seq: number; endSeq?: number; text: string; note?: string; }
export interface MomentsExtractor {
  id: string;
  extract(input: ExtractorInput): { moments: ExtractedMoment[] };
  render(input: ExtractorInput, moments: ExtractedMoment[], budgetChars: number): string;
}

const v1: MomentsExtractor = {
  id: "v1",
  extract(input) { return { moments: extractKeyMoments(input.pieces).moments as ExtractedMoment[] }; },
  render(_input, moments, budgetChars) {
    const set = { moments: moments as KeyMoment[], totalEvents: moments.length };
    const section = renderMomentsSectionV1(set, { budgetChars }).text;
    const goal = moments.find((moment) => moment.kind === "goal");
    const goalLine = goal ? `- goal: ${goal.text.slice(0, 200)}  [seq ${goal.seq}]\n` : "";
    return goalLine + section;
  },
};

const v2Contexts = new WeakMap<ExtractedMoment[], SignalContext>();

const v2: MomentsExtractor = {
  id: "v2",
  extract(input) {
    const set = extractMoments(input);
    const moments = set.moments as ExtractedMoment[];
    v2Contexts.set(moments, set.context);
    return { moments };
  },
  render(input, moments, budgetChars) {
    const chapters = segmentChapters(input.events, input.pieces, {}, moments as KeyMoment[], v2Contexts.get(moments)?.runs);
    const set = { moments: moments as KeyMoment[], totalEvents: input.pieces.length };
    const section = renderMomentsSection(set, { budgetChars, chapters }).text;
    const goal = moments.find((moment) => moment.kind === "goal");
    const goalLine = goal ? `- goal: ${goal.text.slice(0, 200)}  [seq ${goal.seq}]\n` : "";
    return goalLine + section;
  },
};

export const EXTRACTORS: Record<string, MomentsExtractor> = { v1, v2 };
