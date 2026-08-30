# Boundary Assist: Compile Representative Reads

Boundary Assist converts a representative set of valid Explore plans into the
smallest reviewed read-boundary candidate needed by those plans. It is an
optional authoring step before activation. It does not query source rows,
consume Explore privacy budget, change the source database, or activate agent
authority.

Use it when a generated boundary is broader than one agent workflow, or when
you want a review to begin from concrete jobs instead of every structurally
available field.

## The Trust Split

```text
optional semantic convenience
questions -> OpenAI / Anthropic / local model -> exact candidate plans
                                                |
----------------------- untrusted boundary -----+-----------------------
                                                v
trusted Runner core                 validate every exact plan
                                    extract authority atoms
                                    union and minimize operations
                                    prove required reads compile
                                    prove exact deny tests stay denied
                                    save a disabled candidate
                                                |
                                                v
                                    separate human activation
```

The model may map a phrase such as `average invoice value by customer plan`
to exact reviewed identifiers. It cannot grant a field, relationship, tenant,
principal, SQL, activation, approval, apply, or writeback authority. A bad or
incomplete mapping is blocked by deterministic validation.

Everything below the dashed line works without a model.

## Default Guided Path

Start from the normal one-command onboarding. No config or workload file is
required:

```bash
synapsor-runner start --from-env DATABASE_URL --cli
```

Describe one agent job at the first prompt. Model-assisted mapping is the
recommended route when a configured OpenAI, Anthropic, or loopback local model
is available. Runner-guided exact question cards are the no-model route, and
full manual review remains one choice away. The terminal prepares a complete
disabled structural catalog, maps the job, records the immutable analysis and
minimum candidate, then opens the exact boundary review in the same session.
Press `W Agent job` later to reopen this flow from `/access`.

This automates only non-authoritative state. The selected read boundary remains
disabled until the operator confirms the exact activation summary.

For an agent job that also needs proposals, the result is deliberately two
artifacts: a **Read Boundary** for what the agent may learn and an **Action
Boundary** for the exact changes it may propose. The Action Boundary records
the exact Read Boundary dependency and inherits its trusted tenant/principal or
whole-organization scope. Neither boundary activates the other, and approval
or apply authority is not part of workload compilation.

The Action Boundary does not inherit Read row-return fields as write
permission. It reviews exact mutable fields independently. When an action needs
an identity, patch field, conflict value, or reviewed before-state condition
that the minimized Read Boundary does not return, Runner includes that exact
field only in the action contract's internal read snapshot and marks it
model-withheld. Structural keep-out remains an absolute exclusion.

## Other Operator Paths

### Terminal TUI

Open the boundary editor and press `W Agent job`:

```bash
synapsor-runner boundary review --access --project-root .
```

The job mapper offers:

1. model-assisted mapping with OpenAI, Anthropic, or a local endpoint;
2. Runner-guided exact question cards with no model or JSON;
3. full manual table and field setup;
4. Advanced exact workload JSON;
5. Advanced question-intent JSON plus a model;
6. an immutable saved analysis.

Runner saves harmless analysis/draft state automatically and immediately shows
the retained authority in the exact activation review. Once that revision is
fully reviewed, `Y Safe actions` can draft and rehearse a dependent
proposal-only action in the same session. Its activation remains blocked until
the exact read revision is active.

If this editor was opened with `/access` from Ask, option 2 names and reuses the
current provider/model and its memory-only credential. It asks for the
questions and one structural-metadata egress confirmation, not provider setup.
For standalone use, exporting exactly one of `OPENAI_API_KEY` or
`ANTHROPIC_API_KEY` gives the same automatic default. Runner asks explicitly
when both or neither are configured and never persists a credential value.

### Workbench Preview

Open Workbench through the normal reviewed setup, then choose **Compile read
workload**. It provides:

- reviewed question cards as the default path;
- a visual aggregate builder for common counts and reviewed aggregates;
- a multiline, syntax-highlighted full-workload JSON editor;
- local JSON file import;
- optional OpenAI, Anthropic, or OpenAI-compatible question mapping;
- immutable saved-analysis replay;
- coverage, deny-test, and retained-authority review;
- automatic disabled-candidate persistence followed by explicit activation.

The visual builder is convenience, not a second grammar. It generates the same
exact Explore plan JSON accepted by the deterministic compiler. Use the JSON
editor for rows, filters, relationships, time windows, comparisons, bands, and
other reviewed Explore features.

### Scripted CLI

Analyze one exact workload:

```bash
synapsor-runner boundary assist \
  --project-root . \
  --workload ./support-reads.json \
  --actor alex@example.com \
  --reason "Compile the support resolution workload" \
  --json
```

The response contains a `decision_digest` only when every required plan is
valid. After reviewing the coverage and exposure report, save the disabled
revision with the same actor, reason, and exact decision:

```bash
synapsor-runner boundary assist \
  --project-root . \
  --analysis rw_0123456789abcdef0123456789abcdef \
  --actor alex@example.com \
  --reason "Compile the support resolution workload" \
  --apply \
  --confirm "APPLY WORKLOAD sha256:<exact-decision-digest>"
```

List immutable analyses:

```bash
synapsor-runner boundary assist --project-root . --list
```

