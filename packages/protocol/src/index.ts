import { z } from "zod";

const scalar = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const scalarMap = z.record(scalar).refine((value) => Object.keys(value).length > 0, "object must not be empty");
const boundedScalarRecord = z.record(scalar).refine((value) => Object.keys(value).length <= 256, "object exceeds 256 fields");
const sha256 = z.string().regex(/^sha256:.+/, "expected sha256:<digest>");
const safeIdentifier = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "expected fixed safe identifier");

export const protocolVersions = {
  changeSet: "synapsor.change-set.v1",
  changeSetV2: "synapsor.change-set.v2",
  writebackJob: "synapsor.writeback-job.v1",
  writebackJobV2: "synapsor.writeback-job.v2",
  executionReceipt: "synapsor.execution-receipt.v1",
  executionReceiptV2: "synapsor.execution-receipt.v2",
  runnerRegistration: "synapsor.runner-registration.v1",
  legacyWritebackJob: "1.0",
  normalizedWritebackJobV2: "2.0",
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

export const changeSetV1Schema = z.object({
  schema_version: z.literal(protocolVersions.changeSet),
  proposal_id: z.string().min(1),
  proposal_version: z.number().int().positive(),
  action: z.string().min(1),
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

const publicConflictGuardSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("column"), column: safeIdentifier, expected_value: scalar }),
  z.object({ kind: z.literal("row_hash"), expected_hash: z.string().min(1) }),
  z.object({ kind: z.literal("none") })
]);

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
  lease_expires_at: job.lease.expires_at,
  attempt_count: job.lease.attempt,
}));

export const writebackJobSchema = z.union([legacyWritebackJobSchema, normalizedWritebackJobV2InputSchema, normalizedWritebackJobV1Schema, writebackJobV2Schema]);

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
}).superRefine((result, ctx) => {
  if (result.status === "reconciliation_required" && !result.intent_id) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "reconciliation_required results require intent_id", path: ["intent_id"] });
  }
});

export const writebackResultSchema = z.union([legacyWritebackResultSchema, normalizedExecutionReceiptV1Schema, normalizedWritebackResultV2Schema]);

export const runnerRegistrationV1Schema = z.object({
  schema_version: z.literal(protocolVersions.runnerRegistration),
  runner_id: z.string().min(1),
  runner_version: z.string().min(1),
  engines: z.array(writebackEngineSchema).min(1),
  capabilities: z.array(z.string().min(1)).min(1),
  scope: z.object({
    project_id: z.string().min(1),
    source_ids: z.array(z.string().min(1)).min(1)
  }),
  registered_at: z.string().min(1)
});

export type ChangeSetV1 = z.infer<typeof changeSetV1Schema>;
export type ChangeSetV2 = z.infer<typeof changeSetV2Schema>;
export type ChangeSet = ChangeSetV1 | ChangeSetV2;
export type WritebackJobV1 = z.infer<typeof writebackJobV1Schema>;
export type WritebackJobV2 = z.input<typeof writebackJobV2Schema>;
export type ExecutionReceiptV1 = z.infer<typeof executionReceiptV1Schema>;
export type ExecutionReceiptV2 = z.infer<typeof executionReceiptV2Schema>;
export type ExecutionReceipt = ExecutionReceiptV1 | ExecutionReceiptV2;
export type RunnerRegistrationV1 = z.infer<typeof runnerRegistrationV1Schema>;
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
  return z.union([changeSetV1Schema, changeSetV2Schema]).parse(input);
}

export function parseWritebackJob(input: unknown): WritebackJob {
  return writebackJobSchema.parse(input);
}

export function parseExecutionReceipt(input: unknown): ExecutionReceipt {
  return z.union([executionReceiptV1Schema, executionReceiptV2Schema]).parse(input);
}

export function parseWritebackResult(input: unknown): WritebackResult {
  return writebackResultSchema.parse(input);
}

export function parseRunnerRegistration(input: unknown): RunnerRegistrationV1 {
  return runnerRegistrationV1Schema.parse(input);
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
