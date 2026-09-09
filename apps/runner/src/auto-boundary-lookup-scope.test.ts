import { compileAgentDsl } from "@synapsor/dsl";
import type { SchemaInspection } from "@synapsor-runner/schema-inspector";
import { describe, expect, it } from "vitest";
import { buildAutoBoundary, seedConfiguredPrincipalBindingReview } from "./auto-boundary.js";

describe("generated lookup and trusted principal names", () => {
  it.each(["record_id", "student_id"])("onboards students with a trusted student_id and %s row identity", (primaryKey) => {
    const inspection = students(primaryKey);
    const overrides = reviewedScope(inspection);
    const build = buildAutoBoundary({ inspection, overrides, sourceEnv: "DATABASE_URL", project: {
      root: "/unused/student-lookup-test", package_manager: "npm", frameworks: [], schema_inputs: [], database_env_names: ["DATABASE_URL"],
    } });
    expect(build.dsl).toContain("PRINCIPAL SCOPE KEY student_id");
    expect(build.dsl).toContain(`LOOKUP student_lookup_id BY ${primaryKey}`);
    expect(build.dsl).not.toContain("ARG student_id ");
    expect(compileAgentDsl(build.dsl)).toEqual(build.contract);
    expect(build.exploration_boundary.pack.resources[0]).toMatchObject({ principal_key: "student_id", tenant_key: "institution_id" });
    expect(build.exploration_boundary.activation).toBe("disabled_unreviewed");
    expect(build.exploration_boundary.pack.resources[0]!.selectable_fields).not.toContain("student_id");
  });

  it("retains ordinary lookup names when they do not collide with trusted scope", () => {
    const inspection = students("record_id");
    inspection.tables[0]!.name = "registrations";
    const build = buildAutoBoundary({ inspection, sourceEnv: "DATABASE_URL",
      overrides: reviewedScope(inspection), project: {
        root: "/unused/student-lookup-test", package_manager: "npm", frameworks: [], schema_inputs: [], database_env_names: ["DATABASE_URL"],
      } });
    expect(build.dsl).toContain("LOOKUP registration_id BY record_id");
  });
});

function reviewedScope(inspection: SchemaInspection) {
  const overrides = seedConfiguredPrincipalBindingReview({ inspection, principalBinding: "student_id", decidedAt: inspection.inspected_at });
  const id = `university.${inspection.tables[0]!.name}`;
  overrides.resources[id] = { ...overrides.resources[id], tenant_key: {
    value: "institution_id", actor: "fixture-reviewer", reason: "The institution is the trusted tenant boundary.", decided_at: inspection.inspected_at,
  } };
  return overrides;
}

function students(primaryKey: string): SchemaInspection {
  const names = ["record_id", "institution_id", "student_id", "display_name"];
  return {
    engine: "postgres", server_version: "PostgreSQL 16", current_user: "reader", inspected_at: "2026-09-08T00:00:00.000Z",
    schemas: ["university"], warnings: [],
    role_posture: { verified: true, superuser: false, bypass_rls: false, read_only: true, writable_relations: [], owned_relations: [], reasons: [] },
    tables: [{ schema: "university", name: "students", type: "table", writable: false,
      columns: names.map((name, ordinal_position) => ({ name, ordinal_position, data_type: "text", nullable: false, generated: false,
        suggestions: { tenant: name === "institution_id", conflict: false, sensitive: false, immutable: name.endsWith("_id"), large_or_binary: false } })),
      primary_key: [primaryKey], unique_constraints: [{ name: "students_pkey", columns: [primaryKey] }],
      check_constraints: [], foreign_keys: [], indexes: [], row_level_security: false,
      role_posture: { owner: "owner", current_role_is_owner: false, current_role_can_assume_owner: false,
        privileges: { select: true, insert: false, update: false, delete: false, truncate: false, references: false, trigger: false },
        row_security_forced: false, row_security_effective_for_current_role: false },
      suggestions: { tenant_columns: ["institution_id"], conflict_columns: [], sensitive_columns: [], default_visible_columns: ["display_name"] },
    }],
  };
}
