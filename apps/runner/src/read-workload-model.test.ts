import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_REVIEWED_EXPLORATION_BUDGETS,
  type ExplorationBoundaryDraft,
} from "./auto-boundary.js";
import type { AskProviderDependencies } from "./model-ask.js";
import {
  createModelAuthoringConversation,
  rememberModelAuthoringTurn,
} from "./model-authoring-conversation.js";
import { generateModelReadWorkload, readWorkloadCatalog } from "./read-workload-model.js";

describe("model-assisted Read workload mapping", () => {
  it("carries prior authoring history into mapping and returns actual validated model prose", async () => {
    const conversation = createModelAuthoringConversation();
    rememberModelAuthoringTurn(
      conversation,
      "Help customers understand their support history.",
      "I will map that job to reviewed structure.",
    );
    const requests: Array<Parameters<NonNullable<AskProviderDependencies["requestJson"]>>[0]> = [];
    const requestJson = vi.fn(async (request: Parameters<NonNullable<AskProviderDependencies["requestJson"]>>[0]) => {
      requests.push(request);
      if (requests.length === 1) {
        return {
          status: 200,
          body: {
            output: [{
              type: "function_call",
              call_id: "call_read_history",
              name: "runner__submit_read_workloads",
              arguments: JSON.stringify({
                allowed: [{
                  id: "orders_by_status",
                  description: "Count orders by status",
                  plan: {
                    kind: "aggregate",
                    resource: "public.orders",
                    measures: [{ function: "count" }],
                    dimensions: [{ field: "status" }],
                  },
                }],
                forbidden: [],
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
            content: [{ type: "output_text", text: "I mapped one reviewed status summary. It is not active yet." }],
          }],
        },
      };
    });

    const result = await generateModelReadWorkload({
      name: "support_reads",
      allowedQuestions: ["How many orders are in each status?"],
      provider: "openai",
      model: "gpt-5.6-luna",
      generatedBoundary: generatedBoundary(),
      env: { TEST_PROVIDER_KEY: "provider-test-key" },
      apiKeyEnv: "TEST_PROVIDER_KEY",
      egressAcknowledged: true,
      dependencies: { requestJson },
      conversation,
    });

    expect(requestJson).toHaveBeenCalledTimes(2);
    expect(result.model_message).toBe("I mapped one reviewed status summary. It is not active yet.");
    expect(JSON.stringify(requests[0]?.body)).toContain("Help customers understand their support history.");
    expect(JSON.stringify(requests[1]?.body)).toContain("Count orders by status");
    expect(JSON.stringify(requests[1]?.body)).not.toContain("provider-test-key");
  });

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
      expect(body).toContain("schema_declared_values");
      expect(body).toContain("schema_declared_enum_or_check");
      expect(body).toContain("open");
      expect(body).toContain("closed");
      expect(body).not.toContain("sampled-status-from-row");
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

  it("blocks obvious secret material in operator-authored questions before provider egress", async () => {
    const requestJson = vi.fn();
    await expect(generateModelReadWorkload({
      name: "secret_question_refused",
      allowedQuestions: ["Use API key = sk-do-not-send-this-value"],
      provider: "openai",
      model: "gpt-5.6-luna",
      generatedBoundary: generatedBoundary(),
      env: { OPENAI_API_KEY: "provider-test-key" },
      egressAcknowledged: true,
      dependencies: { requestJson },
    })).rejects.toThrow(/READ_WORKLOAD_SECRET_BLOCKED/);
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

  it("asks one operator clarification for opaque reviewed metadata instead of guessing", async () => {
    let attempt = 0;
    const requests: string[] = [];
    const requestJson = vi.fn(async (request: Parameters<NonNullable<AskProviderDependencies["requestJson"]>>[0]) => {
      requests.push(JSON.stringify(request.body));
      attempt += 1;
      const input = attempt === 1
        ? {
            clarification_request: {
              resource: "public.orders",
              field: "status",
              reason: "The field name does not explain its business meaning.",
              question: "What does this reviewed status field represent?",
            },
          }
        : {
            allowed: [{
              id: "orders_by_status",
              description: "Count orders by lifecycle status",
              plan: {
                kind: "aggregate",
                resource: "public.orders",
                measures: [{ function: "count" }],
                dimensions: [{ field: "status" }],
              },
            }],
            forbidden: [],
          };
      return {
        status: 200,
        body: {
          output: [{
            type: "function_call",
            call_id: `call_read_clarification_${attempt}`,
            name: "runner__submit_read_workloads",
            arguments: JSON.stringify(input),
          }],
        },
      };
    });
    const clarificationHandler = vi.fn(async () => ({
      state: "answered" as const,
      answer: "It is the order lifecycle status used for operational grouping.",
    }));

    const result = await generateModelReadWorkload({
      name: "opaque_reads",
      allowedQuestions: ["Count orders by lifecycle status"],
      provider: "openai",
      model: "gpt-5.6-luna",
      generatedBoundary: generatedBoundary(),
      env: { OPENAI_API_KEY: "provider-test-key" },
      egressAcknowledged: true,
      clarificationHandler,
      dependencies: { requestJson },
    });

    expect(clarificationHandler).toHaveBeenCalledWith({
      resource: "public.orders",
      field: "status",
      reason: "The field name does not explain its business meaning.",
      question: "What does this reviewed status field represent?",
    });
    expect(requestJson).toHaveBeenCalledTimes(2);
    expect(requests[1]).toContain("order lifecycle status used for operational grouping");
    expect(result.analysis.status).toBe("ready");
    expect(result).toMatchObject({
      authority_granted: false,
      source_query_executed: false,
      explore_budget_consumed: false,
      source_database_changed: false,
    });
  });

  it("intercepts a guessed opaque plan and requires a resource clarification before accepting it", async () => {
    let attempt = 0;
    const requests: string[] = [];
    const requestJson = vi.fn(async (request: Parameters<NonNullable<AskProviderDependencies["requestJson"]>>[0]) => {
      requests.push(JSON.stringify(request.body));
      attempt += 1;
      const input = attempt === 1
        ? {
            allowed: [{
              id: "guessed_opaque_status",
              description: "Count records by guessed status",
              plan: {
                kind: "aggregate",
                resource: "public.tbl_7",
                measures: [{ function: "count" }],
                dimensions: [{ field: "col_2" }],
              },
            }],
            forbidden: [],
          }
        : {
              allowed: [{
                id: "tickets_by_status",
                description: "Count support tickets by lifecycle status",
                plan: {
                  kind: "aggregate",
                  resource: "public.tbl_7",
                  measures: [{ function: "count" }],
                  dimensions: [{ field: "col_2" }],
                },
              }],
              forbidden: [],
            };
      return {
        status: 200,
        body: {
          output: [{
            type: "function_call",
            call_id: `call_opaque_guard_${attempt}`,
            name: "runner__submit_read_workloads",
            arguments: JSON.stringify(input),
          }],
        },
      };
    });
    const clarificationHandler = vi.fn(async () => ({
      state: "answered" as const,
      answer: "tbl_7 contains support tickets; col_1 is the ticket id and col_2 is lifecycle status.",
    }));

    const result = await generateModelReadWorkload({
      name: "opaque_support_reads",
      allowedQuestions: ["Count support tickets by lifecycle status"],
      provider: "openai",
      model: "gpt-5.6-luna",
      generatedBoundary: opaqueGeneratedBoundary(),
      env: { OPENAI_API_KEY: "provider-test-key" },
      egressAcknowledged: true,
      clarificationHandler,
      dependencies: { requestJson },
    });

    expect(requestJson).toHaveBeenCalledTimes(2);
    expect(clarificationHandler).toHaveBeenCalledWith(expect.objectContaining({
      resource: "public.tbl_7",
      reason: expect.stringContaining("Runner intercepted"),
      question: expect.stringContaining("what do the referenced fields col_2 mean"),
    }));
    expect(requests[1]).toContain("tbl_7 contains support tickets");
    expect(result.analysis.status).toBe("ready");
    expect(result).toMatchObject({
      authority_granted: false,
      source_query_executed: false,
      explore_budget_consumed: false,
      source_database_changed: false,
    });
  });

  it("refuses a second clarification request after one bounded operator answer", async () => {
    const requestJson = vi.fn(async () => ({
      status: 200,
      body: {
        output: [{
          type: "function_call",
          call_id: "call_repeat_opaque_clarification",
          name: "runner__submit_read_workloads",
          arguments: JSON.stringify({
            clarification_request: {
              resource: "public.tbl_7",
              reason: "Need the same metadata again",
              question: "Explain public.tbl_7 again",
            },
          }),
        }],
      },
    }));
    const clarificationHandler = vi.fn(async () => ({
      state: "answered" as const,
      answer: "tbl_7 contains support tickets and col_2 is lifecycle status.",
    }));

    await expect(generateModelReadWorkload({
      name: "opaque_guess_refused",
      allowedQuestions: ["Count support tickets by lifecycle status"],
      provider: "openai",
      model: "gpt-5.6-luna",
      generatedBoundary: opaqueGeneratedBoundary(),
      env: { OPENAI_API_KEY: "provider-test-key" },
      egressAcknowledged: true,
      clarificationHandler,
      dependencies: { requestJson },
    })).rejects.toThrow(/READ_WORKLOAD_ASSISTANCE_REQUEST_REPEATED/);
    expect(requestJson).toHaveBeenCalledTimes(2);
    expect(clarificationHandler).toHaveBeenCalledOnce();
  });

  it("allows one naming clarification followed by one separately approved value request", async () => {
    let attempt = 0;
    const requests: string[] = [];
    const requestJson = vi.fn(async (request: Parameters<NonNullable<AskProviderDependencies["requestJson"]>>[0]) => {
      requests.push(JSON.stringify(request.body));
      attempt += 1;
      const input = attempt === 1
        ? {
            clarification_request: {
              resource: "public.orders",
              field: "status",
              reason: "Need the business meaning before choosing a status code.",
              question: "What business state does status represent?",
            },
          }
        : attempt === 2
          ? {
              value_request: {
                resource: "public.orders",
                field: "status",
                reason: "The active code is not schema-declared.",
                question: "Which exact status code means active?",
              },
            }
          : {
              allowed: [{
                id: "active_orders",
                description: "List active orders",
                plan: {
                  kind: "rows",
                  resource: "public.orders",
                  select: ["id", "status"],
                  where: [{ field: "status", op: "eq", value: "OPN" }],
                },
              }],
              forbidden: [],
            };
      return {
        status: 200,
        body: {
          output: [{
            type: "function_call",
            call_id: `call_read_two_step_help_${attempt}`,
            name: "runner__submit_read_workloads",
            arguments: JSON.stringify(input),
          }],
        },
      };
    });
    const clarificationHandler = vi.fn(async () => ({
      state: "answered" as const,
      answer: "status is the order lifecycle state; active is one database-specific code.",
    }));
    const valueRequestHandler = vi.fn(async () => ({
      state: "provided" as const,
      resource: "public.orders",
      field: "status",
      values: ["OPN"],
      egressAcknowledged: true as const,
    }));

    const result = await generateModelReadWorkload({
      name: "two_step_read_help",
      allowedQuestions: ["List active orders"],
      provider: "openai",
      model: "gpt-5.6-luna",
      generatedBoundary: generatedBoundaryWithoutStatusEnum(),
      env: { OPENAI_API_KEY: "provider-test-key" },
      egressAcknowledged: true,
      clarificationHandler,
      valueRequestHandler,
      dependencies: { requestJson },
    });

    expect(requestJson).toHaveBeenCalledTimes(3);
    expect(clarificationHandler).toHaveBeenCalledOnce();
    expect(valueRequestHandler).toHaveBeenCalledOnce();
    expect(requests[1]).toContain("one value_request now");
    expect(requests[2]).toContain("separately approved these exact values");
    expect(result.analysis.status).toBe("ready");
    expect(result.source_query_executed).toBe(false);
    expect(result.source_database_changed).toBe(false);
  });

  it("preserves approved values when one naming clarification follows the value request", async () => {
    let attempt = 0;
    const requests: string[] = [];
    const requestJson = vi.fn(async (request: Parameters<NonNullable<AskProviderDependencies["requestJson"]>>[0]) => {
      requests.push(JSON.stringify(request.body));
      attempt += 1;
      const input = attempt === 1
        ? {
            value_request: {
              resource: "public.orders",
              field: "status",
              reason: "The active code is not schema-declared.",
              question: "Which exact status code means active?",
            },
          }
        : attempt === 2
          ? {
              clarification_request: {
                resource: "public.orders",
                field: "status",
                reason: "Need the field's business meaning before using the approved code.",
                question: "What business state does status represent?",
              },
            }
          : {
              allowed: [{
                id: "active_orders",
                description: "List active orders",
                plan: {
                  kind: "rows",
                  resource: "public.orders",
                  select: ["id", "status"],
                  where: [{ field: "status", op: "eq", value: "OPN" }],
                },
              }],
              forbidden: [],
            };
      return {
        status: 200,
        body: {
          output: [{
            type: "function_call",
            call_id: `call_read_value_then_name_${attempt}`,
            name: "runner__submit_read_workloads",
            arguments: JSON.stringify(input),
          }],
        },
      };
    });

    const result = await generateModelReadWorkload({
      name: "value_then_name_help",
      allowedQuestions: ["List active orders"],
      provider: "openai",
      model: "gpt-5.6-luna",
      generatedBoundary: generatedBoundaryWithoutStatusEnum(),
      env: { OPENAI_API_KEY: "provider-test-key" },
      egressAcknowledged: true,
      valueRequestHandler: async () => ({
        state: "provided",
        resource: "public.orders",
        field: "status",
        values: ["OPN"],
        egressAcknowledged: true,
      }),
      clarificationHandler: async () => ({
        state: "answered",
        answer: "status is the order lifecycle state.",
      }),
      dependencies: { requestJson },
    });

    expect(requestJson).toHaveBeenCalledTimes(3);
    expect(requests[2]).toContain("approved these exact values");
    expect(requests[2]).toContain("OPN");
    expect(requests[2]).toContain("plan.where");
    expect(result.analysis.status).toBe("ready");
    expect(result.source_query_executed).toBe(false);
  });

  it("sends only separately approved exact values after a model value request", async () => {
    let attempt = 0;
    const requests: string[] = [];
    const requestJson = vi.fn(async (request: Parameters<NonNullable<AskProviderDependencies["requestJson"]>>[0]) => {
      requests.push(JSON.stringify(request.body));
      attempt += 1;
      const input = attempt === 1
        ? {
            value_request: {
              resource: "public.orders",
              field: "status",
              reason: "The question refers to a business status whose exact stored code is not declared by the schema.",
              question: "Which exact reviewed status values represent active work?",
            },
          }
        : {
            allowed: [{
              id: "active_orders",
              description: "List orders in active status",
              plan: {
                kind: "rows",
                resource: "public.orders",
                select: ["id", "status"],
                where: [{ field: "status", op: "in", value: ["open"] }],
              },
            }],
            forbidden: [],
          };
      return {
        status: 200,
        body: {
          output: [{
            type: "function_call",
            call_id: `call_read_values_${attempt}`,
            name: "runner__submit_read_workloads",
            arguments: JSON.stringify(input),
          }],
        },
      };
    });
    const valueRequestHandler = vi.fn(async () => ({
      state: "provided" as const,
      resource: "public.orders",
      field: "status",
      values: ["open"],
      egressAcknowledged: true as const,
    }));

    const result = await generateModelReadWorkload({
      name: "value_assisted_reads",
      allowedQuestions: ["List active orders"],
      provider: "openai",
      model: "gpt-5.6-luna",
      generatedBoundary: generatedBoundary(),
      env: { OPENAI_API_KEY: "provider-test-key" },
      egressAcknowledged: true,
      valueRequestHandler,
      dependencies: { requestJson },
    });

    expect(valueRequestHandler).toHaveBeenCalledWith(expect.objectContaining({
      resource: "public.orders",
      field: "status",
    }));
    expect(requestJson).toHaveBeenCalledTimes(2);
    expect(requests[0]).not.toContain("separately approved these exact values");
    expect(requests[1]).toContain("separately approved these exact values");
    expect(requests[1]).toContain("open");
    expect(requests.join("\n")).not.toContain("provider-test-key");
    expect(result.analysis.status).toBe("ready");
    expect(result.source_query_executed).toBe(false);
    expect(result.source_database_changed).toBe(false);
  });

  it("corrects a non-grammar filters key without requesting approved values again", async () => {
    let attempt = 0;
    const requests: string[] = [];
    const requestJson = vi.fn(async (request: Parameters<NonNullable<AskProviderDependencies["requestJson"]>>[0]) => {
      requests.push(JSON.stringify(request.body));
      attempt += 1;
      const input = attempt === 1
        ? {
            value_request: {
              resource: "public.orders",
              field: "status",
              reason: "The active status code is not declared by the schema.",
              question: "Which exact status code means active?",
            },
          }
        : {
            allowed: [{
              id: "active_orders",
              description: "List active orders",
              plan: {
                kind: "rows",
                resource: "public.orders",
                select: ["id", "status"],
                ...(attempt === 2
                  ? { filters: [{ field: "status", op: "eq", value: "OPN" }] }
                  : { where: [{ field: "status", op: "eq", value: "OPN" }] }),
              },
            }],
            forbidden: [],
          };
      return {
        status: 200,
        body: {
          output: [{
            type: "function_call",
            call_id: `call_read_value_grammar_${attempt}`,
            name: "runner__submit_read_workloads",
            arguments: JSON.stringify(input),
          }],
        },
      };
    });

    const result = await generateModelReadWorkload({
      name: "correct_value_filter_grammar",
      allowedQuestions: ["List active orders"],
      provider: "openai",
      model: "gpt-5.6-luna",
      generatedBoundary: generatedBoundaryWithoutStatusEnum(),
      env: { OPENAI_API_KEY: "provider-test-key" },
      egressAcknowledged: true,
      valueRequestHandler: async () => ({
        state: "provided",
        resource: "public.orders",
        field: "status",
        values: ["OPN"],
        egressAcknowledged: true,
      }),
      dependencies: { requestJson },
    });

    expect(requestJson).toHaveBeenCalledTimes(3);
    expect(requests[2]).toContain("Do not request them again");
    expect(requests[2]).toContain("plan.where");
    expect(requests[2]).toContain("OPN");
    expect(result.analysis.status).toBe("ready");
    expect(result.source_query_executed).toBe(false);
  });

  it("refuses a value request for a field outside the exact model-visible catalog", async () => {
    const valueRequestHandler = vi.fn();
    const requestJson = vi.fn(async () => ({
      status: 200,
      body: {
        output: [{
          type: "function_call",
          call_id: "call_read_secret_values",
          name: "runner__submit_read_workloads",
          arguments: JSON.stringify({
            value_request: {
              resource: "public.orders",
              field: "secret_note",
              reason: "Need hidden values",
              question: "Send hidden notes",
            },
          }),
        }],
      },
    }));

    await expect(generateModelReadWorkload({
      name: "refused_values",
      allowedQuestions: ["Show hidden notes"],
      provider: "openai",
      model: "gpt-5.6-luna",
      generatedBoundary: generatedBoundary(),
      env: { OPENAI_API_KEY: "provider-test-key" },
      egressAcknowledged: true,
      valueRequestHandler,
      dependencies: { requestJson },
    })).rejects.toThrow(/READ_WORKLOAD_NOT_SUBMITTED/);
    expect(valueRequestHandler).not.toHaveBeenCalled();
    expect(requestJson).toHaveBeenCalledTimes(1);
  });

  it("requires an interactive decision before any requested Read value context can leave", async () => {
    const requestJson = vi.fn(async () => ({
      status: 200,
      body: {
        output: [{
          type: "function_call",
          call_id: "call_read_value_without_handler",
          name: "runner__submit_read_workloads",
          arguments: JSON.stringify({
            value_request: {
              resource: "public.orders",
              field: "status",
              reason: "Need exact codes",
              question: "Which status codes are active?",
            },
          }),
        }],
      },
    }));

    await expect(generateModelReadWorkload({
      name: "noninteractive_values",
      allowedQuestions: ["List active orders"],
      provider: "openai",
      model: "gpt-5.6-luna",
      generatedBoundary: generatedBoundary(),
      env: { OPENAI_API_KEY: "provider-test-key" },
      egressAcknowledged: true,
      dependencies: { requestJson },
    })).rejects.toThrow(/READ_WORKLOAD_VALUE_CONTEXT_REQUIRED.*No source query ran/);
    expect(requestJson).toHaveBeenCalledTimes(1);
  });

  it("publishes only model-visible structural catalog fields", () => {
    const catalog = readWorkloadCatalog(generatedBoundary());
    const serialized = JSON.stringify(catalog);
    expect(serialized).toContain("public.orders");
    expect(serialized).not.toContain("tenant_id");
    expect(serialized).not.toContain("principal_id");
    expect(serialized).not.toContain("secret_note");
    expect(serialized).toContain('"schema_declared_values":["open","closed"]');
    expect(serialized).toContain('"value_source":"schema_declared_enum_or_check"');
    expect(serialized).not.toContain("sampled-status-from-row");
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
        field_enums: { status: ["open", "closed"] },
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

function opaqueGeneratedBoundary(): ExplorationBoundaryDraft {
  const boundary = structuredClone(generatedBoundary());
  const resource = boundary.pack.resources[0]!;
  resource.id = "public.tbl_7";
  resource.schema = "public";
  resource.table = "tbl_7";
  delete resource.label;
  delete resource.description;
  resource.primary_key = "col_1";
  resource.tenant_key = "tenant_id";
  delete resource.principal_key;
  resource.field_types = {
    col_1: "uuid",
    col_2: "text",
    tenant_id: "text",
  };
  resource.field_enums = { col_2: ["A1", "B2"] };
  resource.selectable_fields = ["col_1", "col_2"];
  resource.filterable_fields = { col_2: ["eq", "neq", "in"] };
  resource.sortable_fields = [];
  resource.groupable_fields = ["col_2"];
  resource.aggregate_measures = [];
  resource.aggregate_measure_functions = {};
  resource.count_distinct_fields = ["col_2"];
  resource.time_bucket_fields = {};
  resource.kept_out_fields = [];
  resource.field_metadata = {};
  return boundary;
}

function generatedBoundaryWithoutStatusEnum(): ExplorationBoundaryDraft {
  const boundary = structuredClone(generatedBoundary());
  boundary.pack.resources[0]!.field_enums = {};
  return boundary;
}
