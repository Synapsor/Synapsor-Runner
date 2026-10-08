import { randomUUID } from "node:crypto";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { parseOperatorQuestion, proposeOperatorAnswer, type OperatorQuestion } from "./authoring-operator-question.js";
import { parseActionSubjectBinding, parseActionSubjectEntries, actionSubjectFieldDependencies, actionSubjectViewDigest,
  type ActionSubjectBinding, type ActionSubjectEntry, type ActionSubjectProposal } from "./authoring-action-subject-binding.js";
import { validateTypedFieldEvent } from "./authoring-typed-review-codec.js";
import type { TypedFieldEvent, TypedReviewView } from "./authoring-typed-review.js";
import type { AuthoringQuestionCompletion } from "./authoring-generation-recovery.js";
type Digest = `sha256:${string}`;
function invalid(): never { throw new Error("ACTION_SUBJECT_INVALID: Reopen the exact current subject review; no scope decision was saved."); }
/** Local exact target identity is shown in details. These neutral descriptions do
 * not derive a business meaning from resource spelling, comments or row values. */
function view(binding: ActionSubjectBinding, entries: ActionSubjectEntry[], proposalId: string, proposalRevision: number): TypedReviewView {
  const body: TypedReviewView = {
    binding: { proposal_id: proposalId, proposal_revision: proposalRevision, proposal_digest: canonicalJsonDigest(entries),
      applicability_digest: binding.material.applicability_digest, operation_id: binding.origin.completion.operation_id, view_digest: canonicalJsonDigest(null) },
    decision_kind: "business_review", status: "unconfirmed", title: "Review which records this action may affect",
    fields: binding.material.targets.map((item, index) => {
      const entry = entries.find(e => e.target_digest === item.target_digest)!;
      return { kind: "choice", id: `subject-${index + 1}`, target_digest: item.target_digest,
        dependencies_digest: actionSubjectFieldDependencies(binding.material, item), label: `Record group ${index + 1}`, required: true,
        options: item.options.map(o => ({ value: o.reference, label: o.kind === "principal" ? "The signed-in person's records" : o.kind === "tenant" ? "Records in the current organization" : "The reviewed shared records" })),
        ...(entry.state === "proposed" ? { suggestion: { value: { kind: "choice" as const, value: entry.scope_reference },
          origin: entry.support.kind === "operator_choice" ? "operator_edit" as const : "model_proposal" as const } } : {}) };
    }),
    normalized_lines: binding.material.targets.map((target, index) => {
      const entry = entries.find(e => e.target_digest === target.target_digest)!;
      return entry.state === "proposed"
      ? `Record group ${index + 1}: ${binding.material.targets.find(t => t.target_digest === entry.target_digest)!.options.find(o => o.reference === entry.scope_reference)!.kind === "principal" ? "only the signed-in person's records" : "the selected reviewed scope"}.`
      : `Record group ${index + 1}: scope remains pending.`; }),
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
  entries: ActionSubjectEntry[], provenance: ActionSubjectProposal["provenance"]): OperatorQuestion {
  const record: ActionSubjectProposal = { version: 1, entries, meaning_digest: canonicalJsonDigest(entries),
    view: view(binding, entries, previous.view.binding.proposal_id, previous.view.binding.proposal_revision + 1), provenance,
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
    const option = binding.material.targets.find(t => t.target_digest === event.target_digest)?.options.find(o => o.reference === event.value);
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
  const parsed = parseActionSubjectEntries(entries, binding.material);
  for (const entry of parsed) {
    if (entry.state === "awaiting") continue;
    if (entry.support && canonicalJsonDigest(entry.support) !== canonicalJsonDigest(answer)) invalid();
    if (entry.state === "proposed" && !entry.support) invalid();
  }
  return append(q, binding, record, parsed, { kind: "model_answer", completion, answer });
}
