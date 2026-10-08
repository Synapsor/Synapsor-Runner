import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import type { ExplorationBoundaryDraft, GenerationLock } from "./auto-boundary.js";
import type { BoundaryAuthoringResumeBinding } from "./boundary-authoring-resume.js";
import type { BoundaryReviewBundle } from "./boundary-review-context.js";

function binding(boundaryName: string, authority: Omit<BoundaryAuthoringResumeBinding, "boundary_name">): BoundaryAuthoringResumeBinding {
  return { boundary_name: boundaryName, generation_lock_fingerprint: authority.generation_lock_fingerprint,
    schema_fingerprint: authority.schema_fingerprint, role_posture_fingerprint: authority.role_posture_fingerprint };
}

/** Exact existing public binding; structural review and Resume CAS retain their owners. */
export function boundaryAuthoringResumeBinding(bundle: BoundaryReviewBundle): BoundaryAuthoringResumeBinding {
  return binding(bundle.candidate.pack.name, bundle.authority);
}

/** A pure future identity from the actual prepared mutation, not a fabricated
 * structural review, saved Resume, operator acknowledgement or commit receipt. */
export function projectBoundaryAuthoringResumeBinding(candidate: ExplorationBoundaryDraft, lock: GenerationLock): BoundaryAuthoringResumeBinding {
  if (canonicalJsonDigest(lock) !== candidate.generation_lock_fingerprint
    || lock.role_posture_fingerprint !== candidate.role_posture_fingerprint)
    throw new Error("READ_SUBJECT_CONTEXT_CHANGED: The prepared candidate does not match its exact generation lock and role.");
  return binding(candidate.pack.name, { generation_lock_fingerprint: candidate.generation_lock_fingerprint,
    schema_fingerprint: lock.schema_fingerprint, role_posture_fingerprint: lock.role_posture_fingerprint });
}
