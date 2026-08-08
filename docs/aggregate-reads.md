# Bounded Aggregate Reads

There are two distinct aggregate surfaces:

1. A fixed named `aggregate_read` capability, described on this page, is
   production-capable and returns one contract-authored scalar.
2. Scoped Aggregate Explore accepts only a typed plan inside a human-activated
   analytical boundary and supports repeated questions over reviewed measures,
   dimensions, time buckets, filters, ordering, and bounds. It runs locally in
   development/staging and, after explicit production opt-in and attestation,
   through the same two-tool surface over secured HTTP MCP. Protect is optional
   for local analysis that should become a fixed named capability; production
   HTTP Explore remains read-only and does not expose Protect to the model.

Neither surface accepts SQL strings or arbitrary identifiers. Read
[Auto Boundary, Scoped Explore, And
Protect](auto-boundary-and-scoped-explore.md) for the second path.

An `aggregate_read` capability returns one reviewed scalar rather than source
rows. It is intended for questions such as a tenant-scoped overdue balance
total where exposing individual records would be unnecessary.

```sql
CREATE CAPABILITY billing.overdue_balance_total
  DESCRIPTION 'Return the reviewed overdue balance total for the trusted tenant.'
  USING CONTEXT local_operator
  SOURCE billing_postgres
  ON public.invoices
  PRIMARY KEY id
  TENANT KEY tenant_id
  AGGREGATE READ SUM balance_cents
  SELECT WHERE status = 'overdue'
  MIN GROUP SIZE 5
  REQUIRE EVIDENCE
END
```

Compile the packaged example with:

```bash
synapsor-runner dsl compile ./fixtures/dsl/aggregate-read.synapsor.sql \
  --out ./synapsor.contract.json --strict
```

A permitted call returns one aggregate scalar; an undersized group returns a
stable suppressed result. Neither result contains source rows or member IDs.

Supported operations are `COUNT ROWS`, `COUNT NON NULL column`, `SUM column`,
and `AVG column`. The source, table/view, tenant key, function, column, optional
equality selection, and minimum group size are contract-authored. The first
release permits no model arguments, dynamic columns, joins, grouping, arbitrary
expressions, or model-controlled predicates.

When fewer records match than `MIN GROUP SIZE`, the stable result is suppressed
and contains no aggregate value or member identity. Allowed results contain one
scalar plus evidence/query-audit handles. Evidence records the contract digest,
trusted scope reference, reviewed operation, fixed predicate summary, and
suppression state; it never stores member rows or IDs.

`MIN GROUP SIZE` accepts integers from 1 upward. A value of 1 means no matching
group is removed for being small: groups of one can identify an individual.
That value is valid contract authority, not a safe default. Auto Boundary keeps
the generated default at 5. Lowering an Auto Boundary threshold requires an
explicit human owner decision with reviewer identity and reason; the model
cannot request or confirm it. The effective threshold and owner-override marker
appear in `app.describe_data`, the safe analytics catalog, and Workbench.

When an Explore analysis uses a lowered Auto Boundary threshold, Protect
requires the owner to re-confirm that disclosure posture. Activating the
generated named capability requires a second exact confirmation so a staging
choice cannot silently become production authority. `suppression_aware_totals`
remains enabled regardless of the threshold. This is Runner's conservative
default posture, not a claim that cohort suppression is universally required by
regulation.

PostgreSQL and MySQL execution is parameterized and uses the configured
statement timeout. A dependency outage or statement timeout returns a safe,
retryable unavailable result without exposing a driver error. Minimum-group
suppression reduces single-record inference when the reviewed threshold is
greater than 1; it does not solve every statistical inference risk. Review the
underlying view, database role, and aggregation policy as well.

Fixed named `aggregate_read` capabilities still require contract-authored
operations. For calculations outside their closed grammar, use a reviewed
database view. The complete hardened PostgreSQL pattern and runnable retail
example are in [Reviewed Database Views For Derived
Measures](reviewed-database-views.md).

Scoped Aggregate Explore reuses and extends this suppression machinery. Its
reviewed boundary additionally fixes aggregate-safe measures,
`count_distinct` identifiers, numeric dispersion, missing-data measures,
reviewer-named derived measures, fixed numeric bands, hour through year and
day-of-week buckets, typed filters, up to three activated relationship paths
(one or two proven many-to-one links per path), maximum groups,
response/query/rate limits, and durable extraction/differencing budgets. A
field may be approved for
`count_distinct` while its raw values remain hidden. Relationship paths remain
catalog-proven, operator-activated authority; the model cannot supply join
identifiers or activate an inactive path. Plans may request top- or bottom-N
groups, or rank one exact two-period comparison by signed absolute or
percentage change. Timestamps, bucket labels, and range boundaries use UTC in
this release. Structured MCP output schemas and the safe analytics catalog let
external clients consume the same bounded result without learning physical
schema names.

Dispersion uses `COUNT(field)` rather than `COUNT(*)` as its contributor count.
It is released only when at least `max(reviewed minimum group size, 5)` non-null
values contributed; sample standard deviation also requires at least two.
Lowering a table's ordinary group threshold therefore never lowers the
dispersion floor. `min`, `max`, median, percentile, mode, covariance, and
correlation remain unavailable because they need separate disclosure analysis.

Reviewers can save ratio, percentage, and per-unit definitions assembled from
reviewed base aggregates. They can also save running total, rank, lag change,
moving average, and share-of-released-total operations. The model receives only
the digest-bound name. Runner performs the latter operations after suppression,
over released groups only; it emits no database window SQL and accepts no
formula, partition expression, frame, or arbitrary ordering from the model.

