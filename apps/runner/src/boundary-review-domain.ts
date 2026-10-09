import crypto from "node:crypto";
import { Buffer } from "node:buffer";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import {
  AUTO_BOUNDARY_OVERRIDES_VERSION,
  BOUNDARY_REVIEW_SUBMISSION_VERSION,
  boundaryReviewDecisionRefs,
  SHARED_REFERENCE_ACKNOWLEDGEMENT,
  emptyReviewOverrides,
  explorationBoundaryCandidateDigest,
  normalizeAutoBoundaryReviewOverrides,
  normalizeExplorationDerivedMeasure,
  normalizeExplorationAutoBandPolicy,
  normalizeExplorationNumericBand,
  reviewExplorationBoundaryCandidate,
  projectBoundaryReviewDecisions,
  validateBoundaryReviewSubmission,
  parseBoundaryReviewDecisionRef,
  type BoundaryReviewDecisionRef,
  type BoundaryReviewOrigin,
  type ResolvedBoundaryReviewOrigin,
  type BoundaryReviewSubmission,
  type ProjectedBoundaryReviewDecision,
  type AutoBoundaryReviewOverrides,
  type ExplorationBoundaryDraft,
  type ExplorationDerivedMeasure,
  type ExplorationAutoBandPolicy,
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
      kind: "resource_metadata";
      resource_id: string;
      label?: string | null;
      description?: string | null;
      actor: string;
      reason: string;
      decided_at?: string;
    }
  | {
      kind: "field_metadata";
      resource_id: string;
      field: string;
      label?: string | null;
      description?: string | null;
      actor: string;
      reason: string;
      decided_at?: string;
    }
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
      kind: "exact_numeric_grouping";
      resource_id: string;
      field: string;
      enabled: boolean;
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
      kind: "principal_key" | "principal_scope_path" | "principal_rls_setting";
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
    }
  | {
      kind: "auto_band";
      resource_id: string;
      field: string;
      definition: ExplorationAutoBandPolicy | null;
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

  if (kind === "resource_metadata" || kind === "field_metadata") {
    if (!Object.hasOwn(input, "label") && !Object.hasOwn(input, "description")) {
      throw new Error(`${kind} review requires label and/or description; use null to clear a value.`);
    }
    const label = optionalMetadataText(input.label, "label", 64);
    const description = optionalMetadataText(input.description, "description", 280);
    return {
      kind,
      resource_id: resourceId,
      ...(kind === "field_metadata" ? { field: requiredText(input.field, "field") } : {}),
      ...(Object.hasOwn(input, "label") ? { label } : {}),
      ...(Object.hasOwn(input, "description") ? { description } : {}),
      actor,
      reason,
      decided_at: decidedAt,
    } as ManagedBoundaryReviewDecision;
  }

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
  if (kind === "exact_numeric_grouping") {
    if (typeof input.enabled !== "boolean") {
      throw new Error("exact_numeric_grouping review requires enabled true or false.");
    }
    return {
      kind,
      resource_id: resourceId,
      field: requiredText(input.field, "field"),
      enabled: input.enabled,
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
  if (kind === "auto_band") {
    const field = requiredText(input.field, "field");
    const definition = input.definition === null
      ? null
      : normalizeExplorationAutoBandPolicy(input.definition, `${resourceId}.${field} auto band`);
    if (definition && definition.field !== field) {
      throw new Error("auto_band review field must match its policy field.");
    }
    return {
      kind,
      resource_id: resourceId,
      field,
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
  if (kind === "principal_key"
    || kind === "principal_scope_path"
    || kind === "principal_rls_setting") {
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
    "Managed boundary review kind must be resource_metadata, field_metadata, field_exposure, field_enum, exact_numeric_grouping, derived_measure, numeric_band, auto_band, row_identity, tenant_key, tenant_scope_path, shared_reference_scope, principal_key, principal_scope_path, principal_rls_setting, or minimum_cohort.",
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

  if (input.kind === "resource_metadata" || input.kind === "field_metadata") {
    const currentMetadata = input.kind === "resource_metadata"
      ? resource.metadata
      : resource.field_metadata?.[input.field];
    const label = input.label === undefined ? currentMetadata?.label : input.label ?? undefined;
    const description = input.description === undefined
      ? currentMetadata?.description
      : input.description ?? undefined;
    if (input.kind === "resource_metadata") {
      if (!label && !description) {
        delete resource.metadata;
      } else {
        resource.metadata = {
          ...(label ? { label } : {}),
          ...(description ? { description } : {}),
          actor: input.actor,
          reason: input.reason,
          decided_at: decidedAt,
        };
      }
    } else if (!label && !description) {
      if (resource.field_metadata) {
        delete resource.field_metadata[input.field];
        if (Object.keys(resource.field_metadata).length === 0) delete resource.field_metadata;
      }
    } else {
      resource.field_metadata = {
        ...(resource.field_metadata ?? {}),
        [input.field]: {
          ...(label ? { label } : {}),
          ...(description ? { description } : {}),
          actor: input.actor,
          reason: input.reason,
          decided_at: decidedAt,
        },
      };
    }
  } else if (input.kind === "field_exposure") {
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
  } else if (input.kind === "exact_numeric_grouping") {
    if (input.enabled) {
      resource.exact_numeric_grouping = {
        ...(resource.exact_numeric_grouping ?? {}),
        [input.field]: {
          actor: input.actor,
          reason: input.reason,
          decided_at: decidedAt,
        },
      };
    } else if (resource.exact_numeric_grouping) {
      delete resource.exact_numeric_grouping[input.field];
      if (Object.keys(resource.exact_numeric_grouping).length === 0) {
        delete resource.exact_numeric_grouping;
      }
    }
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
  } else if (input.kind === "auto_band") {
    if (input.remove || input.definition === null) {
      if (resource.auto_bands) {
        delete resource.auto_bands[input.field];
        if (Object.keys(resource.auto_bands).length === 0) delete resource.auto_bands;
      }
    } else {
      resource.auto_bands = {
        ...(resource.auto_bands ?? {}),
        [input.field]: {
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
    delete resource.principal_rls_setting;
  } else if (input.kind === "principal_scope_path") {
    resource.principal_scope_path = {
      value: input.value,
      actor: input.actor,
      reason: input.reason,
      decided_at: decidedAt,
    };
    delete resource.principal_key;
    delete resource.principal_rls_setting;
  } else if (input.kind === "principal_rls_setting") {
    resource.principal_rls_setting = {
      value: input.value,
      actor: input.actor,
      reason: input.reason,
      decided_at: decidedAt,
    };
    delete resource.principal_key;
    delete resource.principal_scope_path;
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

export function normalizePartialReviewDecisions(candidate: ExplorationBoundaryDraft, submission: unknown): BoundaryReviewDecisionRef[] {
  return validateBoundaryReviewSubmission(candidate, submission, "partial");
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

/** IDs come only from the exact decisions shown by the existing review view. */
export function boundaryReviewSubmissionForDecisions(candidate: ExplorationBoundaryDraft,
  acceptedIds: readonly string[]): BoundaryReviewSubmission {
  const current = boundaryReviewDecisionRefs(candidate);
  const selected = new Set(acceptedIds);
  if (selected.size !== acceptedIds.length || acceptedIds.some(id => !current.some(item => item.id === id))) {
    throw new Error("BOUNDARY_REVIEW_SUBMISSION_INVALID: The selected review decisions are not current.");
  }
  const submission: BoundaryReviewSubmission = {
    schema_version: BOUNDARY_REVIEW_SUBMISSION_VERSION,
    candidate_digest: explorationBoundaryCandidateDigest(candidate),
    decisions: current.filter(item => selected.has(item.id)),
  };
  validateBoundaryReviewSubmission(candidate, submission, "partial");
  return submission;
}

export function boundaryReviewDecisionResourceId(reference: BoundaryReviewDecisionRef): string | undefined {
  return "resource_id" in reference ? reference.resource_id : undefined;
}

function confirmationReference(confirmation: BoundaryReviewConfirmation): BoundaryReviewDecisionRef {
  const { decision: _copy, status: _status, actor: _actor, reason: _reason, confirmed_at: _at,
    origin: _origin, ...reference } = confirmation as BoundaryReviewConfirmation & { origin?: BoundaryReviewOrigin };
  return parseBoundaryReviewDecisionRef(reference);
}

type ReviewResource = ExplorationBoundaryDraft["pack"]["resources"][number];
/** Existing rescan reduction predicate; it does not create another confirmation. */
export function isSafeUnavailableReviewFieldChange(before: ReviewResource | undefined, after: ReviewResource | undefined): boolean {
  if (!before || !after) return false;
  const same = (left: string[], right: string[]) => JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
  if (!same(before.selectable_fields, after.selectable_fields)
    || !same(before.model_withheld_fields ?? [], after.model_withheld_fields ?? [])) return false;
  const beforeFields = new Set(Object.keys(before.field_types)), afterFields = new Set(Object.keys(after.field_types));
  const access = (resource: ReviewResource, field: string) => !resource.selectable_fields.includes(field) ? "kept_out"
    : (resource.model_withheld_fields ?? []).includes(field) ? "withheld" : "visible";
  return [...afterFields].filter(field => !beforeFields.has(field)).every(field => after.kept_out_fields.includes(field))
    && [...beforeFields].filter(field => !afterFields.has(field)).every(field => before.kept_out_fields.includes(field))
    && [...beforeFields].filter(field => afterFields.has(field)).every(field => access(before, field) === access(after, field));
}

export function applicableBoundaryReviewConfirmations(candidate: ExplorationBoundaryDraft,
  confirmations: readonly BoundaryReviewConfirmation[], resolvedOrigins: readonly ResolvedBoundaryReviewOrigin[] = []): Array<{ confirmation: BoundaryReviewConfirmation;
    current: BoundaryReviewDecisionRef; basis: "exact_input" | "unavailable_fields_only" }> {
  const decisions = new Map(projectBoundaryReviewDecisions(candidate).map(({ decision: _copy, ...reference }) => [reference.id, reference]));
  if (new Set(confirmations.map(item => item.id)).size !== confirmations.length) throw new Error("Boundary review has duplicate native confirmation identities.");
  return confirmations.flatMap<{ confirmation: BoundaryReviewConfirmation; current: BoundaryReviewDecisionRef;
    basis: "exact_input" | "unavailable_fields_only" }>(confirmation => {
    const reference = confirmationReference(confirmation), current = decisions.get(reference.id);
    if (!current) return [];
    const { input_digest: _previousDigest, ...previousBinding } = reference;
    const { input_digest: _currentDigest, ...currentBinding } = current;
    if (canonicalJsonDigest(previousBinding) !== canonicalJsonDigest(currentBinding)) return [];
    const origin = (confirmation as BoundaryReviewConfirmation & { origin?: BoundaryReviewOrigin }).origin;
    const resolved = origin && resolvedOrigins.find(item => canonicalJsonDigest(item.reference) === canonicalJsonDigest(origin));
    if (resolved && explorationBoundaryCandidateDigest(resolved.candidate) !== origin!.candidate_digest) {
      throw new Error("Resolved boundary review origin does not match its exact candidate digest.");
    }
    const original = resolved?.candidate;
    if (original) {
      const originalDecision = projectBoundaryReviewDecisions(original).find(item => item.id === reference.id);
      if (!originalDecision) return [];
      const { decision: _copy, ...originalReference } = originalDecision;
      if (canonicalJsonDigest(originalReference) !== canonicalJsonDigest(reference)) return [];
    }
    if (reference.input_digest === current.input_digest) {
      if (current.kind === "field_permissions") {
        // This decision digest intentionally retains its existing contract and does not
        // contain field types. Only the immutable reviewed candidate proves those types;
        // a previous reconciliation candidate can already contain an unreviewed change.
        if (!original) return [];
        const before = original.pack.resources.find(item => item.id === current.resource_id);
        const after = candidate.pack.resources.find(item => item.id === current.resource_id);
        if (!before || !after || [...new Set([...before.selectable_fields, ...(before.model_withheld_fields ?? [])])]
          .some(field => before.field_types[field] !== after.field_types[field])) return [];
      }
      return [{ confirmation, current, basis: "exact_input" as const }];
    }
    if (current.kind !== "field_visibility" || !original) return [];
    if (!isSafeUnavailableReviewFieldChange(original.pack.resources.find(item => item.id === current.resource_id),
      candidate.pack.resources.find(item => item.id === current.resource_id))) return [];
    return [{ confirmation, current, basis: "unavailable_fields_only" as const }];
  });
}

export function createBoundaryReviewProgress(input: {
  draft: ExplorationBoundaryDraft;
  candidate: ExplorationBoundaryDraft;
  submission?: BoundaryReviewSubmission;
  resolvedOrigins?: readonly ResolvedBoundaryReviewOrigin[];
  previous?: BoundaryReviewProgress;
  boundaryId?: `bnd_${string}`;
  reviewOverrides?: AutoBoundaryReviewOverrides;
  policyMigration?: BoundaryReviewPolicyMigration;
  actor?: string;
  revision: number;
  now?: string;
  reason?: string;
}): BoundaryReviewProgress {
  if (Object.hasOwn(input, "confirmedDecisions")) {
    throw Object.assign(new Error("Text-only boundary confirmations are unsupported; submit the exact typed review."),
      { code: "BOUNDARY_REVIEW_PROTOCOL_REQUIRED" as const });
  }
  const boundaryId = input.boundaryId ?? input.previous?.boundary_id ?? newBoundaryReviewId();
  for (const confirmation of input.previous?.confirmations ?? []) {
    const origin = (confirmation as BoundaryReviewConfirmation & { origin?: BoundaryReviewOrigin }).origin;
    if (origin && origin.boundary_id !== boundaryId) throw new Error("Boundary confirmation origin belongs to another boundary.");
  }
  const now = input.now ?? new Date().toISOString();
  const actor = input.actor?.trim().slice(0, 128)
    || process.env.SYNAPSOR_OPERATOR_ID?.trim().slice(0, 128)
    || "local-workbench-review";
  const submitted = input.submission ? validateBoundaryReviewSubmission(input.candidate, input.submission, "partial") : [];
  const currentDecisions = boundaryReviewDecisions(input.candidate);
  const currentByReferenceId = new Map(currentDecisions.map(item => [item.id, item]));
  if (input.previous && new Set(input.previous.confirmations.map(item => item.id)).size !== input.previous.confirmations.length) {
    throw new Error("Boundary review has duplicate native confirmation identities.");
  }
  const confirmationsById = new Map((input.previous?.confirmations ?? []).map(item => [item.id, structuredClone(item)]));
  const previouslyApplicableIds = new Set(applicableBoundaryReviewConfirmations(input.candidate,
    [...confirmationsById.values()], input.resolvedOrigins).map(item => item.current.id));
  for (const reference of submitted) {
    const decision = currentByReferenceId.get(reference.id)!;
    const previous = confirmationsById.get(reference.id);
    if (previous && previouslyApplicableIds.has(reference.id)
      && canonicalJsonDigest(confirmationReference(previous)) === canonicalJsonDigest(reference)) continue;
    confirmationsById.set(reference.id, { ...decision, status: "confirmed", actor,
      reason: input.reason ?? "Confirmed during managed boundary review.", confirmed_at: now });
  }
  const confirmations = [...confirmationsById.values()];
  const applicable = applicableBoundaryReviewConfirmations(input.candidate, confirmations, input.resolvedOrigins);
  // A fresh submission proves this exact candidate only in this operation. Persistence
  // must attach and resolve its immutable origin before a later reload can reuse it.
  const applicableIds = new Set([...applicable.map(item => item.current.id), ...submitted.map(item => item.id)]);
  const currentById = new Map(currentDecisions.map((item) => [item.id, item]));
  const invalidated = (input.previous?.confirmations ?? [])
    .filter((previous) => {
      const current = currentById.get(previous.id);
      return !current || !applicableIds.has(previous.id);
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
    boundary_id: boundaryId,
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
      .filter((decision) => applicableIds.has(decision.id))
      .map((decision) => decision.decision),
    confirmations,
    invalidated_decisions: mergeBoundaryReviewInvalidations(
      input.previous?.invalidated_decisions ?? [],
      invalidated,
    ),
    updated_at: now,
  };
}

export function reconcileBoundaryReviewProgress(
  previous: BoundaryReviewProgress | undefined,
  draft: ExplorationBoundaryDraft,
  reviewOverrides?: AutoBoundaryReviewOverrides,
): BoundaryReviewProgress | undefined {
  if (!previous) return undefined;
  return createBoundaryReviewProgress({
    draft,
    candidate: draft,
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

export function boundaryReviewDecisions(candidate: ExplorationBoundaryDraft): ProjectedBoundaryReviewDecision[] {
  return projectBoundaryReviewDecisions(candidate);
}

export function normalizeStoredBoundaryReviewProgress(
  raw: JsonRecord,
  candidate: ExplorationBoundaryDraft,
  resolvedOrigins: readonly ResolvedBoundaryReviewOrigin[] = [],
): BoundaryReviewProgress {
  if (raw.schema_version !== BOUNDARY_REVIEW_PROGRESS_VERSION) {
    throw Object.assign(new Error("Saved review progress needs the current typed protocol; previous records remain preserved."),
      { code: "BOUNDARY_REVIEW_PROTOCOL_REQUIRED" as const });
  }
  const boundaryId = normalizeBoundaryReviewId(raw.boundary_id);
  const reviewOverrides = normalizeAutoBoundaryReviewOverrides(raw.review_overrides);
  const policyMigration = normalizePolicyMigration(raw.policy_migration);
  const decisions = boundaryReviewDecisions(candidate);
  const confirmations: BoundaryReviewConfirmation[] = [];
  if (!Array.isArray(raw.confirmations)) throw new Error("Saved boundary-review confirmations are invalid.");
  for (const item of raw.confirmations) {
    if (!isRecord(item) || typeof item.decision !== "string" || item.status !== "confirmed"
      || typeof item.actor !== "string" || typeof item.reason !== "string" || typeof item.confirmed_at !== "string") {
      throw new Error("Saved boundary-review confirmations are invalid.");
    }
    const confirmation = structuredClone(item) as BoundaryReviewConfirmation;
    const origin = (confirmation as BoundaryReviewConfirmation & { origin?: BoundaryReviewOrigin }).origin;
    if (origin && origin.boundary_id !== boundaryId) throw new Error("Boundary confirmation origin belongs to another boundary.");
    confirmationReference(confirmation);
    confirmations.push(confirmation);
  }
  const applicableIds = new Set(applicableBoundaryReviewConfirmations(candidate, confirmations, resolvedOrigins).map(item => item.current.id));
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
      .filter((decision) => applicableIds.has(decision.id))
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

export function normalizePolicyMigration(value: unknown): BoundaryReviewPolicyMigration {
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

function optionalMetadataText(
  value: unknown,
  label: string,
  maximum: number,
): string | null | undefined {
  if (value === undefined || value === null) return value;
  return boundedReviewText(value, label, maximum);
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
