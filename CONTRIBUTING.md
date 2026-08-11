# Contributing

Thanks for improving the x402 Stellar facilitator stack.

## Development Setup

```bash
pnpm install
pnpm build
pnpm test
pnpm typecheck
```

For Soroban contract changes, also run the relevant contract tests:

```bash
cd contracts/upto-settlement-escrow
cargo test

cd ../upto-settlement
cargo test
```

## Pull Request Expectations

- Keep changes scoped to one behavior or documentation area.
- Add or update tests when changing settlement, billing, discovery, MCP, or SDK behavior.
- Update docs when changing public APIs, environment variables, wire formats, or operational behavior.
- Do not commit secrets, local databases, build outputs, generated contract targets, or office document artifacts.

## Repository Map

Use the root [README](./README.md) for the package map and the docs under
[`docs/`](./docs) for architecture, integration, and operations.
