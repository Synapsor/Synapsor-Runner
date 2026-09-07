import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { emptyReviewOverrides, explorationBoundaryCandidateDigest, generationLockSharedFactsDigest,
  loadGenerationLockSnapshot, reviewExplorationBoundaryCandidate, type ExplorationBoundaryDraft } from "./auto-boundary.js";
import { BOUNDARY_REVIEW_PROGRESS_VERSION, boundaryReviewDecisions, createBoundaryReviewProgress, legacyBoundaryReviewId,
  legacyPolicyMigration, normalizePartialReviewDecisions, normalizePolicyMigration,
  normalizeStoredBoundaryReviewProgress, type BoundaryReviewProgress } from "./boundary-review-domain.js";
import { assertReadAuthoringBindings, readProjectReadAuthoring, saveProjectReadProgress,
  type ReadAuthoringBindings } from "./control-policy-read-authoring-project.js";

const LEGACY_BOUNDARY_REVIEW_PROGRESS_VERSION = "synapsor.boundary-review-progress.v1";
const LEGACY_BOUNDARY_REVIEW_PROGRESS_V2 = "synapsor.boundary-review-progress.v2";

export async function readBoundaryReviewProgress(
  projectRoot: string,
  draft: ExplorationBoundaryDraft,
): Promise<BoundaryReviewProgress | undefined> {
  const stored = await readProjectReadAuthoring(projectRoot);
  if (stored) {
    if (!stored.selected) return undefined;
    if (stored.selected.progress.draft_digest !== explorationBoundaryCandidateDigest(draft)) {
      throw Object.assign(new Error("The generated file is not the selected saved Read revision. Reopen the stored review."),
        { code: "POLICY_AUTHORING_BASELINE_MISMATCH" });
    }
    return stored.selected.progress;
  }
  const filePath = path.join(projectRoot, ".synapsor/boundary-review-progress.json");
  const raw = await readOptionalJson(filePath);
  if (raw === null) return undefined;
  if (!isRecord(raw)
    || (raw.schema_version !== BOUNDARY_REVIEW_PROGRESS_VERSION
      && raw.schema_version !== LEGACY_BOUNDARY_REVIEW_PROGRESS_V2
      && raw.schema_version !== LEGACY_BOUNDARY_REVIEW_PROGRESS_VERSION)
    || !isRecord(raw.candidate)
    || !Array.isArray(raw.confirmed_decisions)
    || raw.confirmed_decisions.some((decision) => typeof decision !== "string")
    || typeof raw.updated_at !== "string") {
    throw new Error("Saved boundary-review progress is invalid; use explicit Rescan or Start over rather than trusting it.");
  }
  if (raw.schema_version === LEGACY_BOUNDARY_REVIEW_PROGRESS_VERSION) {
    const preview = reviewExplorationBoundaryCandidate(
      draft,
      raw.candidate as unknown as ExplorationBoundaryDraft,
    );
    return createBoundaryReviewProgress({
      draft,
      candidate: preview.candidate,
      confirmedDecisions: normalizePartialReviewDecisions(
        preview.candidate.unresolved_decisions,
        (raw.confirmed_decisions as string[])
          .filter((decision) => preview.candidate.unresolved_decisions.includes(decision)),
      ),
      actor: "legacy-workbench-review",
      boundaryId: legacyBoundaryReviewId(preview.candidate),
      reviewOverrides: emptyReviewOverrides(),
      policyMigration: legacyPolicyMigration(),
      revision: 1,
      now: raw.updated_at,
    });
  }
  if (!Number.isSafeInteger(raw.revision)
    || (raw.revision as number) < 1
    || typeof raw.draft_digest !== "string"
    || typeof raw.candidate_digest !== "string"
    || !Array.isArray(raw.confirmations)
    || !Array.isArray(raw.invalidated_decisions)) {
    throw new Error("Saved boundary-review progress is invalid; use explicit Rescan or Start over rather than trusting it.");
  }

  const draftDigest = explorationBoundaryCandidateDigest(draft);
  const storedCandidate = raw.candidate as unknown as ExplorationBoundaryDraft;
  let candidate = raw.schema_version === LEGACY_BOUNDARY_REVIEW_PROGRESS_V2
    ? structuredClone(storedCandidate)
    : draft;
  if (raw.schema_version === LEGACY_BOUNDARY_REVIEW_PROGRESS_V2
    && storedCandidate.generation_lock_fingerprint === draft.generation_lock_fingerprint) {
    candidate = reviewExplorationBoundaryCandidate(draft, storedCandidate).candidate;
  } else if (raw.draft_digest === draftDigest) {
    if (storedCandidate.generation_lock_fingerprint === draft.generation_lock_fingerprint) {
      candidate = reviewExplorationBoundaryCandidate(draft, storedCandidate).candidate;
    } else if (raw.schema_version === BOUNDARY_REVIEW_PROGRESS_VERSION
      && raw.candidate_digest === explorationBoundaryCandidateDigest(storedCandidate)) {
      try {
        const [storedLock, draftLock] = await Promise.all([
          loadGenerationLockSnapshot(projectRoot, storedCandidate.generation_lock_fingerprint),
          loadGenerationLockSnapshot(projectRoot, draft.generation_lock_fingerprint),
        ]);
        if (generationLockSharedFactsDigest(storedLock)
          !== generationLockSharedFactsDigest(draftLock)) {
          throw new Error(
            "Saved boundary-review progress is bound to different schema or role facts; rescan that boundary before editing it.",
          );
        }
      } catch (error) {
        const migration = isRecord(raw.policy_migration)
          ? normalizePolicyMigration(raw.policy_migration)
          : undefined;
        if ((error as NodeJS.ErrnoException).code !== "ENOENT"
          || migration?.status !== "review_required"
          || migration.source !== "legacy_exact_boundary_revision") {
          throw error;
        }
        // Legacy disabled boundaries may predate lock snapshots. Keep their
        // exact authority disabled and require reconstruction; never rebase
        // them through another boundary's policy-bound draft.
      }
      // Different boundaries may bind different human policy over these exact
      // shared facts. Preserve the selected boundary's self-consistent revision.
      candidate = storedCandidate;
    }
  }
  const previous = normalizeStoredBoundaryReviewProgress(raw, candidate);
  return createBoundaryReviewProgress({
    draft,
    candidate,
    confirmedDecisions: previous.confirmed_decisions,
    previous,
    actor: "local-workbench-review",
    revision: previous.revision,
    now: previous.updated_at,
  });
}

