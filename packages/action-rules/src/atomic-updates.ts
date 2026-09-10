import type { ActionRuleSpecV1, DerivedEffectEnvelopeSpecV1 } from "@synapsor/spec";
import { ActionRuleError } from "./errors.js";

export const MAX_ATOMIC_UPDATE_TARGETS = 4;

/** Every member inherits the same authority and execution decision, never its own job. */
export function actionRuleEffectEnvelopes(envelope: DerivedEffectEnvelopeSpecV1): DerivedEffectEnvelopeSpecV1[] {
  const { atomic_updates: updates, ...primary } = envelope;
  return [primary, ...(updates ?? []).map(update => ({ ...update,
    schema_version: primary.schema_version, name: primary.name, source: primary.source,
    approval_classes: primary.approval_classes, writeback: primary.writeback,
  }))];
}

export function actionRuleEffects(rule: ActionRuleSpecV1): ActionRuleSpecV1["effect"][] {
  return [rule.effect, ...(rule.atomic_updates ?? [])];
}

export function assertAtomicUpdateShape(rule: ActionRuleSpecV1, envelope: DerivedEffectEnvelopeSpecV1): void {
  if (rule.atomic_updates === undefined && envelope.atomic_updates === undefined) return;
  if (!Array.isArray(rule.atomic_updates) || !Array.isArray(envelope.atomic_updates)
    || rule.atomic_updates.length < 1 || rule.atomic_updates.length >= MAX_ATOMIC_UPDATE_TARGETS
    || rule.atomic_updates.length !== envelope.atomic_updates.length) {
    throw new ActionRuleError("ACTION_RULE_EFFECT_OUTSIDE_BOUNDARY", "Atomic updates require matching ordered sets of two through four exact targets.");
  }
  const targets = actionRuleEffectEnvelopes(envelope), effects = actionRuleEffects(rule);
  if (targets.some(target => target.operation !== "update" || target.max_rows !== 1
    || !target.target_binding || !target.conflict_key
    || target.version_advance?.strategy !== "integer_increment" || target.version_advance.column !== target.conflict_key
    || target.deduplication !== undefined)
    || effects.some(effect => effect.operation !== "update")
    || new Set(targets.map(target => target.target_binding)).size !== targets.length) {
    throw new ActionRuleError("ACTION_RULE_EFFECT_OUTSIDE_BOUNDARY", "Atomic updates require distinct exact verified rows, each with its own reviewed integer version advance.");
  }
}
