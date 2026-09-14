#!/usr/bin/env bash
set -euo pipefail
: "${SYNAPSOR_TEST_POSTGRES_URL:?Provide the explicitly owned local PostgreSQL control-store test URL}"
export NO_COLOR=1
node node_modules/vitest/vitest.mjs run \
  apps/runner/src/semantic-admission-publication.test.ts \
  packages/proposal-store/src/automatic-approval-admission.test.ts \
  packages/proposal-store/src/control-policy-postgres.test.ts \
  --maxWorkers=1 --minWorkers=1 --testTimeout=30000 --hookTimeout=20000

# Management recovery must use its explicit control-store environment even when
# Read authority is unavailable. These four cases are required, not an opt-in skip.
node node_modules/vitest/vitest.mjs run \
  apps/runner/src/control-policy-authority-codec.test.ts \
  --testNamePattern 'postgres validated operator policy transactions.*keeps Action recovery review available with unavailable Read authority:' \
  --maxWorkers=1 --minWorkers=1 --testTimeout=30000 --hookTimeout=20000
