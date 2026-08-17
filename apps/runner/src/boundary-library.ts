import fs from "node:fs/promises";
import crypto from "node:crypto";
import path from "node:path";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import {
  AUTO_BOUNDARY_VERSION,
  emptyReviewOverrides,
  explorationBoundaryCandidateDigest,
  generationLockSharedFactsDigest,
  loadAutoBoundaryPolicyBaseline,
  loadGenerationLockSnapshot,
  loadActivatedExplorationBoundaries,
  ownerReviewableExplorationBudgetCeiling,
  reviewExplorationBoundaryCandidate,
  type ActivatedExplorationBoundary,
  type ExplorationBoundaryDraft,
  type GenerationLock,
} from "./auto-boundary.js";
import {
  boundaryReviewDecisions,
  createBoundaryReviewProgress,
  legacyBoundaryReviewId,
  legacyPolicyMigration,
  normalizeStoredBoundaryReviewProgress,
  saveBoundaryReviewProgress,
  type BoundaryReviewProgress,
} from "./boundary-review-domain.js";
import { resolveBoundaryRevisionState } from "./boundary-revision-state.js";

const BOUNDARY_LIBRARY_VERSION = "synapsor.boundary-library.v1" as const;

type BoundaryLibraryFile = {
  schema_version: typeof BOUNDARY_LIBRARY_VERSION;
  selected_name: string;
  boundaries: Record<string, BoundaryReviewProgress>;
  updated_at: string;
};

export type BoundaryLibraryReconciliationState = {
  selected_name: string;
  boundaries: Record<string, BoundaryReviewProgress>;
  updated_at: string;
};

export type BoundaryLibraryEntry = {
  name: string;
  selected: boolean;
  active: boolean;
  matches_active_digest: boolean;
  table_count: number;
  candidate_digest: `sha256:${string}`;
  outstanding_decisions: number;
  policy_review_required: boolean;
};

export type BoundaryLibrarySnapshot = {
  selected_name: string;
  entries: BoundaryLibraryEntry[];
};

type BoundaryLibraryContext = {
  projectRoot: string;
  draft: ExplorationBoundaryDraft;
  currentCandidate: ExplorationBoundaryDraft;
  currentProgress?: BoundaryReviewProgress;
};

type BoundaryResource = ExplorationBoundaryDraft["pack"]["resources"][number];

export async function resolveSavedBoundaryReviewAuthority(input: {
  projectRoot: string;
  draft: ExplorationBoundaryDraft;
  candidate: ExplorationBoundaryDraft;
  progress?: BoundaryReviewProgress;
}): Promise<{
  reviewDraft: ExplorationBoundaryDraft;
  generationLock: GenerationLock;
}> {
  const projectRoot = path.resolve(input.projectRoot);
  const [generationLock, currentLock] = await Promise.all([
    loadGenerationLockSnapshot(projectRoot, input.candidate.generation_lock_fingerprint),
    loadGenerationLockSnapshot(projectRoot, input.draft.generation_lock_fingerprint),
  ]);
  if (generationLockSharedFactsDigest(generationLock)
    !== generationLockSharedFactsDigest(currentLock)) {
    throw new Error(
      `Saved boundary ${input.candidate.pack.name} is bound to different schema, role, or trusted-context facts. Rescan it before review or activation.`,
    );
  }

  if (input.candidate.generation_lock_fingerprint
    === input.draft.generation_lock_fingerprint) {
    return { reviewDraft: input.draft, generationLock };
  }

  const baseline = await loadAutoBoundaryPolicyBaseline(projectRoot).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  });
  if (baseline?.boundary.generation_lock_fingerprint
    === input.candidate.generation_lock_fingerprint) {
    return { reviewDraft: baseline.boundary, generationLock };
  }

  const saved = input.progress;
  if (saved
    && saved.candidate.pack.name === input.candidate.pack.name
    && saved.candidate.generation_lock_fingerprint
      === input.candidate.generation_lock_fingerprint
    && saved.candidate_digest === explorationBoundaryCandidateDigest(saved.candidate)) {
    return { reviewDraft: saved.candidate, generationLock };
  }

  throw new Error(
    `Saved boundary ${input.candidate.pack.name} has no matching generated review authority. Rescan it before review or activation.`,
  );
}

export async function synchronizeBoundaryLibrary(
  input: BoundaryLibraryContext,
): Promise<BoundaryLibrarySnapshot> {
  const library = await readOrCreateLibrary(input);
  const active = await readActiveBoundaryIdentities(input.projectRoot);
  let selectedChanged = false;
  for (const [name, progress] of Object.entries(library.boundaries)) {
    const aligned = alignDisabledBoundaryWithActiveSet(
      input.draft,
      progress,
      active,
    );
    library.boundaries[name] = aligned;
    if (name === library.selected_name && aligned !== progress) selectedChanged = true;
  }
  const selected = library.boundaries[library.selected_name];
  if (selected && selectedChanged) {
    await saveBoundaryReviewProgress(input.projectRoot, selected);
  }
  await writeBoundaryLibrary(input.projectRoot, library);
  return snapshot(input.projectRoot, library, active);
}

export async function loadBoundaryLibraryForReconciliation(
  input: BoundaryLibraryContext,
): Promise<BoundaryLibraryReconciliationState> {
  const library = await readOrCreateLibrary(input);
  return {
    selected_name: library.selected_name,
    boundaries: structuredClone(library.boundaries),
    updated_at: library.updated_at,
  };
}

