/** Outcome discovery only. The host must still revalidate exact dependencies and review authority. */
export function savedActionRecoveryOutcomes(input: {
  boundaryName: string;
  resumeBoundaryName?: string;
  preferredSavedOutcomes?: readonly string[];
  // Built by the host from preferred saved authorities for this exact Boundary,
  // including older dependencies. It is not an activation or fresh-source proof.
  readDigestByOutcome?: ReadonlyMap<string, `sha256:${string}`>;
}): string[] {
  if (!input.boundaryName || input.resumeBoundaryName !== input.boundaryName) return [];
  // Current saved rules are still required when an unfinished agenda is absent.
  // Staleness decides how to validate a dependency, not whether the rule exists.
  const outcomes = [...new Set(input.preferredSavedOutcomes ?? [])];
  for (const outcome of outcomes) {
    if (!input.readDigestByOutcome?.has(outcome)) {
      throw new Error(`ACTION_RULE_RECOVERY_INVENTORY_INCOMPLETE: ${outcome} has no selected Read dependency. Reload the saved job; no authority was changed.`);
    }
  }
  return outcomes;
}
