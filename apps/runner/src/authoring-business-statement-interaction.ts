import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import type { AuthoringOwnerHandoff } from "./authoring-owner-handoff.js";
import type { OperatorQuestion } from "./authoring-operator-question.js";
import { PolicySourceChangedError } from "./authoring-policy-source.js";
import type { AuthoringQuestionInteraction, AuthoringQuestionResponse } from "./authoring-question-interaction.js";

type Digest = `sha256:${string}`;
export type BusinessStatementBinding = {
  question_id: string; question_revision: number; question_digest: Digest;
  handoff_id: string; handoff_digest: Digest; context_digest: Digest; scope_digest: Digest;
  proposal_digest?: Digest; producer_question_digest?: Digest; read_checkpoint_digest?: Digest;
};
type View = AuthoringQuestionInteraction<BusinessStatementBinding>;
/** These three retained-answer operations have different durable effects.
 * They do not change the pending choices of Input, Version or initial Read. */
export type BusinessStatementInteraction = Extract<View, { kind: "question" }>
  | (Extract<View, { kind: "readback" }> & { question: string })
  | { kind: "pending"; binding: BusinessStatementBinding; lines: readonly string[];
      defaultValue: "keep"; canReplace: boolean; canReview?: boolean };
export type BusinessStatementResponse = Exclude<AuthoringQuestionResponse<BusinessStatementBinding>, { kind: "pending" }>
  | { kind: "pending"; binding: BusinessStatementBinding; choice: "keep" | "review" | "replace" };

export function businessStatementBinding(question: OperatorQuestion, handoff: AuthoringOwnerHandoff,
  producerQuestionDigest?: Digest, readCheckpointDigest?: Digest): BusinessStatementBinding {
  return { question_id: question.id, question_revision: question.revision, question_digest: question.digest,
    handoff_id: handoff.id, handoff_digest: handoff.digest,
    context_digest: question.context_digest, scope_digest: question.scope_digest,
    ...(question.proposal ? { proposal_digest: canonicalJsonDigest(question.proposal) } : {}),
    ...(producerQuestionDigest ? { producer_question_digest: producerQuestionDigest } : {}),
    ...(readCheckpointDigest ? { read_checkpoint_digest: readCheckpointDigest } : {}) };
}

export function assertBusinessStatementResponse(view: BusinessStatementInteraction, response: BusinessStatementResponse): void {
  if (canonicalJsonDigest(view.binding) !== canonicalJsonDigest(response.binding)
    || view.kind === "question" && (response.kind !== "answer" || response.raw !== null && typeof response.raw !== "string")
    || view.kind === "readback" && (response.kind !== "decision" || response.accepted !== null && typeof response.accepted !== "boolean")
    || view.kind === "pending" && (response.kind !== "pending" || !["keep", "review", "replace"].includes(response.choice)
      || response.choice === 'replace' && view.canReview !== undefined && !view.canReplace || response.choice === 'review' && view.canReview === false))
    throw new PolicySourceChangedError();
}
