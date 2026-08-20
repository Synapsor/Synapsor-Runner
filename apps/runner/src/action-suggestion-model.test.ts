import { describe, expect, it, vi } from "vitest";
import { generateModelActionSuggestion } from "./action-suggestion-model.js";
import type { AskProviderDependencies } from "./model-ask.js";
import type { GuidedActionOptions } from "./guided-action.js";

describe("model-assisted Safe Action suggestions", () => {
  it.each(["openai", "anthropic"] as const)(
    "uses one ephemeral structured suggestion tool with %s and grants no authority",
    async (provider) => {
      const requests: Array<Parameters<NonNullable<AskProviderDependencies["requestJson"]>>[0]> = [];
      const requestJson = vi.fn(async (request: Parameters<NonNullable<AskProviderDependencies["requestJson"]>>[0]) => {
        requests.push(request);
        if (provider === "openai") {
          return {
            status: 200,
            body: {
              output: [{
                type: "function_call",
                call_id: "call_action_suggestion",
                name: "runner__suggest_safe_action",
                arguments: JSON.stringify({
                  intent: "Allow support to propose closing one exact order.",
                  operation: "update",
                  resource: "public.orders",
                  fields: ["status"],
                  rationale: "The target and field are structural candidates.",
                }),
              }],
            },
          };
        }
        return {
          status: 200,
          body: {
            content: [{
              type: "tool_use",
              id: "toolu_action_suggestion",
              name: "runner__suggest_safe_action",
              input: {
                intent: "Allow support to propose closing one exact order.",
                operation: "update",
                resource: "public.orders",
                fields: ["status"],
                rationale: "The target and field are structural candidates.",
              },
            }],
          },
        };
      });

      const result = await generateModelActionSuggestion({
        intent: "Let support propose closing one exact order.",
        provider,
        model: provider === "openai" ? "gpt-5.6-luna" : "claude-test",
        options: actionOptions(),
        env: { TEST_PROVIDER_KEY: "provider-test-key" },
        apiKeyEnv: "TEST_PROVIDER_KEY",
        egressAcknowledged: true,
        dependencies: { requestJson },
      });

      expect(result).toMatchObject({
        provider,
        authority_granted: false,
        source_database_changed: false,
        assessment: {
          status: "suggested",
          authority_granted: false,
          suggestion: {
            operation: "update",
            resource: "public.orders",
            fields: ["status"],
            suggested_by: { kind: "model", provider },
          },
        },
      });
      expect(requestJson).toHaveBeenCalledTimes(1);
      const firstRequest = JSON.stringify(requests[0]?.body);
      expect(firstRequest).toContain("public.orders");
      expect(firstRequest).toContain("status");
      expect(firstRequest).toContain("Customer orders");
      expect(firstRequest).toContain("Order status");
      expect(firstRequest).not.toContain("tenant_id");
      expect(firstRequest).not.toContain("provider-test-key");
      expect(firstRequest).not.toContain("Answer application-data questions only");
      const firstBody = requests[0]!.body as Record<string, unknown>;
      expect(firstBody.tool_choice).toEqual(provider === "openai"
        ? { type: "function", name: "runner__suggest_safe_action" }
        : { type: "tool", name: "runner__suggest_safe_action" });
      const tool = (firstBody.tools as Array<Record<string, unknown>>)[0]!;
      const schema = (provider === "openai" ? tool.parameters : tool.input_schema) as Record<string, unknown>;
      const properties = Object.keys(schema.properties as Record<string, unknown>);
      expect(properties.sort()).toEqual(["fields", "intent", "operation", "rationale", "resource"]);
      expect(properties).not.toEqual(expect.arrayContaining(["approval", "executor", "tenant_id", "writeback"]));
    },
  );

  it("requires explicit structural-metadata egress acknowledgement before any provider request", async () => {
    const requestJson = vi.fn();
    await expect(generateModelActionSuggestion({
      intent: "Propose closing an order.",
      provider: "openai",
      model: "gpt-5.6-luna",
      options: actionOptions(),
      env: { OPENAI_API_KEY: "provider-test-key" },
      egressAcknowledged: false,
      dependencies: { requestJson },
    })).rejects.toThrow(/Acknowledge that reviewed visible data/);
    expect(requestJson).not.toHaveBeenCalled();
  });

  it("fails closed when a provider ignores the required structured suggestion tool", async () => {
    const requestJson = vi.fn(async () => ({
      status: 200,
      body: {
        output: [{
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "" }],
        }],
      },
    }));
    await expect(generateModelActionSuggestion({
      intent: "Propose closing an order.",
      provider: "openai",
      model: "gpt-5.6-luna",
      options: actionOptions(),
      env: { OPENAI_API_KEY: "provider-test-key" },
      egressAcknowledged: true,
      dependencies: { requestJson },
    })).rejects.toMatchObject({ code: "ASK_REQUIRED_TOOL_NOT_CALLED" });
    expect(requestJson).toHaveBeenCalledTimes(1);
  });
});

function actionOptions(): GuidedActionOptions {
  return {
    boundary_digest: `sha256:${"a".repeat(64)}`,
    source: "local_postgres",
    deployment_profile: "staging",
    resources: [{
      id: "public.orders",
      schema: "public",
      table: "orders",
      label: "Customer orders",
      description: "One reviewed order per customer purchase.",
      primary_key: "id",
      tenant_key: "tenant_id",
      principal_key: "rep_id",
      writable_fields: [{ name: "status", data_type: "text", enum_values: ["open", "closed"], nullable: false, required_for_insert: true }],
      structurally_eligible_fields: [{
        name: "status",
        data_type: "text",
        enum_values: ["open", "closed"],
        nullable: false,
        required_for_insert: true,
        label: "Order status",
        description: "Reviewed lifecycle state for the order.",
      }],
      conflict_candidates: ["version"],
      insert_dedup_candidates: ["request_id"],
      kept_out_fields: ["tenant_id", "rep_id"],
      operation_availability: {
        update: { available: true, reason: "Available with an exact conflict guard." },
        insert: { available: true, reason: "Available with deduplication." },
        delete: { available: false, reason: "Delete is blocked by a cascading reference." },
      },
    }],
    safe_defaults: {},
  };
}
