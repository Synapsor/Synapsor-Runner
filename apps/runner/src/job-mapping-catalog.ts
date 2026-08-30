import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { inspectDatabase } from "@synapsor-runner/schema-inspector";
import {
  SHARED_REFERENCE_ACKNOWLEDGEMENT,
} from "./auto-boundary.js";
import {
  commitBoundaryReviewMutationBatch,
  inspectBoundaryResourceReview,
  listBoundaryResourceReviews,
  prepareBoundaryReviewMutationBatch,
  type BoundaryResourceReviewRequest,
  type BoundaryResourceReviewView,
} from "./boundary-review-mutation.js";

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
  review_revision?: number;
  direct_resources: number;
  derived_resources: number;
  shared_reference_resources: number;
  manual_resources: number;
  changed: boolean;
  authority_activated: false;
  source_database_changed: false;
};

export async function loadJobMappingCatalog(
  projectRoot: string,
): Promise<JobMappingCatalogPlan> {
  const summaries = await listBoundaryResourceReviews(projectRoot);
  const views = await Promise.all(summaries.map((summary) =>
    inspectBoundaryResourceReview(projectRoot, summary.resource_id)));
  return buildJobMappingCatalog(views);
}

export function buildJobMappingCatalog(
  views: BoundaryResourceReviewView[],
): JobMappingCatalogPlan {
  const directResources = views
    .filter((view) => Boolean(view.generated_candidate))
    .map((view) => view.resource_id)
    .sort();
  const directResourcesToInclude = views
    .filter((view) => Boolean(view.generated_candidate) && !view.included)
    .map((view) => view.resource_id)
    .sort();
  const derivedResources: JobMappingCatalogPlan["derived_resources"] = [];
  const sharedResources: JobMappingCatalogPlan["shared_reference_resources"] = [];
  const manualResources: JobMappingCatalogPlan["manual_resources"] = [];

  for (const view of views) {
    if (view.generated_candidate) continue;
    const identity = view.row_identity.selected
      ?? (view.row_identity.candidates.length === 1 ? view.row_identity.candidates[0] : undefined);
    if (!identity) {
      manualResources.push({ resource_id: view.resource_id, reason: "Row identity is ambiguous." });
      continue;
    }
    const tenantPaths = view.derived_tenant_scope?.candidates ?? [];
    if (tenantPaths.length === 1) {
      const principalPaths = view.derived_principal_scope?.candidates ?? [];
      if (principalPaths.length > 1) {
        manualResources.push({
          resource_id: view.resource_id,
          reason: "Principal scope has multiple proven paths and requires an exact reviewer choice.",
        });
        continue;
      }
      derivedResources.push({
        resource_id: view.resource_id,
        row_identity: identity,
        tenant_scope: catalogPath(tenantPaths[0]!),
        ...(principalPaths[0] ? { principal_scope: catalogPath(principalPaths[0]) } : {}),
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
    if (view.shared_reference_scope?.eligible) {
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

export async function applyJobMappingCatalog(input: {
  projectRoot: string;
  expectedPlanDigest: string;
  acceptedSharedResources?: string[];
  actor: string;
  reason: string;
  schemaInspector?: typeof inspectDatabase;
}): Promise<AppliedJobMappingCatalog> {
  const plan = await loadJobMappingCatalog(input.projectRoot);
  if (plan.plan_digest !== input.expectedPlanDigest) {
    throw new Error(
      "JOB_MAPPING_CATALOG_CHANGED: the reviewed structural catalog changed. Reload it before preparing this job.",
    );
  }
  const accepted = [...new Set(input.acceptedSharedResources ?? [])].sort();
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
  const budgetReviewNeeded = plan.current_limits.max_derived_scope_hops
      !== plan.proposed_limits.max_derived_scope_hops
    || plan.current_limits.max_analysis_relationship_hops
      !== plan.proposed_limits.max_analysis_relationship_hops;
  if (!requests.length && !budgetReviewNeeded) {
    return {
      plan_digest: plan.plan_digest,
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
  );
  const committed = await commitBoundaryReviewMutationBatch(input.projectRoot, preview);
  return {
    plan_digest: plan.plan_digest,
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
