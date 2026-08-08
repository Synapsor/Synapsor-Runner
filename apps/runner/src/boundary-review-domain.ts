import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { Buffer } from "node:buffer";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import {
  AUTO_BOUNDARY_OVERRIDES_VERSION,
  SHARED_REFERENCE_ACKNOWLEDGEMENT,
  emptyReviewOverrides,
  explorationBoundaryCandidateDigest,
  generationLockSharedFactsDigest,
  loadGenerationLockSnapshot,
  normalizeAutoBoundaryReviewOverrides,
  normalizeExplorationDerivedMeasure,
  normalizeExplorationNumericBand,
  reviewExplorationBoundaryCandidate,
  type AutoBoundaryReviewOverrides,
  type ExplorationBoundaryDraft,
  type ExplorationDerivedMeasure,
  type ExplorationNumericBand,
} from "./auto-boundary.js";
import {
  BOUNDARY_REVIEW_PROGRESS_VERSION,
  type BoundaryReviewConfirmation,
  type BoundaryReviewDecision,
  type BoundaryReviewInvalidation,
  type BoundaryReviewPolicyMigration,
  type BoundaryReviewProgressArtifact,
} from "./boundary-review-progress-types.js";

type JsonRecord = Record<string, unknown>;

export {
  BOUNDARY_REVIEW_PROGRESS_VERSION,
};
export type {
  BoundaryReviewConfirmation,
  BoundaryReviewDecision,
  BoundaryReviewInvalidation,
};
const LEGACY_BOUNDARY_REVIEW_PROGRESS_VERSION = "synapsor.boundary-review-progress.v1";
const LEGACY_BOUNDARY_REVIEW_PROGRESS_V2 = "synapsor.boundary-review-progress.v2";

export type BoundaryReviewProgress = BoundaryReviewProgressArtifact<
  ExplorationBoundaryDraft,
  AutoBoundaryReviewOverrides
>;

export type ManagedBoundaryReviewDecision =
  | {
      kind: "field_exposure";
      resource_id: string;
      field: string;
      exposure: "keep_out" | "withhold_from_model" | "allow_reviewed_use";
      actor: string;
      reason: string;
      decided_at?: string;
    }
  | {
      kind: "field_enum";
      resource_id: string;
      field: string;
      values: string[];
      actor: string;
      reason: string;
      decided_at?: string;
    }
  | {
      kind: "row_identity" | "tenant_key" | "tenant_scope_path";
      resource_id: string;
      value: string;
      actor: string;
      reason: string;
      decided_at?: string;
    }
  | {
      kind: "shared_reference_scope";
      resource_id: string;
      acknowledgement: typeof SHARED_REFERENCE_ACKNOWLEDGEMENT;
      actor: string;
      reason: string;
      decided_at?: string;
    }
  | {
      kind: "principal_key" | "principal_scope_path";
      resource_id: string;
      value: string | null;
      actor: string;
      reason: string;
      decided_at?: string;
    }
  | {
      kind: "minimum_cohort";
      resource_id: string;
      value: number;
      actor: string;
      reason: string;
      decided_at?: string;
    }
  | {
      kind: "derived_measure";
      resource_id: string;
      name: string;
      definition: ExplorationDerivedMeasure | null;
      remove?: true;
      actor: string;
      reason: string;
      decided_at?: string;
    }
  | {
      kind: "numeric_band";
      resource_id: string;
      name: string;
      definition: ExplorationNumericBand | null;
      remove?: true;
      actor: string;
      reason: string;
      decided_at?: string;
    };

