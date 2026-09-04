import { z } from "zod";
import { canonicalJsonDigest, canonicalJsonStringify } from "./canonical-json.js";

export const semanticProtocolVersions = {
  eligibilityProof: "synapsor.eligibility-proof.v1",
  changeSetV4: "synapsor.change-set.v4",
  writebackJobV5: "synapsor.writeback-job.v5",
  executionReceiptV5: "synapsor.execution-receipt.v5",
  normalizedWritebackJobV5: "5.0",
} as const;

const scalar = z.union([z.string(), z.number().finite(), z.boolean(), z.null()]);
const scalarRecord = z.record(scalar).refine((value) => Object.keys(value).length <= 256, "object exceeds 256 fields");
const nonEmptyScalarRecord = scalarRecord.refine((value) => Object.keys(value).length > 0, "object must not be empty");
const sha256 = z.string().regex(/^sha256:[a-f0-9]{64}$/, "expected exact sha256 digest");
const safeIdentifier = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "expected fixed safe identifier");
const reviewedName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_.:-]{0,127}$/, "expected fixed reviewed name");
const qualifiedName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+$/, "expected fixed qualified name");
const timestamp = z.string().datetime({ offset: false });

const columnValueSchema = z.object({ column: safeIdentifier, value: scalar }).strict();
const principalScopeSchema = z.object({
  schema_version: z.literal("synapsor.principal-scope.v1"),
  column: safeIdentifier,
  binding: safeIdentifier,
  provider: z.enum(["environment", "http_claims", "cloud_session", "static_dev"]),
  value_fingerprint: sha256,
  value: scalar.optional(),
}).strict();
const organizationScopeSchema = z.object({
  mode: z.literal("single_organization"),
  organization_id: z.string().min(1).max(256),
}).strict();
const contractProvenanceSchema = z.object({
  digest: sha256,
  version: z.string().min(1).max(128),
}).strict();
const leasedContractRefSchema = z.object({
  contract_id: z.string().min(1).max(200),
  contract_version_id: z.string().min(1).max(200),
  digest: sha256,
}).strict();
const versionAdvanceSchema = z.object({
  column: safeIdentifier,
  strategy: z.literal("integer_increment"),
}).strict();

export const semanticDependencyV1Schema = z.object({
  binding: safeIdentifier,
  resource: qualifiedName,
  primary_key: columnValueSchema,
  version: columnValueSchema.optional(),
  row_digest: sha256,
}).strict();

export const semanticSubjectBindingV1Schema = z.object({
  binding: safeIdentifier,
  resource: qualifiedName,
  subject_ref_digest: sha256,
}).strict();

const semanticDeduplicationComponentSchema = z.object({
  column: safeIdentifier,
  source: z.enum(["proposal_id", "trusted_tenant", "derived", "fixed"]),
  value: scalar,
}).strict();

const exactDerivedEffectUnsignedSchema = z.object({
  operation: z.enum(["single_row_update", "single_row_insert"]),
  source: safeIdentifier,
  resource: qualifiedName,
  schema: safeIdentifier,
  table: safeIdentifier,
  primary_key: z.object({ column: safeIdentifier, value: scalar.optional() }).strict(),
  tenant_guard: columnValueSchema.optional(),
  organization_scope: organizationScopeSchema.optional(),
  principal_scope: columnValueSchema.optional(),
  expected_version: columnValueSchema.optional(),
  version_advance: versionAdvanceSchema.optional(),
  allowed_columns: z.array(safeIdentifier).min(1).max(64),
  set: nonEmptyScalarRecord,
  deduplication: z.object({ components: z.array(semanticDeduplicationComponentSchema).min(1).max(8) }).strict().optional(),
}).strict();

