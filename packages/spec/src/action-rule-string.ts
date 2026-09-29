/** Action Rule text lengths retain the v1 JavaScript UTF-16 code-unit metric.
 * Presence and exact comparison are separate. Never trim or normalize values. */
export type ActionRuleTextBounds = { max_length: number; min_length?: number; enum?: readonly string[] };
export function actionRuleStringMinimumValid(type: { max_length: unknown; min_length?: unknown }): boolean {
  return type.min_length === undefined || (Number.isSafeInteger(type.min_length)
    && Number(type.min_length) >= 0 && Number(type.min_length) <= Number(type.max_length));
}
export function actionRuleStringMatches(value: unknown, type: ActionRuleTextBounds): value is string {
  return typeof value === "string" && actionRuleStringMinimumValid(type)
    && value.length >= (type.min_length ?? 0) && value.length <= type.max_length
    && (type.enum === undefined || type.enum.includes(value));
}
