import type {
  BoundaryResourceReviewRequest,
  BoundaryReviewMutationBindings,
} from "./boundary-review-mutation.js";
import { readAuthoringBindingsSchema } from "./control-policy-record.js";

type JsonRecord = Record<string, unknown>;

const DECISION_FILE_VERSION = "synapsor.boundary-review-decisions.v1";
const HASH_PATTERN = /^sha256:[a-f0-9]{64}$/;

export type BoundaryReviewDecisionFile = {
  schema_version: typeof DECISION_FILE_VERSION;
  review_bundle_digest: `sha256:${string}`;
  bindings: BoundaryReviewMutationBindings;
  actor: string;
  reason: string;
  resources: Array<Omit<BoundaryResourceReviewRequest, "actor" | "reason" | "decided_at"> & {
    reason?: string;
  }>;
};

export function parseBoundaryReviewDecisionFile(value: unknown): BoundaryReviewDecisionFile {
  const root = record(value, "boundary-review decision file");
  assertKeys(root, [
    "schema_version",
    "review_bundle_digest",
    "bindings",
    "actor",
    "reason",
    "resources",
  ], "boundary-review decision file");
  if (root.schema_version !== DECISION_FILE_VERSION) {
    throw new Error(`Boundary-review decision file must use ${DECISION_FILE_VERSION}.`);
  }
  const resources = array(root.resources, "resources");
  if (resources.length < 1 || resources.length > 500) {
    throw new Error("Boundary-review decision file must contain 1-500 resource decisions.");
  }
  return {
    schema_version: DECISION_FILE_VERSION,
    review_bundle_digest: hash(root.review_bundle_digest, "review_bundle_digest"),
    bindings: parseBindings(root.bindings),
    actor: text(root.actor, "actor", 128),
    reason: text(root.reason, "reason", 500),
    resources: resources.map((item, index) => parseResource(item, index)),
  };
}

export function boundaryReviewRequestsFromDecisionFile(
  file: BoundaryReviewDecisionFile,
): BoundaryResourceReviewRequest[] {
  return file.resources.map((resource) => {
    const { reason, ...request } = resource;
    return {
      ...request,
      actor: file.actor,
      reason: reason ?? file.reason,
    };
  });
}

/**
 * Strictly parse resource decisions supplied by another bounded authoring
 * surface. The caller owns the reviewer facts; JSON input cannot choose them.
 */
export function parseBoundaryReviewResources(input: unknown, reviewer: {
  actor: string;
  reason: string;
}): BoundaryResourceReviewRequest[] {
  const resources = array(input, "resources");
  if (resources.length > 500) {
    throw new Error("resources must contain at most 500 resource decisions.");
  }
  const actor = text(reviewer.actor, "reviewer.actor", 128);
  const reason = text(reviewer.reason, "reviewer.reason", 500);
  return resources.map((resource, index) => {
    const { reason: resourceReason, ...request } = parseResource(resource, index);
    return { ...request, actor, reason: resourceReason ?? reason };
  });
}

function parseBindings(value: unknown): BoundaryReviewMutationBindings {
  const input = record(value, "bindings");
  assertKeys(input, [
    "draft_digest",
    "candidate_digest",
    "generation_lock_fingerprint",
    "schema_fingerprint",
    "role_posture_fingerprint",
    "review_revision",
    "authoring",
  ], "bindings");
  if (!Number.isSafeInteger(input.review_revision) || Number(input.review_revision) < 0) {
    throw new Error("bindings.review_revision must be a non-negative integer.");
  }
  return {
    draft_digest: hash(input.draft_digest, "bindings.draft_digest"),
    candidate_digest: hash(input.candidate_digest, "bindings.candidate_digest"),
    generation_lock_fingerprint: hash(
      input.generation_lock_fingerprint,
      "bindings.generation_lock_fingerprint",
    ),
    schema_fingerprint: hash(input.schema_fingerprint, "bindings.schema_fingerprint"),
    role_posture_fingerprint: hash(
      input.role_posture_fingerprint,
      "bindings.role_posture_fingerprint",
    ),
    review_revision: Number(input.review_revision),
    ...(input.authoring === undefined ? {} : { authoring: readAuthoringBindingsSchema.parse(input.authoring) }),
  };
}

