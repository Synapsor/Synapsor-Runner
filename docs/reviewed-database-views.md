# Reviewed Database Views For Derived Measures

Scoped Explore deliberately has no formula or expression language. The model
cannot invent ratios, arithmetic, functions, subqueries, or joins. When a
useful measure needs reviewed database logic, put that logic in a
database-owned view and expose only the resulting typed column through a named
Synapsor capability.

The authority split is:

```text
Database owner reviews formula, joins, cardinality, and base-table scope
  -> view publishes a small typed row shape
  -> contract author reviews the view columns and fixed predicate
  -> Runner applies trusted scope and the named aggregate
  -> model receives one scalar, never SQL or member rows
```

This is an explicit escape hatch, not automatic generation. Auto Boundary
blocks a view whose row identity cannot be proven from catalog metadata. Review
the view definition, scope, uniqueness, and grants before hand-authoring a
capability.

## PostgreSQL Hardened Pattern

Use a `security_invoker` view so PostgreSQL checks permissions and row-level
security (RLS) as the Runner read role, not as the view owner. A
`security_barrier` also prevents unsafe predicate movement across the view
boundary.

The retail clean-room fixture defines this reviewed ratio:

```sql
CREATE VIEW public.reviewed_order_performance
WITH (security_barrier = true, security_invoker = true) AS
SELECT
  orders.id AS order_id,
  orders.merchant_id,
  orders.assigned_manager_id,
  orders.region_id,
  ROUND(
    (orders.net_revenue_cents::numeric /
      NULLIF(orders.gross_revenue_cents, 0)) * 10000
  )::integer AS net_revenue_retention_basis_points
FROM public.orders;
```

The formula is fixed in a reviewed database migration. The model sees only
`net_revenue_retention_basis_points`. It cannot change the numerator,
denominator, scale, or source relation.

For `database_scope.mode = "postgres_rls"`, Runner accepts a read view only
when all of these checks pass:

- the target is a normal PostgreSQL view used for `SELECT`;
- both `security_invoker=true` and `security_barrier=true` are present;
- the Runner role is not the view owner, a superuser, or `BYPASSRLS`;
- every referenced table or nested view can be resolved from the catalog;
- every referenced base table independently passes the existing FORCE RLS,
  role, policy-operation, and trusted-setting checks;
- every nested view passes the same view checks.

An ordinary owner-rights view, an unverifiable dependency, a missing RLS
setting, or any non-read operation fails closed before MCP serving.

## Named Aggregate

The public DSL fixes the trusted scope, formula output, region, aggregate, and
minimum cohort:

```sql
CREATE AGENT CONTEXT retail_analytics_context
  BIND tenant_id FROM ENVIRONMENT SYNAPSOR_TENANT_ID REQUIRED
  BIND principal FROM ENVIRONMENT SYNAPSOR_PRINCIPAL REQUIRED
  TENANT BINDING tenant_id
  PRINCIPAL BINDING principal
END

CREATE CAPABILITY retail.average_net_revenue_retention_pacific
  DESCRIPTION 'Return the privacy-suppressed average net-to-gross revenue retention rate for Pacific orders assigned to the trusted manager.'
  RETURNS HINT 'Returns one scalar average in basis points or a suppression result; never order rows.'
  USING CONTEXT retail_analytics_context
  SOURCE retail_postgres
  ON public.reviewed_order_performance
  PRIMARY KEY order_id
  TENANT KEY merchant_id
  PRINCIPAL SCOPE KEY assigned_manager_id
  AGGREGATE READ AVG net_revenue_retention_basis_points
  SELECT WHERE region_id = 'region-pacific'
  MIN GROUP SIZE 5
  REQUIRE EVIDENCE
END
```

Validate, compile, validate the Runner config, and serve:

```bash
npx -y @synapsor/runner dsl validate \
  ./average-retained-revenue.synapsor.sql --strict

npx -y @synapsor/runner dsl compile \
  ./average-retained-revenue.synapsor.sql \
  --out ./average-retained-revenue.contract.json \
  --strict

npx -y @synapsor/runner config validate \
  --config ./synapsor.runner.json

npx -y @synapsor/runner mcp serve \
  --config ./synapsor.runner.json
```

The runnable packaged recipe is under
`examples/retail-clean-room/view-recipe/`. Its clean-room gate proves that the
result is exactly `9000` basis points for the trusted fixture scope, includes
no member rows, and does not change the source database.

## Review Checklist

1. Prove the view has one intended row per counted entity.
2. Prove joins cannot multiply rows or silently double-count values.
3. Apply tenant and, where required, principal scope to every base relation.
4. Keep sensitive source columns out of the view output.
5. Grant the Runner role only `SELECT` on the view and required base objects.
6. Test same-tenant other-principal and cross-tenant denial.
7. Test zero denominators, nulls, rounding, and numeric overflow.
8. Keep cohort suppression and result limits in the Synapsor capability.
9. Treat a changed view definition as reviewed authority drift.

For complex or ambiguous calculations, keep the capability disabled until the
database migration, contract, and expected results have all been reviewed
together.
