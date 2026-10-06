import type { SchemaInspection } from "@synapsor-runner/schema-inspector";

/** Declared synthetic metadata and operator words, not a physical database or
 * proof that any real writer maintains a counter. No expected saved records. */
export const VERSION_PROCESS_FACTS = {
  intent: "Prepare a proposal to complete a scheduled service visit.",
  outcomes: ["maintenance.complete_visit"],
  source: "A scheduled service visit may be proposed as completed. A maintenance reviewer must review the proposal. Counter maintenance requires the source owner's statement; it is not established by schema shape.",
  raw: "  Yes — every visit writer advances it, including café updates.\t ",
  question: "Does every application changing a visit advance this counter each time?",
  nextQuestion: "Which existing business reviewer should review this proposal?",
} as const;

export function versionProcessInspection(): SchemaInspection {
  const column = (name: string, data_type: string, ordinal_position: number) => ({ name, data_type,
    nullable: false, generated: false, ordinal_position, suggestions: { tenant: name === "tenant_id",
      conflict: false, sensitive: false, immutable: ["id", "tenant_id"].includes(name), large_or_binary: false } });
  return { engine: "postgres", server_version: "PostgreSQL 16", current_user: "app_reader",
    inspected_at: "2026-07-25T12:00:00.000Z", schemas: ["public"], warnings: [],
    role_posture: { verified: true, superuser: false, bypass_rls: false, read_only: true,
      writable_relations: [], owned_relations: [], reasons: [] }, tables: [{ schema: "public", name: "service_visits",
      type: "table", writable: true, columns: [column("id", "uuid", 1), column("tenant_id", "uuid", 2),
        { ...column("status", "text", 3), enum_values: ["scheduled", "completed"] }, column("c09", "integer", 4)],
      primary_key: ["id"], unique_constraints: [{ name: "service_visits_pkey", columns: ["id"] }], foreign_keys: [],
      indexes: [{ name: "service_visits_pkey", columns: ["id"], unique: true }], row_level_security: true,
      row_level_security_policies: [{ name: "tenant_read", command: "SELECT", permissive: true, roles: ["app_reader"],
        using_expression: "(tenant_id = current_setting('app.tenant_id')::uuid)" }],
      role_posture: { owner: "app_owner", current_role_is_owner: false, current_role_can_assume_owner: false,
        privileges: { select: true, insert: false, update: false, delete: false, truncate: false, references: false, trigger: false },
        row_security_forced: false, row_security_effective_for_current_role: true },
      suggestions: { tenant_columns: ["tenant_id"], conflict_columns: [], sensitive_columns: [], default_visible_columns: ["id", "tenant_id", "status"] } }] };
}
