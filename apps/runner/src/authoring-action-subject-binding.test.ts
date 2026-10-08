import { describe, expect, it } from "vitest";
import { canonicalJsonDigest as hash } from "@synapsor-runner/protocol";
import { parseActionSubjectBinding, parseActionSubjectEntries, actionSubjectOriginDigest } from "./authoring-action-subject-binding.js";
const target = { kind: "primary_effect" as const, resource: "service.requests" };
const targetDigest = hash(target);
const material = {
  version: 1 as const, outcome: "submit", logical_turn_id: "turn-1", baseline: null,
  request_digest: hash("request"), applicability_digest: hash("dependencies"), candidate_digest: hash("candidate"),
  targets: [{ target, target_digest: targetDigest, options: [{ reference: hash("principal-scope"), target_digest: targetDigest,
    kind: "principal" as const, dependencies_digest: hash("dependencies") }] }],
};
const awaiting = [{ state: "awaiting" as const, target_digest: targetDigest }];
const completion = { operation_id: "actual-operation", request_digest: hash("request"), context_digest: hash("context"), response_digest: hash("response") };
const binding = () => ({ version: 1 as const, material: structuredClone(material), origin: { completion, material_digest: actionSubjectOriginDigest(material, awaiting) } });
describe("Action subject strict initial material", () => {
  it("retains an awaiting target without fabricating answer or Source evidence", () => {
    expect(parseActionSubjectBinding(binding())).toEqual(binding());
    expect(parseActionSubjectEntries(awaiting, material)).toEqual(awaiting);
  });
  it.each(["support", "meaning", "scope_reference"])("rejects invented %s on an awaiting target", key => {
    expect(() => parseActionSubjectEntries([{ ...awaiting[0], [key]: "invented" }], material)).toThrow(/ACTION_SUBJECT/);
  });
  it("does not merge repeated display identities or accept a different actual target", () => {
    const bad = binding(); bad.material.targets[0]!.target.resource = "service.other";
    expect(() => parseActionSubjectBinding(bad)).toThrow(/ACTION_SUBJECT/);
  });
  it("requires exactly the host target set, with no omissions or duplicates", () => {
    expect(() => parseActionSubjectEntries([], material)).toThrow(/ACTION_SUBJECT/);
    expect(() => parseActionSubjectEntries([...awaiting, ...awaiting], material)).toThrow(/ACTION_SUBJECT/);
    expect(() => parseActionSubjectEntries([{ state: "awaiting", target_digest: hash("other") }], material)).toThrow(/ACTION_SUBJECT/);
  });
  it("does not accept tenant scope as trusted-principal scope", () => {
    const tenant = structuredClone(material); tenant.targets[0]!.options[0]!.kind = "tenant" as never;
    expect(() => parseActionSubjectEntries([{ state: "proposed", target_digest: targetDigest, meaning: "trusted_principal",
      scope_reference: tenant.targets[0]!.options[0]!.reference, support: { kind: "operator_answer", question_id: "10101010-1010-4010-8010-101010101010",
        question_revision: 1, answer_id: "20202020-2020-4020-8020-202020202020", answer_digest: hash("raw"), context_digest: hash("context") } }], tenant)).toThrow(/ACTION_SUBJECT/);
  });
  it("rejects Read inheritance on a private effect even when resource names match", () => {
    expect(() => parseActionSubjectEntries([{ state: "proposed", target_digest: targetDigest, meaning: "trusted_principal",
      scope_reference: material.targets[0]!.options[0]!.reference, support: { kind: "read_subject", question_id: "10101010-1010-4010-8010-101010101010",
        question_revision: 1, question_digest: hash("question"), scope_record_digest: hash("scope"), requirement_id: "public-field" } }], material)).toThrow(/ACTION_SUBJECT/);
  });
  it("origin binds staged components and initial entries, not later question or view identities", () => {
    expect(actionSubjectOriginDigest(material, awaiting)).toBe(binding().origin.material_digest);
    expect(actionSubjectOriginDigest({ ...material, candidate_digest: hash("changed") }, awaiting)).not.toBe(binding().origin.material_digest);
    expect(() => parseActionSubjectBinding({ ...binding(), accepted: true })).toThrow(/ACTION_SUBJECT/);
  });
});