export function normalizeManagedBoundaryReviewDecision(
  input: JsonRecord,
  now = new Date().toISOString(),
): ManagedBoundaryReviewDecision {
  const kind = requiredText(input.kind, "kind");
  const resourceId = requiredText(input.resource_id, "resource_id");
  const actor = boundedReviewText(input.actor, "actor", 128);
  const reason = boundedReviewText(input.reason, "reason", 500);
  const decidedAt = input.decided_at === undefined
    ? now
    : requiredTimestamp(input.decided_at, "decided_at");

  if (kind === "field_exposure") {
    const exposure = input.exposure;
    if (exposure !== "keep_out"
      && exposure !== "withhold_from_model"
      && exposure !== "allow_reviewed_use") {
      throw new Error(
        "field_exposure review requires exposure keep_out, withhold_from_model, or allow_reviewed_use.",
      );
    }
    return {
      kind,
      resource_id: resourceId,
      field: requiredText(input.field, "field"),
      exposure,
      actor,
      reason,
      decided_at: decidedAt,
    };
  }
  if (kind === "field_enum") {
    if (!Array.isArray(input.values)
      || input.values.length > 64
      || input.values.some((value) => typeof value !== "string" || [...value].length > 64)
      || new Set(input.values).size !== input.values.length
      || Buffer.byteLength(JSON.stringify(input.values), "utf8") > 2_048) {
      throw new Error(
        "field_enum review requires at most 64 unique values, at most 64 characters each and 2048 bytes total.",
      );
    }
    return {
      kind,
      resource_id: resourceId,
      field: requiredText(input.field, "field"),
      values: input.values.map(String),
      actor,
      reason,
      decided_at: decidedAt,
    };
  }
  if (kind === "derived_measure") {
    const name = requiredText(input.name, "name");
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(name)) {
      throw new Error("derived_measure review requires a safe name of at most 64 characters.");
    }
    const definition = input.definition === null
      ? null
      : normalizeExplorationDerivedMeasure(input.definition, `${resourceId}.${name} derived measure`);
    if (definition && definition.name !== name) {
      throw new Error("derived_measure review name must match its fixed definition name.");
    }
    return {
      kind,
      resource_id: resourceId,
      name,
      definition,
      ...(input.remove === true ? { remove: true } : {}),
      actor,
      reason,
      decided_at: decidedAt,
    };
  }
  if (kind === "numeric_band") {
    const name = requiredText(input.name, "name");
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(name)) {
      throw new Error("numeric_band review requires a safe name of at most 64 characters.");
    }
    const definition = input.definition === null
      ? null
      : normalizeExplorationNumericBand(input.definition, `${resourceId}.${name} numeric band`);
    if (definition && definition.name !== name) {
      throw new Error("numeric_band review name must match its fixed definition name.");
    }
    return {
      kind,
      resource_id: resourceId,
      name,
      definition,
      ...(input.remove === true ? { remove: true } : {}),
      actor,
      reason,
      decided_at: decidedAt,
    };
  }
  if (kind === "row_identity" || kind === "tenant_key" || kind === "tenant_scope_path") {
    return {
      kind,
      resource_id: resourceId,
      value: requiredText(input.value, "value"),
      actor,
      reason,
      decided_at: decidedAt,
    };
  }
  if (kind === "shared_reference_scope") {
    if (input.acknowledgement !== SHARED_REFERENCE_ACKNOWLEDGEMENT) {
      throw new Error(
        `shared_reference_scope review requires acknowledgement ${SHARED_REFERENCE_ACKNOWLEDGEMENT}.`,
      );
    }
    return {
      kind,
      resource_id: resourceId,
      acknowledgement: SHARED_REFERENCE_ACKNOWLEDGEMENT,
      actor,
      reason,
      decided_at: decidedAt,
    };
  }
  if (kind === "principal_key" || kind === "principal_scope_path") {
    return {
      kind,
      resource_id: resourceId,
      value: input.value === null ? null : requiredText(input.value, "value"),
      actor,
      reason,
      decided_at: decidedAt,
    };
  }
  if (kind === "minimum_cohort") {
    if (!Number.isSafeInteger(input.value) || Number(input.value) < 1 || Number(input.value) > 5) {
      throw new Error("minimum_cohort review requires an integer from 1 through 5.");
    }
    return {
      kind,
      resource_id: resourceId,
      value: Number(input.value),
      actor,
      reason,
      decided_at: decidedAt,
    };
  }
  throw new Error(
    "Managed boundary review kind must be field_exposure, field_enum, derived_measure, numeric_band, row_identity, tenant_key, tenant_scope_path, shared_reference_scope, principal_key, principal_scope_path, or minimum_cohort.",
  );
}

