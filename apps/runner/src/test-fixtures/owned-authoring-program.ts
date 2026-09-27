import type { SchemaInspection } from "@synapsor-runner/schema-inspector";
import type { ActionRuleModelDraftV1 } from "../action-rule-draft.js";
export function ownedProgramDraft(index: number): ActionRuleModelDraftV1 {
  const outcome = `studio.pack_parcel_${index}`;
  return { schema_version: "synapsor.action-rule-model-draft.v1", name: outcome, outcome,
    inputs: [{ name: "units", description: "Requested units.", type: { kind: "integer" }, minimum: 1, maximum: 10 }],
    verification: { name: `${outcome}_verification`, resources: [{ binding: "parcel", resource: "studio.parcels", source: { kind: "subject_ref" }, fields: ["available"] }] },
    effect: { name: `${outcome}_effect`, operation: "update", target_resource: "studio.parcels", target_binding: "parcel",
      allowed_fields: [{ name: "units", minimum: 1, maximum: 10 }], set: { units: { kind: "input", name: "units" } }, writeback: "proposal_only" },
    require: { kind: "compare", operator: "eq", left: { kind: "field", binding: "parcel", field: "available" },
      right: { kind: "literal", value: true, value_type: { kind: "boolean" } } }, derive: {}, ttl_seconds: 300,
    approval: { class_name: "studio.shared_review", mode: "human", required_role: "parcel_reviewer", required_approvals: 1, shared_limits: [] },
    review: { when: "The parcel is available.", then: "Record requested units.", refused: ["The parcel is unavailable."], human_review: "One parcel reviewer decides.",
      examples: [{ kind: "eligible", scenario: "Available parcel", result: "Propose" }, { kind: "ineligible", scenario: "Unavailable parcel", result: "Refuse" }] } };
}
export function ownedProgramInspection(): SchemaInspection {
  const names = ["parcel_id", "tenant_id", "principal_id", "label", "units", "available", "version", "internal_note"];
  return { engine: "postgres", server_version: "PostgreSQL 16", current_user: "studio_reader", inspected_at: "2026-09-27T02:19:50Z", schemas: ["studio"], warnings: [],
    role_posture: { verified: true, superuser: false, bypass_rls: false, read_only: true, writable_relations: [], owned_relations: [], reasons: [] },
    tables: [{ schema: "studio", name: "parcels", type: "table", writable: true,
      columns: names.map((name, ordinal_position) => ({ name, data_type: ["units", "version"].includes(name) ? "integer" : name === "available" ? "boolean" : "text",
        ordinal_position, nullable: false, generated: false, suggestions: { tenant: name === "tenant_id", conflict: name === "version", sensitive: name === "internal_note",
          immutable: name.endsWith("_id"), large_or_binary: false } })),
      primary_key: ["parcel_id"], unique_constraints: [{ name: "parcels_pkey", columns: ["parcel_id"] }], check_constraints: [], foreign_keys: [], row_level_security: false, indexes: [],
      role_posture: { owner: "studio_owner", current_role_is_owner: false, current_role_can_assume_owner: false,
        privileges: { select: true, insert: false, update: false, delete: false, truncate: false, references: false, trigger: false }, row_security_forced: false, row_security_effective_for_current_role: false },
      suggestions: { tenant_columns: ["tenant_id"], conflict_columns: ["version"], sensitive_columns: ["internal_note"], default_visible_columns: ["label", "units"] } }] };
}
