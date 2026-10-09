/** Native local rejection; no model prose or supplied code can mint this class. */
export class AuthoringResumeMaterialError extends Error {
  constructor(readonly code: "BOUNDARY_AUTHORING_RESUME_PRIVATE_MATERIAL_BLOCKED" | "BOUNDARY_AUTHORING_RESUME_TRUSTED_IDENTITY_BLOCKED", message: string) {
    super(`${code}: ${message}`);
  }
}

/** The checkpoint caller supplies only the rejection from its actual save.
 * Other currentness/storage failures have no material disposition. */
export class AuthoringCheckpointSaveError extends Error {
  readonly code = "ACTION_CHECKPOINT_NOT_SAVED";
  constructor(step: string, diagnostic: string | undefined, rejectedMaterial?: AuthoringResumeMaterialError) {
    super(`ACTION_CHECKPOINT_NOT_SAVED: ${step} could not be saved. ${diagnostic ?? "Inspect local storage access and retry the saved job."} Existing drafts and authority are unchanged.`,
      { cause: rejectedMaterial });
  }
}

export function rejectedCheckpointMaterial(error: unknown): error is AuthoringCheckpointSaveError {
  return error instanceof AuthoringCheckpointSaveError && error.cause instanceof AuthoringResumeMaterialError;
}
