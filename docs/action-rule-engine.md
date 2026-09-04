# Action Rule Engine

Synapsor's Action Rule Engine lets an agent request a reviewed business outcome
without choosing the database mutation that implements it.

The model-facing Action surface stays fixed as the rule catalog grows:

```text
app.describe_actions
app.request_change
```

An operator may activate one outcome or eighty. The agent still does not receive
SQL, a patch API, approval authority, apply authority, or trusted identity
arguments.

## From Database URL To Usable Agent

The preferred setup is one CLI command:

```bash
export DATABASE_URL="<select-only-postgres-or-mysql-url>"
synapsor-runner start --from-env DATABASE_URL --cli
```

Choose a configured OpenAI, Anthropic, or compatible local model, approve the
exact structural-metadata egress, and describe one job. The model conducts the
Boundary conversation. Runner stays behind it and:

- reuses the current reviewed draft when one already exists;
- asks only for business meaning or thresholds that schema structure cannot
  prove;
- compiles and validates every typed draft without trusting model prose;
- saves disabled Read and Action revisions before any authority decision;
- presents Read activation and proposal activation as separate permissions;
- never requires a concrete tenant or principal value during reusable
  metadata-only authoring.

One job description may contain up to 2,000 characters. Runner's planner
separates it into a concise Read intent and an Action intent before either
compiler runs. An interrupted checkpoint persists those separate intents and
the bounded business-question transcript. Resume therefore continues the same
disabled job; it does not restage the broad catalog or reinterpret the entire
job as one Explore question. Older incomplete checkpoints that lack this
separation are replanned safely.

Low-confidence tenant or principal names remain default-deny. A confirmation
asks the concrete business question, such as whether `principal_id` on the
listed resources stores the authenticated principal supplied by the
application. `View exact Runner details` shows every resource and candidate in
the same decision screen without accepting it. Column naming alone never
authorizes scope.

After activation, install both independently reviewed surfaces:

```bash
synapsor-runner mcp install claude-code \
  --project --authoring --include-actions --project-root . --yes
```

`synapsor-runner tools list --config ./synapsor.runner.json` reports the Read
surface and adjacent Action surface separately. The resulting client has four
stable tools: `app.describe_data`, `app.explore_data`,
`app.describe_actions`, and `app.request_change`.

## The Core Distinction

There are two supported proposal patterns.

| Pattern | Agent supplies | Runner enforces |
| --- | --- | --- |
| Bounded discretionary proposal | Reviewed business arguments within an exact action revision | Types, values, scope, conflict guards, approval, limits, and execution posture |
| Rule-derived outcome | One activated outcome name plus opaque subject references | Private facts, eligibility, exact derived effect, approval, limits, and transaction-time re-verification |

Use a discretionary proposal when the caller is allowed to choose a bounded
value, such as a requested notification threshold. Use a rule-derived outcome
when current authoritative facts must determine the only legal effect, such as
restoring an eligible course registration.

## Four Separate Authorities

An Action Rule is not one large permission. It binds four reviewed objects.

| Authority | Purpose | Model-visible data? |
| --- | --- | --- |
| Read Boundary | Controls what Explore may return and which rows can produce opaque subject references | Only reviewed fields and opaque references |
| Verification Boundary | Defines private resources, fields, relationships, cardinality, scope, lock order, and transaction posture needed to decide eligibility | No fact values; structural names/types may be sent during explicitly approved authoring |
| Effect envelope | Sets the maximum one-row `INSERT` or `UPDATE`, allowed fields and values, conflict/version behavior, and writeback posture | A coarse effect description only |
| Action Rule and approval class | Defines `WHEN`, deterministic derivation, one outcome, TTL, human/policy approval, and atomic rolling limits | Outcome and safe lifecycle summary only |

All four objects are normalized, canonically hashed, and compiled together.
Activation binds the exact Read Boundary revision, Action Boundary revision,
rule, Verification Boundary, effect envelope, approval class, schema lock, and
compiled plan. A changed dependency makes the authority stale; Runner does not
reinterpret old authority against a new schema.

