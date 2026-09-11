import { describe, expect, it } from "vitest";
import { askPlanSyntaxRepair, matchesAskPlanSyntaxRepair } from "./ask-plan-recovery.js";
import { askToolSurfaceDigest, resolveAskProviderConfiguration, runAskProviderTurn,
  type AskProvider, type AskToolGateway, type AskToolTrace } from "./model-ask.js";
import { DEFAULT_REVIEWED_EXPLORATION_BUDGETS, type ActivatedExplorationBoundary } from "./auto-boundary.js";
import { ScopedExploreError, validateExplorePlan } from "./scoped-explore.js";

const malformed = { plan: { kind: "rows", resource: "service.offers", select: ["status"],
  where: [{ field: "status", operator: "eq", value: "active" }], limit: 5 } };
const corrected = { plan: { ...malformed.plan, where: [{ field: "status", op: "eq", value: "active" }] } };
const tools = [{ name: "app.explore_data", description: "Runs an exact reviewed plan",
  input_schema: { type: "object", properties: { plan: { type: "object" } }, required: ["plan"] } }];
const digest = askToolSurfaceDigest(tools);
const boundary = { budgets: DEFAULT_REVIEWED_EXPLORATION_BUDGETS, pack: { resources: [{
  id: "service.offers", selectable_fields: ["status"], filterable_fields: { status: ["eq"] },
  sortable_fields: [], kept_out_fields: ["account_id"], model_withheld_fields: [], field_types: { status: "text" }, field_enums: {},
}] } } as unknown as ActivatedExplorationBoundary;

function refusalTrace(): AskToolTrace {
  try { validateExplorePlan(malformed.plan, boundary); } catch (error) {
    if (!(error instanceof ScopedExploreError)) throw error;
    return { call_id: "bad", tool: "app.explore_data", provider_tool: "app__explore_data",
      status: "refused", arguments: structuredClone(malformed), error_code: error.code,
      result: { error_code: error.code, message: error.message, details: error.details, source_database_changed: false } };
  }
  throw new Error("Expected strict validation to refuse the malformed plan");
}
function response(provider: AskProvider, args?: Record<string, unknown>) {
  return { status: 200, body: provider === "anthropic"
    ? { content: args ? [{ type: "tool_use", id: "query", name: "app__explore_data", input: args }]
      : [{ type: "text", text: "The reviewed query completed." }] }
    : { choices: [{ message: args ? { role: "assistant", content: null,
      tool_calls: [{ id: "query", type: "function", function: { name: "app__explore_data", arguments: JSON.stringify(args) } }] }
      : { role: "assistant", content: "The reviewed query completed." } }] } };
}

describe("bounded model query syntax recovery", () => {
  it("reports pre-query allowed keys without accepting an alias or changing the original request", () => {
    const trace = refusalTrace();
    expect(trace.result.details).toEqual({ category: "plan_syntax", recovery: "correct_plan_keys", location: "filter",
      allowed_keys: ["field", "op", "value", "relationship"], unexpected_keys: ["operator"],
      source_query_executed: false, explore_budget_consumed: false });
    const before = structuredClone(trace);
    const repair = askPlanSyntaxRepair(trace)!;
    expect(repair.arguments).toEqual(corrected);
    expect(trace).toEqual(before);
    expect(matchesAskPlanSyntaxRepair(repair, { plan: { ...corrected.plan, where: [] } })).toBe(false);
    expect(() => validateExplorePlan(malformed.plan, boundary)).toThrow(/unsupported fields: operator/);
    expect(validateExplorePlan(corrected.plan, boundary)).toMatchObject(corrected.plan);
    expect(askPlanSyntaxRepair({ ...trace, error_code: "EXPLORE_FIELD_FORBIDDEN" })).toBeUndefined();
    expect(askPlanSyntaxRepair({ ...trace, arguments: { plan: { ...malformed.plan,
      where: [{ ...malformed.plan.where[0], op: "ne" }] } } })).toBeUndefined();
  });

  for (const provider of ["openai", "anthropic", "openrouter", "openai_compatible"] as const) {
    for (const scenario of ["success", "changed_filter", "repeated_syntax", "missing_call", "still_invalid", "forbidden", "connection", "cancel", "authority_changed"] as const) {
      it(`${provider}: ${scenario}`, async () => {
        const configuration = resolveAskProviderConfiguration({ provider,
          model: provider === "openrouter" ? "openai/gpt-4.1" : "test-model", api_key: "test-only-key",
          ...(provider === "openai_compatible" ? { base_url: "http://127.0.0.1:11434/v1" } : {}),
          egress_acknowledged: true, authority_digest: digest }, {}, new Date());
        const trace = refusalTrace();
        const executed: Record<string, unknown>[] = [];
        let requests = 0;
        let currentDigest = digest;
        const controller = new AbortController();
        const gateway: AskToolGateway = { mode: "authoring", listTools: () => tools, close: async () => {},
          describeOperatorMetadata: async () => ({ ok: true, value: { resources: [{ id: "service.offers", label: "Offers",
            fields: [{ id: "status", label: "Status" }], filterable_fields: { status: ["eq"] },
            allowed_values: { status: ["active"] } }] } }),
          callTool: async (_name, args) => {
            executed.push(args);
            if (executed.length === 1 || scenario === "still_invalid") {
              const code = scenario === "forbidden" ? "EXPLORE_FIELD_FORBIDDEN"
                : scenario === "connection" ? "EXPLORE_SOURCE_UNAVAILABLE" : trace.error_code!;
              return { ok: false, error_code: code, value: { ...trace.result, error_code: code } };
            }
            validateExplorePlan(args.plan, boundary);
            return { ok: true, value: { data: [{ status: "active" }], source_database_changed: false } };
          } };
        const run = runAskProviderTurn({ configuration, question: "Show active offers", history: [], gateway,
          tools, authorityDigest: digest, signal: controller.signal, authorityGuard: () => currentDigest,
          dependencies: { requestJson: async request => {
            requests += 1;
            if (requests === 1) return response(provider, malformed);
            if (["forbidden", "connection"].includes(scenario)) {
              expect(JSON.stringify(request.body)).not.toContain("one syntax correction attempt");
              return response(provider);
            }
            if (requests === 2) {
              expect(JSON.stringify(request.body)).toContain("one syntax correction attempt");
              expect(request.body.tool_choice).toBeDefined();
              if (scenario === "cancel") controller.abort();
              if (scenario === "authority_changed") currentDigest = `sha256:${"f".repeat(64)}`;
              return response(provider, scenario === "missing_call" ? undefined
                : scenario === "repeated_syntax" ? malformed
                  : scenario === "changed_filter" ? { plan: { ...corrected.plan, where: [] } } : corrected);
            }
            return response(provider);
          } } });
        if (scenario === "cancel" || scenario === "authority_changed") {
          await expect(run).rejects.toMatchObject({ code: scenario === "cancel" ? "ASK_CANCELLED" : "ASK_AUTHORITY_CHANGED" });
          expect(executed).toHaveLength(1);
          return;
        }
        const result = await run;
        if (scenario === "success") {
          expect(executed).toEqual([malformed, corrected]);
          expect(result.tool_calls.map(t => t.status)).toEqual(["refused", "ok"]);
        } else {
          expect(executed).toHaveLength(scenario === "still_invalid" ? 2 : 1);
          expect(requests).toBe(2);
          expect(result.answer).not.toContain("query completed");
          if (scenario !== "forbidden") expect(result.answer).not.toContain("review broader access");
          expect(result.source_database_changed).toBe(false);
        }
      });
    }
  }
});
