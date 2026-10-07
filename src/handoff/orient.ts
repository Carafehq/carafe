/**
 * W5 — the three orientation blocks a reader needs BEFORE the trace.
 *
 * Both judges said the same thing: carafe reconstructs five weeks of work
 * faithfully and never says what a "row" is, which file to open first, or what
 * the session learned the hard way. All three are already in the trace, and all
 * three are extractable without a model:
 *
 *   Glossary  — a term the session used in eight or more turns, with the first
 *               assistant sentence that DEFINED it. No definition, no entry.
 *   File map  — the most-touched source files, full repo-relative paths, with
 *               the sentence that says what each one is.
 *   Lessons   — the dead ends and breakthroughs already detected, verbatim.
 *
 * Everything is quoted, seq-anchored, and omitted when the trace does not say
 * it. Nothing is composed.
 */
import { existsSync } from "fs";
import { join, relative } from "path";
import type { CarafeEvent } from "../format/events";
import type { KeyMoment } from "../keymoments/extract";
import { cleanSentence, splitSentences } from "../keymoments/sentences";
import { filesOf, type EventPieces } from "./pieces";
import { clipAtToken, hasShellVariable } from "./leaks";

export const GLOSSARY_MIN_TURNS = 8;
export const GLOSSARY_MAX_TERMS = 15;
export const GLOSSARY_DEF_CHARS = 200;
export const FILE_MAP_FILES = 12;
export const FILE_MAP_DESC_CHARS = 160;
export const LESSONS_MAX = 12;
export const LESSON_TEXT_CHARS = 300;

const TERM_MIN = 3;
const TERM_MAX = 30;

/**
 * The common-English stoplist the glossary screens category (c) against.
 * Without it a real session's glossary read "running", "hold", "quiet",
 * "nothing", "real", "full", "word" — every one of them a word the trace uses
 * a hundred times and never defines.
 */
