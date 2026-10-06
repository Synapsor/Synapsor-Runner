import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { AskError } from "./model-provider-transport.js";
import type { OperatorQuestion } from "./authoring-operator-question.js";
import type { ActionAuthoringPendingVersion } from "./action-rule-authoring-checkpoint.js";
import type { AuthoringQuestionInteraction, AuthoringQuestionResponse } from "./authoring-question-interaction.js";

type Digest = `sha256:${string}`;
/** Version is owned by its existing Action logical turn, not an Input pool. */
export type VersionInteractionBinding = {
  turn_id: string;
  root_question_id: string;
  question_id: string;
  question_revision: number;
  question_digest: Digest;
  pending_version_digest: Digest;
  context_digest: Digest;
  scope_digest: Digest;
  proposal_digest?: Digest;
};
export type VersionInteraction = AuthoringQuestionInteraction<VersionInteractionBinding, { hasRawAnswer: boolean }>;
export type VersionInteractionResponse = AuthoringQuestionResponse<VersionInteractionBinding>;

export function versionInteractionBinding(marker: ActionAuthoringPendingVersion, q: OperatorQuestion): VersionInteractionBinding {
  return { turn_id: marker.turn_id, root_question_id: marker.root_question_id,
    question_id: q.id, question_revision: q.revision, question_digest: q.digest,
    pending_version_digest: canonicalJsonDigest(marker), context_digest: q.context_digest, scope_digest: q.scope_digest,
    ...(q.proposal ? { proposal_digest: canonicalJsonDigest(q.proposal) } : {}) };
}

export function assertVersionInteractionResponse(view: VersionInteraction, response: VersionInteractionResponse): void {
  if (canonicalJsonDigest(view.binding) !== canonicalJsonDigest(response.binding)
    || view.kind === "question" && (response.kind !== "answer" || response.raw !== null && typeof response.raw !== "string")
    || view.kind === "readback" && (response.kind !== "decision" || response.accepted !== null && typeof response.accepted !== "boolean")
    || view.kind === "pending" && (response.kind !== "pending" || !["keep", "answer"].includes(response.choice)
      || !view.canAnswer && response.choice !== "keep"))
    throw new AskError("ACTION_VERSION_QUESTION_STALE", "The answer does not match the saved counter question and owning Action. Preserve the current saved state.", 409);
}
