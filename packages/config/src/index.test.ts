import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";
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
  it("keeps the public JSON Schema aligned with representative runtime shapes", () => {
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
    const schema = JSON.parse(fs.readFileSync(path.join(repoRoot, "schemas/synapsor.runner.schema.json"), "utf8"));
    const schemaValidate = new Ajv2020({ strict: false, allErrors: true }).compile(schema);
    const contractOnly = {
      version: 1,
      mode: "review",
      storage: { sqlite_path: "./.synapsor/local.db" },
      sources: safeConfig.sources,
      contracts: ["./synapsor.contract.json"],
      capabilities: [],
    };
    const invalid = { ...structuredClone(safeConfig), execute_sql: "SELECT 1" };
    const emptyWithoutContract = { ...structuredClone(safeConfig), capabilities: [] };
    const aggregateLimited = structuredClone(safeConfig) as any;
    aggregateLimited.capabilities[1].approval = {
      mode: "policy",
      required_role: "support_lead",
      policy: "billing_small_waiver",
    };
    aggregateLimited.policies = [{
      name: "billing_small_waiver",
      kind: "approval",
      mode: "green",
      rules: [{ field: "late_fee_cents", max: 5500 }],
      limits: [
        { kind: "count", max: 20, period: "day", scope: "tenant_policy" },
        { kind: "total", field: "late_fee_cents", max: 100000, period: "day", scope: "tenant_policy" },
      ],
    }];
    const perSession = structuredClone(safeConfig) as any;
    perSession.trusted_context = {
      provider: "http_claims",
      values: { tenant_id_key: "tenant_id", principal_key: "sub" },
    };
    perSession.session_auth = {
      provider: "jwt_hs256",
      secret_env: "SYNAPSOR_SESSION_JWT_SECRET",
      previous_secret_env: "SYNAPSOR_PREVIOUS_SESSION_JWT_SECRET",
      issuer: "https://identity.example",
      audience: "synapsor-runner",
      tenant_claim: "tenant_id",
      principal_claim: "sub",
      clock_skew_seconds: 30,
    };
    const asymmetricSession = structuredClone(perSession) as any;
    asymmetricSession.session_auth = {
      provider: "jwt_asymmetric",
      algorithms: ["RS256", "ES256"],
      jwks_url_env: "SYNAPSOR_SESSION_JWKS_URL",
      issuer: "https://identity.example",
      audience: "synapsor-runner",
      tenant_claim: "tenant_id",
      principal_claim: "sub",
      clock_skew_seconds: 30,
      jwks_cache_seconds: 600,
      jwks_cooldown_seconds: 30,
      fetch_timeout_ms: 3000,
      max_response_bytes: 1048576,
    };
    const sharedLedger = structuredClone(safeConfig) as any;
    sharedLedger.storage = {
      sqlite_path: "./.synapsor/local.db",
      shared_postgres: {
        mode: "mirror",
        url_env: "SYNAPSOR_LEDGER_DATABASE_URL",
        schema: "synapsor_runner",
        lock_timeout_ms: 10000,
      },
    };
    const sharedRuntimeStore = structuredClone(safeConfig) as any;
    sharedRuntimeStore.storage = {
      shared_postgres: {
        mode: "runtime_store",
        url_env: "SYNAPSOR_LEDGER_DATABASE_URL",
        schema: "synapsor_runner",
        lock_timeout_ms: 10000,
      },
    };
    const operationallyBounded = structuredClone(safeConfig) as any;
    operationallyBounded.sources.app_postgres.pool = {
      max_connections: 8,
      connection_timeout_ms: 3000,
      idle_timeout_ms: 30000,
      queue_timeout_ms: 5000,
      queue_limit: 32,
    };
    operationallyBounded.rate_limits = {
      default: { requests: 120, window_seconds: 60 },
      capabilities: { "billing.propose_late_fee_waiver": { requests: 20, window_seconds: 60 } },
    };

    for (const accepted of [safeConfig, contractOnly, aggregateLimited, perSession, asymmetricSession, sharedLedger, sharedRuntimeStore, operationallyBounded]) {
      expect(validateRunnerCapabilityConfig(accepted).ok).toBe(true);
      expect(schemaValidate(accepted), JSON.stringify(schemaValidate.errors)).toBe(true);
    }
    expect(validateRunnerCapabilityConfig(invalid).ok).toBe(false);
    expect(schemaValidate(invalid)).toBe(false);
    expect(validateRunnerCapabilityConfig(emptyWithoutContract).ok).toBe(false);
    expect(schemaValidate(emptyWithoutContract)).toBe(false);
  });

  it("accepts reviewed read and proposal capabilities", () => {
    const result = validateRunnerCapabilityConfig(safeConfig);
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("validates shared Postgres storage wiring without accepting inline URLs", () => {
    const config = mutableConfig();
    config.storage.shared_postgres = {
      mode: "mirror",
      url_env: "SYNAPSOR_LEDGER_DATABASE_URL",
      schema: "synapsor_runner",
      lock_timeout_ms: 5000,
    };
    expect(validateRunnerCapabilityConfig(config).ok).toBe(true);

    const runtimeStore = mutableConfig();
    runtimeStore.storage.shared_postgres = {
      mode: "runtime_store",
      url_env: "SYNAPSOR_LEDGER_DATABASE_URL",
      schema: "synapsor_runner",
      lock_timeout_ms: 5000,
    };
    expect(validateRunnerCapabilityConfig(runtimeStore).ok).toBe(true);

    const inline = mutableConfig();
    inline.storage.shared_postgres = {
      mode: "mirror",
      url_env: "postgresql://writer:secret@example/ledger",
    };
    const inlineResult = validateRunnerCapabilityConfig(inline);
    expect(inlineResult.ok).toBe(false);
    expect(inlineResult.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "$.storage.shared_postgres.url_env", code: "SHARED_POSTGRES_URL_ENV_REQUIRED" }),
    ]));

    const invalidTimeout = mutableConfig();
    invalidTimeout.storage.shared_postgres = {
      mode: "mirror",
      url_env: "SYNAPSOR_LEDGER_DATABASE_URL",
      lock_timeout_ms: -1,
    };
    expect(validateRunnerCapabilityConfig(invalidTimeout).errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "$.storage.shared_postgres.lock_timeout_ms", code: "INVALID_SHARED_POSTGRES_LOCK_TIMEOUT" }),
    ]));

    const invalidCapacity = mutableConfig();
    invalidCapacity.storage.shared_postgres = {
      mode: "runtime_store",
      url_env: "SYNAPSOR_LEDGER_DATABASE_URL",
      max_entries: 99,
    };
    expect(validateRunnerCapabilityConfig(invalidCapacity).errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "$.storage.shared_postgres.max_entries", code: "INVALID_SHARED_POSTGRES_MAX_ENTRIES" }),
    ]));
  });

  it("validates bounded per-source connection pool controls", () => {
    const config = mutableConfig();
    config.sources.app_postgres.pool = {
      max_connections: 8,
      connection_timeout_ms: 3000,
      idle_timeout_ms: 30000,
      queue_timeout_ms: 5000,
      queue_limit: 32,
    };
    expect(validateRunnerCapabilityConfig(config).ok).toBe(true);

    config.sources.app_postgres.pool.max_connections = 0;
    expect(validateRunnerCapabilityConfig(config).errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "$.sources.app_postgres.pool.max_connections", code: "INVALID_SOURCE_POOL_BOUND" }),
    ]));
  });

  it("validates operational per-capability rate limits", () => {
    const config = mutableConfig();
    config.rate_limits = {
      enabled: true,
      default: { requests: 100, window_seconds: 60 },
      capabilities: { "billing.inspect_invoice": { requests: 20, window_seconds: 10 } },
    };
    expect(validateRunnerCapabilityConfig(config).ok).toBe(true);
    config.rate_limits.capabilities["billing.inspect_invoice"].requests = 0;
    expect(validateRunnerCapabilityConfig(config).errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "INVALID_RATE_LIMIT_REQUESTS" }),
    ]));
  });

  it("validates separately authorized HTTP metrics configuration", () => {
    const config = mutableConfig();
    config.metrics = { enabled: true, token_env: "SYNAPSOR_METRICS_TOKEN" };
    expect(validateRunnerCapabilityConfig(config).ok).toBe(true);
    config.metrics.token_env = "not an env name";
    expect(validateRunnerCapabilityConfig(config).errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "INVALID_METRICS_TOKEN_ENV" }),
    ]));
  });

  it("requires signed session auth for http_claims trusted context", () => {
    const config = mutableConfig();
    config.trusted_context = { provider: "http_claims", values: { tenant_id_key: "tenant_id", principal_key: "sub" } };
    const missing = validateRunnerCapabilityConfig(config);
    expect(missing.errors.map((error) => error.code)).toContain("SESSION_AUTH_REQUIRED");

    config.session_auth = { provider: "jwt_hs256", secret_env: "SYNAPSOR_SESSION_JWT_SECRET", previous_secret_env: "SYNAPSOR_PREVIOUS_SESSION_JWT_SECRET" };
    expect(validateRunnerCapabilityConfig(config).ok).toBe(true);
  });

  it("validates asymmetric session auth key sources and algorithm allowlists", () => {
    const config = mutableConfig();
    config.trusted_context = { provider: "http_claims", values: { tenant_id_key: "tenant_id", principal_key: "sub" } };
    config.session_auth = {
      provider: "jwt_asymmetric",
      algorithms: ["RS256", "ES256"],
      jwks_url_env: "SYNAPSOR_SESSION_JWKS_URL",
      issuer: "https://identity.example",
      audience: "synapsor-runner",
    };
    expect(validateRunnerCapabilityConfig(config).ok).toBe(true);

    config.session_auth.public_key_env = "SYNAPSOR_SESSION_PUBLIC_KEY";
    expect(validateRunnerCapabilityConfig(config).errors.map((error) => error.code)).toContain("SESSION_AUTH_PUBLIC_KEY_SOURCE_REQUIRED");
    delete config.session_auth.public_key_env;
    config.session_auth.algorithms = ["HS256"];
    expect(validateRunnerCapabilityConfig(config).errors.map((error) => error.code)).toContain("INVALID_SESSION_AUTH_ALGORITHMS");
  });

  it("rejects claims sessions whose effective capability context is environment-bound", () => {
    const config = mutableConfig();
    config.trusted_context = { provider: "http_claims", values: { tenant_id_key: "tenant_id", principal_key: "sub" } };
    config.session_auth = { provider: "jwt_hs256", secret_env: "SYNAPSOR_SESSION_JWT_SECRET" };
    config.contexts = {
      legacy_operator: {
        provider: "environment",
        values: { tenant_id_env: "SYNAPSOR_TENANT_ID", principal_env: "SYNAPSOR_PRINCIPAL" },
      },
    };
    config.capabilities[0].context = "legacy_operator";

    const result = validateRunnerCapabilityConfig(config);
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({
        path: "$.contexts.legacy_operator.provider",
        code: "TRUSTED_CONTEXT_PROVIDER_CONFLICT",
      }),
    ]));
    expect(result.errors.find((error) => error.code === "TRUSTED_CONTEXT_PROVIDER_CONFLICT")?.message).toContain("billing.inspect_invoice");
    expect(result.errors.find((error) => error.code === "TRUSTED_CONTEXT_PROVIDER_CONFLICT")?.message).toContain("HTTP_CLAIM tenant_id");

    config.contexts.legacy_operator = {
      provider: "http_claims",
      values: { tenant_id_key: "tenant_id", principal_key: "sub" },
    };
    expect(validateRunnerCapabilityConfig(config).ok).toBe(true);
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

  it("accepts reviewed numeric bounds and status transitions", () => {
    const config = mutableConfig();
    config.capabilities[1].args.next_status = {
      type: "string",
      required: true,
      enum: ["pending_review", "waived"],
    };
    config.capabilities[1].visible_columns.push("status");
    config.capabilities[1].patch.status = { from_arg: "next_status" };
    config.capabilities[1].allowed_columns.push("status");
    config.capabilities[1].numeric_bounds = {
      late_fee_cents: { minimum: 0, maximum: 5500 },
    };
    config.capabilities[1].transition_guards = {
      status: {
        allowed: {
          open: ["pending_review"],
          pending_review: ["waived"],
        },
      },
    };
    const result = validateRunnerCapabilityConfig(config);
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("accepts named trusted contexts and rejects missing context references", () => {
    const config = mutableConfig();
    delete config.trusted_context;
    config.contexts = {
      local_support_operator: {
        provider: "environment",
        values: {
          tenant_id_env: "SYNAPSOR_TENANT_ID",
          principal_env: "SYNAPSOR_PRINCIPAL",
        },
      },
    };
    for (const capability of config.capabilities) {
      capability.context = "local_support_operator";
    }
    const accepted = validateRunnerCapabilityConfig(config);
    expect(accepted.ok).toBe(true);
    expect(accepted.errors).toEqual([]);

    config.capabilities[0].context = "missing_context";
    const rejected = validateRunnerCapabilityConfig(config);
    expect(rejected.ok).toBe(false);
    expect(rejected.errors.map((error) => error.code)).toContain("UNKNOWN_CONTEXT");
  });

  it("accepts app/API handler executors without inline handler secrets", () => {
    const config = mutableConfig();
    delete config.sources.app_postgres.write_url_env;
    config.sources.app_postgres.read_only = true;
    config.executors = {
      billing_api: {
        type: "http_handler",
        url_env: "SYNAPSOR_BILLING_HANDLER_URL",
        method: "POST",
        auth: {
          type: "bearer_env",
          token_env: "SYNAPSOR_BILLING_HANDLER_TOKEN",
        },
        signing_secret_env: "SYNAPSOR_BILLING_HANDLER_SIGNING_SECRET",
        timeout_ms: 5000,
      },
    };
    config.capabilities[1].executor = "billing_api";
    const result = validateRunnerCapabilityConfig(config);
    expect(result.ok).toBe(true);
    expect(result.warnings.map((warning) => warning.code)).not.toContain("WRITEBACK_DISABLED");
    expect(JSON.stringify(config)).not.toMatch(/handler-secret|https:\/\/internal-with-token|postgres(?:ql)?:\/\/|mysql:\/\//i);

    config.capabilities[1].executor = "missing_executor";
    const rejected = validateRunnerCapabilityConfig(config);
    expect(rejected.ok).toBe(false);
    expect(rejected.errors.map((error) => error.code)).toContain("UNKNOWN_EXECUTOR");
  });

  it("accepts canonical app_handler writeback metadata and rejects broken handler references", () => {
    const config = mutableConfig();
    delete config.sources.app_postgres.write_url_env;
    config.sources.app_postgres.read_only = true;
    config.executors = {
      billing_api: {
        type: "http_handler",
        url_env: "SYNAPSOR_BILLING_HANDLER_URL",
      },
    };
    config.capabilities[1].writeback = { mode: "app_handler", executor: "billing_api" };
    const accepted = validateRunnerCapabilityConfig(config);
    expect(accepted.ok).toBe(true);

    config.capabilities[1].writeback = { mode: "app_handler", executor: "missing_executor" };
    const rejected = validateRunnerCapabilityConfig(config);
    expect(rejected.ok).toBe(false);
    expect(rejected.errors.map((error) => error.code)).toContain("UNKNOWN_EXECUTOR");
  });

  it("accepts OIDC operator tokens from stdin and rejects ambiguous token sources", () => {
    const config = mutableConfig();
    config.operator_identity = {
      provider: "jwt_oidc",
      algorithms: ["RS256"],
      public_key_env: "SYNAPSOR_OPERATOR_PUBLIC_KEY",
      token_stdin: true,
      attestation_secret_env: "SYNAPSOR_OPERATOR_ATTESTATION_SECRET",
    };
    expect(validateRunnerCapabilityConfig(config).ok).toBe(true);

    config.operator_identity.token_env = "SYNAPSOR_OPERATOR_TOKEN";
    const rejected = validateRunnerCapabilityConfig(config);
    expect(rejected.ok).toBe(false);
    expect(rejected.errors.map((error) => error.code)).toContain("OPERATOR_TOKEN_SOURCE_CONFLICT");
  });

  it("keeps WRITEBACK NONE distinct from broken direct writeback", () => {
    const config = mutableConfig();
    delete config.sources.app_postgres.write_url_env;
    config.sources.app_postgres.read_only = true;
    config.capabilities[1].writeback = { mode: "none" };
    const accepted = validateRunnerCapabilityConfig(config);
    expect(accepted.ok).toBe(true);
    expect(accepted.warnings.map((warning) => warning.code)).not.toContain("WRITEBACK_DISABLED");
  });

  it("rejects duplicate local capability names", () => {
    const config = mutableConfig();
    config.capabilities.push(structuredClone(config.capabilities[0]));
    const result = validateRunnerCapabilityConfig(config);
    expect(result.ok).toBe(false);
    expect(result.errors.map((error) => error.code)).toContain("DUPLICATE_CAPABILITY_NAME");
  });

  it("warns when direct SQL review proposals have no writer env", () => {
    const config = mutableConfig();
    delete config.sources.app_postgres.write_url_env;
    const result = validateRunnerCapabilityConfig(config);
    expect(result.ok).toBe(true);
    expect(result.warnings.map((warning) => warning.code)).toContain("WRITEBACK_DISABLED");
  });

  it("accepts pure-contract configs when capabilities is omitted or explicitly empty", () => {
    const base = mutableConfig();
    delete base.trusted_context;
    delete base.capabilities;
    base.contracts = ["./synapsor.contract.json"];
    const omitted = validateRunnerCapabilityConfig(base);
    expect(omitted.ok).toBe(true);
    expect(omitted.errors).toEqual([]);

    base.capabilities = [];
    const explicitEmpty = validateRunnerCapabilityConfig(base);
    expect(explicitEmpty.ok).toBe(true);
    expect(explicitEmpty.errors).toEqual([]);
  });

  it("rejects direct SQL writeback when a source is marked read-only", () => {
    const config = mutableConfig();
    config.sources.app_postgres.read_only = true;
    const result = validateRunnerCapabilityConfig(config);
    expect(result.ok).toBe(false);
    expect(result.errors.map((error) => error.code)).toContain("READ_ONLY_SOURCE_DIRECT_WRITEBACK");
  });

  it("rejects invalid proposal guard templates", () => {
    const config = mutableConfig();
    config.capabilities[1].numeric_bounds = {
      admin_override: { minimum: 10, maximum: 1 },
    };
    config.capabilities[1].transition_guards = {
      status: {
        from_column: "internal_state",
        allowed: {
          open: ["closed"],
        },
      },
    };
    const result = validateRunnerCapabilityConfig(config);
    expect(result.ok).toBe(false);
    expect(result.errors.map((error) => error.code)).toContain("NUMERIC_BOUND_PATCH_COLUMN_REQUIRED");
    expect(result.errors.map((error) => error.code)).toContain("INVALID_NUMERIC_RANGE");
    expect(result.errors.map((error) => error.code)).toContain("TRANSITION_PATCH_COLUMN_REQUIRED");
    expect(result.errors.map((error) => error.code)).toContain("TRANSITION_FROM_COLUMN_NOT_VISIBLE");
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
        runner_version: "0.1.0",
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
