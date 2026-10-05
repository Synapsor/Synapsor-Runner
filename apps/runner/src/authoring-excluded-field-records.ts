import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { rolePostureFingerprint, schemaFingerprintForInspection } from "@synapsor-runner/schema-inspector";
import type { PolicySourceInspection } from "./action-rule-source-evidence.js";
import type { ExplorationBoundaryDraft } from "./auto-boundary.js";

type Digest = `sha256:${string}`;
/** Metadata-transfer consent only. This establishes no business classification,
 * database-wide privacy, Read/Action grant, execution or publication. */
export type ExcludedFieldReviewBinding = {
  source_session: string; source_digest: Digest; destination: string;
  read_digest: Digest; actions_digest: Digest; action_review_digest: Digest | null;
  generation_lock_fingerprint: Digest; schema_fingerprint: Digest; role_posture_fingerprint: Digest;
};
export type ExcludedFieldReview = {
  binding: ExcludedFieldReviewBinding;
  fields: Array<{ resource: string; field: string }>;
  actor: "local_installation_operator"; confirmed_at: string; digest: Digest;
};
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const exact = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const hash = (value: unknown) => typeof value === "string" && /^sha256:[a-f0-9]{64}$/u.test(value);
const text = (value: unknown, max: number) => typeof value === "string" && !!value.trim() && value.length <= max && !/[\x00-\x1f\x7f]/u.test(value);
export function assertExcludedFieldReviews(value: unknown): asserts value is ExcludedFieldReview[] | undefined {
  if (value === undefined) return;
  const invalid = (): never => { throw new Error("EXCLUDED_FIELD_REVIEW_INVALID: Preserve the exact metadata-transfer history for inspection."); };
  if (!Array.isArray(value) || value.length > 64) invalid();
  for (const r of value as unknown[]) {
    if (!object(r) || !exact(r, ["binding", "fields", "actor", "confirmed_at", "digest"]) || !object(r.binding)
      || !exact(r.binding, ["source_session", "source_digest", "destination", "read_digest", "actions_digest", "action_review_digest",
        "generation_lock_fingerprint", "schema_fingerprint", "role_posture_fingerprint"])
      || !text(r.binding.source_session, 100) || !text(r.binding.destination, 1000)
      || ![r.binding.source_digest, r.binding.read_digest, r.binding.actions_digest, r.binding.generation_lock_fingerprint,
        r.binding.schema_fingerprint, r.binding.role_posture_fingerprint, r.digest].every(hash)
      || r.binding.action_review_digest !== null && !hash(r.binding.action_review_digest)
      || !Array.isArray(r.fields) || !r.fields.length || r.fields.length > 160
      || r.fields.some(f => !object(f) || !exact(f, ["resource", "field"]) || !text(f.resource, 256) || !text(f.field, 128))
      || new Set(r.fields.map(f => JSON.stringify(f))).size !== r.fields.length
      || r.actor !== "local_installation_operator" || !text(r.confirmed_at, 100) || !Number.isFinite(Date.parse(r.confirmed_at as string))) invalid();
    const { digest, ...body } = r as Record<string, unknown>;
    if (canonicalJsonDigest(body) !== digest) invalid();
  }
}
export function excludedFieldReviewBinding(input: {
  draft: { read: ExplorationBoundaryDraft; actions: readonly unknown[];
    runner_evidence: { action_revision: { review_record_digest: Digest } | null } }; source: PolicySourceInspection;
  sourceSession: string; sourceDigest: Digest; destination: string;
}): ExcludedFieldReviewBinding {
  const { draft, source } = input;
  const schema = schemaFingerprintForInspection(source.inspection), role = rolePostureFingerprint(source.inspection);
  if (canonicalJsonDigest(source.generationLock) !== draft.read.generation_lock_fingerprint
    || source.generationLock.engine !== source.inspection.engine || source.generationLock.schema_fingerprint !== schema
    || source.generationLock.role_posture_fingerprint !== role || draft.read.role_posture_fingerprint !== role)
    throw new Error("EXCLUDED_FIELD_METADATA_STALE: Inspect the exact current reader before reviewing field metadata.");
  return { source_session: input.sourceSession, source_digest: input.sourceDigest, destination: input.destination,
    read_digest: canonicalJsonDigest(draft.read), actions_digest: canonicalJsonDigest(draft.actions),
    action_review_digest: draft.runner_evidence.action_revision?.review_record_digest ?? null,
    generation_lock_fingerprint: draft.read.generation_lock_fingerprint, schema_fingerprint: schema, role_posture_fingerprint: role };
}
export function excludedFieldReview(binding: ExcludedFieldReviewBinding, fields: ExcludedFieldReview["fields"]): ExcludedFieldReview {
  const body = { binding: structuredClone(binding), fields: structuredClone(fields), actor: "local_installation_operator" as const,
    confirmed_at: new Date().toISOString() };
  const result = { ...body, digest: canonicalJsonDigest(body) };
  assertExcludedFieldReviews([result]);
  return result;
}
