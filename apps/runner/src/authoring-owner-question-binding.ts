import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import type { ActionRuleAuthorityRevisionBaseline } from "./action-rule-authority.js";
import type { PolicySourceSession } from "./authoring-policy-source.js";
import type { ExplorationBoundaryDraft } from "./auto-boundary.js";
import type { BoundaryAuthoringReadRevision, BoundaryAuthoringResumeBinding } from "./boundary-authoring-resume.js";

type Digest = `sha256:${string}`;
export type AuthoringOwnerQuestionScopeInput = {
  job?: string;
  canonicalJob?: string;
  pendingJobRevision?: string;
  pendingReadRevision?: string;
  readRevision?: Pick<BoundaryAuthoringReadRevision, "instruction" | "provenance" | "privacy_only"
    | "vocabulary_only" | "interpretation_instruction">;
  /** Resolved by the existing destination owner; never inferred from question history. */
  model?: { provider: string; model: string; destination: string };
};

/** Existing question identity projection. This supplies no currentness or permission.
 * Missing job/model keeps the existing canonical-JSON refusal, not a default identity. */
export function ownerQuestionScopeDigest(input: AuthoringOwnerQuestionScopeInput): Digest {
  return canonicalJsonDigest({ job: (input.canonicalJob ?? input.job)?.trim(),
    request: input.pendingJobRevision ?? null, read_revision: input.pendingReadRevision ?? null,
    read_revision_request: input.readRevision ? { instruction: input.readRevision.instruction,
      provenance: input.readRevision.provenance, privacy_only: input.readRevision.privacy_only,
      vocabulary_only: input.readRevision.vocabulary_only ?? null,
      interpretation_instruction: input.readRevision.interpretation_instruction ?? null } : null,
    model: input.model && { provider: input.model.provider, model: input.model.model,
      destination: input.model.destination } });
}

export type AuthoringOwnerQuestionContextInput = {
  scope: Digest;
  binding: BoundaryAuthoringResumeBinding;
  candidate: ExplorationBoundaryDraft;
  sources?: PolicySourceSession;
  sourceContext?: PolicySourceSession;
  readerSchema: string;
  readerRole: string;
  inputActions?: ActionRuleAuthorityRevisionBaseline;
  policy?: { authority: ActionRuleAuthorityRevisionBaseline; action_schema: string | null; action_role: string | null };
};

/** Pure projection only. The caller still validates saved Source/current Resume,
 * inspects reader/Action posture, and holds the existing mutation permit at save. */
export function ownerQuestionContextDigest(input: AuthoringOwnerQuestionContextInput): Digest {
  return canonicalJsonDigest({ scope: input.scope, binding: input.binding,
    candidate: input.candidate, source: input.sources?.snapshots.length ? input.sourceContext ?? input.sources : null,
    reader_schema: input.readerSchema, reader_role: input.readerRole,
    ...(input.inputActions ? { input_actions: input.inputActions } : {}),
    ...(input.policy ? { policy: input.policy } : {}) });
}
