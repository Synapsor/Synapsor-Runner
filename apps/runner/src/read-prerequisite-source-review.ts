import type { ActionRuleCatalogV1 } from "@synapsor-runner/action-rules";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { rolePostureFingerprint, schemaFingerprintForInspection, type SchemaInspection } from "@synapsor-runner/schema-inspector";
import { credentialPostureFingerprintForAuthority, loadGenerationLockSnapshot, type ExplorationBoundaryDraft, type GenerationLock } from "./auto-boundary.js";
import { listActionRuleAuthorityDrafts, readActionRuleAuthorityActivation } from "./action-rule-authority.js";
import { combineReviewedActionCatalogs, rebuildActionCatalogAfterMetadataRefresh, rebindActionCatalogForReadPolicyRevision } from "./action-rule-read-revision.js";
import type { ReadPrerequisiteScopeEvidence } from "./read-prerequisite-scope.js";

export type ReadPrerequisiteSourceReviewInput = {
  projectRoot: string;
  boundary: ExplorationBoundaryDraft;
  generationLock: GenerationLock;
  inspection: SchemaInspection;
  retainedCatalogs?: readonly ActionRuleCatalogV1[];
  /** Only an explicit rescan/revalidation may refresh source metadata. */
  revalidateMetadata?: boolean;
};

function refuse(reason: string): never {
  throw new Error(`READ_PREREQUISITE_SOURCE_REVIEW_REQUIRED: ${reason} Revalidate the saved source review; no Read exposure, Action rule or active authority changed.`);
}

async function savedDependencies(projectRoot: string, boundaryName: string) {
  const drafts = await listActionRuleAuthorityDrafts(projectRoot);
  const active = await readActionRuleAuthorityActivation(projectRoot);
  return [...drafts, ...(active ? [active] : [])]
    .filter(saved => saved.authority.rules.some(rule => rule.read_boundary_name === boundaryName))
    .sort((a, b) => a.digest.localeCompare(b.digest));
}

/** Reads current saved dependencies, not authority history. An older Read digest
 * is provenance only: exact snapshots and fresh metadata must reproduce its
 * source/identity proof. Returned evidence is host-local, never Read authority. */
export async function loadReadPrerequisiteSourceReview(input: ReadPrerequisiteSourceReviewInput): Promise<{
  scopeEvidence: ReadPrerequisiteScopeEvidence;
  /** Call with the existing Read revision guard before/after consent and before save. */
  assertCurrent: () => Promise<void>;
}> {
  const { projectRoot, boundary, generationLock, inspection } = input;
  if (canonicalJsonDigest(generationLock) !== boundary.generation_lock_fingerprint
    || generationLock.engine !== inspection.engine
    || schemaFingerprintForInspection(inspection) !== generationLock.schema_fingerprint
    || rolePostureFingerprint(inspection) !== generationLock.role_posture_fingerprint
    || boundary.role_posture_fingerprint !== generationLock.role_posture_fingerprint) {
    refuse("Fresh inspection must match the selected Read generation lock and reader posture.");
  }
  const saved = await savedDependencies(projectRoot, boundary.pack.name);
  const savedDigest = canonicalJsonDigest(saved);
  if (saved.some(authority => authority.authority.rules.some(rule => rule.read_boundary_name !== boundary.pack.name))) {
    refuse("A saved Action bundle also depends on another Read Boundary; review those source dependencies together.");
  }
  const catalogs = [...new Map([...input.retainedCatalogs ?? [], ...saved.map(authority => authority.authority.catalog)]
    .map(catalog => [canonicalJsonDigest(catalog), catalog])).values()];
  if (catalogs.length > 16) refuse("Private source review is bounded to 16 exact retained catalogs.");
  const retained: ActionRuleCatalogV1[] = [];
  for (const catalog of catalogs) {
    if (new Set(catalog.resources.map(resource => resource.name)).size !== catalog.resources.length
      || new Set(catalog.resources.map(resource => `${resource.schema}.${resource.table}`)).size !== catalog.resources.length) {
      refuse("A retained catalog has ambiguous logical or physical resource bindings.");
    }
    for (const resource of catalog.resources) {
      for (const current of boundary.pack.resources.filter(current => current.schema === resource.schema && current.table === resource.table)) {
        if (current.primary_key !== resource.primary_key || current.tenant_scope || current.principal_scope
          || current.tenant_key !== resource.tenant_key || current.principal_key !== resource.principal_scope_key) {
          refuse(`The current Read identity or scope for ${resource.name} differs from its saved dependency.`);
        }
      }
    }
    const previousLock = await loadGenerationLockSnapshot(projectRoot, catalog.generation_lock_fingerprint);
    if (input.revalidateMetadata) {
      const credential = credentialPostureFingerprintForAuthority(inspection), role = inspection.role_posture;
      if (previousLock.authority_dependencies?.credential_posture_fingerprint !== credential
        || generationLock.authority_dependencies?.credential_posture_fingerprint !== credential
        || !role?.verified || role.superuser !== false || role.bypass_rls !== false || !role.read_only
        || role.owned_relations.length > 0 || role.writable_relations.length > 0) {
        refuse("Metadata refresh requires the same verified SELECT-only, non-owner/non-bypass reader credential. Missing or changed credential proof needs separate source review.");
      }
    } else {
      rebindActionCatalogForReadPolicyRevision({ catalog, previousLock, nextLock: generationLock, nextBoundary: boundary });
    }
    // Even an unchanged lock must not skip fresh field, identity and FK checks.
    // Explicit rescan may refresh writer-only metadata, but not source/context
    // or retained guards. Discard new unreviewed fields from the rebuilt catalog.
    rebuildActionCatalogAfterMetadataRefresh({ catalog, previousLock, nextLock: generationLock, nextBoundary: boundary, inspection });
    retained.push({ ...structuredClone(catalog), generation_lock_fingerprint: boundary.generation_lock_fingerprint });
  }
  const combined = combineReviewedActionCatalogs(retained);
  const assertCurrent = async () => {
    if (canonicalJsonDigest(await savedDependencies(projectRoot, boundary.pack.name)) !== savedDigest) {
      throw new Error("READ_PREREQUISITE_SOURCE_REVIEW_CHANGED: Saved Action dependencies changed during private-source review. Reopen the review; no source proof or authority was saved.");
    }
  };
  await assertCurrent();
  return { scopeEvidence: { retained_action_catalogs: combined ? [combined] : [] }, assertCurrent };
}
