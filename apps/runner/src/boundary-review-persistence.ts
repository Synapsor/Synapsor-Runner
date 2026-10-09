import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { withProjectAuthorityMutation, withHeldProjectAuthorityAccess, type ProjectAuthorityMutationPermit } from "./project-authority-mutation.js";
import { BOUNDARY_REVIEW_SUBMISSION_VERSION, boundaryReviewDecisionRefs, explorationBoundaryCandidateDigest,
  generationLockSharedFactsDigest, loadGenerationLockSnapshot,
  reviewExplorationBoundaryCandidate, type ExplorationBoundaryDraft, type BoundaryReviewSubmission } from "./auto-boundary.js";
import { createBoundaryReviewProgress, normalizeStoredBoundaryReviewProgress, type BoundaryReviewProgress } from "./boundary-review-domain.js";
import { parseStoredReadReviewProgress } from "./control-policy-read-authoring.js";
import { resolveReadReviewOriginHeld } from "./read-review-origin.js";
import { assertReadAuthoringBindings, readProjectReadAuthoringHeld, saveProjectReadProgress,
  type ReadAuthoringBindings } from "./control-policy-read-authoring-project.js";

export async function readBoundaryReviewProgress(projectRoot: string,
  draft: ExplorationBoundaryDraft): Promise<BoundaryReviewProgress | undefined> {
  return withProjectAuthorityMutation(projectRoot, held => readBoundaryReviewProgressUnlocked(held.projectRoot, draft, held));
}
export async function readBoundaryReviewProgressHeld(projectRoot: string, draft: ExplorationBoundaryDraft,
  permit: ProjectAuthorityMutationPermit): Promise<BoundaryReviewProgress | undefined> {
  return withHeldProjectAuthorityAccess(projectRoot, permit, held => readBoundaryReviewProgressUnlocked(held.projectRoot, draft, held));
}
async function readBoundaryReviewProgressUnlocked(projectRoot: string, draft: ExplorationBoundaryDraft,
  permit: ProjectAuthorityMutationPermit): Promise<BoundaryReviewProgress | undefined> {
  const stored = await readProjectReadAuthoringHeld(projectRoot, permit);
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
  // Older progress is preserved on disk and refused, never interpreted or rewritten.
  const progress = parseStoredReadReviewProgress(raw);
  if (progress.draft_digest !== explorationBoundaryCandidateDigest(draft)) {
    throw Object.assign(new Error("The exact saved draft changed. Reopen its review."), { code: "POLICY_AUTHORING_BASELINE_MISMATCH" });
  }
  if (progress.candidate.generation_lock_fingerprint !== draft.generation_lock_fingerprint) {
    const [candidateLock, draftLock] = await Promise.all([
      loadGenerationLockSnapshot(projectRoot, progress.candidate.generation_lock_fingerprint),
      loadGenerationLockSnapshot(projectRoot, draft.generation_lock_fingerprint),
    ]);
    if (generationLockSharedFactsDigest(candidateLock) !== generationLockSharedFactsDigest(draftLock)) {
      throw Object.assign(new Error("Saved boundary-review progress is bound to different schema or role facts; rescan that boundary before editing it."),
        { code: "POLICY_AUTHORING_BASELINE_MISMATCH" });
    }
  }
  const origins = [];
  for (const confirmation of progress.confirmations) {
    if (confirmation.origin) origins.push(await resolveReadReviewOriginHeld(projectRoot, confirmation.origin, permit));
  }
  return normalizeStoredBoundaryReviewProgress(progress as unknown as Record<string, unknown>, progress.candidate, origins);
}

export async function saveBoundaryReviewProgress(
  projectRoot: string,
  progress: BoundaryReviewProgress,
  expected?: ReadAuthoringBindings,
  permit?: ProjectAuthorityMutationPermit,
  submission?: BoundaryReviewSubmission,
): Promise<ReadAuthoringBindings | undefined> {
  const frozen = structuredClone({ progress, expected, submission });
  return withProjectAuthorityMutation(projectRoot, async (held) => {
    const saved = await saveProjectReadProgress({ projectRoot: held.projectRoot, ...frozen }, held);
    if (saved) return saved;
    const parsed = parseStoredReadReviewProgress(frozen.progress);
    if (parsed.confirmations.length || frozen.submission?.decisions.length) {
      throw Object.assign(new Error("Save this disabled candidate in the native Read repository before confirming it; no review was recorded."),
        { code: "READ_REVIEW_CANDIDATE_NOT_SAVED" });
    }
    await writePrivateJsonAtomic(path.join(held.projectRoot, ".synapsor/boundary-review-progress.json"), parsed);
  }, { permit });
}