export function applyManagedBoundaryReviewDecision(
  current: AutoBoundaryReviewOverrides,
  input: ManagedBoundaryReviewDecision,
): AutoBoundaryReviewOverrides {
  if (current.schema_version !== AUTO_BOUNDARY_OVERRIDES_VERSION) {
    throw new Error(`Managed review decisions require ${AUTO_BOUNDARY_OVERRIDES_VERSION}.`);
  }
  const next = structuredClone(current);
  const resource = next.resources[input.resource_id] ?? {};
  const decidedAt = input.decided_at ?? new Date().toISOString();

  if (input.kind === "field_exposure") {
    resource.fields = {
      ...(resource.fields ?? {}),
      [input.field]: {
        exposure: input.exposure,
        actor: input.actor,
        reason: input.reason,
        decided_at: decidedAt,
      },
    };
  } else if (input.kind === "field_enum") {
    resource.field_enums = {
      ...(resource.field_enums ?? {}),
      [input.field]: {
        values: [...input.values],
        actor: input.actor,
        reason: input.reason,
        decided_at: decidedAt,
      },
    };
  } else if (input.kind === "derived_measure") {
    if (input.remove || input.definition === null) {
      if (resource.derived_measures) {
        delete resource.derived_measures[input.name];
        if (Object.keys(resource.derived_measures).length === 0) delete resource.derived_measures;
      }
    } else {
      resource.derived_measures = {
        ...(resource.derived_measures ?? {}),
        [input.name]: {
          definition: structuredClone(input.definition),
          actor: input.actor,
          reason: input.reason,
          decided_at: decidedAt,
        },
      };
    }
  } else if (input.kind === "numeric_band") {
    if (input.remove || input.definition === null) {
      if (resource.numeric_bands) {
        delete resource.numeric_bands[input.name];
        if (Object.keys(resource.numeric_bands).length === 0) delete resource.numeric_bands;
      }
    } else {
      resource.numeric_bands = {
        ...(resource.numeric_bands ?? {}),
        [input.name]: {
          definition: structuredClone(input.definition),
          actor: input.actor,
          reason: input.reason,
          decided_at: decidedAt,
        },
      };
    }
  } else if (input.kind === "row_identity") {
    resource.row_identity = {
      value: input.value,
      actor: input.actor,
      reason: input.reason,
      decided_at: decidedAt,
    };
  } else if (input.kind === "tenant_key") {
    resource.tenant_key = {
      value: input.value,
      actor: input.actor,
      reason: input.reason,
      decided_at: decidedAt,
    };
    delete resource.tenant_scope_path;
    delete resource.shared_reference_scope;
  } else if (input.kind === "tenant_scope_path") {
    resource.tenant_scope_path = {
      value: input.value,
      actor: input.actor,
      reason: input.reason,
      decided_at: decidedAt,
    };
    delete resource.tenant_key;
    delete resource.shared_reference_scope;
  } else if (input.kind === "shared_reference_scope") {
    resource.shared_reference_scope = {
      value: input.acknowledgement,
      actor: input.actor,
      reason: input.reason,
      decided_at: decidedAt,
    };
    delete resource.tenant_key;
    delete resource.tenant_scope_path;
  } else if (input.kind === "principal_key") {
    resource.principal_key = {
      value: input.value,
      actor: input.actor,
      reason: input.reason,
      decided_at: decidedAt,
    };
    delete resource.principal_scope_path;
  } else if (input.kind === "principal_scope_path") {
    resource.principal_scope_path = {
      value: input.value,
      actor: input.actor,
      reason: input.reason,
      decided_at: decidedAt,
    };
    delete resource.principal_key;
  } else {
    const minimumCohort = Number(input.value);
    if (minimumCohort === 5) {
      delete resource.minimum_cohort;
    } else {
      resource.minimum_cohort = {
        value: minimumCohort,
        actor: input.actor,
        reason: input.reason,
        decided_at: decidedAt,
      };
    }
  }
  next.resources[input.resource_id] = resource;
  return next;
}