export const COMMON_ENGLISH = new Set<string>([
  "a", "able", "about", "above", "accept", "according", "account", "across", "act", "add", "added",
  "addition", "additional", "address", "after", "afternoon", "again", "against", "age", "ago", "agree",
  "agreed", "ahead", "aim", "air", "all", "allow", "allowed", "allows", "almost", "alone", "along",
  "already", "also", "although", "always", "among", "amount", "an", "and", "another", "answer", "answered",
  "any", "anyone", "anything", "apart", "appear", "appeared", "apply", "approach", "are", "area", "areas",
  "around", "arrive", "as", "ask", "asked", "asking", "asks", "at", "attempt", "attention", "available",
  "avoid", "away", "back", "bad", "bar", "base", "based", "basic", "be", "became", "because", "become",
  "becomes", "becoming", "been", "before", "began", "begin", "beginning", "begins", "behind", "being",
  "believe", "below", "beside", "best", "better", "between", "beyond", "big", "bit", "block", "board",
  "body", "book", "both", "bottom", "box", "break", "bring", "broken", "brought", "build", "building",
  "built", "business", "but", "buy", "by", "call", "called", "calling", "calls", "came", "can", "cannot",
  "capital", "car", "care", "carried", "carry", "carrying", "case", "cases", "catch", "caught", "cause",
  "caused", "causes", "center", "central", "certain", "certainly", "chance", "change", "changed",
  "changes", "changing", "check", "checked", "checking", "checks", "child", "children", "choice", "choose",
  "chose", "chosen", "city", "claim", "class", "clean", "clear", "clearly", "close", "closed", "closer",
  "code", "cold", "color", "come", "comes", "coming", "common", "community", "company", "compare",
  "compared", "complete", "completed", "completely", "complex", "concern", "condition", "consider",
  "considered", "contain", "contains", "continue", "continued", "control", "cool", "copy", "correct",
  "cost", "costs", "could", "count", "country", "couple", "course", "cover", "covered", "create",
  "created", "creates", "creating", "cross", "current", "currently", "cut", "daily", "damage", "dark",
  "data", "date", "day", "days", "deal", "dear", "decide", "decided", "decision", "deep", "define",
  "defined", "definitely", "degree", "deliver", "depend", "depends", "describe", "described", "design",
  "designed", "desire", "despite", "detail", "details", "determine", "develop", "developed", "development",
  "did", "die", "difference", "different", "difficult", "direct", "direction", "directly", "discuss",
  "discussion", "do", "does", "doing", "done", "door", "doubt", "down", "draw", "drawn", "drive", "drop",
  "dropped", "due", "during", "each", "earlier", "early", "easier", "easily", "east", "easy", "eat",
  "edge", "effect", "effort", "eight", "either", "else", "empty", "end", "ended", "ending", "ends",
  "enough", "enter", "entire", "equal", "error", "especially", "essential", "etc", "even", "evening",
  "event", "eventually", "ever", "every", "everyone", "everything", "exact", "exactly", "example",
  "except", "exist", "existing", "expect", "expected", "experience", "explain", "explained", "express",
  "extra", "eye", "eyes", "face", "fact", "factor", "fail", "failed", "fair", "fall", "false", "family",
  "far", "fast", "father", "fear", "feature", "features", "feel", "feeling", "feet", "felt", "few",
  "field", "fifty", "figure", "file", "fill", "filled", "final", "finally", "find", "finding", "finds",
  "fine", "finish", "finished", "fire", "firm", "first", "fit", "five", "fix", "fixed", "flat", "floor",
  "flow", "follow", "followed", "following", "follows", "food", "foot", "for", "force", "forget", "form",
  "formed", "former", "forward", "found", "four", "free", "fresh", "friend", "from", "front", "full",
  "fully", "further", "future", "gain", "game", "gave", "general", "generally", "get", "gets", "getting",
  "girl", "give", "given", "gives", "giving", "glad", "go", "goes", "going", "gone", "good", "got",
  "great", "green", "ground", "group", "grow", "growing", "grown", "guess", "guy", "had", "half", "hand",
  "handle", "hands", "hang", "happen", "happened", "happens", "happy", "hard", "has", "have", "having",
  "he", "head", "hear", "heard", "heart", "heavy", "held", "help", "helped", "helping", "her", "here",
  "herself", "hidden", "hide", "high", "higher", "highly", "him", "himself", "his", "hit", "hold",
  "holding", "holds", "home", "hope", "hoped", "hot", "hour", "hours", "house", "how", "however", "huge",
  "human", "hundred", "i", "idea", "ideas", "if", "ill", "immediately", "impact", "important", "improve",
  "in", "include", "included", "includes", "including", "increase", "increased", "indeed", "individual",
  "industry", "information", "initial", "inside", "instead", "interest", "interested", "into", "introduce",
  "involve", "involved", "is", "issue", "issues", "it", "item", "items", "its", "itself", "job", "join",
  "joined", "just", "keep", "keeping", "kept", "key", "kid", "kill", "kind", "knew", "know", "known",
  "knows", "lack", "land", "language", "large", "larger", "last", "late", "later", "latest", "lay", "lead",
  "leading", "learn", "learned", "least", "leave", "leaving", "led", "left", "leg", "length", "less",
  "let", "letter", "level", "lie", "life", "light", "like", "likely", "limit", "limited", "line", "lines",
  "list", "listed", "listen", "little", "live", "lived", "lives", "living", "local", "located", "location",
  "long", "longer", "look", "looked", "looking", "looks", "lose", "losing", "lost", "lot", "lots", "loud",
  "love", "low", "lower", "machine", "made", "main", "mainly", "maintain", "major", "make", "makes",
  "making", "man", "manage", "manner", "many", "mark", "market", "match", "material", "matter", "matters",
  "may", "maybe", "me", "mean", "meaning", "means", "meant", "measure", "media", "meet", "meeting",
  "member", "members", "mention", "mentioned", "merely", "message", "method", "middle", "might", "mile",
  "million", "mind", "mine", "minute", "minutes", "miss", "missed", "missing", "mode", "model", "modern",
  "moment", "money", "month", "months", "moral", "more", "moreover", "morning", "most", "mostly", "mother",
  "motion", "move", "moved", "movement", "moves", "moving", "much", "music", "must", "my", "myself",
  "name", "named", "names", "national", "natural", "nature", "near", "nearly", "necessary", "need",
  "needed", "needs", "neither", "net", "never", "nevertheless", "new", "newer", "news", "next", "nice",
  "night", "nine", "no", "nobody", "none", "nor", "normal", "normally", "north", "not", "note", "noted",
  "nothing", "notice", "noticed", "now", "nowhere", "number", "numbers", "object", "obtain", "obvious",
  "obviously", "occur", "occurred", "of", "off", "offer", "offered", "office", "often", "oh", "ok", "okay",
  "old", "older", "on", "once", "one", "ones", "only", "onto", "open", "opened", "opening", "operation",
  "opinion", "opportunity", "opposite", "option", "options", "or", "order", "orders", "ordinary",
  "organization", "original", "other", "others", "otherwise", "ought", "our", "ours", "ourselves", "out",
  "outside", "over", "overall", "own", "owner", "page", "pages", "paid", "pain", "paper", "part",
  "particular", "particularly", "parts", "party", "pass", "passed", "passing", "past", "pattern", "pay",
  "people", "per", "percent", "perfect", "perform", "performance", "perhaps", "period", "person",
  "personal", "phone", "physical", "pick", "picked", "picture", "piece", "pieces", "place", "placed",
  "places", "plain", "plan", "planned", "plans", "plant", "play", "played", "please", "plus", "point",
  "pointed", "points", "policy", "political", "poor", "popular", "population", "position", "positive",
  "possible", "possibly", "post", "potential", "power", "practice", "prepare", "present", "president",
  "press", "pressure", "pretty", "prevent", "previous", "previously", "price", "prices", "primary",
  "prime", "print", "prior", "private", "probably", "problem", "problems", "process", "produce",
  "produced", "product", "production", "program", "programs", "progress", "project", "projects", "proper",
  "properly", "property", "propose", "protect", "prove", "provide", "provided", "provides", "public",
  "pull", "purpose", "push", "put", "putting", "quality", "question", "questions", "quick", "quickly",
  "quiet", "quietly", "quite", "race", "raise", "raised", "ran", "range", "rate", "rather", "reach",
  "reached", "read", "reading", "ready", "real", "reality", "realize", "really", "reason", "reasons",
  "receive", "received", "recent", "recently", "recognize", "record", "red", "reduce", "refer",
  "reference", "reflect", "regard", "region", "regular", "relate", "related", "relationship", "relatively",
  "release", "remain", "remained", "remains", "remember", "remove", "removed", "report", "reported",
  "reports", "represent", "request", "require", "required", "requires", "research", "resource", "respond",
  "response", "responsible", "rest", "result", "results", "return", "returned", "reveal", "review", "rich",
  "ride", "right", "rise", "rising", "risk", "road", "role", "room", "round", "rule", "rules", "run",
  "running", "runs", "safe", "safety", "said", "same", "sat", "save", "saw", "say", "saying", "says",
  "scale", "scene", "school", "science", "scope", "score", "screen", "sea", "search", "season", "seat",
  "second", "section", "secure", "security", "see", "seeing", "seek", "seem", "seemed", "seems", "seen",
  "sell", "send", "sense", "sent", "sentence", "separate", "series", "serious", "serve", "service",
  "services", "set", "sets", "setting", "settings", "seven", "several", "shall", "shape", "share", "sharp",
  "she", "sheet", "shift", "ship", "shoot", "shop", "short", "shot", "should", "shoulder", "show",
  "showed", "showing", "shown", "shows", "side", "sign", "signal", "significant", "similar", "simple",
  "simply", "since", "single", "sir", "sister", "sit", "site", "sitting", "situation", "six", "size",
  "skill", "sky", "sleep", "slight", "slightly", "slow", "slowly", "small", "smaller", "smile", "so",
  "social", "society", "soft", "software", "sold", "soldier", "solution", "solve", "some", "somebody",
  "somehow", "someone", "something", "sometimes", "somewhat", "somewhere", "son", "song", "soon", "sort",
  "sound", "source", "sources", "south", "space", "speak", "special", "specific", "specifically", "speech",
  "speed", "spend", "spent", "spirit", "split", "spoke", "sport", "spread", "spring", "staff", "stage",
  "stand", "standard", "standing", "stands", "star", "start", "started", "starting", "starts", "state",
  "statement", "states", "station", "status", "stay", "step", "steps", "still", "stock", "stood", "stop",
  "stopped", "stops", "store", "story", "straight", "strange", "street", "strength", "stress", "strict",
  "strike", "strong", "stronger", "strongly", "structure", "student", "studies", "study", "stuff", "style",
  "subject", "success", "successful", "such", "sudden", "suddenly", "suffer", "suggest", "suggested",
  "summer", "sun", "supply", "support", "suppose", "sure", "surface", "surprise", "system", "systems",
  "table", "take", "taken", "takes", "taking", "talk", "talked", "talking", "tall", "task", "tasks", "tax",
  "teach", "teacher", "team", "technology", "tell", "telling", "ten", "tend", "term", "terms", "test",
  "tests", "text", "than", "thank", "that", "the", "their", "theirs", "them", "themselves", "then",
  "theory", "there", "therefore", "these", "they", "thing", "things", "think", "thinking", "third",
  "thirty", "this", "those", "though", "thought", "thousand", "three", "through", "throughout", "throw",
  "thus", "tie", "time", "times", "tiny", "title", "to", "today", "together", "told", "tomorrow", "tone",
  "tonight", "too", "took", "tool", "tools", "top", "total", "totally", "touch", "toward", "towards",
  "town", "track", "trade", "tradition", "traditional", "train", "training", "travel", "treat",
  "treatment", "tree", "trial", "trip", "trouble", "true", "truly", "trust", "truth", "try", "trying",
  "turn", "turned", "turning", "turns", "twenty", "twice", "two", "type", "types", "typically", "under",
  "understand", "understanding", "unit", "united", "unless", "until", "up", "upon", "us", "use", "used",
  "useful", "user", "users", "uses", "using", "usual", "usually", "value", "values", "variety", "various",
  "version", "very", "via", "victim", "view", "views", "violence", "visit", "voice", "vote", "wait",
  "waiting", "walk", "walked", "walking", "wall", "want", "wanted", "wants", "war", "warm", "was", "watch",
  "water", "way", "ways", "we", "weak", "wear", "week", "weeks", "weight", "welcome", "well", "went",
  "were", "west", "what", "whatever", "when", "whenever", "where", "whereas", "whether", "which", "while",
  "white", "who", "whole", "whom", "whose", "why", "wide", "widely", "wife", "will", "win", "wind",
  "window", "wish", "with", "within", "without", "woman", "women", "wonder", "word", "words", "work",
  "worked", "worker", "working", "works", "world", "worry", "worse", "worth", "would", "write", "writer",
  "writes", "writing", "written", "wrong", "wrote", "yard", "yeah", "year", "years", "yes", "yesterday",
  "yet", "you", "young", "your", "yours", "yourself"
]);


