import { describe, expect, it } from "vitest";
import { generateRunnerConfigFromSpec, type OnboardingSelectionSpec, type TableInfo } from "@synapsor-runner/schema-inspector";
import { validateContract } from "@synapsor/spec";
import { buildCanonicalOnboardingArtifacts } from "./onboarding-artifacts.js";

const selection: OnboardingSelectionSpec = {
  version: 1,
  engine: "postgres",
  mode: "review",
  read_url_env: "DATABASE_URL",
  write_url_env: "SYNAPSOR_DATABASE_WRITE_URL",
  schema: "public",
  table: "invoices",
  primary_key: "id",
  tenant_key: "tenant_id",
  conflict_column: "version",
  namespace: "billing",
  object_name: "invoice",
  visible_columns: ["id", "tenant_id", "amount_cents", "version"],
  allowed_columns: ["amount_cents"],
  patch: { amount_cents: { from_arg: "amount_cents" } },
  numeric_bounds: { amount_cents: { minimum: 0, maximum: 2500 } },
  trusted_context: { tenant_id_env: "SYNAPSOR_TENANT_ID", principal_env: "SYNAPSOR_PRINCIPAL" },
  approval: { required_role: "billing_reviewer" },
};

const table: TableInfo = {
  schema: "public",
  name: "invoices",
  type: "table",
  writable: true,
  columns: [
    column("id", true),
    column("tenant_id", true),
    column("amount_cents"),
    column("card_token"),
    column("version"),
  ],
  primary_key: ["id"],
  unique_constraints: [],
  foreign_keys: [],
  indexes: [],
  suggestions: {
    tenant_columns: ["tenant_id"],
    conflict_columns: ["version"],
    sensitive_columns: ["card_token"],
    default_visible_columns: ["id", "tenant_id", "amount_cents", "version"],
  },
};

describe("canonical onboarding artifacts", () => {
  it("keeps review writeback disabled until activation is explicitly confirmed", () => {
    expect(() => buildCanonicalOnboardingArtifacts({
      generated: generateRunnerConfigFromSpec(selection),
      selection,
      table,
      configPath: "/workspace/app/synapsor.runner.json",
      contractPath: "/workspace/app/synapsor.contract.json",
      project: { root: "/workspace/app", frameworks: [], schema_inputs: [], database_env_names: [] },
    })).toThrow(/remains disabled.*explicitly confirms activation/i);
  });

  it("moves semantic authority into one valid canonical contract", () => {
    const artifacts = buildCanonicalOnboardingArtifacts({
      generated: generateRunnerConfigFromSpec(selection),
      selection,
      table,
      configPath: "/workspace/app/synapsor.runner.json",
      contractPath: "/workspace/app/synapsor.contract.json",
      project: {
        root: "/workspace/app",
        package_manager: "pnpm",
        frameworks: ["node"],
        schema_inputs: [],
        database_env_names: ["DATABASE_URL"],
      },
      activationConfirmed: true,
      generatedAt: "2026-07-20T00:00:00.000Z",
    });

    expect(validateContract(artifacts.contract)).toMatchObject({ ok: true, errors: [] });
    expect(artifacts.config).not.toHaveProperty("capabilities");
    expect(artifacts.config).not.toHaveProperty("trusted_context");
    expect(artifacts.config.contracts).toEqual(["./synapsor.contract.json"]);
    expect(artifacts.contract.capabilities.map((capability) => capability.name)).toEqual([
      "billing.inspect_invoice",
      "billing.propose_invoice_update",
    ]);
    expect(artifacts.contract.capabilities[0]?.kept_out_fields).toEqual(["card_token"]);
    expect(artifacts.contract.capabilities[1]?.proposal).toMatchObject({
      allowed_fields: ["amount_cents"],
      numeric_bounds: { amount_cents: { minimum: 0, maximum: 2500 } },
      conflict_guard: { column: "version" },
      approval: { mode: "human", required_role: "billing_reviewer" },
      writeback: { mode: "direct_sql" },
    });
    expect(artifacts.manifest).toMatchObject({
      status: "review_active",
      source: { database_url_env: "DATABASE_URL", table: "invoices" },
      action: {
        read_capability: "billing.inspect_invoice",
        proposal_capability: "billing.propose_invoice_update",
        kept_out_fields: ["card_token"],
      },
      safety: {
        developer_confirmed_activation: true,
        source_changed_during_onboarding: false,
        model_can_approve_or_apply: false,
      },
    });
    expect(JSON.stringify(artifacts)).not.toMatch(/postgres(?:ql)?:\/\/|password|secret-value/i);
  });

  it("keeps shadow proposals non-applying in the canonical contract", () => {
    const shadow = { ...selection, mode: "shadow" as const };
    const artifacts = buildCanonicalOnboardingArtifacts({
      generated: generateRunnerConfigFromSpec(shadow),
      selection: shadow,
      table,
      configPath: "/workspace/app/config/runner.json",
      contractPath: "/workspace/app/contracts/contract.json",
      project: { root: "/workspace/app", frameworks: [], schema_inputs: [], database_env_names: [] },
    });
    expect(artifacts.config.contracts).toEqual(["../contracts/contract.json"]);
    expect(artifacts.contract.capabilities[1]?.proposal?.writeback).toEqual({ mode: "none" });
    expect(artifacts.manifest.action.writeback).toBe("none");
    expect(artifacts.manifest).toMatchObject({
      status: "shadow_active",
      safety: { developer_confirmed_activation: false },
    });
  });
});

function column(name: string, immutable = false): TableInfo["columns"][number] {
  return {
    name,
    data_type: name === "amount_cents" || name === "version" ? "integer" : "text",
    nullable: false,
    generated: false,
    ordinal_position: 1,
    suggestions: {
      tenant: name === "tenant_id",
      conflict: name === "version",
      sensitive: name === "card_token",
      immutable,
      large_or_binary: false,
    },
  };
}
