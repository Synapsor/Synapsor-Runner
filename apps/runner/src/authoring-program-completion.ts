import { AUTHORING_PROGRAM_RESUME_VERSION } from "./authoring-program-capacity.js";
import type { BoundaryAuthoringResumeState } from "./boundary-authoring-resume.js";
import type { ActionRuleAuthorityDraftV1 } from "./action-rule-authority.js";

/** Removal remains pending until publication. Only its exact prepared retained
 * replacement can pass the draft-completion check; no stale/partial agenda or
 * deactivation request is converted into completed work. Full source/Read and
 * publication currentness checks still apply to that replacement. */
export function isPreparedProgramRemoval(resume: BoundaryAuthoringResumeState, draft?: ActionRuleAuthorityDraftV1): boolean {
  const removal = resume.pending_action_removal;
  const completed = resume.action?.completed_outcomes;
  const intents = resume.action?.intents;
  const outcomes = draft?.authority.rules.map(rule => rule.rule.outcome);
  return Boolean(resume.schema_version === AUTHORING_PROGRAM_RESUME_VERSION && removal && !removal.mode && draft && resume.stage === "authority_review"
    && !resume.action?.checkpoint
    && removal.authority_name === draft.authority.name && removal.draft_digest === draft.digest
    && outcomes && completed && intents && intents.length === completed.length && new Set(intents).size === intents.length
    && !outcomes.includes(removal.outcome) && completed.length === outcomes.length
    && new Set(completed).size === completed.length && completed.every(outcome => outcomes.includes(outcome)));
}

