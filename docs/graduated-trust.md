# Graduated Trust Recommendations

Graduated trust is an opt-in operator workflow that evaluates scoped ledger
history and recommends a bounded policy threshold change. It is disabled by
default. It never auto-approves itself, changes the active contract, pushes a
contract, or activates a registry version.

```json
{
  "graduated_trust": {
    "enabled": true,
    "kill_switch": false,
    "criteria": [{
      "capability": "support.propose_plan_credit",
      "policy": "small_credit",
      "field": "plan_credit_cents",
      "minimum_human_reviews": 20,
      "window_days": 30,
      "maximum_rejection_rate": 0.05,
      "maximum_conflict_rate": 0.01,
      "maximum_failure_rate": 0.01,
      "maximum_revert_rate": 0.01,
      "maximum_threshold_increase": 500,
      "absolute_ceiling": 5000
    }]
  }
}
```

Evaluate human-reviewed outcomes for one trusted tenant/capability/policy:

```bash
synapsor-runner policy recommend --contract ./synapsor.contract.json \
  --config ./synapsor.runner.json --tenant tenant_acme \
  --capability support.propose_plan_credit --policy small_credit \
  --store ./.synapsor/local.db
```

Eligible history produces `RECOMMENDATION_CREATED` and a pending `ptr_...`
identifier. Disabled, insufficient, stale, or out-of-policy history returns a
stable non-success code and creates no recommendation.

Auto-approved outcomes do not count as independent human evidence. Missing or
legacy provenance, mismatched contract digest/version, tampered approvals,
cross-scope records, insufficient samples, or excessive rejection, conflict,
failure, or revert rates fail closed. `kill_switch: true` disables evaluation
even when `enabled` remains true.

A recommendation remains operator-only. List it with `policy recommendations
list`. Approval or rejection requires a cryptographically verified `signed_key`
or `jwt_oidc` operator identity. Rejection is terminal. Approval permits only
an explicit export of a separate reviewable contract artifact:

```bash
synapsor-runner policy recommendations export ptr_... --tenant tenant_acme \
  --contract ./synapsor.contract.json \
  --out ./synapsor.contract.recommended.json --actor policy-reviewer --yes \
  --store ./.synapsor/local.db
```

Export rechecks the base contract digest, version, and current threshold. The
artifact is not activated. Activation remains an explicit operator or Cloud
registry action. Recommendation, decision, and export metadata remain in the
local or shared Postgres runtime ledger and can appear in scoped reports.
