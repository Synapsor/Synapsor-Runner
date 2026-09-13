import type { ActionRuleModelDraftV1 } from "./action-rule-draft.js";
import type { SchemaInspection } from "@synapsor-runner/schema-inspector";
// Existing warehouse structured-authoring fixture, shared with the execution regression.
export function structuredTestAction(name: string, field: string, maximum: number, automaticMaximum: number): ActionRuleModelDraftV1 {
  return {
    schema_version: "synapsor.action-rule-model-draft.v1", name: `warehouse.${name}`, outcome: `warehouse.${name}`,
    inputs: [{ name: "units", description: "Requested individual units.", type: { kind: "integer" }, minimum: 1, maximum }],
    verification: { name: `warehouse.${name}_verification`, resources: [{ binding: "item", resource: "warehouse.items", source: { kind: "subject_ref" }, fields: ["available"] }] },
    effect: { name: `warehouse.${name}_effect`, operation: "update", target_resource: "warehouse.items", target_binding: "item",
      allowed_fields: [{ name: field, minimum: 1, maximum }], set: { [field]: { kind: "input", name: "units" } }, writeback: "supervised" },
    require: { kind: "compare", operator: "eq", left: { kind: "field", binding: "item", field: "available" },
      right: { kind: "literal", value: true, value_type: { kind: "boolean" } } },
    derive: {}, approval: { class_name: "warehouse.shared", mode: "policy", required_role: "warehouse_manager", required_approvals: 1,
      auto_approve_when: { kind: "compare", operator: "lte", left: { kind: "input", name: "units" },
        right: { kind: "literal", value: automaticMaximum, value_type: { kind: "integer" } } },
      shared_limits: [{ id: "joint_overall", kind: "count", scope: "boundary", maximum: 10, window_seconds: 86400 },
        { id: "joint_company", kind: "count", scope: "tenant", maximum: 3, window_seconds: 86400 },
        { id: "quantity_limit", kind: "count", scope: "capability", capability: "warehouse.quantity", maximum: 8, window_seconds: 86400 },
        { id: "reorder_limit", kind: "count", scope: "capability", capability: "warehouse.reorder", maximum: 7, window_seconds: 86400 }] },
    ttl_seconds: 300, review: { when: "The selected item is available.", then: `Set ${field} to the requested units.`,
      refused: ["The item is unavailable or the units are outside the hard range."], human_review: "One warehouse manager reviews valid exceptions.",
      examples: [{ kind: "eligible", scenario: "Available item, routine units", result: "Automatic approval within shared limits" },
        { kind: "ineligible", scenario: "Unavailable item", result: "Refuse" }] },
  };
}

export function structuredTestInspection(): SchemaInspection {
  const names = ["item_id", "tenant_id", "principal_id", "sku", "q_av", "reorder_point", "available", "version", "internal_note"];
  return { engine: "postgres", server_version: "PostgreSQL 16", current_user: "reader", inspected_at: "2026-09-08T00:00:00.000Z",
    schemas: ["warehouse"], warnings: [], role_posture: { verified: true, superuser: false, bypass_rls: false, read_only: true,
      writable_relations: [], owned_relations: [], reasons: [] }, tables: [{ schema: "warehouse", name: "items", type: "table", writable: true,
      columns: names.map((name, ordinal_position) => ({ name, data_type: ["q_av", "reorder_point", "version"].includes(name) ? "integer" : name === "available" ? "boolean" : "text",
        ordinal_position, nullable: false, generated: false, suggestions: { tenant: name === "tenant_id", conflict: name === "version",
          sensitive: name === "internal_note", immutable: name.endsWith("_id"), large_or_binary: false } })),
      primary_key: ["item_id"], unique_constraints: [{ name: "items_pkey", columns: ["item_id"] }], check_constraints: [], foreign_keys: [],
      row_level_security: false, indexes: [], role_posture: { owner: "owner", current_role_is_owner: false, current_role_can_assume_owner: false,
        privileges: { select: true, insert: false, update: false, delete: false, truncate: false, references: false, trigger: false },
        row_security_forced: false, row_security_effective_for_current_role: false },
      suggestions: { tenant_columns: ["tenant_id"], conflict_columns: ["version"], sensitive_columns: ["internal_note"], default_visible_columns: ["sku", "q_av", "reorder_point"] } }],
  };
}
