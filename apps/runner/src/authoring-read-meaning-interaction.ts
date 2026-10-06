import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { PolicySourceChangedError } from "./authoring-policy-source.js";
import type { AuthoringOwnerHandoff } from "./authoring-owner-handoff.js";
import type { OperatorQuestion } from "./authoring-operator-question.js";
import type { ReadWorkloadAssistanceCheckpoint } from "./read-workload-assistance-checkpoint.js";
import type { ModelReadClarificationRequest } from "./read-authoring-contract-types.js";
import type { AuthoringQuestionInteraction, AuthoringQuestionResponse } from "./authoring-question-interaction.js";

type Digest = `sha256:${string}`;
export type PreviousReadMeaning = ModelReadClarificationRequest & { answer: string };
export type ReadMeaningInteractionBinding = {
  question_id: string; question_revision: number; question_digest: Digest;
  handoff_digest: Digest; assistance_digest: Digest;
  context_digest: Digest; scope_digest: Digest; proposal_digest?: Digest;
};
type View = AuthoringQuestionInteraction<ReadMeaningInteractionBinding>;
export type ReadMeaningInteraction =
  | (Extract<View, { kind: "question" }> & { request: ModelReadClarificationRequest; previous?: PreviousReadMeaning })
  | (Extract<View, { kind: "readback" }> & { purpose: "meaning" | "decline" | "replacement" })
  | Extract<View, { kind: "pending" }>;
export type ReadMeaningInteractionResponse = AuthoringQuestionResponse<ReadMeaningInteractionBinding>;

/** Only a view of the existing native initial-Read records. Counter advancement
 * is still validated by the producer and Resume journal; no new stored cursor. */
export function readMeaningInteractionBinding(question: OperatorQuestion, handoff: AuthoringOwnerHandoff,
  checkpoint: ReadWorkloadAssistanceCheckpoint): ReadMeaningInteractionBinding {
  return { question_id: question.id, question_revision: question.revision, question_digest: question.digest,
    handoff_digest: handoff.digest, assistance_digest: checkpoint.digest,
    context_digest: question.context_digest, scope_digest: question.scope_digest,
    ...(question.proposal ? { proposal_digest: canonicalJsonDigest(question.proposal) } : {}) };
}

export function assertReadMeaningInteractionResponse(view: ReadMeaningInteraction, response: ReadMeaningInteractionResponse): void {
  if (canonicalJsonDigest(view.binding) !== canonicalJsonDigest(response.binding)
    || view.kind === "question" && (response.kind !== "answer" || response.raw !== null && typeof response.raw !== "string")
    || view.kind === "readback" && (response.kind !== "decision" || response.accepted !== null && typeof response.accepted !== "boolean")
    || view.kind === "pending" && (response.kind !== "pending" || !["keep", "answer"].includes(response.choice)
      || !view.canAnswer && response.choice !== "keep")) throw new PolicySourceChangedError();
}
