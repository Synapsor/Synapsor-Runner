# Trusted Core Architecture

This document maps the parts of Synapsor Runner that decide what a model may
observe, what it may propose, what a human or reviewed policy may authorize,
and what a separately trusted process may commit. It describes code ownership,
not a second specification. Public behavior remains defined by the canonical
Spec, reviewed Runner configuration, protocol records, and tests.

## Dependency Direction

The trusted core follows this package direction:

```text
@synapsor-runner/protocol
            |
            v
@synapsor-runner/proposal-store
            |
            v
@synapsor-runner/mcp-server
            |
            v
@synapsor/runner
```

The MCP runtime also consumes the lower-level config, control-plane client,
Postgres adapter, schema inspector, and public `@synapsor/spec`. The Runner CLI
is the top-level composition layer and may consume all of those packages plus
the DSL compiler, MySQL adapter, and worker core.

`scripts/check-trusted-core-dependencies.mjs` parses production TypeScript
imports with the TypeScript compiler API. It rejects:

- a cycle in any of the three trusted-core source trees;
- proposal-store importing MCP-server or Runner;
- MCP-server importing Runner;
- implementation modules importing their `index.ts` or `cli.ts` compatibility
  facade;
- imports that violate the within-package layers below;
- a compatibility facade above its physical-line guardrail.

The check runs in the root `test` command and can be run directly with:

```bash
corepack pnpm check:trusted-core-dependencies
```

## Compatibility Facades

These entry files preserve existing import and executable behavior:

| Facade | Role |
| --- | --- |
| `packages/proposal-store/src/index.ts` | Explicit public type/value exports and `ProposalStore` constructor compatibility |
| `packages/mcp-server/src/index.ts` | Explicit MCP runtime, transport, authority, and helper exports |
| `apps/runner/src/cli.ts` | Shebang-bearing command registry, executable bootstrap, and explicit public helper wrappers |

No lower module imports one of these facades. The facade is allowed to point
inward; implementation code must depend on the actual owner module.

## Proposal Store

The proposal store is the durable authority below both MCP and the CLI.

| Responsibility | Owner |
| --- | --- |
| Public records and store interfaces | `domain-types.ts` |
| Stable coded errors | `errors.ts` |
| Proposal identity, integrity, and freshness parsing | `proposal-integrity.ts` |
| Filtered SQL fragments for ledger queries | `query-builders.ts` |
| Writeback intent and receipt semantics | `writeback-domain.ts` |
| Attention event normalization | `attention-domain.ts` |
| Operator-bound worker-control decisions | `worker-control-domain.ts` |
| Shadow outcome classification | `shadow-analysis.ts` |
| Durable row encoding and decoding | `record-codecs.ts` |
| Shared-ledger restore ordering and mapping | `shared-ledger-domain.ts` |
| SQLite schema and lifecycle | `sqlite-schema-methods.ts`, `sqlite-core-methods.ts` |
| Proposals, evidence, approvals, events, and query audit | `sqlite-proposal-methods.ts` |
| Intents, idempotency, receipts, replay, and reconciliation | `sqlite-writeback-methods.ts` |
| Worker queues, leases, retry, controls, and dead letters | `sqlite-worker-methods.ts` |
| Metrics and policy recommendations | `sqlite-metrics-policy-methods.ts` |
| Attention and notification outboxes | `sqlite-attention-methods.ts` |
| Cloud outbox and governance state | `sqlite-cloud-control-methods.ts` |
| Shadow studies | `sqlite-shadow-methods.ts` |
| SQLite composition | `sqlite-store.ts` |
| Shared-Postgres runtime and fleet-intent adapters | `postgres-runtime-store.ts` |

The enforced internal direction is:

```text
facade -> adapters -> repositories -> foundations
             |              |
             +--------------+
```

Adapters may compose adapters, repositories, and foundations. Repository
modules may use foundations only. Foundation modules may use other foundations
only. The complete graph must remain acyclic.

SQLite and Postgres schema text, migration order, record encodings, integrity
checks, busy-timeout behavior, state transitions, and receipt/replay semantics
remain owned here. MCP and CLI code do not maintain alternate persistence
implementations.

## MCP Runtime

The MCP package owns the model-facing boundary and the trusted data-plane
runtime.