/**
 * What may follow `is` / `are` / `means` in a DEFINITION.
 *
 * "The beat is stopped.", "Codex is worse", "Prod is genuinely degraded this
 * minute" are states of the world, not definitions of a term; a definition
 * names a thing, so its predicate opens on an article or a determiner.
 *
 * v6/V9 — `one` is gone. "The remaining gap is one we already knew about" is
 * not a definition of `gap`, and `one` was the determiner that let sentences
 * like it in.
 */
const PREDICATE_RE = /^\s*(?:(?:just|only|simply|now)\s+)?(?:not a|not the|a|an|the|our|your|what|where|how|when|which)\b/i;
const FILE_DESC_RE = /\bis\b|\bholds\b|\bowns\b|\bhandles\b/;
const SOURCE_FILE_RE = /\.(?:ts|tsx|js|jsx|mjs|cjs|py|rs|go|java|rb|swift|kt|c|h|cpp|hpp|cs|php|sql|sh|css|scss|html|vue|svelte|md|json|yml|yaml|toml)$/i;

const isPathish = (term: string): boolean => term.includes("/") || term.includes("\\") || SOURCE_FILE_RE.test(term);

interface Turn { seq: number; text: string; role: "user" | "assistant" | "other" }

function turnsOf(pieces: EventPieces[]): Turn[] {
  const turns: Turn[] = [];
  for (const piece of pieces) {
    for (const line of piece.lines) {
      if (line.startsWith("**user:**")) turns.push({ seq: piece.seq, text: line.slice("**user:**".length), role: "user" });
      else if (line.startsWith("**assistant:**")) turns.push({ seq: piece.seq, text: line.slice("**assistant:**".length), role: "assistant" });
    }
  }
  return turns;
}

