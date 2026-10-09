import { isAuthoringProgramResume } from "./authoring-program-capacity.js";
import { explorationBoundaryCandidateDigest } from "./auto-boundary.js";
import { isPreparedProgramRemoval } from "./authoring-program-completion.js";
import { savedAuthoringPolicyReview } from "./authoring-saved-review.js";
import type { ActionRuleAuthorityDraftV1, ActionRuleAuthorityActivationV1 } from "./action-rule-authority.js";
export { readSavedExecutionRequirements } from "./saved-execution-requirements.js";
import { readBoundaryAuthoringResumeState, type BoundaryAuthoringResumeState } from "./boundary-authoring-resume.js";
import { readProjectReadAuthoring } from "./control-policy-read-authoring-project.js";
import { readStructuredDraftSuccessorInventory } from "./boundary-draft-successor.js";

export type SavedActionJobReview = { summary: string[]; details: string[]; detailsLabel?: string; completeProgram?: { draftsComplete: boolean } };

/** A compiled outcome is not evidence that every requested job or edit is done. */
export function unfinishedActionIntents(resume: BoundaryAuthoringResumeState, currentOutcomes: readonly string[]): string[] {
  const action = resume.action;
  const pending: string[] = [];
  if (action) {
    const intents = action.intents ?? [action.intent];
    const completed = action.completed_outcomes ?? (intents.length === 1 && action.outcome
      && ["authority_review", "client_setup"].includes(resume.stage) ? [action.outcome] : []);
    const current = new Set(currentOutcomes);
    const reopened = action.checkpoint?.reopened_draft;
    const unfinishedIndexes = reopened?.covered_intent_indexes.map(index => completed.length + index)
      ?? (action.checkpoint ? [completed.length] : []);
    intents.forEach((intent, index) => {
      if (!completed[index] || !current.has(completed[index]!) || unfinishedIndexes.includes(index)
        || reopened?.outcome === completed[index]) pending.push(intent);
    });
  }
  if (resume.pending_action_addition && !pending.length) {
    pending.push(`Additional behavior from attached rules, lines ${resume.pending_action_addition.source_ranges
      .map(range => range.start === range.end ? range.start : `${range.start}-${range.end}`).join(", ")}`);
  }
  if (resume.pending_action_revision) pending.push(`Requested edit: ${resume.pending_action_revision.instruction}`);
  if (resume.pending_action_removal) pending.push(`Requested removal: ${resume.pending_action_removal.outcome}`);
  return [...new Set(pending)];
}

export async function readSavedActionJobReview(input: {
  projectRoot: string; boundaryName: string; currentOutcomes: readonly string[]; env?: NodeJS.ProcessEnv;
  currentDraft?: ActionRuleAuthorityDraftV1;
  currentActivation?: ActionRuleAuthorityActivationV1;
}): Promise<SavedActionJobReview> {
  const guided = await readGuidedActionJobReview(input);
  const successor = await readStructuredDraftSuccessorInventory(input.projectRoot);
  if (successor.status === "none") return guided;
  if (successor.status === "invalid") return { ...guided, completeProgram: { draftsComplete: false },
    summary: [...guided.summary, "Independent draft successor inventory needs inspection. No complete-program readiness was inferred."],
    details: [...guided.details, successor.reason, "Preserve the original bundle and inspect the exact inventory; do not overwrite it or recover the historical generation."] };
  let draftsComplete = guided.completeProgram?.draftsComplete ?? false;
  if (input.currentDraft) {
    try { await assertCompleteSelectedActionProgram({ projectRoot: input.projectRoot, draft: input.currentDraft, env: input.env }); draftsComplete = true; }
    catch (error) {
      if (!(error instanceof Error) || !error.message.startsWith("AUTHORING_PROGRAM_NOT_READY:")) throw error;
      draftsComplete = false;
    }
  }
  return { ...guided, completeProgram: { draftsComplete },
    summary: [...guided.summary,
      `Independent untrusted draft successor: ${successor.inventory.actions.length} proposed Actions, ${successor.inventory.intents.length} retained intents; ${successor.pending_pages.length} pages and ${successor.pending_intent_indexes.length} intent associations pending.`,
      draftsComplete ? "The complete successor declarations and normal current review checks pass. Publication remains a separate explicit operation."
        : "Imported material is disabled progress. Fresh Source, private-boundary and whole-program review remain pending."],
    details: [...guided.details, ...successor.pages.map(page => `Page ${page.number}: ${page.matching_current_disabled_outcomes.length}/${page.outcomes.length} exact disabled declarations currently match.`),
      ...successor.pending_intent_indexes.map(index => `Pending retained intent ${index + 1}: ${successor.inventory.intents[index]!.text}`),
      ...(successor.current_binding_matches ? [] : ["The current database/access/Read binding differs from the immutable successor inventory."]),
      "Original unknown requests, approvals, publication and transport consent were not imported. Attach and review current Source through normal controls before considering publication."] };
}

