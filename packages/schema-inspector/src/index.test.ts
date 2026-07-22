import { describe, expect, it } from "vitest";
import {
  assessDirectWritePrerequisites,
  generateRunnerConfigFromSpec,
  summarizeInspection,
  type SchemaInspection,
  type TableInfo,
} from "./index.js";

describe("schema inspector helpers", () => {
  it("never generates a weak UPDATE guard silently during onboarding", () => {
    const base = {
      version: 1 as const,
      engine: "postgres" as const,
      schema: "public",
      table: "invoices",
      primary_key: "id",
      tenant_key: "tenant_id",
      namespace: "billing",
      visible_columns: ["id", "tenant_id", "amount_cents"],
      allowed_columns: ["amount_cents"],
      patch: { amount_cents: { from_arg: "amount_cents" } },
    };

    expect(() => generateRunnerConfigFromSpec({ ...base, mode: "review" })).toThrow(/UPDATE requires an inspected exact conflict_column/);
    const readOnly = generateRunnerConfigFromSpec({ ...base, mode: "read_only" });
    expect((readOnly.config.capabilities as Array<Record<string, unknown>>)).toHaveLength(1);
  });

  it("generates a reviewed local runner config without secrets", () => {
    const generated = generateRunnerConfigFromSpec({
      version: 1,
      engine: "postgres",
      mode: "review",
      read_url_env: "SYNAPSOR_DATABASE_READ_URL",
      write_url_env: "SYNAPSOR_DATABASE_WRITE_URL",
      schema: "public",
      table: "invoices",
      primary_key: "id",
      tenant_key: "tenant_id",
      conflict_column: "updated_at",
      namespace: "billing",
      object_name: "invoice",
      visible_columns: ["id", "tenant_id", "late_fee_cents", "waiver_reason", "updated_at", "password_hash"],
      allowed_columns: ["late_fee_cents", "waiver_reason"],
      patch: {
        late_fee_cents: { fixed: 0 },
        waiver_reason: { from_arg: "reason" },
      },
      patch_args: {
        reason: { type: "string", required: true, max_length: 500 },
      },
    });

    expect(generated.config).toMatchObject({
      version: 1,
      mode: "review",
      sources: {
        local_postgres: {
          engine: "postgres",
          read_url_env: "SYNAPSOR_DATABASE_READ_URL",
          write_url_env: "SYNAPSOR_DATABASE_WRITE_URL",
        },
      },
      trusted_context: {
        provider: "environment",
        values: {
          tenant_id_env: "SYNAPSOR_TENANT_ID",
          principal_env: "SYNAPSOR_PRINCIPAL",
        },
      },
    });
    const capabilities = (generated.config.capabilities as any[]);
    expect(capabilities.map((capability) => capability.name)).toEqual([
      "billing.inspect_invoice",
      "billing.propose_invoice_update",
    ]);
    expect(capabilities[1].patch).toEqual({
      late_fee_cents: { fixed: 0 },
      waiver_reason: { from_arg: "reason" },
    });
    expect(JSON.stringify(generated)).not.toMatch(/postgres(?:ql)?:\/\/|mysql:\/\/|secret_password/i);
  });

  it("uses the reviewed namespace and object name instead of fixed starter capabilities", () => {
    const generated = generateRunnerConfigFromSpec({
      version: 1,
      engine: "mysql",
      mode: "review",
      read_url_env: "APP_DATABASE_READ_URL",
      write_url_env: "APP_DATABASE_WRITE_URL",
      schema: "app",
      table: "appointments",
      primary_key: "appointment_id",
      tenant_key: "clinic_id",
      conflict_column: "updated_at",
      namespace: "clinic",
      object_name: "appointment",
      lookup_arg: "appointment_id",
      visible_columns: ["appointment_id", "clinic_id", "status", "review_note", "updated_at"],
      allowed_columns: ["status", "review_note"],
      patch: {
        status: { from_arg: "next_status" },
        review_note: { from_arg: "review_note" },
      },
      transition_guards: {
        status: {
          allowed: {
            scheduled: ["needs_review"],
            needs_review: ["confirmed", "canceled"],
          },
        },
      },
    });

    const capabilities = (generated.config.capabilities as any[]);
    expect(capabilities.map((capability) => capability.name)).toEqual([
      "clinic.inspect_appointment",
      "clinic.propose_appointment_update",
    ]);
    expect(JSON.stringify(generated.config)).not.toMatch(/billing|support|orders|late_fee|invoice/i);
  });

  it("generates app-owned handler writeback config without a writer database URL", () => {
    const generated = generateRunnerConfigFromSpec({
      version: 1,
      engine: "postgres",
      mode: "review",
      read_url_env: "APP_DATABASE_READ_URL",
      schema: "public",
      table: "refund_reviews",
      primary_key: "id",
      tenant_key: "tenant_id",
      conflict_column: "updated_at",
      namespace: "ops",
      object_name: "refund_review",
      visible_columns: ["id", "tenant_id", "status", "decision_note", "updated_at"],
      allowed_columns: ["status", "decision_note"],
      patch: {
        status: { from_arg: "next_status" },
        decision_note: { from_arg: "reason" },
      },
      writeback: {
        executor: "http_handler",
        executor_name: "ops_refund_api",
        handler_url_env: "REFUND_WRITEBACK_URL",
        handler_token_env: "REFUND_WRITEBACK_TOKEN",
        handler_signing_secret_env: "REFUND_WRITEBACK_SIGNING_SECRET",
        timeout_ms: 2500,
      },
    });

    expect(generated.config).toMatchObject({
      mode: "review",
      result_format: 2,
      sources: {
        local_postgres: {
          engine: "postgres",
          read_url_env: "APP_DATABASE_READ_URL",
          read_only: true,
        },
      },
      executors: {
        ops_refund_api: {
          type: "http_handler",
          url_env: "REFUND_WRITEBACK_URL",
          method: "POST",
          auth: { type: "bearer_env", token_env: "REFUND_WRITEBACK_TOKEN" },
          signing_secret_env: "REFUND_WRITEBACK_SIGNING_SECRET",
          timeout_ms: 2500,
        },
      },
    });
    expect((generated.config.sources as any).local_postgres.write_url_env).toBeUndefined();
    expect((generated.config.sources as any).local_postgres.read_only).toBe(true);
    const proposal = (generated.config.capabilities as any[])[1];
    expect(proposal.executor).toBe("ops_refund_api");
    expect(generated.envExample).toContain('REFUND_WRITEBACK_URL="http://127.0.0.1:8787/synapsor/writeback"');
    expect(generated.envExample).toContain('REFUND_WRITEBACK_TOKEN="<handler-bearer-token>"');
    expect(generated.envExample).toContain('REFUND_WRITEBACK_SIGNING_SECRET="<handler-hmac-signing-secret>"');
    expect(JSON.stringify(generated)).not.toMatch(/postgres(?:ql)?:\/\/|mysql:\/\/|password|handler-secret-token|hmac-secret-value/i);
  });

  it("rejects unsafe identifiers and missing tenant scope", () => {
    expect(() => generateRunnerConfigFromSpec({
      engine: "postgres",
      mode: "shadow",
      schema: "public;drop",
      table: "invoices",
      primary_key: "id",
      namespace: "billing",
      visible_columns: ["id"],
    })).toThrow(/tenant_key|single_tenant_dev|unsafe/i);
  });

  it("generates bounded numeric and transition-guarded proposal args", () => {
    const generated = generateRunnerConfigFromSpec({
      version: 1,
      engine: "postgres",
      mode: "review",
      schema: "public",
      table: "tickets",
      primary_key: "id",
      tenant_key: "tenant_id",
      conflict_column: "updated_at",
      namespace: "support",
      object_name: "ticket",
      visible_columns: ["id", "tenant_id", "status", "credit_cents", "updated_at"],
      allowed_columns: ["status", "credit_cents"],
      patch: {
        status: { from_arg: "next_status" },
        credit_cents: { from_arg: "credit_cents" },
      },
      numeric_bounds: {
        credit_cents: { minimum: 0, maximum: 10000 },
      },
      transition_guards: {
        status: {
          allowed: {
            open: ["pending_review"],
            pending_review: ["resolved"],
          },
        },
      },
    });
    const proposal = (generated.config.capabilities as any[])[1];
    expect(proposal.args.credit_cents).toMatchObject({ type: "number", minimum: 0, maximum: 10000 });
    expect(proposal.args.next_status).toMatchObject({ type: "string", enum: ["pending_review", "resolved"] });
    expect(proposal.numeric_bounds).toEqual({ credit_cents: { minimum: 0, maximum: 10000 } });
    expect(proposal.transition_guards).toEqual({
      status: {
        allowed: {
          open: ["pending_review"],
          pending_review: ["resolved"],
        },
      },
    });
  });

  it("rejects generated guard specs that do not reference patch columns", () => {
    expect(() => generateRunnerConfigFromSpec({
      version: 1,
      engine: "postgres",
      mode: "review",
      schema: "public",
      table: "tickets",
      primary_key: "id",
      tenant_key: "tenant_id",
      conflict_column: "updated_at",
      namespace: "support",
      visible_columns: ["id", "tenant_id", "status", "updated_at"],
      allowed_columns: ["status"],
      patch: {
        status: { from_arg: "next_status" },
      },
      numeric_bounds: {
        credit_cents: { minimum: 0, maximum: 10000 },
      },
    })).toThrow(/numeric bound column credit_cents is not in patch/i);
  });

  it("generates native INSERT and Runner-ledger UPDATE semantics without source receipt configuration drift", () => {
    const insert = generateRunnerConfigFromSpec({
      engine: "postgres",
      mode: "review",
      schema: "public",
      table: "credits",
      primary_key: "id",
      tenant_key: "tenant_id",
      namespace: "billing",
      object_name: "credit",
      visible_columns: ["id", "tenant_id", "amount_cents", "reason"],
      operation: "insert",
      deduplication: {
        components: [
          { column: "id", source: "proposal_id" },
          { column: "tenant_id", source: "trusted_tenant" },
        ],
      },
      allowed_columns: ["amount_cents", "reason"],
      patch: {
        amount_cents: { from_arg: "amount_cents" },
        reason: { from_arg: "reason" },
      },
      receipts: { authority: "runner_ledger" },
    });
    const insertProposal = (insert.config.capabilities as any[])[1];
    expect(insertProposal.operation).toEqual({
      kind: "insert",
      deduplication: {
        components: [
          { column: "id", source: "proposal_id" },
          { column: "tenant_id", source: "trusted_tenant" },
        ],
      },
    });
    expect((insert.config.sources as any).local_postgres.receipts).toEqual({ authority: "runner_ledger" });

    const update = generateRunnerConfigFromSpec({
      engine: "mysql",
      mode: "review",
      schema: "app",
      table: "parts",
      primary_key: "id",
      tenant_key: "tenant_id",
      conflict_column: "version",
      namespace: "parts",
      visible_columns: ["id", "tenant_id", "price_cents", "version"],
      operation: "update",
      version_advance: { column: "version", strategy: "integer_increment" },
      allowed_columns: ["price_cents"],
      patch: { price_cents: { from_arg: "price_cents" } },
      receipts: { authority: "runner_ledger" },
    });
    expect((update.config.capabilities as any[])[1].operation).toEqual({
      kind: "update",
      version_advance: { column: "version", strategy: "integer_increment" },
    });
  });

  it("requires source-enforced INSERT identity and complete required fields", () => {
    const table = directWriteTable();
    const checks = assessDirectWritePrerequisites(table, {
      operation: "insert",
      primary_key: "id",
      tenant_key: "tenant_id",
      allowed_columns: ["amount_cents", "reason"],
      patch_columns: ["amount_cents", "reason"],
      dedup_columns: ["id", "tenant_id"],
    });
    expect(checks).toContainEqual(expect.objectContaining({ code: "INSERT_DEDUP_SOURCE_UNIQUE", level: "pass" }));
    expect(checks).toContainEqual(expect.objectContaining({ code: "INSERT_REQUIRED_COLUMNS_SATISFIED", level: "pass" }));

    const unsafe = assessDirectWritePrerequisites(table, {
      operation: "insert",
      primary_key: "id",
      tenant_key: "tenant_id",
      allowed_columns: ["amount_cents"],
      patch_columns: ["amount_cents"],
      dedup_columns: ["tenant_id"],
    });
    expect(unsafe).toContainEqual(expect.objectContaining({ code: "INSERT_DEDUP_NOT_SOURCE_UNIQUE", level: "fail" }));
    expect(unsafe).toContainEqual(expect.objectContaining({ code: "INSERT_REQUIRED_COLUMNS_MISSING", level: "fail" }));
  });

  it("blocks hard DELETE when inspected cascades or triggers can widen the reviewed effect", () => {
    const table = directWriteTable();
    table.referenced_by = [{
      name: "ticket_events_ticket_fk",
      schema: "public",
      table: "ticket_events",
      columns: ["ticket_id"],
      referenced_columns: ["id"],
      delete_rule: "CASCADE",
    }];
    table.write_triggers = [{ name: "delete_audit", timing: "AFTER", orientation: "ROW", events: ["DELETE"] }];
    const checks = assessDirectWritePrerequisites(table, {
      operation: "delete",
      primary_key: "id",
      tenant_key: "tenant_id",
      allowed_columns: [],
      patch_columns: [],
      conflict_column: "version",
    });
    expect(checks).toContainEqual(expect.objectContaining({ code: "DELETE_REFERENTIAL_EFFECT_BLOCKED", level: "fail" }));
    expect(checks).toContainEqual(expect.objectContaining({ code: "DELETE_TRIGGER_BLOCKED", level: "fail" }));
  });

  it("summarizes inspections without row data", () => {
    const inspection: SchemaInspection = {
      engine: "postgres",
      server_version: "PostgreSQL 16",
      current_user: "synapsor_reader",
      inspected_at: "2026-06-21T00:00:00Z",
      schemas: ["public"],
      warnings: [],
      tables: [
        {
          schema: "public",
          name: "invoices",
          type: "table",
          writable: true,
          columns: [],
          primary_key: ["id"],
          unique_constraints: [],
          foreign_keys: [],
          indexes: [],
          suggestions: {
            tenant_columns: ["tenant_id"],
            conflict_columns: ["updated_at"],
            sensitive_columns: ["password_hash"],
            default_visible_columns: ["id", "tenant_id", "updated_at"],
          },
        },
      ],
    };
    expect(summarizeInspection(inspection)).toContain("public.invoices");
    expect(summarizeInspection(inspection)).toContain("tenant=tenant_id");
  });
});

