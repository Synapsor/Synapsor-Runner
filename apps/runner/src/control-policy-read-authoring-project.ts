import { openBoundProjectControlPolicies, type BoundProjectPolicyStore } from "./control-policy-store.js";
import { OperatorAuthorityRepository, type OperatorAuthorityState } from "./control-policy-operator-repository.js";
import type { StoredReadAuthoring, PreparedReadEntry } from "./control-policy-read-authoring.js";
import type { BoundaryReviewProgress } from "./boundary-review-domain.js";
import { OPERATOR_READ_AUTHORING_KEY, assertReadAuthoringBindings, type ReadAuthoringBindings } from "./control-policy-record.js";
import type { GovernedReadEditDecision } from "./control-policy-read-edit.js";
import { withProjectAuthorityMutation, type ProjectAuthorityMutationPermit } from "./project-authority-mutation.js";
export { assertReadAuthoringBindings, type ReadAuthoringBindings } from "./control-policy-record.js";

export type ProjectReadAuthoring = {
  bindings: ReadAuthoringBindings;
  authoring: StoredReadAuthoring;
  selected: PreparedReadEntry | undefined;
};

/** No file fallback or normalization once the project is governed. The token
 * belongs to this original read and must travel with the operator's preview. */
export async function readProjectReadAuthoring(projectRoot: string): Promise<ProjectReadAuthoring | undefined> {
  const binding = await openBoundProjectControlPolicies(projectRoot);
  if (!binding) return undefined;
  try {
    return authoringState(binding, await new OperatorAuthorityRepository(binding).currentReadState());
  } finally { await binding.close(); }
}

/** A complete replacement is one transaction: disabled candidates, all saved
 * review decisions and the selected editing identity. Active grants are separate. */
export async function saveProjectReadAuthoring(input: {
  projectRoot: string; expected: ReadAuthoringBindings;
  authoring: StoredReadAuthoring; actor: string; operation: string;
  verifiedDecision?: GovernedReadEditDecision;
}, permit?: ProjectAuthorityMutationPermit): Promise<ReadAuthoringBindings> {
  const frozen = structuredClone(input);
  return withProjectAuthorityMutation(frozen.projectRoot, (held) => saveProjectReadAuthoringUnlocked({
    ...frozen, projectRoot: held.projectRoot,
  }), { permit });
}

async function saveProjectReadAuthoringUnlocked(input: Parameters<typeof saveProjectReadAuthoring>[0]): Promise<ReadAuthoringBindings> {
  const frozen = input;
  const binding = await openBoundProjectControlPolicies(input.projectRoot);
  if (!binding) fail("POLICY_AUTHORING_STORE_CHANGED", "The governed Read review repository is unavailable.");
  try {
    const repository = new OperatorAuthorityRepository(binding);
    const current = authoringState(binding, await repository.currentReadState());
    assertReadAuthoringBindings(frozen.expected, current.bindings);
    const committed = await repository.commitReadAuthoring({ expected_epoch: frozen.expected.epoch,
      expected_revision_id: frozen.expected.revision_id, authoring: frozen.authoring,
      actor: frozen.actor, operation: frozen.operation, verifiedDecision: frozen.verifiedDecision });
    const authoringChange = committed.changes.find((change) => change.state === "active"
      && change.key.kind === OPERATOR_READ_AUTHORING_KEY.kind && change.key.name === OPERATOR_READ_AUTHORING_KEY.name);
    return { ...frozen.expected, epoch: committed.epoch, revision_id: authoringChange?.after ?? frozen.expected.revision_id };
  } finally { await binding.close(); }
}

export async function saveProjectReadProgress(input: {
  projectRoot: string; expected: ReadAuthoringBindings | undefined;
  progress: BoundaryReviewProgress;
  replacement?: Pick<PreparedReadEntry, "draft" | "draft_lock" | "candidate_lock" | "catalog">;
  actor?: string;
  verifiedDecision?: GovernedReadEditDecision;
}, permit?: ProjectAuthorityMutationPermit): Promise<false | ReadAuthoringBindings> {
  const frozen = structuredClone(input);
  return withProjectAuthorityMutation(frozen.projectRoot, (held) => saveProjectReadProgressUnlocked({
    ...frozen, projectRoot: held.projectRoot,
  }, held), { permit });
}

async function saveProjectReadProgressUnlocked(input: Parameters<typeof saveProjectReadProgress>[0],
  permit: ProjectAuthorityMutationPermit): Promise<false | ReadAuthoringBindings> {
  const frozen = input;
  const current = await readProjectReadAuthoring(input.projectRoot);
  if (!current) {
    if (input.expected || input.verifiedDecision) fail("POLICY_AUTHORING_STORE_CHANGED", "The governed Read review repository is unavailable.");
    return false;
  }
  assertReadAuthoringBindings(frozen.expected, current.bindings);
  const previous = current.selected;
  if (!previous || previous.progress.boundary_id !== frozen.progress.boundary_id) {
    fail("POLICY_AUTHORING_SELECTION_CHANGED", "This edit does not belong to the selected saved boundary.");
  }
  const authoring = structuredClone(current.authoring);
  authoring.entries = authoring.entries.map((entry) => {
    if (entry.progress.boundary_id !== previous.progress.boundary_id) return entry;
    const { stage: _stage, ...retained } = entry;
    return { ...retained, ...frozen.replacement, progress: frozen.progress,
      ...(frozen.progress.candidate.pack.resources.length === 0 ? { stage: "metadata_only" as const } : {}) };
  });
  return saveProjectReadAuthoring({ projectRoot: input.projectRoot, expected: current.bindings,
    authoring, actor: frozen.actor ?? "local_operator", operation: "edit_prepared_read", verifiedDecision: frozen.verifiedDecision }, permit);
}

function authoringState(binding: BoundProjectPolicyStore, state: OperatorAuthorityState): ProjectReadAuthoring {
  const entry = state.active.find(({ policy }) => policy.type === "read_authoring");
  if (!entry || entry.policy.type !== "read_authoring") {
    fail("POLICY_READ_AUTHORING_MISSING", "The governed repository has no saved Read authoring record. Restore or migrate the exact review; file exports cannot replace it.");
  }
  const authoring = structuredClone(entry.policy);
  return { bindings: { repository_id: binding.repository_id, deployment_id: binding.deployment_id,
    project_id: binding.project_id, epoch: state.epoch, revision_id: entry.revision.revision_id },
    authoring, selected: authoring.entries.find((item) => item.progress.boundary_id === authoring.selected_boundary_id) };
}

function fail(code: string, message: string): never {
  throw Object.assign(new Error(message + " No active authority or source data changed."), { code });
}