async function readGuidedActionJobReview(input: {
  projectRoot: string; boundaryName: string; currentOutcomes: readonly string[]; env?: NodeJS.ProcessEnv;
  currentDraft?: ActionRuleAuthorityDraftV1;
  currentActivation?: ActionRuleAuthorityActivationV1;
}): Promise<SavedActionJobReview> {
  let selected;
  try {
    selected = (await readProjectReadAuthoring(input.projectRoot, input.env))?.selected;
  } catch (error) {
    // Guided history is optional for migrated authority, not a substitute for its validation.
    if (!(error instanceof Error) || !("code" in error) || error.code !== "POLICY_READ_AUTHORING_MISSING") throw error;
    return {
      summary: ["Saved job status unavailable. Review covers only the validated changes listed below, not completion of the original job."],
      detailsLabel: "View saved job status",
      details: ["This project has no saved guided Read authoring record. Its validated Action authority remains available for review.",
        "Reviewing these outcomes does not establish that the whole job is complete. Reopen model-guided setup to review any remaining requirements.",
        "No saved work, active permission or source data changed. Missing setup history does not bypass any authority or execution check."],
    };
  }
  if (!selected || selected.progress.candidate.pack.name !== input.boundaryName) return { summary: [], details: [] };
  const saved = await readBoundaryAuthoringResumeState(input.projectRoot, {
    boundary_name: input.boundaryName,
    generation_lock_fingerprint: selected.progress.candidate.generation_lock_fingerprint,
    schema_fingerprint: selected.draft_lock.schema_fingerprint,
    role_posture_fingerprint: selected.draft_lock.role_posture_fingerprint,
  });
  if (saved.status === "none") return { summary: [], details: [] };
  if (saved.status !== "ready") return {
    summary: ["Saved job status needs review. These prepared outcomes do not establish that the whole job is ready."],
    details: [`Saved setup: ${saved.status}. ${saved.reason}`,
      "Reopen model-guided setup to reconcile the saved job with the current review. No saved work or active permission changed."],
  };
  if (!input.currentDraft && input.currentActivation?.publication?.kind === "withdrawal") {
    const publication = input.currentActivation.publication;
    return { completeProgram: { draftsComplete: false },
      summary: [`Published withdrawal: ${publication.removed_outcomes.join(", ")}. Retained ${input.currentOutcomes.length} Actions remain active; the original job and source duties remain pending.`,
        "Withdrawal does not establish BUSINESS review completion."],
      detailsLabel: "View pending original source duties",
      details: ["Original selected job", saved.value.job_intent,
        ...publication.pending_source_ranges.map(r => `Pending source lines ${r.start}-${r.end}.`),
        "The removal and its previous review remain history. Resume current source review to resolve its remaining duties."] };
  }
  const preparedRemoval = isPreparedProgramRemoval(saved.value, input.currentDraft);
  const pending = unfinishedActionIntents(preparedRemoval ? { ...saved.value, pending_action_removal: undefined } : saved.value, input.currentOutcomes);
  if (isAuthoringProgramResume(saved.value)) {
    const ready = !pending.length && !saved.value.pending_job_revision && !saved.value.pending_read_revision
      && !saved.value.pending_policy_review && ["authority_review", "client_setup"].includes(saved.value.stage);
    return { completeProgram: { draftsComplete: ready },
      summary: [ready ? preparedRemoval
        ? `Complete replacement program: all ${saved.value.action?.intents?.length ?? 1} retained Actions are prepared. Removal of ${saved.value.pending_action_removal!.outcome} remains pending until separate publication; exact source and authority validation remain required.`
        : `Complete selected program: all ${saved.value.action?.intents?.length ?? 1} intended Actions are represented in this candidate. Exact source and authority validation remain required.`
        : `Complete selected program is pending: ${pending.length} intended Actions or saved edits, and any unresolved source duties, still require review. Publication stays disabled.`],
      details: ["Complete selected program", ...pending.map((intent, index) => `${index + 1}. ${intent}`),
        "A work unit is saved progress. It cannot be published as completion of the selected program."] };
  }
  if (!pending.length) return { summary: [], details: [] };
  return {
    summary: [`Saved job: ${pending.length} requested ${pending.length === 1 ? "change remains" : "changes remain"} unfinished. This review covers only the ${input.currentOutcomes.length} prepared ${input.currentOutcomes.length === 1 ? "change" : "changes"} below.`,
      "View unfinished saved work for the remaining requests. Reopen model-guided setup to finish them; they are not granted by this review."],
    details: ["Unfinished saved work", ...pending.map((intent, index) => `${index + 1}. ${intent}`),
      "Only the separately listed, validated outcomes can be activated here. The pending requests remain saved, not removed or treated as implemented.",
      "No model request, permission change, source query or write occurs when viewing this status."],
  };
}