| Responsibility | Owner |
| --- | --- |
| Public/internal runtime and transport contracts | `runtime-types.ts` |
| Capability operation and writeback authority | `capability-authority.ts` |
| Trusted tenant, principal, and credential context | `trusted-context.ts` |
| Runtime configuration normalization | `runtime-config.ts` |
| Generated-boundary lock and drift preflight | `generated-authority.ts` |
| Parameterized row and aggregate query plans | `read-planning.ts` |
| Source pools, credentials, rate limits, and RLS/session binding | `source-runtime.ts` |
| Protected reads, suppression, extraction budgets, and analytical audit | `protected-read-runtime.ts` |
| Proposal evidence and pre-approval freshness evaluation | `proposal-freshness.ts` |
| Immutable proposal construction | `proposal-builder.ts` |
| Deterministic approval-policy evaluation | `approval-policy.ts` |
| Tool names, schemas, annotations, and registration catalog | `tool-catalog.ts`, `tool-naming.ts` |
| Canonical tool dispatch | `tool-dispatch.ts` |
| Result envelopes and stable refusal output | `result-envelope.ts`, `runtime-errors.ts` |
| Read-only proposal/evidence/replay resources | `local-resources.ts` |
| Runtime and official MCP server composition | `runtime-composition.ts`, `server-composition.ts` |
| Cloud-linked outbox coordination | `cloud-linked.ts` |
| JWT verification | `jwt-auth.ts` |
| HTTP auth, TLS, OAuth-resource, host, CORS, and network checks | `http-security.ts` |
| HTTP and Streamable HTTP sessions/transports | `http-transport.ts` |
| Readiness and operational metrics | `runtime-observability.ts` |
| Safe hashes, bounded values, logging, and redaction | `safe-values.ts`, `runtime-logging.ts` |

The enforced internal direction is:

```text
facade -> transport -> composition -> services -> foundations
                         |             |
                         +-------------+
```

Composition modules may compose one another, services, and foundations.
Services may use services and foundations. Foundations may use foundations
only. No service or foundation may depend on transport or composition.

The tool catalog and dispatcher are the only model-facing operation registry.
Read plans are built only from typed capability or activated exploration
authority. Trusted tenant/principal values are resolved separately and injected
by the runtime. Tool arguments cannot introduce SQL, identifiers, tenant or
principal authority, activation, approval, apply, worker, notification, or
recovery authority.

## Runner CLI

The CLI is the operator and developer composition plane. Its facade dispatches
to focused command owners:

| Command area | Owners |
| --- | --- |
| Arguments, help, output, files, and redaction | `cli-options.ts`, `cli-help.ts`, `cli-format.ts`, `cli-files.ts`, `cli-logging.ts` |
| Project, config, and local-store resolution | `cli-project.ts`, `config-domain.ts`, `config-inspect.ts` |
| Onboarding, boundary review/activation, and Workbench | `guided-start.ts`, `onboarding.ts`, `boundary-commands.ts`, `ui-command.ts` |
| Safe Action authority, design, suggestions, immutable revisions, and terminal control plane | `action-authority.ts`, `action-design.ts`, `action-suggestions.ts`, `guided-action.ts`, `action-tui.ts` |
| Safe Action operator inbox and disposable rehearsal | `action-operator.ts`, `guided-action-runtime.ts` |
| MCP serving, project installers, audit, and runtime | `mcp-runtime.ts`, `mcp-project.ts`, `mcp-audit.ts`, `runtime-commands.ts` |
| Contracts, DSL, tests, policy, reports, and effect regression | `contract-commands.ts` |
| Proposal/evidence/receipt/replay browsing | `proposal-ledger.ts`, `ledger-commands.ts`, `proposal-formatting.ts` |
| Approval, guarded apply, revert, and reconciliation | `apply-commands.ts`, `guarded-apply.ts`, `writeback-execution.ts`, `writeback-setup.ts` |
| Supervised workers and approval-policy revalidation | `worker-runtime.ts`, `worker-policy.ts` |
| Human attention and notifications | `attention-domain.ts`, `attention-notifications.ts` |
| Shared ledger, Cloud synchronization, shadow, and proof flows | `store-shared.ts`, `cloud-commands.ts`, `shadow-commands.ts`, `try-commands.ts` |

Runner command modules form an acyclic implementation graph below `cli.ts`.
The checker intentionally does not invent a second package hierarchy inside
this mature orchestration layer. Instead, it enforces the important direction:
implementation modules may depend on implementation owners, never back through
the executable/public facade.

The CLI does not become a second mutation engine. Manual apply, batch apply,
Workbench apply, and supervised-worker apply converge on the same guarded apply
and writeback implementation. Operator actions pass through the existing
identity verification and immutable decision records.

The terminal Action control plane and preview Workbench are adapters over the
same domain services. A bounded `ActionSuggestion` may reorder exact structural
candidates, but its schema excludes trusted scope, approval, writeback,
execution, credentials, and SQL. `ActionDesign` compiles through the public DSL
and canonical Spec path into an immutable disabled revision. Rehearsal invokes
the real semantic proposal path with a disposable ledger and must prove that
the source stayed unchanged. Activation recomputes the exact digest and archives
the revision before updating the separate action-runtime config.

Local Ask treats `/actions` as an operator-shell handoff, not a model tool. It
closes the current read gateway, passes only the current provider/model and
memory-only credential to the optional suggestion adapter, and resumes the same
conversation after the TUI closes. Intent ranking is deterministic over
reviewed metadata; unique structural guards may be preselected, but business
bounds and authority are never inferred. Interactive rehearsal values are
validated against the generated contract. Interactive confirmations carry the
selected full digest/hash internally, while non-interactive commands retain
explicit full-digest/hash inputs. Proposal inbox count and page rows are read
from one proposal-store snapshot, including when a shared Postgres runtime
ledger is bridged read-only.

