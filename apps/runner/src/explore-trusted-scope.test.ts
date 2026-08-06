import { describe, expect, it, vi } from "vitest";
import type { SchemaInspection } from "@synapsor-runner/schema-inspector";
import type { ExplorationBoundaryDraft, GenerationLock } from "./auto-boundary.js";
import {
  ExploreTrustedScopeError,
  resolveExploreTrustedScope,
} from "./explore-trusted-scope.js";

describe("Explore trusted scope", () => {
  it("preserves the existing operator-environment binding", async () => {
    const reader = vi.fn();
    const scope = await resolveExploreTrustedScope({
      boundary: boundary(false),
      lock: lock(),
      inspection: inspection(),
      env: {
        DATABASE_URL: "postgresql://unused",
        SYNAPSOR_TENANT_ID: "tenant-from-env",
      },
      readPostgresRoleSetting: reader,
    });
    expect(scope).toMatchObject({
      tenant: "tenant-from-env",
      tenant_source: "environment",
      tenant_binding: "SYNAPSOR_TENANT_ID",
    });
    expect(reader).not.toHaveBeenCalled();
  });

  it("resolves tenant scope from the authenticated PostgreSQL RLS session", async () => {
    const reader = vi.fn().mockResolvedValue({
      currentUser: "fitflow_analytics_reader",
      value: "org-fitflow",
    });
    const scope = await resolveExploreTrustedScope({
      boundary: boundary(true),
      lock: lock(),
      inspection: inspection(),
      env: { DATABASE_URL: "postgresql://credential-owned-scope" },
      readPostgresRoleSetting: reader,
    });
    expect(scope).toEqual({
      tenant: "org-fitflow",
      principal: "",
      tenant_source: "postgres_role_setting",
      tenant_binding: "app.tenant_id",
      principal_source: "not_required",
    });
    expect(reader).toHaveBeenCalledWith({
      databaseUrl: "postgresql://credential-owned-scope",
      setting: "app.tenant_id",
    });
  });

  it("proves role-bound derived scope on the terminal ancestor rather than the child", async () => {
    const candidate = derivedBoundary();
    const derivedInspection = inspection();
    derivedInspection.tables.unshift({
      schema: "public",
      name: "check_in_items",
      type: "table",
      row_level_security: false,
      role_posture: {
        owner: "fitflow_admin",
        current_role_is_owner: false,
        current_role_can_assume_owner: false,
        privileges: {
          select: true,
          insert: false,
          update: false,
          delete: false,
          truncate: false,
          references: false,
          trigger: false,
        },
        row_security_forced: false,
        row_security_effective_for_current_role: false,
      },
    } as SchemaInspection["tables"][number]);
    const reader = vi.fn().mockResolvedValue({
      currentUser: "fitflow_analytics_reader",
      value: "org-fitflow",
    });

    await expect(resolveExploreTrustedScope({
      boundary: candidate,
      lock: lock(),
      inspection: derivedInspection,
      env: { DATABASE_URL: "postgresql://credential-owned-scope" },
      readPostgresRoleSetting: reader,
    })).resolves.toMatchObject({
      tenant: "org-fitflow",
      tenant_source: "postgres_role_setting",
    });
    expect(reader).toHaveBeenCalledOnce();

    derivedInspection.tables.find((table) => table.name === "check_ins")!
      .role_posture!.row_security_effective_for_current_role = false;
    await expect(resolveExploreTrustedScope({
      boundary: candidate,
      lock: lock(),
      inspection: derivedInspection,
      env: { DATABASE_URL: "postgresql://credential-owned-scope" },
      readPostgresRoleSetting: reader,
    })).rejects.toThrow(/not proven by the reviewed RLS policy for public\.check_in_items/);
  });

  it("still requires a trusted principal when reviewed authority explicitly selects principal scope", async () => {
    const candidate = boundary(true);
    candidate.pack.resources[0]!.principal_key = "trainer_id";
    await expect(resolveExploreTrustedScope({
      boundary: candidate,
      lock: lock(),
      inspection: inspection(),
      env: { DATABASE_URL: "postgresql://credential-owned-scope" },
      readPostgresRoleSetting: vi.fn(),
    })).rejects.toThrow(/requires trusted SYNAPSOR_PRINCIPAL/);

    const scope = await resolveExploreTrustedScope({
      boundary: candidate,
      lock: lock(),
      inspection: inspection(),
      env: {
        DATABASE_URL: "postgresql://credential-owned-scope",
        SYNAPSOR_PRINCIPAL: "trainer-alex",
      },
      readPostgresRoleSetting: vi.fn().mockResolvedValue({
        currentUser: "fitflow_analytics_reader",
        value: "org-fitflow",
      }),
    });
    expect(scope).toMatchObject({
      principal: "trainer-alex",
      principal_source: "environment",
      principal_binding: "SYNAPSOR_PRINCIPAL",
    });
  });

  it("fails closed when the credential does not establish the reviewed setting", async () => {
    await expect(resolveExploreTrustedScope({
      boundary: boundary(true),
      lock: lock(),
      inspection: inspection(),
      env: { DATABASE_URL: "postgresql://credential-without-scope" },
      readPostgresRoleSetting: vi.fn().mockResolvedValue({
        currentUser: "fitflow_analytics_reader",
        value: undefined,
      }),
    })).rejects.toThrow(ExploreTrustedScopeError);
  });

  it("refuses a role binding not proven on every reviewed relation", async () => {
    const candidate = boundary(true);
    candidate.pack.resources[0]!.rls_session = { tenant_setting: "app.other_tenant" };
    const reader = vi.fn();
    await expect(resolveExploreTrustedScope({
      boundary: candidate,
      lock: lock(),
      inspection: inspection(),
      env: { DATABASE_URL: "postgresql://credential-owned-scope" },
      readPostgresRoleSetting: reader,
    })).rejects.toThrow(/not proven by the reviewed RLS policy/);
    expect(reader).not.toHaveBeenCalled();
  });

  it("does not use the PostgreSQL fallback for MySQL", async () => {
    const mysqlInspection = { ...inspection(), engine: "mysql" as const };
    await expect(resolveExploreTrustedScope({
      boundary: boundary(true),
      lock: { ...lock(), engine: "mysql" },
      inspection: mysqlInspection,
      env: { DATABASE_URL: "mysql://credential-owned-scope" },
      readPostgresRoleSetting: vi.fn(),
    })).rejects.toThrow(/not valid for this source/);
  });

  it("binds production tenant and principal only from the verified HTTP session", async () => {
    const candidate = productionBoundary();
    const scope = await resolveExploreTrustedScope({
      boundary: candidate,
      lock: lock(),
      inspection: inspection(),
      env: {
        SYNAPSOR_TENANT_ID: "environment-tenant-must-not-win",
        SYNAPSOR_PRINCIPAL: "environment-principal-must-not-win",
      },
      sessionContext: {
        tenant_id: "tenant-from-jwt",
        principal: "principal-from-jwt",
        provenance: "http_claims",
      },
      readPostgresRoleSetting: vi.fn(),
    });

    expect(scope).toEqual({
      tenant: "tenant-from-jwt",
      principal: "principal-from-jwt",
      tenant_source: "verified_http_claim",
      tenant_binding: "org_id",
      principal_source: "verified_http_claim",
      principal_binding: "sub",
    });
  });

  it("requires both verified HTTP scopes for every production Explore session", async () => {
    for (const sessionContext of [
      undefined,
      { tenant_id: "tenant-a", principal: "", provenance: "http_claims" as const },
      { tenant_id: "", principal: "principal-a", provenance: "http_claims" as const },
    ]) {
      await expect(resolveExploreTrustedScope({
        boundary: productionBoundary(),
        lock: lock(),
        inspection: inspection(),
        env: {
          SYNAPSOR_TENANT_ID: "environment-fallback-forbidden",
          SYNAPSOR_PRINCIPAL: "environment-fallback-forbidden",
        },
        ...(sessionContext ? { sessionContext } : {}),
      })).rejects.toMatchObject({
        missingBindings: ["org_id", "sub"],
      });
    }
  });

  it("refuses HTTP claim bindings on a non-production boundary", async () => {
    const candidate = productionBoundary();
    candidate.deployment_profile = "staging";
    await expect(resolveExploreTrustedScope({
      boundary: candidate,
      lock: lock(),
      inspection: inspection(),
      env: {},
      sessionContext: {
        tenant_id: "tenant-a",
        principal: "principal-a",
        provenance: "http_claims",
      },
    })).rejects.toThrow(/only valid for a reviewed production Explore boundary/);
  });
});

