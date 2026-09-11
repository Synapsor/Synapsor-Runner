import type { ActionRuleCatalogV1 } from "@synapsor-runner/action-rules";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { schemaFingerprintForInspection, type SchemaInspection } from "@synapsor-runner/schema-inspector";
import { explorationBoundaryCandidateDigest, generationLockSharedFactsDigest, loadGenerationLockSnapshot,
  type ExplorationBoundaryDraft, type GenerationLock } from "./auto-boundary.js";
import { buildActionRuleAuthoringCatalog, uniqueKey } from "./action-rule-authoring.js";
import { buildActionRuleAuthorityDraft, type ActionRuleAuthorityActivationV1, type ActionRuleAuthorityDraftV1 } from "./action-rule-authority.js";

/** Prepared actions share an authoring conversation, not necessarily public
 * Read resources. Keep their complete private dependencies without choosing
 * between conflicting proofs or granting additional Read/write authority. */
export function combineReviewedActionCatalogs(catalogs: ActionRuleCatalogV1[]): ActionRuleCatalogV1 | undefined {
  const first = catalogs[0];
  if (!first) return undefined;
  const resources = new Map<string, ActionRuleCatalogV1["resources"][number]>();
  const relationships = new Map<string, ActionRuleCatalogV1["relationships"][number]>();
  for (const catalog of catalogs) {
    if (catalog.schema_version !== first.schema_version
      || catalog.generation_lock_fingerprint !== first.generation_lock_fingerprint) {
      throw new Error("ACTION_RULE_REVALIDATION_REQUIRED: Revalidate each prepared action against the current database inspection before continuing. Saved rules and active permissions are unchanged.");
    }
    for (const resource of catalog.resources) {
      const previous = resources.get(resource.name);
      const fingerprint = (value: typeof resource) => canonicalJsonDigest({ ...value,
        fields: [...value.fields].sort((a, b) => a.name.localeCompare(b.name)) });
      if (previous && fingerprint(previous) !== fingerprint(resource)) {
        throw new Error(`ACTION_RULE_REVALIDATION_REQUIRED: Prepared actions disagree about the reviewed identity, fields or safeguards for ${resource.name}. Review their supporting source together; no permissions changed.`);
      }
      resources.set(resource.name, structuredClone(resource));
    }
    for (const relationship of catalog.relationships) {
      const previous = relationships.get(relationship.name);
      if (previous && canonicalJsonDigest(previous) !== canonicalJsonDigest(relationship)) {
        throw new Error(`ACTION_RULE_REVALIDATION_REQUIRED: Prepared actions disagree about the complete key proof for ${relationship.name}. Review this relationship before continuing; no permissions changed.`);
      }
      relationships.set(relationship.name, structuredClone(relationship));
    }
  }
  return { schema_version: first.schema_version, generation_lock_fingerprint: first.generation_lock_fingerprint,
    resources: [...resources.values()].sort((a, b) => a.name.localeCompare(b.name)),
    relationships: [...relationships.values()].sort((a, b) => a.name.localeCompare(b.name)) };
}

/** Read minimization can replace authoring evidence without changing source
 * authority. Rebind from each catalog's exact saved snapshot, not a caller's
 * latest UI context, and still reject schema, role or identity changes. */
export async function buildActionCatalogForSavedReadRevision(input: {
  projectRoot: string; catalog: ActionRuleCatalogV1; nextBoundary: ExplorationBoundaryDraft; inspection: SchemaInspection;
}) {
  const retainedCatalog = input.catalog.generation_lock_fingerprint === input.nextBoundary.generation_lock_fingerprint
    ? input.catalog : rebindActionCatalogForReadPolicyRevision({ catalog: input.catalog,
      previousLock: await loadGenerationLockSnapshot(input.projectRoot, input.catalog.generation_lock_fingerprint),
      nextLock: await loadGenerationLockSnapshot(input.projectRoot, input.nextBoundary.generation_lock_fingerprint),
      nextBoundary: input.nextBoundary });
  return buildActionRuleAuthoringCatalog({ boundary: input.nextBoundary, inspection: input.inspection, retainedCatalog });
}

/** Rebuild every retained disabled Action outcome before it can be merged with
 * a newly compiled outcome from a later Read revision. */