/** Current v2 program gate. Runs again under publication's existing mutation lock.
 * Legacy v1 subset reviews keep their semantics; compiled counts alone never
 * establish full-program completion or current policy coverage. */
export async function assertCompleteSelectedActionProgram(input: {
  projectRoot: string; draft: ActionRuleAuthorityDraftV1; env?: NodeJS.ProcessEnv;
  /** Activation supplies its existing admitted mutation permit; UI does not. */
  permit?: import("./project-authority-mutation.js").ProjectAuthorityMutationPermit;
}): Promise<void> {
  const refuse = (reason: string): never => { throw new Error(`AUTHORING_PROGRAM_NOT_READY: ${reason} Resume the complete saved program. Its drafts and existing authority remain unchanged.`); };
  const successor = await readStructuredDraftSuccessorInventory(input.projectRoot);
  if (successor.status === "invalid") refuse("The independent successor inventory integrity or current inspection cannot be established.");
  if (successor.status === "present") {
    const required = successor.pages.flatMap(page => page.outcomes);
    const current = input.draft.authority.rules.map(rule => rule.rule.outcome);
    if (!successor.current_binding_matches || successor.pending_pages.length || successor.pending_intent_indexes.length
      || required.some(outcome => !current.includes(outcome))) {
      refuse("The complete independent successor agenda has unfinished pages, unassociated intents or changed declarations/bindings.");
    }
  }
  let selected;
  try { selected = (await readProjectReadAuthoring(input.projectRoot, input.env, input.permit))?.selected; }
  catch (error) {
    if ((error as { code?: string }).code === "POLICY_READ_AUTHORING_MISSING") {
      if (successor.status === "present") refuse("Fresh Read/Source review for the independent successor is unavailable.");
      return;
    }
    throw error;
  }
  if (!selected) {
    if (successor.status === "present") refuse("Fresh Read/Source review for the independent successor is unavailable.");
    return;
  }
  const binding = { boundary_name: selected.progress.candidate.pack.name,
    generation_lock_fingerprint: selected.progress.candidate.generation_lock_fingerprint,
    schema_fingerprint: selected.draft_lock.schema_fingerprint,
    role_posture_fingerprint: selected.draft_lock.role_posture_fingerprint };
  const loaded = await readBoundaryAuthoringResumeState(input.projectRoot, binding);
  if (successor.status === "present" && successor.inventory.sources.length) {
    const review = await savedAuthoringPolicyReview({ projectRoot: input.projectRoot, binding,
      readDigest: explorationBoundaryCandidateDigest(selected.progress.candidate), exactActionDraft: input.draft,
      env: input.env, permit: input.permit });
    if (!review?.ready) refuse("Fresh current attached Source/private-boundary coverage for the independent successor is pending. Imported Source text is untrusted material, not an accepted review.");
  }
  if (loaded.status === "none") return;
  if (loaded.status === "invalid") return refuse("The saved program integrity cannot be verified.");
  if (!isAuthoringProgramResume(loaded.value)) return;
  if (loaded.status !== "ready") return refuse("The saved program belongs to older database or access metadata.");
  const saved = loaded.value;
  const outcomes = input.draft.authority.rules.map(rule => rule.rule.outcome);
  const intents = saved.action?.intents;
  const completed = saved.action?.completed_outcomes;
  const completionState = isPreparedProgramRemoval(saved, input.draft) ? { ...saved, pending_action_removal: undefined } : saved;
  if (!intents?.length || !completed || completed.length !== intents.length
    || new Set(intents).size !== intents.length || new Set(completed).size !== completed.length
    || unfinishedActionIntents(completionState, outcomes).length || saved.action?.checkpoint
    || saved.pending_job_revision || saved.pending_read_revision || saved.pending_policy_review
    || !["authority_review", "client_setup"].includes(saved.stage)) return refuse("The selected intent inventory or a requested edit is unfinished.");
  const readDigest = explorationBoundaryCandidateDigest(selected.progress.candidate);
  if (completed.some(outcome => !input.draft.authority.rules.some(rule => rule.rule.outcome === outcome
    && rule.read_boundary_name === binding.boundary_name && rule.read_boundary_digest === readDigest))) {
    refuse("An intended outcome does not match the current exact Read revision.");
  }
  if (saved.policy_source_session) {
    const review = await savedAuthoringPolicyReview({ projectRoot: input.projectRoot, binding, readDigest,
      exactActionDraft: input.draft, env: input.env, permit: input.permit });
    if (!review?.ready) refuse("Full attached source coverage and shared obligations need current validation.");
  }
}