export const exactDerivedEffectV1Schema = exactDerivedEffectUnsignedSchema.extend({
  effect_digest: sha256,
}).strict().superRefine((effect, ctx) => {
  const { effect_digest: _digest, ...unsigned } = effect;
  if (canonicalJsonDigest(unsigned) !== effect.effect_digest) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "derived effect digest mismatch", path: ["effect_digest"] });
  const sorted = [...effect.allowed_columns].sort();
  if (new Set(effect.allowed_columns).size !== effect.allowed_columns.length || canonicalJsonStringify(sorted) !== canonicalJsonStringify(effect.allowed_columns)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "allowed columns must be unique and canonically sorted", path: ["allowed_columns"] });
  if (canonicalJsonStringify(Object.keys(effect.set).sort()) !== canonicalJsonStringify(effect.allowed_columns)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "exact effect set must match its allowed columns", path: ["set"] });
  if ((effect.tenant_guard === undefined) === (effect.organization_scope === undefined)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "exactly one trusted tenant guard or reviewed single-organization scope is required", path: ["tenant_guard"] });
  for (const guard of [effect.primary_key.column, effect.tenant_guard?.column, effect.principal_scope?.column, effect.expected_version?.column, effect.version_advance?.column]) {
    if (guard !== undefined && effect.allowed_columns.includes(guard)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `guard column must not be writable: ${guard}`, path: ["allowed_columns"] });
  }
  if (effect.operation === "single_row_update") {
    if (effect.primary_key.value === undefined || effect.expected_version === undefined || effect.deduplication !== undefined) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "semantic UPDATE requires exact identity/version and no insert deduplication", path: ["operation"] });
    if (effect.version_advance !== undefined && effect.version_advance.column !== effect.expected_version?.column) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "version advance must match expected version column", path: ["version_advance"] });
  } else {
    if (effect.expected_version !== undefined || effect.version_advance !== undefined || effect.deduplication === undefined) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "semantic INSERT requires deduplication and no existing-row version guard", path: ["operation"] });
    const components = effect.deduplication?.components ?? [];
    if (!components.some((component) => component.source === "proposal_id")) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "semantic INSERT deduplication requires proposal identity", path: ["deduplication"] });
    if (effect.tenant_guard !== undefined && !components.some((component) => component.source === "trusted_tenant" && component.column === effect.tenant_guard?.column && component.value === effect.tenant_guard?.value)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "semantic INSERT deduplication must bind the trusted tenant", path: ["deduplication"] });
  }
});

const eligibilityProofUnsignedSchema = z.object({
  schema_version: z.literal(semanticProtocolVersions.eligibilityProof),
  result: z.literal("eligible"),
  action_boundary_name: reviewedName,
  action_boundary_digest: sha256,
  verification_boundary_digest: sha256,
  effect_envelope_digest: sha256,
  action_rule_name: qualifiedName,
  outcome: qualifiedName,
  action_rule_digest: sha256,
  compiled_plan_digest: sha256,
  compiler_version: z.string().min(1).max(120),
  schema_lock_digest: sha256,
  generation_lock_fingerprint: sha256,
  verification_transaction: z.object({
    isolation: z.enum(["read_committed", "repeatable_read", "serializable"]),
    timezone: z.literal("UTC"),
  }).strict(),
  trusted_context_digest: sha256,
  subject_bindings_digest: sha256,
  business_inputs_digest: sha256.optional(),
  evidence_provenance_digest: sha256,
  verified_facts_digest: sha256,
  dependency_set_digest: sha256,
  derived_effect_digest: sha256,
  approval_class: qualifiedName,
  approval_policy_digest: sha256,
  approval_path: z.enum(["automatic_eligible", "human_review"]),
  verified_at: timestamp,
  valid_until: timestamp,
  uses: z.literal(1),
}).strict();

export const eligibilityProofV1Schema = eligibilityProofUnsignedSchema.extend({
  proof_digest: sha256,
}).strict().superRefine((proof, ctx) => {
  const { proof_digest: _digest, ...unsigned } = proof;
  if (canonicalJsonDigest(unsigned) !== proof.proof_digest) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "eligibility proof digest mismatch", path: ["proof_digest"] });
  if (Date.parse(proof.valid_until) <= Date.parse(proof.verified_at)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "eligibility proof must expire after verification", path: ["valid_until"] });
});