export async function saveBoundaryLibraryAfterReconciliation(input: {
  projectRoot: string;
  state: BoundaryLibraryReconciliationState;
}): Promise<void> {
  await writeBoundaryLibrary(
    input.projectRoot,
    boundaryLibraryFileAfterReconciliation(input.state),
  );
}

export function serializeBoundaryLibraryAfterReconciliation(
  state: BoundaryLibraryReconciliationState,
): string {
  return `${JSON.stringify(boundaryLibraryFileAfterReconciliation(state), null, 2)}\n`;
}

function boundaryLibraryFileAfterReconciliation(
  state: BoundaryLibraryReconciliationState,
): BoundaryLibraryFile {
  if (!state.boundaries[state.selected_name]) {
    throw new Error("A reconciled boundary library must retain its selected boundary.");
  }
  const boundaryIds = new Set<string>();
  for (const [name, progress] of Object.entries(state.boundaries)) {
    assertBoundaryName(name);
    if (progress.candidate.pack.name !== name) {
      throw new Error(`Reconciled boundary ${name} has a mismatched internal name.`);
    }
    if (boundaryIds.has(progress.boundary_id)) {
      throw new Error(`Reconciled boundary identity ${progress.boundary_id} is duplicated.`);
    }
    boundaryIds.add(progress.boundary_id);
  }
  return {
    schema_version: BOUNDARY_LIBRARY_VERSION,
    selected_name: state.selected_name,
    boundaries: structuredClone(state.boundaries),
    updated_at: state.updated_at,
  };
}

export function rebaseSavedBoundaryForRescan(input: {
  generatedDraft: ExplorationBoundaryDraft;
  previousCandidate: ExplorationBoundaryDraft;
  boundaryName: string;
}): ExplorationBoundaryDraft {
  return rebaseDisabledBoundary(
    input.generatedDraft,
    input.previousCandidate,
    input.boundaryName,
  );
}

export async function createSavedBoundary(input: BoundaryLibraryContext & {
  name: string;
  resourceId: string;
  actor: string;
}): Promise<BoundaryReviewProgress> {
  assertBoundaryName(input.name);
  const library = await readOrCreateLibrary(input);
  if (library.boundaries[input.name]) {
    throw new Error(`A saved boundary named ${input.name} already exists.`);
  }
  const policyBaseline = await policyNeutralBoundaryForCurrentFacts(
    input.projectRoot,
    input.draft,
  );
  const selectedResource = policyBaseline.pack.resources.find((resource) =>
    resource.id === input.resourceId);
  if (!selectedResource) {
    throw new Error(
      `Starting table ${input.resourceId} is not an available generated boundary resource.`,
    );
  }
  const candidate = structuredClone(policyBaseline);
  const active = await readActiveBoundaryIdentities(input.projectRoot);
  const compatibleActive = findCompatibleActiveBoundary(input.draft, active);
  if (active.length && !compatibleActive) {
    throw new Error(
      "A new boundary cannot join the current Ask session because its generated source, trusted scope, or database capability tier differs from the active reviewed boundaries. Rescan stale boundaries before adding another one.",
    );
  }
  if (compatibleActive) {
    candidate.deployment_profile = compatibleActive.deployment_profile;
  }
  candidate.pack.name = input.name;
  candidate.pack.resources = [{
    ...structuredClone(selectedResource),
    relationships: [],
  }];
  const reviewed = reviewExplorationBoundaryCandidate(policyBaseline, candidate).candidate;
  const progress = createBoundaryReviewProgress({
    draft: input.draft,
    candidate: reviewed,
    confirmedDecisions: [],
    actor: input.actor,
    reviewOverrides: emptyReviewOverrides(),
    reason: `Created disabled boundary ${input.name} with operator-selected starting table ${input.resourceId}.`,
    revision: 1,
  });
  library.boundaries[input.name] = progress;
  library.selected_name = input.name;
  library.updated_at = new Date().toISOString();
  await writeBoundaryLibrary(input.projectRoot, library);
  await saveBoundaryReviewProgress(input.projectRoot, progress);
  return progress;
}

function alignDisabledBoundaryWithActiveSet(
  draft: ExplorationBoundaryDraft,
  progress: BoundaryReviewProgress,
  active: Awaited<ReturnType<typeof readActiveBoundaryIdentities>>,
): BoundaryReviewProgress {
  const compatibleActive = findCompatibleActiveBoundary(draft, active);
  if (!compatibleActive
    || progress.candidate.deployment_profile === compatibleActive.deployment_profile) {
    return progress;
  }
  const candidate = structuredClone(progress.candidate);
  candidate.deployment_profile = compatibleActive.deployment_profile;
  const reviewed = reviewExplorationBoundaryCandidate(draft, candidate).candidate;
  const previousById = new Map(
    progress.confirmations.map((confirmation) => [confirmation.id, confirmation]),
  );
  const retainedDecisions = boundaryReviewDecisions(reviewed)
    .filter((decision) => previousById.get(decision.id)?.input_digest === decision.input_digest)
    .map((decision) => decision.decision);
  return createBoundaryReviewProgress({
    draft,
    candidate: reviewed,
    confirmedDecisions: retainedDecisions,
    previous: progress,
    actor: "local-boundary-library",
    reason: "Aligned this disabled boundary with the active local Ask deployment profile.",
    revision: progress.revision + 1,
  });
}

