# DSL / JSON Parity Matrix

Status: Synapsor contract `0.1`.

`@synapsor/spec` is the canonical contract. `@synapsor/dsl` is an authoring
layer that compiles into that JSON. `@synapsor/runner` and Synapsor Cloud should
consume the same contract shape instead of inventing separate semantics.

Author DSL files as `contract.synapsor.sql` when possible so editors provide
generic SQL highlighting. The legacy `contract.synapsor` suffix remains
supported, and both filenames compile to the same canonical JSON.

Legend:

- Supported: validated and preserved.
- Enforced: runtime checks the field before exposing or applying behavior.
- Preview: accepted as a contract declaration, but not a full local runtime
  engine.
- Not supported: fails clearly or is documented as intentionally absent.

| Field / semantic | JSON spec | DSL syntax | Compile output | Runner load | Runner enforcement | C++/Cloud import/export | Cloud push | Tests / notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Context names | Supported | `CREATE AGENT CONTEXT` | Supported | Supported | Referenced by capabilities/workflows | Supported | Supported | Spec, DSL, runner, C++ fixtures |
| Capability names | Supported | `CREATE CAPABILITY` | Supported | Supported | Exposed as semantic MCP tools | Supported | Supported | Raw SQL/approval/commit tools remain absent |
| Workflow names | Supported | `CREATE AGENT WORKFLOW` | Supported | Loaded as declaration | Preview only; runner does not execute full DAGs | Supported as declaration | Supported | Do not claim workflow DAG execution |
| Policy names | Supported | Approval policy emitted by `AUTO APPROVE WHEN` | Preserved where represented | Loaded | Limited/local | Supported/preserved or rejected clearly | Supported | Rich policy packs are Cloud/paid surface |
| Contract description | Supported in `metadata.description` | Via metadata/examples | Preserved | Preserved | Not behavior-affecting | Supported | Supported | Useful for registry display |
| Context description | Supported | Preview/partial | Preserved when present | Preserved | Not behavior-affecting | Supported | Supported | Unknown fields fail unless extension-prefixed |
| Capability description | Supported | `DESCRIPTION '...'` | Supported | Tool metadata | Model-facing description | Supported | Supported | CLI tests inspect generated metadata |
| Argument description | Supported | `ARG ... DESCRIPTION '...'` | Supported | Input schema | Model-facing schema | Supported | Supported | Required args validated |
| Returns hint | Supported as `returns_hint` | `RETURNS HINT '...'` | Supported | Tool metadata | Model-facing output guidance | Supported | Supported | Strict DSL warns when missing on proposals |
| Arg name/type/required | Supported | `ARG name TYPE REQUIRED` | Supported | Input schema | Required/type validation | Supported | Supported | Model trust args rejected |
| Primary-key lookup | Supported as `lookup.id_from_arg` | `LOOKUP arg BY primary_key` | Supported; non-primary columns fail | Loaded | One fixed primary-key row | Supported | Supported | Compiler rejects `LOOKUP_COLUMN_UNSUPPORTED` rather than rewriting intent |
| Arg max length | Supported | `MAX LENGTH n` | Supported | Input schema | Enforced where runtime has input schema checks | Supported | Supported | String patterns are not yet supported |
| Arg numeric bounds | Supported | `ARG amount NUMBER MIN n MAX m` and `BOUND field n..m` | Supported | Input schema/proposal metadata | Enforced before proposal/apply where patch binding is known | Supported | Supported | Numeric-bounds fixture |
| Arg enum | Supported in JSON | Not expressible in DSL 0.1 | Preserved if in JSON | Loaded into schema | Enforced by schema validation where present | Supported/rejected clearly by validator | Supported | Use canonical JSON when an enum is required |
| Defaults / nullable | Not stable in 0.1 | Not supported | Fails as unknown core fields | Not supported | Not supported | Rejected unless extension-prefixed | Rejected | Avoid implying defaulted args |
| Visible fields | Supported | `ALLOW READ ...` | Supported | Read/proposal field map | Only visible fields can be returned | Supported | Supported | Kept-out overlap rejected |
| Kept-out fields | Supported | `KEEP OUT ...` | Supported | Hidden from tool schemas/results | Must not leak into evidence/replay/proposal surfaces | Supported | Supported | Kept-out conformance fixture |
| Hidden/model-forbidden fields | Represented by kept-out/trusted bindings | `KEEP OUT`, trusted context bindings | Supported | Supported | Raw table/column args rejected | Supported | Supported | No raw table/column model args |
| Session/tenant/principal bindings | Canonical `SESSION` plus `ENVIRONMENT`, `HTTP_CLAIM`, `CLOUD_SESSION`, and `STATIC_DEV` | `BIND ... FROM source`, `TENANT BINDING`, `PRINCIPAL BINDING` | Preserved; `--target runner` rejects `SESSION` | Runner rejects `SESSION`; implemented providers load normally | Model cannot supply tenant/principal authority; verified HTTP/Cloud claims remain distinct from process environment | C++/Cloud implements typed `SESSION` | Supported as canonical content | Runner commands fail `SESSION_BINDING_UNSUPPORTED`; no environment fallback |
| Evidence required | Supported | `REQUIRE EVIDENCE` | Supported | Loaded | Evidence/query audit recorded by runner flows | Supported | Supported | Read/proposal fixtures |
| Evidence options | Supported as `sources`, `query_audit`, `handle_prefix` | Partial | Preserved when present | Loaded | Query audit/evidence handles where supported | Supported/preserved | Supported | More DSL clauses may be added later |
| Proposal action | Supported | `PROPOSE ACTION ...` | Supported | Loaded | Proposal created instead of commit | Supported | Supported | Proposal conformance fixture |
| Allowed write fields | Supported | `ALLOW WRITE ...` | Supported | Loaded | Apply rejects widening beyond reviewed fields | Supported | Supported | Contract-authored apply regression |
| Patch bindings | Supported | `PATCH field = value/ARG arg` | Supported | Loaded | Direct SQL/app handler payload generation | Supported | Supported | Direct/app-handler tests |
| Numeric proposal bounds | Supported | `BOUND field min..max` | Supported | Loaded | Out-of-bounds proposals rejected | Supported | Supported | Numeric-bounds rejection test |
| Transition guards | Supported in JSON | `TRANSITION ...` preview | Preserved | Loaded | Enforced only where runner has enough current-row state | Supported/preserved | Supported | Metadata preservation test |
| Approval requirement | Supported | `APPROVAL ROLE ...` | Supported | Loaded | Approval remains outside MCP | Supported | Supported | No model-facing approve tool |
| Approval policy | Supported | `AUTO APPROVE WHEN field <= integer` after `APPROVAL ROLE` | Emits `approval.mode=policy`, `approval.policy`, and `policies[]` approval rules | Loaded | Runner may auto-approve; never auto-applies | Must preserve `approval.policy` and `policies[]` | Supported | Auto-approval conformance fixture |
| Writeback direct SQL | Supported | `WRITEBACK DIRECT SQL` | Supported | Loaded | Guarded single-row INSERT/UPDATE/DELETE | New operation fields require independent Cloud/C++ adoption | New operation fields require independent Cloud/C++ adoption | `test:guarded-crud` on Postgres/MySQL |
| Bounded set writeback | Supported as operation cardinality, typed selection/batch, row/value caps | `UPDATE|DELETE SET`, fixed `SELECT WHERE`, `INSERT SET`, typed `ITEM FIELD`, `MAX ROWS`, `MAX TOTAL` | Supported | Supported | Fixed/frozen/atomic Postgres/MySQL execution; human approval only; hard cap 100 | Not claimed until independently implemented and verified | Registry may preserve; execution support not claimed | R1-R7 conformance plus `test:bounded-set` |
| Reviewed reversibility | Supported as `proposal.reversibility.mode = reviewed_inverse` | `REVERSIBLE` | Supported | Supported | Direct SQL only; bounded inverse after unambiguous apply; operator revert creates a new proposal; no model-facing rollback | Canonical field must be preserved; Cloud/C++ execution not claimed until independently verified | Registry may preserve; execution support not claimed | Reversible-change-set conformance plus `test:reversible` |
| Writeback handler | Supported | `WRITEBACK APP HANDLER EXECUTOR name` | Supported | Loaded | Runner POSTs approved proposal to configured executor | Supported as contract intent | Supported | Handler URL/token stay in runner config, not contract |
| Idempotency metadata | Supported where represented | Limited | Preserved if present | Loaded | Receipts/idempotency guard local writes | Supported/preserved | Supported | Do not store credentials |
| x-cloud-* extensions | Supported in documented object locations | Not first-class syntax; JSON preserved | Preserved if present | Loaded/preserved | Not behavior unless known | Preserved or rejected clearly | Supported | Unknown unprefixed fields fail |
| x-runner-* extensions | Supported | Not first-class syntax; JSON preserved | Preserved if present | Loaded/preserved | Runner-specific where documented | Preserved | Supported | Keep separate from core semantics |
| x-experimental-* extensions | Supported | Not first-class syntax; JSON preserved | Preserved if present | Loaded/preserved | Experimental only | Preserved | Supported | Do not market as stable |
| Generated pseudo-syntax | Not supported | `ROOT EXTERNAL`, `JOIN EXTERNAL`, `RETURN ANSWER WITH CITATIONS`, `AUTO MERGE` fail | Fails clearly | Not loaded | Not applicable | Rejected unless promoted to spec | Rejected | These are not public 0.1 DSL |
| Cloud push dry-run | N/A | N/A | Normalized payload | N/A | No network call | N/A | Supported | `cloud push --dry-run --json` |
| Cloud push upload | N/A | N/A | Normalized payload POST | N/A | N/A | Cloud validates server-side | Supported | `/v1/control/projects/:project_id/agent-contracts` |
| Cloud registry versioning | N/A | N/A | N/A | N/A | N/A | Project-scoped registry | Supported | Identical digest is idempotent; changed digest creates new version |
| Runner bundle export | N/A | N/A | N/A | N/A | N/A | Backend bundle endpoint | Supported as backend foundation | Includes placeholders only, no secrets |

## Current Intentional Limits

The runner can declare workflows in contracts, but it does not execute full
workflow DAGs, settlement policies, native Synapsor branches, or auto-merge
logic locally. Those remain Cloud/C++ platform features unless separately
implemented in the OSS runtime.

Contracts must not contain database URLs, API tokens, private keys, passwords,
or row data. Local runner config stores environment variable names. Cloud push
stores normalized contract JSON and audit metadata only.
