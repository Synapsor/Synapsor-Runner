import { describe, expect, it, vi } from "vitest";
import { WorkbenchAskSession, askToolSurfaceDigest, type AskToolDefinition, type AskToolGateway } from "./model-ask.js";
import { ScopedExploreError, validateExplorePlan } from "./scoped-explore.js";
import type { ActivatedExplorationBoundary } from "./auto-boundary.js";

const tools: AskToolDefinition[] = [
  { name: "app.describe_data", description: "Current reviewed catalog", input_schema: { type: "object", properties: { resource: { type: "string" } }, additionalProperties: false } },
  { name: "app.explore_data", description: "One reviewed typed plan", input_schema: { type: "object", properties: { plan: { type: "object" } }, required: ["plan"], additionalProperties: false } },
];
function resource(id: string) {
  return { id, schema: "public", table: id.split(".")[1], primary_key: "id", tenant_key: "tenant_id", principal_key: "principal_id", field_types: { status: "text", secret: "text", tenant_id: "text", principal_id: "text" }, field_enums: { status: ["open", "closed"] }, selectable_fields: ["status"], filterable_fields: { status: ["eq", "neq"] }, sortable_fields: [], groupable_fields: ["status"], aggregate_measures: [], aggregate_measure_functions: {}, count_distinct_fields: [], time_bucket_fields: {}, kept_out_fields: ["secret"], model_withheld_fields: ["secret"], relationships: [], minimum_cohort_size: 5 };
}
const boundary = { pack: { name: "reviewed", resources: [resource("public.orders"), resource("public.metrics")] }, budgets: { max_rows: 10, max_response_cells: 20, max_top_n: 10, max_groups: 10 } } as unknown as ActivatedExplorationBoundary;
const plan = { kind: "rows", resource: "public.metrics", select: ["status"], where: [{ field: "status", op: "eq", value: "open" }], limit: 3 };
function response(args?: Record<string, unknown>, answer = "Model interpretation remains untrusted.") {
  return { status: 200, body: { choices: [{ message: args ? { role: "assistant", content: null, tool_calls: [{ id: "typed_plan", type: "function", function: { name: "app__explore_data", arguments: JSON.stringify(args) } }] } : { role: "assistant", content: answer } }] } };
}
function fixture(inputPlan: Record<string, unknown> = plan) {
  const sourceQueries: unknown[] = []; const metadata: unknown[] = []; const calls: unknown[] = [];
  const gateway: AskToolGateway = { mode: "runtime", listTools: () => tools,
    describeOperatorMetadata: async args => { metadata.push(args); return { ok: true, value: { ok: true, metadata_only: true, resources: boundary.pack.resources } }; },
    callTool: async (name, args) => {
      calls.push({ name, args: structuredClone(args) });
      if (name === "app.describe_data") return { ok: true, value: { ok: true, metadata_only: true, resources: boundary.pack.resources } };
      try {
        const actual = validateExplorePlan(args.plan, boundary); sourceQueries.push(actual);
        return { ok: true, value: { ok: true, data: [{ status: "open" }], source_query_executed: true, source_database_changed: false } };
      } catch (error) {
        if (!(error instanceof ScopedExploreError)) throw error;
        return { ok: false, error_code: error.code, value: { ok: false, error_code: error.code, details: error.details, source_query_executed: false, explore_budget_consumed: false, source_database_changed: false } };
      }
    }, close: async () => undefined };
  const session = new WorkbenchAskSession(); const digest = askToolSurfaceDigest(tools);
  session.configure({ provider: "openai", model: "gpt-4.1", api_key: "offline-fixture-only", authority_digest: digest, egress_acknowledged: true });
  const bodies: Record<string, unknown>[] = [];
  const requestJson = vi.fn(async (request: any) => { bodies.push(request.body); return requestJson.mock.calls.length === 1 ? response({ plan: inputPlan }) : response(); });
  return { session, gateway, digest, requestJson, sourceQueries, metadata, calls, bodies };
}

  it("AT01R OpenAI Responses exposes the same tool schemas and passes exact typed model arguments without a semantic-proof claim", async () => {
    const f = fixture(); const result = await f.session.run("計測値を確認してください", f.gateway, { requestJson: f.requestJson });
    expect(f.calls).toEqual([{ name: "app.explore_data", args: { plan } }]);
    expect(f.metadata).toEqual([]); expect(f.sourceQueries).toHaveLength(1); expect(f.requestJson).toHaveBeenCalledTimes(2);
    expect(result.tool_calls[0]).toMatchObject({ question_to_plan_checked: false, status: "ok" });
    expect(result).toMatchObject({ answer_is_untrusted_model_output: true, source_database_changed: false });
    const exposed = (f.bodies[0]!.tools as any[]).map(tool => ({ name: tool.name, schema: tool.parameters }));
    expect(exposed).toEqual(tools.map((tool) => ({ name: tool.name.replaceAll(".", "__"), schema: tool.input_schema })));
  });
