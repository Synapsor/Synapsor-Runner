/** Native job protocol identity. This is host-selected before dispatch, not a
 * model capability or a recovery grant. Legacy jobs are never inferred-upgraded. */
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
