/**
 * User text → safe FTS5 MATCH expressions. FTS5 treats quotes, parentheses,
 * `-`, `:` and bare AND/OR/NOT as syntax, so a search for `retry - timeout (x)`
 * or `don't` raises a syntax error instead of matching. Every token is quoted
 * (internal quotes doubled) and joined with the implicit AND; `orFallback`
 * gives the recall query to try when the AND form finds nothing.
 */
export interface FtsQuery { and: string; or: string; terms: string[] }

export function ftsQuery(text: string): FtsQuery {
  const terms = (text.match(/[\p{L}\p{N}_'./-]+/gu) ?? [])
    .map((t) => t.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ""))
    .filter((t) => t.length >= 2);
  const quoted = terms.map((t) => `"${t.replaceAll('"', '""')}"`);
  return { terms, and: quoted.join(" "), or: quoted.join(" OR ") };
}
