import fs from "node:fs/promises";
import { principalScopeReviewDecision } from "./boundary-principal-review.js";
import { isReadRelationshipScopePair } from "./read-relationship-scope.js";
import path from "node:path";
import crypto from "node:crypto";
import { Buffer } from "node:buffer";
import { withProjectAuthorityMutation, type ProjectAuthorityMutationPermit } from "./project-authority-mutation.js";
import { compileAgentDsl, formatAgentDsl } from "@synapsor/dsl";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import {
  assertDatabaseGrammarFeature,
  assertSupportedDatabaseServerVersion,
  databaseServerCompatibility,
  rolePostureFingerprint,
  schemaFingerprintForInspection,
  classifySensitivity,
  type SchemaInspection,
  type DatabaseServerAuthority,
  type DatabaseServerCompatibility,
  type SensitivityClassification,
  type TableInfo,
} from "@synapsor-runner/schema-inspector";
import { normalizeContract, type SynapsorContract } from "@synapsor/spec";
import type { ProjectDetectionSummary } from "./onboarding-artifacts.js";
import {
  parseSchemaCandidateSource,
  type CandidateObject,
  type ParsedSchema,
  type SchemaCandidateFormat,
} from "./schema-candidates.js";
import {
  assertSafeManagedOutputPath,
  readManagedOutputMarker,
} from "./managed-output.js";
import type {
  BoundaryReviewProgressArtifact,
} from "./boundary-review-progress-types.js";
import { formatDerivedScopePath } from "./derived-scope-display.js";
import { exploreBoundaryVocabularyGaps, exploreFieldSemanticStatus, exploreVocabularyCoverage } from "./explore-vocabulary.js";
import { RELATIVE_TIME_WINDOWS, RELATIVE_TIME_COMPARISONS } from "./relative-time-window.js";
import { checkReadDiscoveryContracts, readDiscoveryConcernLines, type ReadDiscoveryConcern } from "./read-discovery-compatibility.js";
import { assertDatabaseRoleSafeForModelReads } from "./database-role-posture.js";
import {
  assertReadCurrentStatePrerequisiteShape,
  assertReviewedReadCurrentStatePrerequisite,
  type ReviewedReadCurrentStatePrerequisite,
} from "./read-prerequisite.js";
import type { ControlPolicyPointer, ControlPolicyRevision } from "@synapsor-runner/proposal-store";
import { assertGovernedReadActivationDecision, type GovernedReadActivationDecision } from "./control-policy-activation.js";
import { openBoundProjectControlPolicies, assertProjectControlPolicyBinding, commitImmutableControlPolicies,
  type BoundProjectPolicyStore } from "./control-policy-store.js";
import { OPERATOR_POLICY_RECORD_VERSION, OPERATOR_READ_SELECTION_KEY, OPERATOR_READ_AUTHORING_KEY, assertOperatorPolicyRecord,
  assertReadAuthoringBindings, type ReadAuthoringBindings, storedOperatorPolicyRecord } from "./control-policy-record.js";

export const AUTO_BOUNDARY_VERSION = "synapsor.auto-boundary.v1";
export const GENERATION_LOCK_VERSION = "synapsor.generation-lock.v1";
export const AUTHORITY_DEPENDENCIES_VERSION = "synapsor.authority-dependencies.v1";
export const CONFIGURED_TRUSTED_CONTEXT_AUTHORITY_VERSION =
  "synapsor.configured-trusted-context-authority.v1";
export const EXPLORATION_BOUNDARY_VERSION = "synapsor.exploration-boundary.v1";
export const AUTO_BOUNDARY_OVERRIDES_VERSION = "synapsor.auto-boundary-overrides.v1";
export const ACTIVE_EXPLORATION_BOUNDARY_SET_VERSION = "synapsor.active-exploration-boundaries.v1";
export const AUTO_BOUNDARY_COMPILER_VERSION = "1.7.0";
export const AUTO_BOUNDARY_SPEC_VERSION = "1.9.0";
export const SUPPORTED_AUTO_BOUNDARY_SPEC_VERSIONS = new Set(["1.8.0", AUTO_BOUNDARY_SPEC_VERSION]);
export const SHARED_REFERENCE_ACKNOWLEDGEMENT = "table_has_no_per_tenant_rows";
export const DEFAULT_GENERATED_DIR = "synapsor/generated";
export const MAX_ACTIVE_EXPLORATION_BOUNDARIES = 8;
const EXPLORATION_LOCK_SNAPSHOT_DIR = "exploration-locks";
const ACTIVE_EXPLORATION_BOUNDARY_SET_FILE = "exploration-boundaries.active.json";
const AUTO_BOUNDARY_POLICY_BASELINE_FILE = "auto-boundary-policy-baseline.json";
const AUTO_BOUNDARY_POLICY_BASELINE_VERSION = "synapsor.auto-boundary-policy-baseline.v1";

export const EXPLORATION_TIME_BUCKETS = [
  "hour",
  "day",
  "week",
  "month",
  "quarter",
  "year",
  "day_of_week",
] as const;
export type ExplorationTimeBucket = typeof EXPLORATION_TIME_BUCKETS[number];
export const EXPLORATION_NUMERIC_AGGREGATE_FUNCTIONS = [
  "sum",
  "avg",
  "stddev_samp",
  "stddev_pop",
  "var_samp",
  "var_pop",
] as const;
export type ExplorationNumericAggregateFunction =
  typeof EXPLORATION_NUMERIC_AGGREGATE_FUNCTIONS[number];
export const EXPLORATION_PRESENCE_MEASURE_FUNCTIONS = [
  "null_count",
  "non_null_count",
  "completion_rate",
] as const;
export type ExplorationDerivedBaseMeasure =
  | { function: "count" }
  | {
    function: "count_distinct" | "sum" | "avg";
    field: string;
    relationship?: string;
  };
export const EXPLORATION_POST_AGGREGATE_OPERATIONS = [
  "running_total",
  "rank",
  "lag_absolute_change",
  "lag_percentage_change",
  "moving_average",
  "share_of_released_total",
] as const;
export type ExplorationPostAggregateOperation =
  typeof EXPLORATION_POST_AGGREGATE_OPERATIONS[number];
export type ExplorationRatioDerivedMeasure = {
  name: string;
  label: string;
  shape: "ratio" | "percentage" | "per_unit_average";
  numerator: ExplorationDerivedBaseMeasure;
  denominator: ExplorationDerivedBaseMeasure;
  null_policy: "null_on_zero_or_null_denominator";
};
export type ExplorationPostAggregateMeasure = {
  name: string;
  label: string;
  shape: ExplorationPostAggregateOperation;
  base_measure: ExplorationDerivedBaseMeasure;
  direction?: "asc" | "desc";
  window_size?: number;
};
export type ExplorationChildCountDerivedMeasure = {
  name: string;
  label: string;
  shape: "child_count_total" | "child_count_average";
  child_resource: string;
  relationship: string;
};
export type ExplorationDerivedMeasure =
  | ExplorationRatioDerivedMeasure
  | ExplorationPostAggregateMeasure
  | ExplorationChildCountDerivedMeasure;
export type ExplorationNumericBand = {
  name: string;
  label: string;
  field: string;
  relationship?: string;
  edges: number[];
  bucket_labels: string[];
};
export const EXPLORATION_AUTO_BAND_METHODS = ["quantile", "equal_width"] as const;
export type ExplorationAutoBandMethod = typeof EXPLORATION_AUTO_BAND_METHODS[number];
export const EXPLORATION_AUTO_BAND_LABEL_STYLES = ["ordinal", "rounded"] as const;
export type ExplorationAutoBandLabelStyle = typeof EXPLORATION_AUTO_BAND_LABEL_STYLES[number];
export const MIN_AUTO_BAND_BUCKETS = 2;
export const MAX_AUTO_BAND_BUCKETS = 16;
export type ExplorationAutoBandPolicy = {
  field: string;
  methods: ExplorationAutoBandMethod[];
  min_buckets: number;
  max_buckets: number;
  min_bucket_width?: number;
  label_style: ExplorationAutoBandLabelStyle;
  label_round_to?: number;
};

const MAX_STATIC_INPUT_BYTES = 2 * 1024 * 1024;
const MAX_DIRECT_RELATIONSHIP_CANDIDATES_PER_RESOURCE = 4;
const MAX_COMPOSED_RELATIONSHIP_CANDIDATES_PER_DEPTH = 3;
/**
 * Limits applied to a newly-created reviewed candidate. Generated drafts carry
 * the larger reviewer ceilings below so an owner can widen shape/throughput
 * deliberately without weakening disclosure controls.
 */
export const DEFAULT_REVIEWED_EXPLORATION_BUDGETS: ExplorationBudgets = {
  max_rows: 50,
  max_groups: 50,
  max_ranked_groups: 500,
  max_top_n: 25,
  max_measures: 3,
  max_dimensions: 3,
  max_time_ranges: 2,
  max_relationship_hops: 2,
  max_derived_scope_hops: 2,
  max_analysis_relationship_hops: 2,
  max_response_cells: 500,
  max_response_bytes: 64 * 1024,
  statement_timeout_ms: 3000,
  max_complexity: 24,
  // Volume controls are intentionally separate from disclosure controls. A
  // product-scale default supports multi-step agents while the extraction and
  // differencing pools below retain their tighter privacy defaults.
  max_queries_per_session: 1000,
  max_extracted_cells_per_session: 4000,
  // One finite all-shape pool supports the reviewed ten-plan adoption path
  // without restoring the old per-family differencing reset.
  max_differencing_queries: 16,
  rate_limit_per_minute: 120,
};

/** Hard, generated ceilings for explicit owner review. */
export const EXPLORATION_BUDGET_REVIEW_CEILINGS: ExplorationBudgets = {
  ...DEFAULT_REVIEWED_EXPLORATION_BUDGETS,
  max_rows: 100,
  max_groups: 500,
  max_ranked_groups: 10_000,
  max_top_n: 100,
  max_measures: 5,
  max_dimensions: 4,
  max_derived_scope_hops: 3,
  max_analysis_relationship_hops: 3,
  max_response_cells: 4_000,
  max_response_bytes: 1_048_576,
  statement_timeout_ms: 30_000,
};

export type InferenceConfidence = "high" | "medium" | "low";

export type RelationshipLinkProof = {
  constraint_name: string;
  source_resource: string;
  target_resource: string;
  source_columns: string[];
  target_columns: string[];
  target_uniqueness: {
    kind: "primary_key" | "unique_constraint" | "unique_index";
    name: string;
    columns: string[];
  };
  nullable: boolean;
  cardinality: "many_to_one";
  max_fan_out: 1;
};

export type ExplorationRelationship = {
  id: string;
  target_resource: string;
  local_columns: string[];
  target_columns: string[];
  counted_entity: string;
  cardinality: "many_to_one";
  max_fan_out: 1;
  path_depth?: 1 | 2 | 3;
  proof?: {
    source: "database_catalog";
    links: RelationshipLinkProof[];
    digest: `sha256:${string}`;
  };
  nullable?: boolean;
  unmatched_rows?: "exclude" | "keep_null" | "review_required";
};

export type DerivedScopePath = {
  mode: "derived";
  path_id: string;
  ancestor_resource: string;
  ancestor_column: string;
  proof: {
    source: "database_catalog";
    links: RelationshipLinkProof[];
    digest: `sha256:${string}`;
  };
};

export type DerivedScopeInference = {
  candidates: DerivedScopePath[];
  selected?: DerivedScopePath;
  confirmation_required: true;
  safety_consequence: string;
  blocked_reason?: string;
};

export type SharedReferenceScope = {
  mode: "shared_reference";
  acknowledgement: typeof SHARED_REFERENCE_ACKNOWLEDGEMENT;
};

export type SharedReferenceScopeInference = {
  eligible: boolean;
  selected?: SharedReferenceScope;
  confirmation_required: true;
  safety_consequence: string;
  blockers: string[];
  review_override?: ReviewedValueDecision;
};

export type BoundaryInference<T> = {
  selected?: T;
  candidates: T[];
  evidence: Array<{ source: "database" | "prisma" | "drizzle" | "openapi" | "synapsor"; detail: string }>;
  alternatives_considered: Array<{
    value: T;
    confidence: InferenceConfidence;
    evidence: string[];
    selected: boolean;
  }>;
  confidence: InferenceConfidence;
  confirmation_required: boolean;
  safety_consequence: string;
  blocked_reason?: string;
};

export type AutoBoundaryField = {
  name: string;
  data_type: string;
  enum_values?: string[];
  nullable: boolean;
  primary_key: boolean;
  sensitive_suggestion: boolean;
  sensitivity: SensitivityClassification;
  raw_visible_suggestion: boolean;
  aggregate_measure_suggestion: boolean;
  count_distinct_suggestion: boolean;
  groupable_suggestion: boolean;
  time_bucket_suggestion: boolean;
  evidence: string[];
  enum_review_override?: ReviewedEnumValuesDecision;
  exact_numeric_grouping_review_override?: ReviewedExactNumericGroupingDecision;
  metadata_review_override?: ReviewedMetadataDecision;
  review_override?: {
    exposure: "keep_out" | "withhold_from_model" | "allow_reviewed_use";
    actor: string;
    reason: string;
    decided_at: string;
  };
};

export type AutoBoundaryResource = {
  id: string;
  schema: string;
  table: string;
  type: "table" | "view";
  /** Approximate catalog statistic for operator advice only; never authority. */
  approximate_row_count?: number;
  primary_key: BoundaryInference<string>;
  tenant_key: BoundaryInference<string>;
  principal_key: BoundaryInference<string>;
  /** Present only when a catalog-proven scope path is available. */
  derived_tenant_scope?: DerivedScopeInference;
  /** Human-reviewed option for a table whose rows are identical for every tenant. */
  shared_reference_scope?: SharedReferenceScopeInference;
  /** Present only when a catalog-proven principal path is available. */
  derived_principal_scope?: DerivedScopeInference;
  fields: AutoBoundaryField[];
  relationships: Array<{
    name: string;
    columns: string[];
    referenced_resource: string;
    referenced_columns: string[];
    reviewed_cardinality: "many_to_one_candidate";
    review_required: true;
    nullable: boolean;
    cardinality_proven: boolean;
    target_uniqueness?: RelationshipLinkProof["target_uniqueness"];
  }>;
  rls: {
    enabled: boolean | "unknown";
    forced: boolean | "unknown" | "unsupported";
    effective_for_current_role: boolean | "unknown" | "unsupported";
    policy_names: string[];
    using_expressions: string[];
    /**
     * Exact live-catalog settings that could carry principal context. These
     * are review candidates only; opaque names never become authority without
     * an explicit reviewed decision.
     */
    principal_setting_candidates?: string[];
    principal_setting_review_override?: Omit<ReviewedValueDecision, "value"> & {
      value: string | null;
    };
  };
  role_posture: {
    read_only: boolean;
    owner: boolean;
    can_assume_owner: boolean;
    write_capable: boolean;
    verified: boolean;
  };
  minimum_cohort_override?: ReviewedMinimumCohortDecision;
  metadata_review_override?: ReviewedMetadataDecision;
  status: "draft_read" | "blocked_scope" | "blocked_identifier" | "blocked_role";
  blockers: string[];
};

export type AutoBoundaryEvidenceGraph = {
  schema_version: typeof AUTO_BOUNDARY_VERSION;
  engine: SchemaInspection["engine"];
  database_role: {
    name: string;
    verified: boolean;
    read_only: boolean;
    superuser: boolean | "unknown" | "unsupported";
    bypass_rls: boolean | "unknown" | "unsupported";
    fingerprint: `sha256:${string}`;
  };
  project: {
    frameworks: string[];
    schema_inputs: ProjectDetectionSummary["schema_inputs"];
  };
  resources: AutoBoundaryResource[];
  structured_actions: Array<{
    name: string;
    source: "openapi" | "synapsor";
    resource_hint?: string;
    status: "disabled_requires_business_review";
  }>;
  warnings: string[];
};

export type ExplorationBudgets = {
  max_rows: number;
  max_groups: number;
  /**
   * Maximum underlying groups a reviewed top/bottom query may consider before
   * suppression and ranking. Optional so pre-1.6.6 boundary artifacts retain
   * their exact canonical bytes and digest.
   */
  max_ranked_groups?: number;
  max_top_n: number;
  max_measures: number;
  max_dimensions: number;
  max_time_ranges: 2;
  /** Legacy shared depth authority retained for pre-1.7 boundary digests. */
  max_relationship_hops: 1 | 2;
  /** Optional so activated pre-1.7 artifacts retain their exact canonical bytes. */
  max_derived_scope_hops?: 1 | 2 | 3;
  /** Optional so activated pre-1.7 artifacts retain their exact canonical bytes. */
  max_analysis_relationship_hops?: 1 | 2 | 3;
  max_response_cells: number;
  max_response_bytes: number;
  statement_timeout_ms: number;
  max_complexity: number;
  max_queries_per_session: number;
  max_extracted_cells_per_session: number;
  max_differencing_queries: number;
  rate_limit_per_minute: number;
};

export function reviewedDerivedScopeHopLimit(budgets: ExplorationBudgets): 1 | 2 | 3 {
  return budgets.max_derived_scope_hops ?? budgets.max_relationship_hops;
}

export function reviewedAnalysisRelationshipHopLimit(
  budgets: ExplorationBudgets,
): 1 | 2 | 3 {
  return budgets.max_analysis_relationship_hops ?? budgets.max_relationship_hops;
}

const OWNER_REVIEWABLE_EXPLORATION_BUDGETS = new Set<keyof ExplorationBudgets>([
  "max_rows",
  "max_groups",
  "max_ranked_groups",
  "max_top_n",
  "max_measures",
  "max_dimensions",
  "max_derived_scope_hops",
  "max_analysis_relationship_hops",
  "max_response_cells",
  "max_response_bytes",
  "statement_timeout_ms",
  "max_queries_per_session",
  "rate_limit_per_minute",
]);

export function ownerReviewableExplorationBudgetCeiling(
  key: keyof ExplorationBudgets,
): number | undefined {
  return OWNER_REVIEWABLE_EXPLORATION_BUDGETS.has(key)
    ? Number(EXPLORATION_BUDGET_REVIEW_CEILINGS[key])
    : undefined;
}

export type SingleOrganizationScope = {
  mode: "single_organization";
  organization_id: string;
  acknowledgement: "all_rows_belong_to_one_organization";
};

export type ConfiguredTrustedContextAuthority = {
  schema_version: typeof CONFIGURED_TRUSTED_CONTEXT_AUTHORITY_VERSION;
  provider: "environment" | "http_claims";
  tenant_binding?: string;
  principal_binding?: string;
  tenant_env?: string;
  principal_env?: string;
  tenant_claim?: string;
  principal_claim?: string;
};

export type ExplorationBoundaryDraft = {
  schema_version: typeof EXPLORATION_BOUNDARY_VERSION;
  activation: "disabled_unreviewed";
  deployment_profile: "development" | "staging" | "production";
  source: string;
  compiler_version: string;
  spec_version: string;
  /** Exact server version observed when this boundary authority was generated. */
  database_server_version?: string;
  /** Stable supported grammar tier resolved from the detected server release. */
  database_server_tier?: "full" | "compatible_limited";
  /** Release-line capability profile that constrains reviewable grammar. */
  database_server_authority?: DatabaseServerAuthority;
  /**
   * New generated boundaries bind one reporting timezone into their reviewed
   * authority. It remains optional solely so pre-1.6.6 active-boundary
   * artifacts retain their exact canonical digest.
   */
  reporting_timezone?: "UTC";
  /**
   * Explicit owner-reviewed authority for a source that contains exactly one
   * organization. Absent means the existing per-resource tenant requirement.
   */
  organization_scope?: SingleOrganizationScope;
  /** Optional private, reviewed current-state gate for every runtime Read query. */
  read_prerequisite?: ReviewedReadCurrentStatePrerequisite;
  trusted_context:
    | {
      provider: "environment";
      tenant_env: string;
      principal_env: string;
      /**
       * Additive first-run fallback for PostgreSQL credentials whose reviewed
       * RLS policies use one stable session setting. The value is resolved from
       * the authenticated database session and is never stored in this object.
       */
      database_role_tenant?: {
        engine: "postgres";
        setting: string;
      };
    }
    | {
      provider: "http_claims";
      tenant_claim?: string;
      principal_claim: string;
      tenant_env?: never;
      principal_env?: never;
      database_role_tenant?: never;
    };
  generation_lock_fingerprint: `sha256:${string}`;
  role_posture_fingerprint: `sha256:${string}`;
  pack: {
    name: string;
    resources: Array<{
      id: string;
      schema: string;
      table: string;
      /** Human-reviewed semantic metadata. It never changes plan authority. */
      label?: string;
      description?: string;
      field_metadata?: Record<string, {
        label?: string;
        description?: string;
      }>;
      primary_key: string;
      tenant_key?: string;
      tenant_scope?: DerivedScopePath;
      shared_reference_scope?: SharedReferenceScope;
      principal_key?: string;
      principal_scope?: DerivedScopePath;
      field_types: Record<string, string>;
      field_enums: Record<string, string[]>;
      selectable_fields: string[];
      /** Fields may be used through reviewed joins, but not as an independent query root. */
      relationship_only?: true;
      filterable_fields: Record<string, Array<"eq" | "neq" | "lt" | "lte" | "gt" | "gte" | "in">>;
      sortable_fields: string[];
      groupable_fields: string[];
      aggregate_measures: string[];
      /** Absent on legacy boundaries, where aggregate measures mean sum/avg only. */
      aggregate_measure_functions?: Record<string, ExplorationNumericAggregateFunction[]>;
      /** Model-visible fields whose missingness may be released only as suppressed aggregates. */
      presence_measure_fields?: string[];
      /** Fixed reviewed cross-measure definitions; plans may select only by name. */
      derived_measures?: ExplorationDerivedMeasure[];
      /** Fixed reviewed numeric buckets; plans select one by name and cannot choose edges. */
      numeric_bands?: ExplorationNumericBand[];
      /** Reviewed adaptive grouping policy; plans choose only method and bounded count. */
      auto_bands?: ExplorationAutoBandPolicy[];
      count_distinct_fields: string[];
      time_bucket_fields: Record<string, ExplorationTimeBucket[]>;
      kept_out_fields: string[];
      /**
       * Optional so boundaries created before this egress tier retain their
       * exact canonical representation and digest.
       */
      model_withheld_fields?: string[];
      relationships: ExplorationRelationship[];
      rls_session?: {
        tenant_setting?: string;
        principal_setting?: string;
      };
      minimum_cohort_size: number;
      minimum_cohort_overridden?: true;
      suppression_aware_totals: true;
    }>;
  };
  budgets: ExplorationBudgets;
  unresolved_decisions: string[];
};

export type ActivatedExplorationBoundary = Omit<ExplorationBoundaryDraft, "activation" | "unresolved_decisions"> & {
  activation: {
    state: "active";
    digest: `sha256:${string}`;
    actor: string;
    activated_at: string;
    generation_lock_fingerprint: `sha256:${string}`;
    reviewed_decisions: Array<{
      decision: string;
      confirmed: true;
    }>;
    mode?: "full_review" | "instant_development";
    profile_assertion?: "own_development";
    launch_context?: "start_from_env_local_authoring";
    confirmation_gesture?:
      | "activate_and_read"
      | "activate_for_model"
      | "activate_for_existing_client"
      | "activate_for_no_model";
  };
};

type ExplorationPrincipalScopeResource = Pick<
  ExplorationBoundaryDraft["pack"]["resources"][number],
  "principal_key" | "principal_scope" | "rls_session"
>;

/**
 * Principal scope can be compiled into SQL directly, carried through a proven
 * relationship, or enforced by an effective PostgreSQL RLS policy whose
 * trusted session setting Runner discovered from the live catalog.
 */
export function reviewedPrincipalScopeKind(
  resource: ExplorationPrincipalScopeResource,
): "direct" | "derived" | "postgres_rls" | undefined {
  if (resource.principal_key) return "direct";
  if (resource.principal_scope) return "derived";
  if (resource.rls_session?.principal_setting) return "postgres_rls";
  return undefined;
}

export function hasReviewedPrincipalScope(
  resource: ExplorationPrincipalScopeResource,
): boolean {
  return reviewedPrincipalScopeKind(resource) !== undefined;
}

export type ActiveExplorationBoundarySet = {
  schema_version: typeof ACTIVE_EXPLORATION_BOUNDARY_SET_VERSION;
  selected_name: string;
  boundaries: ActivatedExplorationBoundary[];
  updated_at: string;
};

export type GenerationLock = {
  schema_version: typeof GENERATION_LOCK_VERSION;
  compiler_version: string;
  spec_version: string;
  engine: SchemaInspection["engine"];
  /** Exact source server version observed when this lock was generated. */
  database_server_version?: string;
  /** Stable supported grammar tier resolved from the detected server release. */
  database_server_tier?: "full" | "compatible_limited";
  /** Binds reviewed grammar availability to one database release line. */
  database_server_authority?: DatabaseServerAuthority;
  source_env: string;
  inspected_schema?: string;
  schema_fingerprint: `sha256:${string}`;
  role_posture_fingerprint: `sha256:${string}`;
  evidence_fingerprint: `sha256:${string}`;
  generated_contract_digest: `sha256:${string}`;
  reviewed_overrides_digest: `sha256:${string}`;
  protected_authority: string[];
  /**
   * New generated analytical authority fixes time buckets to UTC. This is
   * optional only so published locks retain their exact digest.
   */
  reporting_timezone?: "UTC";
  /** Binds the explicit single-organization posture into live drift checks. */
  organization_scope?: SingleOrganizationScope;
  /**
   * Binds non-secret config inputs that determine where trusted tenant and
   * principal values come from and which reviewed columns they constrain.
   * Optional only so legacy generation locks retain their exact digest.
   */
  trusted_context_authority?: ConfiguredTrustedContextAuthority;
  trusted_context_fingerprint?: `sha256:${string}`;
  /**
   * Records whether explicit config bindings participated in scope inference.
   * Optional only for generation locks written before this posture was recorded.
   */
  configured_trusted_context_used_for_inference?: boolean;
  /**
   * Additive dependency records for authority generated by newer Runner
   * versions. Legacy locks omit this field and retain whole-schema drift
   * enforcement.
   */
  authority_dependencies?: GenerationAuthorityDependencies;
};

/**
 * Render the capability authority captured by a lock. Re-resolving the exact
 * version with newer Runner rules would misstate what the reviewer activated.
 */
export function databaseServerCompatibilityForLock(
  lock: Pick<GenerationLock,
    "engine" | "database_server_version" | "database_server_tier" | "database_server_authority">,
): DatabaseServerCompatibility | undefined {
  if (!lock.database_server_version) return undefined;
  const detected = databaseServerCompatibility({
    engine: lock.engine,
    server_version: lock.database_server_version,
  });
  const authority = lock.database_server_authority ?? detected.authority;
  const tier = lock.database_server_tier ?? detected.tier;
  const limitations = authority
    ? [
        ...(authority.features.automatic_numeric_bands === false
          ? ["Automatic numeric bands are unavailable on this reviewed database capability profile."]
          : []),
        ...(authority.features.schema_check_constraints === false
          ? ["CHECK constraints cannot provide reviewed categorical vocabulary on this database capability profile."]
          : []),
      ]
    : detected.limitations;
  return {
    ...detected,
    supported: tier !== "unsupported",
    tier,
    ...(authority ? { authority: structuredClone(authority) } : {}),
    limitations,
  };
}

export type GenerationAuthorityDependencies = {
  schema_version: typeof AUTHORITY_DEPENDENCIES_VERSION;
  credential_posture_fingerprint: `sha256:${string}`;
  resources: Record<string, {
    schema: string;
    table: string;
    fields: string[];
    shared_reference_scope?: SharedReferenceScope;
    fingerprint: `sha256:${string}`;
  }>;
  relationships: Record<string, {
    root_resource: string;
    relationship_id: string;
    links: RelationshipLinkProof[];
    proof_digest: `sha256:${string}`;
  }>;
};

type AutoBoundaryBuildCore = {
  graph: AutoBoundaryEvidenceGraph;
  dsl: string;
  contract: SynapsorContract;
  contract_digest: `sha256:${string}`;
  overrides: AutoBoundaryReviewOverrides;
  lock: GenerationLock;
  exploration_boundary: ExplorationBoundaryDraft;
  review: {
    schema_version: typeof AUTO_BOUNDARY_VERSION;
    activation: "blocked_unreviewed";
    engine: SchemaInspection["engine"];
    database_role: AutoBoundaryEvidenceGraph["database_role"];
    warnings: string[];
    summary: {
      objects: number;
      draft_reads: number;
      blocked_objects: number;
      sensitive_fields_kept_out: number;
      rls_policies: number;
      structured_write_candidates: number;
    };
    unresolved_decisions: string[];
    resources: AutoBoundaryResource[];
    structured_actions: AutoBoundaryEvidenceGraph["structured_actions"];
  };
  tests: {
    schema_version: "synapsor.generated-tests.v1";
    contract_digest: `sha256:${string}`;
    cases: Array<Record<string, unknown>>;
  };
};

export type AutoBoundaryBuild = AutoBoundaryBuildCore & {
  /** Policy-neutral candidate over the same inspected schema and role facts. */
  policy_baseline: {
    schema_version: typeof AUTO_BOUNDARY_POLICY_BASELINE_VERSION;
    boundary: ExplorationBoundaryDraft;
    lock: GenerationLock;
  };
};

export type BuildAutoBoundaryInput = {
  inspection: SchemaInspection;
  project: ProjectDetectionSummary;
  parsedEvidence?: ParsedSchema[];
  existingContracts?: SynapsorContract[];
  sourceEnv: string;
  sourceName?: string;
  inspectedSchema?: string;
  overrides?: AutoBoundaryReviewOverrides;
  deploymentProfile?: "development" | "staging" | "production";
  httpClaims?: {
    tenantClaim?: string;
    principalClaim: string;
  };
  singleOrganization?: {
    organizationId: string;
  };
  configuredTrustedContext?: ConfiguredTrustedContextAuthority;
  /** Preserve reviewed trust authority while retaining the inference posture of an existing draft. */
  useConfiguredTrustedContextForInference?: boolean;
};

export type AutoBoundaryReviewOverrides = {
  schema_version: typeof AUTO_BOUNDARY_OVERRIDES_VERSION;
  resources: Record<string, {
    row_identity?: ReviewedValueDecision;
    tenant_key?: ReviewedValueDecision;
    tenant_scope_path?: ReviewedValueDecision;
    shared_reference_scope?: ReviewedValueDecision;
    principal_key?: Omit<ReviewedValueDecision, "value"> & { value: string | null };
    principal_scope_path?: Omit<ReviewedValueDecision, "value"> & { value: string | null };
    principal_rls_setting?: Omit<ReviewedValueDecision, "value"> & { value: string | null };
    minimum_cohort?: ReviewedMinimumCohortDecision;
    field_enums?: Record<string, ReviewedEnumValuesDecision>;
    derived_measures?: Record<string, ReviewedDerivedMeasureDecision>;
    numeric_bands?: Record<string, ReviewedNumericBandDecision>;
    auto_bands?: Record<string, ReviewedAutoBandDecision>;
    exact_numeric_grouping?: Record<string, ReviewedExactNumericGroupingDecision>;
    metadata?: ReviewedMetadataDecision;
    field_metadata?: Record<string, ReviewedMetadataDecision>;
    fields?: Record<string, {
      exposure: "keep_out" | "withhold_from_model" | "allow_reviewed_use";
      actor: string;
      reason: string;
      decided_at: string;
    }>;
  }>;
};

export type ReviewedValueDecision = {
  value: string;
  actor: string;
  reason: string;
  decided_at: string;
};

export type ReviewedMinimumCohortDecision = {
  value: number;
  actor: string;
  reason: string;
  decided_at: string;
};

export type ReviewedEnumValuesDecision = {
  values: string[];
  actor: string;
  reason: string;
  decided_at: string;
};

export type ReviewedDerivedMeasureDecision = {
  definition: ExplorationDerivedMeasure;
  actor: string;
  reason: string;
  decided_at: string;
};

export type ReviewedNumericBandDecision = {
  definition: ExplorationNumericBand;
  actor: string;
  reason: string;
  decided_at: string;
};

export type ReviewedAutoBandDecision = {
  definition: ExplorationAutoBandPolicy;
  actor: string;
  reason: string;
  decided_at: string;
};

export type ReviewedExactNumericGroupingDecision = {
  actor: string;
  reason: string;
  decided_at: string;
};

export type ReviewedMetadataDecision = {
  label?: string;
  description?: string;
  actor: string;
  reason: string;
  decided_at: string;
};

export type AutoBoundaryWriteResult = {
  root: string;
  files: string[];
  contract_digest: `sha256:${string}`;
  schema_fingerprint: `sha256:${string}`;
  draft_reads: number;
  blocked_objects: number;
};

export async function loadStructuredProjectEvidence(
  summary: ProjectDetectionSummary,
): Promise<{ parsed: ParsedSchema[]; existingContracts: SynapsorContract[]; warnings: string[] }> {
  const parsed: ParsedSchema[] = [];
  const existingContracts: SynapsorContract[] = [];
  const warnings: string[] = [];
  for (const input of summary.schema_inputs) {
    const absolute = path.resolve(summary.root, input.path.replace(/\/$/, ""));
    if (input.path.endsWith("/")) continue;
    if (input.kind === "prisma" || input.kind === "drizzle" || input.kind === "openapi") {
      try {
        const source = await readBoundedText(absolute);
        parsed.push(parseSchemaCandidateSource(input.kind satisfies SchemaCandidateFormat, source, absolute));
      } catch (error) {
        warnings.push(`${input.kind}:${input.path} could not be parsed statically: ${safeMessage(error)}`);
      }
      continue;
    }
    if (input.kind === "synapsor" && /\.synapsor(?:\.sql)?$/i.test(input.path)) {
      try {
        existingContracts.push(normalizeContract(compileAgentDsl(await readBoundedText(absolute))));
      } catch (error) {
        warnings.push(`synapsor:${input.path} could not be compiled as public DSL: ${safeMessage(error)}`);
      }
      continue;
    }
    if (input.kind === "synapsor" && /\.json$/i.test(input.path)) {
      try {
        const candidate = JSON.parse(await readBoundedText(absolute)) as unknown;
        if (isRecord(candidate) && candidate.kind === "SynapsorContract") {
          existingContracts.push(normalizeContract(candidate as unknown as SynapsorContract));
        }
      } catch (error) {
        warnings.push(`synapsor:${input.path} could not be parsed as a canonical contract: ${safeMessage(error)}`);
      }
    }
  }
  return { parsed, existingContracts, warnings };
}

