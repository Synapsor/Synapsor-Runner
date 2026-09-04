import crypto from "node:crypto";
import {
  resolveActivatedActionRule,
  type ActivatedActionRuleV1,
  type ActionRuleSubjectIdentityV1,
  type RuntimeActionRuleRegistryV1,
} from "@synapsor-runner/action-rules";
import {
  type ProposalRuntimeStore,
  type StoredObservedSubjectReference,
} from "@synapsor-runner/proposal-store";
import {
  canonicalJsonDigest,
  canonicalJsonStringify,
} from "@synapsor-runner/protocol";
import type { JsonScalar } from "@synapsor/spec";
import { McpRuntimeError } from "./runtime-errors.js";
import type {
  SubjectReferenceAuthorityContext,
  SubjectReferenceDigest,
} from "./subject-reference-types.js";

export type { SubjectReferenceAuthorityContext } from "./subject-reference-types.js";

const SUBJECT_REFERENCE_INFO = "synapsor/observed-subject-reference/v1";
const SUBJECT_REFERENCE_AAD_VERSION = "synapsor.observed-subject-aad.v1";
const PROTECTED_SUBJECT_VERSION = "synapsor.protected-subject-identity.v1";
const DEFAULT_SUBJECT_REFERENCE_TTL_SECONDS = 10 * 60;
const MAX_SUBJECT_REFERENCE_TTL_SECONDS = 15 * 60;
const MAX_ISSUED_SUBJECTS = 100;

type Digest = SubjectReferenceDigest;

type ProtectedSubjectPayloadV1 = {
  schema_version: typeof PROTECTED_SUBJECT_VERSION;
  source_id: string;
  resource: string;
  primary_key: { column: string; value: JsonScalar };
  observed_version?: { column: string; value: JsonScalar };
};

type SubjectReferenceImmutableMetadata = Omit<
  StoredObservedSubjectReference,
  "protected_identity" | "state" | "claim_id" | "consumed_at" | "revoked_at"
>;

export type SubjectObservationRequirement = {
  resource: string;
  primary_key: string;
  version_field?: string;
  outcomes: string[];
};

export type ObservedSubjectInput = {
  row_index: number;
  primary_key_value: unknown;
  observed_version_value?: unknown;
};

export type ModelVisibleSubjectReference = {
  row_index: number;
  resource: string;
  ref: string;
  expires_at: string;
};

export type ResolvedSubjectRequest = {
  activated: ActivatedActionRuleV1;
  subjects: ActionRuleSubjectIdentityV1[];
  proposal_id: string;
  claim_id: string;
  claimed_at: string;
  trusted_context_digest: Digest;
  evidence_provenance_digest: Digest;
};

export type SubjectReferenceService = {
  observationRequirement(resource: string): Promise<SubjectObservationRequirement | undefined>;
  issue(input: SubjectReferenceAuthorityContext & {
    resource: string;
    evidence_bundle_id: string;
    observations: ObservedSubjectInput[];
    now?: string;
  }): Promise<ModelVisibleSubjectReference[]>;
  claim(input: SubjectReferenceAuthorityContext & {
    outcome: string;
    subject_refs: Record<string, string>;
    now?: string;
  }): Promise<ResolvedSubjectRequest>;
};

export function subjectReferenceScopeFingerprints(input: {
  key: Uint8Array;
  deployment_scope: string;
  source_id: string;
  tenant: string;
  principal?: string;
}): {
  tenant_scope_fingerprint: Digest;
  principal_scope_fingerprint?: Digest;
} {
  const key = rootKey(input.key);
  const fingerprint = (kind: "tenant" | "principal", value: string): Digest => canonicalJsonDigest({
    schema_version: "synapsor.subject-scope.v1",
    deployment: crypto.createHmac("sha256", key)
      .update(`deployment\0${input.deployment_scope}`, "utf8")
      .digest("hex"),
    source: input.source_id,
    kind,
    value: crypto.createHmac("sha256", key)
      .update(`${kind}\0${value}`, "utf8")
      .digest("hex"),
  });
  return {
    tenant_scope_fingerprint: fingerprint("tenant", input.tenant),
    ...(input.principal === undefined || input.principal.length === 0
      ? {}
      : { principal_scope_fingerprint: fingerprint("principal", input.principal) }),
  };
}

