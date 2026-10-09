import { ActionRuleError, type ActionRuleErrorCode } from "@synapsor-runner/action-rules";

/** Only codes emitted by the local Action authoring producers. Not a wire schema. */
const AUTHORING_CODES = [
  "ACTION_EXECUTION_INTENT_UNMET",
  "ACTION_RULE_ATOMIC_BOUNDS",
  "ACTION_RULE_ATOMIC_SHAPE",
  "ACTION_RULE_ATOMIC_TARGET_DUPLICATED",
  "ACTION_RULE_AUTHORING_CATALOG_TOO_LARGE",
  "ACTION_RULE_AUTHORING_PAUSED",
  "ACTION_RULE_DRAFT_INVALID",
  "ACTION_RULE_EFFECT_BINDING_UNAVAILABLE",
  "ACTION_RULE_EFFECT_BOUNDS_REVERSED",
  "ACTION_RULE_EFFECT_BOUND_TYPE_INVALID",
  "ACTION_RULE_EFFECT_FIELD_DUPLICATED",
  "ACTION_RULE_EFFECT_FIELD_OUTSIDE_ENVELOPE",
  "ACTION_RULE_EFFECT_FIELD_UNAVAILABLE",
  "ACTION_RULE_EFFECT_NULL_FORBIDDEN",
  "ACTION_RULE_EFFECT_OPERATION_UNAVAILABLE",
  "ACTION_RULE_EFFECT_SET_REQUIRED",
  "ACTION_RULE_EFFECT_SOURCE_FIELD_UNAVAILABLE",
  "ACTION_RULE_EFFECT_TARGET_UNAVAILABLE",
  "ACTION_RULE_EFFECT_VALUE_TYPE_INVALID",
  "ACTION_RULE_EFFECT_VALUE_UNREVIEWED",
  "ACTION_RULE_EFFECT_VERIFICATION_REQUIRED",
  "ACTION_RULE_HARD_LIMIT_CHECKPOINT_INVALID",
  "ACTION_RULE_HARD_LIMIT_PHASE_CHANGE_UNSUPPORTED",
  "ACTION_RULE_HISTORY_SELECTOR_REVIEW_REQUIRED",
  "ACTION_RULE_INSERT_TARGET_BINDING_FORBIDDEN",
  "ACTION_RULE_INTENT_INVALID",
  "ACTION_RULE_LIFETIME_APPROVAL_LIMIT_UNSUPPORTED",
  "ACTION_RULE_MODEL_CHECKPOINT_NOT_COMPILED",
  "ACTION_RULE_MODEL_CLARIFICATION_REQUIRED",
  "ACTION_RULE_MODEL_DRAFT_CANCELLED",
  "ACTION_RULE_MODEL_DRAFT_INCOMPLETE",
  "ACTION_RULE_MODEL_DRAFT_INVALID",
  "ACTION_RULE_MODEL_DRAFT_NOT_COMPILED",
  "ACTION_RULE_MODEL_MECHANICAL_QUESTION_REPEATED",
  "ACTION_RULE_POLICY_CLARIFICATION_REQUIRED",
  "ACTION_RULE_POLICY_CLARIFICATION_UNRESOLVED",
  "ACTION_RULE_REVISION_NO_CHANGE",
  "ACTION_RULE_REVISION_SCOPE_REQUIRED",
  "ACTION_RULE_REVISION_STALE",
  "ACTION_RULE_UPDATE_CONFLICT_GUARD_UNAVAILABLE",
  "ACTION_RULE_UPDATE_TARGET_AMBIGUOUS",
  "ACTION_RULE_UPDATE_TARGET_INVALID",
  "ACTION_RULE_UPDATE_TARGET_UNAVAILABLE",
] as const;
export type ActionRuleAuthoringErrorCode = typeof AUTHORING_CODES[number];
export type ActionRuleAuthoringPhase = "verification" | "effect" | "rule" | "approval";
export type ActionRuleAuthoringErrorDetails = { kind: "operator_clarification"; question: string };
export type ActionRuleAuthoringErrorOptions = {
  presentation?: "reviewed_grammar" | "terminal";
  path?: string;
  phase?: ActionRuleAuthoringPhase;
  details?: ActionRuleAuthoringErrorDetails;
};
export type ActionRuleTrustedFailure = {
  origin: "runtime" | "authoring";
  presentation: "reviewed_grammar" | "terminal";
  code: ActionRuleErrorCode | ActionRuleAuthoringErrorCode;
  message: string;
  path?: string;
  phase?: ActionRuleAuthoringPhase;
  details?: ActionRuleAuthoringErrorDetails;
};

// Registration preserves the host's original diagnostic even if a consumer mutates
// Error properties. A JSON roundtrip or prototype/name/code imitation is not registered.
const authoringFailures = new WeakMap<object, ActionRuleTrustedFailure>();

export class ActionRuleAuthoringError extends Error {
  readonly code: ActionRuleAuthoringErrorCode;
  readonly path?: string;
  readonly phase?: ActionRuleAuthoringPhase;
  readonly details?: ActionRuleAuthoringErrorDetails;

  constructor(code: ActionRuleAuthoringErrorCode, message: string, options: ActionRuleAuthoringErrorOptions = {}) {
    super(message);
    if (!AUTHORING_CODES.includes(code) || typeof message !== "string"
      || !options || typeof options !== "object" || Array.isArray(options)
      || Object.keys(options).some(key => !["path", "phase", "details", "presentation"].includes(key))
      || (options.presentation !== undefined && options.presentation !== "reviewed_grammar" && options.presentation !== "terminal")
      || (options.path !== undefined && typeof options.path !== "string")
      || (options.phase !== undefined && !["verification", "effect", "rule", "approval"].includes(options.phase))) {
      throw new TypeError("Invalid local Action authoring diagnostic.");
    }
    const detail = options.details;
    if (detail !== undefined && (!detail || typeof detail !== "object" || Array.isArray(detail)
      || Object.keys(detail).some(key => !["kind", "question"].includes(key))
      || detail.kind !== "operator_clarification"
      || typeof detail.question !== "string" || detail.question.trim().length === 0 || detail.question.length > 500
      || (code !== "ACTION_RULE_MODEL_CLARIFICATION_REQUIRED" && code !== "ACTION_RULE_POLICY_CLARIFICATION_REQUIRED"))) {
      throw new TypeError("Invalid local Action clarification diagnostic.");
    }
    this.name = "ActionRuleAuthoringError";
    this.code = code;
    if (options.path !== undefined) this.path = options.path;
    if (options.phase !== undefined) this.phase = options.phase;
    if (detail !== undefined) this.details = structuredClone(detail);
    authoringFailures.set(this, {
      origin: "authoring", code, message, presentation: options.presentation ?? "terminal",
      ...(this.path !== undefined ? { path: this.path } : {}),
      ...(this.phase !== undefined ? { phase: this.phase } : {}),
      ...(this.details !== undefined ? { details: structuredClone(this.details) } : {}),
    });
  }
}

/** Local instance projection only. Never decode a model/tool JSON error object. */
export function actionRuleTrustedFailure(error: unknown): ActionRuleTrustedFailure | undefined {
  if (!error || typeof error !== "object") return undefined;
  const authored = authoringFailures.get(error);
  if (authored) return structuredClone(authored);
  if (error instanceof ActionRuleError) {
    return { origin: "runtime", presentation: "reviewed_grammar", code: error.code, message: error.message,
      ...(error.path !== undefined ? { path: error.path } : {}) };
  }
  return undefined;
}