export async function rebindStoredActionRuleAuthorityDraftForReadRevision(input: {
  projectRoot: string;
  existing: ActionRuleAuthorityDraftV1;
  nextBoundary: ExplorationBoundaryDraft;
  inspection: SchemaInspection;
  revalidateMetadata?: boolean;
}): Promise<ActionRuleAuthorityDraftV1> {
  const previousFingerprint = input.existing.authority.catalog.generation_lock_fingerprint;
  if (previousFingerprint === input.nextBoundary.generation_lock_fingerprint) return input.existing;
  return prepareActionRuleReadRevision({
    existing: input.existing,
    previousLock: await loadGenerationLockSnapshot(input.projectRoot, previousFingerprint),
    nextLock: await loadGenerationLockSnapshot(input.projectRoot, input.nextBoundary.generation_lock_fingerprint),
    nextBoundary: input.nextBoundary,
    inspection: input.inspection,
    revalidateMetadata: input.revalidateMetadata,
  });
}

/** An active authority is immutable runtime state. When an operator adds an
 * outcome against a later Read revision, rebuild only a disabled replacement
 * draft after proving the old and new generation locks are compatible. */
export async function rebindActiveActionRuleAuthorityForReadRevision(input: {
  projectRoot: string;
  active: ActionRuleAuthorityActivationV1;
  nextBoundary: ExplorationBoundaryDraft;
  inspection: SchemaInspection;
  revalidateMetadata?: boolean;
}): Promise<ActionRuleAuthorityDraftV1> {
  const copy = buildActionRuleAuthorityDraft({
    name: input.active.authority.name,
    action_boundary_name: input.active.authority.action_boundary.name,
    catalog: structuredClone(input.active.authority.catalog),
    rules: input.active.authority.rules.map(({ activated_at: _activatedAt, ...rule }) => structuredClone(rule)),
    approval_classes: structuredClone(input.active.authority.approval_classes),
    reviews: structuredClone(input.active.reviews),
    now: input.active.activated_at,
  });
  return rebindStoredActionRuleAuthorityDraftForReadRevision({
    projectRoot: input.projectRoot,
    existing: copy,
    nextBoundary: input.nextBoundary,
    inspection: input.inspection,
    revalidateMetadata: input.revalidateMetadata,
  });
}

export function rebindActionCatalogForReadPolicyRevision(input: {
  catalog: ActionRuleCatalogV1;
  previousLock: GenerationLock;
  nextLock: GenerationLock;
  nextBoundary: ExplorationBoundaryDraft;
}): ActionRuleCatalogV1 {
  if (canonicalJsonDigest(input.previousLock) !== input.catalog.generation_lock_fingerprint) {
    throw new Error("ACTION_RULE_REVISION_STALE: the saved Action catalog is not bound to the prior Read revision.");
  }
  if (canonicalJsonDigest(input.nextLock) !== input.nextBoundary.generation_lock_fingerprint
    || generationLockSharedFactsDigest(input.previousLock) !== generationLockSharedFactsDigest(input.nextLock)) {
    throw new Error("ACTION_RULE_REVISION_STALE: schema, database role, or trusted context changed during the Read revision.");
  }
  return { ...structuredClone(input.catalog), generation_lock_fingerprint: input.nextBoundary.generation_lock_fingerprint };
}

/** A metadata refresh is not a privacy-only rebind. Rebuild proofs from the
 * current inspection, retaining only reviewed names and guard selections.
 * Callers must recompile the saved rules and review the disabled replacement. */
