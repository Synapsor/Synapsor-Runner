import { describe, expect, it } from "vitest";
import { validateRunnerCapabilityConfig } from "./index.js";

const safeConfig = {
  version: 1,
  mode: "review",
  storage: { sqlite_path: "./.synapsor/local.db" },
  sources: {
    app_postgres: {
      engine: "postgres",
      read_url_env: "APP_POSTGRES_READ_URL",
      write_url_env: "APP_POSTGRES_WRITE_URL",
      statement_timeout_ms: 3000
    }
  },
  trusted_context: {
    provider: "environment",
    values: {
      tenant_id_env: "SYNAPSOR_TENANT_ID",
      principal_env: "SYNAPSOR_PRINCIPAL"
    }
  },
  capabilities: [
    {
      name: "billing.inspect_invoice",
      kind: "read",
      source: "app_postgres",
      target: {
        schema: "public",
        table: "invoices",
        primary_key: "id",
        tenant_key: "tenant_id"
      },
      args: {
        invoice_id: { type: "string", required: true, max_length: 128 }
      },
      lookup: { id_from_arg: "invoice_id" },
      visible_columns: ["id", "late_fee_cents", "waiver_reason", "updated_at"],
      evidence: "required",
      max_rows: 1
    },
    {
      name: "billing.propose_late_fee_waiver",
      kind: "proposal",
      source: "app_postgres",
      target: {
        schema: "public",
        table: "invoices",
        primary_key: "id",
        tenant_key: "tenant_id"
      },
      args: {
        invoice_id: { type: "string", required: true, max_length: 128 },
        reason: { type: "string", required: true, max_length: 500 }
      },
      lookup: { id_from_arg: "invoice_id" },
      visible_columns: ["id", "late_fee_cents", "waiver_reason", "updated_at"],
      evidence: "required",
      max_rows: 1,
      patch: {
        late_fee_cents: { fixed: 0 },
        waiver_reason: { from_arg: "reason" }
      },
      allowed_columns: ["late_fee_cents", "waiver_reason"],
      conflict_guard: { column: "updated_at" },
      approval: { mode: "human", required_role: "support_lead" }
    }
  ]
};

describe("runner capability config validation", () => {
  it("accepts reviewed read and proposal capabilities", () => {
    const result = validateRunnerCapabilityConfig(safeConfig);
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("rejects model-controlled tenant and identifier args", () => {
    const config = mutableConfig();
    config.capabilities[0].args.tenant_id = { type: "string" };
    config.capabilities[0].args.table_name = { type: "string" };
    const result = validateRunnerCapabilityConfig(config);
    expect(result.ok).toBe(false);
    expect(result.errors.map((error) => error.code)).toContain("MODEL_CONTROLLED_RESERVED_ARG");
  });

  it("rejects inline database URLs and raw SQL fields", () => {
    const config = mutableConfig();
    config.sources.app_postgres.url = "postgresql://user:password@example/app";
    config.capabilities[0].sql = "SELECT * FROM invoices";
    const result = validateRunnerCapabilityConfig(config);
    expect(result.ok).toBe(false);
    expect(result.errors.map((error) => error.code)).toContain("INLINE_DATABASE_URL_FORBIDDEN");
    expect(result.errors.map((error) => error.code)).toContain("ARBITRARY_SQL_FORBIDDEN");
  });

  it("rejects proposal capabilities without allowlist or conflict guard", () => {
    const config = mutableConfig();
    delete config.capabilities[1].allowed_columns;
    delete config.capabilities[1].conflict_guard;
    const result = validateRunnerCapabilityConfig(config);
    expect(result.ok).toBe(false);
    expect(result.errors.map((error) => error.code)).toContain("ALLOWED_COLUMNS_REQUIRED");
    expect(result.errors.map((error) => error.code)).toContain("CONFLICT_GUARD_REQUIRED");
  });

  it("requires a tenant guard unless single-tenant dev mode is explicit", () => {
    const config = mutableConfig();
    delete config.capabilities[0].target.tenant_key;
    const result = validateRunnerCapabilityConfig(config);
    expect(result.ok).toBe(false);
    expect(result.errors.map((error) => error.code)).toContain("TENANT_GUARD_REQUIRED");

    config.capabilities[0].target.single_tenant_dev = true;
    const accepted = validateRunnerCapabilityConfig(config);
    expect(accepted.errors.map((error) => error.code)).not.toContain("TENANT_GUARD_REQUIRED");
    expect(accepted.warnings.map((warning) => warning.code)).toContain("SINGLE_TENANT_DEV_EXCEPTION");
  });

  it("accepts cloud mode with Cloud adapter config instead of local source mappings", () => {
    const result = validateRunnerCapabilityConfig({
      version: 1,
      mode: "cloud",
      storage: { sqlite_path: "./.synapsor/cloud-local.db" },
      trusted_context: {
        provider: "cloud_session",
      },
      cloud: {
        base_url_env: "SYNAPSOR_CLOUD_BASE_URL",
        runner_token_env: "SYNAPSOR_RUNNER_TOKEN",
        runner_id: "synapsor_runner_local",
        runner_version: "0.1.0-alpha.0",
        project_id: "token_scope",
        adapter_id: "mcp.billing",
        source_id: "src_pg_acme",
        engines: ["postgres", "mysql"],
        capabilities: ["adapter:read", "adapter:invoke", "writeback:claim", "writeback:complete"],
        session: { tenant_id: "acme" },
      },
    });
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });
});

function mutableConfig(): any {
  return structuredClone(safeConfig);
}
