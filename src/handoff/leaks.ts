/**
 * W6 — two cosmetic leaks that cost the document its credibility.
 *
 * A judge read `"The session's final turns were about $r"` and a revert row
 * truncated mid-SHA, and counted both against everything else in the file. A
 * reading whose path still contains a shell variable is not a reading: nothing
 * in the trace says what `$r` was. It is dropped, not printed.
 */

/** `$r`, `${x}` — a variable the trace never expanded. */
const SHELL_VAR_RE = /\$[A-Za-z_{]/;

export function hasShellVariable(text: string | null | undefined): boolean {
  return text != null && SHELL_VAR_RE.test(text);
}

/** Keep only the lines that carry no unexpanded variable. */
export function withoutShellVariables(lines: string[]): string[] {
  return lines.filter((line) => !hasShellVariable(line));
}

/**
 * Clip at the last `|` or space before the cap, so a table row never loses half
 * a SHA and a sentence never loses half a word.
 */
export function clipAtToken(text: string, cap: number): string {
  if (text.length <= cap) return text;
  const window = text.slice(0, cap);
  const cut = Math.max(window.lastIndexOf("|"), window.lastIndexOf(" "));
  return `${(cut > 0 ? window.slice(0, cut) : window).trimEnd()}…`;
}
