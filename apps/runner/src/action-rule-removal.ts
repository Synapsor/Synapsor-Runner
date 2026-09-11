import {
  deactivateActionRuleAuthorityIfCurrent,
  listActionRuleAuthorityDrafts, readActionRuleAuthorityActivation,
  readActionRuleAuthorityRevisionBaseline, removeOutcomeActionRuleAuthorityDraft,
  type ActionRuleAuthorityActivationV1,
  type ActionRuleAuthorityDraftV1,
} from "./action-rule-authority.js";
import type { BoundaryReviewInteractiveSession, BoundaryAccessNotice } from "./boundary-cli-picker.js";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";

export async function reviewFinalActionRemoval(input: {
  projectRoot: string;
  removal: Extract<Awaited<ReturnType<typeof prepareSavedActionRuleRemoval>>, { mode: "deactivate" }>;
  session: BoundaryReviewInteractiveSession;
}): Promise<{ completed: boolean; notice: BoundaryAccessNotice }> {
  const { removal, session } = input;
  const lines = [
    `${removal.removedOutcome} will no longer accept new requests or begin execution.`,
    "Read access, private-field protections and your existing client connection stay unchanged.",
    "Pending requests and receipts stay in history. Old approvals cannot start a new execution while this action is off.",
    "An already-dispatched database transaction may finish; inspect its receipt. This does not undo completed changes.",
  ];
  const details = [...lines, `Reviewed authority: ${removal.authorityName}`, `Exact revision: ${removal.digest}`,
    "This retires the final active outcome by deactivating Action authority. It does not create an empty authority bundle."];
  session.rememberDetails?.("Remove the last allowed change", details);
  if (!removal.completedDeactivation) {
    while (true) {
      const choice = session.chooseOption ? await session.chooseOption("REMOVE THE LAST ALLOWED CHANGE", [
        { value: "remove", label: "Remove this change; keep viewing available" },
        { value: "details", label: "View exact removal details" },
        { value: "pause", label: "Keep this removal pending", detail: "Existing permissions stay unchanged." },
      ], { initialValue: "pause", context: lines })
        : await session.confirm("Remove this change and keep viewing available?", { defaultValue: false, context: details }) ? "remove" : "pause";
      if (choice === "details") {
        if (session.showReviewDetails) await session.showReviewDetails("Remove the last allowed change", details);
        continue;
      }
      if (choice !== "remove") return { completed: false, notice: { tone: "warning", title: "Action removal is saved for review.",
        lines: ["Existing access, requests and source data are unchanged. Resume this job to review the removal."] } };
      await deactivateActionRuleAuthorityIfCurrent(input.projectRoot, removal.baseline);
      break;
    }
  }
  return { completed: true, notice: { tone: "success", title: "Viewing remains available; this change is no longer offered.",
    lines: [`Removed from active actions: ${removal.removedOutcome}.`,
      "Your client still uses the same four tools. Existing requests, completed changes and receipts were not rewritten.",
      "No new execution can begin under the removed authority. Check receipts for any transaction already dispatched."] } };
}

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
  pending?: { authority_name: string; draft_digest: string; mode?: "deactivate" }) {
  const baseline = await readActionRuleAuthorityRevisionBaseline(projectRoot);
  const drafts = await listActionRuleAuthorityDrafts(projectRoot);
  const active = await readActionRuleAuthorityActivation(projectRoot);
  const activeReviewCopy = (draft: ActionRuleAuthorityDraftV1) => active && draft.authority.name === active.authority.name
    && draft.digest === active.digest && canonicalJsonDigest(draft.reviews) === canonicalJsonDigest(active.reviews);
  if (pending?.mode === "deactivate") {
    if (active && (active.authority.name !== pending.authority_name || active.digest !== pending.draft_digest
      || active.authority.rules.length !== 1 || active.authority.rules[0]!.rule.outcome !== outcome)
      || drafts.some(draft => draft.authority.name === pending.authority_name
        && (active ? !activeReviewCopy(draft) : draft.digest !== pending.draft_digest))) {
      throw new Error("ACTION_RULE_REMOVAL_REVIEW_CHANGED: the final-action review changed. Reopen the current action review; no authority was disabled.");
    }
    return { mode: "deactivate" as const, baseline, active, removedOutcome: outcome,
      authorityName: pending.authority_name, digest: pending.draft_digest, completedDeactivation: !active };
  }
  if (!pending && active?.authority.rules.length === 1 && active.authority.rules[0]!.rule.outcome === outcome) {
    if (drafts.some(draft => draft.authority.rules.some(rule => rule.rule.outcome === outcome) && !activeReviewCopy(draft))) {
      throw new Error("ACTION_RULE_REMOVAL_REVIEW_CHANGED: this action also has a disabled revision. Review the saved revision before retiring its active authority; no work was discarded.");
    }
    return { mode: "deactivate" as const, baseline, active, removedOutcome: outcome,
      authorityName: active.authority.name, digest: active.digest, completedDeactivation: false };
  }
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
