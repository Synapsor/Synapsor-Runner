import type { NativeAuthoringFailure } from "./authoring-native-failure.js";

export type ReadScopeFailureCode = "READ_SCOPE_REVIEW_CHANGED" | "READ_SCOPE_REVIEW_STALE"
  | "READ_SCOPE_QUESTION_MISSING" | "READ_SCOPE_HISTORY_UNAVAILABLE";
const nativeFailures = new WeakMap<object, NativeAuthoringFailure<"read_scope", ReadScopeFailureCode>>();
/** Only the Read owner issues this local operation's failure. Model text, JSON,
 * copied properties and prototypes cannot establish its native disposition. */
export class ReadScopeReviewError extends Error {
  constructor(code: ReadScopeFailureCode, display: string) {
    super(`${code}: ${display}`);
    nativeFailures.set(this, Object.freeze({ domain: "read_scope", code, display, local_outcome: "unchanged" }));
  }
}
export function nativeReadScopeFailure(error: unknown) {
  return error !== null && typeof error === "object" ? nativeFailures.get(error) : undefined;
}