/** The three families of candidate term, kept apart because they are screened
 *  differently: a backticked token and a proper noun are already evidence that
 *  the session treats the word as a name; an ordinary word is not. */
export type TermKind = "backticked" | "proper" | "word";

/** Every candidate term in one turn, with the family it came from. */
export function termsInTurn(text: string): Map<string, TermKind> {
  const terms = new Map<string, TermKind>();
  const put = (term: string, kind: TermKind): void => { if (!terms.has(term)) terms.set(term, kind); };

  for (const match of text.matchAll(/`([^`\n]{1,40})`/g)) {
    const token = (match[1] ?? "").trim();
    if (token.length >= TERM_MIN && token.length <= TERM_MAX && !isPathish(token) && !/\s/.test(token)) put(token, "backticked");
  }
  // a capitalized word that does NOT open its sentence is a name: Rook,
  // Sentinel, Postgres. One that does is just a sentence starting.
  for (const sentence of text.split(/(?<=[.!?\n])\s+/)) {
    let first = true;
    for (const match of sentence.matchAll(/[A-Za-z][\w-]{2,29}/g)) {
      const word = match[0]!;
      const atStart = first;
      first = false;
      if (word.length < TERM_MIN || word.length > TERM_MAX || isPathish(word)) continue;
      if (/^[A-Z]/.test(word) && !atStart && !/^[A-Z]+$/.test(word.slice(1))) { put(word, "proper"); continue; }
      put(word.toLowerCase(), "word");
    }
  }
  return terms;
}

export interface GlossaryEntry { term: string; kind: TermKind; turns: number; definition: string; seq: number }

/**
 * A term is only in the glossary when the trace DEFINED it — and a definition
 * is a sentence with the term in subject position, not a sentence that happens
 * to contain it. ("The build order is strict: runtime.ts is not allowed to
 * grow" is not a definition of `runtime.ts`.)
 */
export function glossaryEntries(pieces: EventPieces[]): GlossaryEntry[] {
  const turns = turnsOf(pieces);
  const counts = new Map<string, number>();
  const kinds = new Map<string, TermKind>();
  for (const turn of turns) {
    for (const [term, kind] of termsInTurn(turn.text)) {
      counts.set(term, (counts.get(term) ?? 0) + 1);
      if (!kinds.has(term) || kind !== "word") kinds.set(term, kind);
    }
  }
  // v6/V9 — `Row` and `row` are one term. A glossary that lists both, with the
  // same definition under each, is a glossary nobody trusts. The casing the
  // session used most often wins, and the counts add up.
  const folded = new Map<string, { term: string; count: number }>();
  for (const [term, count] of counts) {
    const key = term.toLowerCase();
    const existing = folded.get(key);
    if (!existing) { folded.set(key, { term, count }); continue; }
    folded.set(key, { term: count > existing.count ? term : existing.term, count: existing.count + count });
  }
  const eligible = [...folded.values()].map(({ term, count }) => [term, count] as const).filter(([term, count]) => {
    const kind = kinds.get(term)!;
    if (kind === "word") return count >= GLOSSARY_MIN_TURNS && !COMMON_ENGLISH.has(term.toLowerCase());
    return true;
  }).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));

  const entries: GlossaryEntry[] = [];
  const sentences = definableSentences(turns);
  for (const [term, count] of eligible) {
    if (entries.length >= GLOSSARY_MAX_TERMS) break;
    const found = definitionOf(term, sentences);
    if (!found) continue;
    entries.push({ term, kind: kinds.get(term)!, turns: count, definition: found.text, seq: found.seq });
  }
  return entries;
}

/** The term in SUBJECT position: `A row is …`, `Sentinel means …`. */
export function subjectDefinition(term: string): RegExp {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^(?:A|An|The|This|Our)?\\s*${escaped}\\b\\s+(?:is|are|means|refers to|=)\\b`, "i");
}

