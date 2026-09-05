import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_REVIEWED_EXPLORATION_BUDGETS,
  type ExplorationBoundaryDraft,
} from "./auto-boundary.js";
import type { AskProviderDependencies } from "./model-ask.js";
import { parseReadPolicySettings } from "./read-boundary-policy-revision.js";
import {
  generateModelReadBoundaryRevision,
  readBoundaryRevisionCatalog,
} from "./read-boundary-revision-model.js";

describe("model-assisted Read Boundary field exposure revisions", () => {
  it("retains the exact 36-field privacy diff without hiding business references or discarding private facts", async () => {
    const reviewed = boundary();
    const names = ["accounts", "memberships", "subscribers", "subscriptions", "lines", "usage", "invoices", "payments", "preferences", "cases", "notes", "offers"];
    reviewed.pack.resources = names.map((table) => {
      const resource = structuredClone(reviewed.pack.resources[0]!);
      return { ...resource, id: `telecom.${table}`, schema: "telecom", table,
        field_types: { ...resource.field_types, invoice_number: "text", case_number: "text" },
        selectable_fields: [...resource.selectable_fields, "invoice_number", "case_number"] };
    });
    const before = structuredClone(reviewed);
    const fields = ["id", "version", "auto_approval_eligible"];
    const result = await generateModelReadBoundaryRevision({
      instruction: "Keep useful customer information visible, but keep internal IDs, versions and approval controls private. Runner still needs them. Preserve invoice and case numbers, rules and limits.",
      provider: "openai", model: "gpt-5.6-terra", apiKey: "test-only", boundary: reviewed, egressAcknowledged: true,
      dependencies: { requestJson: async () => ({ status: 200, body: { output: [{
        type: "function_call", call_id: "privacy", name: "runner__submit_read_boundary_revision",
        arguments: JSON.stringify({ resource_changes: reviewed.pack.resources.map((resource) => ({
          resource: resource.id, field_exposure: fields.map((field) => ({ field, exposure: "runner_only" })),
        })) }),
      }] } }) },
    });
    expect(result.changes.map(({ resource, field, before, after }) => ({ resource, field, before, after })))
      .toEqual(reviewed.pack.resources.flatMap((resource) => fields.map((field) => ({
        resource: resource.id, field, before: "model_and_runner", after: "runner_only",
      }))));
    expect(result.changes).toHaveLength(36);
    expect(result.policy_changes ?? []).toEqual([]);
    expect(result.changes.some((change) => ["invoice_number", "case_number", "tenant_id", "principal_id"].includes(change.field))).toBe(false);
    expect(reviewed).toEqual(before);
    expect(result.authority_granted).toBe(false);
  });

  it("edits bounded operations, labels and limits without broadening trusted authority", async () => {
    const result = await generateModelReadBoundaryRevision({
      instruction: "Allow filtering status, label it Order status, and cap results at 20 rows.",
      provider: "openai", model: "gpt-test", apiKey: "test-only", boundary: boundary(), egressAcknowledged: true,
      dependencies: { requestJson: async () => ({ status: 200, body: { output: [{
        type: "function_call", call_id: "revision", name: "runner__submit_read_boundary_revision",
        arguments: JSON.stringify({ resource_changes: [{ resource: "public.orders", settings: {
          filterable_fields: ["status"], max_rows: 20, field_metadata: [{ field: "status", label: "Order status" }],
        } }] }),
      }] } }) },
    });
    expect(result.changes).toEqual([]);
    expect(result.policy_changes).toEqual([{ resource: "public.orders", settings: {
      filterable_fields: ["status"], max_rows: 20, field_metadata: [{ field: "status", label: "Order status" }],
    } }]);
    expect(result.authority_granted).toBe(false);
    const resource = readBoundaryRevisionCatalog(boundary()).resources[0]!;
    for (const setting of [
      { tenant_key: "status" }, { max_rows: 1e12 }, { max_rows: 0 },
      { filterable_fields: ["tenant_id"] }, { selectable_fields: ["invented"] },
      { relationship_ids: ["invented_path"] }, { field_metadata: [{ field: "invented", label: "Meaning" }] },
    ]) expect(() => parseReadPolicySettings(setting, resource)).toThrow();
  });

  it.each(["openai", "anthropic"] as const)(
    "accepts one exact %s revision while granting no authority",
    async (provider) => {
      const requests: Array<Parameters<NonNullable<AskProviderDependencies["requestJson"]>>[0]> = [];
      const payload = {
        summary: "Keep internal controls private while retaining business fields.",
        resource_changes: [{
          resource: "public.orders",
          field_exposure: [
            { field: "id", exposure: "runner_only", rationale: "Use an opaque object reference." },
            { field: "version", exposure: "runner_only", rationale: "Keep conflict state private." },
            { field: "auto_approval_eligible", exposure: "runner_only", rationale: "Private policy fact." },
          ],
        }],
      };
      const requestJson = vi.fn(async (request: Parameters<NonNullable<AskProviderDependencies["requestJson"]>>[0]) => {
        requests.push(request);
        return provider === "openai"
          ? {
              status: 200,
              body: {
                output: [{
                  type: "function_call",
                  call_id: "call_read_revision",
                  name: "runner__submit_read_boundary_revision",
                  arguments: JSON.stringify(payload),
                }],
              },
            }
          : {
              status: 200,
              body: {
                content: [{
                  type: "tool_use",
                  id: "toolu_read_revision",
                  name: "runner__submit_read_boundary_revision",
                  input: payload,
                }],
              },
            };
      });

      const result = await generateModelReadBoundaryRevision({
        instruction: "Keep raw internal identifiers, conflict versions, and private approval facts with Runner.",
        provider,
        model: provider === "openai" ? "gpt-5.6-terra" : "claude-test",
        boundary: boundary(),
        env: { TEST_PROVIDER_KEY: "provider-test-key" },
        apiKeyEnv: "TEST_PROVIDER_KEY",
        egressAcknowledged: true,
        dependencies: { requestJson },
      });

      expect(result).toMatchObject({
        provider,
        model_exposure_expansions: 0,
        authority_granted: false,
        source_query_executed: false,
        explore_budget_consumed: false,
        source_database_changed: false,
      });
      expect(result.changes.map(({ resource, field, before, after }) => ({ resource, field, before, after })))
        .toEqual([
          { resource: "public.orders", field: "id", before: "model_and_runner", after: "runner_only" },
          { resource: "public.orders", field: "version", before: "model_and_runner", after: "runner_only" },
          { resource: "public.orders", field: "auto_approval_eligible", before: "model_and_runner", after: "runner_only" },
        ]);
      expect(requestJson).toHaveBeenCalledOnce();
      const body = JSON.stringify(requests[0]!.body);
      expect(body).toContain("runner__submit_read_boundary_revision");
      expect(body).toContain("internal_identifier_candidate");
      expect(body).toContain("conflict_or_version_guard");
      expect(body).toContain("private_policy_candidate");
      expect(body).not.toContain("provider-test-key");
      expect(body).not.toContain("tenant-acme");
      expect(body).not.toContain("principal-maya");
    },
  );

  it("rejects a trusted-scope exposure and permits one bounded correction", async () => {
    let attempt = 0;
    const requestJson = vi.fn(async () => {
      attempt += 1;
      const payload = attempt === 1
        ? {
            resource_changes: [{
              resource: "public.orders",
              field_exposure: [{ field: "tenant_id", exposure: "model_and_runner" }],
            }],
          }
        : {
            resource_changes: [{
              resource: "public.orders",
              field_exposure: [{ field: "id", exposure: "runner_only" }],
            }],
          };
      return {
        status: 200,
        body: {
          output: [{
            type: "function_call",
            call_id: `call_read_revision_${attempt}`,
            name: "runner__submit_read_boundary_revision",
            arguments: JSON.stringify(payload),
          }],
        },
      };
    });

    const result = await generateModelReadBoundaryRevision({
      instruction: "Keep internal scope and identity fields private.",
      provider: "openai",
      model: "gpt-5.6-terra",
      boundary: boundary(),
      env: { OPENAI_API_KEY: "provider-test-key" },
      egressAcknowledged: true,
      dependencies: { requestJson },
    });

    expect(requestJson).toHaveBeenCalledTimes(2);
    expect(result.correction_used).toBe(true);
    expect(result.changes).toEqual([
      expect.objectContaining({ field: "id", after: "runner_only" }),
    ]);
  });

  it("rejects a no-op submission and accepts only one corrected exact change", async () => {
    let attempt = 0;
    const requestJson = vi.fn(async () => {
      attempt += 1;
      const payload = attempt === 1
        ? {
            resource_changes: [{
              resource: "public.orders",
              field_exposure: [{ field: "status", exposure: "model_and_runner" }],
            }],
          }
        : {
            resource_changes: [{
              resource: "public.orders",
              field_exposure: [{ field: "secret_note", exposure: "runner_only" }],
            }],
          };
      return {
        status: 200,
        body: {
          output: [{
            type: "function_call",
            call_id: `call_read_noop_${attempt}`,
            name: "runner__submit_read_boundary_revision",
            arguments: JSON.stringify(payload),
          }],
        },
      };
    });

    const result = await generateModelReadBoundaryRevision({
      instruction: "Retain the private note for Runner verification without returning it to the model.",
      provider: "openai",
      model: "gpt-5.6-terra",
      boundary: boundary(),
      env: { OPENAI_API_KEY: "provider-test-key" },
      egressAcknowledged: true,
      dependencies: { requestJson },
    });

    expect(requestJson).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      correction_used: true,
      model_exposure_expansions: 0,
      changes: [{
        resource: "public.orders",
        field: "secret_note",
        before: "kept_out",
        after: "runner_only",
      }],
    });
  });

  it("publishes structural role hints without rows or trusted identity values", () => {
    const catalog = readBoundaryRevisionCatalog(boundary());
    const resource = catalog.resources[0]!;
    expect(resource.fields.find((field) => field.id === "id")?.roles).toEqual(
      expect.arrayContaining(["record_identity", "internal_identifier_candidate"]),
    );
    expect(resource.fields.find((field) => field.id === "tenant_id")?.roles).toContain("trusted_scope");
    expect(resource.fields.find((field) => field.id === "version")?.roles).toContain("conflict_or_version_guard");
    expect(resource.fields.find((field) => field.id === "auto_approval_eligible")?.roles)
      .toContain("private_policy_candidate");
    expect(catalog.trust).toEqual({
      raw_rows_included: false,
      observed_values_included: false,
      trusted_identity_values_included: false,
      activation_available: false,
      source_query_available: false,
      source_write_available: false,
    });
    expect(JSON.stringify(catalog)).not.toContain("tenant-acme");
    expect(JSON.stringify(catalog)).not.toContain("principal-maya");
  });
});

