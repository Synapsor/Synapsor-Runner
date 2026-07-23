# Runner 1.6.1 Proposal and Evidence Freshness Progress

## Objective

Implement `/home/sandesh-tiwari/Desktop/C++/goal.txt` on
`security/proposal-evidence-freshness`.

Target behavior:

- local freshness-required approval rechecks the target and declared supporting
  source-row dependencies;
- every successful approval binds a bounded freshness proof;
- trusted apply revalidates target and dependencies again;
- stale or unverifiable state fails closed with zero source mutation;
- existing Runner 1.6.0 contracts, digests, tools, and offline approval flows
  remain compatible.

## Current Status

Phases 0-10: complete.

Implementation, public protocol artifacts, PostgreSQL/MySQL verification,
backward compatibility, documentation, technical deep-dive reconciliation,
packed-artifact verification, and release preparation are complete.

Release status: ready for owner review. Nothing has been committed, pushed,
merged, tagged, published, released, or deployed.

Current branch:

```text
security/proposal-evidence-freshness
```

Baseline commit:

```text
be22ea6 Ship Runner 1.6.0 Auto Boundary and protected exploration
```

Published baseline verified 2026-07-23:

```text
@synapsor/runner 1.6.0  latest=1.6.0  next=1.6.0
@synapsor/spec   1.5.0  latest=1.5.0  next=1.5.0
@synapsor/dsl    1.5.0  latest=1.5.0  next=1.5.0
```

Both OSS and Cloud worktrees were clean and aligned with `origin/main` before
the branch was created. No Cloud files have been changed.

## Baseline Verification

Command:

```bash
corepack pnpm test
```

Result:

```text
47 test files passed
709 tests passed
License/content check passed
DSL source path check passed
Cursor plugin verification passed
```

Duration was approximately 127 seconds. The CLI suite is intentionally slow
because many tests start subprocesses; keep long database/integration batteries
sequential.

## Confirmed Existing Boundary

- `ProposalStore.approveProposal` verifies stored proposal identity,
  pending-review state, operator identity/role, duplicate reviewer, and quorum.
  It does not open the source database.
- proposal creation stores the target expected version inside the immutable
  change set and proposal hash.
- PostgreSQL/MySQL direct apply re-read/lock the target and compare the exact
  expected version.
- guarded UPDATE SQL includes primary key, trusted tenant, optional trusted
  principal, and expected version.
- stale single-row apply returns `VERSION_CONFLICT` with zero mutation.
- bounded-set apply locks and revalidates every frozen member and returns
  `SET_DRIFT_CONFLICT` atomically.
- evidence bundles/query audit preserve immutable review evidence and query
  fingerprints, but do not make every supporting source row a freshness
  dependency.

## Baseline Gap

1. Change the target after proposal creation but before local approval:
   approval currently succeeds; apply later fails safely.
2. Keep the target unchanged but change a related supporting evidence row:
   no general approval/apply freshness check exists for that supporting row.
3. Confirm no stale target mutation occurs in either baseline fixture.

The code audit reproduces the gap structurally:

- local CLI, Workbench, and policy approval call the proposal store without a
  source read;
- the immutable target guard is checked only by the trusted apply adapter;
- a supporting evidence row is not part of the writeback job unless it is also
  the mutation target.

Existing adapter tests already prove that stale target rows return
`VERSION_CONFLICT` or `SET_DRIFT_CONFLICT` with zero mutation. Focused
freshness fixtures will preserve that baseline while adding the missing
approval and supporting-row checks.

## Design Decisions

### Public configuration

Freshness is an additive Runner deployment overlay, not a new portable contract
or DSL clause in this release:

```json
{
  "proposal_freshness": {
    "billing.propose_credit": {
      "approval": "required",
      "dependencies": [
        {
          "id": "invoice_eligibility",
          "capability": "billing.inspect_invoice",
          "identity_from_arg": "invoice_id",
          "version_column": "updated_at"
        }
      ]
    }
  }
}
```

The map key is an existing proposal capability. Each dependency names an
existing reviewed single-row read capability and maps one already-declared
proposal argument to that read capability's fixed lookup argument. Schema,
table, primary-key, tenant/principal guards, source, and version column are
fixed reviewed configuration and never MCP arguments.

Strict validation requires:

- direct-SQL writeback for exact atomic dependency enforcement;
- the same source/database and trusted context as the proposal capability;
- an exact safe version column;
- a tenant-scoped dependency, or an explicit existing single-tenant-dev
  boundary;
- compatible principal scope; a principal-scoped dependency cannot introduce a
  scope value absent from the proposal;
- one unique, acyclic dependency ID and reviewed capability reference.

Spec and DSL remain at 1.5.0. Existing contract normalization, contract digests,
and `tools/list` are unchanged when the optional overlay is absent.

