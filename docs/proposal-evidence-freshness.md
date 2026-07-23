# Proposal And Evidence Freshness

Runner 1.6.1 adds an optional fail-closed freshness gate for proposals whose
review depends on live source state.

This closes two different review gaps without changing the model-facing MCP
surface:

1. Before a local approval, Runner can re-read the proposal target and refuse
   approval if its exact version changed.
2. A proposal can declare reviewed supporting rows whose exact versions must
   still match before approval and again at apply.

Target-row drift was already blocked by the exact conflict guard at apply.
Version 1.6.1 does not replace that protection. It adds an earlier review-time
check and extends the final transaction to declared same-source dependencies.

## What Freshness Does And Does Not Mean

Keep these controls separate:

| Control | What it proves |
| --- | --- |
| Proposal hash and version | The approval refers to one immutable proposal shape. |
| Evidence and query fingerprints | The stored review material has not silently changed. |
| Freshness proof | The target and declared dependencies matched their captured exact versions at one live check. |
| Approval | A trusted reviewer or policy authorized that exact proposal and proof. |
| Apply conflict checks | The target and dependencies still match inside the mutation transaction. |
| Idempotency receipt | Retrying the same completed writeback identity does not duplicate its effect. |

A successful approval-time check is not a lock held until apply. Data can
change one millisecond later, so apply always revalidates again.

Runner never refreshes a stale proposal in place. The operator must perform a
new source read and create a new proposal with a new hash and review.

## Configuration

Freshness is a Runner deployment overlay in `synapsor.runner.json`. Version
1.6.1 adds no DSL clause and no canonical Spec field. Existing hand-authored
DSL, canonical JSON, contract digests, and `tools/list` output remain unchanged
when this optional section is absent.

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

The names mean:

- `billing.propose_credit`: an existing reviewed proposal capability.
- `approval: "required"`: every approval decision requires a new short-lived
  live proof.
- `invoice_eligibility`: an operator-defined stable dependency label.
- `billing.inspect_invoice`: an existing reviewed single-row read capability.
- `invoice_id`: an existing bounded scalar argument on the proposal. Its value
  identifies the supporting row through the read capability's fixed lookup.
- `updated_at`: the exact version/conflict column on that supporting row.

The proposal and supporting read must use the same source and trusted context.
The supporting capability supplies the fixed engine, schema, table, primary
key, tenant key, optional principal key, and lookup shape. None of those
identifiers can come from an MCP argument.

Strict validation rejects:

- unknown or non-proposal policy keys;
- app-owned or cross-source writeback;
- unknown, aggregate, protected, or non-single-row dependencies;
- missing or untrusted tenant scope;
- incompatible principal scope;
- missing scalar identity arguments;
- unsafe or missing version identifiers;
- duplicate, self-referential, or more than 16 dependencies.

Run both static validation and live writeback probes:

```bash
synapsor-runner config validate --config ./synapsor.runner.json
synapsor-runner doctor --check-writeback --config ./synapsor.runner.json
```

`doctor --check-writeback` performs rollback-only lock probes. The read role
needs scoped `SELECT`. The writer must be able to lock every declared
supporting row in the final transaction. PostgreSQL and MySQL may require a
narrow update/locking privilege in addition to `SELECT`; use a dedicated
least-privilege writer and verify the exact grants on the deployed database.

## Proposal Creation

When a freshness-enabled proposal is created, Runner:

1. reads the target through the existing reviewed proposal capability;
2. reads each declared dependency through its reviewed single-row capability
   in a read-only transaction;
3. captures only the fixed identity, exact version, and bounded
   evidence/query-audit linkage;
4. sorts dependencies into deterministic lock order;
5. binds the resulting `synapsor.freshness-authority.v1` object into the
   immutable change set and proposal hash.

The authority contains digests and fixed identifiers. It does not add source
rows, kept-out values, database URLs, credentials, or a second copy of trusted
tenant/principal values to the proposal.

The published protocol representation is inspectable without reading the
TypeScript implementation:

- `schemas/freshness-authority.v1.schema.json` defines the optional authority
  carried by change sets and writeback jobs.
- `schemas/freshness-proof.v1.schema.json` defines the immutable live-check
  proof stored in the ledger.
- `fixtures/protocol/change-set.freshness-update.v2.json`,
  `fixtures/protocol/writeback-job.freshness-update.v2.json`,
  `fixtures/protocol/freshness-authority.invoice.v1.json`, and
  `fixtures/protocol/freshness-proof.fresh.v1.json` are hash-manifested
  conformance examples.

The JSON Schemas enforce the public structure. The executable protocol
validator additionally verifies canonical descriptor, dependency-set, and
proof digests plus cross-field invariants that JSON Schema cannot express.

For UPDATE and DELETE, target mode is `exact_guard`. For a bounded set it is
`frozen_set`. INSERT has no prior target row, so target freshness is
`not_applicable`; its source uniqueness and idempotency guards still apply.

## Approval-Time Check

Inspect the newest proposal without copying an ID:

```bash
synapsor-runner proposals check-freshness latest \
  --config ./synapsor.runner.json \
  --store ./.synapsor/local.db
```

Add `--details` for per-check digests or `--json` for the versioned
`synapsor.proposal-freshness-result.v1` document.

Stable exit codes are:

| Status | Exit code | Meaning |
| --- | ---: | --- |
| `fresh` | 0 | Every required target/dependency version matched. |
| `not_required` | 0 | Legacy proposal; its normal apply guard still applies. |
| `stale` | 3 | A target or dependency changed, disappeared, or left trusted scope. |
| `unavailable` | 4 | The source could not be checked; retry may be appropriate. |
| `invalid` | 5 | Stored or configured authority did not validate. |
| `unsupported` | 6 | The topology cannot provide the claimed guarantee. |

