import type { inspectDatabase } from "@synapsor-runner/schema-inspector";
import {
  commitExactBoundaryCandidateMutation,
  prepareExactBoundaryCandidateMutation,
  type BoundaryExactCandidateMutationPreview,
  type BoundaryReviewMutationBindings,
} from "./boundary-review-mutation.js";
import {
  recordReadWorkloadReview,
  type ReadWorkloadReview,
  type ReadWorkloadView,
} from "./read-workloads.js";

export type ReadWorkloadCandidatePreview = {
  workload: ReadWorkloadView;
  mutation: BoundaryExactCandidateMutationPreview;
  authority_activated: false;
  source_database_changed: false;
};

export async function prepareReadWorkloadCandidate(input: {
  projectRoot: string;
  workload: ReadWorkloadView;
  actor: string;
  reason: string;
  expectedBindings?: BoundaryReviewMutationBindings;
  schemaInspector?: typeof inspectDatabase;
}): Promise<ReadWorkloadCandidatePreview> {
  if (input.workload.state !== "ready") {
    throw new Error(
      `READ_WORKLOAD_NOT_REVIEWABLE: ${input.workload.analysis_id} is ${input.workload.state}; re-run analysis against the current generated boundary.`,
    );
  }
  const candidate = input.workload.analysis.candidate;
  const candidateDigest = input.workload.analysis.candidate_digest;
  if (!candidate || !candidateDigest) {
    throw new Error("READ_WORKLOAD_NOT_REVIEWABLE: a ready workload must contain one exact disabled candidate.");
  }
  const mutation = await prepareExactBoundaryCandidateMutation(
    input.projectRoot,
    {
      candidate,
      expected_generated_boundary_digest: input.workload.generated_boundary_digest,
      expected_candidate_digest: candidateDigest,
      actor: input.actor,
      reason: input.reason,
      ...(input.expectedBindings ? { expected_bindings: input.expectedBindings } : {}),
    },
    input.schemaInspector,
  );
  return {
    workload: input.workload,
    mutation,
    authority_activated: false,
    source_database_changed: false,
  };
}

export async function commitReadWorkloadCandidate(input: {
  projectRoot: string;
  preview: ReadWorkloadCandidatePreview;
  now?: string;
}): Promise<{
  candidate_digest: `sha256:${string}`;
  review_revision: number;
  review: ReadWorkloadReview;
  authority_activated: false;
  source_database_changed: false;
}> {
  const committed = await commitExactBoundaryCandidateMutation(
    input.projectRoot,
    input.preview.mutation,
  );
  const review = await recordReadWorkloadReview({
    projectRoot: input.projectRoot,
    workload: input.preview.workload,
    candidateDigest: committed.candidate_digest,
    reviewRevision: committed.review_revision,
    ...(input.now ? { now: input.now } : {}),
  });
  return {
    candidate_digest: committed.candidate_digest,
    review_revision: committed.review_revision,
    review,
    authority_activated: false,
    source_database_changed: false,
  };
}
