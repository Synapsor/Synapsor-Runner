import { randomUUID } from "node:crypto";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { parseOperatorQuestion, proposeOperatorAnswer, type OperatorQuestion } from "./authoring-operator-question.js";
import { parseActionSubjectBinding, parseActionSubjectEntries, actionSubjectFieldDependencies, actionSubjectViewDigest, actionSubjectEffectiveApplicability, actionSubjectViewOptions,
  type ActionSubjectBinding, type ActionSubjectEntry, type ActionSubjectProposal } from "./authoring-action-subject-binding.js";
import { validateTypedFieldEvent } from "./authoring-typed-review-codec.js";
import type { TypedFieldEvent, TypedReviewView } from "./authoring-typed-review.js";
import type { AuthoringQuestionCompletion } from "./authoring-generation-recovery.js";
import { parseActionSubjectReviewMaterial, type ActionSubjectReviewMaterial } from "./authoring-action-subject-proof-binding.js";
type Digest = `sha256:${string}`;
function invalid(): never { throw new Error("ACTION_SUBJECT_INVALID: Reopen the exact current subject review; no scope decision was saved."); }
/** Local exact target identity is shown in details. These neutral descriptions do
 * not derive a business meaning from resource spelling, comments or row values. */
function view(binding: ActionSubjectBinding, entries: ActionSubjectEntry[], proposalId: string, proposalRevision: number, review?: ActionSubjectReviewMaterial): TypedReviewView {
  const body: TypedReviewView = {
    binding: { proposal_id: proposalId, proposal_revision: proposalRevision, proposal_digest: canonicalJsonDigest(entries),
      applicability_digest: actionSubjectEffectiveApplicability(binding.material, review), operation_id: binding.origin.completion.operation_id, view_digest: canonicalJsonDigest(null) },
    decision_kind: "business_review", status: "unconfirmed", title: "Review which records this action may affect",
    fields: binding.material.targets.flatMap((item, index) => {
      const entry = entries.find(e => e.target_digest === item.target_digest)!;
      const options = actionSubjectViewOptions(binding.material, item, review), established = options.filter(o => !o.value.startsWith("request:")), requested = options.filter(o => o.value.startsWith("request:"));
      const identity = { kind: "choice" as const, target_digest: item.target_digest,
        dependencies_digest: actionSubjectFieldDependencies(binding.material, item, review), required: true };
      return [
        ...(established.length ? [{ ...identity, id: `subject-${index + 1}`, label: `Record group ${index + 1}`, options: established,
          ...(entry.state === "proposed" ? { suggestion: { value: { kind: "choice" as const, value: entry.scope_reference },
            origin: entry.support.kind === "operator_choice" ? "operator_edit" as const : "model_proposal" as const } } : {}) }] : []),
        ...(requested.length ? [{ ...identity, id: `requested-subject-${index + 1}`, label: `Scope to verify for record group ${index + 1}`, options: requested,
          ...(entry.state === "requested" ? { suggestion: { value: { kind: "choice" as const, value: `request:${entry.requested_kind}` },
            origin: entry.support.kind === "operator_choice" ? "operator_edit" as const : "model_proposal" as const } } : {}) }] : []),
      ];
    }),
    normalized_lines: binding.material.targets.map((target, index) => {
      const entry = entries.find(e => e.target_digest === target.target_digest)!;
      return entry.state === "proposed"
      ? `Record group ${index + 1}: ${(review?.targets.find(t => t.target_digest === entry.target_digest)?.options ?? target.options).find(o => o.reference === entry.scope_reference)!.kind === "principal" ? "only the signed-in person's records" : "the selected reviewed scope"}.`
      : entry.state === "requested" ? `Record group ${index + 1}: requested ${entry.requested_kind} scope still needs structural verification; no authority is granted.` : `Record group ${index + 1}: scope remains pending.`; }),
    change_lines: [], technical_lines: binding.material.targets.map(t => `${t.target.kind}: ${t.target.resource}; identity ${t.target_digest}`),
    unresolved: entries.filter(e => e.state !== "proposed").map(e => e.state === "unresolved" ? e.question : "Choose the applicable record scope before confirming."),
  };
  return { ...body, binding: { ...body.binding, view_digest: actionSubjectViewDigest(body) } };
}
export function createActionSubjectQuestion(input: { binding: ActionSubjectBinding; entries: ActionSubjectEntry[];
  scope_digest: Digest; context_digest: Digest; id?: string; revision?: number }): OperatorQuestion {
  const binding = parseActionSubjectBinding(input.binding), entries = parseActionSubjectEntries(input.entries, binding.material);
  const id = input.id ?? randomUUID(), revision = input.revision ?? 1;
  const record: ActionSubjectProposal = { version: 1, entries, meaning_digest: canonicalJsonDigest(entries),
    view: view(binding, entries, randomUUID(), 1), provenance: { kind: "initial_producer" } };
  const body = { version: 2 as const, id, revision, kind: "action_subject" as const, action_subject: binding,
    scope_digest: input.scope_digest, context_digest: input.context_digest, target: { phase: "action_subject", outcomes: [binding.material.outcome] },
    material: [], evidence: [], continuation: "action_rule_review" as const,
    proposal: { question_id: id, revision, source_reference: canonicalJsonDigest(binding), disposition: "proposed" as const,
      value: { kind: "action_subject" as const, record } } };
  return parseOperatorQuestion({ ...body, digest: canonicalJsonDigest(body) });
}
function current(question: OperatorQuestion): { q: OperatorQuestion; binding: ActionSubjectBinding; record: ActionSubjectProposal } {
  const q = parseOperatorQuestion(question);
  if (q.kind !== "action_subject" || !q.action_subject || q.proposal?.value?.kind !== "action_subject" || q.confirmation || q.disposition) invalid();
  return { q, binding: q.action_subject, record: q.proposal.value.record };
}
function append(q: OperatorQuestion, binding: ActionSubjectBinding, previous: ActionSubjectProposal,
  entries: ActionSubjectEntry[], provenance: ActionSubjectProposal["provenance"], review = previous.review_material): OperatorQuestion {
  entries = parseActionSubjectEntries(entries, binding.material, review);
  const record: ActionSubjectProposal = { version: 1, entries, meaning_digest: canonicalJsonDigest(entries),
    view: view(binding, entries, previous.view.binding.proposal_id, previous.view.binding.proposal_revision + 1, review), provenance,
    ...(review ? { review_material: review } : {}),
    predecessor_proposal_digest: canonicalJsonDigest(previous) };
  return proposeOperatorAnswer(q, { ...q.proposal!, value: { kind: "action_subject", record } });
}
/** No model operation, invented natural answer or group confirmation. The caller
 * must save this result under the existing native owner/currentness CAS. */