export const semanticAuthorityV1Schema = z.object({
  proof: eligibilityProofV1Schema,
  business_inputs: z.record(safeIdentifier, scalar).optional(),
  subject_bindings: z.array(semanticSubjectBindingV1Schema).min(1).max(8),
  dependencies: z.array(semanticDependencyV1Schema).min(1).max(100),
  effect: exactDerivedEffectV1Schema,
}).strict().superRefine((semantic, ctx) => {
  if ((semantic.business_inputs !== undefined || semantic.proof.business_inputs_digest !== undefined)
    && (!semantic.business_inputs || semantic.proof.business_inputs_digest !== canonicalJsonDigest(semantic.business_inputs))) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "business inputs must match their immutable proof digest", path: ["business_inputs"] });
  }
  const sortedSubjects = [...semantic.subject_bindings].sort((left, right) => left.binding.localeCompare(right.binding));
  if (canonicalJsonStringify(sortedSubjects) !== canonicalJsonStringify(semantic.subject_bindings)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "subject bindings must be canonically sorted", path: ["subject_bindings"] });
  const sortedDependencies = [...semantic.dependencies].sort((left, right) => {
    const binding = left.binding.localeCompare(right.binding);
    return binding !== 0 ? binding : canonicalJsonStringify(left.primary_key.value).localeCompare(canonicalJsonStringify(right.primary_key.value));
  });
  if (canonicalJsonStringify(sortedDependencies) !== canonicalJsonStringify(semantic.dependencies)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "dependencies must be canonically sorted", path: ["dependencies"] });
  if (semantic.proof.subject_bindings_digest !== canonicalJsonDigest(semantic.subject_bindings)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "subject binding digest mismatch", path: ["proof", "subject_bindings_digest"] });
  if (semantic.proof.dependency_set_digest !== canonicalJsonDigest(semantic.dependencies)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "dependency set digest mismatch", path: ["proof", "dependency_set_digest"] });
  if (semantic.proof.derived_effect_digest !== semantic.effect.effect_digest) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "eligibility proof does not bind the exact derived effect", path: ["proof", "derived_effect_digest"] });
});

const semanticChangeSetBaseSchema = z.object({
  schema_version: z.literal(semanticProtocolVersions.changeSetV4),
  proposal_id: z.string().min(1).max(200),
  proposal_version: z.number().int().positive(),
  action: qualifiedName,
  contract: contractProvenanceSchema.optional(),
  operation: z.enum(["single_row_update", "single_row_insert"]),
  mode: z.enum(["review_required", "approved_for_writeback"]),
  principal: z.object({
    id: z.string().min(1).max(200),
    source: z.enum(["trusted_session", "cloud_session", "environment", "static_dev"]),
  }).strict(),
  scope: z.object({
    tenant_id: z.string().min(1).max(256).optional(),
    organization_scope: organizationScopeSchema.optional(),
    business_object: z.string().min(1).max(160),
    object_id: z.string().min(1).max(200),
  }).strict().superRefine((scope, ctx) => {
    if ((scope.tenant_id === undefined) === (scope.organization_scope === undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "exactly one trusted tenant or reviewed single-organization scope is required",
        path: ["tenant_id"],
      });
    }
  }),
  source: z.object({
    kind: z.enum(["external_postgres", "external_mysql"]),
    source_id: z.string().min(1).max(160),
    schema: safeIdentifier,
    table: safeIdentifier,
    primary_key: z.object({ column: safeIdentifier, value: scalar.optional() }).strict(),
  }).strict(),
  before: scalarRecord,
  patch: nonEmptyScalarRecord,
  after: scalarRecord,
  guards: z.object({
    tenant: columnValueSchema.optional(),
    organization_scope: organizationScopeSchema.optional(),
    principal_scope: principalScopeSchema.optional(),
    allowed_columns: z.array(safeIdentifier).min(1).max(64),
    expected_version: columnValueSchema.optional(),
    version_advance: versionAdvanceSchema.optional(),
    deduplication: z.object({ components: z.array(semanticDeduplicationComponentSchema).min(1).max(8) }).strict().optional(),
  }).strict(),
  evidence: z.object({
    bundle_id: z.string().min(1).max(200),
    query_fingerprint: sha256,
    items: z.array(z.unknown()).max(100),
  }).passthrough(),
  approval: z.object({
    status: z.enum(["pending", "approved", "rejected", "canceled"]),
    mode: z.enum(["human", "policy"]),
    approval_class: qualifiedName,
    approval_policy_digest: sha256,
    required_role: z.string().min(1).max(160).optional(),
    required_approvals: z.number().int().min(1).max(10).optional(),
  }).passthrough(),
  writeback: z.object({
    status: z.enum(["not_applied", "pending_worker", "applied", "conflict", "failed", "canceled", "reconciliation_required"]),
    mode: z.enum(["trusted_worker_required", "read_only"]),
    executor: z.literal("semantic_rule").optional(),
  }).passthrough(),
  semantic_authority: semanticAuthorityV1Schema,
  source_database_mutated: z.literal(false),
  integrity: z.object({ proposal_hash: sha256 }).strict(),
  created_at: timestamp,
}).strict();

