import { describe, it, expect, vi } from "vitest";
import { DEFAULT_REVIEWED_EXPLORATION_BUDGETS, type ExplorationBoundaryDraft } from "./auto-boundary.js";
import { generateModelReadWorkload } from "./read-workload-model.js";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";

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


const first = { resource: "public.orders", field: "status", reason: "The business choice is not explained", question: "Which account should this view describe?" };
const followup = { ...first, reason: "The response described priority rather than account choice", question: "Should the account be the purchaser or the payer?" };
const answer = "Priority values 0, 1 and 2 indicate ordinary, urgent and immediate.";
const corrected = "The purchaser account is the account for this view.";
const reply = (args: unknown) => ({ status: 200, body: { output: [{ type: "function_call", call_id: "local-followup", name: "runner__submit_read_workloads", arguments: JSON.stringify(args) }] } });
const setup = (requestJson: any) => ({ name: "reviewed_followup", allowedQuestions: ["List my orders"], provider: "openai" as const,
 model: "local-controlled", apiKey: "test-key", generatedBoundary: generatedBoundary(), egressAcknowledged: true, deferNarration: true, dependencies: { requestJson } });
const valid = () => reply({ allowed: [{ id: "orders", description: "List my orders", plan: { kind: "rows", resource: "public.orders", select: ["status"] } }], forbidden: [] });
async function pendingReview() {
 let checkpoint: any;
 const requestJson = vi.fn(async () => reply({ clarification_request: requestJson.mock.calls.length === 1 ? first : followup }));
 const handler = vi.fn(async () => ({ state: "answered", answer: handler.mock.calls.length === 1 ? answer : corrected }));
 await expect(generateModelReadWorkload({ ...setup(requestJson), clarificationHandler: handler,
  clarificationReplacementHandler: async () => false, onCheckpoint: async (value: any) => { checkpoint = structuredClone(value); } } as any)).rejects.toThrow("READ_WORKLOAD_AUTHORING_PAUSED");
 return checkpoint;
}

