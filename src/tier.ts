/**
 * The open-core seam. Carafe Pro (person-to-person share/receive with the PR
 * story, and LLM decision-ledger distillation) lives in `src/closed/`, which is
 * not part of the open-source build. This is the ONLY file outside
 * `src/closed/` allowed to name it (src/tier.test.ts enforces that).
 *
 * Open code defines the contract (`ProTier`) and asks for it at runtime; the
 * closed tree implements it in `src/closed/index.ts`. When the tree is absent
 * `loadPro()` returns null and every Pro surface says so honestly: the CLI
 * prints one line and exits non-zero, the UI hides its buttons, and the Pro
 * endpoints answer a 404 JSON.
 *
 * The import below is a literal so `bun build --compile` bundles the closed
 * tree whenever it exists; Bun tolerates the unresolvable literal when it does
 * not (the error surfaces at runtime and is caught here).
 */
import type { CarafeStore } from "./format/store";
import type { EventPieces } from "./handoff/pieces";

export type ProFeature = "share" | "distill";

/** Every Pro CLI command and the feature it belongs to. Kept here (not in the
 *  closed tree) so an open build can name what it is missing. */
export const PRO_COMMANDS: Readonly<Record<string, ProFeature>> = {
  share: "share",
  receive: "share",
  "pr-post": "share",
  distill: "distill",
};

/** Every Pro UI endpoint. Matched before a request reaches the Pro handler so
 *  an open build answers a clear 404 JSON instead of the generic "not found". */
export const PRO_ROUTES: ReadonlyArray<readonly [RegExp, ProFeature]> = [
  [/^\/api\/receive\/(preview|import)$/, "share"],
  [/^\/api\/session\/[^/]+\/share\/(preview|write)$/, "share"],
  [/^\/api\/session\/[^/]+\/(ledger|distill)$/, "distill"],
];

export interface ProCliArgs {
  positional: string[];
  flag(name: string): string | undefined;
  has(name: string): boolean;
}

export interface ProCommand {
  /** Runs the command. A non-zero number is the process exit code. */
  run(args: ProCliArgs): Promise<number | void>;
}

export interface ProUiContext {
  store: CarafeStore;
  url: URL;
  json(data: unknown, status?: number): Response;
  /** The UI's cached, non-empty trace pieces for a session. */
  pieces(d: any): EventPieces[];
  /** Called after a receive wrote sessions into the store. */
  afterReceive(): void;
}

export interface ProTier {
  features: ProFeature[];
  commands: Record<string, ProCommand>;
  /** Help lines, each block inserted after the open line for `carafe <after>`. */
  usage: Array<{ after: string; text: string }>;
  /** Handles a Pro UI route, or returns null when the request is not one. */
  handleUi(req: Request, ctx: ProUiContext): Promise<Response | null>;
}

let cached: Promise<ProTier | null> | undefined;

/** The Pro tier, or null in the open-source build. `CARAFE_OPEN_BUILD=1`
 *  forces null in a full tree, to see and test exactly what the open build does. */
export function loadPro(): Promise<ProTier | null> {
  cached ??= (async () => {
    if (process.env.CARAFE_OPEN_BUILD === "1") return null;
    try {
      // @ts-ignore -- absent from the open-source build; resolved at runtime.
      const mod = await import("./closed/index");
      return (mod as { tier: ProTier }).tier;
    } catch (error) {
      // Only the closed tree itself being absent means "open build". Anything
      // else (a broken import INSIDE the closed tree) is a real error.
      if (isClosedTreeMissing(error)) return null;
      throw error;
    }
  })();
  return cached;
}

function isClosedTreeMissing(error: unknown): boolean {
  const e = error as { specifier?: unknown; code?: unknown; message?: unknown } | null;
  if (!e || typeof e !== "object") return false;
  if (e.specifier === "./closed/index") return true;
  return e.code === "ERR_MODULE_NOT_FOUND" && typeof e.message === "string" && e.message.includes("'./closed/index'");
}

export function notInBuild(what: string): string {
  return `${what} is part of Carafe Pro and is not in this build`;
}

/** The feature a UI path belongs to, or null for an open path. */
export function proRouteFeature(path: string): ProFeature | null {
  for (const [re, feature] of PRO_ROUTES) if (re.test(path)) return feature;
  return null;
}
