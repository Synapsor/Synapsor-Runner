# Bounded Aggregate Reads

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
