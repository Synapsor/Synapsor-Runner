import { expect, it } from "vitest";
import { canonicalJsonDigest as d } from "@synapsor-runner/protocol";
import { createActionSubjectQuestion, applyActionSubjectFieldEvent, enrichActionSubjectProof } from "./authoring-action-subject.js";
import { actionSubjectOriginDigest, assertActionSubjectSequence, type ActionSubjectHostMaterial } from "./authoring-action-subject-binding.js";
import { confirmOperatorAnswer, type OperatorQuestion } from "./authoring-operator-question.js";
import type { ActionSubjectReviewMaterial, ActionSubjectStructuralReference } from "./authoring-action-subject-proof-binding.js";
// Codec-only declared records. Actual protected native proof is separately
// exercised by the structural owner; these hashes are not acceptance evidence.
const initial: ActionSubjectStructuralReference = { kind: "boundary_review", boundary_id: "test-boundary", review_revision: 1,
  binding: { draft_digest: d("draft"), candidate_digest: d("before"), generation_lock_fingerprint: d("lock"), schema_fingerprint: d("schema"), role_posture_fingerprint: d("role"), review_revision: 1 },
  bundle_digest: d("bundle"), source_digest: d(null), confirmations_digest: d("confirmations") };
function record(q: OperatorQuestion) { if (q.proposal?.value?.kind !== "action_subject") throw Error("missing"); return q.proposal.value.record; }
function fixture() {
  const first = { kind: "primary_effect" as const, resource: "work.items" }, second = { kind: "atomic_effect" as const, index: 0, resource: "work.notes", binding: "note" };
  const material: ActionSubjectHostMaterial = { version: 2, structural: initial, outcome: "change", logical_turn_id: "turn", baseline: null,
    request_digest: d("request"), applicability_digest: d("applicability"), candidate_digest: d("components"),
    targets: [{ target: first, target_digest: d(first), options: [] }, { target: second, target_digest: d(second), options: [{
      reference: d("known-note"), target_digest: d(second), kind: "principal", dependencies_digest: d("note-proof") }] }] };
  const entries = material.targets.map(t => ({ state: "awaiting" as const, target_digest: t.target_digest }));
  let q = createActionSubjectQuestion({ binding: { version: 2, material, origin: { completion: {
    operation_id: "declared-component-operation", request_digest: d("provider-request"), context_digest: d("context"), response_digest: d("response") },
    material_digest: actionSubjectOriginDigest(material, entries) } }, entries, scope_digest: d("scope"), context_digest: d("context") });
  const choose = (question: OperatorQuestion, target: string, value: string) => {
    const view = record(question).view, field = view.fields.find(f => f.target_digest === target && f.kind === "choice" && f.options.some(o => o.value === value))!;
    return applyActionSubjectFieldEvent(question, { kind: "select_option", binding: view.binding, field_id: field.id,
      target_digest: field.target_digest, dependencies_digest: field.dependencies_digest, value });
  };
  q = choose(q, d(second), d("known-note")); q = choose(q, d(first), "request:principal");
  const after = { ...initial, review_revision: 2, binding: { ...initial.binding, candidate_digest: d("after"), review_revision: 2 }, bundle_digest: d("prepared") };
  const ack = (value: OperatorQuestion) => ({ question_id: value.id, question_revision: value.revision, question_digest: value.digest,
    checkpoint_digest: d("saved-checkpoint"), resume_revision_digest: d("saved-resume"), proposal_digest: d(record(value)) });
  const prepared: ActionSubjectReviewMaterial = { version: 1, phase: "prepared", before: initial, after, request_ack: ack(q),
    changed_targets: [d(first)], mutation: { preview_digest: d("actual-preview"), candidate_digest: after.binding.candidate_digest,
      generation_lock_fingerprint: initial.binding.generation_lock_fingerprint, draft_digest: initial.binding.draft_digest, review_revision: 2,
      requests: [{ resource: first.resource, kind: "direct", value: "principal_id" }] }, targets: material.targets.map(t => ({ target_digest: t.target_digest,
      options: t.options, proof: { kind: "initial", options_digest: d(t.options) } })) };
  const requested = q;
  const planned: ActionSubjectReviewMaterial = { ...prepared, phase: "planned", after: initial };
  q = enrichActionSubjectProof(q, planned);
  const plannedQuestion = q; prepared.request_ack = ack(q); q = enrichActionSubjectProof(q, prepared);
  const scope = { root_resource: first.resource, reference: "subject-scope:exact", source_digest: d(null), review_digest: d("review"), configuration_digest: d("configuration"), kind: "principal" as const };
  const reviewed: ActionSubjectReviewMaterial = { ...prepared, phase: "reviewed", before: after,
    after: { ...after, review_revision: 3, binding: { ...after.binding, review_revision: 3 }, bundle_digest: d("reviewed"), confirmations_digest: d("final-ack") },
    request_ack: ack(q), targets: prepared.targets.map(t => t.target_digest === d(first) ? { target_digest: t.target_digest,
      options: [{ target_digest: t.target_digest, reference: d({ target: first, scope }), dependencies_digest: d(scope), kind: "principal" }],
      proof: { kind: "boundary_scope", scope } } : t) };
  return { requested, plannedQuestion, planned, pending: q, prepared, reviewed };
}
it("prepared proof stays pending, then reviewed proof retains a known companion and needs separate Yes", () => {
  const f = fixture();
  expect(record(f.pending).entries).toEqual(record(f.requested).entries);
  expect(() => confirmOperatorAnswer(f.pending)).toThrow(/Unresolved Action subjects/);
  const proven = enrichActionSubjectProof(f.pending, f.reviewed);
  expect(record(proven).entries[1]).toEqual(record(f.requested).entries[1]);
  expect(record(proven).review_material!.targets[1]).toEqual(f.prepared.targets[1]);
  expect(proven.confirmation).toBeUndefined(); expect(proven.raw_answer).toBeUndefined();
  expect(confirmOperatorAnswer(proven).confirmation).toBeDefined();
  expect(proven.action_subject).toEqual(f.requested.action_subject);
  expect(record(proven).provenance).toEqual({ kind: "host_structural_review" });
});
it.each(["wrong_request", "wrong_scope", "changed_role", "companion_options", "missing_preparation"])("refuses proof enrichment with %s", scenario => {
  const f = fixture(), proof = structuredClone(f.reviewed);
  if (scenario === "wrong_request") proof.request_ack.proposal_digest = d("not-the-request");
  if (scenario === "wrong_scope" && proof.targets[0]!.proof.kind === "boundary_scope") proof.targets[0]!.proof.scope.kind = "tenant";
  if (scenario === "changed_role") proof.after.binding.role_posture_fingerprint = d("another-role");
  if (scenario === "companion_options") proof.targets[1]!.options[0]!.reference = d("expanded");
  expect(() => enrichActionSubjectProof(scenario === "missing_preparation" ? f.requested : f.pending, proof)).toThrow(/ACTION_SUBJECT/);
});
it("cannot rewrite initial options while retaining the original producer digest", () => {
  const f = fixture(), binding = structuredClone(f.requested.action_subject!);
  binding.material.targets[0]!.options = f.reviewed.targets[0]!.options;
  expect(() => assertActionSubjectSequence(binding, [...f.pending.proposal_history!, f.pending.proposal!].map(p => {
    if (p.value?.kind !== "action_subject") throw Error("missing"); return p.value.record;
  }))).toThrow(/ACTION_SUBJECT/);
});

it("records a non-authorizing preview before writing and rejects skipped or substituted plans", () => {
  const f = fixture();
  expect(record(f.plannedQuestion).entries).toEqual(record(f.requested).entries);
  expect(record(f.plannedQuestion).review_material!.after).toEqual(initial);
  expect(() => confirmOperatorAnswer(f.plannedQuestion)).toThrow(/Unresolved Action subjects/);
  const skipped = { ...f.prepared, request_ack: f.planned.request_ack };
  expect(() => enrichActionSubjectProof(f.requested, skipped)).toThrow(/ACTION_SUBJECT/);
  const substituted = structuredClone(f.prepared); substituted.mutation.preview_digest = d("different-preview");
  expect(() => enrichActionSubjectProof(f.plannedQuestion, substituted)).toThrow(/ACTION_SUBJECT/);
});
