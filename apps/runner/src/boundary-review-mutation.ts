import fs from "node:fs/promises";
import path from "node:path";
import { Buffer } from "node:buffer";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import {
  inspectDatabase,
  type SchemaInspection,
} from "@synapsor-runner/schema-inspector";
import {
  buildAutoBoundary,
  SHARED_REFERENCE_ACKNOWLEDGEMENT,
  explorationBoundaryCandidateDigest,
  loadActivatedExplorationBoundary,
  loadStructuredProjectEvidence,
  reviewExplorationBoundaryCandidate,
  writeAutoBoundaryArtifacts,
  type AutoBoundaryField,
  type AutoBoundaryBuild,
  type BoundaryInference,
  type DerivedScopeInference,
  type ActivatedExplorationBoundary,
  type ExplorationBoundaryDraft,
  type GenerationLock,
  type SharedReferenceScopeInference,
} from "./auto-boundary.js";
import {
  applyManagedBoundaryReviewDecision,
  boundaryReviewDecisions,
  createBoundaryReviewProgress,
  nativePolicyMigration,
  normalizeManagedBoundaryReviewDecision,
  readBoundaryReviewProgress,
  type BoundaryReviewProgress,
  type ManagedBoundaryReviewDecision,
} from "./boundary-review-domain.js";
import {
  backupLegacyBoundaryReviewOverrides,
  boundaryReviewOverridesForCandidate,
} from "./boundary-review-policy.js";
import { detectProjectContext } from "./project-detection.js";
import { readGuidedOnboardingState } from "./guided-project.js";
import { recommendedBoundaryReviewCandidate } from "./boundary-candidate.js";
import {
  derivedScopeStartSequence,
  formatDerivedScopePath,
  formatDerivedScopePathWithId,
} from "./derived-scope-display.js";

type JsonRecord = Record<string, unknown>;

export type BoundaryResourceReviewRequest = {
  resource_id: string;
  include?: boolean;
  exclude?: boolean;
  row_identity?: string;
  tenant_key?: string;
  tenant_scope_path?: string;
  shared_reference_scope?: typeof SHARED_REFERENCE_ACKNOWLEDGEMENT;
  principal_key?: string | null;
  principal_scope_path?: string | null;
  keep_out_fields?: string[];
  withhold_from_model_fields?: string[];
  allow_reviewed_fields?: string[];
  selectable_fields?: string[];
  filterable_fields?: string[];
  sortable_fields?: string[];
  groupable_fields?: string[];
  aggregate_measures?: string[];
  count_distinct_fields?: string[];
  time_bucket_fields?: string[];
  field_enum?: {
    field: string;
    values: string[];
  };
  minimum_cohort_size?: number;
  max_ranked_groups?: number;
  relationship_ids?: string[];
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
};

export type BoundaryReviewMutationPreview = {
  schema_version: "synapsor.boundary-review-mutation-preview.v1";
  bindings: BoundaryReviewMutationBindings;
  request: BoundaryResourceReviewRequest;
  decision_digest: `sha256:${string}`;
  candidate_digest: `sha256:${string}`;
  generated_contract_digest: `sha256:${string}`;
  semantic_diff: BoundaryReviewSemanticDiff;
  candidate: ExplorationBoundaryDraft;
  build: AutoBoundaryBuild;
  previous_progress?: BoundaryReviewProgress;
  partial_scope_resolution: boolean;
  boundary_root: string;
  source_database_changed: false;
};

export type BoundaryReviewMutationBatchPreview = {
  schema_version: "synapsor.boundary-review-mutation-batch-preview.v1";
  bindings: BoundaryReviewMutationBindings;
  requests: BoundaryResourceReviewRequest[];
  decision_digest: `sha256:${string}`;
  candidate_digest: `sha256:${string}`;
  generated_contract_digest: `sha256:${string}`;
  semantic_diff: BoundaryReviewSemanticDiff[];
  candidate: ExplorationBoundaryDraft;
  build: AutoBoundaryBuild;
  previous_progress?: BoundaryReviewProgress;
  boundary_root: string;
  source_database_changed: false;
};

export type BoundaryReviewSemanticDiff = {
  resource_id: string;
  before_included: boolean;
  after_included: boolean;
  selected_row_identity: string | null;
  selected_tenant_key: string | null;
  selected_tenant_scope_path?: string;
  selected_shared_reference_scope: boolean;
  selected_principal_key: string | null;
  selected_principal_scope_path?: string;
  added_visible_fields: string[];
  removed_visible_fields: string[];
  added_kept_out_fields: string[];
  removed_kept_out_fields: string[];
  added_model_withheld_fields: string[];
  removed_model_withheld_fields: string[];
  reviewed_enum_changes: Array<{
    field: string;
    before: string[];
    after: string[];
  }>;
  added_relationships: string[];
  removed_relationships: string[];
  minimum_cohort_before: number | null;
  minimum_cohort_after: number | null;
  minimum_cohort_overridden: boolean;
  max_ranked_groups_before: number | null;
  max_ranked_groups_after: number | null;
  structural_review_changed: boolean;
  authority_changed: boolean;
  source_database_changed: false;
};

export type BoundaryResourceReviewView = {
  ok: true;
  resource_id: string;
  status: string;
  included: boolean;
  blockers: string[];
  row_identity: BoundaryInference<string>;
  tenant_key: BoundaryInference<string>;
  derived_tenant_scope?: DerivedScopeInference;
  shared_reference_scope?: SharedReferenceScopeInference;
  principal_key: BoundaryInference<string>;
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
  }>;
  candidate: ExplorationBoundaryDraft["pack"]["resources"][number] | null;
  generated_candidate: ExplorationBoundaryDraft["pack"]["resources"][number] | null;
  bindings: BoundaryReviewMutationBindings;
  source_database_changed: false;
};

export type BoundaryResourceReviewSummary = {
  candidate_boundary_name: string;
  active_boundary_name?: string;
  resource_id: string;
  resource_type: "table" | "view";
  status: string;
  included: boolean;
  active: boolean;
  blockers: string[];
  pending_decisions: string[];
  risk_count: number;
  model_visible_fields: number;
  runner_output_only_fields: number;
  kept_out_fields: number;
  minimum_cohort_size?: number;
  minimum_cohort_overridden?: boolean;
  inline_resolution_available?: boolean;
  first_table_startable?: boolean;
  first_table_guidance?: string;
  first_table_scope_label?: string;
  derived_tenant_scope?: DerivedScopeInference;
  shared_reference_scope?: SharedReferenceScopeInference;
  derived_principal_scope?: DerivedScopeInference;
  relationships: Array<{
    relationship_id: string;
    target_resource: string;
    path_depth: number;
    state: "available" | "included" | "active";
  }>;
};

type BoundaryReviewFiles = {
  boundary_root: string;
  draft: ExplorationBoundaryDraft;
  lock: GenerationLock;
  review: {
    resources: Array<{
      id: string;
      type?: "table" | "view";
      status: string;
      blockers: string[];
      primary_key: BoundaryInference<string>;
      tenant_key: BoundaryInference<string>;
      derived_tenant_scope?: DerivedScopeInference;
      shared_reference_scope?: SharedReferenceScopeInference;
      principal_key: BoundaryInference<string>;
      derived_principal_scope?: DerivedScopeInference;
      fields: AutoBoundaryField[];
      relationships: BoundaryResourceReviewView["relationships"];
    }>;
  };
  progress?: BoundaryReviewProgress;
  candidate: ExplorationBoundaryDraft;
};