import { actionSubjectFieldDependencies, actionSubjectViewDigest, assertActionSubjectSequence, parseActionSubjectProposal, type ActionSubjectProposal } from "./authoring-action-subject-binding.js";
import type { TypedFieldEvent, TypedReviewView } from "./authoring-typed-review.js";
function record(): ActionSubjectProposal {
  let view: TypedReviewView = { binding: { proposal_id: "subject-proposal", proposal_revision: 1, proposal_digest: hash(awaiting), applicability_digest: material.applicability_digest,
    operation_id: completion.operation_id, view_digest: hash("temporary") }, decision_kind: "business_review", status: "unconfirmed", title: "Choose the affected subject",
    fields: [{ id: "subject-0", kind: "choice", target_digest: targetDigest, dependencies_digest: actionSubjectFieldDependencies(material, material.targets[0]!), label: "Affected record",
      required: true, options: [{ value: material.targets[0]!.options[0]!.reference, label: "Signed-in person's records" }] }], normalized_lines: [], change_lines: [], unresolved: ["The affected subject is pending."] };
  view = { ...view, binding: { ...view.binding, view_digest: actionSubjectViewDigest(view) } };
  return { version: 1, entries: structuredClone(awaiting), meaning_digest: hash(awaiting), view, provenance: { kind: "initial_producer" } };
}
function direct(previous = record()): ActionSubjectProposal {
  const event: TypedFieldEvent = { kind: "select_option", binding: previous.view.binding, field_id: "subject-0", target_digest: targetDigest,
    dependencies_digest: previous.view.fields[0]!.dependencies_digest, value: material.targets[0]!.options[0]!.reference };
  const entries = [{ state: "proposed" as const, target_digest: targetDigest, meaning: "trusted_principal" as const, scope_reference: material.targets[0]!.options[0]!.reference,
    support: { kind: "operator_choice" as const, proposal_revision: 2, event_digest: hash(event) } }];
  let view: TypedReviewView = { ...previous.view, binding: { ...previous.view.binding, proposal_revision: 2, proposal_digest: hash(entries) }, unresolved: [] };
  view = { ...view, binding: { ...view.binding, view_digest: actionSubjectViewDigest(view) } };
  return { version: 1, entries, meaning_digest: hash(entries), view, provenance: { kind: "operator_field", event }, predecessor_proposal_digest: hash(previous) };
}
describe("Action subject full retained proposal history", () => {
  it("retains actual direct-choice provenance without any raw answer or model completion", () => {
    const initial = record(), next = direct(initial);
    expect(assertActionSubjectSequence(binding(), [initial, next])).toEqual([initial, next]);
    expect(next.provenance.kind).toBe("operator_field");
  });
  it("rejects a choice without its actual retained event", () => {
    const next = direct(); next.provenance = { kind: "initial_producer" };
    expect(() => assertActionSubjectSequence(binding(), [record(), next])).toThrow(/ACTION_SUBJECT/);
  });
  it("rejects a changed previous full meaning, stale event, or omitted history", () => {
    const initial = record(), next = direct(initial);
    expect(() => assertActionSubjectSequence(binding(), [next])).toThrow(/ACTION_SUBJECT/);
    const changed = structuredClone(initial); changed.view = { ...changed.view, title: "Changed after display" };
    expect(() => assertActionSubjectSequence(binding(), [changed, next])).toThrow(/ACTION_SUBJECT/);
    if (next.provenance.kind === "operator_field") next.provenance.event = { ...next.provenance.event, target_digest: hash("wrong-target") };
    expect(() => assertActionSubjectSequence(binding(), [initial, next])).toThrow();
  });
  it("rejects host option expansion even if the new view digest is internally correct", () => {
    const r = record(); const field = r.view.fields[0]!;
    if (field.kind !== "choice") throw Error("fixture");
    r.view = { ...r.view, fields: [{ ...field, options: [...field.options, { value: hash("unadvertised"), label: "All records" }] }] };
    r.view = { ...r.view, binding: { ...r.view.binding, view_digest: actionSubjectViewDigest(r.view) } };
    expect(() => parseActionSubjectProposal(r, binding())).toThrow(/ACTION_SUBJECT/);
  });
  it("rejects a forged meaning digest and detached origin material", () => {
    const initial = record();
    expect(() => parseActionSubjectProposal({ ...initial, meaning_digest: hash("other") }, binding())).toThrow(/ACTION_SUBJECT/);
    const b = binding(); b.origin.material_digest = hash("unconsumed");
    expect(() => assertActionSubjectSequence(b, [initial])).toThrow(/ACTION_SUBJECT/);
  });
});

