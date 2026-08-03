import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { compileAgentDsl, formatAgentDsl } from "@synapsor/dsl";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import {
  rolePostureFingerprint,
  schemaFingerprintForInspection,
  classifySensitivity,
  type SchemaInspection,
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

export const AUTO_BOUNDARY_VERSION = "synapsor.auto-boundary.v1";
export const GENERATION_LOCK_VERSION = "synapsor.generation-lock.v1";
export const AUTHORITY_DEPENDENCIES_VERSION = "synapsor.authority-dependencies.v1";
export const EXPLORATION_BOUNDARY_VERSION = "synapsor.exploration-boundary.v1";
export const AUTO_BOUNDARY_OVERRIDES_VERSION = "synapsor.auto-boundary-overrides.v1";
export const ACTIVE_EXPLORATION_BOUNDARY_SET_VERSION = "synapsor.active-exploration-boundaries.v1";
export const AUTO_BOUNDARY_COMPILER_VERSION = "1.6.6";
export const AUTO_BOUNDARY_SPEC_VERSION = "1.8.0";
export const DEFAULT_GENERATED_DIR = "synapsor/generated";
export const MAX_ACTIVE_EXPLORATION_BOUNDARIES = 8;
const EXPLORATION_LOCK_SNAPSHOT_DIR = "exploration-locks";
const ACTIVE_EXPLORATION_BOUNDARY_SET_FILE = "exploration-boundaries.active.json";

const MAX_STATIC_INPUT_BYTES = 2 * 1024 * 1024;
const MAX_DIRECT_RELATIONSHIP_CANDIDATES_PER_RESOURCE = 4;
const MAX_DEPTH_TWO_RELATIONSHIP_CANDIDATES_PER_RESOURCE = 3;
const DEFAULT_BUDGETS: ExplorationBudgets = {
  max_rows: 50,
  max_groups: 50,
  max_ranked_groups: 500,
  max_top_n: 25,
  max_measures: 3,
  max_dimensions: 3,
  max_time_ranges: 2,
  max_relationship_hops: 2,
  max_response_cells: 500,
  max_response_bytes: 64 * 1024,
  statement_timeout_ms: 3000,
  max_complexity: 24,
  max_queries_per_session: 40,
  max_extracted_cells_per_session: 4000,
  // One finite all-shape pool supports the reviewed ten-plan adoption path
  // without restoring the old per-family differencing reset.
  max_differencing_queries: 16,
  rate_limit_per_minute: 20,
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
  path_depth?: 1 | 2;
  proof?: {
    source: "database_catalog";
    links: RelationshipLinkProof[];
    digest: `sha256:${string}`;
  };
  nullable?: boolean;
  unmatched_rows?: "exclude" | "keep_null" | "review_required";
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
  primary_key: BoundaryInference<string>;
  tenant_key: BoundaryInference<string>;
  principal_key: BoundaryInference<string>;
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
  };
  role_posture: {
    read_only: boolean;
    owner: boolean;
    can_assume_owner: boolean;
    write_capable: boolean;
    verified: boolean;
  };
  minimum_cohort_override?: ReviewedMinimumCohortDecision;
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
  max_relationship_hops: 1 | 2;
  max_response_cells: number;
  max_response_bytes: number;
  statement_timeout_ms: number;
  max_complexity: number;
  max_queries_per_session: number;
  max_extracted_cells_per_session: number;
  max_differencing_queries: number;
  rate_limit_per_minute: number;
};

