/**
 * The one sentence extractor every quoted line in the orientation layer uses
 * (chapter titles, the opener, and outgoing-agent answers). A trace is not
 * prose: it is full of URLs, domains, file names, versions, markdown and JSON.
 */

export const SENTENCE_MIN_CHARS = 40;
export const SENTENCE_MAX_CHARS = 300;

const TRAILER_RES = [/\sCo-Authored-By/i, /\sSigned-off-by/i, /\s\(#/];
const LIST_ITEM_RE = /^\s*(?:[-+*]|\d+[.)])\s+/;

/**
 * Split prose without cutting machine-shaped text. The scanner keeps
 * backticks, nested JSON/arrays, URLs, domains, file names and versions whole.
 * A list item is one unit, and a bold lead-in remains attached to its body.
 */
export function splitSentences(text: string): string[] {
  const out: string[] = [];
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    if (LIST_ITEM_RE.test(line)) { out.push(line); continue; }

    let start = 0;
    let backtick = false;
    let braces = 0;
    let brackets = 0;
    let inUrl = false;
    for (let index = 0; index < line.length; index++) {
      const char = line[index]!;
      if (char === "`") { backtick = !backtick; continue; }
      if (backtick) continue;

      if (!inUrl && /^(?:https?:\/\/|www\.)/i.test(line.slice(index))) inUrl = true;
      if (inUrl) {
        if (/\s/.test(char)) inUrl = false;
        else continue;
      }

      if (char === "{") { braces++; continue; }
      if (char === "}" && braces) { braces--; continue; }
      if (char === "[") { brackets++; continue; }
      if (char === "]" && brackets) { brackets--; continue; }
      if (braces || brackets || !".!?".includes(char)) continue;

      const next = line[index + 1] ?? "";
      // `notes.md`, `example.com`, `0.1.6`: no whitespace means no boundary.
      if (char === "." && next && !/\s/.test(next)) continue;
      // `**Result.** Details` is one unit, not a one-word sentence plus a tail.
      if (char === "." && /^\s*\*\*[^*]+\.\*\*/.test(line.slice(start, index + 3))) continue;
      // A backtick/closing-bracket start is a fragment from machine-shaped
      // text, not a safe place to attach a new stamp. Lowercase prose still
      // splits normally so quotableSentences can discard a short "no." tail.
      const nextContent = line.slice(index + 1).trimStart()[0] ?? "";
      if (/[`\]\})]/.test(nextContent)) continue;

      const sentence = line.slice(start, index + 1).trim();
      if (sentence) out.push(sentence);
      start = index + 1;
      while (/\s/.test(line[start] ?? "")) start++;
    }
    const rest = line.slice(start).trim();
    if (rest) out.push(rest);
  }
  return out;
}

export function cleanSentence(sentence: string): string {
  let text = sentence.replace(/\s+/g, " ").trim();
  let previous = "";
  while (text !== previous) {
    previous = text;
    text = text.replace(/^(?:#{1,6}\s+|>\s+|[-*•]\s+|\d+[.)]\s+)/, "").trim();
  }
  text = text.replace(/\*\*/g, "").replace(/`/g, "").replace(/(^|\s)_([^_]+)_(?=\s|$)/g, "$1$2").trim();
  for (const re of TRAILER_RES) {
    const at = re.exec(text)?.index;
    if (at != null) text = text.slice(0, at).trim();
  }
  return text;
}

export function isQuotableSentence(text: string): boolean {
  if (!text || text.startsWith("#") || text.startsWith("|") || text.includes("|")) return false;
  if (/^\d/.test(text)) return false;
  if (text.length < SENTENCE_MIN_CHARS || text.length > SENTENCE_MAX_CHARS) return false;
  return /[.!?]$/.test(text);
}

export function quotableSentences(text: string): string[] {
  return splitSentences(text).map(cleanSentence).filter(isQuotableSentence);
}

export function firstQuotableSentence(text: string): string | null {
  return quotableSentences(text)[0] ?? null;
}
