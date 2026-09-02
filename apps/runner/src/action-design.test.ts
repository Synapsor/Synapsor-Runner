import { describe, expect, it } from "vitest";
import {
  ACTION_SUGGESTION_VERSION,
  assessActionSuggestion,
  normalizeActionSuggestion,
} from "./action-design.js";
import type { GuidedActionResourceOption } from "./guided-action.js";

const resource: GuidedActionResourceOption = {
  id: "public.orders",
  schema: "public",
  table: "orders",
  primary_key: "id",
  tenant_key: "tenant_id",
  writable_fields: [{ name: "status", data_type: "text", enum_values: ["open", "closed"], nullable: false, required_for_insert: true }],
  structurally_eligible_fields: [{ name: "status", data_type: "text", enum_values: ["open", "closed"], nullable: false, required_for_insert: true }],
  conflict_candidates: ["version"],
  insert_dedup_candidates: ["request_id"],
  kept_out_fields: ["tenant_id"],
  operation_availability: {
    update: { available: true, reason: "Available with an exact conflict guard." },
    insert: { available: true, reason: "Available with deduplication." },
    delete: { available: false, reason: "Delete is blocked by a cascading reference." },
  },
};

describe("ActionSuggestion authority boundary", () => {
  it("accepts only non-authoritative model convenience metadata", () => {
    const result = assessActionSuggestion({
      schema_version: ACTION_SUGGESTION_VERSION,
      intent: "Let support propose closing one reviewed order.",
      operation: "update",
      resource: "public.orders",
      fields: ["status"],
      rationale: "The inspected enum and version candidate make this structurally reviewable.",
      suggested_by: { kind: "model", provider: "openai", model: "gpt-5.6-luna" },
    }, [resource]);
    expect(result).toMatchObject({
      status: "suggested",
      authority_granted: false,
      source_database_changed: false,
    });
    expect(result.structural_evidence.every((item) => item.state === "proven_candidate")).toBe(true);
  });

  it.each(["writeback", "approval", "tenant_id", "sql", "worker_policy"])(
    "refuses model-owned %s authority",
    (key) => {
      expect(() => normalizeActionSuggestion({
        schema_version: ACTION_SUGGESTION_VERSION,
        intent: "Unsafe suggestion.",
        suggested_by: { kind: "operator" },
        [key]: "unsafe",
      })).toThrow(/ACTION_SUGGESTION_AUTHORITY_FORBIDDEN/);
    },
  );

  it("blocks unknown fields and structurally unavailable operations without granting authority", () => {
    const result = assessActionSuggestion({
      schema_version: ACTION_SUGGESTION_VERSION,
      intent: "Delete using a hidden field.",
      operation: "delete",
      resource: "public.orders",
      fields: ["tenant_id"],
      suggested_by: { kind: "operator" },
    }, [resource]);
    expect(result.status).toBe("blocked");
    expect(result.blockers).toEqual(expect.arrayContaining([
      "Delete is blocked by a cascading reference.",
      expect.stringContaining("tenant_id"),
    ]));
    expect(result.authority_granted).toBe(false);
  });

  it("accepts a tenant-principal breaker backed by reviewed PostgreSQL RLS principal scope", () => {
    const result = assessActionSuggestion({
      schema_version: ACTION_SUGGESTION_VERSION,
      intent: "Propose closing one order with a per-user rolling limit.",
      operation: "update",
      resource: "public.orders",
      fields: ["status"],
      approval_policy_proposal: {
        mode: "deterministic",
        conditions: [{ field: "status", operator: "in", values: ["closed"] }],
        max_per_day: 10,
        shared_limits: [{ kind: "count", scope: "tenant_principal", maximum: 3, window_seconds: 86_400 }],
      },
      suggested_by: { kind: "model", provider: "openai", model: "gpt-5.6-terra" },
    }, [{ ...resource, principal_rls_setting: "synapsor.principal" }]);

    expect(result.status).toBe("suggested");
    expect(result.structural_evidence).toEqual(expect.arrayContaining([
      expect.objectContaining({ decision: "shared_limit", state: "proven_candidate" }),
    ]));
  });
});