/** …and the predicate has to name a thing. */
export function isDefinitionSentence(term: string, sentence: string): boolean {
  const match = subjectDefinition(term).exec(sentence);
  if (!match) return false;
  return PREDICATE_RE.test(sentence.slice(match[0].length));
}

/**
 * Splitting every assistant turn into sentences once, in order, instead of once
 * per candidate term: the scan is the same scan, and on a long session it was
 * repeated a few hundred times over the whole trace.
 */
function definableSentences(turns: Turn[]): Array<{ text: string; seq: number }> {
  const out: Array<{ text: string; seq: number }> = [];
  for (const turn of turns) {
    if (turn.role !== "assistant") continue;
    for (const raw of splitSentences(turn.text)) {
      const sentence = cleanSentence(raw);
      if (!sentence || sentence.length < 12 || hasShellVariable(sentence)) continue;
      out.push({ text: sentence, seq: turn.seq });
    }
  }
  return out;
}
function definitionOf(term: string, sentences: Array<{ text: string; seq: number }>): { text: string; seq: number } | null {
  for (const one of sentences) {
    if (!isDefinitionSentence(term, one.text)) continue;
    return { text: clip(one.text, GLOSSARY_DEF_CHARS), seq: one.seq };
  }
  return null;
}

/** The rendered section for entries already extracted. */
export function glossaryBlock(entries: GlossaryEntry[]): string[] {
  if (!entries.length) return [];
  return [
    `## Glossary (terms this session used, with the sentence that first defined them)`,
    ``,
    ...entries.map((entry) => `- ${entry.term} (${entry.turns} turns): "${entry.definition}"  [seq ${entry.seq}]`),
    ``,
  ];
}
export function glossaryLines(pieces: EventPieces[]): string[] {
  const entries = glossaryEntries(pieces);
  if (!entries.length) return [];
  return [
    `## Glossary (terms this session used, with the sentence that first defined them)`,
    ``,
    ...entries.map((entry) => `- ${entry.term} (${entry.turns} turns): "${entry.definition}"  [seq ${entry.seq}]`),
    ``,
  ];
}

