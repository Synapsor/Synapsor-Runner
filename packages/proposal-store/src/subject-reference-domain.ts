import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import type {
  ClaimObservedSubjectReferencesInput,
  ObservedSubjectOutcomeAuthority,
  RevokeObservedSubjectReferencesInput,
  StoredObservedSubjectReference,
} from "./domain-types.js";
import { ProposalStoreError } from "./errors.js";

const DIGEST = /^sha256:[a-f0-9]{64}$/;
const SUBJECT_REF = /^obj_[A-Za-z0-9_-]{32,128}$/;
const SAFE_NAME = /^[A-Za-z_][A-Za-z0-9_.:-]{0,255}$/;
const SAFE_RESOURCE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

export type NormalizedObservedSubjectClaim = Omit<
  ClaimObservedSubjectReferencesInput,
  "now"
> & { now: string };

export type NormalizedObservedSubjectRevocation = {
  subject_refs: string[];
  read_boundary_digest?: `sha256:${string}`;
  action_boundary_digest?: `sha256:${string}`;
  workflow_session_id?: string;
  now: string;
};

export function subjectReferenceUnavailable(): ProposalStoreError {
  return new ProposalStoreError(
    "SUBJECT_REFERENCE_UNAVAILABLE",
    "One or more observed subjects are unavailable for this request. Re-read the reviewed row and try again.",
  );
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw subjectReferenceUnavailable();
  return value as Record<string, unknown>;
}

function text(value: unknown, pattern: RegExp, maximum = 512): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum || !pattern.test(value)) {
    throw subjectReferenceUnavailable();
  }
  return value;
}

function digest(value: unknown): `sha256:${string}` {
  return text(value, DIGEST, 71) as `sha256:${string}`;
}

function timestamp(value: unknown): string {
  if (typeof value !== "string") throw subjectReferenceUnavailable();
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    throw subjectReferenceUnavailable();
  }
  return value;
}

function authority(value: unknown): ObservedSubjectOutcomeAuthority {
  const input = record(value);
  return {
    outcome: text(input.outcome, SAFE_NAME, 256),
    action_boundary_digest: digest(input.action_boundary_digest),
    action_rule_digest: digest(input.action_rule_digest),
  };
}

export function normalizeStoredObservedSubjectReference(
  value: unknown,
): StoredObservedSubjectReference {
  const input = record(value);
  if (input.schema_version !== "synapsor.observed-subject-ref.v1") throw subjectReferenceUnavailable();
  const protectedIdentity = record(input.protected_identity);
  if (protectedIdentity.algorithm !== "A256GCM") throw subjectReferenceUnavailable();
  const outcomeAuthorities = Array.isArray(input.outcome_authorities)
    ? input.outcome_authorities.map(authority).sort((left, right) => {
      const outcome = left.outcome.localeCompare(right.outcome);
      return outcome !== 0
        ? outcome
        : left.action_rule_digest.localeCompare(right.action_rule_digest);
    })
    : [];
  if (outcomeAuthorities.length === 0
    || new Set(outcomeAuthorities.map((item) => item.outcome)).size !== outcomeAuthorities.length) {
    throw subjectReferenceUnavailable();
  }
  const state = input.state;
  if (state !== "active" && state !== "consumed" && state !== "revoked") {
    throw subjectReferenceUnavailable();
  }
  const normalized: StoredObservedSubjectReference = {
    schema_version: "synapsor.observed-subject-ref.v1",
    subject_ref: text(input.subject_ref, SUBJECT_REF, 132),
    subject_ref_digest: digest(input.subject_ref_digest),
    source_id: text(input.source_id, SAFE_NAME, 256),
    resource: text(input.resource, SAFE_RESOURCE, 256),
    protected_identity: {
      algorithm: "A256GCM",
      nonce: text(protectedIdentity.nonce, BASE64URL, 128),
      ciphertext: text(protectedIdentity.ciphertext, BASE64URL, 16_384),
      authentication_tag: text(protectedIdentity.authentication_tag, BASE64URL, 128),
    },
    evidence_bundle_id: text(input.evidence_bundle_id, SAFE_NAME, 256),
    read_boundary_digest: digest(input.read_boundary_digest),
    generation_lock_fingerprint: digest(input.generation_lock_fingerprint),
    tenant_scope_fingerprint: digest(input.tenant_scope_fingerprint),
    ...(input.principal_scope_fingerprint === undefined
      ? {}
      : { principal_scope_fingerprint: digest(input.principal_scope_fingerprint) }),
    workflow_session_id: text(input.workflow_session_id, SAFE_NAME, 256),
    ...(input.observed_version_digest === undefined
      ? {}
      : { observed_version_digest: digest(input.observed_version_digest) }),
    outcome_authorities: outcomeAuthorities,
    issued_at: timestamp(input.issued_at),
    expires_at: timestamp(input.expires_at),
    state,
    ...(input.claim_id === undefined ? {} : { claim_id: text(input.claim_id, SAFE_NAME, 256) }),
    ...(input.consumed_at === undefined ? {} : { consumed_at: timestamp(input.consumed_at) }),
    ...(input.revoked_at === undefined ? {} : { revoked_at: timestamp(input.revoked_at) }),
  };
  if (Date.parse(normalized.expires_at) <= Date.parse(normalized.issued_at)) throw subjectReferenceUnavailable();
  const expectedDigest = canonicalJsonDigest({
    schema_version: normalized.schema_version,
    subject_ref: normalized.subject_ref,
  });
  if (normalized.subject_ref_digest !== expectedDigest) throw subjectReferenceUnavailable();
  if (state === "active" && (normalized.claim_id || normalized.consumed_at || normalized.revoked_at)) {
    throw subjectReferenceUnavailable();
  }
  if (state === "consumed" && (!normalized.claim_id || !normalized.consumed_at || normalized.revoked_at)) {
    throw subjectReferenceUnavailable();
  }
  if (state === "revoked" && !normalized.revoked_at) throw subjectReferenceUnavailable();
  return normalized;
}

