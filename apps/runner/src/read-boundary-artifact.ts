import { isDeepStrictEqual } from "node:util";
import type { ActivatedExplorationBoundary, ExplorationBoundaryDraft } from "./auto-boundary.js";

/** These are new file envelope formats, independent of the inner policy version. */
export const READ_BOUNDARY_DRAFT_FILE_VERSION = "synapsor.exploration-boundary-draft-file.v1";
export const READ_BOUNDARY_ACTIVE_FILE_VERSION = "synapsor.exploration-boundary-active-file.v1";
export const READ_BOUNDARY_PAYLOAD_VERSION = "synapsor.exploration-boundary.v2";

export type ReadBoundaryDraftFile<T extends object = ExplorationBoundaryDraft> = {
  schema_version: typeof READ_BOUNDARY_DRAFT_FILE_VERSION;
  boundary: T;
};
export type ReadBoundaryActiveFile<T extends object = ActivatedExplorationBoundary> = {
  schema_version: typeof READ_BOUNDARY_ACTIVE_FILE_VERSION;
  boundary: T;
};

/** The existing kind-specific owner must assert the complete payload, including
 * policy/activation identity and any required lock binding. This format codec
 * neither supplies that assertion nor grants authority from a valid envelope. */
export type ReadBoundaryPayloadAssertion<T extends object> = (value: unknown) => asserts value is T;

type ArtifactKind = "draft" | "active";
export class ReadBoundaryArtifactError extends Error {
  constructor(readonly code:
    | "READ_BOUNDARY_ARTIFACT_INVALID"
    | "READ_BOUNDARY_ARTIFACT_UNSUPPORTED"
    | "READ_BOUNDARY_ARTIFACT_KIND_MISMATCH"
    | "READ_BOUNDARY_ARTIFACT_VALIDATOR_REQUIRED"
    | "READ_BOUNDARY_ARTIFACT_VALIDATOR_INVALID"
    | "READ_BOUNDARY_ARTIFACT_NORMALIZATION_REFUSED") {
    super(`${code}: stored Read file format cannot be accepted; no authority has been loaded or changed.`);
    this.name = "ReadBoundaryArtifactError";
  }
}

export function encodeReadBoundaryDraftFile<T extends object>(
  boundary: T, assertBoundary: ReadBoundaryPayloadAssertion<T>,
): ReadBoundaryDraftFile<T> {
  return { schema_version: READ_BOUNDARY_DRAFT_FILE_VERSION, boundary: checkedPayload(boundary, "draft", assertBoundary) };
}

export function encodeReadBoundaryActiveFile<T extends object>(
  boundary: T, assertBoundary: ReadBoundaryPayloadAssertion<T>,
): ReadBoundaryActiveFile<T> {
  return { schema_version: READ_BOUNDARY_ACTIVE_FILE_VERSION, boundary: checkedPayload(boundary, "active", assertBoundary) };
}

export function decodeReadBoundaryDraftFile<T extends object>(
  input: unknown, assertBoundary: ReadBoundaryPayloadAssertion<T>,
): T {
  return checkedPayload(unwrap(input, READ_BOUNDARY_DRAFT_FILE_VERSION), "draft", assertBoundary);
}

export function decodeReadBoundaryActiveFile<T extends object>(
  input: unknown, assertBoundary: ReadBoundaryPayloadAssertion<T>,
): T {
  return checkedPayload(unwrap(input, READ_BOUNDARY_ACTIVE_FILE_VERSION), "active", assertBoundary);
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function unwrap(input: unknown, version: string): unknown {
  if (!record(input) || Object.keys(input).sort().join(",") !== "boundary,schema_version") {
    throw new ReadBoundaryArtifactError("READ_BOUNDARY_ARTIFACT_INVALID");
  }
  if (input.schema_version !== version) throw new ReadBoundaryArtifactError("READ_BOUNDARY_ARTIFACT_UNSUPPORTED");
  return input.boundary;
}
function checkedPayload<T extends object>(
  input: unknown, kind: ArtifactKind, assertBoundary: ReadBoundaryPayloadAssertion<T>,
): T {
  if (!record(input)) throw new ReadBoundaryArtifactError("READ_BOUNDARY_ARTIFACT_INVALID");
  if (input.schema_version !== READ_BOUNDARY_PAYLOAD_VERSION) {
    throw new ReadBoundaryArtifactError("READ_BOUNDARY_ARTIFACT_UNSUPPORTED");
  }
  if (kind === "draft" ? input.activation !== "disabled_unreviewed"
    : !record(input.activation) || input.activation.state !== "active") {
    throw new ReadBoundaryArtifactError("READ_BOUNDARY_ARTIFACT_KIND_MISMATCH");
  }
  if (typeof assertBoundary !== "function") throw new ReadBoundaryArtifactError("READ_BOUNDARY_ARTIFACT_VALIDATOR_REQUIRED");
  let detached: unknown;
  let expected: unknown;
  try {
    // Capture expected material before the caller callback, without introducing
    // a second policy digest or normalizing/stripping any inner payload field.
    detached = structuredClone(input);
    expected = structuredClone(detached);
  } catch {
    throw new ReadBoundaryArtifactError("READ_BOUNDARY_ARTIFACT_INVALID");
  }
  const result = (assertBoundary as (value: unknown) => unknown)(detached);
  if (result !== undefined) {
    // An async assertion cannot validate a synchronous file load. Observe only
    // a native Promise's rejection; never await it or execute foreign thenables.
    if (result instanceof Promise) void Promise.prototype.then.call(result, undefined, () => undefined);
    throw new ReadBoundaryArtifactError("READ_BOUNDARY_ARTIFACT_VALIDATOR_INVALID");
  }
  if (!isDeepStrictEqual(detached, expected)) throw new ReadBoundaryArtifactError("READ_BOUNDARY_ARTIFACT_NORMALIZATION_REFUSED");
  // Do not return the object lent to the assertion: a retained callback alias
  // must not be able to mutate accepted material after validation returns.
  return expected as T;
}
