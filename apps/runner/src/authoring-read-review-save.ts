import { types as nodeTypes } from "node:util";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { loadBoundaryReviewContext, loadBoundaryReviewContextHeld } from "./boundary-review-context.js";
import { createBoundaryReviewProgress, type BoundaryReviewProgress } from "./boundary-review-domain.js";
import { saveBoundaryReviewProgress } from "./boundary-review-persistence.js";
import type { BoundaryReviewMutationBindings } from "./read-authoring-contract-types.js";
import { readProjectReadAuthoringHeld, type ReadAuthoringBindings } from "./control-policy-read-authoring-project.js";
import type { BoundaryReviewSubmission } from "./auto-boundary.js";
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
export type ReadReviewSignoff = (context: ReviewContext, committed: ReadReviewCommit, before: ReviewContext) => Promise<void>;
/** A local projection check only; never prompt, call a model, or wait here. */
export type ReadReviewPredecessorCheck = (before: ReviewContext) => undefined;

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

async function commitBoundaryReviewSignoff(projectRoot: string,
  context: ReviewContext, progress: BoundaryReviewProgress,
  assertBeforeSave?: ReadReviewPredecessorCheck, submission?: BoundaryReviewSubmission,
): Promise<{ before: ReviewContext; progress: BoundaryReviewProgress; authoring_binding: ReadAuthoringBindings | undefined }> {
  const shown = structuredClone({ bindings: context.bundle.mutation_bindings, previous: context.progress ?? null, progress, submission });
  return withProjectAuthorityMutation(projectRoot, async (held) => {
    const current = await loadBoundaryReviewContextHeld(held.projectRoot, held);
    if (canonicalJsonDigest(shown.bindings) !== canonicalJsonDigest(current.bundle.mutation_bindings)
      || canonicalJsonDigest(shown.previous) !== canonicalJsonDigest(current.progress ?? null)) {
      throw Object.assign(new Error("This Boundary changed while you were reviewing it. Reopen the current revision before signing off; your earlier review was not saved."),
        { code: "POLICY_AUTHORING_REVIEW_CHANGED" });
    }
    // Bind the continuation to the actual context checked by this writer, not
    // a caller's expected projection or a later independently loaded revision.
    const before = structuredClone(current);
    const checked = assertBeforeSave?.(structuredClone(before));
    if (checked !== undefined) {
      // A mistaken async callback still refuses before saving. Observe a native
      // rejection without waiting or invoking an arbitrary thenable's methods.
      if (nodeTypes.isPromise(checked)) void Promise.prototype.then.call(checked, undefined, () => undefined);
      throw new Error("READ_REVIEW_PREDECESSOR_CHECK_INVALID: The local review predecessor check must complete synchronously without returning a result. Nothing was saved.");
    }
    // Keep the intended material immutable across a writer callback. The native
    // writer alone attaches immutable origins to explicit submitted references.
    const authoring_binding = await saveBoundaryReviewProgress(held.projectRoot, structuredClone(shown.progress),
      structuredClone(shown.bindings.authoring), held, structuredClone(shown.submission));
    if (!authoring_binding) return { before, authoring_binding, progress: structuredClone(shown.progress) };
    const stored = await readProjectReadAuthoringHeld(held.projectRoot, held);
    const actual = stored?.selected?.progress;
    const refuseAck = (): never => { throw Object.assign(new Error(
      "The Read review save was not acknowledged as the exact submitted revision. Preserve the saved state and reopen it; no continuation was adopted."),
      { code: "READ_REVIEW_SAVE_ACK_CHANGED" }); };
    if (!stored || !actual || canonicalJsonDigest(stored.bindings) !== canonicalJsonDigest(authoring_binding)) return refuseAck();
    const comparable = structuredClone(actual);
    for (const confirmation of comparable.confirmations) {
      const expected = shown.progress.confirmations.find(item => item.id === confirmation.id);
      if (!expected) return refuseAck();
      if (!expected.origin && confirmation.origin) {
        const submitted = shown.submission?.decisions.find(item => item.id === confirmation.id);
        const { decision: _display, status: _status, actor: _actor, reason: _reason, confirmed_at: _at,
          origin: _origin, ...reference } = confirmation;
        if (!submitted || canonicalJsonDigest(submitted) !== canonicalJsonDigest(reference)
          || canonicalJsonDigest(confirmation.origin) !== canonicalJsonDigest({
            revision_id: shown.bindings.authoring?.revision_id,
            boundary_id: shown.progress.boundary_id, candidate_digest: current.bundle.candidate_digest })) return refuseAck();
        // Compare everything except this writer-owned addition; return the actual
        // saved record below, never the reconstructed comparison projection.
        delete confirmation.origin;
      }
    }
    if (canonicalJsonDigest(comparable) !== canonicalJsonDigest(shown.progress)) return refuseAck();
    return { before, authoring_binding, progress: structuredClone(actual) };
  });
}

export async function saveBoundaryReviewSignoff(projectRoot: string,
  context: ReviewContext, progress: BoundaryReviewProgress, submission?: BoundaryReviewSubmission,
): Promise<ReadAuthoringBindings | undefined> {
  return (await commitBoundaryReviewSignoff(projectRoot, context, progress, undefined, submission)).authoring_binding;
}

/** Acknowledge only this protected save. A refused/uncertain save or a
 * competing revision before reload never invokes the continuation. */
export async function saveReadReviewSignoff(input: {
  projectRoot: string; context: ReviewContext; progress: BoundaryReviewProgress;
  submission?: BoundaryReviewSubmission;
  assertBeforeSave?: ReadReviewPredecessorCheck;
  onReviewSignoff?: ReadReviewSignoff;
}): Promise<ReadReviewCommit> {
  const shown = structuredClone({ context: input.context, progress: input.progress, submission: input.submission });
  const { before, authoring_binding, progress } = await commitBoundaryReviewSignoff(input.projectRoot, shown.context,
    shown.progress, input.assertBeforeSave, shown.submission);
  const committed: ReadReviewCommit = { candidate_digest: progress.candidate_digest,
    review_revision: progress.revision, progress, ...(authoring_binding ? { authoring_binding } : {}) };
  if (input.onReviewSignoff) {
    const context = await reloadReadReviewAfterCommit(input.projectRoot, committed);
    await input.onReviewSignoff(context, committed, before);
  }
  return committed;
}

export async function saveReviewedDisabledBoundary(input: {
  projectRoot: string;
  context: Awaited<ReturnType<typeof loadBoundaryReviewContext>>;
  actor: string;
  reason: string;
  submission: BoundaryReviewSubmission;
  assertBeforeSave?: ReadReviewPredecessorCheck;
  onReviewSignoff?: ReadReviewSignoff;
}): Promise<ReadReviewCommit> {
  const progress = createBoundaryReviewProgress({
    draft: input.context.draft,
    candidate: input.context.candidate,
    submission: input.submission,
    resolvedOrigins: input.context.resolvedOrigins,
    ...(input.context.progress ? { previous: input.context.progress } : {}),
    actor: input.actor,
    reason: input.reason,
    revision: (input.context.progress?.revision ?? 0) + 1,
  });
  return saveReadReviewSignoff({ ...input, progress });
}
