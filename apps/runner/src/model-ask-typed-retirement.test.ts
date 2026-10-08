import { expect, it, vi } from "vitest";
import { WorkbenchAskSession, askToolSurfaceDigest, type AskProvider, type AskToolDefinition, type AskToolGateway } from "./model-ask.js";
import { validateExplorePlan, ScopedExploreError } from "./scoped-explore.js";
import type { ActivatedExplorationBoundary } from "./auto-boundary.js";
import { collectAnalyticsAnalyses, renderAnalyticsTurn } from "./analytics-shell-render.js";

const tools: AskToolDefinition[] = ["app.describe_data", "app.explore_data"].map(name => ({ name,
  description: "Reviewed typed fixture tool", input_schema: { type: "object" } }));
const resource = (id: string) => ({ id, schema: "public", table: id.split(".")[1], primary_key: "pk", tenant_key: "tenant",
  field_types: { status: "text", amount: "integer", observed: "timestamp with time zone", secret: "text" },
  field_enums: { status: ["open", "closed"] }, selectable_fields: ["status", "amount"], filterable_fields: { status: ["eq", "neq"] },
  sortable_fields: [], groupable_fields: ["status"], aggregate_measures: ["amount"],
  aggregate_measure_functions: { amount: ["sum", "avg", "stddev_pop"] }, count_distinct_fields: [],
  time_bucket_fields: { observed: ["day", "week"] }, kept_out_fields: ["secret"], relationships: [], minimum_cohort_size: 5 });
const boundary = { pack: { name: "reviewed", resources: [resource("public.records"), resource("public.orders")] },
  budgets: { max_rows: 10, max_response_cells: 40, max_top_n: 10, max_groups: 10, max_measures: 3 } } as unknown as ActivatedExplorationBoundary;
const typedPlan = { kind: "rows", resource: "public.records", select: ["status"], where: [{ field: "status", op: "eq", value: "open" }], limit: 3 };
const questions = ["Show all orders.", "Count orders.", "Sum amount by status.", "Average amount by status.",
  "Population standard deviation of amount by status.", "Group records by status.", "Show records by week.",
  "Compare this week with last week.", "Count orders and sum amount by status."];
async function run(provider: AskProvider, question: string, plan: Record<string, unknown> = typedPlan, mode: "balanced" | "boundary_only" = "balanced", narrationOnly = false) {
  const calls: unknown[] = []; const metadata: unknown[] = []; let requests = 0;
  const gateway: AskToolGateway = { mode: "runtime", listTools: () => tools,
    resolveAskIntentCheck: async () => ({ mode, boundary_name: "reviewed" }),
    describeOperatorMetadata: async args => { metadata.push(args); return { ok: true, value: { ok: true, resources: boundary.pack.resources } }; },
    callTool: async (name, args) => { calls.push({ name, args: structuredClone(args) });
      if (name === "app.describe_data") return { ok: true, value: { ok: true, resources: boundary.pack.resources, source_database_changed: false } };
      try { validateExplorePlan(args.plan, boundary); return { ok: true, value: { ok: true, data: [{ status: "open" }], source_query_executed: true, source_database_changed: false } }; }
      catch (error) { if (!(error instanceof ScopedExploreError)) throw error; return { ok: false, error_code: error.code, value: {
        ok: false, error_code: error.code, details: error.details, source_query_executed: false, explore_budget_consumed: false, source_database_changed: false } }; }
    }, close: async () => undefined };
  const requestJson = vi.fn(async () => {
    const first = requests++ === 0 && !narrationOnly;
    return { status: 200, body: provider === "anthropic"
      ? { content: first ? [{ type: "tool_use", id: "typed-model-plan", name: "app__explore_data", input: { plan } }] : [{ type: "text", text: "Untrusted model interpretation." }] }
      : { choices: [{ message: first ? { role: "assistant", content: null, tool_calls: [{ id: "typed-model-plan", type: "function", function: { name: "app__explore_data", arguments: JSON.stringify({ plan }) } }] }
        : { role: "assistant", content: "Untrusted model interpretation." } }] } };
  });
  const session = new WorkbenchAskSession();session.configure({ provider, model: "offline-fixture", api_key: "offline-fixture-only",
    ...(provider === "openai_compatible" ? { base_url: "http://127.0.0.1:9001/v1" } : {}), authority_digest: askToolSurfaceDigest(tools), egress_acknowledged: true });
  const result = await session.run(question, gateway, { requestJson });
  return { result, calls, metadata, requestJson };
}
it.each(questions)("English request cannot construct or accept/reject model typed plan: %s", async question => {
  expect(() => validateExplorePlan(typedPlan, boundary)).not.toThrow();
  const f = await run("openai_compatible", question);
  expect(f.calls).toEqual([{ name: "app.explore_data", args: { plan: typedPlan } }]);
  expect(f.metadata).toEqual([]);expect(f.requestJson).toHaveBeenCalledTimes(2);
  expect(f.result.tool_calls[0]).toMatchObject({ status: "ok", question_to_plan_checked: false, arguments: { plan: typedPlan } });
});
it.each(["openai", "anthropic", "openai_compatible"] as AskProvider[])("%s narration cannot trigger an English-derived query/correction", async provider => {
  const f = await run(provider, "Show all orders as a sentence for a manual; do not run anything.", typedPlan, "balanced", true);
  expect(f.calls).toEqual([]);expect(f.metadata).toEqual([]);expect(f.requestJson).toHaveBeenCalledTimes(1);
  expect(f.result).toMatchObject({ answer_is_untrusted_model_output: true, tool_calls: [], source_database_changed: false });
});
it.each(["balanced", "boundary_only"] as const)("actual %s session-to-collector-to-renderer displays redacted full typed plan and success", async mode => {
  const f = await run("openai", "任意の依頼", typedPlan, mode);
  const text = renderAnalyticsTurn(f.result, collectAnalyticsAnalyses(f.result.tool_calls));
  expect(text).toContain("RUNNER PLAN READBACK");expect(text).toContain('"resource": "public.records"');
  expect(text).toContain('"where"');expect(text).toContain('"op": "eq"');expect(text).toContain('"value": "<redacted>"');
  expect(text).toContain('"limit": 3');expect(text).toContain("status: ok");
  expect(text).toContain("Question meaning was not verified");
  expect(f.result.tool_calls[0]).toHaveProperty("question_to_plan_checked", false);
});
it("actual validator refusal has readback/status without Source query or budget use", async () => {
  const badPlan = { ...typedPlan, select: ["secret"] };
  const f = await run("openai", "Show secret records.", badPlan);
  expect(f.result.tool_calls[0]).toMatchObject({ status: "refused", error_code: "EXPLORE_FIELD_FORBIDDEN", result: { source_query_executed: false, explore_budget_consumed: false } });
  const text = renderAnalyticsTurn(f.result, collectAnalyticsAnalyses(f.result.tool_calls));
  expect(text).toContain("RUNNER PLAN READBACK");expect(text).toContain("status: refused");
  expect(text).toContain("EXPLORE_FIELD_FORBIDDEN");expect(text).toContain('"limit": 3');
});
