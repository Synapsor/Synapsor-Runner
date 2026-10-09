import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import type { BoundaryAuthoringResumeAction, BoundaryAuthoringResumeState } from "./boundary-authoring-resume.js";
import type { ReadWorkloadAssistanceCheckpoint } from "./read-workload-assistance-checkpoint.js";
import type { ReadBoundaryRevisionCheckpoint } from "./read-boundary-revision-checkpoint.js";
import type { ReadPrerequisiteCheckpoint } from "./read-prerequisite-checkpoint.js";
import { loadBoundaryReviewContextHeld } from "./boundary-review-context.js";
import { boundaryAuthoringResumeBinding, readBoundaryAuthoringResumeStateHeld } from "./boundary-authoring-resume.js";
import { readActionRuleAuthorityRevisionBaselineHeld } from "./action-rule-authority.js";
import { policySourceSavedDigestHeld } from "./authoring-policy-source.js";
import { withProjectAuthorityMutation, withHeldProjectAuthorityAccess, type ProjectAuthorityMutationPermit } from "./project-authority-mutation.js";

/** A short current local-context acquisition, released before model/operator waiting.
 * Cooperating local records are read coherently; this is not a Source DB snapshot
 * or a cross-store rollback guarantee. The caller owns Resume currentness/CAS. */
export async function readAuthoringGenerationContext(projectRoot: string, resume: BoundaryAuthoringResumeState): Promise<`sha256:${string}`> {
  return withProjectAuthorityMutation(projectRoot, permit => readAuthoringGenerationContextHeld(projectRoot, resume, permit));
}

/** Recovery targets business state, while the existing Resume CAS separately
 * guards admission counters. Reserving the next iteration must not turn a
 * reviewed continuation into another business target. */
function generationActionMeaning(action: BoundaryAuthoringResumeAction | undefined) {
  if (!action?.checkpoint) return action ?? null;
  const { digest: _digest, logical_turns, ...checkpoint } = action.checkpoint;
  return { ...action, checkpoint: { ...checkpoint, ...(logical_turns ? { logical_turns: logical_turns.map(turn => {
    const { iterations_used: _iterations, tool_calls_used: _tools, used_version_corrections: _corrections,
      wording_correction_used: _wording, ...identity } = turn;
    return identity;
  }) } : {}) } };
}
function generationRevisionMeaning(revision: BoundaryAuthoringResumeState["pending_action_revision"]) {
  if (!revision?.checkpoint) return revision ?? null;
  return { ...revision, checkpoint: generationActionMeaning({ intent: revision.instruction, checkpoint: revision.checkpoint })!.checkpoint };
}
/** Controller reservations are protected by Resume CAS and their durable
 * allowance, not a new business identity. Retain all actual inputs, answers,
 * selections and the producer's exact dispatch question in that identity. */
function generationReadControllerMeaning(checkpoint: ReadWorkloadAssistanceCheckpoint | ReadBoundaryRevisionCheckpoint | ReadPrerequisiteCheckpoint | undefined): unknown {
  if (!checkpoint) return null;
  const { digest: _digest, state, ...body } = checkpoint;
  const meaning = { ...state } as Record<string, unknown>;
  for (const key of ["call_count", "attempt", "correction_used", "relationship_reviews",
    "naming_evidence_correction_used", "clarification_count", "new_questions", "metrics", "usage"])
    delete meaning[key];
  const pending = "pending_question" in body ? body.pending_question : undefined;
  return { ...body, state: meaning, ...(pending?.kind === "private_prerequisite" && pending.nested_checkpoint
    ? { pending_question: { ...pending, nested_checkpoint: generationReadControllerMeaning(pending.nested_checkpoint) } } : {}) };
}
export async function readAuthoringGenerationContextHeld(projectRoot: string, resume: BoundaryAuthoringResumeState,
  permit: ProjectAuthorityMutationPermit): Promise<`sha256:${string}`> {
  return withHeldProjectAuthorityAccess(projectRoot, permit, async access => {
  const context = await loadBoundaryReviewContextHeld(projectRoot, access);
  const current = await readBoundaryAuthoringResumeStateHeld(projectRoot, boundaryAuthoringResumeBinding(context.bundle), access);
  if (!current || current.revision_digest !== resume.revision_digest) {
    throw Object.assign(new Error("The saved setup changed before its generation context could be read. Reopen current saved work; no later revision was adopted."), { code: "BOUNDARY_AUTHORING_RESUME_CHANGED" });
  }
  const actions = await readActionRuleAuthorityRevisionBaselineHeld(projectRoot, access);
  return canonicalJsonDigest({ binding: boundaryAuthoringResumeBinding(context.bundle), candidate: context.candidate,
    actions, source: resume.policy_source_session ? await policySourceSavedDigestHeld(projectRoot, resume.policy_source_session, access) : null,
    job: resume.job_intent, stage: resume.stage, model: resume.model,
    permission: { private: resume.private_read_metadata_digest ?? null, destination: resume.metadata_destination_digest ?? null },
    action: generationActionMeaning(resume.action), revision: generationRevisionMeaning(resume.pending_action_revision),
    request: resume.pending_job_revision ?? null, removal: resume.pending_action_removal ?? null,
    addition: resume.pending_action_addition ?? null, read: resume.read ?? null,
    read_assistance: generationReadControllerMeaning(resume.read_assistance),
    read_revision: resume.pending_read_revision_state ? { ...resume.pending_read_revision_state,
      ...(resume.pending_read_revision_state.checkpoint ? { checkpoint: generationReadControllerMeaning(resume.pending_read_revision_state.checkpoint) } : {}) } : null,
    pending_policy_review: resume.pending_policy_review ?? null, owner_handoffs: resume.owner_handoffs ?? [],
    questions: (resume.operator_questions ?? []).map(question => {
      if (!question.budget) return question;
      const { digest: _digest, budget: _budget, ...meaning } = question;
      return meaning;
    }) });
  });
}
