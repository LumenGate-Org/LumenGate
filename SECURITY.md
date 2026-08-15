# Security Policy

This repository contains payment and settlement code. Please report suspected
security issues privately instead of opening a public issue.

## Reporting

Preferred: use GitHub's private vulnerability reporting for this repository
(**Security** tab → **Report a vulnerability**), which opens a private
advisory only the maintainers can see — no email round-trip, and the report
stays out of the public issue tracker from the start. If that's not
available to you, open a normal issue asking a maintainer to open a private
channel, without including exploit details in that request.

Include in the report:

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
