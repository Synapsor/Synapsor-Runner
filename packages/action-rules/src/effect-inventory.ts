import type { ActionRuleSpecV1, DerivedEffectEnvelopeSpecV1, RuleVerificationBoundarySpecV1 } from "@synapsor/spec";
import { actionRuleEffectEnvelopes, actionRuleEffects, assertAtomicUpdateShape } from "./atomic-updates.js";
import { ActionRuleError } from "./errors.js";

/** Projection only: never compiles a rule, changes bounds, or grants disclosure. */
export function actionRuleEffectInventory(input: {
  rule: ActionRuleSpecV1; effect_envelope: DerivedEffectEnvelopeSpecV1; verification_boundary: RuleVerificationBoundarySpecV1;
}) {
  assertAtomicUpdateShape(input.rule, input.effect_envelope);
  const envelopes = actionRuleEffectEnvelopes(input.effect_envelope), effects = actionRuleEffects(input.rule);
  const components = effects.map((effect, index) => {
    const envelope = envelopes[index]!;
    const binding = input.verification_boundary.resources.find(r => r.binding === envelope.target_binding);
    if (!effect || !envelope || effect.operation !== envelope.operation || effect.target_resource !== envelope.target_resource
      || effect.target_binding !== envelope.target_binding || !Object.keys(effect.set ?? {}).length
      || Object.keys(effect.set).some(field => !envelope.allowed_fields.some(f => f.name === field))
      || envelope.max_rows !== 1 || (effect.operation === "update" && (!binding || binding.resource !== envelope.target_resource))) {
      throw new ActionRuleError("ACTION_RULE_EFFECT_OUTSIDE_BOUNDARY", "Complete effect inspection is unavailable: a business component does not match its reviewed envelope.");
    }
    return { role: index === 0 ? "primary" as const : "atomic_companion" as const,
      operation: effect.operation, source: envelope.source, resource: effect.target_resource,
      binding: envelope.target_binding ?? null, target: binding?.source ?? { kind: "new_record" as const },
      changes: structuredClone(effect.set), max_rows: envelope.max_rows,
      system_managed: envelope.version_advance ? { version_advance: { ...envelope.version_advance } } : {},
    };
  });
  return { schema_version: "synapsor.action-effect-inventory.v1" as const, completeness: "complete" as const,
    components, transaction: { grouping: components.length > 1 ? "atomic_updates" as const : "single_effect" as const,
      source: input.effect_envelope.source, semantics: "All guarded business effects and required source receipts commit in the same source transaction or roll back; no write occurs during review or request_change.",
      aggregate_row_bound: null, aggregate_bound_reason: "Per-component bounds only; no disjoint-target total is asserted." },
    // Verification collections, lock-only rows and receipts are not extra business mutations.
    verification: input.verification_boundary.resources.filter(r => !components.some(c => c.binding === r.binding))
      .map(r => ({ binding: r.binding, resource: r.resource, cardinality: r.cardinality, max_rows: r.max_rows, lock: r.lock })),
    observed_affected_rows: null,
  };
}

export function actionRuleEffectLines(input: Parameters<typeof actionRuleEffectInventory>[0]): string[] {
  const inventory = actionRuleEffectInventory(input);
  return ["Complete business effects (proposed contract; no write occurred):",
    ...inventory.components.flatMap(c => [
      `${c.role}: ${c.operation.toUpperCase()} ${c.resource} [${c.binding ?? "new record"}]; max_rows ${c.max_rows} for this component.`,
      `  Changes: ${JSON.stringify(c.changes)}`,
      `  Target: ${JSON.stringify(c.target)}`,
      ...(c.system_managed.version_advance ? [`  System-managed: ${c.system_managed.version_advance.column} advances by 1 (${c.system_managed.version_advance.strategy}).`] : []),
    ]),
    `${inventory.transaction.grouping} on ${inventory.transaction.source}: ${inventory.transaction.semantics}`,
    "No aggregate affected-row count is asserted. Verification/locks and receipt bookkeeping are separate from business effects.",
  ];
}

/** The legacy primary fields were public already. New companion details are
 * disclosed only for resources already named by the public subject contract.
 * Private expressions, predicates and related-source metadata never cross here. */
export function actionRulePublicEffects(input: Parameters<typeof actionRuleEffectInventory>[0]) {
  const inventory = actionRuleEffectInventory(input);
  return { schema_version: inventory.schema_version, completeness: "all_components_with_restricted_details" as const,
    components: inventory.components.map(c => {
      const disclosed = c.role === "primary" || input.rule.subjects.some(s => s.resource === c.resource);
      return { role: c.role, operation: c.operation,
        ...(disclosed ? { resource: c.resource, fields: Object.keys(c.changes) } : { target: "related reviewed record", details: "Operator-only physical target and fields." }),
        transformation: "Exact Runner-derived assignment; values and private expressions are not disclosed.",
        max_rows: c.max_rows,
        system_managed: c.system_managed.version_advance ? "Reviewed integer version counter advances by one." : "No version advance.",
      };
    }),
    transaction: { grouping: inventory.transaction.grouping, semantics: inventory.transaction.semantics,
      aggregate_row_bound: null, aggregate_bound_reason: inventory.transaction.aggregate_bound_reason },
    observed_affected_rows: null,
  };
}