Approval runs the same live check automatically:

```bash
synapsor-runner proposals approve latest \
  --yes \
  --actor billing_reviewer \
  --config ./synapsor.runner.json \
  --store ./.synapsor/local.db
```

A successful check records an immutable `synapsor.freshness-proof.v1` event.
The proof binds:

- proposal ID, hash, and integer version;
- dependency-set digest;
- checked and short validity times;
- source adapter identity;
- bounded target/supporting counts and result codes;
- expected/observed version digests, not source values;
- the proof's own digest.

Every human quorum decision receives a distinct live proof. Policy
auto-approval uses the same evaluator. A stale check records no approval and
makes the proposal terminal `conflict`. An unavailable check records no
approval and leaves it `pending_review`.

## Apply-Time Revalidation

Apply remains an operator/worker action outside MCP:

```bash
synapsor-runner apply latest \
  --yes \
  --config ./synapsor.runner.json \
  --store ./.synapsor/local.db
```

For direct SQL PostgreSQL/MySQL writeback, Runner:

1. begins the existing source transaction;
2. locks supporting rows in deterministic source/schema/table/identity order;
3. rechecks each exact version under trusted tenant and principal scope;
4. locks and rechecks the target row or every frozen set member;
5. performs the existing guarded mutation only if all checks pass;
6. finalizes the configured source or Runner-ledger receipt behavior.

PostgreSQL uses parameterized `SELECT ... FOR UPDATE` and quoted reviewed
identifiers. MySQL uses the equivalent InnoDB locking read. A stale supporting
row returns `FRESHNESS_DEPENDENCY_STALE`, zero affected rows, and rolls back the
whole transaction. A stale target continues to use the exact target conflict
path. A stale conflict is never converted to `already_applied`.

For a bounded set, one stale member or one stale dependency aborts every member.

## Timeline

Change before approval:

```text
proposal captures target v4 + invoice v8
invoice moves to v9
reviewer approves
  -> live preflight sees v9 != v8
  -> no approval, no source mutation
  -> create a new read and proposal
```

Change after approval:

```text
proposal captures target v4 + invoice v8
approval preflight succeeds and binds proof
invoice moves to v9
trusted apply starts
  -> transaction locks invoice and sees v9 != v8
  -> conflict, zero source mutation
  -> create a new read and proposal
```

The second timeline is why approval-time freshness can never replace
apply-time concurrency control.

## Supporting Evidence Example

Assume `credits.propose_account_credit` changes an account row, but eligibility
depends on a separate invoice:

```text
target account       version 12 (unchanged)
supporting invoice   status=open, version 7
proposal             credit $25 because invoice is open
```

If a payment process closes the invoice and advances it to version 8 while the
account stays at version 12, the target guard alone would still pass. Declaring
the invoice read as a freshness dependency makes approval or apply fail closed
on the invoice version mismatch.

Freshness checks the reviewed exact version, not whether the current value
"looks equivalent." Returning a row to its old value does not revive a proposal
that already became stale.

## Ledger, Replay, Reports, And Metrics

Use the no-ID lifecycle view:

```bash
synapsor-runner lifecycle --details --store ./.synapsor/local.db
synapsor-runner replay show latest --details --store ./.synapsor/local.db
```

Lifecycle and replay retain the proof chain: authority, proof event, approval
proof digest, apply result, receipt, and replay linkage. Backup/restore and the
shared PostgreSQL runtime store preserve the same versioned records.

Compliance reports include only bounded freshness metadata and digests. Metrics
separate checks, stale target/supporting outcomes, blocked approvals, and
apply-time blocks. Logs never include source rows or credential values.

## Cloud And App-Owned Executors

Cloud-linked approval remains proposal/digest authority. Cloud may retain
bounded freshness metadata, but it does not connect to or read the customer
database. A Runner next to the source revalidates dependencies when it applies
a Cloud-approved lease. Cloud outage never enables weaker local approval or
apply authority.

Strict freshness currently supports same-database direct SQL writeback only.
Runner rejects strict freshness configuration for app-owned handlers and
cross-source dependencies because it cannot place those checks and effects in
one transaction.

An app-owned executor can implement equivalent preconditions, but the
application must own and test:

- source reads and locking;
- tenant/principal authorization;
- exact expected versions;
- transaction boundaries;
- idempotency and ambiguous outcomes;
- safe receipts.

Do not describe those application guarantees as Runner's atomic direct-SQL
freshness guarantee.

## Security Boundary

Freshness adds no model-facing approval, apply, activation, bypass, SQL, table,
column, scope, or policy argument. Existing `tools/list` output is unchanged.

It also does not replace:

- correct monotonic version columns;
- least-privilege read/write roles;
- PostgreSQL RLS, restricted views, or tenant-bound credentials;
- application authorization;
- source backups and recovery testing;
- operator identity and host/store protection.

The dedicated live gate is:

```bash
corepack pnpm test:proposal-freshness
```

It runs disposable PostgreSQL and MySQL scenarios for approval preflight,
proof-bound human/quorum/policy approval, target/supporting drift before and
after approval, source and Runner-ledger receipts, bounded-set rollback,
reversible UPDATE, DELETE, shared runtime state, Cloud-approved local
revalidation, writer lock probes, idempotent retry, and kept-out-value
non-disclosure.