export async function saveBoundaryReviewProgress(
  projectRoot: string,
  progress: BoundaryReviewProgress,
  expected?: ReadAuthoringBindings,
): Promise<ReadAuthoringBindings | undefined> {
  const saved = await saveProjectReadProgress({ projectRoot, progress, expected });
  if (saved) return saved;
  await writePrivateJsonAtomic(
    path.join(path.resolve(projectRoot), ".synapsor/boundary-review-progress.json"),
    progress,
  );
}

type InstantBoundaryBaselineInput = {
  projectRoot: string;
  draft: ExplorationBoundaryDraft;
  candidate: ExplorationBoundaryDraft;
  actor: string;
  now?: string;
  expectedAuthoring?: ReadAuthoringBindings;
};

export async function saveInstantBoundaryReviewBaseline(input: InstantBoundaryBaselineInput) {
  return saveInstantBoundaryBaseline(input, true);
}

export async function saveInstantBoundaryEditBaseline(input: InstantBoundaryBaselineInput) {
  return saveInstantBoundaryBaseline(input, false);
}

async function saveInstantBoundaryBaseline(input: InstantBoundaryBaselineInput, accepted: boolean): Promise<{
  progress: BoundaryReviewProgress; authoring: ReadAuthoringBindings | undefined;
}> {
  input = structuredClone(input);
  const stored = await readProjectReadAuthoring(input.projectRoot);
  let previous: BoundaryReviewProgress | undefined;
  if (stored) {
    assertReadAuthoringBindings(input.expectedAuthoring, stored.bindings);
    if (!stored.selected || stored.selected.progress.draft_digest !== explorationBoundaryCandidateDigest(input.draft)) {
      throw new Error("The selected saved Read baseline changed. Reopen Quick Start before deciding.");
    }
    previous = stored.selected.progress;
  } else if (input.expectedAuthoring) {
    throw new Error("The reviewed policy repository is unavailable. No Quick Start authority changed.");
  }
  const candidate = reviewExplorationBoundaryCandidate(previous?.candidate ?? input.draft, input.candidate).candidate;
  const decisions = new Map(boundaryReviewDecisions(candidate).map((decision) => [decision.id, decision]));
  const retained = (previous?.confirmations ?? [])
    .filter((confirmation) => decisions.get(confirmation.id)?.input_digest === confirmation.input_digest)
    .map((confirmation) => decisions.get(confirmation.id)!.decision);
  const progress = createBoundaryReviewProgress({
    draft: input.draft,
    candidate,
    previous,
    confirmedDecisions: accepted ? candidate.unresolved_decisions : retained,
    actor: input.actor,
    reason: accepted ? "Accepted as the conservative Quick Start boundary."
      : "Opened the conservative Quick Start candidate for detailed access editing.",
    revision: (previous?.revision ?? 0) + 1,
    ...(input.now ? { now: input.now } : {}),
  });
  const authoring = await saveBoundaryReviewProgress(input.projectRoot, progress, input.expectedAuthoring);
  return { progress, authoring };
}

async function writePrivateJsonAtomic(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  try {
    await fs.writeFile(
      temporary,
      `${JSON.stringify(value, null, 2)}\n`,
      { encoding: "utf8", mode: 0o600, flag: "wx" },
    );
    await fs.rename(temporary, filePath);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function readOptionalJson(filePath: string): Promise<unknown | null> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
