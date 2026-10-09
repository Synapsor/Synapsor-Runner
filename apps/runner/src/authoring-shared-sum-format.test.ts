import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { Ajv2020 } from "ajv/dist/2020.js";
import { parseSharedSumDesignation } from "@synapsor-runner/action-rules";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { parseOperatorQuestion, parseOperatorQuestions, assertOperatorQuestionsAdvance, proposeOperatorAnswer, confirmOperatorAnswer, operatorQuestionReadback } from "./authoring-operator-question.js";
import { actionRuleModelDraftJsonSchema, generateModelActionRuleDraft, actionRuleModelDraftFromCheckpoint } from "./action-rule-model.js";
import { parseActionRuleModelDraftProposal, retainSharedSumProposal } from "./action-rule-draft.js";
import { parseSharedSumQuestionBinding } from "./authoring-shared-sum-binding.js";
import { prepareSharedSumOperatorQuestion, assertSharedSumQuestionDependencies, projectReviewedSharedSumQuestion } from "./authoring-shared-sum-question.js";
import { structuredTestAction } from "./structured-authoring-test-fixture.js";
import { values, catalog, boundary, readDigest } from "./test-fixtures/typed-action-parameter.js";
import { parseStructuredActionDraft } from "./boundary-structured-authoring.js";
import { manualSemanticActionDraft } from "./manual-semantic-action-editor.js";
import { actionRuleAuthoringCheckpoint, actionLogicalTurnMaterialDigest, type ActionRuleAuthoringCheckpoint } from "./action-rule-authoring-checkpoint.js";
import { authoringActionCheckpoint, configureAuthoringGenerationRecovery, withAuthoringGenerationRecovery, type AuthoringTransportState } from "./authoring-generation-recovery.js";
import { STRUCTURED_AUTHORING_PROTOCOL_VERSION } from "./authoring-protocol.js";
import { experimentalSharedSumFixture } from "../../../packages/action-rules/src/testing/experimental-shared-sum-fixture.js";

function sharedSumQuestionFixture() {
  const f = experimentalSharedSumFixture();
  const { schema_version: _version, kind: _kind, ...fields } = f.designation;
  const designation = parseSharedSumDesignation({ ...fields, schema_version: "synapsor.shared-sum-designation.v1", kind: "shared_sum",
    unit: { kind: "integer", unit: "reviewed_credits", meaning: "One credit is one reviewed service unit." } });
  const hash = f.catalog.generation_lock_fingerprint, id = randomUUID();
  const components = { verification: { name: "shared.verify", resources: [] }, effect: { name: "shared.effect" },
    rule: { name: "shared.credit", outcome: "shared.credit", shared_sum_proposal: designation }, approval: { class_name: "shared.approval" } };
  const binding = parseSharedSumQuestionBinding({ version: 1, designation,
    dependencies: { context_digest: hash, source_digest: hash, catalog_digest: canonicalJsonDigest(f.authority.authority.catalog),
      generation_lock_fingerprint: hash, read_dependencies: [{ name: "shared.read", digest: hash }],
      participating_outcomes: ["shared.credit", "shared.limit", "shared.waiver"] },
    origin: { completion: { operation_id: randomUUID(), request_digest: hash, context_digest: hash, response_digest: hash },
      material: { intent_digest: hash, context_digest: hash, components, question: null } } });
  const body = { version: 3, id, revision: 1, kind: "shared_sum", shared_sum: binding,
    scope_digest: canonicalJsonDigest(designation), context_digest: hash,
    target: { phase: "shared_sum", outcomes: binding.dependencies.participating_outcomes }, material: [], evidence: [], continuation: "action_rule_review" };
  return { f, designation, binding, question: { ...body, digest: canonicalJsonDigest(body) } };
}