export async function inspectBoundaryResourceReview(
  projectRoot: string,
  resourceId: string,
): Promise<BoundaryResourceReviewView> {
  const state = await loadBoundaryReviewFiles(projectRoot);
  const reviewed = state.review.resources.find((resource) => resource.id === resourceId);
  if (!reviewed) throw new Error(`Boundary review resource ${resourceId} was not found in the inspected schema.`);
  const candidate = state.candidate.pack.resources.find((resource) => resource.id === resourceId) ?? null;
  const generatedCandidate = state.draft.pack.resources.find((resource) => resource.id === resourceId) ?? null;
  return {
    ok: true,
    resource_id: resourceId,
    status: reviewed.status,
    included: Boolean(candidate),
    blockers: reviewed.blockers,
    row_identity: reviewed.primary_key,
    tenant_key: reviewed.tenant_key,
    ...(reviewed.derived_tenant_scope
      ? { derived_tenant_scope: reviewed.derived_tenant_scope }
      : {}),
    ...(reviewed.shared_reference_scope
      ? { shared_reference_scope: reviewed.shared_reference_scope }
      : {}),
    principal_key: reviewed.principal_key,
    ...(reviewed.derived_principal_scope
      ? { derived_principal_scope: reviewed.derived_principal_scope }
      : {}),
    fields: reviewed.fields,
    relationships: reviewed.relationships,
    candidate,
    generated_candidate: generatedCandidate,
    bindings: reviewBindings(state),
    source_database_changed: false,
  };
}

export async function listBoundaryResourceReviews(
  projectRoot: string,
): Promise<BoundaryResourceReviewSummary[]> {
  const state = await loadBoundaryReviewFiles(projectRoot);
  const activeBoundary = await readOptionalActivatedBoundary(
    path.resolve(projectRoot),
    state.candidate.pack.name,
  );
  const confirmed = new Set(state.progress?.confirmed_decisions ?? []);
  return state.review.resources
    .map((resource) => {
      const generated = state.draft.pack.resources.find((candidate) => candidate.id === resource.id);
      const candidate = state.candidate.pack.resources.find((item) => item.id === resource.id);
      const active = activeBoundary?.pack.resources.find((item) => item.id === resource.id);
      const display = candidate ?? generated;
      const firstTable = firstTableAvailability(
        Boolean(state.candidate.organization_scope),
        resource,
      );
      const pendingDecisions = state.candidate.unresolved_decisions
        .filter((decision) => decision.startsWith(`${resource.id}:`) && !confirmed.has(decision));
      return {
        candidate_boundary_name: state.candidate.pack.name,
        ...(activeBoundary?.pack.name
          ? { active_boundary_name: activeBoundary.pack.name }
          : {}),
        resource_id: resource.id,
        resource_type: resource.type === "view" ? "view" as const : "table" as const,
        status: resource.status,
        included: Boolean(candidate),
        active: Boolean(active),
        blockers: [...resource.blockers],
        pending_decisions: pendingDecisions,
        risk_count: pendingDecisions.length + resource.blockers.length,
        model_visible_fields: display
          ? display.selectable_fields.filter(
            (field) => !(display.model_withheld_fields ?? []).includes(field),
          ).length
          : 0,
        runner_output_only_fields: display?.model_withheld_fields?.length ?? 0,
        kept_out_fields: display?.kept_out_fields.length ?? resource.fields.length,
        ...(display ? {
          minimum_cohort_size: display.minimum_cohort_size,
          ...(display.minimum_cohort_overridden === true
            ? { minimum_cohort_overridden: true }
            : {}),
        } : {}),
        inline_resolution_available:
          resource.status !== "blocked_role"
          && Boolean(resource.primary_key.selected || resource.primary_key.candidates.length)
          && Boolean(
            resource.tenant_key.selected
            || resource.tenant_key.candidates.length
            || resource.derived_tenant_scope?.candidates.length
            || resource.shared_reference_scope?.eligible,
          ),
        ...firstTable,
        ...(resource.derived_tenant_scope
          ? { derived_tenant_scope: structuredClone(resource.derived_tenant_scope) }
          : {}),
        ...(resource.shared_reference_scope
          ? { shared_reference_scope: structuredClone(resource.shared_reference_scope) }
          : {}),
        ...(resource.derived_principal_scope
          ? { derived_principal_scope: structuredClone(resource.derived_principal_scope) }
          : {}),
        relationships: boundaryRelationshipSummaries(generated, candidate, active),
      };
    })
    .sort((left, right) =>
      right.risk_count - left.risk_count || left.resource_id.localeCompare(right.resource_id));
}

function firstTableAvailability(
  singleOrganization: boolean,
  resource: BoundaryReviewFiles["review"]["resources"][number],
): Pick<
  BoundaryResourceReviewSummary,
  "first_table_startable" | "first_table_guidance" | "first_table_scope_label"
> {
  if (!resource.primary_key.selected && resource.primary_key.candidates.length === 0) {
    return { first_table_startable: true };
  }

  const requiredScopes = [
    ...(!singleOrganization
      && !resource.tenant_key.selected
      && resource.tenant_key.candidates.length === 0
      ? [resource.derived_tenant_scope?.selected
        ?? resource.derived_tenant_scope?.candidates[0]]
      : []),
    ...(!resource.principal_key.selected && resource.derived_principal_scope?.selected
      ? [resource.derived_principal_scope.selected]
      : []),
  ].filter((scope): scope is NonNullable<typeof scope> => Boolean(scope));
  if (requiredScopes.length === 0) return { first_table_startable: true };

  const paths = requiredScopes.map((scope) => {
    const sequence = derivedScopeStartSequence(scope);
    const ancestor = sequence[0] ?? scope.ancestor_resource;
    const intermediate = sequence.slice(1, -1);
    return {
      scope,
      guidance: intermediate.length > 0
        ? "start with " + ancestor + ", then add " + intermediate.join(", then ") + ", then add this table"
        : "start with " + ancestor + ", then add this table",
    };
  });
  return {
    first_table_startable: false,
    first_table_scope_label: paths.map(({ scope }) => formatDerivedScopePath(scope)).join("; "),
    first_table_guidance: paths.length === 1
      ? paths[0]!.guidance
      : "satisfy both required scope paths: " + paths.map(({ guidance }) => guidance).join("; "),
  };
}

export async function currentBoundaryReviewMutationBindings(
  projectRoot: string,
): Promise<BoundaryReviewMutationBindings> {
  return reviewBindings(await loadBoundaryReviewFiles(projectRoot));
}

export async function prepareBoundaryResourceReviewMutation(
  projectRoot: string,
  request: BoundaryResourceReviewRequest,
  schemaInspector: typeof inspectDatabase = inspectDatabase,
): Promise<BoundaryReviewMutationPreview> {
  validateBoundaryResourceRequest(request);
  const state = await loadBoundaryReviewFiles(projectRoot);
  const reviewed = state.review.resources.find((resource) => resource.id === request.resource_id);
  if (!reviewed) {
    throw new Error(`Boundary review resource ${request.resource_id} was not found in the inspected schema.`);
  }
  validateBoundaryRequestAgainstResource(request, reviewed);
  const previousBindings = reviewBindings(state);
  const managedDecisions = managedDecisionsForRequest(request);
  const inspection = await schemaInspector({
    engine: state.lock.engine,
    databaseUrlEnv: state.lock.source_env,
    schema: state.lock.inspected_schema,
    env: process.env,
  });
  assertCurrentInspectedResource(inspection, request.resource_id);
  const project = await detectProjectContext(projectRoot);
  const evidence = await loadStructuredProjectEvidence(project);
  const cleanBuild = buildReviewMutationBoundary({
    inspection,
    project,
    evidence,
    state,
  });
  let overrides = boundaryReviewOverridesForCandidate({
    progress: state.progress,
    baseline: cleanBuild.exploration_boundary,
    candidate: state.candidate,
    actor: request.actor,
    now: request.decided_at,
  });
  for (const decision of managedDecisions) {
    overrides = applyManagedBoundaryReviewDecision(overrides, decision);
  }
  const build = buildAutoBoundary({
    inspection,
    project,
    parsedEvidence: evidence.parsed,
    existingContracts: evidence.existingContracts,
    sourceEnv: state.lock.source_env,
    inspectedSchema: state.lock.inspected_schema,
    overrides,
    deploymentProfile: state.candidate.deployment_profile,
    ...(state.candidate.trusted_context.provider === "http_claims" ? {
      httpClaims: {
        tenantClaim: state.candidate.trusted_context.tenant_claim,
        principalClaim: state.candidate.trusted_context.principal_claim,
      },
    } : {}),
    ...(state.candidate.organization_scope ? {
      singleOrganization: { organizationId: state.candidate.organization_scope.organization_id },
    } : {}),
  });

  const candidate = buildReviewedCandidate({
    previous: state.candidate,
    generated: build.exploration_boundary,
    request,
  });
  const partialScopeResolution = request.include === true
    && canStageIncompleteScopeResolution(request)
    && !build.exploration_boundary.pack.resources.some(
      (resource) => resource.id === request.resource_id,
    );
  const preview = partialScopeResolution
    ? {
      candidate,
      digest: explorationBoundaryCandidateDigest(candidate),
    }
    : reviewExplorationBoundaryCandidate(build.exploration_boundary, candidate);
  assertRequestedExposureState(request, preview.candidate);
  const diff = semanticDiff(
    request.resource_id,
    state.candidate,
    preview.candidate,
    managedDecisions.length > 0,
  );
  const decisionCore = {
    schema_version: "synapsor.boundary-review-mutation-decision.v1",
    bindings: previousBindings,
    request: canonicalReviewRequest(request),
    next: {
      generated_contract_digest: build.contract_digest,
      generation_lock_fingerprint: build.exploration_boundary.generation_lock_fingerprint,
      schema_fingerprint: build.lock.schema_fingerprint,
      role_posture_fingerprint: build.lock.role_posture_fingerprint,
      candidate_digest: preview.digest,
    },
    semantic_diff: diff,
  };

  return {
    schema_version: "synapsor.boundary-review-mutation-preview.v1",
    bindings: previousBindings,
    request,
    decision_digest: canonicalJsonDigest(decisionCore),
    candidate_digest: preview.digest,
    generated_contract_digest: build.contract_digest,
    semantic_diff: diff,
    candidate: preview.candidate,
    build,
    ...(state.progress ? { previous_progress: state.progress } : {}),
    partial_scope_resolution: partialScopeResolution,
    boundary_root: state.boundary_root,
    source_database_changed: false,
  };
}

