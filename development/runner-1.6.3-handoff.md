# Runner 1.6.3 Owner Handoff

Prepared: 2026-07-24

Implementation branch: `feature/runner-1.6.3-guided-adoption`

Initial merge: PR #42 into `main` (`b128725`)

Baseline: `6a6f49f` (`main`, published Runner 1.6.2)

Prepared package graph:

```text
@synapsor/spec    1.6.0
@synapsor/dsl     1.6.0
@synapsor/runner  1.6.3
```

The implementation and its pre-publish test-hygiene follow-up were pushed and
merged through protected GitHub pull requests. Nothing was published, tagged,
released, deployed, or changed in Synapsor Cloud or AWS.

## Executive Summary

Runner 1.6.3 turns the previously disconnected first-use primitives into one
resumable product journey:

```text
Connect
-> inspect metadata
-> review the disabled boundary by exception
-> activate one exact digest
-> run one real bounded read
-> Explore
-> Protect
-> draft one safe action
-> create a proposal
-> approve outside MCP
-> apply manually or through separately trusted supervised execution
-> inspect receipt/replay and human-attention state
```

The core boundary is unchanged:

- no raw SQL or SQL-string argument;
- no model-controlled tenant or principal;
- no model activation, approval, apply, worker, notification, or credential
  authority;
- deterministic generation and disabled drafts;
- digest-bound human activation;
- canonical public contracts;
- local-first OSS operation.

The release also completes two operator-side gaps:

1. An exact-digest, dual-opt-in supervised worker can automatically consume
   eligible approved single-row INSERT/UPDATE work while reusing the same
   guarded apply implementation as manual execution.
2. Durable, redacted attention events feed a quiet Workbench inbox and an
   optional separately operated JSONL/signed-webhook dispatcher. Notifications
   inform; they never authorize.

## Before And After

The observed 1.6.2 FitFlow lab reported roughly 13 disconnected steps:

```text
start --from-env
-> Workbench review
-> activate
-> hand-author DSL
-> dsl compile
-> hand-author config
-> config validate
-> doctor
-> generate migration/grants
-> run psql
-> smoke
-> approve
-> apply
```

Its exact click count was not instrumented, so this handoff does not invent one.

The packed 1.6.3 FitFlow journey requires:

- one shell invocation through the first proposal;
- 11 primary Workbench actions;
- four distinct human-authority decisions;
- zero manual file edits;
- zero external documentation searches;
- no Cursor requirement.

The first public command is:

```bash
npx -y @synapsor/runner@latest start --from-env DATABASE_URL
```

Rerunning it resumes or offers Try/Rescan/Start-over. Resume and Try do not
rescan, rewrite files, or change authority.

## Measured Packed Journey

The measured clock excludes initial npm download and disposable database
startup:

| Milestone | Measured |
| --- | ---: |
| Schema summary | 3,271 ms |
| Boundary activation | 3,485 ms |
| First real safe read | 5,743 ms |
| PM-style aggregate | 8,357 ms |
| Protected named capability | 9,709 ms |
| First immutable guided proposal | 20,530 ms |
| Complete identity/write/worker/notification matrix | 147,961 ms |

Fixture:

- 39 reviewable PostgreSQL resources;
- organization analytics and assigned-trainer personas;
- independent RLS-backed organization/principal scope;
- planted payment, address, and medical-note fields;
- separate read, writer, setup, and analytics roles.

Structured evidence:

```text
development/runner-1.6.3-fitflow-results.json
```

## Explore And Protect

The packed path proved:

- no SQL or plan JSON was composed;
- Workbench, CLI Try, and generic stdio returned the same reviewed aggregate;
- a kept-out dimension, model-selected tenant, unreviewed/fan-out relationship,
  small cohort, excessive groups/measures, and exhausted differencing budget
  fail closed;
- one successful result becomes a disabled public-DSL/canonical named
  capability;
- activation requires the exact digest;
- the protected capability survives Explore shutdown;
- production `tools/list` contains no broad Explore tool.

The primary path is:

```text
Ask bounded question
-> see result and suppression metadata
-> Protect this analysis
-> review literals/arguments/tests
-> activate exact digest
```

No copied query, proposal, evidence, receipt, or replay handle is required for
the ordinary Workbench/CLI journey.

