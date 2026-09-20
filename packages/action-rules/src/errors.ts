export type ActionRuleErrorCode =
  | "ACTION_RULE_INVALID"
  | "ACTION_RULE_EXPRESSION_KIND_INVALID"
  | "ACTION_RULE_TYPE_MISMATCH"
  | "ACTION_RULE_UNBOUNDED"
  | "ACTION_RULE_SCOPE_UNPROVEN"
  | "ACTION_RULE_EFFECT_OUTSIDE_BOUNDARY"
  | "ACTION_RULE_ARITHMETIC_OVERFLOW"
  | "ACTION_RULE_ENGINE_MISMATCH"
  | "ACTION_RULE_FACT_TYPE_MISMATCH"
  | "ACTION_RULE_FACTS_UNKNOWN"
  | "ACTION_RULE_LOAD_PLAN_INVALID"
  | "ACTION_RULE_NOT_ELIGIBLE"
  | "ACTION_RULE_SUBJECT_INVALID"
  | "ACTION_RULE_AMBIGUOUS"
  | "ACTION_RULE_AUTHORITY_STALE";

export class ActionRuleError extends Error {
  constructor(
    public readonly code: ActionRuleErrorCode,
    message: string,
    public readonly path?: string,
  ) {
    super(message);
    this.name = "ActionRuleError";
  }
}