The public Runner protocol bundle now includes:

- `schemas/freshness-authority.v1.schema.json`;
- `schemas/freshness-proof.v1.schema.json`;
- optional `freshness` references in change-set v1-v3 and writeback-job v1-v3;
- four hash-manifested authority/proof/change-set/writeback fixtures.

The JSON Schemas validate public structure. The executable protocol parser also
checks canonical descriptor/dependency/proof digests and operation/source
invariants. This is a Runner protocol addition, not a canonical Spec or DSL
change.

### Immutable proposal authority

Freshness-required proposals carry an optional versioned
`synapsor.freshness-authority.v1` block inside the already versioned change set.
It contains:

- whether target checking is exact, frozen-set, or not applicable for INSERT;
- a deterministic list of resolved same-source dependency descriptors;
- each fixed resource identity and expected exact version;
- safe evidence-bundle/query-fingerprint linkage;
- a canonical dependency-set digest.

The descriptor does not contain source rows, kept-out values, raw SQL,
credentials, or a second copy of tenant/principal values. Apply derives trusted
scope from the existing immutable target guard and principal scope.

### Proof and approval binding

The shared evaluator produces `synapsor.freshness-proof.v1`:

- exact proposal ID/hash/version;
- dependency-set digest;
- checked time and short validity boundary;
- target/dependency counts and bounded result summaries;
- fresh, stale, unavailable, invalid, or unsupported outcome;
- proof digest.

Proofs are immutable proposal events so they automatically participate in
local replay, backup/restore, and the shared Postgres runtime-store ledger.
Approval rows gain an optional `freshness_proof_digest`. For a
freshness-required proposal the store requires a fresh, unexpired, unused proof
matching the exact proposal and dependency set. Every quorum reviewer receives
a distinct live proof. Policy approval uses the same path.

A stale proof atomically moves the proposal to terminal `conflict`; returning
the source data to an old value cannot revive it. Unavailable/unsupported
checks leave it pending and record no approval.

### Approval flow

CLI, Workbench, and policy auto-approval call one exported evaluator. Approval
preflight:

1. validates proposal hash and dependency-set digest;
2. performs read-only scoped reads through the reviewed source;
3. compares target or frozen-set versions and every dependency version;
4. records the bounded proof;
5. records approval only when the proof is fresh.

This improves what the reviewer is approving but is not a commit lock.

### Apply flow

The writeback job carries the immutable dependency authority. PostgreSQL and
MySQL adapters:

1. begin the existing source transaction;
2. lock supporting dependencies in deterministic resource/identity order;
3. compare exact versions under tenant/principal scope;
4. run the existing target/frozen-set lock and conflict checks;
5. mutate only if every check passes.

A dependency mismatch returns terminal
`FRESHNESS_DEPENDENCY_STALE`, zero affected rows, and no fallback to
`already_applied`. Existing source-receipt and runner-ledger idempotency/
reconciliation semantics remain unchanged.

### Error and topology boundaries

- stale target: `FRESHNESS_TARGET_STALE`, non-retryable conflict;
- stale/missing/out-of-scope dependency:
  `FRESHNESS_DEPENDENCY_STALE`, non-enumerating conflict;
- source timeout/saturation: `FRESHNESS_TEMPORARILY_UNAVAILABLE`, retryable;
- invalid/tampered authority or proof: fail-closed invalid;
- unsupported/cross-source/app-handler strict topology: fail configuration or
  doctor before serving.

Cloud still receives no source rows or credentials. Cloud approval remains
proposal/digest authority only; the local Runner performs final source
revalidation. Cross-source atomic freshness remains unsupported.

## Tests Run

Final source-state gates:

| Command | Result |
| --- | --- |
| `corepack pnpm build` | PASS |
| `corepack pnpm test` | PASS: 47 files, 728 tests; license/content, DSL source paths, and Cursor plugin passed |
| `corepack pnpm --filter @synapsor-runner/protocol test` | PASS: 2 files, 34 tests, including public JSON Schema/fixture parity |
| `corepack pnpm exec vitest run apps/runner/src/compliance-report.test.ts` | PASS: 3 tests |
| `corepack pnpm test:proposal-freshness` | PASS: disposable PostgreSQL and MySQL matrix |
| `corepack pnpm verify:packed-runner` | PASS, including freshness guide/schema/fixture presence |
| `corepack pnpm verify:packed-lifecycle` | PASS |
| `corepack pnpm test:packed-backward-compatibility` | PASS against Runner 1.6.0 / Spec 1.5.0 / DSL 1.5.0 |
| `npm publish --dry-run --access public --json` from `apps/runner` | PASS: Runner 1.6.1, 1,362,517-byte tarball, 6,166,748 bytes unpacked, 292 entries |

Complete regression gates run during this goal:

| Command | Result |
| --- | --- |
| `corepack pnpm test:published-compatibility` | PASS: published 1.5.4 and 1.6.0 compatibility baselines |
| `corepack pnpm test:first-run` | PASS: local PostgreSQL/MySQL examples and stale-store refusal |
| `corepack pnpm test:guarded-crud` | PASS |
| `corepack pnpm test:bounded-set` | PASS |
| `corepack pnpm test:reversible` | PASS |
| `corepack pnpm test:fleet` | PASS |
| `corepack pnpm test:mcp-streamable` | PASS: 2 files, 215 tests |
| `corepack pnpm test:auto-boundary-explore:packed` | PASS |
| `corepack pnpm test:contract-conformance` | PASS |
| `corepack pnpm test:principal-scope` | PASS |
| `corepack pnpm test:database-scope` | PASS |
| `corepack pnpm test:aggregate-read` | PASS |
| `corepack pnpm test:live-apply` | PASS |
| `corepack pnpm verify:packed-network-auth` | PASS |
| `corepack pnpm verify:public-commands` | PASS |
| `corepack pnpm verify:adoption` | PASS |
| `corepack pnpm test:mcp-cloud-linked` | PASS |

One full-suite run initially timed out only the existing signed
compliance-report test at Vitest's 5-second default while all suites ran in
parallel. The same assertions passed alone. All three crypto/PDF compliance
tests now have an explicit 15-second bound; the focused suite and subsequent
complete 728-test run passed.

The live matrix covers pre-approval target/support drift, unavailable sources,
proof-bound local/quorum/policy approvals, source_db and runner_ledger apply,
post-approval target/support drift, DELETE, reversible UPDATE, bounded-set
rollback, shared PostgreSQL runtime state, idempotent retry, Cloud-approved
local revalidation, kept-out-value absence, and rollback-only doctor probes.

Observed writer-role prerequisite:

- apply-time dependency checks use `SELECT ... FOR UPDATE`/locking reads in the
  same source transaction;
- the writer therefore needs `SELECT` plus row-lock authority on every declared
  supporting relation;
- the disposable PostgreSQL and MySQL fixtures satisfy this with a narrow
  `UPDATE(version_column)` grant rather than broad write access;
- MySQL hard DELETE retains its existing trigger-inspection privilege
  prerequisite;
- `doctor --check-writeback` now performs a no-row, rollback-only lock probe for
  each declared dependency and reports actionable, redacted failure guidance.

## Implementation Status

Implemented:

- additive top-level `proposal_freshness` configuration and public Runner
  config JSON schema;
- strict same-source/direct-SQL dependency validation and rejection of
  app-handler/cross-source freshness claims;
- versioned freshness authority and proof protocol objects on additive change
  set/writeback-job fields;
- deterministic descriptor/dependency digests and protocol binding validation;
- proposal-time target/supporting dependency capture from reviewed named read
  capabilities;
- one shared read-only evaluator for CLI, Workbench, and policy approval;
- PostgreSQL/MySQL read-only preflight transactions;
- immutable proof events and proof-bound human/quorum/policy approvals;
- terminal conflict on target/supporting drift, including no revival if the
  source later returns to an old value;
- `proposals check-freshness <id|latest>` text, details, JSON, and stable
  result handling;
- approval preflight in CLI and Workbench;
- Workbench status/check control and approval disabling;
- same-transaction PostgreSQL/MySQL dependency locks before target locks and
  mutation;
- bounded lifecycle output, proposal detail output, immutable events, and fleet
  counters;
- proof/approval preservation through shared-ledger export/import.
- bounded freshness authority/proof metadata in compliance exports without
  source-row payloads;
- replay reconstruction of freshness proof and approval bindings;
- Cloud outbox preservation of bounded freshness authority without supporting
  source rows, kept-out fields, credentials, or local proof payloads;
- live Cloud-approved lease revalidation against local source drift;
- rollback-only writer lock-authority diagnostics for declared dependencies;
- structured freshness check/approval logs containing only safe status/count/
  digest metadata;
- public JSON Schemas for freshness authority/proof, additive references from
  change-set/writeback-job schemas, and hash-manifested conformance fixtures;
- packed-tarball assertions for the guide, schemas, and fixtures;
- a deterministic test timeout for the existing crypto/PDF compliance path
  under full parallel-suite load.

Compatibility design remains Runner-only. Spec and DSL are unchanged at 1.5.0,
legacy contract normalization/digests remain untouched, and the optional
overlay does not alter MCP `tools/list`.

## Documentation Verification

- Root and packaged READMEs are byte-identical.
- 77 public Markdown files have zero missing relative links.
- The technical deep dive has 400 balanced fence markers and 30 parseable JSON
  blocks.
- Complete deep-dive DSL examples were compiled for principal scope, protected
  aggregate read, guarded write, and the combined Auto Boundary context plus
  three generated capabilities.
