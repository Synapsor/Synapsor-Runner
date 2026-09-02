# Safe Action Human Control Plane

Synapsor Safe Actions let an agent request an `INSERT`, `UPDATE`, or `DELETE`
business effect without giving that agent SQL, database credentials, approval,
activation, or commit authority.

The terminal control plane is the preferred authoring and operator interface.
From an active local Ask session, enter:

```text
synapsor> /actions
```

The same provider, model, in-memory credential, and conversation resume when
the control plane closes. The direct shell entry remains:

```bash
synapsor-runner action review --project-root .
```

The preview Workbench and non-interactive commands call the same domain APIs.
The public DSL, canonical Spec JSON, generated tests, runtime validation, and
proposal ledger remain the source of truth. The TUI is not a second policy
engine.

## The Mental Model

Six nouns explain the whole lifecycle.

| Term | Meaning | Grants authority? |
| --- | --- | --- |
| **Read Boundary** | The reviewed tables, fields, relationships, scope, and limits Runner may use to inspect current state. | Yes, read authority only after activation. |
| **Action Boundary** | The reviewed set of exact action revisions, Read Boundary dependencies, approval policies, execution profiles, and cross-action limits for one agent job. | Yes, proposal authority only after exact activation; it does not itself approve or apply. |
| **ActionSuggestion** | Bounded convenience metadata naming an intent and possible resource, operation, and fields. | No. It cannot contain approval, execution, credentials, trusted identity, writeback, or SQL. |
| **ActionDesign** | The human-reviewed choices and the schema proofs behind one business action. | Not by itself. It compiles a disabled revision. |
| **ActionRevision** | One immutable semantic action: DSL, canonical JSON, tests, review explanation, exact digest, and authority posture. | Only when referenced by the exact active Action Boundary after rehearsal and activation. |
| **Proposal** | One immutable requested effect, bound to the exact action digest, trusted scope, target, before/after state, guards, and approval posture. | It may become eligible for a separate approval and execution path. It is not itself a commit. |

The normal progression is:

```text
schema proofs
  -> optional untrusted suggestion
  -> human ActionDesign review
  -> disabled ActionRevision
  -> disposable source-unchanged rehearsal
  -> disabled Action Boundary revision
  -> exact action and Action Boundary activation
  -> agent invokes one semantic action
  -> immutable proposal
  -> outside-model approval
  -> trusted executor rechecks every guard
  -> commit plus receipt
```

At no point does Runner turn the model into a database administrator.

For a new agent, Action Assist follows read setup rather than creating a second
onboarding system. Compile representative reads with `W Workloads`, complete
the exact read review, then press `Y Safe actions`. Drafting and disposable
rehearsal may happen before read activation; activating the proposal action may
not. Workbench uses the equivalent **Compile read workload -> Add safe action**
path and keeps both activation decisions explicit. The handoff shares reviewed
structural evidence only; read authority never implies write permission, and
each Action revision retains its own rehearsal, digest, activation, approval,
and execution posture. See
[Boundary Assist](read-workload-boundary-assist.md).

The default path is one proposal-action card, not the full authority wizard.
Runner uses the business-intent sentence only to rank reviewed structural
candidates, asks about ambiguity or missing bounds, saves a disabled revision,
and runs generated bounded arguments through a disposable proposal ledger.
One later confirmation activates proposal creation only. **Advanced action
design** retains fixed values, transitions, custom approval, execution,
receipts, workers, exact DSL, and manual rehearsal controls.

Drafting and rehearsal may use a fully reviewed read revision that is not yet
active. The disabled action records the exact read boundary name and digest.
That convenience grants no authority: proposal-action activation refuses until
the same digest is active, and a changed read revision requires a new action
review.

## Trusted Scope Is Configured Once

The Read Boundary is the authority source for agent identity isolation. During
read review, the operator chooses one reviewed posture:

- a direct trusted tenant column, with an optional direct principal column;
- database-enforced scope such as reviewed PostgreSQL RLS; or
- one frozen whole-organization identity when the source has no tenant model.

