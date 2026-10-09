import type { NativeAuthoringFailure } from "./authoring-native-failure.js";

export type ReadScopeFailureCode = "READ_SCOPE_REVIEW_CHANGED" | "READ_SCOPE_REVIEW_STALE"
  | "READ_SCOPE_QUESTION_MISSING" | "READ_SCOPE_HISTORY_UNAVAILABLE" | "READ_SCOPE_REVIEW_ACK_UNKNOWN"
  | "READ_SCOPE_INVALID" | "READ_SCOPE_RECORD_INVALID" | "READ_SCOPE_REFERENCE_INVALID"
  | "READ_SCOPE_PROVENANCE_STALE" | "READ_SCOPE_SUBJECT_CONFLICT" | "READ_SCOPE_SUBJECT_INVALID"
  | "READ_SCOPE_SUBJECT_STALE" | "READ_SCOPE_TARGET_INVALID";
const nativeFailures = new WeakMap<object, NativeAuthoringFailure<"read_scope", ReadScopeFailureCode>>();
/** Only the Read owner issues this local operation's failure. Model text, JSON,
 * copied properties and prototypes cannot establish its native disposition. */
export class ReadScopeReviewError extends Error {
  constructor(code: ReadScopeFailureCode, display: string,
    local_outcome: NativeAuthoringFailure<"read_scope", ReadScopeFailureCode>["local_outcome"] = "unchanged",
    options?: ErrorOptions) {
    super(`${code}: ${display}`, options);
    nativeFailures.set(this, Object.freeze({ domain: "read_scope", code, display, local_outcome }));
  }
}
export function nativeReadScopeFailure(error: unknown) {
  return error !== null && typeof error === "object" ? nativeFailures.get(error) : undefined;
}
