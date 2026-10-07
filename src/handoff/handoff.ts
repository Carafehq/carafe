/**
 * carafe handoff — write a portable Markdown brief from a captured session.
 * The optional recipient label affects console output only.
 */
import { writtenAtOf } from "./since";
import type { PeerTrace } from "./session-collisions";
import { mkdirSync, writeFileSync } from "fs";
import { join, resolve } from "path";
import { CarafeStore } from "../format/store";
import { readSession } from "../format/sessions";
import { activityTs, listSessions, currentSession, findSession, helperSessionsOf, latestSession, siblingSessions, workspaceKey, type SiblingSession } from "../query/sessions";
import { buildSessionIndex } from "../search/session-index";
import { armReflex } from "../reflex/state";
import { extractPieces, filesOf } from "./pieces";
import { checkLive, type HealthFetcher } from "./live";
import { resolveHealthConsent, type PromptWriter, type TtyReader } from "./consent";
import { findAnswerFiles, questionsText, readAnswerFile, type AnswerFile } from "./answers";
import { healthUrlsFromTrace, stateFromTrace } from "./state";
import { preparedPieces } from "./render";
import { noAnswersWarning, renderHandoff, reposWorkedIn, tokenEstimate, type HelperTrace } from "./render";

export interface HandoffOpts {
  store?: CarafeStore;
  /** Optional console label; never passed to the renderer. */
  to?: string;
  thinking?: boolean;
  noArm?: boolean;
  live?: boolean;
  noLive?: boolean;
  answers?: string;
  questions?: boolean;
  /** Test seams, and an explicit non-interactive boundary for the web app. */
  interactive?: boolean;
  ttyReader?: TtyReader;
  promptWriter?: PromptWriter;
  fetcher?: HealthFetcher;
  now?: string;
}

