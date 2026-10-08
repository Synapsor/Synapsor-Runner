import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { loadBoundaryReviewContext } from "./boundary-review-context.js";
import { createBoundaryReviewProgress, type BoundaryReviewProgress } from "./boundary-review-domain.js";
import { saveBoundaryReviewProgress } from "./boundary-review-persistence.js";
import type { BoundaryReviewMutationBindings } from "./read-authoring-contract-types.js";
import type { ReadAuthoringBindings } from "./control-policy-read-authoring-project.js";
import { withProjectAuthorityMutation } from "./project-authority-mutation.js";

type ReviewContext = Awaited<ReturnType<typeof loadBoundaryReviewContext>>;
/** The exact local signoff that its protected writer acknowledged. This does
 * not activate authority or permit adopting an unrelated current revision. */
export type ReadReviewCommit = {
  candidate_digest: `sha256:${string}`;
  review_revision: number;
  progress: BoundaryReviewProgress;
  authoring_binding?: ReadAuthoringBindings;
};
export type ReadReviewSignoff = (context: ReviewContext, committed: ReadReviewCommit) => Promise<void>;

export async function reloadReadReviewAfterCommit(projectRoot: string, mutation: {
  candidate_digest: `sha256:${string}`;
  review_revision: number;
  progress?: BoundaryReviewProgress;
  authoring_binding?: BoundaryReviewMutationBindings["authoring"];
}): Promise<Awaited<ReturnType<typeof loadBoundaryReviewContext>>> {
  const context = await loadBoundaryReviewContext(projectRoot);
  if ((mutation.progress && canonicalJsonDigest(context.progress ?? null) !== canonicalJsonDigest(mutation.progress))
    || context.bundle.candidate_digest !== mutation.candidate_digest
    || context.bundle.mutation_bindings.review_revision !== mutation.review_revision
    || canonicalJsonDigest(context.bundle.mutation_bindings.authoring ?? null)
      !== canonicalJsonDigest(mutation.authoring_binding ?? null)) {
    throw new Error("READ_BOUNDARY_REVISION_CHANGED_AFTER_SAVE: The disabled Read revision was saved, but another update changed the selected review before continuation. Resume this job to review the current revision and revalidate its Action dependencies. No authority was activated.");
  }
  return context;
}

export async function saveBoundaryReviewSignoff(projectRoot: string,
  context: Awaited<ReturnType<typeof loadBoundaryReviewContext>>, progress: BoundaryReviewProgress,
): Promise<ReadAuthoringBindings | undefined> {
  const shown = structuredClone({ bindings: context.bundle.mutation_bindings, previous: context.progress ?? null, progress });
  return withProjectAuthorityMutation(projectRoot, async (held) => {
    const current = await loadBoundaryReviewContext(held.projectRoot);
    if (canonicalJsonDigest(shown.bindings) !== canonicalJsonDigest(current.bundle.mutation_bindings)
      || canonicalJsonDigest(shown.previous) !== canonicalJsonDigest(current.progress ?? null)) {
      throw Object.assign(new Error("This Boundary changed while you were reviewing it. Reopen the current revision before signing off; your earlier review was not saved."),
        { code: "POLICY_AUTHORING_REVIEW_CHANGED" });
    }
    return saveBoundaryReviewProgress(held.projectRoot, shown.progress, shown.bindings.authoring, held);
  });
}

/** Acknowledge only this protected save. A refused/uncertain save or a
 * competing revision before reload never invokes the continuation. */
export async function saveReadReviewSignoff(input: {
  projectRoot: string; context: ReviewContext; progress: BoundaryReviewProgress;
  onReviewSignoff?: ReadReviewSignoff;
}): Promise<ReadReviewCommit> {
  const progress = structuredClone(input.progress);
  const authoring_binding = await saveBoundaryReviewSignoff(input.projectRoot, input.context, progress);
  const committed: ReadReviewCommit = { candidate_digest: progress.candidate_digest,
    review_revision: progress.revision, progress, ...(authoring_binding ? { authoring_binding } : {}) };
  if (input.onReviewSignoff) {
    const context = await reloadReadReviewAfterCommit(input.projectRoot, committed);
    await input.onReviewSignoff(context, committed);
  }
  return committed;
}

export async function saveReviewedDisabledBoundary(input: {
  projectRoot: string;
  context: Awaited<ReturnType<typeof loadBoundaryReviewContext>>;
  actor: string;
  reason: string;
  onReviewSignoff?: ReadReviewSignoff;
}): Promise<ReadReviewCommit> {
  const progress = createBoundaryReviewProgress({
    draft: input.context.draft,
    candidate: input.context.candidate,
    confirmedDecisions: input.context.candidate.unresolved_decisions,
    ...(input.context.progress ? { previous: input.context.progress } : {}),
    actor: input.actor,
    reason: input.reason,
    revision: (input.context.progress?.revision ?? 0) + 1,
  });
  return saveReadReviewSignoff({ ...input, progress });
}
