import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { explorationBoundaryCandidateDigest, reviewExplorationBoundaryCandidate, type ExplorationBoundaryDraft } from "./auto-boundary.js";
import { assertReviewedReadRelationshipRetained, reviewReadRelationship, validateReviewedReadRelationship,
  type ReviewedReadRelationship } from "./read-relationship-review.js";

export type PreparedReadWorkloadRelationship = {
  previous_candidate_digest: `sha256:${string}`;
  generated_boundary: ExplorationBoundaryDraft;
  candidate: ExplorationBoundaryDraft;
  reviewed_relationship: ReviewedReadRelationship;
};

/** Exact existing review, no persistence or activation. The host owns the save. */
export async function prepareReadWorkloadRelationship(
  input: Parameters<typeof reviewReadRelationship>[0],
): Promise<PreparedReadWorkloadRelationship | undefined> {
  const previous = explorationBoundaryCandidateDigest(input.boundary);
  const generated = explorationBoundaryCandidateDigest(input.generatedBoundary);
  const reviewed = await reviewReadRelationship(input);
  if (!reviewed) return undefined;
  await input.assertCurrent();
  if (previous !== explorationBoundaryCandidateDigest(input.boundary)
    || generated !== explorationBoundaryCandidateDigest(input.generatedBoundary)) {
    throw new Error("READ_RELATIONSHIP_PROOF_STALE: The reviewed candidate or catalog changed during exact path review.");
  }
  const relationship = validateReviewedReadRelationship(reviewed, input.boundary, input.generatedBoundary);
  const candidate = structuredClone(input.boundary);
  candidate.pack.resources.find(resource => resource.id === reviewed.resource)!.relationships.push(relationship);
  const prepared = { previous_candidate_digest: previous, generated_boundary: input.generatedBoundary,
    candidate: reviewExplorationBoundaryCandidate(input.generatedBoundary, candidate).candidate, reviewed_relationship: reviewed };
  validateReadWorkloadRelationshipPreparation(prepared, input.boundary);
  return prepared;
}

/** Reject any callback update except the one exact, freshly reviewed path. */
export function validateReadWorkloadRelationshipPreparation(
  prepared: PreparedReadWorkloadRelationship,
  previous: ExplorationBoundaryDraft,
): ExplorationBoundaryDraft {
  if (prepared.previous_candidate_digest !== explorationBoundaryCandidateDigest(previous)) {
    throw new Error("READ_RELATIONSHIP_CANDIDATE_STALE: Relationship preparation belongs to another Read revision.");
  }
  if (prepared.generated_boundary.generation_lock_fingerprint !== previous.generation_lock_fingerprint) {
    throw new Error("READ_RELATIONSHIP_PROOF_STALE: Revalidate the current metadata and scope before preparing a relationship.");
  }
  const selected = validateReviewedReadRelationship(prepared.reviewed_relationship, previous, prepared.generated_boundary);
  const exact = structuredClone(previous);
  exact.pack.resources.find(resource => resource.id === prepared.reviewed_relationship.resource)!.relationships.push(selected);
  const expected = reviewExplorationBoundaryCandidate(prepared.generated_boundary, exact).candidate;
  if (canonicalJsonDigest(expected) !== canonicalJsonDigest(prepared.candidate)) {
    throw new Error("READ_RELATIONSHIP_PREPARATION_WIDENED: Relationship review may append only its exact selected path; preserve all fields, scope, privacy and unrelated policy.");
  }
  reviewExplorationBoundaryCandidate(prepared.generated_boundary, prepared.candidate);
  assertReviewedReadRelationshipRetained(prepared.reviewed_relationship, prepared.candidate);
  return prepared.candidate;
}
