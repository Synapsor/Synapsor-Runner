import { canonicalJsonDigest as d } from "@synapsor-runner/protocol";
import { preparedReadAuthoringDraft } from "./control-policy-read-authoring.js";
import { explorationBoundaryCandidateDigest } from "./auto-boundary.js";
import { projectReadSubjectContext, type ReadSubjectReviewContext } from "./authoring-read-subject-context.js";
import { actionSubjectStructuralReferenceSchema, parseActionSubjectReviewMaterial,
  type ActionSubjectRequestAck, type ActionSubjectReviewMaterial, type ActionSubjectStructuralReference } from "./authoring-action-subject-proof-binding.js";
import type { BoundaryReviewMutationBatchPreview, commitBoundaryReviewMutationBatch } from "./boundary-review-mutation.js";
import type { OperatorQuestion } from "./authoring-operator-question.js";
import type { ActionSubjectProposal } from "./authoring-action-subject-binding.js";
type Digest = `sha256:${string}`;
const equal = (a: unknown, b: unknown) => d(a) === d(b);
function changed(): never { throw Error("ACTION_SUBJECT_PROOF_CHANGED: The acknowledged structural change no longer matches this saved request. Keep it pending for inspection; do not replay the structural write."); }
function record(q: OperatorQuestion): ActionSubjectProposal {
  if (q.action_subject?.version !== 2 || q.proposal?.value?.kind !== "action_subject") changed();
  return q.proposal.value.record;
}
/** A coherent projection of actual native records, not a hash supplied by the
 * model. The structural owner retains both writes and its ordinary review. */
export function projectActionSubjectStructural(input: { context: ReadSubjectReviewContext; sourceDigest: Digest }) {
  const scopes = projectReadSubjectContext(input).subject_scopes;
  const { context } = input;
  if (!context.progress) changed();
  const reference: ActionSubjectStructuralReference = actionSubjectStructuralReferenceSchema.parse({
    kind: "boundary_review", boundary_id: context.progress.boundary_id, review_revision: context.progress.revision,
    binding: context.bundle.mutation_bindings, bundle_digest: context.bundle.bundle_digest,
    source_digest: input.sourceDigest, confirmations_digest: d(context.progress.confirmations),
  });
  return { reference, scopes };
}
function checkedRequest(q: OperatorQuestion, ack: ActionSubjectRequestAck) {
  const proposal = record(q);
  if (ack.question_id !== q.id || ack.question_revision !== q.revision || ack.question_digest !== q.digest
    || ack.proposal_digest !== d(proposal)) changed();
  return proposal;
}
function mutation(preview: BoundaryReviewMutationBatchPreview): ActionSubjectReviewMaterial["mutation"] {
  if (preview.source_database_changed !== false || preview.candidate_digest !== explorationBoundaryCandidateDigest(preview.candidate)) changed();
  const requests = preview.requests.map(request => {
    const keys = Object.keys(request).filter(k => !["resource_id", "actor", "reason"].includes(k));
    if (keys.length !== 1 || !request.actor.trim() || !request.reason.trim()) changed();
    if (keys[0] === "principal_key" && typeof request.principal_key === "string") return { resource: request.resource_id, kind: "direct" as const, value: request.principal_key };
    if (keys[0] === "principal_scope_path" && typeof request.principal_scope_path === "string") return { resource: request.resource_id, kind: "derived" as const, value: request.principal_scope_path };
    if (keys[0] === "principal_rls_setting" && typeof request.principal_rls_setting === "string") return { resource: request.resource_id, kind: "postgres_rls" as const, value: request.principal_rls_setting };
    changed();
  });
  if (!requests.length || new Set(requests.map(r => r.resource)).size !== requests.length) changed();
  return { preview_digest: d(preview), candidate_digest: preview.candidate_digest,
    generation_lock_fingerprint: preview.candidate.generation_lock_fingerprint,
    draft_digest: explorationBoundaryCandidateDigest(preview.bindings.authoring ? preparedReadAuthoringDraft(preview.build) : preview.build.exploration_boundary),
    review_revision: preview.bindings.review_revision + 1, requests };
}
export function planActionSubjectProof(input: { question: OperatorQuestion; requestAck: ActionSubjectRequestAck;
  current: ReturnType<typeof projectActionSubjectStructural>; preview: BoundaryReviewMutationBatchPreview }): ActionSubjectReviewMaterial {
  const proposal = checkedRequest(input.question, input.requestAck), material = input.question.action_subject!.material;
  const before = proposal.review_material?.after ?? material.structural!;
  if (!equal(before, input.current.reference) || !equal(before.binding, input.preview.bindings)) changed();
  const change = mutation(input.preview), changedTargets = material.targets.filter(target => change.requests.some(r => r.resource === target.target.resource));
  if (change.requests.some(r => !changedTargets.some(t => t.target.resource === r.resource))) changed();
  for (const target of changedTargets) {
    const entry = proposal.entries.find(e => e.target_digest === target.target_digest);
    if (entry?.state !== "requested" || entry.requested_kind !== "principal") changed();
  }
  return parseActionSubjectReviewMaterial({ version: 1, phase: "planned", before, after: before,
    request_ack: input.requestAck, mutation: change, changed_targets: changedTargets.map(t => t.target_digest),
    targets: proposal.review_material?.targets ?? material.targets.map(t => ({ target_digest: t.target_digest,
      options: t.options, proof: { kind: "initial", options_digest: d(t.options) } })) });
}
export function acknowledgeActionSubjectPreparation(input: { question: OperatorQuestion; requestAck: ActionSubjectRequestAck;
  context: ReadSubjectReviewContext; sourceDigest: Digest; preview: BoundaryReviewMutationBatchPreview;
  committed: Awaited<ReturnType<typeof commitBoundaryReviewMutationBatch>> }): ActionSubjectReviewMaterial {
  const proposal = checkedRequest(input.question, input.requestAck), planned = proposal.review_material;
  if (planned?.phase !== "planned" || !equal(planned.mutation, mutation(input.preview))
    || !equal(planned.before.binding, input.preview.bindings)) changed();
  const actual = projectActionSubjectStructural(input);
  if (!input.committed.progress || !equal(input.committed.progress, input.context.progress)
    || input.committed.candidate_digest !== planned.mutation.candidate_digest
    || input.committed.review_revision !== planned.mutation.review_revision
    || actual.reference.review_revision !== input.committed.review_revision
    || !equal(actual.reference.binding.authoring ?? null, input.committed.authoring_binding ?? null)) changed();
  return parseActionSubjectReviewMaterial({ ...planned, phase: "prepared", before: planned.after,
    after: actual.reference, request_ack: input.requestAck });
}
export type ActionSubjectStructuralReviewAck = { before: ActionSubjectStructuralReference;
  committed: Pick<Awaited<ReturnType<typeof commitBoundaryReviewMutationBatch>>, "candidate_digest" | "review_revision" | "progress" | "authoring_binding">;
  context: ReadSubjectReviewContext;
};
/** The ordinary structural review owner supplies its exact starting reference
 * and acknowledged ending revision. Reloaded records must resolve that ACK. */
