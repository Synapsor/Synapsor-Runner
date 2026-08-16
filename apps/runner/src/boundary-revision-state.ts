import fs from "node:fs/promises";
import path from "node:path";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import {
  explorationBoundaryCandidateDigest,
  loadGenerationLockForActivatedBoundary,
  type ActivatedExplorationBoundary,
  type ExplorationBoundaryDraft,
  type GenerationLock,
} from "./auto-boundary.js";

export type BoundaryRevisionState = {
  matches_active_authority: boolean;
  cause?: "database_posture_changed" | "reviewed_access_edited";
};

export async function resolveBoundaryRevisionState(input: {
  projectRoot: string;
  candidate: ExplorationBoundaryDraft;
  active: ActivatedExplorationBoundary;
}): Promise<BoundaryRevisionState> {
  const exactDigestMatches = explorationBoundaryCandidateDigest(input.candidate)
    === input.active.activation.digest;
  let currentLock: GenerationLock;
  let activeLock: GenerationLock;
  try {
    currentLock = JSON.parse(await fs.readFile(
      path.join(path.resolve(input.projectRoot), ".synapsor/generation-lock.json"),
      "utf8",
    )) as GenerationLock;
    if (canonicalJsonDigest(currentLock) !== input.candidate.generation_lock_fingerprint) {
      throw new Error("The disabled boundary is not bound to the current generation lock.");
    }
    activeLock = await loadGenerationLockForActivatedBoundary(input.projectRoot, input.active);
  } catch {
    return exactDigestMatches
      ? { matches_active_authority: true }
      : {
          matches_active_authority: false,
          cause: "reviewed_access_edited",
        };
  }

  return classifyBoundaryRevisionState({
    candidate: input.candidate,
    active: input.active,
    currentLock,
    activeLock,
  });
}

export function classifyBoundaryRevisionState(input: {
  candidate: ExplorationBoundaryDraft;
  active: ActivatedExplorationBoundary;
  currentLock: Pick<GenerationLock, "schema_fingerprint" | "role_posture_fingerprint">;
  activeLock: Pick<GenerationLock, "schema_fingerprint" | "role_posture_fingerprint">;
}): BoundaryRevisionState {
  const exactDigestMatches = explorationBoundaryCandidateDigest(input.candidate)
    === input.active.activation.digest;
  const databasePostureMatches = input.currentLock.schema_fingerprint === input.activeLock.schema_fingerprint
    && input.currentLock.role_posture_fingerprint === input.activeLock.role_posture_fingerprint;
  if (!databasePostureMatches) {
    return {
      matches_active_authority: false,
      cause: "database_posture_changed",
    };
  }
  if (exactDigestMatches || reviewedAuthorityDigest(input.candidate) === reviewedAuthorityDigest(input.active)) {
    return { matches_active_authority: true };
  }
  return {
    matches_active_authority: false,
    cause: "reviewed_access_edited",
  };
}

function reviewedAuthorityDigest(
  boundary: ExplorationBoundaryDraft | ActivatedExplorationBoundary,
): `sha256:${string}` {
  return canonicalJsonDigest({
    schema_version: boundary.schema_version,
    deployment_profile: boundary.deployment_profile,
    source: boundary.source,
    compiler_version: boundary.compiler_version,
    spec_version: boundary.spec_version,
    ...(boundary.reporting_timezone ? { reporting_timezone: boundary.reporting_timezone } : {}),
    ...(boundary.organization_scope ? { organization_scope: boundary.organization_scope } : {}),
    trusted_context: boundary.trusted_context,
    role_posture_fingerprint: boundary.role_posture_fingerprint,
    pack: {
      ...boundary.pack,
      resources: boundary.pack.resources
        .map((resource) => ({
          ...resource,
          relationships: [...resource.relationships]
            .sort((left, right) => left.id.localeCompare(right.id)),
        }))
        .sort((left, right) => left.id.localeCompare(right.id)),
    },
    budgets: boundary.budgets,
  });
}