export const changeSetV4Schema = semanticChangeSetBaseSchema.superRefine((changeSet, ctx) => {
  const { integrity: _integrity, ...proposalCore } = changeSet;
  if (canonicalJsonDigest(proposalCore) !== changeSet.integrity.proposal_hash) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "semantic proposal hash mismatch", path: ["integrity", "proposal_hash"] });
  }
  const effect = changeSet.semantic_authority.effect;
  const proof = changeSet.semantic_authority.proof;
  if (changeSet.action !== proof.outcome || changeSet.operation !== effect.operation) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "semantic action or operation mismatch", path: ["semantic_authority"] });
  if (changeSet.source.source_id !== effect.source || changeSet.source.schema !== effect.schema || changeSet.source.table !== effect.table || canonicalJsonStringify(changeSet.source.primary_key) !== canonicalJsonStringify(effect.primary_key)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "semantic target mismatch", path: ["source"] });
  if (effect.tenant_guard !== undefined
    ? changeSet.scope.tenant_id !== effect.tenant_guard.value || changeSet.scope.organization_scope !== undefined
    : changeSet.scope.tenant_id !== undefined || canonicalJsonStringify(changeSet.scope.organization_scope ?? null) !== canonicalJsonStringify(effect.organization_scope ?? null)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "proposal scope must equal the Runner-derived effect", path: ["scope"] });
  }
  if (canonicalJsonStringify(changeSet.patch) !== canonicalJsonStringify(effect.set)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "proposal patch must equal the Runner-derived effect", path: ["patch"] });
  if (canonicalJsonStringify(changeSet.guards.allowed_columns) !== canonicalJsonStringify(effect.allowed_columns)
    || canonicalJsonStringify(changeSet.guards.tenant ?? null) !== canonicalJsonStringify(effect.tenant_guard ?? null)
    || canonicalJsonStringify(changeSet.guards.organization_scope ?? null) !== canonicalJsonStringify(effect.organization_scope ?? null)
    || canonicalJsonStringify(changeSet.guards.expected_version ?? null) !== canonicalJsonStringify(effect.expected_version ?? null)
    || canonicalJsonStringify(changeSet.guards.version_advance ?? null) !== canonicalJsonStringify(effect.version_advance ?? null)
    || canonicalJsonStringify(changeSet.guards.deduplication ?? null) !== canonicalJsonStringify(effect.deduplication ?? null)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "proposal guards must equal the Runner-derived effect", path: ["guards"] });
  if (effect.principal_scope === undefined
    ? changeSet.guards.principal_scope !== undefined
    : changeSet.guards.principal_scope?.column !== effect.principal_scope.column || changeSet.guards.principal_scope.value !== effect.principal_scope.value) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "proposal principal scope must equal the Runner-derived effect", path: ["guards", "principal_scope"] });
  if (changeSet.approval.approval_class !== proof.approval_class
    || changeSet.approval.approval_policy_digest !== proof.approval_policy_digest
    || (proof.approval_path === "automatic_eligible") !== (changeSet.approval.mode === "policy")) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "approval authority is not bound to the eligible rule and decision path", path: ["approval"] });
  }
  if (effect.operation === "single_row_insert" && !effect.deduplication?.components.some((component) => component.source === "proposal_id" && component.value === changeSet.proposal_id)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "semantic INSERT proposal identity mismatch", path: ["semantic_authority", "effect", "deduplication"] });
});

