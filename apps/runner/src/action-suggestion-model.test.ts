import { describe, expect, it, vi } from "vitest";
import {
  generateModelActionSuggestion,
  generateModelActionSuggestionSet,
} from "./action-suggestion-model.js";
import { createModelAuthoringConversation } from "./model-authoring-conversation.js";
import type { AskProviderDependencies } from "./model-ask.js";
import type { GuidedActionOptions } from "./guided-action.js";

describe("model-assisted Safe Action suggestions", () => {
  it("tells Action narration that the separately validated Read draft remains intact", async () => {
    const requests: Array<Parameters<NonNullable<AskProviderDependencies["requestJson"]>>[0]> = [];
    const requestJson = vi.fn(async (request: Parameters<NonNullable<AskProviderDependencies["requestJson"]>>[0]) => {
      requests.push(request);
      if (requests.length === 1) {
        return {
          status: 200,
          body: {
            output: [{
              type: "function_call",
              call_id: "call_action_set_with_read_context",
              name: "runner__suggest_safe_actions",
              arguments: JSON.stringify({
                suggestions: [{
                  intent: "Propose creating one order.",
                  operation: "insert",
                  resource: "public.orders",
                  fields: ["status"],
                }],
              }),
            }],
          },
        };
      }
      return {
        status: 200,
        body: {
          output: [{
            type: "message",
            role: "assistant",
            content: [{
              type: "output_text",
              text: "The Action draft is ready, and the separate Read draft remains unchanged.",
            }],
          }],
        },
      };
    });

    const result = await generateModelActionSuggestionSet({
      jobIntent: "Review orders and propose creating replacements.",
      provider: "openai",
      model: "gpt-5.6-luna",
      options: actionOptions(),
      env: { OPENAI_API_KEY: "provider-test-key" },
      egressAcknowledged: true,
      dependencies: { requestJson },
      conversation: createModelAuthoringConversation(),
    });

    expect(result.model_message).toBe(
      "The Action draft is ready, and the separate Read draft remains unchanged.",
    );
    expect(requestJson).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(requests[1]?.body)).toContain(
      "The separately validated Read draft remains unchanged",
    );
    expect(JSON.stringify(requests[1]?.body)).toContain(
      "previously validated work disappeared",
    );
  });

  it("defers Action narration to the retained outer authoring session", async () => {
    const requestJson = vi.fn(async () => ({
      status: 200,
      body: {
        output: [{
          type: "function_call",
          call_id: "call_action_set_deferred",
          name: "runner__suggest_safe_actions",
          arguments: JSON.stringify({
            suggestions: [{
              intent: "Propose creating one order.",
              operation: "insert",
              resource: "public.orders",
              fields: ["status"],
            }],
          }),
        }],
      },
    }));

    const result = await generateModelActionSuggestionSet({
      jobIntent: "Review orders and propose creating replacements.",
      provider: "openai",
      model: "gpt-5.6-luna",
      options: actionOptions(),
      env: { OPENAI_API_KEY: "provider-test-key" },
      egressAcknowledged: true,
      dependencies: { requestJson },
      conversation: createModelAuthoringConversation(),
      deferNarration: true,
    });

    expect(result.model_message).toBeUndefined();
    expect(result.assessments).toHaveLength(1);
    expect(requestJson).toHaveBeenCalledOnce();
  });

  it("gives a local model one bounded correction when an action set is returned as prose", async () => {
    let attempt = 0;
    const requests: string[] = [];
    const requestJson = vi.fn(async (request: Parameters<NonNullable<AskProviderDependencies["requestJson"]>>[0]) => {
      requests.push(JSON.stringify(request.body));
      attempt += 1;
      if (attempt === 1) {
        return {
          status: 200,
          body: {
            choices: [{ message: { role: "assistant", content: "I recommend updating the order." } }],
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
                id: "call_local_action_set",
                type: "function",
                function: {
                  name: "runner__suggest_safe_actions",
                  arguments: JSON.stringify({
                    suggestions: [{
                      intent: "Propose closing one order.",
                      operation: "update",
                      resource: "public.orders",
                      fields: ["status"],
                    }],
                  }),
                },
              }],
            },
          }],
        },
      };
    });

    const result = await generateModelActionSuggestionSet({
      jobIntent: "Close one existing order.",
      provider: "openai_compatible",
      model: "qwen-local",
      baseUrl: "http://127.0.0.1:11434/v1",
      options: actionOptions(),
      egressAcknowledged: true,
      dependencies: { requestJson },
    });

    expect(result.assessments).toHaveLength(1);
    expect(result.assessments[0]?.status).toBe("suggested");
    expect(requestJson).toHaveBeenCalledTimes(2);
    expect(requests[1]).toContain("previous response was discarded");
    expect(requests[1]).toContain("Call runner.suggest_safe_actions exactly once now");
  });

  it.each(["openai", "anthropic"] as const)(
    "decomposes a compound job into distinct bounded suggestions with %s",
    async (provider) => {
      const requestJson = vi.fn(async (
        _request: Parameters<NonNullable<AskProviderDependencies["requestJson"]>>[0],
      ) => provider === "openai"
        ? {
            status: 200,
            body: {
              output: [{
                type: "function_call",
                call_id: "call_action_set",
                name: "runner__suggest_safe_actions",
                arguments: JSON.stringify({
                  suggestions: [
                    {
                      intent: "Propose closing one order.",
                      operation: "update",
                      resource: "public.orders",
                      fields: ["status"],
                    },
                    {
                      intent: "Propose creating one order.",
                      operation: "insert",
                      resource: "public.orders",
                      fields: ["status"],
                    },
                  ],
                }),
              }],
            },
          }
        : {
            status: 200,
            body: {
              content: [{
                type: "tool_use",
                id: "toolu_action_set",
                name: "runner__suggest_safe_actions",
                input: {
                  suggestions: [
                    {
                      intent: "Propose closing one order.",
                      operation: "update",
                      resource: "public.orders",
                      fields: ["status"],
                    },
                    {
                      intent: "Propose creating one order.",
                      operation: "insert",
                      resource: "public.orders",
                      fields: ["status"],
                    },
                  ],
                },
              }],
            },
          });

      const result = await generateModelActionSuggestionSet({
        jobIntent: "Close existing orders and create replacement orders.",
        provider,
        model: provider === "openai" ? "gpt-5.6-luna" : "claude-test",
        options: actionOptions(),
        env: { TEST_PROVIDER_KEY: "provider-test-key" },
        apiKeyEnv: "TEST_PROVIDER_KEY",
        egressAcknowledged: true,
        dependencies: { requestJson },
      });

      expect(result.assessments).toHaveLength(2);
      expect(result.assessments.map((assessment) => [
        assessment.status,
        assessment.suggestion.operation,
      ])).toEqual([
        ["suggested", "update"],
        ["suggested", "insert"],
      ]);
      expect(result).toMatchObject({ authority_granted: false, source_database_changed: false });
      expect(requestJson).toHaveBeenCalledTimes(1);
      const request = requestJson.mock.calls[0]![0] as { body: Record<string, unknown> };
      const tool = (request.body.tools as Array<Record<string, unknown>>)[0]!;
      const schema = (provider === "openai" ? tool.parameters : tool.input_schema) as Record<string, unknown>;
      expect(schema).toMatchObject({
        type: "object",
        additionalProperties: false,
        required: ["suggestions"],
      });
      expect(JSON.stringify(request.body)).not.toContain("provider-test-key");
      expect(JSON.stringify(request.body)).not.toContain("tenant_id");
      expect(JSON.stringify(request.body)).toContain("enum_source");
      expect(JSON.stringify(request.body)).toContain("schema_declared_enum_or_check");
      expect(JSON.stringify(request.body)).toContain("open");
      expect(JSON.stringify(request.body)).toContain("closed");
    },
  );

  it("uses one bounded correction when a compound suggestion repeats an effect", async () => {
    let call = 0;
    const requestJson = vi.fn(async () => {
      call += 1;
      const secondOperation = call === 1 ? "update" : "insert";
      return {
        status: 200,
        body: {
          output: [{
            type: "function_call",
            call_id: `call_action_set_${call}`,
            name: "runner__suggest_safe_actions",
            arguments: JSON.stringify({
              suggestions: [
                {
                  intent: "Propose closing one order.",
                  operation: "update",
                  resource: "public.orders",
                  fields: ["status"],
                },
                {
                  intent: "Propose one other order change.",
                  operation: secondOperation,
                  resource: "public.orders",
                  fields: ["status"],
                },
              ],
            }),
          }],
        },
      };
    });

    const result = await generateModelActionSuggestionSet({
      jobIntent: "Close existing orders and create replacement orders.",
      provider: "openai",
      model: "gpt-5.6-luna",
      options: actionOptions(),
      env: { TEST_PROVIDER_KEY: "provider-test-key" },
      apiKeyEnv: "TEST_PROVIDER_KEY",
      egressAcknowledged: true,
      dependencies: { requestJson },
    });

    expect(requestJson).toHaveBeenCalledTimes(2);
    expect(result.assessments.map((assessment) => assessment.suggestion.operation)).toEqual(["update", "insert"]);
  });

  it("keeps a valid action candidate but discards an incomplete optional approval policy", async () => {
    const requestJson = vi.fn(async () => ({
      status: 200,
      body: {
        output: [{
          type: "function_call",
          call_id: "call_action_set_incomplete_policy",
          name: "runner__suggest_safe_actions",
          arguments: JSON.stringify({
            suggestions: [{
              intent: "Propose closing one order.",
              operation: "update",
              resource: "public.orders",
              fields: ["status"],
              approval_policy_proposal: {
                mode: "deterministic",
                conditions: [{ source: "before", field: "status", operator: "in", values: ["open"] }],
                max_per_day: 10,
              },
            }],
          }),
        }],
      },
    }));

    const result = await generateModelActionSuggestionSet({
      jobIntent: "Close an existing order.",
      provider: "openai",
      model: "gpt-5.6-luna",
      options: actionOptions(),
      env: { OPENAI_API_KEY: "provider-test-key" },
      egressAcknowledged: true,
      dependencies: { requestJson },
    });

    expect(requestJson).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      discarded_approval_policy_proposals: 1,
      assessments: [{
        status: "suggested",
        suggestion: {
          operation: "update",
          resource: "public.orders",
          fields: ["status"],
        },
      }],
      authority_granted: false,
      source_database_changed: false,
    });
    expect(result.assessments[0]?.suggestion).not.toHaveProperty("approval_policy_proposal");
  });

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
                  approval_policy_proposal: {
                    mode: "deterministic",
                    conditions: [{ field: "status", operator: "in", values: ["closed"] }],
                    max_per_day: 20,
                    shared_limits: [{
                      kind: "count",
                      scope: "tenant_principal",
                      maximum: 10,
                      window_seconds: 86400,
                    }],
                    rationale: "Keep unattended closure proposals narrow and bounded.",
                  },
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
                approval_policy_proposal: {
                  mode: "deterministic",
                  conditions: [{ field: "status", operator: "in", values: ["closed"] }],
                  max_per_day: 20,
                  shared_limits: [{
                    kind: "count",
                    scope: "tenant_principal",
                    maximum: 10,
                    window_seconds: 86400,
                  }],
                  rationale: "Keep unattended closure proposals narrow and bounded.",
                },
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
            approval_policy_proposal: {
              mode: "deterministic",
              max_per_day: 20,
              conditions: [{ field: "status", operator: "in", values: ["closed"] }],
              shared_limits: [{ scope: "tenant_principal", maximum: 10 }],
            },
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
      expect(properties.sort()).toEqual([
        "approval_policy_proposal",
        "fields",
        "intent",
        "operation",
        "rationale",
        "resource",
      ]);
      expect(properties).not.toEqual(expect.arrayContaining(["approval", "executor", "tenant_id", "writeback"]));
      const policySchema = (schema.properties as Record<string, Record<string, unknown>>).approval_policy_proposal;
      expect(policySchema).toMatchObject({ type: "object", additionalProperties: false });
      expect(JSON.stringify(policySchema)).not.toContain("tenant_id");
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

  it("reuses an in-memory Ask credential without putting it in provider content", async () => {
    const secret = "memory-only-action-suggestion-key";
    const requestJson = vi.fn(async (request: Parameters<NonNullable<AskProviderDependencies["requestJson"]>>[0]) => {
      expect(request.headers.authorization).toBe(`Bearer ${secret}`);
      expect(JSON.stringify(request.body)).not.toContain(secret);
      return {
        status: 200,
        body: {
          output: [{
            type: "function_call",
            call_id: "call_memory_action_suggestion",
            name: "runner__suggest_safe_action",
            arguments: JSON.stringify({
              intent: "Allow support to propose closing one exact order.",
              operation: "update",
              resource: "public.orders",
              fields: ["status"],
            }),
          }],
        },
      };
    });
    await expect(generateModelActionSuggestion({
      intent: "Let support propose closing one exact order.",
      provider: "openai",
      model: "gpt-5.6-luna",
      options: actionOptions(),
      env: {},
      apiKey: secret,
      egressAcknowledged: true,
      dependencies: { requestJson },
    })).resolves.toMatchObject({ authority_granted: false, source_database_changed: false });
    expect(requestJson).toHaveBeenCalledOnce();
  });

  it("gives one bounded correction when the first target substitution is refused", async () => {
    let attempt = 0;
    const requestJson = vi.fn(async () => {
      attempt += 1;
      return {
        status: 200,
        body: {
          output: [{
            type: "function_call",
            call_id: `call_action_correction_${attempt}`,
            name: "runner__suggest_safe_action",
            arguments: JSON.stringify({
              intent: "Allow support to propose closing one exact order.",
              operation: "update",
              resource: attempt === 1 ? "public.customers" : "public.orders",
              fields: ["status"],
            }),
          }],
        },
      };
    });

    const result = await generateModelActionSuggestion({
      intent: "Let support propose closing one exact order.",
      provider: "openai",
      model: "gpt-5.6-luna",
      options: actionOptions(),
      env: { OPENAI_API_KEY: "provider-test-key" },
      egressAcknowledged: true,
      dependencies: { requestJson },
    });

    expect(requestJson).toHaveBeenCalledTimes(2);
    expect(result.assessment).toMatchObject({
      status: "suggested",
      suggestion: { resource: "public.orders", fields: ["status"] },
      authority_granted: false,
      source_database_changed: false,
    });
  });

  it("fails closed after one bounded retry when a provider ignores the required structured suggestion tool", async () => {
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
    expect(requestJson).toHaveBeenCalledTimes(2);
  });
});

function actionOptions(): GuidedActionOptions {
  return {
    boundary_name: "reviewed_staging",
    boundary_state: "active",
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
    blocked_resources: [],
    safe_defaults: {},
  };
}
