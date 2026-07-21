# Test A Contract Boundary

Adopter-owned contract tests exercise reviewed allow/deny behavior without an
LLM. The public manifest schema is
[`schemas/synapsor.contract-tests.schema.json`](../schemas/synapsor.contract-tests.schema.json).

```bash
synapsor-runner contract test \
  --contract ./synapsor.contract.json \
  --tests ./synapsor.contract-tests.json \
  --config ./synapsor.runner.json
```

Static mode checks tool exposure, operator-only boundaries, trusted scope,
evidence and approval requirements, exact proposal effects, conflict guards,
argument limits, transition guards, bounded-set caps, and other assertions that
do not require a database. Add `--live` to call the actual MCP runtime for
scoped reads, proposals, evidence/replay redaction, and source-unchanged checks.

```bash
synapsor-runner contract test \
  --contract ./synapsor.contract.json \
  --tests ./synapsor.contract-tests.json \
  --config ./synapsor.runner.json \
  --live --format junit --out ./contract-tests.xml
```

Live mode accepts local/disposable PostgreSQL and MySQL targets. Runner refuses
remote hosts by default; `--allow-remote` is an explicit operator override and
does not grant implicit write permission. Use synthetic fixtures and a
disposable database. Unknown assertions and unresolved required tests fail
rather than being skipped.

A successful run ends with a stable count such as:

```text
Summary: 6 passed / 0 failed / 6 total
```

Supported assertions cover valid scoped tools, cross-tenant denial,
same-tenant cross-principal denial, trusted tenant/principal scope, required
evidence, approval-policy boundaries, kept-out fields, argument constraints,
transition guards, set caps, unchanged source state before approval, and the
absence of model-facing approval/writeback.
Trusted tenant and principal values belong in test setup, not tool arguments.

Use `cross_principal_deny` to prove both the allowed and denied sides of one
row lock. The two contexts must use the same tenant and different principals:

```json
{
  "id": "case-manager-b-cannot-read-a",
  "kind": "cross_principal_deny",
  "capability": "care.inspect_assigned_patient",
  "args": { "patient_id": "PAT-1001" },
  "trusted_context": {
    "tenant_id": "hospital_a",
    "principal": "case_manager_a",
    "provenance": "http_claims"
  },
  "other_trusted_context": {
    "tenant_id": "hospital_a",
    "principal": "case_manager_b",
    "provenance": "http_claims"
  },
  "expected_code": "NOT_FOUND_IN_TENANT"
}
```

Live execution first proves the owner can read the row, then requires the other
principal to receive the generic denial and `RESOURCE_NOT_FOUND` for the
owner's evidence handle. Run the repository's Postgres/MySQL proof with
`corepack pnpm test:principal-scope`.

The flagship example includes a working manifest at
[`examples/support-plan-credit/synapsor.contract-tests.json`](../examples/support-plan-credit/synapsor.contract-tests.json).
Contract tests prove the declared cases, not every possible threat or database
permission error.
