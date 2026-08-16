export const BOUNDARY_REVIEW_PROGRESS_VERSION = "synapsor.boundary-review-progress.v3" as const;

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

export type BoundaryReviewPolicyMigration = {
  status: "complete" | "review_required";
  source: "native" | "legacy_exact_boundary_revision";
  reason: string;
};

export type BoundaryReviewProgressArtifact<TCandidate, TReviewOverrides> = {
  schema_version: typeof BOUNDARY_REVIEW_PROGRESS_VERSION;
  /** Stable local identity. Boundary names remain editable display labels. */
  boundary_id: `bnd_${string}`;
  /** Human policy owned by this exact boundary, never shared by resource id. */
  review_overrides: TReviewOverrides;
  policy_migration: BoundaryReviewPolicyMigration;
  revision: number;
  draft_digest: `sha256:${string}`;
  candidate: TCandidate;
  candidate_digest: `sha256:${string}`;
  confirmed_decisions: string[];
  confirmations: BoundaryReviewConfirmation[];
  invalidated_decisions: BoundaryReviewInvalidation[];
  updated_at: string;
};
