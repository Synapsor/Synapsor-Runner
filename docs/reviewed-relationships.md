# Reviewed Relationship Paths

Synapsor Runner can answer bounded aggregate questions across related tables
without exposing a general join planner or SQL. The relationship is authority:
Runner proposes it from database catalog evidence, a human reviews it, and the
activated boundary fixes its exact path and semantics.

This feature is available in local development/staging Scoped Explore and in
the explicit, attested production-Explore HTTP mode. Protected named
capabilities created through Protect This Query remain the default production
surface.

## The Safety Rule

A model may select an already activated relationship **by name**. It cannot
provide a table name, join key, join type, relationship path, or SQL fragment.

Runner accepts only:

- one to three relationship paths in a protected capability;
- one or two links per path;
- inspected foreign-key links whose target key is unique;
- `many_to_one` cardinality with `max_fan_out: 1`;
- trusted tenant and, where configured, principal scope on every relation;
- an explicit human choice for missing related rows.

Runner refuses:

- one-to-many and many-to-many paths;
- relationships inferred only from similar column names;
- ambiguous or unproven cardinality;
- more than two links in one path;
- a plan using more than three reviewed paths;
- a relationship whose catalog proof or generation lock is stale;
- a related table whose trusted scope cannot be enforced;
- formulas, derived measures, free-form joins, and model-selected identifiers.

These limits permit reviewed star-style analysis. For example, a sales fact can
group by an activated store path and an activated category path without
multiplying the counted sales rows.

## Why Fan-Out Matters

Suppose one `sales_facts` row points to one store. Joining the store cannot
create more sales rows, so the relationship is many-to-one and has a maximum
fan-out of one.

By contrast, joining a sale to all of its line items can turn one sale into
several rows. A naive `SUM(sales_facts.amount_cents)` would then overstate
revenue. Runner refuses that one-to-many path instead of silently returning a
plausible but wrong number.

## Demand-Driven Review

Auto Boundary may discover more proven relationships than a developer needs.
They are not all activated automatically.

The intended flow is:

1. Activate the small starter boundary.
2. Ask a bounded aggregate question.
3. If the question needs an inactive but catalog-proven path, Runner refuses the
   plan and identifies the exact path and proof.
4. Workbench shows that one relationship for operator review.
5. The operator chooses missing-row semantics when required and activates the
   exact new boundary digest.
6. Retry the original question.

The model cannot trigger step 5. Adding the path creates new authority, so it is
an operator-plane action with a new digest. Existing unrelated confirmations
remain valid; only dependent review state is invalidated.

## Nullable Links

An optional foreign key requires an explicit business decision:

- `UNMATCHED EXCLUDE`: omit a counted row when its related record is missing;
- `UNMATCHED KEEP NULL`: keep the counted row and return an empty/null group
  value for the missing relationship.

This is not cosmetic. The choice can change totals and cohort sizes, so Runner
does not silently choose it. The decision is stored in the canonical contract
and bound into its digest.

## DSL Syntax

The SQL-like Domain-Specific Language (DSL) supports a legacy one-hop form and
the additive path form. Existing legacy contracts retain their canonical bytes
and digest.

Legacy one-hop form:

```sql
PROTECTED RELATIONSHIP store
  ON store_id
  REFERENCES public.stores.id
  PRIMARY KEY id
  TENANT KEY tenant_id
```

Reviewed path form:

```sql
PROTECTED RELATIONSHIP store LINK 1
  ON store_id
  REFERENCES public.stores.id
  PRIMARY KEY id
  TENANT KEY tenant_id
  UNMATCHED EXCLUDE

PROTECTED RELATIONSHIP category LINK 1
  ON product_id
  REFERENCES public.products.id
  PRIMARY KEY id
  TENANT KEY tenant_id
  UNMATCHED KEEP NULL

PROTECTED RELATIONSHIP category LINK 2
  ON category_id
  REFERENCES public.categories.id
  PRIMARY KEY id
  TENANT KEY tenant_id
  UNMATCHED EXCLUDE
```

In that example:

- `store` and `category` are user-defined path names;
- `LINK 1` and `LINK 2` are DSL keywords and ordered link numbers;
- `store_id`, `product_id`, and `category_id` are inspected local keys;
- `public.stores.id`, `public.products.id`, and `public.categories.id` are
  fixed reviewed targets;
- `PRIMARY KEY`, `TENANT KEY`, `UNMATCHED EXCLUDE`, and
  `UNMATCHED KEEP NULL` are DSL syntax;
- the two `category` declarations form one depth-two path.

Link declarations for one path must be contiguous and ordered. A protected read
cannot mix the legacy form with the path form.

## Canonical Contract

The path form compiles to public, language-neutral JSON:

```json
{
  "protected_read": {
    "mode": "aggregate",
    "relationships": [
      {
        "name": "category",
        "links": [
          {
            "local_key": "product_id",
            "schema": "public",
            "table": "products",
            "target_key": "id",
            "primary_key": "id",
            "tenant_key": "tenant_id",
            "cardinality": "many_to_one",
            "max_fan_out": 1,
            "unmatched_rows": "keep_null"
          },
          {
            "local_key": "category_id",
            "schema": "public",
            "table": "categories",
            "target_key": "id",
            "primary_key": "id",
            "tenant_key": "tenant_id",
            "cardinality": "many_to_one",
            "max_fan_out": 1,
            "unmatched_rows": "exclude"
          }
        ]
      }
    ]
  }
}
```

Measures, dimensions, time buckets, and fixed predicates refer to the reviewed
path name. The canonical Spec is not a generic SQL or analytics Abstract Syntax
Tree (AST); it represents fixed reviewed authority.

## Scope And Privacy

For every participating relation, Runner injects trusted tenant and configured
principal predicates outside model arguments. Scope on only the starting table
is insufficient.

Aggregate privacy controls continue to apply after relationships are added:

- minimum cohort suppression;
- maximum groups and response size;
- query, rate, extraction, and differencing budgets;
- fixed reviewed dimensions and measures;
- no pagination that bypasses the group bound.

Adding dimensions can make cohorts smaller, so suppression is evaluated on the
final grouped result. A relationship does not weaken kept-out fields: kept-out
fields cannot be selected, filtered, grouped, sorted, joined, or counted
distinctly.

## Protect For Production

Protect This Query freezes the exact reviewed paths, measures, dimensions,
filters, ordering, limits, scope, and privacy controls into a disabled named
capability. A human activates its exact digest. Scoped Explore can then be
disabled; the protected capability remains available.

Production does not advertise broad Explore tools and does not permit the model
to add relationship authority.

## When A View Is Better

Runner intentionally does not support:

- arbitrary relationship graphs;
- many-to-many analytics;
- derived formulas such as `revenue / capacity`;
- model-defined expressions;
- general-purpose join planning.

For those cases, create a database view that computes the reviewed business
meaning, grant Runner's reader access only to the safe projected columns, and
inspect the view as a new resource. See [Reviewed Database
Views](reviewed-database-views.md).

This keeps business formulas and complex joins under ordinary database and code
review while preserving Synapsor's field, scope, budget, proposal, and audit
boundary.

## Verification

The repository release gates exercise:

```bash
corepack pnpm test:reviewed-relationships
corepack pnpm test:auto-boundary-explore:packed
corepack pnpm test:clean-room:community-solar
corepack pnpm test:clean-room:retail
```

The live PostgreSQL and MySQL relationship test proves direct star paths,
depth-two paths, both nullable-link choices, demand-driven activation, drift
refusal, per-relation tenant/principal scope, suppression, and rejection of a
deliberately wrong fan-out relationship.
