import { withProjectAuthorityMutation, withHeldProjectAuthorityAccess, type ProjectAuthorityMutationPermit } from "./project-authority-mutation.js";
import { receiptRequirement } from "./authoring-obligation-review.js";
import { readBoundaryAuthoringResumeStateHeld } from "./boundary-authoring-resume.js";
import { readProjectReadAuthoringHeld } from "./control-policy-read-authoring-project.js";

/** Exact saved deployment passages for operator setup. These are explanatory
 * source statements, never executable requirements or permission to provision. */
export type SavedExecutionRequirementsInput = { projectRoot: string; boundaryName: string; env?: NodeJS.ProcessEnv };
export async function readSavedExecutionRequirements(input: SavedExecutionRequirementsInput) {
  const captured = structuredClone(input);
  return withProjectAuthorityMutation(input.projectRoot, held => readExecutionRequirementsHeld(captured, held));
}
export async function readSavedExecutionRequirementsHeld(input: SavedExecutionRequirementsInput, permit: ProjectAuthorityMutationPermit) {
  const captured = structuredClone(input);
  return withHeldProjectAuthorityAccess(input.projectRoot, permit, held => readExecutionRequirementsHeld(captured, held));
}
async function readExecutionRequirementsHeld(input: SavedExecutionRequirementsInput, permit: ProjectAuthorityMutationPermit) {
  const { loadPolicySourcesHeld, activePolicySource, policyTextLines } = await import("./authoring-policy-source.js");
  let selected;
  try { selected = (await readProjectReadAuthoringHeld(input.projectRoot, permit, input.env))?.selected; }
  catch (error) {
    if ((error as { code?: string }).code !== "POLICY_READ_AUTHORING_MISSING") throw error;
  }
  if (!selected || selected.progress.candidate.pack.name !== input.boundaryName) return { source_digest: null, passages: [] as string[] };
  const saved = await readBoundaryAuthoringResumeStateHeld(input.projectRoot, {
    boundary_name: input.boundaryName, generation_lock_fingerprint: selected.progress.candidate.generation_lock_fingerprint,
    schema_fingerprint: selected.draft_lock.schema_fingerprint, role_posture_fingerprint: selected.draft_lock.role_posture_fingerprint,
  }, permit);
  if (saved.status === "none") return { source_digest: null, passages: [] as string[] };
  if (saved.status !== "ready") throw new Error("SEMANTIC_RECEIPT_SAVED_REQUIREMENTS_STALE: Revalidate the saved job before reviewing its deployment requirements. No execution was enabled.");
  if (!saved.value.policy_source_session) return { source_digest: null, passages: [] as string[] };
  const session = await loadPolicySourcesHeld(input.projectRoot, saved.value.policy_source_session, permit);
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
