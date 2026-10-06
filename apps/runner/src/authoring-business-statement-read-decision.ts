import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import type { AuthoringOwnerHandoff } from "./authoring-owner-handoff.js";
import type { OperatorQuestion } from "./authoring-operator-question.js";
import { PolicySourceChangedError } from "./authoring-policy-source.js";
import { authoringReadDecisionCheckpoint, type AuthoringTransportState } from "./authoring-generation-recovery.js";
import { readBoundaryRevisionCheckpoint, type ReadBoundaryRevisionCheckpoint } from "./read-boundary-revision-checkpoint.js";
import { readPrerequisiteCheckpoint } from "./read-prerequisite-checkpoint.js";
import { parseReadPrerequisiteBusinessDecisions, type ReadPrerequisiteBusinessDecision } from "./read-prerequisite-decisions.js";

export type ReadBusinessStatementDecision = {
  checkpoint?: ReadBoundaryRevisionCheckpoint;
  decisions?: ReadPrerequisiteBusinessDecision[];
  recovery?: AuthoringTransportState;
};

/** Existing Read-edit stage decisions only. The statement host owns testimony;
 * this adapter preserves the producer's nested checkpoint and private proof.
 * It performs no Source append, save, permission or acknowledgement. */
export function prepareReadBusinessStatementDecision(input: {
  handoff: AuthoringOwnerHandoff; question: OperatorQuestion; answer: string;
  checkpoint?: ReadBoundaryRevisionCheckpoint;
  decisions: readonly ReadPrerequisiteBusinessDecision[];
  recovery?: AuthoringTransportState;
}): ReadBusinessStatementDecision {
  const { handoff, question, answer, checkpoint } = input;
  const result: ReadBusinessStatementDecision = {};
  if (handoff.consumer === "read_revision_prerequisite") {
    const parent = checkpoint?.pending_question;
    const nested = parent?.kind === "private_prerequisite" ? parent.nested_checkpoint : undefined;
    const correction = question.target.phase === "read_prerequisite_correction";
    if (!checkpoint || checkpoint.stage === "dispatching" || parent?.kind !== "private_prerequisite" || !nested || nested.stage !== "waiting")
      throw new PolicySourceChangedError();
    if (correction ? nested.pending.kind !== "semantic_confirmation" || handoff.completion !== undefined
      : nested.pending.kind !== "clarification" || nested.pending.request.question !== handoff.question
        || canonicalJsonDigest(nested.pending.completion ?? null) !== canonicalJsonDigest(handoff.completion ?? null))
      throw new PolicySourceChangedError();
    const { digest: _nestedDigest, schema_version: _nestedVersion, ...body } = nested;
    const exchange = { question: handoff.question, answer };
    const decision = body.pending.kind === "clarification" ? body.pending.request.decision : undefined;
    const saved = decision && { decision_id: decision.decision_id, applicability_digest: decision.applicability_digest,
      question: decision.question, answer };
    const decisions = saved ? parseReadPrerequisiteBusinessDecisions([
      ...input.decisions.filter(record => record.decision_id !== saved.decision_id), saved]) : [...input.decisions];
    if (saved) result.decisions = decisions;
    const decided = readPrerequisiteCheckpoint({ ...body, stage: "decided",
      pending: body.pending.kind === "clarification"
        ? { ...body.pending, decision: { state: "answered", answer } }
        : { ...body.pending, decision: { state: "revise", instruction: answer } },
      state: { ...body.state, answers: [...body.state.answers, exchange],
        confirmed_answers: [...body.state.confirmed_answers, exchange],
        ...(body.pending.kind === "semantic_confirmation" ? { questioned_proposal: body.pending.proposal,
          questions: body.state.questions.filter(q => !decisions.some(d => d.question.trim().toLowerCase() === q)) } : {}),
        saved_decisions: saved ? parseReadPrerequisiteBusinessDecisions([
          ...body.state.saved_decisions.filter(record => record.decision_id !== saved.decision_id), saved]) : body.state.saved_decisions } });
    if (decided.pending?.kind === "semantic_confirmation" && decided.pending.completion)
      result.recovery = authoringReadDecisionCheckpoint(input.recovery, decided.pending.completion,
        decided.pending.proposal, decided.pending.decision);
    const { digest: _outerDigest, schema_version: _outerVersion, ...outer } = checkpoint;
    result.checkpoint = readBoundaryRevisionCheckpoint({ ...outer,
      pending_question: { ...parent, nested_checkpoint: decided } });
  }
  if (handoff.consumer === "read_revision_clarification") {
    if (!checkpoint || checkpoint.stage !== "waiting" || checkpoint.pending_question.kind !== "clarification"
      || checkpoint.pending_question.question !== handoff.question
      || canonicalJsonDigest(checkpoint.pending_question.completion ?? null) !== canonicalJsonDigest(handoff.completion ?? null))
      throw new PolicySourceChangedError();
    const { digest: _digest, schema_version: _version, ...body } = checkpoint;
    result.checkpoint = readBoundaryRevisionCheckpoint({ ...body, stage: "decided",
      pending_question: { ...checkpoint.pending_question, decision: { state: "answered", answer } },
      state: { ...body.state, clarification_count: body.state.clarification_count + 1,
        clarification_answers: [...body.state.clarification_answers, { question: handoff.question, answer }].slice(-16) } });
  }
  return result;
}
