# Conformance Fixtures

Conformance fixtures prove behavior, not just JSON shape.

The conformance artifacts are canonical JSON. When authoring a source contract
for these checks, prefer `.synapsor.sql` for generic editor SQL highlighting;
`.synapsor` remains backward compatible and the filename does not affect the
compiled contract semantics.

`@synapsor/spec` owns the fixtures under:

```text
packages/spec/fixtures/conformance/
```

Each fixture contains:

- `contract.json`: canonical `@synapsor/spec` contract;
- `scenario.json`: trusted context, invocation, and mocked source data;
- `expected.*.json`: expected evidence, proposal, receipt, replay, redaction,
  or external action result.

Current fixture groups:

- `read-capability`
- `proposal-capability`
- `kept-out-fields`
- `manual-approval`
- `auto-approval`
- `aggregate-policy-limits`
- `aggregate-read`
- `numeric-bounds`
- `bounded-set-threats`
- `reversible-change-sets`

The fixture set is intentionally small in 0.1. It covers the runner-supported
semantic surface first: trusted context, scoped reads, evidence handles,
proposal boundaries, kept-out fields, manual approval, and replay envelopes.
The aggregate-policy fixture additionally proves that reviewed daily ceilings
fall back to human review atomically and record the limit that tripped.
The bounded-set fixture maps threats R1-R7 to executable expectations: fixed
selection, count/value caps, frozen-version drift checks, atomic rollback,
exact receipts, hard-delete side-effect refusal, and human approval. Adapter
tests and `corepack pnpm test:bounded-set` complete the live PostgreSQL/MySQL
matrix.
The aggregate-read fixture proves a reviewer-fixed scalar operation, trusted
tenant scope, fixed equality selection, minimum-group suppression, and an
evidence/query-audit surface containing no member rows or identities. The live
`corepack pnpm test:aggregate-read` gate runs COUNT/SUM/AVG, suppression,
timeout, and dependency classification against disposable PostgreSQL and
MySQL.
The reversible-change-set fixture proves that undo is a new reviewed
compensation proposal, not rollback: apply-time receipts capture only
allowlisted inverse data, compensation uses fresh guards and exact members,
ambiguous outcomes fail closed pending reconciliation, and hard delete reports
a specific best-effort-unavailable reason.

Additional 0.1 parity coverage currently lives in tests and verification
scripts rather than separate `cloud-push/` or `dsl-json-parity/` conformance
fixture directories:

- `docs/dsl-json-parity.md`, DSL/spec tests, and the
  `numeric-bounds-transition` C++ export fixture cover richer DSL/JSON parity
  fields such as `returns_hint`, numeric bounds, and transition guards.
- `packages/dsl/fixtures/invalid/non-primary-lookup.synapsor.sql` proves the
  DSL rejects a lookup meaning that canonical spec 0.1 cannot represent,
  instead of silently rewriting it to primary-key access.
- The main Synapsor repo script `scripts/verify_contract_cloud_push.sh`
  verifies real Cloud push, retrieval, idempotent versioning, unauthorized
  rejection, and runner-bundle download against a live local control-plane.

## Runner Usage

Runner tests load every conformance `contract.json` and verify that the MCP
runtime can expose the contract as semantic tools without exposing raw SQL,
approval, commit, or writeback tools.

Run:

```bash
corepack pnpm --filter @synapsor-runner/mcp-server test
corepack pnpm test:contract-conformance
corepack pnpm test:aggregate-read
```

The spec package also validates every conformance contract:

```bash
corepack pnpm --filter @synapsor/spec test
```

## Cloud/C++ Usage

The proprietary Cloud/C++ engine uses the same fixture contracts for
import/export alignment of the 0.1 overlapping subset:

1. load `contract.json`;
2. validate the 0.1 core fields and extension policy;
3. compile the overlapping subset to internal context/capability/workflow
   models;
4. emit normalized `@synapsor/spec` JSON;
5. compare unsupported fields and extension handling explicitly.

The main Synapsor repo also keeps C++ export fixtures under:

```text
tests/fixtures/synapsor_contract_exports/
```

Those exported contracts are validated by `@synapsor/spec` and loaded by
`@synapsor/runner` through the main repo verifier:

```bash
SYNAPSOR_RUNNER_REPO=/path/to/synapsor-runner \
  ./scripts/verify_contract_roundtrip.sh
```

Full runtime parity is not required for every Cloud-only feature in 0.1, but
unsupported fields must fail clearly or be represented through documented
`x-cloud-*` extensions.

## Add A Fixture

1. Create a new directory under `packages/spec/fixtures/conformance/<name>/`.
2. Add a valid `contract.json`.
3. Add a minimal `scenario.json`.
4. Add one or more `expected.*.json` files.
5. Run:

```bash
corepack pnpm --filter @synapsor/spec test
corepack pnpm --filter @synapsor-runner/mcp-server test
```

Keep fixtures deterministic. Do not include secrets, database URLs, live table
rows, bearer tokens, or customer data.
