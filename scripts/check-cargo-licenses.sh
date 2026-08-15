#!/usr/bin/env bash
# Enforces the same RFP-literal license requirement as scripts/check-licenses.mjs,
# for the Rust side: each Soroban contract is its own crate with its own
# dependency tree, so each is checked independently — mirrors how
# .github/dependabot.yml already treats them as three separate ecosystems.
set -euo pipefail

COPYLEFT_PATTERN='(^|[^L])(A?GPL|SSPL|BUSL)|Commons Clause|Elastic License'
CONTRACTS=("contracts/upto-settlement-escrow" "contracts/upto-settlement" "contracts/custom-account-demo")
FAILED=0

for dir in "${CONTRACTS[@]}"; do
  echo "license-check (cargo): scanning $dir"
  licenses=$(cd "$dir" && cargo license 2>/dev/null | sed -n 's/^\(.*\): .*/\1/p')
  if echo "$licenses" | grep -qiE "$COPYLEFT_PATTERN"; then
    echo "license-check (cargo): FAILED in $dir — strong-copyleft license(s) found:"
    echo "$licenses" | grep -iE "$COPYLEFT_PATTERN"
    FAILED=1
  fi
done

if [ "$FAILED" -ne 0 ]; then
  echo ""
  echo "The SCF Build Award RFP requires a permissive OSI-approved license with no AGPL"
  echo "or other strong copyleft anywhere in the dependency tree."
  exit 1
fi

echo "license-check (cargo): no strong-copyleft licenses found across all contracts."
