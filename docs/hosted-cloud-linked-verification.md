# Hosted Cloud-Linked Verification

This is the manual release gate for the complete OSS Runner and single-node
Synapsor Cloud boundary. It is intentionally opt-in because it creates Cloud
records and mutates a synthetic source row.

The verifier installs packed or published Cloud CLI and Runner packages in a
clean temporary directory and proves:

- public protocol discovery;
- packed CLI human `whoami`, secure one-time service-key output, and immediate
  service-key revocation;
- canonical contract push parity between `synapsor contracts push` and
  `synapsor-runner cloud push` with one immutable version identity;
- source-scoped Runner token creation, rotation, registration idempotency, and
  heartbeat;
- credential-free Runner bundle download;
- scoped MCP read and cross-tenant denial;
- proposal creation without a source write and automatic durable-outbox
  delivery without a manual `cloud sync` command;
- authenticated Cloud approval and guarded local writeback through the packed
  Runner's public worker CLI;
- two registered Runner processes competing for one exclusive job lease;
- duplicate-claim idempotency, rejection, and stale-version conflict;
- linked Cloud activity integrity and canonical export;
- reviewed activation and rollback of a risk-increasing contract version; and
- immediate Runner-token revocation across doctor, registration, claim, and
  result submission.

It never accepts production data. Use a disposable project and a synthetic
Postgres or MySQL database that can be reset after the run.

## Prerequisites

Build the workspace and pack both packages before a pre-publish check:

```bash
corepack pnpm install
corepack pnpm build
corepack pnpm --filter @synapsor/runner pack --pack-destination /tmp
corepack pnpm --filter @synapsor/cli pack --pack-destination /tmp
```

Prepare:

- a disposable Cloud project and imported synthetic source;
- an authenticated human session token obtained through the normal browser/
  device login flow;
- separate least-privilege read and write source URLs;
- a canonical contract with one scoped read and one proposal capability; and
- three independent proposal fixture rows: apply, reject, and stale-conflict.

Read tokens and database URLs from a secret prompt or secret manager. Do not
put them in Git, shell history, command-line arguments, or the Runner bundle.

## Run

Set the non-secret fixture identifiers and JSON assertions for your synthetic
database. The exact required variables and their meanings are always available
without credentials:

```bash
corepack pnpm verify:hosted-cloud-linked -- --help
```

Then opt in explicitly and run:

```bash
export SYNAPSOR_HOSTED_E2E=1
export SYNAPSOR_E2E_DISPOSABLE_PROJECT=1
export SYNAPSOR_CLOUD_BASE_URL="https://dev-api.synapsor.ai"
export SYNAPSOR_RUNNER_PACKAGE_SPEC="/tmp/synapsor-runner-<version>.tgz"
export SYNAPSOR_CLI_PACKAGE_SPEC="/tmp/synapsor-cli-<version>.tgz"

corepack pnpm verify:hosted-cloud-linked
```

The command refuses to run unless both opt-in flags are present. HTTPS is
required unless `SYNAPSOR_E2E_ALLOW_HTTP=1` is explicitly set for a local
control-plane test. The generated Runner token is revoked in a `finally` block,
and the temporary directory is removed unless
`SYNAPSOR_E2E_KEEP_TEMP=1` is set for debugging.

## Passing Result

A pass prints only a boolean summary with all checks set to `true`. The
`token_rotated`, `registration_idempotent`, `two_runner_exclusive_claim`,
`registration_heartbeat`, `proposal_reviewed_metadata`,
`two_runner_exclusive_claim`, `receipt_replay_linked`, `activity_exported`,
`contract_governance`, and `revoked_operations_blocked` fields prove those
additional boundaries explicitly. It does not print bearer tokens, database
URLs, source rows, or kept-out values. Confirm the synthetic fixture is reset
after the run before reusing the project.

This gate is evidence for the existing single-node design-partner boundary. It
does not establish multi-region availability, managed Runner hosting, SSO/SCIM,
legal hold, formal compliance certification, or an enterprise SLA.