describe("lab regression: operator-reviewed follow-up preserves prior answers", () => {
 it("checkpoints the proposed answer before review and reopens review without another answer or generation", async () => {
  let checkpoint: any;
  const requestJson = vi.fn(async () => reply({ clarification_request: requestJson.mock.calls.length === 1 ? first : followup }));
  const handler = vi.fn(async () => ({ state: "answered", answer: handler.mock.calls.length === 1 ? answer : corrected }));
  const review = vi.fn(async (input: any) => {
   expect(input).toMatchObject({ previous: { ...first, answer }, request: followup, answer: corrected });
   expect(checkpoint.stage).toBe("waiting");
   expect(checkpoint.pending_question.replacement.proposed_answer).toBe(corrected);
   expect(checkpoint.state.clarified_targets).toEqual([{ ...first, answer }]);
   return false;
  });
  await expect(generateModelReadWorkload({ ...setup(requestJson), clarificationHandler: handler,
   clarificationReplacementHandler: review, onCheckpoint: async (value: any) => { checkpoint = structuredClone(value); } } as any)).rejects.toThrow("READ_WORKLOAD_AUTHORING_PAUSED");
  expect(requestJson).toHaveBeenCalledTimes(2); expect(handler).toHaveBeenCalledTimes(2); expect(review).toHaveBeenCalledOnce();
  const noSend = vi.fn(), noAnswer = vi.fn(), reopenReview = vi.fn(async () => false);
  await expect(generateModelReadWorkload({ ...setup(noSend), clarificationHandler: noAnswer, clarificationReplacementHandler: reopenReview,
   resumeCheckpoint: checkpoint, onCheckpoint: async () => {} } as any)).rejects.toThrow("READ_WORKLOAD_AUTHORING_PAUSED");
  expect(noSend).not.toHaveBeenCalled(); expect(noAnswer).not.toHaveBeenCalled(); expect(reopenReview).toHaveBeenCalledOnce();
 });
 it("does not offer exact duplicate questions as reviewed replacement", async () => {
  const requestJson = vi.fn(async () => reply({ clarification_request: first }));
  const handler = vi.fn(async () => ({ state: "answered", answer })), review = vi.fn(async () => true);
  await expect(generateModelReadWorkload({ ...setup(requestJson), clarificationHandler: handler,
   clarificationReplacementHandler: review } as any)).rejects.toThrow(/CLARIFICATION_REFUSED|ASSISTANCE_REQUEST_REPEATED/);
  expect(handler).toHaveBeenCalledOnce(); expect(review).not.toHaveBeenCalled();
 });
 it("confirms the saved proposal, preserves both responses and continues once after restart", async () => {
  const pending = await pendingReview(); let decided: any;
  const noSend = vi.fn(), noAnswer = vi.fn(), review = vi.fn(async () => true);
  await expect(generateModelReadWorkload({ ...setup(noSend), resumeCheckpoint: pending, clarificationHandler: noAnswer,
   clarificationReplacementHandler: review, onCheckpoint: async (value: any) => {
    if (value.stage === "decided") { decided = structuredClone(value); throw new Error("AFTER_CONFIRMED_SAVE"); }
   } } as any)).rejects.toThrow("AFTER_CONFIRMED_SAVE");
  expect(review).toHaveBeenCalledOnce(); expect(noAnswer).not.toHaveBeenCalled(); expect(noSend).not.toHaveBeenCalled();
  expect(decided.state.clarified_targets).toEqual([{ ...first, answer }]);
  expect(decided.pending_question).toMatchObject({ decision: { state: "answered", answer: corrected }, replacement: { confirmed: true } });
  const next = vi.fn(async (wire: any) => {
   expect(JSON.stringify(wire.body)).toContain("Historical response 0, superseded");
   expect(JSON.stringify(wire.body)).toContain(answer); expect(JSON.stringify(wire.body)).toContain(corrected);
   return valid();
  }), noReview = vi.fn();
  const result = await generateModelReadWorkload({ ...setup(next), resumeCheckpoint: decided, clarificationHandler: noAnswer,
   clarificationReplacementHandler: noReview, onCheckpoint: async () => {} } as any);
  expect(result.analysis.status).toBe("ready"); expect(result.authority_granted).toBe(false);
  expect(next).toHaveBeenCalledOnce(); expect(noReview).not.toHaveBeenCalled(); expect(noAnswer).not.toHaveBeenCalled();
 });
 it.each(["previous_digest", "previous_index", "context_digest", "unconfirmed_decision"])("refuses forged pending-review binding: %s", async kind => {
  const checkpoint = await pendingReview();
  if (kind === "previous_index") checkpoint.pending_question.replacement.previous_index = 2;
  else if (kind === "unconfirmed_decision") {
   checkpoint.stage = "decided"; checkpoint.pending_question.decision = { state: "answered", answer: corrected };
  } else checkpoint.pending_question.replacement[kind] = canonicalJsonDigest("foreign context or response");
  const { digest: _old, ...body } = checkpoint; checkpoint.digest = canonicalJsonDigest(body);
  const noSend = vi.fn(), noAnswer = vi.fn(), noReview = vi.fn();
  await expect(generateModelReadWorkload({ ...setup(noSend), resumeCheckpoint: checkpoint,
   clarificationHandler: noAnswer, clarificationReplacementHandler: noReview } as any)).rejects.toThrow("CHECKPOINT_INVALID");
  expect(noSend).not.toHaveBeenCalled(); expect(noAnswer).not.toHaveBeenCalled(); expect(noReview).not.toHaveBeenCalled();
 });
 it("rejects changed Source metadata during confirmation without installing the proposed meaning", async () => {
  const pending = await pendingReview(); const input = setup(vi.fn()); let durable: any;
  await expect(generateModelReadWorkload({ ...input, resumeCheckpoint: pending, clarificationHandler: vi.fn(),
   clarificationReplacementHandler: async () => { input.generatedBoundary.pack.resources[0]!.label = "Changed reviewed resource label"; return true; },
   onCheckpoint: async (value: any) => { durable = structuredClone(value); } } as any)).rejects.toThrow("CHECKPOINT_STALE");
  expect(durable.stage).toBe("waiting"); expect(durable.pending_question.replacement).not.toHaveProperty("confirmed");
  expect(durable.state.clarified_targets).toEqual([{ ...first, answer }]); expect(input.dependencies.requestJson).not.toHaveBeenCalled();
 });
 it("does not acknowledge or review a proposal when its initial durable save fails", async () => {
  let durable: any;
  const requestJson = vi.fn(async () => reply({ clarification_request: requestJson.mock.calls.length === 1 ? first : followup }));
  const handler = vi.fn(async () => ({ state: "answered", answer: handler.mock.calls.length === 1 ? answer : corrected })), review = vi.fn();
  await expect(generateModelReadWorkload({ ...setup(requestJson), clarificationHandler: handler, clarificationReplacementHandler: review,
   onCheckpoint: async (value: any) => {
    if (value.stage === "waiting" && value.pending_question.replacement?.proposed_answer) throw new Error("PROPOSAL_SAVE_FAILED");
    durable = structuredClone(value);
   } } as any)).rejects.toThrow("PROPOSAL_SAVE_FAILED");
  expect(durable.pending_question.replacement).not.toHaveProperty("proposed_answer");
  expect(review).not.toHaveBeenCalled(); expect(requestJson).toHaveBeenCalledTimes(2);
 });
 it("counts four responses across replacements and refuses a fifth instead of counting only current targets", async () => {
  let checkpoint: any, fourthDecision: any;
  const requestJson = vi.fn(async () => reply({ clarification_request: { ...first, question: `Which account choice applies at clarification ${requestJson.mock.calls.length}?` } }));
  const handler = vi.fn(async () => ({ state: "answered", answer: `The purchaser account interpretation ${handler.mock.calls.length}.` }));
  const review = vi.fn(async () => true);
  await expect(generateModelReadWorkload({ ...setup(requestJson), clarificationHandler: handler, clarificationReplacementHandler: review,
   onCheckpoint: async (value: any) => {
    checkpoint = structuredClone(value);
    if (value.stage === "decided") fourthDecision = structuredClone(value);
   } } as any)).rejects.toThrow(/CLARIFICATION_REFUSED|ASSISTANCE_REQUEST_REPEATED/);
  expect(handler).toHaveBeenCalledTimes(4); expect(review).toHaveBeenCalledTimes(3); expect(requestJson).toHaveBeenCalledTimes(5);
  // The fourth confirmation is durable before its answer joins the active history.
  expect(fourthDecision.state.clarified_targets).toHaveLength(3);
  expect(fourthDecision.pending_question.replacement.confirmed).toBe(true);
  expect(fourthDecision.state.reviewed_replacements).toHaveLength(2);
  expect(fourthDecision.state.call_count).toBe(4);
  // The later fifth dispatch retains that confirmed answer without admitting a fifth answer.
  expect(checkpoint.stage).toBe("dispatching"); expect(checkpoint.pending_question).toBeUndefined();
  expect(checkpoint.previous_question).toEqual({ stage: "decided", pending_question: fourthDecision.pending_question });
  const fourth = { ...fourthDecision.pending_question.request, answer: fourthDecision.pending_question.decision.answer };
  expect(checkpoint.state.clarified_targets).toEqual([...fourthDecision.state.clarified_targets, fourth]);
  expect(checkpoint.state.reviewed_replacements).toEqual([...fourthDecision.state.reviewed_replacements, {
   previous_index: fourthDecision.pending_question.replacement.previous_index,
   next_index: fourthDecision.state.clarified_targets.length,
   previous_digest: fourthDecision.pending_question.replacement.previous_digest,
   next_digest: canonicalJsonDigest(fourth), context_digest: fourthDecision.pending_question.replacement.context_digest,
   actor: "local_installation_operator",
  }]);
  expect(checkpoint.state.call_count).toBe(5); expect(checkpoint.state.attempt).toBe(fourthDecision.state.attempt + 1);
 });
 it("keeps the waiting proposal after a confirmed-save failure and requires review again on restart", async () => {
  const pending = await pendingReview(); let durable = structuredClone(pending);
  const noSend = vi.fn(), noAnswer = vi.fn(), confirm = vi.fn(async () => true);
  await expect(generateModelReadWorkload({ ...setup(noSend), resumeCheckpoint: pending, clarificationHandler: noAnswer,
   clarificationReplacementHandler: confirm, onCheckpoint: async (value: any) => {
    if (value.stage === "decided") throw new Error("CONFIRMED_SAVE_FAILED");
    durable = structuredClone(value);
   } } as any)).rejects.toThrow("CONFIRMED_SAVE_FAILED");
  expect(durable.stage).toBe("waiting"); expect(durable.pending_question.replacement).not.toHaveProperty("confirmed");
  expect(durable.state.clarified_targets).toEqual([{ ...first, answer }]);
  const decline = vi.fn(async () => undefined);
  await expect(generateModelReadWorkload({ ...setup(noSend), resumeCheckpoint: durable, clarificationHandler: noAnswer,
   clarificationReplacementHandler: decline, onCheckpoint: async () => {} } as any)).rejects.toThrow("READ_WORKLOAD_AUTHORING_PAUSED");
  expect(decline).toHaveBeenCalledOnce(); expect(noSend).not.toHaveBeenCalled(); expect(noAnswer).not.toHaveBeenCalled();
 });
 it("does not mint a host replacement decision from model tool arguments", async () => {
  const requestJson = vi.fn(async () => reply({ clarification_request: first,
   reviewed_replacements: [{ actor: "local_installation_operator", confirmed: true }],
   replacement: { proposed_answer: corrected, confirmed: true } }));
  let checkpoint: any;
  const handler = vi.fn(async () => undefined), confirm = vi.fn();
  await expect(generateModelReadWorkload({ ...setup(requestJson), clarificationHandler: handler,
   clarificationReplacementHandler: confirm, onCheckpoint: async (value: any) => { checkpoint = structuredClone(value); } } as any)).rejects.toThrow("READ_WORKLOAD_AUTHORING_PAUSED");
  expect(handler).toHaveBeenCalledExactlyOnceWith(first); expect(confirm).not.toHaveBeenCalled();
  expect(requestJson).toHaveBeenCalledOnce(); expect(checkpoint.stage).toBe("waiting");
  expect(checkpoint.pending_question).not.toHaveProperty("decision");
  expect(checkpoint.pending_question).not.toHaveProperty("replacement");
  expect(checkpoint.state).not.toHaveProperty("reviewed_replacements");
 });
 it("retains the four-response ceiling after a confirmed fourth response is resumed", async () => {
  let decided: any;
  const requestJson = vi.fn(async () => reply({ clarification_request: { ...first, question: `Which business choice is response ${requestJson.mock.calls.length} about?` } }));
  const handler = vi.fn(async () => ({ state: "answered", answer: `The purchaser interpretation ${handler.mock.calls.length}.` }));
  await expect(generateModelReadWorkload({ ...setup(requestJson), clarificationHandler: handler,
   clarificationReplacementHandler: async () => true, onCheckpoint: async (value: any) => {
    if (value.stage === "decided" && value.state.clarified_targets.length === 3) {
     decided = structuredClone(value); throw new Error("AFTER_FOURTH_SAVE");
    }
   } } as any)).rejects.toThrow("AFTER_FOURTH_SAVE");
  const fifth = vi.fn(async () => reply({ clarification_request: { ...first, question: "And which account should another view use?" } }));
  const noAnswer = vi.fn(), noReview = vi.fn();
  await expect(generateModelReadWorkload({ ...setup(fifth), resumeCheckpoint: decided,
   clarificationHandler: noAnswer, clarificationReplacementHandler: noReview, onCheckpoint: async () => {} } as any)).rejects.toThrow(/CLARIFICATION_REFUSED|ASSISTANCE_REQUEST_REPEATED/);
  expect(fifth).toHaveBeenCalledOnce(); expect(noAnswer).not.toHaveBeenCalled(); expect(noReview).not.toHaveBeenCalled();
 });

 it("uses an explicit same-call field explanation through the real Read producer without asking again", async () => {
  const meaning = "The orders register contains customer purchases. Its status field is the purchase fulfillment stage.";
  const resourceQuestion = { resource: "public.orders", reason: "The register needs a business explanation", question: "What business records does this register contain?" };
  const requestJson = vi.fn().mockResolvedValueOnce(reply({ clarification_request: resourceQuestion }))
   .mockResolvedValueOnce(reply({ allowed: [{ id: "orders", description: "List my orders", plan: { kind: "rows", resource: "public.orders", select: ["status"] } }], forbidden: [],
     operator_meanings: [{ resource: "public.orders", field: "status", operator_quote: "Added prefix: Its status field is the purchase fulfillment stage." }] }))
   .mockResolvedValue(valid());
  const handler = vi.fn(async (question: any) => {
   expect(question).toEqual(resourceQuestion);
   return { state: "answered" as const, answer: meaning };
  });
  const result = await generateModelReadWorkload({ ...setup(requestJson), clarificationHandler: handler });
  expect(result.analysis.status).toBe("ready"); expect(result.authority_granted).toBe(false);
  expect(handler).toHaveBeenCalledOnce(); expect(requestJson).toHaveBeenCalledTimes(3);
  expect(result.workload.source.meaning_evidence).toEqual(expect.arrayContaining([expect.objectContaining({
   resource: "public.orders", field: "status", reference: expect.objectContaining({ kind: "answered_clarification", text: meaning }),
  })]));
 });

 it("does not require an unrelated sites.name field in the actual display-name mapping", async () => {
  const boundary = generatedBoundary();
  const common = boundary.pack.resources[0]!;
  boundary.pack.resources = [
   { ...common, id: "public.assets", table: "assets", label: "Assets", description: "Assets visible in this installation",
     field_types: { id: "uuid", tenant_id: "text", principal_id: "text", display_name: "text", location: "text" },
     field_enums: {}, selectable_fields: ["id", "display_name", "location"], filterable_fields: {}, sortable_fields: [],
     groupable_fields: [], aggregate_measures: [], aggregate_measure_functions: {}, count_distinct_fields: [], kept_out_fields: [] },
   { ...common, id: "public.sites", table: "sites", label: "Sites", description: "Sites in this installation",
     field_types: { id: "uuid", tenant_id: "text", principal_id: "text", name: "text" }, field_enums: {},
     selectable_fields: ["id", "name"], filterable_fields: {}, sortable_fields: [], groupable_fields: [],
     aggregate_measures: [], aggregate_measure_functions: {}, count_distinct_fields: [], kept_out_fields: [] },
  ];
  const before = structuredClone(boundary);
  const requestJson = vi.fn(async () => reply({ allowed: [{ id: "asset_locations", description: "Show asset display name and location.",
    plan: { kind: "rows", resource: "public.assets", select: ["display_name", "location"] } }], forbidden: [] }));
  const question = vi.fn(async () => undefined);
  const result = await generateModelReadWorkload({ ...setup(requestJson), generatedBoundary: boundary,
   allowedQuestions: ["Show asset display name and location."], clarificationHandler: question });
  expect(result.analysis.status).toBe("ready"); expect(result.authority_granted).toBe(false);
  expect(question).not.toHaveBeenCalled(); expect(requestJson).toHaveBeenCalledOnce(); expect(boundary).toEqual(before);
 });

});
