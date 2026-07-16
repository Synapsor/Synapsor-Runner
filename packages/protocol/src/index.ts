import crypto from "node:crypto";
import { z } from "zod";

type CanonicalJson = null | boolean | number | string | CanonicalJson[] | { [key: string]: CanonicalJson };

/** Serialize reviewed protocol data independently of object insertion order. */
export function canonicalJsonStringify(input: unknown): string {
  return JSON.stringify(canonicalJsonValue(input, new Set<object>()));
}

/** Hash reviewed protocol data with deterministic recursive object-key ordering. */
export function canonicalJsonDigest(input: unknown): `sha256:${string}` {
  return `sha256:${crypto.createHash("sha256").update(canonicalJsonStringify(input)).digest("hex")}`;
}

function canonicalJsonValue(input: unknown, ancestors: Set<object>): CanonicalJson {
  if (input === null || typeof input === "string" || typeof input === "boolean") return input;
  if (typeof input === "number") {
    if (!Number.isFinite(input)) throw new TypeError("canonical JSON accepts only finite numbers");
    return Object.is(input, -0) ? 0 : input;
  }
  if (Array.isArray(input)) {
    if (ancestors.has(input)) throw new TypeError("canonical JSON does not accept circular values");
    ancestors.add(input);
    const output = input.map((item) => canonicalJsonValue(item, ancestors));
    ancestors.delete(input);
    return output;
  }
  if (typeof input !== "object" || input === undefined) throw new TypeError("canonical JSON accepts only JSON values");
  const record = input as Record<string, unknown>;
  const prototype = Object.getPrototypeOf(record);
  if (prototype !== Object.prototype && prototype !== null) throw new TypeError("canonical JSON accepts only plain objects");
  if (ancestors.has(record)) throw new TypeError("canonical JSON does not accept circular values");
  ancestors.add(record);
  const output: Record<string, CanonicalJson> = {};
  for (const key of Object.keys(record).sort()) {
    const value = record[key];
    if (value === undefined) throw new TypeError("canonical JSON does not accept undefined values");
    output[key] = canonicalJsonValue(value, ancestors);
  }
  ancestors.delete(record);
  return output;
}

const scalar = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const scalarMap = z.record(scalar).refine((value) => Object.keys(value).length > 0, "object must not be empty");
const boundedScalarRecord = z.record(scalar).refine((value) => Object.keys(value).length <= 256, "object exceeds 256 fields");
const sha256 = z.string().regex(/^sha256:.+/, "expected sha256:<digest>");
const safeIdentifier = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "expected fixed safe identifier");

export const protocolVersions = {
  changeSet: "synapsor.change-set.v1",
  changeSetV2: "synapsor.change-set.v2",
  changeSetV3: "synapsor.change-set.v3",
  compensationChangeSet: "synapsor.compensation-change-set.v1",
  inverseDescriptor: "synapsor.inverse-descriptor.v1",
  writebackJob: "synapsor.writeback-job.v1",
  writebackJobV2: "synapsor.writeback-job.v2",
  writebackJobV3: "synapsor.writeback-job.v3",
  writebackJobV4: "synapsor.writeback-job.v4",
  executionReceipt: "synapsor.execution-receipt.v1",
  executionReceiptV2: "synapsor.execution-receipt.v2",
  executionReceiptV3: "synapsor.execution-receipt.v3",
  executionReceiptV4: "synapsor.execution-receipt.v4",
  runnerRegistration: "synapsor.runner-registration.v1",
  runnerControl: "synapsor.runner-control.v1",
  runnerProposal: "synapsor.runner-proposal.v1",
  runnerActivity: "synapsor.runner-activity.v1",
  legacyWritebackJob: "1.0",
  normalizedWritebackJobV2: "2.0",
  normalizedWritebackJobV3: "3.0",
  normalizedWritebackJobV4: "4.0",
} as const;

export const writebackEngineSchema = z.enum(["postgres", "mysql"]);
export const writebackTerminalStatusSchema = z.enum([
  "applied",
  "conflict",
  "failed",
  "canceled",
  "already_applied"
]);
export const writebackTerminalStatusV2Schema = z.enum([
  "applied",
  "conflict",
  "failed",
  "canceled",
  "already_applied",
  "reconciliation_required",
]);

const columnValueSchema = z.object({
  column: safeIdentifier,
  value: scalar
});

const resolvedDeduplicationComponentSchema = z.object({
  column: safeIdentifier,
  value: scalar,
  source: z.enum(["proposal_id", "trusted_tenant", "fixed"]),
});

const versionAdvanceSchema = z.object({
  column: safeIdentifier,
  strategy: z.enum(["integer_increment", "database_generated"]),
});

const setOperationSchema = z.enum(["set_update", "set_delete", "batch_insert"]);
const aggregateBoundSchema = z.object({
  column: safeIdentifier,
  measure: z.enum(["before", "after", "absolute_delta"]),
  maximum: z.number().finite().nonnegative(),
  actual: z.number().finite().nonnegative(),
});
const frozenSetMemberSchema = z.object({
  primary_key: columnValueSchema,
  expected_version: columnValueSchema.optional(),
  before: boundedScalarRecord,
  after: boundedScalarRecord,
  before_digest: sha256.optional(),
  after_digest: sha256.optional(),
  tombstone_digest: sha256.optional(),
  deduplication: z.object({ components: z.array(resolvedDeduplicationComponentSchema).min(1).max(8) }).optional(),
});
const frozenSetSchema = z.object({
  max_rows: z.number().int().min(1).max(100),
  row_count: z.number().int().min(1).max(100),
  aggregate_bounds: z.array(aggregateBoundSchema).min(1).max(8),
  members: z.array(frozenSetMemberSchema).min(1).max(100),
  set_digest: sha256,
}).superRefine((set, ctx) => {
  if (set.members.length !== set.row_count || set.row_count > set.max_rows) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "frozen set count must equal members and remain within max_rows", path: ["row_count"] });
  for (const [index, bound] of set.aggregate_bounds.entries()) if (bound.actual > bound.maximum) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "frozen set aggregate exceeds reviewed maximum", path: ["aggregate_bounds", index, "actual"] });
  const identities = set.members.map((member) => JSON.stringify(member.primary_key.value));
  if (new Set(identities).size !== identities.length) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "frozen set primary keys must be unique", path: ["members"] });
  if (identities.some((value, index) => index > 0 && identities[index - 1]!.localeCompare(value) > 0)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "frozen set members must use deterministic primary-key ordering", path: ["members"] });
});

