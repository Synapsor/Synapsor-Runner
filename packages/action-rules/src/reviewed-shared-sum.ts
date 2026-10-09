import { canonicalJsonDigest } from '@synapsor-runner/protocol';
import { ActionRuleError } from './errors.js';
import { parseReviewedSharedSum } from './shared-sum-designation.js';
import { buildSharedSumDerivedState, checkSharedSumDerivedPostState, sharedSumDerivedGuardIdentity,
  type SharedSumDerivedState } from './experimental-shared-sum.js';
import type { ActionRuleFactSetV1, CompiledActionRuleV1, DerivedActionEffectV1, RuntimeActionRuleRegistryV1 } from './types.js';

/** Derived solely from current persisted authority; never accepted as runtime configuration. */
export type ReviewedSharedSumProtection = Readonly<{ digest: `sha256:${string}`;
  registry_digest: `sha256:${string}`; state: SharedSumDerivedState }>;

function refuse(stage: string): never {
  throw new ActionRuleError('ACTION_RULE_SCOPE_UNPROVEN',
    'The reviewed shared limit cannot be inspected with the supported Source guarantees.', `source.hard_limit.shared_sum_${stage}`);
}
function kernel<T>(run: () => T): T {
  try { return run(); } catch (error) {
    if (error instanceof ActionRuleError && error.path?.startsWith('experimental.shared_sum.'))
      refuse(error.path.slice('experimental.shared_sum.'.length));
    throw error;
  }
}

/** Pure complete-registry validation. Publication calls this before immutable
 * indexing; calling snapshotActionRuleRegistry here would recurse. */
export function deriveReviewedSharedSumProtection(registry: RuntimeActionRuleRegistryV1): ReviewedSharedSumProtection | undefined {
  if (registry.shared_sum === undefined) {
    if (registry.schema_version !== 'synapsor.action-rule-registry.v1') refuse('designation_missing');
    return undefined;
  }
  if (registry.schema_version !== 'synapsor.action-rule-registry.v2') refuse('authority_version');
  const record = parseReviewedSharedSum(registry.shared_sum), d = record.designation;
  // Source aliases could resolve to the same database. This bounded profile
  // cannot prove that a second Source or an uninspected writer has no effects
  // on the invariant, so the complete authority must stay within one Source.
  if (registry.rules.some(({ compiled }) => compiled.source !== d.source)) refuse('source_inventory');
  const state = kernel(() => buildSharedSumDerivedState(registry, { schema_version: 'synapsor.experimental.shared-sum-protection.v1',
    kind: 'experimental_shared_sum', source: d.source, scope: d.scope, limit: d.limit, populations: d.populations,
    time: d.time, external_writers: d.external_writers }));
  if (registry.rules.some(({ compiled }) => compiled.effect_envelope.writeback.mode !== 'none'
    && !state.contexts.has(compiled.outcome))) refuse('writer_inventory');
  const participants = registry.rules.filter(r => state.contexts.has(r.compiled.outcome));
  if (new Set(registry.rules.map(r => canonicalJsonDigest([r.action_boundary_name, r.action_boundary_digest]))).size !== 1)
    refuse('boundary_inventory');
  const boundary = { schema_version: 'synapsor.semantic-action-boundary.v2', name: participants[0]!.action_boundary_name,
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
  if (canonicalJsonDigest(boundary) !== participants[0]!.action_boundary_digest) refuse('boundary_inventory');
  for (const { compiled, read_boundary_name, read_boundary_digest } of participants) {
    if (compiled.generation_lock_fingerprint !== record.confirmation.generation_lock_fingerprint) refuse('generation');
    if (!record.confirmation.read_dependencies.some(r => r.name === read_boundary_name && r.digest === read_boundary_digest))
      refuse('read_provenance');
    const ctx = state.contexts.get(compiled.outcome)!;
    const values = [{ binding: ctx.parent, field: d.limit.field },
      ...ctx.populations.map((binding, i) => ({ binding, field: d.populations[i]!.field }))];
    for (const { binding, field } of values) {
      const actual = binding.verification.fields.find(f => f.name === field)?.type;
      if (!actual || actual.kind !== d.unit.kind || actual.unit !== d.unit.unit) refuse('unit');
    }
  }
  return Object.freeze({ digest: canonicalJsonDigest({ schema_version: 'synapsor.shared-sum-invariant.v1', meaning: state.meaning }),
    registry_digest: registry.digest, state });
}

export function assertReviewedSharedSumRegistry(registry: RuntimeActionRuleRegistryV1): void {
  deriveReviewedSharedSumProtection(registry);
}
export function resolveReviewedSharedSumProtection(plan: ReviewedSharedSumProtection, registry: RuntimeActionRuleRegistryV1,
  compiled: CompiledActionRuleV1): { digest: `sha256:${string}` } | undefined {
  const current = deriveReviewedSharedSumProtection(registry);
  if (!current || current.registry_digest !== plan.registry_digest || current.digest !== plan.digest) refuse('inventory_changed');
  const participant = current.state.participants.find(p => p.outcome === compiled.outcome);
  if (!participant) return undefined;
  if (participant.compiled_plan_digest !== compiled.compiled_plan_digest) refuse('inventory_changed');
  return { digest: current.digest };
}
export function checkReviewedSharedSumPostState(plan: ReviewedSharedSumProtection, compiled: CompiledActionRuleV1,
  facts: ActionRuleFactSetV1, effect: DerivedActionEffectV1): void {
  kernel(() => checkSharedSumDerivedPostState(plan.state, compiled, facts, effect));
}
export function reviewedSharedSumGuardIdentity(plan: ReviewedSharedSumProtection, compiled: CompiledActionRuleV1,
  facts: ActionRuleFactSetV1): `sha256:${string}` {
  return kernel(() => {
    const parent = sharedSumDerivedGuardIdentity(plan.state, compiled, facts);
    const ctx = plan.state.contexts.get(compiled.outcome)!;
    const populations = ctx.populations.map(b => canonicalJsonDigest([
      b.resource.engine, b.resource.source, b.resource.schema, b.resource.table])).sort();
    // A diagnostic identity for the existing physical parent-row lock, never
    // a new lock family keyed by policy revision, presentation or amount.
    return canonicalJsonDigest({ parent, populations });
  });
}
