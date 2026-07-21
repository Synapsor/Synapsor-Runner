# Support Plan Credit MCP Recipes

These files connect different MCP hosts and frameworks to the same reviewed
Runner tools:

- `support.inspect_customer`
- `support.propose_plan_credit`

Every proposal example uses:

```json
{
  "customer_id": "CUS-3001",
  "credit_cents": 2500,
  "reason": "SLA outage ticket SUP-481"
}
```

The expected call result has `source_database_changed: false`. Human review,
approval, and apply stay outside every model-facing recipe.

See [Client And Framework Recipes](../../../docs/client-recipes.md) for setup,
evidence labels, official references, and verification commands.
