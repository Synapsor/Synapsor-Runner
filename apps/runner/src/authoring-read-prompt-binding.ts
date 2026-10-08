import { parseOperatorQuestions, type OperatorQuestion } from "./authoring-operator-question.js";
import type { AuthoringOwnerHandoff } from "./authoring-owner-handoff.js";
import type { AuthoringTransportState } from "./authoring-generation-recovery.js";

/** Existing Read prompt adapter admits only the current waiting owner. A raw
 * correction is tied to its exact declined review, not every revision handoff. */
export function readMeaningPromptHandoff(input: { handoffs: readonly AuthoringOwnerHandoff[];
  questions: readonly OperatorQuestion[]; generation?: AuthoringTransportState }) {
  const handoff = input.handoffs.at(-1);
  if (!handoff || handoff.state !== "waiting") return undefined;
  if (handoff.consumer === "read_clarification" || handoff.consumer === "read_value_context") return handoff;
  if (handoff.consumer !== "read_revision_instruction") return undefined;
  const questions = parseOperatorQuestions(input.questions, input.handoffs, input.generation);
  const question = questions.find(q => q.handoff_id === handoff.id && q.read_scope?.mode === "replacement_answer");
  if (!question || question.disposition || question.confirmation || question.raw_answer
    || question.scope_digest !== handoff.scope_digest || question.context_digest !== handoff.context_digest) return undefined;
  const review = questions.find(q => q.id === question.read_scope!.review_question_id);
  if (!review?.disposition || review.confirmation || review.read_scope?.mode !== "review"
    || questions.some(q => q.read_scope?.predecessor_id === review.id)) return undefined;
  return handoff;
}
