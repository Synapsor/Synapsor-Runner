import { describe, expect, it, vi } from "vitest";
import {
  actionBoundaryDecisionQuestion,
  interpretActionBoundaryDecision,
  interpretActionBoundaryPolicy,
} from "./action-boundary-interview.js";
import type { GuidedActionInput, GuidedActionResourceOption } from "./guided-action.js";
import type { AskProvider, AskProviderDependencies } from "./model-ask.js";

const followUps: GuidedActionResourceOption = {
  id: "support_ops.follow_up_tasks",
  schema: "support_ops",
  table: "follow_up_tasks",
  label: "Follow-up tasks",
  description: "Bounded customer-support follow-up work.",
  primary_key: "task_id",
  tenant_key: "tenant_id",
  principal_key: "principal_id",
  writable_fields: [
    { name: "priority", data_type: "support_priority", enum_values: ["routine", "elevated", "urgent"], nullable: false, required_for_insert: true },
    { name: "estimated_minutes", data_type: "integer", enum_values: [], nullable: false, required_for_insert: true },
  ],
  structurally_eligible_fields: [
    { name: "priority", data_type: "support_priority", enum_values: ["routine", "elevated", "urgent"], nullable: false, required_for_insert: true },
    { name: "estimated_minutes", label: "Estimated minutes", data_type: "integer", enum_values: [], nullable: false, required_for_insert: true },
  ],
  conflict_candidates: ["version"],
  insert_dedup_candidates: ["request_id"],
  kept_out_fields: ["tenant_id", "principal_id"],
  operation_availability: {
    insert: { available: true, reason: "request_id is unique." },
    update: { available: true, reason: "version detects stale proposals." },
    delete: { available: false, reason: "Delete is not reviewed." },
  },
};

const action: GuidedActionInput = {
  capability_name: "follow_up_task.propose_insert_follow_up_tasks",
  description: "Create bounded support follow-up tasks.",
  resource: followUps.id,
  operation: "insert",
  patches: [
    { column: "estimated_minutes", value_source: "argument", argument_name: "estimated_minutes", minimum: 5, maximum: 120 },
    { column: "priority", value_source: "argument", argument_name: "priority" },
  ],
  dedup_proposal_column: "request_id",
  approval_role: "action_reviewer",
  required_approvals: 1,
  authority_posture: "proposal_only",
  writeback: { mode: "none" },
  supervised_worker_execution: false,
  reversible: false,
  confirmed_trusted_scope: true,
};

