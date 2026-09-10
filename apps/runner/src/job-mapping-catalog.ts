import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { inspectDatabase } from "@synapsor-runner/schema-inspector";
import {
  SHARED_REFERENCE_ACKNOWLEDGEMENT,
  type ExplorationBoundaryDraft,
} from "./auto-boundary.js";
import {
  commitBoundaryReviewMutationBatch,
  loadBoundaryResourceReviewCatalog,
  prepareBoundaryReviewMutationBatch,
  type BoundaryResourceReviewRequest,
  type BoundaryResourceReviewView,
} from "./boundary-review-mutation.js";
import type { BoundaryReviewProgress } from "./boundary-review-domain.js";
import { assertReadAuthoringBindings, type ReadAuthoringBindings } from "./control-policy-record.js";

type DerivedScopeCandidate = NonNullable<
  BoundaryResourceReviewView["derived_tenant_scope"]
>["candidates"][number];

export type JobMappingCatalogPath = {
  path_id: string;
  depth: number;
  ancestor_resource: string;
  links: Array<{
    source_resource: string;
    target_resource: string;
    source_columns: string[];
  }>;
};

export type JobMappingCatalogPlan = {
  schema_version: "synapsor.job-mapping-catalog.v1";
  direct_resources: string[];
  direct_resources_to_include: string[];
  derived_resources: Array<{
    resource_id: string;
    row_identity: string;
    tenant_scope: JobMappingCatalogPath;
    principal_scope?: JobMappingCatalogPath;
  }>;
  shared_reference_resources: Array<{
    resource_id: string;
    row_identity: string;
  }>;
  manual_resources: Array<{
    resource_id: string;
    reason: string;
  }>;
  /**
   * Principal-like columns are structural candidates, not reviewed authority.
   * Keep them out of model catalogs until an operator explicitly reviews their
   * role as trusted scope or ordinary business data.
   */
  unresolved_principal_fields_to_withhold: Array<{
    resource_id: string;
    fields: string[];
  }>;
  current_limits: {
    max_derived_scope_hops: 1 | 2 | 3;
    max_analysis_relationship_hops: 1 | 2 | 3;
  };
  proposed_limits: {
    max_derived_scope_hops: 1 | 2 | 3;
    max_analysis_relationship_hops: 1 | 2 | 3;
  };
  plan_digest: `sha256:${string}`;
};

export type AppliedJobMappingCatalog = {
  plan_digest: `sha256:${string}`;
  candidate: ExplorationBoundaryDraft;
  progress?: BoundaryReviewProgress;
  authoring_binding?: ReadAuthoringBindings;
  review_revision?: number;
  direct_resources: number;
  derived_resources: number;
  shared_reference_resources: number;
  manual_resources: number;
  changed: boolean;
  authority_activated: false;
  source_database_changed: false;
};

export type LoadedJobMappingCatalog = JobMappingCatalogPlan & { authoring_binding?: ReadAuthoringBindings };

export async function loadJobMappingCatalog(
  projectRoot: string,
): Promise<LoadedJobMappingCatalog> {
  return mappingCatalogFromReview(await loadBoundaryResourceReviewCatalog(projectRoot));
}

function mappingCatalogFromReview(review: Awaited<ReturnType<typeof loadBoundaryResourceReviewCatalog>>): LoadedJobMappingCatalog {
  return { ...buildJobMappingCatalog(review.views),
    ...(review.bindings.authoring ? { authoring_binding: review.bindings.authoring } : {}) };
}