function unavailable(): McpRuntimeError {
  return new McpRuntimeError(
    "SUBJECT_REFERENCE_UNAVAILABLE",
    "One or more observed subjects are unavailable for this request. Re-read the reviewed row and try again.",
  );
}

function canonicalTimestamp(value: string | undefined): string {
  const timestamp = value ?? new Date().toISOString();
  const milliseconds = Date.parse(timestamp);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== timestamp) throw unavailable();
  return timestamp;
}

function assertDigest(value: string): asserts value is Digest {
  if (!/^sha256:[a-f0-9]{64}$/.test(value)) throw unavailable();
}

function scalar(value: unknown): JsonScalar {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value) && Number.isSafeInteger(value)) return value;
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.toISOString();
  if (typeof value === "bigint") {
    const numeric = Number(value);
    if (Number.isSafeInteger(numeric)) return numeric;
    return value.toString();
  }
  throw unavailable();
}

function rootKey(value: Uint8Array): Buffer {
  const key = Buffer.from(value);
  if (key.byteLength < 32) {
    throw new McpRuntimeError(
      "SUBJECT_REFERENCE_KEY_INVALID",
      "Observed subject references require at least 32 bytes of Runner-owned key material.",
    );
  }
  return key;
}

function encryptionKey(key: Buffer): Buffer {
  return Buffer.from(crypto.hkdfSync(
    "sha256",
    key,
    Buffer.from("synapsor/observed-subject-reference/salt/v1", "utf8"),
    Buffer.from(SUBJECT_REFERENCE_INFO, "utf8"),
    32,
  ));
}

function immutableMetadata(subject: StoredObservedSubjectReference): SubjectReferenceImmutableMetadata {
  const {
    protected_identity: _protectedIdentity,
    state: _state,
    claim_id: _claimId,
    consumed_at: _consumedAt,
    revoked_at: _revokedAt,
    ...metadata
  } = subject;
  return metadata;
}

function aad(metadata: SubjectReferenceImmutableMetadata): Buffer {
  return Buffer.from(canonicalJsonStringify({
    ...metadata,
    aad_version: SUBJECT_REFERENCE_AAD_VERSION,
  }), "utf8");
}

function encryptIdentity(
  key: Buffer,
  metadata: SubjectReferenceImmutableMetadata,
  payload: ProtectedSubjectPayloadV1,
  randomBytes: (size: number) => Buffer,
): StoredObservedSubjectReference["protected_identity"] {
  const nonce = randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(aad(metadata));
  const ciphertext = Buffer.concat([
    cipher.update(canonicalJsonStringify(payload), "utf8"),
    cipher.final(),
  ]);
  return {
    algorithm: "A256GCM",
    nonce: nonce.toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
    authentication_tag: cipher.getAuthTag().toString("base64url"),
  };
}

function decryptIdentity(
  key: Buffer,
  subject: StoredObservedSubjectReference,
): ProtectedSubjectPayloadV1 {
  try {
    const decipher = crypto.createDecipheriv(
      "aes-256-gcm",
      key,
      Buffer.from(subject.protected_identity.nonce, "base64url"),
    );
    decipher.setAAD(aad(immutableMetadata(subject)));
    decipher.setAuthTag(Buffer.from(subject.protected_identity.authentication_tag, "base64url"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(subject.protected_identity.ciphertext, "base64url")),
      decipher.final(),
    ]).toString("utf8");
    const parsed = JSON.parse(plaintext) as Partial<ProtectedSubjectPayloadV1>;
    if (parsed.schema_version !== PROTECTED_SUBJECT_VERSION
      || typeof parsed.source_id !== "string"
      || typeof parsed.resource !== "string"
      || !parsed.primary_key
      || typeof parsed.primary_key.column !== "string"
      || parsed.primary_key.value === null) {
      throw unavailable();
    }
    return {
      schema_version: PROTECTED_SUBJECT_VERSION,
      source_id: parsed.source_id,
      resource: parsed.resource,
      primary_key: {
        column: parsed.primary_key.column,
        value: scalar(parsed.primary_key.value),
      },
      ...(parsed.observed_version === undefined
        ? {}
        : {
          observed_version: {
            column: parsed.observed_version.column,
            value: scalar(parsed.observed_version.value),
          },
        }),
    };
  } catch {
    throw unavailable();
  }
}