The Action Boundary does not ask for a second tenant policy. It records the
exact Read Boundary name, digest, generation lock, and trusted-context
fingerprint, and each action points to that dependency. A changed Read Boundary
therefore makes the dependent action stale instead of silently changing its
scope.

For local stdio, Runner resolves reviewed tenant/principal bindings from the
configured trusted environment or local provider. For production HTTP, it uses
the verified JWT/OAuth session claims on every request. Those values never
appear as model arguments, and attempts to send `tenant_id`, `principal`, or
other reserved authority fields are refused before proposal creation.

The Action TUI and Workbench show the inherited scope beside every action. A
managed write currently requires direct action scope; a relationship-derived
read path does not become write authority. Shared approval circuit breakers may
then be reviewed per tenant, tenant plus principal, tenant plus object, exact
capability, or the whole Action Boundary.

## Human Control Plane And Agent Data Plane

The human control plane may:

- choose a structurally eligible table and operation;
- select exact fields and value sources;
- set numeric bounds, text limits, enums, and state transitions;
- confirm trusted tenant and principal scope;
- compose exact action revisions into one Action Boundary and set shared limits;
- select conflict, version, and insert-deduplication guards;
- require one reviewer or a quorum;
- define deterministic policy approval thresholds;
- select proposal-only, manual execution, or supervised execution posture;
- choose receipt and executor posture;
- rehearse, activate, promote, demote, approve, reject, apply, replay, and audit.

The model-facing data plane may only:

- discover an already active semantic action tool;
- supply its bounded business arguments;
- receive a proposal, refusal, or reviewed execution outcome.

The model-facing catalog never includes generic authoring, activation,
approval, apply, policy, credential, transaction, or SQL tools. This rule is
identical over local stdio MCP, the local Ask shell, and authenticated
Streamable HTTP MCP.

## States Shown To An Operator

Runner deliberately distinguishes evidence from authority.

| State | What it says |
| --- | --- |
| `PROVEN` | Database metadata proves a structural candidate, such as a primary key, non-generated field, conflict column, unique insert identity, or direct scope column. It does not prove business permission. |
| `SUGGESTED` | A bounded suggestion matches current structural candidates and may be opened for review. |
| `BLOCKED` | A suggestion or operation cannot satisfy current structural requirements. No weaker fallback is used. |
| `STALE` | The activated Read Boundary digest changed after the suggestion or draft was created. It must be regenerated or reviewed again. |
| `REVIEWED` | A suggestion was used to create a disabled exact-digest ActionRevision. This still does not mean active. |
| `ACTIVE` | A human activated that exact rehearsed digest. Only its semantic tool is added to the selected action runtime. |

An imported suggestion only changes ordering in the review UI. The operator
still reviews every authority-bearing choice or explicitly selects the bundled
proposal-only safe rollout.

## What Runner Can Prove From The Schema

Runner starts from a fully reviewed Read Boundary revision and a fresh database
inspection. Drafting and rehearsal may use that exact pending revision;
proposal activation still requires the same Read Boundary digest to be active.
For managed Safe Actions, a resource must currently have a direct reviewed
tenant key. If principal scope is required, it must be either a direct reviewed
column or an effective reviewed PostgreSQL RLS session setting. Runner applies
the latter transaction-locally and accounts deterministic shared limits per
trusted tenant plus principal. A relationship-carried read path does not
silently become write authority.

Runner evaluates Action fields independently from the Read Boundary's row-return
list. It excludes generated, identity, immutable, scope-owned, and structurally
kept-out fields from write candidates. The operator then reviews the exact
mutable fields and value grammar for the action. If conflict validation,
before-state policy, or evidence needs an exact field that Explore does not
return, the action contract makes that field Runner-readable and model-withheld;
it does not widen Read Boundary output. Structurally kept-out fields remain
unavailable. Runner then evaluates each operation:

A reviewed row identity may be one column of a composite source primary key
only when every other primary-key column is a direct trusted tenant or
principal scope column supplied by Runner. For example, `(tenant_id,
student_id)` may use `student_id` as the proposal row identity because Runner
also binds `tenant_id` outside model arguments. `(tenant_id, region_id,
student_id)` stays blocked unless `region_id` is itself reviewed direct trusted
scope. INSERT additionally requires a source-unique deduplication identity.

| Operation | Structural prerequisites | Required reviewed controls |
| --- | --- | --- |
| `UPDATE` | Writable base table, exact primary-key lookup, at least one eligible field, and a source-proven conflict/version column. | Exact fields and patches, bounds/transitions, conflict check, at most one affected row, approval, and execution posture. Runner-ledger direct SQL also requires reviewed version advancement. |
| `INSERT` | Writable base table, eligible required fields, and a primary/unique identity that can include trusted tenant plus proposal identity for retry deduplication. | Exact inserted fields, trusted tenant/principal injection, bounds/enums, dedup key, approval, and execution posture. Generated and scope-owned values never come from the model. |
| `DELETE` | Writable base table, exact primary-key lookup, conflict/version column, and no inspected trigger or cascading-reference shape that could widen the effect. | Exact `DELETE schema.table` confirmation and human approval. Hard delete cannot use automatic approval or supervised automatic execution. |

If the intended business operation is a soft delete, review an `UPDATE` that
sets an exact status transition instead of granting hard `DELETE`.

Names and ORM hints may help presentation, but they never establish scope,
identity, uniqueness, cardinality, conflict, or write authority.

## Review Value Semantics, Not Just Columns

Selecting a column is insufficient. Runner also requires the value grammar.

- **Argument value:** the agent supplies one typed bounded value.
- **Fixed value:** the revision freezes a constant chosen by the reviewer.
- **Enum value:** the argument or fixed value must be in the reviewed database
  or contract allowlist.
- **Numeric value:** the revision may set minimum and maximum bounds.
- **Text value:** the revision sets a maximum length.
- **State transition:** an update may name exact allowed previous states and a
  reviewed next state.

The model cannot send a formula, SQL expression, dynamic field name, tenant,
principal, executor, policy threshold, or approval mode.

## Approval And Execution Are Separate Axes

Approval answers, "May this exact proposed effect proceed?" Execution answers,
"Which trusted component may perform the already-approved effect?"

| Approval posture | Behavior |
| --- | --- |
| Human | One verified reviewer with the exact role approves the proposal. |
| Quorum | Between 2 and 10 distinct verified reviewers approve the same proposal hash. |
| Deterministic policy | Runner evaluates a reviewed conjunction over bounded numeric ranges, enums, booleans, text length, and captured pre-change facts. Rolling count/total limits may narrow one action or the whole Action Boundary. A failed or indeterminate check falls back to human review. The model cannot select or alter policy. |

| Execution posture | Canonical writeback | Source effect |
| --- | --- | --- |
| `proposal_only` | `WRITEBACK NONE` | Impossible for proposals created under this revision. |
| `executable` | `DIRECT SQL`, reviewed app handler, or cloud worker | Possible only after separate approval and an operator/trusted executor call. |
| `supervised_execution` | `DIRECT SQL` plus `ALLOW SUPERVISED WORKER APPLY` | A separately deployed exact-digest worker may apply eligible approved proposals after repeating every guard. |

Proposal-only is the default and recommended first rollout. An operator may
explicitly review a stronger initial revision when the deployment requires it;
there is no silent promotion. Any later posture change creates a new immutable
digest. Proposals retain the writeback mode recorded when they were created, so
an old proposal-only record never becomes executable after promotion.

Automatic approval is not automatic application. Even a policy-approved
proposal stays inert unless its exact revision and deployment separately allow
a trusted executor.

## Preferred Terminal Walkthrough

### 1. Activate A Read Boundary

Safe Action candidates inherit resource identity and trusted scope from an
already reviewed boundary. Start from a SELECT-only source credential:

```bash
synapsor-runner start --cli
```

Review and activate the read boundary, then open the Action control plane:

```text
synapsor> /actions
```

