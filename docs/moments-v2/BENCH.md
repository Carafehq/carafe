# MomentsBench

MomentsBench measures the current open-tier key-moments extractor before the Moments v2 redesign. It is deterministic, local-only, and uses the same tool-agnostic session plan to render both Claude Code and Codex traces.

## Corpus and planted units

Each generated session contains ordinary developer work across authentication, billing, search, queues, migrations, API clients, notifications, exports, rate limiting, webhooks, internationalization, and caching. The generator uses a seeded PRNG and realistic user turns, short assistant turns, reads, searches, edits, writes, tests, failures, commits, a pull request, and idle gaps. Filler episodes add a seeded neutral user turn plus an assistant line every 4–9 episodes; neutral prompts are ordinary inspection requests, not acknowledgements, rules, choices, or refusals. The gate is five plans—S seeds 11 and 12, M seeds 21 and 22, and L seed 31—rendered by both tools, for ten sessions. The full tier adds S seeds 13–15, M seeds 23–24, and L seed 32.

Every early, middle, and late third independently plants one popup decision, freetext decision, approval decision, steering redirect, abandoned dead end, breakthrough, rule restatement, and commit, plus the complete distractor set. Middle and late also contain a reversal; early and middle contain the writes for the no-trace dead end, whose removal is late; the pull request is late. Placement within each third is seeded. The final eight tool beats are WIP and contain no explore burst, while the goal remains beat 0.

Gold units are planted because each represents information a receiving agent may need but cannot safely infer from a short tail:

- goal, decisions, and steering capture intent and trajectory changes;
- reversal, abandoned, and no-trace dead ends capture work that must not be retried;
- breakthroughs capture a failure-to-success transition;
- rules capture repeated normative instructions;
- commits and pull requests capture durable artifacts;
- WIP captures the last eight tool actions.

Planted families have multiple seeded variants: ten ordinary choice pairs, five decision cue phrasings, five approval proposals and approvals, several popup option sets and answer renderings, five steering grammars, five normative rule cues, and multiple breakthrough and distractor phrasings. The text contains no gold markers, IDs, or special scoring tokens. `anchor` is an ordinary verbatim substring (at most 60 characters, in the first 150 characters of its beat) used only after a strict hit to test fidelity; it is never used to locate a hit.

## Distractors and hazards

The corpus includes fast fixes, stash housekeeping, quoted historical errors, rejected proposals, cancelled popups, acknowledgements, exploratory read bursts, and system-injected records. Some are hazards: a moment that lands on them can mislead a receiving agent. Quoted errors and cancelled questions are especially important because their surface form resembles a real failure or decision. In Codex, system injection is rendered as a `response_item` message with developer role and `input_text` environment content, which the adapter maps to assistant; a cancelled popup contains only the agent question and no synthetic user answer.

Tool output is deliberately multi-line. Reads emit 20–80 lines from deterministic extension-specific snippets whose first line is the path. Passing test runs list files and totals and end with `Process exited with code 0`; failures use seeded error banks with stack or diff context. Git commands emit status, stash, commit, reset, or PR-shaped output. The resulting extracted piece-character bands are S 60K–400K, M 0.8M–4M, and L 5M–12M.

## Scoring

Gold windows are derived from the sequence numbers emitted by the real adapters, not guessed from beat counts. A moment lands in `[seq, endSeq]` when its own `seq` is inside that inclusive window. Rules are the one exception: a repeated standing rule is deliberately represented as one moment spanning its first through last restatement, so each planted rule unit receives strict credit when that moment's span overlaps the unit window. Strict recall requires the mapped moment kind; any recall accepts any moment in the window. Rendered recall parses sequence anchors from the 20,000-character budgeted section and therefore measures post-budget survival. Strict hits are then checked for the gold anchor after harmless whitespace and renderer prefixes are removed.

Junk counts moments in any distractor window. Hazard violations are the subset in hazard windows. Unplanted moments land in neither. Rates are displayed for interpretation; the gate compares absolute counts so a rate cannot hide a changed denominator. Runtime is reported but never gated.

## Gate and commands

The committed `baseline.json` is keyed by extractor id (`v1` = the pre-redesign extractor, kept frozen as the reference; `v2` = the chapter-aware selection, the default) and contains only the gated counts for each tool: strict, any, rendered, middle-third strict, junk, hazard, and verbatim. The gate test checks every registered extractor against its own baseline. `gold/gate.hash` seals the rendered gate corpus. Any score change—including an improvement—fails the test until the baseline is deliberately moved (`--update-baseline` rewrites the entry for the extractor it ran). The scorecard also reports, ungated, `chapters/session`, `chapter coverage` (chapters with at least one rendered moment) and `rendered by third` (how many rendered moments fall in each third of the session) — the structural numbers the chapter work targets. Turn parity is exact: each renderer must produce the plan's ordinary user beats plus answered popup responses; system injection and cancelled popups do not add a user turn.

```sh
bun run src/cli/index.ts bench moments
bun run src/cli/index.ts bench moments --json
bun run src/cli/index.ts bench moments --tier full --out /tmp/momentsbench.md
bun run src/cli/index.ts bench moments --materialize /tmp/momentsbench
```

Updating the baseline is an explicit operation and is intended only after reviewing the corpus and score diff:

```sh
bun run src/cli/index.ts bench moments --update-baseline
```

Materialized files are native traces under `claude/projects` and `codex/sessions`. They can be imported hermetically by setting `CARAFE_HOME`, `CARAFE_CC_ROOT`, and `CARAFE_CODEX_ROOT` to temporary directories.

## Extending the bench

To add a unit kind, add its type and a planted episode in `plan.ts`, render it in both native renderers, add its acceptable strict mapping in `score.ts`, and add a per-kind assertion. Keep the anchor in the first 150 characters of its carrying beat. To add an extractor, implement `MomentsExtractor` in `extractors.ts`, register it by a stable ID, and run the same corpus through `runBench`.

Honesty rules are part of the test surface: no markers or gold IDs in prose, no LLM or network calls, no wall-clock or random corpus content, no open-tier extractor importing `src/bench`, and no construction of a `CarafeStore` against the user's home. The corpus is sealed by the hash and the answer key is consumed only by the scorer and tests.