const reversalOperationSchema = z.enum(["restore_update", "remove_insert", "restore_insert"]);
const reversalLineageSchema = z.object({
  root_proposal_id: z.string().min(1),
  parent_proposal_id: z.string().min(1),
  reverts_proposal_id: z.string().min(1),
  depth: z.number().int().min(1).max(16),
});
const inverseMemberSchema = z.object({
  primary_key: columnValueSchema,
  expected_state: boundedScalarRecord,
  restore_values: boundedScalarRecord.optional(),
});
export const inverseDescriptorV1Schema = z.object({
  schema_version: z.literal(protocolVersions.inverseDescriptor),
  availability: z.enum(["available", "best_effort_unavailable"]),
  reason_codes: z.array(z.string().regex(/^[A-Z][A-Z0-9_]*$/)).max(8).default([]),
  operation: reversalOperationSchema,
  cardinality: z.enum(["single", "set"]),
  forward_proposal_id: z.string().min(1),
  forward_writeback_job_id: z.string().min(1),
  target: z.object({
    source_id: z.string().min(1),
    schema: safeIdentifier,
    table: safeIdentifier,
    primary_key_column: safeIdentifier,
  }),
  tenant_guard: columnValueSchema,
  allowed_columns: z.array(safeIdentifier).max(256),
  members: z.array(inverseMemberSchema).min(1).max(100),
  max_rows: z.number().int().min(1).max(100),
  aggregate_bounds: z.array(aggregateBoundSchema).max(8).default([]),
  version_advance: versionAdvanceSchema.optional(),
  lineage: reversalLineageSchema,
}).superRefine((descriptor, ctx) => {
  if (descriptor.members.length > descriptor.max_rows) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "inverse members exceed max_rows", path: ["members"] });
  const identities = descriptor.members.map((member) => JSON.stringify(member.primary_key.value));
  if (new Set(identities).size !== identities.length) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "inverse primary keys must be unique", path: ["members"] });
  if (identities.some((value, index) => index > 0 && identities[index - 1]!.localeCompare(value) > 0)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "inverse members must use deterministic primary-key ordering", path: ["members"] });
  for (const [index, member] of descriptor.members.entries()) {
    if (member.primary_key.column !== descriptor.target.primary_key_column) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "inverse member primary key must match target", path: ["members", index, "primary_key", "column"] });
    if (descriptor.availability === "available" && descriptor.operation === "restore_update" && (!member.restore_values || Object.keys(member.restore_values).length === 0 || Object.keys(member.expected_state).length === 0)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "restore_update requires expected state and restore values", path: ["members", index] });
    if (descriptor.availability === "available" && descriptor.operation === "remove_insert" && (member.restore_values !== undefined || Object.keys(member.expected_state).length === 0)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "remove_insert requires expected state and no restore values", path: ["members", index] });
    if (descriptor.availability === "available" && descriptor.operation === "restore_insert" && (!member.restore_values || Object.keys(member.restore_values).length === 0 || Object.keys(member.expected_state).length !== 0)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "restore_insert requires an absent expected state and exact restore values", path: ["members", index] });
  }
  if (descriptor.operation === "restore_update" && (!descriptor.version_advance || descriptor.version_advance.strategy !== "integer_increment")) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "restore_update requires integer version advancement", path: ["version_advance"] });
  if (descriptor.operation !== "restore_update" && descriptor.version_advance) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "version advancement is valid only for restore_update", path: ["version_advance"] });
  if (descriptor.availability === "available" && descriptor.reason_codes.length) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "available inverse must not carry unavailability reasons", path: ["reason_codes"] });
  if (descriptor.availability === "best_effort_unavailable" && descriptor.reason_codes.length === 0) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "unavailable inverse requires specific reason codes", path: ["reason_codes"] });
});

const reversibilityRequestSchema = z.object({
  mode: z.literal("reviewed_inverse"),
  lineage: reversalLineageSchema,
});

const contractProvenanceSchema = z.object({
  digest: sha256,
  version: z.string().min(1).max(128),
});

export const changeSetV1Schema = z.object({
  schema_version: z.literal(protocolVersions.changeSet),
  proposal_id: z.string().min(1),
  proposal_version: z.number().int().positive(),
  action: z.string().min(1),
  contract: contractProvenanceSchema.optional(),
  mode: z.enum(["read_only", "shadow", "review_required", "approved_for_writeback"]),
  principal: z.object({
    id: z.string().min(1),
    source: z.enum(["trusted_session", "cloud_session", "environment", "static_dev"])
  }),
  scope: z.object({
    tenant_id: z.string().min(1),
    business_object: z.string().min(1),
    object_id: z.string().min(1)
  }),
  source: z.object({
    kind: z.enum(["external_postgres", "external_mysql", "synapsor_table"]),
    source_id: z.string().min(1),
    schema: z.string().min(1),
    table: z.string().min(1),
    primary_key: columnValueSchema
  }),
  before: scalarMap,
  patch: scalarMap,
  after: scalarMap,
  guards: z.object({
    tenant: columnValueSchema,
    allowed_columns: z.array(z.string().min(1)).min(1),
    expected_version: columnValueSchema
  }),
  evidence: z.object({
    bundle_id: z.string().min(1),
    query_fingerprint: sha256,
    items: z.array(z.unknown())
  }).passthrough(),
  approval: z.object({
    status: z.enum(["pending", "approved", "rejected", "canceled"]),
    required_role: z.string().optional(),
    required_approvals: z.number().int().min(1).max(10).optional()
  }).passthrough(),
  writeback: z.object({
    status: z.enum(["not_applied", "pending_worker", "applied", "conflict", "failed", "canceled"]),
    mode: z.enum(["trusted_worker_required", "synapsor_merge", "read_only"])
  }).passthrough(),
  source_database_mutated: z.boolean(),
  integrity: z.object({
    proposal_hash: sha256
  }),
  created_at: z.string().min(1)
}).superRefine((changeSet, ctx) => {
  const allowed = new Set(changeSet.guards.allowed_columns);
  for (const column of Object.keys(changeSet.patch)) {
    if (!allowed.has(column)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `patch column not allowed: ${column}`,
        path: ["patch", column]
      });
    }
  }
  if (allowed.has(changeSet.source.primary_key.column)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "primary key column must not be patch-allowlisted",
      path: ["guards", "allowed_columns"]
    });
  }
  if (allowed.has(changeSet.guards.tenant.column)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "tenant guard column must not be patch-allowlisted",
      path: ["guards", "allowed_columns"]
    });
  }
});

export const changeSetV2Schema = z.object({
  schema_version: z.literal(protocolVersions.changeSetV2),
  proposal_id: z.string().min(1),
  proposal_version: z.number().int().positive(),
  action: z.string().min(1),
  contract: contractProvenanceSchema.optional(),
  operation: z.enum(["single_row_update", "single_row_insert", "single_row_delete"]),
  mode: z.enum(["read_only", "shadow", "review_required", "approved_for_writeback"]),
  principal: z.object({
    id: z.string().min(1),
    source: z.enum(["trusted_session", "cloud_session", "environment", "static_dev"]),
  }),
  scope: z.object({
    tenant_id: z.string().min(1),
    business_object: z.string().min(1),
    object_id: z.string().min(1),
  }),
  source: z.object({
    kind: z.enum(["external_postgres", "external_mysql", "synapsor_table"]),
    source_id: z.string().min(1),
    schema: safeIdentifier,
    table: safeIdentifier,
    primary_key: z.object({ column: safeIdentifier, value: scalar.optional() }),
  }),
  before: boundedScalarRecord,
  patch: boundedScalarRecord,
  after: boundedScalarRecord,
  guards: z.object({
    tenant: columnValueSchema,
    allowed_columns: z.array(safeIdentifier).max(256),
    expected_version: columnValueSchema.optional(),
    version_advance: versionAdvanceSchema.optional(),
    deduplication: z.object({ components: z.array(resolvedDeduplicationComponentSchema).min(1).max(8) }).optional(),
  }),
  reversibility: reversibilityRequestSchema.optional(),
  evidence: z.object({
    bundle_id: z.string().min(1),
    query_fingerprint: sha256,
    items: z.array(z.unknown()).max(1_000),
  }).passthrough(),
  approval: z.object({
    status: z.enum(["pending", "approved", "rejected", "canceled"]),
    required_role: z.string().optional(),
    required_approvals: z.number().int().min(1).max(10).optional(),
  }).passthrough(),
  writeback: z.object({
    status: z.enum(["not_applied", "pending_worker", "applied", "conflict", "failed", "canceled", "reconciliation_required"]),
    mode: z.enum(["trusted_worker_required", "synapsor_merge", "read_only"]),
  }).passthrough(),
  source_database_mutated: z.boolean(),
  integrity: z.object({ proposal_hash: sha256 }),
  created_at: z.string().min(1),
}).superRefine((changeSet, ctx) => {
  const allowed = new Set(changeSet.guards.allowed_columns);
  for (const column of Object.keys(changeSet.patch)) {
    if (!allowed.has(column)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `patch column not allowed: ${column}`, path: ["patch", column] });
  }
  if (allowed.has(changeSet.source.primary_key.column)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "primary key column must not be patch-allowlisted", path: ["guards", "allowed_columns"] });
  if (allowed.has(changeSet.guards.tenant.column)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "tenant guard column must not be patch-allowlisted", path: ["guards", "allowed_columns"] });

  if (changeSet.operation === "single_row_insert") {
    if (Object.keys(changeSet.before).length !== 0) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "INSERT before must be empty", path: ["before"] });
    if (!changeSet.guards.deduplication) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "INSERT requires source-enforced deduplication", path: ["guards", "deduplication"] });
    else {
      if (!changeSet.guards.deduplication.components.some((component) => component.source === "proposal_id")) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "INSERT deduplication requires proposal identity", path: ["guards", "deduplication", "components"] });
      }
      if (!changeSet.guards.deduplication.components.some((component) => component.source === "trusted_tenant" && component.column === changeSet.guards.tenant.column && component.value === changeSet.guards.tenant.value)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "INSERT deduplication requires the trusted tenant guard", path: ["guards", "deduplication", "components"] });
      }
    }
    if (changeSet.guards.expected_version || changeSet.guards.version_advance) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "INSERT must not declare version guards", path: ["guards"] });
  } else {
    if (Object.keys(changeSet.before).length === 0) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "UPDATE and DELETE require reviewed before data", path: ["before"] });
    if (!changeSet.source.primary_key.value) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "UPDATE and DELETE require a primary-key value", path: ["source", "primary_key", "value"] });
    if (!changeSet.guards.expected_version) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "UPDATE and DELETE require an exact version guard", path: ["guards", "expected_version"] });
    if (changeSet.guards.deduplication) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "deduplication is only valid for INSERT", path: ["guards", "deduplication"] });
  }
  if (changeSet.operation === "single_row_update") {
    if (Object.keys(changeSet.patch).length === 0) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "UPDATE patch must not be empty", path: ["patch"] });
    if (Object.keys(changeSet.after).length === 0) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "UPDATE after must not be empty", path: ["after"] });
  }
  if (changeSet.operation === "single_row_delete") {
    if (Object.keys(changeSet.patch).length !== 0 || Object.keys(changeSet.after).length !== 0 || changeSet.guards.allowed_columns.length !== 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "DELETE has no patch, after row, or writable columns", path: ["patch"] });
    }
    if (changeSet.guards.version_advance) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "DELETE must not advance a version", path: ["guards", "version_advance"] });
  }
});