- All 20 changed/new JSON files parse.
- `git diff --check` passes.
- Secret scanning found only explicit test/disposable credentials and
  documented `REPLACE_ME` placeholders; no real credential, token, or private
  key was added.
- `/home/sandesh-tiwari/Desktop/C++/SYNAPSOR_TECHNICAL_DEEP_DIVE.md` now
  explains the old/new approval behavior, supporting-row gap, config and public
  protocol representation, proof binding, CLI/Workbench states, transaction
  locking, Cloud/app-handler limits, timelines, outputs, commands, and tested
  release status.

## Files Changed

- `apps/runner/src/cli.ts`
- `apps/runner/src/cli.test.ts`
- `apps/runner/src/compliance-report.ts`
- `apps/runner/src/compliance-report.test.ts`
- `apps/runner/src/lifecycle-view.ts`
- `apps/runner/src/lifecycle-view.test.ts`
- `apps/runner/src/local-ui.ts`
- `apps/runner/src/local-ui.test.ts`
- `packages/config/src/index.ts`
- `packages/config/src/index.test.ts`
- `packages/mcp-server/src/index.ts`
- `packages/mcp-server/src/index.test.ts`
- `packages/mysql/src/index.ts`
- `packages/mysql/src/index.test.ts`
- `packages/postgres/src/index.ts`
- `packages/postgres/src/index.test.ts`
- `packages/proposal-store/src/index.ts`
- `packages/proposal-store/src/index.test.ts`
- `packages/protocol/src/index.ts`
- `packages/protocol/src/index.test.ts`
- `packages/protocol/package.json`
- `schemas/change-set.v1.schema.json`
- `schemas/change-set.v2.schema.json`
- `schemas/change-set.v3.schema.json`
- `schemas/writeback-job.v1.schema.json`
- `schemas/writeback-job.v2.schema.json`
- `schemas/writeback-job.v3.schema.json`
- `schemas/freshness-authority.v1.schema.json`
- `schemas/freshness-proof.v1.schema.json`
- `fixtures/protocol/MANIFEST.json`
- `fixtures/protocol/change-set.freshness-update.v2.json`
- `fixtures/protocol/freshness-authority.invoice.v1.json`
- `fixtures/protocol/freshness-proof.fresh.v1.json`
- `fixtures/protocol/writeback-job.freshness-update.v2.json`
- `schemas/synapsor.runner.schema.json`
- `scripts/verify-proposal-evidence-freshness.mjs`
- packed/published compatibility and lifecycle verifier scripts
- public README, package README, llms indexes, security/production/authoring/
  lifecycle/troubleshooting docs, changelog, and release notes
- `/home/sandesh-tiwari/Desktop/C++/SYNAPSOR_TECHNICAL_DEEP_DIVE.md`
- `package.json`
- `apps/runner/package.json`
- `pnpm-lock.yaml`
- this progress file

No Cloud/C++/website files have been changed.

## Remaining Work

No implementation or verification work remains in this goal.

External release actions require explicit owner authorization:

1. review and commit the feature branch;
2. merge/push;
3. publish only `@synapsor/runner@1.6.1`;
4. move Runner's `next` tag;
5. verify npm/npx and create/push `v1.6.1`.

## Owner-Run Release Commands

Publish only Runner; Spec and DSL remain unchanged at 1.5.0:

```bash
cd /home/sandesh-tiwari/Desktop/C++/synapsor-runner/apps/runner
npm publish --access public
npm dist-tag add @synapsor/runner@1.6.1 next
```

Registry and installed-artifact verification:

```bash
npm view @synapsor/runner@1.6.1 version repository.url readmeFilename bin license
npm dist-tag ls @synapsor/runner
npx -y -p @synapsor/runner@1.6.1 synapsor-runner --version
npx -y -p @synapsor/runner@1.6.1 synapsor-runner audit --example dangerous-db-mcp
npx -y -p @synapsor/runner@1.6.1 synapsor-runner try --prove --yes --no-open
```

After the reviewed release commit is on `main`:

```bash
cd /home/sandesh-tiwari/Desktop/C++/synapsor-runner
git tag -a v1.6.1 -m "Synapsor Runner 1.6.1"
git push origin v1.6.1
gh release create v1.6.1 --title "Synapsor Runner 1.6.1" --generate-notes
```

## Blockers

None.

## Resume Instructions

1. Read this file and `/home/sandesh-tiwari/Desktop/C++/goal.txt`.
2. Confirm branch and worktree:

   ```bash
   cd /home/sandesh-tiwari/Desktop/C++/synapsor-runner
   git status --short --branch
   ```

3. Inspect the final diff and the test matrix above.
4. Do not push, merge, publish, tag, release, deploy, or alter external
   services without explicit authorization.
