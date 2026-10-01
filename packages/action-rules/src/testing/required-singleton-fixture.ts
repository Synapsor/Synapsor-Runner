import { completeCollectionFixture } from "./complete-collection-fixture.js";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";

/** Synthetic canonical metadata/control, never a live catalogue or scope observation. */
export function requiredSingletonFixture() {
  const f = completeCollectionFixture();
  const witness = f.catalog.resources[1]!, binding = f.verification_boundary.resources[1]!, relationship = f.catalog.relationships[0]!;
  witness.verification_only = true;
  witness.private_evidence = { mode: "required_scoped_singleton", parent_resource: f.catalog.resources[0]!.name,
    relationship: relationship.name,
    column_declarations: {
      witness: Object.fromEntries(witness.fields.map(field => [field.name, canonicalJsonDigest({ synthetic_only: true, field })])),
      parent: Object.fromEntries(f.catalog.resources[0]!.fields.map(field => [field.name, canonicalJsonDigest({ synthetic_only: true, field })])),
    } };
  delete relationship.field_pairs;
  Object.assign(relationship, { local_field: "customer_id", target_field: "customer_id" });
  relationship.required_singleton_proof = { child_unique_key: "holds_customer_unique", child_unique_index: "holds_customer_unique",
    parent_unique_key: "customers_pkey", parent_unique_index: "customers_pkey" };
  if (binding.source.kind !== "relationship") throw new Error("fixture source");
  delete binding.source.field_pairs;
  Object.assign(binding.source, { local_field: "customer_id", target_field: "customer_id" });
  binding.cardinality = "one";
  binding.max_rows = 1;
  binding.evidence_mode = "required_scoped_singleton";
  delete binding.collection_consistency;
  delete binding.deterministic_order;
  f.rule.require = { kind: "compare", operator: "eq", left: { kind: "field", binding: "holds", field: "state" },
    right: { kind: "literal", value: "active", value_type: witness.fields.find(field => field.name === "state")!.type } };
  f.facts.bindings.holds = { rows: [{ tenant_id: "t1", principal_id: "p1", customer_id: "c1", hold_id: "h1", state: "active" }] };
  return f;
}
