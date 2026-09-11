import { describe, expect, it, vi } from "vitest";
import type { CompiledRuleBindingV1 } from "@synapsor-runner/action-rules";
import { createPostgresActionRuleFactLoader, postgresActionRuleVerificationScope } from "./index.js";

function sharedReferenceBinding(): CompiledRuleBindingV1 {
  const pairs = [{ local_field: "institution_id", target_field: "institution_id" }, { local_field: "section_id", target_field: "section_id" }];
  return {
    binding: "section", resource: { name: "university.sections", source: "database", engine: "postgres", schema: "university", table: "sections",
      primary_key: "section_id", tenant_key: "institution_id", fields: [] },
    verification: { binding: "section", resource: "university.sections", primary_key: "section_id", fields: [],
      scope: { mode: "columns", tenant_field: "institution_id" }, cardinality: "one", max_rows: 1, overflow: "unsupported", lock: "for_update",
      source: { kind: "relationship", from_binding: "registration", relationship: "registration_section_fk", direction: "forward", field_pairs: pairs } },
    relationship: { name: "registration_section_fk", from_resource: "university.registrations", to_resource: "university.sections",
      field_pairs: pairs, cardinality: "many_to_one", nullable: false, target_unique: true },
  };
}

describe("PostgreSQL shared-reference verification scope", () => {
  const scope = { tenantSetting: "app.institution", principalSetting: "app.student" };
  it("requires institutional filtering for a proven unique forward shared reference without changing the trusted session", () => {
    const binding = sharedReferenceBinding(), before = structuredClone(binding);
    expect(postgresActionRuleVerificationScope(binding, scope)).toEqual({ tenantSetting: "app.institution" });
    expect(scope).toEqual({ tenantSetting: "app.institution", principalSetting: "app.student" });
    expect(binding).toEqual(before);
  });
  it("supports a scalar unique institution relationship with the same tenant proof", () => {
    const binding = sharedReferenceBinding();
    delete binding.relationship!.field_pairs;
    Object.assign(binding.relationship!, { local_field: "institution_id", target_field: "institution_id" });
    expect(postgresActionRuleVerificationScope(binding, scope)).toEqual({ tenantSetting: "app.institution" });
  });
  it.each(["subject", "inverse", "many", "unproven", "different_target", "different_relationship", "missing_tenant_pair", "inherited", "principal", "verification_principal", "scope_mismatch"])(
    "retains principal policy checks for %s", change => {
      const binding = sharedReferenceBinding();
      if (change === "subject") binding.verification.source = { kind: "subject_ref" };
      if (change === "inverse" && binding.verification.source.kind === "relationship") binding.verification.source.direction = "inverse";
      if (change === "many") binding.verification.cardinality = "many";
      if (change === "unproven") binding.relationship!.target_unique = false;
      if (change === "different_target") binding.relationship!.to_resource = "university.other_sections";
      if (change === "different_relationship") binding.relationship!.name = "other_fk";
      if (change === "missing_tenant_pair") binding.relationship!.field_pairs = [
        { local_field: "section_id", target_field: "section_id" }, { local_field: "term_id", target_field: "term_id" },
      ];
      if (change === "inherited") binding.verification.scope = { mode: "inherited", from_binding: "registration" };
      if (change === "principal") binding.resource.principal_scope_key = "student_id";
      if (change === "verification_principal" && binding.verification.scope.mode === "columns") binding.verification.scope.principal_field = "student_id";
      if (change === "scope_mismatch") binding.resource.tenant_key = "other_institution_id";
      expect(postgresActionRuleVerificationScope(binding, scope)).toEqual(scope);
    });
  it("does not let a cached shared-reference check satisfy a stricter customer binding to the same table", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("AS relation_kind") && !sql.includes("current_user AS role")) return { rows: [{ relation_kind: "r" }], rowCount: 1 };
      if (sql.includes("current_user AS role")) return { rows: [{ role: "limited_reader", table_oid: "42", relation_kind: "r",
        row_security_enabled: true, force_row_security: true, role_is_superuser: false, role_has_bypassrls: false,
        role_is_table_owner: false, role_can_assume_table_owner: false }], rowCount: 1 };
      if (sql.includes("pg_catalog.pg_policy")) return { rows: [{ name: "institution_only", command: "SELECT", permissive: true,
        using_expression: "institution_id = current_setting('app.institution')" }], rowCount: 1 };
      throw new Error(`Unexpected query: ${sql}`);
    });
    const loader = createPostgresActionRuleFactLoader({ query }, { ...scope, tenantId: "i1", principal: "s1" });
    const shared = sharedReferenceBinding();
    await expect(loader.assertResourceCompatible!(shared)).resolves.toBeUndefined();
    await expect(loader.assertResourceCompatible!({ ...shared, verification: { ...shared.verification, source: { kind: "subject_ref" } } }))
      .rejects.toThrow("POSTGRES_RLS_SELECT_SETTING_MISSING:app.student");
    expect(query.mock.calls.filter(([sql]) => sql.includes("current_user AS role"))).toHaveLength(2);
  });
});
