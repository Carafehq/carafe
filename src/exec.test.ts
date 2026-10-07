import { expect, test } from "bun:test";
import { realExec } from "./exec";

test("read-only subprocess waits can be bounded and report their timeout", () => {
  const timedOut: Array<{ cmd: readonly string[]; timeoutMs: number }> = [];
  const started = performance.now();
  const result = realExec(
    [process.execPath, "-e", "await Bun.sleep(1000)"],
    process.cwd(),
    {},
    undefined,
    { timeoutMs: 25, onTimeout: (cmd, timeoutMs) => timedOut.push({ cmd, timeoutMs }) },
  );
  expect(result.ok).toBe(false);
  expect(result.timedOut).toBe(true);
  expect(performance.now() - started).toBeLessThan(500);
  expect(timedOut).toEqual([{ cmd: [process.execPath, "-e", "await Bun.sleep(1000)"], timeoutMs: 25 }]);
});