export async function prepareBoundaryReviewMutationBatch(
  projectRoot: string,
  requests: BoundaryResourceReviewRequest[],
  schemaInspector: typeof inspectDatabase = inspectDatabase,
  expectedBindings?: BoundaryReviewMutationBindings,
): Promise<BoundaryReviewMutationBatchPreview> {
  if (requests.length < 1 || requests.length > 500) {
    throw new Error("Boundary-review decision files must contain 1-500 resource decisions.");
  }
  const identities = new Set(requests.map((request) => request.actor));
  if (identities.size !== 1) {
    throw new Error("One atomic boundary-review decision file must use one verified reviewer identity.");
  }
  for (const request of requests) validateBoundaryResourceRequest(request);
  const duplicateResources = requests
    .map((request) => request.resource_id)
    .filter((resource, index, values) => values.indexOf(resource) !== index);
  if (duplicateResources.length) {
    throw new Error(`Boundary-review decision file repeats resource(s): ${[...new Set(duplicateResources)].sort().join(", ")}.`);
  }
  const state = await loadBoundaryReviewFiles(projectRoot);
  if (expectedBindings) assertBindingsEqual(expectedBindings, reviewBindings(state));
  const knownResources = new Set(state.review.resources.map((resource) => resource.id));
  const unknown = requests.filter((request) => !knownResources.has(request.resource_id));
  if (unknown.length) {
    throw new Error(`Boundary-review decision file references unknown resource ${unknown[0]!.resource_id}.`);
  }
  for (const request of requests) {
    validateBoundaryRequestAgainstResource(
      request,
      state.review.resources.find((resource) => resource.id === request.resource_id)!,
    );
  }
  const bindings = reviewBindings(state);
  const inspection = await schemaInspector({
    engine: state.lock.engine,
    databaseUrlEnv: state.lock.source_env,
    schema: state.lock.inspected_schema,
    env: process.env,
  });
  for (const request of requests) assertCurrentInspectedResource(inspection, request.resource_id);
  const project = await detectProjectContext(projectRoot);
  const evidence = await loadStructuredProjectEvidence(project);
  const cleanBuild = buildReviewMutationBoundary({
    inspection,
    project,
    evidence,
    state,
  });
  let overrides = boundaryReviewOverridesForCandidate({
    progress: state.progress,
    baseline: cleanBuild.exploration_boundary,
    candidate: state.candidate,
    actor: requests[0]!.actor,
    now: requests[0]!.decided_at,
  });
  for (const request of requests) {
    for (const decision of managedDecisionsForRequest(request)) {
      overrides = applyManagedBoundaryReviewDecision(overrides, decision);
    }
  }
  const build = buildAutoBoundary({
    inspection,
    project,
    parsedEvidence: evidence.parsed,
    existingContracts: evidence.existingContracts,
    sourceEnv: state.lock.source_env,
    inspectedSchema: state.lock.inspected_schema,
    overrides,
    deploymentProfile: state.candidate.deployment_profile,
    ...(state.candidate.trusted_context.provider === "http_claims" ? {
      httpClaims: {
        tenantClaim: state.candidate.trusted_context.tenant_claim,
        principalClaim: state.candidate.trusted_context.principal_claim,
      },
    } : {}),
    ...(state.candidate.organization_scope ? {
      singleOrganization: { organizationId: state.candidate.organization_scope.organization_id },
    } : {}),
  });
  let candidate = state.candidate;
  const differences: BoundaryReviewSemanticDiff[] = [];
  for (const request of requests) {
    const next = buildReviewedCandidate({
      previous: candidate,
      generated: build.exploration_boundary,
      request,
    });
    assertRequestedExposureState(request, next);
    differences.push(semanticDiff(
      request.resource_id,
      candidate,
      next,
      managedDecisionsForRequest(request).length > 0,
    ));
    candidate = next;
  }
  const reviewed = reviewExplorationBoundaryCandidate(build.exploration_boundary, candidate);
  const core = {
    schema_version: "synapsor.boundary-review-mutation-batch-decision.v1",
    bindings,
    requests: requests.map(canonicalReviewRequest),
    next: {
      generated_contract_digest: build.contract_digest,
      generation_lock_fingerprint: build.exploration_boundary.generation_lock_fingerprint,
      schema_fingerprint: build.lock.schema_fingerprint,
      role_posture_fingerprint: build.lock.role_posture_fingerprint,
      candidate_digest: reviewed.digest,
    },
    semantic_diff: differences,
  };
  return {
    schema_version: "synapsor.boundary-review-mutation-batch-preview.v1",
    bindings,
    requests,
    decision_digest: canonicalJsonDigest(core),
    candidate_digest: reviewed.digest,
    generated_contract_digest: build.contract_digest,
    semantic_diff: differences,
    candidate: reviewed.candidate,
    build,
    ...(state.progress ? { previous_progress: state.progress } : {}),
    boundary_root: state.boundary_root,
    source_database_changed: false,
  };
}

export async function commitBoundaryResourceReviewMutation(
  projectRoot: string,
  preview: BoundaryReviewMutationPreview,
): Promise<{
  candidate_digest: `sha256:${string}`;
  review_revision: number;
  semantic_diff: BoundaryReviewSemanticDiff;
  source_database_changed: false;
}> {
  if (preview.partial_scope_resolution) {
    if (preview.candidate.pack.resources.length === 0) {
      const current = await loadBoundaryReviewFiles(projectRoot);
      assertBindingsEqual(preview.bindings, reviewBindings(current));
      await writeAutoBoundaryArtifacts({
        projectRoot,
        outputRoot: path.relative(projectRoot, preview.boundary_root),
        build: preview.build,
        force: true,
        preserveReviewProgress: false,
        preserveActiveBoundary: true,
      });
      return {
        candidate_digest: preview.candidate_digest,
        review_revision: 0,
        semantic_diff: preview.semantic_diff,
        source_database_changed: false,
      };
    }
    const result = await commitPreparedBoundaryReviewMutation({
      projectRoot,
      bindings: preview.bindings,
      build: preview.build,
      candidate: preview.candidate,
      boundaryRoot: preview.boundary_root,
      previousProgress: preview.previous_progress,
      actor: preview.request.actor,
      reason: preview.request.reason,
    });
    return {
      ...result,
      semantic_diff: preview.semantic_diff,
    };
  }
  const result = await commitPreparedBoundaryReviewMutation({
    projectRoot,
    bindings: preview.bindings,
    build: preview.build,
    candidate: preview.candidate,
    boundaryRoot: preview.boundary_root,
    previousProgress: preview.previous_progress,
    actor: preview.request.actor,
    reason: preview.request.reason,
  });
  return {
    ...result,
    semantic_diff: preview.semantic_diff,
  };
}

