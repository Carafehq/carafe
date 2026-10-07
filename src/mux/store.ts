/**
 * Persistence for live-mux parent/child maps and encrypted transcripts —
 * lives under <CARAFE_HOME>/mux/, beside (not inside) the capture store's
 * blob/session/distillate layers.
 */
import { mkdirSync, readFileSync, readdirSync } from "fs";
import { join, parse } from "path";
import { atomicWriteFileSync } from "../format/store";
import {
  parseParentSession,
  short,
  tree,
  type ParentSession,
} from "./model";

export function root(): string {
  const base = join(
    process.env.CARAFE_HOME ?? join(process.env.HOME!, ".carafe"),
    "mux",
  );
  mkdirSync(join(base, "sessions"), { recursive: true });
  mkdirSync(join(base, "transcripts"), { recursive: true });
  return base;
}

export function save(session: ParentSession): void {
  atomicWriteFileSync(
    join(root(), "sessions", `${session.id}.json`),
    JSON.stringify(session, null, 2),
  );
}

export function load(id: string): ParentSession {
  const dir = join(root(), "sessions");
  const entry = readdirSync(dir).find((name) =>
    parse(name).name.startsWith(id),
  );
  if (entry === undefined) {
    throw new Error(`parent session not found: ${id}`);
  }
  const path = join(dir, entry);
  try {
    return parseParentSession(JSON.parse(readFileSync(path, "utf8")));
  } catch (error) {
    throw new Error(`read ${path}: ${error instanceof Error ? error.message : error}`);
  }
}

export function all(): ParentSession[] {
  const dir = join(root(), "sessions");
  const sessions: ParentSession[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    try {
      sessions.push(parseParentSession(JSON.parse(readFileSync(join(dir, name), "utf8"))));
    } catch {
      // Unreadable maps are skipped, matching the Rust implementation.
    }
  }
  // ISO-8601 strings sort chronologically; newest first.
  sessions.sort((a, b) => b.created_at.localeCompare(a.created_at));
  return sessions;
}

export function printSessions(): void {
  const sessions = all();
  if (sessions.length === 0) {
    console.log("No live-mux parent sessions yet. Run: carafe start");
  }
  for (const session of sessions) {
    console.log(tree(session));
  }
}

export function printMap(id: string): void {
  process.stdout.write(tree(load(id)));
}

export function transcriptPath(parent: string, child: string): string {
  return join(root(), "transcripts", `${short(parent)}-${short(child)}.carafe.enc`);
}

export function nativeArchivePath(parent: string, child: string): string {
  return join(root(), "transcripts", `${short(parent)}-${short(child)}-native.carafe.enc`);
}