export const changeSetV3Schema = z.object({
  schema_version: z.literal(protocolVersions.changeSetV3),
  proposal_id: z.string().min(1),
  proposal_version: z.number().int().positive(),
  action: z.string().min(1),
  contract: contractProvenanceSchema.optional(),
  operation: setOperationSchema,
  mode: z.enum(["read_only", "shadow", "review_required", "approved_for_writeback"]),
  principal: z.object({
    id: z.string().min(1),
    source: z.enum(["trusted_session", "cloud_session", "environment", "static_dev"]),
  }),
  scope: z.object({ tenant_id: z.string().min(1), business_object: z.string().min(1), object_id: z.string().min(1) }),
  source: z.object({
    kind: z.enum(["external_postgres", "external_mysql", "synapsor_table"]),
    source_id: z.string().min(1),
    schema: safeIdentifier,
    table: safeIdentifier,
    primary_key: z.object({ column: safeIdentifier, value: scalar.optional() }),
  }),
  before: boundedScalarRecord,
  patch: boundedScalarRecord,
  after: boundedScalarRecord,
  guards: z.object({
    tenant: columnValueSchema,
    allowed_columns: z.array(safeIdentifier).max(256),
    expected_version: columnValueSchema.optional(),
    version_advance: versionAdvanceSchema.optional(),
  }),
  frozen_set: frozenSetSchema,
  reversibility: reversibilityRequestSchema.optional(),
  evidence: z.object({ bundle_id: z.string().min(1), query_fingerprint: sha256, items: z.array(z.unknown()).max(100) }).passthrough(),
  approval: z.object({
    status: z.enum(["pending", "approved", "rejected", "canceled"]),
    mode: z.enum(["human", "operator"]),
    required_role: z.string().min(1).optional(),
    required_approvals: z.number().int().min(1).max(10).optional(),
  }).passthrough(),
  writeback: z.object({ status: z.enum(["not_applied", "pending_worker", "applied", "conflict", "failed", "canceled", "reconciliation_required"]), mode: z.literal("trusted_worker_required"), executor: z.literal("sql_update") }).passthrough(),
  source_database_mutated: z.boolean(),
  integrity: z.object({ proposal_hash: sha256 }),
  created_at: z.string().min(1),
}).superRefine((changeSet, ctx) => {
  if (changeSet.source.primary_key.value !== undefined || changeSet.guards.expected_version) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "set guards live on frozen members, not the top-level envelope", path: ["frozen_set"] });
  const allowed = new Set(changeSet.guards.allowed_columns);
  for (const column of Object.keys(changeSet.patch)) if (!allowed.has(column)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `patch column not allowed: ${column}`, path: ["patch", column] });
  for (const [index, member] of changeSet.frozen_set.members.entries()) {
    if (member.primary_key.column !== changeSet.source.primary_key.column) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "member primary key column must match source", path: ["frozen_set", "members", index, "primary_key", "column"] });
    if (changeSet.operation === "set_update") {
      if (!member.expected_version || !member.before_digest || !member.after_digest || member.tombstone_digest || member.deduplication) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "set UPDATE members require version and before/after digests", path: ["frozen_set", "members", index] });
    } else if (changeSet.operation === "set_delete") {
      if (!member.expected_version || !member.before_digest || !member.tombstone_digest || Object.keys(member.after).length || member.after_digest || member.deduplication) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "set DELETE members require version and tombstone", path: ["frozen_set", "members", index] });
    } else if (member.expected_version || Object.keys(member.before).length || member.before_digest || !member.after_digest || !member.deduplication) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "batch INSERT members require exact after data and deduplication", path: ["frozen_set", "members", index] });
    }
  }
  if (changeSet.operation !== "set_update" && changeSet.guards.version_advance) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "version advance is valid only for set UPDATE", path: ["guards", "version_advance"] });
  if (changeSet.operation === "set_delete" && changeSet.guards.allowed_columns.length) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "set DELETE has no allowed write columns", path: ["guards", "allowed_columns"] });
});

export const compensationChangeSetV1Schema = z.object({
  schema_version: z.literal(protocolVersions.compensationChangeSet),
  proposal_id: z.string().min(1),
  proposal_version: z.number().int().positive(),
  action: z.string().min(1),
  contract: contractProvenanceSchema.optional(),
  mode: z.literal("review_required"),
  principal: z.object({
    id: z.string().min(1),
    source: z.enum(["trusted_session", "cloud_session", "environment", "static_dev"]),
  }),
  scope: z.object({ tenant_id: z.string().min(1), business_object: z.string().min(1), object_id: z.string().min(1) }),
  source: z.object({
    kind: z.enum(["external_postgres", "external_mysql"]),
    source_id: z.string().min(1),
    schema: safeIdentifier,
    table: safeIdentifier,
    primary_key: z.object({ column: safeIdentifier, value: scalar.optional() }),
  }),
  before: boundedScalarRecord,
  patch: boundedScalarRecord,
  after: boundedScalarRecord,
  compensation: z.object({
    descriptor: inverseDescriptorV1Schema,
    forward_receipt_hash: sha256,
  }),
  guards: z.object({ tenant: columnValueSchema, allowed_columns: z.array(safeIdentifier).max(256) }),
  evidence: z.object({ bundle_id: z.string().min(1), query_fingerprint: sha256, items: z.array(z.unknown()).max(100) }).passthrough(),
  approval: z.object({
    status: z.enum(["pending", "approved", "rejected", "canceled"]),
    mode: z.enum(["human", "operator"]),
    required_role: z.string().min(1).optional(),
    required_approvals: z.number().int().min(1).max(10).optional(),
  }).passthrough(),
  writeback: z.object({ status: z.literal("not_applied"), mode: z.literal("trusted_worker_required"), executor: z.literal("sql_update") }),
  source_database_mutated: z.literal(false),
  integrity: z.object({ proposal_hash: sha256 }),
  created_at: z.string().min(1),
}).superRefine((changeSet, ctx) => {
  const descriptor = changeSet.compensation.descriptor;
  if (descriptor.availability !== "available") ctx.addIssue({ code: z.ZodIssueCode.custom, message: "compensation proposal requires an available inverse", path: ["compensation", "descriptor", "availability"] });
  if (descriptor.target.source_id !== changeSet.source.source_id || descriptor.target.schema !== changeSet.source.schema || descriptor.target.table !== changeSet.source.table || descriptor.target.primary_key_column !== changeSet.source.primary_key.column) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "compensation descriptor target must match proposal source", path: ["compensation", "descriptor", "target"] });
  if (descriptor.tenant_guard.column !== changeSet.guards.tenant.column || descriptor.tenant_guard.value !== changeSet.guards.tenant.value || descriptor.tenant_guard.value !== changeSet.scope.tenant_id) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "compensation tenant authority must match trusted proposal scope", path: ["guards", "tenant"] });
  if (JSON.stringify(descriptor.allowed_columns) !== JSON.stringify(changeSet.guards.allowed_columns)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "compensation allowlist must match inverse descriptor", path: ["guards", "allowed_columns"] });
});

const publicConflictGuardSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("column"), column: safeIdentifier, expected_value: scalar }),
  z.object({ kind: z.literal("row_hash"), expected_hash: z.string().min(1) }),
  z.object({ kind: z.literal("none") })
]);

const leasedContractRefSchema = z.object({
  contract_id: z.string().min(1),
  contract_version_id: z.string().min(1),
  digest: sha256,
});

export const writebackJobV1Schema = z.object({
  schema_version: z.literal(protocolVersions.writebackJob),
  writeback_job_id: z.string().min(1),
  proposal_id: z.string().min(1),
  proposal_version: z.number().int().positive(),
  proposal_hash: sha256,
  runner_scope: z.object({
    project_id: z.string().min(1),
    source_id: z.string().min(1)
  }),
  engine: writebackEngineSchema,
  operation: z.literal("single_row_update"),
  target: z.object({
    schema: safeIdentifier,
    table: safeIdentifier,
    primary_key: columnValueSchema
  }),
  tenant_guard: columnValueSchema,
  allowed_columns: z.array(safeIdentifier).min(1),
  patch: scalarMap,
  conflict_guard: publicConflictGuardSchema,
  idempotency_key: z.string().min(1),
  lease: z.object({
    lease_id: z.string().min(1),
    attempt: z.number().int().positive(),
    expires_at: z.string().min(1)
  })
}).superRefine((job, ctx) => {
  validateAllowedPatchColumns(job.allowed_columns, Object.keys(job.patch), job.target.primary_key.column, job.tenant_guard.column, ctx);
});

const normalizedWritebackJobV1Schema = writebackJobV1Schema.transform((job) => ({
  protocol_version: protocolVersions.legacyWritebackJob,
  job_id: job.writeback_job_id,
  proposal_id: job.proposal_id,
  approval_id: job.proposal_hash,
  source_id: job.runner_scope.source_id,
  engine: job.engine,
  operation: "single_row_update" as const,
  target: {
    schema: job.target.schema,
    table: job.target.table,
    primary_key: job.target.primary_key,
    tenant_guard: job.tenant_guard
  },
  allowed_columns: job.allowed_columns,
  patch: job.patch,
  conflict_guard: normalizeConflictGuard(job.conflict_guard),
  idempotency_key: job.idempotency_key,
  lease_expires_at: job.lease.expires_at,
  attempt_count: job.lease.attempt
}));

export const legacyWritebackJobSchema = z.object({
  protocol_version: z.literal(protocolVersions.legacyWritebackJob),
  job_id: z.string().min(1),
  proposal_id: z.string().min(1),
  approval_id: z.string().min(1),
  contract: leasedContractRefSchema.optional(),
  source_id: z.string().min(1),
  engine: writebackEngineSchema,
  operation: z.literal("single_row_update").optional(),
  target: z.object({
    schema: safeIdentifier,
    table: safeIdentifier,
    primary_key: z.object({
      column: safeIdentifier,
      value: scalar
    }),
    tenant_guard: z.object({
      column: safeIdentifier,
      value: scalar
    })
  }),
  allowed_columns: z.array(safeIdentifier).min(1),
  patch: scalarMap,
  conflict_guard: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("version_column"), column: z.string().min(1), expected_value: scalar }),
    z.object({ kind: z.literal("row_hash"), expected_hash: z.string().min(1) }),
    z.object({ kind: z.literal("none") })
  ]),
  idempotency_key: z.string().min(1),
  lease_expires_at: z.union([z.string(), z.number()]),
  attempt_count: z.number().int().nonnegative().optional()
}).superRefine((job, ctx) => {
  validateAllowedPatchColumns(job.allowed_columns, Object.keys(job.patch), job.target.primary_key.column, job.target.tenant_guard.column, ctx);
});