## Model-Facing Request

`app.describe_actions` lists activated outcomes and the opaque subject bindings
each one needs. It reads no source rows and grants no authority.

`app.request_change` accepts exactly two top-level properties:

```json
{
  "outcome": "university.promote_active_waitlist_offer",
  "subject_refs": {
    "review": "obj_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
  }
}
```

The request cannot contain:

- a table, field, predicate, SQL fragment, or patch;
- a tenant, organization, principal, or raw primary key;
- an approval mode, reviewer, policy, limit, executor, or writeback command;
- an authority digest or compiler instruction.

Unknown keys and malformed bindings are refused server-side. The opaque
reference is not authorization by itself.

## Opaque Subjects

Eligible Explore row results may include a random `obj_...` reference. Runner
stores the protected row identity separately and binds the reference to:

- the active Read and Action authority revisions;
- trusted tenant/principal or single-organization scope;
- source, resource, workflow session, and permitted outcome;
- observed-version provenance and expiry.

Aggregate or suppressed results never mint subject references. Claims are
atomic and one-use, with same-request idempotency. A forged, expired,
wrong-session, wrong-scope, revoked, or stale-authority reference returns a
generic unavailable result without revealing which check failed.

## Compile Path

The authoring model, when enabled, produces four typed drafts:

```text
structural metadata
  -> Verification draft
  -> effect draft
  -> rule draft
  -> approval draft
  -> Runner validation
  -> canonical compiler
  -> disabled Action Boundary revision
```

Model output is untrusted. The compiler independently resolves exact catalog
resources, keys, relationships, scope, value types, lock ordering, transaction
posture, deduplication, and effect containment. A provider gets one bounded
structured-output correction; repeated or ambiguous output is discarded.

No model participates in runtime rule evaluation.

The portable scalar language supports:

- booleans and checked integers;
- money as integer minor units with an exact currency;
- exact bounded strings and reviewed enum values;
- real calendar dates and canonical UTC timestamps;
- comparisons, `all`, `any`, `not`, null checks, allowlist membership, and
  positive bounded `exists`;
- checked derivation with add/subtract/min/max, bounded scaling and rounding,
  clamp, and timestamp duration addition.

Every expression is type-checked. Invalid dates, numeric overflow, mixed
currencies/units, unknown fields, unproven relationships, unbounded cardinality,
and effects outside the envelope fail before activation.

## Runtime Path

For one `app.request_change` call, Runner performs this sequence:

```text
agent names outcome + opaque subject
  -> Runner resolves trusted session context
  -> atomically claims the subject reference
  -> reloads active authority
  -> loads bounded authoritative facts with parameters
  -> proves scope, cardinality, versions, and eligibility
  -> derives exactly one canonical effect
  -> proves the effect is inside the activated envelope
  -> creates an immutable ChangeSet v4 proposal
  -> applies human or deterministic approval policy
  -> returns proposal lifecycle state; source row is unchanged
```

An ineligible rule creates no proposal. Missing, null, ambiguous, overflowed,
or otherwise unprovable facts produce an unavailable result and no proposal.
Those outcomes are intentionally distinct in operator audit while remaining
coarse on the model-facing surface.

## Eligibility, Approval, And Apply

These are independent decisions.

```text
eligible  !=  approved  !=  applied
```

- **Eligibility** proves that current authoritative facts match an activated
  rule and derives the only permitted effect.
- **Approval** checks a separately activated human/quorum or deterministic
  policy. Automatic-policy failure preserves an eligible proposal for human
  review; it does not widen the rule.
- **Apply** is a separate operator or supervised-worker authority. Proposal-only
  outcomes can never write, even after approval.

Rolling count and typed aggregate limits are accounted atomically in the Runner
control store. Reviewer roles and approval history are control-plane policy,
not source-table fields and not model arguments.

## Transaction-Time Re-Verification

Proposal-time evidence is not sufficient to write. A supervised PostgreSQL or
MySQL apply performs the semantic decision again inside the source transaction:

