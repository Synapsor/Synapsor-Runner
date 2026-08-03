import {
  reviewExplorationBoundaryCandidate,
  type ExplorationBoundaryDraft,
} from "./auto-boundary.js";

export const DEFAULT_BOUNDARY_REVIEW_RESOURCE_LIMIT = 3;
export const INSTANT_BOUNDARY_RESOURCE_LIMIT = 5;

export function recommendedBoundaryReviewCandidate(
  draft: ExplorationBoundaryDraft,
  maximumResources = DEFAULT_BOUNDARY_REVIEW_RESOURCE_LIMIT,
): ExplorationBoundaryDraft {
  if (!Number.isSafeInteger(maximumResources) || maximumResources < 1) {
    throw new Error("Boundary review candidate requires at least one resource.");
  }
  // A metadata-only draft may contain only blocked resources. Keep it
  // inspectable so the operator can resolve those blockers; activation still
  // rejects an empty reviewed boundary.
  if (draft.pack.resources.length === 0) return structuredClone(draft);
  if (draft.pack.resources.length <= maximumResources) {
    return reviewExplorationBoundaryCandidate(draft, structuredClone(draft)).candidate;
  }
  const ranked = draft.pack.resources
    .map((resource) => ({
      resource,
      score: resourceReviewScore(resource),
    }))
    .sort((left, right) =>
      right.score - left.score || left.resource.id.localeCompare(right.resource.id));
  const rankedById = new Map(ranked.map((item) => [item.resource.id, item]));
  const selectedIds = new Set<string>();
  const anchor = ranked[0]?.resource;
  if (anchor) {
    selectedIds.add(anchor.id);
    const dimensions = anchor.relationships
      .map((relationship) => rankedById.get(relationship.target_resource))
      .filter((item): item is NonNullable<typeof item> => Boolean(item))
      .sort((left, right) =>
        right.score - left.score || left.resource.id.localeCompare(right.resource.id));
    for (const dimension of dimensions) {
      if (selectedIds.size >= maximumResources) break;
      selectedIds.add(dimension.resource.id);
    }
  }
  for (const item of ranked) {
    if (selectedIds.size >= maximumResources) break;
    selectedIds.add(item.resource.id);
  }
  const candidate = structuredClone(draft);
  candidate.pack.resources = candidate.pack.resources
    .filter((resource) => selectedIds.has(resource.id))
    .map((resource) => ({
      ...resource,
      relationships: resource.relationships
        .filter((relationship) => relationshipStaysInsidePack(relationship, selectedIds)),
    }));
  return reviewExplorationBoundaryCandidate(draft, candidate).candidate;
}

export function instantLocalBoundaryCandidate(
  draft: ExplorationBoundaryDraft,
): ExplorationBoundaryDraft {
  const tenantOnlyResources = draft.pack.resources
    .filter((resource) => !resource.principal_key);
  const eligible = tenantOnlyResources.length > 0
    ? tenantOnlyResources
    : draft.pack.resources;
  if (eligible.length === 0) return structuredClone(draft);

  const ranked = [...eligible].sort((left, right) =>
    resourceReviewScore(right) - resourceReviewScore(left)
    || left.id.localeCompare(right.id));
  const selected: typeof eligible = [];
  const selectedIds = new Set<string>();
  const anchor = ranked[0];
  if (anchor) {
    selected.push(anchor);
    selectedIds.add(anchor.id);
  }

  while (selected.length < Math.min(INSTANT_BOUNDARY_RESOURCE_LIMIT, eligible.length)) {
    const next = ranked
      .filter((resource) => !selectedIds.has(resource.id))
      .map((resource) => ({
        resource,
        connections: relationshipConnections(resource, selectedIds, eligible),
      }))
      .filter((item) => item.connections > 0)
      .sort((left, right) =>
        resourceReviewScore(right.resource) - resourceReviewScore(left.resource)
        || right.connections - left.connections
        || left.resource.id.localeCompare(right.resource.id))[0]?.resource;
    if (!next) break;
    selected.push(next);
    selectedIds.add(next.id);
  }

  const candidate = structuredClone(draft);
  candidate.deployment_profile = "development";
  candidate.pack.resources = selected.map((resource) => ({
    ...structuredClone(resource),
    relationships: resource.relationships
      .filter((relationship) => relationshipStaysInsidePack(relationship, selectedIds)),
  }));
  return reviewExplorationBoundaryCandidate(draft, candidate).candidate;
}

function resourceReviewScore(
  resource: ExplorationBoundaryDraft["pack"]["resources"][number],
): number {
  return (resource.principal_key ? 40 : 0)
    + (resource.rls_session ? 20 : 0)
    + (Object.keys(resource.time_bucket_fields).length ? 12 : 0)
    + (resource.aggregate_measures.length ? 10 : 0)
    + (resource.groupable_fields.length ? 8 : 0)
    + (resource.count_distinct_fields.length ? 5 : 0)
    + Math.min(resource.relationships.length, 2) * 6
    + Math.min(resource.selectable_fields.length, 8)
    - Math.min(resource.kept_out_fields.length, 8);
}

function relationshipConnections(
  candidate: ExplorationBoundaryDraft["pack"]["resources"][number],
  selectedIds: Set<string>,
  eligible: ExplorationBoundaryDraft["pack"]["resources"],
): number {
  const outgoing = candidate.relationships.filter((relationship) =>
    selectedIds.has(relationship.target_resource)).length;
  const incoming = eligible.filter((resource) =>
    selectedIds.has(resource.id)
    && resource.relationships.some((relationship) =>
      relationship.target_resource === candidate.id)).length;
  return outgoing + incoming;
}

function relationshipStaysInsidePack(
  relationship: ExplorationBoundaryDraft["pack"]["resources"][number]["relationships"][number],
  selectedIds: Set<string>,
): boolean {
  const links = relationship.proof?.links;
  if (!links?.length) return selectedIds.has(relationship.target_resource);
  return links.every((link) =>
    selectedIds.has(link.source_resource) && selectedIds.has(link.target_resource));
}
