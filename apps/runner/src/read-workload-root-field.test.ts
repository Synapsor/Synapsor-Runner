import { describe, it, expect, vi } from "vitest";
import { DEFAULT_REVIEWED_EXPLORATION_BUDGETS, type ExplorationBoundaryDraft } from "./auto-boundary.js";
import { generateModelReadWorkload } from "./read-workload-model.js";
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

const fieldQuestion = { resource: "public.tbl_7", field: "status", reason: "The handling stage meaning is missing", question: "What do the handling-stage codes mean for this workflow?" };
const reply = (args: unknown) => ({ status: 200, body: { output: [{ type: "function_call", call_id: "root-to-field", name: "runner__submit_read_workloads", arguments: JSON.stringify(args) }] } });
// The current controller spends one existing correction on the host-broadened
// opaque-root wording. That response repeats the same visible target; it must
// not consume the next scripted business question or supply a business answer.
function scriptedQuestions(next: (index: number) => typeof fieldQuestion) {
 let current: typeof fieldQuestion | undefined, index = 0;
 const mapping = vi.fn(() => current = next(index++));
 const wording = vi.fn(() => { expect(current).toBeDefined(); return current!; });
 const send = vi.fn(async (request: any) => {
  expect(request.body.tools.map((tool: any) => tool.name)).toEqual(["runner__submit_read_workloads"]);
  const text = JSON.stringify(request.body);
  const correction = text.includes("Your first non-authoritative workload was refused by Runner validation.")
   && text.includes("Rephrase the same missing business question once.");
  const question = correction ? wording() : mapping();
  if (correction) expect(wording).toHaveBeenCalledOnce();
  return reply({ clarification_request: question });
 });
 return Object.assign(send, { mapping, wording });
}
function setup(requestJson: any) {
 const boundary = generatedBoundary();
 const resource = boundary.pack.resources[0]!;
 resource.id = "public.tbl_7"; resource.table = "tbl_7"; delete resource.label; delete resource.description;
 return { name: "root_then_field", allowedQuestions: ["List my parcels"], provider: "openai" as const, model: "local-controlled", apiKey: "test-key", generatedBoundary: boundary, egressAcknowledged: true, deferNarration: true, dependencies: { requestJson } };
}
describe("root meaning does not erase a newly needed field question", () => {
 it("retains a current root answer and saves the distinct field wait without treating it as repeated", async () => {
  const send = scriptedQuestions(() => fieldQuestion);
  let saved: any;
  const answer = vi.fn(async (q: any) => answer.mock.calls.length === 1 ? { state: "answered" as const, answer: "The parcel register is tbl_7." } : undefined);
  await expect(generateModelReadWorkload({ ...setup(send), clarificationHandler: answer, onCheckpoint: async v => { saved = structuredClone(v); } })).rejects.toThrow("READ_WORKLOAD_AUTHORING_PAUSED");
  expect(send.mapping).toHaveBeenCalledTimes(2); expect(send.wording).toHaveBeenCalledOnce(); expect(send).toHaveBeenCalledTimes(3); expect(answer).toHaveBeenCalledTimes(2);
  expect(answer.mock.calls[0]![0].field).toBeUndefined(); expect(answer.mock.calls[1]![0]).toEqual(fieldQuestion);
  expect(saved.pending_question.request).toEqual(fieldQuestion);
  expect(saved.state.clarified_targets).toHaveLength(1);
  expect(saved.state.clarified_targets[0]).toMatchObject({ resource: "public.tbl_7", answer: "The parcel register is tbl_7." });
  expect(saved.state.clarified_targets[0].field).toBeUndefined();
  const noSend = vi.fn(), noAnswer = vi.fn(async () => undefined);
  await expect(generateModelReadWorkload({ ...setup(noSend), resumeCheckpoint: saved, clarificationHandler: noAnswer, onCheckpoint: async () => {} })).rejects.toThrow("READ_WORKLOAD_AUTHORING_PAUSED");
  expect(noSend).not.toHaveBeenCalled(); expect(noAnswer).toHaveBeenCalledWith(fieldQuestion);
 });
 it("still asks about an unexplained root before its field", async () => {
  const send = scriptedQuestions(() => fieldQuestion); const answer = vi.fn(async (_q: any) => undefined);
  await expect(generateModelReadWorkload({ ...setup(send), clarificationHandler: answer })).rejects.toThrow("READ_WORKLOAD_AUTHORING_PAUSED");
  expect(answer.mock.calls[0]![0]).toMatchObject({ resource: "public.tbl_7" }); expect((answer.mock.calls[0] as any)[0].field).toBeUndefined(); expect(send.mapping).toHaveBeenCalledOnce(); expect(send.wording).toHaveBeenCalledOnce(); expect(send).toHaveBeenCalledTimes(2);
 });
 it("does not treat an unknown root answer as established meaning", async () => {
  const send = scriptedQuestions(() => fieldQuestion); let saved: any;
  await expect(generateModelReadWorkload({ ...setup(send), clarificationHandler: async () => ({ state: "answered", answer: "I don't know" }), onCheckpoint: async v => { saved = structuredClone(v); } })).rejects.toThrow("READ_WORKLOAD_AUTHORING_PAUSED");
  expect(send.mapping).toHaveBeenCalledOnce(); expect(send.wording).toHaveBeenCalledOnce(); expect(send).toHaveBeenCalledTimes(2); expect(saved.state.clarified_targets).toEqual([]); expect(saved.pending_question.request.field).toBeUndefined();
 });
 it("does not reuse another resource's accepted root answer", async () => {
  const send = scriptedQuestions(index => ({ ...fieldQuestion, resource: index === 0 ? "public.tbl_7" : "public.tbl_8" }));
  const input = setup(send); const other = structuredClone(input.generatedBoundary.pack.resources[0]!);
  other.id = "public.tbl_8"; other.table = "tbl_8"; input.generatedBoundary.pack.resources.push(other);
  const answer = vi.fn(async (_q: any) => answer.mock.calls.length === 1 ? { state: "answered" as const, answer: "The parcel register is tbl_7." } : undefined);
  await expect(generateModelReadWorkload({ ...input, clarificationHandler: answer })).rejects.toThrow("READ_WORKLOAD_AUTHORING_PAUSED");
  expect(answer).toHaveBeenCalledTimes(2); expect(answer.mock.calls[1]![0]).toMatchObject({ resource: "public.tbl_8" }); expect(answer.mock.calls[1]![0].field).toBeUndefined();
 });
 it("does not establish a declined root or send another generation", async () => {
  const send = scriptedQuestions(() => fieldQuestion); let saved: any;
  await expect(generateModelReadWorkload({ ...setup(send), clarificationHandler: async () => ({ state: "declined" }), onCheckpoint: async v => { saved = structuredClone(v); } })).rejects.toThrow("READ_WORKLOAD_CLARIFICATION_DECLINED");
  expect(send.mapping).toHaveBeenCalledOnce(); expect(send.wording).toHaveBeenCalledOnce(); expect(send).toHaveBeenCalledTimes(2); expect(saved.state.clarified_targets).toEqual([]); expect(saved.pending_question.decision.state).toBe("declined");
 });

 it("keeps S03's two field answers separate from the root and requires reviewed replacement", async () => {
  const followup = { ...fieldQuestion, reason: "The first answer gives one handling-stage code", question: "You said 22 means waiting. What do all the handling-stage codes mean, and is that first answer correct?" };
  const send = scriptedQuestions(index => index < 2 ? fieldQuestion : followup);
  const answers = ["The parcel register is tbl_7.", "22 means waiting.", "I got that wrong. 11 means waiting, 22 means ready, and 33 means closed."];
  const answer = vi.fn(async (_q: any) => ({ state: "answered" as const, answer: answers[answer.mock.calls.length - 1]! }));
  let saved: any; const review = vi.fn(async () => false);
  await expect(generateModelReadWorkload({ ...setup(send), clarificationHandler: answer, clarificationReplacementHandler: review,
   onCheckpoint: async v => { saved = structuredClone(v); } })).rejects.toThrow("READ_WORKLOAD_AUTHORING_PAUSED");
  expect(send.mapping).toHaveBeenCalledTimes(3); expect(send.wording).toHaveBeenCalledOnce(); expect(send).toHaveBeenCalledTimes(4); expect(answer).toHaveBeenCalledTimes(3); expect(review).toHaveBeenCalledOnce();
  expect(saved.state.clarified_targets.map((v: any) => ({ field: v.field, answer: v.answer }))).toEqual([{ field: undefined, answer: answers[0] }, { field: "status", answer: answers[1] }]);
  expect(saved.pending_question.request).toEqual(followup); expect(saved.pending_question.replacement).toMatchObject({ previous_index: 1, proposed_answer: answers[2] });
  const noSend = vi.fn(), noAnswer = vi.fn(async () => undefined), noReview = vi.fn(async () => false);
  await expect(generateModelReadWorkload({ ...setup(noSend), resumeCheckpoint: saved, clarificationHandler: noAnswer,
   clarificationReplacementHandler: noReview, onCheckpoint: async () => {} })).rejects.toThrow("READ_WORKLOAD_AUTHORING_PAUSED");
  expect(noSend).not.toHaveBeenCalled(); expect(noAnswer).not.toHaveBeenCalled(); expect(noReview).toHaveBeenCalledOnce();
 });

 it("does not choose one conflicting current root definition to bypass clarification", async () => {
  const send = scriptedQuestions(() => fieldQuestion); const answer = vi.fn(async (_q: any) => undefined);
  await expect(generateModelReadWorkload({ ...setup(send), operatorNamingContext: "public.tbl_7 is the parcel register.\npublic.tbl_7 is the refund register.", clarificationHandler: answer })).rejects.toThrow("READ_WORKLOAD_AUTHORING_PAUSED");
  expect(answer).toHaveBeenCalledOnce(); expect(answer.mock.calls[0]![0].field).toBeUndefined(); expect(send.mapping).toHaveBeenCalledOnce(); expect(send.wording).toHaveBeenCalledOnce(); expect(send).toHaveBeenCalledTimes(2);
 });
 it.each(["source", "boundary"])("refuses a retained root-to-field checkpoint after %s drift before any generation", async kind => {
  const send = scriptedQuestions(() => fieldQuestion); let saved: any;
  const answer = vi.fn(async (_q: any) => answer.mock.calls.length === 1 ? { state: "answered" as const, answer: "The parcel register is tbl_7." } : undefined);
  await expect(generateModelReadWorkload({ ...setup(send), clarificationHandler: answer, onCheckpoint: async v => { saved = structuredClone(v); } })).rejects.toThrow("READ_WORKLOAD_AUTHORING_PAUSED");
  const before = structuredClone(saved), noSend = vi.fn(), noAnswer = vi.fn(async () => undefined); const input = setup(noSend);
  if (kind === "boundary") input.generatedBoundary.generation_lock_fingerprint = `sha256:${"9".repeat(64)}`;
  await expect(generateModelReadWorkload({ ...input, ...(kind === "source" ? { operatorNamingContext: "Changed current job statement." } : {}),
   resumeCheckpoint: saved, clarificationHandler: noAnswer })).rejects.toThrow("READ_WORKLOAD_ASSISTANCE_CHECKPOINT_STALE");
  expect(noSend).not.toHaveBeenCalled(); expect(noAnswer).not.toHaveBeenCalled(); expect(saved).toEqual(before);
 });

});
