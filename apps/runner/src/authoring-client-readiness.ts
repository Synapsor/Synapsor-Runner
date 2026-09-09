import { loadActivatedExplorationBoundaries } from "./auto-boundary.js";
import { loadActiveActionRuleAuthority, readActionRuleAuthorityActivation } from "./action-rule-authority.js";
import type { BoundaryAuthoringResumeState } from "./boundary-authoring-resume.js";
import { activePolicySource, loadPolicySources } from "./authoring-policy-source.js";
import { policyReadinessItems } from "./authoring-review-readiness.js";
import { needsDeploymentCoverageClassification } from "./authoring-policy-coverage.js";
import { guidedActionStatus } from "./guided-action.js";
import { readSemanticSupervisedExecutionState } from "./semantic-action-deployment.js";

export type PostActivationReadiness = {
  read: "active" | "inactive";
  legacy_actions: "active" | "inactive";
  semantic_actions: "active" | "inactive";
  semantic_outcomes: Array<{ outcome: string; approval_mode: "human" | "policy"; execution_enabled: boolean }>;
  worker: "not_checked";
};

/** Saved authority metadata only, never a source/worker probe or an activation. */
export async function readPostActivationReadiness(projectRoot: string): Promise<PostActivationReadiness> {
  const reads = await loadActivatedExplorationBoundaries(projectRoot).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  });
  const legacy = await guidedActionStatus(projectRoot);
  const activation = await readActionRuleAuthorityActivation(projectRoot);
  const semantic = activation === undefined ? undefined : await loadActiveActionRuleAuthority(projectRoot);
  const execution = semantic ? await readSemanticSupervisedExecutionState({ projectRoot }) : undefined;
  const outcomes = semantic?.authority.action_boundary.rules.map((rule) => ({
    outcome: rule.outcome, approval_mode: rule.approval_mode,
    execution_enabled: Boolean(execution?.enabled && execution.policies.some((policy) =>
      policy.outcome === rule.outcome && policy.action_boundary_digest === semantic.authority.action_boundary.digest)),
  })) ?? [];
  return {
    read: reads.length ? "active" : "inactive",
    legacy_actions: legacy.action_boundary.active?.authority.capabilities.length ? "active" : "inactive",
    semantic_actions: outcomes.length ? "active" : "inactive",
    semantic_outcomes: outcomes,
    worker: "not_checked",
  };
}

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
  return policyReadinessItems(sources.coverage, sources).filter((item) => item.kind === "deployment_prerequisite"
    || item.passages.some(needsDeploymentCoverageClassification))
    .flatMap((item) => [
      `${item.title}: ${item.passages.some(needsDeploymentCoverageClassification) ? "setup classification pending"
        : item.passages.some((passage) => passage.deployment_prerequisite === "runner_client_connection")
        ? "Runner client connection setup pending"
        : item.passages.some((passage) => passage.deployment_prerequisite === "authenticated_identity")
          ? "runtime identity setup pending" : item.blocksReview ? "assignment pending" : "assigned to your client application"}; not verified.`,
      item.nextStep,
    ]);
}
