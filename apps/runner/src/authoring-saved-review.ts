import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { listActionRuleAuthorityDrafts } from "./action-rule-authority.js";
import { readBoundaryAuthoringResumeState, type BoundaryAuthoringResumeBinding } from "./boundary-authoring-resume.js";
import { activePolicySource, loadPolicySources } from "./authoring-policy-source.js";
import { policyReviewReadiness } from "./authoring-review-readiness.js";

/** Status/navigation projection only. Never replaces the current guided
 * coverage check, exact activation review, or runtime admission. */
export async function savedAuthoringPolicyReview(input: {
  projectRoot: string; binding: BoundaryAuthoringResumeBinding; readDigest: string;
}): Promise<ReturnType<typeof policyReviewReadiness> | undefined> {
  const pending = (message: string) => ({ ready: false, privacy: false, summary: [message,
    "Resume the saved job to recheck its policy and pending work. Active authority is unchanged."] });
  const loaded = await readBoundaryAuthoringResumeState(input.projectRoot, input.binding);
  if (loaded.status === "none") return undefined;
  if (loaded.status === "invalid") return pending("The saved job needs recovery before its review can continue.");
  const saved = loaded.value;
  if (!saved.policy_source_session) return undefined;
  if (loaded.status !== "ready") return pending("The saved policy review belongs to older database or access metadata.");
  try {
    const session = await loadPolicySources(input.projectRoot, saved.policy_source_session);
    const source = activePolicySource(session);
    if (!source) return undefined;
    const drafts = await listActionRuleAuthorityDrafts(input.projectRoot);
    const authorityDigests = (drafts.length ? drafts.map(draft => draft.digest) : [null])
      .map(action => canonicalJsonDigest({ read: input.readDigest, action }));
    if (!session.coverage || session.coverage.source_digest !== source.digest
      || !session.coverage_authority_digest || !authorityDigests.some(digest => digest === session.coverage_authority_digest)) {
      return pending("Attached rules need a current interpretation check for this saved revision.");
    }
    const review = policyReviewReadiness(source, session.coverage, session);
    if (saved.pending_job_revision || saved.pending_read_revision || saved.pending_action_revision
      || saved.pending_action_removal || saved.pending_action_addition
      || !["authority_review", "client_setup"].includes(saved.stage)) {
      return { ...review, ready: false, summary: ["A saved edit or unfinished drafting step is still pending.", ...review.summary] };
    }
    return { ...review, summary: [...review.summary,
      "This is the saved policy interpretation, not a live check or activation. Exact authority and execution reviews remain separate."] };
  } catch {
    return pending("The saved policy review is unavailable; the policy and draft have not been changed.");
  }
}
