import type { ActionRuleScalarTypeSpecV1, ActionRuleSpecV1, DerivedEffectEnvelopeSpecV1, RuleVerificationBoundarySpecV1 } from "@synapsor/spec";
import type { ActionRuleCatalogV1, ActionRuleFactSetV1 } from "../types.js";

export function completeCollectionFixture(engine: "postgres" | "mysql" = "postgres") {
  const id = { kind: "string", max_length: 64, comparison: "exact" } as const;
  const integer = { kind: "integer" } as const;
  const status = { kind: "string", max_length: 16, comparison: "exact", enum: ["active", "released", "ready"] } satisfies ActionRuleScalarTypeSpecV1;
  const digest = `sha256:${"a".repeat(64)}` as const;
  const fields = [{ name: "tenant_id", type: id, nullable: false }, { name: "principal_id", type: id, nullable: false },
    { name: "customer_id", type: id, nullable: false }, { name: "state", type: status, nullable: false }];
  const pairs = ["tenant_id", "principal_id", "customer_id"].map(field => ({ local_field: field, target_field: field }));
  const catalog: ActionRuleCatalogV1 = {
    schema_version: "synapsor.action-rule-catalog.v1", generation_lock_fingerprint: digest,
    resources: [
      { name: "collections.customers", source: "database", engine, schema: "collections", table: "customers", primary_key: "customer_id",
        tenant_key: "tenant_id", principal_scope_key: "principal_id", version_field: "version",
        fields: [...fields, { name: "version", type: integer, nullable: false }] },
      { name: "collections.holds", source: "database", engine, schema: "collections", table: "holds", primary_key: "hold_id",
        tenant_key: "tenant_id", principal_scope_key: "principal_id", fields: [...fields, { name: "hold_id", type: id, nullable: false }] },
    ],
    relationships: [{ name: "holds_customer_fk", from_resource: "collections.holds", to_resource: "collections.customers",
      field_pairs: pairs, cardinality: "many_to_one", nullable: false, target_unique: true }],
  };
  const scope = { mode: "columns", tenant_field: "tenant_id", principal_field: "principal_id" } as const;
  const verification_boundary: RuleVerificationBoundarySpecV1 = {
    schema_version: "synapsor.verification-boundary.v1", name: "collections.verify", source: "database", context: "customer",
    generation_lock_fingerprint: digest, resources: [
      { binding: "customer", resource: "collections.customers", source: { kind: "subject_ref" }, primary_key: "customer_id", version_field: "version",
        fields: catalog.resources[0]!.fields, scope, cardinality: "one", max_rows: 1, overflow: "unsupported", lock: "for_update" },
      { binding: "holds", resource: "collections.holds", source: { kind: "relationship", from_binding: "customer", relationship: "holds_customer_fk",
        direction: "inverse", field_pairs: pairs }, primary_key: "hold_id", fields: catalog.resources[1]!.fields, scope,
        cardinality: "many", collection_consistency: "complete_locked", max_rows: 5, overflow: "unsupported",
        deterministic_order: [{ field: "hold_id", direction: "asc" }], lock: "for_update" },
    ], lock_order: ["customer", "holds"], transaction: { isolation: engine === "postgres" ? "read_committed" : "repeatable_read", timezone: "UTC" },
  };
  const effect_envelope: DerivedEffectEnvelopeSpecV1 = {
    schema_version: "synapsor.derived-effect-envelope.v1", name: "collections.effect", source: "database", operation: "update",
    target_resource: "collections.customers", target_binding: "customer", primary_key: "customer_id", tenant_key: "tenant_id",
    principal_scope_key: "principal_id", conflict_key: "version", max_rows: 1, allowed_fields: [{ name: "state", type: status, values: ["ready"] }],
    approval_classes: ["collections.review"], writeback: { mode: "none", supervised_worker: "disabled" },
    version_advance: { column: "version", strategy: "integer_increment" },
  };
  const rule: ActionRuleSpecV1 = {
    schema_version: "synapsor.action-rule.v1", name: "collections.ready", outcome: "collections.ready", context: "customer", source: "database",
    verification_boundary_ref: verification_boundary.name, effect_envelope_ref: effect_envelope.name,
    subjects: [{ binding: "customer", resource: "collections.customers", input: "opaque_subject_ref" }],
    require: { kind: "not", expression: { kind: "exists", binding: "holds", where: { kind: "compare", operator: "eq",
      left: { kind: "field", binding: "holds", field: "state" }, right: { kind: "literal", value: "active", value_type: status } } } },
    derive: {}, effect: { operation: "update", target_resource: "collections.customers", target_binding: "customer",
      set: { state: { kind: "literal", value: "ready", value_type: status } } }, approval_class: "collections.review", ttl_seconds: 300,
  };
  const facts: ActionRuleFactSetV1 = { bindings: { customer: { rows: [{ tenant_id: "t1", principal_id: "p1", customer_id: "c1", state: "active", version: 1 }] }, holds: { rows: [] } },
    trusted: { tenant: "t1", principal: "p1", transaction_time: "2026-09-10T00:00:00.000Z" }, subject_provenance_digest: digest };
  const subjects = [{ binding: "customer", resource: "collections.customers", primary_key: { column: "customer_id", value: "c1" }, subject_ref_digest: digest }];
  return { catalog, verification_boundary, effect_envelope, rule, facts, subjects };
}