Outside Ask, run:

```bash
synapsor-runner action review --project-root .
```

The home screen shows active revisions, disabled drafts, bounded suggestions,
and the proposal/operator inbox.

### 2. Draft Without A Model

Choose **Create from business intent** and describe what the agent should be
allowed to propose. Runner uses reviewed IDs, labels, descriptions, and schema
proofs to rank candidates locally. It auto-selects a conflict or deduplication
guard only when exactly one source-proven candidate exists; ambiguity always
returns to the human.

The recommended path then walks through:

1. target resource;
2. `INSERT`, `UPDATE`, or `DELETE`;
3. fields and fixed/argument values;
4. numeric, text, enum, or transition constraints;
5. conflict/version or insert-dedup guard;
6. semantic capability name and business effect;
7. either the proposal-only safe rollout or advanced approval/execution;
8. trusted-scope confirmation;
9. complete AGENT MAY PROPOSE / RUNNER SUPPLIES / AGENT MAY NOT review.

The safe rollout freezes one `action_reviewer`, one approval, proposal-only
`WRITEBACK NONE`, no automatic approval, and no executor. **Customize approval
or execution** opens quorum, deterministic thresholds, executor, receipt,
worker, and compensation controls. Those decisions are progressive, not
inferred from the intent or model output.

The draft writes public DSL, canonical JSON, generated tests, an ActionDesign,
and a review explanation. Active tools and the source database remain
unchanged.

### 3. Optionally Import A Suggestion

An operator or coding agent may prepare this bounded object:

```json
{
  "schema_version": "synapsor.action-suggestion.v1",
  "intent": "Let support propose a bounded plan credit for one customer.",
  "operation": "update",
  "resource": "support.customers",
  "fields": ["plan_credit_cents"],
  "rationale": "This field is a structural candidate for human review.",
  "suggested_by": { "kind": "operator" }
}
```

Import and inspect it:

```bash
synapsor-runner action suggest \
  --input action-suggestion.json \
  --project-root . \
  --json

synapsor-runner action suggestions --project-root .
synapsor-runner action review --suggestion as_<digest> --project-root .
```

Suggestion files must remain under the project root. Unknown keys and
authority-bearing keys are rejected. The immutable suggestion is bound to the
current Read Boundary digest and becomes stale if that digest changes.

### 4. Optionally Ask A Model For One Suggestion

The operator can ask OpenAI, Anthropic, or an OpenAI-compatible endpoint for
one bounded suggestion. When opened through `/actions`, Runner can reuse the
current Ask provider, model, and memory-only credential after a separate
structural-metadata egress confirmation. The credential is not displayed,
persisted, or sent in model content. Opening `Y Safe actions` from `/access`
inside Ask reuses the same session. Standalone terminal review automatically
uses the default model for exactly one exported `OPENAI_API_KEY` or
`ANTHROPIC_API_KEY`; with both or neither configured, it asks rather than
guessing. The standalone command remains:

```bash
synapsor-runner action suggest \
  --intent "Let support propose a bounded plan credit" \
  --provider openai \
  --model gpt-5.6-terra \
  --api-key-env OPENAI_API_KEY \
  --acknowledge-egress \
  --project-root .
```

Runner sends only the business intent and exact structural candidate metadata:
resource IDs, supported operations, eligible field IDs, types, and reviewed
enums. It does not send source rows, credentials, database URLs, tenant or
principal values, kept-out fields, approval policy, writeback, or active
authority. The key is read from the named environment variable and is never
written into the suggestion.

The provider gets one internal structured-output opportunity. This is not an
MCP authoring tool, and the response remains untrusted until the ordinary human
review finishes.

### 5. Rehearse The Exact Disabled Revision

The default rehearsal is reusable and identity-free. Runner recompiles the
persisted DSL and verifies:

- it produces the exact reviewed contract digest;
- the expanded runtime configuration validates;
- generated arguments stay inside the reviewed type, enum, and numeric bounds;
- generated safety assertions belong to this exact Action revision;
- no runtime tenant or principal is resolved;
- no source row is read or changed.

