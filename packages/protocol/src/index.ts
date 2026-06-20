import { z } from "zod";

const scalar = z.union([z.string(), z.number(), z.boolean(), z.null()]);

export const writebackEngineSchema = z.enum(["postgres", "mysql"]);

export const writebackJobSchema = z.object({
  protocol_version: z.literal("1.0"),
  job_id: z.string().min(1),
  proposal_id: z.string().min(1),
  approval_id: z.string().min(1),
  source_id: z.string().min(1),
  engine: writebackEngineSchema,
  target: z.object({
    schema: z.string().min(1),
    table: z.string().min(1),
    primary_key: z.object({
      column: z.string().min(1),
      value: scalar
    }),
    tenant_guard: z.object({
      column: z.string().min(1),
      value: scalar
    })
  }),
  allowed_columns: z.array(z.string().min(1)).min(1),
  patch: z.record(scalar).refine((value) => Object.keys(value).length > 0, "patch must not be empty"),
  conflict_guard: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("version_column"), column: z.string().min(1), expected_value: scalar }),
    z.object({ kind: z.literal("row_hash"), expected_hash: z.string().min(1) }),
    z.object({ kind: z.literal("none") })
  ]),
  idempotency_key: z.string().min(1),
  lease_expires_at: z.union([z.string(), z.number()]),
  attempt_count: z.number().int().nonnegative().optional()
}).superRefine((job, ctx) => {
  const allow = new Set(job.allowed_columns);
  for (const column of Object.keys(job.patch)) {
    if (!allow.has(column)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `patch column not allowed: ${column}`,
        path: ["patch", column]
      });
    }
  }
  if (job.allowed_columns.includes(job.target.primary_key.column)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "primary key column must not be patch-allowlisted",
      path: ["allowed_columns"]
    });
  }
  if (job.allowed_columns.includes(job.target.tenant_guard.column)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "tenant guard column must not be patch-allowlisted",
      path: ["allowed_columns"]
    });
  }
});

export const writebackResultSchema = z.object({
  protocol_version: z.literal("1.0"),
  job_id: z.string().min(1),
  runner_id: z.string().min(1),
  status: z.enum(["applied", "conflict", "failed"]),
  affected_rows: z.number().int().nonnegative().optional(),
  result_version: z.string().optional(),
  result_hash: z.string().optional(),
  completed_at: z.string().optional(),
  error_code: z.string().optional()
});

export type WritebackJob = z.infer<typeof writebackJobSchema>;
export type WritebackResult = z.infer<typeof writebackResultSchema>;
export type WritebackEngine = z.infer<typeof writebackEngineSchema>;

export function parseWritebackJob(input: unknown): WritebackJob {
  return writebackJobSchema.parse(input);
}

export function parseWritebackResult(input: unknown): WritebackResult {
  return writebackResultSchema.parse(input);
}

export const safeErrorCodes = [
  "TENANT_GUARD_MISMATCH",
  "ROW_NOT_FOUND",
  "VERSION_CONFLICT",
  "PATCH_COLUMN_NOT_ALLOWED",
  "MULTI_ROW_WRITE_BLOCKED",
  "IDEMPOTENCY_REPLAY",
  "DATABASE_UNAVAILABLE",
  "TRANSACTION_FAILED"
] as const;

export type SafeErrorCode = (typeof safeErrorCodes)[number];

