# Conformance Fixtures

Conformance fixtures prove behavior, not just JSON shape.

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

The fixture set is intentionally small in 0.1. It covers the runner-supported
semantic surface first: trusted context, scoped reads, evidence handles,
proposal boundaries, kept-out fields, manual approval, and replay envelopes.

## Runner Usage

Runner tests load every conformance `contract.json` and verify that the MCP
runtime can expose the contract as semantic tools without exposing raw SQL,
approval, commit, or writeback tools.

Run:

```bash
corepack pnpm --filter @synapsor-runner/mcp-server test
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
