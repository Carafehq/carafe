import { Database } from "bun:sqlite";
import { basename } from "path";
import { existsSync, mkdirSync, readFileSync } from "fs";
import { dirname, join } from "path";
import type { SessionDistillate } from "../format/distillate";
import { atomicWriteFileSync, type CarafeStore } from "../format/store";
import { isAck, normalizeSentence } from "../keymoments/signals";
import { sessionIndexPath } from "../search/session-index";

export type PointerKind = "deadend" | "rule" | "decision" | "breakthrough" | "steering" | "chapter";

export interface Pointer {
  key: string;
  sessionId: string;
  sessionKey: string;
  tool: string;
  kind: PointerKind;
  seq: number;
  endSeq: number;
  chapterIdx: number;
  excerpt: string;
  address: string;
  score: number;
  entity: string;
  line: string;
}

export interface ReflexResult { pointers: Pointer[]; text: string; silentReason?: string }
export interface ReflexInput {
  store: CarafeStore;
  /** Project mode. The legacy single-session shape below is normalized to this. */
  sessions?: Array<{ session: SessionDistillate; tailStartSeq?: number; excludeLastChapter?: boolean; bonus?: number }>;
  session?: SessionDistillate;
  turnText: string;
  receiverId: string;
  k?: number;
  budgetChars?: number;
  tailStartSeq?: number;
  cwd?: string;
}

interface Entity { kind: "file" | "error" | "command" | "branch" | "rule"; value: string; specificity: number; sessionKey?: string }
interface Candidate {
  kind: PointerKind; seq: number; endSeq: number; chapterIdx: number;
  excerpt: string; address: string; specificity: number; entity: string; score?: number;
  sessionId: string; sessionKey: string; tool: string;
}

interface EntityCatalog {
  commands: string[];
  rules: Array<{ sessionKey: string; seq: number; text: string }>;
}

const KIND_WEIGHT: Record<PointerKind, number> = { deadend: 5, rule: 4, decision: 4, breakthrough: 3, steering: 2, chapter: 1 };
/** Kinds worth a second line for an entity that already has a pointer. Steering
 * turns and chapters are context, not answers: as seconds they were the bulk of
 * ReflexBench's wrong pointers. */
const STRONG_KINDS = new Set<PointerKind>(["deadend", "decision", "breakthrough", "rule"]);
// Tried and rejected: dropping candidates more than 3 points below the turn's
// best. It removed the correct pointer on two should-fire turns per tool on
// ReflexBench and lowered strict precision; the runner-up is often the answer.
const MOMENT_KIND: Record<string, PointerKind | undefined> = { deadend: "deadend", rule: "rule", decision: "decision", breakthrough: "breakthrough", steering: "steering" };
const SYSTEM_MARKERS = ["<system-reminder", "<environment_context", "<command-name", "<command-message", "<local-command", "<task-notification", "Caveat:", "[Request interrupted", "This session is being continued from a previous conversation"];
const COMMON_WORDS = new Set(["make", "find", "file", "head", "tail", "less", "more", "time", "tree", "test", "true", "echo", "sleep", "touch", "kill", "watch", "which", "date", "sort", "diff", "open", "read", "type", "help", "list", "show", "export", "source", "history", "clear", "exit", "wait", "yes"]);

function isSystemText(text: string): boolean {
  const trimmed = text.trimStart();
  return SYSTEM_MARKERS.some((marker) => trimmed.startsWith(marker));
}

function unique<T>(items: T[]): T[] { return [...new Set(items)]; }

function fileEntities(text: string): Entity[] {
  const urlRanges: Array<[number, number]> = [];
  for (const match of text.matchAll(/https?:\/\/\S+/gi)) if (match.index != null) urlRanges.push([match.index, match.index + match[0].length]);
  const values: string[] = [];
  const addMatches = (re: RegExp): void => {
    for (const match of text.matchAll(re)) {
      const index = match.index ?? -1;
      if (urlRanges.some(([start, end]) => index >= start && index < end)) continue;
      const value = (match[1] ?? match[0]).replace(/[),:;.!?]+$/, "");
      if (value) values.push(value);
    }
  };
  addMatches(/([\w./-]+\.[a-z0-9]{1,6})/gi);
  addMatches(/`([\w./-]+)`/g);
  return unique(values).map((value) => ({ kind: "file", value, specificity: value.includes("/") ? 2 : 1 }));
}