export async function readBoundaryReviewProgress(
  projectRoot: string,
  draft: ExplorationBoundaryDraft,
): Promise<BoundaryReviewProgress | undefined> {
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

export function normalizePartialReviewDecisions(required: string[], confirmed: string[]): string[] {
  if (new Set(confirmed).size !== confirmed.length) {
    throw new Error("Boundary-review progress cannot contain duplicate confirmations.");
  }
  const requiredSet = new Set(required);
  const unknown = confirmed.filter((decision) => !requiredSet.has(decision));
  if (unknown.length) {
    throw new Error("Boundary-review progress references a decision outside the current generated review.");
  }
  const confirmedSet = new Set(confirmed);
  return required.filter((decision) => confirmedSet.has(decision));
}

export function newBoundaryReviewId(): `bnd_${string}` {
  return `bnd_${crypto.randomBytes(16).toString("hex")}`;
}

export function legacyBoundaryReviewId(
  candidate: ExplorationBoundaryDraft,
): `bnd_${string}` {
  const digest = canonicalJsonDigest({
    schema_version: "synapsor.boundary-review-legacy-id.v1",
    source: candidate.source,
    generation_lock_fingerprint: candidate.generation_lock_fingerprint,
    boundary_name: candidate.pack.name,
  }).slice("sha256:".length, "sha256:".length + 32);
  return `bnd_${digest}`;
}

export function nativePolicyMigration(): BoundaryReviewPolicyMigration {
  return {
    status: "complete",
    source: "native",
    reason: "Review policy is stored with this immutable boundary identity.",
  };
}

export function legacyPolicyMigration(): BoundaryReviewPolicyMigration {
  return {
    status: "review_required",
    source: "legacy_exact_boundary_revision",
    reason: "Legacy project-wide review inputs were not assigned to this boundary; its exact saved revision remains authoritative until policy is reconstructed from a clean inspection.",
  };
}

export function createBoundaryReviewProgress(input: {
  draft: ExplorationBoundaryDraft;
  candidate: ExplorationBoundaryDraft;
  confirmedDecisions: string[];
  previous?: BoundaryReviewProgress;
  boundaryId?: `bnd_${string}`;
  reviewOverrides?: AutoBoundaryReviewOverrides;
  policyMigration?: BoundaryReviewPolicyMigration;
  actor?: string;
  revision: number;
  now?: string;
  reason?: string;
}): BoundaryReviewProgress {
  const now = input.now ?? new Date().toISOString();
  const actor = input.actor?.trim().slice(0, 128)
    || process.env.SYNAPSOR_OPERATOR_ID?.trim().slice(0, 128)
    || "local-workbench-review";
  const confirmed = new Set(normalizePartialReviewDecisions(
    input.candidate.unresolved_decisions,
    input.confirmedDecisions,
  ));
  const currentDecisions = boundaryReviewDecisions(input.candidate);
  const previousById = new Map(input.previous?.confirmations.map((item) => [item.id, item]) ?? []);
  const confirmations = currentDecisions
    .filter((decision) => confirmed.has(decision.decision))
    .map((decision): BoundaryReviewConfirmation => {
      const previous = previousById.get(decision.id);
      if (previous?.input_digest === decision.input_digest) {
        return { ...previous, ...decision };
      }
      return {
        ...decision,
        status: "confirmed",
        actor,
        reason: input.reason ?? "Confirmed during managed boundary review.",
        confirmed_at: now,
      };
    });
  const currentById = new Map(currentDecisions.map((item) => [item.id, item]));
  const invalidated = (input.previous?.confirmations ?? [])
    .filter((previous) => {
      const current = currentById.get(previous.id);
      return !current || current.input_digest !== previous.input_digest;
    })
    .map((previous): BoundaryReviewInvalidation => {
      const current = currentById.get(previous.id);
      return {
        id: previous.id,
        decision: previous.decision,
        previous_input_digest: previous.input_digest,
        ...(current ? { current_input_digest: current.input_digest } : {}),
        reason: current ? "reviewed_input_changed" : "decision_removed",
        invalidated_at: now,
      };
    });
  return {
    schema_version: BOUNDARY_REVIEW_PROGRESS_VERSION,
    boundary_id: input.boundaryId
      ?? input.previous?.boundary_id
      ?? newBoundaryReviewId(),
    review_overrides: normalizeAutoBoundaryReviewOverrides(
      input.reviewOverrides
        ?? input.previous?.review_overrides
        ?? emptyReviewOverrides(),
    ),
    policy_migration: input.policyMigration
      ?? input.previous?.policy_migration
      ?? nativePolicyMigration(),
    revision: input.revision,
    draft_digest: explorationBoundaryCandidateDigest(input.draft),
    candidate: input.candidate,
    candidate_digest: explorationBoundaryCandidateDigest(input.candidate),
    confirmed_decisions: currentDecisions
      .filter((decision) => confirmations.some((confirmation) => confirmation.id === decision.id))
      .map((decision) => decision.decision),
    confirmations,
    invalidated_decisions: mergeBoundaryReviewInvalidations(
      input.previous?.invalidated_decisions ?? [],
      invalidated,
    ),
    updated_at: now,
  };
}

export async function saveBoundaryReviewProgress(
  projectRoot: string,
  progress: BoundaryReviewProgress,
): Promise<void> {
  await writePrivateJsonAtomic(
    path.join(path.resolve(projectRoot), ".synapsor/boundary-review-progress.json"),
    progress,
  );
}

export async function saveInstantBoundaryReviewBaseline(input: {
  projectRoot: string;
  draft: ExplorationBoundaryDraft;
  candidate: ExplorationBoundaryDraft;
  actor: string;
  now?: string;
}): Promise<BoundaryReviewProgress> {
  const progress = createBoundaryReviewProgress({
    draft: input.draft,
    candidate: input.candidate,
    confirmedDecisions: input.candidate.unresolved_decisions,
    actor: input.actor,
    reason: "Accepted as the conservative Quick Start boundary.",
    revision: 1,
    ...(input.now ? { now: input.now } : {}),
  });
  await saveBoundaryReviewProgress(input.projectRoot, progress);
  return progress;
}

export async function saveInstantBoundaryEditBaseline(input: {
  projectRoot: string;
  draft: ExplorationBoundaryDraft;
  candidate: ExplorationBoundaryDraft;
  actor: string;
  now?: string;
}): Promise<BoundaryReviewProgress> {
  const progress = createBoundaryReviewProgress({
    draft: input.draft,
    candidate: input.candidate,
    confirmedDecisions: [],
    actor: input.actor,
    reason: "Opened the conservative Quick Start candidate for detailed access editing.",
    revision: 1,
    ...(input.now ? { now: input.now } : {}),
  });
  await saveBoundaryReviewProgress(input.projectRoot, progress);
  return progress;
}

export function reconcileBoundaryReviewProgress(
  previous: BoundaryReviewProgress | undefined,
  draft: ExplorationBoundaryDraft,
  reviewOverrides?: AutoBoundaryReviewOverrides,
): BoundaryReviewProgress | undefined {
  if (!previous) return undefined;
  const nextDecisions = boundaryReviewDecisions(draft);
  const nextById = new Map(nextDecisions.map((decision) => [decision.id, decision]));
  const confirmedDecisions = previous.confirmations
    .filter((confirmation) => nextById.get(confirmation.id)?.input_digest === confirmation.input_digest)
    .map((confirmation) => nextById.get(confirmation.id)!.decision);
  return createBoundaryReviewProgress({
    draft,
    candidate: draft,
    confirmedDecisions,
    previous,
    ...(reviewOverrides ? {
      reviewOverrides,
      policyMigration: previous.policy_migration.source === "legacy_exact_boundary_revision"
        ? {
          status: "complete",
          source: "legacy_exact_boundary_revision",
          reason: "Reconstructed this boundary's policy from its exact saved revision during schema rescan.",
        }
        : nativePolicyMigration(),
    } : {}),
    actor: "local-workbench-review",
    revision: previous.revision + 1,
  });
}

export function boundaryReviewDecisions(candidate: ExplorationBoundaryDraft): BoundaryReviewDecision[] {
  const resources = new Map(candidate.pack.resources.map((resource) => [resource.id, resource]));
  return candidate.unresolved_decisions.map((decision) => {
    if (decision.startsWith("deployment profile:")) {
      return reviewDecision("global.deployment_profile", "deployment_profile", decision, {
        deployment_profile: candidate.deployment_profile,
      });
    }
    if (decision.startsWith("trusted context:")) {
      return reviewDecision("global.trusted_context", "trusted_context", decision, candidate.trusted_context);
    }
    if (decision.startsWith("organization scope:")) {
      return reviewDecision("global.organization_scope", "organization_scope", decision, {
        mode: candidate.organization_scope?.mode,
        organization_id: candidate.organization_scope?.organization_id,
        tenant_predicate: "not_applied",
      });
    }
    if (decision.startsWith("database role:")) {
      return reviewDecision("global.database_role", "database_role", decision, {
        role_posture_fingerprint: candidate.role_posture_fingerprint,
      });
    }
    const separator = decision.indexOf(": ");
    if (separator < 1) {
      return reviewDecision(
        `other.${reviewDecisionSuffix(decision)}`,
        "other",
        decision,
        { decision },
      );
    }
    const resourceId = decision.slice(0, separator);
    const detail = decision.slice(separator + 2);
    const resource = resources.get(resourceId);
    if (!resource) {
      return reviewDecision(
        `resource.${resourceId}.blocked.${reviewDecisionSuffix(detail)}`,
        "resource_blocker",
        decision,
        { resource_id: resourceId, blocker: detail },
        resourceId,
      );
    }
    if (detail.startsWith("confirm tenant key ")) {
      return reviewDecision(`resource.${resourceId}.tenant_scope`, "tenant_scope", decision, {
        tenant_key: resource.tenant_key,
        ...(candidate.trusted_context.provider === "http_claims"
          ? { trusted_tenant_http_claim: candidate.trusted_context.tenant_claim }
          : {
            trusted_tenant_env: candidate.trusted_context.tenant_env,
            ...(candidate.trusted_context.database_role_tenant ? {
              trusted_tenant_database_role_setting: candidate.trusted_context.database_role_tenant.setting,
            } : {}),
          }),
        rls_session: resource.rls_session ?? null,
      }, resourceId);
    }
    if (detail === "confirm whole-organization read access with no tenant predicate") {
      return reviewDecision(`resource.${resourceId}.tenant_scope`, "tenant_scope", decision, {
        organization_scope: candidate.organization_scope,
        tenant_predicate: "not_applied",
      }, resourceId);
    }
    if (detail.startsWith("confirm mandatory derived tenant scope ")) {
      return reviewDecision(`resource.${resourceId}.tenant_scope`, "tenant_scope", decision, {
        tenant_scope: resource.tenant_scope,
        ...(candidate.trusted_context.provider === "http_claims"
          ? { trusted_tenant_http_claim: candidate.trusted_context.tenant_claim }
          : {
            trusted_tenant_env: candidate.trusted_context.tenant_env,
            ...(candidate.trusted_context.database_role_tenant ? {
              trusted_tenant_database_role_setting: candidate.trusted_context.database_role_tenant.setting,
            } : {}),
          }),
        rls_session: resource.rls_session ?? null,
      }, resourceId);
    }
    if (detail === "confirm reviewed shared reference with no tenant predicate") {
      return reviewDecision(`resource.${resourceId}.tenant_scope`, "tenant_scope", decision, {
        shared_reference_scope: resource.shared_reference_scope,
        tenant_predicate: "not_applied",
        field_privacy_controls: "unchanged",
      }, resourceId);
    }
    if (detail.startsWith("confirm principal scope ")) {
      return reviewDecision(`resource.${resourceId}.principal_scope`, "principal_scope", decision, {
        principal_key: resource.principal_key ?? null,
        ...(candidate.trusted_context.provider === "http_claims"
          ? { trusted_principal_http_claim: candidate.trusted_context.principal_claim }
          : { trusted_principal_env: candidate.trusted_context.principal_env }),
        rls_session: resource.rls_session ?? null,
      }, resourceId);
    }
    if (detail.startsWith("confirm mandatory derived principal scope ")) {
      return reviewDecision(`resource.${resourceId}.principal_scope`, "principal_scope", decision, {
        principal_scope: resource.principal_scope,
        ...(candidate.trusted_context.provider === "http_claims"
          ? { trusted_principal_http_claim: candidate.trusted_context.principal_claim }
          : { trusted_principal_env: candidate.trusted_context.principal_env }),
        rls_session: resource.rls_session ?? null,
      }, resourceId);
    }
    if (detail === "confirm visible and kept-out fields") {
      return reviewDecision(`resource.${resourceId}.field_visibility`, "field_visibility", decision, {
        selectable_fields: resource.selectable_fields,
        ...(resource.model_withheld_fields?.length
          ? { model_withheld_fields: resource.model_withheld_fields }
          : {}),
        kept_out_fields: resource.kept_out_fields,
      }, resourceId);
    }
    if (detail === "confirm filter/sort/group/aggregate-only field permissions") {
      return reviewDecision(`resource.${resourceId}.field_permissions`, "field_permissions", decision, {
        filterable_fields: resource.filterable_fields,
        sortable_fields: resource.sortable_fields,
        groupable_fields: resource.groupable_fields,
        aggregate_measures: resource.aggregate_measures,
        ...(resource.aggregate_measure_functions
          ? { aggregate_measure_functions: resource.aggregate_measure_functions }
          : {}),
        ...(resource.presence_measure_fields
          ? { presence_measure_fields: resource.presence_measure_fields }
          : {}),
        ...(resource.derived_measures?.length
          ? { derived_measures: resource.derived_measures }
          : {}),
        count_distinct_fields: resource.count_distinct_fields,
        time_bucket_fields: resource.time_bucket_fields,
        field_enums: resource.field_enums,
      }, resourceId);
    }
    if (detail === "confirm minimum cohort and extraction/differencing budgets") {
      return reviewDecision(`resource.${resourceId}.privacy_budgets`, "privacy_budgets", decision, {
        minimum_cohort_size: resource.minimum_cohort_size,
        ...(resource.minimum_cohort_overridden ? { minimum_cohort_overridden: true } : {}),
        suppression_aware_totals: resource.suppression_aware_totals,
        budgets: candidate.budgets,
      }, resourceId);
    }
    const relationship = /^review relationship (.+) cardinality and scope on (.+)$/.exec(detail);
    if (relationship) {
      const relationshipId = relationship[1]!;
      const targetResource = resources.get(relationship[2]!);
      return reviewDecision(
        `resource.${resourceId}.relationship.${relationshipId}`,
        "relationship",
        decision,
        {
          relationship: resource.relationships.find((item) => item.id === relationshipId) ?? null,
          source_scope: {
            ...(resource.tenant_key ? { tenant_key: resource.tenant_key } : {}),
            ...(resource.tenant_scope ? { tenant_scope: resource.tenant_scope } : {}),
            ...(resource.shared_reference_scope
              ? { shared_reference_scope: resource.shared_reference_scope }
              : {}),
            principal_key: resource.principal_key ?? null,
            ...(resource.principal_scope ? { principal_scope: resource.principal_scope } : {}),
          },
          target_scope: targetResource ? {
            ...(targetResource.tenant_key ? { tenant_key: targetResource.tenant_key } : {}),
            ...(targetResource.tenant_scope ? { tenant_scope: targetResource.tenant_scope } : {}),
            ...(targetResource.shared_reference_scope
              ? { shared_reference_scope: targetResource.shared_reference_scope }
              : {}),
            principal_key: targetResource.principal_key ?? null,
            ...(targetResource.principal_scope ? { principal_scope: targetResource.principal_scope } : {}),
          } : null,
        },
        resourceId,
      );
    }
    return reviewDecision(
      `resource.${resourceId}.other.${reviewDecisionSuffix(detail)}`,
      "resource_other",
      decision,
      { resource_id: resourceId, detail },
      resourceId,
    );
  });
}

export function normalizeStoredBoundaryReviewProgress(
  raw: JsonRecord,
  candidate: ExplorationBoundaryDraft,
): BoundaryReviewProgress {
  const currentVersion = raw.schema_version === BOUNDARY_REVIEW_PROGRESS_VERSION;
  const boundaryId = currentVersion
    ? normalizeBoundaryReviewId(raw.boundary_id)
    : legacyBoundaryReviewId(candidate);
  const reviewOverrides = currentVersion
    ? normalizeAutoBoundaryReviewOverrides(raw.review_overrides)
    : emptyReviewOverrides();
  const policyMigration = currentVersion
    ? normalizePolicyMigration(raw.policy_migration)
    : legacyPolicyMigration();
  const decisions = boundaryReviewDecisions(candidate);
  const decisionById = new Map(decisions.map((decision) => [decision.id, decision]));
  const confirmations: BoundaryReviewConfirmation[] = [];
  for (const item of raw.confirmations as unknown[]) {
    if (!isRecord(item)
      || typeof item.id !== "string"
      || typeof item.decision !== "string"
      || typeof item.input_digest !== "string"
      || item.status !== "confirmed"
      || typeof item.actor !== "string"
      || typeof item.reason !== "string"
      || typeof item.confirmed_at !== "string") {
      throw new Error("Saved boundary-review confirmations are invalid.");
    }
    const current = decisionById.get(item.id);
    if (!current || current.input_digest !== item.input_digest) continue;
    confirmations.push({
      ...current,
      status: "confirmed",
      actor: item.actor,
      reason: item.reason,
      confirmed_at: item.confirmed_at,
    });
  }
  const invalidatedDecisions = (raw.invalidated_decisions as unknown[])
    .flatMap((item): BoundaryReviewInvalidation[] => {
      if (!isRecord(item)
        || typeof item.id !== "string"
        || typeof item.decision !== "string"
        || typeof item.previous_input_digest !== "string"
        || (item.current_input_digest !== undefined && typeof item.current_input_digest !== "string")
        || (item.reason !== "reviewed_input_changed" && item.reason !== "decision_removed")
        || typeof item.invalidated_at !== "string") return [];
      return [{
        id: item.id,
        decision: item.decision,
        previous_input_digest: item.previous_input_digest as `sha256:${string}`,
        ...(item.current_input_digest
          ? { current_input_digest: item.current_input_digest as `sha256:${string}` }
          : {}),
        reason: item.reason,
        invalidated_at: item.invalidated_at,
      }];
    });
  return {
    schema_version: BOUNDARY_REVIEW_PROGRESS_VERSION,
    boundary_id: boundaryId,
    review_overrides: reviewOverrides,
    policy_migration: policyMigration,
    revision: raw.revision as number,
    draft_digest: raw.draft_digest as `sha256:${string}`,
    candidate,
    candidate_digest: explorationBoundaryCandidateDigest(candidate),
    confirmed_decisions: decisions
      .filter((decision) => confirmations.some((confirmation) => confirmation.id === decision.id))
      .map((decision) => decision.decision),
    confirmations,
    invalidated_decisions: invalidatedDecisions,
    updated_at: raw.updated_at as string,
  };
}

function normalizeBoundaryReviewId(value: unknown): `bnd_${string}` {
  if (typeof value !== "string" || !/^bnd_[a-f0-9]{32}$/.test(value)) {
    throw new Error("Saved boundary-review progress has an invalid immutable boundary id.");
  }
  return value as `bnd_${string}`;
}

function normalizePolicyMigration(value: unknown): BoundaryReviewPolicyMigration {
  if (!isRecord(value)
    || (value.status !== "complete" && value.status !== "review_required")
    || (value.source !== "native" && value.source !== "legacy_exact_boundary_revision")
    || typeof value.reason !== "string"
    || !value.reason.trim()
    || value.reason.length > 500) {
    throw new Error("Saved boundary-review progress has invalid policy migration state.");
  }
  return {
    status: value.status,
    source: value.source,
    reason: value.reason,
  };
}

function mergeBoundaryReviewInvalidations(
  previous: BoundaryReviewInvalidation[],
  next: BoundaryReviewInvalidation[],
): BoundaryReviewInvalidation[] {
  const merged = new Map(previous.map((item) => [`${item.id}:${item.previous_input_digest}`, item]));
  for (const item of next) merged.set(`${item.id}:${item.previous_input_digest}`, item);
  return [...merged.values()]
    .sort((left, right) => left.id.localeCompare(right.id))
    .slice(-200);
}

function reviewDecision(
  id: string,
  kind: string,
  decision: string,
  reviewedInput: unknown,
  resourceId?: string,
): BoundaryReviewDecision {
  return {
    id,
    kind,
    decision,
    input_digest: canonicalJsonDigest({
      schema_version: "synapsor.boundary-review-input.v1",
      decision_kind: kind,
      reviewed_input: reviewedInput,
    }),
    ...(resourceId ? { resource_id: resourceId } : {}),
  };
}

function reviewDecisionSuffix(value: string): string {
  return canonicalJsonDigest({ value }).slice("sha256:".length, "sha256:".length + 16);
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

function requiredText(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Managed boundary review requires ${label}.`);
  }
  const normalized = value.trim();
  if (normalized.length > 512 || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error(`Managed boundary review ${label} is invalid.`);
  }
  return normalized;
}

function boundedReviewText(value: unknown, label: string, maximum: number): string {
  const normalized = requiredText(value, label);
  if (normalized.length > maximum) {
    throw new Error(`Managed boundary review ${label} must be at most ${maximum} characters.`);
  }
  return normalized;
}

function requiredTimestamp(value: unknown, label: string): string {
  const normalized = requiredText(value, label);
  if (!Number.isFinite(Date.parse(normalized))) {
    throw new Error(`Managed boundary review ${label} must be an ISO timestamp.`);
  }
  return new Date(normalized).toISOString();
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