An operator can later provide `--args` to run the actual semantic proposal path
against a configured runtime identity using a disposable ledger. That advanced
diagnostic derives typed values from the contract, validates the expected
target and proposal effect, and destroys the rehearsal proposal so it can never
be approved or applied.

### 6. Activate The Exact Action Boundary

Interactive activation shows the selected short digest, asks for a human
yes/no decision, then internally binds that decision to the full digest and
recomputes the artifacts. No digest copy/paste is needed in the TUI. Changed
artifacts, stale boundaries, or a missing exact rehearsal fail closed.

Headless and CI activation still requires the full
`ACTIVATE sha256:...` confirmation plus verified operator authority and nonce.

Activation copies immutable artifacts under a digest-addressed revision path,
publishes the exact action inside its matching Action Boundary revision, and
updates the separate action runtime last. It does not widen the production
Explore two-tool surface. Multiple disabled actions may be reviewed before any
activation; activating one rebases the remaining disabled Action Boundary
candidates without changing their immutable action contract digests.

From the Safe Action home, open **Review Action Boundary** to inspect its exact
actions, Read Boundary dependencies, inherited trusted scope, approval modes,
execution profiles, and shared limits. **Shared approval limits** can add a
rolling count or numeric total for one trusted tenant, tenant+principal,
tenant+object, capability, or the whole boundary. Editing creates a disabled
boundary revision. **Activate this exact boundary revision** remains a separate
operator decision and cannot approve a proposal or mutate a source row.

### 7. Invoke The Semantic Tool

Activation prints exact commands to inspect and test the separate action
runtime and install it for an MCP client. Equivalent commands are:

```bash
synapsor-runner try call --list \
  --config ./synapsor.actions.runner.json --format json

synapsor-runner try call support.propose_plan_credit --sample \
  --config ./synapsor.actions.runner.json --json

synapsor-runner mcp install claude-code --project \
  --config ./synapsor.actions.runner.json --yes
```

Use `cursor` or `vscode` in the final command for those clients. The client
sees a business tool such as:

```text
support.propose_plan_credit(customer_id, plan_credit_cents, reason)
```

It does not see `execute_sql`, `approve`, `apply`, `activate`, `set_policy`, or
trusted identity arguments. A proposal-only call returns an immutable proposal
and `source_database_changed: false`.

### 8. Review And Operate Proposals

Return to:

```bash
synapsor-runner action review --project-root .
```

Open **Proposal inbox and lifecycle** to page across the complete consulted
ledger, search capability/object/proposal metadata, and filter by lifecycle
state or age. Inspect exact effects, approve or reject with the configured
operator identity, apply eligible approved proposals, inspect receipts, and
create replay records. Count and page rows come from one consistent local or
shared-runtime-store snapshot. The TUI uses
the existing proposal, freshness, operator-identity, guarded-apply, receipt,
and evidence services; keyboard input has no special authority.

Interactive approve, reject, and apply decisions are bound internally to the
full current proposal hash; copied hashes are not a TUI burden. Headless
commands retain exact-hash requirements. Proposal-only records show apply as unavailable. An executable proposal is
still rechecked immediately before mutation for active digest, trusted scope,
approval/quorum, freshness, conflict/version, bounds, row count, idempotency,
and receipt authority.

## Promotion And Non-Retroactivity

Select an active action. **Create a replacement design revision** reopens the
reviewed fields, bounds, transitions, approval, and execution choices.
**Promote, demote, or replace execution posture** changes only the authority
posture. Both create a disabled digest while the current revision remains
active. A disabled draft may also be edited/replaced or discarded by exact
digest; neither operation mutates active authority or source rows.

For a scriptable direct-SQL promotion, place this inside the project root:

```json
{
  "authority": {
    "authority_posture": "executable",
    "writeback": { "mode": "direct_sql" },
    "receipt_mode": "runner_ledger",
    "write_url_env": "SYNAPSOR_DATABASE_WRITE_URL"
  }
}
```

Then run:

