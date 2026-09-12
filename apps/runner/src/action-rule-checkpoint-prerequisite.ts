import type { ActionRuleAuthoringCheckpoint } from "./action-rule-authoring-checkpoint.js";
import type { BuiltActionRuleAuthoringCatalogV1 } from "./action-rule-authoring.js";
import type { ExplorationBoundaryDraft } from "./auto-boundary.js";

export type CheckpointPrivateCollectionPrerequisite = {
  resource: string;
  parentResource: string;
  relationship: string;
  collection_consistency: "complete_locked";
};

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** A retained dependency nominates a review, never scope proof or consent. */
export function checkpointPrivateCollectionPrerequisite(
  checkpoint: ActionRuleAuthoringCheckpoint,
  relationship: string,
): CheckpointPrivateCollectionPrerequisite | undefined {
  const resources = checkpoint.components.verification?.resources;
  if (!Array.isArray(resources) || resources.some(value => !record(value))) return undefined;
  if (new Set(resources.map(value => value.binding)).size !== resources.length) return undefined;
  const matches = resources.filter(value => record(value.source) && value.source.kind === "relationship"
    && value.source.relationship === relationship && value.source.direction === "inverse");
  if (matches.length !== 1) return undefined;
  const child = matches[0]!, source = child.source as Record<string, unknown>;
  const parents = resources.filter(value => value.binding === source.from_binding);
  if (parents.length !== 1 || child.collection_consistency !== "complete_locked"
    || child.overflow !== "ineligible" || !Number.isSafeInteger(child.max_rows) || Number(child.max_rows) < 1) return undefined;
  const parent = parents[0]!;
  if (![child.resource, parent.resource].every(value => typeof value === "string"
    && /^[A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*$/u.test(value))
    || child.resource === parent.resource) return undefined;
  const effect = checkpoint.components.effect;
  if (effect?.target_resource === child.resource || (Array.isArray(effect?.atomic_updates)
    && effect.atomic_updates.some(value => record(value) && value.target_resource === child.resource))) return undefined;
  return { resource: child.resource as string, parentResource: parent.resource as string,
    relationship, collection_consistency: "complete_locked" };
}

/** Missing/withdrawn bindings and arbitrary stale edges stay with the stale guard.
 * Only the host's still-pending job may request fresh private-source consent. */
export function checkpointPrivateSourcePrerequisites(
  checkpoint: ActionRuleAuthoringCheckpoint,
  context: { builtCatalog: BuiltActionRuleAuthoringCatalogV1; readBoundary: ExplorationBoundaryDraft },
): CheckpointPrivateCollectionPrerequisite[] {
  const missing = (checkpoint.reviewed_relationships ?? []).filter(name =>
    !context.builtCatalog.catalog.relationships.some(relationship => relationship.name === name));
  const prerequisites: CheckpointPrivateCollectionPrerequisite[] = [];
  for (const name of missing) {
    const candidate = checkpointPrivateCollectionPrerequisite(checkpoint, name);
    if (!candidate || checkpoint.reviewed_private_sources?.some(review => review.resource === candidate.resource)
      || context.readBoundary.pack.resources.some(resource => resource.id === candidate.resource)
      || context.builtCatalog.catalog.resources.some(resource => resource.name === candidate.resource)
      || !context.builtCatalog.catalog.resources.some(resource => resource.name === candidate.parentResource)
      || prerequisites.some(prerequisite => prerequisite.resource === candidate.resource)) return [];
    prerequisites.push(candidate);
  }
  return prerequisites;
}