export type ExplorationBoundaryDraft = {
  schema_version: typeof EXPLORATION_BOUNDARY_VERSION;
  activation: "disabled_unreviewed";
  deployment_profile: "development" | "staging";
  source: string;
  compiler_version: string;
  spec_version: string;
  /**
   * New generated boundaries bind one reporting timezone into their reviewed
   * authority. It remains optional solely so pre-1.6.6 active-boundary
   * artifacts retain their exact canonical digest.
   */
  reporting_timezone?: "UTC";
  trusted_context: {
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
  };
  generation_lock_fingerprint: `sha256:${string}`;
  role_posture_fingerprint: `sha256:${string}`;
  pack: {
    name: string;
    resources: Array<{
      id: string;
      schema: string;
      table: string;
      primary_key: string;
      tenant_key: string;
      principal_key?: string;
      field_types: Record<string, string>;
      field_enums: Record<string, string[]>;
      selectable_fields: string[];
      filterable_fields: Record<string, Array<"eq" | "neq" | "lt" | "lte" | "gt" | "gte" | "in">>;
      sortable_fields: string[];
      groupable_fields: string[];
      aggregate_measures: string[];
      count_distinct_fields: string[];
      time_bucket_fields: Record<string, Array<"day" | "week" | "month">>;
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
  /**
   * Additive dependency records for authority generated by newer Runner
   * versions. Legacy locks omit this field and retain whole-schema drift
   * enforcement.
   */
  authority_dependencies?: GenerationAuthorityDependencies;
};

export type GenerationAuthorityDependencies = {
  schema_version: typeof AUTHORITY_DEPENDENCIES_VERSION;
  credential_posture_fingerprint: `sha256:${string}`;
  resources: Record<string, {
    schema: string;
    table: string;
    fields: string[];
    fingerprint: `sha256:${string}`;
  }>;
  relationships: Record<string, {
    root_resource: string;
    relationship_id: string;
    links: RelationshipLinkProof[];
    proof_digest: `sha256:${string}`;
  }>;
};

export type AutoBoundaryBuild = {
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

export type AutoBoundaryReviewOverrides = {
  schema_version: typeof AUTO_BOUNDARY_OVERRIDES_VERSION;
  resources: Record<string, {
    row_identity?: ReviewedValueDecision;
    tenant_key?: ReviewedValueDecision;
    principal_key?: Omit<ReviewedValueDecision, "value"> & { value: string | null };
    minimum_cohort?: ReviewedMinimumCohortDecision;
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

export async function loadAutoBoundaryReviewOverrides(projectRoot: string): Promise<AutoBoundaryReviewOverrides> {
  const filePath = path.join(path.resolve(projectRoot), ".synapsor/review-overrides.json");
  if (!await exists(filePath)) return emptyReviewOverrides();
  const stat = await fs.lstat(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error("Auto Boundary review overrides must be a regular project-local file.");
  }
  if (stat.size > MAX_STATIC_INPUT_BYTES) {
    throw new Error(`Auto Boundary review overrides exceed ${MAX_STATIC_INPUT_BYTES} bytes.`);
  }
  return normalizeReviewOverrides(JSON.parse(await fs.readFile(filePath, "utf8")) as unknown);
}

export function pruneAutoBoundaryReviewOverrides(
  inspection: SchemaInspection,
  input: AutoBoundaryReviewOverrides,
): { overrides: AutoBoundaryReviewOverrides; removed: string[] } {
  const current = normalizeReviewOverrides(input);
  const tables = new Map(inspection.tables.map((table) => [`${table.schema}.${table.name}`, table]));
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
    if (decision.row_identity) {
      if (provenIdentifiers.has(decision.row_identity.value)) retained.row_identity = decision.row_identity;
      else removed.push(`${resourceId}: reviewed row identity ${decision.row_identity.value} is no longer source-proven`);
    }
    if (decision.tenant_key) {
      if (columns.has(decision.tenant_key.value)) retained.tenant_key = decision.tenant_key;
      else removed.push(`${resourceId}: reviewed tenant key ${decision.tenant_key.value} no longer exists`);
    }
    if (decision.principal_key) {
      if (decision.principal_key.value === null || columns.has(decision.principal_key.value)) {
        retained.principal_key = decision.principal_key;
      } else {
        removed.push(`${resourceId}: reviewed principal key ${decision.principal_key.value} no longer exists`);
      }
    }
    if (decision.minimum_cohort) retained.minimum_cohort = decision.minimum_cohort;
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
  return {
    overrides: normalizeReviewOverrides({
      schema_version: AUTO_BOUNDARY_OVERRIDES_VERSION,
      resources,
    }),
    removed: removed.sort(),
  };
}

export function buildAutoBoundary(input: {
  inspection: SchemaInspection;
  project: ProjectDetectionSummary;
  parsedEvidence?: ParsedSchema[];
  existingContracts?: SynapsorContract[];
  sourceEnv: string;
  sourceName?: string;
  inspectedSchema?: string;
  overrides?: AutoBoundaryReviewOverrides;
}): AutoBoundaryBuild {
  const parsedEvidence = input.parsedEvidence ?? [];
  const existingContracts = input.existingContracts ?? [];
  const overrides = normalizeReviewOverrides(input.overrides);
  const sourceName = input.sourceName ?? (input.inspection.engine === "postgres" ? "local_postgres" : "local_mysql");
  const staticObjects = parsedEvidence.flatMap((evidence) => evidence.objects.map((object) => ({ format: evidence.format, object })));
  const graph = buildEvidenceGraph(input.inspection, input.project, staticObjects, existingContracts);
  applyReviewOverrides(graph, overrides);
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
    source_env: input.sourceEnv,
    ...(input.inspectedSchema ? { inspected_schema: input.inspectedSchema } : {}),
    schema_fingerprint: schemaFingerprint,
    role_posture_fingerprint: roleFingerprint,
    evidence_fingerprint: evidenceFingerprint,
    generated_contract_digest: contractDigest,
    reviewed_overrides_digest: overridesDigest,
    protected_authority: graph.resources.filter((resource) => resource.status === "draft_read").map((resource) => resource.id),
    reporting_timezone: "UTC",
  };
  const provisionalBoundary = buildExplorationBoundaryDraft(graph, sourceName, canonicalJsonDigest(baseLock));
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
    tests: generatedContractTests(graph, contractDigest),
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
            ...(resource.principal_key ? { principal_key: resource.principal_key.value } : {}),
            ...(resource.minimum_cohort ? { minimum_cohort: resource.minimum_cohort.value } : {}),
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

function generationEvidenceAuthority(resources: AutoBoundaryResource[]): unknown[] {
  return resources.map((resource) => ({
    ...resource,
    ...(resource.minimum_cohort_override
      ? {
        minimum_cohort_override: {
          value: resource.minimum_cohort_override.value,
        },
      }
      : {}),
    fields: resource.fields.map((field) => ({
      ...field,
      ...(field.review_override
        ? { review_override: { exposure: field.review_override.exposure } }
        : {}),
    })),
  }));
}

export async function writeAutoBoundaryArtifacts(input: {
  projectRoot: string;
  build: AutoBoundaryBuild;
  outputRoot?: string;
  force?: boolean;
  preserveReviewProgress?: boolean;
  preserveActiveBoundary?: boolean;
  reviewProgress?: BoundaryReviewProgressArtifact<ExplorationBoundaryDraft>;
}): Promise<AutoBoundaryWriteResult> {
  const projectRoot = path.resolve(input.projectRoot);
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
    await writePrivateStagedFile(stagedState, "review-report.json", json(input.build.review));
    await writePrivateStagedFile(stagedState, "review-overrides.json", json(input.build.overrides));
    if (input.reviewProgress) {
      await writePrivateStagedFile(
        stagedState,
        "boundary-review-progress.json",
        json(input.reviewProgress),
      );
    }
    await commitManagedAutoBoundaryWrite({
      outputRoot,
      stagedOutput: temporary,
      stateDir,
      transactionRoot,
      backupRoot,
      existingOutput: existing,
      installStateFiles: [
        "generation-lock.json",
        "review-report.json",
        "review-overrides.json",
        ...(input.reviewProgress ? ["boundary-review-progress.json"] : []),
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
        path.join(stateDir, "review-report.json"),
        path.join(stateDir, "review-overrides.json"),
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
  const changes = [
    ...(schemaFingerprint !== lock.schema_fingerprint ? ["schema metadata changed"] : []),
    ...(roleFingerprint !== lock.role_posture_fingerprint ? ["database role, grants, ownership, or RLS posture changed"] : []),
    ...(lock.compiler_version !== AUTO_BOUNDARY_COMPILER_VERSION ? ["Auto Boundary compiler version changed"] : []),
    ...(lock.spec_version !== AUTO_BOUNDARY_SPEC_VERSION ? ["canonical Spec version changed"] : []),
  ];
  return {
    current: changes.length === 0,
    current_schema_fingerprint: schemaFingerprint,
    current_role_posture_fingerprint: roleFingerprint,
    changes,
  };
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
  const selectedColumns = dependency.fields.map((name) => {
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
    const fields = authorityDependencyFields(resource);
    const descriptor = {
      schema: resource.schema,
      table: resource.table,
      fields,
    };
    const fingerprint = resourceAuthorityDependencyFingerprint(descriptor, inspection);
    if (!fingerprint) throw new Error(`Cannot fingerprint generated authority for missing resource ${resource.id}.`);
    return [resource.id, { ...descriptor, fingerprint }];
  }));
  const relationships = Object.fromEntries(boundary.pack.resources.flatMap((resource) =>
    resource.relationships.map((relationship) => {
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
    })));
  return {
    schema_version: AUTHORITY_DEPENDENCIES_VERSION,
    credential_posture_fingerprint: credentialPostureFingerprintForAuthority(inspection),
    resources,
    relationships,
  };
}

function authorityDependencyFields(
  resource: ExplorationBoundaryDraft["pack"]["resources"][number],
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
  for (const relationship of resource.relationships) {
    for (const link of relationship.proof?.links ?? []) {
      if (link.source_resource === resource.id) link.source_columns.forEach((field) => fields.add(field));
      if (link.target_resource === resource.id) link.target_columns.forEach((field) => fields.add(field));
    }
  }
  return [...fields].sort();
}

export function relationshipDependencyKey(rootResource: string, relationshipId: string): string {
  return `${rootResource}::${relationshipId}`;
}

function sameOrderedStrings(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export async function activateExplorationBoundary(input: {
  projectRoot: string;
  candidate: ExplorationBoundaryDraft;
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
  const projectRoot = path.resolve(input.projectRoot);
  const draftPath = path.join(projectRoot, DEFAULT_GENERATED_DIR, "exploration-boundary.draft.json");
  const lockPath = path.join(projectRoot, ".synapsor/generation-lock.json");
  const draft = JSON.parse(await fs.readFile(draftPath, "utf8")) as ExplorationBoundaryDraft;
  const lock = JSON.parse(await fs.readFile(lockPath, "utf8")) as GenerationLock;
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
    ...(candidate.reporting_timezone ? { reporting_timezone: candidate.reporting_timezone } : {}),
    trusted_context: candidate.trusted_context,
    generation_lock_fingerprint: candidate.generation_lock_fingerprint,
    role_posture_fingerprint: candidate.role_posture_fingerprint,
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
  );
  return active;
}

export function assertCurrentExplorationBoundaryAuthority(input: {
  lock: GenerationLock;
  inspection: SchemaInspection;
  candidate: ExplorationBoundaryDraft;
}): void {
  const comparison = compareGenerationLock(input.lock, input.inspection);
  if (!comparison.current) {
    throw new Error(`Generation lock is stale: ${comparison.changes.join("; ")}.`);
  }
  assertExploreRolePosture(input.inspection, input.candidate);
}

export function explorationBoundaryCandidateDigest(candidate: ExplorationBoundaryDraft): `sha256:${string}` {
  return canonicalJsonDigest(boundaryAuthority(candidate));
}

export function reviewExplorationBoundaryCandidate(
  draft: ExplorationBoundaryDraft,
  candidate: ExplorationBoundaryDraft,
): { digest: `sha256:${string}`; candidate: ExplorationBoundaryDraft } {
  assertBoundaryCandidateNarrowsDraft(draft, candidate);
  const normalized = {
    ...candidate,
    unresolved_decisions: requiredReviewDecisionsForCandidate(draft, candidate),
  };
  return { digest: explorationBoundaryCandidateDigest(normalized), candidate: normalized };
}

export async function loadActivatedExplorationBoundary(
  projectRoot: string,
  selector?: { name?: string; digest?: `sha256:${string}` },
): Promise<ActivatedExplorationBoundary> {
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
): Promise<ActivatedExplorationBoundary[]> {
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
  if (remaining.length === 0) {
    await Promise.all([
      fs.rm(path.join(projectRoot, ".synapsor/exploration-boundary.active.json"), { force: true }),
      fs.rm(path.join(projectRoot, ".synapsor", ACTIVE_EXPLORATION_BOUNDARY_SET_FILE), { force: true }),
    ]);
  } else {
    const selected = remaining.at(-1)!;
    await persistActivatedExplorationBoundarySet(projectRoot, {
      schema_version: ACTIVE_EXPLORATION_BOUNDARY_SET_VERSION,
      selected_name: selected.pack.name,
      boundaries: remaining,
      updated_at: new Date().toISOString(),
    });
    await writePrivateJsonAtomic(
      path.join(projectRoot, ".synapsor/exploration-boundary.active.json"),
      selected,
    );
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
  if (active.activation?.state !== "active") throw new Error("Exploration boundary is not active.");
  if (!/^[a-z][a-z0-9_.-]{0,63}$/.test(active.pack?.name ?? "")) {
    throw new Error("Activated exploration boundary has an invalid name.");
  }
  if (active.reporting_timezone !== undefined && active.reporting_timezone !== "UTC") {
    throw new Error("Activated exploration boundary has an unsupported reporting timezone.");
  }
  const authority = {
    schema_version: active.schema_version,
    activation: "reviewed",
    deployment_profile: active.deployment_profile,
    source: active.source,
    compiler_version: active.compiler_version,
    spec_version: active.spec_version,
    ...(active.reporting_timezone ? { reporting_timezone: active.reporting_timezone } : {}),
    trusted_context: active.trusted_context,
    generation_lock_fingerprint: active.generation_lock_fingerprint,
    role_posture_fingerprint: active.role_posture_fingerprint,
    pack: active.pack,
    budgets: active.budgets,
  };
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
): Promise<void> {
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
  if (boundaries.length > MAX_ACTIVE_EXPLORATION_BOUNDARIES) {
    throw new Error(`Scoped Explore supports at most ${MAX_ACTIVE_EXPLORATION_BOUNDARIES} simultaneously active reviewed boundaries.`);
  }
  const sources = new Set(boundaries.map((boundary) => boundary.source));
  const profiles = new Set(boundaries.map((boundary) => boundary.deployment_profile));
  if (sources.size !== 1 || profiles.size !== 1) {
    throw new Error("Active Explore boundaries must use the same reviewed source and deployment profile.");
  }
  const trustedContexts = new Set(boundaries.map((boundary) => canonicalJsonDigest({
    tenant_env: boundary.trusted_context.tenant_env,
    principal_env: boundary.trusted_context.principal_env,
    database_role_tenant: boundary.trusted_context.database_role_tenant ?? null,
  })));
  if (trustedContexts.size !== 1) {
    throw new Error("Active Explore boundaries must use the same reviewed trusted-context bindings.");
  }
  const set: ActiveExplorationBoundarySet = {
    schema_version: ACTIVE_EXPLORATION_BOUNDARY_SET_VERSION,
    selected_name: active.pack.name,
    boundaries,
    updated_at: new Date().toISOString(),
  };
  activatedExplorationBoundarySetDigest(boundaries);
  await persistActivatedExplorationBoundarySet(projectRoot, set);
  await writePrivateJsonAtomic(
    path.join(projectRoot, ".synapsor/exploration-boundary.active.json"),
    active,
  );
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

export async function loadGenerationLockForActivatedBoundary(
  projectRootInput: string,
  boundary: ActivatedExplorationBoundary,
): Promise<GenerationLock> {
  const projectRoot = path.resolve(projectRootInput);
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

async function persistGenerationLockSnapshot(
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

function normalizeReviewOverrides(input: unknown): AutoBoundaryReviewOverrides {
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
      ["row_identity", "tenant_key", "principal_key", "minimum_cohort", "fields"],
      `${resourceId} review overrides`,
    );
    const resource: AutoBoundaryReviewOverrides["resources"][string] = {};
    if (rawResource.row_identity !== undefined) {
      resource.row_identity = normalizeReviewedValueDecision(rawResource.row_identity, `${resourceId} row identity`, false) as ReviewedValueDecision;
    }
    if (rawResource.tenant_key !== undefined) {
      resource.tenant_key = normalizeReviewedValueDecision(rawResource.tenant_key, `${resourceId} tenant key`, false) as ReviewedValueDecision;
    }
    if (rawResource.principal_key !== undefined) {
      resource.principal_key = normalizeReviewedValueDecision(rawResource.principal_key, `${resourceId} principal key`, true);
    }
    if (rawResource.minimum_cohort !== undefined) {
      resource.minimum_cohort = normalizeReviewedMinimumCohortDecision(
        rawResource.minimum_cohort,
        `${resourceId} minimum cohort`,
      );
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

function applyReviewOverrides(
  graph: AutoBoundaryEvidenceGraph,
  overrides: AutoBoundaryReviewOverrides,
): void {
  const resources = new Map(graph.resources.map((resource) => [resource.id, resource]));
  for (const [resourceId, override] of Object.entries(overrides.resources)) {
    const resource = resources.get(resourceId);
    if (!resource) throw new Error(`Review override references unknown resource ${resourceId}.`);
    const columns = new Set(resource.fields.map((field) => field.name));

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
    if (override.minimum_cohort) {
      resource.minimum_cohort_override = { ...override.minimum_cohort };
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
      field.aggregate_measure_suggestion = allow && isNumericType(field.data_type);
      field.count_distinct_suggestion = allow;
      field.groupable_suggestion = allow
        && !field.primary_key
        && !isReferenceIdentifierName(field.name)
        && isCategoricalType(field.data_type);
      field.time_bucket_suggestion = allow && isTimestampType(field.data_type);
    }
    refreshResourceStatus(resource);
  }
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

function refreshResourceStatus(resource: AutoBoundaryResource): void {
  resource.blockers = [
    ...(!resource.primary_key.selected ? ["source-proven single-column primary or unique row identifier is unresolved"] : []),
    ...(!resource.tenant_key.selected ? ["trusted tenant scope is unresolved"] : []),
  ];
  resource.status = !resource.primary_key.selected
    ? "blocked_identifier"
    : !resource.tenant_key.selected
      ? "blocked_scope"
      : "draft_read";
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

function assertBoundaryCandidateNarrowsDraft(
  draft: ExplorationBoundaryDraft,
  candidate: ExplorationBoundaryDraft,
): void {
  if (candidate.schema_version !== draft.schema_version) throw new Error("Exploration boundary schema version cannot change during review.");
  if (candidate.activation !== "disabled_unreviewed") throw new Error("A reviewed candidate must still be disabled before activation.");
  if (candidate.deployment_profile !== "development" && candidate.deployment_profile !== "staging") {
    throw new Error("Scoped Explore activation is limited to an explicit development or staging profile.");
  }
  if (!/^[a-z][a-z0-9_.-]{0,63}$/.test(candidate.pack.name)) {
    throw new Error("The reviewed authoring pack name must be a stable lower-case identifier.");
  }
  for (const immutable of ["source", "compiler_version", "spec_version", "generation_lock_fingerprint", "role_posture_fingerprint"] as const) {
    if (candidate[immutable] !== draft[immutable]) throw new Error(`${immutable} cannot change during boundary review.`);
  }
  if (candidate.reporting_timezone !== draft.reporting_timezone) {
    throw new Error("reporting_timezone cannot change during boundary review.");
  }
  if (candidate.reporting_timezone !== undefined && candidate.reporting_timezone !== "UTC") {
    throw new Error("Generated Scoped Explore boundaries currently support only the reviewed UTC reporting timezone.");
  }
  if (JSON.stringify(candidate.trusted_context) !== JSON.stringify(draft.trusted_context)) {
    throw new Error("trusted_context cannot change during boundary review.");
  }
  assertBudgetsNarrow(draft.budgets, candidate.budgets);
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
    if (JSON.stringify(resource.field_types) !== JSON.stringify(original.field_types)
      || JSON.stringify(resource.field_enums) !== JSON.stringify(original.field_enums)
      || JSON.stringify(resource.rls_session ?? null) !== JSON.stringify(original.rls_session ?? null)) {
      throw new Error(`${resource.id} field types, enums, and RLS session bindings cannot change during review.`);
    }
    assertSubset(resource.selectable_fields, original.selectable_fields, `${resource.id} selectable fields`);
    assertSubset(resource.sortable_fields, original.sortable_fields, `${resource.id} sortable fields`);
    assertSubset(resource.groupable_fields, original.groupable_fields, `${resource.id} groupable fields`);
    assertSubset(resource.aggregate_measures, original.aggregate_measures, `${resource.id} aggregate measures`);
    assertSubset(resource.count_distinct_fields, original.count_distinct_fields, `${resource.id} count-distinct fields`);
    assertSubset(original.kept_out_fields, resource.kept_out_fields, `${resource.id} generated kept-out fields`);
    assertSubset(resource.kept_out_fields, Object.keys(original.field_types), `${resource.id} kept-out fields`);
    const originalWithheld = original.model_withheld_fields ?? [];
    const candidateWithheld = resource.model_withheld_fields ?? [];
    assertSubset(candidateWithheld, originalWithheld, `${resource.id} model-withheld fields`);
    assertSubset(candidateWithheld, Object.keys(original.field_types), `${resource.id} model-withheld fields`);
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
      if ((relationship.path_depth ?? 1) > candidate.budgets.max_relationship_hops) {
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
      if (links.length !== (relationship.path_depth ?? 1) || links.length < 1 || links.length > 2) {
        throw new Error(`${resource.id} relationship ${relationship.id} has invalid structural path proof.`);
      }
      for (const link of links) {
        const source = candidateResources.get(link.source_resource);
        const target = candidateResources.get(link.target_resource);
        if (!source || !target) {
          throw new Error(`${resource.id} relationship ${relationship.id} leaves the reviewed pack.`);
        }
        if (link.cardinality !== "many_to_one" || link.max_fan_out !== 1
          || link.target_uniqueness.columns.length !== link.target_columns.length
          || link.target_uniqueness.columns.some((field, index) => field !== link.target_columns[index])) {
          throw new Error(`${resource.id} relationship ${relationship.id} is not cardinality-proven many-to-one.`);
        }
        const usesKeptOutJoinKey =
          link.source_columns.some((field) => source.kept_out_fields.includes(field))
          || link.target_columns.some((field) => target.kept_out_fields.includes(field));
        const isTrustedTenantLink = link.source_columns.length === 1
          && link.target_columns.length === 1
          && link.source_columns[0] === source.tenant_key
          && link.target_columns[0] === target.tenant_key;
        if (usesKeptOutJoinKey && !isTrustedTenantLink) {
          throw new Error(`${resource.id} relationship ${relationship.id} cannot use a kept-out field.`);
        }
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

function relationshipMatchesReviewedDraft(
  expected: ExplorationRelationship,
  candidate: ExplorationRelationship,
): boolean {
  if (expected.unmatched_rows !== "review_required") {
    return JSON.stringify(candidate) === JSON.stringify(expected);
  }
  if (candidate.unmatched_rows !== "exclude" && candidate.unmatched_rows !== "keep_null") return false;
  const expectedRest = { ...expected, unmatched_rows: undefined };
  const candidateRest = { ...candidate, unmatched_rows: undefined };
  return JSON.stringify(candidateRest) === JSON.stringify(expectedRest);
}

export function requiredReviewDecisionsForCandidate(
  draft: ExplorationBoundaryDraft,
  candidate: ExplorationBoundaryDraft,
): string[] {
  const retained = new Map(candidate.pack.resources.map((resource) => [resource.id, resource]));
  return draft.unresolved_decisions.filter((decision) => {
    if (decision.startsWith("deployment profile:")
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
      throw new Error(`Exploration budget ${key} cannot be added during review.`);
    }
  }
  for (const key of Object.keys(draft) as Array<keyof ExplorationBudgets>) {
    const value = candidate[key];
    const generated = draft[key];
    if (!Number.isSafeInteger(value) || !Number.isSafeInteger(generated)
      || Number(value) < 1 || Number(value) > Number(generated)) {
      throw new Error(`Exploration budget ${key} may only stay the same or decrease.`);
    }
  }
  if (candidate.max_ranked_groups !== undefined
    && candidate.max_ranked_groups < candidate.max_groups) {
    throw new Error("Exploration budget max_ranked_groups cannot be lower than max_groups.");
  }
}

export function reviewedRankedGroupLimit(budgets: ExplorationBudgets): number {
  return budgets.max_ranked_groups ?? budgets.max_groups;
}

function assertExploreRolePosture(inspection: SchemaInspection, candidate: ExplorationBoundaryDraft): void {
  const role = inspection.role_posture;
  const enginePrivilegePostureSafe = inspection.engine === "mysql"
    ? (role?.superuser === false || role?.superuser === "unsupported")
      && (role?.bypass_rls === false || role?.bypass_rls === "unsupported")
    : role?.superuser === false && role?.bypass_rls === false;
  if (!role?.verified || !role.read_only || !enginePrivilegePostureSafe) {
    throw new Error("Scoped Explore requires a verified non-superuser, non-BYPASSRLS, read-only database role.");
  }
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
  const namePattern = kind === "tenant" ? TENANT_SCOPE_NAME : PRINCIPAL_SCOPE_NAME;
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
  if (detail.startsWith("existing Synapsor") || detail.includes("contract") || detail.includes("capability")) return "synapsor";
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
  const settingPattern = kind === "tenant"
    ? /(?:^|[._-])(?:tenant|org|organization|workspace|merchant|store|company|team|facility|property|clinic|project)(?:$|[._-])/i
    : /(?:^|[._-])(?:principal|user|actor|owner|assignee|agent|staff|technician|manager|trainer)(?:$|[._-])/i;
  const columnPattern = kind === "tenant" ? TENANT_SCOPE_NAME : PRINCIPAL_SCOPE_NAME;
  return settingPattern.test(setting) || columnPattern.test(column);
}

function buildResource(
  table: TableInfo,
  inspection: SchemaInspection,
  staticObjects: Array<{ format: SchemaCandidateFormat; object: CandidateObject }>,
  existing: ExistingScopeEvidence,
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
  });
  const principalInference = rankedScopeInference({
    kind: "principal",
    table,
    inspection,
    staticObjects,
    existing,
  });
  const tenantSelected = tenantInference.selected;
  const principalSelected = principalInference.selected;
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
        description: column.comment,
        source: "database",
      });
      const databaseClassification = column.suggestions.sensitivity
        ? moreRestrictiveSensitivity(column.suggestions.sensitivity, deterministicClassification)
        : deterministicClassification;
      const staticClassifications = staticObjects.flatMap((item) =>
        item.object.fields
          .filter((field) => field.name === column.name)
          .map((field) => field.sensitivity));
      const sensitivity = [databaseClassification, ...staticClassifications]
        .reduce(moreRestrictiveSensitivity);
      const keptOutByClassification = sensitivity.state !== "structurally_low_risk";
      return {
        name: column.name,
        data_type: column.data_type,
        nullable: column.nullable,
        primary_key: table.primary_key.includes(column.name),
        sensitive_suggestion: keptOutByClassification,
        sensitivity,
        raw_visible_suggestion: !keptOutByClassification && !column.suggestions.large_or_binary,
        aggregate_measure_suggestion: !keptOutByClassification && isNumericType(column.data_type),
        count_distinct_suggestion: table.primary_key.includes(column.name) && !keptOutByClassification,
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
      using_expressions: (table.row_level_security_policies ?? []).flatMap((policy) => policy.using_expression ? [policy.using_expression] : []).sort(),
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
  for (const resource of graph.resources.filter((candidate) => candidate.status === "draft_read")) {
    const primaryKey = resource.primary_key.selected!;
    const tenantKey = resource.tenant_key.selected!;
    const principalKey = resource.principal_key.selected;
    const object = singularize(resource.table);
    const capabilityName = `${safeNamespace(resource.schema)}.inspect_${safeIdentifier(object)}`;
    const lookupArg = `${safeIdentifier(object)}_id`;
    const trustedScopeFields = new Set([tenantKey, principalKey].filter((field): field is string => Boolean(field)));
    const trustedScopeReadableFields = reviewedTrustedScopeReadableFields(resource);
    const visible = unique([
      ...(!trustedScopeFields.has(primaryKey) || trustedScopeReadableFields.has(primaryKey) ? [primaryKey] : []),
      ...resource.fields
        .filter((field) => field.raw_visible_suggestion
          && (!trustedScopeFields.has(field.name) || trustedScopeReadableFields.has(field.name)))
        .map((field) => field.name),
    ]);
    const modelWithheld = resource.fields
      .filter((field) =>
        field.review_override?.exposure === "withhold_from_model"
        && visible.includes(field.name))
      .map((field) => field.name);
    const keptOut = unique([
      ...resource.fields.filter((field) => field.sensitive_suggestion || !field.raw_visible_suggestion).map((field) => field.name),
      ...[...trustedScopeFields].filter((field) => !trustedScopeReadableFields.has(field)),
    ]);
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
    const selectable = resource.fields
      .filter((field) => field.raw_visible_suggestion
        && (!trustedScopeFields.has(field.name) || trustedScopeReadableFields.has(field.name)))
      .map((field) => field.name);
    const sortable = selectable.filter((field) => !trustedScopeFields.has(field));
    const filterable = Object.fromEntries(resource.fields
      .filter((field) => field.raw_visible_suggestion && !trustedScopeFields.has(field.name))
      .map((field) => [field.name, operatorsForType(field.data_type)]));
    const relationships = resource.relationships
      .filter((relationship) => {
        const target = graph.resources.find((candidate) => candidate.id === relationship.referenced_resource);
        const trustedTenantRelationship = Boolean(
          resource.tenant_key.selected
          && target?.tenant_key.selected
          && relationship.columns.length === 1
          && relationship.referenced_columns.length === 1
          && relationship.columns[0] === resource.tenant_key.selected
          && relationship.referenced_columns[0] === target.tenant_key.selected,
        );
        if (!target
          || target.status !== "draft_read"
          || !relationship.cardinality_proven
          || !relationship.target_uniqueness
          || relationship.columns.length !== 1
          || relationship.referenced_columns.length !== 1
          || (relationship.columns.some((field) => keptOutSet.has(field))
            && !trustedTenantRelationship)) {
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
        return !relationship.referenced_columns.some((field) => targetKeptOut.has(field))
          || trustedTenantRelationship;
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
      primary_key: resource.primary_key.selected!,
      tenant_key: resource.tenant_key.selected!,
      ...(resource.principal_key.selected ? { principal_key: resource.principal_key.selected } : {}),
      field_types: Object.fromEntries(resource.fields.map((field) => [field.name, field.data_type])),
      field_enums: Object.fromEntries(resource.fields
        .filter((field) => field.evidence.some((item) => item.startsWith("database enum values:")))
        .map((field) => [
          field.name,
          field.evidence.find((item) => item.startsWith("database enum values:"))!.slice("database enum values:".length).trim().split(/,\s*/),
        ])),
      selectable_fields: selectable,
      filterable_fields: filterable,
      sortable_fields: sortable,
      groupable_fields: resource.fields.filter((field) => field.groupable_suggestion
        && !keptOutSet.has(field.name)
        && !trustedScopeFields.has(field.name)).map((field) => field.name),
      aggregate_measures: resource.fields.filter((field) => field.aggregate_measure_suggestion
        && !keptOutSet.has(field.name)
        && !trustedScopeFields.has(field.name)).map((field) => field.name),
      count_distinct_fields: resource.fields.filter((field) => field.count_distinct_suggestion
        && !keptOutSet.has(field.name)
        && !trustedScopeFields.has(field.name)).map((field) => field.name),
      time_bucket_fields: Object.fromEntries(resource.fields.filter((field) => field.time_bucket_suggestion
        && !keptOutSet.has(field.name)
        && !trustedScopeFields.has(field.name)).map((field) => [
        field.name,
        ["day", "week", "month"] as Array<"day" | "week" | "month">,
      ])),
      kept_out_fields: keptOut,
      ...(modelWithheld.length ? { model_withheld_fields: modelWithheld } : {}),
      relationships,
      ...explorationRlsSession(resource),
      minimum_cohort_size: resource.minimum_cohort_override?.value ?? 5,
      ...(resource.minimum_cohort_override ? { minimum_cohort_overridden: true as const } : {}),
      suppression_aware_totals: true as const,
    };
  });
  addDepthTwoExplorationPaths(resources);
  const databaseRoleTenantSetting = graph.engine === "postgres"
    ? commonDatabaseRoleTenantSetting(resources)
    : undefined;
  const draft: ExplorationBoundaryDraft = {
    schema_version: EXPLORATION_BOUNDARY_VERSION,
    activation: "disabled_unreviewed" as const,
    deployment_profile: "staging" as const,
    source: sourceName,
    compiler_version: AUTO_BOUNDARY_COMPILER_VERSION,
    spec_version: AUTO_BOUNDARY_SPEC_VERSION,
    reporting_timezone: "UTC",
    trusted_context: {
      provider: "environment" as const,
      tenant_env: "SYNAPSOR_TENANT_ID",
      principal_env: "SYNAPSOR_PRINCIPAL",
      ...(databaseRoleTenantSetting ? {
        database_role_tenant: {
          engine: "postgres" as const,
          setting: databaseRoleTenantSetting,
        },
      } : {}),
    },
    generation_lock_fingerprint: lockFingerprint,
    role_posture_fingerprint: graph.database_role.fingerprint,
    pack: { name: "reviewed_staging", resources },
    budgets: { ...DEFAULT_BUDGETS },
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
  if (resources.length === 0) return undefined;
  const settings = unique(resources.map((resource) => resource.rls_session?.tenant_setting)
    .filter((setting): setting is string => Boolean(setting)));
  if (settings.length !== 1) return undefined;
  return resources.every((resource) => resource.rls_session?.tenant_setting === settings[0])
    ? settings[0]
    : undefined;
}

function addDepthTwoExplorationPaths(
  resources: ExplorationBoundaryDraft["pack"]["resources"],
): void {
  const byId = new Map(resources.map((resource) => [resource.id, resource]));
  for (const root of resources) {
    const factShaped = root.relationships.length >= 2
      || root.aggregate_measures.some((field) => !isReferenceIdentifierName(field))
      || Object.keys(root.time_bucket_fields).length > 0;
    if (!factShaped) continue;
    const directTargets = new Set(
      root.relationships
        .filter((relationship) => relationship.path_depth === 1)
        .map((relationship) => relationship.target_resource),
    );
    const candidates: ExplorationRelationship[] = [];
    for (const first of root.relationships.filter((relationship) => relationship.path_depth === 1)) {
      const intermediate = byId.get(first.target_resource);
      if (!intermediate) continue;
      for (const second of intermediate.relationships.filter((relationship) => relationship.path_depth === 1)) {
        if (second.target_resource === root.id || second.target_resource === intermediate.id) continue;
        if (directTargets.has(second.target_resource)) continue;
        const links = [
          ...(first.proof?.links ?? []),
          ...(second.proof?.links ?? []),
        ];
        if (links.length !== 2) continue;
        const nullable = links.some((link) => link.nullable);
        candidates.push({
          id: `${first.id}__${second.id}`,
          target_resource: second.target_resource,
          local_columns: [...first.local_columns],
          target_columns: [...second.target_columns],
          counted_entity: root.primary_key,
          cardinality: "many_to_one",
          max_fan_out: 1,
          path_depth: 2,
          proof: {
            source: "database_catalog",
            links: structuredClone(links),
            digest: canonicalJsonDigest(links),
          },
          nullable,
          unmatched_rows: nullable ? "review_required" : "exclude",
        });
      }
    }
    const pathsByTarget = new Map<string, ExplorationRelationship[]>();
    for (const candidate of candidates) {
      const group = pathsByTarget.get(candidate.target_resource) ?? [];
      group.push(candidate);
      pathsByTarget.set(candidate.target_resource, group);
    }
    const unambiguous = [...pathsByTarget.values()]
      .filter((paths) => paths.length === 1)
      .map((paths) => paths[0]!)
      .sort((left, right) => {
        const leftTarget = byId.get(left.target_resource);
        const rightTarget = byId.get(right.target_resource);
        const score = (target: typeof leftTarget) =>
          (target?.groupable_fields.length ?? 0) * 4
          + Object.keys(target?.time_bucket_fields ?? {}).length * 3
          + (target?.selectable_fields.length ?? 0);
        return score(rightTarget) - score(leftTarget) || left.id.localeCompare(right.id);
      })
      .slice(0, MAX_DEPTH_TWO_RELATIONSHIP_CANDIDATES_PER_RESOURCE);
    root.relationships.push(...unambiguous);
    root.relationships.sort((left, right) =>
      (left.path_depth ?? 1) - (right.path_depth ?? 1) || left.id.localeCompare(right.id));
  }
}

function generatedContractTests(
  graph: AutoBoundaryEvidenceGraph,
  digest: `sha256:${string}`,
): AutoBoundaryBuild["tests"] {
  const cases: Array<Record<string, unknown>> = [];
  for (const resource of graph.resources.filter((candidate) => candidate.status === "draft_read")) {
    cases.push(
      { name: `${resource.id}: trusted tenant required`, kind: "scope", expected: "deny_without_trusted_tenant" },
      { name: `${resource.id}: model tenant override absent`, kind: "schema", expected: "tenant_not_model_argument" },
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
  boundary?: Pick<ExplorationBoundaryDraft, "pack" | "trusted_context">,
): string[] {
  const boundaryResources = new Map(
    (boundary?.pack.resources ?? []).map((resource) => [resource.id, resource]),
  );
  return unique([
    "deployment profile: confirm development or staging authoring-only use",
    boundary?.trusted_context.database_role_tenant
      ? `trusted context: confirm tenant scope comes from the verified PostgreSQL credential setting ${boundary.trusted_context.database_role_tenant.setting} and principal scope remains outside model arguments`
      : "trusted context: confirm operator-supplied tenant and principal bindings remain outside model arguments",
    ...(!graph.database_role.verified || !graph.database_role.read_only
      ? ["database role: use and verify a non-owner, non-superuser, non-BYPASSRLS, read-only credential before enabling Scoped Explore"]
      : []),
    ...graph.resources.flatMap((resource) => [
    ...(resource.status !== "draft_read" ? resource.blockers.map((blocker) => `${resource.id}: ${blocker}`) : []),
    ...(resource.status === "draft_read" ? [
      `${resource.id}: confirm tenant key ${resource.tenant_key.selected}`,
      `${resource.id}: confirm principal scope ${resource.principal_key.selected ?? "not configured"}`,
      `${resource.id}: confirm visible and kept-out fields`,
      `${resource.id}: confirm filter/sort/group/aggregate-only field permissions`,
      `${resource.id}: confirm minimum cohort and extraction/differencing budgets`,
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
  const lines = [
    "# Auto Boundary Review",
    "",
    "Status: disabled and unreviewed. These files grant no runtime authority until a human activates the exact reviewed digest in the local Workbench.",
    "",
    `Candidate contract digest: \`${build.contract_digest}\``,
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
    ...build.review.unresolved_decisions.map((decision) => `- [ ] ${decision}`),
    "",
    "Database, ORM, and API comments are naming evidence only. They never create read, write, approval, or activation authority.",
    "",
  ];
  return lines.join("\n");
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

function sourceKind(detail: string): "prisma" | "drizzle" | "openapi" | "synapsor" {
  const prefix = detail.split(":", 1)[0];
  return prefix === "prisma" || prefix === "drizzle" || prefix === "openapi" ? prefix : "synapsor";
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

function operatorsForType(type: string): Array<"eq" | "neq" | "lt" | "lte" | "gt" | "gte" | "in"> {
  if (isNumericType(type) || isTimestampType(type)) return ["eq", "neq", "lt", "lte", "gt", "gte", "in"];
  return ["eq", "neq", "in"];
}

function explorationRlsSession(resource: AutoBoundaryResource): { rls_session?: { tenant_setting?: string; principal_setting?: string } } {
  if (resource.rls.enabled !== true) return {};
  const tenant = resource.tenant_key.selected
    ? settingForScopedColumn(resource.rls.using_expressions, resource.tenant_key.selected)
    : undefined;
  const principal = resource.principal_key.selected
    ? settingForScopedColumn(resource.rls.using_expressions, resource.principal_key.selected)
    : undefined;
  if (!tenant && !principal) return {};
  return {
    rls_session: {
      ...(tenant ? { tenant_setting: tenant } : {}),
      ...(principal ? { principal_setting: principal } : {}),
    },
  };
}

function settingForScopedColumn(expressions: string[], column: string): string | undefined {
  const escaped = column.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const columnReference = `(?:(?:[A-Za-z_][A-Za-z0-9_$]*|\"[^\"]+\")\\s*\\.\\s*)?(?:${escaped}|\"${escaped}\")`;
  const settingCall = `current_setting\\(\\s*'([A-Za-z0-9_.-]+)'`;
  const candidates = expressions.flatMap((expression) => {
    const direct = expression.match(new RegExp(`${columnReference}\\s*=\\s*${settingCall}`, "i"));
    const reverse = expression.match(new RegExp(`${settingCall}[^)]*\\)\\s*=\\s*${columnReference}`, "i"));
    return [direct?.[1], reverse?.[1]].filter((value): value is string => Boolean(value));
  });
  const uniqueCandidates = unique(candidates);
  return uniqueCandidates.length === 1 ? uniqueCandidates[0] : undefined;
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