```bash
synapsor-runner action revise \
  --capability support.propose_plan_credit \
  --expected-digest sha256:<active-digest> \
  --answers promote.json \
  --project-root . \
  --json
```

Rehearse and activate the new digest. The archived proposal-only contract still
contains `WRITEBACK NONE`, and every proposal created under it remains
`read_only` with executor `none`.

Supervised execution additionally requires contract-side worker permission,
an exact-digest deployment allowlist, a least-privilege writer, queue/lease/
retry/rate/TTL controls, and production writer-posture proof. See
[Operator-Supervised Automatic Apply](supervised-automatic-apply.md).

## Non-Interactive And CI Authoring

The same managed compiler accepts a bounded answer file:

```json
{
  "action": {
    "capability_name": "support.propose_plan_credit",
    "description": "Propose one bounded plan credit for an exact customer.",
    "resource": "support.customers",
    "operation": "update",
    "conflict_column": "version",
    "version_advance": "integer_increment",
    "approval_role": "support_lead",
    "required_approvals": 1,
    "authority_posture": "proposal_only",
    "writeback": { "mode": "none" },
    "patches": [
      {
        "column": "plan_credit_cents",
        "value_source": "argument",
        "argument_name": "plan_credit_cents",
        "minimum": 0,
        "maximum": 5000
      }
    ],
    "confirmed_trusted_scope": true
  }
}
```

```bash
synapsor-runner action draft --answers action.json --project-root . --json
synapsor-runner action preview \
  --capability support.propose_plan_credit \
  --project-root . \
  --json
```

That command performs identity-free structural rehearsal. To deliberately run
the optional live scoped proposal diagnostic after runtime identity is
configured, add `--args proposal-args.json`.

JSON commands emit one JSON value on stdout. Input files must remain inside the
project root. Non-interactive activation is intentionally stronger than an
actor string or `--yes`: it requires `--headless`, a configured `signed_key` or
`jwt_oidc` operator provider, exact role and reason, short expiry, and a
single-use nonce bound to the capability and digest.

Example signed-key shape after configuring the operator public key:

```bash
synapsor-runner action activate --headless \
  --capability support.propose_plan_credit \
  --expected-digest sha256:<digest> \
  --confirmation 'ACTIVATE sha256:<digest>' \
  --identity action_reviewer \
  --identity-key ./action-reviewer.private.pem \
  --required-role action_reviewer \
  --reason 'Reviewed the exact proposal effect and source-unchanged rehearsal.' \
  --nonce '<fresh-url-safe-nonce-at-least-16-characters>' \
  --project-root . \
  --json
```

Runner consumes the nonce before activation. A retry with the same capability,
digest, and nonce is refused even though a newly signed decision has a different
timestamp.

## Code-First, DSL, And Spec Parity

Teams may continue to use restricted TypeScript authoring, public DSL, or
canonical JSON.

- `WRITEBACK NONE` is the canonical proposal-only posture.
- `WRITEBACK DIRECT SQL`, `WRITEBACK APP HANDLER EXECUTOR name`, and
  `WRITEBACK CLOUD WORKER` are explicit execution postures.
- `ALLOW SUPERVISED WORKER APPLY` is contract permission only, never a worker
  deployment or approval grant.
- Editing a TypeScript/DSL/JSON file creates no active authority.
- `action validate` parses restricted TypeScript without importing or running
  adopter code and writes only disabled digest-addressed artifacts.

```bash
synapsor-runner action validate \
  ./synapsor/actions/support.propose_plan_credit.ts \
  --project-root . \
  --json
```

The managed TUI, Workbench, scriptable answers, and code-first compatibility
path all converge on canonical Spec validation and the normal MCP/runtime
validators. See [Capability Authoring](capability-authoring.md) and the
[DSL Reference](dsl-reference.md).

## Workbench Parity

The secured loopback Workbench offers the same structural candidates, bounded
suggestion import/model assistance, disabled draft, source-unchanged rehearsal,
immutable revision, activation, and proposal views. It requires session/CSRF
protection and refuses raw key, token, credential, or write URL values in
suggestion request bodies.