describe("shared-SUM proposal and typed Question format", () => {
  it("accepts a closed unreviewed v2 Action proposal and preserves legacy v1", () => {
    const { designation } = sharedSumQuestionFixture();
    const legacy = structuredTestAction("shared.credit", "amount", 500, 200);
    const schema = new Ajv2020({ strict: false, allErrors: true }).compile(actionRuleModelDraftJsonSchema());
    expect(schema(legacy), JSON.stringify(schema.errors)).toBe(true);
    expect(schema({ ...legacy, schema_version: "synapsor.action-rule-model-draft.v2", shared_sum_proposal: designation }), JSON.stringify(schema.errors)).toBe(true);
  });
  it("parses the v3 typed Question without inventing raw operator testimony", () => {
    const { question } = sharedSumQuestionFixture();
    expect(parseOperatorQuestion(question)).toEqual(question);
    expect(question).not.toHaveProperty("raw_answer");
  });
  it("uses existing proposal and separate confirmation handlers for exact typed meaning", () => {
    const { question, designation, binding } = sharedSumQuestionFixture();
    const q = parseOperatorQuestion(question);
    const proposed = proposeOperatorAnswer(q, { question_id: q.id, revision: q.revision,
      source_reference: canonicalJsonDigest(binding), disposition: "proposed", value: { kind: "shared_sum", designation } });
    expect(proposed.confirmation).toBeUndefined();
    const confirmed = confirmOperatorAnswer(proposed);
    expect(confirmed.confirmation?.proposal_digest).toBe(canonicalJsonDigest(confirmed.proposal));
    expect(confirmed.confirmation?.decision).toBe("new_attributed_decision");
  });
  it("renders exact populations, limit, units and participating actions in host readback", () => {
    const { question, designation, binding } = sharedSumQuestionFixture();
    const q = parseOperatorQuestion(question);
    const proposed = proposeOperatorAnswer(q, { question_id: q.id, revision: q.revision,
      source_reference: canonicalJsonDigest(binding), disposition: "proposed", value: { kind: "shared_sum", designation } });
    const lines = operatorQuestionReadback(proposed).join("\n");
    for (const value of [designation.limit.resource, designation.populations[0]!.resource, designation.populations[1]!.resource,
      "reviewed_credits", "shared.credit", "shared.waiver", "current", "refused"]) expect(lines).toContain(value);
  });
  it("refuses model authority/provenance, malformed descriptors and legacy field smuggling", () => {
    const { designation } = sharedSumQuestionFixture(), legacy = structuredTestAction("credit", "amount", 500, 200);
    const proposed = { ...legacy, schema_version: "synapsor.action-rule-model-draft.v2" as const, shared_sum_proposal: designation };
    const validator = new Ajv2020({ strict: false }).compile(actionRuleModelDraftJsonSchema());
    for (const forged of [ { ...legacy, shared_sum_proposal: designation }, { ...proposed, confirmation: { actor: "local_installation_operator" } },
      { ...proposed, shared_sum: { designation, confirmation: { decision: "new_attributed_decision" } } },
      { ...proposed, shared_sum_proposal: { ...designation, confirmed: true } }, { ...proposed, shared_sum_proposal: { ...designation, unit: { ...designation.unit, actor: "operator" } } },
      { ...proposed, shared_sum_proposal: undefined } ]) expect(validator(forged)).toBe(false);
    expect(() => parseActionRuleModelDraftProposal({ ...legacy, shared_sum_proposal: designation })).toThrow();
    expect(parseActionRuleModelDraftProposal(proposed).shared_sum_proposal).toEqual(designation);
    expect(parseStructuredActionDraft(proposed, 0).shared_sum_proposal).toEqual(designation);
    expect(() => parseStructuredActionDraft({ ...legacy, shared_sum_proposal: designation }, 0)).toThrow("SHAPE_INVALID");
    const checkpoint = new Ajv2020({ strict: false }).compile(actionRuleModelDraftJsonSchema({ purpose: "compiled_checkpoint" }));
    expect(checkpoint({ ...proposed, review: { ...proposed.review, examples: [] } })).toBe(true);
    expect(validator({ ...proposed, review: { ...proposed.review, examples: [] } })).toBe(false);
  });
  it("retains an existing invariant's proposal on omission and refuses a changed unit meaning", () => {
    const { designation } = sharedSumQuestionFixture(), legacy = structuredTestAction("credit", "amount", 500, 200);
    const baseline = { ...legacy, schema_version: "synapsor.action-rule-model-draft.v2" as const, shared_sum_proposal: designation };
    expect(retainSharedSumProposal(baseline, legacy).shared_sum_proposal).toEqual(designation);
    expect(() => retainSharedSumProposal(baseline, { ...baseline, shared_sum_proposal: { ...designation, unit: { ...designation.unit, meaning: "Changed meaning" } } })).toThrow();
    expect(baseline.shared_sum_proposal).toEqual(designation);
  });
  it("projects only the separately confirmed exact Question and inspected dependency tuple", () => {
    const { binding, designation } = sharedSumQuestionFixture(), q = prepareSharedSumOperatorQuestion({ binding });
    expect(() => projectReviewedSharedSumQuestion(q)).toThrow("UNCONFIRMED");
    const proposed = proposeOperatorAnswer(q, { question_id: q.id, revision: q.revision, source_reference: canonicalJsonDigest(binding), disposition: "proposed", value: { kind: "shared_sum", designation } });
    expect(() => projectReviewedSharedSumQuestion(proposed)).toThrow("UNCONFIRMED");
    const confirmed = confirmOperatorAnswer(proposed), record = projectReviewedSharedSumQuestion(confirmed);
    expect(record.confirmation.question).toEqual({ id: q.id, revision: q.revision, digest: confirmed.digest });
    expect(record.confirmation.proposal_digest).toBe(canonicalJsonDigest(proposed.proposal));
    expect(record.confirmation.read_dependencies).toEqual(binding.dependencies.read_dependencies);
    expect(record.confirmation.source_digest).toBe(binding.dependencies.source_digest);
    expect(() => assertSharedSumQuestionDependencies(confirmed, binding.dependencies)).not.toThrow();
    for (const key of ["context_digest", "source_digest", "catalog_digest", "generation_lock_fingerprint"] as const)
      expect(() => assertSharedSumQuestionDependencies(confirmed, { ...binding.dependencies, [key]: canonicalJsonDigest(key) })).toThrow("CHANGED");
    expect(() => assertSharedSumQuestionDependencies(confirmed, { ...binding.dependencies, read_dependencies: [] })).toThrow("CHANGED");
    expect(() => assertSharedSumQuestionDependencies(confirmed, { ...binding.dependencies, participating_outcomes: ["different.action"] })).toThrow("CHANGED");
  });
  it("does not borrow descriptor-only identity, testimony or a different proposal to confirm", () => {
    const { binding, designation } = sharedSumQuestionFixture(), q = prepareSharedSumOperatorQuestion({ binding });
    const seal = (extra: Record<string, unknown>) => { const { digest: _, ...body } = { ...q, ...extra }; return { ...body, digest: canonicalJsonDigest(body) }; };
    expect(() => parseOperatorQuestion(seal({ raw_answer: { text: "Yes" } }))).toThrow();
    expect(() => parseOperatorQuestion(seal({ version: 2 }))).toThrow();
    expect(() => parseSharedSumQuestionBinding({ ...binding, origin: { ...binding.origin, material: { designation } } })).toThrow();
    expect(() => parseOperatorQuestions([q], [])).toThrow();
    expect(() => proposeOperatorAnswer(q, { question_id: q.id, revision: q.revision, source_reference: canonicalJsonDigest(designation), disposition: "proposed", value: { kind: "shared_sum", designation } })).toThrow();
    expect(() => proposeOperatorAnswer(q, { question_id: q.id, revision: q.revision, source_reference: canonicalJsonDigest(binding), disposition: "proposed", value: { kind: "shared_sum", designation: { ...designation, unit: { ...designation.unit, meaning: "Other meaning" } } } })).toThrow();
    const proposed = proposeOperatorAnswer(q, { question_id: q.id, revision: q.revision, source_reference: canonicalJsonDigest(binding), disposition: "proposed", value: { kind: "shared_sum", designation } });
    const confirmed = confirmOperatorAnswer(proposed);
    expect(() => assertOperatorQuestionsAdvance([confirmed], [proposed])).toThrow();
    expect(() => assertOperatorQuestionsAdvance([q], [prepareSharedSumOperatorQuestion({ id: q.id, binding: { ...binding, dependencies: { ...binding.dependencies, source_digest: canonicalJsonDigest("changed") } } })])).toThrow();
  });

});


