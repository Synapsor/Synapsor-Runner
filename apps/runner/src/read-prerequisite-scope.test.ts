import { describe, expect, it } from "vitest";
import { ACTION_RULE_CATALOG_VERSION, type ActionRuleCatalogV1 } from "@synapsor-runner/action-rules";
import type { SchemaInspection, TableInfo } from "@synapsor-runner/schema-inspector";
import { actionRuleRelationshipsForTable, actionRuleTypeForColumn, uniqueKey } from "./action-rule-authoring.js";
import * as schemaMetadata from "./action-rule-schema-metadata.js";
import { resolveReadPrerequisiteScope, type ReadPrerequisiteScopeBoundaryContext } from "./read-prerequisite-scope.js";
import { listReadCurrentStatePrerequisiteSources, listSupportedReadCurrentStatePrerequisiteCandidates,
  prepareReviewedReadCurrentStatePrerequisite, type ReadPrerequisiteBoundaryContext } from "./read-prerequisite.js";

function column(name: string, data_type = "uuid"): TableInfo["columns"][number] {
  return { name, data_type, nullable: false, generated: false, ordinal_position: 1,
    suggestions: { tenant: false, conflict: false, sensitive: false, immutable: false, large_or_binary: false } };
}
function table(name: string, fields: string[]): TableInfo {
  return { schema: "coded", name, type: "table", writable: false, columns: fields.map(name => column(name)),
    primary_key: ["row"], unique_constraints: [], foreign_keys: [], indexes: [],
    suggestions: { tenant_columns: [], conflict_columns: [], sensitive_columns: [], default_visible_columns: [] },
    row_level_security: false,
    role_posture: { owner: "owner", current_role_is_owner: false, current_role_can_assume_owner: false,
      row_security_forced: false, row_security_effective_for_current_role: false,
      privileges: { select: true, insert: false, update: false, delete: false, truncate: false, references: false, trigger: false } } };
}
function fixture() {
  const parent = table("p3", ["row", "a", "b"]);
  parent.unique_constraints = [{ name: "parent_tuple", columns: ["a", "b", "row"] }];
  parent.columns.find(column => column.name === "a")!.comment = "Person? This misleading comment is not scope authority.";
  const child = table("r7", ["row", "x", "y", "z", "other"]);
  child.columns.push({ ...column("s", "text"), enum_values: ["yes", "no"] }, column("d0", "timestamptz"), column("d1", "timestamptz"));
  child.unique_constraints = [{ name: "subject_pair", columns: ["x", "y"] }];
  child.foreign_keys = [{ name: "exact_parent", columns: ["y", "x", "z"], referenced_schema: "coded", referenced_table: "p3",
    referenced_columns: ["b", "a", "row"], delete_rule: "RESTRICT" }];
  const inspection: SchemaInspection = { engine: "postgres", server_version: "16", current_user: "reader", inspected_at: "2026-09-11T00:00:00Z",
    schemas: ["coded"], warnings: [], tables: [parent, child],
    role_posture: { verified: true, superuser: false, bypass_rls: false, read_only: true, writable_relations: [], owned_relations: [], reasons: [] } };
  const boundary: ReadPrerequisiteBoundaryContext = { source: "fixture", generation_lock_fingerprint: `sha256:${"a".repeat(64)}`,
    trusted_context: { provider: "environment", principal_env: "FIXTURE_PERSON" },
    pack: { resources: [{ id: "coded.p3", schema: "coded", table: "p3", tenant_key: "a", principal_key: "b",
      field_types: { row: "uuid", a: "uuid", b: "uuid" } }] } };
  return { inspection, boundary, parent, child, source: { schema: "coded", table: "r7" } };
}
function catalog(f: ReturnType<typeof fixture>, selected: TableInfo = f.child): ActionRuleCatalogV1 {
  const parent = selected === f.parent;
  return { schema_version: ACTION_RULE_CATALOG_VERSION, generation_lock_fingerprint: f.boundary.generation_lock_fingerprint!, relationships: [],
    resources: [{ name: `coded.${selected.name}`, source: "fixture", engine: "postgres", schema: selected.schema, table: selected.name,
      primary_key: "row", tenant_key: parent ? "a" : "x", principal_scope_key: parent ? "b" : "y", verification_only: true,
      fields: selected.columns.map(column => ({ name: column.name, nullable: column.nullable, type: actionRuleTypeForColumn(column)! })) }] };
}

