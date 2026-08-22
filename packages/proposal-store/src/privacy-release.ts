import type {
  ExplorePrivacyReleaseClaim,
  ExplorePrivacyReleaseInput,
} from "./domain-types.js";

export type NormalizedExplorePrivacyReleaseClaim = ExplorePrivacyReleaseClaim & {
  complement_fingerprints: `sha256:${string}`[];
};

export function normalizedExplorePrivacyReleaseClaims(
  input: ExplorePrivacyReleaseInput,
): NormalizedExplorePrivacyReleaseClaim[] {
  const claims: ExplorePrivacyReleaseClaim[] = [{
    complement_fingerprints: input.complement_fingerprints,
    release_kind: input.release_kind,
  }, ...(input.additional_releases ?? [])];
  const seen = new Set<string>();
  return claims.flatMap((claim) => {
    const fingerprints = [...new Set(claim.complement_fingerprints)].sort();
    if (fingerprints.length === 0) return [];
    const key = JSON.stringify([
      claim.release_kind,
      claim.conflict_reason ?? null,
      fingerprints,
    ]);
    if (seen.has(key)) return [];
    seen.add(key);
    return [{ ...claim, complement_fingerprints: fingerprints }];
  });
}
