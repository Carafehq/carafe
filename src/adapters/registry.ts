/** The capture registry also supplies source names to handoff pickers. */
import * as cc from "./claude-code";
import * as codex from "./codex";
import type { SourceFile, ParsedSession } from "./types";

export interface Adapter {
  tool: string;
  name: string;
  discover(): SourceFile[];
  parseFile(text: string): ParsedSession;
}

export const ADAPTERS: Adapter[] = [
  { tool: cc.TOOL, name: "Claude Code", discover: cc.discover, parseFile: cc.parseFile },
  { tool: codex.TOOL, name: "Codex", discover: codex.discover, parseFile: codex.parseFile },
];