describe("private Read prerequisite exact scope proof", () => {
  it("reuses the exact cycle-free Action schema proof helpers through the compatibility exports", () => {
    expect(actionRuleRelationshipsForTable).toBe(schemaMetadata.actionRuleRelationshipsForTable);
    expect(actionRuleTypeForColumn).toBe(schemaMetadata.actionRuleTypeForColumn);
    expect(uniqueKey).toBe(schemaMetadata.uniqueKey);
  });

  it("derives coded child roles from the complete ordered immediate FK without mutating inputs", () => {
    const f = fixture(), before = structuredClone(f);
    const result = resolveReadPrerequisiteScope(f.inspection, f.boundary, f.source);
    expect(result).toMatchObject({ state: "proven", subject: { tenant_column: "x", principal_column: "y" }, proof_digest: expect.stringMatching(/^sha256:/) });
    if (result.state === "proven") expect(result.details).toEqual(expect.arrayContaining([
      "coded.r7.y -> coded.p3.b", "coded.r7.x -> coded.p3.a", "coded.r7.z -> coded.p3.row",
    ]));
    const entries = listSupportedReadCurrentStatePrerequisiteCandidates(f.inspection, f.boundary);
    expect(entries).toHaveLength(2);
    expect(entries.every(entry => entry.subject.tenant_column === "x" && entry.subject.principal_column === "y")).toBe(true);
    expect(listReadCurrentStatePrerequisiteSources(f.inspection, f.boundary)).toEqual([f.source]);
    const candidate = entries.find(entry => entry.current_state.effective_from_column === "d0")!;
    expect(prepareReviewedReadCurrentStatePrerequisite({ source: candidate.source, subject: candidate.subject,
      current_state: { state_column: "s", positive_state: "yes", effective_from_column: "d0", effective_until_column: "d1", interval: "[effective_from,effective_until)", clock: "database_utc" },
      semantic_consent: { confirmed: true, source_description: "Owner-reviewed current register.", positive_state_description: "Yes within the effective interval qualifies." },
    }, f.inspection, f.boundary).subject).toEqual(candidate.subject);
    expect(f).toEqual(before);
  });

  it("keeps direct reviewed roles rather than inferring semantics from field names or comments", () => {
    const f = fixture();
    f.boundary.pack.resources = [{ schema: "coded", table: "r7", tenant_key: "y", principal_key: "x" }];
    expect(resolveReadPrerequisiteScope(f.inspection, f.boundary, f.source)).toMatchObject({ state: "proven", subject: { tenant_column: "y", principal_column: "x" } });
    expect(listSupportedReadCurrentStatePrerequisiteCandidates(f.inspection, f.boundary).every(candidate => candidate.subject.tenant_column === "y")).toBe(true);
  });

  it.each(["retained_lock", "retained_guard", "deferred_fk"])("rechecks scope at final preparation after enumeration (%s)", change => {
    const f = fixture();
    if (change !== "deferred_fk") f.boundary.scopeEvidence = { retained_action_catalogs: [catalog(f)] };
    const candidate = listSupportedReadCurrentStatePrerequisiteCandidates(f.inspection, f.boundary)
      .find(candidate => candidate.current_state.effective_from_column === "d0")!;
    expect(candidate).toBeDefined();
    if (change === "retained_lock") f.boundary.scopeEvidence!.retained_action_catalogs[0]!.generation_lock_fingerprint = `sha256:${"b".repeat(64)}`;
    if (change === "retained_guard") f.boundary.scopeEvidence!.retained_action_catalogs[0]!.resources[0]!.fields.find(field => field.name === "x")!.nullable = true;
    if (change === "deferred_fk") f.child.foreign_keys[0]!.deferrable = true;
    expect(() => prepareReviewedReadCurrentStatePrerequisite({ source: candidate.source, subject: candidate.subject,
      current_state: { state_column: "s", positive_state: "yes", effective_from_column: "d0", effective_until_column: "d1", interval: "[effective_from,effective_until)", clock: "database_utc" },
      semantic_consent: { confirmed: true, source_description: "Owner-reviewed current register.", positive_state_description: "Yes within the effective interval qualifies." },
    }, f.inspection, f.boundary)).toThrow(/READ_PREREQUISITE_SCOPE_(STALE|PROOF_MISSING)/);
  });

  it.each(["absent", "partial", "same_names_other_table", "shared_parent"])("keeps missing source proof actionable (%s)", kind => {
    const f = fixture();
    if (kind === "absent") f.boundary.pack.resources = [];
    if (kind === "partial") delete f.boundary.pack.resources[0]!.principal_key;
    if (kind === "same_names_other_table") f.boundary.pack.resources[0]!.table = "unrelated";
    if (kind === "shared_parent") { delete f.boundary.pack.resources[0]!.principal_key; f.boundary.pack.resources[0]!.rls_session = { tenant_setting: "app.org" }; }
    expect(resolveReadPrerequisiteScope(f.inspection, f.boundary, f.source)).toMatchObject({ state: "missing", reason: expect.stringContaining("Review the source scope") });
  });

  it.each(["deferred", "unvalidated", "collation", "partial_tuple", "repeated_tuple", "nullable_local", "nullable_parent", "non_unique_parent", "partial_index", "unusable_index", "incompatible_type"])("rejects unsupported FK proof (%s)", kind => {
    const f = fixture(), fk = f.child.foreign_keys[0]!;
    if (kind === "deferred") fk.deferrable = true;
    if (kind === "unvalidated") fk.action_rule_issue = "unvalidated_foreign_key";
    if (kind === "collation") fk.action_rule_issue = "non_exact_collation";
    if (kind === "partial_tuple") fk.referenced_columns.pop();
    if (kind === "repeated_tuple") fk.columns[1] = fk.columns[0]!;
    if (kind === "nullable_local") f.child.columns.find(column => column.name === "z")!.nullable = true;
    if (kind === "nullable_parent") f.parent.columns.find(column => column.name === "row")!.nullable = true;
    if (kind === "non_unique_parent") f.parent.unique_constraints = [];
    if (kind === "partial_index" || kind === "unusable_index") f.parent.indexes = [{ name: "parent_tuple", unique: true,
      catalog_partial: kind === "partial_index", catalog_usable: kind !== "unusable_index" }];
    if (kind === "incompatible_type") f.child.columns.find(column => column.name === "z")!.data_type = "integer";
    expect(resolveReadPrerequisiteScope(f.inspection, f.boundary, f.source).state).toBe("missing");
    expect(() => listSupportedReadCurrentStatePrerequisiteCandidates(f.inspection, f.boundary)).toThrow("READ_PREREQUISITE_SCOPE_PROOF_MISSING");
  });

  it("rejects multiple possible parent proofs and conflicts with a known partial source role", () => {
    const f = fixture();
    f.child.foreign_keys.push({ ...f.child.foreign_keys[0]!, name: "alternate_parent", columns: ["y", "other", "z"] });
    expect(() => resolveReadPrerequisiteScope(f.inspection, f.boundary, f.source)).toThrow("READ_PREREQUISITE_SCOPE_AMBIGUOUS");
    f.child.foreign_keys.pop();
    f.boundary.pack.resources.push({ schema: "coded", table: "r7", tenant_key: "other" });
    expect(() => resolveReadPrerequisiteScope(f.inspection, f.boundary, f.source)).toThrow("READ_PREREQUISITE_SCOPE_CONFLICT");
  });

  it.each(["missing_column", "nullable", "changed_type", "duplicate_roles", "alias_conflict"])("rejects stale or conflicting direct Read proof (%s)", kind => {
    const f = fixture();
    if (kind === "missing_column") f.parent.columns = f.parent.columns.filter(column => column.name !== "a");
    if (kind === "nullable") f.parent.columns.find(column => column.name === "a")!.nullable = true;
    if (kind === "changed_type") f.parent.columns.find(column => column.name === "a")!.data_type = "integer";
    if (kind === "duplicate_roles") f.boundary.pack.resources[0]!.principal_key = "a";
    if (kind === "alias_conflict") f.boundary.pack.resources.push({ ...f.boundary.pack.resources[0]!, id: "alias", tenant_key: "b", principal_key: "a" });
    expect(() => resolveReadPrerequisiteScope(f.inspection, f.boundary, f.source)).toThrow(/READ_PREREQUISITE_SCOPE_(STALE|CONFLICT)/);
  });

  it.each([{ useParent: false, verificationOnly: true }, { useParent: true, verificationOnly: true },
    { useParent: false, verificationOnly: false }, { useParent: true, verificationOnly: false }])("uses current private Action scope without public exposure or modifying write purpose (%j)", ({ useParent, verificationOnly }) => {
    const f = fixture();
    const retained = catalog(f, useParent ? f.parent : f.child);
    if (!verificationOnly) delete retained.resources[0]!.verification_only;
    f.boundary.pack.resources = [];
    f.boundary.scopeEvidence = { retained_action_catalogs: [retained] };
    const before = structuredClone(f);
    expect(resolveReadPrerequisiteScope(f.inspection, f.boundary, f.source)).toMatchObject({ state: "proven", subject: { tenant_column: "x", principal_column: "y" } });
    expect(f).toEqual(before);
    expect(f.boundary.pack.resources).toEqual([]);
  });

  it.each(["lock", "source", "engine", "field", "duplicate", "conflict"])("rejects stale or conflicting retained Action proof (%s)", kind => {
    const f = fixture(), retained = catalog(f);
    f.boundary.scopeEvidence = { retained_action_catalogs: [retained] };
    if (kind === "lock") retained.generation_lock_fingerprint = `sha256:${"b".repeat(64)}`;
    if (kind === "source") retained.resources[0]!.source = "different_source";
    if (kind === "engine") retained.resources[0]!.engine = "mysql";
    if (kind === "field") retained.resources[0]!.fields.find(field => field.name === "x")!.nullable = true;
    if (kind === "duplicate") retained.resources.push(structuredClone(retained.resources[0]!));
    if (kind === "conflict") f.boundary.pack.resources.push({ schema: "coded", table: "r7", tenant_key: "y", principal_key: "x" });
    expect(() => resolveReadPrerequisiteScope(f.inspection, f.boundary, f.source)).toThrow(/READ_PREREQUISITE_SCOPE_(STALE|CONFLICT|AMBIGUOUS)/);
  });

  it("rejects conflicting scope between separately retained Action catalogs", () => {
    const f = fixture(), first = catalog(f), second = catalog(f);
    second.resources[0]!.tenant_key = "y";
    second.resources[0]!.principal_scope_key = "x";
    f.boundary.scopeEvidence = { retained_action_catalogs: [first, second] };
    expect(() => resolveReadPrerequisiteScope(f.inspection, f.boundary, f.source)).toThrow("READ_PREREQUISITE_SCOPE_CONFLICT");
  });

  it("does not consult source values or require runtime identity while proving scope", () => {
    const f = fixture();
    const local: ReadPrerequisiteScopeBoundaryContext = { pack: f.boundary.pack };
    expect(resolveReadPrerequisiteScope(f.inspection, local, f.source).state).toBe("proven");
  });

  it("keeps optional inspection properties out of its exact proof encoding", () => {
    const f = fixture();
    const before = resolveReadPrerequisiteScope(f.inspection, f.boundary, f.source);
    Object.assign(f.child.foreign_keys[0]!, { action_rule_issue: undefined, deferrable: undefined });
    expect(resolveReadPrerequisiteScope(f.inspection, f.boundary, f.source)).toEqual(before);
  });
});
