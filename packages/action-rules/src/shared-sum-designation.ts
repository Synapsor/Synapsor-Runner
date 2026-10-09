import { canonicalJsonDigest, canonicalJsonStringify } from "@synapsor-runner/protocol";
import { ActionRuleError } from "./errors.js";

export const SHARED_SUM_DESIGNATION_VERSION = "synapsor.shared-sum-designation.v1" as const;
export const REVIEWED_SHARED_SUM_VERSION = "synapsor.reviewed-shared-sum.v1" as const;
type Digest = `sha256:${string}`;
type Field = { resource: string; field: string };

/** A proposed business meaning; this descriptor alone grants no protection. */
export type SharedSumDesignationV1 = {
  schema_version: typeof SHARED_SUM_DESIGNATION_VERSION;
  kind: "shared_sum";
  source: string;
  scope: { tenant_field: string; principal_field: string };
  limit: Field;
  populations: [Field, Field];
  unit: { kind: "integer"; unit: string; meaning: string };
  time: "current_state";
  external_writers: "participating_only";
};

/** Stored inside the existing Action authority. The publishing host verifies
 * the protected question and its confirmed exact proposal before accepting it;
 * parsing retained references cannot manufacture that operator decision. */
export type ReviewedSharedSumV1 = {
  schema_version: typeof REVIEWED_SHARED_SUM_VERSION;
  designation: SharedSumDesignationV1;
  confirmation: {
    actor: "local_installation_operator";
    decision: "new_attributed_decision";
    recorded_at: string;
    question: { id: string; revision: number; digest: Digest };
    proposal_digest: Digest;
    context_digest: Digest;
    source_digest: Digest;
    catalog_digest: Digest;
    generation_lock_fingerprint: Digest;
    read_dependencies: Array<{ name: string; digest: Digest }>;
    designation_digest: Digest;
  };
};

export function parseSharedSumDesignation(value: unknown): SharedSumDesignationV1 {
  const record = exact(value, ["schema_version", "kind", "source", "scope", "limit", "populations", "unit", "time", "external_writers"]);
  if (record.schema_version !== SHARED_SUM_DESIGNATION_VERSION || record.kind !== "shared_sum"
    || record.time !== "current_state" || record.external_writers !== "participating_only") invalid();
  const scope = exact(record.scope, ["tenant_field", "principal_field"]);
  const tenant = name(scope.tenant_field), principal = name(scope.principal_field);
  if (tenant === principal) invalid();
  const limit = field(record.limit);
  if (!Array.isArray(record.populations) || record.populations.length !== 2) invalid();
  const populations: [Field, Field] = [field(record.populations[0]), field(record.populations[1])];
  if (new Set([limit.resource, ...populations.map(item => item.resource)]).size !== 3) invalid();
  const unit = exact(record.unit, ["kind", "unit", "meaning"]);
  if (unit.kind !== "integer") invalid();
  return {
    schema_version: SHARED_SUM_DESIGNATION_VERSION, kind: "shared_sum", source: name(record.source),
    scope: { tenant_field: tenant, principal_field: principal }, limit, populations,
    unit: { kind: "integer", unit: text(unit.unit, 256), meaning: text(unit.meaning, 2000) },
    time: "current_state", external_writers: "participating_only",
  };
}

export function sharedSumDesignationDigest(value: SharedSumDesignationV1): Digest {
  return canonicalJsonDigest(parseSharedSumDesignation(value));
}

export function parseReviewedSharedSum(value: unknown): ReviewedSharedSumV1 {
  if (Buffer.byteLength(canonicalJsonStringify(value)) > 128 * 1024) invalid();
  const record = exact(value, ["schema_version", "designation", "confirmation"]);
  if (record.schema_version !== REVIEWED_SHARED_SUM_VERSION) invalid();
  const designation = parseSharedSumDesignation(record.designation);
  const confirmation = exact(record.confirmation, ["actor", "decision", "recorded_at", "question", "proposal_digest",
    "context_digest", "source_digest", "catalog_digest", "generation_lock_fingerprint", "read_dependencies", "designation_digest"]);
  if (confirmation.actor !== "local_installation_operator" || confirmation.decision !== "new_attributed_decision") invalid();
  const question = exact(confirmation.question, ["id", "revision", "digest"]);
  if (typeof question.id !== "string" || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(question.id)
    || !Number.isSafeInteger(question.revision) || (question.revision as number) < 1) invalid();
  if (!Array.isArray(confirmation.read_dependencies) || confirmation.read_dependencies.length < 1
    || confirmation.read_dependencies.length > 4096) invalid();
  const reads = confirmation.read_dependencies.map(value => {
    const read = exact(value, ["name", "digest"]);
    return { name: name(read.name), digest: digest(read.digest) };
  });
  if (new Set(reads.map(read => read.name)).size !== reads.length) invalid();
  const designationDigest = digest(confirmation.designation_digest);
  if (designationDigest !== canonicalJsonDigest(designation)) invalid();
  return {
    schema_version: REVIEWED_SHARED_SUM_VERSION, designation,
    confirmation: {
      actor: "local_installation_operator", decision: "new_attributed_decision", recorded_at: timestamp(confirmation.recorded_at),
      question: { id: question.id, revision: question.revision as number, digest: digest(question.digest) },
      proposal_digest: digest(confirmation.proposal_digest), context_digest: digest(confirmation.context_digest),
      source_digest: digest(confirmation.source_digest), catalog_digest: digest(confirmation.catalog_digest),
      generation_lock_fingerprint: digest(confirmation.generation_lock_fingerprint), read_dependencies: reads,
      designation_digest: designationDigest,
    },
  };
}

function field(value: unknown): Field {
  const record = exact(value, ["resource", "field"]);
  return { resource: name(record.resource), field: name(record.field) };
}
function exact(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || canonicalJsonStringify(Object.keys(value).sort()) !== canonicalJsonStringify([...keys].sort())) invalid();
  return value as Record<string, unknown>;
}
function text(value: unknown, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) invalid();
  return value;
}
function name(value: unknown): string {
  const result = text(value, 128);
  if (!/^[A-Za-z_][A-Za-z0-9_.:-]{0,127}$/u.test(result)) invalid();
  return result;
}
function digest(value: unknown): Digest {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(value)) invalid();
  return value as Digest;
}
function timestamp(value: unknown): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) invalid();
  return value;
}
function invalid(): never {
  throw new ActionRuleError("ACTION_RULE_INVALID", "The reviewed shared-SUM designation or confirmed provenance is invalid.", "authority.shared_sum");
}
