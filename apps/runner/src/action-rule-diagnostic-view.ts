/** Presentation of an already-refused Action draft. The caller retains the
 * generation-stop, registered-recovery and provider boundaries. */
export type ActionRuleDraftFailureView =
  | { kind: "required_tool" }
  | { kind: "reviewed_grammar"; blockers: string[]; details?: string[] };

export function actionRuleDraftFailureView(error: unknown): ActionRuleDraftFailureView | undefined {
  if (!(error instanceof Error)) return undefined;
  if (/^ACTION_RULE_(?:AUTHORING_)?(?:NOT_SUBMITTED|CLARIFICATION_REQUIRED):/iu.test(error.message)) {
    return { kind: "required_tool" };
  }
  const blocked = /^(?:ACTION_RULE_[A-Z0-9_]+):\s*(.*)$/isu.exec(error.message);
  if (!blocked) return undefined;
  const exact = (blocked[1]?.trim() || "The verified outcome did not fit the reviewed Action Rule grammar.")
    .replace(/^(?:(?:ACTION_RULE_[A-Z0-9_]+):\s*)+/iu, "");
  const summary = actionRuleModelFailureSummary(exact);
  return {
    kind: "reviewed_grammar",
    blockers: [summary],
    ...(summary === exact ? {} : { details: [summary, `Exact local validation: ${exact}`] }),
  };
}

function actionRuleModelFailureSummary(message: string): string {
  const target = /reviewed\s+([A-Za-z_][A-Za-z0-9_.:-]*)\s+(?:subject\s+)?row/iu.exec(message)?.[1]
    ?? /UPDATE\s+([A-Za-z_][A-Za-z0-9_-]*\.[A-Za-z_][A-Za-z0-9_.:-]*)/iu.exec(message)?.[1];
  if (/multiple reviewed .* subject rows|TARGET_AMBIGUOUS/iu.test(message)) {
    return target
      ? `Runner found more than one reviewed ${target} row that could be changed and will not guess which business object the agent meant.`
      : "Runner found more than one reviewed row that could be changed and will not guess which business object the agent meant.";
  }
  if (/target_binding|subject target binding|which reviewed .* row .* update|TARGET_(?:INVALID|UNAVAILABLE)/iu.test(message)) {
    return target
      ? `Runner could not identify one exact reviewed ${target} row for the proposed change. No Action draft was saved.`
      : "Runner could not identify one exact reviewed row for the proposed change. No Action draft was saved.";
  }
  return message;
}