export function applyActionSubjectFieldEvent(question: OperatorQuestion, input: TypedFieldEvent): OperatorQuestion {
  const { q, binding, record } = current(question), { event } = validateTypedFieldEvent(record.view, input);
  if (event.kind !== "select_option" && event.kind !== "leave_pending") invalid();
  const entries = record.entries.map(entry => {
    if (entry.target_digest !== event.target_digest) return entry;
    if (event.kind === "leave_pending") return { state: "awaiting" as const, target_digest: entry.target_digest };
    if (binding.version === 2 && event.value.startsWith("request:")) {
      const kind = event.value.slice(8);
      if (!["principal", "tenant", "global"].includes(kind)) invalid();
      return { state: "requested" as const, target_digest: entry.target_digest, requested_kind: kind as "principal" | "tenant" | "global",
        support: { kind: "operator_choice" as const, proposal_revision: record.view.binding.proposal_revision + 1, event_digest: canonicalJsonDigest(event) } };
    }
    const option = (record.review_material?.targets.find(t => t.target_digest === event.target_digest)?.options
      ?? binding.material.targets.find(t => t.target_digest === event.target_digest)?.options)?.find(o => o.reference === event.value);
    if (!option) invalid();
    return { state: "proposed" as const, target_digest: entry.target_digest, meaning: option.kind === "principal" ? "trusted_principal" as const : "reviewed_scope" as const,
      scope_reference: option.reference, support: { kind: "operator_choice" as const, proposal_revision: record.view.binding.proposal_revision + 1, event_digest: canonicalJsonDigest(event) } };
  });
  return append(q, binding, record, entries, { kind: "operator_field", event });
}
/** Model interpretation is typed and attributed only to the actual retained
 * answer. This helper cannot establish applicability or mint transport proof. */