Changing execution posture never edits an active revision. It creates another
disabled digest. Each proposal freezes the contract digest and writeback mode
under which it was created, so promotion cannot make older proposal-only
records executable. See [Safe Action Human Control
Plane](safe-action-control-plane.md).

## Input Trust

Inputs are treated according to their source, not their shape.

### Model-controlled

- MCP tool names and arguments;
- model-generated prose and provider responses;
- requested filters, measures, dimensions, buckets, and values within an
  already activated exploration boundary;
- proposal requests within an activated named capability.

These values are validated, bounded, and treated as untrusted. They cannot
select credentials, tenant/principal authority, SQL identifiers outside the
reviewed boundary, activation, approval, commit, workers, notification sinks,
or recovery actions.

### Trusted runtime or operator inputs

- activated canonical contract and exact digest;
- environment/session/verified HTTP-claim context;
- database credentials resolved from operator-owned environment or credential
  resolver;
- verified operator identity and roles;
- deployment profile and exact supervised-worker allowlist;
- human boundary, capability, proposal, and recovery decisions;
- generated-authority lock and schema/role-posture fingerprints.

Being in this category does not skip validation. Digests, identity proof,
freshness, scope, policy, limits, role posture, and state are rechecked at the
relevant boundary.

## Side Effects

| Side effect | Authorized owner/path |
| --- | --- |
| Source database read | MCP `read-planning.ts` / `protected-read-runtime.ts` through `source-runtime.ts` |
| Source database mutation | Runner guarded apply through `writeback-execution.ts` and the existing database adapters, outside MCP |
| Proposal/evidence/audit persistence | Proposal-store repository methods |
| Approval/decision/event persistence | Proposal-store append/state methods after operator or policy validation |
| Receipt/replay/reconciliation persistence | Proposal-store writeback methods |
| Worker leasing and dead-letter state | Proposal-store worker methods, driven by Runner worker commands |
| Notification outbox/delivery state | Proposal-store attention methods, dispatched by Runner notification commands |
| Cloud outbox state | Proposal-store Cloud methods, coordinated by MCP/Runner Cloud-linked owners |
| Config, contract, DSL, lock, and test artifacts | Runner guarded file helpers and onboarding/authoring owners |
| HTTP/JWT/TLS sessions | MCP HTTP security and transport owners |

The model-facing MCP surface can read within reviewed authority and create
immutable proposals. It cannot approve or invoke any source mutation path.
With supervised automatic apply enabled, a model-originated bounded request may
eventually produce a database effect only after digest-bound human policy,
deployment opt-in, queue leasing, and complete guarded revalidation by the
separately trusted worker.

## Compatibility And Audit Gates

`scripts/trusted-core-baseline.mjs` compares the refactored build with the
pre-refactor baseline for:

- public declaration symbols and signatures;
- exact CLI help;
- package exports, files, bin, versions, and dependency surface;
- MCP tool names, ordering, and schemas;
- exact generated SQL and parameter order;
- canonical contract digest;
- shared-Postgres migration SQL;
- deterministic proposal, policy, event, attention, and approval transitions.

Packed-artifact gates additionally exercise clean installation, executable
behavior, published-contract compatibility, generated authority, onboarding,
freshness, scope, guarded writes, replay, and fleet behavior.

`scripts/make-runner-declarations-portable.mjs` runs during Runner packaging.
It preserves the captured public `./cli` and `./shadow` symbol/signature
surfaces while structurally resolving the internal workspace types those
signatures use. The packed declarations therefore do not depend on unpublished
`@synapsor-runner/*` packages, repository-local absolute paths, or extracted
source files omitted by the unchanged package `files` list.
`scripts/verify-packed-runner.sh` installs the tarball in a clean consumer,
compiles all four public declaration entrypoints with `skipLibCheck: false`,
and rejects internal or repository-local declaration references.

`development/trusted-core-fixtures/pre-refactor-8989163-ledger.db` was created
by the pre-refactor `ProposalStore`. A characterization test copies it,
validates its synthetic proposal/evidence/audit/approval/receipt/replay records,
appends a new proposal through the current store, and reopens it. The fixture
pins SQLite schema, migration, codec, and ordinary read/write compatibility
without entering the published Runner tarball.

## Remaining Hotspots

The three target entry monoliths are now thin facades. Larger pre-existing
Runner modules remain:

- `local-ui.ts`: approximately 6,806 lines;
- `auto-boundary.ts`: approximately 2,443 lines;
- `boundary-workbench.ts`: approximately 2,255 lines;
- `scoped-explore.ts`: approximately 1,889 lines.

They were not split in this behavior-preserving task because they were not one
of the three authorized targets and mixing additional extraction into the
trusted-core checkpoints would enlarge review risk. They are explicit future
auditability candidates, not hidden inside a compatibility facade.
