/** Flags whose following token is a value, rather than another positional.
 * Boolean flags deliberately do not consume an id placed after them. */
export const VALUE_FLAGS: ReadonlySet<string> = new Set([
  "answers", "branch", "budget", "budgets", "chapter", "command", "cwd", "dir",
  "extractor", "file", "handoff-storage", "host", "interval", "kind", "limit",
  "materialize", "max-chars", "min-events", "model", "out", "per-cwd", "port",
  "prompt", "remote", "seq", "session", "since", "tier", "to", "to-seq", "tool",
  "workspace", "n",
]);

export function positionalArgs(args: readonly string[]): string[] {
  const positional: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg.startsWith("--")) {
      if (!arg.includes("=") && VALUE_FLAGS.has(arg.slice(2))) index++;
      continue;
    }
    if (arg.startsWith("-")) continue;
    positional.push(arg);
  }
  return positional;
}
