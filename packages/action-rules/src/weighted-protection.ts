import { canonicalJsonDigest } from '@synapsor-runner/protocol';
import { ActionRuleError } from './errors.js';
import { validateBoundedInvariantRows } from './bounded-invariant-state.js';
import { buildWeightedConstraintState, checkWeightedPostState, type WeightedConstraintState } from './weighted-constraint-state.js';
import { parseReviewedWeightedSharedSum } from './weighted-shared-sum-designation.js';
import type { ActionRuleFactSetV1, CompiledActionRuleV1, DerivedActionEffectV1, RuntimeActionRuleRegistryV1 } from './types.js';

/** Derived only from the current persisted V3 registry. A descriptor or an
 * externally supplied compiler state cannot enable runtime protection. */
export type ReviewedWeightedSharedSumProtection = Readonly<{ digest: `sha256:${string}`;
  registry_digest: `sha256:${string}`; state: WeightedConstraintState }>;
function refuse(stage: string): never {
  throw new ActionRuleError('ACTION_RULE_SCOPE_UNPROVEN',
    'The reviewed weighted limit cannot be inspected with the supported Source guarantees.', `source.hard_limit.weighted_${stage}`);
}
export function deriveReviewedWeightedSharedSumProtection(registry: RuntimeActionRuleRegistryV1): ReviewedWeightedSharedSumProtection | undefined {
  const version: string = registry.schema_version;
  if (version !== 'synapsor.action-rule-registry.v3') {
    if (version === 'synapsor.action-rule-registry.v1' || version === 'synapsor.action-rule-registry.v2') return undefined;
    refuse('authority_version');
  }
  const record = parseReviewedWeightedSharedSum(registry.shared_sum);
  const state = buildWeightedConstraintState(registry, record.designation);
  if (new Set(registry.rules.map(r => canonicalJsonDigest([r.action_boundary_name, r.action_boundary_digest]))).size !== 1)
    refuse('boundary_inventory');
  const boundary = { schema_version: 'synapsor.semantic-action-boundary.v3', name: registry.rules[0]!.action_boundary_name,
    rules: registry.rules.map(({ compiled: c, approval_policy_digest }) => {
      const approval = registry.approval_classes.find(a => a.name === c.approval_class);
      if (!approval || approval.digest !== approval_policy_digest) return refuse('approval_inventory');
      return { approval_policy_digest, approval_mode: approval.mode, outcome: c.outcome,
        effect_envelope_digest: c.effect_envelope_digest, action_rule_digest: c.rule_digest,
        compiled_plan_digest: c.compiled_plan_digest, approval_class: c.approval_class,
        operation: c.effect_envelope.operation, target_resource: c.effect_envelope.target_resource,
        allowed_fields: c.effect_envelope.allowed_fields.map(f => f.name).sort(), max_rows: 1,
        writeback: c.effect_envelope.writeback };
    }).sort((a, b) => a.outcome.localeCompare(b.outcome)), shared_sum_digest: canonicalJsonDigest(record) };
  if (canonicalJsonDigest(boundary) !== registry.rules[0]!.action_boundary_digest) refuse('boundary_inventory');
  for (const { compiled, read_boundary_name, read_boundary_digest } of registry.rules) {
    if (compiled.generation_lock_fingerprint !== record.confirmation.generation_lock_fingerprint) refuse('generation');
    if (!record.confirmation.read_dependencies.some(r => r.name === read_boundary_name && r.digest === read_boundary_digest))
      refuse('read_provenance');
  }
  return Object.freeze({ digest: canonicalJsonDigest({ schema_version: 'synapsor.weighted-shared-sum-invariant.v1', meaning: state.meaning }),
    registry_digest: registry.digest, state });
}
export function assertReviewedWeightedSharedSumRegistry(registry: RuntimeActionRuleRegistryV1): void {
  deriveReviewedWeightedSharedSumProtection(registry);
}
export function resolveReviewedWeightedSharedSumProtection(plan: ReviewedWeightedSharedSumProtection, registry: RuntimeActionRuleRegistryV1,
  compiled: CompiledActionRuleV1): { digest: `sha256:${string}` } | undefined {
  const current = deriveReviewedWeightedSharedSumProtection(registry);
  if (!current || current.registry_digest !== plan.registry_digest || current.digest !== plan.digest) refuse('inventory_changed');
  const participant = current.state.participants.find(p => p.outcome === compiled.outcome);
  if (!participant) return undefined;
  if (participant.compiled_plan_digest !== compiled.compiled_plan_digest) refuse('inventory_changed');
  return { digest: current.digest };
}
export function checkReviewedWeightedSharedSumPostState(plan: ReviewedWeightedSharedSumProtection, compiled: CompiledActionRuleV1,
  facts: ActionRuleFactSetV1, effect: DerivedActionEffectV1, admitted_at: string): void {
  checkWeightedPostState(plan.state, compiled, facts, effect, admitted_at);
}
export function reviewedWeightedSharedSumGuardIdentity(plan: ReviewedWeightedSharedSumProtection, compiled: CompiledActionRuleV1,
  facts: ActionRuleFactSetV1): `sha256:${string}` {
  const ctx = plan.state.contexts.get(compiled.outcome);
  if (!ctx || !plan.state.participants.some(p => p.outcome === compiled.outcome && p.compiled_plan_digest === compiled.compiled_plan_digest))
    refuse('inventory_changed');
  validateBoundedInvariantRows(ctx, facts, refuse);
  // Identity describes the existing physical guard row. Rates, policy versions,
  // agents and presentation never create a different serialization family.
  return canonicalJsonDigest({ source: compiled.source,
    relation: canonicalJsonDigest([ctx.parent.resource.engine, ctx.parent.resource.source, ctx.parent.resource.schema, ctx.parent.resource.table]),
    tenant: facts.trusted.tenant, principal: facts.trusted.principal,
    key: { column: ctx.parent.resource.primary_key, value: facts.bindings[ctx.parent.binding]!.rows[0]![ctx.parent.resource.primary_key] } });
}
