import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import type { BoundaryAuthoringResumeState } from "./boundary-authoring-resume.js";
import type { AuthoringTransportState } from "./authoring-generation-recovery.js";
import type { ProjectAuthorityMutationPermit } from "./project-authority-mutation.js";

/** The native Resume writer remains the sole CAS/history validator. Return a
 * new local baseline only after its durable acknowledgement; a lost save never
 * changes the caller's last acknowledged revision. */
export async function saveAuthoringRecoveryResume(input: {
  resume: BoundaryAuthoringResumeState;
  expectedRevision: `sha256:${string}`;
  recovery: AuthoringTransportState;
  permit?: ProjectAuthorityMutationPermit;
  assertCurrent(permit?: ProjectAuthorityMutationPermit): Promise<void>;
  write(next: BoundaryAuthoringResumeState, options: {
    expectedRevisionDigest: `sha256:${string}`; permit?: ProjectAuthorityMutationPermit;
  }): Promise<unknown>;
}): Promise<BoundaryAuthoringResumeState> {
  if (input.resume.revision_digest !== input.expectedRevision)
    throw new Error("BOUNDARY_AUTHORING_RESUME_CHANGED: The transport save does not identify the last acknowledged job revision. Reopen current saved work.");
  await input.assertCurrent(input.permit);
  const { revision_digest: _old, ...core } = { ...input.resume,
    generation_recovery: structuredClone(input.recovery), updated_at: new Date().toISOString() };
  const next = { ...core, revision_digest: canonicalJsonDigest(core) };
  await input.write(next, { expectedRevisionDigest: input.expectedRevision,
    ...(input.permit ? { permit: input.permit } : {}) });
  return next;
}