const normalizedSemanticWritebackJobV5Base = z.object({
  protocol_version: z.literal(semanticProtocolVersions.normalizedWritebackJobV5),
  job_id: z.string().min(1).max(200),
  proposal_id: z.string().min(1).max(200),
  approval_id: sha256,
  proposal_hash: sha256,
  contract: leasedContractRefSchema.optional(),
  source_id: z.string().min(1).max(160),
  engine: z.enum(["postgres", "mysql"]),
  operation: z.enum(["single_row_update", "single_row_insert"]),
  target: z.object({
    schema: safeIdentifier,
    table: safeIdentifier,
    primary_key: z.object({ column: safeIdentifier, value: scalar.optional() }).strict(),
    tenant_guard: columnValueSchema.optional(),
    organization_scope: organizationScopeSchema.optional(),
    principal_scope: principalScopeSchema.optional(),
  }).strict(),
  allowed_columns: z.array(safeIdentifier).min(1).max(64),
  patch: nonEmptyScalarRecord,
  conflict_guard: z.union([
    z.object({ kind: z.literal("none") }).strict(),
    z.object({ kind: z.literal("version_column"), column: safeIdentifier, expected_value: scalar }).strict(),
  ]),
  version_advance: versionAdvanceSchema.optional(),
  deduplication: z.object({ components: z.array(semanticDeduplicationComponentSchema).min(1).max(8) }).strict().optional(),
  semantic_authority: semanticAuthorityV1Schema,
  idempotency_key: z.string().min(1).max(256),
  lease_expires_at: z.union([timestamp, z.number().int().positive()]),
  attempt_count: z.number().int().positive(),
}).strict();

function validateSemanticJob(job: z.infer<typeof normalizedSemanticWritebackJobV5Base>, ctx: z.RefinementCtx): void {
  const effect = job.semantic_authority.effect;
  if (job.operation !== effect.operation || job.source_id !== effect.source || job.target.schema !== effect.schema || job.target.table !== effect.table || canonicalJsonStringify(job.target.primary_key) !== canonicalJsonStringify(effect.primary_key)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "semantic writeback target does not match the exact effect", path: ["semantic_authority", "effect"] });
  if (canonicalJsonStringify(job.patch) !== canonicalJsonStringify(effect.set)
    || canonicalJsonStringify(job.allowed_columns) !== canonicalJsonStringify(effect.allowed_columns)
    || canonicalJsonStringify(job.target.tenant_guard ?? null) !== canonicalJsonStringify(effect.tenant_guard ?? null)
    || canonicalJsonStringify(job.target.organization_scope ?? null) !== canonicalJsonStringify(effect.organization_scope ?? null)
    || canonicalJsonStringify(job.version_advance ?? null) !== canonicalJsonStringify(effect.version_advance ?? null)
    || canonicalJsonStringify(job.deduplication ?? null) !== canonicalJsonStringify(effect.deduplication ?? null)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "semantic writeback mutation differs from the exact effect", path: ["patch"] });
  if (effect.principal_scope === undefined
    ? job.target.principal_scope !== undefined
    : job.target.principal_scope?.column !== effect.principal_scope.column || job.target.principal_scope.value !== effect.principal_scope.value) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "semantic writeback principal scope mismatch", path: ["target", "principal_scope"] });
  if (job.operation === "single_row_update") {
    if (job.conflict_guard.kind !== "version_column" || job.conflict_guard.column !== effect.expected_version?.column || job.conflict_guard.expected_value !== effect.expected_version?.value) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "semantic UPDATE conflict guard mismatch", path: ["conflict_guard"] });
  } else if (job.conflict_guard.kind !== "none") ctx.addIssue({ code: z.ZodIssueCode.custom, message: "semantic INSERT must not carry an existing-row conflict guard", path: ["conflict_guard"] });
}

export const normalizedWritebackJobV5InputSchema = normalizedSemanticWritebackJobV5Base.superRefine(validateSemanticJob);

