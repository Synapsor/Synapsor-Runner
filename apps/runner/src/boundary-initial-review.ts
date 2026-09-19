import type { AutoBoundaryBuild } from "./auto-boundary.js";
import { recommendedBoundaryReviewCandidate } from "./boundary-candidate.js";
import { createBoundaryReviewProgress, newBoundaryReviewId } from "./boundary-review-domain.js";
import { preparedReadAuthoringDraft, readAuthoringCatalog, type StoredReadAuthoring } from "./control-policy-read-authoring.js";
import { assertReadAuthoringBindings, readProjectReadAuthoring, saveProjectReadAuthoring,
  type ReadAuthoringBindings } from "./control-policy-read-authoring-project.js";

/** Publish only the first disabled review. Runtime configuration and active
 * authority are not part of this transaction and must not be rolled back. */
export async function saveInitialGovernedBoundaryReview(input: {
  projectRoot: string; build: AutoBoundaryBuild; expectedAuthoring: ReadAuthoringBindings; actor: string;
}) {
  const frozen = structuredClone(input);
  const current = await readProjectReadAuthoring(frozen.projectRoot);
  if (!current) throw new Error("The reviewed policy repository is unavailable. No initial draft was saved.");
  assertReadAuthoringBindings(frozen.expectedAuthoring, current.bindings);
  if (current.authoring.entries.length || current.authoring.selected_boundary_id !== null) {
    throw new Error("A saved Read review already exists. Resume or rescan it; initial generation cannot replace it.");
  }
  const draft = preparedReadAuthoringDraft(frozen.build);
  const candidate = recommendedBoundaryReviewCandidate(frozen.build.exploration_boundary);
  const progress = createBoundaryReviewProgress({ draft, candidate, boundaryId: newBoundaryReviewId(),
    reviewOverrides: frozen.build.overrides, confirmedDecisions: [], actor: frozen.actor, revision: 1 });
  const authoring: StoredReadAuthoring = { type: "read_authoring", selected_boundary_id: progress.boundary_id,
    entries: [{ draft, draft_lock: frozen.build.lock, candidate_lock: frozen.build.lock,
      progress, catalog: readAuthoringCatalog(frozen.build),
      ...(candidate.pack.resources.length === 0 ? { stage: "metadata_only" as const } : {}),
    }] };
  const binding = await saveProjectReadAuthoring({ projectRoot: frozen.projectRoot, expected: frozen.expectedAuthoring,
    authoring, actor: frozen.actor, operation: "prepare_initial_read" });
  return { progress, authoring: binding };
}