export function rebuildActionCatalogAfterMetadataRefresh(input: {
  catalog: ActionRuleCatalogV1;
  previousLock: GenerationLock;
  nextLock: GenerationLock;
  nextBoundary: ExplorationBoundaryDraft;
  inspection: SchemaInspection;
}): ActionRuleCatalogV1 {
  const fail = (reason: string): never => { throw new Error(`ACTION_RULE_REVALIDATION_REQUIRED: ${reason} The saved rules and active permissions are unchanged; review this structural change before continuing.`); };
  if (canonicalJsonDigest(input.previousLock) !== input.catalog.generation_lock_fingerprint
    || canonicalJsonDigest(input.nextLock) !== input.nextBoundary.generation_lock_fingerprint
    || schemaFingerprintForInspection(input.inspection) !== input.nextLock.schema_fingerprint) {
    fail("The inspected database does not match the selected saved revision.");
  }
  const comparablePrevious = { ...input.previousLock, schema_fingerprint: input.nextLock.schema_fingerprint,
    role_posture_fingerprint: input.nextLock.role_posture_fingerprint };
  if (generationLockSharedFactsDigest(comparablePrevious) !== generationLockSharedFactsDigest(input.nextLock)) {
    fail("The database source, supported engine or trusted customer scope changed.");
  }
  const fresh = buildActionRuleAuthoringCatalog({ boundary: input.nextBoundary, inspection: input.inspection,
    retainedCatalog: { ...structuredClone(input.catalog), generation_lock_fingerprint: input.nextBoundary.generation_lock_fingerprint } }).catalog;
  for (const previous of input.catalog.resources) {
    const current = fresh.resources.find(resource => resource.name === previous.name);
    if (!current) fail(`The privately reviewed resource ${previous.name} is unavailable.`);
    for (const key of ["source", "engine", "schema", "table", "primary_key", "tenant_key", "principal_scope_key", "version_field"] as const) {
      if (current![key] !== previous[key]) fail(`The reviewed ${key} for ${previous.name} changed.`);
    }
    const table = input.inspection.tables.find(table => table.schema === current!.schema && table.name === current!.table)!;
    const identity = [current!.primary_key, current!.tenant_key, current!.principal_scope_key].filter((field): field is string => !!field);
    const keys = [[identity[0]!], [...new Set(identity.slice(0, 2))], [...new Set(identity)]];
    if (!keys.some(key => uniqueKey(table, key))) fail(`The row identity of ${previous.name} is no longer proven unique within its trusted scope.`);
    for (const field of previous.fields) {
      const next = current!.fields.find(candidate => candidate.name === field.name);
      if (!next || canonicalJsonDigest(next) !== canonicalJsonDigest(field)) fail(`The reviewed type or nullability of ${previous.name}.${field.name} changed.`);
    }
  }
  for (const relationship of input.catalog.relationships) {
    const next = fresh.relationships.find(candidate => candidate.name === relationship.name
      && candidate.from_resource === relationship.from_resource && candidate.to_resource === relationship.to_resource);
    if (!next || canonicalJsonDigest(next) !== canonicalJsonDigest(relationship)) fail(`The reviewed relationship ${relationship.name} no longer has the same complete key proof.`);
  }
  return fresh;
}

/** Recompile the entire disabled dependency set before saving either draft. */
export function prepareActionRuleReadRevision(input: {
  existing: ActionRuleAuthorityDraftV1;
  previousLock: GenerationLock;
  nextLock: GenerationLock;
  nextBoundary: ExplorationBoundaryDraft;
  inspection: SchemaInspection;
  revalidateMetadata?: boolean;
}): ActionRuleAuthorityDraftV1 {
  const retainedCatalog = input.revalidateMetadata
    ? rebuildActionCatalogAfterMetadataRefresh({ ...input, catalog: input.existing.authority.catalog })
    : rebindActionCatalogForReadPolicyRevision({ ...input, catalog: input.existing.authority.catalog });
  const { catalog } = buildActionRuleAuthoringCatalog({ boundary: input.nextBoundary, inspection: input.inspection, retainedCatalog });
  const fingerprintChanged = catalog.generation_lock_fingerprint !== input.existing.authority.catalog.generation_lock_fingerprint;
  if (fingerprintChanged && input.existing.authority.rules.some((rule) => rule.read_boundary_name !== input.nextBoundary.pack.name)) {
    throw new Error("ACTION_RULE_READ_REVIEW_REQUIRED: this Action bundle also depends on another Read Boundary. Review both dependencies together before changing their generation lock.");
  }
  return buildActionRuleAuthorityDraft({
    name: input.existing.authority.name,
    action_boundary_name: input.existing.authority.action_boundary.name,
    catalog,
    rules: input.existing.authority.rules.map(({ activated_at: _activatedAt, ...rule }) => ({
      ...structuredClone(rule),
      verification_boundary: { ...structuredClone(rule.verification_boundary), generation_lock_fingerprint: catalog.generation_lock_fingerprint },
      ...(rule.read_boundary_name === input.nextBoundary.pack.name
        ? { read_boundary_digest: explorationBoundaryCandidateDigest(input.nextBoundary) } : {}),
    })),
    approval_classes: structuredClone(input.existing.authority.approval_classes),
    reviews: structuredClone(input.existing.reviews),
  });
}