export function acknowledgeActionSubjectReview(input: { question: OperatorQuestion; requestAck: ActionSubjectRequestAck;
  current: ReturnType<typeof projectActionSubjectStructural>; acknowledged: ActionSubjectStructuralReviewAck }): ActionSubjectReviewMaterial {
  const proposal = checkedRequest(input.question, input.requestAck), prepared = proposal.review_material;
  if (prepared?.phase !== "prepared" || !equal(input.acknowledged.before, prepared.after)
    || !equal(projectActionSubjectStructural({ context: input.acknowledged.context, sourceDigest: prepared.after.source_digest }), input.current)
    || !input.acknowledged.committed.progress || !equal(input.acknowledged.committed.progress, input.acknowledged.context.progress)
    || input.acknowledged.committed.candidate_digest !== input.current.reference.binding.candidate_digest
    || input.acknowledged.committed.review_revision !== input.current.reference.review_revision
    || !equal(input.acknowledged.committed.authoring_binding ?? null, input.current.reference.binding.authoring ?? null)) changed();
  const material = input.question.action_subject!.material;
  const targets = prepared.targets.map(target => {
    if (!prepared.changed_targets.includes(target.target_digest)) return target;
    const actualTarget = material.targets.find(t => t.target_digest === target.target_digest)!;
    const matches = input.current.scopes.filter(scope => scope.root_resource === actualTarget.target.resource && scope.kind === "principal");
    if (matches.length !== 1) changed();
    const scope = matches[0]!;
    return { target_digest: target.target_digest, options: [{ target_digest: target.target_digest, kind: scope.kind,
      reference: d({ target: actualTarget.target, scope }), dependencies_digest: d(scope) }], proof: { kind: "boundary_scope" as const, scope } };
  });
  return parseActionSubjectReviewMaterial({ ...prepared, phase: "reviewed", before: prepared.after,
    after: input.current.reference, request_ack: input.requestAck, targets });
}
