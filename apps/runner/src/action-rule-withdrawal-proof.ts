import { canonicalJsonStringify } from "@synapsor-runner/protocol";
import {
  parseStoredActionRuleAuthority,
  removeOutcomeActionRuleAuthorityDraft,
  type ActionRuleAuthorityActivationV1,
  type ActionRuleAuthorityDraftV1,
  type ActionRuleAuthorityReviewSubjectV1,
} from "./action-rule-authority.js";

/** Pure reduction proof, not BUSINESS coverage, publication, or a CAS check.
 * Deriving the complete expected draft retains every semantic field and lets
 * the ordinary publisher recompute only removal/lifecycle-dependent material.
 * Callers must still recheck these exact active/draft records under their
 * existing publication coordination before changing authority. */
export function proveExactActionWithdrawal(
  active: ActionRuleAuthorityActivationV1,
  draft: ActionRuleAuthorityDraftV1,
): string[] {
  const refuse = (): never => {
    throw Object.assign(new Error(
      "ACTION_RULE_WITHDRAWAL_NOT_EXACT: this candidate is not solely an exact withdrawal from the current active Action authority. Review its changed rules normally; pending BUSINESS obligations remain pending.",
    ), { code: "ACTION_RULE_WITHDRAWAL_NOT_EXACT" });
  };
  try {
    const original = parseStoredActionRuleAuthority(structuredClone(active));
    const candidate = parseStoredActionRuleAuthority(structuredClone(draft));
    if (original.state !== "active" || candidate.state !== "disabled") return refuse();
    const previous = new Set(original.authority.rules.map(entry => entry.rule.outcome));
    const retained = new Set(candidate.authority.rules.map(entry => entry.rule.outcome));
    if (!retained.size || [...retained].some(outcome => !previous.has(outcome))) return refuse();
    const removed = [...previous].filter(outcome => !retained.has(outcome)).sort();
    if (!removed.length) return refuse();
    let expected: ActionRuleAuthorityReviewSubjectV1 = original;
    for (const outcome of removed) {
      expected = removeOutcomeActionRuleAuthorityDraft({ existing: expected, outcome, now: candidate.created_at });
    }
    // Includes catalog, Read bindings, source/verification/effect/rule inputs,
    // classes, limits, review prose and canonical digests. The expected builder
    // already uses the candidate's explicit creation time: no field is omitted.
    if (canonicalJsonStringify(expected) !== canonicalJsonStringify(candidate)) return refuse();
    return removed;
  } catch {
    return refuse();
  }
}