export const writebackJobV5Schema = z.object({
  schema_version: z.literal(semanticProtocolVersions.writebackJobV5),
  writeback_job_id: z.string().min(1).max(200),
  proposal_id: z.string().min(1).max(200),
  proposal_hash: sha256,
  approval_id: sha256,
  contract: leasedContractRefSchema.optional(),
  runner_scope: z.object({ project_id: z.string().min(1), source_id: z.string().min(1).max(160) }).strict(),
  engine: z.enum(["postgres", "mysql"]),
  operation: z.enum(["single_row_update", "single_row_insert"]),
  target: normalizedSemanticWritebackJobV5Base.shape.target,
  allowed_columns: normalizedSemanticWritebackJobV5Base.shape.allowed_columns,
  patch: nonEmptyScalarRecord,
  conflict_guard: normalizedSemanticWritebackJobV5Base.shape.conflict_guard,
  version_advance: versionAdvanceSchema.optional(),
  deduplication: normalizedSemanticWritebackJobV5Base.shape.deduplication,
  semantic_authority: semanticAuthorityV1Schema,
  idempotency_key: z.string().min(1).max(256),
  lease: z.object({ lease_id: z.string().min(1), attempt: z.number().int().positive(), expires_at: timestamp }).strict(),
}).strict().transform((job) => ({
  protocol_version: semanticProtocolVersions.normalizedWritebackJobV5,
  job_id: job.writeback_job_id,
  proposal_id: job.proposal_id,
  approval_id: job.approval_id,
  proposal_hash: job.proposal_hash,
  ...(job.contract === undefined ? {} : { contract: job.contract }),
  source_id: job.runner_scope.source_id,
  engine: job.engine,
  operation: job.operation,
  target: job.target,
  allowed_columns: job.allowed_columns,
  patch: job.patch,
  conflict_guard: job.conflict_guard,
  ...(job.version_advance === undefined ? {} : { version_advance: job.version_advance }),
  ...(job.deduplication === undefined ? {} : { deduplication: job.deduplication }),
  semantic_authority: job.semantic_authority,
  idempotency_key: job.idempotency_key,
  lease_expires_at: job.lease.expires_at,
  attempt_count: job.lease.attempt,
})).pipe(normalizedWritebackJobV5InputSchema);

export const semanticVerificationResultSchema = z.object({
  status: z.enum(["reverified", "previously_reverified", "refused", "not_run"]),
  proof_digest: sha256,
  action_rule_digest: sha256,
  compiled_plan_digest: sha256,
  proposal_dependency_set_digest: sha256,
  dependency_set_digest: sha256.optional(),
  effect_digest: sha256,
  checked_at: timestamp.optional(),
}).strict().superRefine((verification, ctx) => {
  if (["reverified", "previously_reverified"].includes(verification.status)
    && verification.dependency_set_digest === undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "completed semantic verification requires the transaction dependency digest", path: ["dependency_set_digest"] });
  }
  if (verification.status === "reverified" && verification.checked_at === undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "transaction-time semantic verification requires its check time", path: ["checked_at"] });
  }
});

export const normalizedWritebackResultV5Schema = z.object({
  protocol_version: z.literal(semanticProtocolVersions.normalizedWritebackJobV5),
  job_id: z.string().min(1).max(200),
  runner_id: z.string().min(1).max(200),
  operation: z.enum(["single_row_update", "single_row_insert"]),
  receipt_authority: z.enum(["source_db", "runner_ledger"]),
  status: z.enum(["applied", "conflict", "failed", "canceled", "already_applied", "reconciliation_required"]),
  affected_rows: z.number().int().min(0).max(1),
  target_identity: z.array(columnValueSchema).min(1).max(8),
  before_digest: sha256.optional(),
  after_digest: sha256.optional(),
  semantic_verification: semanticVerificationResultSchema,
  result_hash: sha256.optional(),
  completed_at: timestamp,
  error_code: z.string().regex(/^[A-Z][A-Z0-9_]*$/).optional(),
  intent_id: z.string().min(1).max(240).optional(),
}).strict().superRefine((result, ctx) => {
  if (result.status === "applied" && result.semantic_verification.status !== "reverified") {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "semantic apply requires transaction-time re-verification", path: ["semantic_verification", "status"] });
  }
  if (result.status === "already_applied" && !["reverified", "previously_reverified"].includes(result.semantic_verification.status)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "semantic idempotent replay requires prior re-verification", path: ["semantic_verification", "status"] });
  }
  if (result.status === "reconciliation_required" && !result.intent_id) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "reconciliation_required results require intent_id", path: ["intent_id"] });
  }
});