describe("conversational Action Boundary interview", () => {
  it("explains exactly where a natural-language numeric decision is enforced", () => {
    expect(actionBoundaryDecisionQuestion({
      kind: "numeric_bounds",
      title: "Set duration",
      help: "Finite bounds are required.",
      field: "estimated_minutes",
    }, "INSERT support_ops.follow_up_tasks")).toEqual({
      label: "What is the smallest and largest estimated minutes the agent may propose?",
      context: expect.arrayContaining([
        "Action: INSERT support_ops.follow_up_tasks",
        "Reviewed proposal field: estimated_minutes",
        "Where used: every INSERT support_ops.follow_up_tasks proposal may supply estimated_minutes only inside the confirmed range.",
        "Outside this range: Runner refuses the proposal before approval. Auto-approval may use a narrower range later.",
        "Result: one disabled proposal bound for your exact confirmation; no activation or database write.",
      ]),
    });
  });

  it("does not describe a domain-neutral numeric field with an unrelated unit", () => {
    const question = actionBoundaryDecisionQuestion({
      kind: "numeric_bounds",
      title: "Set refund amount",
      help: "Finite bounds are required.",
      field: "amount",
    }, "INSERT support_ops.refund_requests");

    expect(question.context).toContain(
      "Answer in ordinary language. State both ends and include the business unit when it matters.",
    );
    expect(question.context.join("\n")).not.toContain("minutes");
  });

  it("blocks obvious secret material before an operator answer reaches a provider", async () => {
    const requestJson = vi.fn();
    await expect(interpretActionBoundaryDecision({
      session: { provider: "openai", model: "gpt-test", apiKey: "memory-key", dependencies: { requestJson } },
      decision: {
        kind: "numeric_bounds",
        title: "Set duration",
        help: "Finite bounds are required.",
        field: "estimated_minutes",
      },
      answer: "API key = sk-do-not-send-this-value",
      intent: "Create follow-up tasks.",
      egressAcknowledged: true,
    })).rejects.toThrow(/credential or secret material/);
    expect(requestJson).not.toHaveBeenCalled();
  });

  for (const provider of ["openai", "anthropic"] as AskProvider[]) {
    it(`interprets ordinary duration language through one bounded ${provider} tool call`, async () => {
      const requests: Array<Record<string, unknown>> = [];
      const requestJson = vi.fn(async (request: Parameters<NonNullable<AskProviderDependencies["requestJson"]>>[0]) => {
        requests.push(request.body);
        if (provider === "anthropic") {
          return {
            status: 200,
            body: {
              content: [{
                type: "tool_use",
                id: "toolu_action_range",
                name: "runner__interpret_action_boundary_answer",
                input: {
                  status: "resolved",
                  minimum: 5,
                  maximum: 120,
                  rationale: "Converted two hours to the reviewed minute unit.",
                },
              }],
            },
          };
        }
        return {
          status: 200,
          body: {
            output: [{
              type: "function_call",
              call_id: "call_action_range",
              name: "runner__interpret_action_boundary_answer",
              arguments: JSON.stringify({
                status: "resolved",
                minimum: 5,
                maximum: 120,
                rationale: "Converted two hours to the reviewed minute unit.",
              }),
            }],
          },
        };
      });

      const result = await interpretActionBoundaryDecision({
        session: {
          provider,
          model: provider === "openai" ? "gpt-5.6-luna" : "claude-test",
          apiKeyEnv: "TEST_PROVIDER_KEY",
          dependencies: { requestJson },
        },
        decision: {
          kind: "numeric_bounds",
          title: "Set the reviewed range for estimated minutes",
          help: "Numeric proposal arguments require finite bounds.",
          field: "estimated_minutes",
        },
        answer: "Between five minutes and two hours.",
        intent: "Create customer follow-up tasks.",
        target: "INSERT support_ops.follow_up_tasks",
        env: { TEST_PROVIDER_KEY: "secret-provider-key" },
        egressAcknowledged: true,
      });

      expect(result).toMatchObject({
        state: "resolved",
        decisions: { numeric_bounds: { estimated_minutes: { minimum: 5, maximum: 120 } } },
        summary: "estimated_minutes: 5 through 120",
        authority_granted: false,
        source_database_changed: false,
      });
      expect(requestJson).toHaveBeenCalledOnce();
      const serialized = JSON.stringify(requests[0]);
      expect(serialized).toContain("Between five minutes and two hours.");
      expect(serialized).toContain("estimated_minutes");
      expect(serialized).not.toContain("secret-provider-key");
      expect(serialized).not.toContain("tenant_id");
    });
  }

  it("asks one clarification instead of guessing an ambiguous range", async () => {
    const requestJson = vi.fn(async () => ({
      status: 200,
      body: {
        output: [{
          type: "function_call",
          call_id: "call_action_clarification",
          name: "runner__interpret_action_boundary_answer",
          arguments: JSON.stringify({
            status: "clarification",
            clarification_question: "What is the largest duration the agent may propose?",
          }),
        }],
      },
    }));
    await expect(interpretActionBoundaryDecision({
      session: { provider: "openai", model: "gpt-test", apiKey: "memory-key", dependencies: { requestJson } },
      decision: {
        kind: "numeric_bounds",
        title: "Set duration",
        help: "Finite bounds are required.",
        field: "estimated_minutes",
      },
      answer: "Keep it short.",
      intent: "Create follow-up tasks.",
      egressAcknowledged: true,
    })).resolves.toMatchObject({
      state: "clarification",
      question: "What is the largest duration the agent may propose?",
      authority_granted: false,
    });
  });

  it("returns an explicit value request without querying or receiving source values", async () => {
    const requestJson = vi.fn(async () => ({
      status: 200,
      body: {
        output: [{
          type: "function_call",
          call_id: "call_action_value_request",
          name: "runner__interpret_action_boundary_answer",
          arguments: JSON.stringify({
            status: "value_request",
            requested_field: "estimated_minutes",
            value_reason: "The phrase refers to an existing business duration class that is not schema-declared.",
            clarification_question: "Which exact duration values belong to that class?",
          }),
        }],
      },
    }));

    await expect(interpretActionBoundaryDecision({
      session: { provider: "openai", model: "gpt-test", apiKey: "memory-key", dependencies: { requestJson } },
      decision: {
        kind: "numeric_bounds",
        title: "Set duration",
        help: "Finite bounds are required.",
        field: "estimated_minutes",
      },
      answer: "Use the normal short-duration class.",
      intent: "Create follow-up tasks.",
      egressAcknowledged: true,
    })).resolves.toMatchObject({
      state: "value_request",
      field: "estimated_minutes",
      question: "Which exact duration values belong to that class?",
      authority_granted: false,
      source_database_changed: false,
    });
  });

  it("sends only separately approved values for the exact requested field", async () => {
    const requests: Array<Record<string, unknown>> = [];
    const requestJson = vi.fn(async (request: Parameters<NonNullable<AskProviderDependencies["requestJson"]>>[0]) => {
      requests.push(request.body);
      return {
        status: 200,
        body: {
          output: [{
            type: "function_call",
            call_id: "call_action_value_context",
            name: "runner__interpret_action_boundary_answer",
            arguments: JSON.stringify({ status: "resolved", minimum: 5, maximum: 120 }),
          }],
        },
      };
    });

    await expect(interpretActionBoundaryDecision({
      session: { provider: "openai", model: "gpt-test", apiKey: "memory-key", dependencies: { requestJson } },
      decision: {
        kind: "numeric_bounds",
        title: "Set duration",
        help: "Finite bounds are required.",
        field: "estimated_minutes",
      },
      answer: "Use our normal short-duration class.",
      intent: "Create follow-up tasks.",
      egressAcknowledged: true,
      operatorApprovedValues: {
        field: "estimated_minutes",
        values: ["5", "120"],
        egressAcknowledged: true,
      },
    })).resolves.toMatchObject({ state: "resolved" });

    const request = JSON.stringify(requests[0]);
    expect(request).toContain("Separately approved value context for estimated_minutes");
    expect(request).toContain("120");
    expect(request).not.toContain("memory-key");
  });

  it("rejects value context for any field outside the current decision before provider egress", async () => {
    const requestJson = vi.fn();
    await expect(interpretActionBoundaryDecision({
      session: { provider: "openai", model: "gpt-test", apiKey: "memory-key", dependencies: { requestJson } },
      decision: {
        kind: "numeric_bounds",
        title: "Set duration",
        help: "Finite bounds are required.",
        field: "estimated_minutes",
      },
      answer: "Use our normal short-duration class.",
      intent: "Create follow-up tasks.",
      egressAcknowledged: true,
      operatorApprovedValues: {
        field: "customer_email",
        values: ["private@example.test"],
        egressAcknowledged: true,
      },
    })).rejects.toThrow(/exact field in the current reviewed decision/);
    expect(requestJson).not.toHaveBeenCalled();
  });

  it("rejects obvious secret material in operator-approved value context before provider egress", async () => {
    const requestJson = vi.fn();
    await expect(interpretActionBoundaryDecision({
      session: { provider: "openai", model: "gpt-test", apiKey: "memory-key", dependencies: { requestJson } },
      decision: {
        kind: "numeric_bounds",
        title: "Set duration",
        help: "Finite bounds are required.",
        field: "estimated_minutes",
      },
      answer: "Use our normal short-duration class.",
      intent: "Create follow-up tasks.",
      egressAcknowledged: true,
      operatorApprovedValues: {
        field: "estimated_minutes",
        values: ["Bearer secret-token-value"],
        egressAcknowledged: true,
      },
    })).rejects.toThrow(/credential or secret material/);
    expect(requestJson).not.toHaveBeenCalled();
  });

  it("uses only one correction after an invalid structured range", async () => {
    let attempt = 0;
    const requestJson = vi.fn(async () => {
      attempt += 1;
      return {
        status: 200,
        body: {
          output: [{
            type: "function_call",
            call_id: `call_action_range_${attempt}`,
            name: "runner__interpret_action_boundary_answer",
            arguments: JSON.stringify({
              status: "resolved",
              minimum: attempt === 1 ? 120 : 5,
              maximum: attempt === 1 ? 5 : 120,
            }),
          }],
        },
      };
    });
    const result = await interpretActionBoundaryDecision({
      session: { provider: "openai", model: "gpt-test", apiKey: "memory-key", dependencies: { requestJson } },
      decision: {
        kind: "numeric_bounds",
        title: "Set duration",
        help: "Finite bounds are required.",
        field: "estimated_minutes",
      },
      answer: "Five minutes through two hours.",
      intent: "Create follow-up tasks.",
      egressAcknowledged: true,
    });
    expect(result).toMatchObject({ state: "resolved", correction_used: true });
    expect(requestJson).toHaveBeenCalledTimes(2);
  });

  it("interprets exact conditions and trusted-scope circuit breakers without identity values", async () => {
    const requests: Array<Record<string, unknown>> = [];
    const requestJson = vi.fn(async (request: Parameters<NonNullable<AskProviderDependencies["requestJson"]>>[0]) => {
      requests.push(request.body);
      return {
      status: 200,
      body: {
        output: [{
          type: "function_call",
          call_id: "call_action_policy",
          name: "runner__interpret_action_approval_policy",
          arguments: JSON.stringify({
            status: "resolved",
            conditions: [
              { field: "estimated_minutes", operator: "lte", value: 30 },
              { field: "priority", operator: "in", values: ["routine", "elevated"] },
            ],
            max_per_day: 3,
            max_total_per_day: 60,
            total_field: "estimated_minutes",
            shared_limits: [{
              kind: "count",
              scope: "tenant_principal",
              maximum: 3,
              window_seconds: 86400,
              field: "estimated_minutes",
            }],
          }),
        }],
      },
      };
    });

    const result = await interpretActionBoundaryPolicy({
      session: { provider: "openai", model: "gpt-test", apiKey: "memory-key", dependencies: { requestJson } },
      action,
      resource: followUps,
      answer: "Routine or elevated tasks up to thirty minutes, at most three per agent per day and sixty minutes total.",
      egressAcknowledged: true,
    });

    expect(result).toMatchObject({
      state: "resolved",
      auto_approval: {
        conditions: [
          { field: "estimated_minutes", operator: "lte", value: 30 },
          { field: "priority", operator: "in", values: ["routine", "elevated"] },
        ],
        max_per_day: 3,
        max_total_per_day: 60,
        total_field: "estimated_minutes",
      },
      shared_limits: [{
        kind: "count",
        scope: "tenant_principal",
        maximum: 3,
        window_seconds: 86400,
      }],
      authority_granted: false,
      source_database_changed: false,
    });
    const request = JSON.stringify(requests[0]);
    expect(request).toContain("routine");
    expect(request).toContain("elevated");
    expect(request).toContain("tenant_principal");
    expect(request).not.toContain("memory-key");
    expect(request).not.toContain("acme");
  });

  it("corrects a policy that drops an explicit per-operator trusted scope", async () => {
    let attempt = 0;
    const requests: string[] = [];
    const requestJson = vi.fn(async (request: Parameters<NonNullable<AskProviderDependencies["requestJson"]>>[0]) => {
      requests.push(JSON.stringify(request.body));
      attempt += 1;
      return {
        status: 200,
        body: {
          output: [{
            type: "function_call",
            call_id: `call_action_scope_${attempt}`,
            name: "runner__interpret_action_approval_policy",
            arguments: JSON.stringify({
              status: "resolved",
              conditions: [
                { field: "estimated_minutes", operator: "lte", value: 45 },
                { field: "priority", operator: "in", values: ["routine", "elevated"] },
              ],
              max_per_day: 4,
              ...(attempt === 2
                ? {
                    shared_limits: [{
                      kind: "count",
                      scope: "tenant_principal",
                      maximum: 4,
                      window_seconds: 86400,
                    }],
                  }
                : {}),
            }),
          }],
        },
      };
    });

    const result = await interpretActionBoundaryPolicy({
      session: { provider: "openai", model: "gpt-test", apiKey: "memory-key", dependencies: { requestJson } },
      action,
      resource: followUps,
      answer: "Auto-approve routine or elevated tasks up to 45 minutes, at most four per operator each day.",
      egressAcknowledged: true,
    });

    expect(result).toMatchObject({
      state: "resolved",
      correction_used: true,
      shared_limits: [{
        kind: "count",
        scope: "tenant_principal",
        maximum: 4,
        window_seconds: 86400,
      }],
    });
    expect(requestJson).toHaveBeenCalledTimes(2);
    expect(requests[0]).toContain("explicitly scoped the limit");
    expect(requests[1]).toContain("shared_limits must include trusted scope tenant_principal");
  });

  it("corrects a model that changes an explicit customer rolling window", async () => {
    let attempt = 0;
    const requests: string[] = [];
    const requestJson = vi.fn(async (request: Parameters<NonNullable<AskProviderDependencies["requestJson"]>>[0]) => {
      requests.push(JSON.stringify(request.body));
      attempt += 1;
      return {
        status: 200,
        body: {
          output: [{
            type: "function_call",
            call_id: `call_action_duration_${attempt}`,
            name: "runner__interpret_action_approval_policy",
            arguments: JSON.stringify({
              status: "resolved",
              conditions: [
                { field: "estimated_minutes", operator: "lte", value: 30 },
                { field: "priority", operator: "in", values: ["routine", "elevated"] },
              ],
              max_per_day: 1,
              shared_limits: [{
                kind: "count",
                scope: "tenant_principal",
                maximum: 1,
                window_seconds: attempt === 1 ? 129_600 : 1_296_000,
              }],
            }),
          }],
        },
      };
    });

    const result = await interpretActionBoundaryPolicy({
      session: { provider: "openai", model: "gpt-test", apiKey: "memory-key", dependencies: { requestJson } },
      action,
      resource: followUps,
      answer: "Auto-approve at most one routine request per customer in a rolling 15-day window.",
      egressAcknowledged: true,
    });

    expect(result).toMatchObject({
      state: "resolved",
      correction_used: true,
      shared_limits: [{
        scope: "tenant_principal",
        maximum: 1,
        window_seconds: 1_296_000,
      }],
    });
    expect(requestJson).toHaveBeenCalledTimes(2);
    expect(requests[1]).toContain("explicitly stated a window of 15 days");
    expect(requests[1]).toContain("15 days");
  });

  it("requires explicit egress acknowledgement before sending an operator answer", async () => {
    const requestJson = vi.fn();
    await expect(interpretActionBoundaryDecision({
      session: { provider: "openai", model: "gpt-test", apiKey: "memory-key", dependencies: { requestJson } },
      decision: {
        kind: "numeric_bounds",
        title: "Set duration",
        help: "Finite bounds are required.",
        field: "estimated_minutes",
      },
      answer: "Five to 120 minutes.",
      intent: "Create follow-up tasks.",
      egressAcknowledged: false,
    })).rejects.toThrow(/Acknowledge that reviewed visible data/);
    expect(requestJson).not.toHaveBeenCalled();
  });

  it("frames numeric decisions as business questions rather than serialization syntax", () => {
    expect(actionBoundaryDecisionQuestion({
      kind: "numeric_bounds",
      title: "Set the reviewed range for estimated minutes",
      help: "Finite bounds are required.",
      field: "estimated_minutes",
    }, "INSERT support_ops.follow_up_tasks")).toMatchObject({
      label: "What is the smallest and largest estimated minutes the agent may propose?",
      context: expect.arrayContaining([expect.stringContaining("ordinary language")]),
    });
  });
});