function findCompatibleActiveBoundary(
  draft: ExplorationBoundaryDraft,
  active: Awaited<ReturnType<typeof readActiveBoundaryIdentities>>,
): ActivatedExplorationBoundary | undefined {
  const trustedContextDigest = canonicalJsonDigest(draft.trusted_context);
  const databaseServerAuthorityDigest = canonicalJsonDigest(
    draft.database_server_authority ?? null,
  );
  return active.find(({ boundary }) =>
    boundary.source === draft.source
    && canonicalJsonDigest(boundary.trusted_context) === trustedContextDigest
    && boundary.database_server_tier === draft.database_server_tier
    && canonicalJsonDigest(boundary.database_server_authority ?? null)
      === databaseServerAuthorityDigest)?.boundary;
}

export async function switchSavedBoundary(input: BoundaryLibraryContext & {
  name: string;
}): Promise<BoundaryReviewProgress> {
  const library = await readOrCreateLibrary(input);
  const stored = library.boundaries[input.name];
  if (!stored) throw new Error(`Saved boundary ${input.name} was not found.`);
  const progress = await normalizeStoredProgress(
    input.projectRoot,
    input.draft,
    stored,
    input.name,
  );
  library.boundaries[input.name] = progress;
  library.selected_name = input.name;
  library.updated_at = new Date().toISOString();
  await writeBoundaryLibrary(input.projectRoot, library);
  await saveBoundaryReviewProgress(input.projectRoot, progress);
  return progress;
}

export async function renameSavedBoundary(input: BoundaryLibraryContext & {
  name: string;
  newName: string;
  actor: string;
  reason: string;
}): Promise<BoundaryReviewProgress> {
  assertBoundaryName(input.name);
  assertBoundaryName(input.newName);
  const library = await readOrCreateLibrary(input);
  const stored = library.boundaries[input.name];
  if (!stored) throw new Error(`Saved boundary ${input.name} was not found.`);
  if (input.name !== input.newName && library.boundaries[input.newName]) {
    throw new Error(`A saved boundary named ${input.newName} already exists.`);
  }
  if (input.name === input.newName) return stored;
  const candidate = structuredClone(stored.candidate);
  candidate.pack.name = input.newName;
  const reviewed = reviewExplorationBoundaryCandidate(input.draft, candidate).candidate;
  const progress = createBoundaryReviewProgress({
    draft: input.draft,
    candidate: reviewed,
    confirmedDecisions: stored.confirmed_decisions,
    previous: stored,
    actor: input.actor,
    reason: input.reason,
    revision: stored.revision + 1,
  });
  const activeNames = new Set(
    (await readActiveBoundaryIdentities(input.projectRoot)).map((active) => active.name),
  );
  library.boundaries[input.newName] = progress;
  if (!activeNames.has(input.name)) delete library.boundaries[input.name];
  library.selected_name = input.newName;
  library.updated_at = new Date().toISOString();
  await writeBoundaryLibrary(input.projectRoot, library);
  await saveBoundaryReviewProgress(input.projectRoot, progress);
  return progress;
}

export async function deleteSavedBoundary(input: BoundaryLibraryContext & {
  name: string;
}): Promise<{ selected_name: string; progress: BoundaryReviewProgress }> {
  const library = await readOrCreateLibrary(input);
  if (!library.boundaries[input.name]) {
    throw new Error(`Saved boundary ${input.name} was not found.`);
  }
  if (Object.keys(library.boundaries).length === 1) {
    throw new Error(
      `Boundary ${input.name} is the only saved boundary. `
      + "Create another boundary first, or explicitly discard its curated review with "
      + `boundary delete ${input.name} --discard-curated-review --yes.`,
    );
  }
  const activeNames = new Set(
    (await readActiveBoundaryIdentities(input.projectRoot)).map((active) => active.name),
  );
  if (activeNames.has(input.name)) {
    throw new Error(
      `Boundary ${input.name} is active. Deactivate it before deleting it.`,
    );
  }
  delete library.boundaries[input.name];
  if (library.selected_name === input.name) {
    library.selected_name = Object.keys(library.boundaries).sort()[0]!;
  }
  const progress = await normalizeStoredProgress(
    input.projectRoot,
    input.draft,
    library.boundaries[library.selected_name]!,
    library.selected_name,
  );
  library.boundaries[library.selected_name] = progress;
  library.updated_at = new Date().toISOString();
  await writeBoundaryLibrary(input.projectRoot, library);
  await saveBoundaryReviewProgress(input.projectRoot, progress);
  return { selected_name: library.selected_name, progress };
}