function boundary(roleBound: boolean): ExplorationBoundaryDraft {
  return {
    schema_version: "synapsor.exploration-boundary.v1",
    activation: "disabled_unreviewed",
    deployment_profile: "development",
    source: "local_postgres",
    compiler_version: "1.6.6",
    spec_version: "1.8.0",
    trusted_context: {
      provider: "environment",
      tenant_env: "SYNAPSOR_TENANT_ID",
      principal_env: "SYNAPSOR_PRINCIPAL",
      ...(roleBound ? {
        database_role_tenant: {
          engine: "postgres" as const,
          setting: "app.tenant_id",
        },
      } : {}),
    },
    generation_lock_fingerprint: `sha256:${"1".repeat(64)}`,
    role_posture_fingerprint: `sha256:${"2".repeat(64)}`,
    pack: {
      name: "reviewed_development",
      resources: [{
        id: "public.check_ins",
        schema: "public",
        table: "check_ins",
        primary_key: "id",
        tenant_key: "organization_id",
        field_types: { id: "text", organization_id: "text" },
        field_enums: {},
        selectable_fields: ["id"],
        filterable_fields: { id: ["eq"] },
        sortable_fields: ["id"],
        groupable_fields: [],
        aggregate_measures: [],
        count_distinct_fields: ["id"],
        time_bucket_fields: {},
        kept_out_fields: ["organization_id"],
        relationships: [],
        rls_session: { tenant_setting: "app.tenant_id" },
        minimum_cohort_size: 5,
        suppression_aware_totals: true,
      }],
    },
    budgets: {
      max_rows: 25,
      max_groups: 25,
      max_top_n: 25,
      max_measures: 2,
      max_dimensions: 3,
      max_time_ranges: 2,
      max_relationship_hops: 2,
      max_response_cells: 250,
      max_response_bytes: 64_000,
      statement_timeout_ms: 3_000,
      max_complexity: 30,
      max_queries_per_session: 50,
      max_extracted_cells_per_session: 2_000,
      max_differencing_queries: 5,
      rate_limit_per_minute: 20,
    },
    unresolved_decisions: [],
  };
}