export const executionReceiptV5Schema = z.object({
  schema_version: z.literal(semanticProtocolVersions.executionReceiptV5),
  writeback_job_id: z.string().min(1).max(200),
  proposal_id: z.string().min(1).max(200),
  proposal_hash: sha256,
  approval_id: sha256,
  runner_id: z.string().min(1).max(200),
  operation: z.enum(["single_row_update", "single_row_insert"]),
  receipt_authority: z.enum(["source_db", "runner_ledger"]),
  status: z.enum(["applied", "conflict", "failed", "canceled", "already_applied", "reconciliation_required"]),
  target: z.object({
    source_id: z.string().min(1).max(160),
    schema: safeIdentifier,
    table: safeIdentifier,
    identity: z.array(columnValueSchema).min(1).max(8),
  }).strict(),
  rows_affected: z.number().int().min(0).max(1),
  idempotency_key: z.string().min(1).max(256),
  before_digest: sha256.optional(),
  after_digest: sha256.optional(),
  semantic_verification: semanticVerificationResultSchema,
  source_database_mutated: z.boolean(),
  safe_outcome_code: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
  safe_error_code: z.string().regex(/^[A-Z][A-Z0-9_]*$/).optional(),
  executed_at: timestamp,
  receipt_hash: sha256,
  reconciliation: z.object({ intent_id: z.string().min(1).max(240), reason: z.string().min(1).max(500) }).strict().optional(),
}).strict().superRefine((receipt, ctx) => {
  const { receipt_hash: _receiptHash, ...receiptCore } = receipt;
  if (canonicalJsonDigest(receiptCore) !== receipt.receipt_hash) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "semantic execution receipt hash mismatch", path: ["receipt_hash"] });
  }
  if (receipt.rows_affected > 0 && !receipt.source_database_mutated) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "mutated rows require source_database_mutated", path: ["source_database_mutated"] });
  }
  if (receipt.status === "applied" && receipt.semantic_verification.status !== "reverified") {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "semantic apply receipt requires transaction-time re-verification", path: ["semantic_verification", "status"] });
  }
  if (receipt.status === "reconciliation_required" && !receipt.reconciliation) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "reconciliation_required receipts require reconciliation metadata", path: ["reconciliation"] });
  }
});

export type SemanticDependencyV1 = z.infer<typeof semanticDependencyV1Schema>;
export type SemanticSubjectBindingV1 = z.infer<typeof semanticSubjectBindingV1Schema>;
export type ExactDerivedEffectProtocolV1 = z.infer<typeof exactDerivedEffectV1Schema>;
export type EligibilityProofV1 = z.infer<typeof eligibilityProofV1Schema>;
export type SemanticAuthorityV1 = z.infer<typeof semanticAuthorityV1Schema>;
export type SemanticVerificationResultV1 = z.infer<typeof semanticVerificationResultSchema>;
export type ChangeSetV4 = z.infer<typeof changeSetV4Schema>;
export type WritebackJobV5 = z.input<typeof writebackJobV5Schema>;
export type NormalizedWritebackJobV5 = z.infer<typeof normalizedWritebackJobV5InputSchema>;
export type NormalizedWritebackResultV5 = z.infer<typeof normalizedWritebackResultV5Schema>;
export type ExecutionReceiptV5 = z.infer<typeof executionReceiptV5Schema>;

export function eligibilityProofDigest(proof: Omit<EligibilityProofV1, "proof_digest">): `sha256:${string}` {
  return canonicalJsonDigest(proof);
}

export function exactDerivedEffectDigest(effect: Omit<ExactDerivedEffectProtocolV1, "effect_digest">): `sha256:${string}` {
  return canonicalJsonDigest(effect);
}

export function parseEligibilityProof(input: unknown): EligibilityProofV1 {
  return eligibilityProofV1Schema.parse(input);
}

export function parseSemanticAuthority(input: unknown): SemanticAuthorityV1 {
  return semanticAuthorityV1Schema.parse(input);
}

export function parseSemanticVerificationResult(input: unknown): SemanticVerificationResultV1 {
  return semanticVerificationResultSchema.parse(input);
}