export async function discardOnlySavedBoundaryReview(input: BoundaryLibraryContext & {
  name: string;
  boundaryRoot: string;
}): Promise<{ removed: string[] }> {
  const projectRoot = path.resolve(input.projectRoot);
  const library = await readOrCreateLibrary(input);
  if (!library.boundaries[input.name]) {
    throw new Error(`Saved boundary ${input.name} was not found.`);
  }
  if (Object.keys(library.boundaries).length !== 1) {
    throw new Error(
      "--discard-curated-review is only for recovering a project with one disabled saved boundary. "
      + "Use ordinary boundary delete after selecting a different saved boundary.",
    );
  }
  const activeNames = new Set(
    (await readActiveBoundaryIdentities(projectRoot)).map((active) => active.name),
  );
  if (activeNames.has(input.name)) {
    throw new Error(`Boundary ${input.name} is active. Deactivate it before discarding its curated review.`);
  }

  const boundaryRoot = path.resolve(input.boundaryRoot);
  const relativeBoundaryRoot = path.relative(projectRoot, boundaryRoot);
  if (!relativeBoundaryRoot
    || relativeBoundaryRoot.startsWith("..")
    || path.isAbsolute(relativeBoundaryRoot)) {
    throw new Error("Managed boundary root escapes or replaces the selected project.");
  }
  const markerPath = path.join(boundaryRoot, ".synapsor-auto-boundary.json");
  const marker = JSON.parse(await fs.readFile(markerPath, "utf8")) as { schema_version?: unknown };
  if (marker.schema_version !== AUTO_BOUNDARY_VERSION) {
    throw new Error(
      `Refusing to remove ${relativeBoundaryRoot} because it is not marked as Runner-managed Auto Boundary output.`,
    );
  }

  const targets = [
    boundaryRoot,
    path.join(projectRoot, ".synapsor/boundary-library.json"),
    path.join(projectRoot, ".synapsor/boundary-review-progress.json"),
    path.join(projectRoot, ".synapsor/generation-lock.json"),
    path.join(projectRoot, ".synapsor/auto-boundary-policy-baseline.json"),
    path.join(projectRoot, ".synapsor/review-report.json"),
    path.join(projectRoot, ".synapsor/review-overrides.json"),
    path.join(projectRoot, ".synapsor/boundary-rescan-report.json"),
    path.join(projectRoot, ".synapsor/exploration-locks"),
    path.join(projectRoot, ".synapsor/guided-onboarding.json"),
  ];
  const transactionRoot = await fs.mkdtemp(
    path.join(projectRoot, ".synapsor/.discard-boundary-review-"),
  );
  const moved: Array<{ target: string; staged: string }> = [];
  try {
    for (const [index, target] of targets.entries()) {
      try {
        await fs.lstat(target);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      const staged = path.join(transactionRoot, `${String(index).padStart(2, "0")}-${path.basename(target)}`);
      await fs.rename(target, staged);
      moved.push({ target, staged });
    }
  } catch (error) {
    for (const entry of moved.reverse()) {
      await fs.mkdir(path.dirname(entry.target), { recursive: true, mode: 0o700 });
      await fs.rename(entry.staged, entry.target).catch(() => undefined);
    }
    await fs.rm(transactionRoot, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
  await fs.rm(transactionRoot, { recursive: true, force: true });
  return {
    removed: moved.map(({ target }) => path.relative(projectRoot, target)),
  };
}

async function readOrCreateLibrary(input: BoundaryLibraryContext): Promise<BoundaryLibraryFile> {
  const current = input.currentProgress
    ? input.currentProgress
    : createBoundaryReviewProgress({
      draft: input.draft,
      candidate: input.currentCandidate,
      confirmedDecisions: [],
      boundaryId: legacyBoundaryReviewId(input.currentCandidate),
      actor: "local-boundary-library",
      reason: "Registered the existing disabled boundary without changing authority.",
      revision: 1,
    });
  const filePath = boundaryLibraryPath(input.projectRoot);
  let library: BoundaryLibraryFile;
  try {
    const raw = JSON.parse(await fs.readFile(filePath, "utf8")) as unknown;
    library = await normalizeLibrary(input.projectRoot, raw, input.draft, current);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    library = {
      schema_version: BOUNDARY_LIBRARY_VERSION,
      selected_name: current.candidate.pack.name,
      boundaries: {},
      updated_at: new Date().toISOString(),
    };
  }

  const active = await readActiveBoundaryIdentities(input.projectRoot);
  const activeNames = new Set(active.map((identity) => identity.name));
  for (const identity of active) {
    if (identity.name === current.candidate.pack.name || library.boundaries[identity.name]) continue;
    const activeProgress = await readActiveBoundaryProgress(input.draft, identity.boundary);
    library.boundaries[identity.name] = activeProgress;
  }
  const previousSelected = library.selected_name;
  if (previousSelected !== current.candidate.pack.name
    && !library.boundaries[current.candidate.pack.name]
    && !activeNames.has(previousSelected)) {
    delete library.boundaries[previousSelected];
  }
  library.selected_name = current.candidate.pack.name;
  library.boundaries[library.selected_name] = current;
  library.updated_at = new Date().toISOString();
  return library;
}

async function normalizeLibrary(
  projectRoot: string,
  raw: unknown,
  draft: ExplorationBoundaryDraft,
  current: BoundaryReviewProgress,
): Promise<BoundaryLibraryFile> {
  if (!isRecord(raw)
    || raw.schema_version !== BOUNDARY_LIBRARY_VERSION
    || typeof raw.selected_name !== "string"
    || !isRecord(raw.boundaries)
    || typeof raw.updated_at !== "string") {
    throw new Error("Saved boundary library is invalid; no boundary was selected or activated.");
  }
  assertBoundaryName(raw.selected_name);
  const boundaries: Record<string, BoundaryReviewProgress> = {};
  for (const [name, value] of Object.entries(raw.boundaries)) {
    assertBoundaryName(name);
    boundaries[name] = name === current.candidate.pack.name
      ? current
      : await normalizeStoredProgress(projectRoot, draft, value, name);
  }
  if (!boundaries[raw.selected_name]) {
    throw new Error("Saved boundary library does not contain its selected boundary.");
  }
  return {
    schema_version: BOUNDARY_LIBRARY_VERSION,
    selected_name: raw.selected_name,
    boundaries,
    updated_at: raw.updated_at,
  };
}

async function normalizeStoredProgress(
  projectRoot: string,
  draft: ExplorationBoundaryDraft,
  raw: unknown,
  expectedName: string,
): Promise<BoundaryReviewProgress> {
  if (!isRecord(raw)
    || !isRecord(raw.candidate)
    || !isRecord(raw.candidate.pack)
    || !Array.isArray(raw.candidate.pack.resources)
    || !Array.isArray(raw.confirmed_decisions)
    || raw.confirmed_decisions.some((item) => typeof item !== "string")
    || !Array.isArray(raw.confirmations)
    || !Array.isArray(raw.invalidated_decisions)
    || !Number.isSafeInteger(raw.revision)
    || Number(raw.revision) < 1
    || typeof raw.updated_at !== "string") {
    throw new Error(`Saved boundary ${expectedName} has invalid review state.`);
  }
  const storedCandidate = raw.candidate as unknown as ExplorationBoundaryDraft;
  const policyBaseline = await optionalPolicyNeutralBoundaryForCurrentFacts(
    projectRoot,
    draft,
  );
  const sharedFactsStatus = await boundarySharedFactsStatus(
    projectRoot,
    storedCandidate,
    draft,
  );
  const candidate = sharedFactsStatus === "changed" && policyBaseline
    ? rebaseDisabledBoundary(policyBaseline, storedCandidate, expectedName)
    : sharedFactsStatus === "unchanged"
      && storedCandidate.generation_lock_fingerprint === draft.generation_lock_fingerprint
      ? reviewExplorationBoundaryCandidate(draft, storedCandidate).candidate
      : structuredClone(storedCandidate);
  if (candidate.pack.name !== expectedName) {
    throw new Error(`Saved boundary ${expectedName} has a mismatched internal name.`);
  }
  const previous = normalizeStoredBoundaryReviewProgress(raw, candidate);
  return createBoundaryReviewProgress({
    draft,
    candidate,
    confirmedDecisions: (raw.confirmed_decisions as string[])
      .filter((decision) => candidate.unresolved_decisions.includes(decision)),
    previous,
    actor: "local-boundary-library",
    reason: "Restored an operator-selected saved boundary.",
    revision: Number(raw.revision),
    now: raw.updated_at,
  });
}

async function policyNeutralBoundaryForCurrentFacts(
  projectRoot: string,
  current: ExplorationBoundaryDraft,
): Promise<ExplorationBoundaryDraft> {
  const baseline = await optionalPolicyNeutralBoundaryForCurrentFacts(projectRoot, current);
  if (!baseline) {
    throw new Error(
      "Creating an independent boundary requires a policy-neutral schema baseline. Run Rescan, then create the boundary again.",
    );
  }
  return baseline;
}

async function optionalPolicyNeutralBoundaryForCurrentFacts(
  projectRoot: string,
  current: ExplorationBoundaryDraft,
): Promise<ExplorationBoundaryDraft | undefined> {
  try {
    const baseline = await loadAutoBoundaryPolicyBaseline(projectRoot);
    const currentLock = await loadGenerationLockSnapshot(
      projectRoot,
      current.generation_lock_fingerprint,
    );
    if (generationLockSharedFactsDigest(baseline.lock)
      !== generationLockSharedFactsDigest(currentLock)) {
      throw new Error(
        "The saved policy-neutral schema baseline is stale. Run Rescan before changing saved boundaries.",
      );
    }
    return baseline.boundary;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function boundarySharedFactsStatus(
  projectRoot: string,
  stored: ExplorationBoundaryDraft,
  current: ExplorationBoundaryDraft,
): Promise<"unchanged" | "changed" | "unavailable"> {
  if (stored.generation_lock_fingerprint === current.generation_lock_fingerprint) {
    return "unchanged";
  }
  try {
    const [storedLock, currentLock] = await Promise.all([
      loadGenerationLockSnapshot(projectRoot, stored.generation_lock_fingerprint),
      loadGenerationLockSnapshot(projectRoot, current.generation_lock_fingerprint),
    ]);
    return generationLockSharedFactsDigest(storedLock)
      === generationLockSharedFactsDigest(currentLock)
      ? "unchanged"
      : "changed";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "unavailable";
    throw error;
  }
}

function rebaseDisabledBoundary(
  draft: ExplorationBoundaryDraft,
  stored: ExplorationBoundaryDraft,
  expectedName: string,
): ExplorationBoundaryDraft {
  const candidate = structuredClone(draft);
  candidate.pack.name = expectedName;
  if (stored.deployment_profile === "development"
    || stored.deployment_profile === "staging"
    || stored.deployment_profile === "production") {
    candidate.deployment_profile = stored.deployment_profile;
  }
  candidate.budgets = narrowStoredBudgets(draft, stored);

  const storedResources = new Map(
    stored.pack.resources.map((resource) => [resource.id, resource]),
  );
  candidate.pack.resources = draft.pack.resources
    .filter((resource) => storedResources.has(resource.id))
    .map((resource) => rebaseBoundaryResource(resource, storedResources.get(resource.id)!));
  if (!candidate.pack.resources.length) {
    throw new Error(
      `Saved boundary ${expectedName} no longer contains a table present in the inspected schema. `
      + "Runner preserved its curated review and stopped. If that table was intentionally removed, reset only this disabled review with "
      + `synapsor-runner boundary delete ${expectedName} --discard-curated-review --yes, then draft a current boundary. `
      + "Runner config, ledger, evidence, and source data are preserved by that reset.",
    );
  }

  const included = new Set(candidate.pack.resources.map((resource) => resource.id));
  for (const resource of candidate.pack.resources) {
    const storedResource = storedResources.get(resource.id)!;
    const storedRelationships = new Map(
      storedResource.relationships.map((relationship) => [relationship.id, relationship]),
    );
    resource.relationships = resource.relationships
      .filter((relationship) => storedRelationships.has(relationship.id))
      .filter((relationship) => relationshipTargetResources(relationship).every((id) => included.has(id)))
      .map((relationship) => {
        const previous = storedRelationships.get(relationship.id)!;
        if (relationship.unmatched_rows === "review_required"
          && (previous.unmatched_rows === "exclude" || previous.unmatched_rows === "keep_null")) {
          return { ...relationship, unmatched_rows: previous.unmatched_rows };
        }
        return relationship;
      });
  }
  return reviewExplorationBoundaryCandidate(draft, candidate).candidate;
}

function rebaseBoundaryResource(current: BoundaryResource, stored: BoundaryResource): BoundaryResource {
  const resource = structuredClone(current);
  const currentFields = new Set(Object.keys(current.field_types));
  const currentSelectable = new Set(current.selectable_fields);
  const storedSelectable = new Set(stored.selectable_fields);
  const storedWithheld = new Set(stored.model_withheld_fields ?? []);
  const currentWithheld = new Set(current.model_withheld_fields ?? []);
  const forcedKeptOut = new Set([
    ...current.kept_out_fields,
    ...stored.kept_out_fields.filter((field) => currentFields.has(field)),
    ...Object.keys(current.field_types).filter((field) => !Object.hasOwn(stored.field_types, field)),
    ...[...storedWithheld].filter((field) => !currentWithheld.has(field)),
  ]);
  resource.selectable_fields = stored.selectable_fields
    .filter((field) => currentSelectable.has(field) && !forcedKeptOut.has(field));
  const selectable = new Set(resource.selectable_fields);
  resource.kept_out_fields = [...forcedKeptOut].sort();
  const withheld = current.model_withheld_fields?.filter((field) => selectable.has(field)) ?? [];
  if (withheld.length) resource.model_withheld_fields = withheld;
  else delete resource.model_withheld_fields;
  resource.sortable_fields = intersectStoredList(stored.sortable_fields, current.sortable_fields, selectable);
  resource.groupable_fields = intersectStoredList(stored.groupable_fields, current.groupable_fields, selectable);
  resource.aggregate_measures = intersectStoredList(
    stored.aggregate_measures,
    current.aggregate_measures,
    selectable,
  );
  if (stored.aggregate_measure_functions) {
    resource.aggregate_measure_functions = intersectStoredMap(
      stored.aggregate_measure_functions,
      current.aggregate_measure_functions ?? {},
      new Set(resource.aggregate_measures),
    );
  } else {
    delete resource.aggregate_measure_functions;
  }
  if (stored.presence_measure_fields) {
    resource.presence_measure_fields = intersectStoredList(
      stored.presence_measure_fields,
      current.presence_measure_fields ?? [],
      new Set([...selectable].filter((field) => !(resource.model_withheld_fields ?? []).includes(field))),
    );
  } else {
    delete resource.presence_measure_fields;
  }
  if (stored.derived_measures?.length && current.derived_measures?.length) {
    const currentlyValid = new Map(current.derived_measures.map((definition) => [
      definition.name,
      definition,
    ]));
    resource.derived_measures = stored.derived_measures
      .filter((definition) => JSON.stringify(currentlyValid.get(definition.name)) === JSON.stringify(definition))
      .map((definition) => structuredClone(definition));
    if (!resource.derived_measures.length) delete resource.derived_measures;
  } else {
    delete resource.derived_measures;
  }
  if (stored.numeric_bands?.length && current.numeric_bands?.length) {
    const currentlyValid = new Map(current.numeric_bands.map((definition) => [
      definition.name,
      definition,
    ]));
    resource.numeric_bands = stored.numeric_bands
      .filter((definition) => JSON.stringify(currentlyValid.get(definition.name)) === JSON.stringify(definition))
      .map((definition) => structuredClone(definition));
    if (!resource.numeric_bands.length) delete resource.numeric_bands;
  } else {
    delete resource.numeric_bands;
  }
  if (stored.auto_bands?.length && current.auto_bands?.length) {
    const currentlyValid = new Map(current.auto_bands.map((definition) => [
      definition.field,
      definition,
    ]));
    resource.auto_bands = stored.auto_bands
      .filter((definition) => JSON.stringify(currentlyValid.get(definition.field)) === JSON.stringify(definition))
      .map((definition) => structuredClone(definition));
    if (!resource.auto_bands.length) delete resource.auto_bands;
  } else {
    delete resource.auto_bands;
  }
  resource.count_distinct_fields = intersectStoredList(
    stored.count_distinct_fields,
    current.count_distinct_fields,
    selectable,
  );
  resource.filterable_fields = intersectStoredMap(
    stored.filterable_fields,
    current.filterable_fields,
    selectable,
  );
  resource.field_enums = rebaseStoredFieldEnums({
    stored,
    current,
    selectable,
    retainedFilterableFields: resource.filterable_fields,
    retainedGroupableFields: resource.groupable_fields,
  });
  resource.time_bucket_fields = intersectStoredMap(
    stored.time_bucket_fields,
    current.time_bucket_fields,
    selectable,
  );
  resource.minimum_cohort_size = Math.max(
    current.minimum_cohort_size,
    Number.isSafeInteger(stored.minimum_cohort_size) ? stored.minimum_cohort_size : current.minimum_cohort_size,
  );
  return resource;
}

function intersectStoredList(
  stored: string[],
  current: string[],
  selectable: Set<string>,
): string[] {
  const allowed = new Set(current);
  return stored.filter((field) => allowed.has(field) && selectable.has(field));
}

function intersectStoredMap<T extends string>(
  stored: Record<string, T[]>,
  current: Record<string, T[]>,
  selectable: Set<string>,
): Record<string, T[]> {
  const result: Record<string, T[]> = {};
  for (const [field, storedValues] of Object.entries(stored)) {
    const currentValues = current[field];
    if (!currentValues || !selectable.has(field)) continue;
    const allowed = new Set(currentValues);
    const values = storedValues.filter((value) => allowed.has(value));
    if (values.length) result[field] = values;
  }
  return result;
}

function rebaseStoredFieldEnums(input: {
  stored: BoundaryResource;
  current: BoundaryResource;
  selectable: Set<string>;
  retainedFilterableFields: BoundaryResource["filterable_fields"];
  retainedGroupableFields: string[];
}): BoundaryResource["field_enums"] {
  const result = intersectStoredMap(
    input.stored.field_enums,
    input.current.field_enums,
    input.selectable,
  );
  for (const [field, values] of Object.entries(input.current.field_enums)) {
    if (Object.hasOwn(input.stored.field_enums, field)
      || !input.selectable.has(field)
      || values.length === 0) {
      continue;
    }
    const hadLegacyCategoricalAuthority = Object.hasOwn(input.stored.filterable_fields, field)
      || input.stored.groupable_fields.includes(field);
    const retainsCategoricalAuthority = Object.hasOwn(input.retainedFilterableFields, field)
      || input.retainedGroupableFields.includes(field);
    if (hadLegacyCategoricalAuthority && retainsCategoricalAuthority) {
      result[field] = [...values];
    }
  }
  return result;
}

function narrowStoredBudgets(
  draft: ExplorationBoundaryDraft,
  stored: ExplorationBoundaryDraft,
): ExplorationBoundaryDraft["budgets"] {
  const old = stored.budgets;
  const bounded = <T extends number>(
    key: keyof ExplorationBoundaryDraft["budgets"],
    current: T,
    previous: unknown,
  ): T =>
    (Number.isSafeInteger(previous) && Number(previous) >= 1
      ? Math.min(ownerReviewableExplorationBudgetCeiling(key) ?? current, Number(previous))
      : current) as T;
  const maxGroups = bounded("max_groups", draft.budgets.max_groups, old?.max_groups);
  const maxRankedGroups = draft.budgets.max_ranked_groups === undefined
    ? undefined
    : Math.max(
      maxGroups,
      bounded("max_ranked_groups", draft.budgets.max_ranked_groups, old?.max_ranked_groups),
    );
  return {
    max_rows: bounded("max_rows", draft.budgets.max_rows, old?.max_rows),
    max_groups: maxGroups,
    ...(maxRankedGroups === undefined ? {} : { max_ranked_groups: maxRankedGroups }),
    max_top_n: bounded("max_top_n", draft.budgets.max_top_n, old?.max_top_n),
    max_measures: bounded("max_measures", draft.budgets.max_measures, old?.max_measures),
    max_dimensions: bounded("max_dimensions", draft.budgets.max_dimensions, old?.max_dimensions),
    max_time_ranges: bounded("max_time_ranges", draft.budgets.max_time_ranges, old?.max_time_ranges),
    max_relationship_hops: bounded(
      "max_relationship_hops",
      draft.budgets.max_relationship_hops,
      old?.max_relationship_hops,
    ),
    ...(draft.budgets.max_derived_scope_hops === undefined ? {} : {
      max_derived_scope_hops: bounded(
        "max_derived_scope_hops",
        draft.budgets.max_derived_scope_hops,
        old?.max_derived_scope_hops ?? old?.max_relationship_hops,
      ),
    }),
    ...(draft.budgets.max_analysis_relationship_hops === undefined ? {} : {
      max_analysis_relationship_hops: bounded(
        "max_analysis_relationship_hops",
        draft.budgets.max_analysis_relationship_hops,
        old?.max_analysis_relationship_hops ?? old?.max_relationship_hops,
      ),
    }),
    max_response_cells: bounded("max_response_cells", draft.budgets.max_response_cells, old?.max_response_cells),
    max_response_bytes: bounded("max_response_bytes", draft.budgets.max_response_bytes, old?.max_response_bytes),
    statement_timeout_ms: bounded("statement_timeout_ms", draft.budgets.statement_timeout_ms, old?.statement_timeout_ms),
    max_complexity: bounded("max_complexity", draft.budgets.max_complexity, old?.max_complexity),
    max_queries_per_session: bounded(
      "max_queries_per_session",
      draft.budgets.max_queries_per_session,
      old?.max_queries_per_session,
    ),
    max_extracted_cells_per_session: bounded(
      "max_extracted_cells_per_session",
      draft.budgets.max_extracted_cells_per_session,
      old?.max_extracted_cells_per_session,
    ),
    max_differencing_queries: bounded(
      "max_differencing_queries",
      draft.budgets.max_differencing_queries,
      old?.max_differencing_queries,
    ),
    rate_limit_per_minute: bounded(
      "rate_limit_per_minute",
      draft.budgets.rate_limit_per_minute,
      old?.rate_limit_per_minute,
    ),
  };
}

function relationshipTargetResources(
  relationship: BoundaryResource["relationships"][number],
): string[] {
  return relationship.proof?.links?.flatMap((link) => [link.source_resource, link.target_resource])
    ?? [relationship.target_resource];
}

async function snapshot(
  projectRoot: string,
  library: BoundaryLibraryFile,
  active: Array<{
    name: string;
    digest: `sha256:${string}`;
    boundary: ActivatedExplorationBoundary;
  }>,
): Promise<BoundaryLibrarySnapshot> {
  const activeByName = new Map(active.map((identity) => [identity.name, identity]));
  const entries: BoundaryLibraryEntry[] = [];
  for (const [name, progress] of Object.entries(library.boundaries)) {
    const activeIdentity = activeByName.get(name);
    const revisionState = activeIdentity
      ? await resolveBoundaryRevisionState({
          projectRoot,
          candidate: progress.candidate,
          active: activeIdentity.boundary,
        })
      : undefined;
    entries.push({
      name,
      selected: name === library.selected_name,
      active: Boolean(activeIdentity),
      matches_active_digest: revisionState?.matches_active_authority ?? false,
      table_count: progress.candidate.pack.resources.length,
      candidate_digest: explorationBoundaryCandidateDigest(progress.candidate),
      outstanding_decisions: progress.candidate.unresolved_decisions.length
        - progress.confirmed_decisions.length
        + (progress.policy_migration.status === "review_required" ? 1 : 0),
      policy_review_required: progress.policy_migration.status === "review_required",
    });
  }
  return {
    selected_name: library.selected_name,
    entries: entries.sort((left, right) => Number(right.selected) - Number(left.selected)
      || Number(right.active) - Number(left.active)
      || left.name.localeCompare(right.name)),
  };
}

async function readActiveBoundaryIdentities(
  projectRoot: string,
): Promise<Array<{
  name: string;
  digest: `sha256:${string}`;
  boundary: ActivatedExplorationBoundary;
}>> {
  try {
    return (await loadActivatedExplorationBoundaries(projectRoot)).map((boundary) => ({
      name: boundary.pack.name,
      digest: boundary.activation.digest,
      boundary,
    }));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function readActiveBoundaryProgress(
  draft: ExplorationBoundaryDraft,
  active: ActivatedExplorationBoundary,
): Promise<BoundaryReviewProgress> {
  if (!isRecord(active.activation)
    || active.activation.state !== "active"
    || typeof active.pack?.name !== "string") {
    throw new Error("Activated exploration boundary is invalid; no saved draft was changed.");
  }
  const candidate = reviewExplorationBoundaryCandidate(draft, {
    schema_version: active.schema_version,
    activation: "disabled_unreviewed",
    deployment_profile: active.deployment_profile,
    source: active.source,
    compiler_version: active.compiler_version,
    spec_version: active.spec_version,
    ...(active.database_server_version
      ? { database_server_version: active.database_server_version }
      : {}),
    ...(active.database_server_tier
      ? { database_server_tier: active.database_server_tier }
      : {}),
    ...(active.database_server_authority
      ? { database_server_authority: structuredClone(active.database_server_authority) }
      : {}),
    ...(active.reporting_timezone ? { reporting_timezone: active.reporting_timezone } : {}),
    ...(active.organization_scope
      ? { organization_scope: structuredClone(active.organization_scope) }
      : {}),
    trusted_context: structuredClone(active.trusted_context),
    generation_lock_fingerprint: active.generation_lock_fingerprint,
    role_posture_fingerprint: active.role_posture_fingerprint,
    pack: structuredClone(active.pack),
    budgets: structuredClone(active.budgets),
    unresolved_decisions: [],
  }).candidate;
  return createBoundaryReviewProgress({
    draft,
    candidate,
    confirmedDecisions: active.activation.reviewed_decisions
      .filter((decision) => decision.confirmed)
      .map((decision) => decision.decision),
    actor: active.activation.actor,
    reviewOverrides: emptyReviewOverrides(),
    policyMigration: legacyPolicyMigration(),
    reason: "Registered the current active Explore boundary in the local saved-boundary list.",
    revision: 1,
    now: active.activation.activated_at,
  });
}

async function writeBoundaryLibrary(projectRoot: string, value: BoundaryLibraryFile): Promise<void> {
  const filePath = boundaryLibraryPath(projectRoot);
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${process.pid}.${crypto.randomBytes(8).toString("hex")}.tmp`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      mode: 0o600,
      flag: "wx",
    });
    await fs.rename(temporary, filePath);
    await fs.chmod(filePath, 0o600);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

function boundaryLibraryPath(projectRoot: string): string {
  return path.join(path.resolve(projectRoot), ".synapsor/boundary-library.json");
}

function assertBoundaryName(name: string): void {
  if (!/^[a-z][a-z0-9_.-]{0,63}$/.test(name)) {
    throw new Error(
      "Boundary name must start with a lower-case letter and contain at most 64 lower-case letters, numbers, dots, dashes, or underscores.",
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