export function buildJobMappingCatalog(
  views: BoundaryResourceReviewView[],
): JobMappingCatalogPlan {
  const directResources = views
    .filter((view) => isGeneratedDirectResource(view))
    .map((view) => view.resource_id)
    .sort();
  const directResourcesToInclude = views
    .filter((view) => isGeneratedDirectResource(view) && !view.included)
    .map((view) => view.resource_id)
    .sort();
  const derivedResources: JobMappingCatalogPlan["derived_resources"] = [];
  const sharedResources: JobMappingCatalogPlan["shared_reference_resources"] = [];
  const manualResources: JobMappingCatalogPlan["manual_resources"] = [];

  for (const view of views) {
    if (isGeneratedDirectResource(view)) continue;
    const identity = view.generated_candidate?.primary_key
      ?? view.row_identity.selected
      ?? (view.row_identity.candidates.length === 1 ? view.row_identity.candidates[0] : undefined);
    if (!identity) {
      manualResources.push({ resource_id: view.resource_id, reason: "Row identity is ambiguous." });
      continue;
    }
    const tenantPaths = view.derived_tenant_scope?.candidates ?? [];
    const tenantPath = view.generated_candidate?.tenant_scope
      ?? view.derived_tenant_scope?.selected
      ?? (tenantPaths.length === 1 ? tenantPaths[0] : undefined);
    if (tenantPath) {
      const principalPaths = view.derived_principal_scope?.candidates ?? [];
      const principalPath = view.generated_candidate?.principal_scope
        ?? view.derived_principal_scope?.selected
        ?? (principalPaths.length === 1 ? principalPaths[0] : undefined);
      if (!principalPath && principalPaths.length > 1) {
        manualResources.push({
          resource_id: view.resource_id,
          reason: "Principal scope has multiple proven paths and requires an exact reviewer choice.",
        });
        continue;
      }
      derivedResources.push({
        resource_id: view.resource_id,
        row_identity: identity,
        tenant_scope: catalogPath(tenantPath),
        ...(principalPath ? { principal_scope: catalogPath(principalPath) } : {}),
      });
      continue;
    }
    if (tenantPaths.length > 1) {
      manualResources.push({
        resource_id: view.resource_id,
        reason: "Tenant scope has multiple proven paths and requires an exact reviewer choice.",
      });
      continue;
    }
    if (view.generated_candidate?.shared_reference_scope || view.shared_reference_scope?.eligible) {
      sharedResources.push({ resource_id: view.resource_id, row_identity: identity });
      continue;
    }
    manualResources.push({
      resource_id: view.resource_id,
      reason: "Trusted scope still requires manual review.",
    });
  }

  derivedResources.sort((left, right) =>
    left.tenant_scope.depth - right.tenant_scope.depth
    || left.resource_id.localeCompare(right.resource_id));
  sharedResources.sort((left, right) => left.resource_id.localeCompare(right.resource_id));
  manualResources.sort((left, right) => left.resource_id.localeCompare(right.resource_id));

  const currentDerivedDepth = boundedPathDepth(
    views[0]?.reviewed_budgets?.max_derived_scope_hops
      ?? views[0]?.reviewed_budgets?.max_relationship_hops
      ?? 2,
  );
  const currentAnalysisDepth = boundedPathDepth(
    views[0]?.reviewed_budgets?.max_analysis_relationship_hops
      ?? views[0]?.reviewed_budgets?.max_relationship_hops
      ?? 2,
  );
  const deepestDerivedPath = boundedPathDepth(Math.max(
    1,
    ...derivedResources.flatMap((resource) => [
      resource.tenant_scope.depth,
      resource.principal_scope?.depth ?? 1,
    ]),
  ));
  const included = new Set([
    ...directResources,
    ...derivedResources.map((resource) => resource.resource_id),
    ...sharedResources.map((resource) => resource.resource_id),
  ]);
  const unresolvedPrincipalFieldsToWithhold = views
    .filter((view) => included.has(view.resource_id))
    .filter((view) => !view.principal_key.selected && Boolean(view.principal_key.blocked_reason))
    .map((view) => ({
      resource_id: view.resource_id,
      fields: [...new Set(view.principal_key.candidates)]
        .filter((field) => view.fields.some((candidate) => candidate.name === field))
        .sort(),
    }))
    .filter((entry) => entry.fields.length > 0)
    .sort((left, right) => left.resource_id.localeCompare(right.resource_id));
  const deepestAnalysisPath = reviewedCatalogAnalysisDepth(views, included);
  const proposedDerivedDepth = boundedPathDepth(Math.max(currentDerivedDepth, deepestDerivedPath));
  const proposedAnalysisDepth = boundedPathDepth(Math.max(currentAnalysisDepth, deepestAnalysisPath));
  const core = {
    schema_version: "synapsor.job-mapping-catalog.v1" as const,
    direct_resources: directResources,
    direct_resources_to_include: directResourcesToInclude,
    derived_resources: derivedResources,
    shared_reference_resources: sharedResources,
    manual_resources: manualResources,
    unresolved_principal_fields_to_withhold: unresolvedPrincipalFieldsToWithhold,
    current_limits: {
      max_derived_scope_hops: currentDerivedDepth,
      max_analysis_relationship_hops: currentAnalysisDepth,
    },
    proposed_limits: {
      max_derived_scope_hops: proposedDerivedDepth,
      max_analysis_relationship_hops: proposedAnalysisDepth,
    },
  };
  return { ...core, plan_digest: canonicalJsonDigest(core) };
}

function isGeneratedDirectResource(view: BoundaryResourceReviewView): boolean {
  const generated = view.generated_candidate;
  if (!generated) return false;
  // A regenerated authoring draft can contain previously reviewed derived or
  // shared resources. Presence in that draft therefore does not by itself
  // prove direct scope. Classify from the frozen resource authority so a
  // minimized boundary can be expanded again ancestor-first.
  return !generated.tenant_scope && !generated.shared_reference_scope;
}

