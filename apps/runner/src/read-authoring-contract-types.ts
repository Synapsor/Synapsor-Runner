/** Canonical Read request and checkpoint types. Publication grants no authority. */
import type { SHARED_REFERENCE_ACKNOWLEDGEMENT, ExplorationDerivedBaseMeasure, ExplorationPostAggregateOperation, ExplorationAutoBandPolicy } from "./auto-boundary.js";
import type { ReadAuthoringBindings } from "./control-policy-read-authoring-project.js";

export type BoundaryResourceReviewRequest = {
  /** Remove model inference grants, retaining separately reviewed private access. */
  private_model_fields?: string[];
  /** Withhold without adding a previously unselected field to row selection. */
  preserve_unselected_fields?: string[];
  resource_id: string;
  metadata?: {
    label?: string | null;
    description?: string | null;
  };
  field_metadata?: Array<{
    field: string;
    label?: string | null;
    description?: string | null;
  }>;
  include?: boolean;
  exclude?: boolean;
  row_identity?: string;
  tenant_key?: string;
  tenant_scope_path?: string;
  shared_reference_scope?: typeof SHARED_REFERENCE_ACKNOWLEDGEMENT;
  principal_key?: string | null;
  principal_scope_path?: string | null;
  principal_rls_setting?: string | null;
  keep_out_fields?: string[];
  withhold_from_model_fields?: string[];
  allow_reviewed_fields?: string[];
  selectable_fields?: string[];
  filterable_fields?: string[];
  sortable_fields?: string[];
  groupable_fields?: string[];
  allow_exact_numeric_grouping_fields?: string[];
  remove_exact_numeric_grouping_fields?: string[];
  aggregate_measures?: string[];
  count_distinct_fields?: string[];
  time_bucket_fields?: string[];
  field_enum?: {
    field: string;
    values: string[];
  };
  derived_measure?: (
    | {
      name: string;
      label: string;
      shape: "ratio" | "percentage" | "per_unit_average";
      numerator: ExplorationDerivedBaseMeasure;
      denominator: ExplorationDerivedBaseMeasure;
      remove?: boolean;
    }
    | {
      name: string;
      label: string;
      shape: ExplorationPostAggregateOperation;
      base_measure: ExplorationDerivedBaseMeasure;
      direction?: "asc" | "desc";
      window_size?: number;
      remove?: boolean;
    }
    | {
      name: string;
      label: string;
      shape: "child_count_total" | "child_count_average";
      child_resource: string;
      relationship: string;
      remove?: boolean;
    }
  );
  numeric_band?: {
    name: string;
    label: string;
    field: string;
    relationship?: string;
    edges: number[];
    bucket_labels: string[];
    remove?: boolean;
  };
  auto_band?: ExplorationAutoBandPolicy & { remove?: boolean };
  minimum_cohort_size?: number;
  max_ranked_groups?: number;
  max_queries_per_session?: number;
  rate_limit_per_minute?: number;
  max_rows?: number;
  max_groups?: number;
  max_top_n?: number;
  max_response_cells?: number;
  max_response_bytes?: number;
  statement_timeout_ms?: number;
  max_measures?: number;
  max_dimensions?: number;
  max_derived_scope_hops?: 1 | 2 | 3;
  max_analysis_relationship_hops?: 1 | 2 | 3;
  relationship_ids?: string[];
  relationship_only?: true;
  nullable_relationship?: {
    relationship_id: string;
    unmatched_rows: "exclude" | "keep_null";
  };
  actor: string;
  reason: string;
  decided_at?: string;
};

export type BoundaryReviewMutationBindings = {
  draft_digest: `sha256:${string}`;
  candidate_digest: `sha256:${string}`;
  generation_lock_fingerprint: `sha256:${string}`;
  schema_fingerprint: `sha256:${string}`;
  role_posture_fingerprint: `sha256:${string}`;
  review_revision: number;
  authoring?: ReadAuthoringBindings;
};

export type ModelReadValueRequest = {
  resource: string;
  field: string;
  reason: string;
  question: string;
};

export type ModelReadClarificationRequest = {
  resource: string;
  field?: string;
  category?: "business_meaning" | "relationship_support";
  reason: string;
  question: string;
};

export type ModelReadValueContextDecision =
  | {
      state: "provided";
      resource: string;
      field: string;
      values: string[];
      egressAcknowledged: true;
    }
  | { state: "without_values" };

export type ModelReadClarificationDecision =
  | { state: "answered"; answer: string }
  | { state: "declined" };

export type ReadBoundaryFieldExposure = "model_and_runner" | "runner_only" | "kept_out";

export type ReadBoundaryFieldExposureChange = {
  resource: string;
  field: string;
  before: ReadBoundaryFieldExposure;
  after: ReadBoundaryFieldExposure;
  rationale?: string;
  /** Full privacy is the default for new model-guided Runner-only decisions. */
  model_operations?: "none" | "preserve_reviewed";
};

export type ModelReadBoundaryRevisionClarification = {
  question: string;
  reason: string;
};

export type ModelReadBoundaryRevisionClarificationDecision =
  | { state: "answered"; answer: string }
  | { state: "declined" };

/** One host-created reviewed relationship; provenance does not grant authority. */
export const REVIEWED_READ_RELATIONSHIP_SCHEMA_VERSION = "synapsor.reviewed-read-relationship.v1";
export type ReviewedReadRelationship = Readonly<{
  schema_version: typeof REVIEWED_READ_RELATIONSHIP_SCHEMA_VERSION;
  candidate_digest: `sha256:${string}`;
  resource: string;
  relationship_id: string;
  relationship_fingerprint: `sha256:${string}`;
}>;
