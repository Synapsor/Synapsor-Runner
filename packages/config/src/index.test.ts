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
  it("accepts only explicit local required generation-lock enforcement", () => {
    const generated = {
      ...structuredClone(safeConfig),
      generated_authority: {
        generation_lock_path: "./.synapsor/generation-lock.json",
        enforcement: "required",
      },
    };
    expect(validateRunnerCapabilityConfig(generated).ok).toBe(true);
    expect(validateRunnerCapabilityConfig({
      ...generated,
      generated_authority: {
        generation_lock_path: "https://example.com/lock.json",
        enforcement: "optional",
      },
    }).errors.map((issue) => issue.code)).toEqual(expect.arrayContaining([
      "INVALID_GENERATION_LOCK_PATH",
      "INVALID_GENERATION_LOCK_ENFORCEMENT",
    ]));
  });

  it("accepts only UTC as generated analytical reporting-timezone authority", () => {
    const generated = {
      ...structuredClone(safeConfig),
      generated_authority: {
        generation_lock_path: "./.synapsor/generation-lock.json",
        enforcement: "required",
        reporting_timezone: "UTC",
      },
    };
    expect(validateRunnerCapabilityConfig(generated).ok).toBe(true);
    expect(validateRunnerCapabilityConfig({
      ...generated,
      generated_authority: {
        ...generated.generated_authority,
        reporting_timezone: "America/Los_Angeles",
      },
    }).errors).toContainEqual(expect.objectContaining({
      path: "$.generated_authority.reporting_timezone",
      code: "INVALID_REPORTING_TIMEZONE",
    }));
  });

  it("validates exact metadata for a generated minimum-cohort owner override", () => {
    const digest = `sha256:${"a".repeat(64)}`;
    const generated = {
      ...structuredClone(safeConfig),
      generated_authority: {
        generation_lock_path: "./.synapsor/generation-lock.json",
        enforcement: "required",
        minimum_cohort_overrides: {
          "analytics.reviewed_counts": {
            contract_digest: digest,
            minimum_cohort_size: 1,
            review_digest: `sha256:${"b".repeat(64)}`,
          },
        },
      },
    };
    expect(validateRunnerCapabilityConfig(generated).ok).toBe(true);

    generated.generated_authority.minimum_cohort_overrides["analytics.reviewed_counts"]!
      .minimum_cohort_size = 0;
    expect(validateRunnerCapabilityConfig(generated).errors)
      .toContainEqual(expect.objectContaining({
        code: "INVALID_MINIMUM_COHORT_OVERRIDE_VALUE",
      }));
  });

  it("accepts a zero-authority read-only shell and distinguishes lock-bound authoring", () => {
    const authoringShell = {
      version: 1,
      mode: "read_only",
      storage: { sqlite_path: "./.synapsor/local.db" },
      sources: {
        local_postgres: {
          engine: "postgres",
          read_url_env: "DATABASE_URL",
          read_only: true,
          statement_timeout_ms: 3000,
        },
      },
      trusted_context: {
        provider: "environment",
        values: {
          tenant_id: "SYNAPSOR_TENANT_ID",
          principal: "SYNAPSOR_PRINCIPAL",
        },
        tenant_binding: "tenant_id",
        principal_binding: "principal",
      },
      capabilities: [],
      generated_authority: {
        generation_lock_path: "./.synapsor/generation-lock.json",
        enforcement: "required",
      },
      strict: true,
    };
    const result = validateRunnerCapabilityConfig(authoringShell);
    expect(result.ok).toBe(true);
    expect(result.warnings.map((issue) => issue.code)).toContain("AUTHORING_PROJECT_HAS_NO_ACTIVE_CAPABILITIES");

    expect(validateRunnerCapabilityConfig({
      ...authoringShell,
      mode: "review",
    }).errors.map((issue) => issue.code)).toContain("CAPABILITIES_REQUIRED");
    expect(validateRunnerCapabilityConfig({
      ...authoringShell,
      generated_authority: undefined,
    }).warnings.map((issue) => issue.code)).toContain("READ_ONLY_CONFIG_HAS_NO_ACTIVE_CAPABILITIES");
  });

  it("requires both exact contract permission and an exact deployment allowlist for supervised execution", () => {
    const config = supervisedWorkerConfig();
    expect(validateRunnerCapabilityConfig(config)).toMatchObject({ ok: true, errors: [] });

    const missingContractPermission = supervisedWorkerConfig();
    delete missingContractPermission.capabilities[1].execution;
    expect(validateRunnerCapabilityConfig(missingContractPermission).errors.map((issue) => issue.code))
      .toContain("SUPERVISED_WORKER_CONTRACT_PERMISSION_REQUIRED");

    const staleDigest = supervisedWorkerConfig();
    staleDigest.supervised_worker.capabilities[0].contract_digest = `sha256:${"b".repeat(64)}`;
    expect(validateRunnerCapabilityConfig(staleDigest).errors.map((issue) => issue.code))
      .toContain("SUPERVISED_WORKER_DIGEST_MISMATCH");

    const wrongWriter = supervisedWorkerConfig();
    wrongWriter.supervised_worker.capabilities[0].write_url_env = "OTHER_WRITE_URL";
    expect(validateRunnerCapabilityConfig(wrongWriter).errors.map((issue) => issue.code))
      .toContain("SUPERVISED_WORKER_WRITER_MISMATCH");

    const missingTtl = supervisedWorkerConfig();
    delete missingTtl.supervised_worker.capabilities[0].proposal_ttl_seconds;
    expect(validateRunnerCapabilityConfig(missingTtl).errors.map((issue) => issue.code))
      .toContain("INVALID_SUPERVISED_WORKER_BOUND");

    const productionDevIdentity = supervisedWorkerConfig();
    productionDevIdentity.supervised_worker.profile = "production";
    const productionErrors = validateRunnerCapabilityConfig(productionDevIdentity).errors.map((issue) => issue.code);
    expect(productionErrors).toContain("SUPERVISED_WORKER_VERIFIED_OPERATOR_REQUIRED");
    expect(productionErrors).toContain("SUPERVISED_WORKER_PRODUCTION_POSTURE_REQUIRED");

    const hardenedWithoutFingerprint = supervisedWorkerConfig();
    hardenedWithoutFingerprint.supervised_worker.capabilities[0].require_least_privilege_writer = true;
    expect(validateRunnerCapabilityConfig(hardenedWithoutFingerprint).errors.map((issue) => issue.code))
      .toContain("SUPERVISED_WORKER_POSTURE_FINGERPRINT_REQUIRED");

    const hardenedRuntimeDdl = supervisedWorkerConfig();
    hardenedRuntimeDdl.supervised_worker.capabilities[0].require_least_privilege_writer = true;
    hardenedRuntimeDdl.supervised_worker.capabilities[0].writer_posture_fingerprint = `sha256:${"c".repeat(64)}`;
    hardenedRuntimeDdl.sources.app_postgres.receipts.provisioning = "auto_migrate";
    expect(validateRunnerCapabilityConfig(hardenedRuntimeDdl).errors.map((issue) => issue.code))
      .toContain("SUPERVISED_WORKER_PRECREATED_RECEIPT_REQUIRED");
  });

  it("keeps supervised execution additive and disabled when deployment policy is absent", () => {
    const config = mutableConfig();
    config.capabilities[1].approval = {
      mode: "policy",
      required_role: "support_lead",
      policy: "billing_small_waiver",
    };
    config.policies = [{
      name: "billing_small_waiver",
      kind: "approval",
      mode: "green",
      rules: [{ field: "late_fee_cents", max: 0 }],
    }];

    expect(validateRunnerCapabilityConfig(config)).toMatchObject({ ok: true, errors: [] });
    expect(config.supervised_worker).toBeUndefined();
    expect(config.capabilities[1].execution).toBeUndefined();
  });

  it("accepts quiet operator-owned notification routes without inline destinations or secrets", () => {
    const config = notificationConfig();
    expect(validateRunnerCapabilityConfig(config)).toMatchObject({ ok: true, errors: [] });

    const inlineAuthority = notificationConfig();
    inlineAuthority.notifications.sinks[0].url_env = "https://hooks.example.test/synapsor";
    inlineAuthority.notifications.sinks[0].signing_secret_env = "inline-secret";
    expect(validateRunnerCapabilityConfig(inlineAuthority).errors.map((issue) => issue.code))
      .toEqual(expect.arrayContaining([
        "NOTIFICATION_WEBHOOK_URL_ENV_REQUIRED",
        "NOTIFICATION_SIGNING_SECRET_ENV_REQUIRED",
      ]));

    const invalidRoute = notificationConfig();
    invalidRoute.notifications.sinks[0].events = ["proposal.created", "operator.make_it_so"];
    invalidRoute.notifications.sinks[0].budgets.per_minute = 0;
    expect(validateRunnerCapabilityConfig(invalidRoute).errors.map((issue) => issue.code))
      .toEqual(expect.arrayContaining([
        "INVALID_NOTIFICATION_EVENT_FILTER",
        "INVALID_NOTIFICATION_BUDGET",
      ]));
  });

  it("requires explicit private-destination and supervised-worker health-gate opt-ins", () => {
    const privateDestination = notificationConfig();
    privateDestination.notifications.sinks[0].private_host_allowlist = ["hooks.internal.example"];
    expect(validateRunnerCapabilityConfig(privateDestination).errors.map((issue) => issue.code))
      .toContain("PRIVATE_DESTINATION_OPT_IN_REQUIRED");

    privateDestination.notifications.sinks[0].allow_private_destinations = true;
    expect(validateRunnerCapabilityConfig(privateDestination)).toMatchObject({ ok: true, errors: [] });

    const healthGated = supervisedWorkerConfig();
    healthGated.notifications = notificationConfig().notifications;
    healthGated.supervised_worker.capabilities[0].required_attention_sinks = ["operations"];
    expect(validateRunnerCapabilityConfig(healthGated)).toMatchObject({ ok: true, errors: [] });

    healthGated.notifications.enabled = false;
    expect(validateRunnerCapabilityConfig(healthGated).errors.map((issue) => issue.code))
      .toContain("HEALTH_GATE_NOTIFICATIONS_REQUIRED");

    healthGated.notifications.enabled = true;
    healthGated.notifications.sinks[0].enabled = false;
    expect(validateRunnerCapabilityConfig(healthGated).errors.map((issue) => issue.code))
      .toContain("REQUIRED_ATTENTION_SINK_UNAVAILABLE");
  });

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
    const sharedHttp = structuredClone(asymmetricSession) as any;
    sharedHttp.session_auth.audience = "https://runner.example/mcp";
    sharedHttp.http_security = {
      deployment: "shared",
      channel: "trusted_tls_proxy",
      oauth_resource: {
        resource: "https://runner.example/mcp",
        authorization_servers: ["https://identity.example"],
        scopes_supported: ["synapsor:mcp"],
        required_scopes: ["synapsor:mcp"],
      },
      allowed_origins: ["https://agent.example"],
      allowed_hosts: ["runner.example"],
      limits: { max_sessions: 500, session_idle_timeout_seconds: 900 },
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
    const databaseScoped = structuredClone(safeConfig) as any;
    databaseScoped.sources.app_postgres.database_scope = {
      mode: "postgres_rls",
      tenant_setting: "app.tenant_id",
      principal_setting: "app.principal_id",
    };
    databaseScoped.sources.app_postgres.credential_scope = {
      mode: "tenant_resolver",
      resolver: "app_credentials",
    };
    const boundedSet = structuredClone(safeConfig) as any;
    boundedSet.capabilities = [{
      ...boundedSet.capabilities[1],
      name: "billing.close_overdue_invoices",
      visible_columns: ["id", "tenant_id", "status", "balance_cents", "version"],
      patch: { status: { fixed: "closed" } },
      allowed_columns: ["status"],
      conflict_guard: { column: "version" },
      operation: {
        kind: "update",
        cardinality: "set",
        selection: { all: [{ column: "status", operator: "eq", value: "overdue" }] },
        max_rows: 10,
        aggregate_bounds: [{ column: "balance_cents", measure: "before", maximum: 50000 }],
        version_advance: { column: "version", strategy: "integer_increment" },
      },
      approval: { mode: "human", required_role: "billing_reviewer" },
      writeback: { mode: "direct_sql" },
    }];
    const batchInsert = structuredClone(safeConfig) as any;
    batchInsert.capabilities = [{
      ...batchInsert.capabilities[1],
      name: "billing.create_credits",
      target: { schema: "public", table: "account_credits", primary_key: "id", tenant_key: "tenant_id" },
      args: {
        items: {
          type: "object_array",
          required: true,
          max_items: 10,
          fields: {
            id: { type: "string", required: true, max_length: 128 },
            amount_cents: { type: "number", required: true, minimum: 1, maximum: 2500 },
          },
        },
      },
      lookup: { id_from_arg: "items" },
      visible_columns: ["id", "tenant_id", "amount_cents"],
      patch: { amount_cents: { from_item: "amount_cents" } },
      allowed_columns: ["amount_cents"],
      numeric_bounds: { amount_cents: { minimum: 1, maximum: 2500 } },
      conflict_guard: undefined,
      operation: {
        kind: "insert",
        cardinality: "set",
        batch: { items_from_arg: "items" },
        max_rows: 10,
        aggregate_bounds: [{ column: "amount_cents", measure: "after", maximum: 25000 }],
        deduplication: { components: [
          { column: "tenant_id", source: "trusted_tenant" },
          { column: "id", source: "item_field", item_field: "id" },
        ] },
      },
      approval: { mode: "human", required_role: "billing_reviewer" },
      writeback: { mode: "direct_sql" },
    }];
    const aggregateRead = structuredClone(safeConfig) as any;
    aggregateRead.capabilities = [{
      name: "billing.overdue_balance_total",
      kind: "aggregate_read",
      source: "app_postgres",
      target: { schema: "public", table: "invoices", primary_key: "id", tenant_key: "tenant_id" },
      args: {},
      visible_columns: [],
      evidence: "required",
      aggregate: {
        function: "sum",
        column: "late_fee_cents",
        minimum_group_size: 5,
        selection: { all: [{ column: "status", operator: "eq", value: "overdue" }] },
      },
    }];
    const aggregateReadWithOwnerThreshold = structuredClone(aggregateRead) as any;
    aggregateReadWithOwnerThreshold.capabilities[0].aggregate.minimum_group_size = 1;
    aggregateReadWithOwnerThreshold.generated_authority = {
      generation_lock_path: "./.synapsor/generation-lock.json",
      enforcement: "required",
      minimum_cohort_overrides: {
        "billing.overdue_balance_total": {
          contract_digest: `sha256:${"a".repeat(64)}`,
          minimum_cohort_size: 1,
          review_digest: `sha256:${"b".repeat(64)}`,
        },
      },
    };
    const aggregateReadBelowMinimum = structuredClone(aggregateRead) as any;
    aggregateReadBelowMinimum.capabilities[0].aggregate.minimum_group_size = 0;
    const modelWithheld = structuredClone(safeConfig) as any;
    modelWithheld.capabilities[0].model_withheld_fields = ["waiver_reason"];
    const graduatedTrust = structuredClone(safeConfig) as any;
    graduatedTrust.graduated_trust = {
      enabled: true,
      kill_switch: false,
      workspace_id: "workspace_acme",
      project_id: "project_billing",
      criteria: [{
        capability: "billing.propose_late_fee_waiver",
        policy: "billing_small_waiver",
        field: "late_fee_cents",
        minimum_human_reviews: 20,
        window_days: 30,
        maximum_rejection_rate: 0.05,
        maximum_conflict_rate: 0.01,
        maximum_failure_rate: 0.01,
        maximum_revert_rate: 0.01,
        maximum_threshold_increase: 500,
        absolute_ceiling: 5000,
      }],
    };
    const freshnessRequired = structuredClone(safeConfig) as any;
    freshnessRequired.capabilities[1].writeback = { mode: "direct_sql" };
    freshnessRequired.proposal_freshness = {
      "billing.propose_late_fee_waiver": {
        approval: "required",
        dependencies: [{
          id: "invoice_eligibility",
          capability: "billing.inspect_invoice",
          identity_from_arg: "invoice_id",
          version_column: "updated_at",
        }],
      },
    };
    const notifications = notificationConfig();
    const productionExplore = structuredClone(sharedHttp) as any;
    productionExplore.mode = "read_only";
    delete productionExplore.capabilities;
    productionExplore.trusted_context = { provider: "http_claims" };
    productionExplore.storage = {
      shared_postgres: {
        mode: "runtime_store",
        url_env: "SYNAPSOR_CONTROL_DATABASE_URL",
        schema: "synapsor_runner",
      },
    };
    productionExplore.http_security.oauth_resource.scopes_supported = ["synapsor.explore"];
    productionExplore.http_security.oauth_resource.required_scopes = ["synapsor.explore"];
    productionExplore.production_explore = {
      enabled: true,
      project_root: "./production-explore",
      required_oauth_scope: "synapsor.explore",
      budget_hmac_key_env: "SYNAPSOR_EXPLORE_BUDGET_HMAC_KEY",
      accounting_namespace: "example.analytics.production",
      source_max_connections: 8,
      max_sessions_per_principal: 4,
      tenant_limits: {
        max_queries_per_rolling_24_hours: 10_000,
        max_extracted_cells_per_rolling_24_hours: 1_000_000,
        max_differencing_queries_per_rolling_24_hours: 2_000,
        requests_per_minute: 1_000,
        max_response_cells_per_response: 500,
      },
    };

    for (const accepted of [safeConfig, contractOnly, aggregateLimited, perSession, asymmetricSession, sharedHttp, sharedLedger, sharedRuntimeStore, operationallyBounded, databaseScoped, boundedSet, batchInsert, aggregateRead, aggregateReadWithOwnerThreshold, modelWithheld, graduatedTrust, freshnessRequired, notifications, productionExplore]) {
      expect(validateRunnerCapabilityConfig(accepted).ok).toBe(true);
      expect(schemaValidate(accepted), JSON.stringify(schemaValidate.errors)).toBe(true);
    }
    expect(validateRunnerCapabilityConfig(invalid).ok).toBe(false);
    expect(schemaValidate(invalid)).toBe(false);
    expect(validateRunnerCapabilityConfig(emptyWithoutContract).ok).toBe(false);
    expect(schemaValidate(emptyWithoutContract)).toBe(false);
    expect(validateRunnerCapabilityConfig(aggregateReadBelowMinimum).ok).toBe(false);
    expect(schemaValidate(aggregateReadBelowMinimum)).toBe(false);
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

  it("validates explicit database and credential scope modes without accepting secrets", () => {
    const config = mutableConfig();
    config.sources.app_postgres.database_scope = {
      mode: "postgres_rls",
      tenant_setting: "app.tenant_id",
      principal_setting: "app.principal_id",
    };
    config.sources.app_postgres.credential_scope = {
      mode: "tenant_resolver",
      resolver: "app_credentials",
    };
    expect(validateRunnerCapabilityConfig(config)).toMatchObject({ ok: true, errors: [] });

    config.sources.app_postgres.database_scope.principal_setting = "app.tenant_id";
    expect(validateRunnerCapabilityConfig(config).errors.map((error) => error.code)).toContain("RLS_SETTINGS_MUST_DIFFER");

    const tenantOnly = mutableConfig();
    tenantOnly.capabilities[0]!.target.principal_scope_key = undefined;
    tenantOnly.sources.app_postgres.database_scope = {
      mode: "postgres_rls",
      tenant_setting: "app.tenant_id",
    };
    expect(validateRunnerCapabilityConfig(tenantOnly)).toMatchObject({ ok: true, errors: [] });

    tenantOnly.capabilities[0]!.target.principal_scope_key = "assigned_to";
    expect(validateRunnerCapabilityConfig(tenantOnly).errors.map((error) => error.code)).toContain("RLS_PRINCIPAL_SETTING_REQUIRED");

    const mysqlConfig = mutableConfig();
    mysqlConfig.sources.app_postgres.engine = "mysql";
    mysqlConfig.sources.app_postgres.database_scope = {
      mode: "postgres_rls",
      tenant_setting: "app.tenant_id",
      principal_setting: "app.principal_id",
    };
    expect(validateRunnerCapabilityConfig(mysqlConfig).errors.map((error) => error.code)).toContain("POSTGRES_RLS_ENGINE_REQUIRED");

    const missingResolver = mutableConfig();
    missingResolver.sources.app_postgres.credential_scope = { mode: "tenant_resolver" };
    expect(validateRunnerCapabilityConfig(missingResolver).errors.map((error) => error.code)).toContain("TENANT_CREDENTIAL_RESOLVER_REQUIRED");
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

  it("validates networked MCP deployment security without accepting credential values", () => {
    const config = mutableConfig();
    config.trusted_context = { provider: "http_claims", values: { tenant_id_key: "tenant_id", principal_key: "sub" } };
    config.session_auth = {
      provider: "jwt_asymmetric",
      algorithms: ["RS256"],
      jwks_url_env: "SYNAPSOR_SESSION_JWKS_URL",
      issuer: "https://identity.example",
      audience: "https://runner.example/mcp",
    };
    config.http_security = {
      deployment: "shared",
      channel: "trusted_tls_proxy",
      oauth_resource: {
        resource: "https://runner.example/mcp",
        authorization_servers: ["https://identity.example"],
        scopes_supported: ["synapsor:mcp"],
        required_scopes: ["synapsor:mcp"],
        resource_name: "Synapsor Runner",
        resource_documentation: "https://synapsor.ai/docs/http-mcp",
      },
      allowed_origins: ["https://agent.example"],
      allowed_hosts: ["runner.example"],
      limits: {
        max_request_bytes: 1_048_576,
        max_header_bytes: 16_384,
        max_sessions: 500,
        session_idle_timeout_seconds: 900,
        request_timeout_ms: 30_000,
        headers_timeout_ms: 10_000,
        keep_alive_timeout_ms: 5_000,
        max_connections: 1_000,
      },
    };
    expect(validateRunnerCapabilityConfig(config)).toMatchObject({ ok: true, errors: [] });
    config.http_security.oauth_resource.resource = "https://other.example/mcp";
    expect(validateRunnerCapabilityConfig(config).errors.map((error) => error.code)).toContain("HTTP_RESOURCE_AUDIENCE_MISMATCH");
    config.http_security.oauth_resource.resource = "https://runner.example/mcp";
    config.http_security.allowed_origins = ["*"];
    expect(validateRunnerCapabilityConfig(config).errors.map((error) => error.code)).toContain("INVALID_HTTP_ALLOWED_ORIGIN");
    config.http_security.allowed_origins = ["https://agent.example/path"];
    expect(validateRunnerCapabilityConfig(config).errors.map((error) => error.code)).toContain("INVALID_HTTP_ALLOWED_ORIGIN");
    config.http_security.allowed_origins = ["https://agent.example"];
    config.http_security.static_token = { active_env: "literal secret", previous_env: "SYNAPSOR_PREVIOUS_HTTP_TOKEN" };
    expect(validateRunnerCapabilityConfig(config).errors.map((error) => error.code)).toContain("INVALID_HTTP_TOKEN_ENV");
  });

  it("requires the complete production Explore security posture", () => {
    const config = mutableConfig();
    config.storage = {
      sqlite_path: "./.synapsor/local.db",
      shared_postgres: {
        mode: "runtime_store",
        url_env: "SYNAPSOR_CONTROL_DATABASE_URL",
      },
    };
    config.trusted_context = {
      provider: "http_claims",
    };
    config.session_auth = {
      provider: "jwt_asymmetric",
      algorithms: ["RS256"],
      jwks_url_env: "SYNAPSOR_SESSION_JWKS_URL",
      issuer: "https://identity.example",
      audience: "https://runner.example/mcp",
      tenant_claim: "tenant_id",
      principal_claim: "sub",
    };
    config.http_security = {
      deployment: "shared",
      channel: "trusted_tls_proxy",
      oauth_resource: {
        resource: "https://runner.example/mcp",
        authorization_servers: ["https://identity.example"],
        scopes_supported: ["synapsor.explore"],
        required_scopes: ["synapsor.explore"],
      },
      allowed_hosts: ["runner.example"],
    };
    config.production_explore = {
      enabled: true,
      project_root: "./production-explore",
      required_oauth_scope: "synapsor.explore",
      budget_hmac_key_env: "SYNAPSOR_EXPLORE_BUDGET_HMAC_KEY",
      accounting_namespace: "example.analytics.production",
      tenant_limits: {
        max_queries_per_rolling_24_hours: 10_000,
        max_extracted_cells_per_rolling_24_hours: 1_000_000,
        max_differencing_queries_per_rolling_24_hours: 2_000,
        requests_per_minute: 1_000,
      },
    };

    expect(validateRunnerCapabilityConfig(config).errors.map((error) => error.code))
      .toContain("PRODUCTION_EXPLORE_READ_ONLY_REQUIRED");

    config.mode = "read_only";
    delete config.capabilities;
    expect(validateRunnerCapabilityConfig(config)).toMatchObject({ ok: true, errors: [] });

    config.production_explore.source_max_connections = 0;
    expect(validateRunnerCapabilityConfig(config).errors.map((error) => error.code))
      .toContain("INVALID_PRODUCTION_EXPLORE_AVAILABILITY_LIMIT");
    config.production_explore.source_max_connections = 8;
    config.production_explore.max_sessions_per_principal = 101;
    expect(validateRunnerCapabilityConfig(config).errors.map((error) => error.code))
      .toContain("INVALID_PRODUCTION_EXPLORE_AVAILABILITY_LIMIT");
    config.production_explore.max_sessions_per_principal = 4;
    config.production_explore.tenant_limits.max_response_cells_per_response = 0;
    expect(validateRunnerCapabilityConfig(config).errors.map((error) => error.code))
      .toContain("INVALID_PRODUCTION_EXPLORE_TENANT_LIMIT");
    config.production_explore.tenant_limits.max_response_cells_per_response = 500;

    config.session_auth.provider = "jwt_hs256";
    config.session_auth.secret_env = "SYNAPSOR_SESSION_JWT_SECRET";
    delete config.session_auth.algorithms;
    delete config.session_auth.jwks_url_env;
    expect(validateRunnerCapabilityConfig(config).errors.map((error) => error.code)).toContain("PRODUCTION_EXPLORE_ASYMMETRIC_JWT_REQUIRED");

    config.session_auth.provider = "jwt_asymmetric";
    config.session_auth.algorithms = ["RS256"];
    config.session_auth.jwks_url_env = "SYNAPSOR_SESSION_JWKS_URL";
    delete config.session_auth.secret_env;
    config.storage.shared_postgres.mode = "mirror";
    expect(validateRunnerCapabilityConfig(config).errors.map((error) => error.code)).toContain("PRODUCTION_EXPLORE_SHARED_STORE_REQUIRED");

    config.storage.shared_postgres.mode = "runtime_store";
    config.http_security.channel = "insecure_http_break_glass";
    expect(validateRunnerCapabilityConfig(config).errors.map((error) => error.code)).toContain("PRODUCTION_EXPLORE_SECURE_CHANNEL_REQUIRED");

    config.http_security.channel = "trusted_tls_proxy";
    delete config.session_auth.tenant_claim;
    expect(validateRunnerCapabilityConfig(config).errors.map((error) => error.code))
      .toContain("PRODUCTION_EXPLORE_TENANT_CLAIM_REQUIRED");
    config.production_explore.single_organization_id = "internal-finance";
    expect(validateRunnerCapabilityConfig(config)).toMatchObject({ ok: true, errors: [] });
    config.session_auth.tenant_claim = "tenant_id";
    expect(validateRunnerCapabilityConfig(config).errors.map((error) => error.code))
      .toContain("PRODUCTION_EXPLORE_SINGLE_ORGANIZATION_TENANT_CLAIM_FORBIDDEN");
    delete config.session_auth.tenant_claim;
    config.production_explore.single_organization_id = "bad organization id";
    expect(validateRunnerCapabilityConfig(config).errors.map((error) => error.code))
      .toContain("PRODUCTION_EXPLORE_SINGLE_ORGANIZATION_ID_INVALID");
  });

  it("requires signed claims and RFC 9728 metadata for shared HTTP deployment", () => {
    const config = mutableConfig();
    config.http_security = { deployment: "shared", channel: "direct_tls" };
    const result = validateRunnerCapabilityConfig(config);
    expect(result.errors.map((error) => error.code)).toEqual(expect.arrayContaining([
      "SHARED_HTTP_CLAIMS_REQUIRED",
      "SHARED_HTTP_SESSION_AUTH_REQUIRED",
      "SHARED_HTTP_OAUTH_RESOURCE_REQUIRED",
    ]));

    config.http_security = {
      deployment: "single_tenant",
      channel: "trusted_tls_proxy",
      static_token: { active_env: "SYNAPSOR_RUNNER_HTTP_TOKEN", previous_env: "SYNAPSOR_RUNNER_PREVIOUS_HTTP_TOKEN" },
      allowed_hosts: ["runner.internal:8766"],
    };
    expect(validateRunnerCapabilityConfig(config).ok).toBe(true);
    config.http_security.static_token.previous_env = "SYNAPSOR_RUNNER_HTTP_TOKEN";
    expect(validateRunnerCapabilityConfig(config).errors.map((error) => error.code)).toContain("HTTP_TOKEN_ENV_REUSED");
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

  it("rejects policy auto-approval for direct hard DELETE", () => {
    const config = mutableConfig();
    config.capabilities[1].operation = { kind: "delete" };
    config.capabilities[1].patch = {};
    config.capabilities[1].allowed_columns = [];
    config.capabilities[1].approval = {
      mode: "policy",
      required_role: "support_lead",
      policy: "low_risk_waiver",
    };

    expect(validateRunnerCapabilityConfig(config).errors.map((error) => error.code)).toContain("HARD_DELETE_HUMAN_APPROVAL_REQUIRED");
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
      issuer: "https://identity.example",
      audience: "synapsor-operators",
    };
    expect(validateRunnerCapabilityConfig(config).ok).toBe(true);

    config.operator_identity.token_env = "SYNAPSOR_OPERATOR_TOKEN";
    const rejected = validateRunnerCapabilityConfig(config);
    expect(rejected.ok).toBe(false);
    expect(rejected.errors.map((error) => error.code)).toContain("OPERATOR_TOKEN_SOURCE_CONFLICT");
  });

  it("requires exact issuer and audience binding for OIDC operator tokens", () => {
    const config = mutableConfig();
    config.operator_identity = {
      provider: "jwt_oidc",
      algorithms: ["RS256"],
      public_key_env: "SYNAPSOR_OPERATOR_PUBLIC_KEY",
      token_stdin: true,
      attestation_secret_env: "SYNAPSOR_OPERATOR_ATTESTATION_SECRET",
    };

    const missing = validateRunnerCapabilityConfig(config);
    expect(missing.ok).toBe(false);
    expect(missing.errors.map((error) => error.code)).toEqual(expect.arrayContaining([
      "OPERATOR_JWT_ISSUER_REQUIRED",
      "OPERATOR_JWT_AUDIENCE_REQUIRED",
    ]));

    config.operator_identity.issuer = "https://identity.example";
    config.operator_identity.audience = "synapsor-operators";
    expect(validateRunnerCapabilityConfig(config).ok).toBe(true);
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

  it("accepts exact same-source proposal freshness and rejects widened authority", () => {
    const config = mutableConfig();
    config.capabilities[1].writeback = { mode: "direct_sql" };
    config.proposal_freshness = {
      "billing.propose_late_fee_waiver": {
        approval: "required",
        dependencies: [{
          id: "invoice_eligibility",
          capability: "billing.inspect_invoice",
          identity_from_arg: "invoice_id",
          version_column: "updated_at",
        }],
      },
    };
    expect(validateRunnerCapabilityConfig(config)).toMatchObject({ ok: true, errors: [] });

    config.proposal_freshness["billing.propose_late_fee_waiver"].dependencies[0].identity_from_arg = "tenant_id";
    expect(validateRunnerCapabilityConfig(config).errors.map((error) => error.code)).toContain("FRESHNESS_IDENTITY_ARG_UNKNOWN");

    config.proposal_freshness["billing.propose_late_fee_waiver"].dependencies[0].identity_from_arg = "invoice_id";
    config.capabilities[0].source = "other_source";
    config.sources.other_source = { ...config.sources.app_postgres };
    expect(validateRunnerCapabilityConfig(config).errors.map((error) => error.code)).toContain("FRESHNESS_CROSS_SOURCE_UNSUPPORTED");

    config.capabilities[0].source = "app_postgres";
    config.capabilities[1].writeback = { mode: "app_handler", executor: "billing_handler" };
    config.executors = { billing_handler: { type: "http_handler", url_env: "BILLING_HANDLER_URL" } };
    expect(validateRunnerCapabilityConfig(config).errors.map((error) => error.code)).toContain("FRESHNESS_DIRECT_SQL_REQUIRED");
  });

  it("defers freshness capability references until external contracts are resolved", () => {
    const config = mutableConfig();
    delete config.capabilities;
    config.contracts = ["./synapsor.contract.json"];
    config.proposal_freshness = {
      "billing.propose_late_fee_waiver": {
        approval: "required",
        dependencies: [{
          id: "invoice_eligibility",
          capability: "billing.inspect_invoice",
          identity_from_arg: "invoice_id",
          version_column: "updated_at",
        }],
      },
    };

    expect(validateRunnerCapabilityConfig(config)).toMatchObject({ ok: true, errors: [] });

    delete config.contracts;
    expect(validateRunnerCapabilityConfig(config).errors.map((error) => error.code)).toContain("FRESHNESS_PROPOSAL_UNKNOWN");
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

  it("requires reviewed direct SQL and monotonic versions for reversible capabilities", () => {
    const config = mutableConfig();
    const capability = config.capabilities[1];
    capability.visible_columns = [...capability.visible_columns.filter((field: string) => field !== "updated_at"), "version"];
    capability.conflict_guard = { column: "version" };
    capability.operation = { kind: "update", version_advance: { column: "version", strategy: "integer_increment" } };
    capability.writeback = { mode: "direct_sql" };
    capability.reversibility = { mode: "reviewed_inverse" };

    expect(validateRunnerCapabilityConfig(config)).toMatchObject({ ok: true, errors: [] });

    capability.operation.version_advance.strategy = "database_generated";
    expect(validateRunnerCapabilityConfig(config).errors.map((error) => error.code)).toContain("REVERSIBILITY_INTEGER_VERSION_REQUIRED");
    capability.operation.version_advance.strategy = "integer_increment";
    capability.approval = { mode: "policy", policy: "small_credit" };
    expect(validateRunnerCapabilityConfig(config).errors.map((error) => error.code)).toContain("REVERSIBILITY_HUMAN_APPROVAL_REQUIRED");
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

  it("validates explicit Cloud-linked governance independently from remote adapter mode", () => {
    const config = mutableConfig();
    config.governance = {
      mode: "cloud_linked",
      connection_file: "./synapsor.cloud.json",
      evidence_residency: "metadata_only",
      queue_when_unavailable: true,
      sync_interval_ms: 1000,
      max_attempts: 12,
      outbox_retention_days: 30,
    };
    expect(validateRunnerCapabilityConfig(config)).toMatchObject({ ok: true, errors: [] });

    delete config.governance.connection_file;
    expect(validateRunnerCapabilityConfig(config).errors.map((error) => error.code)).toContain("CLOUD_LINKED_CONNECTION_REQUIRED");
    config.governance.connection_file = "./synapsor.cloud.json";
    config.governance.evidence_residency = "encrypted_payload";
    expect(validateRunnerCapabilityConfig(config).errors.map((error) => error.code)).toContain("UNSUPPORTED_EVIDENCE_RESIDENCY");
  });
});

function mutableConfig(): any {
  return structuredClone(safeConfig);
}

function supervisedWorkerConfig(): any {
  const config = mutableConfig();
  const digest = `sha256:${"a".repeat(64)}`;
  config.sources.app_postgres.receipts = {
    authority: "source_db",
    provisioning: "precreated",
    schema: "public",
    table: "synapsor_writeback_receipts",
  };
  config.capabilities[1].contract_provenance = { digest, version: "1" };
  config.capabilities[1].execution = { supervised_worker: "allowed" };
  config.capabilities[1].writeback = { mode: "direct_sql" };
  config.supervised_worker = {
    enabled: true,
    profile: "staging",
    capabilities: [{
      capability: config.capabilities[1].name,
      contract_digest: digest,
      mode: "supervised_worker",
      concurrency: 1,
      queue_limit: 100,
      lease_seconds: 60,
      max_attempts: 5,
      proposal_ttl_seconds: 86_400,
      rate_limit: { executions: 20, window_seconds: 60 },
      write_url_env: "APP_POSTGRES_WRITE_URL",
      worker_identity: "runner_worker",
      control_role: "runner_operator",
    }],
  };
  return config;
}

function notificationConfig(): any {
  const config = mutableConfig();
  config.notifications = {
    enabled: true,
    workbench_url_env: "SYNAPSOR_WORKBENCH_URL",
    sinks: [
      {
        id: "operations",
        type: "webhook",
        enabled: true,
        url_env: "SYNAPSOR_NOTIFY_WEBHOOK_URL",
        signing_secret_env: "SYNAPSOR_NOTIFY_SIGNING_SECRET",
        minimum_severity: "warning",
        events: [
          "proposal.review_required",
          "worker.dead_lettered",
          "worker.unknown_outcome",
          "worker.reconciliation_required",
          "schema.drift_detected",
        ],
        environments: ["staging", "production"],
        delivery: "immediate",
        max_attempts: 5,
        timeout_ms: 3000,
        max_response_bytes: 1024,
        replay_window_seconds: 300,
        allow_private_destinations: false,
        recovery_notifications: false,
        budgets: {
          per_minute: 10,
          per_hour: 100,
          immediate_informational_per_hour: 0,
          aggregation_window_seconds: 300,
          cooldown_seconds: 600,
          max_unresolved_reminders: 3,
          digest_cadence_minutes: 1440,
          escalation_delay_seconds: 60,
          retry_attempt_threshold: 3,
          degraded_duration_seconds: 120,
          queue_depth_threshold: 100,
          queue_age_seconds: 300,
        },
        quiet_hours: {
          start_utc_hour: 22,
          end_utc_hour: 7,
        },
      },
      {
        id: "development",
        type: "jsonl",
        enabled: true,
        destination: "stdout",
        minimum_severity: "informational",
        delivery: "all",
      },
    ],
  };
  return config;
}
