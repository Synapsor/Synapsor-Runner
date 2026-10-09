import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { explorationBoundaryCandidateDigest, parseBoundaryReviewDecisionRef, validateBoundaryReviewSubmission,
  type BoundaryReviewSubmission, type ResolvedBoundaryReviewOrigin } from "./auto-boundary.js";
import { resolveReadReviewOriginHeld } from "./read-review-origin.js";
import { openBoundProjectControlPolicies, type BoundProjectPolicyStore } from "./control-policy-store.js";
import { OperatorAuthorityRepository, type OperatorAuthorityState } from "./control-policy-operator-repository.js";
import { parseStoredReadReviewProgress, type StoredReadAuthoring, type PreparedReadEntry } from "./control-policy-read-authoring.js";
import { normalizeStoredBoundaryReviewProgress, type BoundaryReviewProgress } from "./boundary-review-domain.js";
import { OPERATOR_READ_AUTHORING_KEY, assertReadAuthoringBindings, type ReadAuthoringBindings } from "./control-policy-record.js";
import type { GovernedReadEditDecision } from "./control-policy-read-edit.js";
import { withProjectAuthorityMutation, withHeldProjectAuthorityAccess, type ProjectAuthorityMutationPermit } from "./project-authority-mutation.js";
export { assertReadAuthoringBindings, type ReadAuthoringBindings } from "./control-policy-record.js";

export type ProjectReadAuthoring = {
  bindings: ReadAuthoringBindings;
  authoring: StoredReadAuthoring;
  selected: PreparedReadEntry | undefined;
  /** Resolved immutable original candidates, not new acknowledgments. */
  resolvedOrigins: ResolvedBoundaryReviewOrigin[];
};

/** No file fallback or normalization once the project is governed. The token
 * belongs to this original read and must travel with the operator's preview. */
export async function readProjectReadAuthoring(projectRoot: string, env?: NodeJS.ProcessEnv): Promise<ProjectReadAuthoring | undefined> {
  return withProjectAuthorityMutation(projectRoot, held => readProjectReadAuthoringUnlocked(held.projectRoot, held, env));
}
export async function readProjectReadAuthoringHeld(projectRoot: string, permit: ProjectAuthorityMutationPermit,
  env?: NodeJS.ProcessEnv): Promise<ProjectReadAuthoring | undefined> {
  return withHeldProjectAuthorityAccess(projectRoot, permit, held => readProjectReadAuthoringUnlocked(held.projectRoot, held, env));
}
async function readProjectReadAuthoringUnlocked(projectRoot: string, permit: ProjectAuthorityMutationPermit,
  env?: NodeJS.ProcessEnv): Promise<ProjectReadAuthoring | undefined> {
  const binding = await openBoundProjectControlPolicies(projectRoot, env);
  if (!binding) return undefined;
  try {
    return await resolveAuthoringState(projectRoot, authoringState(binding, await new OperatorAuthorityRepository(binding).currentReadState()), permit);
  } finally { await binding.close(); }
}

/** A complete replacement is one transaction: disabled candidates, all saved
 * review decisions and the selected editing identity. Active grants are separate. */
export async function saveProjectReadAuthoring(input: {
  projectRoot: string; expected: ReadAuthoringBindings;
  authoring: StoredReadAuthoring; actor: string; operation: string;
  verifiedDecision?: GovernedReadEditDecision;
  reviewSubmissions?: Array<{ boundary_id: string; submission: BoundaryReviewSubmission }>;
}, permit?: ProjectAuthorityMutationPermit): Promise<ReadAuthoringBindings> {
  const frozen = structuredClone(input);
  return withProjectAuthorityMutation(frozen.projectRoot, (held) => saveProjectReadAuthoringUnlocked({
    ...frozen, projectRoot: held.projectRoot,
  }, held), { permit });
}

