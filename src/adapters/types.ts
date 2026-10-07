/** Adapter contract — one per tool. Community-contributable at Phase 1 ship. */
export interface SourceFile {
  tool: string;
  sessionId: string;   // primary key = filename stem (unique per file)
  path: string;
  size: number;
  mtimeMs: number;
}

export interface ParsedSession {
  events: ParsedRawEvent[];
  internalSessionId?: string;
  cwd: string | null;
  gitBranch: string | null;
  firstUserText: string | null;
  lastActivityTs: string | null;
  internal: boolean;
  /** Set when the session OPENED with a carafe handoff instruction: the id of
   *  the session it continues. Resolving that to a title needs the store, so
   *  it is done at import/backfill time, not here. */
  handoffSourceId: string | null;
  /** First owner text that survives after a handoff opener, whether strong or
   *  weak. Used to distinguish short continuations by prefixing the source. */
  firstPostHandoffText: string | null;
  /** First short/steering user text, verbatim — the last-resort title. */
  weakTitleText: string | null;
  /** Last valid set_thread_title call in a Codex rollout. */
  codexToolTitle: string | null;
  toolUseCount: number;
  sidechain: boolean;
  /** title updates keyed by the sessionId they reference (CC title events name any session) */
  titleUpdates: Array<{ sessionId: string; title: string; priority: number }>;
  /** timestamps of tool calls that spawned a codex run (parent→subsession linking) */
  codexCalls: string[];
  /** how this session was launched (codex session_meta: originator + source) */
  originator: string | null;
  sourceKind: string | null;
  /** REAL token usage per model, read from the trace's own usage records */
  usageByModel: Record<string, { in: number; cacheR: number; cacheW5m: number; cacheW1h: number; out: number; calls: number }>;
  parseErrors: number;
}

export interface ParsedRawEvent {
  ts: string | null;
  kind: string;
  sidechain?: boolean;
  raw: unknown;
}

/**
 * Title from the first user message, skipping a leading boilerplate/safety
 * preamble ("IMPORTANT: Do NOT read…", "NOTE:", "CONTEXT:") so a sub-agent brief
 * titles by its real task, not its guardrails. Never strips the LAST remaining
 * paragraph — a short single-paragraph message stays whole.
 */
const BOILERPLATE = /^(IMPORTANT|NOTE|CONTEXT|SAFETY|WARNING|REMINDER|CAVEAT)\b|^Do NOT\b/i;
export const CODEX_REVIEW_PREFIX = "The following is the Codex agent history";
const LEADING_TAG = /^<([A-Za-z_][\w:.-]*)>/;

/** Codex injects AGENTS.md as markdown, not as a tag, so the tag scanner misses
 *  it. The whole message is injected. */
const AGENTS_MD = /^#+ AGENTS\.md instructions for /;
/** Codex's @-file / paste headers: file sections, then the owner's words under
 *  a heading. Everything before the heading is machine-generated. The leading
 *  `#`s are not always present, so they are optional in both patterns. */
const FILES_HEADER = /^#*\s*Files (?:mentioned|pasted) by the user:/;
const CODEX_REQUEST_HEADING = /#*\s*My request for Codex:/;
/** A session STARTED FROM A CARAFE HANDOFF opens with carafe's own instruction.
 *  Several sessions continued from one source would otherwise share a title and
 *  be indistinguishable in a ~56-character menu. */
const HANDOFF_OPENER = /^Read\s+(\S*\/handoffs\/(\S+?)\.(?:md|carafe))(?=\s|$)/;
/** A word that steers the work without naming it. Shared with chapter titles
 *  (`src/keymoments/chapters.ts`) so "what counts as a real instruction" is
 *  defined once. */