// Controlled native decoder/journal fixture. This establishes format custody
// only: the unrelated warehouse Source never qualifies this E3 designation.
async function nativeProposalFixture(omitProposalOnRevision = false) {
  const f = sharedSumQuestionFixture(), declared = manualSemanticActionDraft(values());
  declared.review.examples.push({ kind: "ineligible", scenario: "Disabled item", result: "Refuse." });
  const draft = { ...declared, schema_version: "synapsor.action-rule-model-draft.v2" as const, shared_sum_proposal: f.designation };
  const { verification, effect, approval, schema_version: _, ...rule } = draft;
  const steps = [{ name: "runner__submit_verification_boundary_draft", args: { status: "draft", ...verification } },
    { name: "runner__submit_effect_envelope_draft", args: { status: "draft", ...effect } },
    { name: "runner__submit_action_rule_draft", args: { status: "draft", ...rule } },
    { name: "runner__submit_approval_policy_draft", args: { status: "draft", ...approval } },
    { name: "runner__validate_action_draft", args: {} }];
  if (omitProposalOnRevision) {
    steps.splice(0, 2); steps.splice(1, 1);
    const args = steps[0]!.args as Record<string, unknown>; delete args.shared_sum_proposal; args.changed_fields = ["review.examples"];
  }
  let generation: AuthoringTransportState | undefined, checkpoint: ActionRuleAuthoringCheckpoint | undefined, calls = 0;
  await withAuthoringGenerationRecovery(async () => {
    configureAuthoringGenerationRecovery({ available: () => true, read: () => generation, current: async () => canonicalJsonDigest("native-format-context"),
      write: async next => { generation = structuredClone(next); } });
    const result = await generateModelActionRuleDraft({ builtCatalog: catalog(), readBoundary: boundary(), readBoundaryDigest: readDigest,
      intent: "Prepare proposals setting enabled warehouse items' reorder threshold to a requested integer from 1 to 1000. Auto-approve at most 100; otherwise one warehouse_reviewer. Overall 10 and per customer 3 approvals per 86400 seconds. Expire requests after 300 seconds. Proposal only; no execution.",
      ...(omitProposalOnRevision ? { existingDraft: draft } : {}),
      authoringProtocol: { version: STRUCTURED_AUTHORING_PROTOCOL_VERSION }, egressAcknowledged: true, expectedOutcome: draft.outcome, deferCompletionMessage: true,
      session: { provider: "openai", model: "controlled-native-format", apiKey: "inert-local-credential", dependencies: { requestJson: async () => {
        const next = steps.shift(); if (!next) throw new Error("Finite fixture exhausted"); calls++;
        return { status: 200, body: { output: [{ type: "function_call", call_id: `format_${calls}`, name: next.name, arguments: JSON.stringify(next.args) }] } };
      } } }, stageVersionQuestion: () => { throw new Error("No Version question declared"); }, reviewVersionQuestion: async () => { throw new Error("No Version review declared"); },
      assertLogicalTurnBoundary: async () => { throw new Error("No rollover declared"); },
      onCheckpoint: async (next, metadata) => {
        expect(metadata?.expected_checkpoint_digest).toBe(checkpoint?.digest);
        if (metadata?.ordinary_completion) {
          const closed = metadata.ordinary_completion;
          expect(closed.kind).toBe("compiled_draft");
          generation = authoringActionCheckpoint(generation!, closed.completion, { consumer: "action_rule_components", kind: "compiled_draft", material_digest: closed.material_digest });
        }
        checkpoint = structuredClone(next);
      } });
    expect(result.state).toBe("ready"); expect(calls).toBe(omitProposalOnRevision ? 2 : 5); expect(steps).toHaveLength(0);
  });
  const saved = checkpoint!, closed = saved.logical_turns!.at(-1)!.completed!;
  expect(actionRuleModelDraftFromCheckpoint(saved).shared_sum_proposal).toEqual(f.designation);
  const binding = parseSharedSumQuestionBinding({ ...f.binding, dependencies: { ...f.binding.dependencies, participating_outcomes: [draft.outcome] },
    origin: { completion: closed.completion, material: { intent_digest: saved.intent_digest, context_digest: saved.context_digest, components: saved.components,
      question: saved.pending_question ? { question: saved.pending_question.question, operator_message: saved.pending_question.operator_message, policy_source_digest: saved.pending_question.policy_source_digest ?? null } : null } } });
  expect(canonicalJsonDigest(binding.origin.material)).toBe(actionLogicalTurnMaterialDigest(saved));
  return { binding, generation: generation!, checkpoint: saved };
}