function buildReviewMutationBoundary(input: {
  inspection: SchemaInspection;
  project: Awaited<ReturnType<typeof detectProjectContext>>;
  evidence: Awaited<ReturnType<typeof loadStructuredProjectEvidence>>;
  state: BoundaryReviewFiles;
}): AutoBoundaryBuild {
  return buildAutoBoundary({
    inspection: input.inspection,
    project: input.project,
    parsedEvidence: input.evidence.parsed,
    existingContracts: input.evidence.existingContracts,
    sourceEnv: input.state.lock.source_env,
    inspectedSchema: input.state.lock.inspected_schema,
    deploymentProfile: input.state.candidate.deployment_profile,
    ...(input.state.candidate.trusted_context.provider === "http_claims" ? {
      httpClaims: {
        tenantClaim: input.state.candidate.trusted_context.tenant_claim,
        principalClaim: input.state.candidate.trusted_context.principal_claim,
      },
    } : {}),
    ...(input.state.candidate.organization_scope ? {
      singleOrganization: {
        organizationId: input.state.candidate.organization_scope.organization_id,
      },
    } : {}),
  });
}

export async function commitBoundaryReviewMutationBatch(
  projectRoot: string,
  preview: BoundaryReviewMutationBatchPreview,
): Promise<{
  candidate_digest: `sha256:${string}`;
  review_revision: number;
  semantic_diff: BoundaryReviewSemanticDiff[];
  source_database_changed: false;
}> {
  const result = await commitPreparedBoundaryReviewMutation({
    projectRoot,
    bindings: preview.bindings,
    build: preview.build,
    candidate: preview.candidate,
    boundaryRoot: preview.boundary_root,
    previousProgress: preview.previous_progress,
    actor: preview.requests[0]!.actor,
    reason: `Applied ${preview.requests.length} reviewed resource decision(s) atomically.`,
  });
  return {
    ...result,
    semantic_diff: preview.semantic_diff,
  };
}

async function commitPreparedBoundaryReviewMutation(input: {
  projectRoot: string;
  bindings: BoundaryReviewMutationBindings;
  build: AutoBoundaryBuild;
  candidate: ExplorationBoundaryDraft;
  boundaryRoot: string;
  previousProgress: BoundaryReviewProgress | undefined;
  actor: string;
  reason: string;
}): Promise<{
  candidate_digest: `sha256:${string}`;
  review_revision: number;
  source_database_changed: false;
}> {
  const current = await loadBoundaryReviewFiles(input.projectRoot);
  assertBindingsEqual(input.bindings, reviewBindings(current));

  const decisions = boundaryReviewDecisions(input.candidate);
  const currentById = new Map(decisions.map((decision) => [decision.id, decision]));
  const retainedConfirmations = (input.previousProgress?.confirmations ?? [])
    .filter((confirmation) =>
      currentById.get(confirmation.id)?.input_digest === confirmation.input_digest)
    .map((confirmation) => currentById.get(confirmation.id)!.decision);
  const progress = createBoundaryReviewProgress({
    draft: input.build.exploration_boundary,
    candidate: input.candidate,
    confirmedDecisions: retainedConfirmations,
    ...(input.previousProgress ? { previous: input.previousProgress } : {}),
    reviewOverrides: input.build.overrides,
    policyMigration: input.previousProgress?.policy_migration.source === "legacy_exact_boundary_revision"
      ? {
        status: "complete",
        source: "legacy_exact_boundary_revision",
        reason: "Reconstructed this boundary's policy from its exact saved revision against a clean inspected baseline.",
      }
      : nativePolicyMigration(),
    actor: input.actor,
    reason: input.reason,
    revision: input.bindings.review_revision + 1,
  });
  if (!input.previousProgress || input.previousProgress.policy_migration.status === "review_required") {
    await backupLegacyBoundaryReviewOverrides(input.projectRoot);
  }
  await writeAutoBoundaryArtifacts({
    projectRoot: input.projectRoot,
    outputRoot: path.relative(input.projectRoot, input.boundaryRoot),
    build: input.build,
    force: true,
    preserveReviewProgress: true,
    preserveActiveBoundary: true,
    reviewProgress: progress,
  });
  return {
    candidate_digest: progress.candidate_digest,
    review_revision: progress.revision,
    source_database_changed: false,
  };
}

function managedDecisionsForRequest(
  request: BoundaryResourceReviewRequest,
): ManagedBoundaryReviewDecision[] {
  const common = {
    resource_id: request.resource_id,
    actor: request.actor,
    reason: request.reason,
    ...(request.decided_at ? { decided_at: request.decided_at } : {}),
  };
  const decisions: ManagedBoundaryReviewDecision[] = [];
  if (request.row_identity !== undefined) {
    decisions.push(normalizeManagedBoundaryReviewDecision({
      ...common,
      kind: "row_identity",
      value: request.row_identity,
    }));
  }
  if (request.tenant_key !== undefined) {
    decisions.push(normalizeManagedBoundaryReviewDecision({
      ...common,
      kind: "tenant_key",
      value: request.tenant_key,
    }));
  }
  if (request.tenant_scope_path !== undefined) {
    decisions.push(normalizeManagedBoundaryReviewDecision({
      ...common,
      kind: "tenant_scope_path",
      value: request.tenant_scope_path,
    }));
  }
  if (request.shared_reference_scope !== undefined) {
    decisions.push(normalizeManagedBoundaryReviewDecision({
      ...common,
      kind: "shared_reference_scope",
      acknowledgement: request.shared_reference_scope,
    }));
  }
  if (request.principal_key !== undefined) {
    decisions.push(normalizeManagedBoundaryReviewDecision({
      ...common,
      kind: "principal_key",
      value: request.principal_key,
    }));
  }
  if (request.principal_scope_path !== undefined) {
    decisions.push(normalizeManagedBoundaryReviewDecision({
      ...common,
      kind: "principal_scope_path",
      value: request.principal_scope_path,
    }));
  }
  for (const field of request.keep_out_fields ?? []) {
    decisions.push(normalizeManagedBoundaryReviewDecision({
      ...common,
      kind: "field_exposure",
      field,
      exposure: "keep_out",
    }));
  }
  for (const field of request.withhold_from_model_fields ?? []) {
    decisions.push(normalizeManagedBoundaryReviewDecision({
      ...common,
      kind: "field_exposure",
      field,
      exposure: "withhold_from_model",
    }));
  }
  for (const field of request.allow_reviewed_fields ?? []) {
    decisions.push(normalizeManagedBoundaryReviewDecision({
      ...common,
      kind: "field_exposure",
      field,
      exposure: "allow_reviewed_use",
    }));
  }
  if (request.field_enum) {
    decisions.push(normalizeManagedBoundaryReviewDecision({
      ...common,
      kind: "field_enum",
      field: request.field_enum.field,
      values: request.field_enum.values,
    }));
  }
  if (request.minimum_cohort_size !== undefined) {
    decisions.push(normalizeManagedBoundaryReviewDecision({
      ...common,
      kind: "minimum_cohort",
      value: request.minimum_cohort_size,
    }));
  }
  return decisions;
}

