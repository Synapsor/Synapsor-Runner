import { loadActivatedExplorationBoundaries } from "./auto-boundary.js";
import { loadActiveActionRuleAuthority } from "./action-rule-authority.js";
import type { BoundaryAuthoringResumeState } from "./boundary-authoring-resume.js";
import { activePolicySource, loadPolicySources } from "./authoring-policy-source.js";
import { policyReadinessItems } from "./authoring-review-readiness.js";

/** This only restores navigation. Every runtime operation still resolves
 * current authority and trusted identity independently. */
export async function clientHandoffMatchesActiveAuthority(root: string, saved: BoundaryAuthoringResumeState): Promise<boolean> {
  if (saved.stage !== "client_setup" || !saved.client_handoff) return false;
  const reads = await loadActivatedExplorationBoundaries(root);
  const actions = await loadActiveActionRuleAuthority(root).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  });
  return reads.some((boundary) => boundary.pack.name === saved.binding.boundary_name
    && boundary.activation.digest === saved.client_handoff!.read_digest)
    && actions?.authority.action_boundary.digest === saved.client_handoff.action_digest;
}

export async function pendingClientResponsibilities(root: string, saved: BoundaryAuthoringResumeState): Promise<string[]> {
  if (!saved.policy_source_session) return [];
  const sources = await loadPolicySources(root, saved.policy_source_session);
  const source = activePolicySource(sources);
  if (!source || !sources.coverage || sources.coverage.source_digest !== source.digest) {
    return ["Attached rules need a current coverage check. Client behavior has not been verified."];
  }
  return policyReadinessItems(sources.coverage, sources).filter((item) => item.kind === "deployment_prerequisite")
    .flatMap((item) => [
      `${item.title}: ${item.passages.some((passage) => passage.deployment_prerequisite) ? "runtime identity setup pending" : item.blocksReview ? "assignment pending" : "assigned to your client application"}; not verified.`,
      item.nextStep,
    ]);
}