/** Upgrade only an unfinished mapping catalog, never an already mapped Read revision. */
export async function refreshIncompleteReadMappingRelationships(input: {
  projectRoot: string;
  schemaInspector: typeof inspectDatabase;
}): Promise<string[]> {
  const review = await loadBoundaryResourceReviewCatalog(input.projectRoot);
  const first = review.candidate.pack.resources[0];
  if (!first) return [];
  const decision = {
    actor: "runner-job-mapping",
    reason: "Resume the unfinished job with newly supported declared composite links; keep access disabled pending exact review.",
  };
  const preview = await prepareBoundaryReviewMutationBatch(input.projectRoot,
    [{ resource_id: first.id, ...decision }], input.schemaInspector, review.bindings);
  const included = new Set(review.candidate.pack.resources.map(resource => resource.id));
  const additions: string[] = [];
  const requests: BoundaryResourceReviewRequest[] = [];
  for (const resource of preview.build.exploration_boundary.pack.resources) {
    const prior = review.candidate.pack.resources.find(item => item.id === resource.id);
    if (!prior) continue;
    const originallyGenerated = new Set(review.views.find(view => view.resource_id === resource.id)
      ?.generated_candidate?.relationships.map(link => link.id));
    const missing = resource.relationships.filter(relationship =>
      !originallyGenerated.has(relationship.id)
      && !prior.relationships.some(link => link.id === relationship.id)
      && relationship.proof?.links.some(link => link.source_columns.length > 1)
      && relationship.proof.links.every(link => included.has(link.source_resource) && included.has(link.target_resource)));
    if (!missing.length) continue;
    // A link present in the old generated catalog but removed by a reviewer
    // is deliberately excluded above. Do not restore reviewed exclusions.
    additions.push(...missing.map(link => `${resource.id}:${link.id}`));
    requests.push({ resource_id: resource.id, ...decision,
      relationship_ids: [...prior.relationships.map(link => link.id), ...missing.map(link => link.id)] });
  }
  if (!requests.length) return [];
  const refreshed = await prepareBoundaryReviewMutationBatch(input.projectRoot, requests,
    input.schemaInspector, review.bindings);
  await commitBoundaryReviewMutationBatch(input.projectRoot, refreshed);
  return additions;
}

