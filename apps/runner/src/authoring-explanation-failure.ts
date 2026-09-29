import { AskError } from "./model-ask.js";

export type AuthoringExplanationFailure = {
  category: string;
  code: string;
  retryable: boolean;
  guidance: string;
  /** Fixed validator description only; never raw provider content. */
  mismatch?: string;
};

// Use fixed diagnostics only; provider bodies, URLs and credentials are not review content.
export function authoringExplanationFailure(error?: unknown): AuthoringExplanationFailure {
  const code = error instanceof AskError ? error.code : "NARRATION_UNAVAILABLE";
  const known: Record<string, [string, boolean, string]> = {
    ASK_GENERATION_OUTCOME_REQUIRES_INSPECTION: ["Incomplete generation or uncertain local result", false, "Inspect the saved job and its recorded attempts. No automatic generation or tool replay is permitted; local details remain available."],
    ASK_GENERATION_OUTCOME_UNKNOWN: ["Provider generation outcome unknown", false, "Saved progress is retained. The provider may have charged for this attempt; inspect its finite recovery history before continuing."],
    ASK_GENERATION_NOT_SENT: ["Generation not sent", false, "Inspect connection settings and the saved job's recovery policy; no source authority changed."],
    ASK_GENERATION_CONTEXT_CHANGED: ["Saved generation context changed", false, "Reopen the current saved job; the previous generation will not be silently retargeted."],
    ASK_GENERATION_DEADLINE: ["Generation deadline reached", false, "Inspect the retained attempt and saved progress; its deadline and allowance were not reset."],
    ASK_GENERATION_RECOVERY_EXHAUSTED: ["Generation retries exhausted", false, "Preserve and inspect the current job and its attempts. No further automatic generation is permitted."],
    ASK_GENERATION_ALREADY_ACTIVE: ["Generation still active", false, "Wait for the current operation to finish or cancel it; do not start another request."],
    ASK_GENERATION_HISTORY_LIMIT: ["Saved generation record bound reached", false, "Preserve and inspect the saved recovery history. No automatic new request is permitted."],
    ASK_KEY_REQUIRED: ["Provider credential unavailable", false, "Restore the configured credential before retrying; local review remains available."],
    ASK_KEY_INVALID: ["Provider credential invalid", false, "Correct the provider credential before retrying; local review remains available."],
    ASK_EGRESS_ACKNOWLEDGEMENT_REQUIRED: ["Provider permission required", false, "Review provider egress before asking the model; local review needs no provider permission."],
    ASK_PROVIDER_TIMEOUT: ["Provider timeout", true, "Retry the explanation, or review the local details now."],
    ASK_PROVIDER_UNAVAILABLE: ["Provider unavailable", true, "Retry the explanation, or review the local details now."],
    ASK_PROVIDER_RATE_LIMITED: ["Provider rate limit or quota", true, "Retry after the provider limit clears; local review remains available."],
    ASK_PROVIDER_AUTHENTICATION_FAILED: ["Provider authentication", false, "Correct the provider credentials before retrying; local review remains available."],
    ASK_PROVIDER_PERMISSION_DENIED: ["Provider access denied", false, "Correct model access before retrying; local review remains available."],
    ASK_PROVIDER_RESPONSE_INVALID: ["Malformed provider response", true, "Retry the explanation, or review the local details now."],
    ASK_PROVIDER_RESPONSE_TOO_LARGE: ["Provider response limit", true, "Retry the explanation, or review the local details now."],
    ASK_PROVIDER_HTTP_ERROR: ["Provider request failed", true, "Retry the explanation, or review the local details now."],
    ASK_PROVIDER_STREAM_FAILED: ["Provider stream interrupted", true, "Retry the explanation, or review the local details now."],
    ASK_PROVIDER_DNS_FAILED: ["Provider name resolution failed", true, "Check connectivity before retrying; local review remains available."],
    ASK_PROVIDER_DESTINATION_REFUSED: ["Provider destination refused", false, "Correct the provider configuration before retrying; local review remains available."],
    ASK_PROVIDER_REDIRECT_REFUSED: ["Provider redirect refused", false, "Use the provider's approved endpoint before retrying; local review remains available."],
    ASK_PROVIDER_REQUEST_TOO_LARGE: ["Explanation context too large", false, "The explanation exceeded the request bound. Review the complete local details instead."],
    ASK_PROVIDER_REQUEST_INVALID: ["Explanation request invalid", false, "Runner could not encode the explanation request. Review the complete local details instead."],
    ASK_CANCELLED: ["Explanation cancelled", true, "Retry when ready, or review the local details now."],
    NARRATION_CONTEXT_MISSING: ["Conversation context unavailable", false, "Local review remains available without restarting setup."],
    NARRATION_EMPTY: ["No model explanation returned", true, "Retry the explanation, or review the local details now."],
    NARRATION_VALIDATION_REJECTED: ["Explanation failed validation", true, "The explanation did not match the validated record. Review local details or retry."],
  };
  const result = known[code];
  return result
    ? { code, category: result[0], retryable: result[1], guidance: result[2] }
    : { code: "NARRATION_UNAVAILABLE", category: "Explanation unavailable; cause unclassified", retryable: true,
        guidance: "Retry the explanation, or review the local details now." };
}