function requirementsForRegistry(registry: RuntimeActionRuleRegistryV1): Map<string, SubjectObservationRequirement> {
  const result = new Map<string, SubjectObservationRequirement>();
  for (const activated of registry.rules) {
    for (const subject of activated.compiled.rule.subjects) {
      const binding = activated.compiled.bindings.find((candidate) => candidate.binding === subject.binding);
      if (!binding || binding.resource.name !== subject.resource) throw unavailable();
      const candidate: SubjectObservationRequirement = {
        resource: subject.resource,
        primary_key: binding.resource.primary_key,
        ...(binding.resource.version_field === undefined
          ? {}
          : { version_field: binding.resource.version_field }),
        outcomes: [activated.compiled.outcome],
      };
      const existing = result.get(subject.resource);
      if (!existing) {
        result.set(subject.resource, candidate);
        continue;
      }
      if (existing.primary_key !== candidate.primary_key
        || existing.version_field !== candidate.version_field) throw unavailable();
      existing.outcomes.push(activated.compiled.outcome);
      existing.outcomes.sort();
    }
  }
  return result;
}

function validateContext(context: SubjectReferenceAuthorityContext): void {
  assertDigest(context.read_boundary_digest);
  assertDigest(context.generation_lock_fingerprint);
  assertDigest(context.tenant_scope_fingerprint);
  if (context.principal_scope_fingerprint !== undefined) assertDigest(context.principal_scope_fingerprint);
  if (!/^[A-Za-z_][A-Za-z0-9_.:-]{0,255}$/.test(context.source_id)
    || !/^[A-Za-z_][A-Za-z0-9_.:-]{0,255}$/.test(context.workflow_session_id)) throw unavailable();
}

function subjectAuthority(
  registry: RuntimeActionRuleRegistryV1,
  resource: string,
): StoredObservedSubjectReference["outcome_authorities"] {
  return registry.rules
    .filter((activated) => activated.compiled.rule.subjects.some((subject) => subject.resource === resource))
    .map((activated) => ({
      outcome: activated.compiled.outcome,
      action_boundary_digest: activated.action_boundary_digest,
      action_rule_digest: activated.compiled.rule_digest,
    }))
    .sort((left, right) => left.outcome.localeCompare(right.outcome));
}