function directWriteTable(): TableInfo {
  const suggestions = { tenant: false, conflict: false, sensitive: false, immutable: false, large_or_binary: false };
  return {
    schema: "public",
    name: "credits",
    type: "table",
    writable: true,
    columns: [
      { name: "id", data_type: "text", nullable: false, generated: false, ordinal_position: 1, suggestions: { ...suggestions, immutable: true } },
      { name: "tenant_id", data_type: "text", nullable: false, generated: false, ordinal_position: 2, suggestions: { ...suggestions, tenant: true, immutable: true } },
      { name: "amount_cents", data_type: "integer", nullable: false, generated: false, ordinal_position: 3, suggestions },
      { name: "reason", data_type: "text", nullable: false, generated: false, ordinal_position: 4, suggestions },
      { name: "version", data_type: "integer", nullable: false, default: "0", generated: false, ordinal_position: 5, suggestions: { ...suggestions, conflict: true } },
    ],
    primary_key: ["id"],
    unique_constraints: [],
    foreign_keys: [],
    indexes: [],
    suggestions: {
      tenant_columns: ["tenant_id"],
      conflict_columns: ["version"],
      sensitive_columns: [],
      default_visible_columns: ["id", "tenant_id", "amount_cents", "reason", "version"],
    },
  };
}