## Approval Role And OIDC Evidence

The packaged guide and local RS256/JWKS issuer prove:

```text
APPROVAL ROLE
-> external IdP role claim
-> signature/algorithm/key/issuer/audience/time verification
-> exact subject and role
-> proposal action/id/version/hash binding
-> token-free attested decision in the ledger
```

Accepted:

- exact `membership_reviewer` approval role;
- overlapping key rotation;
- independent `writeback_operator` apply role.

Rejected without source mutation:

- missing or similar role;
- bad signature or unknown key;
- expired or not-yet-valid token;
- wrong issuer or audience;
- unsafe subject;
- malformed roles;
- missing expiry;
- short attestation material;
- unavailable JWKS;
- tampered stored proof;
- proof copied to another proposal;
- reviewer token reused for apply.

The bearer tokens were absent from generated project text and SQLite bytes.

## Supervised Worker Evidence

All four combinations are verified:

| Approval | Execution | Verified |
| --- | --- | --- |
| Human | Manual | yes |
| Human | Supervised worker | yes |
| Policy auto-approval | Manual | yes |
| Policy auto-approval | Supervised worker | yes |

Automatic execution is default-off and requires:

- public contract permission;
- independent deployment enablement;
- exact active capability digest;
- eligible direct single-row operation;
- fresh policy, TTL, scope, target, supporting evidence, generation lock,
  writer posture, receipt authority, and fenced lease.

The worker proof covers:

- contract-only and deployment-only denial;
- exact-digest enable/disable/revoke;
- pause, resume, drain, cancel, dead-letter, and reconciliation controls;
- two competing worker processes producing one effect and one receipt;
- process death before write, during transaction, and after known commit;
- bounded transient retry;
- UNKNOWN outcomes entering reconciliation without blind retry;
- concurrent count/value policy reservations;
- changed policy/digest/role posture stopping queued work;
- source and supporting-evidence drift failing closed;
- old `AUTO APPROVE` contracts remaining manual-apply.

The model-facing result honestly says an eligible reviewed request may be
applied later by a separate trusted worker. It does not claim that such a model
request can never lead to a production effect.

## Human Attention And Notification Evidence

Authoritative state and attention event creation share the store transaction.
Delivery is separate:

```text
ledger transition
-> immutable redacted event
-> coalesced attention item
-> separately operated dispatcher
-> JSONL or signed HTTPS webhook
-> authenticated Workbench resolution
```

Quiet defaults are verified:

- no sink means no external traffic;
- normal create/approve/queue/retry/apply success stays in ledger/Workbench;
- the packed successful workload emitted zero immediate success messages;
- two useful review interruptions were delivered once by two competing
  dispatchers;
- repeated related incidents update one attention item;
- transient retry stays internal until an escalation threshold;
- queue/worker warnings respect age, depth, and sustained-health grace;
- budgets, cooldowns, quiet hours, grouping, and digest routing bound noise;
- critical UNKNOWN/reconciliation bypasses ordinary quiet policy but still
  deduplicates.

Security and recovery proof:

- stable CloudEvents-compatible event IDs;
- HMAC-SHA-256 over timestamp, event ID, and exact raw body;
- replay-window and tamper checks;
- redirect, loopback, link-local, metadata, private/rebinding destination
  refusal unless explicitly allowlisted;
- `169.254.169.254` refused before transport and dead-lettered;
- no credentials, SQL, source rows, kept-out fields, trusted scope values, or
  bearer tokens in payloads;
- webhook response content cannot mutate Runner;
- acknowledgement does not approve;
- dead-letter replay requires a verified signed-key/OIDC decision over the
  exact delivery revision and a reason;
- replay requeues only the notification, writes `notification.replayed`, and
  leaves the source snapshot unchanged;
- optional required-sink health holds new automatic work without becoming
  approval authority.

## Compatibility

The release is additive:

- published Runner 1.5.4 / DSL 1.4.4 / Spec 1.4.2 fixtures pass;
- published Runner 1.6.0 / DSL 1.5.0 / Spec 1.5.0 fixtures pass;
- absent new fields preserve legacy normalization and exact digests;
- existing hand-authored DSL/JSON/configs and active contracts need no
  Workbench, generation lock, metadata scan, or migration;
