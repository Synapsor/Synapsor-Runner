import { readBoundaryAuthoringResumeState, type BoundaryAuthoringResumeState } from "./boundary-authoring-resume.js";
import { readProjectReadAuthoring } from "./control-policy-read-authoring-project.js";

export type SavedActionJobReview = { summary: string[]; details: string[]; detailsLabel?: string };

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
  projectRoot: string; boundaryName: string; currentOutcomes: readonly string[];
}): Promise<SavedActionJobReview> {
  let selected;
  try {
    selected = (await readProjectReadAuthoring(input.projectRoot))?.selected;
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
  const pending = unfinishedActionIntents(saved.value, input.currentOutcomes);
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
export async function readSavedExecutionRequirements(input: { projectRoot: string; boundaryName: string }) {
  const { loadPolicySources, activePolicySource, policyTextLines } = await import("./authoring-policy-source.js");
  let selected;
  try { selected = (await readProjectReadAuthoring(input.projectRoot))?.selected; }
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
  return { source_digest: source.digest,
    passages: passages.length ? passages.map(passage => `Source lines ${passage.start}-${passage.end}: ${lines.slice(passage.start - 1, passage.end).join("\n")}`)
      : [source.text] };
}
