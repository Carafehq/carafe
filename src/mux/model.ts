/**
 * Live-mux data model — one parent session owning multiple agent children,
 * each in its own PTY. Session JSON uses the exact field names and value
 * spellings of the original archive implementation, so maps written by either
 * tool remain interchangeable.
 */
export type Agent = "codex" | "claude";

export type HandoffStorage = "memory" | "disk";

export type ChildStatus = "running" | "exited";

export function otherAgent(agent: Agent): Agent {
  return agent === "codex" ? "claude" : "codex";
}

/** Human-readable agent name, mirroring the Rust `Display` impl. */
export function agentDisplay(agent: Agent): string {
  return agent === "codex" ? "Codex" : "Claude Code";
}

export interface ChildSession {
  id: string;
  agent: Agent;
  created_at: string;
  handoff_from: string | null;
  handoff_file: string | null;
  status: ChildStatus;
}

export interface ParentSession {
  id: string;
  cwd: string;
  created_at: string;
  active_child: string;
  handoff_storage: HandoffStorage;
  children: ChildSession[];
}

export function newParentSession(
  cwd: string,
  first: Agent,
  handoffStorage: HandoffStorage,
): ParentSession {
  const child: ChildSession = {
    id: crypto.randomUUID(),
    agent: first,
    created_at: new Date().toISOString(),
    handoff_from: null,
    handoff_file: null,
    status: "running",
  };
  return {
    id: crypto.randomUUID(),
    cwd,
    created_at: new Date().toISOString(),
    active_child: child.id,
    handoff_storage: handoffStorage,
    children: [child],
  };
}

export function recordHandoff(
  session: ParentSession,
  id: string,
  agent: Agent,
  from: string,
  handoffFile: string | null,
): void {
  session.children.push({
    id,
    agent,
    created_at: new Date().toISOString(),
    handoff_from: from,
    handoff_file: handoffFile,
    status: "running",
  });
  session.active_child = id;
}

function formatMinuteUtc(iso: string): string {
  const date = new Date(iso);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`;
}

export function tree(session: ParentSession): string {
  let out = `Parent ${short(session.id)}  ${formatMinuteUtc(session.created_at)}\n  cwd: ${session.cwd} · handoffs: ${session.handoff_storage}\n`;
  session.children.forEach((child, i) => {
    const branch = i + 1 === session.children.length ? "└─" : "├─";
    const active = child.id === session.active_child ? "  ◀ active" : "";
    const from =
      child.handoff_from !== null
        ? `  ← handoff from ${short(child.handoff_from)}`
        : "";
    out += `  ${branch} ${agentDisplay(child.agent)} [${short(child.id)}] ${child.status === "running" ? "Running" : "Exited"}${from}${active}\n`;
  });
  return out;
}

export function short(id: string): string {
  return id.slice(0, 8);
}

/**
 * Decodes persisted session JSON. `handoff_storage` defaults to `memory` so
 * maps written before that field existed keep loading.
 */
export function parseParentSession(value: unknown): ParentSession {
  if (typeof value !== "object" || value === null) {
    throw new Error("parent session JSON is not an object");
  }
  const raw = value as Record<string, unknown>;
  for (const field of ["id", "cwd", "created_at", "active_child"]) {
    if (typeof raw[field] !== "string") {
      throw new Error(`parent session JSON is missing ${field}`);
    }
  }
  if (!Array.isArray(raw.children)) {
    throw new Error("parent session JSON is missing children");
  }
  const storage = raw.handoff_storage ?? "memory";
  if (storage !== "memory" && storage !== "disk") {
    throw new Error("parent session JSON has an unknown handoff_storage");
  }
  const children = raw.children.map((entry) => {
    const child = entry as Record<string, unknown>;
    for (const field of ["id", "agent", "created_at", "status"]) {
      if (typeof child[field] !== "string") {
        throw new Error(`child session JSON is missing ${field}`);
      }
    }
    if (child.agent !== "codex" && child.agent !== "claude") {
      throw new Error("child session JSON has an unknown agent");
    }
    if (child.status !== "running" && child.status !== "exited") {
      throw new Error("child session JSON has an unknown status");
    }
    return {
      id: child.id as string,
      agent: child.agent as Agent,
      created_at: child.created_at as string,
      handoff_from: (child.handoff_from as string | null | undefined) ?? null,
      handoff_file: (child.handoff_file as string | null | undefined) ?? null,
      status: child.status as ChildStatus,
    } satisfies ChildSession;
  });
  return {
    id: raw.id as string,
    cwd: raw.cwd as string,
    created_at: raw.created_at as string,
    active_child: raw.active_child as string,
    handoff_storage: storage,
    children,
  };
}