function buildReviewedCandidate(input: {
  previous: ExplorationBoundaryDraft;
  generated: ExplorationBoundaryDraft;
  request: BoundaryResourceReviewRequest;
}): ExplorationBoundaryDraft {
  const candidate = structuredClone(input.generated);
  candidate.pack.name = input.previous.pack.name;
  candidate.budgets = preserveReviewedBudgets(input.generated, input.previous);
  if (input.request.max_ranked_groups !== undefined) {
    candidate.budgets.max_ranked_groups = input.request.max_ranked_groups;
  }
  const previousIncluded = new Set(input.previous.pack.resources.map((resource) => resource.id));
  candidate.pack.resources = candidate.pack.resources.filter((resource) =>
    previousIncluded.has(resource.id)
      || (input.request.include === true && resource.id === input.request.resource_id));

  if (input.request.exclude) {
    candidate.pack.resources = candidate.pack.resources.filter(
      (resource) => resource.id !== input.request.resource_id,
    );
  } else if (input.request.include) {
    const generated = input.generated.pack.resources.find(
      (resource) => resource.id === input.request.resource_id,
    );
    if (!generated) {
      if (!canStageIncompleteScopeResolution(input.request)) {
        throw new Error(
          `Resource ${input.request.resource_id} remains blocked after the reviewed identity/scope choices and cannot be included.`,
        );
      }
    } else if (!candidate.pack.resources.some((resource) => resource.id === generated.id)) {
      candidate.pack.resources.push(structuredClone(generated));
    }
  }
  candidate.pack.resources.sort((left, right) => left.id.localeCompare(right.id));
  const previousResources = new Map(
    input.previous.pack.resources.map((resource) => [resource.id, resource]),
  );
  for (const generatedResource of candidate.pack.resources) {
    const previousResource = previousResources.get(generatedResource.id);
    if (!previousResource) continue;
    preserveBoundaryResourcePolicy(
      generatedResource,
      previousResource,
      input.request,
      generatedResource.id === input.request.resource_id,
    );
  }
  const resource = candidate.pack.resources.find(
    (item) => item.id === input.request.resource_id,
  );
  if (!resource) {
    if (hasAuthorityNarrowing(input.request)) {
      throw new Error(`Resource ${input.request.resource_id} must be included before its field or relationship authority can be reviewed.`);
    }
    pruneRelationshipsOutsideBoundary(candidate);
    if (candidate.pack.resources.length === 0
      && canStageIncompleteScopeResolution(input.request)) {
      return candidate;
    }
    return reviewExplorationBoundaryCandidate(input.generated, candidate).candidate;
  }

  setReviewedList(resource, "selectable_fields", input.request.selectable_fields);
  setReviewedList(resource, "sortable_fields", input.request.sortable_fields);
  setReviewedList(resource, "groupable_fields", input.request.groupable_fields);
  setReviewedList(resource, "aggregate_measures", input.request.aggregate_measures);
  setReviewedList(resource, "count_distinct_fields", input.request.count_distinct_fields);
  if (input.request.filterable_fields) {
    const allowed = new Set(input.request.filterable_fields);
    resource.filterable_fields = Object.fromEntries(
      Object.entries(resource.filterable_fields).filter(([field]) => allowed.has(field)),
    );
  }
  if (input.request.time_bucket_fields) {
    const allowed = new Set(input.request.time_bucket_fields);
    resource.time_bucket_fields = Object.fromEntries(
      Object.entries(resource.time_bucket_fields).filter(([field]) => allowed.has(field)),
    );
  }
  if (input.request.relationship_ids) {
    const allowed = new Set(input.request.relationship_ids);
    resource.relationships = resource.relationships.filter((relationship) => allowed.has(relationship.id));
  }
  if (input.request.nullable_relationship) {
    const relationship = resource.relationships.find(
      (item) => item.id === input.request.nullable_relationship!.relationship_id,
    );
    if (!relationship) {
      throw new Error(
        `Relationship ${input.request.nullable_relationship.relationship_id} is not in the reviewed resource pack.`,
      );
    }
    if (relationship.unmatched_rows !== "review_required"
      && relationship.nullable !== true) {
      throw new Error(`Relationship ${relationship.id} is not nullable and has no unmatched-row decision.`);
    }
    relationship.unmatched_rows = input.request.nullable_relationship.unmatched_rows;
  }
  pruneRelationshipsOutsideBoundary(candidate);
  assertRequestedRelationshipsRetained(input.request, input.generated, candidate);
  return reviewExplorationBoundaryCandidate(input.generated, candidate).candidate;
}

type ReviewedBoundaryResource = ExplorationBoundaryDraft["pack"]["resources"][number];

function preserveBoundaryResourcePolicy(
  generated: ReviewedBoundaryResource,
  previous: ReviewedBoundaryResource,
  request: BoundaryResourceReviewRequest,
  editedResource: boolean,
): void {
  const visibilityChanges = new Set([
    ...(editedResource ? request.keep_out_fields ?? [] : []),
    ...(editedResource ? request.withhold_from_model_fields ?? [] : []),
    ...(editedResource ? request.allow_reviewed_fields ?? [] : []),
  ]);
  generated.selectable_fields = preserveReviewedList(
    generated.selectable_fields,
    previous.selectable_fields,
    visibilityChanges,
  );
  generated.sortable_fields = preserveReviewedList(
    generated.sortable_fields,
    previous.sortable_fields,
  );
  generated.groupable_fields = preserveReviewedList(
    generated.groupable_fields,
    previous.groupable_fields,
  );
  generated.aggregate_measures = preserveReviewedList(
    generated.aggregate_measures,
    previous.aggregate_measures,
  );
  generated.count_distinct_fields = preserveReviewedList(
    generated.count_distinct_fields,
    previous.count_distinct_fields,
  );
  generated.filterable_fields = preserveReviewedMap(
    generated.filterable_fields,
    previous.filterable_fields,
  );
  generated.time_bucket_fields = preserveReviewedMap(
    generated.time_bucket_fields,
    previous.time_bucket_fields,
  );

  const previousRelationships = new Map(
    previous.relationships.map((relationship) => [relationship.id, relationship]),
  );
  const requestedRelationships = new Set([
    ...(editedResource ? request.relationship_ids ?? [] : []),
    ...(editedResource && request.nullable_relationship
      ? [request.nullable_relationship.relationship_id]
      : []),
  ]);
  generated.relationships = generated.relationships
    .filter((relationship) =>
      previousRelationships.has(relationship.id)
      || requestedRelationships.has(relationship.id)
      || (request.include === true
        && relationshipTouchesResource(relationship, request.resource_id)))
    .map((relationship) => {
      const prior = previousRelationships.get(relationship.id);
      if (relationship.unmatched_rows === "review_required"
        && (prior?.unmatched_rows === "exclude" || prior?.unmatched_rows === "keep_null")) {
        return { ...relationship, unmatched_rows: prior.unmatched_rows };
      }
      return relationship;
    });
}

function relationshipTouchesResource(
  relationship: ReviewedBoundaryResource["relationships"][number],
  resourceId: string,
): boolean {
  if (relationship.target_resource === resourceId) return true;
  return (relationship.proof?.links ?? []).some((link) =>
    link.source_resource === resourceId || link.target_resource === resourceId);
}

function preserveReviewedList(
  generated: string[],
  previous: string[],
  explicitlyChanged: ReadonlySet<string> = new Set(),
): string[] {
  const previousSet = new Set(previous);
  return generated.filter((value) =>
    previousSet.has(value) || explicitlyChanged.has(value));
}

function preserveReviewedMap<T extends string>(
  generated: Record<string, T[]>,
  previous: Record<string, T[]>,
): Record<string, T[]> {
  const result: Record<string, T[]> = {};
  for (const [field, generatedValues] of Object.entries(generated)) {
    const previousValues = previous[field];
    if (!previousValues) continue;
    const previousSet = new Set(previousValues);
    const retained = generatedValues.filter((value) => previousSet.has(value));
    if (retained.length) result[field] = retained;
  }
  return result;
}

function preserveReviewedBudgets(
  generated: ExplorationBoundaryDraft,
  previous: ExplorationBoundaryDraft,
): ExplorationBoundaryDraft["budgets"] {
  const budgets = structuredClone(generated.budgets);
  for (const key of Object.keys(budgets) as Array<keyof typeof budgets>) {
    const prior = previous.budgets[key];
    if (Number.isSafeInteger(prior) && Number(prior) >= 1) {
      (budgets as Record<string, number>)[key] = Math.min(
        Number(budgets[key]),
        Number(prior),
      );
    }
  }
  if (budgets.max_ranked_groups !== undefined) {
    budgets.max_ranked_groups = Math.max(budgets.max_groups, budgets.max_ranked_groups);
  }
  return budgets;
}

