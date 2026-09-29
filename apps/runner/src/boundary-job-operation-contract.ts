/** Shared public field inventory. Unknown names and all values stay private. */
export const PLANNING_FIELDS = ["status", "operation", "read_mode", "read_intent", "action_mode", "action_intent",
  "action_intents", "action_outcomes", "action_outcome", "action_strategy", "summary", "question", "intended_client"] as const;
export const REVIEW_PLAN_FIELDS = ["status", "operation", "read_mode", "action_mode", "summary", "intended_client"] as const;
export const REVIEW_OPERATION_GUIDANCE = "For review/recheck without requested changes, use the separate review_rules branch: status=planned, operation=review_rules, read_mode=reuse or none, action_mode=reuse or none, summary; optionally retain an explicitly selected intended_client. Omit read_intent, action_intent, action_intents, action_outcome and action_strategy entirely, including null or empty placeholders. The existing candidate is selected by the host; action_outcome is not a review target selector. Edit branches have no operation field. A request combining review and changes needs the clarification branch {status:clarification,question}; preserve the whole request and do not discard its change to obtain a review plan.";

export function planningValueCategory(value: unknown): string {
  return value === null ? "null" : Array.isArray(value) ? "array"
    : typeof value === "string" ? value.length ? "nonempty string" : "empty string" : typeof value;
}
export function planningFieldShape(key: string, value: unknown): string {
  const safeKey = (PLANNING_FIELDS as readonly string[]).includes(key) ? key : "<unexpected-key>";
  return `/${safeKey}: ${planningValueCategory(value)}`;
}
/** Validate the closed review operation before generic edit-field parsing.
 * No redundant field is silently deleted, including neutral placeholders. */
export function assertReviewOperationShape(value: Record<string, unknown>): void {
  if (!Object.hasOwn(value, "operation")) return;
  if (value.operation !== "review_rules") throw new Error(`Invalid ${planningFieldShape("operation", value.operation)}; expected review_rules for review, or omit operation for an edit/clarification.`);
  const extra = Object.keys(value).filter(key => !(REVIEW_PLAN_FIELDS as readonly string[]).includes(key));
  if (extra.length) throw new Error(`Review-only routing cannot contain edit or extra fields. Disallowed ${extra.map(key => planningFieldShape(key, value[key])).slice(0, 8).join("; ")}. ${REVIEW_OPERATION_GUIDANCE}`);
  for (const key of ["read_mode", "action_mode"] as const) {
    if (!["reuse", "none"].includes(value[key] as string)) throw new Error(`Invalid review ${planningFieldShape(key, value[key])}; expected reuse or none. Clarify Review versus Edit without dropping a requested change.`);
  }
}
