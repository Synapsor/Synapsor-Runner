import { describe, expect, it, vi } from "vitest";
import type {
  DbRowReader,
  RuntimeCapabilityConfig,
  RuntimeConfig,
  TrustedContext,
} from "@synapsor-runner/mcp-server";
import type { SchemaInspection, TableInfo } from "@synapsor-runner/schema-inspector";
import {
  resolveGuidedActionRehearsalTargetWithRuntime,
  reviewedScopeUniqueness,
} from "./guided-action-rehearsal-target.js";

const capability: RuntimeCapabilityConfig = {
  name: "billing.propose_alert",
  kind: "proposal",
  source: "local_postgres",
  target: {
    schema: "telecom",
    table: "billing_preferences",
    primary_key: "billing_preference_id",
    tenant_key: "account_id",
  },
  args: {
    billing_preference_id: { type: "string", required: true, max_length: 128 },
    monthly_spend_alert_cents: { type: "number", required: true, minimum: 1000, maximum: 50_000 },
  },
  lookup: { id_from_arg: "billing_preference_id" },
  visible_columns: ["billing_preference_id", "alert_level", "delivery_channel"],
  kept_out_fields: ["internal_note"],
  model_withheld_fields: ["operator_code"],
  operation: { kind: "update" },
  conflict_guard: { column: "version" },
  writeback: { mode: "none" },
};

const config: RuntimeConfig = {
  version: 1,
  mode: "review",
  sources: {
    local_postgres: { engine: "postgres", read_url_env: "DATABASE_URL", read_only: true },
  },
  capabilities: [capability],
  trusted_context: {
    provider: "environment",
    values: { tenant_id_env: "SYNAPSOR_TENANT_ID" },
  },
};

const context: TrustedContext = {
  tenant_id: "northstar",
  principal: "",
  provenance: "environment",
};

describe("guided Action rehearsal target resolution", () => {
  it("proves a trusted-scope unique row and keeps its identity internal", async () => {
    const readRow = vi.fn<DbRowReader>(async (input) => {
      expect(input.context).toEqual(context);
      expect(input.args).toEqual({});
      expect(input.transaction_mode).toBe("read_only");
      expect(input.capability.operation).toMatchObject({ cardinality: "set", max_rows: 2 });
      return {
        row: { billing_preference_id: "bp-northstar", alert_level: "standard" },
        rows: [{ billing_preference_id: "bp-northstar", alert_level: "standard" }],
        rowCount: 1,
      };
    });

    await expect(resolveGuidedActionRehearsalTargetWithRuntime({
      config,
      capability,
      inspection: inspection(table({
        unique_constraints: [{ name: "billing_preferences_account_key", columns: ["account_id"] }],
      })),
      context,
      readRow,
    })).resolves.toEqual({
      state: "resolved",
      mode: "trusted_scope_unique",
      lookup_argument: "billing_preference_id",
      value: "bp-northstar",
      proof: "unique constraint billing_preferences_account_key (account_id)",
    });
    expect(readRow).toHaveBeenCalledOnce();
  });

  it("fails closed when the unique scoped row is absent or cardinality changed", async () => {
    const inspected = inspection(table({
      unique_constraints: [{ name: "billing_preferences_account_key", columns: ["account_id"] }],
    }));
    const none: DbRowReader = async () => ({ row: {}, rows: [], rowCount: 0 });
    const multiple: DbRowReader = async () => ({
      row: { billing_preference_id: "bp-1" },
      rows: [{ billing_preference_id: "bp-1" }, { billing_preference_id: "bp-2" }],
      rowCount: 2,
    });

    await expect(resolveGuidedActionRehearsalTargetWithRuntime({
      config, capability, inspection: inspected, context, readRow: none,
    })).resolves.toMatchObject({ state: "unavailable", reason: "no_scoped_rows" });
    await expect(resolveGuidedActionRehearsalTargetWithRuntime({
      config, capability, inspection: inspected, context, readRow: multiple,
    })).resolves.toMatchObject({ state: "unavailable", reason: "scope_cardinality_changed" });
  });

  it("returns a bounded local picker for non-unique scoped resources without displaying identities", async () => {
    const readRow = vi.fn<DbRowReader>(async (input) => {
      expect(input.capability.operation).toMatchObject({ cardinality: "set", max_rows: 3 });
      return {
      row: { billing_preference_id: "secret-pk-1", alert_level: "standard", delivery_channel: "email" },
      rows: [
        { billing_preference_id: "secret-pk-1", alert_level: "standard", delivery_channel: "email" },
        { billing_preference_id: "secret-pk-2", alert_level: "urgent", delivery_channel: "sms" },
        { billing_preference_id: "secret-pk-3", alert_level: "quiet", delivery_channel: "app" },
      ],
      rowCount: 3,
      };
    });
    const result = await resolveGuidedActionRehearsalTargetWithRuntime({
      config,
      capability,
      inspection: inspection(table()),
      context,
      readRow,
      localPickerLimit: 2,
    });

    expect(result).toMatchObject({
      state: "selection_required",
      mode: "local_safe_picker",
      truncated: true,
      candidates: [
        { label: "alert_level: standard | delivery_channel: email", value: "secret-pk-1" },
        { label: "alert_level: urgent | delivery_channel: sms", value: "secret-pk-2" },
      ],
    });
    expect(JSON.stringify(result)).toContain("secret-pk-1");
    if (result.state === "selection_required") {
      expect(result.candidates.map((candidate) => candidate.label).join(" ")).not.toContain("secret-pk");
    }
  });

  it("does not query when trusted scope has no physical target column", async () => {
    const unscoped = {
      ...capability,
      target: { ...capability.target, tenant_key: undefined, principal_scope_key: undefined },
    } as RuntimeCapabilityConfig;
    const readRow = vi.fn<DbRowReader>();
    await expect(resolveGuidedActionRehearsalTargetWithRuntime({
      config,
      capability: unscoped,
      inspection: inspection(table()),
      context,
      readRow,
    })).resolves.toMatchObject({ state: "unavailable", reason: "scope_proof_missing" });
    expect(readRow).not.toHaveBeenCalled();
  });

  it("accepts a composite unique key covered by tenant and principal bindings", () => {
    expect(reviewedScopeUniqueness(table({
      unique_constraints: [{ name: "tenant_principal_key", columns: ["account_id", "principal_id"] }],
    }), ["account_id", "principal_id"]))
      .toBe("unique constraint tenant_principal_key (account_id, principal_id)");
    expect(reviewedScopeUniqueness(table({
      unique_constraints: [{ name: "tenant_kind_key", columns: ["account_id", "kind"] }],
    }), ["account_id", "principal_id"]))
      .toBeUndefined();
  });
});

function inspection(target: TableInfo): SchemaInspection {
  return {
    engine: "postgres",
    server_version: "16",
    current_user: "reader",
    inspected_at: "2026-09-02T00:00:00.000Z",
    schemas: ["telecom"],
    tables: [target],
    warnings: [],
  };
}

function table(overrides: Partial<TableInfo> = {}): TableInfo {
  return {
    schema: "telecom",
    name: "billing_preferences",
    type: "table",
    writable: false,
    columns: [],
    primary_key: ["billing_preference_id"],
    unique_constraints: [],
    foreign_keys: [],
    indexes: [],
    suggestions: {
      tenant_columns: ["account_id"],
      conflict_columns: ["version"],
      sensitive_columns: [],
      default_visible_columns: ["alert_level", "delivery_channel"],
    },
    ...overrides,
  };
}
