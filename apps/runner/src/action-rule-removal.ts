import {
  listActionRuleAuthorityDrafts, readActionRuleAuthorityActivation,
  readActionRuleAuthorityRevisionBaseline, removeOutcomeActionRuleAuthorityDraft,
  type ActionRuleAuthorityActivationV1,
  type ActionRuleAuthorityDraftV1,
} from "./action-rule-authority.js";

function completedRemovalReview(active: ActionRuleAuthorityActivationV1): ActionRuleAuthorityDraftV1 {
  return {
    schema_version: "synapsor.action-rule-authority-draft.v1",
    state: "disabled",
    authority: active.authority,
    digest: active.digest,
    reviews: active.reviews,
    created_at: active.activated_at,
  };
}

/** Select the current editable bundle, never an older active copy of an outcome
 * already removed from its replacement. Publication still requires exact CAS. */
export async function prepareSavedActionRuleRemoval(projectRoot: string, outcome: string,
  pending?: { authority_name: string; draft_digest: string }) {
  const baseline = await readActionRuleAuthorityRevisionBaseline(projectRoot);
  const drafts = await listActionRuleAuthorityDrafts(projectRoot);
  const active = await readActionRuleAuthorityActivation(projectRoot);
  const owners = [...drafts, ...(active ? [active] : [])]
    .filter(candidate => candidate.authority.rules.some(rule => rule.rule.outcome === outcome));
  const names = [...new Set(owners.map(candidate => candidate.authority.name))];
  const reviewedReplacement = pending ? drafts.find(draft => draft.authority.name === pending.authority_name) : undefined;
  // Activation consumes the disabled draft. A matching active authority is the
  // durable proof that this exact removal completed, not a reason to revive it.
  const completedActivation = pending && active
    && active.authority.name === pending.authority_name
    && active.digest === pending.draft_digest
    && !active.authority.rules.some(rule => rule.rule.outcome === outcome);
  if (completedActivation) {
    // Keep the established result shape for callers until they clear the
    // checkpoint. This is a display-only snapshot, never a saved draft.
    return { baseline, draft: completedRemovalReview(active), active, alreadyRemoved: true, completedActivation: true, removedOutcome: outcome,
      previousOutcomes: active.authority.rules.map(rule => rule.rule.outcome),
      retainedOutcomes: active.authority.rules.map(rule => rule.rule.outcome) };
  }
  if (pending && (!reviewedReplacement || reviewedReplacement.digest !== pending.draft_digest
    || reviewedReplacement.authority.rules.some(rule => rule.rule.outcome === outcome))) {
    throw new Error("ACTION_RULE_REMOVAL_REVIEW_CHANGED: the saved removal review no longer matches this checkpoint. Inspect the current action list before revising it; nothing changed.");
  }
  if (reviewedReplacement) {
    return { baseline, draft: reviewedReplacement, active, alreadyRemoved: true, removedOutcome: outcome,
      previousOutcomes: reviewedReplacement.authority.rules.map(rule => rule.rule.outcome),
      retainedOutcomes: reviewedReplacement.authority.rules.map(rule => rule.rule.outcome) };
  }
  if (names.length !== 1) {
    throw new Error(names.length
      ? "ACTION_RULE_REMOVAL_AMBIGUOUS: more than one saved bundle contains this action. Select its exact saved review before removal; nothing changed."
      : "ACTION_RULE_OUTCOME_NOT_FOUND: this action is not in the saved authority. Inspect the current action list; nothing changed.");
  }
  const existing = drafts.find(draft => draft.authority.name === names[0]) ?? active!;
  const alreadyRemoved = !existing.authority.rules.some(rule => rule.rule.outcome === outcome);
  if (alreadyRemoved && existing.state !== "disabled") throw new Error("ACTION_RULE_REMOVAL_INVALID: reload the saved action review.");
  const draft = alreadyRemoved && existing.state === "disabled"
    ? existing : removeOutcomeActionRuleAuthorityDraft({ existing, outcome });
  return { baseline, draft, active, alreadyRemoved, removedOutcome: outcome,
    previousOutcomes: existing.authority.rules.map(rule => rule.rule.outcome),
    retainedOutcomes: draft.authority.rules.map(rule => rule.rule.outcome) };
}
