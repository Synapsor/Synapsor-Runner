import { loadActiveActionRuleAuthority, readActionRuleAuthorityActivation, unavailableReadDependencies } from "./action-rule-authority.js";
import { explorationBoundaryCandidateDigest, loadActivatedExplorationBoundaries,
  type ExplorationBoundaryDraft } from "./auto-boundary.js";

export type ReadActivationImpact = {
  assessment: "current" | "unavailable";
  newly_unavailable_outcomes: string[];
  already_unavailable_outcomes: string[];
};

/** Display only: a snapshot of exact dependency pins, never an activation decision. */
export async function readActivationImpact(projectRoot: string, candidate: ExplorationBoundaryDraft): Promise<ReadActivationImpact> {
  const empty: ReadActivationImpact = { assessment: "current", newly_unavailable_outcomes: [], already_unavailable_outcomes: [] };
  try {
    const current = await loadActivatedExplorationBoundaries(projectRoot).catch(error => {
      if (error?.code === "ENOENT") return [];
      throw error;
    });
    if (!await readActionRuleAuthorityActivation(projectRoot)) return empty;
    const actions = await loadActiveActionRuleAuthority(projectRoot, { read_boundaries: current, dependency_check: "report" });
    const before = new Set(unavailableReadDependencies(actions, current));
    const projected = [
      ...current.filter(boundary => boundary.pack.name !== candidate.pack.name),
      { pack: { name: candidate.pack.name }, source: candidate.source,
        generation_lock_fingerprint: candidate.generation_lock_fingerprint,
        activation: { digest: explorationBoundaryCandidateDigest(candidate) } },
    ];
    const affected = new Set(actions.registry.rules.filter(rule => rule.read_boundary_name === candidate.pack.name)
      .map(rule => rule.compiled.outcome));
    const after = unavailableReadDependencies(actions, projected).filter(outcome => affected.has(outcome));
    return { assessment: "current", newly_unavailable_outcomes: after.filter(outcome => !before.has(outcome)),
      already_unavailable_outcomes: after.filter(outcome => before.has(outcome)) };
  } catch {
    // A display failure must neither claim zero impact nor change activation authority.
    return { ...empty, assessment: "unavailable" };
  }
}

export function readActivationImpactLines(impact: ReadActivationImpact): string[] {
  if (impact.assessment === "unavailable") return [
    "ACTION DEPENDENCY IMPACT COULD NOT BE ASSESSED",
    "Read activation can pause verified Actions pinned to the current Read revision. Check Action status; affected outcomes need an Action recheck and then a fresh writer review before supervised execution resumes.",
  ];
  if (!impact.newly_unavailable_outcomes.length && !impact.already_unavailable_outcomes.length) return [];
  return [
    ...(impact.newly_unavailable_outcomes.length ? [
      "ACTIVATING THIS READ REVISION WILL PAUSE VERIFIED ACTIONS",
      ...impact.newly_unavailable_outcomes.map(outcome => `- ${outcome}`),
    ] : []),
    ...(impact.already_unavailable_outcomes.length ? [
      "These dependent outcomes are already unavailable and will remain unavailable:",
      ...impact.already_unavailable_outcomes.map(outcome => `- ${outcome}`),
    ] : []),
    "Each listed outcome needs an Action recheck and then a fresh writer review before supervised execution can resume.",
    "Actions pin the entire Read revision, including fields they do not use. This preview reflects the current saved authority.",
  ];
}
