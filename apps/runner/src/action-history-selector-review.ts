import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import type { ActionRuleModelDraftV1 } from "./action-rule-draft.js";
import type { BoundaryReviewInteractiveSession } from "./boundary-cli-picker.js";
export type HistorySelectorReview = { before: ActionRuleModelDraftV1; after: ActionRuleModelDraftV1; read_digest: string };
export function historySelectorChanges(input: HistorySelectorReview) {
  const selected = (limit: ActionRuleModelDraftV1["approval"]["shared_limits"][number], outcome: string) => limit.capability ?? (limit.scope === "capability" ? outcome : null);
  return input.after.approval.shared_limits.flatMap(limit => {
    const old = input.before.approval.shared_limits.find(p => p.id === limit.id);
    return old && selected(old,input.before.outcome) !== selected(limit,input.after.outcome)
      ? [{ limit: limit.id, before: selected(old,input.before.outcome), after: selected(limit,input.after.outcome), scope: limit.scope, maximum: limit.maximum, window_seconds: limit.window_seconds }] : [];
  });
}
/** Exact disabled-edit confirmation, never publication or a new policy meaning. */
export async function reviewHistorySelectorChange(input: HistorySelectorReview, session: BoundaryReviewInteractiveSession,
  assertCurrent: () => Promise<void>): Promise<boolean> {
  const changes=historySelectorChanges(input);
  if (!changes.length) return true;
  await assertCurrent();
  const accepted=await session.confirm("Save this exact change to counted approval history in a disabled draft?", { defaultValue:false, context:[
    "COUNTED HISTORY SELECTION — EXPLICIT REVIEW",`Outcome: ${input.after.outcome}`,`Exact candidate: ${canonicalJsonDigest(input.after)}`,`Read dependency: ${input.read_digest}`,
    ...changes.map(c=>`${c.limit}: ${c.before ?? "all boundary automatic outcomes"} -> ${c.after ?? "all boundary automatic outcomes"}; ${c.scope}, maximum ${c.maximum}, inclusive ${c.window_seconds}s.`),
    "A capability filter counts retained automatic approvals with that exact canonical outcome. Other outcomes stop consuming this allowance; removing a filter includes them. No approval record is deleted or refunded. Human approvals remain excluded.",
    "This confirmation saves an implementation choice only. Business review, exact Action publication and execution approval remain separate. Declining keeps the existing saved rule unchanged.",
  ]});
  if(accepted!==true)return false;
  await assertCurrent();return true;
}
