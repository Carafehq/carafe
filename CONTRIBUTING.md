# Contributing

Thanks for looking. Carafe is small and opinionated; the rules below keep it that way.

## Setup

```sh
bun install
bun test                 # all green expected
bunx tsc --noEmit        # strict typecheck
bun run src/cli/index.ts # CLI help
```

Tests never touch the real store: point `CARAFE_HOME`, `CARAFE_CC_ROOT` and
`CARAFE_CODEX_ROOT` at temporary folders, and keep every fixture inside one temporary
workspace folder per test.

## Rules that are not up for debate

- **Local-first.** Never transmit session data. Release metadata checks and downloads carry no session
  content; project health checks require explicit per-project consent.
- **Read-only on sources.** `~/.claude/projects` and `~/.codex/sessions` are never written.
- **Never destroy user data.** Preserve undo stashes and append-only checkpoints.
- **Honest numbers and honest text.** Anything carafe prints as a fact must be verifiable;
  the handoff gate (`carafe bench handoff --real`) fails the build on a false statement.
- **Deterministic.** No LLM calls in the open code paths.


## Pull requests

- One change per PR, with tests. The Linux test workflow must pass.
- Say in the description what you verified and how. Do not claim a check passed unless you
  ran it.
- By contributing you agree your work is licensed under Apache-2.0 (see LICENSE).
