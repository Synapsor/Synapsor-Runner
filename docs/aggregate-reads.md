# Bounded Aggregate Reads

There are two distinct aggregate surfaces:

1. A fixed named `aggregate_read` capability, described on this page, is
   production-capable and returns one contract-authored scalar.
2. Runner 1.6.0 Scoped Aggregate Explore is a temporary local development/
   staging authoring tool. It accepts only a typed plan inside a human-activated
   analytical boundary, supports reviewed dimensions and time buckets, and
   must be converted through Protect into a named production capability.

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

PostgreSQL and MySQL execution is parameterized and uses the configured
statement timeout. A dependency outage or statement timeout returns a safe,
retryable unavailable result without exposing a driver error. Minimum-group
suppression reduces single-record inference; it does not solve every statistical
inference risk. Review the underlying view, database role, and aggregation
policy as well.

Scoped Aggregate Explore reuses and extends this suppression machinery. Its
reviewed boundary additionally fixes aggregate-safe measures,
`count_distinct` identifiers, dimensions, day/week/month buckets, typed
filters, optional one-hop proven many-to-one relationships, maximum groups,
response/query/rate limits, and durable extraction/differencing budgets. A
field may be approved for `count_distinct` while its raw values remain hidden.
Production receives only the protected named capability; broad Explore is
absent from production `tools/list`.