function parseResource(
  value: unknown,
  index: number,
): BoundaryReviewDecisionFile["resources"][number] {
  const label = `resources[${index}]`;
  const input = record(value, label);
  assertKeys(input, [
    "resource_id",
    "include",
    "exclude",
    "row_identity",
    "tenant_key",
    "tenant_scope_path",
    "shared_reference_scope",
    "principal_key",
    "principal_scope_path",
    "principal_rls_setting",
    "metadata",
    "field_metadata",
    "keep_out_fields",
    "withhold_from_model_fields",
    "private_model_fields",
    "preserve_unselected_fields",
    "allow_reviewed_fields",
    "selectable_fields",
    "filterable_fields",
    "sortable_fields",
    "groupable_fields",
    "allow_exact_numeric_grouping_fields",
    "remove_exact_numeric_grouping_fields",
    "aggregate_measures",
    "count_distinct_fields",
    "time_bucket_fields",
    "field_enum",
    "minimum_cohort_size",
    "relationship_ids",
    "nullable_relationship",
    "reason",
  ], label);
  const result: BoundaryReviewDecisionFile["resources"][number] = {
    resource_id: text(input.resource_id, `${label}.resource_id`, 256),
  };
  if (input.include !== undefined) result.include = bool(input.include, `${label}.include`);
  if (input.exclude !== undefined) result.exclude = bool(input.exclude, `${label}.exclude`);
  if (input.row_identity !== undefined) {
    result.row_identity = text(input.row_identity, `${label}.row_identity`, 256);
  }
  if (input.tenant_key !== undefined) {
    result.tenant_key = text(input.tenant_key, `${label}.tenant_key`, 256);
  }
  if (input.tenant_scope_path !== undefined) {
    result.tenant_scope_path = text(input.tenant_scope_path, `${label}.tenant_scope_path`, 256);
  }
  if (input.shared_reference_scope !== undefined) {
    if (input.shared_reference_scope !== "table_has_no_per_tenant_rows") {
      throw new Error(`${label}.shared_reference_scope must acknowledge table_has_no_per_tenant_rows.`);
    }
    result.shared_reference_scope = input.shared_reference_scope;
  }
  if (input.principal_key !== undefined) {
    result.principal_key = input.principal_key === null
      ? null
      : text(input.principal_key, `${label}.principal_key`, 256);
  }
  if (input.principal_scope_path !== undefined) {
    result.principal_scope_path = input.principal_scope_path === null
      ? null
      : text(input.principal_scope_path, `${label}.principal_scope_path`, 256);
  }
  if (input.principal_rls_setting !== undefined) {
    result.principal_rls_setting = input.principal_rls_setting === null
      ? null
      : text(input.principal_rls_setting, `${label}.principal_rls_setting`, 256);
  }
  if (input.metadata !== undefined) result.metadata = parseMetadata(input.metadata, `${label}.metadata`);
  if (input.field_metadata !== undefined) {
    const fields = array(input.field_metadata, `${label}.field_metadata`);
    if (fields.length > 500) throw new Error(`${label}.field_metadata must contain at most 500 entries.`);
    const seen = new Set<string>();
    result.field_metadata = fields.map((value, fieldIndex) => {
      const field = record(value, `${label}.field_metadata[${fieldIndex}]`);
      assertKeys(field, ["field", "label", "description"], `${label}.field_metadata[${fieldIndex}]`);
      const name = text(field.field, `${label}.field_metadata[${fieldIndex}].field`, 256);
      if (seen.has(name)) throw new Error(`${label}.field_metadata field names must be unique.`);
      seen.add(name);
      const { field: _field, ...metadata } = field;
      return { field: name, ...parseMetadata(metadata, `${label}.field_metadata[${fieldIndex}]`) };
    });
  }
  if (input.minimum_cohort_size !== undefined) {
    if (!Number.isSafeInteger(input.minimum_cohort_size)
      || Number(input.minimum_cohort_size) < 1
      || Number(input.minimum_cohort_size) > 5) {
      throw new Error(`${label}.minimum_cohort_size must be an integer from 1 through 5.`);
    }
    result.minimum_cohort_size = Number(input.minimum_cohort_size);
  }
  assignStringList(result, input, "keep_out_fields", label);
  assignStringList(result, input, "withhold_from_model_fields", label);
  assignStringList(result, input, "private_model_fields", label);
  assignStringList(result, input, "preserve_unselected_fields", label);
  assignStringList(result, input, "allow_reviewed_fields", label);
  assignStringList(result, input, "selectable_fields", label);
  assignStringList(result, input, "filterable_fields", label);
  assignStringList(result, input, "sortable_fields", label);
  assignStringList(result, input, "groupable_fields", label);
  assignStringList(result, input, "allow_exact_numeric_grouping_fields", label);
  assignStringList(result, input, "remove_exact_numeric_grouping_fields", label);
  assignStringList(result, input, "aggregate_measures", label);
  assignStringList(result, input, "count_distinct_fields", label);
  assignStringList(result, input, "time_bucket_fields", label);
  assignStringList(result, input, "relationship_ids", label);
  if (input.field_enum !== undefined) {
    const fieldEnum = record(input.field_enum, `${label}.field_enum`);
    assertKeys(fieldEnum, ["field", "values"], `${label}.field_enum`);
    const values = array(fieldEnum.values, `${label}.field_enum.values`)
      .map((value, valueIndex) => text(value, `${label}.field_enum.values[${valueIndex}]`, 64));
    if (values.length < 1 || values.length > 64 || new Set(values).size !== values.length
      || Buffer.byteLength(JSON.stringify(values), "utf8") > 2_048) {
      throw new Error(`${label}.field_enum.values must contain 1-64 unique bounded values.`);
    }
    result.field_enum = { field: text(fieldEnum.field, `${label}.field_enum.field`, 256), values };
  }
  if (input.nullable_relationship !== undefined) {
    const relationship = record(
      input.nullable_relationship,
      `${label}.nullable_relationship`,
    );
    assertKeys(
      relationship,
      ["relationship_id", "unmatched_rows"],
      `${label}.nullable_relationship`,
    );
    if (relationship.unmatched_rows !== "exclude" && relationship.unmatched_rows !== "keep_null") {
      throw new Error(`${label}.nullable_relationship.unmatched_rows must be exclude or keep_null.`);
    }
    result.nullable_relationship = {
      relationship_id: text(
        relationship.relationship_id,
        `${label}.nullable_relationship.relationship_id`,
        256,
      ),
      unmatched_rows: relationship.unmatched_rows,
    };
  }
  if (input.reason !== undefined) result.reason = text(input.reason, `${label}.reason`, 500);
  return result;
}

