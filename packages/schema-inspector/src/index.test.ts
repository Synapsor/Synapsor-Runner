import { describe, expect, it } from "vitest";
import { generateRunnerConfigFromSpec, summarizeInspection, type SchemaInspection } from "./index.js";

describe("schema inspector helpers", () => {
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
