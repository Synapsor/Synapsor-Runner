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

Five nouns explain the whole lifecycle.

| Term | Meaning | Grants authority? |
| --- | --- | --- |
| **Read Boundary** | The reviewed tables, fields, relationships, scope, and limits Runner may use to inspect current state. | Yes, read authority only after activation. |
| **ActionSuggestion** | Bounded convenience metadata naming an intent and possible resource, operation, and fields. | No. It cannot contain approval, execution, credentials, trusted identity, writeback, or SQL. |
| **ActionDesign** | The human-reviewed choices and the schema proofs behind one business action. | Not by itself. It compiles a disabled revision. |
| **ActionRevision** | Immutable DSL, canonical JSON, tests, review explanation, exact digest, and authority posture. | Only after exact rehearsal and activation. |
| **Proposal** | One immutable requested effect, bound to the exact action digest, trusted scope, target, before/after state, guards, and approval posture. | It may become eligible for a separate approval and execution path. It is not itself a commit. |

The normal progression is:

```text
schema proofs
  -> optional untrusted suggestion
  -> human ActionDesign review
  -> disabled ActionRevision
  -> disposable source-unchanged rehearsal
  -> exact-digest activation
  -> agent invokes one semantic action
  -> immutable proposal
  -> outside-model approval
  -> trusted executor rechecks every guard
  -> commit plus receipt
```

At no point does Runner turn the model into a database administrator.

## Human Control Plane And Agent Data Plane

The human control plane may:

- choose a structurally eligible table and operation;
- select exact fields and value sources;
- set numeric bounds, text limits, enums, and state transitions;
- confirm trusted tenant and principal scope;
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

Runner starts from an activated Read Boundary and a fresh database inspection.
For managed Safe Actions, a resource must currently have a direct reviewed
tenant key. If principal scope is required, it must also be direct. A derived
read path does not silently become write authority.

Runner excludes generated, identity, immutable, scope-owned, kept-out, and
unreviewed fields from the write candidates. It then evaluates each operation:

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
| Deterministic policy | Runner may approve a bounded numeric proposal at or below a reviewed threshold, with per-day count and aggregate-value circuit breakers. The model cannot select or alter the policy. |

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
persisted, or sent in model content. The standalone command remains:

```bash
synapsor-runner action suggest \
  --intent "Let support propose a bounded plan credit" \
  --provider openai \
  --model gpt-5.6-luna \
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

The TUI derives typed prompts from the generated contract: enum pickers,
booleans, bounded numbers, and length-bounded text. Raw JSON remains an
advanced option for repeatable fixtures. Runner then runs the actual semantic
proposal path against the current schema and scope using a disposable ledger
and verifies:

- the generated action validates;
- the expected target and proposed effect are produced;
- trusted tenant/principal values came from runtime context;
- the source database did not change;
- the proposal digest belongs to this exact ActionRevision.

The rehearsal proposal is destroyed. It cannot later be approved or applied.

### 6. Activate The Exact Digest

Interactive activation shows the selected short digest, asks for a human
yes/no decision, then internally binds that decision to the full digest and
recomputes the artifacts. No digest copy/paste is needed in the TUI. Changed
artifacts, stale boundaries, or a missing exact rehearsal fail closed.

Headless and CI activation still requires the full
`ACTIVATE sha256:...` confirmation plus verified operator authority and nonce.

Activation copies immutable artifacts under a digest-addressed revision path
and updates the separate action runtime. It does not widen the production
Explore two-tool surface.

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
  --args proposal-args.json \
  --project-root . \
  --json
```

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
