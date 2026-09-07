import { compileActionRule, type ActionRuleCatalogV1, type ActionRuleFactSetV1 } from "@synapsor-runner/action-rules";
import type { ActionRuleSpecV1, DerivedEffectEnvelopeSpecV1, RuleVerificationBoundarySpecV1 } from "@synapsor/spec";
import type { OwnerPolicyDefinition, OwnerPolicyParent } from "./owner-policy-language.js";

export function ownerPolicyTestFixture(domain = "inventory", coded = false) {
  const resource = `${domain}.${coded ? "t17" : "requests"}`, amount = coded ? "f09" : "quantity";
  const id = { kind: "string", max_length: 64, comparison: "exact" } as const;
  const integer = { kind: "integer", unit: "units" } as const;
  const catalog: ActionRuleCatalogV1 = { schema_version: "synapsor.action-rule-catalog.v1", generation_lock_fingerprint: `sha256:${"a".repeat(64)}`,
    resources: [{ name: resource, source: "local_postgres", engine: "postgres", schema: domain, table: coded ? "t17" : "requests",
      primary_key: "id", tenant_key: "tenant_id", principal_scope_key: "principal_id", version_field: "version", fields: [
        { name: "id", type: id, nullable: false }, { name: "tenant_id", type: id, nullable: false }, { name: "principal_id", type: id, nullable: false },
        { name: "version", type: { kind: "integer" }, nullable: false }, { name: amount, type: integer, nullable: false },
        { name: "available", type: { kind: "boolean" }, nullable: false },
        { name: "category", type: { kind: "string", max_length: 16, comparison: "exact", enum: ["routine", "exception"] }, nullable: false },
        { name: "expires_at", type: { kind: "timestamp" }, nullable: false },
      ] }], relationships: [] };
  const boundary: RuleVerificationBoundarySpecV1 = { schema_version: "synapsor.verification-boundary.v1", name: `${domain}.verify`, source: "local_postgres",
    context: "trusted_context", generation_lock_fingerprint: catalog.generation_lock_fingerprint, resources: [{
      binding: "request", resource, source: { kind: "subject_ref" }, primary_key: "id", version_field: "version", fields: catalog.resources[0]!.fields,
      scope: { mode: "columns", tenant_field: "tenant_id", principal_field: "principal_id" }, cardinality: "one", max_rows: 1, overflow: "unsupported", lock: "for_update",
    }], lock_order: ["request"], transaction: { isolation: "repeatable_read", timezone: "UTC" } };
  const envelope: DerivedEffectEnvelopeSpecV1 = { schema_version: "synapsor.derived-effect-envelope.v1", name: `${domain}.effect`,
    source: "local_postgres", operation: "update", target_resource: resource, target_binding: "request", primary_key: "id",
    tenant_key: "tenant_id", principal_scope_key: "principal_id", conflict_key: "version", max_rows: 1,
    allowed_fields: [{ name: amount, type: integer, minimum: 1, maximum: 50 }], version_advance: { column: "version", strategy: "integer_increment" },
    approval_classes: [`${domain}.reviewer`], writeback: { mode: "direct_sql", supervised_worker: "allowed" } };
  const rule: ActionRuleSpecV1 = { schema_version: "synapsor.action-rule.v1", name: `${domain}.adjust`, outcome: `${domain}.adjust`,
    source: "local_postgres", context: "trusted_context", verification_boundary_ref: boundary.name, effect_envelope_ref: envelope.name,
    subjects: [{ binding: "request", resource, input: "opaque_subject_ref" }],
    inputs: [{ name: "quantity", description: "Requested units", type: integer, minimum: 1, maximum: 50 }],
    require: { kind: "compare", operator: "eq", left: { kind: "field", binding: "request", field: "available" }, right: { kind: "literal", value: true, value_type: { kind: "boolean" } } },
    derive: { next_units: { kind: "input", name: "quantity" } },
    effect: { operation: "update", target_resource: resource, target_binding: "request", set: { [amount]: { kind: "derived", name: "next_units" } } },
    approval_class: `${domain}.reviewer`, ttl_seconds: 120 };
  const compiled = compileActionRule({ rule, catalog, verification_boundary: boundary, effect_envelope: envelope });
  const parent: OwnerPolicyParent = { schema_version: "synapsor.owner-policy-parent.v1", agents: ["agent-a", "agent-b"], outcomes: [{
    outcome: rule.outcome, compiled_plan_digest: compiled.compiled_plan_digest, allow_automatic_approval: true,
    facts: [
      { name: "requested_units", title: "Requested units", source: { kind: "input", name: "quantity" }, operators: ["lte", "gte", "eq"], literal_range: { minimum: 1, maximum: 50 } },
      { name: "current_units", title: "Current units", source: { kind: "field", binding: "request", field: amount }, operators: ["lte", "gte", "eq"] },
      { name: "request_category", title: "Request category", source: { kind: "field", binding: "request", field: "category" }, operators: ["eq", "one_of"] },
      { name: "valid_until", title: "Valid until", source: { kind: "field", binding: "request", field: "expires_at" }, operators: ["gt", "is_present"] },
      { name: "current_time", title: "Current time", source: { kind: "trusted", binding: "transaction_time" }, operators: ["gt"] },
    ],
    require: { kind: "compare_facts", fact: "valid_until", operator: "gt", other_fact: "current_time" },
  }] };
  const definition: OwnerPolicyDefinition = { schema_version: "synapsor.owner-policy.v1", agents: ["agent-a"], rules: [{ outcome: rule.outcome,
    require: { kind: "compare", fact: "requested_units", operator: "lte", value: 20 }, approval: "inherit",
    auto_approve_when: { kind: "one_of", fact: "request_category", values: ["routine"] },
  }] };
  const facts: ActionRuleFactSetV1 = { bindings: { request: { rows: [{ id: "request-1", tenant_id: "acme", principal_id: "maya", version: 1,
    [amount]: 5, available: true, category: "routine", expires_at: "2030-01-01T00:00:00.000Z" }] } },
    trusted: { tenant: "acme", principal: "maya", transaction_time: "2026-09-07T00:00:00.000Z" }, subject_provenance_digest: `sha256:${"b".repeat(64)}` };
  return { parent, definition, compiled, facts, resource, amount };
}
