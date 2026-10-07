import { describe, expect, test } from "bun:test";
import {
  newParentSession,
  parseParentSession,
  recordHandoff,
} from "./model";

describe("mux model", () => {
  test("recording handoff builds parent/child edge and activates destination", () => {
    const parent = newParentSession("/work", "claude", "memory");
    const from = parent.active_child;
    const destination = crypto.randomUUID();

    recordHandoff(parent, destination, "codex", from, null);

    expect(parent.active_child).toBe(destination);
    expect(parent.children).toHaveLength(2);
    const child = parent.children[1]!;
    expect(child.id).toBe(destination);
    expect(child.agent).toBe("codex");
    expect(child.handoff_from).toBe(from);
    expect(child.handoff_file).toBeNull();
  });

  test("old session JSON defaults to memory storage", () => {
    const parent = newParentSession("/work", "claude", "memory");
    const value = JSON.parse(JSON.stringify(parent)) as Record<string, unknown>;
    delete value.handoff_storage;

    const decoded = parseParentSession(value);

    expect(decoded.handoff_storage).toBe("memory");
  });
});
