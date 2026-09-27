import { AUTHORING_PROGRAM_RESUME_VERSION } from "./authoring-program-capacity.js";
import { explorationBoundaryCandidateDigest } from "./auto-boundary.js";
import { isPreparedProgramRemoval } from "./authoring-program-completion.js";
import { savedAuthoringPolicyReview } from "./authoring-saved-review.js";
import type { ActionRuleAuthorityDraftV1 } from "./action-rule-authority.js";
import { receiptRequirement } from "./authoring-obligation-review.js";
import { readBoundaryAuthoringResumeState, type BoundaryAuthoringResumeState } from "./boundary-authoring-resume.js";
import { readProjectReadAuthoring } from "./control-policy-read-authoring-project.js";

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
  const preparedRemoval = isPreparedProgramRemoval(saved.value, input.currentDraft);
  const pending = unfinishedActionIntents(preparedRemoval ? { ...saved.value, pending_action_removal: undefined } : saved.value, input.currentOutcomes);
  if (saved.value.schema_version === AUTHORING_PROGRAM_RESUME_VERSION) {
    const ready = !pending.length && !saved.value.pending_job_revision && !saved.value.pending_read_revision
      && !saved.value.pending_policy_review && ["authority_review", "client_setup"].includes(saved.value.stage);
    return { completeProgram: { draftsComplete: ready },
      summary: [ready ? preparedRemoval
        ? `Complete replacement program: all ${saved.value.action?.intents?.length ?? 1} retained Actions are prepared. Removal of ${saved.value.pending_action_removal!.outcome} remains pending until separate publication; exact source and authority validation remain required.`
        : `Complete selected program: all ${saved.value.action?.intents?.length ?? 1} intended Actions are represented in this candidate. Exact source and authority validation remain required.`
        : `Complete selected program is pending: ${pending.length} intended Actions or saved edits still require review. Publication stays disabled.`],
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

/** Exact saved deployment passages for operator setup. These are explanatory
 * source statements, never executable requirements or permission to provision. */
export async function readSavedExecutionRequirements(input: { projectRoot: string; boundaryName: string; env?: NodeJS.ProcessEnv }) {
  const { loadPolicySources, activePolicySource, policyTextLines } = await import("./authoring-policy-source.js");
  let selected;
  try { selected = (await readProjectReadAuthoring(input.projectRoot, input.env))?.selected; }
  catch (error) {
    if ((error as { code?: string }).code !== "POLICY_READ_AUTHORING_MISSING") throw error;
  }
  if (!selected || selected.progress.candidate.pack.name !== input.boundaryName) return { source_digest: null, passages: [] as string[] };
  const saved = await readBoundaryAuthoringResumeState(input.projectRoot, {
    boundary_name: input.boundaryName, generation_lock_fingerprint: selected.progress.candidate.generation_lock_fingerprint,
    schema_fingerprint: selected.draft_lock.schema_fingerprint, role_posture_fingerprint: selected.draft_lock.role_posture_fingerprint,
  });
  if (saved.status === "none") return { source_digest: null, passages: [] as string[] };
  if (saved.status !== "ready") throw new Error("SEMANTIC_RECEIPT_SAVED_REQUIREMENTS_STALE: Revalidate the saved job before reviewing its deployment requirements. No execution was enabled.");
  if (!saved.value.policy_source_session) return { source_digest: null, passages: [] as string[] };
  const session = await loadPolicySources(input.projectRoot, saved.value.policy_source_session);
  const source = activePolicySource(session);
  if (!source) return { source_digest: null, passages: [] as string[] };
  const lines = policyTextLines(source.text);
  const passages = session.coverage?.source_digest === source.digest
    ? session.coverage.passages.filter(passage => passage.deployment_prerequisite === "runner_execution_setup") : [];
  const requirementRanges = session.coverage?.source_digest === source.digest ? session.coverage.passages : [{ start: 1, end: lines.length }];
  const receiptRequirements = [...new Set(requirementRanges.map(p => receiptRequirement(source, p)).filter(Boolean))];
  return { source_digest: source.digest, receipt_requirements: receiptRequirements,
    passages: passages.length ? passages.map(passage => `Source lines ${passage.start}-${passage.end}: ${lines.slice(passage.start - 1, passage.end).join("\n")}`)
      : [source.text] };
}

/** Current v2 program gate. Runs again under publication's existing mutation lock.
 * Legacy v1 subset reviews keep their semantics; compiled counts alone never
 * establish full-program completion or current policy coverage. */
export async function assertCompleteSelectedActionProgram(input: {
  projectRoot: string; draft: ActionRuleAuthorityDraftV1; env?: NodeJS.ProcessEnv;
  /** Activation supplies its existing admitted mutation permit; UI does not. */
  permit?: import("./project-authority-mutation.js").ProjectAuthorityMutationPermit;
}): Promise<void> {
  let selected;
  try { selected = (await readProjectReadAuthoring(input.projectRoot, input.env))?.selected; }
  catch (error) {
    if ((error as { code?: string }).code === "POLICY_READ_AUTHORING_MISSING") return;
    throw error;
  }
  if (!selected) return;
  const binding = { boundary_name: selected.progress.candidate.pack.name,
    generation_lock_fingerprint: selected.progress.candidate.generation_lock_fingerprint,
    schema_fingerprint: selected.draft_lock.schema_fingerprint,
    role_posture_fingerprint: selected.draft_lock.role_posture_fingerprint };
  const loaded = await readBoundaryAuthoringResumeState(input.projectRoot, binding);
  if (loaded.status === "none") return;
  const refuse = (reason: string): never => { throw new Error(`AUTHORING_PROGRAM_NOT_READY: ${reason} Resume the complete saved program. Its drafts and existing authority remain unchanged.`); };
  if (loaded.status === "invalid") return refuse("The saved program integrity cannot be verified.");
  if (loaded.value.schema_version !== AUTHORING_PROGRAM_RESUME_VERSION) return;
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
