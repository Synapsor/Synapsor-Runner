import path from "node:path";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import type { RuntimeConfig } from "@synapsor-runner/mcp-server";
import { readRuntimeConfig } from "./cli-project.js";
import { loadActiveActionRuleAuthority } from "./action-rule-authority.js";
import { SEMANTIC_ACTION_RUNTIME_CONFIG } from "./semantic-action-deployment.js";
import { shellQuote } from "./cli-format.js";
import { cliCommandName } from "./cli-command-meta.js";

export type ReviewerGrantImpact = {
  state: "known" | "unknown" | "not_applicable";
  grants: Array<{ subject: string; removed_scopes: string[]; retained_scopes: string[] }>;
  reason?: string;
};

/** Complete operator configuration and authoritative outcome membership only.
 * This describes a proposed removal; it neither retires nor creates a grant. */
export function reviewerGrantRemovalImpact(identity: RuntimeConfig["operator_identity"],
  currentOutcomes: readonly string[], removedOutcomes: readonly string[]): ReviewerGrantImpact {
  if (!identity || identity.provider === "dev_env") return { state: "not_applicable", grants: [] };
  if (identity.provider !== "signed_key") return { state: "unknown", grants: [], reason: "EXTERNAL_REVIEWER_ROSTER_UNASSESSED" };
  const current = new Set(currentOutcomes), removed = new Set(removedOutcomes);
  if (removedOutcomes.some(outcome => !current.has(outcome))) return { state: "unknown", grants: [], reason: "ACTION_REMOVAL_BASELINE_CHANGED" };
  // Legacy roles may satisfy both APPLY and an approval mandate. Membership in
  // apply_roles does not establish that an unrestricted signer is APPLY-only.
  const unscoped = Object.values(identity.operators ?? {}).some(operator => operator.authority_kind !== "scoped_apply"
    && !operator.outcomes?.length && operator.roles.length > 0);
  const grants = Object.entries(identity.operators ?? {}).sort(([a], [b]) => a.localeCompare(b)).flatMap(([subject, operator]) => {
    if (operator.authority_kind === "scoped_apply") return [];
    // Legacy unrestricted reviewers are not converted to scoped ones here.
    if (!operator.outcomes?.length) return [];
    const removed_scopes = [...new Set(operator.outcomes.filter(outcome => removed.has(outcome)))].sort();
    if (!removed_scopes.length) return [];
    return [{ subject, removed_scopes, retained_scopes: [...new Set(operator.outcomes.filter(outcome => current.has(outcome) && !removed.has(outcome)))].sort() }];
  });
  return unscoped ? { state: "unknown", grants, reason: "UNRESTRICTED_LEGACY_REVIEWER_IMPACT_UNASSESSED" } : { state: "known", grants };
}

export async function inspectReviewerGrantRemovalImpact(input: {
  projectRoot: string; activeDigest: string; removedOutcomes: readonly string[]; env?: NodeJS.ProcessEnv;
}): Promise<ReviewerGrantImpact> {
  const configPath = path.join(input.projectRoot, SEMANTIC_ACTION_RUNTIME_CONFIG);
  try {
    const config = await readRuntimeConfig(configPath, { env: input.env });
    const active = await loadActiveActionRuleAuthority(input.projectRoot, { dependency_check: "report" });
    if (active.activation.digest !== input.activeDigest) return { state: "unknown", grants: [], reason: "ACTION_REMOVAL_BASELINE_CHANGED" };
    const result = reviewerGrantRemovalImpact(config.operator_identity,
      active.registry.rules.map(rule => rule.compiled.outcome), input.removedOutcomes);
    const latestConfig = await readRuntimeConfig(configPath, { env: input.env });
    const latestActive = await loadActiveActionRuleAuthority(input.projectRoot, { dependency_check: "report" });
    if (canonicalJsonDigest(config) !== canonicalJsonDigest(latestConfig) || active.activation.digest !== latestActive.activation.digest) {
      return { state: "unknown", grants: [], reason: "REVIEWER_OR_ACTION_CONFIGURATION_CHANGED" };
    }
    return result;
  } catch {
    return { state: "unknown", grants: [], reason: "CURRENT_REVIEWER_OR_ACTION_CONFIGURATION_UNAVAILABLE" };
  }
}

export function reviewerGrantImpactLines(impact: ReviewerGrantImpact, projectRoot: string): string[] {
  return [
    `Reviewer-grant impact: ${impact.state}${impact.reason ? ` (${impact.reason})` : ""}.`,
    ...impact.grants.map(grant => `${grant.subject}: removal leaves scope ${grant.removed_scopes.join(", ")} without an active outcome; ${grant.retained_scopes.length ? `other current scopes retained: ${grant.retained_scopes.join(", ")}` : "no other active restricted scope remains"}.`),
    ...(impact.state === "unknown" ? ["Unavailable impact is not evidence that no reviewers are affected. Inspect the current operator configuration before separate roster maintenance."] : []),
    ...(impact.grants.length ? [`Grant retirement is a separate reviewed operation: ${cliCommandName()} policy approver --config ${shellQuote(path.join(projectRoot, SEMANTIC_ACTION_RUNTIME_CONFIG))} --input <reviewed-roster.json>. Remove a last scoped reviewer entry; do not remove its restriction to create an unrestricted signer.`] : []),
    "This notice changes no reviewer or APPLY grant. Action removal and grant retirement are separate; historical approvals and verification material remain recorded.",
  ];
}
