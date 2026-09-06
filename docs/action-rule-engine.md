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

After Read activation, install the fixed local surface once:

```bash
synapsor-runner mcp install claude-code \
  --project --authoring --project-root . --yes
```

`synapsor-runner tools list --config ./synapsor.runner.json` reports four local
tools. Action authority stays disabled until separately reviewed. The client has four
stable tools: `app.describe_data`, `app.explore_data`,
`app.describe_actions`, and `app.request_change`.

## Business Rules From Text

At any model-authoring `you>` prompt, use `/attach ./rules.txt`, or `/rules`
to paste, preview, replace or remove rules. Conversation-only setup remains
available. The file is context for the same draft, not executable policy.

Runner reads only the explicitly selected regular UTF-8 `.txt` file. The
initial limits are 32 KiB, 600 lines and eight retained versions per job.
Oversize, invalid encoding, binary input and symlinks are refused without
truncation. Mentioning a path does not read it. Paths, URLs and instructions
inside a document cannot trigger additional file reads, network requests,
source queries, activation or execution.

The local preview shows the complete numbered text, filename, version, size,
line count and exact provider/model destination. Choose **Use this complete
text with the named model** to authorize that transfer alongside reviewed
metadata, the existing draft and business conversation. Metadata-only consent
does not authorize an attachment. Replacing its contents or changing the model
requires new consent; ordinary refinements against the same approved snapshot
do not. After a model change, `/rules` offers transfer review.

Snapshots and source-related operator messages are stored under
`.synapsor/boundary-authoring/policy-sources`, in owner-only files. Resume uses
the saved bytes and digest, never silently rereads the original path. Sources
are separate from the bounded conversation history, so long chats cannot
silently truncate policy paragraphs. Retained source-related messages are
bounded to 64 messages of at most 4,000 characters; a full buffer refuses the
next message rather than dropping prior overrides. `/rules` removal deletes
all retained versions for this job, not its existing business rules. It is not
secure erasure or deletion of provider logs or earlier transcript excerpts.

Before activation, source coverage links numbered passages to exact draft
decisions. Missing decisions, conflicts and unsupported clauses are prominent;
the model can revise the existing Read or Action draft and present a new diff.
An Action revision preserves its outcome identity and unrelated rules; it is
saved disabled and never overwrites active authority. Explicit operator
overrides must quote recorded operator messages, not a document instruction.

The main review reports the source version and open business topics before
activation. Compilation prepares a structured draft; policy coverage is a
separate review. Topic details pair source passages with interpreted behavior,
responsibility and the next step. Exact configuration evidence is available
one level deeper, without losing the pending permission.

**Recheck existing controls with the model** reconciles coverage against the
current confirmed Read decisions, effective field access, verified scope
bindings and Runner's approval, replay and execution mechanisms. It changes
the report, not the business rules. A tenant-scoped limit groups by the exact
trusted tenant binding used in this deployment; Runner does not assume every
database uses tenant to mean customer account. Missing business meanings still
need clarification. Deployment and client responsibilities are identified
separately from Boundary predicates and cannot be silently waived.

Coverage is a **model assessment, not proof of semantic completeness**.
Runner verifies source links and field-privacy claims against current
permissions and attaches the actual settings behind each selected reference.
It does not prove the truth of arbitrary prose.
Review the source excerpts and interpreted behavior; unresolved passages block
this guided activation path. Provider failure preserves the draft and local
source preview. Runtime requests never include the source text: the existing
typed compiler, scope checks, private fact reload, approval policy and separate
execution permissions remain authoritative. The four runtime tools do not
change.

## The Core Distinction

New model-guided jobs use the fixed semantic surface for both patterns.

| Pattern | Agent supplies | Runner enforces |
| --- | --- | --- |
| Caller-selected business value | Outcome, opaque subjects, reviewed typed `inputs` | Exact keys, types, bounds, units and deterministic effect derivation |
| Fact-derived outcome | Outcome and opaque subject references | Private facts, eligibility, exact derived effect, approval, limits, and transaction-time re-verification |

Both use `app.request_change`; neither accepts a database patch. The older
per-capability discretionary tools remain explicit compatibility only. See
[reviewed business inputs](design-reviewed-business-inputs.md) for proof binding
and rejection rules.

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

`app.request_change` requires two properties and permits optional reviewed `inputs`:

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

The authoring model uses a conversational tool loop to edit four typed components
in the order the job needs, including revisiting earlier decisions:

```text
operator conversation + reviewed structural metadata
  <-> model edits verification / effect / rule / approval components
  <-> Runner validates and returns typed diagnostics
  -> exact disabled revision for operator review
```

Model output is untrusted. The compiler independently resolves exact catalog
resources, keys, relationships, scope, value types, lock ordering, transaction
posture, deduplication, and effect containment. Autonomous work is bounded;
genuine operator follow-ups are not treated as failed retries. Accepted components
and business answers are checkpointed against the exact job and catalog.
Unknown coded meanings require clarification, not guessed labels or row sampling.
One job can prepare multiple outcomes; each stays disabled until review.
Read edits can change exposure, operations, labels and limits. Runner preflights
dependent Action revisions before changing the reviewed Read dependency.

No model participates in runtime rule evaluation.

### Existing relationships in model chat

The model can discover declared links with `runner.inspect_action_relationships`
and prepare one with `runner.review_action_relationship`. These are internal
authoring tools, not additions to the four runtime MCP tools. They use only the
already approved structural catalog, never source rows, SQL, or a schema edit.
An ambiguous business relationship needs clarification; a missing or unsupported
link returns its exact reason instead of asking the operator to invent a join.

Composite foreign keys retain all ordered key pairs, including scope columns.
For example, an offer's `(account_id, subscription_id)` selects its own
subscription using both columns together. Forward traversal needs a proven
unique target; inverse traversal is bounded and cannot become an arbitrary
one-row update. Null components do not match. Join fields remain private to
verification and do not become model-facing Read fields.

`/details` shows the selected link, each equality, direction and disabled state.
Reviewing a link does not activate either Boundary. Accepted link selections
resume only against the same catalog and Read revision. At runtime PostgreSQL
and MySQL use parameterized, tuple-correlated predicates and recheck the actual
composite foreign key and unique-key proof before fact loading, including
transaction-time reverification. Unsupported partial, expression or prefix keys
cannot stand in for the complete target key. Existing single-column authority
keeps its original representation and digest.

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
