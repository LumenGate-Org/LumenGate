# Contributing

Thanks for improving the x402 Stellar facilitator stack.

## Development Setup

```bash
pnpm install
pnpm build
pnpm test
pnpm typecheck
```

For Soroban contract changes, also run the relevant contract's tests and
lint — CI runs both as required checks (`.github/workflows/ci.yml`'s
`contracts` job), so a PR that only passes `cargo test` will still fail CI
on a clippy warning:

```bash
cd contracts/upto-settlement-escrow # or upto-settlement, or custom-account-demo
cargo test
cargo clippy --all-targets -- -D warnings
```

CI additionally runs `cargo audit` (dependency-vulnerability scan) and a
Soroban-specific static analyzer (Scout) against every contract on every
push and pull request — see "Scope boundaries" in
[`docs/architecture.md`](./docs/architecture.md) for why, and what these
have already found and fixed.

## Pull Request Expectations

- Keep changes scoped to one behavior or documentation area.
- Add or update tests when changing settlement, billing, discovery, MCP, or SDK behavior.
- Update docs when changing public APIs, environment variables, wire formats, or operational behavior.
- Do not commit secrets, local databases, build outputs, generated contract targets, or office document artifacts.

## Maintainers and Review

This project handles real fund movement (settlement contracts, billing,
resource-ownership verification), so review authority is split deliberately
rather than open by default everywhere:

- **Security-sensitive paths** — `contracts/`, `packages/stellar-upto/`,
  `packages/facilitator/src/billing.ts`,
  `packages/facilitator/src/resource-ownership.ts`, `specs/` — require
  review from a core maintainer, enforced by [`.github/CODEOWNERS`](.github/CODEOWNERS).
  The intent is a small, named, accountable maintainer team (more than one
  person, to avoid a single point of failure) rather than open merge access
  to code that moves funds or verifies what gets cataloged.
- **Everything else** — discovery, MCP tooling, SDK helpers, examples,
  docs — is open to community contribution through ordinary issues and pull
  requests, reviewed against the same CI bar (tests, typecheck, lint) as
  core-team changes, with no separate approval tier.

This is intentionally a hybrid, not a fully open community-governance model:
a reviewer suggestion to run maintenance purely by community consensus was
considered and set aside specifically for the security-sensitive paths above
— diffusing review authority on fund-moving code trades away exactly the
accountability that code needs. Community involvement is still real, just
scoped to where an unreviewed merge can't move or misdirect funds.
`.github/CODEOWNERS` currently names a placeholder org handle rather than
individual maintainers — see the comment in that file — since this is a
described target, not a claim that a multi-person team is staffed and
enforcing it today. See "Maintenance and support plan" in
[`docs/runbook.md`](./docs/runbook.md) for the fuller operational picture
(upstream contribution path, spec-drift tracking, handoff plan).

## Repository Map

Use the root [README](./README.md) for the package map and the docs under
[`docs/`](./docs) for architecture, integration, and operations.