```text
BEGIN
  -> set the reviewed isolation level and UTC posture
  -> reload the active Action authority
  -> lock target and verification rows in canonical order
  -> recheck trusted scope and every dependency version
  -> re-evaluate the same portable rule
  -> re-derive the effect
  -> compare the exact effect digest with the approved proposal
  -> mutate exactly one row
  -> require affected-row count = 1
  -> record/reconcile the idempotent receipt
COMMIT
```

Authority drift, changed facts, a changed derived effect, a stale version,
wrong scope, tampering, or an unknown commit outcome cannot silently become a
second or broader mutation. The job stops or enters explicit reconciliation.

PostgreSQL and MySQL share the evaluator. Their adapters own parameterized
loading, row locks, transaction setup, and exact mutation lowering. MySQL
supervised writes require a transaction-capable reviewed storage engine.

## University Example

Suppose Explore returns one reviewed registration case and an opaque reference.
The student asks to use an active waitlist offer. The agent calls the same fixed
tool used for every other reviewed outcome:

```json
{
  "outcome": "university.promote_active_waitlist_offer",
  "subject_refs": { "review": "obj_..." }
}
```

Runner privately verifies:

```text
trusted institution and student match
registration status = waitlisted
waitlist position = 1
offer status = active and expires after transaction time
seat available = true
prerequisite satisfied = true
registration hold = false
already enrolled = false
current term = true
```

If all checks pass, the only derived effect is:

```text
UPDATE one reviewed registration row
SET status = enrolled, version = version + 1
WHERE registration_id = protected subject identity
  AND institution_id = trusted institution
  AND student_id = trusted student
  AND version = observed version
```

Values shown above describe the parameterized shape; the model receives no raw
identity or executable SQL. A second outcome,
`university.restore_erroneous_prerequisite_drop`, uses the same fixed tool and
generic evaluator but requires an erroneous drop reason, prerequisite proof
predating the drop, an open restoration window, and a reserved seat.

A third outcome, `university.release_completed_advising_hold`, proves that the
same surface is not limited to enrollment rows. Runner may derive one
`active -> released` transition only when current completion evidence is
verified, a registrar release is authorized, and the hold is specifically an
advising hold for the trusted student. Financial and disciplinary holds do not
match. The eligible result uses the separately reviewed registrar approval
class; eligibility does not itself approve or apply the change.

No domain-specific MCP function is added for any of these outcomes.

## Deliberate V1 Limits

The first portable release supports one exact row mutation per rule-derived
proposal. It does not pretend that two independent proposals are one atomic
business transaction.

Not supported in the v1 direct semantic path:

- multi-row effects such as inserting an enrollment and consuming an offer;
- hard `DELETE`, DDL, UPSERT, arbitrary SQL, or model-generated predicates;
- cross-database atomicity;
- scalar aggregates or negatively polarized existence checks whose absence
  could change through an unlocked phantom row;
- unbounded supporting rows or unreviewed many-to-many traversal.

Use an application-owned transactional executor for a genuinely multi-effect
business operation until a reviewed multi-effect protocol exists. Do not split
it into unbound actions and call that atomic.

## Failure Semantics

| Condition | Model-facing result | Source effect |
| --- | --- | --- |
| Rule is proven false | `SEMANTIC_ACTION_NOT_ELIGIBLE` | None; no proposal |
| Facts/scope/cardinality cannot be proven | `SEMANTIC_ACTION_UNAVAILABLE` | None; no proposal |
| Subject forged, expired, wrong scope, or stale authority | Generic unavailable/not-found posture | None |
| Eligible but policy does not match or limit trips | Human-review proposal | None |
| Approved proposal changes before apply | `SEMANTIC_AUTHORITY_STALE` or conflict | None |
| Exact supervised transaction succeeds | Applied receipt | Exactly one reviewed row |

See [Safe Action Human Control Plane](safe-action-control-plane.md),
[Proposal And Evidence Freshness](proposal-evidence-freshness.md), and the
[Threat Model](../THREAT_MODEL.md).
