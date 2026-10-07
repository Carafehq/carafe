# Contributor guide

- Local-first: keep capture, indexing, search, and replay on the user's machine.
- Never transmit session data. Release downloads and metadata checks carry no session content; project health checks require explicit per-project consent.
- Fail closed at egress: redact secrets and refuse output when validation fails.
- Never destroy user data. Preserve undo stashes and append-only checkpoints; skip conflicting imports.
- Be honest about numbers and claims. Facts must be verifiable; never invent benchmark results.
- Read source session folders without modifying them. Optional hook installation must be explicit and preserve existing configuration.
- Keep tests hermetic: use temporary CARAFE_HOME, CARAFE_CC_ROOT, and CARAFE_CODEX_ROOT directories, never real session stores.

Development commands:

```sh
bun install --frozen-lockfile
bun run typecheck
bun run test
bun run src/cli/index.ts --help
bun run build
```

Run typecheck and the full test suite before proposing a change. Public releases
are built from main; release versions use vX.Y.Z tags. See CONTRIBUTING.md.