export async function runHandoff(sessionArg: string, opts: HandoffOpts = {}): Promise<void> {
  const store = opts.store ?? new CarafeStore();

  const d = sessionArg === "latest"
    ? latestSession(store)
    : sessionArg === "current"
      ? currentSession(store)
      : findSession(store, sessionArg);
  if (!d) { console.error(`no session found for "${sessionArg}". try: carafe list`); process.exit(1); }
  if (opts.questions) { console.log(`Resolved session: ${d.sessionId} — ${d.title ?? "(untitled)"}`); console.log(questionsText(store.root, d.sessionId)); return; }

  const events = readSession(store, d.tool, d.sessionId);
  buildSessionIndex(store, d, events);
  const workedIn = reposWorkedIn(events, extractPieces(events, {}, {}), d.cwd).slice(0, 4).map((repo) => repo.path);
  const siblings = withTopFiles(store, siblingSessions(store, d, undefined, workedIn));
  // The helpers that ran inside this session hold the tool calls for the work it
  // delegated — and therefore, often, the newest state of the repositories.
  const helperTraces: HelperTrace[] = [];
  for (const helper of helperSessionsOf(store, d, undefined, workedIn)) {
    // one unreadable helper must never cost the handoff its other observations
    try { helperTraces.push({ sessionId: helper.sessionId, events: readSession(store, helper.tool, helper.sessionId), cwd: helper.cwd }); } catch { /* skip */ }
  }
  // Redaction is always on inside the renderer (silent same-machine; the review
  // gate is the cross-person path). Tier decided by size: full trace when it
  // fits, orientation-layer + retrieval keys when it doesn't.

  // W1 — the state, CHECKED now. The renderer never runs a command itself: the
  // readings are taken here, once, and handed in. Without `--live` nothing in
  // this call can reach the network.
  const pieces = preparedPieces(events, d.sessionId);
  const healthUrls = healthUrlsFromTrace(events, pieces);
  const explicitLive = opts.live === true && opts.noLive !== true;
  const interactive = opts.interactive ?? (process.stdin.isTTY === true && process.stdout.isTTY === true);
  const healthConsent = await resolveHealthConsent({
    root: store.root,
    workspace: workspaceKey(d.cwd),
    urls: healthUrls,
    interactive: interactive && opts.noLive !== true,
    noLive: opts.noLive,
    liveOverride: explicitLive,
    reader: opts.ttyReader,
    write: opts.promptWriter,
    now: opts.now,
  });
  const repoPaths = [...new Set([d.cwd, ...reposWorkedIn(events, pieces, d.cwd).map((r) => r.path), ...helperTraces.flatMap((h) => reposWorkedIn(h.events, preparedPieces(h.events, h.sessionId), h.cwd).map((r) => r.path))].filter((p): p is string => !!p))];
  // the branches the trace itself named: they sort above the ones it never did
  // in Right now's `unpushed:` line, and W2 checks answer sentences against them
  const traceBranches = new Set<string>();
  for (const state of stateFromTrace(events, pieces, { cwd: d.cwd })) {
    for (const name of [state.branch?.value, state.pushed?.value, state.rejected?.value]) if (name && name !== "?") traceBranches.add(name);
  }
  const live = await checkLive(repoPaths, {
    live: explicitLive,
    healthUrls,
    healthConsent,
    knownBranches: traceBranches,
    fetcher: opts.fetcher,
    now: opts.now,
  });

  // W2 — the outgoing agent's own answers, if it wrote any
  const answerPaths = opts.answers ? [opts.answers] : findAnswerFiles(store.root, d.sessionId);
  const answers = answerPaths.map((path) => readAnswerFile(path)).filter((file): file is AnswerFile => file != null);
  const lastMessage = preparedPieces(events, d.sessionId).filter((p) => p.lines.some((l) => /^\*\*(?:user|assistant):\*\*/.test(l))).at(-1)?.ts ?? d.endTs;
  if (sessionArg === "current" && !answers.some((a) => Date.parse(a.writtenAt ?? "") > Date.parse(lastMessage ?? ""))) console.log(questionsText(store.root, d.sessionId));
  // v6/V8 — the handoff is still written: a session whose agent is gone must
  // still hand off. The person running the command is told what is missing.
  if (!answers.length) console.error(noAnswersWarning(d.sessionId).replace(/^>\s*/, "").replace(/\*\*/g, ""));

  const peerTraces: PeerTrace[] = [];
  const answeredAt = writtenAtOf(answers);
  if (answeredAt != null) for (const peer of listSessions(store)) {
    if (peer.sessionId === d.sessionId || !(Date.parse(activityTs(peer) ?? "") > answeredAt)) continue;
    try { peerTraces.push({ sessionId: peer.sessionId, title: peer.title, tool: peer.tool, cwd: peer.cwd, events: readSession(store, peer.tool, peer.sessionId) }); } catch { /* unreadable peer */ }
  }
  const { text, tier, lines, redactionHits, tailStartSeq } = renderHandoff(d, events, {
    includeThinking: opts.thinking, now: opts.now, siblings, helperTraces, peerTraces,
    live, answers, answerFacts: { traceBranches, traceUrls: new Set(healthUrls) },
  });
  if (!opts.noArm) armReflex(store, d, { armedAtSeq: events.at(-1)?.seq ?? 0, tailStartSeq });

  const dir = join(store.root, "handoffs");
  mkdirSync(dir, { recursive: true });
  const outPath = resolve(dir, `${d.sessionId}.md`);
  writeFileSync(outPath, text);

  const totalRedactions = Object.values(redactionHits).reduce((a, b) => a + b, 0);
  const label = opts.to ?? "any agent";

  console.log(`
handoff ready → ${label}
  from: ${d.tool} session "${d.title ?? d.sessionId}"
  tier: ${tier === "full" ? "full pure trace" : "LAYERED (orientation + directory + tail; optional full trace retrieval if carafe is installed)"}
  ${lines} trace lines${totalRedactions ? ` · ${totalRedactions} secret(s) redacted (${Object.keys(redactionHits).join(", ")})` : ""}
  file: ${outPath} (${(Buffer.byteLength(text) / 1024).toFixed(0)}KB ${tokenEstimate(text.length)})
`);

  console.log(`Read ${outPath} and continue the work\n`);
}

/** The files each sibling session touched most. Read from the trace, capped at
 *  three per session — enough to recognise what that session was about. */
function withTopFiles(store: CarafeStore, siblings: SiblingSession[]): SiblingSession[] {
  return siblings.map((sibling) => {
    try {
      const counts = new Map<string, number>();
      for (const event of readSession(store, sibling.tool, sibling.sessionId)) {
        for (const file of filesOf(event)) counts.set(file, (counts.get(file) ?? 0) + 1);
      }
      const topFiles = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 3).map(([file]) => file);
      return { ...sibling, topFiles };
    } catch {
      return sibling; // an unreadable sibling still deserves its line
    }
  });
}
