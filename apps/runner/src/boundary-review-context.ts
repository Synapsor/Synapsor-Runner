import path from "node:path";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { explorationBoundaryCandidateDigest, parseExplorationBoundaryDraftArtifact, type ExplorationBoundaryDraft, type GenerationLock, type ResolvedBoundaryReviewOrigin } from "./auto-boundary.js";
import { readGuidedOnboardingState } from "./guided-project.js";
import { readProjectReadAuthoring } from "./control-policy-read-authoring-project.js";
import { readJsonFileWithLocation } from "./cli-files.js";
import { readBoundaryReviewProgress } from "./boundary-review-persistence.js";
import { recommendedBoundaryReviewCandidate } from "./boundary-candidate.js";
import { applicableBoundaryReviewConfirmations, boundaryReviewDecisions } from "./boundary-review-domain.js";
import type { ProjectAuthorityMutationPermit } from "./project-authority-mutation.js";
import type { BoundaryReviewMutationBindings } from "./read-authoring-contract-types.js";

export const BOUNDARY_REVIEW_BUNDLE_VERSION = "synapsor.boundary-review-bundle.v2";
export type BoundaryReviewBundle = {
  schema_version: typeof BOUNDARY_REVIEW_BUNDLE_VERSION;
  candidate_digest: `sha256:${string}`;
  bundle_digest: `sha256:${string}`;
  activation: "disabled_unreviewed";
  mutation_bindings: BoundaryReviewMutationBindings;
  authority: {
    source: string;
    deployment_profile: "development" | "staging" | "production";
    compiler_version: string;
    spec_version: string;
    generation_lock_fingerprint: `sha256:${string}`;
    schema_fingerprint: `sha256:${string}`;
    role_posture_fingerprint: `sha256:${string}`;
    environment: string;
    budgets: ExplorationBoundaryDraft["budgets"];
  };
  decisions: Array<ReturnType<typeof boundaryReviewDecisions>[number] & { confirmed: boolean }>;
  outstanding_decision_ids: string[];
  candidate: ExplorationBoundaryDraft;
};

export async function loadBoundaryReviewContext(projectRoot: string, permit?: ProjectAuthorityMutationPermit): Promise<{
  boundaryRoot: string;
  draft: ExplorationBoundaryDraft;
  candidate: ExplorationBoundaryDraft;
  lock: GenerationLock;
  progress: Awaited<ReturnType<typeof readBoundaryReviewProgress>>;
  bundle: BoundaryReviewBundle;
  resolvedOrigins?: ResolvedBoundaryReviewOrigin[];
}> {
  const journey = await readGuidedOnboardingState(projectRoot);
  const boundaryRoot = path.resolve(projectRoot, journey?.artifacts.boundary_root ?? "synapsor/generated");
  const relative = path.relative(projectRoot, boundaryRoot);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Managed boundary root escapes the selected project.");
  }
  const stored = await readProjectReadAuthoring(projectRoot, undefined, permit);
  if (stored && !stored.selected) {
    throw new Error("No saved Read boundary is selected. Create a disabled boundary before opening its review.");
  }
  const lock = stored?.selected?.draft_lock ?? await readJsonFileWithLocation<GenerationLock>(
    path.join(projectRoot, ".synapsor/generation-lock.json"),
    "generation lock",
  );
  const draft = stored?.selected?.draft ?? parseExplorationBoundaryDraftArtifact(await readJsonFileWithLocation<unknown>(
    path.join(boundaryRoot, "exploration-boundary.draft.json"),
    "exploration boundary draft",
  ), lock);
  const progress = stored?.selected?.progress ?? await readBoundaryReviewProgress(projectRoot, draft, permit);
  const candidate = progress?.candidate ?? recommendedBoundaryReviewCandidate(draft);
  const applicable = new Set(applicableBoundaryReviewConfirmations(candidate,
    progress?.confirmations ?? [], stored?.resolvedOrigins).map(item => item.current.id));
  const decisions = boundaryReviewDecisions(candidate).map((decision) => ({
    ...decision,
    confirmed: applicable.has(decision.id),
  }));
  const candidateDigest = explorationBoundaryCandidateDigest(candidate);
  const core = {
    schema_version: BOUNDARY_REVIEW_BUNDLE_VERSION as typeof BOUNDARY_REVIEW_BUNDLE_VERSION,
    candidate_digest: candidateDigest,
    activation: "disabled_unreviewed" as const,
    authority: {
      source: candidate.source,
      deployment_profile: candidate.deployment_profile,
      compiler_version: candidate.compiler_version,
      spec_version: candidate.spec_version,
      generation_lock_fingerprint: candidate.generation_lock_fingerprint,
      schema_fingerprint: lock.schema_fingerprint,
      role_posture_fingerprint: candidate.role_posture_fingerprint,
      environment: candidate.deployment_profile,
      budgets: candidate.budgets,
    },
    decisions,
    outstanding_decision_ids: decisions.filter((decision) => !decision.confirmed).map((decision) => decision.id),
    candidate,
  };
  const bundle: BoundaryReviewBundle = {
    ...core,
    mutation_bindings: {
      draft_digest: explorationBoundaryCandidateDigest(draft),
      candidate_digest: candidateDigest,
      generation_lock_fingerprint: draft.generation_lock_fingerprint,
      schema_fingerprint: lock.schema_fingerprint,
      role_posture_fingerprint: lock.role_posture_fingerprint,
      review_revision: progress?.revision ?? 0,
      ...(stored ? { authoring: stored.bindings } : {}),
    },
    bundle_digest: canonicalJsonDigest(core),
  };
  return { boundaryRoot, draft, candidate, lock, progress, bundle, resolvedOrigins: stored?.resolvedOrigins ?? [] };
}
