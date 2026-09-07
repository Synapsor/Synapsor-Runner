import { canonicalJsonDigest, type ExactDerivedEffectProtocolV1 } from "@synapsor-runner/protocol";
import type { HardBudgetReservation } from "@synapsor-runner/proposal-store";
import type { EffectiveOwnerPolicy } from "./effective-owner-policy.js";
import { OwnerRuntimeError } from "./owner-runtime-identity.js";

/** Only current compiled parent charges determine resource consumption. Owner
 * edits can narrow common-unit caps, not meter identity, scope, window or cost.
 * A count is one executed effect, never a proposal or an approval event. */
export function effectiveOwnerBudgetCharges(effective: EffectiveOwnerPolicy, outcome: string,
  effect: ExactDerivedEffectProtocolV1): HardBudgetReservation["accounts"] {
  if (!effective.layers.length || !effective.allowed_outcomes.includes(outcome)) throw new OwnerRuntimeError("DELEGATION_NOT_AVAILABLE");
  const accounts = new Map<string, HardBudgetReservation["accounts"][number]>();
  for (const layer of effective.layers) {
    const { digest, ...body } = layer.policy;
    if (canonicalJsonDigest(body) !== digest) throw new OwnerRuntimeError("DELEGATION_CHANGED");
    const rule = layer.policy.rules.find((entry) => entry.outcome === outcome);
    if (!rule) throw new OwnerRuntimeError("DELEGATION_NOT_AVAILABLE");
    for (const charge of rule.budget_charges ?? []) {
      const budget = layer.policy.budgets?.find((entry) => entry.meter === charge.meter);
      if (!budget) throw new OwnerRuntimeError("DELEGATION_BUDGET_UNAVAILABLE");
      const amount = charge.kind === "effect_count" ? 1 : effect.set[charge.field];
      if (typeof amount !== "number" || !Number.isSafeInteger(amount) || amount <= 0) throw new OwnerRuntimeError("DELEGATION_BUDGET_CHARGE_NOT_PROVEN");
      const scope = budget.scope === "tenant" ? { level: "tenant" as const, tenant_id: effective.actor.tenant_id }
        : { level: "principal" as const, tenant_id: effective.actor.tenant_id, principal: effective.actor.principal };
      const key = canonicalJsonDigest({ scope, meter: budget.meter });
      const current = { scope, meter: budget.meter, unit: budget.unit, scale: budget.scale,
        window_ms: budget.window_ms, limit: budget.maximum, amount };
      const prior = accounts.get(key);
      if (prior) {
        if (prior.unit !== current.unit || prior.scale !== current.scale || prior.window_ms !== current.window_ms || prior.amount !== current.amount) {
          throw new OwnerRuntimeError("DELEGATION_BUDGET_INCOMPATIBLE");
        }
        current.limit = Math.min(prior.limit, current.limit);
      }
      accounts.set(key, current);
    }
  }
  if (accounts.size > 8) throw new OwnerRuntimeError("DELEGATION_BUDGET_LIMIT");
  return [...accounts.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, account]) => account);
}
