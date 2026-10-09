import type { BoundaryAuthoringReadRevision, BoundaryAuthoringResumeRead } from "./boundary-authoring-resume.js";
import type { BoundaryPlanningResult } from "./authoring-planning-result.js";
import type { AuthoringTransportState } from "./authoring-generation-recovery.js";
import type { OperatorQuestion } from "./authoring-operator-question.js";
import type { NativeReadScopePorts } from "./authoring-read-scope-native.js";
import { ReadScopeReviewError } from "./authoring-read-scope-error.js";

export type ReadScopeCheckpointState = {
  questions: OperatorQuestion[]; planningResult?: BoundaryPlanningResult; generation?: AuthoringTransportState;
  read?: BoundaryAuthoringResumeRead; pendingRevision?: BoundaryAuthoringReadRevision; pendingRequest?: string;
};
/** Installs only the native scope owner's requested fields. The public adapter
 * still owns protected Resume CAS and rollback; this projection never saves or
 * acknowledges success. Completing a revision cannot clear another pending step. */
export function projectReadScopeCheckpointSave(current: ReadScopeCheckpointState,
  next: Parameters<NativeReadScopePorts["save"]>[0]): ReadScopeCheckpointState {
  if (next.completedReadRevision && (!current.pendingRevision
    || current.pendingRevision.scope_question_id !== next.completedReadRevision.question_id
    || !next.read || next.pendingReadRevisionState)) {
    throw new ReadScopeReviewError("READ_SCOPE_REVIEW_CHANGED", "The exact pending Read revision changed. No checkpoint was installed.");
  }
  return { questions: next.questions,
    ...(next.planningResult ?? current.planningResult ? { planningResult: next.planningResult ?? current.planningResult } : {}),
    ...(next.generation ?? current.generation ? { generation: next.generation ?? current.generation } : {}),
    ...(next.read ?? current.read ? { read: next.read ?? current.read } : {}),
    ...(!next.completedReadRevision ? {
      ...(next.pendingReadRevisionState ?? current.pendingRevision ? { pendingRevision: next.pendingReadRevisionState ?? current.pendingRevision } : {}),
      ...(current.pendingRequest !== undefined ? { pendingRequest: current.pendingRequest } : {}),
    } : {}) };
}
