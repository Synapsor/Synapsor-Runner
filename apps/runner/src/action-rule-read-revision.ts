import type { ActionRuleCatalogV1 } from "@synapsor-runner/action-rules";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import type { SchemaInspection } from "@synapsor-runner/schema-inspector";
import { explorationBoundaryCandidateDigest, generationLockSharedFactsDigest,
  type ExplorationBoundaryDraft, type GenerationLock } from "./auto-boundary.js";
import { buildActionRuleAuthoringCatalog } from "./action-rule-authoring.js";
import { buildActionRuleAuthorityDraft, type ActionRuleAuthorityDraftV1 } from "./action-rule-authority.js";

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

/** Recompile the entire disabled dependency set before saving either draft. */
export function prepareActionRuleReadRevision(input: {
  existing: ActionRuleAuthorityDraftV1;
  previousLock: GenerationLock;
  nextLock: GenerationLock;
  nextBoundary: ExplorationBoundaryDraft;
  inspection: SchemaInspection;
}): ActionRuleAuthorityDraftV1 {
  const retainedCatalog = rebindActionCatalogForReadPolicyRevision({ ...input, catalog: input.existing.authority.catalog });
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