- legacy CLI selectors, `--answers`, `--table`, `onboard db`, headless/CI and
  machine-readable routes remain;
- existing `tools/list` does not change without explicit adoption;
- no worker or dispatcher starts on upgrade;
- missing notification config needs no network;
- generated-lock drift enforcement remains limited to generated authority.

## Verification

Passed:

- `corepack pnpm test`: 55 files, 843 tests;
- `corepack pnpm test:guided-onboarding:packed`;
- `corepack pnpm test:auto-boundary-visual`: 14 desktop/mobile/state captures;
- `corepack pnpm test:auto-boundary-explore:packed`;
- `corepack pnpm test:packed-backward-compatibility`;
- `corepack pnpm test:published-compatibility`;
- `corepack pnpm test:fleet`;
- `corepack pnpm test:guarded-crud`;
- `corepack pnpm test:bounded-set`;
- `corepack pnpm test:reversible`;
- `corepack pnpm test:proposal-freshness`;
- `corepack pnpm test:database-scope`;
- `corepack pnpm test:principal-scope`;
- `corepack pnpm test:mcp-client-configs`;
- `./scripts/verify-release-gate.sh 1.6.3`: uninterrupted pass;
- independent Spec, DSL, and Runner `pnpm publish --dry-run`;
- `git diff --check`.

The release gate includes:

- 428 selected release tests;
- current Claude Code and Codex CLI config acceptance;
- generic stdio tools/list;
- Docker Postgres/MySQL first-run safety proof;
- public checkout commands;
- local and clean packed Runner checks;
- packed own-database Postgres proposal/apply;
- license/content and public-doc checks;
- Runner publish dry-run.

Package dry-run facts:

| Package | Compressed | Unpacked | Files |
| --- | ---: | ---: | ---: |
| `@synapsor/spec@1.6.0` | 48.2 kB | 251.0 kB | 83 |
| `@synapsor/dsl@1.6.0` | 29.1 kB | 120.1 kB | 14 |
| `@synapsor/runner@1.6.3` | 1.6 MB | 7.2 MB | 305 |

Before Spec 1.6.0 is published, the clean-install gate uses the locally packed
public Spec tarball. Once npm has that exact version it automatically returns
to Runner-only registry resolution. Force that post-publish proof with:

```bash
VERIFY_PACKED_RUNNER_USE_LOCAL_SPEC=0 ./scripts/verify-packed-runner.sh
```

## Visual Evidence

Screenshots are under:

```text
development/runner-1.6.3-visual/
```

They cover:

- desktop/mobile and light/dark overview;
- keyboard, loading, partial, stale, failure, and empty states;
- unresolved field and ambiguous identity;
- 40-table boundary;
- action unavailable;
- open, acknowledged, resolved, and expired attention;
- review, retry escalation, dead letter, UNKNOWN, reconciliation, unhealthy
  required sink, and queue backlog.

The visual verifier checks titles, labels, duplicate IDs, overflow,
authority-separation copy, primary actions, and attention state. The captures
were also manually inspected.

## Changed Files By Phase

### Release, package, and public positioning

```text
CHANGELOG.md
README.md
SECURITY.md
THREAT_MODEL.md
apps/runner/README.md
apps/runner/package.json
package.json
pnpm-lock.yaml
packages/spec/package.json
packages/dsl/package.json
plugins/cursor/synapsor/.cursor-plugin/plugin.json
plugins/cursor/synapsor/README.md
plugins/cursor/synapsor/commands/synapsor-protect.md
plugins/cursor/synapsor/mcp.json
```

### Guided onboarding, Workbench, Try, actions, and project discovery