describe("shared-SUM existing native compiled origin", () => {
  it("keeps the existing descriptor in the real saved Rule component when a model revision omits it", async () => {
    const f = await nativeProposalFixture(true);
    expect(f.checkpoint.components.rule!.shared_sum_proposal).toEqual(f.binding.designation);
    expect(actionRuleModelDraftFromCheckpoint(f.checkpoint).shared_sum_proposal).toEqual(f.binding.designation);
  });
  it("round trips a real Rule decoder/checkpoint and exact typed confirmation history", async () => {
    const f = await nativeProposalFixture(), initial = prepareSharedSumOperatorQuestion({ binding: f.binding });
    const cold = JSON.parse(JSON.stringify({ questions: [initial], generation: f.generation }));
    expect(parseOperatorQuestions(cold.questions, [], cold.generation)).toEqual([initial]);
    const proposed = proposeOperatorAnswer(initial, { question_id: initial.id, revision: initial.revision, source_reference: canonicalJsonDigest(f.binding),
      disposition: "proposed", value: { kind: "shared_sum", designation: f.binding.designation } });
    expect(() => assertOperatorQuestionsAdvance([initial], [proposed])).not.toThrow();
    const confirmed = confirmOperatorAnswer(proposed);
    expect(parseOperatorQuestions([confirmed], [], f.generation)).toEqual([confirmed]);
    expect(projectReviewedSharedSumQuestion(confirmed).designation).toEqual(f.binding.designation);
  });
  it("rejects full-component, native-operation and predecessor drift despite resealed data", async () => {
    const f = await nativeProposalFixture(), original = prepareSharedSumOperatorQuestion({ binding: f.binding });
    const changed = structuredClone(f.binding); changed.origin.material.components.approval.extra = "different original";
    expect(() => parseOperatorQuestions([prepareSharedSumOperatorQuestion({ binding: changed })], [], f.generation)).toThrow();
    for (const key of ["operation_id", "request_digest", "context_digest", "response_digest"] as const) {
      const binding = structuredClone(f.binding); if (key === "operation_id") binding.origin.completion.operation_id = randomUUID();
      else binding.origin.completion[key] = canonicalJsonDigest(key);
      expect(() => parseOperatorQuestions([prepareSharedSumOperatorQuestion({ binding })], [], f.generation)).toThrow();
    }
    const unconsumed = structuredClone(f.generation); unconsumed.operations.at(-1)!.state = "handled"; delete unconsumed.operations.at(-1)!.checkpoint_seen;
    expect(() => parseOperatorQuestions([original], [], unconsumed)).toThrow();
    const predecessor = { question_id: original.id, question_digest: original.digest };
    const next = prepareSharedSumOperatorQuestion({ binding: { ...f.binding, predecessor }, revision: 2 });
    expect(parseOperatorQuestions([original, next], [], f.generation)).toEqual([original, next]);
    expect(() => parseOperatorQuestions([next, original], [], f.generation)).toThrow();
    expect(() => parseOperatorQuestions([original, next, prepareSharedSumOperatorQuestion({ binding: { ...f.binding, predecessor }, revision: 2 })], [], f.generation)).toThrow();
    // A copied completion cannot be used outside its real decoder frame to
    // mint another native acknowledgement.
    expect(() => authoringActionCheckpoint(f.generation, structuredClone(f.binding.origin.completion), { consumer: "action_rule_components", kind: "compiled_draft", material_digest: canonicalJsonDigest(f.binding.origin.material) })).toThrow();
  });
});
