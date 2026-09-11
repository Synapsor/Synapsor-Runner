import { hasReviewedPrincipalScope, type ExplorationBoundaryDraft } from "./auto-boundary.js";

/** Only existing, usable paths from independently queryable roots count. */
export function reviewedReadEntryPaths(boundary: ExplorationBoundaryDraft, resourceId: string) {
  return boundary.pack.resources.filter((root) => !root.relationship_only && root.id !== resourceId)
    .flatMap((root) => root.relationships.filter((link) => link.target_resource === resourceId
      && link.unmatched_rows !== "review_required").map((link) => ({
      root_resource: root.id, relationship: link.id,
      customer_scoped_root: hasReviewedPrincipalScope(root),
    })));
}

export function hasReviewedCustomerReadEntry(boundary: ExplorationBoundaryDraft, resourceId: string): boolean {
  const resource = boundary.pack.resources.find((entry) => entry.id === resourceId);
  if (!resource) return false;
  if (!resource.relationship_only) return hasReviewedPrincipalScope(resource);
  const paths = reviewedReadEntryPaths(boundary, resourceId);
  return paths.length > 0 && paths.every((path) => path.customer_scoped_root);
}
