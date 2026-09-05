import type { RuleRelationshipFieldPairSpecV1, RuleRelationshipFieldsSpecV1 } from "@synapsor/spec";
import { ActionRuleError } from "./errors.js";

/** Validate without rewriting legacy signed authority or discarding tuple order. */
export function actionRuleRelationshipPairs(value: RuleRelationshipFieldsSpecV1): RuleRelationshipFieldPairSpecV1[] {
  const invalid = (): never => { throw new ActionRuleError("ACTION_RULE_INVALID", "Relationship requires either two fixed fields or 2 through 16 ordered, unique field pairs; mixed representations are forbidden."); };
  const identifier = (field: unknown): field is string => typeof field === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(field);
  if (value.field_pairs === undefined) {
    if (!identifier(value.local_field) || !identifier(value.target_field)) return invalid();
    return [{ local_field: value.local_field, target_field: value.target_field }];
  }
  if (value.local_field !== undefined || value.target_field !== undefined
    || !Array.isArray(value.field_pairs) || value.field_pairs.length < 2 || value.field_pairs.length > 16) return invalid();
  const local = new Set<string>();
  const target = new Set<string>();
  for (const pair of value.field_pairs) {
    if (!pair || Object.keys(pair).some((key) => key !== "local_field" && key !== "target_field")
      || !identifier(pair.local_field) || !identifier(pair.target_field)
      || local.has(pair.local_field) || target.has(pair.target_field)) return invalid();
    local.add(pair.local_field);
    target.add(pair.target_field);
  }
  return value.field_pairs;
}
