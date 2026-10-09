import { ReadScopeReviewError } from "./authoring-read-scope-error.js";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { parseOperatorQuestion, parseOperatorQuestions, proposeOperatorAnswer, confirmOperatorAnswer,
  type OperatorQuestion } from "./authoring-operator-question.js";
import { parseReadScopeQuestionBinding, type ReadScopeQuestionBinding } from "./authoring-read-scope-binding.js";
import { assessReadScopeDraft, assessReadScopeRecordCurrentness, assertReadScopeProvenance,
  type ReadScopeBinding, type ReadScopeReference, type ReadScopeCatalog } from "./read-structured-scope.js";
import type { ReadWorkloadAnalysis } from "./read-workload-assist.js";
import type { AuthoringOwnerHandoff } from "./authoring-owner-handoff.js";
import type { AuthoringTransportState } from "./authoring-generation-recovery.js";

type Digest = `sha256:${string}`;
export type ReadScopeNativeInventory = { references: readonly ReadScopeReference[]; catalog: ReadScopeCatalog };
export function createReadScopeQuestion(input: { id: string; revision: number; scope_digest: Digest; context_digest: Digest;
  read_scope: ReadScopeQuestionBinding; handoff_id?: string; material?: string[] }): OperatorQuestion {
  const { material = [], ...identity } = input;
  const body = { version: 2, ...identity, read_scope: parseReadScopeQuestionBinding(input.read_scope), kind: "read_scope",
    target: { phase: "read_scope", outcomes: [] }, material, evidence: [], continuation: "read_mapping" };
  return parseOperatorQuestion({ ...body, digest: canonicalJsonDigest(body) });
}
function assertCurrentAnalysis(q: OperatorQuestion, binding: ReadScopeBinding, analysis: ReadWorkloadAnalysis | undefined,
  inventory: ReadScopeNativeInventory): void {
  if (!q.read_scope || q.read_scope.mode !== "review"
    || canonicalJsonDigest(q.read_scope.record.binding) !== canonicalJsonDigest(binding)) {
    throw new ReadScopeReviewError("READ_SCOPE_REVIEW_STALE", "Review the exact current analyzed Read proposal. No decision was accepted.");
  }
  assertReadScopeProvenance(q.read_scope.record, { expectedBinding: binding, ...inventory });
  const record = q.read_scope.record;
  if (record.proposal.applicability === "no_read_requested") {
    if (analysis !== undefined || record.analysis_digest !== undefined)
      throw new ReadScopeReviewError("READ_SCOPE_REVIEW_STALE", "A no-Read interpretation must not invent an analyzed Read plan.");
  } else if (!analysis || record.analysis_digest !== canonicalJsonDigest(analysis)
    || assessReadScopeDraft(record, analysis).status !== "compatible")
    throw new ReadScopeReviewError("READ_SCOPE_REVIEW_STALE", "Review the exact current analyzed Read proposal. No decision was accepted.");
}
/** Pure transition only. Caller persists through the existing Resume CAS after
 * rechecking current catalog, Source, request, question lineage and analysis. */
export function proposeReadScopeReview(value: OperatorQuestion, binding: ReadScopeBinding,
  analysis: ReadWorkloadAnalysis | undefined, inventory: ReadScopeNativeInventory): OperatorQuestion {
  const q = parseOperatorQuestion(value); assertCurrentAnalysis(q, binding, analysis, inventory);
  return proposeOperatorAnswer(q, { question_id: q.id, revision: q.revision,
    source_reference: canonicalJsonDigest(q.read_scope), disposition: "proposed",
    value: { kind: "read_scope", scope_digest: q.read_scope!.record.digest } });
}
export function confirmReadScopeReview(value: OperatorQuestion, binding: ReadScopeBinding,
  analysis: ReadWorkloadAnalysis | undefined, displayedQuestionDigest: Digest, inventory: ReadScopeNativeInventory): OperatorQuestion {
  const q = parseOperatorQuestion(value); assertCurrentAnalysis(q, binding, analysis, inventory);
  if (q.digest !== displayedQuestionDigest) throw new ReadScopeReviewError("READ_SCOPE_REVIEW_STALE", "The displayed review changed.");
  return confirmOperatorAnswer(q);
}
/** Reconstruct from actual native history, never a caller-supplied confirmed
 * boolean. A pending/declined replacement masks its predecessor, including an
 * older Yes; drift is rechecked against the current analyzed plan. */
export function resolveNativeReadScope(input: { questions: readonly OperatorQuestion[]; handoffs: readonly AuthoringOwnerHandoff[];
  generation?: AuthoringTransportState; question_id: string; expectedBinding: ReadScopeBinding; analysis?: ReadWorkloadAnalysis;
  references: readonly ReadScopeReference[]; catalog: ReadScopeCatalog }) {
  const questions = parseOperatorQuestions(input.questions, input.handoffs, input.generation);
  let q = questions.find(q => q.id === input.question_id && q.kind === "read_scope" && q.read_scope?.mode === "review");
  if (!q) throw new ReadScopeReviewError("READ_SCOPE_QUESTION_MISSING", "Inspect the existing native question history.");
  for (;;) {
    const next = questions.find(item => item.read_scope?.predecessor_id === q!.id);
    if (!next) break;
    q = next;
  }
  const record = q.read_scope!.record;
  const replacement_pending = questions.some(answer => answer.read_scope?.mode === "replacement_answer"
    && answer.read_scope.review_question_id === q.id);
  const current = assessReadScopeRecordCurrentness({ record, expectedBinding: input.expectedBinding });
  let provenanceCurrent = true;
  try { assertReadScopeProvenance(record, input); } catch { provenanceCurrent = false; }
  const currentAnswers = record.references.every(ref => ref.kind !== "answer" || (() => {
    const captured = questions.find(item => item.id === ref.question_id)!;
    return !captured.disposition && !questions.some(item => item.read_scope?.predecessor_id === captured.id);
  })());
  const analysisState = record.proposal.applicability === "no_read_requested"
    ? record.analysis_digest === undefined && input.analysis === undefined ? "ready" : "stale"
    : record.analysis_digest === undefined ? "pending"
    : input.analysis === undefined || record.analysis_digest !== canonicalJsonDigest(input.analysis) ? "stale"
    : assessReadScopeDraft(record, input.analysis).status === "delta_required" ? "stale"
    : assessReadScopeDraft(record, input.analysis).status === "pending" ? "pending" : "ready";
  const status: "proposed" | "confirmed" | "stale" | "pending" = !provenanceCurrent || !currentAnswers || analysisState === "stale" ? "stale"
    : analysisState === "pending" ? "pending"
    : replacement_pending || q.disposition || q.read_scope!.mode !== "review" ? "pending"
    : current.status === "proposed" && q.confirmation ? "confirmed" : current.status;
  return { ...current, status, question: q, replacement_pending };
}
