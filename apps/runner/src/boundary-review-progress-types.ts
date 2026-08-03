export const BOUNDARY_REVIEW_PROGRESS_VERSION = "synapsor.boundary-review-progress.v2" as const;

export type BoundaryReviewDecision = {
  id: string;
  kind: string;
  decision: string;
  input_digest: `sha256:${string}`;
  resource_id?: string;
};

export type BoundaryReviewConfirmation = BoundaryReviewDecision & {
  status: "confirmed";
  actor: string;
  reason: string;
  confirmed_at: string;
};

export type BoundaryReviewInvalidation = {
  id: string;
  decision: string;
  previous_input_digest: `sha256:${string}`;
  current_input_digest?: `sha256:${string}`;
  reason: "reviewed_input_changed" | "decision_removed";
  invalidated_at: string;
};

export type BoundaryReviewProgressArtifact<TCandidate> = {
  schema_version: typeof BOUNDARY_REVIEW_PROGRESS_VERSION;
  revision: number;
  draft_digest: `sha256:${string}`;
  candidate: TCandidate;
  candidate_digest: `sha256:${string}`;
  confirmed_decisions: string[];
  confirmations: BoundaryReviewConfirmation[];
  invalidated_decisions: BoundaryReviewInvalidation[];
  updated_at: string;
};