export function normalizeNewObservedSubjectReference(
  value: unknown,
): StoredObservedSubjectReference {
  const normalized = normalizeStoredObservedSubjectReference(value);
  if (normalized.state !== "active") throw subjectReferenceUnavailable();
  return normalized;
}

export function normalizeObservedSubjectClaim(
  value: ClaimObservedSubjectReferencesInput,
): NormalizedObservedSubjectClaim {
  if (!Array.isArray(value.subject_refs)
    || value.subject_refs.length < 1
    || value.subject_refs.length > 8
    || new Set(value.subject_refs).size !== value.subject_refs.length) {
    throw subjectReferenceUnavailable();
  }
  return {
    subject_refs: value.subject_refs.map((item) => text(item, SUBJECT_REF, 132)),
    claim_id: text(value.claim_id, SAFE_NAME, 256),
    outcome: text(value.outcome, SAFE_NAME, 256),
    action_boundary_digest: digest(value.action_boundary_digest),
    action_rule_digest: digest(value.action_rule_digest),
    read_boundary_digest: digest(value.read_boundary_digest),
    generation_lock_fingerprint: digest(value.generation_lock_fingerprint),
    tenant_scope_fingerprint: digest(value.tenant_scope_fingerprint),
    ...(value.principal_scope_fingerprint === undefined
      ? {}
      : { principal_scope_fingerprint: digest(value.principal_scope_fingerprint) }),
    workflow_session_id: text(value.workflow_session_id, SAFE_NAME, 256),
    now: timestamp(value.now ?? new Date().toISOString()),
  };
}

export function assertObservedSubjectMatchesClaim(
  subject: StoredObservedSubjectReference,
  claim: ReturnType<typeof normalizeObservedSubjectClaim>,
): void {
  const authority = subject.outcome_authorities.find((candidate) =>
    candidate.outcome === claim.outcome
      && candidate.action_boundary_digest === claim.action_boundary_digest
      && candidate.action_rule_digest === claim.action_rule_digest);
  if (!authority
    || subject.read_boundary_digest !== claim.read_boundary_digest
    || subject.generation_lock_fingerprint !== claim.generation_lock_fingerprint
    || subject.tenant_scope_fingerprint !== claim.tenant_scope_fingerprint
    || subject.principal_scope_fingerprint !== claim.principal_scope_fingerprint
    || subject.workflow_session_id !== claim.workflow_session_id
    || Date.parse(subject.expires_at) <= Date.parse(claim.now)
    || (subject.state === "consumed" && subject.claim_id !== claim.claim_id)
    || subject.state === "revoked") {
    throw subjectReferenceUnavailable();
  }
}

export function consumedObservedSubjectReference(
  subject: StoredObservedSubjectReference,
  claimId: string,
  consumedAt: string,
): StoredObservedSubjectReference {
  return normalizeStoredObservedSubjectReference({
    ...subject,
    state: "consumed",
    claim_id: claimId,
    consumed_at: consumedAt,
  });
}

export function normalizeObservedSubjectRevocation(
  value: RevokeObservedSubjectReferencesInput,
): NormalizedObservedSubjectRevocation {
  const refs = value.subject_refs ?? [];
  if (refs.length > 256 || new Set(refs).size !== refs.length) throw subjectReferenceUnavailable();
  const readDigest = value.read_boundary_digest === undefined ? undefined : digest(value.read_boundary_digest);
  const actionDigest = value.action_boundary_digest === undefined ? undefined : digest(value.action_boundary_digest);
  const workflow = value.workflow_session_id === undefined
    ? undefined
    : text(value.workflow_session_id, SAFE_NAME, 256);
  if (refs.length === 0 && !readDigest && !actionDigest && !workflow) throw subjectReferenceUnavailable();
  return {
    subject_refs: refs.map((item) => text(item, SUBJECT_REF, 132)),
    ...(readDigest === undefined ? {} : { read_boundary_digest: readDigest }),
    ...(actionDigest === undefined ? {} : { action_boundary_digest: actionDigest }),
    ...(workflow === undefined ? {} : { workflow_session_id: workflow }),
    now: timestamp(value.now ?? new Date().toISOString()),
  };
}
