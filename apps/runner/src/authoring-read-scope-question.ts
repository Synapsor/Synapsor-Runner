import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { parseOperatorQuestion, parseOperatorQuestions, proposeOperatorAnswer, confirmOperatorAnswer,
  type OperatorQuestion } from "./authoring-operator-question.js";
import { parseReadScopeQuestionBinding, type ReadScopeQuestionBinding } from "./authoring-read-scope-binding.js";
import { assessReadScopeDraft, currentReadScope, type ReadScopeBinding } from "./read-structured-scope.js";
import type { ReadWorkloadAnalysis } from "./read-workload-assist.js";
import type { AuthoringOwnerHandoff } from "./authoring-owner-handoff.js";
import type { AuthoringTransportState } from "./authoring-generation-recovery.js";

type Digest = `sha256:${string}`;
export function createReadScopeQuestion(input: { id: string; revision: number; scope_digest: Digest; context_digest: Digest;
  read_scope: ReadScopeQuestionBinding; handoff_id?: string; material?: string[] }): OperatorQuestion {
  const { material = [], ...identity } = input;
  const body = { version: 2, ...identity, read_scope: parseReadScopeQuestionBinding(input.read_scope), kind: "read_scope",
    target: { phase: "read_scope", outcomes: [] }, material, evidence: [], continuation: "read_mapping" };
  return parseOperatorQuestion({ ...body, digest: canonicalJsonDigest(body) });
}
function assertCurrentAnalysis(q: OperatorQuestion, binding: ReadScopeBinding, analysis: ReadWorkloadAnalysis): void {
  if (!q.read_scope || q.read_scope.mode !== "review"
    || canonicalJsonDigest(q.read_scope.record.binding) !== canonicalJsonDigest(binding)
    || q.read_scope.record.analysis_digest !== canonicalJsonDigest(analysis)
    || assessReadScopeDraft(q.read_scope.record, analysis).status !== "compatible") {
    throw new Error("READ_SCOPE_REVIEW_STALE: Review the exact current analyzed Read proposal. No decision was accepted.");
  }
}
/** Pure transition only. Caller persists through the existing Resume CAS after
 * rechecking current catalog, Source, request, question lineage and analysis. */
export function proposeReadScopeReview(value: OperatorQuestion, binding: ReadScopeBinding,
  analysis: ReadWorkloadAnalysis): OperatorQuestion {
  const q = parseOperatorQuestion(value); assertCurrentAnalysis(q, binding, analysis);
  return proposeOperatorAnswer(q, { question_id: q.id, revision: q.revision,
    source_reference: canonicalJsonDigest(q.read_scope), disposition: "proposed",
    value: { kind: "read_scope", scope_digest: q.read_scope!.record.digest } });
}
export function confirmReadScopeReview(value: OperatorQuestion, binding: ReadScopeBinding,
  analysis: ReadWorkloadAnalysis, displayedQuestionDigest: Digest): OperatorQuestion {
  const q = parseOperatorQuestion(value); assertCurrentAnalysis(q, binding, analysis);
  if (q.digest !== displayedQuestionDigest) throw new Error("READ_SCOPE_REVIEW_STALE: The displayed review changed.");
  return confirmOperatorAnswer(q);
}
/** Reconstruct from actual native history, never a caller-supplied confirmed
 * boolean. A pending/declined replacement masks its predecessor, including an
 * older Yes; drift is rechecked against the current analyzed plan. */
export function resolveNativeReadScope(input: { questions: readonly OperatorQuestion[]; handoffs: readonly AuthoringOwnerHandoff[];
  generation?: AuthoringTransportState; question_id: string; expectedBinding: ReadScopeBinding; analysis: ReadWorkloadAnalysis }) {
  const questions = parseOperatorQuestions(input.questions, input.handoffs, input.generation);
  let q = questions.find(q => q.id === input.question_id && q.kind === "read_scope" && q.read_scope?.mode === "review");
  if (!q) throw new Error("READ_SCOPE_QUESTION_MISSING: Inspect the existing native question history.");
  for (;;) {
    const next = questions.find(item => item.read_scope?.predecessor_id === q!.id);
    if (!next) break;
    q = next;
  }
  const record = q.read_scope!.record;
  const current = currentReadScope({ record, expectedBinding: input.expectedBinding,
    ...(q.confirmation && !q.disposition ? { confirmation: { actor: q.confirmation.actor, proposal_digest: record.digest } } : {}),
    pendingReplacement: !!q.disposition });
  const currentAnswers = record.references.every(ref => ref.kind !== "answer" || (() => {
    const captured = questions.find(item => item.id === ref.question_id)!;
    return !captured.disposition && !questions.some(item => item.read_scope?.predecessor_id === captured.id);
  })());
  const analysisMatches = currentAnswers && record.analysis_digest === canonicalJsonDigest(input.analysis)
    && assessReadScopeDraft(record, input.analysis).status === "compatible";
  return { ...current, status: analysisMatches ? current.status : "stale" as const, question: q };
}
