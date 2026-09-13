#!/usr/bin/env bash
set -euo pipefail
: "${SYNAPSOR_TEST_POSTGRES_URL:?Provide the explicitly owned local PostgreSQL control-store test URL}"
export NO_COLOR=1
node node_modules/vitest/vitest.mjs run \
  apps/runner/src/semantic-admission-publication.test.ts \
  packages/proposal-store/src/automatic-approval-admission.test.ts \
  packages/proposal-store/src/control-policy-postgres.test.ts \
  --maxWorkers=1 --minWorkers=1 --testTimeout=30000 --hookTimeout=20000