function boundary(): ExplorationBoundaryDraft {
  const hash = (value: string) => `sha256:${value.repeat(64).slice(0, 64)}` as `sha256:${string}`;
  return {
    schema_version: "synapsor.exploration-boundary.v1",
    activation: "disabled_unreviewed",
    deployment_profile: "staging",
    source: "local_postgres",
    compiler_version: "1.8.0",
    spec_version: "1.11.0",
    reporting_timezone: "UTC",
    trusted_context: {
      provider: "environment",
      tenant_env: "SYNAPSOR_TENANT_ID",
      principal_env: "SYNAPSOR_PRINCIPAL",
    },
    generation_lock_fingerprint: hash("1"),
    role_posture_fingerprint: hash("2"),
    pack: {
      name: "reviewed_staging",
      resources: [{
        id: "public.orders",
        schema: "public",
        table: "orders",
        primary_key: "id",
        tenant_key: "tenant_id",
        principal_key: "principal_id",
        field_types: {
          id: "uuid",
          tenant_id: "text",
          principal_id: "text",
          status: "text",
          version: "integer",
          auto_approval_eligible: "boolean",
          secret_note: "text",
        },
        field_enums: { status: ["open", "closed"] },
        selectable_fields: ["id", "status", "version", "auto_approval_eligible"],
        filterable_fields: { status: ["eq", "neq", "in"] },
        sortable_fields: ["status"],
        groupable_fields: ["status"],
        aggregate_measures: [],
        aggregate_measure_functions: {},
        count_distinct_fields: ["status"],
        time_bucket_fields: {},
        kept_out_fields: ["tenant_id", "principal_id", "secret_note"],
        relationships: [],
        minimum_cohort_size: 5,
        suppression_aware_totals: true,
      }],
    },
    budgets: structuredClone(DEFAULT_REVIEWED_EXPLORATION_BUDGETS),
    unresolved_decisions: [],
  };
}
