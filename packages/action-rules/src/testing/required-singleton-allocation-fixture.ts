import type { ActionRuleSpecV1, DerivedEffectEnvelopeSpecV1, RuleVerificationBoundarySpecV1 } from "@synapsor/spec";
import type { ActionRuleCatalogV1 } from "../types.js";
import type { ActionRuleSubjectIdentityV1 } from "../fact-loader.js";

/** Fresh synthetic original-shaped allocation control. Native proof is supplied
 * only by its real inspected catalogue, never by this fixture constructor. */
export function requiredSingletonAllocationFixture(input: {
  generation_lock_fingerprint: `sha256:${string}`;
  column_declarations: { parent: Record<string, `sha256:${string}`>; witness: Record<string, `sha256:${string}`> };
  relationship_proof: NonNullable<ActionRuleCatalogV1["relationships"][number]["required_singleton_proof"]>;
}) {
  const text = { kind: "string", max_length: 64, comparison: "exact" } as const;
  const integer = { kind: "integer" } as const, boolean = { kind: "boolean" } as const;
  const lock = input.generation_lock_fingerprint;
  const identity = ["id", "tenant_id", "principal_id"].map(name => ({ name, type: text, nullable: false }));
  const parentFields = [...identity, { name: "allocated_count", type: integer, nullable: false },
    { name: "blocked", type: boolean, nullable: false }, { name: "version", type: integer, nullable: false }];
  const witnessFields = [...identity, { name: "allowed", type: boolean, nullable: false }, { name: "capacity", type: integer, nullable: false }];
  const catalog: ActionRuleCatalogV1 = { schema_version: "synapsor.action-rule-catalog.v1", generation_lock_fingerprint: lock,
    resources: [{ name: "b36.units", source: "database", engine: "postgres", schema: "b36", table: "units", primary_key: "id",
      tenant_key: "tenant_id", principal_scope_key: "principal_id", version_field: "version", fields: [...parentFields,
        // Advertised metadata only, not an allocation dependency or native proof.
        { name: "status", type: { ...text, enum: ["held", "open", "ready"] }, nullable: false }] },
    { name: "b36.eligibility", source: "database", engine: "postgres", schema: "b36", table: "eligibility", primary_key: "id",
      tenant_key: "tenant_id", principal_scope_key: "principal_id", verification_only: true, fields: witnessFields,
      private_evidence: { mode: "required_scoped_singleton", parent_resource: "b36.units", relationship: "eligibility_unit_fk",
        column_declarations: input.column_declarations } }],
    relationships: [{ name: "eligibility_unit_fk", from_resource: "b36.eligibility", to_resource: "b36.units",
      local_field: "id", target_field: "id", cardinality: "many_to_one", nullable: false, target_unique: true,
      required_singleton_proof: input.relationship_proof }] };
  const scope = { mode: "columns", tenant_field: "tenant_id", principal_field: "principal_id" } as const;
  const verification_boundary: RuleVerificationBoundarySpecV1 = {
    schema_version: "synapsor.verification-boundary.v1", name: "b36.verify", source: "database", context: "unit", generation_lock_fingerprint: lock,
    resources: [{ binding: "unit", resource: "b36.units", primary_key: "id", version_field: "version", source: { kind: "subject_ref" },
      fields: parentFields.map(field => ({ ...field, model_visible: false })), scope, cardinality: "one", max_rows: 1, overflow: "unsupported", lock: "for_update" },
    { binding: "eligibility", resource: "b36.eligibility", primary_key: "id", source: { kind: "relationship", from_binding: "unit",
      relationship: "eligibility_unit_fk", direction: "inverse", local_field: "id", target_field: "id" },
      fields: witnessFields.map(field => ({ ...field, model_visible: false })), scope, cardinality: "one", max_rows: 1,
      overflow: "unsupported", lock: "for_update", evidence_mode: "required_scoped_singleton" }],
    lock_order: ["unit", "eligibility"], transaction: { isolation: "read_committed", timezone: "UTC" } };
  const effect_envelope: DerivedEffectEnvelopeSpecV1 = { schema_version: "synapsor.derived-effect-envelope.v1", name: "b36.effect", source: "database",
    operation: "update", target_resource: "b36.units", target_binding: "unit", primary_key: "id", tenant_key: "tenant_id", principal_scope_key: "principal_id",
    conflict_key: "version", max_rows: 1, allowed_fields: [{ name: "allocated_count", type: integer, minimum: 0, maximum: 10_000 }],
    approval_classes: ["b36.review"], writeback: { mode: "direct_sql", supervised_worker: "allowed" },
    version_advance: { column: "version", strategy: "integer_increment" } };
  const field = (binding: string, name: string) => ({ kind: "field" as const, binding, field: name });
  const result = { kind: "math" as const, operation: "add" as const,
    inputs: [field("unit", "allocated_count"), { kind: "input" as const, name: "units" }] };
  const rule: ActionRuleSpecV1 = { schema_version: "synapsor.action-rule.v1", name: "b36.allocate", outcome: "b36.allocate", context: "unit", source: "database",
    verification_boundary_ref: verification_boundary.name, effect_envelope_ref: effect_envelope.name,
    subjects: [{ binding: "unit", resource: "b36.units", input: "opaque_subject_ref" }],
    inputs: [{ name: "units", type: integer, minimum: 1, maximum: 25, description: "Caller requested allocation units." }],
    require: { kind: "all", expressions: [
      { kind: "compare", operator: "eq", left: field("unit", "blocked"), right: { kind: "literal", value: false, value_type: boolean } },
      { kind: "compare", operator: "eq", left: field("eligibility", "allowed"), right: { kind: "literal", value: true, value_type: boolean } },
      { kind: "compare", operator: "lte", left: result, right: field("eligibility", "capacity") }] },
    derive: {}, effect: { operation: "update", target_resource: "b36.units", target_binding: "unit", set: { allocated_count: result } },
    approval_class: "b36.review", ttl_seconds: 300 };
  const subjects: ActionRuleSubjectIdentityV1[] = [{ binding: "unit", resource: "b36.units", primary_key: { column: "id", value: "u1" }, subject_ref_digest: lock }];
  return { catalog, verification_boundary, effect_envelope, rule, subjects };
}
