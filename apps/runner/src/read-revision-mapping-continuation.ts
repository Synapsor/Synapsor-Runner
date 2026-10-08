import { canonicalJsonDigest as d } from "@synapsor-runner/protocol";
import { explorationBoundaryCandidateDigest, type ExplorationBoundaryDraft } from "./auto-boundary.js";
import type { BoundaryAuthoringResumeRead, BoundaryAuthoringReadRevision } from "./boundary-authoring-resume.js";
import { parseReadWorkloadAssistanceCheckpoint } from "./read-workload-assistance-checkpoint.js";
import { resolveNativeReadScope } from "./authoring-read-scope-question.js";
import type { CurrentStructuredReadEvidence } from "./read-current-evidence.js";
import type { ReadWorkloadView } from "./read-workloads.js";

export type ReadRevisionMappingOwner = Pick<CurrentStructuredReadEvidence, "questions" | "handoffs" | "generation" | "question_id">
  & { read: BoundaryAuthoringResumeRead; revision: BoundaryAuthoringReadRevision; currentBoundary: ExplorationBoundaryDraft; priorAnalysis: Pick<ReadWorkloadView, "analysis_id" | "analysis_digest" | "analysis"> };
/** Existing native records only; this is admission to a new bounded mapping,
 * never permission to replay the completed revision or reuse its predecessor Yes. */
export function readRevisionMappingContinuation(input: ReadRevisionMappingOwner,
  current: Pick<CurrentStructuredReadEvidence, "expectedBinding" | "references" | "catalog">) {
  const fail = (): never => { throw new Error("READ_REVISION_MAPPING_STALE: Reopen the exact committed, consumed Read revision and its retained mapping history. No new mapping was sent."); };
  const revision = input.revision;
  if (revision.result_received !== true || revision.terminal_reason || revision.checkpoint
    || !revision.saved_read_digest || revision.saved_read_digest !== explorationBoundaryCandidateDigest(input.currentBoundary)
    || revision.scope_question_id !== input.question_id || !input.read.assistance_history) fail();
  const resolved = resolveNativeReadScope({ ...input, ...current });
  const question = resolved.question;
  if (question.id !== input.question_id || question.read_scope?.mode !== "review"
    || question.read_scope.record.proposal.applicability !== "read_requested" || question.read_scope.record.analysis_digest !== undefined
    || question.confirmation || question.proposal || question.disposition || resolved.status !== "pending" || resolved.replacement_pending) fail();
  const prior = input.priorAnalysis;
  if (prior.analysis_id !== input.read.analysis_id || prior.analysis_digest !== input.read.analysis_digest) fail();
  let ancestor = question;
  while (ancestor.read_scope?.predecessor_id && ancestor.id !== input.read.scope_question_id) {
    const next = input.questions.find(q => q.id === ancestor.read_scope!.predecessor_id); if (!next) fail(); ancestor = next!;
  }
  if (ancestor.id !== input.read.scope_question_id || ancestor.read_scope?.record.analysis_digest !== d(prior.analysis)) fail();
  const history = parseReadWorkloadAssistanceCheckpoint(input.read.assistance_history);
  if (history.stage !== "dispatching" || !history.state.call_count || !history.state.attempt
    || history.previous_question?.stage === "waiting") fail();
  if (!history.state.scope_invocation_binding)
    throw new Error("READ_REVISION_MAPPING_HISTORY_UNSUPPORTED: This mapping history predates the required invocation binding. It was preserved unchanged; no migration, allowance reset or mapping was started.");
  return { question, history };
}