/* ------------------------------------------------------------------ */

export interface FileMapEntry { repo: string | null; path: string; touches: number; description: string | null; seq: number | null }

/** A file's home repository, resolved at generation time. A trace records
 *  `src/lib/llm/runtime.ts` as often as it records the absolute path, and a map
 *  that lists both is two entries for one file — which is what a real handoff
 *  printed, 129 touches under "(repository not recorded)" and 84 under the
 *  repo. The disk says which one it is. */
export function resolveInRepos(file: string, repos: Array<{ path: string; calls: number }>): { repo: string | null; full: string } | null {
  if (file.startsWith("/")) {
    const repo = repos.find((candidate) => file.startsWith(`${candidate.path}/`));
    return { repo: repo?.path ?? null, full: file };
  }
  const homes = repos.filter((candidate) => existsSync(join(candidate.path, file)));
  if (!homes.length) return null;                      // a relative path with no home is not a fact
  // two repositories hold the same relative path: the busier one is the one
  // this session was working in
  const home = homes.slice().sort((a, b) => b.calls - a.calls)[0]!;
  return { repo: home.path, full: join(home.path, file) };
}

export function fileMapEntries(events: CarafeEvent[], pieces: EventPieces[], repos: Array<{ path: string; calls: number }>): FileMapEntry[] {
  const counts = new Map<string, { repo: string | null; touches: number }>();
  for (const event of events) {
    for (const file of filesOf(event)) {
      if (!SOURCE_FILE_RE.test(file)) continue;
      if (hasShellVariable(file)) continue;
      const resolved = resolveInRepos(file, repos);
      if (!resolved) continue;
      const existing = counts.get(resolved.full);
      counts.set(resolved.full, { repo: resolved.repo, touches: (existing?.touches ?? 0) + 1 });
    }
  }
  const top = [...counts.entries()].sort((a, b) => b[1].touches - a[1].touches || a[0].localeCompare(b[0])).slice(0, FILE_MAP_FILES);
  const turns = turnsOf(pieces);
  return top.map(([file, { repo, touches }]) => {
    const shown = repo ? relative(repo, file) : file;
    const described = describeFile(file, shown, turns);
    return { repo, path: shown, touches, description: described?.text ?? null, seq: described?.seq ?? null };
  });
}