function assertRequestedRelationshipsRetained(
  request: BoundaryResourceReviewRequest,
  generated: ExplorationBoundaryDraft,
  candidate: ExplorationBoundaryDraft,
): void {
  if (!request.relationship_ids) return;
  const generatedResource = generated.pack.resources.find(
    (resource) => resource.id === request.resource_id,
  );
  const candidateResource = candidate.pack.resources.find(
    (resource) => resource.id === request.resource_id,
  );
  if (!generatedResource || !candidateResource) return;
  const available = new Map(generatedResource.relationships.map((relationship) => [
    relationship.id,
    relationship,
  ]));
  const unknown = request.relationship_ids.filter((id) => !available.has(id));
  if (unknown.length) {
    throw new Error(
      `Unknown relationship${unknown.length === 1 ? "" : "s"} ${unknown.map((id) => JSON.stringify(id)).join(", ")} ` +
      `for ${request.resource_id}. Available relationships: ${[...available.keys()].sort().join(", ") || "none"}.`,
    );
  }
  const included = new Set(candidate.pack.resources.map((resource) => resource.id));
  for (const id of request.relationship_ids) {
    const relationship = available.get(id)!;
    const requiredResources = new Set([
      relationship.target_resource,
      ...(relationship.proof?.links ?? []).flatMap((link) => [
        link.source_resource,
        link.target_resource,
      ]),
    ]);
    const missing = [...requiredResources].filter((resource) => !included.has(resource)).sort();
    if (missing.length) {
      throw new Error(
        `Relationship ${id} requires ${missing.join(", ")} in the same boundary. ` +
        `Include ${missing.length === 1 ? "that table" : "those tables"} first, then review the relationship again.`,
      );
    }
    if (!candidateResource.relationships.some((item) => item.id === id)) {
      throw new Error(`Reviewed relationship ${id} was not retained in the disabled boundary candidate.`);
    }
  }
}

function pruneRelationshipsOutsideBoundary(candidate: ExplorationBoundaryDraft): void {
  const included = new Set(candidate.pack.resources.map((item) => item.id));
  candidate.pack.resources.forEach((item) => {
    item.relationships = item.relationships.filter((relationship) => {
      const links = relationship.proof?.links ?? [];
      return included.has(relationship.target_resource)
        && links.every((link) =>
          included.has(link.source_resource) && included.has(link.target_resource));
    });
  });
}

function setReviewedList<
  Key extends "selectable_fields" | "sortable_fields" | "groupable_fields"
    | "aggregate_measures" | "count_distinct_fields",
>(
  resource: ExplorationBoundaryDraft["pack"]["resources"][number],
  key: Key,
  selected: string[] | undefined,
): void {
  if (!selected) return;
  const allowed = new Set(selected);
  resource[key] = resource[key].filter((field) => allowed.has(field));
}

function hasAuthorityNarrowing(request: BoundaryResourceReviewRequest): boolean {
  return [
    request.selectable_fields,
    request.filterable_fields,
    request.sortable_fields,
    request.groupable_fields,
    request.aggregate_measures,
    request.count_distinct_fields,
    request.time_bucket_fields,
    request.relationship_ids,
    request.withhold_from_model_fields,
    request.field_enum ? [request.field_enum.field] : undefined,
  ].some((value) => value !== undefined)
    || request.minimum_cohort_size !== undefined
    || request.max_ranked_groups !== undefined
    || request.nullable_relationship !== undefined;
}

function canStageIncompleteScopeResolution(
  request: BoundaryResourceReviewRequest,
): boolean {
  const hasScopeChoice = request.row_identity !== undefined
    || request.tenant_key !== undefined
    || request.tenant_scope_path !== undefined
    || request.shared_reference_scope !== undefined
    || request.principal_key !== undefined
    || request.principal_scope_path !== undefined;
  const hasNonScopeChoice = [
    request.keep_out_fields,
    request.withhold_from_model_fields,
    request.allow_reviewed_fields,
    request.selectable_fields,
    request.filterable_fields,
    request.sortable_fields,
    request.groupable_fields,
    request.aggregate_measures,
    request.count_distinct_fields,
    request.time_bucket_fields,
    request.relationship_ids,
    request.field_enum ? [request.field_enum.field] : undefined,
  ].some((value) => value !== undefined)
    || request.minimum_cohort_size !== undefined
    || request.max_ranked_groups !== undefined
    || request.nullable_relationship !== undefined
    || request.exclude === true;
  return hasScopeChoice && !hasNonScopeChoice;
}

function semanticDiff(
  resourceId: string,
  before: ExplorationBoundaryDraft,
  after: ExplorationBoundaryDraft,
  structuralReviewChanged: boolean,
): BoundaryReviewSemanticDiff {
  const beforeResource = before.pack.resources.find((resource) => resource.id === resourceId);
  const afterResource = after.pack.resources.find((resource) => resource.id === resourceId);
  const listDiff = (
    left: string[] = [],
    right: string[] = [],
  ) => ({
    added: right.filter((item) => !left.includes(item)).sort(),
    removed: left.filter((item) => !right.includes(item)).sort(),
  });
  const visible = listDiff(beforeResource?.selectable_fields, afterResource?.selectable_fields);
  const keptOut = listDiff(beforeResource?.kept_out_fields, afterResource?.kept_out_fields);
  const modelWithheld = listDiff(
    beforeResource?.model_withheld_fields,
    afterResource?.model_withheld_fields,
  );
  const relationships = listDiff(
    beforeResource?.relationships.map((item) => item.id),
    afterResource?.relationships.map((item) => item.id),
  );
  const enumFields = new Set([
    ...Object.keys(beforeResource?.field_enums ?? {}),
    ...Object.keys(afterResource?.field_enums ?? {}),
  ]);
  const reviewedEnumChanges = [...enumFields]
    .sort()
    .flatMap((field) => {
      const beforeValues = beforeResource?.field_enums[field] ?? [];
      const afterValues = afterResource?.field_enums[field] ?? [];
      return JSON.stringify(beforeValues) === JSON.stringify(afterValues)
        ? []
        : [{ field, before: [...beforeValues], after: [...afterValues] }];
    });
  return {
    resource_id: resourceId,
    before_included: Boolean(beforeResource),
    after_included: Boolean(afterResource),
    selected_row_identity: afterResource?.primary_key ?? null,
    selected_tenant_key: afterResource?.tenant_key ?? null,
    ...(afterResource?.tenant_scope
      ? { selected_tenant_scope_path: afterResource.tenant_scope.path_id }
      : {}),
    selected_shared_reference_scope: Boolean(afterResource?.shared_reference_scope),
    selected_principal_key: afterResource?.principal_key ?? null,
    ...(afterResource?.principal_scope
      ? { selected_principal_scope_path: afterResource.principal_scope.path_id }
      : {}),
    added_visible_fields: visible.added,
    removed_visible_fields: visible.removed,
    added_kept_out_fields: keptOut.added,
    removed_kept_out_fields: keptOut.removed,
    added_model_withheld_fields: modelWithheld.added,
    removed_model_withheld_fields: modelWithheld.removed,
    reviewed_enum_changes: reviewedEnumChanges,
    added_relationships: relationships.added,
    removed_relationships: relationships.removed,
    minimum_cohort_before: beforeResource?.minimum_cohort_size ?? null,
    minimum_cohort_after: afterResource?.minimum_cohort_size ?? null,
    minimum_cohort_overridden: afterResource?.minimum_cohort_overridden === true,
    max_ranked_groups_before: before.budgets.max_ranked_groups ?? null,
    max_ranked_groups_after: after.budgets.max_ranked_groups ?? null,
    structural_review_changed: structuralReviewChanged,
    authority_changed: explorationBoundaryCandidateDigest(before)
      !== explorationBoundaryCandidateDigest(after),
    source_database_changed: false,
  };
}

