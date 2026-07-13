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
- model-facing capability descriptions and returns hints;
- visible and kept-out fields;
- evidence/query-audit requirements;
- proposal action shape, explicit INSERT/UPDATE/DELETE operation, source-unique
  INSERT deduplication, UPDATE version advancement, numeric bounds, transition
  guards, optional bounded-set cardinality/fixed selection/row and aggregate
  caps/exact batch items, and guarded writeback intent;
- workflow allowed capabilities and replay requirements;
- policy references and 0.1 policy metadata.

## What Does Not Belong In The Contract

- database passwords or URLs;
- bearer tokens;
- local machine paths;
- MCP transport details;
- ports or local process settings.

Runner config references contracts and provides local wiring. Cloud imports the
same contracts into a shared, versioned registry and can export placeholder-only
Runner bundles. Hosted approval/evidence/replay behavior depends on the enabled
Cloud pilot; managed runners, SAML/SCIM, and enterprise retention are not implied
by contract compatibility.

## Local To Cloud Loop

```bash
synapsor-spec validate ./synapsor.contract.json
synapsor-runner contract bundle ./synapsor.contract.json --out ./synapsor-runner-bundle
synapsor-runner cloud push ./synapsor.contract.json --dry-run
```

A real push stores the normalized contract as an immutable Cloud registry
version with a server-computed digest. Downloading that version's Runner bundle
returns the same contract plus local wiring placeholders; the contract never
contains database credentials.

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

## 0.1 Additive Fields

The `0.1` line accepts additive optional core fields when they carry portable
safety semantics shared by Runner and Cloud/C++.

Current additive safety fields:

- capability `returns_hint`: model-facing result guidance for a reviewed tool;
- proposal `numeric_bounds`: reviewed minimum/maximum constraints for patched
  numeric fields;
- proposal `transition_guards`: reviewed allowed state transitions for patched
  string fields;
- proposal approval `policy`: names a reviewed approval policy for
  policy-based local approval;
- proposal approval `required_approvals`: optional distinct-reviewer quorum
  from 1 through 10; omitted contracts retain the default of 1;
- approval policy rules: `{ "field": "...", "max": 2500 }` thresholds for
  integer patched fields. A rule field is numeric when the proposal declares
  `numeric_bounds` for it, patches it from a `NUMBER` arg, or patches it from
  an integer literal.
- proposal `operation.kind`: `update`, `insert`, or `delete`; omission preserves
  the legacy single-row UPDATE meaning;
- INSERT `operation.deduplication`: reviewed components supplied from trusted
  tenant, proposal identity, or a fixed value and enforced by a source unique
  key;
- UPDATE `operation.version_advance`: reviewed integer increment or
  database-generated advancement of the exact conflict guard.
- bounded-set `operation.cardinality = "set"`, fixed typed `selection`,
  `max_rows` (hard ceiling 100), aggregate bounds, exact batch item source, and
  source-unique per-item deduplication. Runner 1.3 requires human/operator
  approval and freezes the exact set before apply.
- proposal `reversibility.mode = "reviewed_inverse"`: opt-in portable authority
  to capture a bounded inverse for direct SQL and create a separately approved
  compensation proposal. It does not authorize automatic or model-facing
  rollback.

Receipt authority, receipt-table provisioning, credentials, and Runner ledger
topology are deliberately not canonical fields. They remain deployment choices
in `synapsor.runner.json`.

These are not `x-runner-*` extensions because they are part of the reviewed
contract. A Cloud importer may choose when to enforce them, but it must not
silently drop or reject them as unknown runner-only metadata. This OSS release
proves bounded-set and reviewed-compensation execution in Runner only; it does
not claim proprietary Cloud/C++ execution support for the new fields until
independently verified.

## Stability

`0.1` is the first shared contract line. It is intended to be useful and
testable, but not yet a frozen v1 compatibility promise. New behavior should
arrive behind optional fields or explicit extension keys until promoted.