import { parseOperatorQuestion, confirmOperatorAnswer, proposeOperatorAnswer, assertOperatorQuestionsAdvance, type OperatorQuestion } from "./authoring-operator-question.js";
function question(): OperatorQuestion {
  const b = binding();
  const body = { version: 2 as const, id: "30303030-3030-4030-8030-303030303030", revision: 1, kind: "action_subject" as const,
    scope_digest: hash("action-scope"), context_digest: hash("context"), target: { phase: "action_subject", outcomes: [material.outcome] },
    material: [], evidence: [], continuation: "action_rule_review" as const, action_subject: b,
    proposal: { question_id: "30303030-3030-4030-8030-303030303030", revision: 1, source_reference: hash(b), disposition: "proposed" as const,
      value: { kind: "action_subject" as const, record: record() } } };
  return parseOperatorQuestion({ ...body, digest: hash(body) });
}
describe("Action subject native question composition", () => {
  it("round trips the existing question store and refuses confirming awaiting subjects", () => {
    const q = question(); expect(parseOperatorQuestion(JSON.parse(JSON.stringify(q)))).toEqual(q);
    expect(() => confirmOperatorAnswer(q)).toThrow(/Unresolved Action subjects/);
    expect(q.confirmation).toBeUndefined();
  });
  it("preserves full prior records through a real direct event and separate group decision", () => {
    const before = question(), next = proposeOperatorAnswer(before, { ...before.proposal!, value: { kind: "action_subject", record: direct() } });
    assertOperatorQuestionsAdvance([before], [next]);
    expect(next.proposal_history).toEqual([before.proposal]);
    expect(next.confirmation).toBeUndefined();
    expect(confirmOperatorAnswer(next).confirmation?.proposal_digest).toBe(hash(next.proposal));
  });
  it("rejects a changed fixed binding and any fresh independent allowance", () => {
    const q = question();
    const { digest: _, ...body } = q;
    expect(() => parseOperatorQuestion({ ...body, budget: { iterations_used: 0, tool_calls_used: 0, correction_used: false },
      digest: hash({ ...body, budget: { iterations_used: 0, tool_calls_used: 0, correction_used: false } }) })).toThrow(/existing producer turn/);
    const changed = structuredClone(body); changed.action_subject!.material.logical_turn_id = "new-reset-turn";
    expect(() => assertOperatorQuestionsAdvance([q], [{ ...changed, digest: hash(changed) }])).toThrow();
  });
  it("rejects malformed current-v2 subject records instead of retrofitting or inferring them", () => {
    const { digest: _, action_subject: __, ...body } = question();
    expect(() => parseOperatorQuestion({ ...body, digest: hash(body) })).toThrow(/ACTION_SUBJECT/);
  });
});