/** Same rule as the glossary: the file has to be the SUBJECT of the sentence. */
function describeFile(full: string, shown: string, turns: Turn[]): { text: string; seq: number } | null {
  const names = [...new Set([shown, full.split("/").pop() ?? shown])];
  const holds = names.map((name) => new RegExp(`^(?:A|An|The|This|Our)?\\s*${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b\\s+(?:holds|owns|handles)\\b`, "i"));
  for (const turn of turns) {
    if (turn.role !== "assistant") continue;
    for (const raw of splitSentences(turn.text)) {
      const sentence = cleanSentence(raw);
      if (!sentence || hasShellVariable(sentence)) continue;
      const defines = names.some((name) => isDefinitionSentence(name, sentence));
      if (!defines && !holds.some((re) => re.test(sentence))) continue;
      return { text: clip(sentence, FILE_MAP_DESC_CHARS), seq: turn.seq };
    }
  }
  return null;
}

export function fileMapLines(events: CarafeEvent[], pieces: EventPieces[], repos: Array<{ path: string; calls: number }>): string[] {
  const entries = fileMapEntries(events, pieces, repos);
  if (!entries.length) return [];
  const lines = [`## File map`, ``];
  const groups = new Map<string, FileMapEntry[]>();
  for (const entry of entries) {
    // an absolute path under no known repository is real, and says so
    const key = entry.repo ?? "elsewhere";
    groups.set(key, [...(groups.get(key) ?? []), entry]);
  }
  for (const [repo, group] of groups) {
    lines.push(`- ${repo}`);
    for (const entry of group) {
      lines.push(`  - ${entry.path} (${entry.touches})${entry.description ? `: "${entry.description}"  [seq ${entry.seq}]` : ""}`);
    }
  }
  lines.push(``);
  return lines;
}

/* ------------------------------------------------------------------ *
 * Lessons
 * ------------------------------------------------------------------ */

const clip = clipAtToken;

/** The words that mark a sentence as an explanation rather than a narration. */
/**
 * STRONG cues only. The weak set let "If the probe delivers products…" and
 * "Results land in grade-v10…" into a section headed "Lessons" — narration,
 * not explanation. `instead`, `never`, `didn't`, `doesn't`, `actually` and
 * `not the` all appear in ordinary progress reports and are gone.
 */
const CAUSAL_CUES = [
  "because", "turns out", "turned out", "root cause", "the cause", "the reason",
  "the problem was", "the problem is", "the fix was", "the fix is",
  "not evidence", "isn't the", "wasn't the", "on my review", "my mistake", "i was wrong",
];

/**
 * A PLAN is not a lesson.
 *
 * "Codex is working right now, on its own branch, under a repro-first brief:
 * … find the root cause, fix it" carries `root cause` and says nothing that was
 * learned — it says what someone is about to do. A lesson is in the past tense
 * by nature; these words mark the future.
 */
/** v6/V9 — `I'll rerun it`, `I will check`, `when it reports green`, `Status
 *  after the fix:` all reached a real Lessons section and none of them is a
 *  lesson: they are the next thing someone is about to do. */