export function createSubjectReferenceService(input: {
  store: ProposalRuntimeStore;
  registry: RuntimeActionRuleRegistryV1 | (() => RuntimeActionRuleRegistryV1 | Promise<RuntimeActionRuleRegistryV1>);
  key: Uint8Array;
  ttl_seconds?: number;
  clock?: () => string;
  random_bytes?: (size: number) => Buffer;
}): SubjectReferenceService {
  if (!input.store.createObservedSubjectReference
    || !input.store.claimObservedSubjectReferences
    || !input.store.revokeObservedSubjectReferences) {
    throw new McpRuntimeError(
      "SUBJECT_REFERENCE_STORE_UNAVAILABLE",
      "The configured runtime store does not support durable observed subject references.",
    );
  }
  const createStoredSubject = input.store.createObservedSubjectReference.bind(input.store);
  const claimStoredSubjects = input.store.claimObservedSubjectReferences.bind(input.store);
  const revokeStoredSubjects = input.store.revokeObservedSubjectReferences.bind(input.store);
  const key = encryptionKey(rootKey(input.key));
  const configuredTtl = input.ttl_seconds ?? DEFAULT_SUBJECT_REFERENCE_TTL_SECONDS;
  if (!Number.isSafeInteger(configuredTtl) || configuredTtl < 30 || configuredTtl > MAX_SUBJECT_REFERENCE_TTL_SECONDS) {
    throw new McpRuntimeError(
      "SUBJECT_REFERENCE_TTL_INVALID",
      `Observed subject reference TTL must be from 30 through ${MAX_SUBJECT_REFERENCE_TTL_SECONDS} seconds.`,
    );
  }
  const randomBytes = input.random_bytes ?? crypto.randomBytes;
  const loadRegistry = async () => typeof input.registry === "function" ? await input.registry() : input.registry;

  return {
    async observationRequirement(resource) {
      return requirementsForRegistry(await loadRegistry()).get(resource);
    },

    async issue(request) {
      validateContext(request);
      if (!Array.isArray(request.observations) || request.observations.length > MAX_ISSUED_SUBJECTS) {
        throw unavailable();
      }
      const registry = await loadRegistry();
      const requirement = requirementsForRegistry(registry).get(request.resource);
      const outcomeAuthorities = subjectAuthority(registry, request.resource);
      if (!requirement || outcomeAuthorities.length === 0) return [];
      const issuedAt = canonicalTimestamp(request.now ?? input.clock?.());
      const authorityTtl = Math.min(...registry.rules
        .filter((activated) => outcomeAuthorities.some((authority) => authority.outcome === activated.compiled.outcome))
        .map((activated) => activated.compiled.ttl_seconds));
      const expiresAt = new Date(
        Date.parse(issuedAt) + Math.min(configuredTtl, authorityTtl) * 1_000,
      ).toISOString();
      const created: StoredObservedSubjectReference[] = [];
      try {
        for (const observation of request.observations) {
          if (!Number.isSafeInteger(observation.row_index) || observation.row_index < 0) throw unavailable();
          if (requirement.version_field !== undefined
            && (observation.observed_version_value === undefined || observation.observed_version_value === null)) {
            throw unavailable();
          }
          if (requirement.version_field === undefined && observation.observed_version_value !== undefined) {
            throw unavailable();
          }
          const subjectRef = `obj_${randomBytes(32).toString("base64url")}`;
          const metadata: SubjectReferenceImmutableMetadata = {
            schema_version: "synapsor.observed-subject-ref.v1",
            subject_ref: subjectRef,
            subject_ref_digest: canonicalJsonDigest({
              schema_version: "synapsor.observed-subject-ref.v1",
              subject_ref: subjectRef,
            }),
            source_id: request.source_id,
            resource: request.resource,
            evidence_bundle_id: request.evidence_bundle_id,
            read_boundary_digest: request.read_boundary_digest,
            generation_lock_fingerprint: request.generation_lock_fingerprint,
            tenant_scope_fingerprint: request.tenant_scope_fingerprint,
            ...(request.principal_scope_fingerprint === undefined
              ? {}
              : { principal_scope_fingerprint: request.principal_scope_fingerprint }),
            workflow_session_id: request.workflow_session_id,
            ...(observation.observed_version_value === undefined
              ? {}
              : {
                observed_version_digest: canonicalJsonDigest({
                  column: requirement.version_field,
                  value: scalar(observation.observed_version_value),
                }),
              }),
            outcome_authorities: outcomeAuthorities,
            issued_at: issuedAt,
            expires_at: expiresAt,
          };
          const payload: ProtectedSubjectPayloadV1 = {
            schema_version: PROTECTED_SUBJECT_VERSION,
            source_id: request.source_id,
            resource: request.resource,
            primary_key: {
              column: requirement.primary_key,
              value: scalar(observation.primary_key_value),
            },
            ...(observation.observed_version_value === undefined || requirement.version_field === undefined
              ? {}
              : {
                observed_version: {
                  column: requirement.version_field,
                  value: scalar(observation.observed_version_value),
                },
              }),
          };
          if (payload.primary_key.value === null) throw unavailable();
          const subject = await createStoredSubject({
            ...metadata,
            protected_identity: encryptIdentity(key, metadata, payload, randomBytes),
            state: "active",
          });
          created.push(subject);
        }
      } catch (error) {
        if (created.length > 0) {
          try {
            await revokeStoredSubjects({
              subject_refs: created.map((subject) => subject.subject_ref),
              now: issuedAt,
            });
          } catch {
            // Orphaned references were never returned and still expire normally.
          }
        }
        if (error instanceof McpRuntimeError) throw error;
        throw unavailable();
      }
      return created.map((subject, index) => ({
        row_index: request.observations[index]!.row_index,
        resource: subject.resource,
        ref: subject.subject_ref,
        expires_at: subject.expires_at,
      }));
    },

    async claim(request) {
      try {
        validateContext(request);
        const now = canonicalTimestamp(request.now ?? input.clock?.());
        const registry = await loadRegistry();
        const activated = resolveActivatedActionRule(registry, request.outcome);
        const expectedBindings = activated.compiled.rule.subjects.map((subject) => subject.binding).sort();
        const suppliedBindings = Object.keys(request.subject_refs).sort();
        if (canonicalJsonStringify(expectedBindings) !== canonicalJsonStringify(suppliedBindings)) throw unavailable();
        const orderedRefs = activated.compiled.rule.subjects.map((subject) => request.subject_refs[subject.binding]!);
        const requestDigest = canonicalJsonDigest({
          outcome: request.outcome,
          subject_refs: activated.compiled.rule.subjects.map((subject) => ({
            binding: subject.binding,
            ref: request.subject_refs[subject.binding],
          })),
          read_boundary_digest: request.read_boundary_digest,
          generation_lock_fingerprint: request.generation_lock_fingerprint,
          tenant_scope_fingerprint: request.tenant_scope_fingerprint,
          principal_scope_fingerprint: request.principal_scope_fingerprint ?? null,
          workflow_session_id: request.workflow_session_id,
        });
        const claimId = `request_${requestDigest.slice("sha256:".length)}`;
        const stored = await claimStoredSubjects({
          subject_refs: orderedRefs,
          claim_id: claimId,
          outcome: request.outcome,
          action_boundary_digest: activated.action_boundary_digest,
          action_rule_digest: activated.compiled.rule_digest,
          read_boundary_digest: request.read_boundary_digest,
          generation_lock_fingerprint: request.generation_lock_fingerprint,
          tenant_scope_fingerprint: request.tenant_scope_fingerprint,
          ...(request.principal_scope_fingerprint === undefined
            ? {}
            : { principal_scope_fingerprint: request.principal_scope_fingerprint }),
          workflow_session_id: request.workflow_session_id,
          now,
        });
        const byRef = new Map(stored.map((subject) => [subject.subject_ref, subject]));
        const claimedAt = stored[0]?.consumed_at;
        if (!claimedAt || stored.some((subject) => subject.consumed_at !== claimedAt)) throw unavailable();
        const subjects = activated.compiled.rule.subjects.map((subjectSpec) => {
          const storedSubject = byRef.get(request.subject_refs[subjectSpec.binding]!);
          const compiledBinding = activated.compiled.bindings.find((binding) => binding.binding === subjectSpec.binding);
          if (!storedSubject || !compiledBinding) throw unavailable();
          const payload = decryptIdentity(key, storedSubject);
          if (payload.source_id !== request.source_id
            || payload.resource !== subjectSpec.resource
            || storedSubject.source_id !== payload.source_id
            || storedSubject.resource !== payload.resource
            || payload.primary_key.column !== compiledBinding.resource.primary_key) throw unavailable();
          return {
            binding: subjectSpec.binding,
            resource: subjectSpec.resource,
            primary_key: payload.primary_key,
            subject_ref_digest: storedSubject.subject_ref_digest,
          } satisfies ActionRuleSubjectIdentityV1;
        });
        const evidence = activated.compiled.rule.subjects.map((subjectSpec) => {
          const storedSubject = byRef.get(request.subject_refs[subjectSpec.binding]!)!;
          return {
            binding: subjectSpec.binding,
            resource: subjectSpec.resource,
            subject_ref_digest: storedSubject.subject_ref_digest,
            evidence_bundle_id: storedSubject.evidence_bundle_id,
            observed_version_digest: storedSubject.observed_version_digest ?? null,
          };
        });
        return {
          activated,
          subjects,
          proposal_id: `wrp_rule_${requestDigest.slice("sha256:".length, "sha256:".length + 32)}`,
          claim_id: claimId,
          claimed_at: claimedAt,
          trusted_context_digest: canonicalJsonDigest({
            tenant_scope_fingerprint: request.tenant_scope_fingerprint,
            principal_scope_fingerprint: request.principal_scope_fingerprint ?? null,
            workflow_session_id: request.workflow_session_id,
          }),
          evidence_provenance_digest: canonicalJsonDigest(evidence),
        };
      } catch {
        throw unavailable();
      }
    },
  };
}
