import { z } from "zod";
import type { ProjectedBoundaryReviewDecision, BoundaryReviewOrigin } from "./auto-boundary.js";
/** Pure reference syntax; resolving this reference is a separate native read. */
export const readReviewOriginSchema = z.object({
  revision_id: z.string().regex(/^policy:[a-f0-9]{64}$/u).transform(value => value as `policy:${string}`),
  boundary_id: z.string().regex(/^bnd_[a-f0-9]{32}$/u).transform(value => value as `bnd_${string}`),
  candidate_digest: z.string().regex(/^sha256:[a-f0-9]{64}$/u).transform(value => value as `sha256:${string}`),
}).strict();

export const BOUNDARY_REVIEW_PROGRESS_VERSION = "synapsor.boundary-review-progress.v4" as const;

export type BoundaryReviewDecision = ProjectedBoundaryReviewDecision;

export type BoundaryReviewConfirmation = BoundaryReviewDecision & {
  status: "confirmed";
  /** Original immutable pre-confirmation candidate; never replaced on rescan. */
  origin?: BoundaryReviewOrigin;
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