import { createActionSubjectQuestion, applyActionSubjectFieldEvent, proposeActionSubjectAnswer } from "./authoring-action-subject.js";
import { captureOperatorAnswer, presentOperatorQuestion } from "./authoring-operator-question.js";
describe("Action subject local host adapters", () => {
  it("renders distinct exact target identities and applies a real choice without confirming", () => {
    const q = createActionSubjectQuestion({ binding: binding(), entries: awaiting, scope_digest: hash("scope"), context_digest: hash("context") });
    if (q.proposal?.value?.kind !== "action_subject") throw Error("missing");
    const v = q.proposal.value.record.view, f = v.fields[0]!;
    expect(v.technical_lines?.join("\n")).toContain("service.requests");
    const next = applyActionSubjectFieldEvent(q, { kind: "select_option", binding: v.binding, field_id: f.id,
      target_digest: f.target_digest, dependencies_digest: f.dependencies_digest, value: material.targets[0]!.options[0]!.reference });
    expect(next.raw_answer).toBeUndefined(); expect(next.confirmation).toBeUndefined();
    expect(next.proposal_history).toEqual([q.proposal]);
    expect(confirmOperatorAnswer(next).confirmation).toBeDefined();
  });
  it("retains leave-pending as an actual event and refuses group confirmation", () => {
    const q = createActionSubjectQuestion({ binding: binding(), entries: awaiting, scope_digest: hash("scope"), context_digest: hash("context") });
    if (q.proposal?.value?.kind !== "action_subject") throw Error("missing");
    const v = q.proposal.value.record.view, f = v.fields[0]!;
    const next = applyActionSubjectFieldEvent(q, { kind: "leave_pending", binding: v.binding, field_id: f.id, target_digest: f.target_digest, dependencies_digest: f.dependencies_digest });
    expect(next.proposal_history).toHaveLength(1); expect(() => confirmOperatorAnswer(next)).toThrow();
  });
  it("maps only the actual captured answer and cannot consume an unrelated raw answer", () => {
    const q = captureOperatorAnswer(presentOperatorQuestion(question(), "Which records may this action affect?"), "Only records belonging to the signed-in person.");
    const support = { kind: "operator_answer" as const, question_id: q.id, question_revision: q.revision, answer_id: q.raw_answer!.id,
      answer_digest: hash(q.raw_answer), context_digest: q.context_digest };
    const entries = [{ state: "proposed" as const, target_digest: targetDigest, meaning: "trusted_principal" as const,
      scope_reference: material.targets[0]!.options[0]!.reference, support }];
    const next = proposeActionSubjectAnswer(q, entries, { ...completion, operation_id: "actual-answer-operation" });
    expect(next.raw_answer).toEqual(q.raw_answer); expect(next.confirmation).toBeUndefined();
    expect(() => proposeActionSubjectAnswer(q, [{ ...entries[0]!, support: { ...support, answer_digest: hash("invented") } }], completion)).toThrow();
  });
});
it("renders business readbacks by the same target order as fields and details", () => {
  const secondTarget = { kind: "atomic_effect" as const, resource: "service.archive", binding: "archive", index: 0 };
  const secondDigest = hash(secondTarget);
  const host = { ...material, targets: [...material.targets, { target: secondTarget, target_digest: secondDigest,
    options: [{ reference: hash("archive-org-scope"), target_digest: secondDigest, kind: "tenant" as const, dependencies_digest: hash("archive-deps") }] }] };
  const entries = [{ state: "awaiting" as const, target_digest: secondDigest }, { state: "proposed" as const, target_digest: targetDigest,
    meaning: "trusted_principal" as const, scope_reference: material.targets[0]!.options[0]!.reference,
    support: { kind: "operator_answer" as const, question_id: "10101010-1010-4010-8010-101010101010", question_revision: 1,
      answer_id: "20202020-2020-4020-8020-202020202020", answer_digest: hash("raw"), context_digest: hash("context") } }];
  const b = { ...binding(), material: host, origin: { completion, material_digest: actionSubjectOriginDigest(host, entries) } };
  const q = createActionSubjectQuestion({ binding: b, entries, scope_digest: hash("scope"), context_digest: hash("context") });
  if (q.proposal?.value?.kind !== "action_subject") throw Error("missing");
  const v = q.proposal.value.record.view;
  expect(v.fields.map(f => f.target_digest)).toEqual([targetDigest, secondDigest]);
  expect(v.normalized_lines[0]).toContain("signed-in person's records");
  expect(v.normalized_lines[1]).toContain("pending");
  expect(v.technical_lines![0]).toContain(targetDigest);
});
