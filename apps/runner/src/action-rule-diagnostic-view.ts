import { actionRuleTrustedFailure } from "./action-rule-authoring-error.js";

/** Presentation of an already-refused, locally produced Action draft. The
 * caller retains generation-stop, registered-recovery and provider boundaries. */
export type ActionRuleDraftFailureView =
  | { kind: "required_tool" }
  | { kind: "reviewed_grammar"; blockers: string[]; details?: string[] };

export function actionRuleDraftFailureView(error: unknown): ActionRuleDraftFailureView | undefined {
  const failure = actionRuleTrustedFailure(error);
  if (!failure || failure.presentation !== "reviewed_grammar") return undefined;
  return { kind: "reviewed_grammar", blockers: [failure.message] };
}

/** Cancellation is an actual host diagnostic, never a model-supplied message. */
export function actionRuleDraftCancelled(error: unknown): boolean {
  return actionRuleTrustedFailure(error)?.code === "ACTION_RULE_MODEL_DRAFT_CANCELLED";
}