```text
apps/runner/src/authoring-mcp.ts
apps/runner/src/auto-boundary.ts
apps/runner/src/auto-boundary.test.ts
apps/runner/src/boundary-workbench.ts
apps/runner/src/boundary-workbench.test.ts
apps/runner/src/cli.ts
apps/runner/src/cli.test.ts
apps/runner/src/explore-cli.ts
apps/runner/src/explore-cli.test.ts
apps/runner/src/guided-action.ts
apps/runner/src/guided-action.test.ts
apps/runner/src/guided-project.ts
apps/runner/src/guided-project.test.ts
apps/runner/src/local-ui.ts
apps/runner/src/local-ui.test.ts
apps/runner/src/project-resolution.ts
apps/runner/src/project-resolution.test.ts
apps/runner/src/protect-query.ts
apps/runner/src/scoped-explore.ts
apps/runner/src/scoped-explore.test.ts
apps/runner/src/schema-candidates.ts
apps/runner/src/schema-candidates.test.ts
apps/runner/src/capability-surface-lint.ts
apps/runner/src/capability-surface-lint.test.ts
apps/runner/src/lifecycle-view.test.ts
```

### Identity, supervised execution, attention, and stores

```text
apps/runner/src/operator-identity.ts
apps/runner/src/operator-identity.test.ts
apps/runner/src/notifications.ts
apps/runner/src/notifications.test.ts
apps/runner/src/notifications-cli.test.ts
packages/config/src/index.ts
packages/config/src/index.test.ts
packages/mcp-server/src/index.ts
packages/mcp-server/src/index.test.ts
packages/mcp-server/src/generated-authority.test.ts
packages/proposal-store/src/index.ts
packages/proposal-store/src/index.test.ts
schemas/synapsor.runner.schema.json
```

### Canonical contract, DSL, and schema classification

```text
packages/dsl/src/index.ts
packages/dsl/test/dsl.test.ts
packages/spec/schemas/synapsor-contract.schema.json
packages/spec/src/types.ts
packages/spec/src/validate.ts
packages/spec/test/validate.test.ts
packages/schema-inspector/src/index.ts
packages/schema-inspector/src/index.test.ts
packages/schema-inspector/src/sensitivity.ts
packages/schema-inspector/src/sensitivity.test.ts
schemas/schema-candidate-review.schema.json
```

### Documentation

```text
docs/README.md
docs/agent-guided-setup.md
docs/approval-roles-and-operator-identity.md
docs/auto-boundary-and-scoped-explore.md
docs/capability-authoring.md
docs/current-scope.md
docs/dsl-json-parity.md
docs/dsl-reference.md
docs/fresh-developer-usability.md
docs/getting-started-own-database.md
docs/guarded-crud-writeback.md
docs/guided-onboarding.md
docs/human-attention-notifications.md
docs/limitations.md
docs/local-mode.md
docs/migrating-to-synapsor-spec.md
docs/production.md
docs/release-notes.md
docs/runner-config-reference.md
docs/running-a-runner-fleet.md
docs/security-boundary.md
docs/store-lifecycle.md
docs/supervised-automatic-apply.md
docs/threat-model.md
docs/troubleshooting-first-run.md
examples/support-plan-credit/README.md
```

External, intentionally outside the OSS repository:

```text
/home/sandesh-tiwari/Desktop/C++/SYNAPSOR_TECHNICAL_DEEP_DIVE.md
```

### Fixtures, release gates, and evidence

```text
examples/fitflow-guided-onboarding/
examples/operator-oidc/
scripts/build-runner-package.mjs
scripts/check-license-content.mjs
scripts/cursor-plugin-package.mjs
scripts/verify-auto-boundary-workbench-visual.mjs
scripts/verify-packed-auto-boundary-explore.mjs
scripts/verify-packed-guided-onboarding.mjs
scripts/verify-packed-runner.sh
development/runner-1.6.3-fitflow-results.json
development/runner-1.6.3-progress.md
development/runner-1.6.3-handoff.md
development/runner-1.6.3-visual/
```

## Pre-Publish CI Hardening

An independent loaded-machine run exposed two test-harness failure modes after
the initial merge:

- a timed-out quick-demo test could leave the process cwd in its temporary
  directory until its async body unwound, causing later fixture lookups to fail;
- two signed-identity CLI integration tests performed four to five complete
  signing, SQLite, approval, and guarded-execution commands under Vitest's
  five-second unit-test default.

The CLI suite now restores its original cwd in the suite-level `afterEach`, and
two consecutive tests prove a deliberately changed cwd cannot reach the next
test. The two multi-command signed-identity cases use the repository's existing
scoped 15-second integration budget; the global unit-test timeout is unchanged.

Post-fix evidence:

- focused cwd and signed-identity regression: 4/4;
- exact `test:smoke` release gate stage: 8/8 files, 430/430 tests;
- complete `./scripts/verify-release-gate.sh 1.6.3`: passed;
- full four-worker source suite: 55/55 files, 845/845 tests;
- license/content, DSL source-path, Cursor-plugin, packed Runner,
  own-database Docker, and npm publish-dry-run checks: passed.

## Known Limits And Manual Checks

- A real first-time participant has not yet completed the owner observation
  protocol. Use `docs/fresh-developer-usability.md`; report this as pending
  until a person actually runs it.
- The golden stack is PostgreSQL + Next.js + Prisma + local Workbench. MySQL,
  Drizzle, and OpenAPI retain deterministic regression coverage, not an equally
  polished showcase.
- The OIDC proof uses a real signed-token/JWKS flow against a local simulated
  issuer, not a live Okta/Auth0 tenant.
- The generic signed webhook is verified locally and adversarially; no external
  Slack/PagerDuty endpoint was configured.
- Registry-only Runner installation cannot pass until Spec 1.6.0 is published.
  Run the forced registry check immediately after publishing Spec and before
  Runner.
- The packed timing named `first_guarded_apply_ms` covers the complete
  identity/write/worker/notification matrix before returning, not merely the
  first SQL commit. Public documentation labels it accordingly.
- Supervised automatic apply initially excludes DELETE, reversible/bounded-set
  work, app-owned executors, and external effects.
- Notification delivery is at least once. The ledger/Workbench, not an
  external sink, remains the source of truth.
- No Synapsor Cloud or AWS deployment was changed or verified by this OSS goal.

## Owner Usability Script

Use:

```text
docs/fresh-developer-usability.md
```

The participant should need only the README, an exported SELECT-only disposable
`DATABASE_URL`, trusted development scope variables, and the public first
command. Record command/click count, elapsed time, file edits, blocked-request
recovery, whether external docs were needed, and the four-part comprehension
answer.

## Publish And Release Plan

Run only after owner review, merge approval, clean status, and npm login.
Publish Spec first because Runner requires `@synapsor/spec@^1.6.0`.

Pre-publish:

```bash
cd /home/sandesh-tiwari/Desktop/C++/synapsor-runner
./scripts/verify-release-gate.sh 1.6.3
git diff --check
git status --short --branch
```

Publish Spec:

```bash
cd /home/sandesh-tiwari/Desktop/C++/synapsor-runner/packages/spec
corepack pnpm publish --access public --no-git-checks
```

Prove registry resolution before publishing Runner:

```bash
cd /home/sandesh-tiwari/Desktop/C++/synapsor-runner
npm view @synapsor/spec@1.6.0 version
VERIFY_PACKED_RUNNER_USE_LOCAL_SPEC=0 ./scripts/verify-packed-runner.sh
```

Publish DSL:

```bash
cd /home/sandesh-tiwari/Desktop/C++/synapsor-runner/packages/dsl
corepack pnpm publish --access public --no-git-checks
```

Publish Runner:

```bash
cd /home/sandesh-tiwari/Desktop/C++/synapsor-runner/apps/runner
corepack pnpm publish --access public --no-git-checks
```

Verify all public packages from a clean registry path:

```bash
npm view @synapsor/spec@1.6.0 version
npm view @synapsor/dsl@1.6.0 version
npm view @synapsor/runner@1.6.3 version
npx -y @synapsor/runner@1.6.3 --version
npx -y @synapsor/runner@1.6.3 audit --example dangerous-db-mcp
npx -y @synapsor/runner@1.6.3 try --prove
```

After merge and public verification, tag the exact merged commit:

```bash
cd /home/sandesh-tiwari/Desktop/C++/synapsor-runner
git switch main
git pull --ff-only origin main
git tag -a v1.6.3 -m "Synapsor Runner 1.6.3"
git push origin v1.6.3
sed -n '/^## 1.6.3 /,/^## 1.6.2 /p' docs/release-notes.md |
  sed '$d' > /tmp/synapsor-runner-1.6.3-release.md
gh release create v1.6.3 \
  --title "Synapsor Runner 1.6.3" \
  --notes-file /tmp/synapsor-runner-1.6.3-release.md
```

The extraction intentionally excludes historical release-note sections.