export const normalizedWritebackJobV2InputSchema = z.object({
  protocol_version: z.literal(protocolVersions.normalizedWritebackJobV2),
  job_id: z.string().min(1),
  proposal_id: z.string().min(1),
  approval_id: sha256,
  contract: leasedContractRefSchema.optional(),
  source_id: z.string().min(1),
  engine: writebackEngineSchema,
  operation: z.enum(["single_row_update", "single_row_insert", "single_row_delete"]),
  target: z.object({
    schema: safeIdentifier,
    table: safeIdentifier,
    primary_key: z.object({ column: safeIdentifier, value: scalar.optional() }),
    tenant_guard: columnValueSchema,
  }),
  allowed_columns: z.array(safeIdentifier).max(256),
  patch: boundedScalarRecord,
  conflict_guard: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("version_column"), column: safeIdentifier, expected_value: scalar }),
    z.object({ kind: z.literal("row_hash"), expected_hash: z.string().min(1) }),
    z.object({ kind: z.literal("none") }),
  ]),
  version_advance: versionAdvanceSchema.optional(),
  deduplication: z.object({ components: z.array(resolvedDeduplicationComponentSchema).min(1).max(8) }).optional(),
  idempotency_key: z.string().min(1),
  lease_expires_at: z.union([z.string(), z.number()]),
  attempt_count: z.number().int().positive(),
  inverse_capture: inverseDescriptorV1Schema.optional(),
}).superRefine((job, ctx) => {
  if (job.operation !== "single_row_insert" && job.target.primary_key.value === undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "UPDATE and DELETE require a primary-key value", path: ["target", "primary_key", "value"] });
  }
  if (job.operation === "single_row_update" || job.operation === "single_row_insert") {
    validateAllowedPatchColumns(job.allowed_columns, Object.keys(job.patch), job.target.primary_key.column, job.target.tenant_guard.column, ctx);
    if (Object.keys(job.patch).length === 0) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${job.operation} patch must not be empty`, path: ["patch"] });
  } else if (job.allowed_columns.length !== 0 || Object.keys(job.patch).length !== 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "DELETE must not allow or carry write columns", path: ["allowed_columns"] });
  }
  if (job.operation === "single_row_update") {
    if (job.deduplication) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "deduplication is only valid for INSERT", path: ["deduplication"] });
    if (job.version_advance && (job.conflict_guard.kind !== "version_column" || job.version_advance.column !== job.conflict_guard.column)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "version advance must match the version conflict guard", path: ["version_advance", "column"] });
    }
  }
  if (job.operation === "single_row_insert") {
    if (!job.deduplication) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "INSERT requires source-enforced deduplication", path: ["deduplication"] });
    } else {
      validateResolvedDeduplication(job.deduplication.components, job.patch, job.target.tenant_guard, ctx, ["deduplication", "components"]);
    }
    if (job.conflict_guard.kind !== "none" || job.version_advance) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "INSERT must not declare version guards", path: ["conflict_guard"] });
  }
  if (job.operation === "single_row_delete" && (job.conflict_guard.kind !== "version_column" || job.version_advance || job.deduplication)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "DELETE requires only an exact version-column guard", path: ["conflict_guard"] });
  }
});

const writebackMutationV2Schema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("single_row_update"),
    values: scalarMap,
    conflict_guard: publicConflictGuardSchema,
    version_advance: versionAdvanceSchema.optional(),
  }),
  z.object({
    kind: z.literal("single_row_insert"),
    values: scalarMap,
    deduplication: z.object({ components: z.array(resolvedDeduplicationComponentSchema).min(1).max(8) }),
  }),
  z.object({
    kind: z.literal("single_row_delete"),
    conflict_guard: z.object({ kind: z.literal("column"), column: safeIdentifier, expected_value: scalar }),
  }),
]);

export const writebackJobV2Schema = z.object({
  schema_version: z.literal(protocolVersions.writebackJobV2),
  writeback_job_id: z.string().min(1),
  proposal_id: z.string().min(1),
  proposal_version: z.number().int().positive(),
  proposal_hash: sha256,
  runner_scope: z.object({
    project_id: z.string().min(1),
    source_id: z.string().min(1),
  }),
  engine: writebackEngineSchema,
  target: z.object({
    schema: safeIdentifier,
    table: safeIdentifier,
    primary_key: z.object({ column: safeIdentifier, value: scalar.optional() }),
  }),
  tenant_guard: columnValueSchema,
  allowed_columns: z.array(safeIdentifier),
  mutation: writebackMutationV2Schema,
  idempotency_key: z.string().min(1),
  inverse_capture: inverseDescriptorV1Schema.optional(),
  lease: z.object({
    lease_id: z.string().min(1),
    attempt: z.number().int().positive(),
    expires_at: z.string().min(1),
  }),
}).superRefine((job, ctx) => {
  const mutation = job.mutation;
  if (mutation.kind !== "single_row_insert" && job.target.primary_key.value === undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "UPDATE and DELETE require a primary-key value", path: ["target", "primary_key", "value"] });
  }
  if (mutation.kind === "single_row_update" || mutation.kind === "single_row_insert") {
    validateAllowedPatchColumns(job.allowed_columns, Object.keys(mutation.values), job.target.primary_key.column, job.tenant_guard.column, ctx);
  } else if (job.allowed_columns.length !== 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "DELETE must not allow write columns", path: ["allowed_columns"] });
  }
  if (mutation.kind === "single_row_update" && mutation.version_advance) {
    if (mutation.conflict_guard.kind !== "column" || mutation.version_advance.column !== mutation.conflict_guard.column) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "version advance must match the column conflict guard", path: ["mutation", "version_advance", "column"] });
    }
  }
  if (mutation.kind === "single_row_insert") {
    validateResolvedDeduplication(mutation.deduplication.components, mutation.values, job.tenant_guard, ctx, ["mutation", "deduplication", "components"]);
  }
}).transform((job) => ({
  protocol_version: protocolVersions.normalizedWritebackJobV2,
  job_id: job.writeback_job_id,
  proposal_id: job.proposal_id,
  approval_id: job.proposal_hash,
  source_id: job.runner_scope.source_id,
  engine: job.engine,
  operation: job.mutation.kind,
  target: {
    schema: job.target.schema,
    table: job.target.table,
    primary_key: job.target.primary_key,
    tenant_guard: job.tenant_guard,
  },
  allowed_columns: job.allowed_columns,
  patch: job.mutation.kind === "single_row_delete" ? {} : job.mutation.values,
  conflict_guard: job.mutation.kind === "single_row_insert" ? { kind: "none" as const } : normalizeConflictGuard(job.mutation.conflict_guard),
  ...(job.mutation.kind === "single_row_update" && job.mutation.version_advance ? { version_advance: job.mutation.version_advance } : {}),
  ...(job.mutation.kind === "single_row_insert" ? { deduplication: job.mutation.deduplication } : {}),
  idempotency_key: job.idempotency_key,
  ...(job.inverse_capture ? { inverse_capture: job.inverse_capture } : {}),
  lease_expires_at: job.lease.expires_at,
  attempt_count: job.lease.attempt,
}));

export const normalizedWritebackJobV3InputSchema = z.object({
  protocol_version: z.literal(protocolVersions.normalizedWritebackJobV3),
  job_id: z.string().min(1),
  proposal_id: z.string().min(1),
  approval_id: sha256,
  contract: leasedContractRefSchema.optional(),
  source_id: z.string().min(1),
  engine: writebackEngineSchema,
  operation: setOperationSchema,
  target: z.object({ schema: safeIdentifier, table: safeIdentifier, primary_key: z.object({ column: safeIdentifier, value: scalar.optional() }), tenant_guard: columnValueSchema }),
  allowed_columns: z.array(safeIdentifier).max(256),
  patch: boundedScalarRecord,
  conflict_guard: z.object({ kind: z.literal("none") }).default({ kind: "none" }),
  version_advance: versionAdvanceSchema.optional(),
  frozen_set: frozenSetSchema,
  idempotency_key: z.string().min(1),
  lease_expires_at: z.union([z.string(), z.number()]),
  attempt_count: z.number().int().positive(),
  inverse_capture: inverseDescriptorV1Schema.optional(),
}).superRefine((job, ctx) => {
  if (job.operation === "set_delete" && (job.allowed_columns.length || Object.keys(job.patch).length || job.version_advance)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "set DELETE cannot carry patch authority", path: ["patch"] });
  if (job.operation === "set_update" && (!Object.keys(job.patch).length || !job.version_advance)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "set UPDATE requires patch and version advance", path: ["patch"] });
  if (job.operation === "batch_insert" && !job.frozen_set.members.every((member) => member.deduplication)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "batch INSERT requires per-item source deduplication", path: ["frozen_set", "members"] });
});

export const writebackJobV3Schema = z.object({
  schema_version: z.literal(protocolVersions.writebackJobV3),
  writeback_job_id: z.string().min(1),
  proposal_id: z.string().min(1),
  proposal_version: z.number().int().positive(),
  proposal_hash: sha256,
  runner_scope: z.object({ project_id: z.string().min(1), source_id: z.string().min(1) }),
  engine: writebackEngineSchema,
  operation: setOperationSchema,
  target: z.object({ schema: safeIdentifier, table: safeIdentifier, primary_key: z.object({ column: safeIdentifier, value: scalar.optional() }) }),
  tenant_guard: columnValueSchema,
  allowed_columns: z.array(safeIdentifier).max(256),
  patch: boundedScalarRecord,
  version_advance: versionAdvanceSchema.optional(),
  frozen_set: frozenSetSchema,
  idempotency_key: z.string().min(1),
  inverse_capture: inverseDescriptorV1Schema.optional(),
  lease: z.object({ lease_id: z.string().min(1), attempt: z.number().int().positive(), expires_at: z.string().min(1) }),
}).transform((job) => ({
  protocol_version: protocolVersions.normalizedWritebackJobV3,
  job_id: job.writeback_job_id,
  proposal_id: job.proposal_id,
  approval_id: job.proposal_hash,
  source_id: job.runner_scope.source_id,
  engine: job.engine,
  operation: job.operation,
  target: { ...job.target, primary_key: { ...job.target.primary_key, value: undefined }, tenant_guard: job.tenant_guard },
  allowed_columns: job.allowed_columns,
  patch: job.patch,
  conflict_guard: { kind: "none" as const },
  ...(job.version_advance ? { version_advance: job.version_advance } : {}),
  frozen_set: job.frozen_set,
  idempotency_key: job.idempotency_key,
  ...(job.inverse_capture ? { inverse_capture: job.inverse_capture } : {}),
  lease_expires_at: job.lease.expires_at,
  attempt_count: job.lease.attempt,
}));

export const writebackJobV4Schema = z.object({
  schema_version: z.literal(protocolVersions.writebackJobV4),
  writeback_job_id: z.string().min(1),
  proposal_id: z.string().min(1),
  proposal_version: z.number().int().positive(),
  proposal_hash: sha256,
  runner_scope: z.object({ project_id: z.string().min(1), source_id: z.string().min(1) }),
  engine: writebackEngineSchema,
  operation: reversalOperationSchema,
  target: z.object({ schema: safeIdentifier, table: safeIdentifier, primary_key: z.object({ column: safeIdentifier, value: scalar.optional() }) }),
  tenant_guard: columnValueSchema,
  allowed_columns: z.array(safeIdentifier).max(256),
  patch: z.object({}).default({}),
  compensation: inverseDescriptorV1Schema,
  forward_receipt_hash: sha256,
  idempotency_key: z.string().min(1),
  lease: z.object({ lease_id: z.string().min(1), attempt: z.number().int().positive(), expires_at: z.string().min(1) }),
}).superRefine((job, ctx) => {
  if (job.compensation.availability !== "available") ctx.addIssue({ code: z.ZodIssueCode.custom, message: "compensation job requires an available inverse", path: ["compensation", "availability"] });
  if (job.compensation.target.source_id !== job.runner_scope.source_id) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "compensation source must match runner scope", path: ["compensation", "target", "source_id"] });
  if (job.operation !== job.compensation.operation || job.target.schema !== job.compensation.target.schema || job.target.table !== job.compensation.target.table || job.target.primary_key.column !== job.compensation.target.primary_key_column || job.tenant_guard.column !== job.compensation.tenant_guard.column || job.tenant_guard.value !== job.compensation.tenant_guard.value) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "compensation public authority must match descriptor", path: ["compensation"] });
}).transform((job) => ({
  protocol_version: protocolVersions.normalizedWritebackJobV4,
  job_id: job.writeback_job_id,
  proposal_id: job.proposal_id,
  approval_id: job.proposal_hash,
  source_id: job.runner_scope.source_id,
  engine: job.engine,
  operation: job.operation,
  target: {
    ...job.target,
    tenant_guard: job.tenant_guard,
  },
  allowed_columns: job.allowed_columns,
  patch: job.patch,
  conflict_guard: { kind: "none" as const },
  compensation: job.compensation,
  forward_receipt_hash: job.forward_receipt_hash,
  idempotency_key: job.idempotency_key,
  lease_expires_at: job.lease.expires_at,
  attempt_count: job.lease.attempt,
}));

export const normalizedWritebackJobV4InputSchema = z.object({
  protocol_version: z.literal(protocolVersions.normalizedWritebackJobV4),
  job_id: z.string().min(1),
  proposal_id: z.string().min(1),
  approval_id: sha256,
  contract: leasedContractRefSchema.optional(),
  source_id: z.string().min(1),
  engine: writebackEngineSchema,
  operation: reversalOperationSchema,
  target: z.object({ schema: safeIdentifier, table: safeIdentifier, primary_key: z.object({ column: safeIdentifier, value: scalar.optional() }), tenant_guard: columnValueSchema }),
  allowed_columns: z.array(safeIdentifier).max(256),
  patch: z.object({}).default({}),
  conflict_guard: z.object({ kind: z.literal("none") }).default({ kind: "none" }),
  compensation: inverseDescriptorV1Schema,
  forward_receipt_hash: sha256,
  idempotency_key: z.string().min(1),
  lease_expires_at: z.union([z.string(), z.number()]),
  attempt_count: z.number().int().positive(),
}).superRefine((job, ctx) => {
  if (job.operation !== job.compensation.operation) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "compensation operation mismatch", path: ["operation"] });
  if (job.source_id !== job.compensation.target.source_id || job.target.schema !== job.compensation.target.schema || job.target.table !== job.compensation.target.table || job.target.primary_key.column !== job.compensation.target.primary_key_column) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "compensation target mismatch", path: ["target"] });
  if (job.target.tenant_guard.column !== job.compensation.tenant_guard.column || job.target.tenant_guard.value !== job.compensation.tenant_guard.value) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "compensation tenant mismatch", path: ["target", "tenant_guard"] });
});

export const writebackJobSchema = z.union([legacyWritebackJobSchema, normalizedWritebackJobV4InputSchema, normalizedWritebackJobV3InputSchema, normalizedWritebackJobV2InputSchema, normalizedWritebackJobV1Schema, writebackJobV4Schema, writebackJobV3Schema, writebackJobV2Schema]);

export const executionReceiptV1Schema = z.object({
  schema_version: z.literal(protocolVersions.executionReceipt),
  writeback_job_id: z.string().min(1),
  proposal_id: z.string().min(1),
  runner_id: z.string().min(1),
  status: writebackTerminalStatusSchema,
  rows_affected: z.number().int().nonnegative(),
  idempotency_key: z.string().min(1),
  previous_version: scalar.optional(),
  new_version: scalar.optional(),
  source_database_mutated: z.boolean(),
  executed_at: z.string().min(1),
  safe_error_code: z.string().optional(),
  receipt_hash: sha256
}).passthrough();

export const executionReceiptV2Schema = z.object({
  schema_version: z.literal(protocolVersions.executionReceiptV2),
  writeback_job_id: z.string().min(1),
  proposal_id: z.string().min(1),
  proposal_hash: sha256,
  approval_id: z.string().min(1),
  runner_id: z.string().min(1),
  operation: z.enum(["single_row_update", "single_row_insert", "single_row_delete"]),
  receipt_authority: z.enum(["source_db", "runner_ledger"]),
  status: writebackTerminalStatusV2Schema,
  target: z.object({
    source_id: z.string().min(1),
    schema: safeIdentifier,
    table: safeIdentifier,
    identity: z.array(columnValueSchema).min(1).max(8),
  }),
  rows_affected: z.number().int().min(0).max(1),
  idempotency_key: z.string().min(1),
  before_digest: sha256.optional(),
  after_digest: sha256.optional(),
  tombstone_digest: sha256.optional(),
  source_database_mutated: z.boolean(),
  safe_outcome_code: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
  safe_error_code: z.string().regex(/^[A-Z][A-Z0-9_]*$/).optional(),
  executed_at: z.string().min(1),
  receipt_hash: sha256,
  reconciliation: z.object({
    intent_id: z.string().min(1),
    reason: z.string().min(1),
  }).optional(),
  inverse: inverseDescriptorV1Schema.optional(),
}).superRefine((receipt, ctx) => {
  if (receipt.operation === "single_row_delete" && !receipt.tombstone_digest && (receipt.status === "applied" || receipt.status === "already_applied")) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "applied DELETE receipts require a tombstone digest", path: ["tombstone_digest"] });
  }
  if (receipt.status === "reconciliation_required" && !receipt.reconciliation) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "reconciliation_required receipts require reconciliation metadata", path: ["reconciliation"] });
  }
  if (receipt.rows_affected > 0 && !receipt.source_database_mutated) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "rows_affected cannot be positive when source_database_mutated is false", path: ["rows_affected"] });
  }
});

export const executionReceiptV3Schema = z.object({
  schema_version: z.literal(protocolVersions.executionReceiptV3),
  writeback_job_id: z.string().min(1),
  proposal_id: z.string().min(1),
  proposal_hash: sha256,
  approval_id: z.string().min(1),
  runner_id: z.string().min(1),
  operation: setOperationSchema,
  receipt_authority: z.enum(["source_db", "runner_ledger"]),
  status: writebackTerminalStatusV2Schema,
  target: z.object({
    source_id: z.string().min(1),
    schema: safeIdentifier,
    table: safeIdentifier,
    identities: z.array(columnValueSchema).min(1).max(100),
    set_digest: sha256,
  }),
  rows_affected: z.number().int().min(0).max(100),
  idempotency_key: z.string().min(1),
  member_effects: z.array(z.object({
    primary_key: columnValueSchema,
    before_digest: sha256.optional(),
    after_digest: sha256.optional(),
    tombstone_digest: sha256.optional(),
  })).max(100),
  source_database_mutated: z.boolean(),
  safe_outcome_code: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
  safe_error_code: z.string().regex(/^[A-Z][A-Z0-9_]*$/).optional(),
  executed_at: z.string().min(1),
  receipt_hash: sha256,
  reconciliation: z.object({ intent_id: z.string().min(1), reason: z.string().min(1) }).optional(),
  inverse: inverseDescriptorV1Schema.optional(),
}).superRefine((receipt, ctx) => {
  if (receipt.status === "applied" && (receipt.rows_affected !== receipt.target.identities.length || receipt.member_effects.length !== receipt.target.identities.length)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "applied set receipt must identify every affected member", path: ["rows_affected"] });
  if (receipt.rows_affected > 0 && !receipt.source_database_mutated) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "mutated rows require source_database_mutated", path: ["source_database_mutated"] });
  if (receipt.status === "reconciliation_required" && !receipt.reconciliation) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "reconciliation metadata required", path: ["reconciliation"] });
});

export const executionReceiptV4Schema = z.object({
  schema_version: z.literal(protocolVersions.executionReceiptV4),
  writeback_job_id: z.string().min(1),
  proposal_id: z.string().min(1),
  proposal_hash: sha256,
  approval_id: z.string().min(1),
  runner_id: z.string().min(1),
  operation: reversalOperationSchema,
  receipt_authority: z.enum(["source_db", "runner_ledger"]),
  status: writebackTerminalStatusV2Schema,
  target: z.object({
    source_id: z.string().min(1),
    schema: safeIdentifier,
    table: safeIdentifier,
    identities: z.array(columnValueSchema).min(1).max(100),
  }),
  rows_affected: z.number().int().min(0).max(100),
  idempotency_key: z.string().min(1),
  forward_receipt_hash: sha256,
  member_effects: z.array(z.object({ primary_key: columnValueSchema, before_digest: sha256.optional(), after_digest: sha256.optional(), tombstone_digest: sha256.optional() })).max(100),
  inverse: inverseDescriptorV1Schema.optional(),
  source_database_mutated: z.boolean(),
  safe_outcome_code: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
  safe_error_code: z.string().regex(/^[A-Z][A-Z0-9_]*$/).optional(),
  executed_at: z.string().min(1),
  receipt_hash: sha256,
  reconciliation: z.object({ intent_id: z.string().min(1), reason: z.string().min(1) }).optional(),
}).superRefine((receipt, ctx) => {
  if (receipt.status === "applied" && receipt.rows_affected !== receipt.target.identities.length) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "applied compensation receipt must identify every affected member", path: ["rows_affected"] });
  if ((receipt.status === "applied" || receipt.status === "already_applied") && !receipt.inverse) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "successful compensation requires its own inverse", path: ["inverse"] });
  if (receipt.rows_affected > 0 && !receipt.source_database_mutated) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "mutated rows require source_database_mutated", path: ["source_database_mutated"] });
  if (receipt.status === "reconciliation_required" && !receipt.reconciliation) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "reconciliation metadata required", path: ["reconciliation"] });
});

const normalizedExecutionReceiptV1Schema = executionReceiptV1Schema.transform((receipt) => ({
  protocol_version: protocolVersions.legacyWritebackJob,
  job_id: receipt.writeback_job_id,
  runner_id: receipt.runner_id,
  status: receipt.status,
  affected_rows: receipt.rows_affected,
  result_version: receipt.new_version == null ? undefined : String(receipt.new_version),
  result_hash: receipt.receipt_hash,
  completed_at: receipt.executed_at,
  error_code: receipt.safe_error_code
}));

export const legacyWritebackResultSchema = z.object({
  protocol_version: z.literal(protocolVersions.legacyWritebackJob),
  job_id: z.string().min(1),
  runner_id: z.string().min(1),
  status: writebackTerminalStatusSchema,
  affected_rows: z.number().int().nonnegative().optional(),
  result_version: z.string().optional(),
  result_hash: z.string().optional(),
  completed_at: z.string().optional(),
  error_code: z.string().optional()
});

export const normalizedWritebackResultV2Schema = z.object({
  protocol_version: z.literal(protocolVersions.normalizedWritebackJobV2),
  job_id: z.string().min(1),
  runner_id: z.string().min(1),
  operation: z.enum(["single_row_update", "single_row_insert", "single_row_delete"]),
  receipt_authority: z.enum(["source_db", "runner_ledger"]),
  status: writebackTerminalStatusV2Schema,
  affected_rows: z.number().int().min(0).max(1),
  target_identity: z.array(columnValueSchema).min(1).max(8),
  result_version: scalar.optional(),
  before_digest: sha256.optional(),
  after_digest: sha256.optional(),
  tombstone_digest: sha256.optional(),
  result_hash: sha256.optional(),
  completed_at: z.string().min(1),
  error_code: z.string().regex(/^[A-Z][A-Z0-9_]*$/).optional(),
  intent_id: z.string().min(1).optional(),
  inverse: inverseDescriptorV1Schema.optional(),
}).superRefine((result, ctx) => {
  if (result.status === "reconciliation_required" && !result.intent_id) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "reconciliation_required results require intent_id", path: ["intent_id"] });
  }
});

export const normalizedWritebackResultV3Schema = z.object({
  protocol_version: z.literal(protocolVersions.normalizedWritebackJobV3),
  job_id: z.string().min(1),
  runner_id: z.string().min(1),
  operation: setOperationSchema,
  receipt_authority: z.enum(["source_db", "runner_ledger"]),
  status: writebackTerminalStatusV2Schema,
  affected_rows: z.number().int().min(0).max(100),
  target_identities: z.array(columnValueSchema).min(1).max(100),
  set_digest: sha256,
  member_effects: z.array(z.object({ primary_key: columnValueSchema, before_digest: sha256.optional(), after_digest: sha256.optional(), tombstone_digest: sha256.optional() })).max(100),
  result_version: scalar.optional(),
  result_hash: sha256.optional(),
  completed_at: z.string().min(1),
  error_code: z.string().regex(/^[A-Z][A-Z0-9_]*$/).optional(),
  intent_id: z.string().min(1).optional(),
  inverse: inverseDescriptorV1Schema.optional(),
}).superRefine((result, ctx) => {
  if (result.status === "applied" && (result.affected_rows !== result.target_identities.length || result.member_effects.length !== result.target_identities.length)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "applied set result must identify every member", path: ["affected_rows"] });
  if (result.status === "reconciliation_required" && !result.intent_id) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "reconciliation_required results require intent_id", path: ["intent_id"] });
});

export const normalizedWritebackResultV4Schema = z.object({
  protocol_version: z.literal(protocolVersions.normalizedWritebackJobV4),
  job_id: z.string().min(1),
  runner_id: z.string().min(1),
  operation: reversalOperationSchema,
  receipt_authority: z.enum(["source_db", "runner_ledger"]),
  status: writebackTerminalStatusV2Schema,
  affected_rows: z.number().int().min(0).max(100),
  target_identities: z.array(columnValueSchema).min(1).max(100),
  member_effects: z.array(z.object({ primary_key: columnValueSchema, before_digest: sha256.optional(), after_digest: sha256.optional(), tombstone_digest: sha256.optional() })).max(100),
  inverse: inverseDescriptorV1Schema.optional(),
  result_hash: sha256.optional(),
  completed_at: z.string().min(1),
  error_code: z.string().regex(/^[A-Z][A-Z0-9_]*$/).optional(),
  intent_id: z.string().min(1).optional(),
}).superRefine((result, ctx) => {
  if (result.status === "applied" && result.affected_rows !== result.target_identities.length) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "applied compensation must identify every member", path: ["affected_rows"] });
  if ((result.status === "applied" || result.status === "already_applied") && !result.inverse) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "successful compensation requires its own inverse", path: ["inverse"] });
  if (result.status === "reconciliation_required" && !result.intent_id) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "reconciliation_required results require intent_id", path: ["intent_id"] });
});

export const writebackResultSchema = z.union([legacyWritebackResultSchema, normalizedExecutionReceiptV1Schema, normalizedWritebackResultV4Schema, normalizedWritebackResultV3Schema, normalizedWritebackResultV2Schema]);

export const runnerRegistrationV1Schema = z.object({
  schema_version: z.literal(protocolVersions.runnerRegistration),
  protocol_version: z.literal(protocolVersions.runnerControl).optional(),
  runner_id: z.string().min(1),
  runner_version: z.string().min(1),
  engines: z.array(writebackEngineSchema).min(1),
  capabilities: z.array(z.string().min(1)).min(1),
  scope: z.object({
    project_id: z.string().min(1),
    source_ids: z.array(z.string().min(1)).min(1)
  }),
  contracts: z.array(z.object({
    contract_id: z.string().min(1),
    contract_version_id: z.string().min(1),
    digest: sha256,
  })).max(100).optional(),
  registered_at: z.string().min(1)
});

export const runnerProposalV1Schema = z.object({
  schema_version: z.literal(protocolVersions.runnerProposal),
  runner_id: z.string().min(1),
  source_id: z.string().min(1),
  mapping_id: z.string().min(1).optional(),
  contract: z.object({
    contract_id: z.string().min(1),
    contract_version_id: z.string().min(1),
    digest: sha256,
  }),
  change_set: z.union([changeSetV1Schema, changeSetV2Schema, changeSetV3Schema, compensationChangeSetV1Schema]),
  evidence_metadata: z.record(z.unknown()).optional(),
  query_audit: z.record(z.unknown()).optional(),
}).superRefine((proposal, ctx) => {
  // source_id is the Cloud external-source scope used for token authorization
  // and queue routing. change_set.source.source_id is the portable source alias
  // reviewed in the contract and used by the local Runner config. They are
  // intentionally independent identifiers.
  if (proposal.change_set.source_database_mutated) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Runner proposals must describe an unchanged source database", path: ["change_set", "source_database_mutated"] });
  }
});

export const runnerActivityV1Schema = z.object({
  schema_version: z.literal(protocolVersions.runnerActivity),
  event_id: z.string().min(1).max(120).regex(/^[A-Za-z0-9_.:-]+$/),
  event_type: z.enum(["evidence.recorded", "query_audit.recorded", "replay.recorded", "worker.diagnostic"]),
  runner_id: z.string().min(1).max(120),
  source_id: z.string().min(1).max(120),
  proposal_id: z.string().min(1).max(120).optional(),
  job_id: z.string().min(1).max(120).optional(),
  contract_id: z.string().min(1).max(120).optional(),
  contract_version_id: z.string().min(1).max(120).optional(),
  contract_digest: sha256.optional(),
  capability: z.string().min(1).max(160).optional(),
  workflow: z.string().min(1).max(160).optional(),
  tenant_id: z.string().min(1).max(160).optional(),
  principal: z.string().min(1).max(200).optional(),
  business_object: z.string().min(1).max(160).optional(),
  object_id: z.string().min(1).max(200).optional(),
  status: z.string().min(1).max(80).optional(),
  evidence_ids: z.array(z.string().min(1).max(160)).max(100).optional(),
  query_audit_ids: z.array(z.string().min(1).max(160)).max(100).optional(),
  receipt_id: z.string().min(1).max(160).optional(),
  replay_id: z.string().min(1).max(160).optional(),
  detail: z.record(z.unknown()).optional(),
  occurred_at: z.string().min(1).max(80).optional(),
}).strict();

export type ChangeSetV1 = z.infer<typeof changeSetV1Schema>;
export type ChangeSetV2 = z.infer<typeof changeSetV2Schema>;
export type ChangeSetV3 = z.infer<typeof changeSetV3Schema>;
export type CompensationChangeSetV1 = z.infer<typeof compensationChangeSetV1Schema>;
export type ChangeSet = ChangeSetV1 | ChangeSetV2 | ChangeSetV3 | CompensationChangeSetV1;
export type WritebackJobV1 = z.infer<typeof writebackJobV1Schema>;
export type WritebackJobV2 = z.input<typeof writebackJobV2Schema>;
export type WritebackJobV3 = z.input<typeof writebackJobV3Schema>;
export type WritebackJobV4 = z.input<typeof writebackJobV4Schema>;
export type ExecutionReceiptV1 = z.infer<typeof executionReceiptV1Schema>;
export type ExecutionReceiptV2 = z.infer<typeof executionReceiptV2Schema>;
export type ExecutionReceiptV3 = z.infer<typeof executionReceiptV3Schema>;
export type ExecutionReceiptV4 = z.infer<typeof executionReceiptV4Schema>;
export type ExecutionReceipt = ExecutionReceiptV1 | ExecutionReceiptV2 | ExecutionReceiptV3 | ExecutionReceiptV4;
export type InverseDescriptorV1 = z.infer<typeof inverseDescriptorV1Schema>;
export type RunnerRegistrationV1 = z.infer<typeof runnerRegistrationV1Schema>;
export type RunnerProposalV1 = z.infer<typeof runnerProposalV1Schema>;
export type RunnerActivityV1 = z.infer<typeof runnerActivityV1Schema>;
export type WritebackJob = z.infer<typeof writebackJobSchema>;
export type WritebackResult = z.infer<typeof writebackResultSchema>;
export type WritebackEngine = z.infer<typeof writebackEngineSchema>;

function validateAllowedPatchColumns(
  allowedColumns: string[],
  patchColumns: string[],
  primaryKeyColumn: string,
  tenantGuardColumn: string,
  ctx: z.RefinementCtx
): void {
  const allow = new Set(allowedColumns);
  for (const column of patchColumns) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(column)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `patch column is not a fixed safe identifier: ${column}`,
        path: ["patch", column]
      });
      continue;
    }
    if (!allow.has(column)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `patch column not allowed: ${column}`,
        path: ["patch", column]
      });
    }
  }
  if (allowedColumns.includes(primaryKeyColumn)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "primary key column must not be patch-allowlisted",
      path: ["allowed_columns"]
    });
  }
  if (allowedColumns.includes(tenantGuardColumn)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "tenant guard column must not be patch-allowlisted",
      path: ["allowed_columns"]
    });
  }
}

function validateResolvedDeduplication(
  components: Array<z.infer<typeof resolvedDeduplicationComponentSchema>>,
  values: Record<string, unknown>,
  tenantGuard: z.infer<typeof columnValueSchema>,
  ctx: z.RefinementCtx,
  path: Array<string | number>,
): void {
  const columns = new Set<string>();
  let proposalIdentity = false;
  let trustedTenant = false;
  for (const [index, component] of components.entries()) {
    if (columns.has(component.column)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "deduplication columns must be unique", path: [...path, index, "column"] });
    columns.add(component.column);
    if (Object.prototype.hasOwnProperty.call(values, component.column)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "deduplication columns must be Runner-supplied, not mutation values", path: [...path, index, "column"] });
    if (component.source === "proposal_id") proposalIdentity = true;
    if (component.source === "trusted_tenant") {
      if (component.column !== tenantGuard.column || component.value !== tenantGuard.value) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "trusted tenant deduplication must match tenant_guard", path: [...path, index] });
      else trustedTenant = true;
    }
  }
  if (!proposalIdentity) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "INSERT deduplication must include proposal_id", path });
  if (!trustedTenant) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "INSERT deduplication must include trusted tenant", path });
}

function normalizeConflictGuard(guard: z.infer<typeof publicConflictGuardSchema>): z.infer<typeof legacyWritebackJobSchema>["conflict_guard"] {
  if (guard.kind === "column") {
    return { kind: "version_column", column: guard.column, expected_value: guard.expected_value };
  }
  return guard;
}

export function parseChangeSet(input: unknown): ChangeSet {
  return z.union([changeSetV1Schema, changeSetV2Schema, changeSetV3Schema, compensationChangeSetV1Schema]).parse(input);
}

export function parseWritebackJob(input: unknown): WritebackJob {
  return writebackJobSchema.parse(input);
}

export function parseExecutionReceipt(input: unknown): ExecutionReceipt {
  return z.union([executionReceiptV1Schema, executionReceiptV2Schema, executionReceiptV3Schema, executionReceiptV4Schema]).parse(input);
}

export function parseWritebackResult(input: unknown): WritebackResult {
  return writebackResultSchema.parse(input);
}

export function parseRunnerRegistration(input: unknown): RunnerRegistrationV1 {
  return runnerRegistrationV1Schema.parse(input);
}

export function parseRunnerProposal(input: unknown): RunnerProposalV1 {
  return runnerProposalV1Schema.parse(input);
}

export function parseRunnerActivity(input: unknown): RunnerActivityV1 {
  return runnerActivityV1Schema.parse(input);
}

export const safeErrorCodes = [
  "TENANT_GUARD_MISMATCH",
  "ROW_NOT_FOUND",
  "VERSION_CONFLICT",
  "ROW_CHANGED_AFTER_PROPOSAL",
  "PATCH_COLUMN_NOT_ALLOWED",
  "MULTI_ROW_WRITE_BLOCKED",
  "IDEMPOTENCY_REPLAY",
  "DATABASE_UNAVAILABLE",
  "TRANSACTION_FAILED",
  "PROPOSAL_VERSION_MISMATCH",
  "PROPOSAL_HASH_MISMATCH",
  "RUNNER_SCOPE_MISMATCH",
  "WRITEBACK_LEASE_EXPIRED",
  "WRITEBACK_ALREADY_COMPLETED",
  "WRITEBACK_SAFETY_FAILURE",
  "OUTCOME_UNKNOWN",
  "RECONCILIATION_REQUIRED",
  "VERSION_DID_NOT_ADVANCE",
  "INSERT_DEDUP_CONFLICT",
  "INSERT_CONSTRAINT_FAILED",
  "DELETE_CASCADE_BLOCKED",
  "DELETE_TRIGGER_BLOCKED",
  "SOURCE_RECEIPT_UNAVAILABLE",
  "RUNNER_LEDGER_UNAVAILABLE"
] as const;

export type SafeErrorCode = (typeof safeErrorCodes)[number];