async function saveProjectReadAuthoringUnlocked(input: Parameters<typeof saveProjectReadAuthoring>[0],
  permit: ProjectAuthorityMutationPermit): Promise<ReadAuthoringBindings> {
  const frozen = input;
  const binding = await openBoundProjectControlPolicies(input.projectRoot);
  if (!binding) fail("POLICY_AUTHORING_STORE_CHANGED", "The governed Read review repository is unavailable.");
  try {
    const repository = new OperatorAuthorityRepository(binding);
    const current = authoringState(binding, await repository.currentReadState());
    assertReadAuthoringBindings(frozen.expected, current.bindings);
    const authoring = await prepareConfirmedAuthoring(input.projectRoot, frozen.authoring, current, frozen.reviewSubmissions ?? [], permit);
    const committed = await repository.commitReadAuthoring({ expected_epoch: frozen.expected.epoch,
      expected_revision_id: frozen.expected.revision_id, authoring,
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
  submission?: BoundaryReviewSubmission;
}, permit?: ProjectAuthorityMutationPermit): Promise<false | ReadAuthoringBindings> {
  const frozen = structuredClone(input);
  return withProjectAuthorityMutation(frozen.projectRoot, (held) => saveProjectReadProgressUnlocked({
    ...frozen, projectRoot: held.projectRoot,
  }, held), { permit });
}

async function saveProjectReadProgressUnlocked(input: Parameters<typeof saveProjectReadProgress>[0],
  permit: ProjectAuthorityMutationPermit): Promise<false | ReadAuthoringBindings> {
  const frozen = input;
  const current = await readProjectReadAuthoringHeld(input.projectRoot, permit);
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
    authoring, actor: frozen.actor ?? "local_operator", operation: "edit_prepared_read", verifiedDecision: frozen.verifiedDecision,
    ...(frozen.submission ? { reviewSubmissions: [{ boundary_id: frozen.progress.boundary_id, submission: frozen.submission }] } : {}) }, permit);
}

function authoringState(binding: BoundProjectPolicyStore, state: OperatorAuthorityState): ProjectReadAuthoring {
  const entry = state.active.find(({ policy }) => policy.type === "read_authoring");
  if (!entry || entry.policy.type !== "read_authoring") {
    fail("POLICY_READ_AUTHORING_MISSING", "The governed repository has no saved Read authoring record. Restore or migrate the exact review; file exports cannot replace it.");
  }
  const authoring = structuredClone(entry.policy);
  return { bindings: { repository_id: binding.repository_id, deployment_id: binding.deployment_id,
    project_id: binding.project_id, epoch: state.epoch, revision_id: entry.revision.revision_id },
    authoring, resolvedOrigins: [], selected: authoring.entries.find((item) => item.progress.boundary_id === authoring.selected_boundary_id) };
}

async function resolveProgressOrigins(projectRoot: string, progress: BoundaryReviewProgress,
  permit: ProjectAuthorityMutationPermit): Promise<ResolvedBoundaryReviewOrigin[]> {
  const unique = new Map(progress.confirmations.flatMap(item => item.origin
    ? [[canonicalJsonDigest(item.origin), item.origin] as const] : []));
  const result: ResolvedBoundaryReviewOrigin[] = [];
  for (const reference of unique.values()) result.push(await resolveReadReviewOriginHeld(projectRoot, reference, permit));
  return result;
}

async function resolveAuthoringState(projectRoot: string, state: ProjectReadAuthoring,
  permit: ProjectAuthorityMutationPermit): Promise<ProjectReadAuthoring> {
  const authoring = structuredClone(state.authoring);
  const origins = new Map<string, ResolvedBoundaryReviewOrigin>();
  for (const entry of authoring.entries) {
    const progress = parseStoredReadReviewProgress(entry.progress);
    const resolved = await resolveProgressOrigins(projectRoot, progress, permit);
    for (const origin of resolved) origins.set(canonicalJsonDigest(origin.reference), origin);
    entry.progress = normalizeStoredBoundaryReviewProgress(progress as unknown as Record<string, unknown>, progress.candidate, resolved);
  }
  return { ...state, authoring, resolvedOrigins: [...origins.values()],
    selected: authoring.entries.find(item => item.progress.boundary_id === authoring.selected_boundary_id) };
}

