import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import {
  rolePostureFingerprint,
  schemaFingerprintForInspection,
  type SchemaInspection,
} from "@synapsor-runner/schema-inspector";
import {
  preflightGeneratedAuthority,
  type RuntimeConfig,
} from "./index.js";

describe("generated protected-authority preflight", () => {
  it("does not inspect a legacy configuration without protected authority", async () => {
    let inspected = false;
    await preflightGeneratedAuthority(legacyConfig(), {}, async () => {
      inspected = true;
      return inspection();
    });
    expect(inspected).toBe(false);
  });

  it("refuses protected authority without an explicit generation lock", async () => {
    const config = protectedConfig(`sha256:${"a".repeat(64)}`);
    await expect(preflightGeneratedAuthority(config, {}, async () => inspection()))
      .rejects.toMatchObject({ code: "GENERATED_AUTHORITY_LOCK_REQUIRED" });
  });

  it.each([
    ["1.6.0", "1.5.0"],
    ["1.6.3", "1.5.0"],
    ["1.6.3", "1.5.1"],
    ["1.6.3", "1.6.0"],
    ["1.6.4", "1.7.0"],
  ])("accepts supported compiler/spec lock %s/%s and fails closed on schema drift", async (compilerVersion, specVersion) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-generation-lock-"));
    try {
      const current = inspection();
      const lock = {
        schema_version: "synapsor.generation-lock.v1",
        compiler_version: compilerVersion,
        spec_version: specVersion,
        engine: "postgres",
        source_env: "DATABASE_URL",
        schema_fingerprint: schemaFingerprintForInspection(current),
        role_posture_fingerprint: rolePostureFingerprint(current),
        evidence_fingerprint: `sha256:${"b".repeat(64)}`,
        generated_contract_digest: `sha256:${"c".repeat(64)}`,
        reviewed_overrides_digest: `sha256:${"d".repeat(64)}`,
        protected_authority: ["public.subscriptions"],
      } as const;
      const lockPath = path.join(root, "generation-lock.json");
      await fs.writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`, "utf8");
      const config = protectedConfig(canonicalJsonDigest(lock));
      config.generated_authority = {
        generation_lock_path: lockPath,
        enforcement: "required",
      };

      await expect(preflightGeneratedAuthority(config, { DATABASE_URL: "postgres://redacted" }, async () => current))
        .resolves.toBeUndefined();

      const drifted = structuredClone(current);
      drifted.tables[0]!.columns.push({
        name: "new_field",
        data_type: "text",
        nullable: true,
        generated: false,
        ordinal_position: 5,
        suggestions: {
          tenant: false,
          conflict: false,
          sensitive: false,
          immutable: false,
          large_or_binary: false,
        },
      });
      await expect(preflightGeneratedAuthority(config, { DATABASE_URL: "postgres://redacted" }, async () => drifted))
        .rejects.toMatchObject({ code: "GENERATED_AUTHORITY_DRIFT" });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("keeps protected authority current across unrelated schema drift but rejects a dependent resource change", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-generation-dependencies-"));
    try {
      const current = inspection();
      const authorityDependencies = authorityDependenciesFor(current);
      const lock = {
        schema_version: "synapsor.generation-lock.v1",
        compiler_version: "1.6.4",
        spec_version: "1.7.0",
        engine: "postgres",
        source_env: "DATABASE_URL",
        schema_fingerprint: schemaFingerprintForInspection(current),
        role_posture_fingerprint: rolePostureFingerprint(current),
        evidence_fingerprint: `sha256:${"b".repeat(64)}`,
        generated_contract_digest: `sha256:${"c".repeat(64)}`,
        reviewed_overrides_digest: `sha256:${"d".repeat(64)}`,
        protected_authority: ["public.subscriptions"],
        authority_dependencies: authorityDependencies,
      } as const;
      const lockPath = path.join(root, "generation-lock.json");
      await fs.writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`, "utf8");
      const config = protectedConfig(canonicalJsonDigest(lock));
      config.generated_authority = {
        generation_lock_path: lockPath,
        enforcement: "required",
      };

      const unrelatedDrift = structuredClone(current);
      const unrelated = structuredClone(unrelatedDrift.tables[0]!);
      unrelated.name = "unrelated_events";
      unrelated.columns = [column("id", "uuid", 1), column("tenant_id", "uuid", 2)];
      unrelated.primary_key = ["id"];
      unrelated.row_level_security_policies![0]!.name = "unrelated_tenant_scope";
      unrelatedDrift.tables.push(unrelated);
      await expect(preflightGeneratedAuthority(
        config,
        { DATABASE_URL: "postgres://redacted" },
        async () => unrelatedDrift,
      )).resolves.toBeUndefined();

      const dependentDrift = structuredClone(unrelatedDrift);
      dependentDrift.tables[0]!.columns.find((item) => item.name === "region")!.data_type = "integer";
      await expect(preflightGeneratedAuthority(
        config,
        { DATABASE_URL: "postgres://redacted" },
        async () => dependentDrift,
      )).rejects.toMatchObject({
        code: "GENERATED_AUTHORITY_DRIFT",
        message: expect.stringContaining("public.subscriptions"),
      });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("refuses an unsupported compiler lock before inspecting the database", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-generation-lock-"));
    try {
      const current = inspection();
      const lock = {
        schema_version: "synapsor.generation-lock.v1",
        compiler_version: "9.9.9",
        spec_version: "1.5.0",
        engine: "postgres",
        source_env: "DATABASE_URL",
        schema_fingerprint: schemaFingerprintForInspection(current),
        role_posture_fingerprint: rolePostureFingerprint(current),
        evidence_fingerprint: `sha256:${"b".repeat(64)}`,
        generated_contract_digest: `sha256:${"c".repeat(64)}`,
        reviewed_overrides_digest: `sha256:${"d".repeat(64)}`,
        protected_authority: ["public.subscriptions"],
      } as const;
      const lockPath = path.join(root, "generation-lock.json");
      await fs.writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`, "utf8");
      const config = protectedConfig(canonicalJsonDigest(lock));
      config.generated_authority = {
        generation_lock_path: lockPath,
        enforcement: "required",
      };
      let inspected = false;

      await expect(preflightGeneratedAuthority(config, { DATABASE_URL: "postgres://redacted" }, async () => {
        inspected = true;
        return current;
      })).rejects.toMatchObject({ code: "GENERATION_LOCK_INVALID" });
      expect(inspected).toBe(false);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

function legacyConfig(): RuntimeConfig {
  return {
    version: 1,
    mode: "read_only",
    sources: {
      app: {
        engine: "postgres",
        read_url_env: "DATABASE_URL",
        read_only: true,
      },
    },
    trusted_context: {
      provider: "environment",
      values: {
        tenant_id_env: "TENANT_ID",
        principal_env: "PRINCIPAL",
      },
    },
    capabilities: [{
      name: "app.inspect_subscription",
      kind: "read",
      source: "app",
      target: {
        schema: "public",
        table: "subscriptions",
        primary_key: "id",
        tenant_key: "tenant_id",
      },
      args: { id: { type: "string", required: true } },
      lookup: { id_from_arg: "id" },
      visible_columns: ["id", "status"],
      evidence: "required",
      max_rows: 1,
    }],
  };
}

function protectedConfig(lockFingerprint: `sha256:${string}`): RuntimeConfig {
  const config = legacyConfig();
  config.capabilities = [{
    ...config.capabilities![0]!,
    name: "analytics.churn_by_region",
    kind: "aggregate_read",
    args: {},
    visible_columns: [],
    kept_out_fields: ["customer_id"],
    protected_read: {
      version: "1",
      mode: "aggregate",
      boundary_digest: `sha256:${"e".repeat(64)}`,
      generation_lock_fingerprint: lockFingerprint,
      aggregate: {
        counted_entity: "subject",
        measures: [{ name: "churned_accounts", function: "count" }],
        dimensions: [{ name: "region", field: "region" }],
        top_n: 10,
        minimum_group_size: 5,
      },
      limits: {
        max_rows: 20,
        max_groups: 20,
        max_response_cells: 200,
        max_response_bytes: 32_000,
        statement_timeout_ms: 3_000,
        max_queries_per_session: 20,
        max_extracted_cells_per_session: 2_000,
        max_differencing_queries: 4,
        rate_limit_per_minute: 20,
      },
    },
  }];
  return config;
}

function inspection(): SchemaInspection {
  return {
    engine: "postgres",
    server_version: "16",
    current_user: "synapsor_reader",
    role_posture: {
      verified: true,
      superuser: false,
      bypass_rls: false,
      read_only: true,
      writable_relations: [],
      owned_relations: [],
      reasons: [],
    },
    inspected_at: "2026-07-22T00:00:00.000Z",
    schemas: ["public"],
    tables: [{
      schema: "public",
      name: "subscriptions",
      type: "table",
      writable: false,
      columns: [
        column("id", "uuid", 1),
        column("tenant_id", "uuid", 2),
        column("status", "text", 3),
        column("region", "text", 4),
      ],
      primary_key: ["id"],
      unique_constraints: [],
      foreign_keys: [],
      indexes: [],
      row_level_security: true,
      row_level_security_policies: [{
        name: "tenant_scope",
        command: "SELECT",
        permissive: true,
        roles: ["synapsor_reader"],
        using_expression: "tenant_id = current_setting('app.tenant_id')::uuid",
      }],
      role_posture: {
        owner: "app_owner",
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
      suggestions: {
        tenant_columns: ["tenant_id"],
        conflict_columns: [],
        sensitive_columns: [],
        default_visible_columns: ["id", "status", "region"],
      },
    }],
    warnings: [],
  };
}

function column(name: string, dataType: string, ordinalPosition: number) {
  return {
    name,
    data_type: dataType,
    nullable: false,
    generated: false,
    ordinal_position: ordinalPosition,
    suggestions: {
      tenant: name === "tenant_id",
      conflict: false,
      sensitive: false,
      immutable: name === "id" || name === "tenant_id",
      large_or_binary: false,
    },
  };
}

function authorityDependenciesFor(current: SchemaInspection) {
  const table = current.tables[0]!;
  const fields = ["id", "region", "status", "tenant_id"];
  const selectedColumns = fields.map((name) => {
    const item = table.columns.find((candidate) => candidate.name === name)!;
    return {
      name: item.name,
      data_type: item.data_type,
      nullable: item.nullable,
      default: item.default ?? null,
      generated: item.generated,
      identity: item.identity ?? false,
      enum_values: [...(item.enum_values ?? [])].sort(),
    };
  });
  const role = current.role_posture!;
  return {
    schema_version: "synapsor.authority-dependencies.v1" as const,
    credential_posture_fingerprint: canonicalJsonDigest({
      engine: current.engine,
      current_user: current.current_user,
      role: {
        verified: role.verified,
        superuser: role.superuser,
        bypass_rls: role.bypass_rls,
        read_only: role.read_only,
        writable_relations: [...role.writable_relations].sort(),
        owned_relations: [...role.owned_relations].sort(),
      },
    }),
    resources: {
      "public.subscriptions": {
        schema: "public",
        table: "subscriptions",
        fields,
        fingerprint: canonicalJsonDigest({
          engine: current.engine,
          schema: table.schema,
          table: table.name,
          type: table.type,
          primary_key: [...table.primary_key],
          columns: selectedColumns,
          row_level_security: table.row_level_security,
          row_level_security_policies: table.row_level_security_policies!.map((policy) => ({
            name: policy.name,
            command: policy.command,
            permissive: policy.permissive,
            roles: [...policy.roles].sort(),
            using_expression: policy.using_expression ?? null,
            check_expression: policy.check_expression ?? null,
          })),
          role_posture: {
            owner: table.role_posture!.owner,
            current_role_is_owner: table.role_posture!.current_role_is_owner,
            current_role_can_assume_owner: table.role_posture!.current_role_can_assume_owner,
            privileges: table.role_posture!.privileges,
            row_security_forced: table.role_posture!.row_security_forced,
            row_security_effective_for_current_role: table.role_posture!.row_security_effective_for_current_role,
          },
        }),
      },
    },
    relationships: {},
  };
}
