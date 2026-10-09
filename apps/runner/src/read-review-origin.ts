import type { z } from "zod";
import { readReviewOriginSchema } from "./boundary-review-progress-types.js";
export { readReviewOriginSchema } from "./boundary-review-progress-types.js";
import { explorationBoundaryCandidateDigest, type ExplorationBoundaryDraft } from "./auto-boundary.js";
import { decodeOperatorAuthority } from "./control-policy-authority-codec.js";
import { OPERATOR_READ_AUTHORING_KEY } from "./control-policy-record.js";
import { openBoundProjectControlPolicies } from "./control-policy-store.js";
import { withProjectAuthorityMutation, withHeldProjectAuthorityAccess, type ProjectAuthorityMutationPermit } from "./project-authority-mutation.js";

export type ReadReviewOrigin = z.infer<typeof readReviewOriginSchema>;

const unavailable = (): never => {
  throw Object.assign(new Error("The exact original Read review candidate is unavailable. Retain its confirmation without treating changed inputs as approved."),
    { code: "READ_REVIEW_ORIGIN_UNAVAILABLE" });
};

/** Resolves original reviewed inputs, not a new confirmation or current grant.
 * The native writer binds this reference to its actual pre-confirmation
 * revision. Later rescans retain that reference instead of minting a new Yes.
 * No latest-revision lookup, text reconstruction or exported-file fallback. */
type ResolvedReadReviewOrigin = { reference: ReadReviewOrigin; candidate: ExplorationBoundaryDraft };
export async function resolveReadReviewOrigin(projectRoot: string, rawOrigin: unknown): Promise<ResolvedReadReviewOrigin> {
  return withProjectAuthorityMutation(projectRoot, held => resolveReadReviewOriginUnlocked(held, rawOrigin));
}
export async function resolveReadReviewOriginHeld(projectRoot: string, rawOrigin: unknown,
  permit: ProjectAuthorityMutationPermit): Promise<ResolvedReadReviewOrigin> {
  return withHeldProjectAuthorityAccess(projectRoot, permit, held => resolveReadReviewOriginUnlocked(held, rawOrigin));
}
async function resolveReadReviewOriginUnlocked(held: ProjectAuthorityMutationPermit, rawOrigin: unknown): Promise<ResolvedReadReviewOrigin> {
  const reference = readReviewOriginSchema.parse(rawOrigin);
    const binding = await openBoundProjectControlPolicies(held.projectRoot);
    if (!binding) return unavailable();
    try {
      const revision = await binding.repository.revision(binding.deployment_id, OPERATOR_READ_AUTHORING_KEY, reference.revision_id);
      if (!revision || revision.revision_id !== reference.revision_id) return unavailable();
      const policy = decodeOperatorAuthority(revision);
      if (policy.type !== "read_authoring") return unavailable();
      const entry = policy.entries.find(candidate => candidate.progress.boundary_id === reference.boundary_id);
      if (!entry || entry.progress.candidate_digest !== reference.candidate_digest
        || explorationBoundaryCandidateDigest(entry.progress.candidate) !== reference.candidate_digest) return unavailable();
      return { reference: structuredClone(reference), candidate: structuredClone(entry.progress.candidate) };
    } finally { await binding.close(); }
}