A reviewed child-count measure answers normalized-schema questions such as
total line items by customer region or average events per order. Its definition
fixes one child resource and one non-null catalog-proven many-to-one child-to-
parent foreign key. Runner compiles a correlated subaggregate, injects the
child's own trusted tenant/principal scope, and never exposes a raw one-to-many
join. The released cohort is the reviewed parent population and has an effective
minimum of five. Child-count analyses are currently Explore-only: Protect
refuses them until protected contracts can freeze the inverse child and scope
authority explicitly.

### Database Compatibility For Reviewed Analytics

The 1.7.0 release gates execute these analytics on PostgreSQL 16 and MySQL 8.
Those are the documented tested database lines for the expanded grammar; this
release makes no broader server-version claim. Standard deviation and variance
compile to each engine's `STDDEV_*` and `VAR_*` aggregate functions. Calendar
grouping and correlated child counts compile through engine-specific fixed SQL.
Post-suppression running totals, lag changes, ranks, moving averages, and shares
run in Runner after bounded groups are returned, so they do not depend on
database window-function support. Already-correct plans have one shared
validator/compiler path for local stdio and production HTTP MCP.

Ranked aggregates use two independent reviewed ceilings:

- `max_top_n` limits how many groups may be returned (25 by default).
- `max_ranked_groups` limits the complete underlying candidate set Runner may
  inspect for ranking (500 by default for newly generated boundaries).

Runner validates the candidate-set ceiling, applies the minimum-cohort rule to
that complete set, and only then ranks and returns the requested top-N. A
high-valued suppressed group therefore cannot leak through ranking, and the
next eligible group may fill its place. If the grouped result exceeds
`max_ranked_groups`, Runner refuses instead of silently ranking an incomplete
population. Ordinary unranked aggregates retain the smaller `max_groups`
ceiling.

The operator may narrow `max_ranked_groups` in Workbench or with
`boundary review --max-ranked-groups`; it is bound into the boundary digest.
It is not present in the model plan or MCP input schema. Every field, measure,
time range, relationship path, suppression rule, query timeout, complexity
bound, response bound, and differencing rule remains independently enforced.
Existing boundaries without this additive setting use `max_groups`, preserving
their prior behavior and canonical authority.

A ranked period mover pairs exactly two suppressed period results by reviewed
dimensions and may order by absolute or percentage change. Percentage change
is null when the earlier value is zero and sorts after defined values. This is
a closed typed operation, not a formula or expression language.

Every cohort-protected aggregate claims an atomic durable privacy reservation
before the source query. Differencing variants share one rolling 24-hour pool
for the reviewed source, trusted scope, and root resource; changing measures,
dimensions, filters, time grains, ordering, or result bounds does not create a
fresh allowance. Only an exact normalized-plan replay reuses a variant, though
it still consumes query and rate allowance. Invalid plans and source failures
do not consume extraction or differencing allowance. Pending concurrent work
counts conservatively, so parallel requests cannot all pass against the same
snapshot. Runner also refuses release of a scalar total after a suppression-
bearing grouping, or the reverse, when the two results could expose the hidden
aggregate by subtraction. A reviewed minimum cohort of `1` disables small-
group suppression and therefore disables differencing and complementary-total
checks; query, rate, extraction, response, and complexity limits still apply.
The interactive CLI calls this the **minimum group size**. In `/access`, keep
the affected table highlighted and press `P`; do not open its column editor.
After entering the value and reason, Enter accepts the default-Yes draft save
and the following default-Yes review/activation prompt. If activation is
postponed, press `C` from the boundary screen later.
New Auto Boundaries review a finite default of 16 distinct cohort-protected
variants per root resource in that rolling window. This supports the ten-plan
first-use journey while remaining one shared cross-shape allowance. Existing
boundaries retain their exact digest-bound value, and reviewers may narrow the
generated value.

The reviewer may also mark an otherwise usable dimension, filter, selected
field, time bucket, or raw output as **withheld from model**. Runner still executes
the reviewed plan once and shows the real value in its local verified result,
but model-facing MCP content receives only response-local opaque tokens for
raw values and group labels. Reviewed derived values such as a distinct count
remain visible without disclosing the values being counted. This makes a raw
data value, including a prompt-injection string,
unavailable to the provider while preserving legal grouping and comparison
inside one answer. It does not bypass minimum-cohort suppression, trusted
scope, response bounds, extraction budgets, or differencing protection, and it
does not make the value private from the human viewing the local result.
The model-visible catalog retains the field's reviewed type and legal
operations so it can compose typed plans, but omits that field's enum/value
domain.

Local Explore remains an authoring surface. Repeated questions do not create
authority and do not need to be protected. When a local operator explicitly
chooses **Protect this analysis**, Runner freezes supported normalized analyses
into disabled public DSL and canonical named authority, then requires a separate
digest-bound human activation. Production Explore appears in `tools/list` only
under its explicit secured-HTTP opt-in and still exposes exactly
`app.describe_data` and `app.explore_data`; it never exposes Protect or any
operator action. See [Production Scoped Explore Over
HTTP](production-scoped-explore-http.md), [Reviewed Relationship
Paths](reviewed-relationships.md), and [Auto Boundary, Scoped Explore, And
Protect](auto-boundary-and-scoped-explore.md).