/** Only an explicit trusted submission can introduce an acknowledgment. A diff
 * in caller-supplied progress is not consent. Origins point backward to the exact
 * pre-confirmation native candidate, avoiding a self-referential revision hash. */
async function prepareConfirmedAuthoring(projectRoot: string, proposed: StoredReadAuthoring,
  current: ProjectReadAuthoring, submissions: Array<{ boundary_id: string; submission: BoundaryReviewSubmission }>,
  permit: ProjectAuthorityMutationPermit): Promise<StoredReadAuthoring> {
  const authoring = structuredClone(proposed);
  const byBoundary = new Map(submissions.map(item => [item.boundary_id, item.submission]));
  if (byBoundary.size !== submissions.length || submissions.some(item => !authoring.entries.some(entry => entry.progress.boundary_id === item.boundary_id))) {
    fail("READ_REVIEW_SUBMISSION_INVALID", "Review submissions must name one exact saved boundary.");
  }
  for (const entry of authoring.entries) {
    const progress = parseStoredReadReviewProgress(entry.progress);
    const previous = current.authoring.entries.find(item => item.progress.boundary_id === progress.boundary_id);
    const submission = byBoundary.get(progress.boundary_id);
    const submitted = submission ? validateBoundaryReviewSubmission(progress.candidate, submission, "partial") : [];
    const refs = new Map(submitted.map(item => [item.id, item]));
    if (submission && (!previous || previous.progress.candidate_digest !== progress.candidate_digest
      || explorationBoundaryCandidateDigest(previous.progress.candidate) !== progress.candidate_digest)) {
      fail("READ_REVIEW_CANDIDATE_NOT_SAVED", "Save the exact disabled candidate before reviewing its settings.");
    }
    const old = new Map(previous?.progress.confirmations.map(item => [item.id, item]) ?? []);
    for (const confirmation of progress.confirmations) {
      const prior = old.get(confirmation.id);
      const unchanged = prior && canonicalJsonDigest(prior) === canonicalJsonDigest(confirmation);
      if (unchanged && (prior.origin || !refs.has(confirmation.id))) continue;
      const { decision: _decision, status: _status, actor: _actor, reason: _reason,
        confirmed_at: _time, origin, ...rawRef } = confirmation;
      const reference = parseBoundaryReviewDecisionRef(rawRef);
      if (!refs.has(confirmation.id) || canonicalJsonDigest(refs.get(confirmation.id)) !== canonicalJsonDigest(reference)) {
        fail("READ_REVIEW_EXPLICIT_SUBMISSION_REQUIRED", "A new or changed review confirmation requires an exact explicit typed submission.");
      }
      if (origin) fail("READ_REVIEW_ORIGIN_NOT_HOST_OWNED", "The saved origin of an acknowledgment cannot be supplied or replaced by a caller.");
      if (!current.bindings.revision_id || !previous) fail("READ_REVIEW_CANDIDATE_NOT_SAVED", "Save the disabled candidate before confirming it.");
      confirmation.origin = { revision_id: current.bindings.revision_id,
        boundary_id: progress.boundary_id, candidate_digest: previous.progress.candidate_digest };
    }
    if (submitted.some(reference => !progress.confirmations.some(item => item.id === reference.id))) {
      fail("READ_REVIEW_SUBMISSION_INVALID", "The explicit submission has no corresponding exact recorded decision.");
    }
    const resolved = await resolveProgressOrigins(projectRoot, progress, permit);
    entry.progress = normalizeStoredBoundaryReviewProgress(progress as unknown as Record<string, unknown>, progress.candidate, resolved);
  }
  return authoring;
}

function fail(code: string, message: string): never {
  throw Object.assign(new Error(message + " No active authority or source data changed."), { code });
}
