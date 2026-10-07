# Security

Carafe reads every Claude Code and Codex session on the machine it runs on. That is the
whole point, and it is why the product rules are strict: carafe never uploads session data, it is
read-only on the source folders, and anything secret-shaped is masked before it can leave
the local store.

If you find a way to break one of those rules — data leaving the machine, a source file
being written, a secret surviving the egress gate — please report it privately rather than
in a public issue.

**Report to:** open a private security advisory on this repository
(Security → Advisories → Report a vulnerability). You will get a reply within seven days.

Please include the carafe version (`carafe --version`), the platform, and the smallest
reproduction you can. Do not include real session content.

Release metadata checks and downloads contact GitHub without session content.
Disable automatic checks with `CARAFE_NO_UPDATE_CHECK=1`. Explicit project health
checks require consent. Context given to a launched agent follows that agent's privacy settings.
