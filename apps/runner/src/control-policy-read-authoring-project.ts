import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { openBoundProjectControlPolicies, type BoundProjectPolicyStore } from "./control-policy-store.js";
import { OperatorAuthorityRepository, type OperatorAuthorityState } from "./control-policy-operator-repository.js";
import type { StoredReadAuthoring, PreparedReadEntry } from "./control-policy-read-authoring.js";
import type { BoundaryReviewProgress } from "./boundary-review-domain.js";

export type ReadAuthoringBindings = {
  repository_id: string;
  deployment_id: string;
  project_id: string;
  epoch: number;
  revision_id: string;
};

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

export function assertReadAuthoringBindings(expected: ReadAuthoringBindings | undefined, current: ReadAuthoringBindings): void {
  if (!expected || canonicalJsonDigest(expected) !== canonicalJsonDigest(current)) {
    fail("POLICY_AUTHORING_REVIEW_CHANGED", "The saved Read review changed. Reopen the current draft before applying this edit.");
  }
}

/** A complete replacement is one transaction: disabled candidates, all saved
 * review decisions and the selected editing identity. Active grants are separate. */
export async function saveProjectReadAuthoring(input: {
  projectRoot: string; expected: ReadAuthoringBindings;
  authoring: StoredReadAuthoring; actor: string; operation: string;
}): Promise<void> {
  const frozen = structuredClone(input);
  const binding = await openBoundProjectControlPolicies(input.projectRoot);
  if (!binding) fail("POLICY_AUTHORING_STORE_CHANGED", "The governed Read review repository is unavailable.");
  try {
    const repository = new OperatorAuthorityRepository(binding);
    const current = authoringState(binding, await repository.currentReadState());
    assertReadAuthoringBindings(frozen.expected, current.bindings);
    await repository.commitReadAuthoring({ expected_epoch: frozen.expected.epoch,
      expected_revision_id: frozen.expected.revision_id, authoring: frozen.authoring,
      actor: frozen.actor, operation: frozen.operation });
  } finally { await binding.close(); }
}

export async function saveProjectReadProgress(input: {
  projectRoot: string; expected: ReadAuthoringBindings | undefined;
  progress: BoundaryReviewProgress;
  replacement?: Pick<PreparedReadEntry, "draft" | "draft_lock" | "candidate_lock" | "catalog">;
}): Promise<boolean> {
  const frozen = structuredClone(input);
  const current = await readProjectReadAuthoring(input.projectRoot);
  if (!current) {
    if (input.expected) fail("POLICY_AUTHORING_STORE_CHANGED", "The governed Read review repository is unavailable.");
    return false;
  }
  assertReadAuthoringBindings(frozen.expected, current.bindings);
  const previous = current.selected;
  if (!previous || previous.progress.boundary_id !== frozen.progress.boundary_id) {
    fail("POLICY_AUTHORING_SELECTION_CHANGED", "This edit does not belong to the selected saved boundary.");
  }
  const authoring = structuredClone(current.authoring);
  authoring.entries = authoring.entries.map((entry) => entry.progress.boundary_id === previous.progress.boundary_id
    ? { ...entry, ...frozen.replacement, progress: frozen.progress } : entry);
  await saveProjectReadAuthoring({ projectRoot: input.projectRoot, expected: current.bindings,
    authoring, actor: "local_operator", operation: "edit_prepared_read" });
  return true;
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