type InstantBoundaryBaselineInput = {
  projectRoot: string;
  draft: ExplorationBoundaryDraft;
  candidate: ExplorationBoundaryDraft;
  actor: string;
  now?: string;
  expectedAuthoring?: ReadAuthoringBindings;
  expectedLegacyProgress?: BoundaryReviewProgress;
};

type InstantBoundaryBaselineResult = {
  progress: BoundaryReviewProgress;
  authoring: ReadAuthoringBindings | undefined;
  reviewSubmission?: BoundaryReviewSubmission;
};

export async function saveInstantBoundaryReviewBaseline(input: InstantBoundaryBaselineInput) {
  return saveInstantBoundaryBaseline(input, true);
}

export async function saveInstantBoundaryEditBaseline(input: InstantBoundaryBaselineInput) {
  return saveInstantBoundaryBaseline(input, false);
}

async function saveInstantBoundaryBaseline(input: InstantBoundaryBaselineInput, accepted: boolean): Promise<InstantBoundaryBaselineResult> {
  const frozen = structuredClone(input);
  return withProjectAuthorityMutation(frozen.projectRoot, (held) => saveInstantBoundaryBaselineUnlocked({
    ...frozen, projectRoot: held.projectRoot,
  }, accepted, held));
}

async function saveInstantBoundaryBaselineUnlocked(input: InstantBoundaryBaselineInput, accepted: boolean,
  permit: ProjectAuthorityMutationPermit): Promise<InstantBoundaryBaselineResult> {
  const stored = await readProjectReadAuthoringHeld(input.projectRoot, permit);
  let previous: BoundaryReviewProgress | undefined;
  if (stored) {
    assertReadAuthoringBindings(input.expectedAuthoring, stored.bindings);
    if (!stored.selected || stored.selected.progress.draft_digest !== explorationBoundaryCandidateDigest(input.draft)) {
      throw new Error("The selected saved Read baseline changed. Reopen Quick Start before deciding.");
    }
    previous = stored.selected.progress;
  } else if (input.expectedAuthoring) {
    throw new Error("The reviewed policy repository is unavailable. No Quick Start authority changed.");
  } else {
    const lock = await readOptionalJson(path.join(input.projectRoot, ".synapsor/generation-lock.json"));
    if (canonicalJsonDigest(lock) !== input.draft.generation_lock_fingerprint
      || canonicalJsonDigest(await readBoundaryReviewProgressHeld(input.projectRoot, input.draft, permit) ?? null)
        !== canonicalJsonDigest(input.expectedLegacyProgress ?? null)) {
      throw Object.assign(new Error("The Boundary review changed after Quick Start opened. Resume the saved review; no Quick Start decision was saved."),
        { code: "POLICY_AUTHORING_REVIEW_CHANGED" });
    }
    previous = input.expectedLegacyProgress;
  }
  const candidate = reviewExplorationBoundaryCandidate(previous?.candidate ?? input.draft, input.candidate).candidate;
  const submission: BoundaryReviewSubmission | undefined = accepted ? {
    schema_version: BOUNDARY_REVIEW_SUBMISSION_VERSION,
    candidate_digest: explorationBoundaryCandidateDigest(candidate),
    decisions: boundaryReviewDecisionRefs(candidate),
  } : undefined;
  const progress = createBoundaryReviewProgress({
    draft: input.draft,
    candidate,
    previous,
    submission,
    resolvedOrigins: stored?.resolvedOrigins,
    actor: input.actor,
    reason: accepted ? "Accepted as the conservative Quick Start boundary."
      : "Opened the conservative Quick Start candidate for detailed access editing.",
    revision: (previous?.revision ?? 0) + 1,
    ...(input.now ? { now: input.now } : {}),
  });
  const authoring = await saveBoundaryReviewProgress(input.projectRoot, progress, input.expectedAuthoring, permit, submission);
  return { progress, authoring, ...(submission ? { reviewSubmission: submission } : {}) };
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