export async function applyJobMappingCatalog(input: {
  projectRoot: string;
  expectedPlanDigest: string;
  expectedAuthoring?: ReadAuthoringBindings;
  acceptedSharedResources?: string[];
  actor: string;
  reason: string;
  schemaInspector?: typeof inspectDatabase;
}): Promise<AppliedJobMappingCatalog> {
  const expectedAuthoring = structuredClone(input.expectedAuthoring);
  const accepted = [...new Set(input.acceptedSharedResources ?? [])].sort();
  const review = await loadBoundaryResourceReviewCatalog(input.projectRoot);
  const plan = mappingCatalogFromReview(review);
  assertCatalogAuthoring(expectedAuthoring, plan.authoring_binding);
  if (plan.plan_digest !== input.expectedPlanDigest) {
    throw new Error(
      "JOB_MAPPING_CATALOG_CHANGED: the reviewed structural catalog changed. Reload it before preparing this job.",
    );
  }
  const eligibleShared = new Set(plan.shared_reference_resources.map((resource) => resource.resource_id));
  const invalid = accepted.find((resourceId) => !eligibleShared.has(resourceId));
  if (invalid) {
    throw new Error(`${invalid} is not an eligible shared-reference resource in the current reviewed catalog.`);
  }
  const acceptedShared = plan.shared_reference_resources.filter((resource) =>
    accepted.includes(resource.resource_id));
  const requests: BoundaryResourceReviewRequest[] = [
    ...plan.direct_resources_to_include.map((resourceId): BoundaryResourceReviewRequest => ({
      resource_id: resourceId,
      include: true,
      actor: input.actor,
      reason: input.reason,
    })),
    ...plan.derived_resources.map((resource): BoundaryResourceReviewRequest => ({
      resource_id: resource.resource_id,
      include: true,
      row_identity: resource.row_identity,
      tenant_scope_path: resource.tenant_scope.path_id,
      ...(resource.principal_scope ? { principal_scope_path: resource.principal_scope.path_id } : {}),
      actor: input.actor,
      reason: input.reason,
    })),
    ...acceptedShared.map((resource): BoundaryResourceReviewRequest => ({
      resource_id: resource.resource_id,
      include: true,
      row_identity: resource.row_identity,
      shared_reference_scope: SHARED_REFERENCE_ACKNOWLEDGEMENT,
      actor: input.actor,
      reason: input.reason,
    })),
  ];
  for (const unresolved of plan.unresolved_principal_fields_to_withhold) {
    const existing = requests.find((request) => request.resource_id === unresolved.resource_id);
    if (existing) {
      existing.withhold_from_model_fields = [...new Set([
        ...(existing.withhold_from_model_fields ?? []),
        ...unresolved.fields,
      ])].sort();
    } else {
      requests.push({
        resource_id: unresolved.resource_id,
        withhold_from_model_fields: [...unresolved.fields],
        actor: input.actor,
        reason: input.reason,
      });
    }
  }
  const budgetReviewNeeded = plan.current_limits.max_derived_scope_hops
      !== plan.proposed_limits.max_derived_scope_hops
    || plan.current_limits.max_analysis_relationship_hops
      !== plan.proposed_limits.max_analysis_relationship_hops;
  if (!requests.length && !budgetReviewNeeded) {
    return {
      plan_digest: plan.plan_digest,
      candidate: review.candidate,
      ...(review.progress ? { progress: review.progress } : {}),
      ...(plan.authoring_binding ? { authoring_binding: plan.authoring_binding } : {}),
      direct_resources: plan.direct_resources.length,
      derived_resources: 0,
      shared_reference_resources: 0,
      manual_resources: plan.manual_resources.length,
      changed: false,
      authority_activated: false,
      source_database_changed: false,
    };
  }
  if (!requests.length) {
    const resourceId = plan.direct_resources[0];
    if (!resourceId) {
      throw new Error("JOB_MAPPING_CATALOG_EMPTY: no reviewed root resource can carry the path-depth decision.");
    }
    requests.push({ resource_id: resourceId, actor: input.actor, reason: input.reason });
  }
  requests[0]!.max_derived_scope_hops = plan.proposed_limits.max_derived_scope_hops;
  requests[0]!.max_analysis_relationship_hops = plan.proposed_limits.max_analysis_relationship_hops;
  const preview = await prepareBoundaryReviewMutationBatch(
    input.projectRoot,
    requests,
    input.schemaInspector ?? inspectDatabase,
    review.bindings,
  );
  assertCatalogAuthoring(expectedAuthoring, preview.bindings.authoring);
  const committed = await commitBoundaryReviewMutationBatch(input.projectRoot, preview);
  return {
    plan_digest: plan.plan_digest,
    candidate: committed.progress?.candidate ?? preview.candidate,
    ...(committed.progress ? { progress: committed.progress } : {}),
    ...(committed.authoring_binding ? { authoring_binding: committed.authoring_binding } : {}),
    review_revision: committed.review_revision,
    direct_resources: plan.direct_resources.length,
    derived_resources: plan.derived_resources.length,
    shared_reference_resources: acceptedShared.length,
    manual_resources: plan.manual_resources.length,
    changed: true,
    authority_activated: false,
    source_database_changed: false,
  };
}

function assertCatalogAuthoring(expected: ReadAuthoringBindings | undefined, current: ReadAuthoringBindings | undefined): void {
  if (current) assertReadAuthoringBindings(expected, current);
  else if (expected) throw Object.assign(new Error("The saved mapping catalog repository changed. Reload the current draft before preparing this job."),
    { code: "POLICY_AUTHORING_REVIEW_CHANGED" });
}

function catalogPath(path: DerivedScopeCandidate): JobMappingCatalogPath {
  return {
    path_id: path.path_id,
    depth: boundedPathDepth(path.proof.links.length),
    ancestor_resource: path.ancestor_resource,
    links: path.proof.links.map((link) => ({
      source_resource: link.source_resource,
      target_resource: link.target_resource,
      source_columns: [...link.source_columns],
    })),
  };
}

function reviewedCatalogAnalysisDepth(
  views: BoundaryResourceReviewView[],
  included: ReadonlySet<string>,
): 1 | 2 | 3 {
  const outgoing = new Map<string, string[]>();
  for (const view of views) {
    if (!included.has(view.resource_id)) continue;
    outgoing.set(view.resource_id, [...new Set(view.relationships
      .filter((relationship) =>
        relationship.cardinality_proven && included.has(relationship.referenced_resource))
      .map((relationship) => relationship.referenced_resource))]);
  }
  let deepest = 1;
  const visit = (resourceId: string, seen: Set<string>, depth: number): void => {
    deepest = Math.max(deepest, depth);
    if (depth >= 3) return;
    for (const target of outgoing.get(resourceId) ?? []) {
      if (seen.has(target)) continue;
      visit(target, new Set([...seen, target]), depth + 1);
    }
  };
  for (const resourceId of included) visit(resourceId, new Set([resourceId]), 0);
  return boundedPathDepth(deepest);
}

function boundedPathDepth(value: number): 1 | 2 | 3 {
  return Math.max(1, Math.min(3, Math.trunc(value))) as 1 | 2 | 3;
}
