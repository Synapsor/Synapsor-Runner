# @synapsor/spec

`@synapsor/spec` is the canonical Synapsor contract package.

It defines the portable JSON contract shared by Synapsor Runner and Synapsor
Cloud/C++. The contract describes trusted context, business resources,
capabilities, workflows, policies, evidence, proposals, receipts, replay, and
external action intents.

Part of the Synapsor OSS toolchain:

- [`@synapsor/runner`](https://www.npmjs.com/package/@synapsor/runner): local MCP runtime that serves validated contracts.
- [`@synapsor/dsl`](https://www.npmjs.com/package/@synapsor/dsl): SQL-like authoring layer that compiles to this spec.
- [Source and issues on GitHub](https://github.com/Synapsor/Synapsor-Runner).

It does not contain local runtime wiring:

- no database URLs;
- no write credentials;
- no local SQLite path;
- no MCP port or transport;
- no debug flags.

Those belong in `synapsor.runner.json`.

## Version

Current contract version:

```text
0.1
```

`0.1` is preview/stabilizing. Unknown core fields fail validation. Extension
fields must use one of:

- `x-cloud-*`
- `x-runner-*`
- `x-experimental-*`

## Programmatic Usage

```ts
import { assertValidContract, normalizeContract } from "@synapsor/spec";

const contract = normalizeContract(JSON.parse(source));
assertValidContract(contract);
```

## CLI

```bash
synapsor-spec validate ./synapsor.contract.json
synapsor-spec normalize ./synapsor.contract.json --out ./synapsor.contract.normalized.json
```

Runner exposes the same public path:

```bash
synapsor-runner contract validate ./synapsor.contract.json
synapsor-runner contract bundle ./synapsor.contract.json --out ./synapsor-runner-bundle
synapsor-runner cloud push ./synapsor.contract.json --dry-run
```

## What Belongs In The Contract

- contexts and trusted/session bindings;
- resources and subject identity;
- read/proposal/external-action capabilities;
- visible and kept-out fields;
- evidence/query-audit requirements;
- proposal action shape and guarded writeback intent;
- workflow allowed capabilities and replay requirements;
- policy references and 0.1 policy metadata.

## What Does Not Belong In The Contract

- database passwords or URLs;
- bearer tokens;
- local machine paths;
- MCP transport details;
- ports or local process settings.

Runner config references contracts and provides local wiring. Cloud imports the
same contracts and provides hosted registry, approval, replay, RBAC, retention,
and managed runners.

## Conformance Fixtures

Schemas prove shape. Conformance fixtures prove behavior.

Fixtures live under:

```text
fixtures/conformance/
```

Each fixture contains a canonical contract, a scenario, and expected evidence,
proposal, receipt, replay, or redaction output. Runner tests load these
contracts to ensure tool exposure, kept-out fields, and model-facing boundaries
do not drift. Cloud/C++ tests use the same fixtures for import/export
alignment. The main Synapsor repo also keeps C++ export snapshots under
`tests/fixtures/synapsor_contract_exports/`; those snapshots validate with this
package and load in Runner through the cross-repo round-trip verifier.

## Extension Policy

Use extension fields instead of inventing new unprefixed core fields:

```json
{
  "x-cloud-registry-target": {
    "workspace": "workspace_123"
  }
}
```

Allowed prefixes:

- `x-cloud-*`
- `x-runner-*`
- `x-experimental-*`

Unknown unprefixed fields fail validation by design. That keeps Runner, Cloud,
C++, and DSL semantics from drifting silently.

## Stability

`0.1` is the first shared contract line. It is intended to be useful and
testable, but not yet a frozen v1 compatibility promise. New behavior should
arrive behind optional fields or explicit extension keys until promoted.
