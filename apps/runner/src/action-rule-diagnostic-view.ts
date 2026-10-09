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
  return {
    kind: "reviewed_grammar",
    blockers: [exact],
  };
}
