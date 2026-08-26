import type { SchemaInspection } from "@synapsor-runner/schema-inspector";
import { describe, expect, it } from "vitest";
import {
  assertDatabaseRoleSafeForModelReads,
  assessDatabaseRolePosture,
  formatUnsafeDatabaseRoleMessage,
} from "./database-role-posture.js";


describe("database role posture diagnostics", () => {
  it("accepts a verified PostgreSQL SELECT-only non-owner role", () => {
    expect(assessDatabaseRolePosture(inspection()).safe_for_model_reads).toBe(true);
    expect(() => assertDatabaseRoleSafeForModelReads({ inspection: inspection() })).not.toThrow();
  });

  it("names every relevant PostgreSQL superuser fact without leaking a URL", () => {
    const unsafe = inspection({
      verified: true,
      superuser: true,
      bypass_rls: true,
      read_only: false,
      writable_relations: ["public.orders", "public.customers"],
      owned_relations: ["public.orders"],
      reasons: [],
    });
    const message = formatUnsafeDatabaseRoleMessage({
      inspection: unsafe,
      sourceEnv: "DATABASE_URL",
      nextAction: "Rerun the same command.",
    });
    expect(message).toContain('Database role "app_reader" is unsafe');
    expect(message).toContain("PostgreSQL superuser");
    expect(message).toContain("BYPASSRLS");
    expect(message).toContain("ownership of 1 inspected relation");
    expect(message).toContain("write authority on 2 inspected relations");
    expect(message).toContain("Update DATABASE_URL");
    expect(message).not.toMatch(/postgres(?:ql)?:\/\//u);
    expect(() => assertDatabaseRoleSafeForModelReads({ inspection: unsafe }))
      .toThrow(expect.objectContaining({ code: "DATABASE_ROLE_UNSAFE" }));
  });

  it("describes MySQL elevated grants without calling them a PostgreSQL-style superuser", () => {
    const unsafe = inspection({
      verified: true,
      superuser: true,
      bypass_rls: "unsupported",
      read_only: false,
      writable_relations: ["library.loans"],
      owned_relations: [],
      reasons: [],
    }, "mysql");
    const message = formatUnsafeDatabaseRoleMessage({ inspection: unsafe });
    expect(message).toContain("elevated/global authority or GRANT OPTION");
    expect(message).toContain("schema/table SELECT grants");
    expect(message).not.toContain("MySQL superuser");
  });

  it("accepts a verified MySQL account limited to table SELECT grants", () => {
    const mysqlReader = inspection({
      verified: true,
      superuser: "unsupported",
      bypass_rls: "unsupported",
      read_only: true,
      writable_relations: [],
      owned_relations: [],
      reasons: [],
    }, "mysql");
    expect(assessDatabaseRolePosture(mysqlReader).safe_for_model_reads).toBe(true);
    expect(() => assertDatabaseRoleSafeForModelReads({ inspection: mysqlReader })).not.toThrow();
  });

  it("fails closed when a saved inspection has no verified role posture", () => {
    const unsafe = inspection();
    delete unsafe.role_posture;
    const assessment = assessDatabaseRolePosture(unsafe);
    expect(assessment.safe_for_model_reads).toBe(false);
    expect(assessment.facts).toContain("the inspection does not contain database-role posture evidence");
  });

  it("does not trust an inconsistent read-only summary over owned-relation evidence", () => {
    const inconsistent = inspection({
      verified: true,
      superuser: false,
      bypass_rls: false,
      read_only: true,
      writable_relations: [],
      owned_relations: ["public.orders"],
      reasons: [],
    });
    const assessment = assessDatabaseRolePosture(inconsistent);
    expect(assessment.safe_for_model_reads).toBe(false);
    expect(assessment.facts).toContain("the role owns or can assume ownership of 1 inspected relation");
  });
});


function inspection(
  role: NonNullable<SchemaInspection["role_posture"]> = {
    verified: true,
    superuser: false,
    bypass_rls: false,
    read_only: true,
    writable_relations: [],
    owned_relations: [],
    reasons: [],
  },
  engine: "postgres" | "mysql" = "postgres",
): SchemaInspection {
  return {
    engine,
    server_version: engine === "postgres" ? "PostgreSQL 16.4" : "8.4.9",
    current_user: "app_reader",
    role_posture: role,
    inspected_at: "2026-08-26T00:00:00.000Z",
    schemas: [engine === "postgres" ? "public" : "library"],
    tables: [],
    warnings: [],
  };
}