The CLI remains the preferred operator surface. Workbench is a preview visual
adapter; it does not own separate authority semantics. A production deployment
must not expose Workbench as a remote control plane.

## Local, Ask, And HTTP Behavior

Transport changes authentication and process topology, not Action semantics.

| Path | Trusted identity source | Model-visible authority |
| --- | --- | --- |
| Local stdio MCP | Reviewed environment/static context | Activated semantic action tools only. |
| Local Ask shell | Same Runner runtime context as local MCP | Same activated semantic tools; authoring/control commands are refused. |
| Secured HTTP MCP | Verified asymmetric JWT/OAuth claims on every request | Same action tools, scoped to verified tenant/principal. Missing/bad auth fails before proposal creation. |

For shared HTTP, use the existing asymmetric JWT, OAuth protected-resource,
TLS/trusted-proxy, session, and shared-ledger requirements. A token may invoke
an already active action; it cannot change its approval, executor, policy, or
trusted scope. Keep the locked production Explore endpoint separate from the
action runtime rather than adding write tools to its exact two-tool catalog.

## Receipts, Replay, And Failure Semantics

Runner records proposal identity, exact contract digest, trusted-scope
fingerprints, normalized effect, approval evidence, lifecycle events, and
writeback receipts. Result values are not copied into general evidence views.

Before direct execution, Runner reopens current state in a guarded transaction.
Zero or multiple matches, changed scope, stale evidence, version conflicts,
changed authority, exhausted policy, duplicate idempotency identity, or an
unexpected affected-row count cause refusal.

With source-database receipt authority, mutation and receipt can commit in one
transaction. With Runner-ledger receipt authority, an ambiguous crash after a
source commit may require reconciliation; Runner does not falsely claim a
distributed exactly-once transaction.

Compensation is not rollback magic. For supported reviewed reversible updates,
Runner captures a bounded inverse after unambiguous execution. Revert creates a
new proposal with its own review and execution cycle.

## What Is Deliberately Not Possible

- No raw SQL or generic CRUD tool for the model.
- No model-supplied table, column, predicate, tenant, principal, executor,
  approval, policy threshold, or write credential.
- No automatic widening from schema names or model suggestions.
- No retroactive execution of proposal-only records.
- No hard delete with cascade/trigger uncertainty, policy auto-approval, or
  supervised worker execution.
- No derived-scope write merely because a derived read is safe.
- No activation without exact current artifacts and a real source-unchanged
  rehearsal.
- No headless activation based only on `--yes` or an unverified actor label.
- No approval or apply response accepted from a webhook or MCP client.

Use an app-owned executor when a business operation needs a multi-table
transaction, external side effect, application-specific authorization, or a
rollback protocol that the canonical single-row grammar cannot express.

## Qualification

The permanent generated-action live matrix runs the complete managed lifecycle
against PostgreSQL and MySQL:

```bash
corepack pnpm test:guided-actions-live
```

It creates ephemeral databases, activates a reviewed boundary, drafts and
rehearses proposal-only `INSERT`, `UPDATE`, and `DELETE`, proves no mutation,
promotes exact new digests, proves old proposals remain ineligible, approves and
applies new proposals with a separate least-privilege writer, verifies receipts
and cross-tenant refusal, and removes its containers, volumes, and temporary
projects.

Provider adapter tests use mocked OpenAI Responses and Anthropic tool-use
round-trips. The deterministic suite does not require a paid model call.

## Related References

- [Human Approval For AI Database Writes](human-approval-ai-database-writes.md)
- [Guarded CRUD Writeback](guarded-crud-writeback.md)
- [Approval Roles And Verified Operator Identity](approval-roles-and-operator-identity.md)
- [Operator-Supervised Automatic Apply](supervised-automatic-apply.md)
- [Proposal Evidence Freshness](proposal-evidence-freshness.md)
- [Capability Authoring](capability-authoring.md)
- [Security Boundary](security-boundary.md)