export function pruneAutoBoundaryReviewOverrides(
  inspection: SchemaInspection,
  input: AutoBoundaryReviewOverrides,
  context: {
    project?: ProjectDetectionSummary;
    parsedEvidence?: ParsedSchema[];
    existingContracts?: SynapsorContract[];
    configuredTrustedContext?: ConfiguredTrustedContextAuthority;
    previousBoundary?: ExplorationBoundaryDraft;
  } = {},
): { overrides: AutoBoundaryReviewOverrides; removed: string[] } {
  const current = normalizeAutoBoundaryReviewOverrides(input);
  const serverAuthority = databaseServerCompatibility(inspection).authority;
  const tables = new Map(inspection.tables.map((table) => [`${table.schema}.${table.name}`, table]));
  const previousResources = new Map(
    (context.previousBoundary?.pack.resources ?? []).map((resource) => [resource.id, resource]),
  );
  const resources: AutoBoundaryReviewOverrides["resources"] = {};
  const removed: string[] = [];
  for (const [resourceId, decision] of Object.entries(current.resources)) {
    const table = tables.get(resourceId);
    if (!table) {
      removed.push(`${resourceId}: resource no longer exists`);
      continue;
    }
    const columns = new Map(table.columns.map((column) => [column.name, column]));
    const provenIdentifiers = new Set([
      ...(table.primary_key.length === 1 ? table.primary_key : []),
      ...table.unique_constraints.filter((constraint) => constraint.columns.length === 1).map((constraint) => constraint.columns[0]!),
      ...table.indexes.filter((index) => index.unique === true && index.columns?.length === 1).map((index) => index.columns![0]!),
    ]);
    const retained: AutoBoundaryReviewOverrides["resources"][string] = {};
    if (decision.metadata) retained.metadata = decision.metadata;
    if (decision.row_identity) {
      if (provenIdentifiers.has(decision.row_identity.value)) retained.row_identity = decision.row_identity;
      else removed.push(`${resourceId}: reviewed row identity ${decision.row_identity.value} is no longer source-proven`);
    }
    if (decision.tenant_key) {
      if (columns.has(decision.tenant_key.value)) retained.tenant_key = decision.tenant_key;
      else removed.push(`${resourceId}: reviewed tenant key ${decision.tenant_key.value} no longer exists`);
    }
    if (decision.tenant_scope_path) retained.tenant_scope_path = decision.tenant_scope_path;
    if (decision.shared_reference_scope) retained.shared_reference_scope = decision.shared_reference_scope;
    if (decision.principal_key) {
      if (decision.principal_key.value === null || columns.has(decision.principal_key.value)) {
        retained.principal_key = decision.principal_key;
      } else {
        removed.push(`${resourceId}: reviewed principal key ${decision.principal_key.value} no longer exists`);
      }
    }
    if (decision.principal_scope_path) retained.principal_scope_path = decision.principal_scope_path;
    if (decision.principal_rls_setting) {
      const candidates = rlsPrincipalSettingCandidates(
        (table.row_level_security_policies ?? [])
          .flatMap((policy) => policy.using_expression ? [policy.using_expression] : []),
      );
      if (decision.principal_rls_setting.value === null
        || candidates.includes(decision.principal_rls_setting.value)) {
        retained.principal_rls_setting = decision.principal_rls_setting;
      } else {
        removed.push(
          `${resourceId}: reviewed PostgreSQL RLS principal setting ${decision.principal_rls_setting.value} is no longer present in an effective policy candidate`,
        );
      }
    }
    if (decision.minimum_cohort) retained.minimum_cohort = decision.minimum_cohort;
    const derivedMeasures: NonNullable<
      AutoBoundaryReviewOverrides["resources"][string]["derived_measures"]
    > = {};
    for (const [name, derivedDecision] of Object.entries(decision.derived_measures ?? {})) {
      const definition = derivedDecision.definition;
      if ("child_resource" in definition) {
        const child = tables.get(definition.child_resource);
        if (!child) {
          removed.push(
            `${resourceId}.${name}: reviewed child-count resource ${definition.child_resource} no longer exists`,
          );
          continue;
        }
        const relationship = child.foreign_keys.find((foreignKey) =>
          foreignKey.name === definition.relationship
          && `${foreignKey.referenced_schema}.${foreignKey.referenced_table}` === resourceId);
        if (!relationship) {
          removed.push(
            `${resourceId}.${name}: reviewed child-count relationship ${definition.relationship} no longer exists`,
          );
          continue;
        }
        const sourceColumnsAreNonNull = relationship.columns.length > 0
          && relationship.columns.every((field) =>
            child.columns.find((column) => column.name === field)?.nullable === false);
        const targetUniqueness = relationshipTargetUniqueness(table, relationship.referenced_columns);
        if (!sourceColumnsAreNonNull || !targetUniqueness) {
          removed.push(
            `${resourceId}.${name}: reviewed child-count relationship ${definition.relationship} is no longer a non-null many-to-one path to a unique parent key`,
          );
          continue;
        }
        derivedMeasures[name] = derivedDecision;
        continue;
      }
      const operands = "base_measure" in definition
        ? [definition.base_measure]
        : [definition.numerator, definition.denominator];
      const missingLocalField = operands.find((operand) =>
        "field" in operand && !operand.relationship && !columns.has(operand.field));
      if (missingLocalField && "field" in missingLocalField) {
        removed.push(`${resourceId}.${name}: reviewed derived measure field ${missingLocalField.field} no longer exists`);
        continue;
      }
      derivedMeasures[name] = derivedDecision;
    }
    if (Object.keys(derivedMeasures).length) retained.derived_measures = derivedMeasures;
    const numericBands: NonNullable<
      AutoBoundaryReviewOverrides["resources"][string]["numeric_bands"]
    > = {};
    for (const [name, bandDecision] of Object.entries(decision.numeric_bands ?? {})) {
      if (!bandDecision.definition.relationship && !columns.has(bandDecision.definition.field)) {
        removed.push(`${resourceId}.${name}: reviewed numeric-band field ${bandDecision.definition.field} no longer exists`);
        continue;
      }
      numericBands[name] = bandDecision;
    }
    if (Object.keys(numericBands).length) retained.numeric_bands = numericBands;
    const autoBands: NonNullable<
      AutoBoundaryReviewOverrides["resources"][string]["auto_bands"]
    > = {};
    for (const [field, autoBandDecision] of Object.entries(decision.auto_bands ?? {})) {
      if (serverAuthority?.features.automatic_numeric_bands === false) {
        removed.push(
          `${resourceId}.${field}: reviewed automatic numeric bands are unavailable on ${inspection.server_version}`,
        );
        continue;
      }
      if (!columns.has(field)) {
        removed.push(`${resourceId}.${field}: reviewed auto-band field no longer exists`);
        continue;
      }
      autoBands[field] = autoBandDecision;
    }
    if (Object.keys(autoBands).length) retained.auto_bands = autoBands;
    const exactNumericGrouping: NonNullable<
      AutoBoundaryReviewOverrides["resources"][string]["exact_numeric_grouping"]
    > = {};
    for (const [field, groupingDecision] of Object.entries(
      decision.exact_numeric_grouping ?? {},
    )) {
      const column = columns.get(field);
      if (!column) {
        removed.push(`${resourceId}.${field}: reviewed exact grouping field no longer exists`);
        continue;
      }
      const previousType = previousResources.get(resourceId)?.field_types[field];
      if (previousType !== undefined && previousType !== column.data_type) {
        removed.push(
          `${resourceId}.${field}: reviewed exact grouping was removed because the field type changed from ${previousType} to ${column.data_type}; review the new type explicitly`,
        );
        continue;
      }
      exactNumericGrouping[field] = groupingDecision;
    }
    if (Object.keys(exactNumericGrouping).length) {
      retained.exact_numeric_grouping = exactNumericGrouping;
    }
    const fieldMetadata: NonNullable<
      AutoBoundaryReviewOverrides["resources"][string]["field_metadata"]
    > = {};
    for (const [fieldName, metadata] of Object.entries(decision.field_metadata ?? {})) {
      if (!columns.has(fieldName)) {
        removed.push(`${resourceId}.${fieldName}: reviewed label or description was removed because the field no longer exists`);
        continue;
      }
      fieldMetadata[fieldName] = metadata;
    }
    if (Object.keys(fieldMetadata).length) retained.field_metadata = fieldMetadata;
    const fieldEnums: NonNullable<
      AutoBoundaryReviewOverrides["resources"][string]["field_enums"]
    > = {};
    for (const [fieldName, enumDecision] of Object.entries(decision.field_enums ?? {})) {
      const column = columns.get(fieldName);
      if (!column) {
        removed.push(`${resourceId}.${fieldName}: reviewed categorical field no longer exists`);
        continue;
      }
      const declared = new Set(column.enum_values ?? []);
      const retainedValues = enumDecision.values.filter((value) => declared.has(value));
      if (!declared.size && enumDecision.values.length) {
        removed.push(
          `${resourceId}.${fieldName}: the schema-declared vocabulary is no longer provable; filtering and grouping remain disabled`,
        );
      } else if (retainedValues.length !== enumDecision.values.length) {
        removed.push(
          `${resourceId}.${fieldName}: values no longer declared by the database were removed from the reviewed vocabulary`,
        );
      }
      fieldEnums[fieldName] = {
        ...enumDecision,
        values: retainedValues,
      };
    }
    if (Object.keys(fieldEnums).length) retained.field_enums = fieldEnums;
    const fields: NonNullable<AutoBoundaryReviewOverrides["resources"][string]["fields"]> = {};
    for (const [fieldName, fieldDecision] of Object.entries(decision.fields ?? {})) {
      const column = columns.get(fieldName);
      if (!column) {
        removed.push(`${resourceId}.${fieldName}: reviewed field no longer exists`);
      } else if ((fieldDecision.exposure === "allow_reviewed_use"
          || fieldDecision.exposure === "withhold_from_model")
        && (column.suggestions.large_or_binary || isUnsafeRawType(column.data_type))) {
        removed.push(`${resourceId}.${fieldName}: reviewed use was removed because the current type is binary or unsupported`);
      } else {
        fields[fieldName] = fieldDecision;
      }
    }
    if (Object.keys(fields).length) retained.fields = fields;
    if (Object.keys(retained).length) resources[resourceId] = retained;
  }
  const preliminary = normalizeAutoBoundaryReviewOverrides({
    schema_version: AUTO_BOUNDARY_OVERRIDES_VERSION,
    resources,
  });
  if (Object.values(preliminary.resources).some((resource) =>
    resource.tenant_scope_path
    || resource.principal_scope_path
    || resource.principal_rls_setting
    || resource.shared_reference_scope
    || Object.keys(resource.exact_numeric_grouping ?? {}).length > 0)) {
    const parsedEvidence = context.parsedEvidence ?? [];
    const staticObjects = parsedEvidence.flatMap((evidence) =>
      evidence.objects.map((object) => ({ format: evidence.format, object })));
    const graph = buildEvidenceGraph(
      inspection,
      context.project ?? {
        root: "",
        frameworks: [],
        schema_inputs: [],
        database_env_names: [],
      },
      staticObjects,
      context.existingContracts ?? [],
      context.configuredTrustedContext,
    );
    const structuralOverrides = structuredClone(preliminary);
    for (const resource of Object.values(structuralOverrides.resources)) {
      delete resource.exact_numeric_grouping;
    }
    applyReviewOverrides(graph, normalizeAutoBoundaryReviewOverrides(structuralOverrides));
    inferDerivedScopeCandidates(graph);
    const reviewedResources = new Map(graph.resources.map((resource) => [resource.id, resource]));
    for (const [resourceId, decision] of Object.entries(resources)) {
      const reviewed = reviewedResources.get(resourceId);
      if (decision.tenant_scope_path
        && !reviewed?.derived_tenant_scope?.candidates.some((candidate) =>
          candidate.path_id === decision.tenant_scope_path!.value)) {
        removed.push(
          `${resourceId}: reviewed derived tenant path ${decision.tenant_scope_path.value} is no longer non-null, catalog-proven, unique, and connected to direct tenant scope`,
        );
        delete decision.tenant_scope_path;
      }
      if (decision.principal_scope_path?.value
        && !reviewed?.derived_principal_scope?.candidates.some((candidate) =>
          candidate.path_id === decision.principal_scope_path!.value)) {
        removed.push(
          `${resourceId}: reviewed derived principal path ${decision.principal_scope_path.value} is no longer non-null, catalog-proven, unique, and connected to direct principal scope`,
        );
        delete decision.principal_scope_path;
      }
      if (decision.shared_reference_scope && reviewed) {
        const eligibility = sharedReferenceScopeInference(reviewed, reviewedResources);
        if (!eligibility.eligible) {
          removed.push(
            `${resourceId}: reviewed shared-reference scope is no longer safe (${eligibility.blockers.join("; ")})`,
          );
          delete decision.shared_reference_scope;
        }
      }
      for (const field of Object.keys(decision.exact_numeric_grouping ?? {})) {
        const eligibility = reviewed
          ? exactNumericGroupingEligibility(reviewed, field)
          : { eligible: false, reasons: ["the resource is no longer available"] };
        if (eligibility.eligible) continue;
        removed.push(
          `${resourceId}.${field}: reviewed exact grouping was removed because `
          + eligibility.reasons.join("; "),
        );
        delete decision.exact_numeric_grouping![field];
      }
      if (decision.exact_numeric_grouping
        && Object.keys(decision.exact_numeric_grouping).length === 0) {
        delete decision.exact_numeric_grouping;
      }
      if (Object.keys(decision).length === 0) delete resources[resourceId];
    }
  }
  return {
    overrides: normalizeAutoBoundaryReviewOverrides({
      schema_version: AUTO_BOUNDARY_OVERRIDES_VERSION,
      resources,
    }),
    removed: removed.sort(),
  };
}

export function buildAutoBoundary(input: BuildAutoBoundaryInput): AutoBoundaryBuild {
  const compatibility = assertSupportedDatabaseServerVersion(input.inspection);
  if (!compatibility.authority) {
    throw new Error("The compatible database server did not produce a grammar authority profile.");
  }
  if (!compatibility.authority.features.automatic_numeric_bands
    && Object.values(input.overrides?.resources ?? {}).some((resource) =>
      Object.keys(resource.auto_bands ?? {}).length > 0)) {
    assertDatabaseGrammarFeature(
      compatibility.authority,
      "automatic_numeric_bands",
    );
  }
  const build = buildAutoBoundaryOnce(input);
  const hasPolicy = Object.keys(build.overrides.resources).length > 0;
  const baseline = hasPolicy
    ? buildAutoBoundaryOnce({ ...input, overrides: emptyReviewOverrides() })
    : build;
  return {
    ...build,
    policy_baseline: {
      schema_version: AUTO_BOUNDARY_POLICY_BASELINE_VERSION,
      boundary: baseline.exploration_boundary,
      lock: baseline.lock,
    },
  };
}

function configuredTrustedContextForBuild(
  input: BuildAutoBoundaryInput,
  organizationScope: SingleOrganizationScope | undefined,
): ConfiguredTrustedContextAuthority {
  const deploymentProfile = input.deploymentProfile ?? "staging";
  const fallback: ConfiguredTrustedContextAuthority = deploymentProfile === "production"
    ? {
        schema_version: CONFIGURED_TRUSTED_CONTEXT_AUTHORITY_VERSION,
        provider: "http_claims",
        ...(input.httpClaims?.tenantClaim ? { tenant_claim: input.httpClaims.tenantClaim } : {}),
        ...(input.httpClaims?.principalClaim
          ? { principal_claim: input.httpClaims.principalClaim }
          : {}),
      }
    : {
        schema_version: CONFIGURED_TRUSTED_CONTEXT_AUTHORITY_VERSION,
        provider: "environment",
        ...(organizationScope ? {} : { tenant_binding: "tenant_id" }),
        tenant_env: "SYNAPSOR_TENANT_ID",
        principal_env: "SYNAPSOR_PRINCIPAL",
      };
  const configured = structuredClone(input.configuredTrustedContext ?? fallback);
  if (configured.schema_version !== CONFIGURED_TRUSTED_CONTEXT_AUTHORITY_VERSION) {
    throw new Error(
      `Configured trusted-context authority must use ${CONFIGURED_TRUSTED_CONTEXT_AUTHORITY_VERSION}.`,
    );
  }
  if (deploymentProfile === "production" && configured.provider !== "http_claims") {
    throw new Error("Production Explore requires trusted_context.provider=http_claims.");
  }
  if (deploymentProfile !== "production" && configured.provider !== "environment") {
    throw new Error("Local development and staging Explore require trusted_context.provider=environment.");
  }
  if (configured.provider === "http_claims") {
    if (!configured.principal_claim?.trim()) {
      throw new Error(organizationScope
        ? "Single-organization production Explore boundary generation requires an explicit principal HTTP claim name."
        : "Production Explore boundary generation requires explicit tenant and principal HTTP claim names.");
    }
    if (!organizationScope && !configured.tenant_claim?.trim()) {
      throw new Error("Multi-tenant production Explore requires an explicit trusted tenant HTTP claim name.");
    }
    if (organizationScope && configured.tenant_claim) {
      throw new Error(
        "Single-organization production Explore uses its reviewed organization id and must not configure a tenant HTTP claim.",
      );
    }
    if (input.httpClaims
      && (input.httpClaims.tenantClaim !== configured.tenant_claim
        || input.httpClaims.principalClaim !== configured.principal_claim)) {
      throw new Error(
        "Production Explore HTTP claim flags must match the authoritative session-auth claim names in Runner config.",
      );
    }
  } else {
    configured.tenant_env = configured.tenant_env?.trim() || "SYNAPSOR_TENANT_ID";
    configured.principal_env = configured.principal_env?.trim() || "SYNAPSOR_PRINCIPAL";
  }
  for (const key of [
    "tenant_binding",
    "principal_binding",
    "tenant_env",
    "principal_env",
    "tenant_claim",
    "principal_claim",
  ] as const) {
    if (configured[key] !== undefined) {
      const value = configured[key]!.trim();
      if (!value) delete configured[key];
      else configured[key] = value;
    }
  }
  return configured;
}

function buildAutoBoundaryOnce(input: BuildAutoBoundaryInput): AutoBoundaryBuildCore {
  const serverCompatibility = assertSupportedDatabaseServerVersion(input.inspection);
  if (!serverCompatibility.authority || serverCompatibility.tier === "unsupported") {
    throw new Error("The compatible database server did not produce a grammar authority profile.");
  }
  const parsedEvidence = input.parsedEvidence ?? [];
  const existingContracts = input.existingContracts ?? [];
  const overrides = normalizeAutoBoundaryReviewOverrides(input.overrides);
  const sourceName = input.sourceName ?? (input.inspection.engine === "postgres" ? "local_postgres" : "local_mysql");
  const organizationScope = input.singleOrganization
    ? singleOrganizationScope(input.singleOrganization.organizationId)
    : undefined;
  const configuredTrustedContext = configuredTrustedContextForBuild(input, organizationScope);
  const configuredTrustedContextUsedForInference = Boolean(input.configuredTrustedContext)
    && input.useConfiguredTrustedContextForInference !== false;
  const staticObjects = parsedEvidence.flatMap((evidence) => evidence.objects.map((object) => ({ format: evidence.format, object })));
  const graph = buildEvidenceGraph(
    input.inspection,
    input.project,
    staticObjects,
    existingContracts,
    configuredTrustedContextUsedForInference
      ? configuredTrustedContext
      : undefined,
  );
  if (organizationScope) assertSingleOrganizationInspectionSafe(input.inspection, graph);
  applyReviewOverrides(graph, overrides);
  if (organizationScope) assertSingleOrganizationInspectionSafe(input.inspection, graph);
  inferDerivedScopeCandidates(graph);
  applyDerivedScopeReviewOverrides(graph, overrides, Boolean(organizationScope));
  graph.resources.forEach((resource) => refreshResourceStatus(resource, Boolean(organizationScope)));
  const dsl = emitDraftDsl(graph, sourceName);
  const contract = compileAgentDsl(dsl);
  const contractDigest = canonicalJsonDigest(contract);
  const schemaFingerprint = schemaFingerprintForInspection(input.inspection);
  const roleFingerprint = graph.database_role.fingerprint;
  const overridesDigest = canonicalJsonDigest(reviewOverrideAuthority(overrides));
  const evidenceFingerprint = canonicalJsonDigest({
    graph: generationEvidenceAuthority(graph.resources),
    structured_actions: graph.structured_actions,
    project: graph.project,
  });
  const baseLock: GenerationLock = {
    schema_version: GENERATION_LOCK_VERSION,
    compiler_version: AUTO_BOUNDARY_COMPILER_VERSION,
    spec_version: AUTO_BOUNDARY_SPEC_VERSION,
    engine: input.inspection.engine,
    database_server_version: input.inspection.server_version,
    database_server_tier: serverCompatibility.tier,
    database_server_authority: serverCompatibility.authority,
    source_env: input.sourceEnv,
    ...(input.inspectedSchema ? { inspected_schema: input.inspectedSchema } : {}),
    schema_fingerprint: schemaFingerprint,
    role_posture_fingerprint: roleFingerprint,
    evidence_fingerprint: evidenceFingerprint,
    generated_contract_digest: contractDigest,
    reviewed_overrides_digest: overridesDigest,
    protected_authority: graph.resources
      .filter((resource) => resource.status === "draft_read" && Boolean(resource.tenant_key.selected))
      .map((resource) => resource.id),
    reporting_timezone: "UTC",
    ...(organizationScope ? { organization_scope: organizationScope } : {}),
    trusted_context_authority: configuredTrustedContext,
    trusted_context_fingerprint: canonicalJsonDigest(configuredTrustedContext),
    configured_trusted_context_used_for_inference: configuredTrustedContextUsedForInference,
  };
  const provisionalBoundary = buildExplorationBoundaryDraft(
    graph,
    sourceName,
    canonicalJsonDigest(baseLock),
    {
      deploymentProfile: input.deploymentProfile ?? "staging",
      configuredTrustedContext,
      databaseServerVersion: input.inspection.server_version,
      databaseServerTier: serverCompatibility.tier,
      databaseServerAuthority: serverCompatibility.authority,
      ...(organizationScope ? { organizationScope } : {}),
    },
  );
  applyReviewedDerivedMeasureOverrides(provisionalBoundary, overrides);
  applyReviewedNumericBandOverrides(provisionalBoundary, overrides);
  applyReviewedAutoBandOverrides(provisionalBoundary, overrides);
  const lock: GenerationLock = {
    ...baseLock,
    authority_dependencies: buildGenerationAuthorityDependencies(input.inspection, provisionalBoundary),
  };
  const explorationBoundary: ExplorationBoundaryDraft = {
    ...provisionalBoundary,
    generation_lock_fingerprint: canonicalJsonDigest(lock),
  };
  const unresolved = explorationBoundary.unresolved_decisions;
  const review: AutoBoundaryBuild["review"] = {
    schema_version: AUTO_BOUNDARY_VERSION,
    activation: "blocked_unreviewed" as const,
    engine: graph.engine,
    database_role: graph.database_role,
    warnings: graph.warnings,
    summary: {
      objects: graph.resources.length,
      draft_reads: graph.resources.filter((resource) => resource.status === "draft_read").length,
      blocked_objects: graph.resources.filter((resource) => resource.status !== "draft_read").length,
      sensitive_fields_kept_out: graph.resources.reduce((count, resource) => count + resource.fields.filter((field) => field.sensitive_suggestion).length, 0),
      rls_policies: graph.resources.reduce((count, resource) => count + resource.rls.policy_names.length, 0),
      structured_write_candidates: graph.structured_actions.length,
    },
    unresolved_decisions: unresolved,
    resources: graph.resources,
    structured_actions: graph.structured_actions,
  };
  return {
    graph,
    dsl,
    contract,
    contract_digest: contractDigest,
    overrides,
    lock,
    exploration_boundary: explorationBoundary,
    review,
    tests: generatedContractTests(graph, contractDigest, Boolean(organizationScope)),
  };
}

function reviewOverrideAuthority(overrides: AutoBoundaryReviewOverrides): Record<string, unknown> {
  return {
    schema_version: overrides.schema_version,
    resources: Object.fromEntries(
      Object.entries(overrides.resources)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([resourceId, resource]) => [
          resourceId,
          {
            ...(resource.row_identity ? { row_identity: resource.row_identity.value } : {}),
            ...(resource.tenant_key ? { tenant_key: resource.tenant_key.value } : {}),
            ...(resource.tenant_scope_path
              ? { tenant_scope_path: resource.tenant_scope_path.value }
              : {}),
            ...(resource.shared_reference_scope
              ? { shared_reference_scope: resource.shared_reference_scope.value }
              : {}),
            ...(resource.principal_key ? { principal_key: resource.principal_key.value } : {}),
            ...(resource.principal_scope_path
              ? { principal_scope_path: resource.principal_scope_path.value }
              : {}),
            ...(resource.principal_rls_setting
              ? { principal_rls_setting: resource.principal_rls_setting.value }
              : {}),
            ...(resource.minimum_cohort ? { minimum_cohort: resource.minimum_cohort.value } : {}),
            ...(resource.derived_measures ? {
              derived_measures: Object.fromEntries(
                Object.entries(resource.derived_measures)
                  .sort(([left], [right]) => left.localeCompare(right))
                  .map(([name, decision]) => [name, decision.definition]),
              ),
            } : {}),
            ...(resource.numeric_bands ? {
              numeric_bands: Object.fromEntries(
                Object.entries(resource.numeric_bands)
                  .sort(([left], [right]) => left.localeCompare(right))
                  .map(([name, decision]) => [name, decision.definition]),
              ),
            } : {}),
            ...(resource.auto_bands ? {
              auto_bands: Object.fromEntries(
                Object.entries(resource.auto_bands)
                  .sort(([left], [right]) => left.localeCompare(right))
                  .map(([field, decision]) => [field, decision.definition]),
              ),
            } : {}),
            ...(resource.exact_numeric_grouping ? {
              exact_numeric_grouping: Object.keys(resource.exact_numeric_grouping).sort(),
            } : {}),
            ...(resource.metadata ? {
              metadata: {
                ...(resource.metadata.label ? { label: resource.metadata.label } : {}),
                ...(resource.metadata.description ? { description: resource.metadata.description } : {}),
              },
            } : {}),
            ...(resource.field_metadata ? {
              field_metadata: Object.fromEntries(
                Object.entries(resource.field_metadata)
                  .sort(([left], [right]) => left.localeCompare(right))
                  .map(([field, decision]) => [field, {
                    ...(decision.label ? { label: decision.label } : {}),
                    ...(decision.description ? { description: decision.description } : {}),
                  }]),
              ),
            } : {}),
            ...(resource.field_enums ? {
              field_enums: Object.fromEntries(
                Object.entries(resource.field_enums)
                  .sort(([left], [right]) => left.localeCompare(right))
                  .map(([field, decision]) => [field, decision.values]),
              ),
            } : {}),
            ...(resource.fields ? {
              fields: Object.fromEntries(
                Object.entries(resource.fields)
                  .sort(([left], [right]) => left.localeCompare(right))
                  .map(([field, decision]) => [field, decision.exposure]),
              ),
            } : {}),
          },
        ]),
    ),
  };
}

export function generationReviewEvidenceDigest(
  review: Pick<AutoBoundaryBuild["review"], "resources" | "structured_actions">,
  project: AutoBoundaryEvidenceGraph["project"],
): `sha256:${string}` {
  return canonicalJsonDigest({ graph: generationEvidenceAuthority(review.resources),
    structured_actions: review.structured_actions, project });
}

function generationEvidenceAuthority(resources: AutoBoundaryResource[]): unknown[] {
  return resources.map(({
    approximate_row_count: _approximateRowCount,
    shared_reference_scope: sharedReferenceScope,
    ...resource
  }) => ({
    ...resource,
    rls: {
      ...resource.rls,
      ...(resource.rls.principal_setting_review_override
        ? {
          principal_setting_review_override: {
            value: resource.rls.principal_setting_review_override.value,
          },
        }
        : {}),
    },
    ...(sharedReferenceScope
      ? {
        shared_reference_scope: sharedReferenceEvidenceAuthority(sharedReferenceScope),
      }
      : {}),
    ...(resource.metadata_review_override
      ? {
        metadata_review_override: {
          ...(resource.metadata_review_override.label
            ? { label: resource.metadata_review_override.label }
            : {}),
          ...(resource.metadata_review_override.description
            ? { description: resource.metadata_review_override.description }
            : {}),
        },
      }
      : {}),
    ...(resource.minimum_cohort_override
      ? {
        minimum_cohort_override: {
          value: resource.minimum_cohort_override.value,
        },
      }
      : {}),
    fields: resource.fields.map((field) => ({
      ...field,
      ...(field.enum_review_override
        ? { enum_review_override: { values: field.enum_review_override.values } }
        : {}),
      ...(field.exact_numeric_grouping_review_override
        ? { exact_numeric_grouping_review_override: true }
        : {}),
      ...(field.metadata_review_override
        ? {
          metadata_review_override: {
            ...(field.metadata_review_override.label
              ? { label: field.metadata_review_override.label }
              : {}),
            ...(field.metadata_review_override.description
              ? { description: field.metadata_review_override.description }
              : {}),
          },
        }
        : {}),
      ...(field.review_override
        ? { review_override: { exposure: field.review_override.exposure } }
        : {}),
    })),
  }));
}

function sharedReferenceEvidenceAuthority(
  scope: SharedReferenceScopeInference,
): Omit<SharedReferenceScopeInference, "review_override"> {
  const { review_override: _reviewOverride, ...authority } = scope;
  return authority;
}

export async function writeAutoBoundaryArtifacts(input: {
  projectRoot: string;
  build: AutoBoundaryBuild;
  outputRoot?: string;
  force?: boolean;
  preserveReviewProgress?: boolean;
  preserveActiveBoundary?: boolean;
  reviewProgress?: BoundaryReviewProgressArtifact<
    ExplorationBoundaryDraft,
    AutoBoundaryReviewOverrides
  >;
  additionalPrivateStateFiles?: Record<string, string>;
}, permit?: ProjectAuthorityMutationPermit): Promise<AutoBoundaryWriteResult> {
  const frozen = structuredClone(input);
  await fs.mkdir(frozen.projectRoot, { recursive: true });
  const relativeOutput = path.relative(path.resolve(frozen.projectRoot), path.resolve(frozen.projectRoot, frozen.outputRoot ?? DEFAULT_GENERATED_DIR));
  return withProjectAuthorityMutation(frozen.projectRoot, (held) => writeAutoBoundaryArtifactsUnlocked({
    ...frozen, projectRoot: held.projectRoot, outputRoot: relativeOutput,
  }), { permit });
}