## Exact Workload Format

The input is bounded JSON. `allowed` entries must validate and compile. A
`forbidden` entry is a useful deny test only when it is itself one valid exact
plan under the generated authority and is denied by the minimized candidate.
Typos and invented identifiers are blockers, not successful deny tests.

```json
{
  "schema_version": "synapsor.read-workload-set.v1",
  "name": "support_resolution",
  "allowed": [
    {
      "id": "open_invoices_by_plan",
      "description": "Average open invoice value by customer plan",
      "plan": {
        "kind": "aggregate",
        "resource": "billing.invoices",
        "where": [
          { "field": "status", "op": "eq", "value": "open" }
        ],
        "dimensions": [
          {
            "field": "plan_name",
            "relationship": "invoices_customer_id_fkey__customers_subscription_id_fkey"
          }
        ],
        "measures": [
          { "function": "avg", "field": "amount_cents" }
        ],
        "top_n": 25
      }
    }
  ],
  "forbidden": [
    {
      "id": "raw_invoice_amounts",
      "description": "Individual invoice amounts must remain unavailable",
      "plan": {
        "kind": "rows",
        "resource": "billing.invoices",
        "select": ["id", "amount_cents"],
        "limit": 25
      }
    }
  ],
  "source": { "kind": "operator_exact_plan" }
}
```

Filter literals are used only for validation and are replaced by typed
placeholders in the immutable workload analysis. Result rows and SQL are not
stored in the analysis.

## Optional Question Mapping

Create a question-intent file:

```json
{
  "name": "support_resolution",
  "allowed_questions": [
    "What is the customer's current plan?",
    "Has the invoice for this ticket been paid?"
  ],
  "forbidden_questions": [
    "List customer email addresses outside the current reviewed scope"
  ]
}
```

Then explicitly acknowledge the structural metadata egress:

```bash
synapsor-runner boundary assist \
  --project-root . \
  --intent ./support-questions.json \
  --provider anthropic \
  --model claude-sonnet-4-20250514 \
  --api-key-env ANTHROPIC_API_KEY \
  --acknowledge-structural-metadata-egress \
  --actor alex@example.com \
  --reason "Review model-mapped support reads"
```

The provider may receive only:

- reviewed model-visible resource and field identifiers;
- field types and reviewed operations;
- reviewed relationship identifiers;
- reviewed labels and descriptions;
- the representative questions.

It does not receive database rows or values, kept-out or model-withheld fields,
database credentials or URL values, trusted tenant/principal values, SQL,
activation, approval, apply, policy, or writeback authority. The API key is
resolved from the named environment variable and is not embedded in the
analysis.

## What Minimum Means

Minimum authority is relative to the supplied representative workload, not a
claim that Runner inferred every future business need. For each allowed plan,
Runner extracts exact atoms such as:

```text
billing.invoices                     resource
billing.invoices.status              filter:eq
billing.invoices.amount_cents        aggregate:avg
invoices -> customers -> subscription relationship
subscriptions.plan_name              group
```

It unions those atoms and removes unrelated resources, return fields, filter
operators, sort/group/aggregate permissions, relationships, measures, bands,
and time operations. Scope, cohort suppression, disclosure budgets, role
posture, generation locks, and hard ceilings are inherited rather than
weakened.

If a later question needs more authority, add it as another representative
plan and create a new disabled revision. Active authority remains unchanged
until a human reviews and activates that exact revision.

## States And Failure Behavior

| State | Meaning |
| --- | --- |
| `ready` | Every allowed plan compiles and every exact forbidden plan is denied by the minimized candidate. |
| `blocked` | A plan is invalid, unsupported, contradictory, or a deny test is not an exact valid test. |
| `stale` | The generated schema/role-bound boundary changed after analysis. Re-run the workload. |
| `reviewed` | The workload created one disabled boundary revision. This is not active authority. |

Apply rechecks the live schema inspection, database-role posture, generation
lock, candidate digest, reviewer identity, reason, and decision digest. It
preserves every existing active boundary and writes no source data.

## Reads Then Writes

Read setup precedes Action Assist because a proposal often depends on reviewed
read evidence. After read activation:

```text
active read boundary
  -> Y Safe actions (CLI) or Add safe action (Workbench)
  -> exact proposal-only Action revision
  -> disposable source-unchanged rehearsal
  -> separate activation
  -> agent may create proposals
  -> approval and apply remain outside the model
```

The initial managed Action posture remains `WRITEBACK NONE`. Boundary Assist
does not infer business write permission, write bounds, approval roles, or
execution posture from read usage.

## Current Deliberate Limits

- Natural-language mapping is optional and may fail. Runner refuses rather
  than silently substituting a different plan.
- The visual builder covers common aggregate shapes; exact JSON exposes the
  complete reviewed Explore grammar.
- Application-route and runtime-lineage evidence may inform a human review,
  but this release does not claim that names or route presence prove database
  authorization.
- Forbidden natural-language examples count only after mapping to exact valid
  plans.
- Candidate creation never auto-activates authority.

For the lower-level plan compiler, see [Explore Plan Playground](explore-plan-playground.md).
For the write side, see [Safe Action Human Control Plane](safe-action-control-plane.md).
