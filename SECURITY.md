# Security Policy

This repository contains payment and settlement code. Please report suspected
security issues privately instead of opening a public issue.

## Reporting

Send a concise report to the project maintainer with:

- Affected package, contract, endpoint, or script
- Impact and exploitation conditions
- Reproduction steps or proof of concept, if available
- Suggested fix, if known

Please avoid sharing live private keys, seed phrases, production credentials,
or sensitive transaction data in reports.

## Scope

In scope:

- Soroban settlement contracts
- Facilitator `/verify` and `/settle` behavior
- Discovery catalog integrity
- MCP payment guardrails
- SDK signing, allowance, cancellation, and settlement helpers

Out of scope:

- Issues that require leaked private keys or compromised operator machines
- Denial-of-service findings without a concrete amplification or cost impact
- Third-party service outages outside this repository's control