async function writeAutoBoundaryArtifactsUnlocked(input: Parameters<typeof writeAutoBoundaryArtifacts>[0]): Promise<AutoBoundaryWriteResult> {
  const projectRoot = path.resolve(input.projectRoot);
  const governed = await openBoundProjectControlPolicies(projectRoot);
  if (governed) {
    await governed.close();
    throw Object.assign(new Error(
      "This project stores reviewed boundaries in its control repository. File-only generation cannot replace that state. "
      + "Use an exact saved-review revision; no artifacts or authority changed.",
    ), { code: "POLICY_AUTHORING_REPOSITORY_REQUIRED" });
  }
  const outputRoot = await assertSafeManagedOutputPath(
    path.resolve(projectRoot, input.outputRoot ?? DEFAULT_GENERATED_DIR),
  );
  assertInsideProject(projectRoot, outputRoot);
  const stateDir = await assertSafeManagedOutputPath(path.join(projectRoot, ".synapsor"));
  if (outputRoot === stateDir
    || outputRoot.startsWith(`${stateDir}${path.sep}`)
    || stateDir.startsWith(`${outputRoot}${path.sep}`)) {
    throw new Error("Auto Boundary output and private Runner state must use separate project directories.");
  }
  const existing = await exists(outputRoot);
  if (existing && !input.force) {
    throw new Error(`Auto Boundary output already exists at ${outputRoot}; review it or rerun with --force.`);
  }
  if (existing) await assertManagedBoundaryOutput(outputRoot);
  if (existing && input.preserveActiveBoundary) {
    try {
      const active = await loadActivatedExplorationBoundary(projectRoot);
      await loadGenerationLockForActivatedBoundary(projectRoot, active);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  await fs.mkdir(path.dirname(outputRoot), { recursive: true });
  const temporary = await fs.mkdtemp(path.join(path.dirname(outputRoot), `.${path.basename(outputRoot)}.tmp-`));
  await fs.mkdir(stateDir, { recursive: true, mode: 0o700 });
  const transactionRoot = await fs.mkdtemp(path.join(stateDir, ".auto-boundary-write-"));
  const stagedState = path.join(transactionRoot, "staged-state");
  const backupRoot = path.join(transactionRoot, "backup");
  const files = [
    "domain.synapsor.sql",
    "read-capabilities.synapsor.sql",
    "synapsor.candidate.contract.json",
    "exploration-boundary.draft.json",
    "generation-review.json",
    "review-overrides.json",
    "contract-tests.json",
    "REVIEW.md",
    ".synapsor-auto-boundary.json",
  ];
  try {
    await fs.mkdir(temporary, { recursive: true });
    await fs.writeFile(path.join(temporary, "domain.synapsor.sql"), contextDsl(input.build.dsl), "utf8");
    await fs.writeFile(path.join(temporary, "read-capabilities.synapsor.sql"), capabilityDsl(input.build.dsl), "utf8");
    await fs.writeFile(path.join(temporary, "synapsor.candidate.contract.json"), json(input.build.contract), "utf8");
    await fs.writeFile(path.join(temporary, "exploration-boundary.draft.json"), json(input.build.exploration_boundary), "utf8");
    await fs.writeFile(path.join(temporary, "generation-review.json"), json(input.build.review), "utf8");
    await fs.writeFile(path.join(temporary, "review-overrides.json"), json(input.build.overrides), "utf8");
    await fs.writeFile(path.join(temporary, "contract-tests.json"), json(input.build.tests), "utf8");
    await fs.writeFile(path.join(temporary, "REVIEW.md"), reviewMarkdown(input.build), "utf8");
    await fs.writeFile(path.join(temporary, ".synapsor-auto-boundary.json"), json({
      schema_version: AUTO_BOUNDARY_VERSION,
      contract_digest: input.build.contract_digest,
      schema_fingerprint: input.build.lock.schema_fingerprint,
    }), "utf8");
    await fs.mkdir(stagedState, { recursive: true, mode: 0o700 });
    await writePrivateStagedFile(stagedState, "generation-lock.json", json(input.build.lock));
    await writePrivateStagedFile(
      stagedState,
      AUTO_BOUNDARY_POLICY_BASELINE_FILE,
      json(input.build.policy_baseline),
    );
    await writePrivateStagedFile(stagedState, "review-report.json", json(input.build.review));
    await writePrivateStagedFile(stagedState, "review-overrides.json", json(input.build.overrides));
    if (input.reviewProgress) {
      await writePrivateStagedFile(
        stagedState,
        "boundary-review-progress.json",
        json(input.reviewProgress),
      );
    }
    const reservedStateFiles = new Set([
      "generation-lock.json",
      AUTO_BOUNDARY_POLICY_BASELINE_FILE,
      "review-report.json",
      "review-overrides.json",
      "boundary-review-progress.json",
      "exploration-boundary.active.json",
      ACTIVE_EXPLORATION_BOUNDARY_SET_FILE,
    ]);
    const additionalStateFiles = Object.keys(input.additionalPrivateStateFiles ?? {}).sort();
    for (const file of additionalStateFiles) {
      if (file !== path.basename(file) || reservedStateFiles.has(file)) {
        throw new Error(`Additional managed state file ${file} is not allowed.`);
      }
      await writePrivateStagedFile(stagedState, file, input.additionalPrivateStateFiles![file]!);
    }
    await persistGenerationLockSnapshot(
      projectRoot,
      input.build.exploration_boundary.generation_lock_fingerprint,
      input.build.lock,
    );
    await persistGenerationLockSnapshot(
      projectRoot,
      input.build.policy_baseline.boundary.generation_lock_fingerprint,
      input.build.policy_baseline.lock,
    );
    await commitManagedAutoBoundaryWrite({
      outputRoot,
      stagedOutput: temporary,
      stateDir,
      transactionRoot,
      backupRoot,
      existingOutput: existing,
      installStateFiles: [
        "generation-lock.json",
        AUTO_BOUNDARY_POLICY_BASELINE_FILE,
        "review-report.json",
        "review-overrides.json",
        ...(input.reviewProgress ? ["boundary-review-progress.json"] : []),
        ...additionalStateFiles,
      ],
      removeStateFiles: existing
        ? [
            ...(!input.preserveActiveBoundary
              ? ["exploration-boundary.active.json", ACTIVE_EXPLORATION_BOUNDARY_SET_FILE]
              : []),
            ...(!input.preserveReviewProgress && !input.reviewProgress
              ? ["boundary-review-progress.json"]
              : []),
          ]
        : [],
    });
    return {
      root: outputRoot,
      files: [
        ...files.map((file) => path.join(outputRoot, file)),
        path.join(stateDir, "generation-lock.json"),
        path.join(stateDir, AUTO_BOUNDARY_POLICY_BASELINE_FILE),
        path.join(stateDir, "review-report.json"),
        path.join(stateDir, "review-overrides.json"),
        ...additionalStateFiles.map((file) => path.join(stateDir, file)),
      ],
      contract_digest: input.build.contract_digest,
      schema_fingerprint: input.build.lock.schema_fingerprint,
      draft_reads: input.build.review.summary.draft_reads,
      blocked_objects: input.build.review.summary.blocked_objects,
    };
  } catch (error) {
    await fs.rm(temporary, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  } finally {
    await fs.rm(transactionRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

export function compareGenerationLock(
  lock: GenerationLock,
  inspection: SchemaInspection,
): {
  current: boolean;
  current_schema_fingerprint: `sha256:${string}`;
  current_role_posture_fingerprint: `sha256:${string}`;
  changes: string[];
} {
  const schemaFingerprint = schemaFingerprintForInspection(inspection);
  const roleFingerprint = rolePostureFingerprint(inspection);
  const currentServerCompatibility = databaseServerCompatibility(inspection);
  const currentServerAuthority = currentServerCompatibility.authority;
  const reviewedServerAuthority = lock.database_server_authority;
  const serverAuthorityMissing = !lock.database_server_version
    || !lock.database_server_tier
    || !reviewedServerAuthority;
  const serverAuthorityChanged = !serverAuthorityMissing
    && (canonicalJsonDigest(currentServerAuthority ?? null)
      !== canonicalJsonDigest(reviewedServerAuthority)
      || currentServerCompatibility.tier !== lock.database_server_tier);
  const serverAuthorityChanges = serverAuthorityMissing
    ? ["database server capability authority is not recorded"]
    : serverAuthorityChanged
      ? [
        `database server release line changed from ${reviewedServerAuthority.engine} ${reviewedServerAuthority.version_line} to ${currentServerAuthority ? `${currentServerAuthority.engine} ${currentServerAuthority.version_line}` : inspection.server_version}`,
      ]
      : [];
  const changes = [
    ...serverAuthorityChanges,
    ...(schemaFingerprint !== lock.schema_fingerprint ? ["schema metadata changed"] : []),
    ...(roleFingerprint !== lock.role_posture_fingerprint ? ["database role, grants, ownership, or RLS posture changed"] : []),
    ...(lock.compiler_version !== AUTO_BOUNDARY_COMPILER_VERSION ? ["Auto Boundary compiler version changed"] : []),
    ...(!SUPPORTED_AUTO_BOUNDARY_SPEC_VERSIONS.has(lock.spec_version) ? ["canonical Spec version is unsupported"] : []),
  ];
  return {
    current: changes.length === 0,
    current_schema_fingerprint: schemaFingerprint,
    current_role_posture_fingerprint: roleFingerprint,
    changes,
  };
}

export function generationLockRemediationCommand(
  lock: Pick<GenerationLock, "source_env">,
): string {
  return `synapsor-runner boundary rescan --from-env ${lock.source_env}`;
}

export function generationLockRemediation(
  lock: Pick<GenerationLock, "source_env">,
): string {
  return [
    "The reviewed boundary must be reconciled against the current database posture.",
    `Run from the project directory: ${generationLockRemediationCommand(lock)}`,
    "Runner preserves unchanged review decisions, invalidates only affected authority, and never activates the reconciled draft automatically.",
  ].join("\n");
}

export function credentialPostureFingerprintForAuthority(
  inspection: SchemaInspection,
): `sha256:${string}` {
  const role = inspection.role_posture;
  return canonicalJsonDigest({
    engine: inspection.engine,
    current_user: inspection.current_user,
    role: role
      ? {
          verified: role.verified,
          superuser: role.superuser,
          bypass_rls: role.bypass_rls,
          read_only: role.read_only,
          writable_relations: [...role.writable_relations].sort(),
          owned_relations: [...role.owned_relations].sort(),
        }
      : null,
  });
}

export function resourceAuthorityDependencyFingerprint(
  dependency: Omit<GenerationAuthorityDependencies["resources"][string], "fingerprint">,
  inspection: SchemaInspection,
): `sha256:${string}` | undefined {
  const table = inspection.tables.find((candidate) =>
    candidate.schema === dependency.schema && candidate.name === dependency.table);
  if (!table) return undefined;
  const columns = new Map(table.columns.map((column) => [column.name, column]));
  const dependencyFieldNames = dependency.shared_reference_scope
    ? table.columns.map((column) => column.name).sort()
    : dependency.fields;
  const selectedColumns = dependencyFieldNames.map((name) => {
    const column = columns.get(name);
    if (!column) return undefined;
    return {
      name: column.name,
      data_type: column.data_type,
      nullable: column.nullable,
      default: column.default ?? null,
      generated: column.generated,
      identity: column.identity ?? false,
      enum_values: [...(column.enum_values ?? [])].sort(),
    };
  });
  if (selectedColumns.some((column) => !column)) return undefined;
  return canonicalJsonDigest({
    engine: inspection.engine,
    schema: table.schema,
    table: table.name,
    type: table.type,
    ...(dependency.shared_reference_scope
      ? {
        shared_reference_scope: dependency.shared_reference_scope,
        tenant_column_candidates: [...table.suggestions.tenant_columns].sort(),
        foreign_keys: [...table.foreign_keys]
          .map((foreignKey) => ({
            name: foreignKey.name,
            columns: [...foreignKey.columns],
            referenced_schema: foreignKey.referenced_schema,
            referenced_table: foreignKey.referenced_table,
            referenced_columns: [...foreignKey.referenced_columns],
          }))
          .sort((left, right) => left.name.localeCompare(right.name)),
      }
      : {}),
    primary_key: [...table.primary_key],
    columns: selectedColumns,
    row_level_security: table.row_level_security ?? "unknown",
    row_level_security_policies: [...(table.row_level_security_policies ?? [])]
      .map((policy) => ({
        name: policy.name,
        command: policy.command,
        permissive: policy.permissive,
        roles: [...policy.roles].sort(),
        using_expression: policy.using_expression ?? null,
        check_expression: policy.check_expression ?? null,
      }))
      .sort((left, right) => left.name.localeCompare(right.name)),
    role_posture: table.role_posture
      ? {
          owner: table.role_posture.owner,
          current_role_is_owner: table.role_posture.current_role_is_owner,
          current_role_can_assume_owner: table.role_posture.current_role_can_assume_owner,
          privileges: table.role_posture.privileges,
          row_security_forced: table.role_posture.row_security_forced,
          row_security_effective_for_current_role: table.role_posture.row_security_effective_for_current_role,
        }
      : null,
  });
}

export function relationshipAuthorityDependencyFingerprint(
  dependency: GenerationAuthorityDependencies["relationships"][string],
  inspection: SchemaInspection,
): `sha256:${string}` | undefined {
  const tables = new Map(inspection.tables.map((table) => [`${table.schema}.${table.name}`, table]));
  const currentLinks: RelationshipLinkProof[] = [];
  for (const expected of dependency.links) {
    const source = tables.get(expected.source_resource);
    const target = tables.get(expected.target_resource);
    if (!source || !target) return undefined;
    const foreignKey = source.foreign_keys.find((candidate) =>
      candidate.name === expected.constraint_name
      && candidate.referenced_schema === target.schema
      && candidate.referenced_table === target.name
      && sameOrderedStrings(candidate.columns, expected.source_columns)
      && sameOrderedStrings(candidate.referenced_columns, expected.target_columns));
    if (!foreignKey) return undefined;
    const targetUniqueness = relationshipTargetUniqueness(target, foreignKey.referenced_columns);
    if (!targetUniqueness
      || targetUniqueness.kind !== expected.target_uniqueness.kind
      || targetUniqueness.name !== expected.target_uniqueness.name
      || !sameOrderedStrings(targetUniqueness.columns, expected.target_uniqueness.columns)) {
      return undefined;
    }
    const nullable = foreignKey.columns.some((name) =>
      source.columns.find((column) => column.name === name)?.nullable !== false);
    currentLinks.push({
      constraint_name: foreignKey.name,
      source_resource: expected.source_resource,
      target_resource: expected.target_resource,
      source_columns: [...foreignKey.columns],
      target_columns: [...foreignKey.referenced_columns],
      target_uniqueness: targetUniqueness,
      nullable,
      cardinality: "many_to_one",
      max_fan_out: 1,
    });
  }
  return canonicalJsonDigest(currentLinks);
}

function buildGenerationAuthorityDependencies(
  inspection: SchemaInspection,
  boundary: ExplorationBoundaryDraft,
): GenerationAuthorityDependencies {
  const resources = Object.fromEntries(boundary.pack.resources.map((resource) => {
    const fields = authorityDependencyFields(resource, boundary.pack.resources);
    const descriptor = {
      schema: resource.schema,
      table: resource.table,
      fields,
      ...(resource.shared_reference_scope
        ? { shared_reference_scope: structuredClone(resource.shared_reference_scope) }
        : {}),
    };
    const fingerprint = resourceAuthorityDependencyFingerprint(descriptor, inspection);
    if (!fingerprint) throw new Error(`Cannot fingerprint generated authority for missing resource ${resource.id}.`);
    return [resource.id, { ...descriptor, fingerprint }];
  }));
  const relationships = Object.fromEntries(boundary.pack.resources.flatMap((resource) => [
    ...resource.relationships.map((relationship) => {
      if (!relationship.proof || relationship.proof.source !== "database_catalog") {
        throw new Error(`Generated relationship ${resource.id}.${relationship.id} lacks database-catalog proof.`);
      }
      const key = relationshipDependencyKey(resource.id, relationship.id);
      return [key, {
        root_resource: resource.id,
        relationship_id: relationship.id,
        links: structuredClone(relationship.proof.links),
        proof_digest: relationship.proof.digest,
      }];
    }),
    ...([[
      "tenant" as const,
      resource.tenant_scope,
    ], [
      "principal" as const,
      resource.principal_scope,
    ]] as const).flatMap(([kind, scope]) => scope
      ? [[derivedScopeDependencyKey(resource.id, kind), {
        root_resource: resource.id,
        relationship_id: `scope:${kind}:${scope.path_id}`,
        links: structuredClone(scope.proof.links),
        proof_digest: scope.proof.digest,
      }] as const]
      : []),
  ]));
  return {
    schema_version: AUTHORITY_DEPENDENCIES_VERSION,
    credential_posture_fingerprint: credentialPostureFingerprintForAuthority(inspection),
    resources,
    relationships,
  };
}

function authorityDependencyFields(
  resource: ExplorationBoundaryDraft["pack"]["resources"][number],
  resources: ExplorationBoundaryDraft["pack"]["resources"],
): string[] {
  const fields = new Set([
    resource.primary_key,
    resource.tenant_key,
    resource.principal_key,
    ...resource.selectable_fields,
    ...Object.keys(resource.filterable_fields),
    ...resource.sortable_fields,
    ...resource.groupable_fields,
    ...resource.aggregate_measures,
    ...resource.count_distinct_fields,
    ...Object.keys(resource.time_bucket_fields),
  ].filter((field): field is string => Boolean(field)));
  for (const relationship of resources.flatMap((entry) => entry.relationships)) {
    for (const link of relationship.proof?.links ?? []) {
      if (link.source_resource === resource.id) link.source_columns.forEach((field) => fields.add(field));
      if (link.target_resource === resource.id) link.target_columns.forEach((field) => fields.add(field));
    }
  }
  for (const scopedResource of resources) {
    for (const scope of [scopedResource.tenant_scope, scopedResource.principal_scope]) {
      if (!scope) continue;
      for (const link of scope.proof.links) {
        if (link.source_resource === resource.id) {
          link.source_columns.forEach((field) => fields.add(field));
        }
        if (link.target_resource === resource.id) {
          link.target_columns.forEach((field) => fields.add(field));
        }
      }
      if (scope.ancestor_resource === resource.id) fields.add(scope.ancestor_column);
    }
  }
  return [...fields].sort();
}

export function relationshipDependencyKey(rootResource: string, relationshipId: string): string {
  return `${rootResource}::${relationshipId}`;
}

export function derivedScopeDependencyKey(
  resourceId: string,
  kind: "tenant" | "principal",
): string {
  return `${resourceId}::scope:${kind}`;
}

function sameOrderedStrings(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

type DescribedReadResource = ExplorationBoundaryDraft["pack"]["resources"][number];

/** Complete metadata only; runtime adds optional validated question examples. */
export function describeExplorationBoundaryMetadata(
  boundary: ActivatedExplorationBoundary | ExplorationBoundaryDraft,
  selected: DescribedReadResource[],
  reviewableBoundary?: ExplorationBoundaryDraft,
  timeCoverage: ReviewedTimeCoverage = {},
): Record<string, unknown> {
  return {
    ok: true,
    outcome: { type: "success" },
    ...(typeof boundary.activation === "object" ? { boundary_digest: boundary.activation.digest } : {}),
    pack: boundary.pack.name,
    ...(boundary.organization_scope ? {
      organization_scope: {
        mode: "single_organization",
        tenant_filter: "not_applicable",
        organization_identity: "fixed_outside_model_arguments",
      },
    } : {}),
    reporting_timezone: {
      name: boundary.reporting_timezone ?? "database_session",
      authority_bound: Boolean(boundary.reporting_timezone),
    },
    relative_time_windows: {
      available: boundary.reporting_timezone === "UTC",
      reporting_timezone: boundary.reporting_timezone === "UTC" ? "UTC" : null,
      windows: boundary.reporting_timezone === "UTC" ? [...RELATIVE_TIME_WINDOWS] : [],
      comparison_partners: boundary.reporting_timezone === "UTC"
        ? [...RELATIVE_TIME_COMPARISONS]
        : [],
      range_semantics: "half-open [start, end)",
      week_starts_on: "Monday",
      model_supplied_date_arithmetic: false,
    },
    vocabulary_policy: {
      reviewed_metadata_is_semantic_only: true,
      exact_ids_required_in_plans: true,
      opaque_identifier_behavior: "do_not_guess; ask the operator to add a reviewed label or description",
      coded_value_behavior: "do_not_infer_business_meaning_from_codes; use exact codes only when the question names them or reviewed metadata explains them",
    },
    resources: selected.map((resource) => {
      const reviewableRelationships = inactiveReviewableRelationships(resource, boundary, reviewableBoundary);
      const reviewedFields = unique([
        resource.primary_key,
        ...resource.selectable_fields,
        ...Object.keys(resource.filterable_fields),
        ...resource.sortable_fields,
        ...resource.groupable_fields,
        ...resource.aggregate_measures,
        ...(resource.presence_measure_fields ?? []),
        ...resource.count_distinct_fields,
        ...Object.keys(resource.time_bucket_fields),
      ]);
      const describedFields = reviewedFields.filter((field) =>
        !resource.kept_out_fields.includes(field));
      const modelWithheld = new Set(resource.model_withheld_fields ?? []);
      const vocabulary = exploreVocabularyCoverage(resource);
      return {
        id: resource.id,
        ...(resource.label ? { label: resource.label } : {}),
        ...(resource.description ? { description: resource.description } : {}),
        vocabulary,
        primary_key: resource.primary_key,
        fields: describedFields.map((field) => describeReviewedFieldGrammar(
          resource,
          field,
          modelWithheld,
        )),
        field_egress: Object.fromEntries(reviewedFields.map((field) => [
          field,
          { model_egress: modelWithheld.has(field) ? "withheld" : "visible" },
        ])),
        selectable_fields: resource.selectable_fields,
        ...(resource.relationship_only ? { relationship_only: true } : {}),
        filterable_fields: Object.keys(resource.filterable_fields),
        filter_operators: resource.filterable_fields,
        sortable_fields: resource.sortable_fields,
        groupable_fields: resource.groupable_fields,
        aggregate_measures: resource.aggregate_measures,
        aggregate_measure_functions: Object.fromEntries(resource.aggregate_measures.map((field) => [
          field,
          reviewedNumericAggregateFunctions(resource, field),
        ])),
        presence_measure_fields: resource.presence_measure_fields ?? [],
        presence_measure_functions: resource.presence_measure_fields?.length
          ? ["null_count", "non_null_count", "completion_rate"]
          : [],
        derived_measures: (resource.derived_measures ?? []).map((measure) =>
          describeReviewedDerivedMeasure(measure, resource.minimum_cohort_size)),
        numeric_bands: (resource.numeric_bands ?? []).map((band) => ({
          name: band.name,
          label: band.label,
          field: band.field,
          relationship: band.relationship ?? null,
          edges: [...band.edges],
          bucket_labels: [...band.bucket_labels],
        })),
        auto_bands: (resource.auto_bands ?? []).map((policy) => ({
          field: policy.field,
          methods: [...policy.methods],
          min_buckets: policy.min_buckets,
          max_buckets: policy.max_buckets,
          min_bucket_width: policy.min_bucket_width ?? null,
          label_style: policy.label_style,
          label_round_to: policy.label_round_to ?? null,
          model_selects: ["field", "method", "buckets"],
          raw_edges_returned: false,
        })),
        count_distinct_fields: resource.count_distinct_fields,
        time_bucket_fields: resource.time_bucket_fields,
        relative_time_window_fields: boundary.reporting_timezone === "UTC"
          ? Object.keys(resource.time_bucket_fields).sort()
          : [],
        time_coverage: timeCoverage[resource.id] ?? {},
        field_types: Object.fromEntries(reviewedFields.map((field) => [field, resource.field_types[field]])),
        field_enums: Object.fromEntries(reviewedFields
          .filter((field) => !modelWithheld.has(field) && resource.field_enums[field]?.length)
          .map((field) => [field, resource.field_enums[field]])),
        kept_out_field_count: resource.kept_out_fields.length,
        relationships: [
          ...resource.relationships.map((relationship) => ({ relationship, activation: "active" as const })),
          ...reviewableRelationships.map((relationship) => ({
            relationship,
            activation: "review_required" as const,
          })),
        ].map(({ relationship, activation }) => {
          const target = boundary.pack.resources.find((candidate) => candidate.id === relationship.target_resource)!;
          const relationshipLinks = relationship.proof?.links ?? [];
          const pathResources = relationshipLinks.length
            ? [relationshipLinks[0]!.source_resource, ...relationshipLinks.map((link) =>
                link.target_resource)]
            : [resource.id, relationship.target_resource];
          const pathViaColumns = relationshipLinks.length
            ? relationshipLinks.map((link) => [...link.source_columns])
            : [[...relationship.local_columns]];
          const targetFields = unique([
            ...target.selectable_fields,
            ...Object.keys(target.filterable_fields),
            ...target.groupable_fields,
            ...target.aggregate_measures,
            ...(target.presence_measure_fields ?? []),
            ...target.count_distinct_fields,
            ...Object.keys(target.time_bucket_fields),
          ]);
          const targetModelWithheld = new Set(target.model_withheld_fields ?? []);
          const describedTargetFields = targetFields.filter((field) =>
            !target.kept_out_fields.includes(field));
          const targetVocabulary = exploreVocabularyCoverage(target);
          return {
            id: relationship.id,
            activation,
            operator_review_required: activation === "review_required",
            target_resource: relationship.target_resource,
            ...(target.label ? { target_label: target.label } : {}),
            ...(target.description ? { target_description: target.description } : {}),
            vocabulary: targetVocabulary,
            cardinality: relationship.cardinality,
            counted_entity: relationship.counted_entity,
            path_depth: relationship.path_depth ?? 1,
            path: {
              resources: pathResources,
              via_columns: pathViaColumns,
            },
            nullable: relationship.nullable ?? false,
            unmatched_rows: relationship.unmatched_rows ?? "exclude",
            structural_evidence: relationship.proof?.links.map((link) => ({
              constraint_name: link.constraint_name,
              source_resource: link.source_resource,
              target_resource: link.target_resource,
              source_columns: link.source_columns,
              target_columns: link.target_columns,
              target_uniqueness: link.target_uniqueness,
              nullable: link.nullable,
              cardinality: link.cardinality,
            })) ?? [],
            field_egress: Object.fromEntries(targetFields.map((field) => [
              field,
              { model_egress: targetModelWithheld.has(field) ? "withheld" : "visible" },
            ])),
            fields: describedTargetFields.map((field) => describeReviewedFieldGrammar(
              target,
              field,
              targetModelWithheld,
              true,
            )),
            selectable_fields: target.selectable_fields,
            filterable_fields: Object.keys(target.filterable_fields),
            filter_operators: target.filterable_fields,
            groupable_fields: target.groupable_fields,
            aggregate_measures: target.aggregate_measures,
            aggregate_measure_functions: Object.fromEntries(target.aggregate_measures.map((field) => [
              field,
              reviewedNumericAggregateFunctions(target, field),
            ])),
            presence_measure_fields: target.presence_measure_fields ?? [],
            presence_measure_functions: target.presence_measure_fields?.length
              ? ["null_count", "non_null_count", "completion_rate"]
              : [],
            derived_measures: (target.derived_measures ?? []).map((measure) =>
              describeReviewedDerivedMeasure(measure, target.minimum_cohort_size)),
            count_distinct_fields: target.count_distinct_fields,
            time_bucket_fields: target.time_bucket_fields,
            relative_time_window_fields: boundary.reporting_timezone === "UTC"
              ? Object.keys(target.time_bucket_fields).sort()
              : [],
            field_types: Object.fromEntries(targetFields.map((field) => [field, target.field_types[field]])),
            field_enums: Object.fromEntries(targetFields
              .filter((field) => !targetModelWithheld.has(field) && target.field_enums[field]?.length)
              .map((field) => [field, target.field_enums[field]])),
          };
        }),
        minimum_cohort_size: resource.minimum_cohort_size,
        ...(resource.minimum_cohort_overridden ? { minimum_cohort_overridden: true } : {}),
        maximum_rows: boundary.budgets.max_rows,
        maximum_groups: Math.min(boundary.budgets.max_groups, boundary.budgets.max_top_n),
        suggested_questions: [],
      };
    }),
    next_cursor: null,
    raw_sql_available: false,
    source_rows_available_before_activation: false,
  };
}

function describeReviewedFieldGrammar(
  resource: DescribedReadResource,
  field: string,
  modelWithheld: Set<string>,
  throughRelationship = false,
): Record<string, unknown> {
  const aggregateFunctions = resource.aggregate_measures.includes(field)
    ? reviewedNumericAggregateFunctions(resource, field)
    : [];
  const presenceFunctions = (resource.presence_measure_fields ?? []).includes(field)
    ? ["null_count", "non_null_count", "completion_rate"]
    : [];
  return {
    id: field,
    plan_reference: "exact_id_only",
    semantic_status: exploreFieldSemanticStatus(resource, field),
    ...(resource.field_metadata?.[field]?.label
      ? { label: resource.field_metadata[field]!.label }
      : {}),
    ...(resource.field_metadata?.[field]?.description
      ? { description: resource.field_metadata[field]!.description }
      : {}),
    operations: {
      return_value: resource.selectable_fields.includes(field),
      model_egress: modelWithheld.has(field) ? "withheld" : "visible",
      filter_operators: [...(resource.filterable_fields[field] ?? [])],
      sortable: !throughRelationship && resource.sortable_fields.includes(field),
      groupable: resource.groupable_fields.includes(field),
      aggregate_functions: aggregateFunctions,
      presence_functions: presenceFunctions,
      count_distinct: resource.count_distinct_fields.includes(field),
      time_buckets: [...(resource.time_bucket_fields[field] ?? [])],
    },
    ...(!modelWithheld.has(field) && resource.field_enums[field]?.length
      ? { allowed_values: [...resource.field_enums[field]!] }
      : {}),
  };
}

function describeReviewedDerivedMeasure(
  measure: ExplorationDerivedMeasure,
  minimumCohortSize: number,
): Record<string, unknown> {
  const common = {
    name: measure.name,
    label: measure.label,
    shape: measure.shape,
    effective_minimum_cohort_size: Math.max(
      minimumCohortSize,
      MINIMUM_DISPERSION_COHORT_SIZE,
    ),
  };
  if ("child_resource" in measure) {
    return {
      ...common,
      calculation_stage: "scoped child count aggregated over reviewed parent cohorts",
      child_resource: measure.child_resource,
      relationship: measure.relationship,
      parent_contributor_floor: "applied before release",
      raw_child_rows_returned: false,
    };
  }
  if (!("base_measure" in measure)) {
    return {
      ...common,
      calculation_stage: "after cohort validation",
      null_behavior: "null when the reviewed denominator is zero or null",
    };
  }
  const sequential = isSequentialDerivedMeasureShape(measure.shape);
  return {
    ...common,
    calculation_stage: "after small-group suppression",
    required_grain: sequential
      ? "one reviewed ordered time_bucket; dimensions are optional partitions"
      : "one or more reviewed dimensions and no time_bucket",
    ...(sequential ? { records_without_reviewed_time: "omitted" } : {}),
    ...(measure.shape === "rank" ? { fixed_direction: measure.direction } : {}),
    ...(measure.shape === "moving_average" ? { fixed_window_size: measure.window_size } : {}),
    suppressed_groups_included: false,
  };
}

export type ReviewedTimeCoverage = Record<string, Record<string, {
  status: "available" | "empty" | "withheld_below_minimum_cohort" | "unavailable";
  start_date?: string;
  end_date?: string;
  reporting_timezone?: "UTC" | "database_session";
}>>;

export const MINIMUM_DISPERSION_COHORT_SIZE = 5;

export function reviewedNumericAggregateFunctions(
  resource: DescribedReadResource,
  field: string,
): readonly ExplorationNumericAggregateFunction[] {
  const reviewed = resource.aggregate_measure_functions?.[field];
  if (reviewed) return reviewed.every((fn) => EXPLORATION_NUMERIC_AGGREGATE_FUNCTIONS.includes(fn)) ? reviewed : [];
  return resource.aggregate_measure_functions ? [] : ["sum", "avg"];
}

export function isSequentialDerivedMeasureShape(shape: string): boolean {
  return shape === "running_total"
    || shape === "lag_absolute_change"
    || shape === "lag_percentage_change"
    || shape === "moving_average";
}

export function inactiveReviewableRelationships(
  resource: DescribedReadResource,
  boundary: ActivatedExplorationBoundary | ExplorationBoundaryDraft,
  draft?: ExplorationBoundaryDraft,
): DescribedReadResource["relationships"] {
  if (!draft) return [];
  const activeIds = new Set(resource.relationships.map((relationship) => relationship.id));
  const activeResources = new Set(boundary.pack.resources.map((candidate) => candidate.id));
  const draftResource = draft.pack.resources.find((candidate) => candidate.id === resource.id);
  return (draftResource?.relationships ?? [])
    .filter((relationship) =>
      !activeIds.has(relationship.id)
      && activeResources.has(relationship.target_resource)
      && relationship.proof?.source === "database_catalog"
      && canonicalJsonDigest(relationship.proof.links) === relationship.proof.digest
      && relationship.proof.links.length >= 1
      && relationship.proof.links.length <= 3
      && relationship.proof.links.every((link) =>
        activeResources.has(link.source_resource)
        && activeResources.has(link.target_resource)
        && link.cardinality === "many_to_one"
        && link.max_fan_out === 1
        && link.target_uniqueness.columns.length === link.target_columns.length
        && link.target_uniqueness.columns.every((field, index) => field === link.target_columns[index])))
    .sort((left, right) =>
      (left.path_depth ?? 1) - (right.path_depth ?? 1) || left.id.localeCompare(right.id));
}

export function readDiscoveryCompatibility(
  boundary: ExplorationBoundaryDraft | ActivatedExplorationBoundary,
  digest: string,
  reviewable?: ExplorationBoundaryDraft,
): ReadDiscoveryConcern[] {
  return checkReadDiscoveryContracts(boundary.pack.resources.map((resource) =>
    describeExplorationBoundaryMetadata(boundary, [resource], reviewable)), digest, boundary.pack.name);
}

export async function readOptionalExplorationDraft(projectRoot: string): Promise<ExplorationBoundaryDraft | undefined> {
  try {
    return JSON.parse(await fs.readFile(path.join(projectRoot, DEFAULT_GENERATED_DIR, "exploration-boundary.draft.json"), "utf8")) as ExplorationBoundaryDraft;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function assertRuntimeReadDiscoveryFits(projectRoot: string, boundaries: ActivatedExplorationBoundary[]): Promise<void> {
  const runtimeDraft = await readOptionalExplorationDraft(projectRoot);
  const concerns = boundaries.flatMap((boundary) => readDiscoveryCompatibility(boundary, boundary.activation.digest, runtimeDraft));
  if (concerns.length) throw new Error(readDiscoveryConcernLines(concerns).join("\n"));
}


export async function activateExplorationBoundary(input: {
  projectRoot: string;
  candidate: ExplorationBoundaryDraft;
  reviewDraft?: ExplorationBoundaryDraft;
  generationLock?: GenerationLock;
  expectedAuthoring?: ReadAuthoringBindings;
  verifiedDecision?: GovernedReadActivationDecision;
  expectedDigest: string;
  actor: string;
  confirmation: string;
  confirmedDecisions: string[];
  currentInspection: SchemaInspection;
  activeSetMode?: "replace" | "add";
  activationAudit?: {
    mode: "full_review" | "instant_development";
    profile_assertion?: "own_development";
    launch_context?: "start_from_env_local_authoring";
    confirmation_gesture?:
      | "activate_and_read"
      | "activate_for_model"
      | "activate_for_existing_client"
      | "activate_for_no_model";
  };
}): Promise<ActivatedExplorationBoundary> {
  input = structuredClone(input);
  const projectRoot = path.resolve(input.projectRoot);
  const draftPath = path.join(projectRoot, DEFAULT_GENERATED_DIR, "exploration-boundary.draft.json");
  const lockPath = path.join(projectRoot, ".synapsor/generation-lock.json");
  const draft = input.reviewDraft
    ?? JSON.parse(await fs.readFile(draftPath, "utf8")) as ExplorationBoundaryDraft;
  const lock = input.generationLock
    ?? JSON.parse(await fs.readFile(lockPath, "utf8")) as GenerationLock;
  const reviewed = reviewExplorationBoundaryCandidate(draft, input.candidate);
  const candidate = reviewed.candidate;
  assertGenerationLockFingerprint(lock, candidate.generation_lock_fingerprint);
  const reviewedDecisions = assertExactDecisionReview(
    candidate.unresolved_decisions,
    input.confirmedDecisions,
    draft.unresolved_decisions,
  );
  assertCurrentExplorationBoundaryAuthority({
    lock,
    inspection: input.currentInspection,
    candidate,
  });
  for (const resource of candidate.pack.resources) {
    const unresolved = resource.relationships.find((relationship) =>
      relationship.unmatched_rows === "review_required");
    if (unresolved) {
      throw new Error(`${resource.id} relationship ${unresolved.id} is nullable; choose whether unmatched rows are kept as null or excluded.`);
    }
  }
  const vocabularyGaps = exploreBoundaryVocabularyGaps(candidate.pack.resources);
  if (vocabularyGaps.length > 0) {
    const details = vocabularyGaps.map((gap) => {
      const missing = [
        ...(gap.resource_gap ? ["table label or description"] : []),
        ...(gap.fields.length > 0 ? [`field vocabulary for ${gap.fields.join(", ")}`] : []),
      ];
      return `- ${gap.resource}: ${missing.join("; ")}`;
    });
    throw new Error([
      "Exploration-boundary activation requires reviewed vocabulary for clearly opaque model-facing identifiers.",
      ...details,
      "Open /access, select each table or column, and press I to add a reviewed label or description; then review and activate again.",
      "Plans will still use exact database IDs. Reviewed vocabulary helps the model choose those IDs and grants no additional data authority.",
    ].join("\n"));
  }
  const normalizedAuthority = boundaryAuthority(candidate);
  const digest = canonicalJsonDigest(normalizedAuthority);
  if (input.expectedDigest !== digest) throw new Error("Exploration-boundary digest changed after review; reload and review the exact candidate.");
  if (input.confirmation !== `ACTIVATE ${digest}`) {
    throw new Error(`Activation requires the exact confirmation ACTIVATE ${digest}.`);
  }
  const actor = input.actor.trim();
  if (!actor || actor.length > 128 || /[\u0000-\u001f\u007f]/.test(actor)) throw new Error("Activation actor must be a non-empty local operator identifier.");
  const active: ActivatedExplorationBoundary = {
    schema_version: candidate.schema_version,
    deployment_profile: candidate.deployment_profile,
    source: candidate.source,
    compiler_version: candidate.compiler_version,
    spec_version: candidate.spec_version,
    ...(candidate.database_server_version
      ? { database_server_version: candidate.database_server_version }
      : {}),
    ...(candidate.database_server_tier
      ? { database_server_tier: candidate.database_server_tier }
      : {}),
    ...(candidate.database_server_authority
      ? { database_server_authority: structuredClone(candidate.database_server_authority) }
      : {}),
    ...(candidate.reporting_timezone ? { reporting_timezone: candidate.reporting_timezone } : {}),
    ...(candidate.organization_scope ? { organization_scope: candidate.organization_scope } : {}),
    trusted_context: candidate.trusted_context,
    generation_lock_fingerprint: candidate.generation_lock_fingerprint,
    role_posture_fingerprint: candidate.role_posture_fingerprint,
    ...(candidate.read_prerequisite ? { read_prerequisite: structuredClone(candidate.read_prerequisite) } : {}),
    pack: candidate.pack,
    budgets: candidate.budgets,
    activation: {
      state: "active",
      digest,
      actor,
      activated_at: new Date().toISOString(),
      generation_lock_fingerprint: input.candidate.generation_lock_fingerprint,
      reviewed_decisions: reviewedDecisions.map((decision) => ({ decision, confirmed: true as const })),
      ...(input.activationAudit ?? {}),
    },
  };
  const discoveryConcerns = readDiscoveryCompatibility(active, digest);
  if (discoveryConcerns.length) throw new Error(readDiscoveryConcernLines(discoveryConcerns).join("\n"));
  const stateDir = path.join(projectRoot, ".synapsor");
  await fs.mkdir(stateDir, { recursive: true, mode: 0o700 });
  await persistGenerationLockSnapshot(projectRoot, candidate.generation_lock_fingerprint, lock);
  const auditKeyPath = path.join(stateDir, "explore-audit.key");
  try {
    await fs.writeFile(auditKeyPath, crypto.randomBytes(32).toString("base64url"), { encoding: "utf8", mode: 0o600, flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  await writeActivatedExplorationBoundarySet(
    projectRoot,
    active,
    input.activeSetMode ?? "replace",
    lock,
    { expected: input.expectedAuthoring, candidate: input.candidate, verifiedDecision: input.verifiedDecision },
  );
  return active;
}

export function assertCurrentExplorationBoundaryAuthority(input: {
  lock: GenerationLock;
  inspection: SchemaInspection;
  candidate: ExplorationBoundaryDraft;
}): void {
  const compatibility = assertSupportedDatabaseServerVersion(input.inspection);
  if (!input.lock.database_server_version
    || !input.lock.database_server_tier
    || !input.lock.database_server_authority) {
    throw new Error([
      "Generation lock is stale: database server capability authority is not recorded.",
      generationLockRemediation(input.lock),
    ].join("\n"));
  }
  if (input.candidate.database_server_version !== input.lock.database_server_version
    || input.candidate.database_server_tier !== input.lock.database_server_tier
    || canonicalJsonDigest(input.candidate.database_server_authority ?? null)
      !== canonicalJsonDigest(input.lock.database_server_authority)) {
    throw new Error(
      "The reviewed boundary and generation lock disagree on database server capability authority.",
    );
  }
  const comparison = compareGenerationLock(input.lock, input.inspection);
  if (!comparison.current) {
    throw new Error([
      `Generation lock is stale: ${comparison.changes.join("; ")}.`,
      generationLockRemediation(input.lock),
    ].join("\n"));
  }
  if (input.candidate.pack.resources.some((resource) => resource.auto_bands?.length)) {
    assertDatabaseGrammarFeature(
      compatibility.authority ?? input.inspection,
      "automatic_numeric_bands",
    );
  }
  if (input.candidate.read_prerequisite) {
    assertReviewedReadCurrentStatePrerequisite(input.candidate.read_prerequisite, input.inspection);
  }
  assertExploreRolePosture(input.inspection, input.candidate);
  if (input.candidate.organization_scope) {
    assertSingleOrganizationInspectionSafe(input.inspection);
  }
}

export function explorationBoundaryCandidateDigest(candidate: ExplorationBoundaryDraft): `sha256:${string}` {
  return canonicalJsonDigest(boundaryAuthority(normalizeDependentAggregateAuthority(candidate)));
}

/** Storage validation, not a new review or an assertion of current source freshness. */
export function assertStoredExplorationPolicy(
  boundary: ExplorationBoundaryDraft | ActivatedExplorationBoundary,
  lock: GenerationLock,
): void {
  assertGenerationLockFingerprint(lock, boundary.generation_lock_fingerprint);
  if (boundary.activation === "disabled_unreviewed") {
    const reviewed = reviewExplorationBoundaryCandidate(boundary, boundary);
    // A transfer must not silently repair or minimize saved authority.
    const { unresolved_decisions: _before, ...before } = boundary;
    const { unresolved_decisions: _after, ...after } = reviewed.candidate;
    if (canonicalJsonDigest(before) !== canonicalJsonDigest(after)) {
      throw new Error("Stored Read policy requires normalization; review it before transferring authority.");
    }
  } else {
    validateActivatedExplorationBoundary(boundary as ActivatedExplorationBoundary);
  }
}

/** Non-authorizing metadata scaffold only. Empty scaffolds must never become Read pointers. */
export function assertStoredExplorationMetadata(
  boundary: ExplorationBoundaryDraft,
  lock: GenerationLock,
): void {
  if (boundary.schema_version !== EXPLORATION_BOUNDARY_VERSION
    || boundary.activation !== "disabled_unreviewed"
    || !Array.isArray(boundary.pack.resources) || boundary.pack.resources.length !== 0) {
    throw new Error("Metadata-only authoring requires an empty disabled scaffold, not Read authority.");
  }
  assertGenerationLockFingerprint(lock, boundary.generation_lock_fingerprint);
  assertBoundaryCandidateMetadata(boundary, boundary);
}

export function reviewExplorationBoundaryCandidate(
  draft: ExplorationBoundaryDraft,
  candidate: ExplorationBoundaryDraft,
): { digest: `sha256:${string}`; candidate: ExplorationBoundaryDraft } {
  const coherentCandidate = normalizeDependentAggregateAuthority(candidate);
  assertBoundaryCandidateNarrowsDraft(draft, coherentCandidate);
  const normalized = {
    ...coherentCandidate,
    unresolved_decisions: requiredReviewDecisionsForCandidate(draft, coherentCandidate),
  };
  return { digest: explorationBoundaryCandidateDigest(normalized), candidate: normalized };
}

function normalizeDependentAggregateAuthority(
  candidate: ExplorationBoundaryDraft,
): ExplorationBoundaryDraft {
  const normalized = structuredClone(candidate);
  const relationshipDepth = reviewedAnalysisRelationshipHopLimit(normalized.budgets);
  for (const resource of normalized.pack.resources) {
    resource.relationships = resource.relationships.filter(
      (relationship) => (relationship.path_depth ?? 1) <= relationshipDepth,
    );
  }
  for (const resource of normalized.pack.resources) {
    if (resource.aggregate_measure_functions) {
      const aggregateFields = new Set(resource.aggregate_measures);
      resource.aggregate_measure_functions = Object.fromEntries(
        Object.entries(resource.aggregate_measure_functions)
          .filter(([field]) => aggregateFields.has(field)),
      );
    }
    if (resource.presence_measure_fields) {
      const selectable = new Set(resource.selectable_fields);
      const unavailable = new Set([
        ...resource.kept_out_fields,
        ...(resource.model_withheld_fields ?? []),
        ...(resource.tenant_key ? [resource.tenant_key] : []),
        ...(resource.principal_key ? [resource.principal_key] : []),
      ]);
      resource.presence_measure_fields = resource.presence_measure_fields.filter(
        (field) => selectable.has(field) && !unavailable.has(field),
      );
    }
  }
  for (const resource of normalized.pack.resources) {
    if (resource.derived_measures) {
      resource.derived_measures = resource.derived_measures.filter((definition) => {
        try {
          assertReviewedDerivedMeasureForBoundary(normalized, resource.id, definition);
          return true;
        } catch {
          return false;
        }
      });
      if (!resource.derived_measures.length) delete resource.derived_measures;
    }
    if (resource.numeric_bands) {
      resource.numeric_bands = resource.numeric_bands.filter((definition) => {
        try {
          assertReviewedNumericBandForBoundary(normalized, resource.id, definition);
          return true;
        } catch {
          return false;
        }
      });
      if (!resource.numeric_bands.length) delete resource.numeric_bands;
    }
    if (resource.auto_bands) {
      resource.auto_bands = resource.auto_bands.filter((definition) => {
        try {
          assertReviewedAutoBandForBoundary(normalized, resource.id, definition);
          return true;
        } catch {
          return false;
        }
      });
      if (!resource.auto_bands.length) delete resource.auto_bands;
    }
  }
  return normalized;
}

type StoredReadPolicySet = {
  epoch: number; boundaries: ActivatedExplorationBoundary[]; selected_name: string | null;
  locks: Map<string, GenerationLock>; records: ControlPolicyRevision[]; drafts: ControlPolicyRevision[];
};

async function withStoredReadPolicies<T>(projectRoot: string, supplied: BoundProjectPolicyStore | undefined,
  operation: (binding: BoundProjectPolicyStore, state: StoredReadPolicySet) => Promise<T>): Promise<T | undefined> {
  const binding = supplied ?? await openBoundProjectControlPolicies(projectRoot);
  if (!binding) return undefined;
  try {
    if (supplied) await assertProjectControlPolicyBinding(projectRoot, supplied);
    const snapshot = await binding.repository.scopeSnapshot({ deployment_id: binding.deployment_id,
      scope: { level: "operator" }, kinds: ["read", "management"] });
    const boundaries: ActivatedExplorationBoundary[] = [];
    const locks = new Map<string, GenerationLock>();
    let selected: string | null | undefined;
    for (const revision of snapshot.active) {
      if (revision.kind === "management" && revision.name !== OPERATOR_READ_SELECTION_KEY.name) continue;
      const content = revision.content as Record<string, unknown>;
      if (!content || typeof content !== "object" || content.schema_version !== OPERATOR_POLICY_RECORD_VERSION) throw invalidStoredRead();
      if (revision.kind === "read") {
        if (content.type !== "read" || Object.keys(content).sort().join(",") !== "boundary,generation_lock,schema_version,type") throw invalidStoredRead();
        const boundary = content.boundary as ActivatedExplorationBoundary;
        const lock = content.generation_lock as GenerationLock;
        validateActivatedExplorationBoundary(boundary);
        assertStoredExplorationPolicy(boundary, lock);
        assertOperatorPolicyRecord(revision, storedReadKey(boundary.pack.name), boundary.activation.digest);
        boundaries.push(boundary); locks.set(boundary.pack.name, lock);
      } else {
        if (content.type !== "read_selection" || Object.keys(content).sort().join(",") !== "schema_version,selected_name,type"
          || (content.selected_name !== null && typeof content.selected_name !== "string")) throw invalidStoredRead();
        selected = content.selected_name;
        assertOperatorPolicyRecord(revision, OPERATOR_READ_SELECTION_KEY, storedReadSelection(selected).authority_digest);
      }
    }
    if (selected === undefined || (boundaries.length ? !boundaries.some((boundary) => boundary.pack.name === selected) : selected !== null)) throw invalidStoredRead();
    if (boundaries.length) assertActiveReadSetBindings(boundaries);
    return await operation(binding, { epoch: snapshot.epoch, boundaries, selected_name: selected, locks, records: snapshot.active, drafts: snapshot.drafts });
  } finally { if (!supplied) await binding.close(); }
}

function storedReadKey(name: string) { return { scope: { level: "operator" as const }, kind: "read" as const, name }; }
function storedReadSelection(selected: string | null): ControlPolicyRevision {
  const policy = { type: "read_selection", selected_name: selected };
  return storedOperatorPolicyRecord(OPERATOR_READ_SELECTION_KEY, canonicalJsonDigest(policy), { schema_version: OPERATOR_POLICY_RECORD_VERSION, ...policy });
}
function storedPointer(revision: ControlPolicyRevision): ControlPolicyPointer {
  return { scope: revision.scope, kind: revision.kind, name: revision.name, revision_id: revision.revision_id };
}
function invalidStoredRead(): Error {
  return Object.assign(new Error("Stored Read authority is invalid. Restore the reviewed repository; file exports cannot replace it."), { code: "POLICY_READ_AUTHORITY_INVALID" });
}

async function commitStoredReadPolicies(binding: BoundProjectPolicyStore, current: StoredReadPolicySet,
  incoming: ControlPolicyRevision[], active: ControlPolicyPointer[], actor: string, operation: string,
  verifiedDecision?: GovernedReadActivationDecision): Promise<void> {
  const changes = active.map((pointer) => ({ name: pointer.name, kind: pointer.kind,
    before: current.records.find((record) => record.name === pointer.name && record.kind === pointer.kind)?.revision_id ?? null,
    after: pointer.revision_id }));
  const event = { event_id: verifiedDecision?.event_id ?? crypto.randomUUID(), actor, occurred_at: new Date().toISOString(),
    receipt: { operation, changes, source_database_changed: false, ...(verifiedDecision ? { verified_decision: verifiedDecision } : {}) } };
  try {
    await commitImmutableControlPolicies(binding, { expected_epoch: current.epoch, revisions: incoming, active, event });
  } catch (error) {
    if (!verifiedDecision || (error as { code?: string }).code === "POLICY_EVENT_ALREADY_RECORDED") throw error;
    // A response can be lost after COMMIT. Only this exact transaction receipt
    // proves success; finding the same active digest is insufficient.
    let recorded;
    try { recorded = await binding.repository.event(binding.deployment_id, event.event_id); }
    catch {
      throw Object.assign(new Error("Read activation could not be confirmed. Inspect the control-store review receipt before retrying; do not assume authority is unchanged."),
        { code: "POLICY_ACTIVATION_COMMIT_UNCONFIRMED" });
    }
    if (recorded && canonicalJsonDigest(recorded) === canonicalJsonDigest({ ...event, epoch: current.epoch + 1 })) return;
    throw error;
  }
}

export async function loadActivatedExplorationBoundary(
  projectRoot: string,
  selector?: { name?: string; digest?: `sha256:${string}`; policyStore?: BoundProjectPolicyStore },
): Promise<ActivatedExplorationBoundary> {
  const stored = await withStoredReadPolicies(projectRoot, selector?.policyStore, async (_binding, current) => current);
  if (stored) {
    const selected = stored.boundaries.find((boundary) => selector?.name || selector?.digest
      ? (!selector.name || selector.name === boundary.pack.name) && (!selector.digest || selector.digest === boundary.activation.digest)
      : boundary.pack.name === stored.selected_name);
    if (!selected) throw Object.assign(new Error("Requested exploration boundary is not active."), { code: "ENOENT" });
    return selected;
  }
  if (selector?.name || selector?.digest) {
    const boundaries = await loadActivatedExplorationBoundaries(projectRoot);
    const selected = boundaries.find((boundary) =>
      (!selector.name || boundary.pack.name === selector.name)
      && (!selector.digest || boundary.activation.digest === selector.digest));
    if (!selected) {
      throw Object.assign(new Error("Requested exploration boundary is not active."), { code: "ENOENT" });
    }
    return selected;
  }
  const root = path.resolve(projectRoot);
  try {
    const set = await readActivatedExplorationBoundarySet(root);
    const selected = set.boundaries.find((boundary) => boundary.pack.name === set.selected_name);
    if (!selected) throw new Error("Active exploration-boundary registry does not contain its selected boundary.");
    return selected;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return readLegacyActivatedExplorationBoundary(root);
}

export async function loadActivatedExplorationBoundaries(
  projectRoot: string,
  policyStore?: BoundProjectPolicyStore,
): Promise<ActivatedExplorationBoundary[]> {
  const stored = await withStoredReadPolicies(projectRoot, policyStore, async (_binding, current) => current);
  if (stored) {
    if (!stored.boundaries.length) throw Object.assign(new Error("No exploration boundary is active."), { code: "ENOENT" });
    // Boundary-set callers use the final entry as the selected default.
    return [...stored.boundaries.filter((boundary) => boundary.pack.name !== stored.selected_name),
      stored.boundaries.find((boundary) => boundary.pack.name === stored.selected_name)!];
  }
  const root = path.resolve(projectRoot);
  try {
    return (await readActivatedExplorationBoundarySet(root)).boundaries;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return [await readLegacyActivatedExplorationBoundary(root)];
}

export function activatedExplorationBoundarySetDigest(
  boundaries: ActivatedExplorationBoundary[],
): `sha256:${string}` {
  if (boundaries.length < 1 || boundaries.length > MAX_ACTIVE_EXPLORATION_BOUNDARIES) {
    throw new Error(`Active Scoped Explore requires 1-${MAX_ACTIVE_EXPLORATION_BOUNDARIES} reviewed boundaries.`);
  }
  return canonicalJsonDigest({
    schema_version: ACTIVE_EXPLORATION_BOUNDARY_SET_VERSION,
    boundaries: boundaries
      .map((boundary) => ({ name: boundary.pack.name, digest: boundary.activation.digest }))
      .sort((left, right) => left.name.localeCompare(right.name)),
  });
}

export async function deactivateExplorationBoundary(
  projectRootInput: string,
  name?: string,
): Promise<{ disabled: string[]; remaining: ActivatedExplorationBoundary[] }> {
  const projectRoot = path.resolve(projectRootInput);
  return withActiveExplorationBoundaryLock(projectRoot, async (heldRoot) =>
    deactivateExplorationBoundaryUnlocked(heldRoot, name));
}

async function deactivateExplorationBoundaryUnlocked(
  projectRoot: string,
  name?: string,
): Promise<{ disabled: string[]; remaining: ActivatedExplorationBoundary[] }> {
  const stored = await withStoredReadPolicies(projectRoot, undefined, async (binding, current) => {
    const disabled = current.boundaries.filter((boundary) => !name || boundary.pack.name === name);
    if (name && !disabled.length) throw new Error(`Boundary ${name} is not active.`);
    if (!disabled.length) return { disabled: [], remaining: [] };
    const remaining = current.boundaries.filter((boundary) => name && boundary.pack.name !== name);
    const selected = remaining.at(-1)?.pack.name ?? null;
    const selection = storedReadSelection(selected);
    await commitStoredReadPolicies(binding, current, [selection], [
      ...disabled.map((boundary) => ({ ...storedReadKey(boundary.pack.name), revision_id: null })),
      storedPointer(selection),
    ], "local_operator", "deactivate_read");
    return { disabled: disabled.map((boundary) => boundary.pack.name), remaining };
  });
  if (stored) return stored;
  let active: ActivatedExplorationBoundary[];
  try {
    active = await loadActivatedExplorationBoundaries(projectRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { disabled: [], remaining: [] };
    throw error;
  }
  const disabled = name
    ? active.filter((boundary) => boundary.pack.name === name)
    : active;
  if (name && disabled.length === 0) throw new Error(`Boundary ${name} is not active.`);
  const remaining = name
    ? active.filter((boundary) => boundary.pack.name !== name)
    : [];
  const legacyPath = path.join(projectRoot, ".synapsor/exploration-boundary.active.json");
  const legacySnapshot = await captureOptionalPrivateFile(legacyPath);
  if (remaining.length === 0) {
    await fs.rm(legacyPath, { force: true });
    try {
      await fs.rm(
        path.join(projectRoot, ".synapsor", ACTIVE_EXPLORATION_BOUNDARY_SET_FILE),
        { force: true },
      );
    } catch (error) {
      await restoreOptionalPrivateFile(legacyPath, legacySnapshot);
      throw error;
    }
  } else {
    const selected = remaining.at(-1)!;
    const set: ActiveExplorationBoundarySet = {
      schema_version: ACTIVE_EXPLORATION_BOUNDARY_SET_VERSION,
      selected_name: selected.pack.name,
      boundaries: remaining,
      updated_at: new Date().toISOString(),
    };
    await writePrivateJsonAtomic(legacyPath, selected);
    try {
      await persistActivatedExplorationBoundarySet(projectRoot, set);
    } catch (error) {
      await restoreOptionalPrivateFile(legacyPath, legacySnapshot);
      throw error;
    }
  }
  return { disabled: disabled.map((boundary) => boundary.pack.name), remaining };
}

async function readLegacyActivatedExplorationBoundary(
  projectRoot: string,
): Promise<ActivatedExplorationBoundary> {
  const resolved = path.join(projectRoot, ".synapsor/exploration-boundary.active.json");
  const active = JSON.parse(await fs.readFile(resolved, "utf8")) as ActivatedExplorationBoundary;
  return validateActivatedExplorationBoundary(active);
}

function validateActivatedExplorationBoundary(
  active: ActivatedExplorationBoundary,
): ActivatedExplorationBoundary {
  if (active.activation?.state !== "active") {
    throw Object.assign(new Error("Exploration boundary is not active."), { code: "EXPLORATION_BOUNDARY_INACTIVE" as const });
  }
  if (!/^[a-z][a-z0-9_.-]{0,63}$/.test(active.pack?.name ?? "")) {
    throw new Error("Activated exploration boundary has an invalid name.");
  }
  if (active.reporting_timezone !== undefined && active.reporting_timezone !== "UTC") {
    throw new Error("Activated exploration boundary has an unsupported reporting timezone.");
  }
  if (active.organization_scope) {
    const normalized = singleOrganizationScope(active.organization_scope.organization_id);
    if (canonicalJsonDigest(normalized) !== canonicalJsonDigest(active.organization_scope)) {
      throw new Error("Activated exploration boundary has an invalid single-organization scope declaration.");
    }
  }
  if (active.read_prerequisite) assertReadCurrentStatePrerequisiteShape(active.read_prerequisite);
  const resources = new Map(active.pack.resources.map((resource) => [resource.id, resource]));
  for (const resource of active.pack.resources) {
    assertReviewedResourceScope(
      resource,
      resources,
      Boolean(active.organization_scope),
      reviewedDerivedScopeHopLimit(active.budgets),
    );
  }
  const {
    activation: _activation,
    unresolved_decisions: _unresolved,
    ...activeAuthority
  } = active as ActivatedExplorationBoundary & { unresolved_decisions?: unknown };
  const authority = { ...activeAuthority, activation: "reviewed" };
  if (canonicalJsonDigest(authority) !== active.activation.digest) {
    throw new Error("Activated exploration boundary digest does not match its authority.");
  }
  return active;
}

async function readActivatedExplorationBoundarySet(
  projectRoot: string,
): Promise<ActiveExplorationBoundarySet> {
  const raw = JSON.parse(await fs.readFile(
    path.join(projectRoot, ".synapsor", ACTIVE_EXPLORATION_BOUNDARY_SET_FILE),
    "utf8",
  )) as ActiveExplorationBoundarySet;
  if (raw.schema_version !== ACTIVE_EXPLORATION_BOUNDARY_SET_VERSION
    || typeof raw.selected_name !== "string"
    || !Array.isArray(raw.boundaries)
    || raw.boundaries.length < 1
    || raw.boundaries.length > MAX_ACTIVE_EXPLORATION_BOUNDARIES
    || typeof raw.updated_at !== "string") {
    throw new Error("Active exploration-boundary registry is invalid.");
  }
  const boundaries = raw.boundaries.map(validateActivatedExplorationBoundary);
  const names = new Set<string>();
  for (const boundary of boundaries) {
    if (names.has(boundary.pack.name)) throw new Error("Active exploration-boundary names must be unique.");
    names.add(boundary.pack.name);
  }
  if (!names.has(raw.selected_name)) {
    throw new Error("Active exploration-boundary registry does not contain its selected boundary.");
  }
  activatedExplorationBoundarySetDigest(boundaries);
  return { ...raw, boundaries };
}

async function writeActivatedExplorationBoundarySet(
  projectRoot: string,
  active: ActivatedExplorationBoundary,
  mode: "replace" | "add",
  lock: GenerationLock,
  review: { expected?: ReadAuthoringBindings; candidate: ExplorationBoundaryDraft; verifiedDecision?: GovernedReadActivationDecision },
): Promise<void> {
  await withActiveExplorationBoundaryLock(projectRoot, async (heldRoot) => {
    await writeActivatedExplorationBoundarySetUnlocked(heldRoot, active, mode, lock, review);
  });
}

async function writeActivatedExplorationBoundarySetUnlocked(
  projectRoot: string,
  active: ActivatedExplorationBoundary,
  mode: "replace" | "add",
  lock: GenerationLock,
  review: { expected?: ReadAuthoringBindings; candidate: ExplorationBoundaryDraft; verifiedDecision?: GovernedReadActivationDecision },
): Promise<void> {
  const stored = await withStoredReadPolicies(projectRoot, undefined, async (binding, current) => {
    assertStoredReadActivationReview(binding, current, review, lock);
    if (review.verifiedDecision) assertGovernedReadActivationDecision(review.verifiedDecision, binding, active.activation.actor, active.activation.digest);
    const boundaries = [...(mode === "add" ? current.boundaries.filter((boundary) => boundary.pack.name !== active.pack.name) : []), active];
    assertActiveReadSetBindings(boundaries);
    await assertRuntimeReadDiscoveryFits(projectRoot, boundaries);
    assertStoredExplorationPolicy(active, lock);
    const revision = storedOperatorPolicyRecord(storedReadKey(active.pack.name), active.activation.digest,
      { schema_version: OPERATOR_POLICY_RECORD_VERSION, type: "read", boundary: active, generation_lock: lock });
    const selection = storedReadSelection(active.pack.name);
    await commitStoredReadPolicies(binding, current, [revision, selection], [
      ...current.boundaries.filter((boundary) => !boundaries.some((next) => next.pack.name === boundary.pack.name))
        .map((boundary) => ({ ...storedReadKey(boundary.pack.name), revision_id: null })),
      storedPointer(revision), storedPointer(selection),
    ], active.activation.actor, "activate_read", review.verifiedDecision);
    return true;
  });
  if (stored) return;
  if (review.expected || review.verifiedDecision) throw invalidStoredReadReview();
  let boundaries: ActivatedExplorationBoundary[] = [];
  if (mode === "add") {
    try {
      boundaries = await loadActivatedExplorationBoundaries(projectRoot);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  boundaries = [
    ...boundaries.filter((boundary) => boundary.pack.name !== active.pack.name),
    active,
  ];
  assertActiveReadSetBindings(boundaries);
  await assertRuntimeReadDiscoveryFits(projectRoot, boundaries);
  const set: ActiveExplorationBoundarySet = {
    schema_version: ACTIVE_EXPLORATION_BOUNDARY_SET_VERSION,
    selected_name: active.pack.name,
    boundaries,
    updated_at: new Date().toISOString(),
  };
  activatedExplorationBoundarySetDigest(boundaries);
  const legacyPath = path.join(projectRoot, ".synapsor/exploration-boundary.active.json");
  const legacySnapshot = await captureOptionalPrivateFile(legacyPath);
  await writePrivateJsonAtomic(legacyPath, active);
  try {
    await persistActivatedExplorationBoundarySet(projectRoot, set);
  } catch (error) {
    await restoreOptionalPrivateFile(legacyPath, legacySnapshot);
    throw error;
  }
}

function invalidStoredReadReview(): Error {
  return Object.assign(new Error("The saved Read review changed or no longer matches this activation. Reopen and confirm its current revision."),
    { code: "POLICY_AUTHORING_REVIEW_CHANGED" });
}

function assertStoredReadActivationReview(binding: BoundProjectPolicyStore, current: StoredReadPolicySet,
  review: { expected?: ReadAuthoringBindings; candidate: ExplorationBoundaryDraft }, lock: GenerationLock): void {
  const record = current.records.find((item) => item.kind === OPERATOR_READ_AUTHORING_KEY.kind && item.name === OPERATOR_READ_AUTHORING_KEY.name);
  // Older internal imports can have active authority without prepared authoring.
  // Once authoring exists, every activation must carry its original review token.
  if (!record) { if (review.expected) throw invalidStoredReadReview(); return; }
  assertReadAuthoringBindings(review.expected, { repository_id: binding.repository_id, deployment_id: binding.deployment_id,
    project_id: binding.project_id, epoch: current.epoch, revision_id: record.revision_id });
  const content = record.content;
  if (!isRecord(content) || content.schema_version !== OPERATOR_POLICY_RECORD_VERSION || content.type !== "read_authoring"
    || !Array.isArray(content.entries)) throw invalidStoredReadReview();
  const { schema_version: _version, ...policy } = content;
  assertOperatorPolicyRecord(record, OPERATOR_READ_AUTHORING_KEY, canonicalJsonDigest(policy));
  const selected = content.entries.filter((entry) => isRecord(entry) && isRecord(entry.progress)
    && entry.progress.boundary_id === content.selected_boundary_id);
  const entry = selected[0];
  if (selected.length !== 1 || !isRecord(entry) || !isRecord(entry.progress)
    || canonicalJsonDigest(entry.progress.candidate ?? null) !== canonicalJsonDigest(review.candidate)
    || canonicalJsonDigest(entry.candidate_lock ?? null) !== canonicalJsonDigest(lock)) throw invalidStoredReadReview();
  const draft = current.drafts.find((item) => item.kind === "read" && item.name === review.candidate.pack.name);
  const expected = storedOperatorPolicyRecord(storedReadKey(review.candidate.pack.name), explorationBoundaryCandidateDigest(review.candidate),
    { schema_version: OPERATOR_POLICY_RECORD_VERSION, type: "read", boundary: review.candidate, generation_lock: lock });
  if (!draft || canonicalJsonDigest(draft) !== canonicalJsonDigest(expected)) throw invalidStoredReadReview();
}

function assertActiveReadSetBindings(boundaries: ActivatedExplorationBoundary[]): void {
  if (boundaries.length > MAX_ACTIVE_EXPLORATION_BOUNDARIES) {
    throw new Error(`Scoped Explore supports at most ${MAX_ACTIVE_EXPLORATION_BOUNDARIES} simultaneously active reviewed boundaries.`);
  }
  const sources = new Set(boundaries.map((boundary) => boundary.source));
  const profiles = new Set(boundaries.map((boundary) => boundary.deployment_profile));
  if (sources.size !== 1 || profiles.size !== 1) {
    throw new Error("Active Explore boundaries must use the same reviewed source and deployment profile.");
  }
  const trustedContexts = new Set(boundaries.map((boundary) =>
    canonicalJsonDigest(boundary.trusted_context)));
  if (trustedContexts.size !== 1) {
    throw new Error("Active Explore boundaries must use the same reviewed trusted-context bindings.");
  }
  const organizationScopes = new Set(boundaries.map((boundary) =>
    canonicalJsonDigest(boundary.organization_scope ?? null)));
  if (organizationScopes.size !== 1) {
    throw new Error("Active Explore boundaries must use the same reviewed organization-scope posture.");
  }
}

async function persistActivatedExplorationBoundarySet(
  projectRoot: string,
  value: ActiveExplorationBoundarySet,
): Promise<void> {
  await writePrivateJsonAtomic(
    path.join(projectRoot, ".synapsor", ACTIVE_EXPLORATION_BOUNDARY_SET_FILE),
    value,
  );
}

async function writePrivateJsonAtomic(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${process.pid}.${cryptoRandomSuffix()}.tmp`;
  try {
    await fs.writeFile(temporary, json(value), { encoding: "utf8", mode: 0o600, flag: "wx" });
    await fs.rename(temporary, filePath);
    await fs.chmod(filePath, 0o600);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

type OptionalPrivateFileSnapshot =
  | { exists: false }
  | { exists: true; contents: string };

async function captureOptionalPrivateFile(filePath: string): Promise<OptionalPrivateFileSnapshot> {
  try {
    return { exists: true, contents: await fs.readFile(filePath, "utf8") };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { exists: false };
    throw error;
  }
}

async function restoreOptionalPrivateFile(
  filePath: string,
  snapshot: OptionalPrivateFileSnapshot,
): Promise<void> {
  if (!snapshot.exists) {
    await fs.rm(filePath, { force: true });
    return;
  }
  await writePrivateTextAtomic(filePath, snapshot.contents);
}

async function writePrivateTextAtomic(filePath: string, contents: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${process.pid}.${cryptoRandomSuffix()}.tmp`;
  try {
    await fs.writeFile(temporary, contents, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await fs.rename(temporary, filePath);
    await fs.chmod(filePath, 0o600);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function withActiveExplorationBoundaryLock<T>(
  projectRoot: string,
  operation: (heldRoot: string) => Promise<T>,
): Promise<T> {
  return withProjectAuthorityMutation(projectRoot, (held) => operation(held.projectRoot));
}

export async function loadGenerationLockForActivatedBoundary(
  projectRootInput: string,
  boundary: ActivatedExplorationBoundary,
  policyStore?: BoundProjectPolicyStore,
): Promise<GenerationLock> {
  const projectRoot = path.resolve(projectRootInput);
  const stored = await withStoredReadPolicies(projectRoot, policyStore, async (_binding, current) => {
    const active = current.boundaries.find((entry) => entry.pack.name === boundary.pack.name && entry.activation.digest === boundary.activation.digest);
    const lock = active && current.locks.get(active.pack.name);
    if (!lock) throw Object.assign(new Error("The requested Read revision is no longer active in the control store."), { code: "POLICY_READ_AUTHORITY_STALE" });
    return lock;
  });
  if (stored) return stored;
  const snapshotPath = generationLockSnapshotPath(
    projectRoot,
    boundary.generation_lock_fingerprint,
  );
  try {
    const snapshot = JSON.parse(await fs.readFile(snapshotPath, "utf8")) as GenerationLock;
    assertGenerationLockFingerprint(snapshot, boundary.generation_lock_fingerprint);
    return snapshot;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const current = JSON.parse(
    await fs.readFile(path.join(projectRoot, ".synapsor/generation-lock.json"), "utf8"),
  ) as GenerationLock;
  assertGenerationLockFingerprint(current, boundary.generation_lock_fingerprint);
  await persistGenerationLockSnapshot(
    projectRoot,
    boundary.generation_lock_fingerprint,
    current,
  );
  return current;
}

export async function loadGenerationLockSnapshot(
  projectRootInput: string,
  fingerprint: `sha256:${string}`,
): Promise<GenerationLock> {
  const projectRoot = path.resolve(projectRootInput);
  const snapshotPath = generationLockSnapshotPath(projectRoot, fingerprint);
  const stored = await withStoredReadPolicies(projectRoot, undefined, async (binding, current) => {
    for (const lock of current.locks.values()) {
      if (canonicalJsonDigest(lock) === fingerprint) return lock;
    }
    const currentAuthoring = current.records.find((record) => record.kind === OPERATOR_READ_AUTHORING_KEY.kind
      && record.name === OPERATOR_READ_AUTHORING_KEY.name);
    const currentLock = currentAuthoring && generationLockInAuthoringRecord(currentAuthoring, fingerprint);
    if (currentLock) return currentLock;
    // A minimized draft can replace its original evidence before Actions are
    // rebound. Read immutable, deployment-scoped history in bounded pages; it
    // supplies metadata only, never an active permission or a new pointer.
    let before = { epoch: current.epoch + 1, revision_id: currentAuthoring?.revision_id ?? "history" };
    for (;;) {
      const page = await binding.repository.history({ deployment_id: binding.deployment_id,
        key: OPERATOR_READ_AUTHORING_KEY, before, limit: 16 });
      for (const { revision } of page) {
        if (revision.revision_id === currentAuthoring?.revision_id) continue;
        const lock = generationLockInAuthoringRecord(revision, fingerprint);
        if (lock) return lock;
      }
      if (page.length < 16) break;
      const last = page.at(-1)!;
      before = { epoch: last.epoch, revision_id: last.revision.revision_id };
    }
    throw Object.assign(new Error("The exact saved schema snapshot is unavailable in this project's reviewed history. Resume this saved job with --rescan and revalidate it against the current database. Existing drafts and active authority are unchanged; legacy exports cannot replace the missing evidence."),
      { code: "POLICY_GENERATION_SNAPSHOT_UNAVAILABLE" });
  });
  if (stored) return stored;
  const snapshot = JSON.parse(
    await fs.readFile(snapshotPath, "utf8"),
  ) as GenerationLock;
  assertGenerationLockFingerprint(snapshot, fingerprint);
  return snapshot;
}

function generationLockInAuthoringRecord(record: ControlPolicyRevision, fingerprint: `sha256:${string}`): GenerationLock | undefined {
  const content = record.content;
  if (!isRecord(content) || content.schema_version !== OPERATOR_POLICY_RECORD_VERSION || content.type !== "read_authoring"
    || !Array.isArray(content.entries)) throw invalidStoredRead();
  const { schema_version: _version, ...policy } = content;
  assertOperatorPolicyRecord(record, OPERATOR_READ_AUTHORING_KEY, canonicalJsonDigest(policy));
  for (const entry of content.entries) {
    if (!isRecord(entry) || !isRecord(entry.progress)) throw invalidStoredRead();
    for (const [rawBoundary, rawLock] of [[entry.draft, entry.draft_lock], [entry.progress.candidate, entry.candidate_lock]]) {
      if (!isRecord(rawBoundary) || !isRecord(rawLock)) throw invalidStoredRead();
      const boundary = rawBoundary as unknown as ExplorationBoundaryDraft;
      const lock = rawLock as unknown as GenerationLock;
      if (boundary.activation !== "disabled_unreviewed" || lock.schema_version !== GENERATION_LOCK_VERSION) throw invalidStoredRead();
      if (boundary.pack.resources.length === 0) assertStoredExplorationMetadata(boundary, lock);
      else assertStoredExplorationPolicy(boundary, lock);
      if (canonicalJsonDigest(lock) === fingerprint) return structuredClone(lock);
    }
  }
  return undefined;
}

export async function loadAutoBoundaryPolicyBaseline(
  projectRootInput: string,
): Promise<AutoBoundaryBuild["policy_baseline"]> {
  const projectRoot = path.resolve(projectRootInput);
  const value = JSON.parse(await fs.readFile(
    path.join(projectRoot, ".synapsor", AUTO_BOUNDARY_POLICY_BASELINE_FILE),
    "utf8",
  )) as unknown;
  return parseAutoBoundaryPolicyBaseline(value);
}

/** An operator catalog baseline may be empty; it is not activatable authority. */
export function parseAutoBoundaryPolicyBaseline(value: unknown): AutoBoundaryBuild["policy_baseline"] {
  if (!isRecord(value)
    || value.schema_version !== AUTO_BOUNDARY_POLICY_BASELINE_VERSION
    || !isRecord(value.boundary)
    || !isRecord(value.lock)
    || value.boundary.activation !== "disabled_unreviewed"
    || typeof value.boundary.generation_lock_fingerprint !== "string") {
    throw new Error("Saved policy-neutral Auto Boundary baseline is invalid; Rescan before creating another boundary.");
  }
  const baseline = value as unknown as AutoBoundaryBuild["policy_baseline"];
  assertGenerationLockFingerprint(
    baseline.lock,
    baseline.boundary.generation_lock_fingerprint,
  );
  if (baseline.lock.reviewed_overrides_digest
    !== canonicalJsonDigest(reviewOverrideAuthority(emptyReviewOverrides()))) {
    throw new Error("Saved Auto Boundary baseline contains human policy; Rescan before creating another boundary.");
  }
  return baseline;
}

export async function persistAutoBoundaryPolicyBaseline(
  projectRootInput: string,
  baseline: AutoBoundaryBuild["policy_baseline"],
  permit?: ProjectAuthorityMutationPermit,
): Promise<void> {
  const frozen = structuredClone(baseline);
  return withProjectAuthorityMutation(projectRootInput, (held) => persistAutoBoundaryPolicyBaselineUnlocked(held.projectRoot, frozen), { permit });
}

async function persistAutoBoundaryPolicyBaselineUnlocked(projectRootInput: string, baseline: AutoBoundaryBuild["policy_baseline"]): Promise<void> {
  const governed = await openBoundProjectControlPolicies(projectRootInput);
  if (governed) {
    await governed.close();
    throw new Error("The governed Read baseline requires an exact repository revision. No file-based replacement was saved.");
  }
  if (baseline.schema_version !== AUTO_BOUNDARY_POLICY_BASELINE_VERSION
    || baseline.boundary.activation !== "disabled_unreviewed") {
    throw new Error("Refusing to persist an invalid policy-neutral Auto Boundary baseline.");
  }
  assertGenerationLockFingerprint(
    baseline.lock,
    baseline.boundary.generation_lock_fingerprint,
  );
  if (baseline.lock.reviewed_overrides_digest
    !== canonicalJsonDigest(reviewOverrideAuthority(emptyReviewOverrides()))) {
    throw new Error("Refusing to persist human policy in the Auto Boundary baseline.");
  }
  const projectRoot = path.resolve(projectRootInput);
  await persistGenerationLockSnapshot(
    projectRoot,
    baseline.boundary.generation_lock_fingerprint,
    baseline.lock,
  );
  await writePrivateJsonAtomic(
    path.join(projectRoot, ".synapsor", AUTO_BOUNDARY_POLICY_BASELINE_FILE),
    baseline,
  );
}

export function generationLockSharedFactsDigest(
  lock: GenerationLock,
): `sha256:${string}` {
  return canonicalJsonDigest({
    schema_version: "synapsor.boundary-shared-generation-facts.v1",
    compiler_version: lock.compiler_version,
    spec_version: lock.spec_version,
    engine: lock.engine,
    source_env: lock.source_env,
    inspected_schema: lock.inspected_schema ?? null,
    schema_fingerprint: lock.schema_fingerprint,
    role_posture_fingerprint: lock.role_posture_fingerprint,
    reporting_timezone: lock.reporting_timezone ?? null,
    database_server_tier: lock.database_server_tier ?? null,
    database_server_authority: lock.database_server_authority ?? null,
    organization_scope: lock.organization_scope ?? null,
    trusted_context_fingerprint: lock.trusted_context_fingerprint ?? null,
  });
}

function generationLockSnapshotPath(
  projectRoot: string,
  fingerprint: `sha256:${string}`,
): string {
  const digest = fingerprint.slice("sha256:".length);
  if (!/^[a-f0-9]{64}$/.test(digest)) {
    throw new Error("Exploration generation-lock fingerprint is malformed.");
  }
  return path.join(projectRoot, ".synapsor", EXPLORATION_LOCK_SNAPSHOT_DIR, `${digest}.json`);
}

function assertGenerationLockFingerprint(
  lock: GenerationLock,
  expected: `sha256:${string}`,
): void {
  if (canonicalJsonDigest(lock) !== expected) {
    throw new Error("The active exploration boundary is not bound to its generation-lock snapshot.");
  }
}

export async function persistGenerationLockSnapshot(
  projectRoot: string,
  fingerprint: `sha256:${string}`,
  lock: GenerationLock,
): Promise<void> {
  assertGenerationLockFingerprint(lock, fingerprint);
  const target = generationLockSnapshotPath(projectRoot, fingerprint);
  try {
    const existing = JSON.parse(await fs.readFile(target, "utf8")) as GenerationLock;
    assertGenerationLockFingerprint(existing, fingerprint);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.${process.pid}.${cryptoRandomSuffix()}.tmp`;
  try {
    await fs.writeFile(temporary, json(lock), { encoding: "utf8", mode: 0o600, flag: "wx" });
    await fs.rename(temporary, target);
    await fs.chmod(target, 0o600);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

export { rolePostureFingerprint, schemaFingerprintForInspection };

export function emptyReviewOverrides(): AutoBoundaryReviewOverrides {
  return {
    schema_version: AUTO_BOUNDARY_OVERRIDES_VERSION,
    resources: {},
  };
}

export function seedConfiguredPrincipalBindingReview(input: {
  inspection: SchemaInspection;
  principalBinding: string | undefined;
  overrides?: AutoBoundaryReviewOverrides;
  actor?: string;
  decidedAt: string;
}): AutoBoundaryReviewOverrides {
  const overrides = structuredClone(normalizeAutoBoundaryReviewOverrides(input.overrides));
  const principalBinding = input.principalBinding?.trim();
  if (!principalBinding) return overrides;
  const actor = input.actor?.trim() || "runner-config";
  for (const table of input.inspection.tables) {
    const column = table.columns.find((candidate) =>
      candidate.name === principalBinding
      && candidate.nullable === false
      && candidate.suggestions.large_or_binary !== true);
    if (!column) continue;
    const resourceId = `${table.schema}.${table.name}`;
    const review = overrides.resources[resourceId] ?? {};
    if (review.principal_key !== undefined
      || review.principal_scope_path !== undefined
      || review.principal_rls_setting !== undefined) continue;
    review.principal_key = {
      value: column.name,
      actor,
      reason: `Runner config principal_binding explicitly names inspected non-null column ${column.name}; exact boundary activation is still required.`,
      decided_at: input.decidedAt,
    };
    overrides.resources[resourceId] = review;
  }
  return normalizeAutoBoundaryReviewOverrides(overrides);
}

export function normalizeAutoBoundaryReviewOverrides(input: unknown): AutoBoundaryReviewOverrides {
  if (input === undefined) return emptyReviewOverrides();
  if (!isRecord(input)) throw new Error("Auto Boundary review overrides must be a JSON object.");
  assertOnlyKeys(input, ["schema_version", "resources"], "Auto Boundary review overrides");
  if (input.schema_version !== AUTO_BOUNDARY_OVERRIDES_VERSION) {
    throw new Error(`Auto Boundary review overrides must use ${AUTO_BOUNDARY_OVERRIDES_VERSION}.`);
  }
  if (!isRecord(input.resources)) throw new Error("Auto Boundary review overrides resources must be an object.");

  const resources: AutoBoundaryReviewOverrides["resources"] = {};
  for (const resourceId of Object.keys(input.resources).sort()) {
    assertSafeMapKey(resourceId, "reviewed resource");
    const rawResource = input.resources[resourceId];
    if (!isRecord(rawResource)) throw new Error(`Review overrides for ${resourceId} must be an object.`);
    assertOnlyKeys(
      rawResource,
      [
        "row_identity",
        "tenant_key",
        "tenant_scope_path",
        "shared_reference_scope",
        "principal_key",
        "principal_scope_path",
        "principal_rls_setting",
        "minimum_cohort",
        "field_enums",
        "derived_measures",
        "numeric_bands",
        "auto_bands",
        "exact_numeric_grouping",
        "metadata",
        "field_metadata",
        "fields",
      ],
      `${resourceId} review overrides`,
    );
    const resource: AutoBoundaryReviewOverrides["resources"][string] = {};
    if (rawResource.metadata !== undefined) {
      resource.metadata = normalizeReviewedMetadataDecision(
        rawResource.metadata,
        `${resourceId} metadata`,
      );
    }
    if (rawResource.row_identity !== undefined) {
      resource.row_identity = normalizeReviewedValueDecision(rawResource.row_identity, `${resourceId} row identity`, false) as ReviewedValueDecision;
    }
    if (rawResource.tenant_key !== undefined) {
      resource.tenant_key = normalizeReviewedValueDecision(rawResource.tenant_key, `${resourceId} tenant key`, false) as ReviewedValueDecision;
    }
    if (rawResource.tenant_scope_path !== undefined) {
      resource.tenant_scope_path = normalizeReviewedValueDecision(
        rawResource.tenant_scope_path,
        `${resourceId} derived tenant scope path`,
        false,
      ) as ReviewedValueDecision;
    }
    if (rawResource.shared_reference_scope !== undefined) {
      resource.shared_reference_scope = normalizeReviewedValueDecision(
        rawResource.shared_reference_scope,
        `${resourceId} shared-reference scope`,
        false,
      ) as ReviewedValueDecision;
      if (resource.shared_reference_scope.value !== SHARED_REFERENCE_ACKNOWLEDGEMENT) {
        throw new Error(
          `${resourceId} shared-reference scope must acknowledge ${SHARED_REFERENCE_ACKNOWLEDGEMENT}.`,
        );
      }
    }
    if (rawResource.principal_key !== undefined) {
      resource.principal_key = normalizeReviewedValueDecision(rawResource.principal_key, `${resourceId} principal key`, true);
    }
    if (rawResource.principal_scope_path !== undefined) {
      resource.principal_scope_path = normalizeReviewedValueDecision(
        rawResource.principal_scope_path,
        `${resourceId} derived principal scope path`,
        true,
      );
    }
    if (rawResource.principal_rls_setting !== undefined) {
      resource.principal_rls_setting = normalizeReviewedValueDecision(
        rawResource.principal_rls_setting,
        `${resourceId} PostgreSQL RLS principal setting`,
        true,
      );
    }
    if (rawResource.minimum_cohort !== undefined) {
      resource.minimum_cohort = normalizeReviewedMinimumCohortDecision(
        rawResource.minimum_cohort,
        `${resourceId} minimum cohort`,
      );
    }
    if (rawResource.field_enums !== undefined) {
      if (!isRecord(rawResource.field_enums)) {
        throw new Error(`${resourceId} enum review overrides must be an object.`);
      }
      const fieldEnums: NonNullable<AutoBoundaryReviewOverrides["resources"][string]["field_enums"]> = {};
      for (const fieldName of Object.keys(rawResource.field_enums).sort()) {
        assertSafeMapKey(fieldName, "reviewed enum field");
        fieldEnums[fieldName] = normalizeReviewedEnumValuesDecision(
          rawResource.field_enums[fieldName],
          `${resourceId}.${fieldName} reviewed enum`,
        );
      }
      resource.field_enums = fieldEnums;
    }
    if (rawResource.derived_measures !== undefined) {
      if (!isRecord(rawResource.derived_measures)) {
        throw new Error(`${resourceId} derived-measure review overrides must be an object.`);
      }
      const derivedMeasures: NonNullable<
        AutoBoundaryReviewOverrides["resources"][string]["derived_measures"]
      > = {};
      for (const name of Object.keys(rawResource.derived_measures).sort()) {
        assertSafeMapKey(name, "reviewed derived measure");
        derivedMeasures[name] = normalizeReviewedDerivedMeasureDecision(
          rawResource.derived_measures[name],
          `${resourceId}.${name} reviewed derived measure`,
        );
        if (derivedMeasures[name]!.definition.name !== name) {
          throw new Error(`${resourceId}.${name} reviewed derived-measure key must match its definition name.`);
        }
      }
      resource.derived_measures = derivedMeasures;
    }
    if (rawResource.numeric_bands !== undefined) {
      if (!isRecord(rawResource.numeric_bands)) {
        throw new Error(`${resourceId} numeric-band review overrides must be an object.`);
      }
      const numericBands: NonNullable<
        AutoBoundaryReviewOverrides["resources"][string]["numeric_bands"]
      > = {};
      for (const name of Object.keys(rawResource.numeric_bands).sort()) {
        assertSafeMapKey(name, "reviewed numeric band");
        numericBands[name] = normalizeReviewedNumericBandDecision(
          rawResource.numeric_bands[name],
          `${resourceId}.${name} reviewed numeric band`,
        );
        if (numericBands[name]!.definition.name !== name) {
          throw new Error(`${resourceId}.${name} reviewed numeric-band key must match its definition name.`);
        }
      }
      resource.numeric_bands = numericBands;
    }
    if (rawResource.auto_bands !== undefined) {
      if (!isRecord(rawResource.auto_bands)) {
        throw new Error(`${resourceId} auto-band review overrides must be an object.`);
      }
      const autoBands: NonNullable<
        AutoBoundaryReviewOverrides["resources"][string]["auto_bands"]
      > = {};
      for (const field of Object.keys(rawResource.auto_bands).sort()) {
        assertSafeMapKey(field, "reviewed auto-band field");
        autoBands[field] = normalizeReviewedAutoBandDecision(
          rawResource.auto_bands[field],
          `${resourceId}.${field} reviewed auto band`,
        );
        if (autoBands[field]!.definition.field !== field) {
          throw new Error(`${resourceId}.${field} reviewed auto-band key must match its definition field.`);
        }
      }
      resource.auto_bands = autoBands;
    }
    if (rawResource.exact_numeric_grouping !== undefined) {
      if (!isRecord(rawResource.exact_numeric_grouping)) {
        throw new Error(`${resourceId} exact grouping review overrides must be an object.`);
      }
      const exactNumericGrouping: NonNullable<
        AutoBoundaryReviewOverrides["resources"][string]["exact_numeric_grouping"]
      > = {};
      for (const field of Object.keys(rawResource.exact_numeric_grouping).sort()) {
        assertSafeMapKey(field, "reviewed exact grouping field");
        exactNumericGrouping[field] = normalizeReviewedExactNumericGroupingDecision(
          rawResource.exact_numeric_grouping[field],
          `${resourceId}.${field} exact grouping`,
        );
      }
      resource.exact_numeric_grouping = exactNumericGrouping;
    }
    if (rawResource.field_metadata !== undefined) {
      if (!isRecord(rawResource.field_metadata)) {
        throw new Error(`${resourceId} field metadata review overrides must be an object.`);
      }
      const fieldMetadata: NonNullable<
        AutoBoundaryReviewOverrides["resources"][string]["field_metadata"]
      > = {};
      for (const fieldName of Object.keys(rawResource.field_metadata).sort()) {
        assertSafeMapKey(fieldName, "reviewed metadata field");
        fieldMetadata[fieldName] = normalizeReviewedMetadataDecision(
          rawResource.field_metadata[fieldName],
          `${resourceId}.${fieldName} metadata`,
        );
      }
      resource.field_metadata = fieldMetadata;
    }
    if (rawResource.fields !== undefined) {
      if (!isRecord(rawResource.fields)) throw new Error(`${resourceId} field review overrides must be an object.`);
      const fields: NonNullable<AutoBoundaryReviewOverrides["resources"][string]["fields"]> = {};
      for (const fieldName of Object.keys(rawResource.fields).sort()) {
        assertSafeMapKey(fieldName, "reviewed field");
        const rawField = rawResource.fields[fieldName];
        if (!isRecord(rawField)) throw new Error(`${resourceId}.${fieldName} review override must be an object.`);
        assertOnlyKeys(rawField, ["exposure", "actor", "reason", "decided_at"], `${resourceId}.${fieldName} review override`);
        if (rawField.exposure !== "keep_out"
          && rawField.exposure !== "withhold_from_model"
          && rawField.exposure !== "allow_reviewed_use") {
          throw new Error(
            `${resourceId}.${fieldName} exposure must be keep_out, withhold_from_model, or allow_reviewed_use.`,
          );
        }
        fields[fieldName] = {
          exposure: rawField.exposure,
          actor: reviewedText(rawField.actor, `${resourceId}.${fieldName} actor`, 128),
          reason: reviewedText(rawField.reason, `${resourceId}.${fieldName} reason`, 500),
          decided_at: reviewedTimestamp(rawField.decided_at, `${resourceId}.${fieldName} decided_at`),
        };
      }
      resource.fields = fields;
    }
    resources[resourceId] = resource;
  }
  return {
    schema_version: AUTO_BOUNDARY_OVERRIDES_VERSION,
    resources,
  };
}

function normalizeReviewedValueDecision(
  value: unknown,
  label: string,
  allowNull: boolean,
): Omit<ReviewedValueDecision, "value"> & { value: string | null } {
  if (!isRecord(value)) throw new Error(`${label} review decision must be an object.`);
  assertOnlyKeys(value, ["value", "actor", "reason", "decided_at"], `${label} review decision`);
  if (value.value === null && !allowNull) throw new Error(`${label} cannot be null.`);
  if (value.value !== null && typeof value.value !== "string") throw new Error(`${label} value must be a column name${allowNull ? " or null" : ""}.`);
  const reviewedValue = value.value === null ? null : reviewedText(value.value, `${label} value`, 256);
  return {
    value: reviewedValue,
    actor: reviewedText(value.actor, `${label} actor`, 128),
    reason: reviewedText(value.reason, `${label} reason`, 500),
    decided_at: reviewedTimestamp(value.decided_at, `${label} decided_at`),
  };
}

function normalizeReviewedMinimumCohortDecision(
  value: unknown,
  label: string,
): ReviewedMinimumCohortDecision {
  if (!isRecord(value)) throw new Error(`${label} review decision must be an object.`);
  assertOnlyKeys(value, ["value", "actor", "reason", "decided_at"], `${label} review decision`);
  if (!Number.isSafeInteger(value.value) || Number(value.value) < 1 || Number(value.value) >= 5) {
    throw new Error(`${label} override must be an integer from 1 through 4.`);
  }
  return {
    value: Number(value.value),
    actor: reviewedText(value.actor, `${label} actor`, 128),
    reason: reviewedText(value.reason, `${label} reason`, 500),
    decided_at: reviewedTimestamp(value.decided_at, `${label} decided_at`),
  };
}

function normalizeReviewedEnumValuesDecision(
  value: unknown,
  label: string,
): ReviewedEnumValuesDecision {
  if (!isRecord(value)) throw new Error(`${label} decision must be an object.`);
  assertOnlyKeys(value, ["values", "actor", "reason", "decided_at"], `${label} decision`);
  if (!Array.isArray(value.values)
    || value.values.length > 64
    || value.values.some((item) => typeof item !== "string" || [...item].length > 64)
    || new Set(value.values).size !== value.values.length) {
    throw new Error(`${label} values must contain at most 64 unique strings of at most 64 characters each.`);
  }
  if (Buffer.byteLength(JSON.stringify(value.values), "utf8") > 2_048) {
    throw new Error(`${label} values exceed the 2048-byte reviewed vocabulary limit.`);
  }
  return {
    values: value.values.map(String),
    actor: reviewedText(value.actor, `${label} actor`, 128),
    reason: reviewedText(value.reason, `${label} reason`, 500),
    decided_at: reviewedTimestamp(value.decided_at, `${label} decided_at`),
  };
}

function normalizeReviewedDerivedMeasureDecision(
  value: unknown,
  label: string,
): ReviewedDerivedMeasureDecision {
  if (!isRecord(value)) throw new Error(`${label} decision must be an object.`);
  assertOnlyKeys(value, ["definition", "actor", "reason", "decided_at"], `${label} decision`);
  return {
    definition: normalizeExplorationDerivedMeasure(value.definition, `${label} definition`),
    actor: reviewedText(value.actor, `${label} actor`, 128),
    reason: reviewedText(value.reason, `${label} reason`, 500),
    decided_at: reviewedTimestamp(value.decided_at, `${label} decided_at`),
  };
}

function normalizeReviewedNumericBandDecision(
  value: unknown,
  label: string,
): ReviewedNumericBandDecision {
  if (!isRecord(value)) throw new Error(`${label} decision must be an object.`);
  assertOnlyKeys(value, ["definition", "actor", "reason", "decided_at"], `${label} decision`);
  return {
    definition: normalizeExplorationNumericBand(value.definition, `${label} definition`),
    actor: reviewedText(value.actor, `${label} actor`, 128),
    reason: reviewedText(value.reason, `${label} reason`, 500),
    decided_at: reviewedTimestamp(value.decided_at, `${label} decided_at`),
  };
}

function normalizeReviewedAutoBandDecision(
  value: unknown,
  label: string,
): ReviewedAutoBandDecision {
  if (!isRecord(value)) throw new Error(`${label} decision must be an object.`);
  assertOnlyKeys(value, ["definition", "actor", "reason", "decided_at"], `${label} decision`);
  return {
    definition: normalizeExplorationAutoBandPolicy(value.definition, `${label} definition`),
    actor: reviewedText(value.actor, `${label} actor`, 128),
    reason: reviewedText(value.reason, `${label} reason`, 500),
    decided_at: reviewedTimestamp(value.decided_at, `${label} decided_at`),
  };
}

function normalizeReviewedExactNumericGroupingDecision(
  value: unknown,
  label: string,
): ReviewedExactNumericGroupingDecision {
  if (!isRecord(value)) throw new Error(`${label} decision must be an object.`);
  assertOnlyKeys(value, ["actor", "reason", "decided_at"], `${label} decision`);
  return {
    actor: reviewedText(value.actor, `${label} actor`, 128),
    reason: reviewedText(value.reason, `${label} reason`, 500),
    decided_at: reviewedTimestamp(value.decided_at, `${label} decided_at`),
  };
}

function normalizeReviewedMetadataDecision(
  input: unknown,
  label: string,
): ReviewedMetadataDecision {
  if (!isRecord(input)) throw new Error(`${label} review decision must be an object.`);
  assertOnlyKeys(input, ["label", "description", "actor", "reason", "decided_at"], `${label} review decision`);
  const reviewedLabel = input.label === undefined
    ? undefined
    : reviewedText(input.label, `${label} label`, 64);
  const reviewedDescription = input.description === undefined
    ? undefined
    : reviewedText(input.description, `${label} description`, 280);
  if (!reviewedLabel && !reviewedDescription) {
    throw new Error(`${label} review decision requires a label or description.`);
  }
  return {
    ...(reviewedLabel ? { label: reviewedLabel } : {}),
    ...(reviewedDescription ? { description: reviewedDescription } : {}),
    actor: reviewedText(input.actor, `${label} actor`, 128),
    reason: reviewedText(input.reason, `${label} reason`, 500),
    decided_at: reviewedTimestamp(input.decided_at, `${label} decided_at`),
  };
}

export function normalizeExplorationNumericBand(
  value: unknown,
  label: string,
): ExplorationNumericBand {
  if (!isRecord(value)) throw new Error(`${label} must be an object.`);
  assertOnlyKeys(value, ["name", "label", "field", "relationship", "edges", "bucket_labels"], label);
  const name = reviewedText(value.name, `${label} name`, 64);
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(name)) {
    throw new Error(`${label} name must be a safe identifier of at most 64 characters.`);
  }
  if (!Array.isArray(value.edges) || value.edges.length < 1 || value.edges.length > 16
    || value.edges.some((edge) => typeof edge !== "number" || !Number.isFinite(edge))) {
    throw new Error(`${label} requires 1 through 16 finite numeric edges.`);
  }
  const edges = value.edges.map(Number);
  if (edges.some((edge, index) => index > 0 && edge <= edges[index - 1]!)) {
    throw new Error(`${label} edges must be strictly increasing and unique.`);
  }
  if (!Array.isArray(value.bucket_labels)
    || value.bucket_labels.length !== edges.length + 1
    || value.bucket_labels.some((item) => typeof item !== "string" || !item.trim() || [...item].length > 64)
    || new Set(value.bucket_labels).size !== value.bucket_labels.length
    || Buffer.byteLength(JSON.stringify(value.bucket_labels), "utf8") > 2_048) {
    throw new Error(`${label} requires one unique label per bucket, each at most 64 characters and 2048 bytes total.`);
  }
  return {
    name,
    label: reviewedText(value.label, `${label} label`, 120),
    field: reviewedText(value.field, `${label} field`, 256),
    ...(value.relationship === undefined
      ? {}
      : { relationship: reviewedText(value.relationship, `${label} relationship`, 256) }),
    edges,
    bucket_labels: value.bucket_labels.map((item) => item.trim()),
  };
}

export function normalizeExplorationAutoBandPolicy(
  value: unknown,
  label: string,
): ExplorationAutoBandPolicy {
  if (!isRecord(value)) throw new Error(`${label} must be an object.`);
  assertOnlyKeys(
    value,
    ["field", "methods", "min_buckets", "max_buckets", "min_bucket_width", "label_style", "label_round_to"],
    label,
  );
  if (!Array.isArray(value.methods)
    || value.methods.length < 1
    || value.methods.length > EXPLORATION_AUTO_BAND_METHODS.length
    || value.methods.some((method) => !EXPLORATION_AUTO_BAND_METHODS.includes(method as ExplorationAutoBandMethod))) {
    throw new Error(`${label} methods must contain quantile and/or equal_width.`);
  }
  const selectedMethods = new Set(value.methods as ExplorationAutoBandMethod[]);
  const methods = EXPLORATION_AUTO_BAND_METHODS.filter((method) => selectedMethods.has(method));
  if (methods.length !== value.methods.length) throw new Error(`${label} methods cannot contain duplicates.`);
  const minBuckets = Number(value.min_buckets);
  const maxBuckets = Number(value.max_buckets);
  if (!Number.isSafeInteger(minBuckets)
    || !Number.isSafeInteger(maxBuckets)
    || minBuckets < MIN_AUTO_BAND_BUCKETS
    || maxBuckets > MAX_AUTO_BAND_BUCKETS
    || minBuckets > maxBuckets) {
    throw new Error(
      `${label} bucket range must be whole numbers from ${MIN_AUTO_BAND_BUCKETS} through ${MAX_AUTO_BAND_BUCKETS}.`,
    );
  }
  const labelStyle = value.label_style;
  if (!EXPLORATION_AUTO_BAND_LABEL_STYLES.includes(labelStyle as ExplorationAutoBandLabelStyle)) {
    throw new Error(`${label} label_style must be ordinal or rounded.`);
  }
  const minBucketWidth = value.min_bucket_width === undefined
    ? undefined
    : Number(value.min_bucket_width);
  if (methods.includes("equal_width")
    && (minBucketWidth === undefined || !Number.isFinite(minBucketWidth) || minBucketWidth <= 0)) {
    throw new Error(`${label} requires a positive min_bucket_width when equal_width is enabled.`);
  }
  if (!methods.includes("equal_width") && minBucketWidth !== undefined) {
    throw new Error(`${label} min_bucket_width is available only for equal_width.`);
  }
  const labelRoundTo = value.label_round_to === undefined
    ? undefined
    : Number(value.label_round_to);
  if (labelStyle === "rounded"
    && (labelRoundTo === undefined || !Number.isFinite(labelRoundTo) || labelRoundTo <= 0)) {
    throw new Error(`${label} requires a positive label_round_to for rounded labels.`);
  }
  if (labelStyle !== "rounded" && labelRoundTo !== undefined) {
    throw new Error(`${label} label_round_to is available only for rounded labels.`);
  }
  return {
    field: reviewedText(value.field, `${label} field`, 256),
    methods,
    min_buckets: minBuckets,
    max_buckets: maxBuckets,
    ...(minBucketWidth === undefined ? {} : { min_bucket_width: minBucketWidth }),
    label_style: labelStyle as ExplorationAutoBandLabelStyle,
    ...(labelRoundTo === undefined ? {} : { label_round_to: labelRoundTo }),
  };
}

export function normalizeExplorationDerivedMeasure(
  value: unknown,
  label: string,
): ExplorationDerivedMeasure {
  if (!isRecord(value)) throw new Error(`${label} must be an object.`);
  const name = reviewedText(value.name, `${label} name`, 64);
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(name)) {
    throw new Error(`${label} name must be a safe identifier of at most 64 characters.`);
  }
  const reviewedLabel = reviewedText(value.label, `${label} label`, 120);
  if (value.shape === "ratio" || value.shape === "percentage" || value.shape === "per_unit_average") {
    assertOnlyKeys(
      value,
      ["name", "label", "shape", "numerator", "denominator", "null_policy"],
      label,
    );
    if (value.null_policy !== "null_on_zero_or_null_denominator") {
      throw new Error(`${label} must use null_on_zero_or_null_denominator.`);
    }
    return {
      name,
      label: reviewedLabel,
      shape: value.shape,
      numerator: normalizeExplorationDerivedBaseMeasure(value.numerator, `${label} numerator`),
      denominator: normalizeExplorationDerivedBaseMeasure(value.denominator, `${label} denominator`),
      null_policy: "null_on_zero_or_null_denominator",
    };
  }
  if (value.shape === "child_count_total" || value.shape === "child_count_average") {
    assertOnlyKeys(value, ["name", "label", "shape", "child_resource", "relationship"], label);
    return {
      name,
      label: reviewedLabel,
      shape: value.shape,
      child_resource: reviewedText(value.child_resource, `${label} child_resource`, 256),
      relationship: reviewedText(value.relationship, `${label} relationship`, 256),
    };
  }
  if (!EXPLORATION_POST_AGGREGATE_OPERATIONS.includes(
    value.shape as ExplorationPostAggregateOperation,
  )) {
    throw new Error(
      `${label} shape must be a fixed reviewed ratio, percentage, per-unit average, or post-suppression transform.`,
    );
  }
  assertOnlyKeys(value, ["name", "label", "shape", "base_measure", "direction", "window_size"], label);
  const shape = value.shape as ExplorationPostAggregateOperation;
  if (shape === "rank") {
    if (value.direction !== "asc" && value.direction !== "desc") {
      throw new Error(`${label} rank requires direction asc or desc.`);
    }
  } else if (value.direction !== undefined) {
    throw new Error(`${label} direction is available only for a reviewed rank.`);
  }
  if (shape === "moving_average") {
    if (!Number.isSafeInteger(value.window_size)
      || Number(value.window_size) < 2
      || Number(value.window_size) > 12) {
      throw new Error(`${label} moving_average requires a fixed window_size from 2 through 12.`);
    }
  } else if (value.window_size !== undefined) {
    throw new Error(`${label} window_size is available only for a reviewed moving average.`);
  }
  return {
    name,
    label: reviewedLabel,
    shape,
    base_measure: normalizeExplorationDerivedBaseMeasure(value.base_measure, `${label} base_measure`),
    ...(shape === "rank" ? { direction: value.direction as "asc" | "desc" } : {}),
    ...(shape === "moving_average" ? { window_size: Number(value.window_size) } : {}),
  };
}

function normalizeExplorationDerivedBaseMeasure(
  value: unknown,
  label: string,
): ExplorationDerivedBaseMeasure {
  if (!isRecord(value)) throw new Error(`${label} must be an object.`);
  if (value.function === "count") {
    assertOnlyKeys(value, ["function"], label);
    return { function: "count" };
  }
  assertOnlyKeys(value, ["function", "field", "relationship"], label);
  if (value.function !== "count_distinct" && value.function !== "sum" && value.function !== "avg") {
    throw new Error(`${label} function must be count, count_distinct, sum, or avg.`);
  }
  return {
    function: value.function,
    field: reviewedText(value.field, `${label} field`, 256),
    ...(value.relationship === undefined
      ? {}
      : { relationship: reviewedText(value.relationship, `${label} relationship`, 256) }),
  };
}

function applyReviewedDerivedMeasureOverrides(
  boundary: ExplorationBoundaryDraft,
  overrides: AutoBoundaryReviewOverrides,
): void {
  const resources = new Map(boundary.pack.resources.map((resource) => [resource.id, resource]));
  for (const [resourceId, review] of Object.entries(overrides.resources)) {
    if (!review.derived_measures) continue;
    const resource = resources.get(resourceId);
    if (!resource) throw new Error(`Derived-measure review override references unavailable resource ${resourceId}.`);
    resource.derived_measures = Object.values(review.derived_measures)
      .map((decision) => structuredClone(decision.definition))
      .sort((left, right) => left.name.localeCompare(right.name));
  }
  for (const resource of boundary.pack.resources) {
    assertReviewedDerivedMeasures(resource, boundary.pack.resources, Boolean(boundary.organization_scope));
  }
}

function applyReviewedNumericBandOverrides(
  boundary: ExplorationBoundaryDraft,
  overrides: AutoBoundaryReviewOverrides,
): void {
  const resources = new Map(boundary.pack.resources.map((resource) => [resource.id, resource]));
  for (const [resourceId, review] of Object.entries(overrides.resources)) {
    if (!review.numeric_bands) continue;
    const resource = resources.get(resourceId);
    if (!resource) throw new Error(`Numeric-band review override references unavailable resource ${resourceId}.`);
    resource.numeric_bands = Object.values(review.numeric_bands)
      .map((decision) => structuredClone(decision.definition))
      .sort((left, right) => left.name.localeCompare(right.name));
  }
  for (const resource of boundary.pack.resources) {
    assertReviewedNumericBands(resource, boundary.pack.resources);
  }
}

function applyReviewedAutoBandOverrides(
  boundary: ExplorationBoundaryDraft,
  overrides: AutoBoundaryReviewOverrides,
): void {
  const resources = new Map(boundary.pack.resources.map((resource) => [resource.id, resource]));
  for (const [resourceId, review] of Object.entries(overrides.resources)) {
    if (!review.auto_bands) continue;
    const resource = resources.get(resourceId);
    if (!resource) throw new Error(`Auto-band review override references unavailable resource ${resourceId}.`);
    resource.auto_bands = Object.values(review.auto_bands)
      .map((decision) => structuredClone(decision.definition))
      .sort((left, right) => left.field.localeCompare(right.field));
  }
  for (const resource of boundary.pack.resources) assertReviewedAutoBands(resource);
}

function applyReviewOverrides(
  graph: AutoBoundaryEvidenceGraph,
  overrides: AutoBoundaryReviewOverrides,
): void {
  const resources = new Map(graph.resources.map((resource) => [resource.id, resource]));
  for (const [resourceId, override] of Object.entries(overrides.resources)) {
    const resource = resources.get(resourceId);
    if (!resource) throw new Error(`Review override references unknown resource ${resourceId}.`);
    const columns = new Set(resource.fields.map((field) => field.name));

    if (override.metadata) {
      resource.metadata_review_override = structuredClone(override.metadata);
    }
    for (const [fieldName, metadata] of Object.entries(override.field_metadata ?? {})) {
      const field = resource.fields.find((candidate) => candidate.name === fieldName);
      if (!field) throw new Error(`Metadata review override references unknown field ${resourceId}.${fieldName}.`);
      field.metadata_review_override = structuredClone(metadata);
    }

    if (override.row_identity) {
      if (!resource.primary_key.candidates.includes(override.row_identity.value)) {
        throw new Error(
          `${resourceId} row identity ${override.row_identity.value} is not a database-proven single-column primary or unique key.`,
        );
      }
      resource.primary_key.selected = override.row_identity.value;
      resource.primary_key.confidence = "high";
      resource.primary_key.evidence.push(reviewDecisionEvidence("row identity", override.row_identity));
      markReviewedInference(resource.primary_key, override.row_identity.value, "Human reviewed this source-proven row identity.");
    }
    if (override.tenant_key) {
      if (!columns.has(override.tenant_key.value)) {
        throw new Error(`${resourceId} tenant key ${override.tenant_key.value} is not an inspected source column.`);
      }
      resource.tenant_key.selected = override.tenant_key.value;
      resource.tenant_key.candidates = unique([...resource.tenant_key.candidates, override.tenant_key.value]).sort();
      resource.tenant_key.confidence = "high";
      resource.tenant_key.evidence.push(reviewDecisionEvidence("tenant key", override.tenant_key));
      markReviewedInference(resource.tenant_key, override.tenant_key.value, "Human reviewed this inspected tenant-scope column.");
    }
    if (override.principal_key) {
      if (override.principal_key.value !== null && !columns.has(override.principal_key.value)) {
        throw new Error(`${resourceId} principal key ${override.principal_key.value} is not an inspected source column.`);
      }
      if (override.principal_key.value === null) {
        delete resource.principal_key.selected;
      } else {
        resource.principal_key.selected = override.principal_key.value;
        resource.principal_key.candidates = unique([
          ...resource.principal_key.candidates,
          override.principal_key.value,
        ]).sort();
      }
      resource.principal_key.confidence = "high";
      resource.principal_key.evidence.push(reviewDecisionEvidence("principal key", override.principal_key));
      if (override.principal_key.value === null) {
        resource.principal_key.alternatives_considered = resource.principal_key.alternatives_considered
          .map((alternative) => ({ ...alternative, selected: false }));
        delete resource.principal_key.blocked_reason;
      } else {
        markReviewedInference(resource.principal_key, override.principal_key.value, "Human reviewed this inspected principal-scope column.");
      }
    }
    if (override.principal_rls_setting) {
      const reviewedSetting = override.principal_rls_setting.value;
      if (reviewedSetting !== null
        && !(resource.rls.principal_setting_candidates ?? []).includes(reviewedSetting)) {
        throw new Error(
          `${resourceId} PostgreSQL RLS principal setting ${reviewedSetting} is not a current live-policy candidate.`,
        );
      }
      resource.rls.principal_setting_review_override = structuredClone(
        override.principal_rls_setting,
      );
    }
    if (override.minimum_cohort) {
      resource.minimum_cohort_override = { ...override.minimum_cohort };
    }

    for (const [fieldName, enumOverride] of Object.entries(override.field_enums ?? {})) {
      const field = resource.fields.find((candidate) => candidate.name === fieldName);
      if (!field) throw new Error(`Enum review override references unknown field ${resourceId}.${fieldName}.`);
      if (!field.enum_values?.length && enumOverride.values.length) {
        throw new Error(`${resourceId}.${fieldName} has no bounded schema-declared value set to review.`);
      }
      if (field.enum_values?.length) {
        assertSubset(
          enumOverride.values,
          field.enum_values,
          `${resourceId}.${fieldName} reviewed enum values`,
        );
      }
      field.enum_review_override = structuredClone(enumOverride);
      field.evidence.push(
        `human enum review override: ${enumOverride.values.length} of ${field.enum_values?.length ?? 0} schema values retained`,
      );
    }

    for (const [fieldName, fieldOverride] of Object.entries(override.fields ?? {})) {
      const field = resource.fields.find((candidate) => candidate.name === fieldName);
      if (!field) throw new Error(`Review override references unknown field ${resourceId}.${fieldName}.`);
      if ((fieldOverride.exposure === "allow_reviewed_use"
          || fieldOverride.exposure === "withhold_from_model")
        && isUnsafeRawType(field.data_type)) {
        throw new Error(`${resourceId}.${fieldName} has a binary or unsupported large-object type and cannot be made available for reviewed use.`);
      }
      field.review_override = { ...fieldOverride };
      field.evidence.push(
        `human review override: ${fieldOverride.exposure}`,
      );
      const allow = fieldOverride.exposure === "allow_reviewed_use"
        || fieldOverride.exposure === "withhold_from_model";
      field.sensitive_suggestion = !allow;
      field.raw_visible_suggestion = allow;
      field.aggregate_measure_suggestion = allow
        && isNumericType(field.data_type)
        && isAnalyticalNumericMeasureName(field.name);
      field.count_distinct_suggestion = allow;
      field.groupable_suggestion = allow
        && !field.primary_key
        && !isReferenceIdentifierName(field.name)
        && isCategoricalType(field.data_type);
      field.time_bucket_suggestion = allow && isTimestampType(field.data_type);
    }
    for (const [fieldName, groupingOverride] of Object.entries(
      override.exact_numeric_grouping ?? {},
    )) {
      const field = resource.fields.find((candidate) => candidate.name === fieldName);
      if (!field) {
        throw new Error(`Exact grouping review references unknown field ${resourceId}.${fieldName}.`);
      }
      const eligibility = exactNumericGroupingEligibility(resource, fieldName);
      if (!eligibility.eligible) {
        throw new Error(
          `${resourceId}.${fieldName} cannot be reviewed for exact grouping: `
          + `${eligibility.reasons.join("; ")}.`,
        );
      }
      field.exact_numeric_grouping_review_override = structuredClone(groupingOverride);
      field.groupable_suggestion = true;
      field.evidence.push("human review override: exact grouping enabled");
    }
    refreshResourceStatus(resource);
  }
}

function inferDerivedScopeCandidates(graph: AutoBoundaryEvidenceGraph): void {
  const byId = new Map(graph.resources.map((resource) => [resource.id, resource]));
  for (const resource of graph.resources) {
    if (!resource.tenant_key.selected) {
      const candidates = derivedScopeCandidates(resource, byId, "tenant");
      if (candidates.length) {
        resource.derived_tenant_scope = {
          candidates,
          confirmation_required: true,
          safety_consequence: "Every read will be constrained through this mandatory proven path to the trusted tenant ancestor.",
          blocked_reason: candidates.length === 1
            ? "A human must review the single proven relationship-carried tenant path before this table becomes available."
            : "Several proven tenant paths exist; a human must choose exactly one before this table becomes available.",
        };
      }
    }
    if (!resource.principal_key.selected) {
      const candidates = derivedScopeCandidates(resource, byId, "principal");
      if (candidates.length) {
        resource.derived_principal_scope = {
          candidates,
          confirmation_required: true,
          safety_consequence: "When selected, every read will also be constrained through this mandatory proven path to the trusted principal ancestor.",
          blocked_reason: candidates.length === 1
            ? "A human may review the single proven relationship-carried principal path."
            : "Several proven principal paths exist; a human must choose one to add principal scope.",
        };
      }
    }
  }
}

function derivedScopeCandidates(
  root: AutoBoundaryResource,
  resources: Map<string, AutoBoundaryResource>,
  kind: "tenant" | "principal",
): DerivedScopePath[] {
  const candidates: DerivedScopePath[] = [];
  const visit = (
    current: AutoBoundaryResource,
    links: RelationshipLinkProof[],
    visited: Set<string>,
  ): void => {
    if (links.length >= (EXPLORATION_BUDGET_REVIEW_CEILINGS.max_derived_scope_hops ?? 2)) return;
    for (const relationship of current.relationships) {
      if (!relationship.cardinality_proven
        || relationship.nullable
        || !relationship.target_uniqueness
        || relationship.columns.length < 1
        || relationship.columns.length !== relationship.referenced_columns.length) continue;
      const target = resources.get(relationship.referenced_resource);
      if (!target || visited.has(target.id) || target.id === root.id) continue;
      const link: RelationshipLinkProof = {
        constraint_name: relationship.name,
        source_resource: current.id,
        target_resource: target.id,
        source_columns: [...relationship.columns],
        target_columns: [...relationship.referenced_columns],
        target_uniqueness: structuredClone(relationship.target_uniqueness),
        nullable: false,
        cardinality: "many_to_one",
        max_fan_out: 1,
      };
      const nextLinks = [...links, link];
      const ancestorColumn = kind === "tenant"
        ? target.tenant_key.selected
        : target.principal_key.selected;
      if (ancestorColumn) {
        const pathId = nextLinks.map((item) => item.constraint_name).join("__");
        candidates.push({
          mode: "derived",
          path_id: pathId,
          ancestor_resource: target.id,
          ancestor_column: ancestorColumn,
          proof: {
            source: "database_catalog",
            links: nextLinks,
            digest: canonicalJsonDigest(nextLinks),
          },
        });
        continue;
      }
      visit(target, nextLinks, new Set([...visited, target.id]));
    }
  };
  visit(root, [], new Set([root.id]));
  return [...new Map(candidates.map((candidate) => [
    `${candidate.path_id}:${candidate.ancestor_resource}:${candidate.ancestor_column}`,
    candidate,
  ])).values()].sort((left, right) =>
    left.path_id.localeCompare(right.path_id)
    || left.ancestor_resource.localeCompare(right.ancestor_resource)
    || left.ancestor_column.localeCompare(right.ancestor_column));
}

function applyDerivedScopeReviewOverrides(
  graph: AutoBoundaryEvidenceGraph,
  overrides: AutoBoundaryReviewOverrides,
  singleOrganization = false,
): void {
  const resources = new Map(graph.resources.map((resource) => [resource.id, resource]));
  for (const resource of graph.resources) {
    if (!singleOrganization
      && !resource.tenant_key.selected
      && !resource.derived_tenant_scope?.selected) {
      resource.shared_reference_scope = sharedReferenceScopeInference(resource, resources);
    } else {
      delete resource.shared_reference_scope;
    }
  }
  for (const [resourceId, override] of Object.entries(overrides.resources)) {
    const resource = resources.get(resourceId);
    if (!resource) continue;
    const reviewedTenantModes = [
      override.tenant_key,
      override.tenant_scope_path,
      override.shared_reference_scope,
    ].filter(Boolean).length;
    if (reviewedTenantModes > 1) {
      throw new Error(
        `${resourceId} must review exactly one of a direct tenant key, a derived tenant path, or shared-reference scope.`,
      );
    }
    const reviewedPrincipalModes = [
      override.principal_key?.value,
      override.principal_scope_path?.value,
      override.principal_rls_setting?.value,
    ].filter(Boolean).length;
    if (reviewedPrincipalModes > 1) {
      throw new Error(
        `${resourceId} must review one principal mode: a direct key, a derived path, or a PostgreSQL RLS setting.`,
      );
    }
    if (override.tenant_scope_path) {
      const selected = resource.derived_tenant_scope?.candidates.find((candidate) =>
        candidate.path_id === override.tenant_scope_path!.value);
      if (!selected) {
        throw new Error(
          `${resourceId} derived tenant scope path ${override.tenant_scope_path.value} is not a current non-null, catalog-proven many-to-one path to a direct tenant scope.`,
        );
      }
      resource.derived_tenant_scope!.selected = structuredClone(selected);
      delete resource.derived_tenant_scope!.blocked_reason;
    }
    if (override.shared_reference_scope) {
      if (singleOrganization) {
        throw new Error(
          `${resourceId} cannot declare shared-reference scope inside a single-organization boundary.`,
        );
      }
      const inference = resource.shared_reference_scope
        ?? sharedReferenceScopeInference(resource, resources);
      if (!inference.eligible) {
        throw new Error(
          `${resourceId} cannot be reviewed as a shared reference: ${inference.blockers.join("; ")}.`,
        );
      }
      inference.selected = {
        mode: "shared_reference",
        acknowledgement: SHARED_REFERENCE_ACKNOWLEDGEMENT,
      };
      inference.review_override = structuredClone(override.shared_reference_scope);
      resource.shared_reference_scope = inference;
    }
    if (override.principal_scope_path?.value) {
      const selected = resource.derived_principal_scope?.candidates.find((candidate) =>
        candidate.path_id === override.principal_scope_path!.value);
      if (!selected) {
        throw new Error(
          `${resourceId} derived principal scope path ${override.principal_scope_path.value} is not a current non-null, catalog-proven many-to-one path to a direct principal scope.`,
        );
      }
      resource.derived_principal_scope!.selected = structuredClone(selected);
      delete resource.derived_principal_scope!.blocked_reason;
    }
  }
}

function sharedReferenceScopeInference(
  resource: AutoBoundaryResource,
  resources: Map<string, AutoBoundaryResource>,
): SharedReferenceScopeInference {
  const blockers = new Set<string>();
  if (resource.tenant_key.selected || resource.tenant_key.candidates.length > 0) {
    blockers.add("the inspected table has tenant-scope column evidence");
  }
  if ((resource.derived_tenant_scope?.candidates.length ?? 0) > 0) {
    blockers.add("the inspected table has a proven path to tenant-scoped rows");
  }
  if (resource.rls.enabled === true
    || resource.rls.enabled === "unknown"
    || resource.rls.policy_names.length > 0) {
    blockers.add("row-level tenant posture is present or could not be proven absent");
  }
  for (const relationship of resource.relationships) {
    const target = resources.get(relationship.referenced_resource);
    if (!target) continue;
    if (target.tenant_key.selected
      || target.tenant_key.candidates.length > 0
      || target.derived_tenant_scope?.selected
      || (target.derived_tenant_scope?.candidates.length ?? 0) > 0) {
      blockers.add(
        `relationship ${relationship.name} reaches tenant-scoped resource ${target.id}`,
      );
    }
  }
  return {
    eligible: blockers.size === 0,
    confirmation_required: true,
    safety_consequence:
      "Runner will apply no tenant predicate to this table; every tenant may receive the same reviewed rows, while field, cohort, and budget controls remain enforced.",
    blockers: [...blockers].sort(),
  };
}

function markReviewedInference(
  target: BoundaryInference<string>,
  value: string,
  evidence: string,
): void {
  target.alternatives_considered = [
    ...target.alternatives_considered
      .filter((alternative) => alternative.value !== value)
      .map((alternative) => ({ ...alternative, selected: false })),
    { value, confidence: "high" as const, evidence: [evidence], selected: true },
  ].sort((left, right) => Number(right.selected) - Number(left.selected) || left.value.localeCompare(right.value));
  delete target.blocked_reason;
}

function refreshResourceStatus(resource: AutoBoundaryResource, singleOrganization = false): void {
  const hasTenantScope = Boolean(
    resource.tenant_key.selected
    || resource.derived_tenant_scope?.selected
    || resource.shared_reference_scope?.selected,
  );
  const tenantResolved = singleOrganization ? !hasTenantScope : hasTenantScope;
  resource.blockers = [
    ...(!resource.primary_key.selected ? ["source-proven single-column primary or unique row identifier is unresolved"] : []),
    ...(!tenantResolved ? [singleOrganization
      ? "single-organization resources must not declare direct, derived, or shared-reference tenant scope"
      : resource.shared_reference_scope?.eligible
        ? "trusted tenant scope is unresolved; review Shared reference only if this table has no per-tenant rows"
        : "trusted tenant scope is unresolved"] : []),
  ];
  resource.status = !resource.primary_key.selected
    ? "blocked_identifier"
    : !tenantResolved
      ? "blocked_scope"
      : "draft_read";
}

function singleOrganizationScope(organizationId: string): SingleOrganizationScope {
  const normalized = organizationId.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(normalized)) {
    throw new Error("Single-organization Explore requires an organization id of 1-128 letters, numbers, dots, colons, underscores, or dashes.");
  }
  return {
    mode: "single_organization",
    organization_id: normalized,
    acknowledgement: "all_rows_belong_to_one_organization",
  };
}

export function assertSingleOrganizationInspectionSafe(
  inspection: SchemaInspection,
  graph?: AutoBoundaryEvidenceGraph,
): void {
  const evidence = new Set<string>(inspection.global_tenant_isolation_evidence ?? []);
  for (const table of inspection.tables) {
    const resource = `${table.schema}.${table.name}`;
    for (const column of table.suggestions.tenant_columns) {
      evidence.add(`${resource}.${column} is a tenant-scope candidate`);
    }
    for (const column of table.columns.filter((item) => item.suggestions.tenant)) {
      evidence.add(`${resource}.${column.name} is marked as tenant scope`);
    }
    if (table.row_level_security === true || (table.row_level_security_policies?.length ?? 0) > 0) {
      evidence.add(`${resource} has row-level security metadata`);
    }
  }
  for (const resource of graph?.resources ?? []) {
    for (const candidate of resource.tenant_key.candidates) {
      evidence.add(`${resource.id}.${candidate} is a generated tenant-scope candidate`);
    }
    if (resource.tenant_key.selected) {
      evidence.add(`${resource.id}.${resource.tenant_key.selected} is selected as tenant scope`);
    }
  }
  if (evidence.size > 0) {
    throw new Error([
      "Single-organization Explore was refused because the inspected source contains tenant-isolation evidence.",
      ...[...evidence].sort().map((item) => `- ${item}`),
      "Use the normal multi-tenant boundary so Runner keeps injecting trusted tenant scope. No boundary was generated or activated.",
    ].join("\n"));
  }
}

function reviewDecisionEvidence(
  kind: string,
  decision: Omit<ReviewedValueDecision, "value"> & { value: string | null },
): BoundaryInference<string>["evidence"][number] {
  return {
    source: "synapsor",
    detail: `human-reviewed ${kind} override: ${decision.value ?? "none"}`,
  };
}

function reviewedText(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== "string") throw new Error(`${label} must be text.`);
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength || /[\r\n\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error(`${label} must be 1-${maxLength} characters without control characters.`);
  }
  if (looksLikeSecret(normalized)) throw new Error(`${label} must not contain credentials or secret material.`);
  return normalized;
}

function reviewedTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be an ISO-8601 timestamp.`);
  const timestamp = new Date(value);
  if (!Number.isFinite(timestamp.getTime()) || timestamp.toISOString() !== value) {
    throw new Error(`${label} must be a canonical UTC ISO-8601 timestamp.`);
  }
  return value;
}

function assertOnlyKeys(value: Record<string, unknown>, allowed: string[], label: string): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !allowedSet.has(key));
  if (unknown.length) throw new Error(`${label} contains unsupported field(s): ${unknown.sort().join(", ")}.`);
}

function assertSafeMapKey(value: string, label: string): void {
  if (!value || value.length > 512 || /[\u0000-\u001f\u007f]/.test(value) || ["__proto__", "prototype", "constructor"].includes(value)) {
    throw new Error(`${label} name is invalid.`);
  }
}

function looksLikeSecret(value: string): boolean {
  return /(?:postgres(?:ql)?|mysql):\/\/\S+|Bearer\s+[A-Za-z0-9._~+/=-]{12,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|(?:^|[?&\s])(?:password|passwd|secret|token|api[_-]?key|private[_-]?key)=\S+/i.test(value);
}

function isUnsafeRawType(type: string): boolean {
  return /(?:^|\b)(bytea|blob|binary|varbinary|image|large object|oid)(?:\b|$)/i.test(type);
}

function buildEvidenceGraph(
  inspection: SchemaInspection,
  project: ProjectDetectionSummary,
  staticObjects: Array<{ format: SchemaCandidateFormat; object: CandidateObject }>,
  existingContracts: SynapsorContract[],
  configuredTrustedContext?: ConfiguredTrustedContextAuthority,
): AutoBoundaryEvidenceGraph {
  const staticByTable = new Map<string, Array<{ format: SchemaCandidateFormat; object: CandidateObject }>>();
  for (const item of staticObjects) {
    const key = `${item.object.schema}.${item.object.table}`.toLowerCase();
    const values = staticByTable.get(key) ?? [];
    values.push(item);
    staticByTable.set(key, values);
  }
  const resources = inspection.tables
    .map((table) => buildResource(
      table,
      inspection,
      staticByTable.get(`${table.schema}.${table.name}`.toLowerCase()) ?? [],
      existingScopeEvidence(table, existingContracts),
      configuredTrustedContext,
    ))
    .sort((left, right) => left.id.localeCompare(right.id));
  const structuredActions = [
    ...staticObjects.flatMap(({ format, object }) => format === "openapi"
      ? object.action_candidates.filter((action) => action.kind === "proposal").map((action) => ({
        name: action.name,
        source: "openapi" as const,
        resource_hint: object.name,
        status: "disabled_requires_business_review" as const,
      }))
      : []),
    ...existingContracts.flatMap((contract) => contract.capabilities.filter((capability) => capability.kind === "proposal").map((capability) => ({
      name: capability.name,
      source: "synapsor" as const,
      resource_hint: capability.subject.resource ?? capability.subject.table,
      status: "disabled_requires_business_review" as const,
    }))),
  ].sort((left, right) => left.name.localeCompare(right.name));
  const rolePosture = inspection.role_posture;
  return {
    schema_version: AUTO_BOUNDARY_VERSION,
    engine: inspection.engine,
    database_role: {
      name: inspection.current_user,
      verified: rolePosture?.verified === true,
      read_only: rolePosture?.read_only === true,
      superuser: rolePosture?.superuser ?? "unknown",
      bypass_rls: rolePosture?.bypass_rls ?? "unknown",
      fingerprint: rolePostureFingerprint(inspection),
    },
    project: {
      frameworks: [...project.frameworks].sort(),
      schema_inputs: [...project.schema_inputs].sort((left, right) => `${left.kind}:${left.path}`.localeCompare(`${right.kind}:${right.path}`)),
    },
    resources,
    structured_actions: structuredActions,
    warnings: [
      "Names and comments are untrusted naming evidence only; they never grant authority.",
      "Tenant, principal, field exposure, aggregate permissions, relationships, privacy limits, and activation require human review.",
      ...(!rolePosture?.read_only ? ["The inspected credential is not demonstrably read-only; source-row exploration is blocked."] : []),
    ],
  };
}

function boundaryAuthority(candidate: ExplorationBoundaryDraft): Record<string, unknown> {
  const { unresolved_decisions: _unresolved, activation: _activation, ...authority } = candidate;
  return { ...authority, activation: "reviewed" };
}

function assertBoundaryCandidateMetadata(
  draft: ExplorationBoundaryDraft,
  candidate: ExplorationBoundaryDraft,
): void {
  if (candidate.schema_version !== draft.schema_version) throw new Error("Exploration boundary schema version cannot change during review.");
  if (candidate.activation !== "disabled_unreviewed") throw new Error("A reviewed candidate must still be disabled before activation.");
  if (draft.deployment_profile === "production" && candidate.deployment_profile !== "production") {
    throw new Error("A production boundary cannot be downgraded during review.");
  }
  if (draft.deployment_profile !== "production" && candidate.deployment_profile === "production") {
    throw new Error("A local authoring draft cannot be promoted to production during review; generate a separate production draft.");
  }
  if (candidate.deployment_profile !== "development"
    && candidate.deployment_profile !== "staging"
    && candidate.deployment_profile !== "production") {
    throw new Error("Scoped Explore activation requires an explicit development, staging, or production profile.");
  }
  if (candidate.deployment_profile === "production" && candidate.trusted_context.provider !== "http_claims") {
    throw new Error("Production Scoped Explore requires reviewed tenant and principal HTTP claim bindings.");
  }
  if (candidate.deployment_profile !== "production" && candidate.trusted_context.provider !== "environment") {
    throw new Error("Development and staging Scoped Explore require local trusted context bindings.");
  }
  if (!/^[a-z][a-z0-9_.-]{0,63}$/.test(candidate.pack.name)) {
    throw new Error("The reviewed authoring pack name must be a stable lower-case identifier.");
  }
  for (const immutable of [
    "source",
    "compiler_version",
    "spec_version",
    "database_server_version",
    "database_server_tier",
    "generation_lock_fingerprint",
    "role_posture_fingerprint",
  ] as const) {
    if (candidate[immutable] !== draft[immutable]) throw new Error(`${immutable} cannot change during boundary review.`);
  }
  if (canonicalJsonDigest(candidate.database_server_authority ?? null)
    !== canonicalJsonDigest(draft.database_server_authority ?? null)) {
    throw new Error("database_server_authority cannot change during boundary review.");
  }
  if (candidate.reporting_timezone !== draft.reporting_timezone) {
    throw new Error("reporting_timezone cannot change during boundary review.");
  }
  if (canonicalJsonDigest(candidate.organization_scope ?? null) !== canonicalJsonDigest(draft.organization_scope ?? null)) {
    throw new Error("organization_scope cannot change during boundary review.");
  }
  if (candidate.read_prerequisite) assertReadCurrentStatePrerequisiteShape(candidate.read_prerequisite);
  if (draft.read_prerequisite) {
    if (!candidate.read_prerequisite
      || canonicalJsonDigest(candidate.read_prerequisite) !== canonicalJsonDigest(draft.read_prerequisite)) {
      throw new Error("A reviewed Read current-state prerequisite cannot be removed or changed during narrowing review.");
    }
  }
  if (candidate.organization_scope) singleOrganizationScope(candidate.organization_scope.organization_id);
  if (candidate.organization_scope
    && (candidate.organization_scope.mode !== "single_organization"
      || candidate.organization_scope.acknowledgement !== "all_rows_belong_to_one_organization")) {
    throw new Error("Single-organization scope must retain its exact reviewed mode and acknowledgement.");
  }
  if (candidate.reporting_timezone !== undefined && candidate.reporting_timezone !== "UTC") {
    throw new Error("Generated Scoped Explore boundaries currently support only the reviewed UTC reporting timezone.");
  }
  if (canonicalJsonDigest(candidate.trusted_context) !== canonicalJsonDigest(draft.trusted_context)) {
    throw new Error("trusted_context cannot change during boundary review.");
  }
  assertBudgetsNarrow(draft.budgets, candidate.budgets);
}

function assertBoundaryCandidateNarrowsDraft(
  draft: ExplorationBoundaryDraft,
  candidate: ExplorationBoundaryDraft,
): void {
  assertBoundaryCandidateMetadata(draft, candidate);
  const draftResources = new Map(draft.pack.resources.map((resource) => [resource.id, resource]));
  const candidateResources = new Map(candidate.pack.resources.map((resource) => [resource.id, resource]));
  if (candidate.pack.resources.length < 1) throw new Error("Boundary review must retain at least one reviewed resource.");
  if (candidate.pack.resources.length > draft.pack.resources.length) throw new Error("Boundary review cannot add resources.");
  if (candidateResources.size !== candidate.pack.resources.length) throw new Error("Boundary review cannot duplicate resources.");
  for (const resource of candidate.pack.resources) {
    const original = draftResources.get(resource.id);
    if (!original) throw new Error(`Boundary review cannot add resource ${resource.id}.`);
    for (const field of ["schema", "table", "primary_key", "tenant_key", "principal_key"] as const) {
      if (resource[field] !== original[field]) throw new Error(`${resource.id} ${field} cannot change during review.`);
    }
    if (canonicalJsonDigest(resource.tenant_scope ?? null) !== canonicalJsonDigest(original.tenant_scope ?? null)
      || canonicalJsonDigest(resource.shared_reference_scope ?? null)
        !== canonicalJsonDigest(original.shared_reference_scope ?? null)
      || canonicalJsonDigest(resource.principal_scope ?? null) !== canonicalJsonDigest(original.principal_scope ?? null)) {
      throw new Error(`${resource.id} trusted scope cannot change during boundary review.`);
    }
    assertReviewedResourceScope(
      resource,
      candidateResources,
      Boolean(candidate.organization_scope),
      reviewedDerivedScopeHopLimit(candidate.budgets),
    );
    if (canonicalJsonDigest(resource.field_types) !== canonicalJsonDigest(original.field_types)
      || canonicalJsonDigest(resource.rls_session ?? null) !== canonicalJsonDigest(original.rls_session ?? null)) {
      throw new Error(`${resource.id} field types and RLS session bindings cannot change during review.`);
    }
    if (canonicalJsonDigest({
      ...(resource.label !== undefined ? { label: resource.label } : {}),
      ...(resource.description !== undefined ? { description: resource.description } : {}),
      ...(resource.field_metadata !== undefined ? { field_metadata: resource.field_metadata } : {}),
    }) !== canonicalJsonDigest({
      ...(original.label !== undefined ? { label: original.label } : {}),
      ...(original.description !== undefined ? { description: original.description } : {}),
      ...(original.field_metadata !== undefined ? { field_metadata: original.field_metadata } : {}),
    })) {
      throw new Error(`${resource.id} reviewed labels and descriptions must be changed through the reviewed metadata editor.`);
    }
    assertSubset(
      Object.keys(resource.field_enums),
      Object.keys(original.field_enums),
      `${resource.id} reviewed enum fields`,
    );
    for (const [field, values] of Object.entries(resource.field_enums)) {
      assertSubset(values, original.field_enums[field] ?? [], `${resource.id}.${field} reviewed enum values`);
    }
    for (const field of Object.keys(original.field_enums)) {
      if (original.field_enums[field]!.length > 0
        && !resource.field_enums[field]?.length
        && (resource.selectable_fields.includes(field)
          || Object.hasOwn(resource.filterable_fields, field)
          || resource.groupable_fields.includes(field))) {
        throw new Error(
          `${resource.id}.${field} cannot disable its reviewed value allowlist while retaining select, filter or group authority.`,
        );
      }
    }
    if (resource.relationship_only !== undefined && resource.relationship_only !== true) {
      throw new Error(`${resource.id} relationship-only access must be true or absent.`);
    }
    if (original.relationship_only && !resource.relationship_only) {
      throw new Error(`${resource.id} cannot add independent query access during narrowing review.`);
    }
    assertSubset(resource.selectable_fields, original.selectable_fields, `${resource.id} selectable fields`);
    assertSubset(resource.sortable_fields, original.sortable_fields, `${resource.id} sortable fields`);
    assertSubset(resource.groupable_fields, original.groupable_fields, `${resource.id} groupable fields`);
    assertSubset(resource.aggregate_measures, original.aggregate_measures, `${resource.id} aggregate measures`);
    if (resource.aggregate_measure_functions) {
      assertSubset(
        Object.keys(resource.aggregate_measure_functions),
        resource.aggregate_measures,
        `${resource.id} aggregate-function fields with reviewed aggregate access`,
      );
      assertSubset(
        Object.keys(resource.aggregate_measure_functions),
        Object.keys(original.aggregate_measure_functions ?? {}),
        `${resource.id} aggregate-function fields`,
      );
      for (const [field, functions] of Object.entries(resource.aggregate_measure_functions)) {
        assertSubset(
          functions,
          original.aggregate_measure_functions?.[field] ?? [],
          `${resource.id}.${field} aggregate functions`,
        );
      }
    }
    if (resource.presence_measure_fields) {
      assertSubset(
        resource.presence_measure_fields,
        original.presence_measure_fields ?? [],
        `${resource.id} missing-data measure fields`,
      );
      assertSubset(
        resource.presence_measure_fields,
        resource.selectable_fields.filter((field) => !(resource.model_withheld_fields ?? []).includes(field)),
        `${resource.id} model-visible missing-data measure fields`,
      );
    }
    assertReviewedDerivedMeasures(resource, candidate.pack.resources, Boolean(candidate.organization_scope));
    assertReviewedNumericBands(resource, candidate.pack.resources);
    assertReviewedAutoBands(resource);
    assertSubset(resource.count_distinct_fields, original.count_distinct_fields, `${resource.id} count-distinct fields`);
    assertSubset(original.kept_out_fields, resource.kept_out_fields, `${resource.id} generated kept-out fields`);
    assertSubset(resource.kept_out_fields, Object.keys(original.field_types), `${resource.id} kept-out fields`);
    const originalWithheld = original.model_withheld_fields ?? [];
    const candidateWithheld = resource.model_withheld_fields ?? [];
    assertSubset(candidateWithheld, originalWithheld, `${resource.id} model-withheld fields`);
    assertSubset(candidateWithheld, Object.keys(original.field_types), `${resource.id} model-withheld fields`);
    assertSubset(
      originalWithheld.filter((field) => resource.selectable_fields.includes(field)),
      candidateWithheld,
      `${resource.id} retained model-withheld selectable fields`,
    );
    for (const [field, operators] of Object.entries(resource.filterable_fields)) {
      const originalOperators = original.filterable_fields[field];
      if (!originalOperators) throw new Error(`${resource.id} cannot add filterable field ${field}.`);
      assertSubset(operators, originalOperators, `${resource.id}.${field} filter operators`);
    }
    for (const [field, buckets] of Object.entries(resource.time_bucket_fields)) {
      const originalBuckets = original.time_bucket_fields[field];
      if (!originalBuckets) throw new Error(`${resource.id} cannot add time-bucket field ${field}.`);
      assertSubset(buckets, originalBuckets, `${resource.id}.${field} time buckets`);
    }
    const originalRelationships = new Map(original.relationships.map((relationship) => [relationship.id, relationship]));
    for (const relationship of resource.relationships) {
      const expected = originalRelationships.get(relationship.id);
      if (expected?.unmatched_rows === "review_required"
        && relationship.unmatched_rows === "review_required") {
        throw new Error(`${resource.id} relationship ${relationship.id} is nullable; choose whether unmatched rows are kept as null or excluded.`);
      }
      if (!expected || !relationshipMatchesReviewedDraft(expected, relationship)) {
        throw new Error(`${resource.id} cannot add or alter relationship ${relationship.id}.`);
      }
      if ((relationship.path_depth ?? 1) > reviewedAnalysisRelationshipHopLimit(candidate.budgets)) {
        throw new Error(`${resource.id} relationship ${relationship.id} exceeds the reviewed path-depth bound.`);
      }
      const links = relationship.proof?.links ?? [{
        constraint_name: relationship.id,
        source_resource: resource.id,
        target_resource: relationship.target_resource,
        source_columns: relationship.local_columns,
        target_columns: relationship.target_columns,
        target_uniqueness: {
          kind: "unique_constraint" as const,
          name: "legacy_activated_relationship",
          columns: relationship.target_columns,
        },
        nullable: false,
        cardinality: "many_to_one" as const,
        max_fan_out: 1 as const,
      }];
      if (links.length !== (relationship.path_depth ?? 1)
        || links.length < 1
        || links.length > reviewedAnalysisRelationshipHopLimit(candidate.budgets)) {
        throw new Error(`${resource.id} relationship ${relationship.id} has invalid structural path proof.`);
      }
      let expectedSource = resource.id;
      for (const link of links) {
        const source = candidateResources.get(link.source_resource);
        const target = candidateResources.get(link.target_resource);
        if (!source || !target) {
          throw new Error(`${resource.id} relationship ${relationship.id} leaves the reviewed pack.`);
        }
        if (link.source_resource !== expectedSource
          || link.source_columns.length < 1
          || link.source_columns.length !== link.target_columns.length
          || new Set(link.source_columns).size !== link.source_columns.length
          || new Set(link.target_columns).size !== link.target_columns.length
          || link.source_columns.some((field) => !Object.hasOwn(source.field_types, field))
          || link.target_columns.some((field) => !Object.hasOwn(target.field_types, field))
          || link.cardinality !== "many_to_one" || link.max_fan_out !== 1
          || link.target_uniqueness.columns.length !== link.target_columns.length
          || link.target_uniqueness.columns.some((field, index) => field !== link.target_columns[index])) {
          throw new Error(`${resource.id} relationship ${relationship.id} is not cardinality-proven many-to-one.`);
        }
        const usesKeptOutJoinKey = link.source_columns.some((field, index) => {
          const targetField = link.target_columns[index]!;
          const trustedScopePair = isReadRelationshipScopePair(source, target, field, targetField);
          return !trustedScopePair && (source.kept_out_fields.includes(field)
            || target.kept_out_fields.includes(targetField));
        });
        if (usesKeptOutJoinKey) {
          throw new Error(`${resource.id} relationship ${relationship.id} cannot use a kept-out field.`);
        }
        expectedSource = target.id;
      }
      if (expectedSource !== relationship.target_resource) {
        throw new Error(`${resource.id} relationship ${relationship.id} does not end at its reviewed target.`);
      }
    }
    assertKeptOutUnavailable(resource);
    if (!Number.isSafeInteger(resource.minimum_cohort_size) || resource.minimum_cohort_size < 1) {
      throw new Error(`${resource.id} minimum cohort size must be an integer of at least 1.`);
    }
    if (resource.minimum_cohort_size < original.minimum_cohort_size) {
      throw new Error(`${resource.id} minimum cohort size may only stay the same or increase.`);
    }
    if (resource.minimum_cohort_overridden !== original.minimum_cohort_overridden) {
      throw new Error(`${resource.id} minimum cohort override marker must match the reviewed owner decision.`);
    }
    if (resource.suppression_aware_totals !== true) throw new Error(`${resource.id} suppression-aware totals cannot be disabled.`);
  }
}

function assertReviewedDerivedMeasures(
  resource: ExplorationBoundaryDraft["pack"]["resources"][number],
  resources: ExplorationBoundaryDraft["pack"]["resources"],
  singleOrganization: boolean,
): void {
  const definitions = resource.derived_measures ?? [];
  if (definitions.length > 16) throw new Error(`${resource.id} may review at most 16 named derived measures.`);
  const names = new Set<string>();
  for (const definition of definitions) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(definition.name) || names.has(definition.name)) {
      throw new Error(`${resource.id} derived-measure names must be unique safe identifiers.`);
    }
    names.add(definition.name);
    if (!definition.label.trim() || definition.label.length > 120
      || /[\u0000-\u001f\u007f]/.test(definition.label)) {
      throw new Error(`${resource.id}.${definition.name} requires a bounded plain-language label.`);
    }
    if ("base_measure" in definition) {
      if (!EXPLORATION_POST_AGGREGATE_OPERATIONS.includes(definition.shape)) {
        throw new Error(`${resource.id}.${definition.name} has an unsupported post-suppression transform.`);
      }
      assertDerivedBaseMeasure(resource, definition.name, definition.base_measure, resources);
      if (definition.shape === "rank" && definition.direction !== "asc" && definition.direction !== "desc") {
        throw new Error(`${resource.id}.${definition.name} rank requires a fixed direction.`);
      }
      if (definition.shape === "moving_average"
        && (!Number.isSafeInteger(definition.window_size)
          || definition.window_size! < 2
          || definition.window_size! > 12)) {
        throw new Error(`${resource.id}.${definition.name} moving average requires a fixed 2-12 group window.`);
      }
    } else if ("child_resource" in definition) {
      resolveReviewedChildCountLink(resource.id, definition, resources, singleOrganization);
    } else {
      if (definition.null_policy !== "null_on_zero_or_null_denominator") {
        throw new Error(`${resource.id}.${definition.name} has an unsupported fixed derived-measure null policy.`);
      }
      const numeratorRelationship = derivedBaseMeasureRelationship(definition.numerator);
      const denominatorRelationship = derivedBaseMeasureRelationship(definition.denominator);
      if (numeratorRelationship !== denominatorRelationship) {
        throw new Error(`${resource.id}.${definition.name} operands must use the same reviewed relationship path.`);
      }
      assertDerivedBaseMeasure(resource, definition.name, definition.numerator, resources);
      assertDerivedBaseMeasure(resource, definition.name, definition.denominator, resources);
      if (definition.shape === "per_unit_average"
        && (definition.numerator.function !== "sum"
          || !["count", "count_distinct"].includes(definition.denominator.function))) {
        throw new Error(`${resource.id}.${definition.name} per_unit_average requires SUM divided by COUNT or COUNT DISTINCT.`);
      }
    }
  }
}

export function resolveReviewedChildCountLink(
  rootResourceId: string,
  definition: ExplorationChildCountDerivedMeasure,
  resources: ExplorationBoundaryDraft["pack"]["resources"],
  singleOrganization = false,
): {
  child: ExplorationBoundaryDraft["pack"]["resources"][number];
  link: RelationshipLinkProof;
} {
  const root = resources.find((resource) => resource.id === rootResourceId);
  const child = resources.find((resource) => resource.id === definition.child_resource);
  if (!root) throw new Error(`${rootResourceId}.${definition.name} root is not in this boundary.`);
  if (!child || child.id === root.id) {
    throw new Error(`${root.id}.${definition.name} requires a different reviewed child resource.`);
  }
  if (!singleOrganization
    && (child.shared_reference_scope || (!child.tenant_key && !child.tenant_scope))) {
    throw new Error(
      `${root.id}.${definition.name} child ${child.id} must have independently reviewed tenant scope.`,
    );
  }
  const proofs: Array<{
    id: string;
    source: "database_catalog";
    links: RelationshipLinkProof[];
    digest: `sha256:${string}`;
  }> = [];
  for (const relationship of child.relationships) {
    if (relationship.id !== definition.relationship || (relationship.path_depth ?? 1) !== 1
      || !relationship.proof) continue;
    proofs.push({ id: relationship.id, ...relationship.proof });
  }
  for (const scope of [child.tenant_scope, child.principal_scope]) {
    if (scope?.path_id !== definition.relationship || scope.proof.links.length !== 1) continue;
    proofs.push({ id: scope.path_id, ...scope.proof });
  }
  const uniqueProofs = [...new Map(proofs.map((proof) => [
    canonicalJsonDigest({ id: proof.id, links: proof.links }),
    proof,
  ])).values()];
  if (uniqueProofs.length !== 1) {
    throw new Error(
      `${root.id}.${definition.name} requires one active catalog-proven child relationship ${definition.relationship}.`,
    );
  }
  const proof = uniqueProofs[0]!;
  const link = proof.links[0];
  if (proof.source !== "database_catalog"
    || proof.links.length !== 1
    || canonicalJsonDigest(proof.links) !== proof.digest
    || !link
    || link.constraint_name !== definition.relationship
    || link.source_resource !== child.id
    || link.target_resource !== root.id
    || link.nullable
    || link.cardinality !== "many_to_one"
    || link.max_fan_out !== 1
    || link.source_columns.length < 1
    || link.source_columns.length !== link.target_columns.length
    || link.target_uniqueness.columns.length !== link.target_columns.length
    || link.target_uniqueness.columns.some((column, index) => column !== link.target_columns[index])) {
    throw new Error(
      `${root.id}.${definition.name} requires one continuous non-null child-to-parent relationship with a unique reviewed parent key.`,
    );
  }
  return { child, link };
}

export function assertReviewedDerivedMeasureForBoundary(
  boundary: ExplorationBoundaryDraft,
  resourceId: string,
  definition: ExplorationDerivedMeasure,
): void {
  const resource = boundary.pack.resources.find((candidate) => candidate.id === resourceId);
  if (!resource) throw new Error(`${resourceId} is no longer in the reviewed boundary.`);
  assertReviewedDerivedMeasures(
    { ...resource, derived_measures: [structuredClone(definition)] },
    boundary.pack.resources,
    Boolean(boundary.organization_scope),
  );
}

function assertReviewedNumericBands(
  resource: ExplorationBoundaryDraft["pack"]["resources"][number],
  resources: ExplorationBoundaryDraft["pack"]["resources"],
): void {
  const definitions = resource.numeric_bands ?? [];
  if (definitions.length > 16) throw new Error(`${resource.id} may review at most 16 named numeric bands.`);
  const names = new Set<string>();
  for (const definition of definitions) {
    const normalized = normalizeExplorationNumericBand(
      definition,
      `${resource.id}.${definition.name || "numeric_band"}`,
    );
    if (names.has(normalized.name)) {
      throw new Error(`${resource.id} numeric-band names must be unique.`);
    }
    names.add(normalized.name);
    const relationship = normalized.relationship
      ? resource.relationships.find((candidate) => candidate.id === normalized.relationship)
      : undefined;
    if (normalized.relationship && !relationship) {
      throw new Error(`${resource.id}.${normalized.name} references an unreviewed relationship ${normalized.relationship}.`);
    }
    const targetId = relationship?.target_resource ?? resource.id;
    const target = resources.find((candidate) => candidate.id === targetId);
    if (!target || !target.aggregate_measures.includes(normalized.field)) {
      throw new Error(`${resource.id}.${normalized.name} uses an unreviewed numeric field ${targetId}.${normalized.field}.`);
    }
  }
}

export function assertReviewedNumericBandForBoundary(
  boundary: ExplorationBoundaryDraft,
  resourceId: string,
  definition: ExplorationNumericBand,
): void {
  const resource = boundary.pack.resources.find((candidate) => candidate.id === resourceId);
  if (!resource) throw new Error(`${resourceId} is no longer in the reviewed boundary.`);
  assertReviewedNumericBands(
    { ...resource, numeric_bands: [structuredClone(definition)] },
    boundary.pack.resources,
  );
}

function assertReviewedAutoBands(
  resource: ExplorationBoundaryDraft["pack"]["resources"][number],
): void {
  const definitions = resource.auto_bands ?? [];
  if (definitions.length > 16) throw new Error(`${resource.id} may review at most 16 auto-band policies.`);
  const fields = new Set<string>();
  for (const definition of definitions) {
    const normalized = normalizeExplorationAutoBandPolicy(
      definition,
      `${resource.id}.${definition.field || "auto_band"}`,
    );
    if (fields.has(normalized.field)) throw new Error(`${resource.id} auto-band fields must be unique.`);
    fields.add(normalized.field);
    if (!resource.aggregate_measures.includes(normalized.field)) {
      throw new Error(`${resource.id}.${normalized.field} is not a reviewed numeric aggregate field.`);
    }
    if ((resource.model_withheld_fields ?? []).includes(normalized.field)
      || resource.kept_out_fields.includes(normalized.field)) {
      throw new Error(`${resource.id}.${normalized.field} must be model-visible before it can expose adaptive band labels.`);
    }
  }
}

export function assertReviewedAutoBandForBoundary(
  boundary: ExplorationBoundaryDraft,
  resourceId: string,
  definition: ExplorationAutoBandPolicy,
): void {
  const resource = boundary.pack.resources.find((candidate) => candidate.id === resourceId);
  if (!resource) throw new Error(`${resourceId} is no longer in the reviewed boundary.`);
  assertReviewedAutoBands({ ...resource, auto_bands: [structuredClone(definition)] });
}

function derivedBaseMeasureRelationship(
  measure: ExplorationDerivedBaseMeasure,
): string | undefined {
  return "relationship" in measure ? measure.relationship : undefined;
}

function assertDerivedBaseMeasure(
  root: ExplorationBoundaryDraft["pack"]["resources"][number],
  name: string,
  operand: ExplorationDerivedBaseMeasure,
  resources: ExplorationBoundaryDraft["pack"]["resources"],
): void {
  if (!["count", "count_distinct", "sum", "avg"].includes(operand.function)) {
    throw new Error(`${root.id}.${name} contains an unsupported base measure.`);
  }
  if (operand.function === "count") {
    if ("field" in operand || "relationship" in operand) {
      throw new Error(`${root.id}.${name} COUNT operand must count the reviewed root entity.`);
    }
    return;
  }
  const relationship = operand.relationship
    ? root.relationships.find((candidate) => candidate.id === operand.relationship)
    : undefined;
  if (operand.relationship && !relationship) {
    throw new Error(`${root.id}.${name} references an unreviewed relationship ${operand.relationship}.`);
  }
  const targetId = relationship?.target_resource ?? root.id;
  const target = resources.find((candidate) => candidate.id === targetId);
  if (!target) throw new Error(`${root.id}.${name} operand target ${targetId} is not in this boundary.`);
  if (operand.function === "count_distinct") {
    if (!target.count_distinct_fields.includes(operand.field)) {
      throw new Error(`${root.id}.${name} uses an unreviewed count-distinct field ${target.id}.${operand.field}.`);
    }
    return;
  }
  if (!target.aggregate_measures.includes(operand.field)
    || !(target.aggregate_measure_functions?.[operand.field] ?? ["sum", "avg"]).includes(operand.function)) {
    throw new Error(`${root.id}.${name} uses an unreviewed ${operand.function} field ${target.id}.${operand.field}.`);
  }
}

function assertReviewedResourceScope(
  resource: ExplorationBoundaryDraft["pack"]["resources"][number],
  resources: Map<string, ExplorationBoundaryDraft["pack"]["resources"][number]>,
  singleOrganization: boolean,
  maximumHops: 1 | 2 | 3,
): void {
  if (singleOrganization
    && (resource.tenant_key || resource.tenant_scope || resource.shared_reference_scope)) {
    throw new Error(`${resource.id} cannot declare tenant scope inside a single-organization boundary.`);
  }
  const tenantModes = [
    resource.tenant_key,
    resource.tenant_scope,
    resource.shared_reference_scope,
  ].filter(Boolean).length;
  if (!singleOrganization && tenantModes !== 1) {
    throw new Error(
      `${resource.id} must have exactly one direct, derived, or shared-reference tenant scope.`,
    );
  }
  if (resource.shared_reference_scope
    && (resource.shared_reference_scope.mode !== "shared_reference"
      || resource.shared_reference_scope.acknowledgement
        !== SHARED_REFERENCE_ACKNOWLEDGEMENT)) {
    throw new Error(`${resource.id} has malformed shared-reference scope authority.`);
  }
  if (resource.principal_key && resource.principal_scope) {
    throw new Error(`${resource.id} cannot have both direct and derived principal scope.`);
  }
  if (resource.tenant_scope) {
    assertDerivedScopePath(resource, resource.tenant_scope, resources, "tenant", maximumHops);
  }
  if (resource.principal_scope) {
    assertDerivedScopePath(resource, resource.principal_scope, resources, "principal", maximumHops);
  }
}

function assertDerivedScopePath(
  resource: ExplorationBoundaryDraft["pack"]["resources"][number],
  scope: DerivedScopePath,
  resources: Map<string, ExplorationBoundaryDraft["pack"]["resources"][number]>,
  kind: "tenant" | "principal",
  maximumHops: 1 | 2 | 3,
): void {
  const links = scope.proof?.links ?? [];
  if (links.length > maximumHops) {
    throw new Error(
      `${resource.id} derived ${kind} scope uses ${links.length} hops, but the reviewed `
      + `max_derived_scope_hops is ${maximumHops}. Raise that reviewed limit to ${links.length} `
      + "and activate the exact revision before adding this resource.",
    );
  }
  if (scope.mode !== "derived"
    || scope.proof.source !== "database_catalog"
    || links.length < 1
    || canonicalJsonDigest(links) !== scope.proof.digest
    || scope.path_id !== links.map((link) => link.constraint_name).join("__")) {
    throw new Error(`${resource.id} has malformed derived ${kind} scope proof.`);
  }
  let expectedSource = resource.id;
  const visited = new Set([resource.id]);
  for (const link of links) {
    const source = resources.get(link.source_resource);
    const target = resources.get(link.target_resource);
    if (!source || !target
      || link.source_resource !== expectedSource
      || visited.has(link.target_resource)
      || link.nullable
      || link.cardinality !== "many_to_one"
      || link.max_fan_out !== 1
      || link.source_columns.length < 1
      || link.source_columns.length !== link.target_columns.length
      || link.target_uniqueness.columns.length !== link.target_columns.length
      || link.target_uniqueness.columns.some((field, index) => field !== link.target_columns[index])) {
      throw new Error(`${resource.id} derived ${kind} scope is not a continuous non-null many-to-one path inside the reviewed boundary.`);
    }
    expectedSource = target.id;
    visited.add(target.id);
  }
  const ancestor = resources.get(scope.ancestor_resource);
  const directColumn = kind === "tenant" ? ancestor?.tenant_key : ancestor?.principal_key;
  if (expectedSource !== scope.ancestor_resource || directColumn !== scope.ancestor_column) {
    throw new Error(`${resource.id} derived ${kind} scope does not terminate at the reviewed direct ${kind} column.`);
  }
}

function relationshipMatchesReviewedDraft(
  expected: ExplorationRelationship,
  candidate: ExplorationRelationship,
): boolean {
  if (expected.unmatched_rows !== "review_required") {
    return canonicalJsonDigest(candidate) === canonicalJsonDigest(expected);
  }
  if (candidate.unmatched_rows !== "exclude" && candidate.unmatched_rows !== "keep_null") return false;
  const { unmatched_rows: _expectedUnmatched, ...expectedRest } = expected;
  const { unmatched_rows: _candidateUnmatched, ...candidateRest } = candidate;
  return canonicalJsonDigest(candidateRest) === canonicalJsonDigest(expectedRest);
}

export function requiredReviewDecisionsForCandidate(
  draft: ExplorationBoundaryDraft,
  candidate: ExplorationBoundaryDraft,
): string[] {
  const retained = new Map(candidate.pack.resources.map((resource) => [resource.id, resource]));
  return draft.unresolved_decisions.filter((decision) => {
    if (decision.startsWith("deployment profile:")
      || decision.startsWith("organization scope:")
      || decision.startsWith("trusted context:")
      || decision.startsWith("database role:")) return true;
    const separator = decision.indexOf(": ");
    if (separator < 1) return true;
    const resourceId = decision.slice(0, separator);
    const resource = retained.get(resourceId);
    if (!resource) return false;
    const relationship = /^review relationship (.+) cardinality and scope on (.+)$/.exec(
      decision.slice(separator + 2),
    );
    if (!relationship) return true;
    return resource.relationships.some((item) =>
      item.id === relationship[1] && item.target_resource === relationship[2]);
  });
}

function assertExactDecisionReview(
  required: string[],
  confirmed: string[],
  legacyComplete?: string[],
): string[] {
  if (!Array.isArray(confirmed) || confirmed.some((decision) => typeof decision !== "string")) {
    throw new Error("Boundary activation requires an explicit confirmation for every generated review decision.");
  }
  const normalizedRequired = [...new Set(required)].sort();
  const normalizedConfirmed = [...new Set(confirmed)].sort();
  const normalizedLegacy = legacyComplete ? [...new Set(legacyComplete)].sort() : undefined;
  const exactCurrent = JSON.stringify(normalizedConfirmed) === JSON.stringify(normalizedRequired);
  const exactLegacy = normalizedLegacy
    ? JSON.stringify(normalizedConfirmed) === JSON.stringify(normalizedLegacy)
    : false;
  if (normalizedConfirmed.length !== confirmed.length || (!exactCurrent && !exactLegacy)) {
    throw new Error("Boundary activation requires the exact complete set of generated review decisions.");
  }
  return normalizedRequired;
}

function assertBudgetsNarrow(draft: ExplorationBudgets, candidate: ExplorationBudgets): void {
  for (const key of Object.keys(candidate) as Array<keyof ExplorationBudgets>) {
    if (!Object.hasOwn(draft, key)) {
      const ceiling = ownerReviewableExplorationBudgetCeiling(key);
      if (ceiling === undefined) {
        throw new Error(`Exploration budget ${key} cannot be added during review.`);
      }
      if (!Number.isSafeInteger(candidate[key])
        || Number(candidate[key]) < 1
        || Number(candidate[key]) > ceiling) {
        throw new Error(`Exploration budget ${key} exceeds its hard reviewed ceiling ${ceiling}.`);
      }
    }
  }
  for (const key of Object.keys(draft) as Array<keyof ExplorationBudgets>) {
    const value = candidate[key];
    const generated = draft[key];
    const reviewedCeiling = ownerReviewableExplorationBudgetCeiling(key);
    if (!Number.isSafeInteger(value) || !Number.isSafeInteger(generated)
      || Number(value) < 1
      || Number(value) > (reviewedCeiling ?? Number(generated))) {
      throw new Error(reviewedCeiling === undefined
        ? `Exploration budget ${key} may only stay the same or decrease.`
        : `Exploration budget ${key} exceeds its hard reviewed ceiling ${reviewedCeiling}.`);
    }
  }
  if (candidate.max_ranked_groups !== undefined
    && candidate.max_ranked_groups < candidate.max_groups) {
    throw new Error("Exploration budget max_ranked_groups cannot be lower than max_groups.");
  }
  if (candidate.max_top_n > candidate.max_groups) {
    throw new Error("Exploration budget max_top_n cannot exceed max_groups.");
  }
  if (reviewedDerivedScopeHopLimit(candidate) > 3
    || reviewedAnalysisRelationshipHopLimit(candidate) > 3) {
    throw new Error("Exploration relationship paths are hard-capped at three proven hops.");
  }
}

export function reviewedRankedGroupLimit(budgets: ExplorationBudgets): number {
  return budgets.max_ranked_groups ?? budgets.max_groups;
}

function assertExploreRolePosture(inspection: SchemaInspection, candidate: ExplorationBoundaryDraft): void {
  assertDatabaseRoleSafeForModelReads({
    inspection,
    statePreserved: "The reviewed boundary was not activated, existing active authority remains unchanged, and the source database was not changed.",
  });
  const tables = new Map(inspection.tables.map((table) => [`${table.schema}.${table.name}`, table]));
  for (const resource of candidate.pack.resources) {
    const table = tables.get(resource.id);
    const posture = table?.role_posture;
    if (!table || !posture || posture.current_role_is_owner || posture.current_role_can_assume_owner) {
      throw new Error(`Scoped Explore cannot prove non-owner role posture for ${resource.id}.`);
    }
    if (!posture.privileges.select || posture.privileges.insert || posture.privileges.update || posture.privileges.delete || posture.privileges.truncate || posture.privileges.trigger) {
      throw new Error(`Scoped Explore requires SELECT-only authority for ${resource.id}.`);
    }
    if (table.row_level_security === true && posture.row_security_effective_for_current_role !== true) {
      throw new Error(`Configured RLS does not constrain the exact exploration role for ${resource.id}.`);
    }
  }
}

function assertSubset<T>(values: T[], allowed: T[], label: string): void {
  if (new Set(values).size !== values.length) throw new Error(`${label} cannot contain duplicates.`);
  const set = new Set(allowed);
  if (values.some((value) => !set.has(value))) throw new Error(`${label} may not widen the generated draft.`);
}

function assertKeptOutUnavailable(
  resource: ExplorationBoundaryDraft["pack"]["resources"][number],
): void {
  const withheld = new Set(resource.model_withheld_fields ?? []);
  for (const field of resource.kept_out_fields) {
    if (withheld.has(field)) {
      throw new Error(`${resource.id} field ${field} cannot be both kept out and withheld from the model.`);
    }
    if (resource.selectable_fields.includes(field)
      || Object.hasOwn(resource.filterable_fields, field)
      || resource.sortable_fields.includes(field)
      || resource.groupable_fields.includes(field)
      || resource.aggregate_measures.includes(field)
      || resource.count_distinct_fields.includes(field)
      || Object.hasOwn(resource.time_bucket_fields, field)) {
      throw new Error(`${resource.id} kept-out field ${field} cannot retain read, filter, sort, group, aggregate, count-distinct, or time-bucket authority.`);
    }
  }
}

function cryptoRandomSuffix(): string {
  return crypto.randomBytes(6).toString("hex");
}

type ExistingScopeEvidence = {
  primary: Array<{ value: string; detail: string }>;
  tenant: Array<{ value: string; detail: string }>;
  principal: Array<{ value: string; detail: string }>;
};

type RankedScopeCandidate = {
  value: string;
  score: number;
  confidence: InferenceConfidence;
  evidence: string[];
  structurally_supported: boolean;
};

const TENANT_SCOPE_NAME = /^(?:tenant|tenant_id|tenantid|organization_id|org_id|workspace_id|account_id|merchant_id|store_id|company_id|team_id|facility_id|property_id|clinic_id|project_id)$/i;
const REVIEWABLE_TENANT_SCOPE_NAME = /^(?:tenant|tenant_id|tenantid|organization_id|org_id|workspace_id|account_id|merchant_id|store_id|company_id|team_id|facility_id|hospital_id|property_id|clinic_id|project_id)$/i;
const PRINCIPAL_SCOPE_NAME = /^(?:principal|principal_id|user_id|owner_id|assignee_id|assigned_[a-z0-9_]+_id|agent_id|staff_id|technician_id|manager_id|trainer_id|customer_id|patient_id)$/i;
const TENANT_RELATION_TARGET = /^(?:tenants?|organizations?|orgs?|workspaces?|merchants?|stores?|companies?|teams?|facilities?|properties?|clinics?|projects?)$/i;
const PRINCIPAL_RELATION_TARGET = /^(?:users?|principals?|owners?|assignees?|agents?|staff|staff_members?|technicians?|managers?|trainers?)$/i;

function existingScopeEvidence(table: TableInfo, contracts: SynapsorContract[]): ExistingScopeEvidence {
  const result: ExistingScopeEvidence = { primary: [], tenant: [], principal: [] };
  for (const contract of contracts) {
    const label = contract.metadata?.name
      ? `${contract.metadata.name}${contract.metadata.version ? `@${contract.metadata.version}` : ""}`
      : "canonical contract";
    const sourceLabel = /^existing\b/i.test(label)
      ? `Synapsor ${label}`
      : `Synapsor contract ${label}`;
    const resources = new Map((contract.resources ?? []).map((resource) => [resource.name, resource]));
    for (const resource of contract.resources ?? []) {
      if (resource.schema !== table.schema || resource.table !== table.name) continue;
      result.primary.push({ value: resource.primary_key, detail: `${sourceLabel} resource ${resource.name} declares primary key ${resource.primary_key}` });
      if (resource.tenant_key) {
        result.tenant.push({ value: resource.tenant_key, detail: `${sourceLabel} resource ${resource.name} declares tenant key ${resource.tenant_key}` });
      }
    }
    for (const capability of contract.capabilities) {
      const referenced = capability.subject.resource ? resources.get(capability.subject.resource) : undefined;
      const schema = capability.subject.schema ?? referenced?.schema;
      const targetTable = capability.subject.table ?? referenced?.table;
      if (schema !== table.schema || targetTable !== table.name) continue;
      const primary = capability.subject.primary_key ?? referenced?.primary_key;
      const tenant = capability.subject.tenant_key ?? referenced?.tenant_key;
      if (primary) {
        result.primary.push({ value: primary, detail: `${sourceLabel} capability ${capability.name} declares primary key ${primary}` });
      }
      if (tenant) {
        result.tenant.push({ value: tenant, detail: `${sourceLabel} capability ${capability.name} declares tenant key ${tenant}` });
      }
      if (capability.subject.principal_scope_key) {
        result.principal.push({
          value: capability.subject.principal_scope_key,
          detail: `${sourceLabel} capability ${capability.name} declares principal scope ${capability.subject.principal_scope_key}`,
        });
      }
    }
  }
  return {
    primary: uniqueScopeEvidence(result.primary),
    tenant: uniqueScopeEvidence(result.tenant),
    principal: uniqueScopeEvidence(result.principal),
  };
}

function uniqueScopeEvidence(values: Array<{ value: string; detail: string }>): Array<{ value: string; detail: string }> {
  return [...new Map(values.map((item) => [`${item.value}\u0000${item.detail}`, item])).values()]
    .sort((left, right) => `${left.value}:${left.detail}`.localeCompare(`${right.value}:${right.detail}`));
}

function rankedScopeInference(input: {
  kind: "tenant" | "principal";
  table: TableInfo;
  inspection: SchemaInspection;
  staticObjects: Array<{ format: SchemaCandidateFormat; object: CandidateObject }>;
  existing: ExistingScopeEvidence;
  configuredBinding?: string;
}): BoundaryInference<string> {
  const { kind, table, inspection, staticObjects, existing } = input;
  const columns = new Set(table.columns.map((column) => column.name));
  const candidates = new Map<string, {
    score: number;
    evidence: Set<string>;
    strong: boolean;
    confidence: InferenceConfidence;
  }>();
  const add = (
    value: string,
    score: number,
    detail: string,
    options: { strong?: boolean; confidence?: InferenceConfidence } = {},
  ) => {
    if (!columns.has(value)) return;
    const current = candidates.get(value) ?? { score: 0, evidence: new Set<string>(), strong: false, confidence: "low" as const };
    current.score += score;
    current.evidence.add(detail);
    current.strong ||= options.strong === true;
    if (options.confidence === "high" || (options.confidence === "medium" && current.confidence === "low")) {
      current.confidence = options.confidence;
    }
    candidates.set(value, current);
  };
  const namePattern = kind === "tenant" ? REVIEWABLE_TENANT_SCOPE_NAME : PRINCIPAL_SCOPE_NAME;
  const configuredBinding = input.configuredBinding?.trim();
  const configuredColumn = configuredBinding
    ? table.columns.find((column) => column.name === configuredBinding)
    : undefined;
  if (configuredColumn
    && configuredColumn.nullable === false
    && configuredColumn.suggestions.large_or_binary !== true
    && !isUnsafeRawType(configuredColumn.data_type)) {
    add(
      configuredColumn.name,
      120,
      `Runner config ${kind}_binding explicitly names inspected non-null column ${configuredColumn.name}; exact boundary review is still required`,
      { strong: true, confidence: "high" },
    );
  }
  for (const column of table.columns) {
    if (namePattern.test(column.name)) {
      add(column.name, 5, `column name ${column.name} matches a low-confidence ${kind} convention`);
    }
  }
  const inspectorSuggestions = kind === "tenant" ? table.suggestions.tenant_columns : [];
  for (const candidate of inspectorSuggestions) {
    add(candidate, 5, `database inspector suggested ${candidate} from naming metadata`);
  }
  for (const item of staticObjects) {
    const values = kind === "tenant" ? item.object.tenant_candidates : item.object.principal_candidates;
    for (const candidate of values) {
      add(candidate, 10, `${item.format} object ${item.object.name} suggests ${candidate}; structured source names do not prove authority`);
    }
  }
  const reviewed = kind === "tenant" ? existing.tenant : existing.principal;
  for (const item of reviewed) {
    add(item.value, 100, item.detail, { strong: true, confidence: "high" });
  }
  for (const column of table.columns) {
    const matchingPolicies = (table.row_level_security_policies ?? [])
      .filter((policy) => policyAppliesToInspectedRole(policy.roles, inspection.current_user))
      .filter((policy) => policy.using_expression && rlsExpressionSupportsScope(policy.using_expression, column.name, kind));
    for (const policy of matchingPolicies) {
      add(
        column.name,
        70,
        `active RLS policy ${policy.name} references ${column.name}: ${policy.using_expression}`,
        { strong: true, confidence: "high" },
      );
    }
  }
  const targetPattern = kind === "tenant" ? TENANT_RELATION_TARGET : PRINCIPAL_RELATION_TARGET;
  for (const foreignKey of table.foreign_keys) {
    if (!targetPattern.test(foreignKey.referenced_table)) continue;
    for (const column of foreignKey.columns) {
      add(
        column,
        35,
        kind === "principal"
          ? `foreign key ${foreignKey.name} maps ${column} to ${foreignKey.referenced_schema}.${foreignKey.referenced_table}; the relationship suggests identity but does not prove per-principal authorization`
          : `foreign key ${foreignKey.name} maps ${column} to ${foreignKey.referenced_schema}.${foreignKey.referenced_table}`,
        { strong: kind === "tenant", confidence: "medium" },
      );
    }
  }
  for (const [column, count] of repeatedColumnCounts(inspection)) {
    if (count < 2 || !columns.has(column) || !namePattern.test(column)) continue;
    add(column, Math.min(20, 4 + count), `${column} repeats across ${count} inspected resources; repetition is supporting evidence only`);
  }
  const ranked: RankedScopeCandidate[] = [...candidates.entries()]
    .map(([value, candidate]) => ({
      value,
      score: candidate.score,
      confidence: candidate.confidence,
      evidence: [...candidate.evidence].sort(),
      structurally_supported: candidate.strong,
    }))
    .sort((left, right) => right.score - left.score || left.value.localeCompare(right.value));
  const winner = ranked[0];
  const runnerUp = ranked[1];
  const selected = winner?.structurally_supported
    && (!runnerUp || winner.score > runnerUp.score)
    ? winner.value
    : undefined;
  const evidence = ranked.flatMap((candidate) => candidate.evidence.map((detail) => ({
    source: evidenceSource(detail),
    detail: `${candidate.value}: ${detail}`,
  })));
  const blockedReason = selected
    ? undefined
    : ranked.length === 0
      ? `No ${kind} scope candidate was found in reviewed contracts, database enforcement, keys, or supported static schemas.`
      : ranked.some((candidate) => candidate.structurally_supported)
        ? `Multiple structurally plausible ${kind} scope candidates remain; a human must choose one.`
        : kind === "principal"
          ? "Only descriptive schema evidence exists for principal scope; names and relationships do not prove per-principal authorization."
          : `Only naming or repetition evidence exists for ${kind} scope; names alone cannot grant cross-row authority.`;
  return inference(
    selected,
    ranked.map((candidate) => candidate.value),
    evidence,
    winner?.confidence === "high" && selected === winner.value,
    kind === "tenant"
      ? "The wrong tenant key can cause cross-tenant reads; confirmation is mandatory."
      : "An incorrect owner or assignee key can expose another principal's row.",
    {
      alternatives: ranked.map((candidate) => ({
        value: candidate.value,
        confidence: candidate.confidence,
        evidence: candidate.evidence,
        selected: candidate.value === selected,
      })),
      confidence: selected ? winner!.confidence : "low",
      ...(blockedReason ? { blockedReason } : {}),
    },
  );
}

function policyAppliesToInspectedRole(roles: string[], currentUser: string): boolean {
  return roles.some((role) => role === "public" || role === currentUser);
}

function evidenceSource(detail: string): BoundaryInference<string>["evidence"][number]["source"] {
  if (detail.startsWith("prisma ")) return "prisma";
  if (detail.startsWith("drizzle ")) return "drizzle";
  if (detail.startsWith("openapi ")) return "openapi";
  if (detail.startsWith("Runner config")
    || detail.startsWith("existing Synapsor")
    || detail.includes("contract")
    || detail.includes("capability")) return "synapsor";
  return "database";
}

function repeatedColumnCounts(inspection: SchemaInspection): Map<string, number> {
  const counts = new Map<string, number>();
  for (const table of inspection.tables) {
    for (const column of new Set(table.columns.map((candidate) => candidate.name))) {
      counts.set(column, (counts.get(column) ?? 0) + 1);
    }
  }
  return counts;
}

function expressionReferencesColumn(expression: string, column: string): boolean {
  const escaped = column.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[^A-Za-z0-9_$])(?:"${escaped}"|${escaped})(?:$|[^A-Za-z0-9_$])`, "i").test(expression);
}

function rlsExpressionSupportsScope(
  expression: string,
  column: string,
  kind: "tenant" | "principal",
): boolean {
  if (!expressionReferencesColumn(expression, column)) return false;
  const setting = settingForScopedColumn([expression], column) ?? "";
  const columnPattern = kind === "tenant" ? TENANT_SCOPE_NAME : PRINCIPAL_SCOPE_NAME;
  // A familiar column name cannot override an explicit opposite identity
  // binding in the inspected predicate (for example account_id -> principal).
  if (settingNameSupportsScope(setting, kind === "tenant" ? "principal" : "tenant")) return false;
  return settingNameSupportsScope(setting, kind) || columnPattern.test(column);
}

function buildResource(
  table: TableInfo,
  inspection: SchemaInspection,
  staticObjects: Array<{ format: SchemaCandidateFormat; object: CandidateObject }>,
  existing: ExistingScopeEvidence,
  configuredTrustedContext?: ConfiguredTrustedContextAuthority,
): AutoBoundaryResource {
  const tablesById = new Map(inspection.tables.map((candidate) => [
    `${candidate.schema}.${candidate.name}`,
    candidate,
  ]));
  const sourceColumns = new Set(table.columns.map((column) => column.name));
  const sourceProvenUniqueIdentifiers = unique([
    ...(table.primary_key.length === 1 ? table.primary_key : []),
    ...table.unique_constraints.filter((constraint) => constraint.columns.length === 1).map((constraint) => constraint.columns[0]!),
    ...table.indexes.filter((index) => index.unique === true && index.columns?.length === 1).map((index) => index.columns![0]!),
  ]);
  const primaryCandidates = sourceProvenUniqueIdentifiers;
  const primarySelected = table.primary_key.length === 1
    ? table.primary_key[0]
    : sourceProvenUniqueIdentifiers.length === 1
      ? sourceProvenUniqueIdentifiers[0]
      : undefined;
  const tenantInference = rankedScopeInference({
    kind: "tenant",
    table,
    inspection,
    staticObjects,
    existing,
    ...(configuredTrustedContext?.tenant_binding
      ? { configuredBinding: configuredTrustedContext.tenant_binding }
      : {}),
  });
  const principalInference = rankedScopeInference({
    kind: "principal",
    table,
    inspection,
    staticObjects,
    existing,
    ...(configuredTrustedContext?.principal_binding
      ? { configuredBinding: configuredTrustedContext.principal_binding }
      : {}),
  });
  const tenantSelected = tenantInference.selected;
  const principalSelected = principalInference.selected;
  const rlsUsingExpressions = (table.row_level_security_policies ?? [])
    .flatMap((policy) => policy.using_expression ? [policy.using_expression] : [])
    .sort();
  const principalSettingCandidates = rlsPrincipalSettingCandidates(rlsUsingExpressions);
  const posture = table.role_posture;
  const writeCapable = posture
    ? posture.privileges.insert || posture.privileges.update || posture.privileges.delete || posture.privileges.truncate || posture.privileges.trigger
    : true;
  const blockers = [
    ...(!primarySelected ? ["source-proven single-column primary or unique row identifier is unresolved"] : []),
    ...(!tenantSelected ? ["trusted tenant scope is unresolved"] : []),
  ];
  const status: AutoBoundaryResource["status"] = !primarySelected
    ? "blocked_identifier"
    : !tenantSelected
      ? "blocked_scope"
      : "draft_read";
  const evidence = staticObjects.map((item) => `${item.format}:${item.object.name}`);
  return {
    id: `${table.schema}.${table.name}`,
    schema: table.schema,
    table: table.name,
    type: table.type,
    ...(table.approximate_row_count === undefined
      ? {}
      : { approximate_row_count: table.approximate_row_count }),
    primary_key: inference(primarySelected, primaryCandidates, [
      { source: "database", detail: `inspected primary key: ${table.primary_key.join(", ") || "none"}` },
      { source: "database", detail: `inspected single-column unique identifiers: ${sourceProvenUniqueIdentifiers.join(", ") || "none"}` },
      ...existing.primary
        .filter((item) => sourceColumns.has(item.value))
        .map((item) => ({ source: "synapsor" as const, detail: item.detail })),
      ...evidence.map((detail) => ({ source: sourceKind(detail), detail })),
    ], Boolean(primarySelected), "The wrong identifier could select a different row or make one-row guarantees impossible.", {
      ...(!primarySelected
        ? { blockedReason: "The database does not prove one single-column primary or unique key; a friendly field name is not enough." }
        : {}),
    }),
    tenant_key: tenantInference,
    principal_key: principalInference,
    fields: table.columns.map((column): AutoBoundaryField => {
      const deterministicClassification = classifySensitivity({
        name: column.name,
        dataType: column.data_type,
        constrainedValues: column.enum_values,
        description: column.comment,
        source: "database",
      });
      const staticClassifications = staticObjects.flatMap((item) =>
        item.object.fields
          .filter((field) => field.name === column.name)
          .map((field) => field.sensitivity));
      const sensitivity = [
        deterministicClassification,
        ...(column.suggestions.sensitivity
          ? [column.suggestions.sensitivity]
          : []),
        ...staticClassifications,
      ]
        .filter((classification) => !nameOnlySensitivityRefutedByStructure(
          classification,
          deterministicClassification,
        ))
        .reduce(moreRestrictiveSensitivity);
      const keptOutByClassification = sensitivity.state !== "structurally_low_risk";
      return {
        name: column.name,
        data_type: column.data_type,
        ...(column.enum_values?.length ? { enum_values: [...column.enum_values] } : {}),
        nullable: column.nullable,
        primary_key: table.primary_key.includes(column.name),
        sensitive_suggestion: keptOutByClassification,
        sensitivity,
        raw_visible_suggestion: !keptOutByClassification && !column.suggestions.large_or_binary,
        aggregate_measure_suggestion: !keptOutByClassification
          && isNumericType(column.data_type)
          && isAnalyticalNumericMeasureName(column.name),
        count_distinct_suggestion: !keptOutByClassification
          && (table.primary_key.includes(column.name) || isReferenceIdentifierName(column.name)),
        groupable_suggestion: !keptOutByClassification
          && !table.primary_key.includes(column.name)
          && !isReferenceIdentifierName(column.name)
          && isCategoricalType(column.data_type, column.enum_values),
        time_bucket_suggestion: !keptOutByClassification && isTimestampType(column.data_type),
        evidence: [
          `database column ${column.name} ${column.data_type}`,
          ...sensitivity.reasons.map((reason) => `${sensitivity.evidence_source} classification: ${reason}`),
          ...(column.enum_values?.length ? [`database enum values: ${column.enum_values.join(", ")}`] : []),
          ...evidence,
        ],
      };
    }),
    relationships: table.foreign_keys.map((foreignKey) => {
      const target = tablesById.get(`${foreignKey.referenced_schema}.${foreignKey.referenced_table}`);
      const targetUniqueness = target
        ? relationshipTargetUniqueness(target, foreignKey.referenced_columns)
        : undefined;
      return {
        name: foreignKey.name,
        columns: foreignKey.columns,
        referenced_resource: `${foreignKey.referenced_schema}.${foreignKey.referenced_table}`,
        referenced_columns: foreignKey.referenced_columns,
        reviewed_cardinality: "many_to_one_candidate" as const,
        review_required: true as const,
        nullable: foreignKey.columns.some((name) =>
          table.columns.find((column) => column.name === name)?.nullable !== false),
        cardinality_proven: Boolean(targetUniqueness),
        ...(targetUniqueness ? { target_uniqueness: targetUniqueness } : {}),
      };
    }),
    rls: {
      enabled: table.row_level_security ?? "unknown",
      forced: posture?.row_security_forced ?? (inspection.engine === "postgres" ? "unknown" : "unsupported"),
      effective_for_current_role: posture?.row_security_effective_for_current_role ?? (inspection.engine === "postgres" ? "unknown" : "unsupported"),
      policy_names: (table.row_level_security_policies ?? []).map((policy) => policy.name).sort(),
      using_expressions: rlsUsingExpressions,
      ...(principalSettingCandidates.length
        ? { principal_setting_candidates: principalSettingCandidates }
        : {}),
    },
    role_posture: {
      read_only: Boolean(posture?.privileges.select) && !writeCapable,
      owner: posture?.current_role_is_owner ?? false,
      can_assume_owner: posture?.current_role_can_assume_owner ?? false,
      write_capable: writeCapable,
      verified: Boolean(posture),
    },
    status,
    blockers,
  };
}

function relationshipTargetUniqueness(
  target: TableInfo,
  columns: string[],
): RelationshipLinkProof["target_uniqueness"] | undefined {
  const sameColumns = (candidate: string[]) =>
    candidate.length === columns.length && candidate.every((column, index) => column === columns[index]);
  if (sameColumns(target.primary_key)) {
    const named = target.unique_constraints.find((constraint) => sameColumns(constraint.columns))
      ?? target.indexes.find((index) => index.unique === true && sameColumns(index.columns ?? []));
    return {
      kind: "primary_key",
      name: named?.name ?? `${target.schema}.${target.name}.primary_key`,
      columns: [...columns],
    };
  }
  const constraint = target.unique_constraints.find((candidate) => sameColumns(candidate.columns));
  if (constraint) {
    return {
      kind: "unique_constraint",
      name: constraint.name,
      columns: [...columns],
    };
  }
  const index = target.indexes.find((candidate) =>
    candidate.unique === true && sameColumns(candidate.columns ?? []));
  if (index) {
    return {
      kind: "unique_index",
      name: index.name,
      columns: [...columns],
    };
  }
  return undefined;
}

function emitDraftDsl(graph: AutoBoundaryEvidenceGraph, sourceName: string): string {
  const lines = [
    "CREATE AGENT CONTEXT generated_operator",
    "  BIND tenant_id FROM ENVIRONMENT SYNAPSOR_TENANT_ID REQUIRED",
    "  BIND principal FROM ENVIRONMENT SYNAPSOR_PRINCIPAL REQUIRED",
    "  TENANT BINDING tenant_id",
    "  PRINCIPAL BINDING principal",
    "END",
    "",
  ];
  for (const resource of graph.resources.filter((candidate) =>
    candidate.status === "draft_read" && Boolean(candidate.tenant_key.selected))) {
    const primaryKey = resource.primary_key.selected!;
    const tenantKey = resource.tenant_key.selected!;
    const principalKey = resource.principal_key.selected;
    const object = singularize(resource.table);
    const capabilityName = `${safeNamespace(resource.schema)}.inspect_${safeIdentifier(object)}`;
    const trustedScopeFields = new Set([tenantKey, principalKey].filter((field): field is string => Boolean(field)));
    let lookupArg = `${safeIdentifier(object)}_id`;
    // A generated lookup is not a trusted identity input, even when the table
    // name naturally produces the same identifier as its principal column.
    if (trustedScopeFields.has(lookupArg)) {
      const base = `${safeIdentifier(object)}_lookup_id`;
      const occupied = new Set(resource.fields.map((field) => field.name));
      lookupArg = base;
      for (let suffix = 2; occupied.has(lookupArg); suffix++) lookupArg = `${base}_${suffix}`;
    }
    const trustedScopeReadableFields = reviewedTrustedScopeReadableFields(resource);
    const keptOut = unique([
      ...resource.fields.filter((field) => field.sensitive_suggestion || !field.raw_visible_suggestion).map((field) => field.name),
      ...[...trustedScopeFields].filter((field) => !trustedScopeReadableFields.has(field)),
    ]);
    const visible = unique([
      ...(!trustedScopeFields.has(primaryKey) || trustedScopeReadableFields.has(primaryKey) ? [primaryKey] : []),
      ...resource.fields
        .filter((field) => field.raw_visible_suggestion
          && (!trustedScopeFields.has(field.name) || trustedScopeReadableFields.has(field.name)))
        .map((field) => field.name),
    ]).filter((field) => !keptOut.includes(field));
    const modelWithheld = resource.fields
      .filter((field) =>
        field.review_override?.exposure === "withhold_from_model"
        && visible.includes(field.name))
      .map((field) => field.name);
    lines.push(
      `CREATE CAPABILITY ${capabilityName}`,
      `  DESCRIPTION '${escapeDslString(`Inspect one ${humanize(object)} inside the reviewed trusted tenant boundary.`)}'`,
      `  RETURNS HINT '${escapeDslString(`Returns reviewed ${humanize(object)} fields plus evidence and query-audit handles; it never exposes raw SQL.`)}'`,
      "  USING CONTEXT generated_operator",
      `  SOURCE ${safeIdentifier(sourceName)}`,
      `  ON ${safeIdentifier(resource.schema)}.${safeIdentifier(resource.table)}`,
      `  PRIMARY KEY ${safeIdentifier(primaryKey)}`,
      `  TENANT KEY ${safeIdentifier(tenantKey)}`,
      ...(principalKey ? [`  PRINCIPAL SCOPE KEY ${safeIdentifier(principalKey)}`] : []),
      `  LOOKUP ${lookupArg} BY ${safeIdentifier(primaryKey)}`,
      `  ARG ${lookupArg} STRING REQUIRED MAX LENGTH 128 DESCRIPTION 'Reviewed ${escapeDslString(humanize(object))} identifier.'`,
      `  ALLOW READ ${visible.map(safeIdentifier).join(", ")}`,
      ...(modelWithheld.length
        ? [`  MODEL WITHHELD ${modelWithheld.map(safeIdentifier).join(", ")}`]
        : []),
      ...(keptOut.length ? [`  KEEP OUT ${keptOut.map(safeIdentifier).join(", ")}`] : []),
      "  REQUIRE EVIDENCE",
      "  MAX ROWS 1",
      "END",
      "",
    );
  }
  return `${formatAgentDsl(lines.join("\n"))}\n`;
}

function buildExplorationBoundaryDraft(
  graph: AutoBoundaryEvidenceGraph,
  sourceName: string,
  lockFingerprint: `sha256:${string}`,
  options: {
    deploymentProfile: "development" | "staging" | "production";
    configuredTrustedContext: ConfiguredTrustedContextAuthority;
    databaseServerVersion: string;
    databaseServerTier: "full" | "compatible_limited";
    databaseServerAuthority: DatabaseServerAuthority;
    organizationScope?: SingleOrganizationScope;
  },
): ExplorationBoundaryDraft {
  const resources = graph.resources.filter((resource) => resource.status === "draft_read").map((resource) => {
    const trustedScopeFields = new Set([resource.tenant_key.selected, resource.principal_key.selected].filter((field): field is string => Boolean(field)));
    const trustedScopeReadableFields = reviewedTrustedScopeReadableFields(resource);
    const keptOut = unique([
      ...resource.fields.filter((field) => field.sensitive_suggestion || !field.raw_visible_suggestion).map((field) => field.name),
      ...[...trustedScopeFields].filter((field) => !trustedScopeReadableFields.has(field)),
    ]);
    const keptOutSet = new Set(keptOut);
    const modelWithheld = resource.fields
      .filter((field) => field.review_override?.exposure === "withhold_from_model")
      .map((field) => field.name)
      .filter((field) => !keptOutSet.has(field));
    const enumDisabledFields = new Set(resource.fields
      .filter((field) => field.enum_review_override?.values.length === 0)
      .map((field) => field.name));
    const reviewedFieldEnums = Object.fromEntries(resource.fields
      .flatMap((field) => {
        const values = reviewedBoundaryEnumValues(field, keptOutSet, trustedScopeFields);
        return values ? [[field.name, values] as const] : [];
      }));
    const categoricalAnalysisAvailable = (field: AutoBoundaryField): boolean =>
      options.databaseServerAuthority.features.schema_check_constraints
      || !field.groupable_suggestion
      || Boolean(field.exact_numeric_grouping_review_override)
      || Boolean(reviewedFieldEnums[field.name]?.length);
    const selectable = resource.fields
      .filter((field) => field.raw_visible_suggestion
        && (!trustedScopeFields.has(field.name) || trustedScopeReadableFields.has(field.name)))
      .map((field) => field.name);
    const sortable = selectable.filter((field) => !trustedScopeFields.has(field));
    const filterable = Object.fromEntries(resource.fields
      .filter((field) => field.raw_visible_suggestion
        && !trustedScopeFields.has(field.name)
        && !enumDisabledFields.has(field.name)
        && categoricalAnalysisAvailable(field))
      .map((field) => [field.name, operatorsForType(field.data_type)]));
    const relationships = resource.relationships
      .filter((relationship) => {
        const target = graph.resources.find((candidate) => candidate.id === relationship.referenced_resource);
        if (!target
          || target.status !== "draft_read"
          || !relationship.cardinality_proven
          || !relationship.target_uniqueness
          || relationship.columns.length < 1
          || relationship.columns.length !== relationship.referenced_columns.length) {
          return false;
        }
        const targetTrustedFields = new Set([target.tenant_key.selected, target.principal_key.selected]
          .filter((field): field is string => Boolean(field)));
        const targetKeptOut = new Set([
          ...target.fields
            .filter((field) => field.sensitive_suggestion || !field.raw_visible_suggestion)
            .map((field) => field.name),
          ...targetTrustedFields,
        ]);
        // Scope components can remain private in a composite join; this does
        // not permit other excluded columns or replace either table's scope.
        return relationship.columns.every((field, index) => {
          const targetField = relationship.referenced_columns[index]!;
          const trustedScopePair = isReadRelationshipScopePair(
            { tenant_key: resource.tenant_key.selected, principal_key: resource.principal_key.selected },
            { tenant_key: target.tenant_key.selected, principal_key: target.principal_key.selected },
            field, targetField,
          );
          return trustedScopePair || (!keptOutSet.has(field) && !targetKeptOut.has(targetField));
        });
      })
      .sort((left, right) => {
        const score = (relationship: typeof left) => {
          const target = graph.resources.find((candidate) =>
            candidate.id === relationship.referenced_resource);
          return (target?.fields.filter((field) => field.groupable_suggestion).length ?? 0) * 4
            + (target?.fields.filter((field) => field.time_bucket_suggestion).length ?? 0) * 3
            + (target?.fields.filter((field) => field.raw_visible_suggestion).length ?? 0)
            + (relationship.nullable ? 0 : 2);
        };
        return score(right) - score(left) || left.name.localeCompare(right.name);
      })
      .slice(0, MAX_DIRECT_RELATIONSHIP_CANDIDATES_PER_RESOURCE)
      .map((relationship): ExplorationRelationship => {
        const link: RelationshipLinkProof = {
          constraint_name: relationship.name,
          source_resource: resource.id,
          target_resource: relationship.referenced_resource,
          source_columns: [...relationship.columns],
          target_columns: [...relationship.referenced_columns],
          target_uniqueness: structuredClone(relationship.target_uniqueness!),
          nullable: relationship.nullable,
          cardinality: "many_to_one",
          max_fan_out: 1,
        };
        return {
          id: relationship.name,
          target_resource: relationship.referenced_resource,
          local_columns: [...relationship.columns],
          target_columns: [...relationship.referenced_columns],
          counted_entity: resource.primary_key.selected!,
          cardinality: "many_to_one",
          max_fan_out: 1,
          path_depth: 1,
          proof: {
            source: "database_catalog",
            links: [link],
            digest: canonicalJsonDigest([link]),
          },
          nullable: relationship.nullable,
          unmatched_rows: relationship.nullable ? "review_required" : "exclude",
        };
      });
    return {
      id: resource.id,
      schema: resource.schema,
      table: resource.table,
      ...(resource.metadata_review_override?.label
        ? { label: resource.metadata_review_override.label }
        : {}),
      ...(resource.metadata_review_override?.description
        ? { description: resource.metadata_review_override.description }
        : {}),
      ...(resource.fields.some((field) => field.metadata_review_override)
        ? {
          field_metadata: Object.fromEntries(resource.fields
            .filter((field) => field.metadata_review_override)
            .sort((left, right) => left.name.localeCompare(right.name))
            .map((field) => [field.name, {
              ...(field.metadata_review_override!.label
                ? { label: field.metadata_review_override!.label }
                : {}),
              ...(field.metadata_review_override!.description
                ? { description: field.metadata_review_override!.description }
                : {}),
            }])),
        }
        : {}),
      primary_key: resource.primary_key.selected!,
      ...(!options.organizationScope
        ? resource.tenant_key.selected
          ? { tenant_key: resource.tenant_key.selected }
          : resource.derived_tenant_scope?.selected
            ? { tenant_scope: structuredClone(resource.derived_tenant_scope.selected) }
            : {
              shared_reference_scope: structuredClone(
                resource.shared_reference_scope!.selected!,
              ),
            }
        : {}),
      ...(resource.principal_key.selected ? { principal_key: resource.principal_key.selected } : {}),
      ...(!resource.principal_key.selected && resource.derived_principal_scope?.selected
        ? { principal_scope: structuredClone(resource.derived_principal_scope.selected) }
        : {}),
      field_types: Object.fromEntries(resource.fields.map((field) => [field.name, field.data_type])),
      field_enums: reviewedFieldEnums,
      selectable_fields: selectable,
      filterable_fields: filterable,
      sortable_fields: sortable,
      groupable_fields: resource.fields.filter((field) => field.groupable_suggestion
        && !keptOutSet.has(field.name)
        && !trustedScopeFields.has(field.name)
        && !enumDisabledFields.has(field.name)
        && categoricalAnalysisAvailable(field)).map((field) => field.name),
      aggregate_measures: resource.fields.filter((field) => field.aggregate_measure_suggestion
        && !keptOutSet.has(field.name)
        && !trustedScopeFields.has(field.name)).map((field) => field.name),
      aggregate_measure_functions: Object.fromEntries(resource.fields
        .filter((field) => field.aggregate_measure_suggestion
          && !keptOutSet.has(field.name)
          && !trustedScopeFields.has(field.name))
        .map((field) => [field.name, [...EXPLORATION_NUMERIC_AGGREGATE_FUNCTIONS]])),
      presence_measure_fields: selectable.filter((field) =>
        !modelWithheld.includes(field) && !trustedScopeFields.has(field)),
      count_distinct_fields: resource.fields.filter((field) => field.count_distinct_suggestion
        && !keptOutSet.has(field.name)
        && !trustedScopeFields.has(field.name)).map((field) => field.name),
      time_bucket_fields: Object.fromEntries(resource.fields.filter((field) => field.time_bucket_suggestion
        && !keptOutSet.has(field.name)
        && !trustedScopeFields.has(field.name)).map((field) => [
        field.name,
        [...EXPLORATION_TIME_BUCKETS],
      ])),
      kept_out_fields: keptOut,
      ...(modelWithheld.length ? { model_withheld_fields: modelWithheld } : {}),
      relationships,
      ...explorationRlsSession(resource, graph.resources),
      minimum_cohort_size: resource.minimum_cohort_override?.value ?? 5,
      ...(resource.minimum_cohort_override ? { minimum_cohort_overridden: true as const } : {}),
      suppression_aware_totals: true as const,
    };
  });
  addComposedExplorationPaths(resources);
  const databaseRoleTenantSetting = graph.engine === "postgres" && !options.organizationScope
    ? commonDatabaseRoleTenantSetting(resources)
    : undefined;
  const configuredTrustedContext = options.configuredTrustedContext;
  const draft: ExplorationBoundaryDraft = {
    schema_version: EXPLORATION_BOUNDARY_VERSION,
    activation: "disabled_unreviewed" as const,
    deployment_profile: options.deploymentProfile,
    source: sourceName,
    compiler_version: AUTO_BOUNDARY_COMPILER_VERSION,
    spec_version: AUTO_BOUNDARY_SPEC_VERSION,
    database_server_version: options.databaseServerVersion,
    database_server_tier: options.databaseServerTier,
    database_server_authority: structuredClone(options.databaseServerAuthority),
    reporting_timezone: "UTC",
    ...(options.organizationScope ? { organization_scope: options.organizationScope } : {}),
    trusted_context: options.deploymentProfile === "production"
      ? {
        provider: "http_claims" as const,
        ...(configuredTrustedContext.tenant_claim
          ? { tenant_claim: configuredTrustedContext.tenant_claim }
          : {}),
        principal_claim: configuredTrustedContext.principal_claim!,
      }
      : {
        provider: "environment" as const,
        tenant_env: configuredTrustedContext.tenant_env!,
        principal_env: configuredTrustedContext.principal_env!,
        ...(databaseRoleTenantSetting ? {
          database_role_tenant: {
            engine: "postgres" as const,
            setting: databaseRoleTenantSetting,
          },
        } : {}),
      },
    generation_lock_fingerprint: lockFingerprint,
    role_posture_fingerprint: graph.database_role.fingerprint,
    pack: {
      name: options.deploymentProfile === "production" ? "reviewed_production" : "reviewed_staging",
      resources,
    },
    budgets: { ...DEFAULT_REVIEWED_EXPLORATION_BUDGETS },
    unresolved_decisions: [] as string[],
  };
  draft.unresolved_decisions = unresolvedDecisions(graph, draft);
  return draft;
}

function reviewedTrustedScopeReadableFields(resource: AutoBoundaryResource): Set<string> {
  const trustedScopeFields = new Set([
    resource.tenant_key.selected,
    resource.principal_key.selected,
  ].filter((field): field is string => Boolean(field)));
  return new Set(resource.fields
    .filter((field) => trustedScopeFields.has(field.name)
      && (field.review_override?.exposure === "withhold_from_model"
        || field.review_override?.exposure === "allow_reviewed_use"))
    .map((field) => field.name));
}

function commonDatabaseRoleTenantSetting(
  resources: ExplorationBoundaryDraft["pack"]["resources"],
): string | undefined {
  const tenantScoped = resources.filter((resource) => !resource.shared_reference_scope);
  if (tenantScoped.length === 0) return undefined;
  const settings = unique(tenantScoped.map((resource) => resource.rls_session?.tenant_setting)
    .filter((setting): setting is string => Boolean(setting)));
  if (settings.length !== 1) return undefined;
  return tenantScoped.every((resource) => resource.rls_session?.tenant_setting === settings[0])
    ? settings[0]
    : undefined;
}

function addComposedExplorationPaths(
  resources: ExplorationBoundaryDraft["pack"]["resources"],
): void {
  const byId = new Map(resources.map((resource) => [resource.id, resource]));
  const hardDepth = EXPLORATION_BUDGET_REVIEW_CEILINGS.max_analysis_relationship_hops ?? 2;
  for (const root of resources) {
    if (!root.relationships.length) continue;
    const directTargets = new Set(
      root.relationships
        .filter((relationship) => relationship.path_depth === 1)
        .map((relationship) => relationship.target_resource),
    );
    const candidates: ExplorationRelationship[] = [];
    const visit = (
      current: ExplorationBoundaryDraft["pack"]["resources"][number],
      path: ExplorationRelationship[],
      visited: Set<string>,
    ): void => {
      if (path.length >= hardDepth) return;
      for (const next of current.relationships.filter((item) => item.path_depth === 1)) {
        if (visited.has(next.target_resource)) continue;
        const nextResource = byId.get(next.target_resource);
        if (!nextResource) continue;
        const nextPath = [...path, next];
        const links = nextPath.flatMap((item) => item.proof?.links ?? []);
        if (links.length !== nextPath.length) continue;
        if (nextPath.length >= 2 && !directTargets.has(next.target_resource)) {
          const first = nextPath[0]!;
          const nullable = links.some((link) => link.nullable);
          candidates.push({
            id: nextPath.map((item) => item.id).join("__"),
            target_resource: next.target_resource,
            local_columns: [...first.local_columns],
            target_columns: [...next.target_columns],
            counted_entity: root.primary_key,
            cardinality: "many_to_one",
            max_fan_out: 1,
            path_depth: nextPath.length as 2 | 3,
            proof: {
              source: "database_catalog",
              links: structuredClone(links),
              digest: canonicalJsonDigest(links),
            },
            nullable,
            unmatched_rows: nullable ? "review_required" : "exclude",
          });
        }
        visit(nextResource, nextPath, new Set([...visited, next.target_resource]));
      }
    };
    visit(root, [], new Set([root.id]));
    const pathsByTarget = new Map<string, ExplorationRelationship[]>();
    for (const candidate of candidates) {
      const group = pathsByTarget.get(candidate.target_resource) ?? [];
      group.push(candidate);
      pathsByTarget.set(candidate.target_resource, group);
    }
    const unambiguous = [...pathsByTarget.values()]
      .flatMap((paths) => {
        const shortest = Math.min(...paths.map((path) => path.path_depth ?? 1));
        const shortestPaths = paths.filter((path) => (path.path_depth ?? 1) === shortest);
        return shortestPaths.length === 1 ? shortestPaths : [];
      })
      .sort((left, right) => {
        const leftTarget = byId.get(left.target_resource);
        const rightTarget = byId.get(right.target_resource);
        const score = (target: typeof leftTarget) =>
          (target?.groupable_fields.length ?? 0) * 4
          + Object.keys(target?.time_bucket_fields ?? {}).length * 3
          + (target?.selectable_fields.length ?? 0);
        return score(rightTarget) - score(leftTarget) || left.id.localeCompare(right.id);
      });
    for (const depth of [2, 3] as const) {
      root.relationships.push(...unambiguous
        .filter((relationship) => relationship.path_depth === depth)
        .slice(0, MAX_COMPOSED_RELATIONSHIP_CANDIDATES_PER_DEPTH));
    }
    root.relationships.sort((left, right) =>
      (left.path_depth ?? 1) - (right.path_depth ?? 1) || left.id.localeCompare(right.id));
  }
}

function generatedContractTests(
  graph: AutoBoundaryEvidenceGraph,
  digest: `sha256:${string}`,
  singleOrganization: boolean,
): AutoBoundaryBuild["tests"] {
  const cases: Array<Record<string, unknown>> = [];
  for (const resource of graph.resources.filter((candidate) => candidate.status === "draft_read")) {
    cases.push(
      singleOrganization
        ? { name: `${resource.id}: reviewed organization fixed`, kind: "scope", expected: "single_organization_boundary_bound" }
        : resource.shared_reference_scope?.selected
          ? { name: `${resource.id}: reviewed shared reference`, kind: "scope", expected: "shared_reference_no_tenant_predicate" }
          : { name: `${resource.id}: trusted tenant required`, kind: "scope", expected: "deny_without_trusted_tenant" },
      singleOrganization
        ? { name: `${resource.id}: model organization override absent`, kind: "schema", expected: "organization_not_model_argument" }
        : { name: `${resource.id}: model tenant override absent`, kind: "schema", expected: "tenant_not_model_argument" },
      { name: `${resource.id}: kept-out fields unavailable`, kind: "redaction", fields: resource.fields.filter((field) => field.sensitive_suggestion).map((field) => field.name) },
      { name: `${resource.id}: schema fingerprint current`, kind: "drift", expected: "generation_lock_match" },
    );
  }
  return {
    schema_version: "synapsor.generated-tests.v1",
    contract_digest: digest,
    cases,
  };
}

function unresolvedDecisions(
  graph: AutoBoundaryEvidenceGraph,
  boundary: Pick<ExplorationBoundaryDraft, "pack" | "trusted_context" | "deployment_profile" | "organization_scope" | "source" | "role_posture_fingerprint">,
): string[] {
  const boundaryResources = new Map(
    (boundary?.pack.resources ?? []).map((resource) => [resource.id, resource]),
  );
  return unique([
    boundary?.deployment_profile === "production"
      ? "deployment profile: confirm production Explore over secured HTTP with mandatory per-principal scope and privacy accounting"
      : "deployment profile: confirm development or staging authoring-only use",
    ...(boundary?.organization_scope
      ? [`organization scope: confirm this source contains one organization (${boundary.organization_scope.organization_id}), every row belongs to it, and Explore will apply no tenant predicate`]
      : []),
    boundary?.trusted_context.provider === "http_claims"
      ? boundary.organization_scope
        ? `trusted context: confirm principal comes only from verified HTTP claim ${boundary.trusted_context.principal_claim}; organization identity is fixed by the reviewed boundary`
        : `trusted context: confirm tenant and principal come only from verified HTTP claims ${boundary.trusted_context.tenant_claim} and ${boundary.trusted_context.principal_claim}`
      : boundary?.trusted_context.database_role_tenant
      ? `trusted context: confirm tenant scope comes from the verified PostgreSQL credential setting ${boundary.trusted_context.database_role_tenant.setting} and principal scope remains outside model arguments`
      : boundary?.organization_scope
        ? `trusted context: confirm organization identity is fixed as ${boundary.organization_scope.organization_id} and any principal binding remains outside model arguments`
        : "trusted context: confirm operator-supplied tenant and principal bindings remain outside model arguments",
    ...(!graph.database_role.verified || !graph.database_role.read_only
      ? ["database role: use and verify a non-owner, non-superuser, non-BYPASSRLS, read-only credential before enabling Scoped Explore"]
      : []),
    ...graph.resources.flatMap((resource) => [
    ...(resource.status !== "draft_read" ? resource.blockers.map((blocker) => `${resource.id}: ${blocker}`) : []),
    ...(resource.status === "draft_read" ? [
      boundary?.organization_scope
        ? `${resource.id}: confirm whole-organization read access with no tenant predicate`
        : resource.tenant_key.selected
          ? `${resource.id}: confirm tenant key ${resource.tenant_key.selected}`
          : resource.derived_tenant_scope?.selected
            ? `${resource.id}: confirm mandatory derived tenant scope via ${resource.derived_tenant_scope.selected.path_id} to ${resource.derived_tenant_scope.selected.ancestor_resource}.${resource.derived_tenant_scope.selected.ancestor_column}`
            : `${resource.id}: confirm reviewed shared reference with no tenant predicate`,
      principalScopeReviewDecision(boundaryResources.get(resource.id)!, boundary).decision,
      `${resource.id}: confirm visible and kept-out fields`,
      `${resource.id}: confirm filter/sort/group/aggregate-only field permissions`,
      `${resource.id}: confirm minimum cohort and extraction/differencing budgets`,
      ...(boundaryResources.get(resource.id)?.label
        || boundaryResources.get(resource.id)?.description
        || Object.keys(boundaryResources.get(resource.id)?.field_metadata ?? {}).length
        ? [`${resource.id}: confirm reviewed labels and descriptions`]
        : []),
      ...(boundaryResources.get(resource.id)?.relationships ?? resource.relationships
        .filter((relationship) => relationship.cardinality_proven)
        .map((relationship) => ({
          id: relationship.name,
          target_resource: relationship.referenced_resource,
        })))
        .map((relationship) =>
          `${resource.id}: review relationship ${relationship.id} cardinality and scope on ${relationship.target_resource}`),
    ] : []),
    ]),
  ]).sort();
}

function reviewMarkdown(build: AutoBoundaryBuild): string {
  const derivedScopes = build.review.resources.flatMap((resource) => [
    ...(resource.derived_tenant_scope?.selected
      ? [{ resource: resource.id, kind: "tenant", scope: resource.derived_tenant_scope.selected }]
      : []),
    ...(resource.derived_principal_scope?.selected
      ? [{ resource: resource.id, kind: "principal", scope: resource.derived_principal_scope.selected }]
      : []),
  ]);
  const sharedReferences = build.exploration_boundary.pack.resources
    .filter((resource) => Boolean(resource.shared_reference_scope))
    .map((resource) => resource.id);
  const autoBands = build.exploration_boundary.pack.resources.flatMap((resource) =>
    (resource.auto_bands ?? []).map((policy) => ({ resource: resource.id, policy })));
  const reviewedMetadata = build.exploration_boundary.pack.resources
    .filter((resource) => resource.label || resource.description
      || Object.keys(resource.field_metadata ?? {}).length)
    .map((resource) => ({
      resource: resource.id,
      label: resource.label,
      description: resource.description,
      fields: Object.entries(resource.field_metadata ?? {})
        .sort(([left], [right]) => left.localeCompare(right)),
    }));
  const lines = [
    "# Auto Boundary Review",
    "",
    "Status: disabled and unreviewed. These files grant no runtime authority until a human activates the exact reviewed digest in the local Workbench.",
    "",
    `Candidate contract digest: \`${build.contract_digest}\``,
    `Database server: \`${build.lock.engine} ${build.lock.database_server_version ?? "not recorded by this lock"}\``,
    `Database capability tier: \`${build.lock.database_server_tier ?? "not recorded by this lock"}\``,
    `Schema fingerprint: \`${build.lock.schema_fingerprint}\``,
    `Role posture fingerprint: \`${build.lock.role_posture_fingerprint}\``,
    "",
    "## Summary",
    "",
    `- Objects inspected: ${build.review.summary.objects}`,
    `- Draft exact-row reads: ${build.review.summary.draft_reads}`,
    `- Blocked objects: ${build.review.summary.blocked_objects}`,
    `- Sensitive fields kept out by suggestion: ${build.review.summary.sensitive_fields_kept_out}`,
    `- Structured write candidates (disabled): ${build.review.summary.structured_write_candidates}`,
    "",
    "## Required Review",
    "",
    ...build.review.unresolved_decisions.map((decision) =>
      `- [ ] ${humanReadableScopeDecision(decision, derivedScopes)}`),
    ...(sharedReferences.length
      ? [
          "",
          "## Reviewed Shared References",
          "",
          "These tables apply no tenant predicate because a human asserted that every tenant may receive the same reviewed rows. Field visibility, cohort suppression, privacy budgets, and principal scope remain enforced.",
          "",
          ...sharedReferences.map((resource) => `- ${resource}`),
        ]
      : []),
    ...(autoBands.length
      ? [
          "",
          "## Reviewed Automatic Numeric Bands",
          "",
          "The model may select only the reviewed method and bucket count. Runner computes boundaries from trusted scoped rows, applies cohort suppression, and never returns raw computed edges.",
          "",
          ...autoBands.map(({ resource, policy }) =>
            `- ${resource}.${policy.field}: ${policy.methods.join(" or ")}; ${policy.min_buckets}-${policy.max_buckets} buckets; ${policy.label_style} labels`),
        ]
      : []),
    ...(reviewedMetadata.length
      ? [
          "",
          "## Reviewed Names And Descriptions",
          "",
          "These bounded descriptions explain exact database IDs. They grant no authority, and plans must continue to use the exact IDs shown here.",
          "",
          ...reviewedMetadata.flatMap((metadata) => [
            `- ${metadata.resource}: label ${JSON.stringify(metadata.label ?? null)}; description ${JSON.stringify(metadata.description ?? null)}`,
            ...metadata.fields.map(([field, fieldMetadata]) =>
              `  - ${metadata.resource}.${field}: label ${JSON.stringify(fieldMetadata.label ?? null)}; description ${JSON.stringify(fieldMetadata.description ?? null)}`),
          ]),
        ]
      : []),
    ...(derivedScopes.length
      ? [
          "",
          "## Advanced Scope Path IDs",
          "",
          "These canonical IDs are for scripted review flags. Runtime enforcement and digests use them unchanged.",
          "",
          ...derivedScopes.map(({ resource, kind, scope }) =>
            `- ${resource} ${kind}: \`${scope.path_id}\` (${formatDerivedScopePath(scope)})`),
        ]
      : []),
    "",
    "Database, ORM, and API comments are naming evidence only. They never create read, write, approval, or activation authority.",
    "",
  ];
  return lines.join("\n");
}

function humanReadableScopeDecision(
  decision: string,
  scopes: Array<{
    resource: string;
    kind: string;
    scope: DerivedScopePath;
  }>,
): string {
  let displayed = decision;
  for (const { scope } of scopes) {
    displayed = displayed.replace(
      `via ${scope.path_id} to ${scope.ancestor_resource}.${scope.ancestor_column}`,
      `through ${formatDerivedScopePath(scope)}`,
    );
  }
  return displayed;
}

function inference<T>(
  selected: T | undefined,
  candidates: T[],
  evidence: BoundaryInference<T>["evidence"],
  structurallyProven: boolean,
  safetyConsequence: string,
  options: {
    alternatives?: BoundaryInference<T>["alternatives_considered"];
    blockedReason?: string;
    confidence?: InferenceConfidence;
  } = {},
): BoundaryInference<T> {
  const confidence: InferenceConfidence = options.confidence
    ?? (structurallyProven ? "high" : candidates.length === 1 ? "medium" : "low");
  return {
    ...(selected !== undefined ? { selected } : {}),
    candidates,
    evidence,
    alternatives_considered: options.alternatives ?? candidates.map((value) => ({
      value,
      confidence,
      evidence: evidence.map((item) => `${item.source}: ${item.detail}`),
      selected: selected === value,
    })),
    confidence,
    confirmation_required: true,
    safety_consequence: safetyConsequence,
    ...(options.blockedReason ? { blocked_reason: options.blockedReason } : {}),
  };
}

function moreRestrictiveSensitivity(
  left: SensitivityClassification,
  right: SensitivityClassification,
): SensitivityClassification {
  const rank = {
    structurally_low_risk: 0,
    unresolved_free_text: 1,
    high_confidence_sensitive: 2,
  } as const;
  if (rank[left.state] > rank[right.state]) return left;
  if (rank[right.state] > rank[left.state]) return right;
  return {
    state: left.state,
    reason_codes: unique([...left.reason_codes, ...right.reason_codes]).sort(),
    reasons: unique([...left.reasons, ...right.reasons]).sort(),
    evidence_source: left.evidence_source,
  };
}

function nameOnlySensitivityRefutedByStructure(
  classification: SensitivityClassification,
  deterministic: SensitivityClassification,
): boolean {
  return deterministic.state === "structurally_low_risk"
    && classification.state === "unresolved_free_text"
    && classification.reason_codes.length > 0
    && classification.reason_codes.every((code) =>
      code === "unconstrained_free_text_name" || code === "ambiguous_display_name");
}

function sourceKind(detail: string): "prisma" | "drizzle" | "openapi" | "synapsor" {
  const prefix = detail.split(":", 1)[0];
  return prefix === "prisma" || prefix === "drizzle" || prefix === "openapi" ? prefix : "synapsor";
}

export type ExactNumericGroupingEligibility = {
  eligible: boolean;
  reasons: string[];
};

/**
 * The stored review key keeps its 1.7.1 name so existing unpublished boundary
 * artifacts reconcile byte-for-byte. The authority itself is type-neutral:
 * it grants exact grouping for one reviewed scalar field.
 */
export function exactNumericGroupingEligibility(
  resource: Pick<
    AutoBoundaryResource,
    "fields" | "primary_key" | "tenant_key" | "principal_key" | "relationships"
  >,
  fieldName: string,
): ExactNumericGroupingEligibility {
  const field = resource.fields.find((candidate) => candidate.name === fieldName);
  if (!field) return { eligible: false, reasons: ["the field is not present in the inspected resource"] };
  const reasons: string[] = [];
  if (!exactGroupingDataTypeSupported(field.data_type)) {
    reasons.push(
      "the inspected database type is binary, structural, or cannot be represented faithfully as a scalar group label",
    );
  }
  if (field.primary_key || resource.primary_key.selected === fieldName) {
    reasons.push("record identity fields cannot be exact grouping dimensions");
  }
  if (resource.relationships.some((relationship) => relationship.columns.includes(fieldName))) {
    reasons.push("foreign-key and reference fields cannot be exact grouping dimensions");
  }
  if (isReferenceIdentifierName(fieldName)) {
    reasons.push("identifier-like fields cannot be exact grouping dimensions");
  }
  if (resource.tenant_key.selected === fieldName
    || resource.principal_key.selected === fieldName
    || resource.tenant_key.candidates.includes(fieldName)
    || resource.principal_key.candidates.includes(fieldName)) {
    reasons.push("trusted tenant and principal fields cannot be exact grouping dimensions");
  }
  if (field.sensitivity.state === "high_confidence_sensitive") {
    reasons.push("sensitive fields cannot be exact grouping dimensions");
  } else if (field.sensitivity.state !== "structurally_low_risk"
    && field.review_override?.exposure !== "allow_reviewed_use"
    && field.review_override?.exposure !== "withhold_from_model") {
    reasons.push(
      "an unresolved field must first receive an explicit reviewed model or Runner-only exposure decision",
    );
  }
  if (!field.raw_visible_suggestion || field.sensitive_suggestion || isUnsafeRawType(field.data_type)) {
    reasons.push("the field is not available for reviewed model use");
  }
  return { eligible: reasons.length === 0, reasons: unique(reasons) };
}

export function exactGroupingDataTypeSupported(type: string): boolean {
  return !isUnsafeRawType(type)
    && !/(?:^|\b)(?:(?:tiny|medium|long)?blob|jsonb?|xml|interval|geometry|geography|point|multipoint|linestring|multilinestring|polygon|multipolygon|geometrycollection|line|lseg|box|path|circle|array|record|composite|(?:int4|int8|num|ts|tstz|date)(?:multi)?range|range|multirange|hstore|tsvector|tsquery|vector|varbit|bit varying|bit)(?:\b|$)|\[\]/i.test(type);
}

function isNumericType(type: string): boolean {
  return /(?:^|\b)(smallint|int|integer|bigint|numeric|decimal|real|double|float|money|number|tinyint|mediumint)(?:\b|$)/i.test(type);
}

function isTimestampType(type: string): boolean {
  return /date|time/i.test(type);
}

function isCategoricalType(type: string, enumValues?: string[]): boolean {
  return Boolean(enumValues?.length) || /char|text|enum|boolean|bool/i.test(type);
}

function reviewedBoundaryEnumValues(
  field: AutoBoundaryField,
  keptOutFields: Set<string>,
  trustedScopeFields: Set<string>,
): string[] | undefined {
  const values = field.enum_review_override?.values ?? field.enum_values;
  if (!values?.length
    || values.length > 64
    || field.primary_key
    || isReferenceIdentifierName(field.name)
    || field.sensitivity.state !== "structurally_low_risk"
    || keptOutFields.has(field.name)
    || trustedScopeFields.has(field.name)
    || values.some((value) => [...value].length > 64)
    || Buffer.byteLength(JSON.stringify(values), "utf8") > 2_048) {
    return undefined;
  }
  return [...values];
}

function operatorsForType(type: string): Array<"eq" | "neq" | "lt" | "lte" | "gt" | "gte" | "in"> {
  if (isNumericType(type) || isTimestampType(type)) return ["eq", "neq", "lt", "lte", "gt", "gte", "in"];
  return ["eq", "neq", "in"];
}

function explorationRlsSession(
  resource: AutoBoundaryResource,
  resources: AutoBoundaryResource[],
): { rls_session?: { tenant_setting?: string; principal_setting?: string } } {
  const byId = new Map(resources.map((candidate) => [candidate.id, candidate]));
  const tenantOwner = resource.tenant_key.selected
    ? resource
    : resource.derived_tenant_scope?.selected
      ? byId.get(resource.derived_tenant_scope.selected.ancestor_resource)
      : undefined;
  const principalOwner = resource.principal_key.selected
    ? resource
    : resource.derived_principal_scope?.selected
      ? byId.get(resource.derived_principal_scope.selected.ancestor_resource)
      : undefined;
  const tenant = tenantOwner?.tenant_key.selected && tenantOwner.rls.enabled === true
    ? settingForScopedColumn(tenantOwner.rls.using_expressions, tenantOwner.tenant_key.selected)
    : undefined;
  const directPrincipal = principalOwner?.principal_key.selected && principalOwner.rls.enabled === true
    ? settingForScopedColumn(principalOwner.rls.using_expressions, principalOwner.principal_key.selected)
    : undefined;
  const conventionalPrincipalCandidates = resource.rls.enabled === true
    ? (resource.rls.principal_setting_candidates ?? [])
      .filter((setting) => setting !== tenant && settingNameSupportsScope(setting, "principal"))
    : [];
  const reviewedPrincipalSetting = resource.rls.principal_setting_review_override;
  const principal = directPrincipal
    ?? (reviewedPrincipalSetting
      ? reviewedPrincipalSetting.value ?? undefined
      : conventionalPrincipalCandidates.length === 1
        ? conventionalPrincipalCandidates[0]
        : undefined);
  if (!tenant && !principal) return {};
  return {
    rls_session: {
      ...(tenant ? { tenant_setting: tenant } : {}),
      ...(principal ? { principal_setting: principal } : {}),
    },
  };
}

/**
 * Returns exact settings mentioned by an RLS policy that are not already
 * proven to carry tenant context. The list is deliberately broader than the
 * automatic vocabulary: opaque names are candidates for human/model-assisted
 * clarification, never automatic principal authority.
 */
function rlsPrincipalSettingCandidates(expressions: string[]): string[] {
  const settings = unique(expressions.flatMap(currentSettingNames));
  const tenantSettings = new Set(settings.filter((setting) =>
    settingNameSupportsScope(setting, "tenant")));
  return settings.filter((setting) => !tenantSettings.has(setting)).sort();
}

function settingNameSupportsScope(setting: string, kind: "tenant" | "principal"): boolean {
  const settingPattern = kind === "tenant"
    ? /(?:^|[._-])(?:tenant|org|organization|workspace|merchant|store|company|team|facility|property|clinic|project)(?:$|[._-])/i
    : /(?:^|[._-])(?:principal|user|actor|owner|assignee|agent|staff|technician|manager|trainer)(?:$|[._-])/i;
  return settingPattern.test(setting);
}

function settingForScopedColumn(expressions: string[], column: string): string | undefined {
  const escaped = column.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const columnReference = new RegExp(
    `(?:^|[^A-Za-z0-9_$\"])(?:${escaped}|\"${escaped}\")(?=$|[^A-Za-z0-9_$\"])`,
    "i",
  );
  const candidates = expressions.flatMap((expression) =>
    splitSqlBooleanClauses(expression).flatMap((clause) => {
      const masked = maskSqlQuotedSegments(clause, false);
      const equalities = [...masked.matchAll(/(?<![<>=!])=(?!=)/gu)];
      if (equalities.length !== 1 || equalities[0]?.index === undefined) return [];
      const index = equalities[0].index;
      const left = clause.slice(0, index);
      const right = clause.slice(index + 1);
      const leftNamesColumn = columnReference.test(maskSqlQuotedSegments(left, false));
      const rightNamesColumn = columnReference.test(maskSqlQuotedSegments(right, false));
      if (leftNamesColumn === rightNamesColumn) return [];
      return currentSettingNames(leftNamesColumn ? right : left);
    }));
  const uniqueCandidates = unique(candidates);
  return uniqueCandidates.length === 1 ? uniqueCandidates[0] : undefined;
}

function currentSettingNames(sql: string): string[] {
  return [...sql.matchAll(/current_setting\(\s*'([A-Za-z0-9_.-]+)'/giu)]
    .flatMap((match) => match[1] ? [match[1]] : []);
}

function splitSqlBooleanClauses(expression: string): string[] {
  const masked = maskSqlQuotedSegments(expression, true);
  const separators = [...masked.matchAll(/\b(?:AND|OR)\b/giu)];
  if (!separators.length) return [expression];
  const clauses: string[] = [];
  let start = 0;
  for (const separator of separators) {
    if (separator.index === undefined) continue;
    clauses.push(expression.slice(start, separator.index));
    start = separator.index + separator[0].length;
  }
  clauses.push(expression.slice(start));
  return clauses;
}

function maskSqlQuotedSegments(sql: string, includeIdentifiers: boolean): string {
  const chars = [...sql];
  let quote: "'" | '"' | undefined;
  for (let index = 0; index < chars.length; index += 1) {
    const character = chars[index]!;
    if (!quote) {
      if (character === "'" || (includeIdentifiers && character === '"')) quote = character;
      continue;
    }
    chars[index] = " ";
    if (character !== quote) continue;
    if (chars[index + 1] === quote) {
      chars[index + 1] = " ";
      index += 1;
      continue;
    }
    quote = undefined;
  }
  return chars.join("");
}

function singularize(value: string): string {
  if (/ies$/i.test(value)) return `${value.slice(0, -3)}y`;
  if (/sses$/i.test(value)) return value.slice(0, -2);
  if (/s$/i.test(value) && !/ss$/i.test(value)) return value.slice(0, -1);
  return value;
}

function safeNamespace(value: string): string {
  const candidate = safeIdentifier(value);
  return candidate === "public" ? "app" : candidate;
}

function safeIdentifier(value: string): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "");
  const prefixed = /^[a-z_]/.test(normalized) ? normalized : `resource_${normalized}`;
  return prefixed || "resource";
}

function humanize(value: string): string {
  return value.replace(/_/g, " ");
}

function isReferenceIdentifierName(value: string): boolean {
  return value.toLowerCase() === "id" || /_id$/i.test(value);
}

function isAnalyticalNumericMeasureName(value: string): boolean {
  return !isReferenceIdentifierName(value)
    && !/(?:^|_)(?:version|revision|sequence|seq|ordinal|position|rank)(?:_|$)/i.test(value);
}

function escapeDslString(value: string): string {
  return value.replace(/'/g, "''");
}

function contextDsl(source: string): string {
  const marker = "\nCREATE CAPABILITY ";
  const index = source.indexOf(marker);
  return index === -1 ? source : `${source.slice(0, index).trim()}\n`;
}

function capabilityDsl(source: string): string {
  const marker = "CREATE CAPABILITY ";
  const index = source.indexOf(marker);
  return index === -1 ? "" : `${source.slice(index).trim()}\n`;
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

async function readBoundedText(filePath: string): Promise<string> {
  const stat = await fs.lstat(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("input must be a regular file");
  if (stat.size > MAX_STATIC_INPUT_BYTES) throw new Error(`input exceeds ${MAX_STATIC_INPUT_BYTES} bytes`);
  return fs.readFile(filePath, "utf8");
}

function safeMessage(error: unknown): string {
  return error instanceof Error ? error.message.replace(/(?:postgres|mysql)(?:ql)?:\/\/\S+/gi, "<redacted-database-url>") : String(error);
}

function assertInsideProject(projectRoot: string, outputRoot: string): void {
  const relative = path.relative(projectRoot, outputRoot);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    if (!relative) return;
    throw new Error("Auto Boundary output must stay inside the project root.");
  }
}

async function assertManagedBoundaryOutput(outputRoot: string): Promise<void> {
  let marker: Record<string, unknown>;
  try {
    marker = await readManagedOutputMarker(outputRoot, ".synapsor-auto-boundary.json");
  } catch {
    throw new Error(`Refusing to replace unmanaged directory ${outputRoot}.`);
  }
  if (marker.schema_version !== AUTO_BOUNDARY_VERSION
    || typeof marker.contract_digest !== "string"
    || typeof marker.schema_fingerprint !== "string") {
    throw new Error(`Refusing to replace invalid managed Auto Boundary output ${outputRoot}.`);
  }
}

async function writePrivateStagedFile(
  stagedState: string,
  fileName: string,
  contents: string,
): Promise<void> {
  await fs.writeFile(
    path.join(stagedState, fileName),
    contents,
    { encoding: "utf8", mode: 0o600, flag: "wx" },
  );
}

async function commitManagedAutoBoundaryWrite(input: {
  outputRoot: string;
  stagedOutput: string;
  stateDir: string;
  transactionRoot: string;
  backupRoot: string;
  existingOutput: boolean;
  installStateFiles: string[];
  removeStateFiles: string[];
}): Promise<void> {
  const installFiles = unique(input.installStateFiles);
  const removeFiles = unique(input.removeStateFiles)
    .filter((file) => !installFiles.includes(file));
  await fs.mkdir(input.backupRoot, { recursive: true, mode: 0o700 });

  const state = new Map<string, { target: string; backup: string; existed: boolean }>();
  for (const file of [...installFiles, ...removeFiles]) {
    if (file !== path.basename(file)) throw new Error("Managed state file names must not contain paths.");
    const target = path.join(input.stateDir, file);
    const backup = path.join(input.backupRoot, `state-${file}`);
    const existed = await exists(target);
    if (existed) {
      const stat = await fs.lstat(target);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new Error(`Refusing to replace non-regular managed state file ${target}.`);
      }
      if (!input.existingOutput && installFiles.includes(file)) {
        throw new Error(
          `Refusing to replace existing state ${target} without a managed Auto Boundary output marker.`,
        );
      }
    }
    state.set(file, { target, backup, existed });
  }

  const outputBackup = path.join(input.backupRoot, "generated-output");
  let outputBackedUp = false;
  let outputInstalled = false;
  const stateBackedUp = new Set<string>();
  const stateInstalled = new Set<string>();
  try {
    if (input.existingOutput) {
      await fs.rename(input.outputRoot, outputBackup);
      outputBackedUp = true;
    }
    await fs.rename(input.stagedOutput, input.outputRoot);
    outputInstalled = true;

    for (const file of installFiles) {
      const entry = state.get(file)!;
      if (entry.existed) {
        await fs.rename(entry.target, entry.backup);
        stateBackedUp.add(file);
      }
      await fs.rename(path.join(input.transactionRoot, "staged-state", file), entry.target);
      await fs.chmod(entry.target, 0o600);
      stateInstalled.add(file);
    }
    for (const file of removeFiles) {
      const entry = state.get(file)!;
      if (!entry.existed) continue;
      await fs.rename(entry.target, entry.backup);
      stateBackedUp.add(file);
    }
  } catch (error) {
    let rollbackError: unknown;
    try {
      for (const file of [...stateInstalled].reverse()) {
        await fs.rm(state.get(file)!.target, { force: true });
      }
      for (const file of [...stateBackedUp].reverse()) {
        const entry = state.get(file)!;
        await fs.rm(entry.target, { force: true });
        await fs.rename(entry.backup, entry.target);
      }
      if (outputInstalled) {
        await fs.rm(input.outputRoot, { recursive: true, force: true });
      }
      if (outputBackedUp) {
        await fs.rename(outputBackup, input.outputRoot);
      }
    } catch (rollbackFailure) {
      rollbackError = rollbackFailure;
    }
    if (rollbackError) {
      throw new Error(
        "Auto Boundary artifact commit failed and its managed rollback could not be completed.",
        { cause: { commit_error: error, rollback_error: rollbackError } },
      );
    }
    throw error;
  }
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.lstat(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
