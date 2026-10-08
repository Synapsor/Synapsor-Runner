/** Native job protocol identity, selected before dispatch. Old authoring jobs
 * are refused rather than interpreted or migrated. */
export const STRUCTURED_AUTHORING_RESUME_VERSION = "synapsor.boundary-authoring-resume.v3" as const;
export const STRUCTURED_AUTHORING_PROTOCOL_VERSION = "synapsor.structured-authoring.v1" as const;
export type StructuredAuthoringProtocol = { version: typeof STRUCTURED_AUTHORING_PROTOCOL_VERSION };

export function parseStructuredAuthoringProtocol(value: unknown): StructuredAuthoringProtocol {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).length !== 1
    || (value as Record<string, unknown>).version !== STRUCTURED_AUTHORING_PROTOCOL_VERSION) {
    throw new Error("AUTHORING_PROTOCOL_INVALID: This saved protocol is unsupported. Preserve this job and open it with its compatible Runner; no legacy interpretation was selected.");
  }
  return { version: STRUCTURED_AUTHORING_PROTOCOL_VERSION };
}

export function assertAuthoringProtocolUnchanged(previous?: StructuredAuthoringProtocol, next?: StructuredAuthoringProtocol): void {
  if (previous) parseStructuredAuthoringProtocol(previous);
  if (next) parseStructuredAuthoringProtocol(next);
  if (previous?.version !== next?.version) {
    throw new Error("AUTHORING_PROTOCOL_CHANGE_REQUIRES_NEW_JOB: A saved job cannot change its authoring protocol. Preserve its history and use a separately initialized job; no fallback or recovery right was granted.");
  }
}


export const OLDER_AUTHORING_SETUP_MESSAGE = "This setup was saved by an older version. Start a new setup.";
/** Recognize only the envelope tag. Never inspect old transcript/meaning or
 * migrate its records into the current protocol. Historical files stay intact. */
export function assertCurrentAuthoringEnvelope(value: unknown): void {
  if (value && typeof value === "object" && !Array.isArray(value)
    && ["synapsor.boundary-authoring-resume.v1", "synapsor.boundary-authoring-resume.v2"]
      .includes((value as { schema_version?: string }).schema_version ?? ""))
    throw Object.assign(new Error(OLDER_AUTHORING_SETUP_MESSAGE), { code: "AUTHORING_SETUP_OLDER_VERSION" });
}