const PLAN_RE = /\bwill\s|\bgoing to\b|\bdirected to\b|\bis working\b|\bbrief\b|\bI['’]ll\s|\bI will\b|\bwhen it reports\b|\bStatus after\b/i;

export function isPlanSentence(sentence: string): boolean {
  // …and a sentence that ends on a colon is the heading of the list that follows
  return PLAN_RE.test(sentence) || /:\s*$/.test(sentence.trim());
}

export function hasCausalCue(sentence: string): boolean {
  if (isPlanSentence(sentence)) return false;
  const text = sentence.toLowerCase();
  return CAUSAL_CUES.some((cue) => text.includes(cue));
}

/** The explanation a moment earned: the first assistant sentence within the
 *  next two turns of the moment's OWN trace that says why. */
export type LessonLookup = (moment: KeyMoment) => { text: string; seq: number } | null;

/**
 * The transferable part of a session: what it tried that did not work, and what
 * finally did — in the assistant's own words.
 *
 * A lesson is NEVER a command. A real handoff's Lessons section read
 * "dead end: Bash: cd … && git reset -q --soft HEAD~1 → explicit reversal",
 * which tells a reader nothing they could not have guessed. The sentence that
 * explains the reversal is in the trace two turns later; that is the lesson,
 * and a moment with no such sentence is left out rather than padded.
 */
/**
 * v6/V9 — one seq, one kind.
 *
 * A failing run that finally passes can fire the dead-end detector and the
 * breakthrough detector on the same carrier event, and the file then printed
 * the same seq as both "this did not work" and "this is what worked". The dead
 * end is the one that costs a reader something to not know, so it stays and the
 * breakthrough on that seq goes. Rendering only — `carafe key-moments` and both
 * sealed benches score the detectors' own output, untouched.
 */
export function withoutDoubleLabelled(moments: KeyMoment[]): KeyMoment[] {
  const deadends = new Set(moments.filter((one) => one.kind === "deadend").map((one) => `${one.via ?? ""}:${one.seq}`));
  return moments.filter((one) => one.kind !== "breakthrough" || !deadends.has(`${one.via ?? ""}:${one.seq}`));
}

/**
 * Round 8 — a "dead end" describes something tried that did not work. The
 * explanation sentence has to say so in its own words; "Vacuous tests: found
 * none" and "This layer exists because conversations are stateful" reached a
 * real handoff under that label and neither is one.
 */
const DEAD_END_CUE_RE = /\b(?:tried|attempt(?:ed|s)?|did(?:n['’]t| not) (?:work|help|fix)|does(?:n['’]t| not) (?:work|help|fix)|gave up|giving up|abandon(?:ed|ing)?|revert(?:ed|ing)?|rolled back|backed out|dead[- ]end|turned out|wrong (?:layer|fix|approach|place|file|repo(?:sitory)?|branch|path|assumption|model|test)|not evidence|no luck|went nowhere|false (?:lead|alarm|start)|red herring|was a mistake|failed (?:to|because|again)|made (?:it|things) worse|wasted)\b/i;
export const isDeadEndSentence = (text: string): boolean => DEAD_END_CUE_RE.test(text);

export function lessonsLines(moments: KeyMoment[], tsBySeq: Map<number, string | null>, explain: LessonLookup): string[] {
  // round 8 — one explanation sentence, one label. Two moments (a dead end and
  // a breakthrough on different seqs) can share the sentence that explains
  // them; the dead end is the one a reader pays for not knowing, so it wins.
  const rows = new Map<string, { row: string; label: string }>();
  const candidates = withoutDoubleLabelled(moments).filter((one) => one.kind === "deadend" || one.kind === "breakthrough").sort((a, b) => b.seq - a.seq);
  for (const moment of candidates) {
    if (rows.size >= LESSONS_MAX) break;
    const said = explain(moment);
    if (!said) continue;
    const text = clip(said.text.replace(/\s+/g, " ").trim(), LESSON_TEXT_CHARS);
    const label = moment.kind === "deadend" ? "dead end" : "breakthrough";
    // an explicit reversal (a reset, a revert) IS the abandoned attempt; any other
    // "dead end" must say in its own words that something was tried and dropped
    if (label === "dead end" && !/reversal/i.test(moment.note ?? "") && !isDeadEndSentence(text)) continue;
    const anchor = moment.via ? `agent-${moment.via} seq ${said.seq}` : `seq ${said.seq}`;
    const key = text;
    const date = (tsBySeq.get(moment.seq) ?? "").slice(0, 10) || "date not recorded";
    const row = `- ${date} · ${label}: ${text}  [${anchor}]`;
    const existing = rows.get(key);
    if (!existing) rows.set(key, { row, label });
    else if (existing.label === "breakthrough" && label === "dead end") rows.set(key, { row, label });
  }
  if (!rows.size) return [];
  return [`## Lessons (dead ends and breakthroughs, verbatim)`, ``, ...[...rows.values()].map((one) => one.row), ``];
}
