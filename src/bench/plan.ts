export type BeatId = number;
export type Size = "S" | "M" | "L";
export type ToolName = "shell" | "read" | "grep" | "edit" | "write";

export interface ToolInput {
  command?: string;
  path?: string;
  pattern?: string;
  oldText?: string;
  newText?: string;
  content?: string;
}

export type Beat =
  | { kind: "user"; text: string; systemInjected?: boolean }
  | { kind: "assistant"; text: string; thinking?: string }
  | { kind: "tool"; name: ToolName; input: ToolInput; output: string; exitCode: number; files: string[] }
  | { kind: "popup"; question: string; header: string; options: string[]; answer: string | null }
  | { kind: "prlink"; number: number; url: string }
  | { kind: "gap"; hours: number }
  | { kind: "token" };

export type GoldKind =
  | "goal" | "decision.popup" | "decision.freetext" | "decision.approval" | "steering"
  | "deadend.reversal" | "deadend.abandoned" | "deadend.notrace" | "breakthrough" | "rule"
  | "artifact.commit" | "artifact.pr" | "wip";

export interface GoldUnit {
  id: string;
  kind: GoldKind;
  beats: [BeatId, BeatId];
  anchor: string;
  third: "early" | "middle" | "late";
}

export type DistractorKind =
  | "fixed-fast" | "stash-housekeeping" | "quoted-error" | "rejected-proposal"
  | "cancelled-popup" | "ack-turn" | "explore-burst" | "system-injected";

export interface Distractor {
  id: string;
  kind: DistractorKind;
  beats: [BeatId, BeatId];
  hazard: boolean;
}

export interface SessionPlan {
  seed: number;
  size: Size;
  title: string;
  cwd: string;
  repo: string;
  branch: string;
  startTs: string;
  beats: Beat[];
  gold: GoldUnit[];
  distractors: Distractor[];
  expectedBoundaries: Array<{ kind: "gap" | "branch" | "cwd"; beat: BeatId }>;
}
