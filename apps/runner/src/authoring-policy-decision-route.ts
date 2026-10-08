import type { AuthoringOwnerHandoff } from './authoring-owner-handoff.js';
import type { OperatorQuestion } from './authoring-operator-question.js';
import type { ReceiptRequirementResult } from './authoring-receipt-requirement-host.js';
import { ReviewResolutionError, type operatorReviewResolution } from './authoring-review-resolution.js';

type Resolution = ReturnType<typeof operatorReviewResolution>;
const ownsWaitingDecision = (handoff: AuthoringOwnerHandoff | undefined, questions: readonly OperatorQuestion[]) =>
  handoff?.state === 'waiting' && questions.filter(q => q.handoff_id === handoff.id).at(-1)?.kind === 'receipt_requirement';
const hasDecision = (resolution: Pick<Resolution, 'options'> | undefined) => resolution?.options.some(option =>
  option.operation === 'receipt_requirement_review' && option.availability === 'available') ?? false;

/** Entry-route adapter only. The production host owns nomination, mapping,
 * currentness and persistence; this adapter never selects a passage or answer. */
export function policyDecisionAllowsSavedReview(handoff: AuthoringOwnerHandoff | undefined, questions: readonly OperatorQuestion[]): boolean {
  return handoff?.state !== 'waiting' || ownsWaitingDecision(handoff, questions);
}
export async function resumePolicyDecision(input: {
  handoff: AuthoringOwnerHandoff | undefined; questions: readonly OperatorQuestion[];
  review(): Promise<ReceiptRequirementResult>;
}): Promise<{handled: false} | {handled: true; answer?: {answer: string; question: string}}> {
  if (!ownsWaitingDecision(input.handoff, input.questions)) return {handled: false};
  const result = await input.review();
  return {handled: true, ...(result.kind === 'saved' ? {answer: {answer: '', question: input.handoff!.question}} : {})};
}
export async function resolvePolicyDecision(input: {
  resolution: Resolution | undefined; review(): Promise<ReceiptRequirementResult>; recheck(): Promise<unknown>;
}): Promise<'not_routed' | 'handled'> {
  if (!hasDecision(input.resolution)) return 'not_routed';
  const result = await input.review();
  if (result.kind === 'no_target') return 'not_routed';
  if (result.kind === 'saved') await input.recheck();
  return 'handled';
}

/** One existing-host decision after one complete review. Pending decisions do
 * not buy another episode; ordinary validated reuse does not call this host. */
export async function reviewPolicyWithDecision<T>(input: {
  check(): Promise<T>; review?: () => Promise<ReceiptRequirementResult>;
  acknowledgeCurrent(): void; assertCurrent(): Promise<void>; presentBlocked(lines: readonly string[]): void;
}): Promise<T> {
  try { return await input.check(); }
  catch (error) {
    if (!(error instanceof ReviewResolutionError) || error.plan.recommended !== 'receipt_requirement_review'
      || !hasDecision(error.plan) || !input.review) throw error;
    const result = await input.review();
    input.acknowledgeCurrent();
    if (result.kind === 'blocked') input.presentBlocked(result.lines);
    if (result.kind !== 'saved') throw error;
    await input.assertCurrent();
    return input.check();
  }
}

/** The route's explanation follows its typed plan, never error-message text. */
export function policyReviewNextStep(plan: Resolution): string {
  if (plan.recommended === 'scoped_correction')
    return 'A bounded correction may be available within the existing review episode; the complete replacement must validate.';
  if (plan.recommended === 'source_transaction_scope_review')
    return 'Use the exact local source-outcome scope decision. Another model opinion cannot establish owner meaning.';
  if (plan.recommended === 'receipt_requirement_review')
    return 'Review the completion rule in ordinary business language, then confirm its exact applicability. Existing receipt storage is supplied separately; another model opinion cannot establish your meaning.';
  return 'Inspect the saved review and its actual prerequisite before starting another model episode.';
}
