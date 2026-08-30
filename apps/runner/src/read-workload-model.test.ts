import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_REVIEWED_EXPLORATION_BUDGETS,
  type ExplorationBoundaryDraft,
} from "./auto-boundary.js";
import type { AskProviderDependencies } from "./model-ask.js";
import { generateModelReadWorkload, readWorkloadCatalog } from "./read-workload-model.js";

describe("model-assisted Read workload mapping", () => {
  it.each(["openai", "anthropic"] as const)(
    "uses one ephemeral structured workload tool with %s and grants no authority",
    async (provider) => {
      const requests: string[] = [];
      const requestJson = vi.fn(async (request: Parameters<NonNullable<AskProviderDependencies["requestJson"]>>[0]) => {
        requests.push(JSON.stringify(request.body));
        const input = {
          allowed: [{
            id: "orders_by_status",
            description: "Average order amount by status",
            plan: {
              kind: "aggregate",
              resource: "public.orders",
              measures: [{ function: "avg", field: "amount" }],
              dimensions: [{ field: "status" }],
            },
          }],
          forbidden: [{
            id: "raw_secret_notes",
            description: "Do not return secret notes",
            plan: { kind: "rows", resource: "public.orders", select: ["secret_note"] },
          }],
        };
        if (provider === "openai") {
          return {
            status: 200,
            body: {
              output: [{
                type: "function_call",
                call_id: "call_read_workload",
                name: "runner__submit_read_workloads",
                arguments: JSON.stringify(input),
              }],
            },
          };
        }
        return {
          status: 200,
          body: {
            content: [{
              type: "tool_use",
              id: "toolu_read_workload",
              name: "runner__submit_read_workloads",
              input,
            }],
          },
        };
      });

      const result = await generateModelReadWorkload({
        name: "support_reads",
        allowedQuestions: ["What is average order amount by status?"],
        forbiddenQuestions: ["Show private row text."],
        provider,
        model: provider === "openai" ? "gpt-5.6-luna" : "claude-test",
        generatedBoundary: generatedBoundary(),
        env: { TEST_PROVIDER_KEY: "provider-test-key" },
        apiKeyEnv: "TEST_PROVIDER_KEY",
        egressAcknowledged: true,
        dependencies: { requestJson },
      });

      expect(result).toMatchObject({
        provider,
        authority_granted: false,
        source_query_executed: false,
        explore_budget_consumed: false,
        source_database_changed: false,
        analysis: {
          status: "ready",
          authority_granted: false,
          coverage: {
            allowed_supported: 1,
            forbidden_denied: 1,
          },
        },
      });
      expect(requestJson).toHaveBeenCalledTimes(1);
      const body = requests[0]!;
      expect(body).toContain("public.orders");
      expect(body).toContain("amount");
      expect(body).not.toContain("provider-test-key");
      expect(body).not.toContain("tenant_id");
      expect(body).not.toContain("principal_id");
      expect(body).not.toContain("secret_note");
      expect(body).not.toContain("open-value-from-database");
      const firstBody = JSON.parse(requests[0]!) as Record<string, unknown>;
      expect(firstBody.tool_choice).toEqual(provider === "openai"
        ? { type: "function", name: "runner__submit_read_workloads" }
        : { type: "tool", name: "runner__submit_read_workloads" });
    },
  );

  it("requires explicit structural-metadata egress acknowledgement before any provider request", async () => {
    const requestJson = vi.fn();
    await expect(generateModelReadWorkload({
      name: "support_reads",
      allowedQuestions: ["Average order amount by status"],
      provider: "openai",
      model: "gpt-5.6-luna",
      generatedBoundary: generatedBoundary(),
      env: { OPENAI_API_KEY: "provider-test-key" },
      egressAcknowledged: false,
      dependencies: { requestJson },
    })).rejects.toThrow(/Acknowledge that reviewed visible data/);
    expect(requestJson).not.toHaveBeenCalled();
  });

  it("gives a local model one bounded correction when it returns prose instead of the required tool", async () => {
    let attempt = 0;
    const requests: string[] = [];
    const requestJson = vi.fn(async (request: Parameters<NonNullable<AskProviderDependencies["requestJson"]>>[0]) => {
      requests.push(JSON.stringify(request.body));
      attempt += 1;
      if (attempt === 1) {
        return {
          status: 200,
          body: {
            choices: [{ message: { role: "assistant", content: "Here is a prose summary instead." } }],
          },
        };
      }
      return {
        status: 200,
        body: {
          choices: [{
            message: {
              role: "assistant",
              content: "",
              tool_calls: [{
                id: "call_local_read_workload",
                type: "function",
                function: {
                  name: "runner__submit_read_workloads",
                  arguments: JSON.stringify({
                    allowed: [{
                      id: "orders_by_status",
                      description: "Average order amount by status",
                      plan: {
                        kind: "aggregate",
                        resource: "public.orders",
                        measures: [{ function: "avg", field: "amount" }],
                        dimensions: [{ field: "status" }],
                      },
                    }],
                    forbidden: [],
                  }),
                },
              }],
            },
          }],
        },
      };
    });

    const result = await generateModelReadWorkload({
      name: "support_reads",
      allowedQuestions: ["What is average order amount by status?"],
      provider: "openai_compatible",
      model: "qwen-local",
      baseUrl: "http://127.0.0.1:11434/v1",
      generatedBoundary: generatedBoundary(),
      egressAcknowledged: true,
      dependencies: { requestJson },
    });

    expect(result.analysis.status).toBe("ready");
    expect(requestJson).toHaveBeenCalledTimes(2);
    expect(requests[1]).toContain("previous response was discarded");
    expect(requests[1]).toContain("Call runner.submit_read_workloads exactly once now");
  });

  it.each(["openai", "anthropic"] as const)(
    "gives %s one bounded correction after deterministic workload validation refuses the first plan",
    async (provider) => {
      let attempt = 0;
      const requests: string[] = [];
      const requestJson = vi.fn(async (request: Parameters<NonNullable<AskProviderDependencies["requestJson"]>>[0]) => {
        requests.push(JSON.stringify(request.body));
        attempt += 1;
        const input = {
          allowed: [{
            id: "orders_by_status",
            description: "Average order amount by status",
            plan: attempt === 1
              ? {
                  kind: "aggregate",
                  resource: "public.orders",
                  measures: [{ function: "avg" }],
                  dimensions: [{ field: "status" }],
                }
              : {
                  kind: "aggregate",
                  resource: "public.orders",
                  measures: [{ function: "avg", field: "amount" }],
                  dimensions: [{ field: "status" }],
                },
          }],
          forbidden: [],
        };
        return provider === "openai"
          ? {
              status: 200,
              body: {
                output: [{
                  type: "function_call",
                  call_id: `call_read_workload_${attempt}`,
                  name: "runner__submit_read_workloads",
                  arguments: JSON.stringify(input),
                }],
              },
            }
          : {
              status: 200,
              body: {
                content: [{
                  type: "tool_use",
                  id: `toolu_read_workload_${attempt}`,
                  name: "runner__submit_read_workloads",
                  input,
                }],
              },
            };
      });

      const result = await generateModelReadWorkload({
        name: "support_reads",
        allowedQuestions: ["What is average order amount by status?"],
        provider,
        model: provider === "openai" ? "gpt-5.6-luna" : "claude-test",
        generatedBoundary: generatedBoundary(),
        env: { TEST_PROVIDER_KEY: "provider-test-key" },
        apiKeyEnv: "TEST_PROVIDER_KEY",
        egressAcknowledged: true,
        dependencies: { requestJson },
      });

      expect(requestJson).toHaveBeenCalledTimes(2);
      expect(result.analysis.status).toBe("ready");
      expect(result.workload.allowed[0]?.plan).toMatchObject({ kind: "aggregate" });
      expect(requests[1]).toContain("Your first non-authoritative workload was refused");
      expect(requests[0]).toContain('"enum":["rows"]');
      expect(requests[0]).toContain('"required":["function","field"]');
      expect(requests[1]).toContain("(missing) is not reviewed for avg");
      expect(result).toMatchObject({
        authority_granted: false,
        source_query_executed: false,
        explore_budget_consumed: false,
        source_database_changed: false,
      });
    },
  );

  it("keeps an invalid model mapping blocked and non-authoritative", async () => {
    const requestJson = vi.fn(async () => ({
      status: 200,
      body: {
        output: [{
          type: "function_call",
          call_id: "call_bad_read_workload",
          name: "runner__submit_read_workloads",
          arguments: JSON.stringify({
            allowed: [{
              id: "invented_field",
              description: "Invented access",
              plan: { kind: "rows", resource: "public.orders", select: ["not_a_field"] },
            }],
            forbidden: [],
          }),
        }],
      },
    }));

    const result = await generateModelReadWorkload({
      name: "blocked_mapping",
      allowedQuestions: ["Show an invented field"],
      provider: "openai",
      model: "gpt-5.6-luna",
      generatedBoundary: generatedBoundary(),
      env: { OPENAI_API_KEY: "provider-test-key" },
      egressAcknowledged: true,
      dependencies: { requestJson },
    });

    expect(result.analysis.status).toBe("blocked");
    expect(result.analysis.candidate).toBeUndefined();
    expect(requestJson).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      authority_granted: false,
      source_query_executed: false,
      explore_budget_consumed: false,
      source_database_changed: false,
    });
  });

  it("publishes only model-visible structural catalog fields", () => {
    const catalog = readWorkloadCatalog(generatedBoundary());
    const serialized = JSON.stringify(catalog);
    expect(serialized).toContain("public.orders");
    expect(serialized).not.toContain("tenant_id");
    expect(serialized).not.toContain("principal_id");
    expect(serialized).not.toContain("secret_note");
    expect(serialized).not.toContain("open-value-from-database");
    expect(catalog.trust).toEqual({
      model_supplies_tenant: false,
      model_supplies_principal: false,
      model_supplies_object_scope: false,
      raw_rows_included: false,
      database_values_included: false,
    });
  });
});