function boundaryIncludes(text: string, value: string): boolean {
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[^\\w])${escaped}(?=$|[^\\w])`, "i").test(text);
}

function extractEntities(catalog: EntityCatalog, text: string): Entity[] {
  const entities = fileEntities(text);
  const errors = unique([
    ...(text.match(/\bTS\d{4}\b/g) ?? []), ...(text.match(/\bE[A-Z]{3,}\b/g) ?? []),
    ...(text.match(/\b(?:Traceback|AssertionError|panic|ELIFECYCLE)\b/gi) ?? []),
  ]);
  entities.push(...errors.map((value) => ({ kind: "error" as const, value, specificity: 2 })));

  // A family is an entity when it reads as a command, not as an English word: two
  // tokens (`bun test`, `npm run`) always; a lone token only when it is not a word
  // people write in ordinary sentences ("make", "find", "cat", "go").
  for (const value of catalog.commands) {
    const commandLike = value.includes(" ") || (value.length >= 4 && !COMMON_WORDS.has(value));
    if (commandLike && boundaryIncludes(text, value)) entities.push({ kind: "command", value, specificity: 1 });
    // Families keep npm/bun/yarn script names, and people write the script alone
    // ("deploy:update keeps failing"). A distinctive script name (a ':' or '-' in
    // it, or long and not an ordinary word) resolves to its family.
    const script = /^(?:npm|bun|yarn)(?: run)? (\S+)$/.exec(value)?.[1];
    if (script && (/[:-]/.test(script) || (script.length >= 8 && !COMMON_WORDS.has(script))) && boundaryIncludes(text, script)) {
      entities.push({ kind: "command", value, specificity: 1 });
    }
  }

  const branches = new Set<string>();
  for (const match of text.matchAll(/\b(?:feat|fix|chore)\/[\w./-]+/gi)) branches.add(match[0].replace(/[),:;.!?]+$/, ""));
  for (const match of text.matchAll(/\bbranch(?:\s+(?:named|is|of))?\s+[`'"]?([\w./-]+)/gi)) if (match[1]) branches.add(match[1]);
  entities.push(...[...branches].map((value) => ({ kind: "branch" as const, value, specificity: 1 })));

  const turnTerms = new Set(normalizeSentence(text).split(/\s+/).filter((word) => word.length >= 3));
  for (const rule of catalog.rules) {
    const overlap = unique(normalizeSentence(rule.text).split(/\s+/).filter((word) => word.length >= 3 && turnTerms.has(word)));
    if (overlap.length >= 2) entities.push({ kind: "rule", value: String(rule.seq), specificity: 0, sessionKey: rule.sessionKey });
  }
  const seen = new Set<string>();
  return entities.filter((entity) => {
    const key = `${entity.sessionKey ?? ""}\0${entity.kind}\0${entity.value.toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });
}

function intentBoost(text: string): Partial<Record<PointerKind, number>> {
  const boost: Partial<Record<PointerKind, number>> = {};
  if (/\b(?:why|chosen|chose|decided|decision|rationale|reason(?:ing)?)\b/i.test(text)) { boost.decision = 3; }
  if (/\b(?:fail(?:s|ed|ing)?|error|broken|breaks|crash|retry|again|flaky|stuck)\b/i.test(text)) { boost.deadend = 2; boost.breakthrough = 2; }
  if (/\b(?:rule|always|never|must|constraint|policy|invariant)\b/i.test(text)) { boost.rule = 3; }
  if (/\bbranch\b/i.test(text)) { boost.chapter = 2; }
  return boost;
}

function excerpt(text: string | null | undefined): string {
  const clean = (text ?? "").replace(/^\*\*(?:user|assistant):\*\*\s*/i, "").replace(/^\s*⤷\s*/, "").trim();
  const line = clean.split(/\r?\n/).find((part) => part.trim())?.trim() ?? clean;
  return line.length <= 90 ? line : `${line.slice(0, 89)}…`;
}

function momentCandidate(row: Record<string, unknown>, specificity: number, entity: string, session: SessionDistillate): Candidate | null {
  const kind = MOMENT_KIND[String(row.kind)];
  if (!kind) return null;
  const seq = Number(row.seq); const endSeq = Number(row.endSeq ?? row.seq);
  return { kind, seq, endSeq, chapterIdx: Number(row.chapterIdx), excerpt: excerpt(String(row.text ?? row.note ?? "")), address: `carafe show ${session.sessionId} --seq ${seq}${endSeq !== seq ? `-${endSeq}` : ""}`, specificity, entity, sessionId: session.sessionId, sessionKey: `${session.tool}\0${session.sessionId}`, tool: session.tool };
}

function chapterCandidate(row: Record<string, unknown>, specificity: number, entity: string, session: SessionDistillate, sourceExcerpt?: string): Candidate {
  return { kind: "chapter", seq: Number(row.startSeq), endSeq: Number(row.endSeq), chapterIdx: Number(row.chapterIdx), excerpt: excerpt(sourceExcerpt ?? String(row.excerpt ?? row.branch ?? row.cwd ?? "chapter")), address: `carafe chapters ${session.sessionId} --chapter ${Number(row.chapterIdx)}`, specificity, entity, sessionId: session.sessionId, sessionKey: `${session.tool}\0${session.sessionId}`, tool: session.tool };
}

function resolveEntities(db: Database, entities: Entity[], session: SessionDistillate): Candidate[] {
  const candidates: Candidate[] = [];
  for (const entity of entities) {
    if (entity.sessionKey && entity.sessionKey !== `${session.tool}\0${session.sessionId}`) continue;
    if (entity.kind === "file") {
      const rows = db.query(`SELECT m.seq, m.end_seq AS endSeq, m.kind, m.chapter_idx AS chapterIdx, m.text, m.note
        FROM moments m JOIN moment_files mf ON mf.seq = m.seq
        WHERE lower(mf.basename) = lower($file) OR lower(substr(mf.file, -length($file))) = lower($file)
        ORDER BY CASE m.kind WHEN 'deadend' THEN 0 WHEN 'rule' THEN 1 WHEN 'decision' THEN 2 WHEN 'breakthrough' THEN 3 WHEN 'steering' THEN 4 ELSE 5 END, m.seq DESC`).all({ $file: entity.value }) as Array<Record<string, unknown>>;
      const resolved = rows.map((row) => momentCandidate(row, entity.specificity, entity.value, session)).filter((item): item is Candidate => item != null);
      if (resolved.length) candidates.push(...resolved);
      else {
        const row = db.query(`SELECT c.idx AS chapterIdx, c.start_seq AS startSeq, c.end_seq AS endSeq, b.first_line AS excerpt
          FROM block_files bf JOIN blocks b ON b.idx = bf.block_idx JOIN chapters c ON c.idx = b.chapter_idx
          WHERE lower(bf.basename) = lower($file) OR lower(substr(bf.file, -length($file))) = lower($file)
          GROUP BY c.idx ORDER BY sum(bf.edited) DESC, sum(bf.touches) DESC, c.idx DESC LIMIT 1`).get({ $file: entity.value }) as Record<string, unknown> | null;
        if (row) candidates.push(chapterCandidate(row, entity.specificity, entity.value, session));
      }
    } else if (entity.kind === "error") {
      const runs = db.query(`SELECT r.excerpt, c.idx AS chapterIdx, c.start_seq AS startSeq, c.end_seq AS endSeq
        FROM runs r JOIN chapters c ON c.idx = r.chapter_idx WHERE r.ok = 0 AND lower(r.excerpt) LIKE lower($match) ORDER BY r.seq DESC`).all({ $match: `%${entity.value}%` }) as Array<Record<string, unknown>>;
      for (const run of runs) {
        candidates.push(chapterCandidate(run, 2, entity.value, session));
        const moments = db.query(`SELECT seq, end_seq AS endSeq, kind, chapter_idx AS chapterIdx, text, note FROM moments WHERE kind = 'breakthrough' AND chapter_idx = $chapter`).all({ $chapter: Number(run.chapterIdx) }) as Array<Record<string, unknown>>;
        for (const row of moments) { const candidate = momentCandidate(row, 2, entity.value, session); if (candidate) candidates.push(candidate); }
      }
    } else if (entity.kind === "command") {
      const failed = db.query(`SELECT r.seq, r.chapter_idx AS chapterIdx, r.excerpt, c.start_seq AS startSeq, c.end_seq AS endSeq
        FROM runs r JOIN chapters c ON c.idx = r.chapter_idx WHERE r.ok = 0 AND lower(r.family) = lower($family) ORDER BY r.chapter_idx DESC, r.seq`).all({ $family: entity.value }) as Array<Record<string, unknown>>;
      if (failed.length) {
        const chapters = unique(failed.map((row) => Number(row.chapterIdx)));
        let foundDeadend = false;
        for (const chapter of chapters) {
          const moments = db.query(`SELECT seq, end_seq AS endSeq, kind, chapter_idx AS chapterIdx, text, note FROM moments WHERE kind = 'deadend' AND chapter_idx = $chapter ORDER BY seq`).all({ $chapter: chapter }) as Array<Record<string, unknown>>;
          for (const row of moments) { const candidate = momentCandidate(row, 1, entity.value, session); if (candidate) { candidates.push(candidate); foundDeadend = true; } }
        }
        if (!foundDeadend) {
          const counts = new Map<number, number>();
          for (const row of failed) counts.set(Number(row.chapterIdx), (counts.get(Number(row.chapterIdx)) ?? 0) + 1);
          const best = failed.slice().sort((a, b) => (counts.get(Number(b.chapterIdx)) ?? 0) - (counts.get(Number(a.chapterIdx)) ?? 0) || Number(b.chapterIdx) - Number(a.chapterIdx))[0]!;
          candidates.push(chapterCandidate(best, 1, entity.value, session, String(best.excerpt ?? "")));
        }
      }
    } else if (entity.kind === "branch") {
      const rows = db.query(`SELECT idx AS chapterIdx, start_seq AS startSeq, end_seq AS endSeq, branch FROM chapters WHERE lower(branch) = lower($branch) ORDER BY idx DESC`).all({ $branch: entity.value }) as Array<Record<string, unknown>>;
      for (const row of rows) candidates.push(chapterCandidate(row, 1, entity.value, session, String(row.branch ?? entity.value)));
    } else {
      const row = db.query(`SELECT seq, end_seq AS endSeq, kind, chapter_idx AS chapterIdx, text, note FROM moments WHERE kind = 'rule' AND seq = $seq`).get({ $seq: Number(entity.value) }) as Record<string, unknown> | null;
      if (row) { const candidate = momentCandidate(row, 0, entity.value, session); if (candidate) candidates.push(candidate); }
    }
  }
  return candidates;
}

function seenPath(store: CarafeStore, receiverId: string): string {
  const safe = receiverId.replace(/[^A-Za-z0-9._-]/g, "_") || "cli";
  return join(store.root, "state", "reflex-seen", `${safe}.json`);
}

function loadSeen(store: CarafeStore, receiverId: string): Set<string> {
  try {
    const value = JSON.parse(readFileSync(seenPath(store, receiverId), "utf8")) as unknown;
    return new Set(Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []);
  } catch { return new Set(); }
}

function saveSeen(store: CarafeStore, receiverId: string, seen: Set<string>): void {
  const path = seenPath(store, receiverId);
  mkdirSync(dirname(path), { recursive: true });
  atomicWriteFileSync(path, JSON.stringify([...seen].sort()));
}

function pointerLabel(candidate: Candidate): string {
  if (candidate.kind === "deadend") return candidate.entity.includes(".") ? `dead end touching ${basename(candidate.entity)}` : "dead end";
  if (candidate.kind === "rule") return "standing rule";
  if (candidate.kind === "decision") return "decision";
  if (candidate.kind === "breakthrough") return "breakthrough";
  if (candidate.kind === "steering") return "steering";
  return candidate.entity.startsWith("feat/") || candidate.entity.startsWith("fix/") || candidate.entity.startsWith("chore/") ? `chapter on ${candidate.entity}` : "relevant chapter";
}

function renderLine(candidate: Candidate): string | null {
  const prefix = `- ${pointerLabel(candidate)}: "`;
  const suffix = `" → ${candidate.address}`;
  const cap = Math.min(90, 200 - prefix.length - suffix.length);
  if (cap < 8) return null;
  const quote = candidate.excerpt.length <= cap ? candidate.excerpt : `${candidate.excerpt.slice(0, cap - 1)}…`;
  return `${prefix}${quote}${suffix}`;
}

function singleSessionHeader(session: SessionDistillate, count: number): string {
  const title = (session.title ?? "untitled").replace(/\s+/g, " ").slice(0, 48);
  return `[carafe reflex · ${session.tool} ${session.sessionId.slice(0, 8)} "${title}"] ${count} pointer${count === 1 ? "" : "s"} — verbatim, seq-anchored; fetch only if useful:`;
}

function projectHeader(cwd: string | undefined, count: number, contributed: number): string {
  const folder = basename(cwd ?? "") || "project";
  return `[carafe reflex · ${contributed} sessions in ${folder}] ${count} pointer${count === 1 ? "" : "s"} — verbatim, seq-anchored; fetch only if useful:`;
}

export function reflex(input: ReflexInput): ReflexResult {
  const turnText = input.turnText.trim();
  if (isAck(turnText)) return { pointers: [], text: "", silentReason: "ack" };
  if (turnText.length < 8) return { pointers: [], text: "", silentReason: "turn-too-short" };
  if (isSystemText(turnText)) return { pointers: [], text: "", silentReason: "system-injected" };
  const sources = (input.sessions ?? (input.session ? [{ session: input.session, tailStartSeq: input.tailStartSeq }] : [])).slice(0, 12);
  if (!sources.length) return { pointers: [], text: "", silentReason: "no-sessions" };

  const queryStarted = performance.now();
  const opened: Array<{ source: (typeof sources)[number]; db: Database; chapterCount: number; lastChapter: number }> = [];
  const commandValues = new Set<string>();
  const ruleRows: EntityCatalog["rules"] = [];
  try {
    for (const source of sources) {
      if (performance.now() - queryStarted >= 400) break;
      const path = sessionIndexPath(input.store, source.session);
      if (!existsSync(path)) continue;
      let db: Database;
      try { db = new Database(path, { readonly: true }); } catch { continue; }
      try {
        const counts = db.query(`SELECT count(*) AS count, COALESCE(max(idx), -1) AS lastChapter FROM chapters`).get() as { count: number; lastChapter: number };
        const commands = db.query(`SELECT value FROM entities WHERE kind = 'command' ORDER BY length(value) DESC, value`).all() as Array<{ value: string }>;
        for (const row of commands) commandValues.add(row.value);
        const sessionKey = `${source.session.tool}\0${source.session.sessionId}`;
        const rules = db.query(`SELECT seq, text FROM moments WHERE kind = 'rule' ORDER BY seq`).all() as Array<{ seq: number; text: string }>;
        for (const rule of rules) ruleRows.push({ sessionKey, seq: rule.seq, text: rule.text });
        opened.push({ source, db, chapterCount: Number(counts.count), lastChapter: Number(counts.lastChapter) });
      } catch {
        db.close();
      }
    }
    if (!opened.length) return { pointers: [], text: "", silentReason: "index-missing" };
    const entities = extractEntities({ commands: [...commandValues].sort((a, b) => b.length - a.length || a.localeCompare(b)), rules: ruleRows }, turnText);
    if (!entities.length) return { pointers: [], text: "", silentReason: "no-entities" };

    const candidates: Candidate[] = [];
    const chapterCounts = new Map<string, number>();
    for (const item of opened) {
      chapterCounts.set(`${item.source.session.tool}\0${item.source.session.sessionId}`, item.chapterCount);
      candidates.push(...resolveEntities(item.db, entities, item.source.session));
    }
    if (!candidates.length) return { pointers: [], text: "", silentReason: "unresolved" };

    const sourceByKey = new Map(opened.map((item) => [`${item.source.session.tool}\0${item.source.session.sessionId}`, item]));
    const recencyKeys = opened.slice().sort((a, b) => (b.source.session.endTs ?? b.source.session.startTs ?? "").localeCompare(a.source.session.endTs ?? a.source.session.startTs ?? ""))
      .map((item) => `${item.source.session.tool}\0${item.source.session.sessionId}`);
    const recencyRank = new Map(recencyKeys.map((key, rank) => [key, rank]));
    const intent = intentBoost(turnText);
    const deduped = new Map<string, Candidate>();
    for (const candidate of candidates) {
      const item = sourceByKey.get(candidate.sessionKey)!;
      if (candidate.seq >= (item.source.tailStartSeq ?? Number.POSITIVE_INFINITY)) continue;
      if (item.source.excludeLastChapter && candidate.chapterIdx === item.lastChapter) continue;
      const key = `${candidate.sessionKey}:${candidate.kind}:${candidate.seq}`;
      const chapterCount = chapterCounts.get(candidate.sessionKey) ?? 0;
      const rank = recencyRank.get(candidate.sessionKey) ?? opened.length - 1;
      const sessionRecency = opened.length ? (opened.length - rank) / opened.length : 0;
      candidate.score = KIND_WEIGHT[candidate.kind] + candidate.specificity
        + (chapterCount ? candidate.chapterIdx / chapterCount : 0)
        + (intent[candidate.kind] ?? 0) + (item.source.bonus ?? 0) + sessionRecency;
      const prior = deduped.get(key);
      if (!prior || candidate.score > (prior.score ?? 0)) deduped.set(key, candidate);
    }
    const seen = loadSeen(input.store, input.receiverId);
    const entityKey = (candidate: Candidate): string => `entity:${candidate.entity.toLowerCase()}`;
    const suppressionEntityKey = (candidate: Candidate): string => `${candidate.sessionKey}:entity:${candidate.entity.toLowerCase()}`;
    const pointerKey = (candidate: Candidate): string => `${candidate.sessionKey}:${candidate.kind}:${candidate.seq}`;
    const ranked = [...deduped.values()]
      .filter((candidate) => !seen.has(pointerKey(candidate)) && !seen.has(suppressionEntityKey(candidate)))
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || b.seq - a.seq || a.sessionKey.localeCompare(b.sessionKey) || a.kind.localeCompare(b.kind));
    if (!ranked.length) return { pointers: [], text: "", silentReason: deduped.size ? "suppressed" : "inside-tail" };

    const k = Math.max(0, Math.min(20, input.k ?? 3));
    const budget = Math.max(0, input.budgetChars ?? 600);
    const selected: Pointer[] = [];
    const perEntity = new Map<string, Set<PointerKind>>();
    const renderHeader = (candidatesToRender: Array<Pointer | Candidate>): string => {
      const contributing = new Set(candidatesToRender.map((candidate) => candidate.sessionKey));
      if (contributing.size > 1) return projectHeader(input.cwd ?? sources[0]?.session.cwd ?? undefined, candidatesToRender.length, contributing.size);
      const only = candidatesToRender[0]?.sessionKey;
      const source = sources.find((item) => `${item.session.tool}\0${item.session.sessionId}` === only)?.session ?? sources[0]!.session;
      return singleSessionHeader(source, candidatesToRender.length);
    };
    const pick = (candidate: Candidate, allowSecond: boolean): boolean => {
      const kinds = perEntity.get(entityKey(candidate)) ?? new Set<PointerKind>();
      if (kinds.size >= (allowSecond ? 2 : 1) || kinds.has(candidate.kind)) return false;
      const line = renderLine(candidate);
      if (!line) return false;
      const prospectiveCandidates = [...selected, candidate];
      const prospective = `${renderHeader(prospectiveCandidates)}\n${[...selected.map((pointer) => pointer.line), line].join("\n")}`;
      if (prospective.length > budget) return false;
      kinds.add(candidate.kind); perEntity.set(entityKey(candidate), kinds);
      selected.push({ key: pointerKey(candidate), sessionId: candidate.sessionId, sessionKey: candidate.sessionKey, tool: candidate.tool, kind: candidate.kind, seq: candidate.seq, endSeq: candidate.endSeq, chapterIdx: candidate.chapterIdx, excerpt: candidate.excerpt, address: candidate.address, score: candidate.score ?? 0, entity: candidate.entity, line });
      return true;
    };
    for (const candidate of ranked) { if (selected.length >= k) break; pick(candidate, false); }
    for (const candidate of ranked) {
      if (selected.length >= k) break;
      if (!STRONG_KINDS.has(candidate.kind)) continue;
      if (!selected.some((pointer) => pointer.key === pointerKey(candidate))) pick(candidate, true);
    }
    if (!selected.length) return { pointers: [], text: "", silentReason: "budget" };
    for (const pointer of selected) {
      seen.add(pointer.key);
      // The entity cap spans sessions, so suppression must span every session
      // that resolved that entity too. Keys remain session-qualified to avoid
      // collisions between unrelated project memories.
      for (const candidate of deduped.values()) {
        if (candidate.entity.toLowerCase() === pointer.entity.toLowerCase()) seen.add(suppressionEntityKey(candidate));
      }
    }
    saveSeen(input.store, input.receiverId, seen);
    return { pointers: selected, text: `${renderHeader(selected)}\n${selected.map((pointer) => pointer.line).join("\n")}` };
  } finally {
    for (const item of opened) item.db.close();
  }
}