export function proposeActionSubjectAnswer(question: OperatorQuestion, entries: ActionSubjectEntry[], completion: AuthoringQuestionCompletion): OperatorQuestion {
  const { q, binding, record } = current(question);
  if (!q.raw_answer?.text.trim()) invalid();
  const answer = { kind: "operator_answer" as const, question_id: q.id, question_revision: q.revision,
    answer_id: q.raw_answer.id, answer_digest: canonicalJsonDigest(q.raw_answer), context_digest: q.context_digest };
  const parsed = parseActionSubjectEntries(entries, binding.material, record.review_material);
  for (const entry of parsed) {
    const previous = record.entries.find(old => old.target_digest === entry.target_digest);
    if (canonicalJsonDigest(previous ?? null) === canonicalJsonDigest(entry) || entry.state === "awaiting") continue;
    if (entry.support && canonicalJsonDigest(entry.support) !== canonicalJsonDigest(answer)) invalid();
    if (entry.state === "proposed" && !entry.support) invalid();
  }
  return append(q, binding, record, parsed, { kind: "model_answer", completion, answer });
}

/** A protected owner supplies actual acknowledged structural records. This
 * local event has no model completion and creates no business confirmation. */
export function enrichActionSubjectProof(question: OperatorQuestion, review: ActionSubjectReviewMaterial): OperatorQuestion {
  review = parseActionSubjectReviewMaterial(review);
  const { q, binding, record } = current(question);
  const entries = record.entries.map(entry => {
    if (review.phase !== "reviewed" || !review.changed_targets.includes(entry.target_digest)) return entry;
    if (entry.state !== "requested" || entry.requested_kind !== "principal") invalid();
    const option = review.targets.find(t => t.target_digest === entry.target_digest)?.options[0];
    if (!option) invalid();
    return { state: "proposed" as const, target_digest: entry.target_digest, meaning: "trusted_principal" as const,
      scope_reference: option.reference, support: entry.support };
  });
  return append(q, binding, record, entries, { kind: "host_structural_review" }, review);
}

/** Re-present an exact retained predecessor's effective proof for a new raw
 * answer. Native inventory validation resolves the prior question; this is no
 * new structural write, model completion, confirmation or allowance. */
export function inheritActionSubjectPredecessor(question: OperatorQuestion, predecessor: OperatorQuestion): OperatorQuestion {
  const { q, binding, record } = current(question), priorQuestion = parseOperatorQuestion(predecessor);
  if (!priorQuestion.action_subject || priorQuestion.proposal?.value?.kind !== "action_subject") invalid();
  const prior = { q: priorQuestion, binding: priorQuestion.action_subject, record: priorQuestion.proposal.value.record };
  if (binding.version !== 2 || binding.predecessor?.question_id !== prior.q.id || binding.predecessor.question_digest !== prior.q.digest
    || !prior.record.review_material || canonicalJsonDigest(binding.material) !== canonicalJsonDigest(prior.binding.material)
    || canonicalJsonDigest(binding.origin) !== canonicalJsonDigest(prior.binding.origin)) invalid();
  return append(q, binding, record, prior.record.entries, { kind: "host_predecessor_projection" }, prior.record.review_material);
}
