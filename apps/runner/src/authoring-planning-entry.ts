import { BoundaryJobPlanningError, planningDiagnosticLines } from "./boundary-job-diagnostics.js";
import { AskError } from "./model-ask.js";
import { redactCliErrorMessage } from "./cli-logging.js";
import { prepareBoundaryJobPlanningInvocation, type BoundaryJobPlan, type BoundaryJobPlanningInput } from "./boundary-job-model.js";
import type { BoundaryAuthoringResumeState } from "./boundary-authoring-resume.js";
import type { BoundaryPlanningResult } from "./authoring-planning-result.js";
import type { createNativeReadScope } from "./authoring-read-scope-native.js";

type ScopePorts = Pick<ReturnType<typeof createNativeReadScope>, "recordPlanning" | "restorePlanning" | "review">;
/** Selection only: the native owner still checks the complete current invocation
 * and question. A historical plan is not the plan for a newly requested edit. */
export function retainedPlanningForEntry(input: {
  resume?: BoundaryAuthoringResumeState; continuing: boolean; editing: boolean;
}): BoundaryPlanningResult | undefined {
  const resume = input.resume;
  return input.continuing && !input.editing && resume?.stage === "planning"
    && !resume.pending_job_revision && !resume.pending_read_revision
    && !resume.pending_action_revision && !resume.pending_action_addition && !resume.pending_action_removal
    ? resume.planning_result : undefined;
}
/** Narrow composition of the existing producer and native question owner. There
 * is no second question engine, consumption record or save implementation. */
export async function runPlanningEntry(input: {
  request: BoundaryJobPlanningInput; retained?: BoundaryPlanningResult;
  produce(): Promise<BoundaryJobPlan>; scope: ScopePorts;
}): Promise<{ plan: BoundaryJobPlan; readReviewPending: boolean }> {
  const plan = input.retained
    ? await input.scope.restorePlanning(await prepareBoundaryJobPlanningInvocation(input.request, input.retained))
    : await input.produce();
  if (plan.state !== "planned") return { plan, readReviewPending: false };
  const saved = input.retained ?? (plan.completion ? await input.scope.recordPlanning(plan) : undefined);
  // The genuine completed plan is already durable before this operator wait.
  // This review grants only the exact existing Read interpretation.
  const readReviewPending = Boolean(saved && plan.read_scope?.proposal.applicability === "no_read_requested"
    && (await input.scope.review(saved.read_scope_question_id)).state !== "confirmed");
  return { plan, readReviewPending };
}

export function boundaryJobPlanningFailureReason(error: unknown): string {
  if (error instanceof BoundaryJobPlanningError) return planningDiagnosticLines(error.diagnostic).join("\n");
  if (error instanceof AskError && error.code === "ASK_REQUIRED_TOOL_NOT_CALLED") {
    return "The model did not submit the required typed Read/Action job plan.";
  }
  if (error instanceof Error && /^BOUNDARY_JOB_PLAN_INVALID:/iu.test(error.message)) {
    return "The model response did not match Runner's typed Read/Action planning contract.";
  }
  if (error instanceof Error) {
    return `Runner could not finish the planning step: ${redactCliErrorMessage(error.message).slice(0, 700)}`;
  }
  return "Runner could not finish the planning step. No new draft was saved.";
}
