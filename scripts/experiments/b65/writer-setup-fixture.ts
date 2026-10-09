import type { ActionRuleBooleanExpressionV1 } from "@synapsor/spec";
import { completeCollectionFixture } from "../../../packages/action-rules/src/testing/complete-collection-fixture.js";

/** Synthetic offline fixture, using existing strict AST and real dependency identities.
 * No activated hard-invariant authority or public proposal acceptance is claimed. */
export function invariantFixture(amount = 30) {
  const fixture = completeCollectionFixture();
  const integer = { kind: "integer", unit: "credits" } as const;
  const parent = fixture.catalog.resources[0]!;
  const child = fixture.catalog.resources[1]!;
  parent.fields.push({ name: "limit", type: integer, nullable: false });
  child.fields.push({ name: "credits", type: integer, nullable: false },
    { name: "version", type: { kind: "integer" }, nullable: false });
  child.version_field = "version";
  fixture.verification_boundary.resources[1]!.version_field = "version";
  const target = structuredClone(fixture.verification_boundary.resources[1]!);
  target.binding = "credit";
  target.source = { kind: "subject_ref" };
  target.cardinality = "one";
  target.max_rows = 1;
  target.version_field = "version";
  delete target.collection_consistency;
  delete target.deterministic_order;
  fixture.verification_boundary.resources.push(target);
  fixture.verification_boundary.lock_order.push("credit");
  fixture.rule.subjects.push({ binding: "credit", resource: child.name, input: "opaque_subject_ref" });
  fixture.subjects.push({ binding: "credit", resource: child.name,
    primary_key: { column: "hold_id", value: "h1" }, subject_ref_digest: fixture.subjects[0]!.subject_ref_digest });
  const active: ActionRuleBooleanExpressionV1 = { kind: "compare", operator: "eq",
    left: { kind: "field", binding: "holds", field: "state" },
    right: { kind: "literal", value: "active", value_type: child.fields.find(field => field.name === "state")!.type } };
  fixture.rule.require = { kind: "compare", operator: "lte",
    left: { kind: "aggregate", operation: "sum", binding: "holds", field: "credits", where: active },
    right: { kind: "field", binding: "customer", field: "limit" } };
  Object.assign(fixture.effect_envelope, { target_resource: child.name, target_binding: "credit",
    primary_key: "hold_id", conflict_key: "version", allowed_fields: [
      { name: "credits", type: integer, minimum: 0, maximum: 50 },
      { name: "state", type: child.fields.find(field => field.name === "state")!.type, values: ["active"] },
    ] });
  fixture.rule.effect = { operation: "update", target_resource: child.name, target_binding: "credit", set: {
    credits: { kind: "literal", value: amount, value_type: integer },
    state: { kind: "literal", value: "active", value_type: child.fields.find(field => field.name === "state")!.type },
  } };
  Object.assign(fixture.facts.bindings.customer!.rows[0]!, { limit: 50 });
  const credit = { tenant_id: "t1", principal_id: "p1", customer_id: "c1", hold_id: "h1",
    state: "released", credits: 0, version: 1 };
  fixture.facts.bindings.credit = { rows: [structuredClone(credit)] };
  fixture.facts.bindings.holds = { rows: [structuredClone(credit)] };
  return fixture;
}
