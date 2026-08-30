import { describe, expect, it } from "vitest";
import type { PolicySpec } from "@synapsor/spec";
import { evaluateApprovalPolicy, explainApprovalPolicy } from "./approval-policy.js";
import type { RuntimeCapabilityConfig } from "./runtime-types.js";

describe("typed approval policy evaluation", () => {
  it("supports typed reviewed conditions across model-controlled patch fields", () => {
    const policy: PolicySpec = {
      name: "support_auto",
      kind: "approval",
      rules: [
        { field: "amount_cents", operator: "gte", value: 0 },
        { field: "amount_cents", operator: "lte", value: 2500 },
        { field: "reason", operator: "max_length", value: 80 },
        { field: "priority", operator: "in", values: ["normal", "urgent"] },
        { field: "notify", operator: "eq", value: false },
      ],
    };
    expect(evaluateApprovalPolicy(capability(), policy, {
      amount_cents: 1250,
      reason: "documented outage",
      priority: "normal",
      notify: false,
    })).toMatchObject({ qualifies: true });
    expect(evaluateApprovalPolicy(capability(), policy, {
      amount_cents: 1250,
      reason: "documented outage",
      priority: "low",
      notify: false,
    })).toMatchObject({ qualifies: false, reason: expect.stringContaining("priority") });
  });

  it("preserves existing policies whose nonnumeric fields remain contract-bounded", () => {
    const result = explainApprovalPolicy(capability(), {
      name: "incomplete",
      kind: "approval",
      rules: [{ field: "amount_cents", max: 2500 }],
    }, {
      amount_cents: 100,
      reason: "unconstrained text",
      priority: "normal",
      notify: false,
    });
    expect(result).toMatchObject({
      decision: "auto_approve",
      qualifies: true,
      model_controlled_fields: [
        { field: "amount_cents", covered: true },
        { field: "reason", covered: false },
        { field: "priority", covered: false },
        { field: "notify", covered: false },
      ],
    });
  });

  it("evaluates reviewed pre-change facts and fails closed when the snapshot is unavailable", () => {
    const policy: PolicySpec = {
      name: "state_transition",
      kind: "approval",
      rules: [
        { field: "amount_cents", max: 2500 },
        { field: "reason", operator: "max_length", value: 80 },
        { field: "priority", operator: "in", values: ["normal"] },
        { field: "notify", operator: "eq", value: false },
        { source: "before", field: "status", operator: "eq", value: "open" },
      ],
    };
    const patch = { amount_cents: 100, reason: "reviewed", priority: "normal", notify: false } as const;
    expect(evaluateApprovalPolicy(capability(), policy, patch, { before: { status: "open" } })).toMatchObject({ qualifies: true });
    expect(evaluateApprovalPolicy(capability(), policy, patch)).toEqual({
      qualifies: false,
      reason: "before.status is unavailable",
    });
  });

  it("explains every reviewed condition, field-coverage decision, and rolling limit", () => {
    const policy: PolicySpec = {
      name: "explainable",
      kind: "approval",
      rules: [
        { field: "amount_cents", operator: "lte", value: 2500 },
        { field: "reason", operator: "max_length", value: 80 },
        { field: "priority", operator: "in", values: ["normal"] },
        { field: "notify", operator: "eq", value: false },
        { source: "before", field: "status", operator: "eq", value: "open" },
      ],
      limits: [
        { kind: "count", max: 20, period: "day", scope: "tenant_policy" },
        { kind: "total", max: 10_000, period: "day", field: "amount_cents", scope: "tenant_policy_object" },
      ],
    };
    const result = explainApprovalPolicy(capability(), policy, {
      amount_cents: 1250,
      reason: "reviewed outage",
      priority: "normal",
      notify: false,
    }, { before: { status: "open" } });
    expect(result).toMatchObject({
      decision: "auto_approve",
      qualifies: true,
      model_controlled_fields: [
        { field: "amount_cents", covered: true },
        { field: "reason", covered: true },
        { field: "priority", covered: true },
        { field: "notify", covered: true },
      ],
      conditions: [
        { field: "amount_cents", status: "passed", actual: 1250, expected: 2500 },
        { field: "reason", status: "passed" },
        { field: "priority", status: "passed", expected: ["normal"] },
        { field: "notify", status: "passed", actual: false },
        { source: "before", field: "status", status: "passed" },
      ],
      limits: policy.limits,
    });
  });

  it("distinguishes human fallback from an indeterminate current-state check", () => {
    const policy: PolicySpec = {
      name: "explainable",
      kind: "approval",
      rules: [
        { field: "amount_cents", operator: "lte", value: 2500 },
        { field: "reason", operator: "max_length", value: 80 },
        { field: "priority", operator: "in", values: ["normal"] },
        { field: "notify", operator: "eq", value: false },
        { source: "before", field: "status", operator: "eq", value: "open" },
      ],
    };
    const patch = { amount_cents: 3000, reason: "reviewed", priority: "normal", notify: false } as const;
    expect(explainApprovalPolicy(capability(), policy, patch, { before: { status: "open" } }))
      .toMatchObject({ decision: "human_review", qualifies: false, reason: expect.stringContaining("failed") });
    expect(explainApprovalPolicy(capability(), policy, { ...patch, amount_cents: 100 }))
      .toMatchObject({
        decision: "indeterminate",
        qualifies: false,
        reason: "before.status is unavailable",
        conditions: expect.arrayContaining([
          expect.objectContaining({ source: "before", field: "status", status: "indeterminate" }),
        ]),
      });
  });

  it("keeps every stricter typed policy decision inside the wider reviewed policy", () => {
    const wider: PolicySpec = {
      name: "wider_reviewed_policy",
      kind: "approval",
      rules: [
        { field: "amount_cents", operator: "gte", value: 0 },
        { field: "amount_cents", operator: "lte", value: 2500 },
        { field: "reason", operator: "max_length", value: 80 },
        { field: "priority", operator: "in", values: ["normal", "urgent"] },
        { field: "notify", operator: "eq", value: false },
        { source: "before", field: "status", operator: "eq", value: "open" },
      ],
    };
    const stricter: PolicySpec = {
      name: "stricter_reviewed_policy",
      kind: "approval",
      rules: [
        { field: "amount_cents", operator: "gte", value: 0 },
        { field: "amount_cents", operator: "lte", value: 1000 },
        { field: "reason", operator: "max_length", value: 40 },
        { field: "priority", operator: "in", values: ["normal"] },
        { field: "notify", operator: "eq", value: false },
        { source: "before", field: "status", operator: "eq", value: "open" },
      ],
    };

    let widerOnly = 0;
    for (const amount_cents of [0, 500, 1000, 1001, 2500, 2501]) {
      for (const reasonLength of [1, 40, 41, 80, 81]) {
        for (const priority of ["low", "normal", "urgent"] as const) {
          for (const notify of [false, true]) {
            for (const status of ["open", "closed"] as const) {
              const patch = {
                amount_cents,
                reason: "r".repeat(reasonLength),
                priority,
                notify,
              };
              const context = { before: { status } };
              const widerDecision = explainApprovalPolicy(capability(), wider, patch, context);
              const stricterDecision = explainApprovalPolicy(capability(), stricter, patch, context);
              if (stricterDecision.qualifies) {
                expect(widerDecision.qualifies, JSON.stringify({ patch, context })).toBe(true);
              }
              if (widerDecision.qualifies && !stricterDecision.qualifies) widerOnly += 1;
            }
          }
        }
      }
    }
    expect(widerOnly).toBeGreaterThan(0);
  });
});

function capability(): RuntimeCapabilityConfig {
  return {
    name: "support.propose_credit",
    kind: "proposal",
    context: "support_context",
    source: "local_postgres",
    target: {
      schema: "public",
      table: "credits",
      primary_key: "id",
      tenant_key: "tenant_id",
    },
    args: {
      amount: { type: "number", required: true, minimum: 0, maximum: 5000 },
      reason_arg: { type: "string", required: true, max_length: 500 },
      priority_arg: { type: "string", required: true, enum: ["low", "normal", "urgent"] },
      notify_arg: { type: "boolean", required: true },
    },
    lookup: { id_from_arg: "id" },
    visible_columns: ["id", "amount_cents", "reason", "priority", "notify", "status"],
    allowed_columns: ["amount_cents", "reason", "priority", "notify"],
    patch: {
      amount_cents: { from_arg: "amount" },
      reason: { from_arg: "reason_arg" },
      priority: { from_arg: "priority_arg" },
      notify: { from_arg: "notify_arg" },
    },
    numeric_bounds: { amount_cents: { minimum: 0, maximum: 5000 } },
    approval: { mode: "policy", required_role: "reviewer", policy: "support_auto" },
    writeback: { mode: "none" },
  };
}
