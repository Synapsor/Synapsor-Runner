import { z } from "zod";

const scalar = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const scalarMap = z.record(scalar).refine((value) => Object.keys(value).length > 0, "object must not be empty");
const sha256 = z.string().regex(/^sha256:.+/, "expected sha256:<digest>");
const safeIdentifier = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "expected fixed safe identifier");

export const protocolVersions = {
  changeSet: "synapsor.change-set.v1",
  writebackJob: "synapsor.writeback-job.v1",
  executionReceipt: "synapsor.execution-receipt.v1",
  runnerRegistration: "synapsor.runner-registration.v1",
  legacyWritebackJob: "1.0"
} as const;

export const writebackEngineSchema = z.enum(["postgres", "mysql"]);
export const writebackTerminalStatusSchema = z.enum([
  "applied",
  "conflict",
  "failed",
  "canceled",
  "already_applied"
]);

const columnValueSchema = z.object({
  column: safeIdentifier,
  value: scalar
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
    required_role: z.string().optional()
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

export const writebackJobSchema = z.union([legacyWritebackJobSchema, normalizedWritebackJobV1Schema]);

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

export const writebackResultSchema = z.union([legacyWritebackResultSchema, normalizedExecutionReceiptV1Schema]);

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
export type WritebackJobV1 = z.infer<typeof writebackJobV1Schema>;
export type ExecutionReceiptV1 = z.infer<typeof executionReceiptV1Schema>;
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

function normalizeConflictGuard(guard: z.infer<typeof publicConflictGuardSchema>): z.infer<typeof legacyWritebackJobSchema>["conflict_guard"] {
  if (guard.kind === "column") {
    return { kind: "version_column", column: guard.column, expected_value: guard.expected_value };
  }
  return guard;
}

export function parseChangeSet(input: unknown): ChangeSetV1 {
  return changeSetV1Schema.parse(input);
}

export function parseWritebackJob(input: unknown): WritebackJob {
  return writebackJobSchema.parse(input);
}

export function parseExecutionReceipt(input: unknown): ExecutionReceiptV1 {
  return executionReceiptV1Schema.parse(input);
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
  "WRITEBACK_SAFETY_FAILURE"
] as const;

export type SafeErrorCode = (typeof safeErrorCodes)[number];