function generatedBoundary(): ExplorationBoundaryDraft {
  const hash = (value: string) => `sha256:${value.repeat(64).slice(0, 64)}` as `sha256:${string}`;
  return {
    schema_version: "synapsor.exploration-boundary.v1",
    activation: "disabled_unreviewed",
    deployment_profile: "staging",
    source: "local_postgres",
    compiler_version: "1.7.0",
    spec_version: "1.9.0",
    reporting_timezone: "UTC",
    trusted_context: {
      provider: "environment",
      tenant_env: "SYNAPSOR_TENANT_ID",
      principal_env: "SYNAPSOR_PRINCIPAL_ID",
    },
    generation_lock_fingerprint: hash("1"),
    role_posture_fingerprint: hash("2"),
    pack: {
      name: "reviewed_staging",
      resources: [{
        id: "public.orders",
        schema: "public",
        table: "orders",
        label: "Customer orders",
        description: "One reviewed order per purchase.",
        primary_key: "id",
        tenant_key: "tenant_id",
        principal_key: "principal_id",
        field_types: {
          id: "uuid",
          tenant_id: "text",
          principal_id: "text",
          status: "text",
          amount: "numeric",
          secret_note: "text",
        },
        field_enums: { status: ["open-value-from-database", "closed-value-from-database"] },
        selectable_fields: ["id", "status", "amount"],
        filterable_fields: { status: ["eq", "neq", "in"] },
        sortable_fields: ["amount"],
        groupable_fields: ["status"],
        aggregate_measures: ["amount"],
        aggregate_measure_functions: { amount: ["sum", "avg"] },
        count_distinct_fields: ["status"],
        time_bucket_fields: {},
        kept_out_fields: ["secret_note"],
        relationships: [],
        minimum_cohort_size: 5,
        suppression_aware_totals: true,
      }],
    },
    budgets: structuredClone(DEFAULT_REVIEWED_EXPLORATION_BUDGETS),
    unresolved_decisions: [],
  };
}
