import { describe, it, expect, vi } from "vitest";
import { DEFAULT_REVIEWED_EXPLORATION_BUDGETS, type ExplorationBoundaryDraft } from "./auto-boundary.js";
import { generateModelReadWorkload } from "./read-workload-model.js";

// Existing reviewed-boundary fixture, with controlled local responses only.
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


const response = (args: unknown) => ({ status: 200, body: { output: [{ type: "function_call", call_id: "local-misplaced", name: "runner__submit_read_workloads", arguments: JSON.stringify(args) }] } });
const good = () => ({ allowed: [{ id: "orders", description: "List my orders", plan: { kind: "rows", resource: "public.orders", select: ["status"] } }], forbidden: [] });
const clarification = { resource: "public.orders", field: "status", reason: "Unknown meaning", question: "What does status mean for this workflow?" };
function setup(requestJson: any, clarificationHandler: any) {
 return { name: "misplaced_guidance", allowedQuestions: ["List my orders"], provider: "openai" as const, model: "local-controlled", apiKey: "test-key", generatedBoundary: generatedBoundary(), egressAcknowledged: true, deferNarration: true, clarificationHandler, dependencies: { requestJson } };
}
function invalid(field: string) {
 const value: any = good();
 if (field === "clarification_request") value.allowed[0].plan = { clarification_request: clarification };
 else value.allowed[0].plan.operator_meanings = [{ resource: "public.orders", field: "status", operator_quote: "MISPLACED_VALUE_MUST_NOT_BE_ECHOED" }];
 return value;
}
function feedback(requestJson: any) {
 const body = requestJson.mock.calls[1][0].body;
 const messages = body.messages ?? body.input;
 return messages.filter((m: any) => m.role === "user").map((m: any) => typeof m.content === "string" ? m.content : m.content.map((part: any) => part.text ?? "").join("\n")).findLast((v: string) => v.includes("Validation issues:"));
}
describe("misplaced Read root fields use the existing strict bounded correction", () => {
 for (const field of ["clarification_request", "operator_meanings"]) {
  for (const persistent of [false, true]) it(`${field}: ${persistent ? "persistent bounded stop" : "targeted correction then valid workload"}`, async () => {
   const original = invalid(field); const before = structuredClone(original);
   const requestJson = vi.fn(async () => response(requestJson.mock.calls.length === 1 || persistent ? original : good()));
   const handler = vi.fn();
   const result = await generateModelReadWorkload(setup(requestJson, handler));
   expect(requestJson).toHaveBeenCalledTimes(2); expect(handler).not.toHaveBeenCalled(); expect(original).toEqual(before);
   const correction = feedback(requestJson);
   expect(correction).toContain(`/allowed/0/plan/${field}`); expect(correction).toContain("root");
   expect(correction).not.toContain("MISPLACED_VALUE_MUST_NOT_BE_ECHOED");
   expect(result.analysis.status).toBe(persistent ? "blocked" : "ready");
  });
 }
 it("does not accept a private field in the corrected workload", async () => {
  const privatePlan: any = good(); privatePlan.allowed[0].plan.select = ["secret_note"];
  const requestJson = vi.fn(async () => response(requestJson.mock.calls.length === 1 ? invalid("clarification_request") : privatePlan));
  const handler = vi.fn(); const result = await generateModelReadWorkload(setup(requestJson, handler));
  expect(requestJson).toHaveBeenCalledTimes(2); expect(handler).not.toHaveBeenCalled(); expect(result.analysis.status).toBe("blocked");
 });
 it("does not accept an invented quote after operator_meanings is placed at the root", async () => {
  const badQuote: any = good(); badQuote.operator_meanings = [{ resource: "public.orders", field: "status", operator_quote: "Invented statement that is absent from the original Source." }];
  const requestJson = vi.fn(async () => response(requestJson.mock.calls.length === 1 ? invalid("operator_meanings") : badQuote));
  const handler = vi.fn();
  await expect(generateModelReadWorkload({ ...setup(requestJson, handler), clarificationHandler: undefined }))
    .rejects.toThrow(/READ_WORKLOAD_DRAFT_FAILED:[\s\S]*READ_WORKLOAD_NAMING_EVIDENCE_INVALID/);
  expect(requestJson).toHaveBeenCalledTimes(2); expect(handler).not.toHaveBeenCalled();
 });
});