function productionBoundary(): ExplorationBoundaryDraft {
  const candidate = boundary(false);
  candidate.deployment_profile = "production";
  candidate.pack.name = "reviewed_production";
  candidate.trusted_context = {
    provider: "http_claims",
    tenant_claim: "org_id",
    principal_claim: "sub",
  };
  return candidate;
}

function derivedBoundary(): ExplorationBoundaryDraft {
  const candidate = boundary(true);
  const ancestor = candidate.pack.resources[0]!;
  candidate.pack.resources.unshift({
    ...structuredClone(ancestor),
    id: "public.check_in_items",
    table: "check_in_items",
    tenant_key: undefined,
    tenant_scope: {
      mode: "derived",
      path_id: "public.check_in_items.check_in_id->public.check_ins.id",
      ancestor_resource: "public.check_ins",
      ancestor_column: "organization_id",
      proof: {
        source: "database_catalog",
        links: [{
          constraint_name: "check_in_items_check_in_id_fkey",
          source_resource: "public.check_in_items",
          source_columns: ["check_in_id"],
          target_resource: "public.check_ins",
          target_columns: ["id"],
          target_uniqueness: {
            kind: "primary_key",
            name: "check_ins_pkey",
            columns: ["id"],
          },
          nullable: false,
          cardinality: "many_to_one",
          max_fan_out: 1,
        }],
        digest: `sha256:${"8".repeat(64)}`,
      },
    },
    field_types: { id: "text", check_in_id: "text" },
    selectable_fields: ["id", "check_in_id"],
    filterable_fields: { id: ["eq"], check_in_id: ["eq"] },
    kept_out_fields: [],
  });
  return candidate;
}

function lock(): GenerationLock {
  return {
    schema_version: "synapsor.generation-lock.v1",
    compiler_version: "1.6.6",
    spec_version: "1.8.0",
    engine: "postgres",
    source_env: "DATABASE_URL",
    schema_fingerprint: `sha256:${"3".repeat(64)}`,
    role_posture_fingerprint: `sha256:${"4".repeat(64)}`,
    evidence_fingerprint: `sha256:${"5".repeat(64)}`,
    generated_contract_digest: `sha256:${"6".repeat(64)}`,
    reviewed_overrides_digest: `sha256:${"7".repeat(64)}`,
    protected_authority: ["public.check_ins"],
  };
}

function inspection(): SchemaInspection {
  return {
    engine: "postgres",
    server_version: "16",
    current_user: "fitflow_analytics_reader",
    role_posture: {
      verified: true,
      superuser: false,
      bypass_rls: false,
      read_only: true,
      writable_relations: [],
      owned_relations: [],
      reasons: [],
    },
    inspected_at: "2026-07-31T00:00:00.000Z",
    schemas: ["public"],
    tables: [{
      schema: "public",
      name: "check_ins",
      type: "table",
      row_level_security: true,
      role_posture: {
        owner: "fitflow_admin",
        current_role_is_owner: false,
        current_role_can_assume_owner: false,
        privileges: {
          select: true,
          insert: false,
          update: false,
          delete: false,
          truncate: false,
          references: false,
          trigger: false,
        },
        row_security_forced: true,
        row_security_effective_for_current_role: true,
      },
    } as SchemaInspection["tables"][number]],
    warnings: [],
  };
}
