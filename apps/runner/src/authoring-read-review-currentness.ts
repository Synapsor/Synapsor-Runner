import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { loadBoundaryReviewContext, loadBoundaryReviewContextHeld, type BoundaryReviewBundle } from "./boundary-review-context.js";
import { readActionRuleAuthorityActivation, readActionRuleAuthorityDraft, type ActionRuleAuthorityReviewSubjectV1 } from "./action-rule-authority.js";
import { withProjectAuthorityMutation, withHeldProjectAuthorityAccess, type ProjectAuthorityMutationPermit } from "./project-authority-mutation.js";

/** Read/Action currentness is a short coherent local read, never a lease across
 * a human or model response. The caller retains its exact save/CAS baseline. */
export async function reloadReadReviewForModelRevision(projectRoot: string,
  previous: Awaited<ReturnType<typeof loadBoundaryReviewContext>>,
  expectedAction?: ActionRuleAuthorityReviewSubjectV1,
): Promise<Awaited<ReturnType<typeof loadBoundaryReviewContext>>> {
  return withProjectAuthorityMutation(projectRoot, permit => reloadReadReviewForModelRevisionHeld(projectRoot, previous, permit, expectedAction));
}
export async function reloadReadReviewForModelRevisionHeld(projectRoot: string,
  previous: Awaited<ReturnType<typeof loadBoundaryReviewContext>>, permit: ProjectAuthorityMutationPermit,
  expectedAction?: ActionRuleAuthorityReviewSubjectV1,
): Promise<Awaited<ReturnType<typeof loadBoundaryReviewContext>>> {
  return withHeldProjectAuthorityAccess(projectRoot, permit, async held => {
    const current = await loadBoundaryReviewContextHeld(projectRoot, held);
    const readIdentity = ({ authoring, ...bindings }: BoundaryReviewBundle["mutation_bindings"]) => ({
      ...bindings,
      ...(authoring ? { authoring: { ...authoring, epoch: 0 } } : {}),
  });
  if (canonicalJsonDigest(readIdentity(previous.bundle.mutation_bindings))
    !== canonicalJsonDigest(readIdentity(current.bundle.mutation_bindings))) {
    throw new Error("READ_BOUNDARY_REVISION_CHANGED: The selected Read revision changed. Reopen its current review; your requested revision has not been applied.");
  }
  if (expectedAction) {
    const currentAction = expectedAction.state === "active"
      ? await readActionRuleAuthorityActivation(projectRoot)
      : await readActionRuleAuthorityDraft(projectRoot, expectedAction.authority.name);
    if (currentAction?.digest !== expectedAction.digest
      || (expectedAction.state === "active" && canonicalJsonDigest(currentAction) !== canonicalJsonDigest(expectedAction))) {
      throw new Error("ACTION_BOUNDARY_REVISION_CHANGED: The dependent Action revision changed. Reopen the saved job to review its current rules; no Read revision was applied.");
    }
  }
  return current;
  });
}
