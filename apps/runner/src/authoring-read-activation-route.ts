import { inspectDatabase } from "@synapsor-runner/schema-inspector";
import type { ExplorationBoundaryDraft } from "./auto-boundary.js";
import { inspectPolicyReviewSource } from "./authoring-policy-evidence.js";
import { assessReadScopeForActivation } from "./authoring-read-scope-activation.js";
import type { NativeReadScopeAssessment } from "./authoring-read-scope-native.js";
import { loadBoundaryReviewContextHeld } from "./boundary-review-context.js";
import { withHeldProjectAuthorityAccess, type ProjectAuthorityMutationPermit } from "./project-authority-mutation.js";

/** Public saved-review adapter. Inspect and hydrate locally at each call; no
 * provider operation, confirmation, mutable session or cached meaning result.
 * The activation writer supplies its permit after all human waiting is over. */
export function createSavedReadActivationAssessment(projectRoot: string,
  schemaInspector: typeof inspectDatabase = inspectDatabase) {
  return (candidate: ExplorationBoundaryDraft, permit: ProjectAuthorityMutationPermit): Promise<NativeReadScopeAssessment> =>
    withHeldProjectAuthorityAccess(projectRoot, permit, async held => {
      const current = await loadBoundaryReviewContextHeld(held.projectRoot, held);
      const reader = await inspectPolicyReviewSource(current.lock, schemaInspector);
      return assessReadScopeForActivation({ projectRoot: held.projectRoot, candidate,
        readerInspection: reader.inspection, permit: held });
    });
}