function assignStringList<
  Key extends "keep_out_fields" | "withhold_from_model_fields" | "allow_reviewed_fields" | "selectable_fields"
    | "private_model_fields" | "preserve_unselected_fields"
    | "filterable_fields" | "sortable_fields" | "groupable_fields"
    | "allow_exact_numeric_grouping_fields" | "remove_exact_numeric_grouping_fields"
    | "aggregate_measures" | "count_distinct_fields" | "time_bucket_fields"
    | "relationship_ids",
>(
  result: BoundaryReviewDecisionFile["resources"][number],
  input: JsonRecord,
  key: Key,
  label: string,
): void {
  if (input[key] === undefined) return;
  const values = array(input[key], `${label}.${key}`)
    .map((item, index) => text(item, `${label}.${key}[${index}]`, 256));
  if (values.length > 500 || new Set(values).size !== values.length) {
    throw new Error(`${label}.${key} must contain at most 500 unique field or relationship names.`);
  }
  result[key] = values;
}

function parseMetadata(value: unknown, label: string): { label?: string | null; description?: string | null } {
  const metadata = record(value, label);
  assertKeys(metadata, ["label", "description"], label);
  if (metadata.label === undefined && metadata.description === undefined) {
    throw new Error(`${label} requires label and/or description.`);
  }
  return {
    ...(metadata.label === undefined ? {} : { label: metadata.label === null ? null : text(metadata.label, `${label}.label`, 64) }),
    ...(metadata.description === undefined ? {} : { description: metadata.description === null ? null : text(metadata.description, `${label}.description`, 280) }),
  };
}

function record(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object.`);
  }
  return value as JsonRecord;
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be a JSON array.`);
  return value;
}

function text(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > maximum) {
    throw new Error(`${label} must be non-empty text of at most ${maximum} characters.`);
  }
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`${label} must not contain control characters.`);
  }
  return value.trim();
}

function bool(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} must be a boolean.`);
  return value;
}

function hash(value: unknown, label: string): `sha256:${string}` {
  if (typeof value !== "string" || !HASH_PATTERN.test(value)) {
    throw new Error(`${label} must be a lowercase sha256 digest.`);
  }
  return value as `sha256:${string}`;
}

function assertKeys(value: JsonRecord, allowed: string[], label: string): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length) {
    throw new Error(`${label} contains unsupported field(s): ${unknown.sort().join(", ")}.`);
  }
}