export const BARE_COMMAND_RE = /^(?:go|push|ok|okay|yes|no|run it|try again|continue|where are we|next|do it|do all)[.!?]?$/i;
/** A message that is ONLY a link names nothing. */
const URL_ONLY_RE = /^<?(?:https?|file):\/\/\S+>?$/i;
const MARKDOWN_LINK_ONLY_RE = /^\[[^\]]*\]\([^)\s]+\)$/;
/** Leading markdown heading / list / quote markers, for display only. */
const MARKDOWN_MARKER = /^(?:#{1,6}|[>\-*])[ \t]+/;

/** When `text` is a carafe handoff opener, the session id it continues from
 *  (the handoff file's basename without extension). Null otherwise. The title
 *  it implies needs the STORE, so the adapters only report the id. */
export function handoffOpener(text: string): { sourceId: string } | null {
  const m = HANDOFF_OPENER.exec(text.trim());
  if (!m) return null;
  const base = m[2]!;
  return { sourceId: base.slice(base.lastIndexOf("/") + 1) };
}

/** Remove complete leading injected blocks, including nested blocks. An
 * unclosed block (e.g. a truncated old title) has no recoverable owner text.
 * Messages that are injected IN FULL (the reviewer banner, an AGENTS.md dump,
 * a handoff opener) collapse to "", which makes the caller move on to the next
 * user message rather than title the session with machinery. */
export function stripInjectedBlocks(raw: string): string {
  let text = raw.trim();
  for (let guard = 0; guard < 64; guard++) {
    if (text.startsWith(CODEX_REVIEW_PREFIX)) return "";
    if (AGENTS_MD.test(text)) return "";
    if (handoffOpener(text)) return "";
    if (FILES_HEADER.test(text)) {
      // The owner's actual words live under the request heading; with no
      // heading the message is all machine-listed file content.
      const heading = CODEX_REQUEST_HEADING.exec(text);
      if (!heading) return "";
      text = text.slice(heading.index + heading[0].length).trimStart();
      continue;
    }
    const opening = LEADING_TAG.exec(text);
    if (!opening) return text;
    let depth = 0;
    let end = 0;
    for (const tag of text.matchAll(/<\/?([A-Za-z_][\w:.-]*)>/g)) {
      if (tag[1] !== opening[1]) continue;
      depth += tag[0].startsWith("</") ? -1 : 1;
      if (depth === 0) { end = tag.index! + tag[0].length; break; }
    }
    if (!end) return "";
    text = text.slice(end).trimStart();
  }
  return text;
}

/** May a STORED title be overwritten by the backfill? True for anything that is
 *  machinery rather than the owner's words. Deliberately stricter than the
 *  parse-time loop: text that merely STARTS with a block counts, because a
 *  stored title was truncated to 120 characters and its tail is unknowable. */
export function isInjectedBlock(text: string): boolean {
  const trimmed = text.trim();
  return LEADING_TAG.test(trimmed)
    || trimmed.startsWith(CODEX_REVIEW_PREFIX)
    || AGENTS_MD.test(trimmed)
    || FILES_HEADER.test(trimmed)
    || handoffOpener(trimmed) !== null
    || !stripInjectedBlocks(trimmed);
}

export function deriveTitle(raw: string, max = 120): string {
  const text = stripInjectedBlocks(raw.replace(/\r/g, ""));
  if (!text) return "";
  const paras = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  let i = 0;
  while (i < paras.length - 1 && BOILERPLATE.test(paras[i]!)) i++;
  // Display polish only: a brief that opens "# Brief — three fixes" should read
  // as "Brief — three fixes" in a menu. Nothing else is stripped.
  let chosen = (paras[i] ?? text).replace(/\s+/g, " ").trim();
  for (let guard = 0; guard < 4 && MARKDOWN_MARKER.test(chosen); guard++) {
    chosen = chosen.replace(MARKDOWN_MARKER, "").trimStart();
  }
  return chosen.slice(0, max);
}

/** A title that steers but does not name: "go", "do all", a bare URL, or one
 *  or two words. Kept as a LAST-RESORT fallback rather than discarded, because
 *  a short true title still beats showing nothing. */
export function isWeakTitle(text: string): boolean {
  const t = text.trim();
  if (!t) return true;
  if (BARE_COMMAND_RE.test(t)) return true;
  if (URL_ONLY_RE.test(t) || MARKDOWN_LINK_ONLY_RE.test(t)) return true;
  return t.split(/\s+/).length <= 2;
}

/** Is this weak text usable as the last-resort title? A bare URL or link names
 *  nothing at all, so it never is; a short instruction does. */
function isWeakButUsable(text: string): boolean {
  const t = text.trim();
  return !!t && !URL_ONLY_RE.test(t) && !MARKDOWN_LINK_ONLY_RE.test(t);
}

/**
 * "The first user text that survives", as one object shared by both adapters
 * and the store-side backfill, so the rule cannot drift between them. Feed it
 * every user message in trace order; it keeps the first real title, the
 * handoff it continues, and a weak text to fall back on.
 */
export class TitlePicker {
  title: string | null = null;
  handoffSourceId: string | null = null;
  firstPostHandoffText: string | null = null;
  /** First skipped short text, verbatim — used only if nothing better appears. */
  weakFallback: string | null = null;

  offer(raw: string): void {
    if (this.title !== null) return;
    if (this.handoffSourceId === null) {
      const opener = handoffOpener(raw);
      if (opener) this.handoffSourceId = opener.sourceId;
    }
    // "" means injected, an opener, or empty: nothing of the owner's here.
    const derived = deriveTitle(raw);
    if (!derived) return;
    if (this.handoffSourceId !== null && this.firstPostHandoffText === null && isWeakButUsable(derived)) {
      this.firstPostHandoffText = derived;
    }
    if (isWeakTitle(derived)) {
      if (this.weakFallback === null && isWeakButUsable(derived)) this.weakFallback = derived;
      return;
    }
    this.title = derived;
  }

  /** The title with no store available: a real one, else the weak fallback.
   *  Callers WITH a store resolve `handoffSourceId` ahead of the fallback. */
  get resolved(): string | null {
    return this.title ?? this.weakFallback;
  }
}