async function loadBoundaryReviewFiles(projectRoot: string): Promise<BoundaryReviewFiles> {
  const resolvedRoot = path.resolve(projectRoot);
  const journey = await readGuidedOnboardingState(resolvedRoot);
  const boundaryRoot = path.resolve(
    resolvedRoot,
    journey?.artifacts.boundary_root ?? "synapsor/generated",
  );
  assertInsideProject(resolvedRoot, boundaryRoot);
  const [draft, lock, review] = await Promise.all([
    readJson<ExplorationBoundaryDraft>(
      path.join(boundaryRoot, "exploration-boundary.draft.json"),
      "exploration boundary draft",
    ),
    readJson<GenerationLock>(
      path.join(resolvedRoot, ".synapsor/generation-lock.json"),
      "generation lock",
    ),
    readJson<BoundaryReviewFiles["review"]>(
      path.join(resolvedRoot, ".synapsor/review-report.json"),
      "boundary review report",
    ),
  ]);
  const progress = await readBoundaryReviewProgress(resolvedRoot, draft);
  return {
    boundary_root: boundaryRoot,
    draft,
    lock,
    review,
    ...(progress ? { progress } : {}),
    candidate: progress?.candidate ?? recommendedBoundaryReviewCandidate(draft),
  };
}

function boundaryRelationshipSummaries(
  generated: ExplorationBoundaryDraft["pack"]["resources"][number] | undefined,
  candidate: ExplorationBoundaryDraft["pack"]["resources"][number] | undefined,
  active: ExplorationBoundaryDraft["pack"]["resources"][number] | undefined,
): BoundaryResourceReviewSummary["relationships"] {
  const relationships = new Map<
    string,
    BoundaryResourceReviewSummary["relationships"][number]
  >();
  for (const [resource, state] of [
    [generated, "available"],
    [candidate, "included"],
    [active, "active"],
  ] as const) {
    for (const relationship of resource?.relationships ?? []) {
      relationships.set(relationship.id, {
        relationship_id: relationship.id,
        target_resource: relationship.target_resource,
        path_depth: relationship.path_depth ?? 1,
        state,
      });
    }
  }
  return [...relationships.values()].sort((left, right) =>
    left.target_resource.localeCompare(right.target_resource)
      || left.relationship_id.localeCompare(right.relationship_id));
}

