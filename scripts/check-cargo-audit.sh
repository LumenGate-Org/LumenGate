#!/usr/bin/env bash
# Dependency-vulnerability scan for the Rust side, mirroring
# scripts/check-cargo-licenses.sh's per-crate loop: each Soroban contract is
# its own crate with its own Cargo.lock, so each is audited independently —
# same reasoning as .github/dependabot.yml treating them as three separate
# ecosystems. Part of the audit-tooling pass documented in
# docs/architecture.md ("Scope boundaries"): find and fix what a linter/
# scanner catches for free, before a paid third-party review.
set -euo pipefail

CONTRACTS=("contracts/upto-settlement-escrow" "contracts/upto-settlement" "contracts/custom-account-demo")
FAILED=0

for dir in "${CONTRACTS[@]}"; do
  echo "cargo-audit: scanning $dir"
  if ! (cd "$dir" && cargo audit); then
    echo "cargo-audit: FAILED in $dir"
    FAILED=1
  fi
done

if [ "$FAILED" -ne 0 ]; then
  echo ""
  echo "cargo-audit found a real, unresolved RUSTSEC advisory (not just an"
  echo "'unmaintained' warning, which cargo-audit already treats as non-fatal"
  echo "on its own). Resolve it before merging."
  exit 1
fi

echo "cargo-audit: no unresolved advisories across all contracts."
