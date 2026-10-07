import { spawnSync } from "child_process";
import { type Checker, plain, spanOf } from "./types";
export function readPort(port: number): string | null {
  const p = spawnSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN"], { encoding: "utf8", timeout: 5000 });
  if (p.error || p.signal || (p.status !== 0 && !(p.status === 1 && !p.stderr))) return null;
  return p.stdout;
}
export const portClaims: Checker = (sentence, ctx) => {
  const s = plain(sentence);
  const m = /\b(nothing is listening|[\w.-]+ is (?:running|listening)) on port (\d+)\b/i.exec(s);
  if (!m) return [];
  const port = Number(m[2]);
  const output = port > 0 && port <= 65535 ? (ctx.portReader ?? readPort)(port) : null;
  const lines = output?.trim().split("\n").filter(Boolean) ?? [];
  const listening = lines.some((l) => /LISTEN/.test(l));
  const negative = /^nothing/i.test(m[1]!);
  const name = m[1]!.split(" ")[0]!;
  const matching = lines.some((l) => l.split(/\s+/)[0] === name);
  const agrees = negative ? !listening : matching;
  // A listener with a different name does not prove that an app with this
  // product name is absent. Only an empty listener list proves that opposite.
  const stamp = output == null || (!negative && listening && !matching) ? "?" : agrees ? "✓" : "✗";
  return [{ span: spanOf(m), label: m[0], stamp, command: `lsof -nP -iTCP:${port} -sTCP:LISTEN`, value: lines.length ? lines.join("; ") : output == null ? "unavailable" : "no listeners", checkable: true, time: { kind: "no-history" as const, what: "listening ports" } }];
};