async function readOptionalActivatedBoundary(
  projectRoot: string,
  boundaryName: string,
): Promise<ActivatedExplorationBoundary | undefined> {
  try {
    return await loadActivatedExplorationBoundary(projectRoot, { name: boundaryName });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function reviewBindings(state: BoundaryReviewFiles): BoundaryReviewMutationBindings {
  return {
    draft_digest: explorationBoundaryCandidateDigest(state.draft),
    candidate_digest: explorationBoundaryCandidateDigest(state.candidate),
    generation_lock_fingerprint: state.draft.generation_lock_fingerprint,
    schema_fingerprint: state.lock.schema_fingerprint,
    role_posture_fingerprint: state.lock.role_posture_fingerprint,
    review_revision: state.progress?.revision ?? 0,
  };
}

function assertBindingsEqual(
  expected: BoundaryReviewMutationBindings,
  current: BoundaryReviewMutationBindings,
): void {
  for (const key of Object.keys(expected) as Array<keyof BoundaryReviewMutationBindings>) {
    if (expected[key] !== current[key]) {
      throw new Error(
        `Boundary review changed after preview (${key} mismatch). No decision was applied; inspect and preview the current review again.`,
      );
    }
  }
}

function validateBoundaryResourceRequest(request: BoundaryResourceReviewRequest): void {
  if (!request.resource_id.trim()) throw new Error("Boundary resource review requires a resource ID.");
  if (request.include && request.exclude) throw new Error("Boundary resource review cannot include and exclude the same resource.");
  const tenantModes = [
    request.tenant_key,
    request.tenant_scope_path,
    request.shared_reference_scope,
  ].filter((value) => value !== undefined).length;
  if (tenantModes > 1) {
    throw new Error(
      "Choose exactly one tenant mode: a direct column, one relationship-carried path, or reviewed Shared reference.",
    );
  }
  if (request.shared_reference_scope !== undefined
    && request.shared_reference_scope !== SHARED_REFERENCE_ACKNOWLEDGEMENT) {
    throw new Error(
      `Shared-reference review must acknowledge ${SHARED_REFERENCE_ACKNOWLEDGEMENT}.`,
    );
  }
  if (request.principal_key && request.principal_scope_path) {
    throw new Error("Choose either a direct principal column or one relationship-carried principal path, not both.");
  }
  if (!request.actor.trim() || request.actor.length > 128) {
    throw new Error("Boundary resource review requires a bounded human reviewer identity.");
  }
  if (!request.reason.trim() || request.reason.length > 500) {
    throw new Error("Boundary resource review requires a concrete reason of at most 500 characters.");
  }
  if (request.minimum_cohort_size !== undefined
    && (!Number.isSafeInteger(request.minimum_cohort_size)
      || request.minimum_cohort_size < 1
      || request.minimum_cohort_size > 5)) {
    throw new Error(
      "The reviewed minimum group size must be an integer from 1 through 5; 5 restores the default.",
    );
  }
  if (request.max_ranked_groups !== undefined
    && (!Number.isSafeInteger(request.max_ranked_groups)
      || request.max_ranked_groups < 1
      || request.max_ranked_groups > 10_000)) {
    throw new Error(
      "The reviewed ranked-group ceiling must be an integer from 1 through 10000.",
    );
  }
  if (request.field_enum
    && (!Array.isArray(request.field_enum.values)
      || request.field_enum.values.some((value) => typeof value !== "string")
      || request.field_enum.values.length > 64
      || new Set(request.field_enum.values).size !== request.field_enum.values.length
      || request.field_enum.values.some((value) => [...value].length > 64)
      || Buffer.byteLength(JSON.stringify(request.field_enum.values), "utf8") > 2_048)) {
    throw new Error(
      "Reviewed categorical values must contain at most 64 unique values of at most 64 characters and 2048 bytes total.",
    );
  }
  const values = [
    request.resource_id,
    request.actor,
    request.reason,
    request.row_identity,
    request.tenant_key,
    request.tenant_scope_path,
    request.shared_reference_scope,
    ...(request.principal_key ? [request.principal_key] : []),
    ...(request.principal_scope_path ? [request.principal_scope_path] : []),
    ...requestArrays(request),
  ].filter((value): value is string => typeof value === "string");
  if (values.some((value) => /[\u0000-\u001f\u007f]/.test(value))) {
    throw new Error("Boundary resource review values must not contain control characters.");
  }
}

function validateBoundaryRequestAgainstResource(
  request: BoundaryResourceReviewRequest,
  resource: BoundaryReviewFiles["review"]["resources"][number],
): void {
  const columns = resource.fields.map((field) => field.name).sort();
  const known = new Set(columns);
  const requestedColumns = [
    request.row_identity,
    request.tenant_key,
    ...(request.principal_key ? [request.principal_key] : []),
    ...(request.keep_out_fields ?? []),
    ...(request.withhold_from_model_fields ?? []),
    ...(request.allow_reviewed_fields ?? []),
    ...(request.selectable_fields ?? []),
    ...(request.filterable_fields ?? []),
    ...(request.sortable_fields ?? []),
    ...(request.groupable_fields ?? []),
    ...(request.aggregate_measures ?? []),
    ...(request.count_distinct_fields ?? []),
    ...(request.time_bucket_fields ?? []),
    ...(request.field_enum ? [request.field_enum.field] : []),
  ].filter((field): field is string => typeof field === "string");
  const unknown = [...new Set(requestedColumns.filter((field) => !known.has(field)))].sort();
  if (unknown.length) {
    throw new Error(
      `Unknown field${unknown.length === 1 ? "" : "s"} ${unknown.map((field) => JSON.stringify(field)).join(", ")} ` +
      `for ${resource.id}. Available columns: ${columns.join(", ")}.`,
    );
  }

  if (request.tenant_scope_path !== undefined
    && !resource.derived_tenant_scope?.candidates.some((candidate) =>
      candidate.path_id === request.tenant_scope_path)) {
    throw new Error(
      `${resource.id} tenant path ${JSON.stringify(request.tenant_scope_path)} is not a current non-null, catalog-proven many-to-one path. ` +
      `Available derived tenant paths: ${resource.derived_tenant_scope?.candidates.map(
        formatDerivedScopePathWithId,
      ).join(", ") || "none"}. Use the exact path ID with --tenant-scope-path.`,
    );
  }
  if (request.shared_reference_scope !== undefined) {
    if (!resource.shared_reference_scope?.eligible) {
      throw new Error(
        `${resource.id} cannot be reviewed as a shared reference: ${
          resource.shared_reference_scope?.blockers.join("; ")
          || "the inspected structure does not prove that shared-reference review is eligible"
        }. No change was made.`,
      );
    }
  }
  if (request.principal_scope_path
    && !resource.derived_principal_scope?.candidates.some((candidate) =>
      candidate.path_id === request.principal_scope_path)) {
    throw new Error(
      `${resource.id} principal path ${JSON.stringify(request.principal_scope_path)} is not a current non-null, catalog-proven many-to-one path. ` +
      `Available derived principal paths: ${resource.derived_principal_scope?.candidates.map(
        formatDerivedScopePathWithId,
      ).join(", ") || "none"}. Use the exact path ID with --principal-scope-path.`,
    );
  }

  if (request.field_enum) {
    const field = resource.fields.find((candidate) => candidate.name === request.field_enum!.field);
    if (!field?.enum_values?.length) {
      throw new Error(
        `${resource.id}.${request.field_enum.field} has no bounded schema-declared categorical values to review.`,
      );
    }
    const schemaValues = new Set(field.enum_values);
    const added = request.field_enum.values.filter((value) => !schemaValues.has(value));
    if (added.length) {
      throw new Error(
        `${resource.id}.${request.field_enum.field} may only remove schema-declared values. ` +
        `Not declared by the database: ${added.map((value) => JSON.stringify(value)).join(", ")}.`,
      );
    }
  }

  const exposureRequests = new Map<string, string>();
  for (const [label, fields] of [
    ["keep out", request.keep_out_fields],
    ["withhold from model", request.withhold_from_model_fields],
    ["allow reviewed use", request.allow_reviewed_fields],
  ] as const) {
    for (const field of fields ?? []) {
      const existing = exposureRequests.get(field);
      if (existing) {
        throw new Error(
          `Field ${field} cannot be requested as both ${existing} and ${label} in one boundary decision.`,
        );
      }
      exposureRequests.set(field, label);
    }
  }
}

function assertRequestedExposureState(
  request: BoundaryResourceReviewRequest,
  candidate: ExplorationBoundaryDraft,
): void {
  const resource = candidate.pack.resources.find((item) => item.id === request.resource_id);
  if (!resource) return;
  for (const field of request.keep_out_fields ?? []) {
    if (!resource.kept_out_fields.includes(field)) {
      throw new Error(`Reviewed keep-out decision for ${request.resource_id}.${field} was not reflected in the disabled candidate.`);
    }
  }
  for (const field of request.withhold_from_model_fields ?? []) {
    if (!resource.model_withheld_fields?.includes(field)
      || !resource.selectable_fields.includes(field)
      || resource.kept_out_fields.includes(field)) {
      throw new Error(
        `Reviewed model-withheld decision for ${request.resource_id}.${field} was not reflected in the disabled candidate.`,
      );
    }
  }
  for (const field of request.allow_reviewed_fields ?? []) {
    if (!resource.selectable_fields.includes(field)
      || resource.kept_out_fields.includes(field)
      || resource.model_withheld_fields?.includes(field)) {
      throw new Error(
        `Reviewed visible-field decision for ${request.resource_id}.${field} was not reflected in the disabled candidate.`,
      );
    }
  }
  if (request.field_enum) {
    const actual = resource.field_enums[request.field_enum.field] ?? [];
    if (JSON.stringify(actual) !== JSON.stringify(request.field_enum.values)) {
      throw new Error(
        `Reviewed categorical values for ${request.resource_id}.${request.field_enum.field} ` +
        "were not reflected in the disabled candidate.",
      );
    }
    if (request.field_enum.values.length === 0
      && (Object.hasOwn(resource.filterable_fields, request.field_enum.field)
        || resource.groupable_fields.includes(request.field_enum.field))) {
      throw new Error(
        `${request.resource_id}.${request.field_enum.field} disabled its categorical allowlist ` +
        "but retained filter or group authority.",
      );
    }
  }
}

function canonicalReviewRequest(request: BoundaryResourceReviewRequest): JsonRecord {
  return {
    resource_id: request.resource_id,
    include: request.include === true,
    exclude: request.exclude === true,
    row_identity: request.row_identity ?? null,
    tenant_key: request.tenant_key ?? null,
    ...(request.tenant_scope_path !== undefined
      ? { tenant_scope_path: request.tenant_scope_path }
      : {}),
    shared_reference_scope: request.shared_reference_scope ?? null,
    principal_key: request.principal_key === undefined ? "unchanged" : request.principal_key,
    ...(request.principal_scope_path !== undefined
      ? { principal_scope_path: request.principal_scope_path }
      : {}),
    keep_out_fields: [...(request.keep_out_fields ?? [])].sort(),
    withhold_from_model_fields: [...(request.withhold_from_model_fields ?? [])].sort(),
    allow_reviewed_fields: [...(request.allow_reviewed_fields ?? [])].sort(),
    selectable_fields: sortedOrNull(request.selectable_fields),
    filterable_fields: sortedOrNull(request.filterable_fields),
    sortable_fields: sortedOrNull(request.sortable_fields),
    groupable_fields: sortedOrNull(request.groupable_fields),
    aggregate_measures: sortedOrNull(request.aggregate_measures),
    count_distinct_fields: sortedOrNull(request.count_distinct_fields),
    time_bucket_fields: sortedOrNull(request.time_bucket_fields),
    field_enum: request.field_enum
      ? { field: request.field_enum.field, values: [...request.field_enum.values] }
      : null,
    minimum_cohort_size: request.minimum_cohort_size ?? null,
    max_ranked_groups: request.max_ranked_groups ?? null,
    relationship_ids: sortedOrNull(request.relationship_ids),
    nullable_relationship: request.nullable_relationship ?? null,
    actor: request.actor,
    reason: request.reason,
  };
}

function sortedOrNull(value: string[] | undefined): string[] | null {
  return value ? [...value].sort() : null;
}

function requestArrays(request: BoundaryResourceReviewRequest): string[] {
  return [
    ...(request.keep_out_fields ?? []),
    ...(request.withhold_from_model_fields ?? []),
    ...(request.allow_reviewed_fields ?? []),
    ...(request.selectable_fields ?? []),
    ...(request.filterable_fields ?? []),
    ...(request.sortable_fields ?? []),
    ...(request.groupable_fields ?? []),
    ...(request.aggregate_measures ?? []),
    ...(request.count_distinct_fields ?? []),
    ...(request.time_bucket_fields ?? []),
    ...(request.field_enum ? [request.field_enum.field, ...request.field_enum.values] : []),
    ...(request.relationship_ids ?? []),
  ];
}

function assertCurrentInspectedResource(inspection: SchemaInspection, resourceId: string): void {
  if (!inspection.tables.some((table) => `${table.schema}.${table.name}` === resourceId)) {
    throw new Error(`Boundary review resource ${resourceId} is absent from the current inspected schema.`);
  }
}

function assertInsideProject(projectRoot: string, target: string): void {
  const relative = path.relative(projectRoot, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Managed boundary review path escapes the selected project.");
  }
}

async function readJson<T>(filePath: string, label: string): Promise<T> {
  const stat = await fs.lstat(filePath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 10 * 1024 * 1024) {
    throw new Error(`${label} must be a bounded regular project file.`);
  }
  return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
}
