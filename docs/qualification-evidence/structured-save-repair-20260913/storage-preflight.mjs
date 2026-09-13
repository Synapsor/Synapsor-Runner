var __require = /* @__PURE__ */ ((x) => typeof require !== "undefined" ? require : typeof Proxy !== "undefined" ? new Proxy(x, {
  get: (a2, b) => (typeof require !== "undefined" ? require : a2)[b]
}) : x)(function(x) {
  if (typeof require !== "undefined") return require.apply(this, arguments);
  throw Error('Dynamic require of "' + x + '" is not supported');
});

// ../Progress docs tracking/r13-e07-20260911/isolation-completion-591555b/preflight-entry.ts
import fs5 from "node:fs/promises";

// ../synapsor-runner/apps/runner/src/qualification-storage-preflight.ts
import fs4 from "node:fs/promises";
import path6 from "node:path";

// ../synapsor-runner/packages/protocol/src/index.ts
import { z as z2 } from "zod";

// ../synapsor-runner/packages/protocol/src/canonical-json.ts
import crypto from "node:crypto";
function canonicalJsonStringify(input) {
  return JSON.stringify(canonicalJsonValue(input, /* @__PURE__ */ new Set()));
}
function canonicalJsonDigest(input) {
  return `sha256:${crypto.createHash("sha256").update(canonicalJsonStringify(input)).digest("hex")}`;
}
function canonicalJsonValue(input, ancestors) {
  if (input === null || typeof input === "string" || typeof input === "boolean") return input;
  if (typeof input === "number") {
    if (!Number.isFinite(input)) throw new TypeError("canonical JSON accepts only finite numbers");
    return Object.is(input, -0) ? 0 : input;
  }
  if (Array.isArray(input)) {
    if (ancestors.has(input)) throw new TypeError("canonical JSON does not accept circular values");
    ancestors.add(input);
    const output2 = input.map((item) => canonicalJsonValue(item, ancestors));
    ancestors.delete(input);
    return output2;
  }
  if (typeof input !== "object" || input === void 0) throw new TypeError("canonical JSON accepts only JSON values");
  const record2 = input;
  const prototype = Object.getPrototypeOf(record2);
  if (prototype !== Object.prototype && prototype !== null) throw new TypeError("canonical JSON accepts only plain objects");
  if (ancestors.has(record2)) throw new TypeError("canonical JSON does not accept circular values");
  ancestors.add(record2);
  const output = {};
  for (const key2 of Object.keys(record2).sort()) {
    const value = record2[key2];
    if (value === void 0) throw new TypeError("canonical JSON does not accept undefined values");
    output[key2] = canonicalJsonValue(value, ancestors);
  }
  ancestors.delete(record2);
  return output;
}

// ../synapsor-runner/packages/protocol/src/semantic-action.ts
import { z } from "zod";
var semanticProtocolVersions = {
  eligibilityProof: "synapsor.eligibility-proof.v1",
  changeSetV4: "synapsor.change-set.v4",
  writebackJobV5: "synapsor.writeback-job.v5",
  executionReceiptV5: "synapsor.execution-receipt.v5",
  normalizedWritebackJobV5: "5.0"
};
var scalar = z.union([z.string(), z.number().finite(), z.boolean(), z.null()]);
var scalarRecord = z.record(scalar).refine((value) => Object.keys(value).length <= 256, "object exceeds 256 fields");
var nonEmptyScalarRecord = scalarRecord.refine((value) => Object.keys(value).length > 0, "object must not be empty");
var sha256 = z.string().regex(/^sha256:[a-f0-9]{64}$/, "expected exact sha256 digest");
var safeIdentifier = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "expected fixed safe identifier");
var reviewedName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_.:-]{0,127}$/, "expected fixed reviewed name");
var qualifiedName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+$/, "expected fixed qualified name");
var timestamp = z.string().datetime({ offset: false });
var delegationProofV1Schema = z.object({
  schema_version: z.literal("synapsor.delegation-proof.v1"),
  binding_digest: sha256,
  policy_chain_digest: sha256,
  actor_digest: sha256,
  valid_until: timestamp
}).strict();
var columnValueSchema = z.object({ column: safeIdentifier, value: scalar }).strict();
var principalScopeSchema = z.object({
  schema_version: z.literal("synapsor.principal-scope.v1"),
  column: safeIdentifier,
  binding: safeIdentifier,
  provider: z.enum(["environment", "http_claims", "cloud_session", "static_dev"]),
  value_fingerprint: sha256,
  value: scalar.optional()
}).strict();
var organizationScopeSchema = z.object({
  mode: z.literal("single_organization"),
  organization_id: z.string().min(1).max(256)
}).strict();
var contractProvenanceSchema = z.object({
  digest: sha256,
  version: z.string().min(1).max(128)
}).strict();
var leasedContractRefSchema = z.object({
  contract_id: z.string().min(1).max(200),
  contract_version_id: z.string().min(1).max(200),
  digest: sha256
}).strict();
var versionAdvanceSchema = z.object({
  column: safeIdentifier,
  strategy: z.literal("integer_increment")
}).strict();
var semanticDependencyV1Schema = z.object({
  binding: safeIdentifier,
  resource: qualifiedName,
  primary_key: columnValueSchema,
  version: columnValueSchema.optional(),
  row_digest: sha256
}).strict();
var semanticSubjectBindingV1Schema = z.object({
  binding: safeIdentifier,
  resource: qualifiedName,
  subject_ref_digest: sha256
}).strict();
var semanticDeduplicationComponentSchema = z.object({
  column: safeIdentifier,
  source: z.enum(["proposal_id", "trusted_tenant", "derived", "fixed"]),
  value: scalar
}).strict();
var exactDerivedEffectUnsignedSchema = z.object({
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
  deduplication: z.object({ components: z.array(semanticDeduplicationComponentSchema).min(1).max(8) }).strict().optional()
}).strict();
function validateExactDerivedEffect(effect, ctx) {
  const { effect_digest: _digest, ...unsigned } = effect;
  if (canonicalJsonDigest(unsigned) !== effect.effect_digest) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "derived effect digest mismatch", path: ["effect_digest"] });
  const sorted = [...effect.allowed_columns].sort();
  if (new Set(effect.allowed_columns).size !== effect.allowed_columns.length || canonicalJsonStringify(sorted) !== canonicalJsonStringify(effect.allowed_columns)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "allowed columns must be unique and canonically sorted", path: ["allowed_columns"] });
  if (canonicalJsonStringify(Object.keys(effect.set).sort()) !== canonicalJsonStringify(effect.allowed_columns)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "exact effect set must match its allowed columns", path: ["set"] });
  if (effect.tenant_guard === void 0 === (effect.organization_scope === void 0)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "exactly one trusted tenant guard or reviewed single-organization scope is required", path: ["tenant_guard"] });
  for (const guard of [effect.primary_key.column, effect.tenant_guard?.column, effect.principal_scope?.column, effect.expected_version?.column, effect.version_advance?.column]) {
    if (guard !== void 0 && effect.allowed_columns.includes(guard)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `guard column must not be writable: ${guard}`, path: ["allowed_columns"] });
  }
  if (effect.operation === "single_row_update") {
    if (effect.primary_key.value === void 0 || effect.expected_version === void 0 || effect.deduplication !== void 0) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "semantic UPDATE requires exact identity/version and no insert deduplication", path: ["operation"] });
    if (effect.version_advance !== void 0 && effect.version_advance.column !== effect.expected_version?.column) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "version advance must match expected version column", path: ["version_advance"] });
  } else {
    if (effect.expected_version !== void 0 || effect.version_advance !== void 0 || effect.deduplication === void 0) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "semantic INSERT requires deduplication and no existing-row version guard", path: ["operation"] });
    const components = effect.deduplication?.components ?? [];
    if (!components.some((component) => component.source === "proposal_id")) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "semantic INSERT deduplication requires proposal identity", path: ["deduplication"] });
    if (effect.tenant_guard !== void 0 && !components.some((component) => component.source === "trusted_tenant" && component.column === effect.tenant_guard?.column && component.value === effect.tenant_guard?.value)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "semantic INSERT deduplication must bind the trusted tenant", path: ["deduplication"] });
  }
}
var exactSingleDerivedEffectV1Schema = exactDerivedEffectUnsignedSchema.extend({ effect_digest: sha256 }).strict().superRefine(validateExactDerivedEffect);
var exactDerivedEffectV1Schema = exactDerivedEffectUnsignedSchema.extend({
  effect_digest: sha256,
  atomic_updates: z.array(exactSingleDerivedEffectV1Schema).min(1).max(3).optional()
}).strict().superRefine((effect, ctx) => {
  validateExactDerivedEffect(effect, ctx);
  if (!effect.atomic_updates) return;
  const members = [effect, ...effect.atomic_updates];
  const identities = /* @__PURE__ */ new Set();
  for (const [index, member] of members.entries()) {
    const path7 = index === 0 ? [] : ["atomic_updates", index - 1];
    if (member.operation !== "single_row_update" || !member.version_advance || member.expected_version?.column !== member.version_advance.column) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: path7, message: "every atomic update requires an exact version-advancing UPDATE" });
    }
    if (member.source !== effect.source || member.tenant_guard?.value !== effect.tenant_guard?.value || canonicalJsonStringify(member.organization_scope ?? null) !== canonicalJsonStringify(effect.organization_scope ?? null) || member.principal_scope && effect.principal_scope && member.principal_scope.value !== effect.principal_scope.value) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: path7, message: "atomic updates must share the same trusted source and scope" });
    }
    const identity = canonicalJsonStringify([member.schema, member.table, member.primary_key, member.tenant_guard?.value ?? null]);
    if (identities.has(identity)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: path7, message: "atomic updates cannot repeat a physical target" });
    identities.add(identity);
  }
});
var eligibilityProofUnsignedSchema = z.object({
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
    timezone: z.literal("UTC")
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
  delegation: delegationProofV1Schema.optional(),
  verified_at: timestamp,
  valid_until: timestamp,
  uses: z.literal(1)
}).strict();
var eligibilityProofV1Schema = eligibilityProofUnsignedSchema.extend({
  proof_digest: sha256
}).strict().superRefine((proof, ctx) => {
  const { proof_digest: _digest, ...unsigned } = proof;
  if (canonicalJsonDigest(unsigned) !== proof.proof_digest) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "eligibility proof digest mismatch", path: ["proof_digest"] });
  if (Date.parse(proof.valid_until) <= Date.parse(proof.verified_at)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "eligibility proof must expire after verification", path: ["valid_until"] });
  if (proof.delegation && Date.parse(proof.valid_until) > Date.parse(proof.delegation.valid_until)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "eligibility proof must not outlive its delegation", path: ["delegation", "valid_until"] });
  }
});
var semanticAuthorityV1Schema = z.object({
  proof: eligibilityProofV1Schema,
  business_inputs: z.record(safeIdentifier, scalar).optional(),
  subject_bindings: z.array(semanticSubjectBindingV1Schema).min(1).max(8),
  dependencies: z.array(semanticDependencyV1Schema).min(1).max(100),
  effect: exactDerivedEffectV1Schema
}).strict().superRefine((semantic, ctx) => {
  if ((semantic.business_inputs !== void 0 || semantic.proof.business_inputs_digest !== void 0) && (!semantic.business_inputs || semantic.proof.business_inputs_digest !== canonicalJsonDigest(semantic.business_inputs))) {
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
  for (const [index, effect] of (semantic.effect.atomic_updates ?? []).entries()) {
    if (!semantic.dependencies.some((dependency) => dependency.resource === effect.resource && canonicalJsonStringify(dependency.primary_key) === canonicalJsonStringify(effect.primary_key) && canonicalJsonStringify(dependency.version ?? null) === canonicalJsonStringify(effect.expected_version ?? null))) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["effect", "atomic_updates", index], message: "atomic update must match one verified dependency identity and version" });
    }
  }
});
var semanticChangeSetBaseSchema = z.object({
  schema_version: z.literal(semanticProtocolVersions.changeSetV4),
  proposal_id: z.string().min(1).max(200),
  proposal_version: z.number().int().positive(),
  action: qualifiedName,
  contract: contractProvenanceSchema.optional(),
  operation: z.enum(["single_row_update", "single_row_insert"]),
  mode: z.enum(["review_required", "approved_for_writeback"]),
  principal: z.object({
    id: z.string().min(1).max(200),
    source: z.enum(["trusted_session", "cloud_session", "environment", "static_dev"])
  }).strict(),
  scope: z.object({
    tenant_id: z.string().min(1).max(256).optional(),
    organization_scope: organizationScopeSchema.optional(),
    business_object: z.string().min(1).max(160),
    object_id: z.string().min(1).max(200)
  }).strict().superRefine((scope2, ctx) => {
    if (scope2.tenant_id === void 0 === (scope2.organization_scope === void 0)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "exactly one trusted tenant or reviewed single-organization scope is required",
        path: ["tenant_id"]
      });
    }
  }),
  source: z.object({
    kind: z.enum(["external_postgres", "external_mysql"]),
    source_id: z.string().min(1).max(160),
    schema: safeIdentifier,
    table: safeIdentifier,
    primary_key: z.object({ column: safeIdentifier, value: scalar.optional() }).strict()
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
    deduplication: z.object({ components: z.array(semanticDeduplicationComponentSchema).min(1).max(8) }).strict().optional()
  }).strict(),
  evidence: z.object({
    bundle_id: z.string().min(1).max(200),
    query_fingerprint: sha256,
    items: z.array(z.unknown()).max(100)
  }).passthrough(),
  approval: z.object({
    status: z.enum(["pending", "approved", "rejected", "canceled"]),
    mode: z.enum(["human", "policy"]),
    approval_class: qualifiedName,
    approval_policy_digest: sha256,
    required_role: z.string().min(1).max(160).optional(),
    required_approvals: z.number().int().min(1).max(10).optional()
  }).passthrough(),
  writeback: z.object({
    status: z.enum(["not_applied", "pending_worker", "applied", "conflict", "failed", "canceled", "reconciliation_required"]),
    mode: z.enum(["trusted_worker_required", "read_only"]),
    executor: z.literal("semantic_rule").optional()
  }).passthrough(),
  semantic_authority: semanticAuthorityV1Schema,
  source_database_mutated: z.literal(false),
  integrity: z.object({ proposal_hash: sha256 }).strict(),
  created_at: timestamp
}).strict();
var changeSetV4Schema = semanticChangeSetBaseSchema.superRefine((changeSet, ctx) => {
  const { integrity: _integrity, ...proposalCore } = changeSet;
  if (canonicalJsonDigest(proposalCore) !== changeSet.integrity.proposal_hash) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "semantic proposal hash mismatch", path: ["integrity", "proposal_hash"] });
  }
  const effect = changeSet.semantic_authority.effect;
  const proof = changeSet.semantic_authority.proof;
  if (changeSet.action !== proof.outcome || changeSet.operation !== effect.operation) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "semantic action or operation mismatch", path: ["semantic_authority"] });
  if (changeSet.source.source_id !== effect.source || changeSet.source.schema !== effect.schema || changeSet.source.table !== effect.table || canonicalJsonStringify(changeSet.source.primary_key) !== canonicalJsonStringify(effect.primary_key)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "semantic target mismatch", path: ["source"] });
  if (effect.tenant_guard !== void 0 ? changeSet.scope.tenant_id !== effect.tenant_guard.value || changeSet.scope.organization_scope !== void 0 : changeSet.scope.tenant_id !== void 0 || canonicalJsonStringify(changeSet.scope.organization_scope ?? null) !== canonicalJsonStringify(effect.organization_scope ?? null)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "proposal scope must equal the Runner-derived effect", path: ["scope"] });
  }
  if (canonicalJsonStringify(changeSet.patch) !== canonicalJsonStringify(effect.set)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "proposal patch must equal the Runner-derived effect", path: ["patch"] });
  if (canonicalJsonStringify(changeSet.guards.allowed_columns) !== canonicalJsonStringify(effect.allowed_columns) || canonicalJsonStringify(changeSet.guards.tenant ?? null) !== canonicalJsonStringify(effect.tenant_guard ?? null) || canonicalJsonStringify(changeSet.guards.organization_scope ?? null) !== canonicalJsonStringify(effect.organization_scope ?? null) || canonicalJsonStringify(changeSet.guards.expected_version ?? null) !== canonicalJsonStringify(effect.expected_version ?? null) || canonicalJsonStringify(changeSet.guards.version_advance ?? null) !== canonicalJsonStringify(effect.version_advance ?? null) || canonicalJsonStringify(changeSet.guards.deduplication ?? null) !== canonicalJsonStringify(effect.deduplication ?? null)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "proposal guards must equal the Runner-derived effect", path: ["guards"] });
  if (effect.principal_scope === void 0 ? changeSet.guards.principal_scope !== void 0 : changeSet.guards.principal_scope?.column !== effect.principal_scope.column || changeSet.guards.principal_scope.value !== effect.principal_scope.value) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "proposal principal scope must equal the Runner-derived effect", path: ["guards", "principal_scope"] });
  if (changeSet.approval.approval_class !== proof.approval_class || changeSet.approval.approval_policy_digest !== proof.approval_policy_digest || proof.approval_path === "automatic_eligible" !== (changeSet.approval.mode === "policy")) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "approval authority is not bound to the eligible rule and decision path", path: ["approval"] });
  }
  if (effect.operation === "single_row_insert" && !effect.deduplication?.components.some((component) => component.source === "proposal_id" && component.value === changeSet.proposal_id)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "semantic INSERT proposal identity mismatch", path: ["semantic_authority", "effect", "deduplication"] });
});
var normalizedSemanticWritebackJobV5Base = z.object({
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
    principal_scope: principalScopeSchema.optional()
  }).strict(),
  allowed_columns: z.array(safeIdentifier).min(1).max(64),
  patch: nonEmptyScalarRecord,
  conflict_guard: z.union([
    z.object({ kind: z.literal("none") }).strict(),
    z.object({ kind: z.literal("version_column"), column: safeIdentifier, expected_value: scalar }).strict()
  ]),
  version_advance: versionAdvanceSchema.optional(),
  deduplication: z.object({ components: z.array(semanticDeduplicationComponentSchema).min(1).max(8) }).strict().optional(),
  semantic_authority: semanticAuthorityV1Schema,
  idempotency_key: z.string().min(1).max(256),
  lease_expires_at: z.union([timestamp, z.number().int().positive()]),
  attempt_count: z.number().int().positive()
}).strict();
function validateSemanticJob(job, ctx) {
  const effect = job.semantic_authority.effect;
  if (job.operation !== effect.operation || job.source_id !== effect.source || job.target.schema !== effect.schema || job.target.table !== effect.table || canonicalJsonStringify(job.target.primary_key) !== canonicalJsonStringify(effect.primary_key)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "semantic writeback target does not match the exact effect", path: ["semantic_authority", "effect"] });
  if (canonicalJsonStringify(job.patch) !== canonicalJsonStringify(effect.set) || canonicalJsonStringify(job.allowed_columns) !== canonicalJsonStringify(effect.allowed_columns) || canonicalJsonStringify(job.target.tenant_guard ?? null) !== canonicalJsonStringify(effect.tenant_guard ?? null) || canonicalJsonStringify(job.target.organization_scope ?? null) !== canonicalJsonStringify(effect.organization_scope ?? null) || canonicalJsonStringify(job.version_advance ?? null) !== canonicalJsonStringify(effect.version_advance ?? null) || canonicalJsonStringify(job.deduplication ?? null) !== canonicalJsonStringify(effect.deduplication ?? null)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "semantic writeback mutation differs from the exact effect", path: ["patch"] });
  if (effect.principal_scope === void 0 ? job.target.principal_scope !== void 0 : job.target.principal_scope?.column !== effect.principal_scope.column || job.target.principal_scope.value !== effect.principal_scope.value) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "semantic writeback principal scope mismatch", path: ["target", "principal_scope"] });
  if (job.operation === "single_row_update") {
    if (job.conflict_guard.kind !== "version_column" || job.conflict_guard.column !== effect.expected_version?.column || job.conflict_guard.expected_value !== effect.expected_version?.value) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "semantic UPDATE conflict guard mismatch", path: ["conflict_guard"] });
  } else if (job.conflict_guard.kind !== "none") ctx.addIssue({ code: z.ZodIssueCode.custom, message: "semantic INSERT must not carry an existing-row conflict guard", path: ["conflict_guard"] });
}
var normalizedWritebackJobV5InputSchema = normalizedSemanticWritebackJobV5Base.superRefine(validateSemanticJob);
var writebackJobV5Schema = z.object({
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
  lease: z.object({ lease_id: z.string().min(1), attempt: z.number().int().positive(), expires_at: timestamp }).strict()
}).strict().transform((job) => ({
  protocol_version: semanticProtocolVersions.normalizedWritebackJobV5,
  job_id: job.writeback_job_id,
  proposal_id: job.proposal_id,
  approval_id: job.approval_id,
  proposal_hash: job.proposal_hash,
  ...job.contract === void 0 ? {} : { contract: job.contract },
  source_id: job.runner_scope.source_id,
  engine: job.engine,
  operation: job.operation,
  target: job.target,
  allowed_columns: job.allowed_columns,
  patch: job.patch,
  conflict_guard: job.conflict_guard,
  ...job.version_advance === void 0 ? {} : { version_advance: job.version_advance },
  ...job.deduplication === void 0 ? {} : { deduplication: job.deduplication },
  semantic_authority: job.semantic_authority,
  idempotency_key: job.idempotency_key,
  lease_expires_at: job.lease.expires_at,
  attempt_count: job.lease.attempt
})).pipe(normalizedWritebackJobV5InputSchema);
var semanticVerificationResultSchema = z.object({
  status: z.enum(["reverified", "previously_reverified", "refused", "not_run"]),
  proof_digest: sha256,
  action_rule_digest: sha256,
  compiled_plan_digest: sha256,
  proposal_dependency_set_digest: sha256,
  dependency_set_digest: sha256.optional(),
  effect_digest: sha256,
  checked_at: timestamp.optional()
}).strict().superRefine((verification, ctx) => {
  if (["reverified", "previously_reverified"].includes(verification.status) && verification.dependency_set_digest === void 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "completed semantic verification requires the transaction dependency digest", path: ["dependency_set_digest"] });
  }
  if (verification.status === "reverified" && verification.checked_at === void 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "transaction-time semantic verification requires its check time", path: ["checked_at"] });
  }
});
var atomicEffectResultSchema = z.object({
  resource: qualifiedName,
  schema: safeIdentifier,
  table: safeIdentifier,
  effect_digest: sha256,
  target_identity: z.array(columnValueSchema).min(1).max(8),
  affected_rows: z.number().int().min(0).max(1),
  before_digest: sha256.optional(),
  after_digest: sha256.optional()
}).strict();
var atomicEffectResultsSchema = z.array(atomicEffectResultSchema).min(2).max(4);
function validateAtomicEffectResults(status, rows, effects, ctx) {
  if (!effects) {
    if (rows > 1) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "multiple rows require complete atomic effect results", path: ["atomic_effects"] });
    return;
  }
  const identities = effects.map((effect) => canonicalJsonStringify([effect.schema, effect.table, effect.target_identity]));
  if (new Set(identities).size !== identities.length || effects.reduce((sum, effect) => sum + effect.affected_rows, 0) !== rows || (status === "applied" ? effects.some((effect) => effect.affected_rows !== 1 || !effect.after_digest) : rows !== 0)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "atomic results require distinct targets and complete all-or-nothing affected-row evidence", path: ["atomic_effects"] });
  }
}
var normalizedWritebackResultV5Schema = z.object({
  protocol_version: z.literal(semanticProtocolVersions.normalizedWritebackJobV5),
  job_id: z.string().min(1).max(200),
  runner_id: z.string().min(1).max(200),
  operation: z.enum(["single_row_update", "single_row_insert"]),
  receipt_authority: z.enum(["source_db", "runner_ledger"]),
  status: z.enum(["applied", "conflict", "failed", "canceled", "already_applied", "reconciliation_required"]),
  affected_rows: z.number().int().min(0).max(4),
  atomic_effects: atomicEffectResultsSchema.optional(),
  target_identity: z.array(columnValueSchema).min(1).max(8),
  before_digest: sha256.optional(),
  after_digest: sha256.optional(),
  semantic_verification: semanticVerificationResultSchema,
  result_hash: sha256.optional(),
  completed_at: timestamp,
  error_code: z.string().regex(/^[A-Z][A-Z0-9_]*$/).optional(),
  intent_id: z.string().min(1).max(240).optional()
}).strict().superRefine((result, ctx) => {
  validateAtomicEffectResults(result.status, result.affected_rows, result.atomic_effects, ctx);
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
var executionReceiptV5Schema = z.object({
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
    identity: z.array(columnValueSchema).min(1).max(8)
  }).strict(),
  rows_affected: z.number().int().min(0).max(4),
  atomic_effects: atomicEffectResultsSchema.optional(),
  idempotency_key: z.string().min(1).max(256),
  before_digest: sha256.optional(),
  after_digest: sha256.optional(),
  semantic_verification: semanticVerificationResultSchema,
  source_database_mutated: z.boolean(),
  safe_outcome_code: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
  safe_error_code: z.string().regex(/^[A-Z][A-Z0-9_]*$/).optional(),
  executed_at: timestamp,
  receipt_hash: sha256,
  reconciliation: z.object({ intent_id: z.string().min(1).max(240), reason: z.string().min(1).max(500) }).strict().optional()
}).strict().superRefine((receipt2, ctx) => {
  validateAtomicEffectResults(receipt2.status, receipt2.rows_affected, receipt2.atomic_effects, ctx);
  const { receipt_hash: _receiptHash, ...receiptCore } = receipt2;
  if (canonicalJsonDigest(receiptCore) !== receipt2.receipt_hash) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "semantic execution receipt hash mismatch", path: ["receipt_hash"] });
  }
  if (receipt2.rows_affected > 0 && !receipt2.source_database_mutated) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "mutated rows require source_database_mutated", path: ["source_database_mutated"] });
  }
  if (receipt2.status === "applied" && receipt2.semantic_verification.status !== "reverified") {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "semantic apply receipt requires transaction-time re-verification", path: ["semantic_verification", "status"] });
  }
  if (receipt2.status === "reconciliation_required" && !receipt2.reconciliation) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "reconciliation_required receipts require reconciliation metadata", path: ["reconciliation"] });
  }
});

// ../synapsor-runner/packages/protocol/src/privacy-boundary.ts
var PrivacyBoundaryError = class extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = "PrivacyBoundaryError";
  }
  code;
};
function enforcePrivacyBudgets(input) {
  if (input.snapshot.query_count >= input.limits.max_queries_per_session) {
    throw new PrivacyBoundaryError("QUERY_BUDGET_EXHAUSTED", "The reviewed per-session query budget is exhausted.");
  }
  if (input.snapshot.queries_last_minute >= input.limits.rate_limit_per_minute) {
    throw new PrivacyBoundaryError("RATE_LIMIT_EXHAUSTED", "The reviewed request rate is exhausted.");
  }
  if (input.estimated_response_cells > input.limits.max_response_cells || input.snapshot.extracted_cells + input.estimated_response_cells > input.limits.max_extracted_cells_per_session) {
    throw new PrivacyBoundaryError("EXTRACTION_BUDGET_EXHAUSTED", "The reviewed response or cumulative extraction budget would be exceeded.");
  }
  if (input.aggregate && input.snapshot.differencing_attempts >= input.limits.max_differencing_queries) {
    throw new PrivacyBoundaryError(
      "DIFFERENCING_BUDGET_EXHAUSTED",
      "Too many distinct filter or date-range variants of the same cohort-protected aggregate were requested in this privacy window."
    );
  }
}

// ../synapsor-runner/packages/protocol/src/index.ts
var scalar2 = z2.union([z2.string(), z2.number(), z2.boolean(), z2.null()]);
var scalarMap = z2.record(scalar2).refine((value) => Object.keys(value).length > 0, "object must not be empty");
var boundedScalarRecord = z2.record(scalar2).refine((value) => Object.keys(value).length <= 256, "object exceeds 256 fields");
var sha2562 = z2.string().regex(/^sha256:.+/, "expected sha256:<digest>");
var safeIdentifier2 = z2.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "expected fixed safe identifier");
var protocolVersions = {
  changeSet: "synapsor.change-set.v1",
  changeSetV2: "synapsor.change-set.v2",
  changeSetV3: "synapsor.change-set.v3",
  changeSetV4: "synapsor.change-set.v4",
  compensationChangeSet: "synapsor.compensation-change-set.v1",
  inverseDescriptor: "synapsor.inverse-descriptor.v1",
  writebackJob: "synapsor.writeback-job.v1",
  writebackJobV2: "synapsor.writeback-job.v2",
  writebackJobV3: "synapsor.writeback-job.v3",
  writebackJobV4: "synapsor.writeback-job.v4",
  writebackJobV5: "synapsor.writeback-job.v5",
  executionReceipt: "synapsor.execution-receipt.v1",
  executionReceiptV2: "synapsor.execution-receipt.v2",
  executionReceiptV3: "synapsor.execution-receipt.v3",
  executionReceiptV4: "synapsor.execution-receipt.v4",
  executionReceiptV5: "synapsor.execution-receipt.v5",
  runnerRegistration: "synapsor.runner-registration.v1",
  runnerControl: "synapsor.runner-control.v1",
  runnerProposal: "synapsor.runner-proposal.v1",
  runnerActivity: "synapsor.runner-activity.v1",
  principalScope: "synapsor.principal-scope.v1",
  freshnessAuthority: "synapsor.freshness-authority.v1",
  freshnessProof: "synapsor.freshness-proof.v1",
  legacyWritebackJob: "1.0",
  normalizedWritebackJobV2: "2.0",
  normalizedWritebackJobV3: "3.0",
  normalizedWritebackJobV4: "4.0",
  normalizedWritebackJobV5: "5.0"
};
var writebackEngineSchema = z2.enum(["postgres", "mysql"]);
var writebackTerminalStatusSchema = z2.enum([
  "applied",
  "conflict",
  "failed",
  "canceled",
  "already_applied",
  "reconciliation_required"
]);
var writebackTerminalStatusV2Schema = z2.enum([
  "applied",
  "conflict",
  "failed",
  "canceled",
  "already_applied",
  "reconciliation_required"
]);
var columnValueSchema2 = z2.object({
  column: safeIdentifier2,
  value: scalar2
});
var trustedScopeProviderSchema = z2.enum(["environment", "http_claims", "cloud_session", "static_dev"]);
function principalScopeFingerprint(input) {
  return canonicalJsonDigest({
    schema_version: protocolVersions.principalScope,
    column: input.column,
    binding: input.binding,
    provider: input.provider,
    value: input.value
  });
}
var principalScopeGuardSchema = z2.object({
  schema_version: z2.literal(protocolVersions.principalScope),
  column: safeIdentifier2,
  binding: safeIdentifier2,
  provider: trustedScopeProviderSchema,
  value_fingerprint: sha2562,
  value: scalar2.optional()
}).superRefine((scope2, ctx) => {
  if (scope2.value !== void 0 && principalScopeFingerprint(scope2) !== scope2.value_fingerprint) {
    ctx.addIssue({ code: z2.ZodIssueCode.custom, message: "principal scope fingerprint does not match its trusted value", path: ["value_fingerprint"] });
  }
});
var freshnessDependencyUnsignedSchema = z2.object({
  id: safeIdentifier2,
  capability: z2.string().regex(/^[A-Za-z_][A-Za-z0-9_.-]*\.[A-Za-z_][A-Za-z0-9_.-]*$/, "expected reviewed capability name"),
  source_id: z2.string().min(1).max(160),
  engine: writebackEngineSchema,
  target: z2.object({
    schema: safeIdentifier2,
    table: safeIdentifier2,
    primary_key: columnValueSchema2,
    tenant_column: safeIdentifier2,
    principal_column: safeIdentifier2.optional()
  }),
  expected_version: columnValueSchema2,
  evidence: z2.object({
    bundle_id: z2.string().min(1).max(200),
    query_fingerprint: sha2562
  })
});
var freshnessDependencyV1Schema = freshnessDependencyUnsignedSchema.extend({
  descriptor_digest: sha2562
}).superRefine((dependency, ctx) => {
  const { descriptor_digest: _digest, ...unsigned } = dependency;
  if (canonicalJsonDigest(unsigned) !== dependency.descriptor_digest) {
    ctx.addIssue({ code: z2.ZodIssueCode.custom, message: "freshness dependency digest mismatch", path: ["descriptor_digest"] });
  }
});
var freshnessAuthorityUnsignedSchema = z2.object({
  schema_version: z2.literal(protocolVersions.freshnessAuthority),
  required: z2.literal(true),
  target: z2.object({
    mode: z2.enum(["exact_guard", "frozen_set", "not_applicable"]),
    member_count: z2.number().int().min(0).max(100)
  }),
  dependencies: z2.array(freshnessDependencyV1Schema).max(16)
});
var freshnessAuthorityV1Schema = freshnessAuthorityUnsignedSchema.extend({
  dependency_set_digest: sha2562
}).superRefine((authority2, ctx) => {
  const identities = authority2.dependencies.map((dependency) => dependency.id);
  if (new Set(identities).size !== identities.length) {
    ctx.addIssue({ code: z2.ZodIssueCode.custom, message: "freshness dependency ids must be unique", path: ["dependencies"] });
  }
  const sorted = [...authority2.dependencies].sort((left, right) => left.source_id.localeCompare(right.source_id) || left.target.schema.localeCompare(right.target.schema) || left.target.table.localeCompare(right.target.table) || JSON.stringify(left.target.primary_key.value).localeCompare(JSON.stringify(right.target.primary_key.value)) || left.id.localeCompare(right.id));
  if (JSON.stringify(sorted) !== JSON.stringify(authority2.dependencies)) {
    ctx.addIssue({ code: z2.ZodIssueCode.custom, message: "freshness dependencies must use deterministic lock order", path: ["dependencies"] });
  }
  const { dependency_set_digest: _digest, ...unsigned } = authority2;
  if (canonicalJsonDigest(unsigned) !== authority2.dependency_set_digest) {
    ctx.addIssue({ code: z2.ZodIssueCode.custom, message: "freshness dependency-set digest mismatch", path: ["dependency_set_digest"] });
  }
});
var freshnessCheckStatusSchema = z2.enum(["fresh", "stale", "unavailable", "invalid", "unsupported"]);
var freshnessItemResultSchema = z2.object({
  id: z2.string().min(1).max(160),
  kind: z2.enum(["target", "supporting"]),
  status: z2.enum(["fresh", "stale", "not_applicable", "unavailable", "invalid", "unsupported"]),
  safe_code: z2.string().regex(/^[A-Z][A-Z0-9_]*$/),
  expected_version_digest: sha2562.optional(),
  observed_version_digest: sha2562.optional()
});
var freshnessProofUnsignedSchema = z2.object({
  schema_version: z2.literal(protocolVersions.freshnessProof),
  proposal_id: z2.string().min(1),
  proposal_hash: sha2562,
  proposal_version: z2.number().int().positive(),
  dependency_set_digest: sha2562,
  checked_at: z2.string().datetime(),
  valid_until: z2.string().datetime(),
  source_adapters: z2.array(z2.object({
    source_id: z2.string().min(1).max(160),
    engine: writebackEngineSchema
  })).min(1).max(8),
  result: freshnessCheckStatusSchema,
  safe_code: z2.string().regex(/^[A-Z][A-Z0-9_]*$/),
  target_count: z2.number().int().min(0).max(100),
  supporting_count: z2.number().int().min(0).max(16),
  checks: z2.array(freshnessItemResultSchema).max(116)
});
var freshnessProofV1Schema = freshnessProofUnsignedSchema.extend({
  proof_digest: sha2562
}).superRefine((proof, ctx) => {
  if (Date.parse(proof.valid_until) < Date.parse(proof.checked_at)) {
    ctx.addIssue({ code: z2.ZodIssueCode.custom, message: "freshness proof validity ends before it was checked", path: ["valid_until"] });
  }
  if (proof.checks.filter((check) => check.kind === "target").length !== proof.target_count) {
    ctx.addIssue({ code: z2.ZodIssueCode.custom, message: "freshness target count mismatch", path: ["target_count"] });
  }
  if (proof.checks.filter((check) => check.kind === "supporting").length !== proof.supporting_count) {
    ctx.addIssue({ code: z2.ZodIssueCode.custom, message: "freshness supporting count mismatch", path: ["supporting_count"] });
  }
  const { proof_digest: _digest, ...unsigned } = proof;
  if (canonicalJsonDigest(unsigned) !== proof.proof_digest) {
    ctx.addIssue({ code: z2.ZodIssueCode.custom, message: "freshness proof digest mismatch", path: ["proof_digest"] });
  }
});
var resolvedDeduplicationComponentSchema = z2.object({
  column: safeIdentifier2,
  value: scalar2,
  source: z2.enum(["proposal_id", "trusted_tenant", "fixed"])
});
var versionAdvanceSchema2 = z2.object({
  column: safeIdentifier2,
  strategy: z2.enum(["integer_increment", "database_generated"])
});
var setOperationSchema = z2.enum(["set_update", "set_delete", "batch_insert"]);
var aggregateBoundSchema = z2.object({
  column: safeIdentifier2,
  measure: z2.enum(["before", "after", "absolute_delta"]),
  maximum: z2.number().finite().nonnegative(),
  actual: z2.number().finite().nonnegative()
});
var frozenSetMemberSchema = z2.object({
  primary_key: columnValueSchema2,
  expected_version: columnValueSchema2.optional(),
  before: boundedScalarRecord,
  after: boundedScalarRecord,
  before_digest: sha2562.optional(),
  after_digest: sha2562.optional(),
  tombstone_digest: sha2562.optional(),
  deduplication: z2.object({ components: z2.array(resolvedDeduplicationComponentSchema).min(1).max(8) }).optional()
});
var frozenSetSchema = z2.object({
  max_rows: z2.number().int().min(1).max(100),
  row_count: z2.number().int().min(1).max(100),
  aggregate_bounds: z2.array(aggregateBoundSchema).min(1).max(8),
  members: z2.array(frozenSetMemberSchema).min(1).max(100),
  set_digest: sha2562
}).superRefine((set, ctx) => {
  if (set.members.length !== set.row_count || set.row_count > set.max_rows) ctx.addIssue({ code: z2.ZodIssueCode.custom, message: "frozen set count must equal members and remain within max_rows", path: ["row_count"] });
  for (const [index, bound] of set.aggregate_bounds.entries()) if (bound.actual > bound.maximum) ctx.addIssue({ code: z2.ZodIssueCode.custom, message: "frozen set aggregate exceeds reviewed maximum", path: ["aggregate_bounds", index, "actual"] });
  const identities = set.members.map((member) => JSON.stringify(member.primary_key.value));
  if (new Set(identities).size !== identities.length) ctx.addIssue({ code: z2.ZodIssueCode.custom, message: "frozen set primary keys must be unique", path: ["members"] });
  if (identities.some((value, index) => index > 0 && identities[index - 1].localeCompare(value) > 0)) ctx.addIssue({ code: z2.ZodIssueCode.custom, message: "frozen set members must use deterministic primary-key ordering", path: ["members"] });
});
var reversalOperationSchema = z2.enum(["restore_update", "remove_insert", "restore_insert"]);
var reversalLineageSchema = z2.object({
  root_proposal_id: z2.string().min(1),
  parent_proposal_id: z2.string().min(1),
  reverts_proposal_id: z2.string().min(1),
  depth: z2.number().int().min(1).max(16)
});
var inverseMemberSchema = z2.object({
  primary_key: columnValueSchema2,
  expected_state: boundedScalarRecord,
  restore_values: boundedScalarRecord.optional()
});
var inverseDescriptorV1Schema = z2.object({
  schema_version: z2.literal(protocolVersions.inverseDescriptor),
  availability: z2.enum(["available", "best_effort_unavailable"]),
  reason_codes: z2.array(z2.string().regex(/^[A-Z][A-Z0-9_]*$/)).max(8).default([]),
  operation: reversalOperationSchema,
  cardinality: z2.enum(["single", "set"]),
  forward_proposal_id: z2.string().min(1),
  forward_writeback_job_id: z2.string().min(1),
  target: z2.object({
    source_id: z2.string().min(1),
    schema: safeIdentifier2,
    table: safeIdentifier2,
    primary_key_column: safeIdentifier2
  }),
  tenant_guard: columnValueSchema2,
  principal_scope: principalScopeGuardSchema.optional(),
  allowed_columns: z2.array(safeIdentifier2).max(256),
  members: z2.array(inverseMemberSchema).min(1).max(100),
  max_rows: z2.number().int().min(1).max(100),
  aggregate_bounds: z2.array(aggregateBoundSchema).max(8).default([]),
  version_advance: versionAdvanceSchema2.optional(),
  lineage: reversalLineageSchema
}).superRefine((descriptor, ctx) => {
  if (descriptor.members.length > descriptor.max_rows) ctx.addIssue({ code: z2.ZodIssueCode.custom, message: "inverse members exceed max_rows", path: ["members"] });
  const identities = descriptor.members.map((member) => JSON.stringify(member.primary_key.value));
  if (new Set(identities).size !== identities.length) ctx.addIssue({ code: z2.ZodIssueCode.custom, message: "inverse primary keys must be unique", path: ["members"] });
  if (identities.some((value, index) => index > 0 && identities[index - 1].localeCompare(value) > 0)) ctx.addIssue({ code: z2.ZodIssueCode.custom, message: "inverse members must use deterministic primary-key ordering", path: ["members"] });
  for (const [index, member] of descriptor.members.entries()) {
    if (member.primary_key.column !== descriptor.target.primary_key_column) ctx.addIssue({ code: z2.ZodIssueCode.custom, message: "inverse member primary key must match target", path: ["members", index, "primary_key", "column"] });
    if (descriptor.availability === "available" && descriptor.operation === "restore_update" && (!member.restore_values || Object.keys(member.restore_values).length === 0 || Object.keys(member.expected_state).length === 0)) ctx.addIssue({ code: z2.ZodIssueCode.custom, message: "restore_update requires expected state and restore values", path: ["members", index] });
    if (descriptor.availability === "available" && descriptor.operation === "remove_insert" && (member.restore_values !== void 0 || Object.keys(member.expected_state).length === 0)) ctx.addIssue({ code: z2.ZodIssueCode.custom, message: "remove_insert requires expected state and no restore values", path: ["members", index] });
    if (descriptor.availability === "available" && descriptor.operation === "restore_insert" && (!member.restore_values || Object.keys(member.restore_values).length === 0 || Object.keys(member.expected_state).length !== 0)) ctx.addIssue({ code: z2.ZodIssueCode.custom, message: "restore_insert requires an absent expected state and exact restore values", path: ["members", index] });
  }
  if (descriptor.operation === "restore_update" && (!descriptor.version_advance || descriptor.version_advance.strategy !== "integer_increment")) ctx.addIssue({ code: z2.ZodIssueCode.custom, message: "restore_update requires integer version advancement", path: ["version_advance"] });
  if (descriptor.operation !== "restore_update" && descriptor.version_advance) ctx.addIssue({ code: z2.ZodIssueCode.custom, message: "version advancement is valid only for restore_update", path: ["version_advance"] });
  if (descriptor.availability === "available" && descriptor.reason_codes.length) ctx.addIssue({ code: z2.ZodIssueCode.custom, message: "available inverse must not carry unavailability reasons", path: ["reason_codes"] });
  if (descriptor.availability === "best_effort_unavailable" && descriptor.reason_codes.length === 0) ctx.addIssue({ code: z2.ZodIssueCode.custom, message: "unavailable inverse requires specific reason codes", path: ["reason_codes"] });
});
var reversibilityRequestSchema = z2.object({
  mode: z2.literal("reviewed_inverse"),
  lineage: reversalLineageSchema
});
var contractProvenanceSchema2 = z2.object({
  digest: sha2562,
  version: z2.string().min(1).max(128)
});
var changeSetV1Schema = z2.object({
  schema_version: z2.literal(protocolVersions.changeSet),
  proposal_id: z2.string().min(1),
  proposal_version: z2.number().int().positive(),
  action: z2.string().min(1),
  contract: contractProvenanceSchema2.optional(),
  mode: z2.enum(["read_only", "shadow", "review_required", "approved_for_writeback"]),
  principal: z2.object({
    id: z2.string().min(1),
    source: z2.enum(["trusted_session", "cloud_session", "environment", "static_dev"])
  }),
  scope: z2.object({
    tenant_id: z2.string().min(1),
    business_object: z2.string().min(1),
    object_id: z2.string().min(1)
  }),
  source: z2.object({
    kind: z2.enum(["external_postgres", "external_mysql", "synapsor_table"]),
    source_id: z2.string().min(1),
    schema: z2.string().min(1),
    table: z2.string().min(1),
    primary_key: columnValueSchema2
  }),
  before: scalarMap,
  patch: scalarMap,
  after: scalarMap,
  guards: z2.object({
    tenant: columnValueSchema2,
    principal_scope: principalScopeGuardSchema.optional(),
    allowed_columns: z2.array(z2.string().min(1)).min(1),
    expected_version: columnValueSchema2
  }),
  freshness: freshnessAuthorityV1Schema.optional(),
  evidence: z2.object({
    bundle_id: z2.string().min(1),
    query_fingerprint: sha2562,
    items: z2.array(z2.unknown())
  }).passthrough(),
  approval: z2.object({
    status: z2.enum(["pending", "approved", "rejected", "canceled"]),
    required_role: z2.string().optional(),
    required_approvals: z2.number().int().min(1).max(10).optional()
  }).passthrough(),
  writeback: z2.object({
    status: z2.enum(["not_applied", "pending_worker", "applied", "conflict", "failed", "canceled"]),
    mode: z2.enum(["trusted_worker_required", "synapsor_merge", "read_only"])
  }).passthrough(),
  source_database_mutated: z2.boolean(),
  integrity: z2.object({
    proposal_hash: sha2562
  }),
  created_at: z2.string().min(1)
}).superRefine((changeSet, ctx) => {
  validateFreshnessBinding(changeSet.freshness, changeSet.source.source_id, sourceEngine(changeSet.source.kind), "exact_guard", 1, ctx);
  const allowed = new Set(changeSet.guards.allowed_columns);
  for (const column of Object.keys(changeSet.patch)) {
    if (!allowed.has(column)) {
      ctx.addIssue({
        code: z2.ZodIssueCode.custom,
        message: `patch column not allowed: ${column}`,
        path: ["patch", column]
      });
    }
  }
  if (allowed.has(changeSet.source.primary_key.column)) {
    ctx.addIssue({
      code: z2.ZodIssueCode.custom,
      message: "primary key column must not be patch-allowlisted",
      path: ["guards", "allowed_columns"]
    });
  }
  if (allowed.has(changeSet.guards.tenant.column)) {
    ctx.addIssue({
      code: z2.ZodIssueCode.custom,
      message: "tenant guard column must not be patch-allowlisted",
      path: ["guards", "allowed_columns"]
    });
  }
  if (changeSet.guards.principal_scope && allowed.has(changeSet.guards.principal_scope.column)) {
    ctx.addIssue({
      code: z2.ZodIssueCode.custom,
      message: "principal scope column must not be patch-allowlisted",
      path: ["guards", "allowed_columns"]
    });
  }
});
var changeSetV2Schema = z2.object({
  schema_version: z2.literal(protocolVersions.changeSetV2),
  proposal_id: z2.string().min(1),
  proposal_version: z2.number().int().positive(),
  action: z2.string().min(1),
  contract: contractProvenanceSchema2.optional(),
  operation: z2.enum(["single_row_update", "single_row_insert", "single_row_delete"]),
  mode: z2.enum(["read_only", "shadow", "review_required", "approved_for_writeback"]),
  principal: z2.object({
    id: z2.string().min(1),
    source: z2.enum(["trusted_session", "cloud_session", "environment", "static_dev"])
  }),
  scope: z2.object({
    tenant_id: z2.string().min(1),
    business_object: z2.string().min(1),
    object_id: z2.string().min(1)
  }),
  source: z2.object({
    kind: z2.enum(["external_postgres", "external_mysql", "synapsor_table"]),
    source_id: z2.string().min(1),
    schema: safeIdentifier2,
    table: safeIdentifier2,
    primary_key: z2.object({ column: safeIdentifier2, value: scalar2.optional() })
  }),
  before: boundedScalarRecord,
  patch: boundedScalarRecord,
  after: boundedScalarRecord,
  guards: z2.object({
    tenant: columnValueSchema2,
    principal_scope: principalScopeGuardSchema.optional(),
    allowed_columns: z2.array(safeIdentifier2).max(256),
    expected_version: columnValueSchema2.optional(),
    version_advance: versionAdvanceSchema2.optional(),
    deduplication: z2.object({ components: z2.array(resolvedDeduplicationComponentSchema).min(1).max(8) }).optional()
  }),
  freshness: freshnessAuthorityV1Schema.optional(),
  reversibility: reversibilityRequestSchema.optional(),
  evidence: z2.object({
    bundle_id: z2.string().min(1),
    query_fingerprint: sha2562,
    items: z2.array(z2.unknown()).max(1e3)
  }).passthrough(),
  approval: z2.object({
    status: z2.enum(["pending", "approved", "rejected", "canceled"]),
    required_role: z2.string().optional(),
    required_approvals: z2.number().int().min(1).max(10).optional()
  }).passthrough(),
  writeback: z2.object({
    status: z2.enum(["not_applied", "pending_worker", "applied", "conflict", "failed", "canceled", "reconciliation_required"]),
    mode: z2.enum(["trusted_worker_required", "synapsor_merge", "read_only"])
  }).passthrough(),
  source_database_mutated: z2.boolean(),
  integrity: z2.object({ proposal_hash: sha2562 }),
  created_at: z2.string().min(1)
}).superRefine((changeSet, ctx) => {
  validateFreshnessBinding(
    changeSet.freshness,
    changeSet.source.source_id,
    sourceEngine(changeSet.source.kind),
    changeSet.operation === "single_row_insert" ? "not_applicable" : "exact_guard",
    changeSet.operation === "single_row_insert" ? 0 : 1,
    ctx
  );
  const allowed = new Set(changeSet.guards.allowed_columns);
  for (const column of Object.keys(changeSet.patch)) {
    if (!allowed.has(column)) ctx.addIssue({ code: z2.ZodIssueCode.custom, message: `patch column not allowed: ${column}`, path: ["patch", column] });
  }
  if (allowed.has(changeSet.source.primary_key.column)) ctx.addIssue({ code: z2.ZodIssueCode.custom, message: "primary key column must not be patch-allowlisted", path: ["guards", "allowed_columns"] });
  if (allowed.has(changeSet.guards.tenant.column)) ctx.addIssue({ code: z2.ZodIssueCode.custom, message: "tenant guard column must not be patch-allowlisted", path: ["guards", "allowed_columns"] });
  if (changeSet.guards.principal_scope && allowed.has(changeSet.guards.principal_scope.column)) ctx.addIssue({ code: z2.ZodIssueCode.custom, message: "principal scope column must not be patch-allowlisted", path: ["guards", "allowed_columns"] });
  if (changeSet.operation === "single_row_insert") {
    if (Object.keys(changeSet.before).length !== 0) ctx.addIssue({ code: z2.ZodIssueCode.custom, message: "INSERT before must be empty", path: ["before"] });
    if (!changeSet.guards.deduplication) ctx.addIssue({ code: z2.ZodIssueCode.custom, message: "INSERT requires source-enforced deduplication", path: ["guards", "deduplication"] });
    else {
      if (!changeSet.guards.deduplication.components.some((component) => component.source === "proposal_id")) {
        ctx.addIssue({ code: z2.ZodIssueCode.custom, message: "INSERT deduplication requires proposal identity", path: ["guards", "deduplication", "components"] });
      }
      if (!changeSet.guards.deduplication.components.some((component) => component.source === "trusted_tenant" && component.column === changeSet.guards.tenant.column && component.value === changeSet.guards.tenant.value)) {
        ctx.addIssue({ code: z2.ZodIssueCode.custom, message: "INSERT deduplication requires the trusted tenant guard", path: ["guards", "deduplication", "components"] });
      }
    }
    if (changeSet.guards.expected_version || changeSet.guards.version_advance) ctx.addIssue({ code: z2.ZodIssueCode.custom, message: "INSERT must not declare version guards", path: ["guards"] });
  } else {
    if (Object.keys(changeSet.before).length === 0) ctx.addIssue({ code: z2.ZodIssueCode.custom, message: "UPDATE and DELETE require reviewed before data", path: ["before"] });
    if (!changeSet.source.primary_key.value) ctx.addIssue({ code: z2.ZodIssueCode.custom, message: "UPDATE and DELETE require a primary-key value", path: ["source", "primary_key", "value"] });
    if (!changeSet.guards.expected_version) ctx.addIssue({ code: z2.ZodIssueCode.custom, message: "UPDATE and DELETE require an exact version guard", path: ["guards", "expected_version"] });
    if (changeSet.guards.deduplication) ctx.addIssue({ code: z2.ZodIssueCode.custom, message: "deduplication is only valid for INSERT", path: ["guards", "deduplication"] });
  }
  if (changeSet.operation === "single_row_update") {
    if (Object.keys(changeSet.patch).length === 0) ctx.addIssue({ code: z2.ZodIssueCode.custom, message: "UPDATE patch must not be empty", path: ["patch"] });
    if (Object.keys(changeSet.after).length === 0) ctx.addIssue({ code: z2.ZodIssueCode.custom, message: "UPDATE after must not be empty", path: ["after"] });
  }
  if (changeSet.operation === "single_row_delete") {
    if (Object.keys(changeSet.patch).length !== 0 || Object.keys(changeSet.after).length !== 0 || changeSet.guards.allowed_columns.length !== 0) {
      ctx.addIssue({ code: z2.ZodIssueCode.custom, message: "DELETE has no patch, after row, or writable columns", path: ["patch"] });
    }
    if (changeSet.guards.version_advance) ctx.addIssue({ code: z2.ZodIssueCode.custom, message: "DELETE must not advance a version", path: ["guards", "version_advance"] });
  }
});
var changeSetV3Schema = z2.object({
  schema_version: z2.literal(protocolVersions.changeSetV3),
  proposal_id: z2.string().min(1),
  proposal_version: z2.number().int().positive(),
  action: z2.string().min(1),
  contract: contractProvenanceSchema2.optional(),
  operation: setOperationSchema,
  mode: z2.enum(["read_only", "shadow", "review_required", "approved_for_writeback"]),
  principal: z2.object({
    id: z2.string().min(1),
    source: z2.enum(["trusted_session", "cloud_session", "environment", "static_dev"])
  }),
  scope: z2.object({ tenant_id: z2.string().min(1), business_object: z2.string().min(1), object_id: z2.string().min(1) }),
  source: z2.object({
    kind: z2.enum(["external_postgres", "external_mysql", "synapsor_table"]),
    source_id: z2.string().min(1),
    schema: safeIdentifier2,
    table: safeIdentifier2,
    primary_key: z2.object({ column: safeIdentifier2, value: scalar2.optional() })
  }),
  before: boundedScalarRecord,
  patch: boundedScalarRecord,
  after: boundedScalarRecord,
  guards: z2.object({
    tenant: columnValueSchema2,
    principal_scope: principalScopeGuardSchema.optional(),
    allowed_columns: z2.array(safeIdentifier2).max(256),
    expected_version: columnValueSchema2.optional(),
    version_advance: versionAdvanceSchema2.optional()
  }),
  freshness: freshnessAuthorityV1Schema.optional(),
  frozen_set: frozenSetSchema,
  reversibility: reversibilityRequestSchema.optional(),
  evidence: z2.object({ bundle_id: z2.string().min(1), query_fingerprint: sha2562, items: z2.array(z2.unknown()).max(100) }).passthrough(),
  approval: z2.object({
    status: z2.enum(["pending", "approved", "rejected", "canceled"]),
    mode: z2.enum(["human", "operator"]),
    required_role: z2.string().min(1).optional(),
    required_approvals: z2.number().int().min(1).max(10).optional()
  }).passthrough(),
  writeback: z2.object({ status: z2.enum(["not_applied", "pending_worker", "applied", "conflict", "failed", "canceled", "reconciliation_required"]), mode: z2.literal("trusted_worker_required"), executor: z2.literal("sql_update") }).passthrough(),
  source_database_mutated: z2.boolean(),
  integrity: z2.object({ proposal_hash: sha2562 }),
  created_at: z2.string().min(1)
}).superRefine((changeSet, ctx) => {
  validateFreshnessBinding(
    changeSet.freshness,
    changeSet.source.source_id,
    sourceEngine(changeSet.source.kind),
    changeSet.operation === "batch_insert" ? "not_applicable" : "frozen_set",
    changeSet.operation === "batch_insert" ? 0 : changeSet.frozen_set.row_count,
    ctx
  );
  if (changeSet.source.primary_key.value !== void 0 || changeSet.guards.expected_version) ctx.addIssue({ code: z2.ZodIssueCode.custom, message: "set guards live on frozen members, not the top-level envelope", path: ["frozen_set"] });
  const allowed = new Set(changeSet.guards.allowed_columns);
  for (const column of Object.keys(changeSet.patch)) if (!allowed.has(column)) ctx.addIssue({ code: z2.ZodIssueCode.custom, message: `patch column not allowed: ${column}`, path: ["patch", column] });
  if (changeSet.guards.principal_scope && allowed.has(changeSet.guards.principal_scope.column)) ctx.addIssue({ code: z2.ZodIssueCode.custom, message: "principal scope column must not be patch-allowlisted", path: ["guards", "allowed_columns"] });
  for (const [index, member] of changeSet.frozen_set.members.entries()) {
    if (member.primary_key.column !== changeSet.source.primary_key.column) ctx.addIssue({ code: z2.ZodIssueCode.custom, message: "member primary key column must match source", path: ["frozen_set", "members", index, "primary_key", "column"] });
    if (changeSet.operation === "set_update") {
      if (!member.expected_version || !member.before_digest || !member.after_digest || member.tombstone_digest || member.deduplication) ctx.addIssue({ code: z2.ZodIssueCode.custom, message: "set UPDATE members require version and before/after digests", path: ["frozen_set", "members", index] });
    } else if (changeSet.operation === "set_delete") {
      if (!member.expected_version || !member.before_digest || !member.tombstone_digest || Object.keys(member.after).length || member.after_digest || member.deduplication) ctx.addIssue({ code: z2.ZodIssueCode.custom, message: "set DELETE members require version and tombstone", path: ["frozen_set", "members", index] });
    } else if (member.expected_version || Object.keys(member.before).length || member.before_digest || !member.after_digest || !member.deduplication) {
      ctx.addIssue({ code: z2.ZodIssueCode.custom, message: "batch INSERT members require exact after data and deduplication", path: ["frozen_set", "members", index] });
    }
  }
  if (changeSet.operation !== "set_update" && changeSet.guards.version_advance) ctx.addIssue({ code: z2.ZodIssueCode.custom, message: "version advance is valid only for set UPDATE", path: ["guards", "version_advance"] });
  if (changeSet.operation === "set_delete" && changeSet.guards.allowed_columns.length) ctx.addIssue({ code: z2.ZodIssueCode.custom, message: "set DELETE has no allowed write columns", path: ["guards", "allowed_columns"] });
});
var compensationChangeSetV1Schema = z2.object({
  schema_version: z2.literal(protocolVersions.compensationChangeSet),
  proposal_id: z2.string().min(1),
  proposal_version: z2.number().int().positive(),
  action: z2.string().min(1),
  contract: contractProvenanceSchema2.optional(),
  mode: z2.literal("review_required"),
  principal: z2.object({
    id: z2.string().min(1),
    source: z2.enum(["trusted_session", "cloud_session", "environment", "static_dev"])
  }),
  scope: z2.object({ tenant_id: z2.string().min(1), business_object: z2.string().min(1), object_id: z2.string().min(1) }),
  source: z2.object({
    kind: z2.enum(["external_postgres", "external_mysql"]),
    source_id: z2.string().min(1),
    schema: safeIdentifier2,
    table: safeIdentifier2,
    primary_key: z2.object({ column: safeIdentifier2, value: scalar2.optional() })
  }),
  before: boundedScalarRecord,
  patch: boundedScalarRecord,
  after: boundedScalarRecord,
  compensation: z2.object({
    descriptor: inverseDescriptorV1Schema,
    forward_receipt_hash: sha2562
  }),
  guards: z2.object({ tenant: columnValueSchema2, principal_scope: principalScopeGuardSchema.optional(), allowed_columns: z2.array(safeIdentifier2).max(256) }),
  evidence: z2.object({ bundle_id: z2.string().min(1), query_fingerprint: sha2562, items: z2.array(z2.unknown()).max(100) }).passthrough(),
  approval: z2.object({
    status: z2.enum(["pending", "approved", "rejected", "canceled"]),
    mode: z2.enum(["human", "operator"]),
    required_role: z2.string().min(1).optional(),
    required_approvals: z2.number().int().min(1).max(10).optional()
  }).passthrough(),
  writeback: z2.object({ status: z2.literal("not_applied"), mode: z2.literal("trusted_worker_required"), executor: z2.literal("sql_update") }),
  source_database_mutated: z2.literal(false),
  integrity: z2.object({ proposal_hash: sha2562 }),
  created_at: z2.string().min(1)
}).superRefine((changeSet, ctx) => {
  const descriptor = changeSet.compensation.descriptor;
  if (descriptor.availability !== "available") ctx.addIssue({ code: z2.ZodIssueCode.custom, message: "compensation proposal requires an available inverse", path: ["compensation", "descriptor", "availability"] });
  if (descriptor.target.source_id !== changeSet.source.source_id || descriptor.target.schema !== changeSet.source.schema || descriptor.target.table !== changeSet.source.table || descriptor.target.primary_key_column !== changeSet.source.primary_key.column) ctx.addIssue({ code: z2.ZodIssueCode.custom, message: "compensation descriptor target must match proposal source", path: ["compensation", "descriptor", "target"] });
  if (descriptor.tenant_guard.column !== changeSet.guards.tenant.column || descriptor.tenant_guard.value !== changeSet.guards.tenant.value || descriptor.tenant_guard.value !== changeSet.scope.tenant_id) ctx.addIssue({ code: z2.ZodIssueCode.custom, message: "compensation tenant authority must match trusted proposal scope", path: ["guards", "tenant"] });
  if (JSON.stringify(descriptor.principal_scope) !== JSON.stringify(changeSet.guards.principal_scope)) ctx.addIssue({ code: z2.ZodIssueCode.custom, message: "compensation principal authority must match inverse descriptor", path: ["guards", "principal_scope"] });
  if (JSON.stringify(descriptor.allowed_columns) !== JSON.stringify(changeSet.guards.allowed_columns)) ctx.addIssue({ code: z2.ZodIssueCode.custom, message: "compensation allowlist must match inverse descriptor", path: ["guards", "allowed_columns"] });
});
var publicConflictGuardSchema = z2.discriminatedUnion("kind", [
  z2.object({ kind: z2.literal("column"), column: safeIdentifier2, expected_value: scalar2 }),
  z2.object({ kind: z2.literal("row_hash"), expected_hash: z2.string().min(1) }),
  z2.object({ kind: z2.literal("none") })
]);
var leasedContractRefSchema2 = z2.object({
  contract_id: z2.string().min(1),
  contract_version_id: z2.string().min(1),
  digest: sha2562
});
var writebackJobV1Schema = z2.object({
  schema_version: z2.literal(protocolVersions.writebackJob),
  writeback_job_id: z2.string().min(1),
  proposal_id: z2.string().min(1),
  proposal_version: z2.number().int().positive(),
  proposal_hash: sha2562,
  runner_scope: z2.object({
    project_id: z2.string().min(1),
    source_id: z2.string().min(1)
  }),
  engine: writebackEngineSchema,
  operation: z2.literal("single_row_update"),
  target: z2.object({
    schema: safeIdentifier2,
    table: safeIdentifier2,
    primary_key: columnValueSchema2
  }),
  tenant_guard: columnValueSchema2,
  principal_scope: principalScopeGuardSchema.optional(),
  allowed_columns: z2.array(safeIdentifier2).min(1),
  patch: scalarMap,
  conflict_guard: publicConflictGuardSchema,
  freshness: freshnessAuthorityV1Schema.optional(),
  idempotency_key: z2.string().min(1),
  lease: z2.object({
    lease_id: z2.string().min(1),
    attempt: z2.number().int().positive(),
    expires_at: z2.string().min(1)
  })
}).superRefine((job, ctx) => {
  validateFreshnessBinding(job.freshness, job.runner_scope.source_id, job.engine, "exact_guard", 1, ctx);
  validateAllowedPatchColumns(job.allowed_columns, Object.keys(job.patch), job.target.primary_key.column, job.tenant_guard.column, ctx);
  if (job.principal_scope && job.allowed_columns.includes(job.principal_scope.column)) ctx.addIssue({ code: z2.ZodIssueCode.custom, message: "principal scope column must not be patch-allowlisted", path: ["allowed_columns"] });
});
var normalizedWritebackJobV1Schema = writebackJobV1Schema.transform((job) => ({
  protocol_version: protocolVersions.legacyWritebackJob,
  job_id: job.writeback_job_id,
  proposal_id: job.proposal_id,
  approval_id: job.proposal_hash,
  source_id: job.runner_scope.source_id,
  engine: job.engine,
  operation: "single_row_update",
  target: {
    schema: job.target.schema,
    table: job.target.table,
    primary_key: job.target.primary_key,
    tenant_guard: job.tenant_guard,
    ...job.principal_scope ? { principal_scope: job.principal_scope } : {}
  },
  allowed_columns: job.allowed_columns,
  patch: job.patch,
  conflict_guard: normalizeConflictGuard(job.conflict_guard),
  ...job.freshness ? { freshness: job.freshness } : {},
  idempotency_key: job.idempotency_key,
  lease_expires_at: job.lease.expires_at,
  attempt_count: job.lease.attempt
}));
var legacyWritebackJobSchema = z2.object({
  protocol_version: z2.literal(protocolVersions.legacyWritebackJob),
  job_id: z2.string().min(1),
  proposal_id: z2.string().min(1),
  approval_id: z2.string().min(1),
  contract: leasedContractRefSchema2.optional(),
  source_id: z2.string().min(1),
  engine: writebackEngineSchema,
  operation: z2.literal("single_row_update").optional(),
  target: z2.object({
    schema: safeIdentifier2,
    table: safeIdentifier2,
    primary_key: z2.object({
      column: safeIdentifier2,
      value: scalar2
    }),
    tenant_guard: z2.object({
      column: safeIdentifier2,
      value: scalar2
    }),
    principal_scope: principalScopeGuardSchema.optional()
  }),
  allowed_columns: z2.array(safeIdentifier2).min(1),
  patch: scalarMap,
  conflict_guard: z2.discriminatedUnion("kind", [
    z2.object({ kind: z2.literal("version_column"), column: z2.string().min(1), expected_value: scalar2 }),
    z2.object({ kind: z2.literal("row_hash"), expected_hash: z2.string().min(1) }),
    z2.object({ kind: z2.literal("none") })
  ]),
  freshness: freshnessAuthorityV1Schema.optional(),
  idempotency_key: z2.string().min(1),
  lease_expires_at: z2.union([z2.string(), z2.number()]),
  attempt_count: z2.number().int().nonnegative().optional()
}).superRefine((job, ctx) => {
  validateFreshnessBinding(job.freshness, job.source_id, job.engine, "exact_guard", 1, ctx);
  validateAllowedPatchColumns(job.allowed_columns, Object.keys(job.patch), job.target.primary_key.column, job.target.tenant_guard.column, ctx);
  if (job.target.principal_scope && job.allowed_columns.includes(job.target.principal_scope.column)) ctx.addIssue({ code: z2.ZodIssueCode.custom, message: "principal scope column must not be patch-allowlisted", path: ["allowed_columns"] });
});
var normalizedWritebackJobV2InputSchema = z2.object({
  protocol_version: z2.literal(protocolVersions.normalizedWritebackJobV2),
  job_id: z2.string().min(1),
  proposal_id: z2.string().min(1),
  approval_id: sha2562,
  contract: leasedContractRefSchema2.optional(),
  source_id: z2.string().min(1),
  engine: writebackEngineSchema,
  operation: z2.enum(["single_row_update", "single_row_insert", "single_row_delete"]),
  target: z2.object({
    schema: safeIdentifier2,
    table: safeIdentifier2,
    primary_key: z2.object({ column: safeIdentifier2, value: scalar2.optional() }),
    tenant_guard: columnValueSchema2,
    principal_scope: principalScopeGuardSchema.optional()
  }),
  allowed_columns: z2.array(safeIdentifier2).max(256),
  patch: boundedScalarRecord,
  conflict_guard: z2.discriminatedUnion("kind", [
    z2.object({ kind: z2.literal("version_column"), column: safeIdentifier2, expected_value: scalar2 }),
    z2.object({ kind: z2.literal("row_hash"), expected_hash: z2.string().min(1) }),
    z2.object({ kind: z2.literal("none") })
  ]),
  freshness: freshnessAuthorityV1Schema.optional(),
  version_advance: versionAdvanceSchema2.optional(),
  deduplication: z2.object({ components: z2.array(resolvedDeduplicationComponentSchema).min(1).max(8) }).optional(),
  idempotency_key: z2.string().min(1),
  lease_expires_at: z2.union([z2.string(), z2.number()]),
  attempt_count: z2.number().int().positive(),
  inverse_capture: inverseDescriptorV1Schema.optional()
}).superRefine((job, ctx) => {
  validateFreshnessBinding(
    job.freshness,
    job.source_id,
    job.engine,
    job.operation === "single_row_insert" ? "not_applicable" : "exact_guard",
    job.operation === "single_row_insert" ? 0 : 1,
    ctx
  );
  if (job.operation !== "single_row_insert" && job.target.primary_key.value === void 0) {
    ctx.addIssue({ code: z2.ZodIssueCode.custom, message: "UPDATE and DELETE require a primary-key value", path: ["target", "primary_key", "value"] });
  }
  if (job.operation === "single_row_update" || job.operation === "single_row_insert") {
    validateAllowedPatchColumns(job.allowed_columns, Object.keys(job.patch), job.target.primary_key.column, job.target.tenant_guard.column, ctx);
    if (job.target.principal_scope && job.allowed_columns.includes(job.target.principal_scope.column)) ctx.addIssue({ code: z2.ZodIssueCode.custom, message: "principal scope column must not be patch-allowlisted", path: ["allowed_columns"] });
    if (Object.keys(job.patch).length === 0) ctx.addIssue({ code: z2.ZodIssueCode.custom, message: `${job.operation} patch must not be empty`, path: ["patch"] });
  } else if (job.allowed_columns.length !== 0 || Object.keys(job.patch).length !== 0) {
    ctx.addIssue({ code: z2.ZodIssueCode.custom, message: "DELETE must not allow or carry write columns", path: ["allowed_columns"] });
  }
  if (job.operation === "single_row_update") {
    if (job.deduplication) ctx.addIssue({ code: z2.ZodIssueCode.custom, message: "deduplication is only valid for INSERT", path: ["deduplication"] });
    if (job.version_advance && (job.conflict_guard.kind !== "version_column" || job.version_advance.column !== job.conflict_guard.column)) {
      ctx.addIssue({ code: z2.ZodIssueCode.custom, message: "version advance must match the version conflict guard", path: ["version_advance", "column"] });
    }
  }
  if (job.operation === "single_row_insert") {
    if (!job.deduplication) {
      ctx.addIssue({ code: z2.ZodIssueCode.custom, message: "INSERT requires source-enforced deduplication", path: ["deduplication"] });
    } else {
      validateResolvedDeduplication(job.deduplication.components, job.patch, job.target.tenant_guard, ctx, ["deduplication", "components"]);
    }
    if (job.conflict_guard.kind !== "none" || job.version_advance) ctx.addIssue({ code: z2.ZodIssueCode.custom, message: "INSERT must not declare version guards", path: ["conflict_guard"] });
  }
  if (job.operation === "single_row_delete" && (job.conflict_guard.kind !== "version_column" || job.version_advance || job.deduplication)) {
    ctx.addIssue({ code: z2.ZodIssueCode.custom, message: "DELETE requires only an exact version-column guard", path: ["conflict_guard"] });
  }
});
var writebackMutationV2Schema = z2.discriminatedUnion("kind", [
  z2.object({
    kind: z2.literal("single_row_update"),
    values: scalarMap,
    conflict_guard: publicConflictGuardSchema,
    version_advance: versionAdvanceSchema2.optional()
  }),
  z2.object({
    kind: z2.literal("single_row_insert"),
    values: scalarMap,
    deduplication: z2.object({ components: z2.array(resolvedDeduplicationComponentSchema).min(1).max(8) })
  }),
  z2.object({
    kind: z2.literal("single_row_delete"),
    conflict_guard: z2.object({ kind: z2.literal("column"), column: safeIdentifier2, expected_value: scalar2 })
  })
]);
var writebackJobV2Schema = z2.object({
  schema_version: z2.literal(protocolVersions.writebackJobV2),
  writeback_job_id: z2.string().min(1),
  proposal_id: z2.string().min(1),
  proposal_version: z2.number().int().positive(),
  proposal_hash: sha2562,
  runner_scope: z2.object({
    project_id: z2.string().min(1),
    source_id: z2.string().min(1)
  }),
  engine: writebackEngineSchema,
  target: z2.object({
    schema: safeIdentifier2,
    table: safeIdentifier2,
    primary_key: z2.object({ column: safeIdentifier2, value: scalar2.optional() })
  }),
  tenant_guard: columnValueSchema2,
  principal_scope: principalScopeGuardSchema.optional(),
  allowed_columns: z2.array(safeIdentifier2),
  mutation: writebackMutationV2Schema,
  freshness: freshnessAuthorityV1Schema.optional(),
  idempotency_key: z2.string().min(1),
  inverse_capture: inverseDescriptorV1Schema.optional(),
  lease: z2.object({
    lease_id: z2.string().min(1),
    attempt: z2.number().int().positive(),
    expires_at: z2.string().min(1)
  })
}).superRefine((job, ctx) => {
  validateFreshnessBinding(
    job.freshness,
    job.runner_scope.source_id,
    job.engine,
    job.mutation.kind === "single_row_insert" ? "not_applicable" : "exact_guard",
    job.mutation.kind === "single_row_insert" ? 0 : 1,
    ctx
  );
  const mutation = job.mutation;
  if (mutation.kind !== "single_row_insert" && job.target.primary_key.value === void 0) {
    ctx.addIssue({ code: z2.ZodIssueCode.custom, message: "UPDATE and DELETE require a primary-key value", path: ["target", "primary_key", "value"] });
  }
  if (mutation.kind === "single_row_update" || mutation.kind === "single_row_insert") {
    validateAllowedPatchColumns(job.allowed_columns, Object.keys(mutation.values), job.target.primary_key.column, job.tenant_guard.column, ctx);
    if (job.principal_scope && job.allowed_columns.includes(job.principal_scope.column)) ctx.addIssue({ code: z2.ZodIssueCode.custom, message: "principal scope column must not be patch-allowlisted", path: ["allowed_columns"] });
  } else if (job.allowed_columns.length !== 0) {
    ctx.addIssue({ code: z2.ZodIssueCode.custom, message: "DELETE must not allow write columns", path: ["allowed_columns"] });
  }
  if (mutation.kind === "single_row_update" && mutation.version_advance) {
    if (mutation.conflict_guard.kind !== "column" || mutation.version_advance.column !== mutation.conflict_guard.column) {
      ctx.addIssue({ code: z2.ZodIssueCode.custom, message: "version advance must match the column conflict guard", path: ["mutation", "version_advance", "column"] });
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
    ...job.principal_scope ? { principal_scope: job.principal_scope } : {}
  },
  allowed_columns: job.allowed_columns,
  patch: job.mutation.kind === "single_row_delete" ? {} : job.mutation.values,
  conflict_guard: job.mutation.kind === "single_row_insert" ? { kind: "none" } : normalizeConflictGuard(job.mutation.conflict_guard),
  ...job.mutation.kind === "single_row_update" && job.mutation.version_advance ? { version_advance: job.mutation.version_advance } : {},
  ...job.mutation.kind === "single_row_insert" ? { deduplication: job.mutation.deduplication } : {},
  ...job.freshness ? { freshness: job.freshness } : {},
  idempotency_key: job.idempotency_key,
  ...job.inverse_capture ? { inverse_capture: job.inverse_capture } : {},
  lease_expires_at: job.lease.expires_at,
  attempt_count: job.lease.attempt
}));
var normalizedWritebackJobV3InputSchema = z2.object({
  protocol_version: z2.literal(protocolVersions.normalizedWritebackJobV3),
  job_id: z2.string().min(1),
  proposal_id: z2.string().min(1),
  approval_id: sha2562,
  contract: leasedContractRefSchema2.optional(),
  source_id: z2.string().min(1),
  engine: writebackEngineSchema,
  operation: setOperationSchema,
  target: z2.object({ schema: safeIdentifier2, table: safeIdentifier2, primary_key: z2.object({ column: safeIdentifier2, value: scalar2.optional() }), tenant_guard: columnValueSchema2, principal_scope: principalScopeGuardSchema.optional() }),
  allowed_columns: z2.array(safeIdentifier2).max(256),
  patch: boundedScalarRecord,
  conflict_guard: z2.object({ kind: z2.literal("none") }).default({ kind: "none" }),
  freshness: freshnessAuthorityV1Schema.optional(),
  version_advance: versionAdvanceSchema2.optional(),
  frozen_set: frozenSetSchema,
  idempotency_key: z2.string().min(1),
  lease_expires_at: z2.union([z2.string(), z2.number()]),
  attempt_count: z2.number().int().positive(),
  inverse_capture: inverseDescriptorV1Schema.optional()
}).superRefine((job, ctx) => {
  validateFreshnessBinding(
    job.freshness,
    job.source_id,
    job.engine,
    job.operation === "batch_insert" ? "not_applicable" : "frozen_set",
    job.operation === "batch_insert" ? 0 : job.frozen_set.row_count,
    ctx
  );
  if (job.target.principal_scope && job.allowed_columns.includes(job.target.principal_scope.column)) ctx.addIssue({ code: z2.ZodIssueCode.custom, message: "principal scope column must not be patch-allowlisted", path: ["allowed_columns"] });
  if (job.operation === "set_delete" && (job.allowed_columns.length || Object.keys(job.patch).length || job.version_advance)) ctx.addIssue({ code: z2.ZodIssueCode.custom, message: "set DELETE cannot carry patch authority", path: ["patch"] });
  if (job.operation === "set_update" && (!Object.keys(job.patch).length || !job.version_advance)) ctx.addIssue({ code: z2.ZodIssueCode.custom, message: "set UPDATE requires patch and version advance", path: ["patch"] });
  if (job.operation === "batch_insert" && !job.frozen_set.members.every((member) => member.deduplication)) ctx.addIssue({ code: z2.ZodIssueCode.custom, message: "batch INSERT requires per-item source deduplication", path: ["frozen_set", "members"] });
});
var writebackJobV3Schema = z2.object({
  schema_version: z2.literal(protocolVersions.writebackJobV3),
  writeback_job_id: z2.string().min(1),
  proposal_id: z2.string().min(1),
  proposal_version: z2.number().int().positive(),
  proposal_hash: sha2562,
  runner_scope: z2.object({ project_id: z2.string().min(1), source_id: z2.string().min(1) }),
  engine: writebackEngineSchema,
  operation: setOperationSchema,
  target: z2.object({ schema: safeIdentifier2, table: safeIdentifier2, primary_key: z2.object({ column: safeIdentifier2, value: scalar2.optional() }) }),
  tenant_guard: columnValueSchema2,
  principal_scope: principalScopeGuardSchema.optional(),
  allowed_columns: z2.array(safeIdentifier2).max(256),
  patch: boundedScalarRecord,
  version_advance: versionAdvanceSchema2.optional(),
  frozen_set: frozenSetSchema,
  freshness: freshnessAuthorityV1Schema.optional(),
  idempotency_key: z2.string().min(1),
  inverse_capture: inverseDescriptorV1Schema.optional(),
  lease: z2.object({ lease_id: z2.string().min(1), attempt: z2.number().int().positive(), expires_at: z2.string().min(1) })
}).superRefine((job, ctx) => {
  validateFreshnessBinding(
    job.freshness,
    job.runner_scope.source_id,
    job.engine,
    job.operation === "batch_insert" ? "not_applicable" : "frozen_set",
    job.operation === "batch_insert" ? 0 : job.frozen_set.row_count,
    ctx
  );
}).transform((job) => ({
  protocol_version: protocolVersions.normalizedWritebackJobV3,
  job_id: job.writeback_job_id,
  proposal_id: job.proposal_id,
  approval_id: job.proposal_hash,
  source_id: job.runner_scope.source_id,
  engine: job.engine,
  operation: job.operation,
  target: { ...job.target, primary_key: { ...job.target.primary_key, value: void 0 }, tenant_guard: job.tenant_guard, ...job.principal_scope ? { principal_scope: job.principal_scope } : {} },
  allowed_columns: job.allowed_columns,
  patch: job.patch,
  conflict_guard: { kind: "none" },
  ...job.version_advance ? { version_advance: job.version_advance } : {},
  frozen_set: job.frozen_set,
  ...job.freshness ? { freshness: job.freshness } : {},
  idempotency_key: job.idempotency_key,
  ...job.inverse_capture ? { inverse_capture: job.inverse_capture } : {},
  lease_expires_at: job.lease.expires_at,
  attempt_count: job.lease.attempt
}));
var writebackJobV4Schema = z2.object({
  schema_version: z2.literal(protocolVersions.writebackJobV4),
  writeback_job_id: z2.string().min(1),
  proposal_id: z2.string().min(1),
  proposal_version: z2.number().int().positive(),
  proposal_hash: sha2562,
  runner_scope: z2.object({ project_id: z2.string().min(1), source_id: z2.string().min(1) }),
  engine: writebackEngineSchema,
  operation: reversalOperationSchema,
  target: z2.object({ schema: safeIdentifier2, table: safeIdentifier2, primary_key: z2.object({ column: safeIdentifier2, value: scalar2.optional() }) }),
  tenant_guard: columnValueSchema2,
  principal_scope: principalScopeGuardSchema.optional(),
  allowed_columns: z2.array(safeIdentifier2).max(256),
  patch: z2.object({}).default({}),
  compensation: inverseDescriptorV1Schema,
  forward_receipt_hash: sha2562,
  idempotency_key: z2.string().min(1),
  lease: z2.object({ lease_id: z2.string().min(1), attempt: z2.number().int().positive(), expires_at: z2.string().min(1) })
}).superRefine((job, ctx) => {
  if (job.compensation.availability !== "available") ctx.addIssue({ code: z2.ZodIssueCode.custom, message: "compensation job requires an available inverse", path: ["compensation", "availability"] });
  if (job.compensation.target.source_id !== job.runner_scope.source_id) ctx.addIssue({ code: z2.ZodIssueCode.custom, message: "compensation source must match runner scope", path: ["compensation", "target", "source_id"] });
  if (job.operation !== job.compensation.operation || job.target.schema !== job.compensation.target.schema || job.target.table !== job.compensation.target.table || job.target.primary_key.column !== job.compensation.target.primary_key_column || job.tenant_guard.column !== job.compensation.tenant_guard.column || job.tenant_guard.value !== job.compensation.tenant_guard.value) ctx.addIssue({ code: z2.ZodIssueCode.custom, message: "compensation public authority must match descriptor", path: ["compensation"] });
  if (JSON.stringify(job.principal_scope) !== JSON.stringify(job.compensation.principal_scope)) ctx.addIssue({ code: z2.ZodIssueCode.custom, message: "compensation principal authority must match descriptor", path: ["compensation", "principal_scope"] });
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
    ...job.principal_scope ? { principal_scope: job.principal_scope } : {}
  },
  allowed_columns: job.allowed_columns,
  patch: job.patch,
  conflict_guard: { kind: "none" },
  compensation: job.compensation,
  forward_receipt_hash: job.forward_receipt_hash,
  idempotency_key: job.idempotency_key,
  lease_expires_at: job.lease.expires_at,
  attempt_count: job.lease.attempt
}));
var normalizedWritebackJobV4InputSchema = z2.object({
  protocol_version: z2.literal(protocolVersions.normalizedWritebackJobV4),
  job_id: z2.string().min(1),
  proposal_id: z2.string().min(1),
  approval_id: sha2562,
  contract: leasedContractRefSchema2.optional(),
  source_id: z2.string().min(1),
  engine: writebackEngineSchema,
  operation: reversalOperationSchema,
  target: z2.object({ schema: safeIdentifier2, table: safeIdentifier2, primary_key: z2.object({ column: safeIdentifier2, value: scalar2.optional() }), tenant_guard: columnValueSchema2, principal_scope: principalScopeGuardSchema.optional() }),
  allowed_columns: z2.array(safeIdentifier2).max(256),
  patch: z2.object({}).default({}),
  conflict_guard: z2.object({ kind: z2.literal("none") }).default({ kind: "none" }),
  compensation: inverseDescriptorV1Schema,
  forward_receipt_hash: sha2562,
  idempotency_key: z2.string().min(1),
  lease_expires_at: z2.union([z2.string(), z2.number()]),
  attempt_count: z2.number().int().positive()
}).superRefine((job, ctx) => {
  if (job.operation !== job.compensation.operation) ctx.addIssue({ code: z2.ZodIssueCode.custom, message: "compensation operation mismatch", path: ["operation"] });
  if (job.source_id !== job.compensation.target.source_id || job.target.schema !== job.compensation.target.schema || job.target.table !== job.compensation.target.table || job.target.primary_key.column !== job.compensation.target.primary_key_column) ctx.addIssue({ code: z2.ZodIssueCode.custom, message: "compensation target mismatch", path: ["target"] });
  if (job.target.tenant_guard.column !== job.compensation.tenant_guard.column || job.target.tenant_guard.value !== job.compensation.tenant_guard.value) ctx.addIssue({ code: z2.ZodIssueCode.custom, message: "compensation tenant mismatch", path: ["target", "tenant_guard"] });
  if (JSON.stringify(job.target.principal_scope) !== JSON.stringify(job.compensation.principal_scope)) ctx.addIssue({ code: z2.ZodIssueCode.custom, message: "compensation principal mismatch", path: ["target", "principal_scope"] });
});
var writebackJobSchema = z2.union([legacyWritebackJobSchema, normalizedWritebackJobV5InputSchema, normalizedWritebackJobV4InputSchema, normalizedWritebackJobV3InputSchema, normalizedWritebackJobV2InputSchema, normalizedWritebackJobV1Schema, writebackJobV5Schema, writebackJobV4Schema, writebackJobV3Schema, writebackJobV2Schema]);
var executionReceiptV1Schema = z2.object({
  schema_version: z2.literal(protocolVersions.executionReceipt),
  writeback_job_id: z2.string().min(1),
  proposal_id: z2.string().min(1),
  runner_id: z2.string().min(1),
  status: writebackTerminalStatusSchema,
  rows_affected: z2.number().int().nonnegative(),
  idempotency_key: z2.string().min(1),
  previous_version: scalar2.optional(),
  new_version: scalar2.optional(),
  source_database_mutated: z2.boolean(),
  executed_at: z2.string().min(1),
  safe_error_code: z2.string().optional(),
  receipt_hash: sha2562,
  reconciliation: z2.object({
    intent_id: z2.string().min(1),
    reason: z2.string().min(1)
  }).optional()
}).passthrough().superRefine((receipt2, ctx) => {
  if (receipt2.status === "reconciliation_required" && !receipt2.reconciliation) {
    ctx.addIssue({ code: z2.ZodIssueCode.custom, message: "reconciliation_required receipts require reconciliation metadata", path: ["reconciliation"] });
  }
});
var executionReceiptV2Schema = z2.object({
  schema_version: z2.literal(protocolVersions.executionReceiptV2),
  writeback_job_id: z2.string().min(1),
  proposal_id: z2.string().min(1),
  proposal_hash: sha2562,
  approval_id: z2.string().min(1),
  runner_id: z2.string().min(1),
  operation: z2.enum(["single_row_update", "single_row_insert", "single_row_delete"]),
  receipt_authority: z2.enum(["source_db", "runner_ledger"]),
  status: writebackTerminalStatusV2Schema,
  target: z2.object({
    source_id: z2.string().min(1),
    schema: safeIdentifier2,
    table: safeIdentifier2,
    identity: z2.array(columnValueSchema2).min(1).max(8)
  }),
  rows_affected: z2.number().int().min(0).max(1),
  idempotency_key: z2.string().min(1),
  before_digest: sha2562.optional(),
  after_digest: sha2562.optional(),
  tombstone_digest: sha2562.optional(),
  source_database_mutated: z2.boolean(),
  safe_outcome_code: z2.string().regex(/^[A-Z][A-Z0-9_]*$/),
  safe_error_code: z2.string().regex(/^[A-Z][A-Z0-9_]*$/).optional(),
  executed_at: z2.string().min(1),
  receipt_hash: sha2562,
  reconciliation: z2.object({
    intent_id: z2.string().min(1),
    reason: z2.string().min(1)
  }).optional(),
  inverse: inverseDescriptorV1Schema.optional()
}).superRefine((receipt2, ctx) => {
  if (receipt2.operation === "single_row_delete" && !receipt2.tombstone_digest && (receipt2.status === "applied" || receipt2.status === "already_applied")) {
    ctx.addIssue({ code: z2.ZodIssueCode.custom, message: "applied DELETE receipts require a tombstone digest", path: ["tombstone_digest"] });
  }
  if (receipt2.status === "reconciliation_required" && !receipt2.reconciliation) {
    ctx.addIssue({ code: z2.ZodIssueCode.custom, message: "reconciliation_required receipts require reconciliation metadata", path: ["reconciliation"] });
  }
  if (receipt2.rows_affected > 0 && !receipt2.source_database_mutated) {
    ctx.addIssue({ code: z2.ZodIssueCode.custom, message: "rows_affected cannot be positive when source_database_mutated is false", path: ["rows_affected"] });
  }
});
var executionReceiptV3Schema = z2.object({
  schema_version: z2.literal(protocolVersions.executionReceiptV3),
  writeback_job_id: z2.string().min(1),
  proposal_id: z2.string().min(1),
  proposal_hash: sha2562,
  approval_id: z2.string().min(1),
  runner_id: z2.string().min(1),
  operation: setOperationSchema,
  receipt_authority: z2.enum(["source_db", "runner_ledger"]),
  status: writebackTerminalStatusV2Schema,
  target: z2.object({
    source_id: z2.string().min(1),
    schema: safeIdentifier2,
    table: safeIdentifier2,
    identities: z2.array(columnValueSchema2).min(1).max(100),
    set_digest: sha2562
  }),
  rows_affected: z2.number().int().min(0).max(100),
  idempotency_key: z2.string().min(1),
  member_effects: z2.array(z2.object({
    primary_key: columnValueSchema2,
    before_digest: sha2562.optional(),
    after_digest: sha2562.optional(),
    tombstone_digest: sha2562.optional()
  })).max(100),
  source_database_mutated: z2.boolean(),
  safe_outcome_code: z2.string().regex(/^[A-Z][A-Z0-9_]*$/),
  safe_error_code: z2.string().regex(/^[A-Z][A-Z0-9_]*$/).optional(),
  executed_at: z2.string().min(1),
  receipt_hash: sha2562,
  reconciliation: z2.object({ intent_id: z2.string().min(1), reason: z2.string().min(1) }).optional(),
  inverse: inverseDescriptorV1Schema.optional()
}).superRefine((receipt2, ctx) => {
  if (receipt2.status === "applied" && (receipt2.rows_affected !== receipt2.target.identities.length || receipt2.member_effects.length !== receipt2.target.identities.length)) ctx.addIssue({ code: z2.ZodIssueCode.custom, message: "applied set receipt must identify every affected member", path: ["rows_affected"] });
  if (receipt2.rows_affected > 0 && !receipt2.source_database_mutated) ctx.addIssue({ code: z2.ZodIssueCode.custom, message: "mutated rows require source_database_mutated", path: ["source_database_mutated"] });
  if (receipt2.status === "reconciliation_required" && !receipt2.reconciliation) ctx.addIssue({ code: z2.ZodIssueCode.custom, message: "reconciliation metadata required", path: ["reconciliation"] });
});
var executionReceiptV4Schema = z2.object({
  schema_version: z2.literal(protocolVersions.executionReceiptV4),
  writeback_job_id: z2.string().min(1),
  proposal_id: z2.string().min(1),
  proposal_hash: sha2562,
  approval_id: z2.string().min(1),
  runner_id: z2.string().min(1),
  operation: reversalOperationSchema,
  receipt_authority: z2.enum(["source_db", "runner_ledger"]),
  status: writebackTerminalStatusV2Schema,
  target: z2.object({
    source_id: z2.string().min(1),
    schema: safeIdentifier2,
    table: safeIdentifier2,
    identities: z2.array(columnValueSchema2).min(1).max(100)
  }),
  rows_affected: z2.number().int().min(0).max(100),
  idempotency_key: z2.string().min(1),
  forward_receipt_hash: sha2562,
  member_effects: z2.array(z2.object({ primary_key: columnValueSchema2, before_digest: sha2562.optional(), after_digest: sha2562.optional(), tombstone_digest: sha2562.optional() })).max(100),
  inverse: inverseDescriptorV1Schema.optional(),
  source_database_mutated: z2.boolean(),
  safe_outcome_code: z2.string().regex(/^[A-Z][A-Z0-9_]*$/),
  safe_error_code: z2.string().regex(/^[A-Z][A-Z0-9_]*$/).optional(),
  executed_at: z2.string().min(1),
  receipt_hash: sha2562,
  reconciliation: z2.object({ intent_id: z2.string().min(1), reason: z2.string().min(1) }).optional()
}).superRefine((receipt2, ctx) => {
  if (receipt2.status === "applied" && receipt2.rows_affected !== receipt2.target.identities.length) ctx.addIssue({ code: z2.ZodIssueCode.custom, message: "applied compensation receipt must identify every affected member", path: ["rows_affected"] });
  if ((receipt2.status === "applied" || receipt2.status === "already_applied") && !receipt2.inverse) ctx.addIssue({ code: z2.ZodIssueCode.custom, message: "successful compensation requires its own inverse", path: ["inverse"] });
  if (receipt2.rows_affected > 0 && !receipt2.source_database_mutated) ctx.addIssue({ code: z2.ZodIssueCode.custom, message: "mutated rows require source_database_mutated", path: ["source_database_mutated"] });
  if (receipt2.status === "reconciliation_required" && !receipt2.reconciliation) ctx.addIssue({ code: z2.ZodIssueCode.custom, message: "reconciliation metadata required", path: ["reconciliation"] });
});
var normalizedExecutionReceiptV1Schema = executionReceiptV1Schema.transform((receipt2) => ({
  protocol_version: protocolVersions.legacyWritebackJob,
  job_id: receipt2.writeback_job_id,
  runner_id: receipt2.runner_id,
  status: receipt2.status,
  affected_rows: receipt2.rows_affected,
  result_version: receipt2.new_version == null ? void 0 : String(receipt2.new_version),
  result_hash: receipt2.receipt_hash,
  completed_at: receipt2.executed_at,
  error_code: receipt2.safe_error_code,
  intent_id: receipt2.reconciliation?.intent_id
}));
var legacyWritebackResultSchema = z2.object({
  protocol_version: z2.literal(protocolVersions.legacyWritebackJob),
  job_id: z2.string().min(1),
  runner_id: z2.string().min(1),
  status: writebackTerminalStatusSchema,
  affected_rows: z2.number().int().nonnegative().optional(),
  result_version: z2.string().optional(),
  result_hash: z2.string().optional(),
  completed_at: z2.string().optional(),
  error_code: z2.string().optional(),
  intent_id: z2.string().min(1).optional()
}).superRefine((result, ctx) => {
  if (result.status === "reconciliation_required" && !result.intent_id) {
    ctx.addIssue({ code: z2.ZodIssueCode.custom, message: "reconciliation_required results require intent_id", path: ["intent_id"] });
  }
});
var normalizedWritebackResultV2Schema = z2.object({
  protocol_version: z2.literal(protocolVersions.normalizedWritebackJobV2),
  job_id: z2.string().min(1),
  runner_id: z2.string().min(1),
  operation: z2.enum(["single_row_update", "single_row_insert", "single_row_delete"]),
  receipt_authority: z2.enum(["source_db", "runner_ledger"]),
  status: writebackTerminalStatusV2Schema,
  affected_rows: z2.number().int().min(0).max(1),
  target_identity: z2.array(columnValueSchema2).min(1).max(8),
  result_version: scalar2.optional(),
  before_digest: sha2562.optional(),
  after_digest: sha2562.optional(),
  tombstone_digest: sha2562.optional(),
  result_hash: sha2562.optional(),
  completed_at: z2.string().min(1),
  error_code: z2.string().regex(/^[A-Z][A-Z0-9_]*$/).optional(),
  intent_id: z2.string().min(1).optional(),
  inverse: inverseDescriptorV1Schema.optional()
}).superRefine((result, ctx) => {
  if (result.status === "reconciliation_required" && !result.intent_id) {
    ctx.addIssue({ code: z2.ZodIssueCode.custom, message: "reconciliation_required results require intent_id", path: ["intent_id"] });
  }
});
var normalizedWritebackResultV3Schema = z2.object({
  protocol_version: z2.literal(protocolVersions.normalizedWritebackJobV3),
  job_id: z2.string().min(1),
  runner_id: z2.string().min(1),
  operation: setOperationSchema,
  receipt_authority: z2.enum(["source_db", "runner_ledger"]),
  status: writebackTerminalStatusV2Schema,
  affected_rows: z2.number().int().min(0).max(100),
  target_identities: z2.array(columnValueSchema2).min(1).max(100),
  set_digest: sha2562,
  member_effects: z2.array(z2.object({ primary_key: columnValueSchema2, before_digest: sha2562.optional(), after_digest: sha2562.optional(), tombstone_digest: sha2562.optional() })).max(100),
  result_version: scalar2.optional(),
  result_hash: sha2562.optional(),
  completed_at: z2.string().min(1),
  error_code: z2.string().regex(/^[A-Z][A-Z0-9_]*$/).optional(),
  intent_id: z2.string().min(1).optional(),
  inverse: inverseDescriptorV1Schema.optional()
}).superRefine((result, ctx) => {
  if (result.status === "applied" && (result.affected_rows !== result.target_identities.length || result.member_effects.length !== result.target_identities.length)) ctx.addIssue({ code: z2.ZodIssueCode.custom, message: "applied set result must identify every member", path: ["affected_rows"] });
  if (result.status === "reconciliation_required" && !result.intent_id) ctx.addIssue({ code: z2.ZodIssueCode.custom, message: "reconciliation_required results require intent_id", path: ["intent_id"] });
});
var normalizedWritebackResultV4Schema = z2.object({
  protocol_version: z2.literal(protocolVersions.normalizedWritebackJobV4),
  job_id: z2.string().min(1),
  runner_id: z2.string().min(1),
  operation: reversalOperationSchema,
  receipt_authority: z2.enum(["source_db", "runner_ledger"]),
  status: writebackTerminalStatusV2Schema,
  affected_rows: z2.number().int().min(0).max(100),
  target_identities: z2.array(columnValueSchema2).min(1).max(100),
  member_effects: z2.array(z2.object({ primary_key: columnValueSchema2, before_digest: sha2562.optional(), after_digest: sha2562.optional(), tombstone_digest: sha2562.optional() })).max(100),
  inverse: inverseDescriptorV1Schema.optional(),
  result_hash: sha2562.optional(),
  completed_at: z2.string().min(1),
  error_code: z2.string().regex(/^[A-Z][A-Z0-9_]*$/).optional(),
  intent_id: z2.string().min(1).optional()
}).superRefine((result, ctx) => {
  if (result.status === "applied" && result.affected_rows !== result.target_identities.length) ctx.addIssue({ code: z2.ZodIssueCode.custom, message: "applied compensation must identify every member", path: ["affected_rows"] });
  if ((result.status === "applied" || result.status === "already_applied") && !result.inverse) ctx.addIssue({ code: z2.ZodIssueCode.custom, message: "successful compensation requires its own inverse", path: ["inverse"] });
  if (result.status === "reconciliation_required" && !result.intent_id) ctx.addIssue({ code: z2.ZodIssueCode.custom, message: "reconciliation_required results require intent_id", path: ["intent_id"] });
});
var writebackResultSchema = z2.union([legacyWritebackResultSchema, normalizedExecutionReceiptV1Schema, normalizedWritebackResultV5Schema, normalizedWritebackResultV4Schema, normalizedWritebackResultV3Schema, normalizedWritebackResultV2Schema]);
var runnerRegistrationV1Schema = z2.object({
  schema_version: z2.literal(protocolVersions.runnerRegistration),
  protocol_version: z2.literal(protocolVersions.runnerControl).optional(),
  runner_id: z2.string().min(1),
  runner_version: z2.string().min(1),
  engines: z2.array(writebackEngineSchema).min(1),
  capabilities: z2.array(z2.string().min(1)).min(1),
  scope: z2.object({
    project_id: z2.string().min(1),
    source_ids: z2.array(z2.string().min(1)).min(1)
  }),
  contracts: z2.array(z2.object({
    contract_id: z2.string().min(1),
    contract_version_id: z2.string().min(1),
    digest: sha2562
  })).max(100).optional(),
  registered_at: z2.string().min(1)
});
var runnerProposalV1Schema = z2.object({
  schema_version: z2.literal(protocolVersions.runnerProposal),
  runner_id: z2.string().min(1),
  source_id: z2.string().min(1),
  mapping_id: z2.string().min(1).optional(),
  contract: z2.object({
    contract_id: z2.string().min(1),
    contract_version_id: z2.string().min(1),
    digest: sha2562
  }),
  change_set: z2.union([changeSetV1Schema, changeSetV2Schema, changeSetV3Schema, changeSetV4Schema, compensationChangeSetV1Schema]),
  evidence_metadata: z2.record(z2.unknown()).optional(),
  query_audit: z2.record(z2.unknown()).optional()
}).superRefine((proposal, ctx) => {
  if (proposal.change_set.source_database_mutated) {
    ctx.addIssue({ code: z2.ZodIssueCode.custom, message: "Runner proposals must describe an unchanged source database", path: ["change_set", "source_database_mutated"] });
  }
  if (proposal.change_set.guards.principal_scope?.value !== void 0) {
    ctx.addIssue({ code: z2.ZodIssueCode.custom, message: "Runner Cloud proposals must use fingerprint-only principal scope metadata", path: ["change_set", "guards", "principal_scope", "value"] });
  }
});
var runnerActivityV1Schema = z2.object({
  schema_version: z2.literal(protocolVersions.runnerActivity),
  event_id: z2.string().min(1).max(120).regex(/^[A-Za-z0-9_.:-]+$/),
  event_type: z2.enum(["evidence.recorded", "query_audit.recorded", "replay.recorded", "worker.diagnostic"]),
  runner_id: z2.string().min(1).max(120),
  source_id: z2.string().min(1).max(120),
  proposal_id: z2.string().min(1).max(120).optional(),
  job_id: z2.string().min(1).max(120).optional(),
  contract_id: z2.string().min(1).max(120).optional(),
  contract_version_id: z2.string().min(1).max(120).optional(),
  contract_digest: sha2562.optional(),
  capability: z2.string().min(1).max(160).optional(),
  workflow: z2.string().min(1).max(160).optional(),
  tenant_id: z2.string().min(1).max(160).optional(),
  principal: z2.string().min(1).max(200).optional(),
  business_object: z2.string().min(1).max(160).optional(),
  object_id: z2.string().min(1).max(200).optional(),
  status: z2.string().min(1).max(80).optional(),
  evidence_ids: z2.array(z2.string().min(1).max(160)).max(100).optional(),
  query_audit_ids: z2.array(z2.string().min(1).max(160)).max(100).optional(),
  receipt_id: z2.string().min(1).max(160).optional(),
  replay_id: z2.string().min(1).max(160).optional(),
  detail: z2.record(z2.unknown()).optional(),
  occurred_at: z2.string().min(1).max(80).optional()
}).strict();
function sourceEngine(kind) {
  if (kind === "external_postgres") return "postgres";
  if (kind === "external_mysql") return "mysql";
  return void 0;
}
function validateFreshnessBinding(freshness, sourceId, engine, expectedTargetMode, expectedMemberCount, ctx) {
  if (!freshness) return;
  if (!engine) {
    ctx.addIssue({
      code: z2.ZodIssueCode.custom,
      message: "freshness authority requires an external PostgreSQL or MySQL source",
      path: ["freshness"]
    });
    return;
  }
  if (freshness.target.mode !== expectedTargetMode || freshness.target.member_count !== expectedMemberCount) {
    ctx.addIssue({
      code: z2.ZodIssueCode.custom,
      message: `freshness target authority must be ${expectedTargetMode} with ${expectedMemberCount} reviewed member(s)`,
      path: ["freshness", "target"]
    });
  }
  for (const [index, dependency] of freshness.dependencies.entries()) {
    if (dependency.source_id !== sourceId || dependency.engine !== engine) {
      ctx.addIssue({
        code: z2.ZodIssueCode.custom,
        message: "freshness dependencies must use the proposal/writeback source and engine",
        path: ["freshness", "dependencies", index, "source_id"]
      });
    }
  }
}
function validateAllowedPatchColumns(allowedColumns, patchColumns, primaryKeyColumn, tenantGuardColumn, ctx) {
  const allow = new Set(allowedColumns);
  for (const column of patchColumns) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(column)) {
      ctx.addIssue({
        code: z2.ZodIssueCode.custom,
        message: `patch column is not a fixed safe identifier: ${column}`,
        path: ["patch", column]
      });
      continue;
    }
    if (!allow.has(column)) {
      ctx.addIssue({
        code: z2.ZodIssueCode.custom,
        message: `patch column not allowed: ${column}`,
        path: ["patch", column]
      });
    }
  }
  if (allowedColumns.includes(primaryKeyColumn)) {
    ctx.addIssue({
      code: z2.ZodIssueCode.custom,
      message: "primary key column must not be patch-allowlisted",
      path: ["allowed_columns"]
    });
  }
  if (allowedColumns.includes(tenantGuardColumn)) {
    ctx.addIssue({
      code: z2.ZodIssueCode.custom,
      message: "tenant guard column must not be patch-allowlisted",
      path: ["allowed_columns"]
    });
  }
}
function validateResolvedDeduplication(components, values, tenantGuard, ctx, path7) {
  const columns = /* @__PURE__ */ new Set();
  let proposalIdentity = false;
  let trustedTenant = false;
  for (const [index, component] of components.entries()) {
    if (columns.has(component.column)) ctx.addIssue({ code: z2.ZodIssueCode.custom, message: "deduplication columns must be unique", path: [...path7, index, "column"] });
    columns.add(component.column);
    if (Object.prototype.hasOwnProperty.call(values, component.column)) ctx.addIssue({ code: z2.ZodIssueCode.custom, message: "deduplication columns must be Runner-supplied, not mutation values", path: [...path7, index, "column"] });
    if (component.source === "proposal_id") proposalIdentity = true;
    if (component.source === "trusted_tenant") {
      if (component.column !== tenantGuard.column || component.value !== tenantGuard.value) ctx.addIssue({ code: z2.ZodIssueCode.custom, message: "trusted tenant deduplication must match tenant_guard", path: [...path7, index] });
      else trustedTenant = true;
    }
  }
  if (!proposalIdentity) ctx.addIssue({ code: z2.ZodIssueCode.custom, message: "INSERT deduplication must include proposal_id", path: path7 });
  if (!trustedTenant) ctx.addIssue({ code: z2.ZodIssueCode.custom, message: "INSERT deduplication must include trusted tenant", path: path7 });
}
function normalizeConflictGuard(guard) {
  if (guard.kind === "column") {
    return { kind: "version_column", column: guard.column, expected_value: guard.expected_value };
  }
  return guard;
}
function parseChangeSet(input) {
  return z2.union([changeSetV1Schema, changeSetV2Schema, changeSetV3Schema, changeSetV4Schema, compensationChangeSetV1Schema]).parse(input);
}
function parseFreshnessAuthority(input) {
  return freshnessAuthorityV1Schema.parse(input);
}
function parseFreshnessProof(input) {
  return freshnessProofV1Schema.parse(input);
}
function parseWritebackJob(input) {
  return writebackJobSchema.parse(input);
}
function parseExecutionReceipt(input) {
  return z2.union([executionReceiptV1Schema, executionReceiptV2Schema, executionReceiptV3Schema, executionReceiptV4Schema, executionReceiptV5Schema]).parse(input);
}
function parseWritebackResult(input) {
  return writebackResultSchema.parse(input);
}

// ../synapsor-runner/packages/action-rules/dist/limits.js
var ACTION_AUTHORITY_LIMITS = Object.freeze({
  rules: 4096,
  approvalClasses: 4096,
  sourceBytes: 64 * 1024 * 1024
});

// ../synapsor-runner/packages/proposal-store/src/sqlite-store.ts
import { DatabaseSync } from "node:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

// ../synapsor-runner/packages/proposal-store/src/common.ts
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ../synapsor-runner/packages/proposal-store/src/query-builders.ts
function inWhere(column, values) {
  if (values.length === 0) return void 0;
  return {
    sql: `${column} IN (${values.map(() => "?").join(", ")})`,
    params: values
  };
}
function buildProposalQuery(filters) {
  const { clauses, params } = proposalQueryParts(filters);
  return finishQuery("SELECT * FROM proposals", clauses, params, filters.limit, filters.offset, "created_at DESC, proposal_id DESC");
}
function buildProposalCountQuery(filters) {
  const { clauses, params } = proposalQueryParts(filters);
  const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
  return { sql: `SELECT COUNT(*) AS count FROM proposals${where}`, params };
}
function proposalQueryParts(filters) {
  const clauses = [];
  const params = [];
  addEqual(clauses, params, "proposal_id", filters.proposal);
  addEqual(clauses, params, "tenant_id", filters.tenant);
  addEqual(clauses, params, "principal", filters.principal);
  addEqual(clauses, params, "source_id", filters.source);
  addTableFilter(clauses, params, "source_table", filters.table);
  addEqual(clauses, params, "state", filters.status ?? filters.state);
  addEqual(clauses, params, "action", filters.capability ?? filters.action);
  addObjectFilter(clauses, params, "business_object", "source_table", "object_id", filters.objectType, filters.objectId);
  addMetadataSearch(clauses, params, filters.search, [
    "proposal_id",
    "action",
    "capability",
    "business_object",
    "object_id",
    "source_table",
    "state"
  ]);
  addTimeRange(clauses, params, "created_at", filters.from, filters.to);
  return { clauses, params };
}
function buildEvidenceQuery(filters) {
  const clauses = [];
  const params = [];
  addEqual(clauses, params, "evidence_bundle_id", filters.evidence);
  addEqualAny(clauses, params, "tenant_id", filters.tenants ?? (filters.tenant ? [filters.tenant] : []));
  addEqualAny(clauses, params, "principal", filters.principals ?? (filters.principal ? [filters.principal] : []));
  addEqual(clauses, params, "capability", filters.capability);
  addEqual(clauses, params, "proposal_id", filters.proposal);
  addEqual(clauses, params, "source_id", filters.source);
  addTableFilter(clauses, params, "source_table", filters.table);
  addEqual(clauses, params, "query_fingerprint", filters.queryFingerprint);
  addEvidenceStatusFilter(clauses, params, filters.status);
  addExploreOutcomeFilter(clauses, params, filters.outcome, "outcome");
  addJsonEqual(clauses, params, "boundary_digest", filters.boundary);
  addObjectFilter(clauses, params, "business_object", "source_table", "object_id", filters.objectType, filters.objectId);
  addMetadataSearch(clauses, params, filters.search, [
    "evidence_bundle_id",
    "source_table",
    "source_id",
    "capability",
    "query_fingerprint",
    "payload_json"
  ]);
  addTimeRange(clauses, params, "created_at", filters.from, filters.to);
  return finishQuery("SELECT * FROM evidence_bundles", clauses, params, filters.limit, filters.offset);
}
function buildQueryAuditQuery(filters) {
  const clauses = [];
  const params = [];
  addEqualAny(clauses, params, "tenant_id", filters.tenants ?? (filters.tenant ? [filters.tenant] : []));
  addEqualAny(clauses, params, "principal", filters.principals ?? (filters.principal ? [filters.principal] : []));
  addEqual(clauses, params, "capability", filters.capability);
  addEqual(clauses, params, "proposal_id", filters.proposal);
  addEqual(clauses, params, "evidence_bundle_id", filters.evidence);
  addEqual(clauses, params, "source_id", filters.source);
  addTableFilter(clauses, params, "table_name", filters.table);
  addObjectFilter(clauses, params, "business_object", "table_name", "object_id", filters.objectType, filters.objectId);
  addEqual(clauses, params, "primary_key_value", filters.primaryKey);
  addEqual(clauses, params, "query_fingerprint", filters.queryFingerprint);
  addJsonStatusFilter(clauses, params, filters.status);
  addExploreOutcomeFilter(clauses, params, filters.outcome, "status");
  addJsonEqual(clauses, params, "boundary_digest", filters.boundary);
  addMetadataSearch(clauses, params, filters.search, [
    "CAST(audit_id AS TEXT)",
    "table_name",
    "source_id",
    "capability",
    "evidence_bundle_id",
    "query_fingerprint",
    "payload_json"
  ]);
  addTimeRange(clauses, params, "created_at", filters.from, filters.to);
  return finishQuery("SELECT * FROM query_audit", clauses, params, filters.limit, filters.offset);
}
function buildReceiptQuery(filters) {
  const clauses = [];
  const params = [];
  addEqual(clauses, params, "receipt_id", filters.receipt);
  addEqual(clauses, params, "proposal_id", filters.proposal);
  addEqual(clauses, params, "writeback_job_id", filters.writebackJob);
  addEqual(clauses, params, "idempotency_key", filters.idempotencyKey);
  addEqual(clauses, params, "status", filters.status);
  addEqual(clauses, params, "tenant_id", filters.tenant);
  addEqual(clauses, params, "principal", filters.principal);
  addEqual(clauses, params, "capability", filters.capability);
  addEqual(clauses, params, "source_id", filters.source);
  addTableFilter(clauses, params, "source_table", filters.table);
  addObjectFilter(clauses, params, "business_object", "source_table", "object_id", filters.objectType, filters.objectId);
  addTimeRange(clauses, params, "created_at", filters.from, filters.to);
  return finishQuery(`SELECT * FROM (
    SELECT r.*, p.tenant_id, p.principal, p.action AS capability,
      p.business_object, p.object_id, p.source_id, p.source_table
    FROM writeback_receipts r
    JOIN proposals p ON p.proposal_id = r.proposal_id
  ) AS associated_receipts`, clauses, params, filters.limit);
}
function buildEventQuery(filters) {
  const clauses = [];
  const params = [];
  addEqual(clauses, params, "proposal_id", filters.proposal);
  addEqual(clauses, params, "kind", filters.kind);
  addEqual(clauses, params, "actor", filters.actor);
  addTimeRange(clauses, params, "created_at", filters.from, filters.to);
  return finishQuery("SELECT * FROM proposal_events", clauses, params, filters.limit);
}
function addEqual(clauses, params, column, value) {
  if (!value) return;
  clauses.push(`${column} = ?`);
  params.push(value);
}
function addEqualAny(clauses, params, column, values) {
  const distinct = [...new Set(values.filter(Boolean))];
  const clause = inWhere(column, distinct);
  if (!clause) return;
  clauses.push(clause.sql);
  params.push(...clause.params);
}
function addJsonEqual(clauses, params, key2, value) {
  if (!value) return;
  clauses.push(`json_extract(payload_json, '$.${key2}') = ?`);
  params.push(value);
}
function addExploreOutcomeFilter(clauses, params, outcome, payloadKey) {
  if (!outcome) return;
  const expression = `json_extract(payload_json, '$.${payloadKey}')`;
  if (outcome === "refused") {
    clauses.push(`${expression} LIKE 'refused_%'`);
    return;
  }
  if (outcome === "failed") {
    clauses.push(`${expression} = 'failed'`);
    return;
  }
  clauses.push(`${expression} IN ('ok', 'empty', 'fully_suppressed', 'incomplete_comparison')`);
}
function addJsonStatusFilter(clauses, params, value) {
  if (!value) return;
  clauses.push("json_extract(payload_json, '$.status') = ?");
  params.push(value);
}
function addEvidenceStatusFilter(clauses, params, value) {
  if (!value) return;
  clauses.push("(json_extract(payload_json, '$.outcome') = ? OR json_extract(payload_json, '$.status') = ?)");
  params.push(value, value);
}
function addTableFilter(clauses, params, column, value) {
  if (!value) return;
  if (value.includes(".")) {
    clauses.push(`${column} = ?`);
    params.push(value);
    return;
  }
  clauses.push(`(${column} = ? OR ${column} = ?)`);
  params.push(value, `public.${value}`);
}
function addObjectFilter(clauses, params, typeColumn, tableColumn, idColumn, objectType, objectId) {
  if (objectId) {
    clauses.push(`${idColumn} = ?`);
    params.push(objectId);
  }
  if (!objectType) return;
  const variants = objectTypeVariants(objectType);
  const placeholders = variants.map(() => "?").join(", ");
  clauses.push(`(${typeColumn} IN (${placeholders}) OR ${tableColumn} IN (${placeholders}))`);
  params.push(...variants, ...variants);
}
function addTimeRange(clauses, params, column, from, to) {
  if (from) {
    clauses.push(`${column} >= ?`);
    params.push(from);
  }
  if (to) {
    clauses.push(`${column} <= ?`);
    params.push(to);
  }
}
function addMetadataSearch(clauses, params, value, columns) {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return;
  const escaped = normalized.replace(/[\\%_]/g, (character) => `\\${character}`);
  clauses.push(`(${columns.map((column) => `LOWER(COALESCE(${column}, '')) LIKE ? ESCAPE '\\'`).join(" OR ")})`);
  params.push(...columns.map(() => `%${escaped}%`));
}
function finishQuery(base, clauses, params, limit, offset, orderBy = "created_at DESC") {
  const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
  const boundedOffset = Number.isSafeInteger(offset) && Number(offset) > 0 ? Number(offset) : 0;
  const sql = `${base}${where} ORDER BY ${orderBy}${limit ? " LIMIT ?" : boundedOffset ? " LIMIT -1" : ""}${boundedOffset ? " OFFSET ?" : ""}`;
  return {
    sql,
    params: [
      ...params,
      ...limit ? [limit] : [],
      ...boundedOffset ? [boundedOffset] : []
    ]
  };
}
function objectTypeVariants(value) {
  const variants = /* @__PURE__ */ new Set([value]);
  if (value.endsWith("s")) variants.add(value.slice(0, -1));
  else variants.add(`${value}s`);
  for (const variant of [...variants]) {
    if (!variant.includes(".")) variants.add(`public.${variant}`);
  }
  return [...variants];
}
function stringFromUnknown(value) {
  if (typeof value === "string" && value.trim()) return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return void 0;
}
function stringFromPrincipal(value) {
  if (typeof value === "string") return value;
  if (isRecord(value)) return stringFromUnknown(value.id);
  return void 0;
}
function lastIdentifier(value) {
  const parts = value.split(".");
  return parts[parts.length - 1] ?? value;
}

// ../synapsor-runner/packages/proposal-store/src/sqlite-schema-methods.ts
var proposalStoreSchemaMethods = {
  close() {
    this.db.close();
  },
  stats() {
    const pageCount = this.numberValue("PRAGMA page_count");
    const pageSize = this.numberValue("PRAGMA page_size");
    return {
      path: this.path,
      proposals: this.countTable("proposals"),
      evidence_bundles: this.countTable("evidence_bundles"),
      evidence_items: this.countTable("evidence_items"),
      observed_subject_references: this.countTable("observed_subject_references"),
      query_audit: this.countTable("query_audit"),
      explore_privacy_releases: this.countTable("explore_privacy_releases"),
      explore_budget_reservations: this.countTable("explore_budget_reservations"),
      writeback_receipts: this.countTable("writeback_receipts"),
      writeback_jobs: this.countTable("writeback_jobs"),
      writeback_intents: this.countTable("writeback_intents"),
      idempotency_receipts: this.countTable("idempotency_receipts"),
      replay_records: this.countTable("replay_records"),
      approvals: this.countTable("approvals"),
      proposal_events: this.countTable("proposal_events"),
      shadow_human_actions: this.countTable("shadow_human_actions"),
      shadow_studies: this.countTable("shadow_studies"),
      shadow_study_cases: this.countTable("shadow_study_cases"),
      shadow_outcomes: this.countTable("shadow_outcomes"),
      worker_queue: this.countTable("worker_queue"),
      attention_events: this.countTable("attention_events"),
      attention_items: this.countTable("attention_items"),
      notification_deliveries: this.countTable("notification_deliveries"),
      policy_recommendations: this.countTable("policy_recommendations"),
      page_count: pageCount,
      page_size: pageSize,
      approx_bytes: pageCount * pageSize
    };
  },
  vacuum() {
    this.db.exec("VACUUM");
  },
  pruneBefore(cutoffIso, options = {}) {
    const dryRun = options.dryRun !== false;
    const proposalIds = this.stringColumn(
      `SELECT proposal_id FROM proposals
         WHERE created_at < ? AND state IN ('applied', 'conflict', 'rejected', 'canceled')
           AND NOT EXISTS (
             SELECT 1 FROM cloud_outbox
             WHERE cloud_outbox.proposal_id = proposals.proposal_id
               AND cloud_outbox.status <> 'acknowledged'
           )`,
      [cutoffIso],
      "proposal_id"
    );
    const evidenceIds = this.evidenceIdsForPrune(cutoffIso, proposalIds);
    const deleted = {};
    const run = (table, where, params) => {
      deleted[table] = this.countWhere(table, where, params);
      if (!dryRun && deleted[table] > 0) this.db.prepare(`DELETE FROM ${table} WHERE ${where}`).run(...params);
    };
    const proposalWhere = inWhere("proposal_id", proposalIds);
    const evidenceWhere = inWhere("evidence_bundle_id", evidenceIds);
    this.transaction(() => {
      if (proposalWhere) {
        run("cloud_outbox", `${proposalWhere.sql} AND status = 'acknowledged'`, proposalWhere.params);
        run("cloud_governance_events", proposalWhere.sql, proposalWhere.params);
        run("idempotency_receipts", proposalWhere.sql, proposalWhere.params);
        run("writeback_receipts", proposalWhere.sql, proposalWhere.params);
        run("writeback_jobs", proposalWhere.sql, proposalWhere.params);
        run("writeback_intents", proposalWhere.sql, proposalWhere.params);
        run("approvals", proposalWhere.sql, proposalWhere.params);
        run("proposal_events", proposalWhere.sql, proposalWhere.params);
        run("shadow_outcomes", proposalWhere.sql, proposalWhere.params);
        run("shadow_study_cases", proposalWhere.sql, proposalWhere.params);
        run("shadow_human_actions", proposalWhere.sql, proposalWhere.params);
        run("worker_queue", proposalWhere.sql, proposalWhere.params);
        run("replay_records", proposalWhere.sql, proposalWhere.params);
      } else {
        for (const table of ["cloud_outbox", "cloud_governance_events", "idempotency_receipts", "writeback_receipts", "writeback_jobs", "writeback_intents", "approvals", "proposal_events", "shadow_outcomes", "shadow_study_cases", "shadow_human_actions", "worker_queue", "replay_records"]) {
          deleted[table] = 0;
        }
      }
      const auditClauses = [];
      const auditParams = [];
      if (proposalWhere) {
        auditClauses.push(proposalWhere.sql);
        auditParams.push(...proposalWhere.params);
      }
      if (evidenceWhere) {
        auditClauses.push(evidenceWhere.sql);
        auditParams.push(...evidenceWhere.params);
      }
      auditClauses.push("(proposal_id IS NULL AND evidence_bundle_id IS NULL AND created_at < ?)");
      auditParams.push(cutoffIso);
      run("query_audit", auditClauses.map((clause) => `(${clause})`).join(" OR "), auditParams);
      if (evidenceWhere) {
        run("evidence_items", evidenceWhere.sql, evidenceWhere.params);
        run("evidence_bundles", evidenceWhere.sql, evidenceWhere.params);
      } else {
        deleted.evidence_items = 0;
        deleted.evidence_bundles = 0;
      }
      if (proposalWhere) run("proposals", proposalWhere.sql, proposalWhere.params);
      else deleted.proposals = 0;
      run("observed_subject_references", "expires_at < ?", [cutoffIso]);
    });
    return { cutoff: cutoffIso, dry_run: dryRun, deleted };
  },
  migrate() {
    this.db.exec(`
        PRAGMA foreign_keys = ON;
  
        CREATE TABLE IF NOT EXISTS proposal_store_schema (
          version INTEGER PRIMARY KEY,
          applied_at TEXT NOT NULL
        );
  
        CREATE TABLE IF NOT EXISTS proposals (
          proposal_id TEXT PRIMARY KEY,
          proposal_version INTEGER NOT NULL,
          proposal_hash TEXT NOT NULL,
          action TEXT NOT NULL,
          state TEXT NOT NULL,
          tenant_id TEXT NOT NULL,
          business_object TEXT NOT NULL,
          object_id TEXT NOT NULL,
          source_kind TEXT NOT NULL,
          source_id TEXT NOT NULL,
          source_schema TEXT NOT NULL,
          source_table TEXT NOT NULL,
          source_database_mutated INTEGER NOT NULL DEFAULT 0,
          change_set_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
  
        CREATE TABLE IF NOT EXISTS proposal_events (
          event_id INTEGER PRIMARY KEY AUTOINCREMENT,
          proposal_id TEXT NOT NULL,
          kind TEXT NOT NULL,
          actor TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          FOREIGN KEY (proposal_id) REFERENCES proposals(proposal_id)
        );
  
        CREATE TABLE IF NOT EXISTS approvals (
          approval_id INTEGER PRIMARY KEY AUTOINCREMENT,
          proposal_id TEXT NOT NULL,
          proposal_version INTEGER NOT NULL,
          proposal_hash TEXT NOT NULL,
          approver TEXT NOT NULL,
          status TEXT NOT NULL,
          reason TEXT,
          identity_json TEXT,
          decision_hash TEXT,
          signature TEXT,
          integrity_hash TEXT,
          freshness_proof_digest TEXT,
          action_boundary_name TEXT,
          action_boundary_digest TEXT,
          created_at TEXT NOT NULL,
          FOREIGN KEY (proposal_id) REFERENCES proposals(proposal_id)
        );
  
        CREATE TABLE IF NOT EXISTS writeback_receipts (
          receipt_id INTEGER PRIMARY KEY AUTOINCREMENT,
          writeback_job_id TEXT NOT NULL,
          proposal_id TEXT NOT NULL,
          runner_id TEXT NOT NULL,
          status TEXT NOT NULL,
          idempotency_key TEXT NOT NULL,
          source_database_mutated INTEGER NOT NULL,
          receipt_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          UNIQUE (writeback_job_id, idempotency_key),
          FOREIGN KEY (proposal_id) REFERENCES proposals(proposal_id)
        );
  
        CREATE TABLE IF NOT EXISTS evidence_bundles (
          evidence_bundle_id TEXT PRIMARY KEY,
          proposal_id TEXT,
          tenant_id TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          FOREIGN KEY (proposal_id) REFERENCES proposals(proposal_id)
        );
  
        CREATE TABLE IF NOT EXISTS evidence_items (
          evidence_item_id INTEGER PRIMARY KEY AUTOINCREMENT,
          evidence_bundle_id TEXT NOT NULL,
          item_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          FOREIGN KEY (evidence_bundle_id) REFERENCES evidence_bundles(evidence_bundle_id)
        );

        CREATE TABLE IF NOT EXISTS observed_subject_references (
          subject_ref TEXT PRIMARY KEY,
          subject_ref_digest TEXT UNIQUE NOT NULL,
          state TEXT NOT NULL CHECK (state IN ('active', 'consumed', 'revoked')),
          claim_id TEXT,
          record_json TEXT NOT NULL,
          issued_at TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          consumed_at TEXT,
          revoked_at TEXT
        );
  
        CREATE TABLE IF NOT EXISTS query_audit (
          audit_id INTEGER PRIMARY KEY AUTOINCREMENT,
          proposal_id TEXT,
          evidence_bundle_id TEXT,
          source_id TEXT NOT NULL,
          query_fingerprint TEXT NOT NULL,
          table_name TEXT NOT NULL,
          row_count INTEGER NOT NULL,
          payload_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          FOREIGN KEY (proposal_id) REFERENCES proposals(proposal_id),
          FOREIGN KEY (evidence_bundle_id) REFERENCES evidence_bundles(evidence_bundle_id)
        );

        CREATE TABLE IF NOT EXISTS explore_privacy_releases (
          release_id INTEGER PRIMARY KEY AUTOINCREMENT,
          scope_fingerprint TEXT NOT NULL,
          complement_fingerprint TEXT NOT NULL,
          release_kind TEXT NOT NULL CHECK (release_kind IN ('scalar_total', 'suppressed_grouping')),
          query_fingerprint TEXT NOT NULL,
          boundary_digest TEXT NOT NULL,
          created_at TEXT NOT NULL,
          UNIQUE(scope_fingerprint, complement_fingerprint, release_kind, query_fingerprint)
        );

        CREATE TABLE IF NOT EXISTS explore_budget_reservations (
          reservation_id TEXT PRIMARY KEY,
          scope_fingerprint TEXT NOT NULL,
          resource_id TEXT NOT NULL,
          variant_fingerprint TEXT NOT NULL,
          requires_differencing INTEGER NOT NULL CHECK (requires_differencing IN (0, 1)),
          differencing_counted INTEGER NOT NULL CHECK (differencing_counted IN (0, 1)),
          reserved_cells INTEGER NOT NULL CHECK (reserved_cells >= 0),
          accounted_cells INTEGER NOT NULL CHECK (accounted_cells >= 0),
          status TEXT NOT NULL CHECK (status IN ('pending', 'released', 'not_released')),
          created_at TEXT NOT NULL,
          completed_at TEXT
        );
  
        CREATE TABLE IF NOT EXISTS writeback_jobs (
          writeback_job_id TEXT PRIMARY KEY,
          proposal_id TEXT NOT NULL,
          proposal_hash TEXT NOT NULL,
          status TEXT NOT NULL,
          job_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY (proposal_id) REFERENCES proposals(proposal_id)
        );
  
        CREATE TABLE IF NOT EXISTS idempotency_receipts (
          idempotency_key TEXT PRIMARY KEY,
          writeback_job_id TEXT NOT NULL,
          proposal_id TEXT NOT NULL,
          receipt_status TEXT NOT NULL,
          receipt_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          FOREIGN KEY (writeback_job_id) REFERENCES writeback_jobs(writeback_job_id),
          FOREIGN KEY (proposal_id) REFERENCES proposals(proposal_id)
        );
  
        CREATE TABLE IF NOT EXISTS writeback_intents (
          intent_id TEXT PRIMARY KEY,
          idempotency_key TEXT UNIQUE NOT NULL,
          writeback_job_id TEXT UNIQUE NOT NULL,
          proposal_id TEXT NOT NULL,
          proposal_hash TEXT NOT NULL,
          runner_id TEXT NOT NULL,
          operation TEXT NOT NULL,
          status TEXT NOT NULL,
          intent_json TEXT NOT NULL,
          result_json TEXT,
          reconciliation_reason TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY (proposal_id) REFERENCES proposals(proposal_id)
        );
  
        CREATE TABLE IF NOT EXISTS replay_records (
          replay_id TEXT PRIMARY KEY,
          proposal_id TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          FOREIGN KEY (proposal_id) REFERENCES proposals(proposal_id)
        );
  
        CREATE TABLE IF NOT EXISTS shadow_human_actions (
          action_id INTEGER PRIMARY KEY AUTOINCREMENT,
          proposal_id TEXT NOT NULL,
          actor TEXT NOT NULL,
          patch_json TEXT NOT NULL,
          notes TEXT,
          created_at TEXT NOT NULL,
          FOREIGN KEY (proposal_id) REFERENCES proposals(proposal_id)
        );
  
        CREATE TABLE IF NOT EXISTS shadow_studies (
          study_id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          description TEXT,
          selected_capabilities_json TEXT NOT NULL,
          starts_at TEXT,
          ends_at TEXT,
          status TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
  
        CREATE TABLE IF NOT EXISTS shadow_study_cases (
          case_id TEXT PRIMARY KEY,
          study_id TEXT NOT NULL,
          request_id TEXT NOT NULL,
          proposal_id TEXT,
          tenant_id TEXT NOT NULL,
          principal TEXT,
          capability TEXT NOT NULL,
          business_object TEXT NOT NULL,
          object_id TEXT NOT NULL,
          evidence_bundle_id TEXT,
          proposed_effect_json TEXT,
          agent_result TEXT NOT NULL,
          decision_reason TEXT,
          risk_score REAL,
          amount_value REAL,
          created_at TEXT NOT NULL,
          UNIQUE(study_id, request_id, tenant_id, business_object, object_id),
          FOREIGN KEY (study_id) REFERENCES shadow_studies(study_id),
          FOREIGN KEY (proposal_id) REFERENCES proposals(proposal_id)
        );
  
        CREATE TABLE IF NOT EXISTS shadow_outcomes (
          outcome_id TEXT PRIMARY KEY,
          study_id TEXT NOT NULL,
          request_id TEXT NOT NULL,
          proposal_id TEXT,
          tenant_id TEXT NOT NULL,
          business_object TEXT NOT NULL,
          object_id TEXT NOT NULL,
          actor TEXT NOT NULL,
          disposition TEXT NOT NULL,
          actual_effect_json TEXT,
          occurred_at TEXT NOT NULL,
          source TEXT NOT NULL,
          reference TEXT,
          reason TEXT,
          created_at TEXT NOT NULL,
          FOREIGN KEY (study_id) REFERENCES shadow_studies(study_id),
          FOREIGN KEY (proposal_id) REFERENCES proposals(proposal_id)
        );
  
        CREATE TABLE IF NOT EXISTS runner_state (
          key TEXT PRIMARY KEY,
          value_json TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
  
        CREATE TABLE IF NOT EXISTS cloud_outbox (
          event_id TEXT PRIMARY KEY,
          proposal_id TEXT,
          sequence INTEGER NOT NULL,
          kind TEXT NOT NULL,
          status TEXT NOT NULL,
          payload_hash TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          attempts INTEGER NOT NULL DEFAULT 0,
          max_attempts INTEGER NOT NULL,
          next_attempt_at TEXT NOT NULL,
          lease_owner TEXT,
          lease_expires_at TEXT,
          last_error_code TEXT,
          sent_at TEXT,
          acknowledged_at TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY (proposal_id) REFERENCES proposals(proposal_id)
        );
  
        CREATE TABLE IF NOT EXISTS cloud_governance_events (
          event_id TEXT PRIMARY KEY,
          proposal_id TEXT NOT NULL,
          cloud_proposal_id TEXT,
          kind TEXT NOT NULL,
          state TEXT NOT NULL,
          authority TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          integrity_hash TEXT NOT NULL,
          created_at TEXT NOT NULL,
          FOREIGN KEY (proposal_id) REFERENCES proposals(proposal_id)
        );
  
        CREATE TABLE IF NOT EXISTS policy_recommendations (
          recommendation_id TEXT PRIMARY KEY,
          tenant_id TEXT NOT NULL,
          capability TEXT NOT NULL,
          policy TEXT NOT NULL,
          base_contract_digest TEXT NOT NULL,
          status TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          integrity_hash TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
  
        CREATE TABLE IF NOT EXISTS attention_events (
          event_id TEXT PRIMARY KEY,
          schema_version TEXT NOT NULL,
          event_type TEXT NOT NULL,
          severity TEXT NOT NULL,
          occurred_at TEXT NOT NULL,
          environment TEXT NOT NULL,
          proposal_id TEXT,
          job_id TEXT,
          operation_id TEXT,
          correlation_id TEXT,
          capability TEXT,
          contract_digest TEXT,
          attention_key TEXT,
          attention_required INTEGER NOT NULL,
          immediate_default INTEGER NOT NULL,
          summary TEXT NOT NULL,
          approval_source TEXT,
          worker_state TEXT,
          failure_class TEXT,
          expires_at TEXT,
          workbench_path TEXT,
          details_json TEXT NOT NULL,
          payload_hash TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
  
        CREATE TABLE IF NOT EXISTS attention_items (
          attention_id TEXT PRIMARY KEY,
          attention_key TEXT NOT NULL UNIQUE,
          status TEXT NOT NULL,
          severity TEXT NOT NULL,
          environment TEXT NOT NULL,
          event_type TEXT NOT NULL,
          capability TEXT,
          contract_digest TEXT,
          title TEXT NOT NULL,
          occurrence_count INTEGER NOT NULL,
          first_event_id TEXT NOT NULL,
          latest_event_id TEXT NOT NULL,
          first_seen_at TEXT NOT NULL,
          last_seen_at TEXT NOT NULL,
          acknowledged_by TEXT,
          acknowledged_at TEXT,
          acknowledgement_identity_json TEXT,
          acknowledgement_decision_hash TEXT,
          acknowledgement_signature TEXT,
          acknowledgement_integrity_hash TEXT,
          resolved_at TEXT,
          expires_at TEXT,
          FOREIGN KEY (first_event_id) REFERENCES attention_events(event_id),
          FOREIGN KEY (latest_event_id) REFERENCES attention_events(event_id)
        );
  
        CREATE TABLE IF NOT EXISTS notification_deliveries (
          delivery_id TEXT PRIMARY KEY,
          sink_id TEXT NOT NULL,
          event_id TEXT NOT NULL,
          attention_id TEXT,
          status TEXT NOT NULL,
          attempts INTEGER NOT NULL DEFAULT 0,
          max_attempts INTEGER NOT NULL,
          next_attempt_at TEXT NOT NULL,
          lease_owner TEXT,
          lease_id TEXT,
          lease_expires_at TEXT,
          last_error_code TEXT,
          external_reference TEXT,
          delivered_at TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE(sink_id, event_id),
          FOREIGN KEY (event_id) REFERENCES attention_events(event_id),
          FOREIGN KEY (attention_id) REFERENCES attention_items(attention_id)
        );
  
        CREATE TABLE IF NOT EXISTS worker_queue (
          proposal_id TEXT PRIMARY KEY,
          status TEXT NOT NULL,
          execution_mode TEXT DEFAULT 'legacy',
          contract_digest TEXT,
          cancellation_control_role TEXT,
          cancellation_control_role_present INTEGER NOT NULL DEFAULT 0,
          attempts INTEGER NOT NULL DEFAULT 0,
          max_attempts INTEGER NOT NULL,
          next_attempt_at TEXT NOT NULL,
          lease_owner TEXT,
          lease_id TEXT,
          lease_expires_at TEXT,
          last_error_code TEXT,
          terminal_outcome TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY (proposal_id) REFERENCES proposals(proposal_id)
        );
  
        CREATE INDEX IF NOT EXISTS idx_proposal_events_proposal_id ON proposal_events(proposal_id);
        CREATE INDEX IF NOT EXISTS idx_query_audit_proposal_id ON query_audit(proposal_id);
        CREATE INDEX IF NOT EXISTS idx_explore_privacy_release_lookup
          ON explore_privacy_releases(scope_fingerprint, complement_fingerprint, release_kind);
        CREATE INDEX IF NOT EXISTS idx_explore_budget_scope_created
          ON explore_budget_reservations(scope_fingerprint, created_at);
        CREATE INDEX IF NOT EXISTS idx_explore_budget_variant
          ON explore_budget_reservations(scope_fingerprint, resource_id, variant_fingerprint, created_at);
        CREATE INDEX IF NOT EXISTS idx_writeback_receipts_proposal_id ON writeback_receipts(proposal_id);
        CREATE INDEX IF NOT EXISTS idx_writeback_intents_proposal_id ON writeback_intents(proposal_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_writeback_intents_status_updated ON writeback_intents(status, updated_at);
        CREATE INDEX IF NOT EXISTS idx_replay_records_proposal_id ON replay_records(proposal_id);
        CREATE INDEX IF NOT EXISTS idx_shadow_human_actions_proposal_id ON shadow_human_actions(proposal_id);
        CREATE INDEX IF NOT EXISTS idx_shadow_studies_status ON shadow_studies(status, starts_at, ends_at);
        CREATE INDEX IF NOT EXISTS idx_shadow_study_cases_study ON shadow_study_cases(study_id, created_at, case_id);
        CREATE INDEX IF NOT EXISTS idx_shadow_study_cases_proposal ON shadow_study_cases(proposal_id);
        CREATE INDEX IF NOT EXISTS idx_shadow_outcomes_study_request ON shadow_outcomes(study_id, request_id, occurred_at, outcome_id);
        CREATE INDEX IF NOT EXISTS idx_shadow_outcomes_proposal ON shadow_outcomes(proposal_id);
        CREATE INDEX IF NOT EXISTS idx_policy_recommendations_scope ON policy_recommendations(tenant_id, capability, policy, status, created_at);
        CREATE INDEX IF NOT EXISTS idx_cloud_outbox_due ON cloud_outbox(status, next_attempt_at, sequence, created_at);
        CREATE INDEX IF NOT EXISTS idx_cloud_outbox_proposal ON cloud_outbox(proposal_id, sequence, created_at);
        CREATE INDEX IF NOT EXISTS idx_cloud_governance_proposal ON cloud_governance_events(proposal_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_attention_events_type_time ON attention_events(event_type, occurred_at, event_id);
        CREATE INDEX IF NOT EXISTS idx_attention_events_proposal ON attention_events(proposal_id, occurred_at, event_id);
        CREATE INDEX IF NOT EXISTS idx_attention_events_capability ON attention_events(capability, occurred_at, event_id);
        CREATE INDEX IF NOT EXISTS idx_attention_items_status ON attention_items(status, severity, last_seen_at, attention_id);
        CREATE INDEX IF NOT EXISTS idx_notification_deliveries_due ON notification_deliveries(status, next_attempt_at, created_at, delivery_id);
        CREATE INDEX IF NOT EXISTS idx_notification_deliveries_sink ON notification_deliveries(sink_id, status, updated_at, delivery_id);
  
        INSERT OR IGNORE INTO proposal_store_schema(version, applied_at)
        VALUES (1, datetime('now'));
      `);
    this.ensureSearchColumns();
    this.backfillSearchColumns();
    this.ensureSearchIndexes();
  },
  ensureSearchColumns() {
    this.ensureColumn("proposals", "principal", "TEXT");
    this.ensureColumn("proposals", "capability", "TEXT");
    this.ensureColumn("proposals", "interaction_id", "TEXT");
    this.ensureColumn("proposals", "tool_call_id", "TEXT");
    this.ensureColumn("evidence_bundles", "principal", "TEXT");
    this.ensureColumn("evidence_bundles", "capability", "TEXT");
    this.ensureColumn("evidence_bundles", "source_id", "TEXT");
    this.ensureColumn("evidence_bundles", "source_table", "TEXT");
    this.ensureColumn("evidence_bundles", "business_object", "TEXT");
    this.ensureColumn("evidence_bundles", "object_id", "TEXT");
    this.ensureColumn("evidence_bundles", "query_fingerprint", "TEXT");
    this.ensureColumn("query_audit", "tenant_id", "TEXT");
    this.ensureColumn("query_audit", "principal", "TEXT");
    this.ensureColumn("query_audit", "capability", "TEXT");
    this.ensureColumn("query_audit", "business_object", "TEXT");
    this.ensureColumn("query_audit", "object_id", "TEXT");
    this.ensureColumn("query_audit", "primary_key_value", "TEXT");
    this.ensureColumn("approvals", "identity_json", "TEXT");
    this.ensureColumn("approvals", "decision_hash", "TEXT");
    this.ensureColumn("approvals", "signature", "TEXT");
    this.ensureColumn("approvals", "integrity_hash", "TEXT");
    this.ensureColumn("approvals", "freshness_proof_digest", "TEXT");
    this.ensureColumn("approvals", "action_boundary_name", "TEXT");
    this.ensureColumn("approvals", "action_boundary_digest", "TEXT");
    this.ensureColumn("attention_items", "acknowledgement_identity_json", "TEXT");
    this.ensureColumn("attention_items", "acknowledgement_decision_hash", "TEXT");
    this.ensureColumn("attention_items", "acknowledgement_signature", "TEXT");
    this.ensureColumn("attention_items", "acknowledgement_integrity_hash", "TEXT");
    this.ensureColumn("worker_queue", "execution_mode", "TEXT DEFAULT 'legacy'");
    this.ensureColumn("worker_queue", "contract_digest", "TEXT");
    this.ensureColumn("worker_queue", "cancellation_control_role", "TEXT");
    this.ensureColumn("worker_queue", "cancellation_control_role_present", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("worker_queue", "lease_id", "TEXT");
    this.ensureColumn("worker_queue", "terminal_outcome", "TEXT");
  },
  ensureSearchIndexes() {
    this.db.exec(`
        CREATE INDEX IF NOT EXISTS idx_proposals_tenant_created ON proposals(tenant_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_proposals_action_created ON proposals(action, created_at);
        CREATE INDEX IF NOT EXISTS idx_proposals_capability_created ON proposals(capability, created_at);
        CREATE INDEX IF NOT EXISTS idx_proposals_principal_created ON proposals(principal, created_at);
        CREATE INDEX IF NOT EXISTS idx_proposals_object_created ON proposals(business_object, object_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_proposals_state_created ON proposals(state, created_at);
        CREATE INDEX IF NOT EXISTS idx_proposals_source_table_created ON proposals(source_id, source_table, created_at);
  
        CREATE INDEX IF NOT EXISTS idx_evidence_bundles_tenant_created ON evidence_bundles(tenant_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_evidence_bundles_proposal_id ON evidence_bundles(proposal_id);
        CREATE INDEX IF NOT EXISTS idx_evidence_bundles_created ON evidence_bundles(created_at);
        CREATE INDEX IF NOT EXISTS idx_evidence_bundles_capability_created ON evidence_bundles(capability, created_at);
        CREATE INDEX IF NOT EXISTS idx_evidence_bundles_principal_created ON evidence_bundles(principal, created_at);
        CREATE INDEX IF NOT EXISTS idx_evidence_bundles_object_created ON evidence_bundles(business_object, object_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_evidence_bundles_source_table_created ON evidence_bundles(source_id, source_table, created_at);
        CREATE INDEX IF NOT EXISTS idx_evidence_bundles_fingerprint_created ON evidence_bundles(query_fingerprint, created_at);
  
        CREATE INDEX IF NOT EXISTS idx_evidence_items_bundle_id ON evidence_items(evidence_bundle_id);

        CREATE INDEX IF NOT EXISTS idx_observed_subject_expiry
          ON observed_subject_references(state, expires_at);
        CREATE INDEX IF NOT EXISTS idx_observed_subject_claim
          ON observed_subject_references(claim_id);
  
        CREATE INDEX IF NOT EXISTS idx_query_audit_evidence_id ON query_audit(evidence_bundle_id);
        CREATE INDEX IF NOT EXISTS idx_query_audit_source_table_created ON query_audit(source_id, table_name, created_at);
        CREATE INDEX IF NOT EXISTS idx_query_audit_fingerprint_created ON query_audit(query_fingerprint, created_at);
        CREATE INDEX IF NOT EXISTS idx_query_audit_created ON query_audit(created_at);
        CREATE INDEX IF NOT EXISTS idx_query_audit_tenant_created ON query_audit(tenant_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_query_audit_capability_created ON query_audit(capability, created_at);
        CREATE INDEX IF NOT EXISTS idx_query_audit_principal_created ON query_audit(principal, created_at);
        CREATE INDEX IF NOT EXISTS idx_query_audit_object_created ON query_audit(business_object, object_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_query_audit_primary_key_created ON query_audit(primary_key_value, created_at);
  
        CREATE INDEX IF NOT EXISTS idx_writeback_receipts_writeback_job ON writeback_receipts(writeback_job_id);
        CREATE INDEX IF NOT EXISTS idx_writeback_receipts_idempotency_key ON writeback_receipts(idempotency_key);
        CREATE INDEX IF NOT EXISTS idx_writeback_receipts_status_created ON writeback_receipts(status, created_at);
  
        CREATE INDEX IF NOT EXISTS idx_replay_records_created ON replay_records(created_at);
  
        CREATE INDEX IF NOT EXISTS idx_approvals_proposal_id ON approvals(proposal_id);
        CREATE INDEX IF NOT EXISTS idx_approvals_status_created ON approvals(status, created_at);
        CREATE INDEX IF NOT EXISTS idx_approvals_action_boundary_created ON approvals(action_boundary_name, created_at);
  
        CREATE INDEX IF NOT EXISTS idx_proposal_events_kind_created ON proposal_events(kind, created_at);
        CREATE INDEX IF NOT EXISTS idx_worker_queue_claim ON worker_queue(status, next_attempt_at, lease_expires_at, created_at);
        CREATE INDEX IF NOT EXISTS idx_worker_queue_supervised_claim ON worker_queue(execution_mode, contract_digest, status, next_attempt_at, lease_expires_at, created_at);
      `);
  },
  ensureColumn(table, column, definition) {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all();
    if (columns.some((row) => isRecord(row) && row.name === column)) return;
    this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  },
  backfillSearchColumns() {
    const proposals = this.db.prepare("SELECT proposal_id, action, change_set_json FROM proposals").all();
    for (const row of proposals) {
      if (!isRecord(row)) continue;
      try {
        const changeSet = parseChangeSet(JSON.parse(String(row.change_set_json)));
        this.db.prepare("UPDATE proposals SET principal = COALESCE(principal, ?), capability = COALESCE(capability, ?) WHERE proposal_id = ?").run(changeSet.principal.id, changeSet.action, String(row.proposal_id));
      } catch {
      }
    }
    const evidenceRows = this.db.prepare("SELECT evidence_bundle_id, proposal_id, payload_json FROM evidence_bundles").all();
    for (const row of evidenceRows) {
      if (!isRecord(row)) continue;
      const proposal = row.proposal_id == null ? void 0 : this.getProposal(String(row.proposal_id));
      let payload = {};
      try {
        payload = JSON.parse(String(row.payload_json));
      } catch {
        payload = {};
      }
      const metadata = this.evidenceMetadata({
        proposal,
        payload,
        items: this.evidenceItems(String(row.evidence_bundle_id)).map((item) => item.item)
      });
      this.db.prepare(`
          UPDATE evidence_bundles
          SET principal = COALESCE(principal, ?),
              capability = COALESCE(capability, ?),
              source_id = COALESCE(source_id, ?),
              source_table = COALESCE(source_table, ?),
              business_object = COALESCE(business_object, ?),
              object_id = COALESCE(object_id, ?),
              query_fingerprint = COALESCE(query_fingerprint, ?)
          WHERE evidence_bundle_id = ?
        `).run(
        metadata.principal ?? null,
        metadata.capability ?? null,
        metadata.source_id ?? null,
        metadata.source_table ?? null,
        metadata.business_object ?? null,
        metadata.object_id ?? null,
        metadata.query_fingerprint ?? null,
        String(row.evidence_bundle_id)
      );
    }
    const auditRows = this.db.prepare("SELECT audit_id, proposal_id, evidence_bundle_id, payload_json FROM query_audit").all();
    for (const row of auditRows) {
      if (!isRecord(row)) continue;
      const proposal = row.proposal_id == null ? void 0 : this.getProposal(String(row.proposal_id));
      const evidence = row.evidence_bundle_id == null ? void 0 : this.getEvidenceBundle(String(row.evidence_bundle_id));
      let payload = {};
      try {
        payload = JSON.parse(String(row.payload_json));
      } catch {
        payload = {};
      }
      const metadata = this.queryAuditMetadata({ proposal, evidence, payload });
      this.db.prepare(`
          UPDATE query_audit
          SET tenant_id = COALESCE(tenant_id, ?),
              principal = COALESCE(principal, ?),
              capability = COALESCE(capability, ?),
              business_object = COALESCE(business_object, ?),
              object_id = COALESCE(object_id, ?),
              primary_key_value = COALESCE(primary_key_value, ?)
          WHERE audit_id = ?
        `).run(
        metadata.tenant_id ?? null,
        metadata.principal ?? null,
        metadata.capability ?? null,
        metadata.business_object ?? null,
        metadata.object_id ?? null,
        metadata.primary_key_value ?? null,
        Number(row.audit_id)
      );
    }
  }
};

// ../synapsor-runner/packages/proposal-store/src/errors.ts
var ProposalStoreError = class extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = "ProposalStoreError";
  }
  code;
};

// ../synapsor-runner/packages/proposal-store/src/proposal-integrity.ts
function semanticApprovalSetDigest(proposal, approvals) {
  const approved = approvals.filter((approval) => approval.status === "approved").map((approval) => ({
    approval_id: approval.approval_id,
    proposal_version: approval.proposal_version,
    proposal_hash: approval.proposal_hash,
    approver: approval.approver,
    decision_hash: approval.decision_hash ?? null,
    integrity_hash: approval.integrity_hash ?? null,
    freshness_proof_digest: approval.freshness_proof_digest ?? null,
    action_boundary_name: approval.action_boundary_name ?? null,
    action_boundary_digest: approval.action_boundary_digest ?? null,
    created_at: approval.created_at
  }));
  if (approved.length === 0) {
    throw new ProposalStoreError(
      "SEMANTIC_APPROVAL_MISSING",
      `semantic proposal ${proposal.proposal_id} has no durable approval record`
    );
  }
  return canonicalJsonDigest({
    schema_version: "synapsor.semantic-approval-set.v1",
    proposal_id: proposal.proposal_id,
    proposal_version: proposal.proposal_version,
    proposal_hash: proposal.proposal_hash,
    approvals: approved
  });
}
function stateFromChangeSet(changeSet) {
  if (changeSet.approval.status === "approved") return "approved";
  if (changeSet.approval.status === "rejected") return "rejected";
  if (changeSet.approval.status === "canceled") return "canceled";
  return "pending_review";
}
function proposalScopeIndex(changeSet) {
  if (changeSet.schema_version === "synapsor.change-set.v4" && changeSet.scope.organization_scope !== void 0) {
    return {
      kind: "organization",
      id: changeSet.scope.organization_scope.organization_id
    };
  }
  const tenantId = changeSet.scope.tenant_id;
  if (typeof tenantId !== "string" || tenantId.length === 0) {
    throw new ProposalStoreError(
      "PROPOSAL_SCOPE_INVALID",
      `proposal ${changeSet.proposal_id} has no trusted accounting scope`
    );
  }
  return { kind: "tenant", id: tenantId };
}
function proposalFreshnessAuthority(proposal) {
  if (!("freshness" in proposal.change_set) || proposal.change_set.freshness === void 0) return void 0;
  try {
    return parseFreshnessAuthority(proposal.change_set.freshness);
  } catch {
    throw new ProposalStoreError(
      "FRESHNESS_AUTHORITY_TAMPERED",
      `stored freshness authority for proposal ${proposal.proposal_id} failed integrity validation`
    );
  }
}
function requiredApprovalCount(proposal) {
  const configured = proposal.change_set.approval.required_approvals;
  return typeof configured === "number" && Number.isSafeInteger(configured) && configured >= 1 ? configured : 1;
}
function assertOperatorDecision(proposal, action, actor, identity, requireVerified) {
  if (requireVerified && (!identity || !identity.verified)) {
    throw new ProposalStoreError("VERIFIED_OPERATOR_IDENTITY_REQUIRED", `verified operator identity is required to ${action} proposal ${proposal.proposal_id}`);
  }
  if (!identity) return;
  if (identity.subject !== actor || identity.decision.subject !== actor) {
    throw new ProposalStoreError("OPERATOR_IDENTITY_MISMATCH", `operator identity ${identity.subject} does not match actor ${actor}`);
  }
  if (identity.decision.action !== action || identity.decision.proposal_id !== proposal.proposal_id || identity.decision.proposal_version !== proposal.proposal_version || identity.decision.proposal_hash !== proposal.proposal_hash) {
    throw new ProposalStoreError("OPERATOR_DECISION_MISMATCH", `operator proof is not bound to this ${action} decision`);
  }
  const requiredRole = proposal.change_set.approval.required_role;
  if ((action === "approve" || action === "reject") && requiredRole && !identity.roles.includes(requiredRole)) {
    throw new ProposalStoreError("APPROVER_ROLE_REQUIRED", `operator ${identity.subject} lacks required role ${requiredRole}`);
  }
}
function publicIdentitySummary(identity) {
  if (!identity) return void 0;
  return {
    provider: identity.provider,
    verified: identity.verified,
    subject: identity.subject,
    roles: identity.roles,
    key_id: identity.key_id,
    algorithm: identity.algorithm,
    decision_hash: identity.decision_hash,
    integrity_hash: identity.integrity_hash
  };
}
function utcDayWindow(value) {
  const instant = new Date(value);
  if (Number.isNaN(instant.getTime())) {
    throw new ProposalStoreError("INVALID_POLICY_CLOCK", `invalid policy evaluation time: ${value}`);
  }
  const start = new Date(Date.UTC(instant.getUTCFullYear(), instant.getUTCMonth(), instant.getUTCDate()));
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1e3);
  return { start: start.toISOString(), end: end.toISOString() };
}
function assertProposalIdentity(proposal, hash, version) {
  if (proposal.proposal_hash !== hash) {
    throw new ProposalStoreError("PROPOSAL_HASH_MISMATCH", `proposal ${proposal.proposal_id} hash mismatch`);
  }
  if (proposal.proposal_version !== version) {
    throw new ProposalStoreError("PROPOSAL_VERSION_MISMATCH", `proposal ${proposal.proposal_id} version mismatch`);
  }
}
function assertWritebackAllowed(proposal, operation) {
  if (proposal.change_set.mode === "shadow") {
    throw new ProposalStoreError(
      "SHADOW_WRITEBACK_DISABLED",
      `shadow proposal ${proposal.proposal_id} cannot be ${operation}; shadow mode stores proposals, evidence, query audit, and replay only and never mutates the source database`
    );
  }
  if (proposal.change_set.mode === "read_only") {
    throw new ProposalStoreError(
      "READ_ONLY_WRITEBACK_DISABLED",
      `read-only proposal ${proposal.proposal_id} cannot be ${operation}; read-only mode does not allow proposal writeback`
    );
  }
}
var secretKeyPattern = /(^|[_-])(password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|cookie|credential|connection[_-]?string|database[_-]?url|read[_-]?url|write[_-]?url)($|[_-])/i;
var secretValuePattern = /(postgres(?:ql)?:\/\/|mysql:\/\/|Bearer\s+[A-Za-z0-9._~+/=-]+|syn_wbr_[A-Za-z0-9._~+/=-]+|-----BEGIN [A-Z ]*PRIVATE KEY-----)/i;
function assertNoSecretMaterial(value, path7) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoSecretMaterial(item, `${path7}[${index}]`));
    return;
  }
  if (isRecord(value)) {
    for (const [key2, entry] of Object.entries(value)) {
      const entryPath = `${path7}.${key2}`;
      if (secretKeyPattern.test(key2)) {
        throw new ProposalStoreError(
          "SECRET_MATERIAL_REJECTED",
          `refusing to persist secret-like field ${entryPath}; remove it from reviewed visible/evidence/query-audit data`
        );
      }
      assertNoSecretMaterial(entry, entryPath);
    }
    return;
  }
  if (typeof value === "string" && secretValuePattern.test(value)) {
    throw new ProposalStoreError(
      "SECRET_MATERIAL_REJECTED",
      `refusing to persist secret-like value at ${path7}; remove it from reviewed visible/evidence/query-audit data`
    );
  }
}

// ../synapsor-runner/packages/proposal-store/src/attention-domain.ts
function attentionEventsForProposalEvent(input) {
  const proposal = input.proposal;
  const contractDigest = proposal.change_set.contract?.digest;
  const scopeDigest = canonicalJsonDigest({
    tenant_id: proposal.tenant_id,
    principal: proposal.principal ?? null
  });
  const sourceKey = (eventType) => `proposal:${proposal.proposal_id}:event:${input.proposal_event_id}:${eventType}`;
  const base = (eventType, severity) => ({
    event_type: eventType,
    severity,
    environment: input.environment,
    proposal_id: proposal.proposal_id,
    capability: proposal.capability ?? proposal.action,
    ...contractDigest ? { contract_digest: contractDigest } : {},
    source_event_key: sourceKey(eventType),
    now: input.occurred_at
  });
  const safeCode = safeAttentionPayloadString(input.payload, "safe_error_code") ?? safeAttentionPayloadString(input.payload, "error_code") ?? safeAttentionPayloadString(input.payload, "reason_code");
  const workerDetails = safeAttentionDetails(input.payload, [
    "attempt",
    "max_attempts",
    "execution_mode",
    "outcome"
  ]);
  const requiredRole = typeof proposal.change_set.approval.required_role === "string" ? proposal.change_set.approval.required_role : "reviewer";
  const reviewAttention = (summary) => {
    const attentionKey = proposalReviewAttentionKey(proposal, input.environment);
    return {
      ...base("proposal.review_required", "warning"),
      attention_required: true,
      immediate_default: true,
      attention_key: attentionKey,
      summary: summary ?? `${proposal.capability ?? proposal.action} proposals need ${requiredRole} review`,
      workbench_path: `/attention/${attentionItemId(attentionKey)}`,
      details: {
        required_role: requiredRole,
        ...safeCode ? { failure_class: safeCode } : {}
      },
      ...safeCode ? { failure_class: safeCode } : {}
    };
  };
  const criticalWorkerAttention = (eventType, summary) => {
    const failureClass = safeCode ?? (eventType === "worker.dead_lettered" ? "RETRY_BUDGET_EXHAUSTED" : eventType === "worker.unknown_outcome" ? "OUTCOME_UNKNOWN" : "RECONCILIATION_REQUIRED");
    const attentionKey = [
      input.environment,
      eventType,
      proposal.capability ?? proposal.action,
      contractDigest ?? "no_digest",
      failureClass,
      scopeDigest
    ].join(":");
    return {
      ...base(eventType, "critical"),
      attention_required: true,
      immediate_default: true,
      attention_key: attentionKey,
      summary,
      workbench_path: `/attention/${attentionItemId(attentionKey)}`,
      worker_state: eventType.slice("worker.".length),
      failure_class: failureClass,
      details: {
        ...workerDetails,
        failure_class: failureClass
      }
    };
  };
  if (input.kind === "proposal_created") {
    const events = [{
      ...base("proposal.created", "informational"),
      attention_required: false,
      immediate_default: false,
      details: { source_database_changed: false }
    }];
    const approvalMode = proposal.change_set.approval.mode;
    if (proposal.state === "pending_review" && approvalMode !== "policy") events.push(reviewAttention());
    return events;
  }
  if (input.kind === "proposal_approved") {
    const policyApproved = input.actor.startsWith("policy:");
    return [{
      ...base(policyApproved ? "proposal.auto_approved" : "proposal.approved", "informational"),
      attention_required: false,
      immediate_default: false,
      approval_source: policyApproved ? "policy_auto" : "human",
      details: safeAttentionDetails(input.payload, ["approvals", "required_approvals", "remaining_approvals"])
    }];
  }
  if (input.kind === "policy_auto_approval_deferred" || input.kind === "proposal_approval_blocked_freshness") {
    return [reviewAttention(
      input.kind === "proposal_approval_blocked_freshness" ? `${proposal.capability ?? proposal.action} needs review because its source freshness check failed` : `${proposal.capability ?? proposal.action} exceeded automatic-approval policy and needs human review`
    )];
  }
  if (input.kind === "proposal_rejected" || input.kind === "proposal_failed") {
    return [{
      ...base("proposal.refused", "warning"),
      attention_required: false,
      immediate_default: false,
      ...safeCode ? { failure_class: safeCode, details: { failure_class: safeCode } } : {}
    }];
  }
  if (input.kind === "proposal_canceled" || input.kind === "writeback_canceled") {
    return [{
      ...base("proposal.cancelled", "informational"),
      attention_required: false,
      immediate_default: false
    }];
  }
  if (input.kind === "proposal_conflict" || input.kind === "writeback_conflict" || input.kind === "writeback_intent_conflict") {
    return [{
      ...base("proposal.conflict", "warning"),
      attention_required: false,
      immediate_default: false,
      ...safeCode ? { failure_class: safeCode, details: { failure_class: safeCode } } : {}
    }];
  }
  if (input.kind === "proposal_pending_worker" || input.kind === "writeback_worker_queued") {
    return [{
      ...base("proposal.queued", "informational"),
      attention_required: false,
      immediate_default: false,
      worker_state: "queued",
      details: safeAttentionDetails(input.payload, ["execution_mode", "max_attempts"])
    }];
  }
  if (input.kind === "writeback_retry_scheduled") {
    return [{
      ...base("worker.retry_scheduled", "warning"),
      attention_required: false,
      immediate_default: false,
      worker_state: "retry_wait",
      ...safeCode ? { failure_class: safeCode } : {},
      details: {
        ...workerDetails,
        ...safeCode ? { failure_class: safeCode } : {}
      }
    }];
  }
  if (input.kind === "writeback_dead_lettered") {
    return [criticalWorkerAttention("worker.dead_lettered")];
  }
  if (input.kind === "writeback_worker_blocked") {
    const failureClass = safeCode ?? "WORKER_POLICY_BLOCKED";
    if (/PROPOSAL_.*EXPIRED|PROPOSAL_EXPIRED/i.test(failureClass)) {
      return [{
        ...base("proposal.expired", "warning"),
        attention_required: false,
        immediate_default: false,
        worker_state: "blocked",
        failure_class: failureClass,
        details: {
          ...workerDetails,
          failure_class: failureClass
        }
      }];
    }
    const digestStale = /(?:CONTRACT|DIGEST|GENERATION_LOCK|SCHEMA|POLICY)_.*(?:STALE|MISMATCH|CHANGED)|ACTIVE_CONTRACT_DIGEST/i.test(failureClass);
    const limitExceeded = /(?:LIMIT|RATE|QUEUE|BUDGET)_.*(?:EXCEEDED|STALE|MISMATCH)|POLICY_LIMIT/i.test(failureClass);
    const eventType = digestStale ? "contract.digest_stale" : limitExceeded ? "policy.limit_exceeded" : "proposal.refused";
    const severity = digestStale || limitExceeded ? "critical" : "warning";
    const attentionRequired = digestStale || limitExceeded;
    const attentionKey = [
      input.environment,
      eventType,
      proposal.capability ?? proposal.action,
      contractDigest ?? "no_digest",
      failureClass,
      scopeDigest
    ].join(":");
    return [{
      ...base(eventType, severity),
      attention_required: attentionRequired,
      immediate_default: attentionRequired,
      ...attentionRequired ? {
        attention_key: attentionKey,
        workbench_path: `/attention/${attentionItemId(attentionKey)}`
      } : {},
      worker_state: "blocked",
      failure_class: failureClass,
      details: {
        ...workerDetails,
        failure_class: failureClass
      }
    }];
  }
  if (input.kind === "policy_limit_near") {
    return [{
      ...base("policy.limit_near", "warning"),
      attention_required: false,
      immediate_default: false,
      summary: `${proposal.capability ?? proposal.action} is approaching a reviewed policy limit`,
      details: safeAttentionDetails(input.payload, [
        "kind",
        "scope",
        "observed",
        "proposed",
        "projected",
        "max",
        "window_start",
        "window_end"
      ])
    }];
  }
  if (input.kind === "writeback_reconciliation_required" || input.kind === "writeback_intent_reconciliation_required") {
    return [criticalWorkerAttention("worker.reconciliation_required")];
  }
  if ((input.kind === "writeback_failed" || input.kind === "writeback_intent_failed") && (safeCode === "OUTCOME_UNKNOWN" || safeCode === "RECONCILIATION_REQUIRED")) {
    return [criticalWorkerAttention("worker.unknown_outcome")];
  }
  if (input.kind === "writeback_applied" || input.kind === "writeback_already_applied" || input.kind === "writeback_intent_applied" || input.kind === "writeback_intent_already_applied") {
    return [{
      ...base("proposal.applied", "informational"),
      attention_required: false,
      immediate_default: false,
      worker_state: "completed",
      details: safeAttentionDetails(input.payload, ["rows_affected", "source_database_mutated"])
    }];
  }
  if (input.kind === "writeback_worker_completed") {
    const outcome = safeAttentionPayloadString(input.payload, "outcome");
    if (outcome === "conflict") {
      return [{
        ...base("proposal.conflict", "warning"),
        attention_required: false,
        immediate_default: false,
        worker_state: "completed",
        details: { outcome }
      }];
    }
    if (outcome === "applied" || outcome === "already_applied") {
      return [{
        ...base("proposal.applied", "informational"),
        attention_required: false,
        immediate_default: false,
        worker_state: "completed",
        details: { outcome }
      }];
    }
  }
  if (input.kind === "proposal_reconciliation_required") {
    return [criticalWorkerAttention("worker.reconciliation_required")];
  }
  return [];
}
function proposalReviewAttentionKey(proposal, environment) {
  const contractDigest = proposal.change_set.contract?.digest;
  const requiredRole = typeof proposal.change_set.approval.required_role === "string" ? proposal.change_set.approval.required_role : "reviewer";
  const scopeDigest = canonicalJsonDigest({
    tenant_id: proposal.tenant_id,
    principal: proposal.principal ?? null
  });
  return [
    environment,
    "proposal.review_required",
    proposal.capability ?? proposal.action,
    contractDigest ?? "no_digest",
    requiredRole,
    scopeDigest
  ].join(":");
}
function safeAttentionPayloadString(payload, key2) {
  const value = payload[key2];
  if (typeof value !== "string" || !value.trim()) return void 0;
  return value.trim().slice(0, 128);
}
function safeAttentionDetails(payload, keys) {
  const details = {};
  for (const key2 of keys) {
    const value = payload[key2];
    if (value === null || typeof value === "boolean") details[key2] = value;
    else if (typeof value === "number" && Number.isFinite(value)) details[key2] = value;
    else if (typeof value === "string" && value.trim()) details[key2] = value.trim().slice(0, 128);
  }
  return details;
}
var attentionEventTypes = /* @__PURE__ */ new Set([
  "proposal.created",
  "proposal.review_required",
  "proposal.auto_approved",
  "proposal.approved",
  "proposal.queued",
  "proposal.expiring",
  "proposal.expired",
  "proposal.cancelled",
  "proposal.applied",
  "proposal.conflict",
  "proposal.refused",
  "worker.started",
  "worker.paused",
  "worker.unhealthy",
  "worker.recovered",
  "worker.queue_backlog",
  "worker.retry_scheduled",
  "worker.dead_lettered",
  "worker.unknown_outcome",
  "worker.reconciliation_required",
  "capability.review_required",
  "capability.activated",
  "capability.revoked",
  "contract.digest_stale",
  "schema.drift_detected",
  "credential.posture_changed",
  "policy.limit_near",
  "policy.limit_exceeded",
  "sensitive_override_activated",
  "notification.replayed",
  "notification.digest"
]);
var defaultAttentionEventTypes = /* @__PURE__ */ new Set([
  "proposal.review_required",
  "proposal.expiring",
  "proposal.expired",
  "worker.unhealthy",
  "worker.queue_backlog",
  "worker.dead_lettered",
  "worker.unknown_outcome",
  "worker.reconciliation_required",
  "capability.review_required",
  "contract.digest_stale",
  "schema.drift_detected",
  "credential.posture_changed",
  "policy.limit_exceeded",
  "sensitive_override_activated"
]);
var defaultImmediateAttentionEventTypes = /* @__PURE__ */ new Set([
  "proposal.review_required",
  "proposal.expiring",
  "worker.unhealthy",
  "worker.queue_backlog",
  "worker.dead_lettered",
  "worker.unknown_outcome",
  "worker.reconciliation_required",
  "contract.digest_stale",
  "schema.drift_detected",
  "credential.posture_changed",
  "policy.limit_exceeded"
]);
function attentionEventTitle(eventType) {
  const titles = {
    "proposal.created": "Proposal created",
    "proposal.review_required": "Proposal needs human review",
    "proposal.auto_approved": "Proposal approved by reviewed policy",
    "proposal.approved": "Proposal approved",
    "proposal.queued": "Proposal queued for trusted execution",
    "proposal.expiring": "Approved proposal is approaching expiry",
    "proposal.expired": "Approved proposal expired without execution",
    "proposal.cancelled": "Proposal cancelled",
    "proposal.applied": "Proposal applied",
    "proposal.conflict": "Guarded writeback conflict",
    "proposal.refused": "Proposal refused",
    "worker.started": "Trusted worker started",
    "worker.paused": "Trusted worker paused",
    "worker.unhealthy": "Trusted worker needs attention",
    "worker.recovered": "Trusted worker supervision recovered",
    "worker.queue_backlog": "Trusted worker queue backlog",
    "worker.retry_scheduled": "Trusted worker retry scheduled",
    "worker.dead_lettered": "Trusted worker job dead-lettered",
    "worker.unknown_outcome": "Database transaction outcome is unknown",
    "worker.reconciliation_required": "Operator reconciliation is required",
    "capability.review_required": "Capability needs human review",
    "capability.activated": "Capability activated",
    "capability.revoked": "Capability revoked",
    "contract.digest_stale": "Active contract or policy authority is stale",
    "schema.drift_detected": "Schema drift blocks active authority",
    "credential.posture_changed": "Credential posture changed",
    "policy.limit_near": "Policy limit is approaching",
    "policy.limit_exceeded": "Policy limit exceeded",
    "sensitive_override_activated": "Sensitive-field override activated",
    "notification.replayed": "Notification delivery requeued by a verified operator",
    "notification.digest": "Runner activity digest"
  };
  return titles[eventType];
}
function assertAttentionEventInput(input) {
  if (!attentionEventTypes.has(input.event_type)) {
    throw new ProposalStoreError("ATTENTION_EVENT_TYPE_INVALID", `unsupported attention event type: ${String(input.event_type)}`);
  }
  if (!["informational", "warning", "critical"].includes(input.severity)) {
    throw new ProposalStoreError("ATTENTION_EVENT_SEVERITY_INVALID", `unsupported attention severity: ${String(input.severity)}`);
  }
  if (input.contract_digest && !/^sha256:[a-f0-9]{64}$/.test(input.contract_digest)) {
    throw new ProposalStoreError("ATTENTION_EVENT_DIGEST_INVALID", "attention event contract digest must be a lowercase sha256 digest");
  }
  for (const [label, value] of [["now", input.now], ["expires_at", input.expires_at]]) {
    if (value !== void 0 && !Number.isFinite(Date.parse(value))) {
      throw new ProposalStoreError("ATTENTION_EVENT_TIME_INVALID", `attention event ${label} must be an ISO timestamp`);
    }
  }
  const entries = Object.entries(input.details ?? {});
  if (entries.length > 32) {
    throw new ProposalStoreError("ATTENTION_EVENT_DETAILS_TOO_LARGE", "attention event details may contain at most 32 safe fields");
  }
  for (const [key2, value] of entries) {
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(key2)) {
      throw new ProposalStoreError("ATTENTION_EVENT_DETAIL_KEY_INVALID", `attention event detail key is invalid: ${key2}`);
    }
    if (typeof value === "string") boundedSafeLabel(value, `attention detail ${key2}`, 256);
    else if (typeof value === "number" && !Number.isFinite(value)) {
      throw new ProposalStoreError("ATTENTION_EVENT_DETAIL_VALUE_INVALID", `attention event detail ${key2} must be finite`);
    } else if (value !== null && typeof value !== "number" && typeof value !== "boolean") {
      throw new ProposalStoreError("ATTENTION_EVENT_DETAIL_VALUE_INVALID", `attention event detail ${key2} must be scalar`);
    }
  }
  assertNoSecretMaterial(input.details ?? {}, "attention_event.details");
}
function boundedSafeLabel(value, label, maximum) {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maximum || /[\u0000-\u001f\u007f]/.test(trimmed)) {
    throw new ProposalStoreError("ATTENTION_EVENT_FIELD_INVALID", `${label} must be a non-empty bounded single-line value`);
  }
  assertNoSecretMaterial({ value: trimmed }, label);
  return trimmed;
}
function boundedWorkbenchPath(value) {
  const path7 = boundedSafeLabel(value, "attention Workbench path", 512);
  if (!path7.startsWith("/") || path7.includes("?") || path7.includes("#") || path7.includes("://") || path7.includes("..")) {
    throw new ProposalStoreError(
      "ATTENTION_WORKBENCH_PATH_INVALID",
      "attention Workbench path must be a local absolute path without query, fragment, traversal, or authority"
    );
  }
  return path7;
}
function defaultAttentionKey(input) {
  const failureClass = typeof input.details.failure_class === "string" ? input.details.failure_class : typeof input.details.reason_code === "string" ? input.details.reason_code : "none";
  return [
    input.environment,
    input.event_type,
    input.capability ?? "global",
    input.contract_digest ?? "no_digest",
    failureClass
  ].join(":");
}
function attentionEventId(sourceEventKey, eventType) {
  const digest7 = canonicalJsonDigest({ source_event_key: sourceEventKey, event_type: eventType });
  return `aev_${digest7.slice("sha256:".length)}`;
}
function attentionItemId(attentionKey) {
  const digest7 = canonicalJsonDigest({ attention_key: attentionKey });
  return `attn_${digest7.slice("sha256:".length, "sha256:".length + 32)}`;
}
function boundedSinkId(value) {
  const sinkId = boundedSafeLabel(value, "notification sink id", 128);
  if (!/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(sinkId)) {
    throw new ProposalStoreError(
      "NOTIFICATION_SINK_ID_INVALID",
      "notification sink id must use letters, numbers, underscore, period, or hyphen"
    );
  }
  return sinkId;
}
function boundedSafeErrorCode(value) {
  const errorCode = boundedSafeLabel(value, "notification error code", 128);
  if (!/^[A-Z][A-Z0-9_]*$/.test(errorCode)) {
    throw new ProposalStoreError(
      "NOTIFICATION_ERROR_CODE_INVALID",
      "notification error code must be an uppercase safe code"
    );
  }
  return errorCode;
}
function notificationDeliveryId(sinkId, eventId) {
  const digest7 = canonicalJsonDigest({ sink_id: sinkId, event_id: eventId });
  return `ndl_${digest7.slice("sha256:".length, "sha256:".length + 32)}`;
}
function notificationLeaseId(deliveryId, owner, attempt, now) {
  const digest7 = canonicalJsonDigest({
    delivery_id: deliveryId,
    owner,
    attempt,
    now
  });
  return `nlease_${digest7.slice("sha256:".length, "sha256:".length + 32)}`;
}
function attentionSeverityRank(severity) {
  if (severity === "critical") return 3;
  if (severity === "warning") return 2;
  return 1;
}
function attentionDecisionSubject(item) {
  return {
    proposal_id: item.attention_id,
    proposal_version: item.occurrence_count,
    proposal_hash: canonicalJsonDigest({
      schema_version: "synapsor.attention-decision-subject.v1",
      attention_id: item.attention_id,
      attention_key: item.attention_key,
      status: item.status,
      severity: item.severity,
      environment: item.environment,
      event_type: item.event_type,
      capability: item.capability ?? null,
      contract_digest: item.contract_digest ?? null,
      occurrence_count: item.occurrence_count,
      latest_event_id: item.latest_event_id,
      last_seen_at: item.last_seen_at
    })
  };
}
function notificationReplayDecisionSubject(delivery) {
  return {
    proposal_id: delivery.delivery_id,
    proposal_version: Math.max(1, delivery.attempts),
    proposal_hash: canonicalJsonDigest({
      schema_version: "synapsor.notification-replay-decision-subject.v1",
      delivery_id: delivery.delivery_id,
      sink_id: delivery.sink_id,
      event_id: delivery.event_id,
      attention_id: delivery.attention_id ?? null,
      status: delivery.status,
      attempts: delivery.attempts,
      max_attempts: delivery.max_attempts,
      last_error_code: delivery.last_error_code ?? null,
      updated_at: delivery.updated_at
    })
  };
}
function assertNotificationReplayOperatorDecision(delivery, identity, reason) {
  if (!identity.verified || identity.provider === "dev_env") {
    throw new ProposalStoreError(
      "VERIFIED_OPERATOR_IDENTITY_REQUIRED",
      `verified operator identity is required to replay notification delivery ${delivery.delivery_id}`
    );
  }
  if (identity.subject !== identity.decision.subject) {
    throw new ProposalStoreError(
      "OPERATOR_IDENTITY_MISMATCH",
      "notification replay identity does not match its signed decision subject"
    );
  }
  const subject = notificationReplayDecisionSubject(delivery);
  if (identity.decision.action !== "notification_replay" || identity.decision.proposal_id !== subject.proposal_id || identity.decision.proposal_version !== subject.proposal_version || identity.decision.proposal_hash !== subject.proposal_hash || identity.decision.reason !== reason) {
    throw new ProposalStoreError(
      "OPERATOR_DECISION_MISMATCH",
      "operator proof is not bound to this exact notification delivery revision and replay reason"
    );
  }
  if (identity.decision_hash !== canonicalJsonDigest(identity.decision)) {
    throw new ProposalStoreError(
      "OPERATOR_IDENTITY_TAMPERED",
      "notification replay decision hash failed its integrity check"
    );
  }
  const { integrity_hash: _integrityHash, ...core } = identity;
  const canonicalCore = JSON.parse(JSON.stringify(core));
  if (identity.integrity_hash !== canonicalJsonDigest(canonicalCore)) {
    throw new ProposalStoreError(
      "OPERATOR_IDENTITY_TAMPERED",
      "notification replay identity proof failed its integrity check"
    );
  }
}
function assertAttentionOperatorDecision(item, actor, identity, requireVerified) {
  if (requireVerified && (!identity || !identity.verified || identity.provider === "dev_env")) {
    throw new ProposalStoreError(
      "VERIFIED_OPERATOR_IDENTITY_REQUIRED",
      `verified operator identity is required to acknowledge attention item ${item.attention_id}`
    );
  }
  if (!identity) return;
  if (identity.subject !== actor || identity.decision.subject !== actor) {
    throw new ProposalStoreError(
      "OPERATOR_IDENTITY_MISMATCH",
      `operator identity ${identity.subject} does not match attention acknowledgement actor ${actor}`
    );
  }
  const subject = attentionDecisionSubject(item);
  if (identity.decision.action !== "attention_acknowledge" || identity.decision.proposal_id !== subject.proposal_id || identity.decision.proposal_version !== subject.proposal_version || identity.decision.proposal_hash !== subject.proposal_hash) {
    throw new ProposalStoreError(
      "OPERATOR_DECISION_MISMATCH",
      "operator proof is not bound to this exact attention item version"
    );
  }
  if (identity.decision_hash !== canonicalJsonDigest(identity.decision)) {
    throw new ProposalStoreError(
      "OPERATOR_IDENTITY_TAMPERED",
      "attention acknowledgement decision hash failed its integrity check"
    );
  }
  const { integrity_hash: _integrityHash, ...core } = identity;
  const canonicalCore = JSON.parse(JSON.stringify(core));
  if (identity.integrity_hash !== canonicalJsonDigest(canonicalCore)) {
    throw new ProposalStoreError(
      "OPERATOR_IDENTITY_TAMPERED",
      "attention acknowledgement identity proof failed its integrity check"
    );
  }
}

// ../synapsor-runner/packages/proposal-store/src/shadow-analysis.ts
function comparePatches(proposalId, agentPatch, humanAction) {
  const comparedAt = (/* @__PURE__ */ new Date()).toISOString();
  if (!humanAction) {
    return {
      proposal_id: proposalId,
      status: "no_human_action",
      agent_patch: agentPatch,
      matching_columns: [],
      differing_columns: [],
      missing_from_human: Object.keys(agentPatch),
      extra_human_columns: [],
      compared_at: comparedAt
    };
  }
  const humanPatch = humanAction.patch;
  const agentColumns = Object.keys(agentPatch);
  const humanColumns = Object.keys(humanPatch);
  const matchingColumns = agentColumns.filter((column) => Object.is(agentPatch[column], humanPatch[column]));
  const differingColumns = agentColumns.filter((column) => column in humanPatch && !Object.is(agentPatch[column], humanPatch[column]));
  const missingFromHuman = agentColumns.filter((column) => !(column in humanPatch));
  const extraHumanColumns = humanColumns.filter((column) => !(column in agentPatch));
  const exact = matchingColumns.length === agentColumns.length && differingColumns.length === 0 && missingFromHuman.length === 0 && extraHumanColumns.length === 0;
  const partial = !exact && matchingColumns.length > 0;
  return {
    proposal_id: proposalId,
    status: exact ? "exact_match" : partial ? "partial_match" : "mismatch",
    agent_patch: agentPatch,
    human_patch: humanPatch,
    matching_columns: matchingColumns,
    differing_columns: differingColumns,
    missing_from_human: missingFromHuman,
    extra_human_columns: extraHumanColumns,
    notes: humanAction.notes,
    compared_at: comparedAt
  };
}
function compareShadowStudyCase(shadowCase, outcome) {
  const base = {
    study_id: shadowCase.study_id,
    case_id: shadowCase.case_id,
    request_id: shadowCase.request_id,
    proposal_id: shadowCase.proposal_id,
    tenant_id: shadowCase.tenant_id,
    principal: shadowCase.principal,
    capability: shadowCase.capability,
    business_object: shadowCase.business_object,
    object_id: shadowCase.object_id,
    agent_result: shadowCase.agent_result,
    proposed_effect: shadowCase.proposed_effect,
    outcome,
    matching_columns: [],
    differing_columns: [],
    missing_from_human: [],
    extra_human_columns: [],
    decision_reason: shadowCase.decision_reason,
    risk_score: shadowCase.risk_score,
    amount_value: shadowCase.amount_value,
    compared_at: outcome?.created_at ?? shadowCase.created_at
  };
  if (shadowCase.agent_result === "invalid_unsafe_scope_attempt") {
    return { ...base, status: "invalid_or_unsafe_scope_attempt", comparable: false };
  }
  if (shadowCase.agent_result === "policy_denied") {
    return { ...base, status: "agent_policy_denied", comparable: false };
  }
  if (shadowCase.agent_result === "unable_to_propose") {
    return { ...base, status: "agent_unable_to_propose", comparable: false };
  }
  if (shadowCase.agent_result === "stale_conflict" || outcome?.disposition === "stale_conflict") {
    return { ...base, status: "stale_conflict", comparable: false };
  }
  if (!outcome) {
    return { ...base, status: "unmatched_no_authoritative_outcome", comparable: false };
  }
  if (outcome.disposition === "rejected_no_action") {
    return { ...base, status: "human_rejected_no_action", comparable: false };
  }
  const agentPatch = shadowCase.proposed_effect?.patch ?? {};
  const humanPatch = outcome.actual_effect?.patch ?? {};
  const agentColumns = Object.keys(agentPatch).sort();
  const humanColumns = Object.keys(humanPatch).sort();
  const matchingColumns = agentColumns.filter(
    (column) => column in humanPatch && shadowValuesEqual(agentPatch[column], humanPatch[column])
  );
  const differingColumns = agentColumns.filter(
    (column) => column in humanPatch && !shadowValuesEqual(agentPatch[column], humanPatch[column])
  );
  const missingFromHuman = agentColumns.filter((column) => !(column in humanPatch));
  const extraHumanColumns = humanColumns.filter((column) => !(column in agentPatch));
  const exact = matchingColumns.length === agentColumns.length && differingColumns.length === 0 && missingFromHuman.length === 0 && extraHumanColumns.length === 0;
  const partial = !exact && matchingColumns.length > 0;
  return {
    ...base,
    status: exact ? "exact_agreement" : partial ? "partial_agreement" : "disagreement",
    comparable: true,
    matching_columns: matchingColumns,
    differing_columns: differingColumns,
    missing_from_human: missingFromHuman,
    extra_human_columns: extraHumanColumns
  };
}
function latestIsoTimestamp(values) {
  return [...values].sort((left, right) => Date.parse(right) - Date.parse(left))[0];
}
function normalizeShadowEffect(input, path7) {
  if (!isRecord(input) || !isRecord(input.before) || !isRecord(input.after) || !isRecord(input.patch)) {
    throw new ProposalStoreError("SHADOW_EFFECT_INVALID", `${path7} must contain before, after, and patch objects`);
  }
  const before = structuredClone(input.before);
  const after = structuredClone(input.after);
  const patch = structuredClone(input.patch);
  for (const [column, value] of Object.entries(patch)) {
    if (!(column in after) || !shadowValuesEqual(after[column], value)) {
      throw new ProposalStoreError("SHADOW_EFFECT_PATCH_MISMATCH", `${path7}.patch.${column} must equal the normalized after value`);
    }
  }
  assertNoSecretMaterial({ before, after, patch }, path7);
  return { before, after, patch };
}
function shadowEffectFromChangeSet(changeSet) {
  return normalizeShadowEffect({
    before: changeSet.before,
    after: changeSet.after,
    patch: changeSet.patch
  }, "shadow_proposal.effect");
}
function effectAmountValue(effect) {
  let total = 0;
  let found = false;
  for (const column of Object.keys(effect.patch)) {
    const before = effect.before[column];
    const after = effect.after[column];
    if (typeof before === "number" && Number.isFinite(before) && typeof after === "number" && Number.isFinite(after)) {
      total += Math.abs(after - before);
      found = true;
    }
  }
  return found ? total : void 0;
}
function shadowStudyIncludes(study, capability, createdAt) {
  const timestamp3 = Date.parse(createdAt);
  if (!Number.isFinite(timestamp3)) return false;
  if (study.starts_at && timestamp3 < Date.parse(study.starts_at)) return false;
  if (study.ends_at && timestamp3 > Date.parse(study.ends_at)) return false;
  return study.selected_capabilities.length === 0 || study.selected_capabilities.includes(capability);
}
function requiredBoundedText(value, label, maximum) {
  if (typeof value !== "string" || !value.trim()) {
    throw new ProposalStoreError("SHADOW_FIELD_REQUIRED", `${label} is required`);
  }
  const normalized = value.trim();
  if (normalized.length > maximum || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(normalized)) {
    throw new ProposalStoreError("SHADOW_FIELD_INVALID", `${label} exceeds its safe bound or contains control characters`);
  }
  return normalized;
}
function optionalBoundedText(value, label, maximum) {
  if (value === void 0 || value === null || value === "") return void 0;
  return requiredBoundedText(value, label, maximum);
}
function optionalIsoTimestamp(value, label) {
  if (value === void 0 || value === null || value === "") return void 0;
  const normalized = requiredBoundedText(value, label, 64);
  const timestamp3 = Date.parse(normalized);
  if (!Number.isFinite(timestamp3)) {
    throw new ProposalStoreError("SHADOW_TIMESTAMP_INVALID", `${label} must be an ISO-8601 timestamp`);
  }
  return new Date(timestamp3).toISOString();
}
function optionalFiniteNumber(value, label, minimum, maximum) {
  if (value === void 0 || value === null) return void 0;
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new ProposalStoreError("SHADOW_NUMBER_INVALID", `${label} must be between ${minimum} and ${maximum}`);
  }
  return value;
}
function safeShadowId(value, kind) {
  const id4 = requiredBoundedText(value, `shadow ${kind} id`, 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(id4)) {
    throw new ProposalStoreError("SHADOW_ID_INVALID", `shadow ${kind} id contains unsupported characters`);
  }
  return id4;
}
function assertShadowAgentResult(value) {
  if (!isShadowAgentResult(value)) {
    throw new ProposalStoreError("SHADOW_AGENT_RESULT_INVALID", `unsupported shadow agent result: ${value}`);
  }
}
function isShadowAgentResult(value) {
  return [
    "proposed",
    "policy_denied",
    "unable_to_propose",
    "stale_conflict",
    "invalid_unsafe_scope_attempt"
  ].includes(value);
}
function assertShadowOutcomeDisposition(value) {
  if (!isShadowOutcomeDisposition(value)) {
    throw new ProposalStoreError("SHADOW_OUTCOME_DISPOSITION_INVALID", `unsupported shadow outcome disposition: ${value}`);
  }
}
function isShadowOutcomeDisposition(value) {
  return ["applied", "rejected_no_action", "stale_conflict"].includes(value);
}
function shadowValuesEqual(left, right) {
  return canonicalJsonDigest(left) === canonicalJsonDigest(right);
}
function countShadowStatus(comparisons, status) {
  return comparisons.filter((item) => item.status === status).length;
}
function emptyShadowStatusCounts() {
  return {
    exact_agreement: 0,
    partial_agreement: 0,
    disagreement: 0,
    human_rejected_no_action: 0,
    agent_policy_denied: 0,
    agent_unable_to_propose: 0,
    stale_conflict: 0,
    unmatched_no_authoritative_outcome: 0,
    invalid_or_unsafe_scope_attempt: 0
  };
}
function distribution(values) {
  if (values.length === 0) return null;
  const ordered = [...values].sort((left, right) => left - right);
  const total = ordered.reduce((sum, value) => sum + value, 0);
  const percentile = (fraction) => ordered[Math.min(ordered.length - 1, Math.ceil(ordered.length * fraction) - 1)];
  return {
    count: ordered.length,
    minimum: ordered[0],
    maximum: ordered.at(-1),
    mean: total / ordered.length,
    median: percentile(0.5),
    p95: percentile(0.95),
    total
  };
}
function suggestedShadowPolicies(comparisons) {
  const byCapability = /* @__PURE__ */ new Map();
  for (const comparison of comparisons) {
    const items = byCapability.get(comparison.capability) ?? [];
    items.push(comparison);
    byCapability.set(comparison.capability, items);
  }
  const suggestions = [];
  for (const [capability, items] of [...byCapability.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const exact = items.filter((item) => item.status === "exact_agreement");
    const values = exact.map((item) => item.amount_value).filter((value) => value !== void 0);
    if (exact.length < 5 || values.length !== exact.length) continue;
    suggestions.push({
      capability,
      suggestion: `Review a bounded policy no higher than the observed exact-agreement maximum (${Math.max(...values)}).`,
      sample_size: exact.length,
      active: false
    });
  }
  return suggestions;
}
function shadowTrustProgression(comparisons, suggestions) {
  const outcomes = comparisons.filter((item) => item.outcome !== void 0).length;
  const comparable = comparisons.filter((item) => item.comparable).length;
  const exact = comparisons.filter((item) => item.status === "exact_agreement").length;
  const currentStage = comparisons.length === 0 ? "observe" : outcomes === 0 ? "compare" : suggestions.length === 0 ? "manual_review" : "suggested_bounded_policy";
  const stageOrder = ["observe", "compare", "manual_review", "suggested_bounded_policy"];
  const currentIndex = stageOrder.indexOf(currentStage);
  const details = {
    observe: `${comparisons.length} task${comparisons.length === 1 ? "" : "s"} observed without source mutation.`,
    compare: `${outcomes} authoritative outcome${outcomes === 1 ? "" : "s"}; ${comparisons.length - outcomes} unmatched.`,
    manual_review: `${comparable} comparable task${comparable === 1 ? "" : "s"}; ${exact} exact agreement${exact === 1 ? "" : "s"}. At least 5 exact numeric examples are required before a bounded-policy suggestion.`,
    suggested_bounded_policy: suggestions.length > 0 ? `${suggestions.length} inactive bounded-policy suggestion${suggestions.length === 1 ? "" : "s"}; a human must review and activate any contract change separately.` : "No policy suggestion is available."
  };
  const labels = ["Observe", "Compare", "Manual review", "Suggested bounded policy"];
  return {
    current_stage: currentStage,
    minimum_policy_sample_size: 5,
    insufficient_sample_size: suggestions.length === 0,
    stages: stageOrder.map((stage, index) => ({
      name: labels[index],
      status: index < currentIndex ? "complete" : index === currentIndex ? "current" : "locked",
      detail: details[stage]
    })),
    automatic_activation: false
  };
}
function safeSqliteFailure(_error, fallback) {
  return fallback;
}

// ../synapsor-runner/packages/proposal-store/src/record-codecs.ts
function rowToProposal(row) {
  if (!isRecord(row)) return void 0;
  const changeSet = parseChangeSet(JSON.parse(String(row.change_set_json)));
  const scope2 = proposalScopeIndex(changeSet);
  if (String(row.tenant_id) !== scope2.id) {
    throw new ProposalStoreError(
      "PROPOSAL_SCOPE_INDEX_MISMATCH",
      `proposal ${String(row.proposal_id)} scope index does not match its immutable change set`
    );
  }
  return {
    proposal_id: String(row.proposal_id),
    proposal_version: Number(row.proposal_version),
    proposal_hash: String(row.proposal_hash),
    action: String(row.action),
    state: String(row.state),
    scope_kind: scope2.kind,
    scope_id: scope2.id,
    tenant_id: String(row.tenant_id),
    principal: row.principal == null ? void 0 : String(row.principal),
    capability: row.capability == null ? void 0 : String(row.capability),
    interaction_id: row.interaction_id == null ? void 0 : String(row.interaction_id),
    tool_call_id: row.tool_call_id == null ? void 0 : String(row.tool_call_id),
    business_object: String(row.business_object),
    object_id: String(row.object_id),
    source_kind: String(row.source_kind),
    source_id: String(row.source_id),
    source_schema: String(row.source_schema),
    source_table: String(row.source_table),
    source_database_mutated: Number(row.source_database_mutated) === 1,
    change_set: changeSet,
    created_at: String(row.created_at),
    updated_at: String(row.updated_at)
  };
}
function rowToEvent(row) {
  if (!isRecord(row)) return void 0;
  return {
    event_id: Number(row.event_id),
    proposal_id: String(row.proposal_id),
    kind: String(row.kind),
    actor: String(row.actor),
    payload: JSON.parse(String(row.payload_json)),
    created_at: String(row.created_at)
  };
}
function rowToApproval(row) {
  if (!isRecord(row)) return void 0;
  const status = String(row.status);
  if (status !== "approved" && status !== "rejected") return void 0;
  return {
    approval_id: Number(row.approval_id),
    proposal_id: String(row.proposal_id),
    proposal_version: Number(row.proposal_version),
    proposal_hash: String(row.proposal_hash),
    approver: String(row.approver),
    status,
    reason: row.reason == null ? void 0 : String(row.reason),
    identity: row.identity_json == null ? void 0 : JSON.parse(String(row.identity_json)),
    decision_hash: row.decision_hash == null ? void 0 : String(row.decision_hash),
    signature: row.signature == null ? void 0 : String(row.signature),
    integrity_hash: row.integrity_hash == null ? void 0 : String(row.integrity_hash),
    freshness_proof_digest: row.freshness_proof_digest == null ? void 0 : String(row.freshness_proof_digest),
    action_boundary_name: row.action_boundary_name == null ? void 0 : String(row.action_boundary_name),
    action_boundary_digest: row.action_boundary_digest == null ? void 0 : String(row.action_boundary_digest),
    created_at: String(row.created_at)
  };
}
function rowToPolicyRecommendation(row) {
  if (!isRecord(row)) return void 0;
  let unsigned;
  try {
    unsigned = JSON.parse(String(row.payload_json));
  } catch {
    throw new ProposalStoreError("POLICY_RECOMMENDATION_TAMPERED", "policy recommendation payload is not valid JSON");
  }
  const recommendation = { ...unsigned, integrity_hash: String(row.integrity_hash) };
  assertPolicyRecommendationShape(recommendation);
  if (recommendation.recommendation_id !== String(row.recommendation_id) || recommendation.tenant_id !== String(row.tenant_id) || recommendation.capability !== String(row.capability) || recommendation.policy !== String(row.policy) || recommendation.base_contract_digest !== String(row.base_contract_digest) || recommendation.status !== String(row.status)) throw new ProposalStoreError("POLICY_RECOMMENDATION_TAMPERED", `policy recommendation ${String(row.recommendation_id)} index fields do not match its signed payload`);
  const expected = canonicalJsonDigest(policyRecommendationUnsigned(recommendation));
  if (recommendation.integrity_hash !== expected) throw new ProposalStoreError("POLICY_RECOMMENDATION_TAMPERED", `policy recommendation ${recommendation.recommendation_id} failed its integrity check`);
  return recommendation;
}
function policyRecommendationUnsigned(recommendation) {
  const { integrity_hash: _integrityHash, ...unsigned } = recommendation;
  return unsigned;
}
function assertPolicyRecommendationShape(recommendation) {
  if (recommendation.schema_version !== "synapsor.policy-recommendation.v1") throw new ProposalStoreError("POLICY_RECOMMENDATION_INVALID", "unsupported policy recommendation schema version");
  if (!/^ptr_[a-f0-9]{20}$/.test(recommendation.recommendation_id)) throw new ProposalStoreError("POLICY_RECOMMENDATION_INVALID", "policy recommendation id is invalid");
  for (const [name4, value] of [["tenant", recommendation.tenant_id], ["capability", recommendation.capability], ["policy", recommendation.policy], ["field", recommendation.field]]) {
    if (!value || value.length > 256) throw new ProposalStoreError("POLICY_RECOMMENDATION_INVALID", `policy recommendation ${name4} is invalid`);
  }
  if (!/^sha256:[a-f0-9]{64}$/.test(recommendation.base_contract_digest)) throw new ProposalStoreError("POLICY_RECOMMENDATION_INVALID", "policy recommendation base digest is invalid");
  if (!/^sha256:[a-f0-9]{64}$/.test(recommendation.integrity_hash)) throw new ProposalStoreError("POLICY_RECOMMENDATION_INVALID", "policy recommendation integrity digest is invalid");
  if (!Number.isFinite(recommendation.current_threshold) || !Number.isFinite(recommendation.proposed_threshold) || !Number.isFinite(recommendation.maximum_increment) || !Number.isFinite(recommendation.absolute_ceiling)) {
    throw new ProposalStoreError("POLICY_RECOMMENDATION_INVALID", "policy recommendation thresholds must be finite numbers");
  }
  if (recommendation.proposed_threshold <= recommendation.current_threshold || recommendation.proposed_threshold - recommendation.current_threshold > recommendation.maximum_increment || recommendation.proposed_threshold > recommendation.absolute_ceiling) {
    throw new ProposalStoreError("POLICY_RECOMMENDATION_INVALID", "policy recommendation exceeds its reviewed increment or ceiling");
  }
  if (!Array.isArray(recommendation.evidence_proposal_ids) || recommendation.evidence_proposal_ids.length === 0 || recommendation.evidence_proposal_ids.length > 1e4) {
    throw new ProposalStoreError("POLICY_RECOMMENDATION_INVALID", "policy recommendation requires bounded proposal evidence");
  }
  if (!isRecord(recommendation.metrics) || !isRecord(recommendation.criteria)) throw new ProposalStoreError("POLICY_RECOMMENDATION_INVALID", "policy recommendation criteria and metrics are required");
  if (!["pending_review", "approved", "rejected", "exported"].includes(recommendation.status)) throw new ProposalStoreError("POLICY_RECOMMENDATION_INVALID", "policy recommendation status is invalid");
}
function assertPolicyRecommendationIdentity(recommendation, input) {
  const proof = input.identity;
  if (!proof.verified || proof.provider === "dev_env") throw new ProposalStoreError("POLICY_RECOMMENDATION_VERIFIED_IDENTITY_REQUIRED", "policy recommendation decisions require a cryptographically verified operator identity");
  if (proof.subject !== input.actor || proof.decision.subject !== input.actor) throw new ProposalStoreError("POLICY_RECOMMENDATION_IDENTITY_MISMATCH", "policy recommendation actor does not match the verified identity");
  if (proof.decision.action !== input.action || proof.decision.proposal_id !== recommendation.recommendation_id || proof.decision.proposal_hash !== recommendation.integrity_hash || proof.decision.proposal_version !== 1) {
    throw new ProposalStoreError("POLICY_RECOMMENDATION_IDENTITY_MISMATCH", "verified operator decision is not bound to this policy recommendation version");
  }
  const { integrity_hash: _integrityHash, ...core } = proof;
  const canonicalCore = JSON.parse(JSON.stringify(core));
  if (proof.integrity_hash !== canonicalJsonDigest(canonicalCore)) throw new ProposalStoreError("POLICY_RECOMMENDATION_IDENTITY_TAMPERED", "verified operator identity proof failed its integrity check");
}
function rowToAttentionEvent(row) {
  if (!isRecord(row)) return void 0;
  const eventType = String(row.event_type);
  const severity = String(row.severity);
  if (!attentionEventTypes.has(eventType) || !["informational", "warning", "critical"].includes(severity)) return void 0;
  let details;
  try {
    const parsed = JSON.parse(String(row.details_json));
    if (!isRecord(parsed)) return void 0;
    details = {};
    for (const [key2, value] of Object.entries(parsed)) {
      if (value !== null && typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") return void 0;
      details[key2] = value;
    }
  } catch {
    return void 0;
  }
  const event = {
    schema_version: "synapsor.attention-event.v1",
    event_id: String(row.event_id),
    event_type: eventType,
    severity,
    occurred_at: String(row.occurred_at),
    environment: String(row.environment),
    ...row.proposal_id == null ? {} : { proposal_id: String(row.proposal_id) },
    ...row.job_id == null ? {} : { job_id: String(row.job_id) },
    ...row.operation_id == null ? {} : { operation_id: String(row.operation_id) },
    ...row.correlation_id == null ? {} : { correlation_id: String(row.correlation_id) },
    ...row.capability == null ? {} : { capability: String(row.capability) },
    ...row.contract_digest == null ? {} : { contract_digest: String(row.contract_digest) },
    ...row.attention_key == null ? {} : { attention_key: String(row.attention_key) },
    attention_required: Number(row.attention_required) === 1,
    immediate_default: Number(row.immediate_default) === 1,
    summary: String(row.summary),
    ...row.approval_source === "human" || row.approval_source === "policy_auto" ? { approval_source: row.approval_source } : {},
    ...row.worker_state == null ? {} : { worker_state: String(row.worker_state) },
    ...row.failure_class == null ? {} : { failure_class: String(row.failure_class) },
    ...row.expires_at == null ? {} : { expires_at: String(row.expires_at) },
    ...row.workbench_path == null ? {} : { workbench_path: String(row.workbench_path) },
    details,
    payload_hash: String(row.payload_hash)
  };
  const { payload_hash: _payloadHash, ...unsigned } = event;
  if (event.payload_hash !== canonicalJsonDigest(unsigned)) {
    throw new ProposalStoreError("ATTENTION_EVENT_CORRUPT", `attention event ${event.event_id} failed its integrity check`);
  }
  return event;
}
function rowToAttentionItem(row) {
  if (!isRecord(row)) return void 0;
  const status = String(row.status);
  const severity = String(row.severity);
  const eventType = String(row.event_type);
  if (!["open", "acknowledged", "resolved", "expired"].includes(status)) return void 0;
  if (!["informational", "warning", "critical"].includes(severity) || !attentionEventTypes.has(eventType)) return void 0;
  let acknowledgementIdentity;
  if (row.acknowledgement_identity_json != null) {
    try {
      const parsed = JSON.parse(String(row.acknowledgement_identity_json));
      if (!isRecord(parsed) || !isRecord(parsed.decision)) return void 0;
      acknowledgementIdentity = parsed;
    } catch {
      return void 0;
    }
  }
  return {
    attention_id: String(row.attention_id),
    attention_key: String(row.attention_key),
    status,
    severity,
    environment: String(row.environment),
    event_type: eventType,
    capability: row.capability == null ? void 0 : String(row.capability),
    contract_digest: row.contract_digest == null ? void 0 : String(row.contract_digest),
    title: String(row.title),
    occurrence_count: Number(row.occurrence_count),
    first_event_id: String(row.first_event_id),
    latest_event_id: String(row.latest_event_id),
    first_seen_at: String(row.first_seen_at),
    last_seen_at: String(row.last_seen_at),
    acknowledged_by: row.acknowledged_by == null ? void 0 : String(row.acknowledged_by),
    acknowledged_at: row.acknowledged_at == null ? void 0 : String(row.acknowledged_at),
    acknowledgement_identity: acknowledgementIdentity,
    resolved_at: row.resolved_at == null ? void 0 : String(row.resolved_at),
    expires_at: row.expires_at == null ? void 0 : String(row.expires_at)
  };
}
function rowToNotificationDelivery(row) {
  if (!isRecord(row)) return void 0;
  const status = String(row.status);
  if (![
    "pending",
    "leased",
    "delivered",
    "retry_wait",
    "dead_letter",
    "suppressed",
    "batched"
  ].includes(status)) return void 0;
  return {
    delivery_id: String(row.delivery_id),
    sink_id: String(row.sink_id),
    event_id: String(row.event_id),
    ...row.attention_id == null ? {} : { attention_id: String(row.attention_id) },
    status,
    attempts: Number(row.attempts),
    max_attempts: Number(row.max_attempts),
    next_attempt_at: String(row.next_attempt_at),
    ...row.lease_owner == null ? {} : { lease_owner: String(row.lease_owner) },
    ...row.lease_id == null ? {} : { lease_id: String(row.lease_id) },
    ...row.lease_expires_at == null ? {} : { lease_expires_at: String(row.lease_expires_at) },
    ...row.last_error_code == null ? {} : { last_error_code: String(row.last_error_code) },
    ...row.external_reference == null ? {} : { external_reference: String(row.external_reference) },
    ...row.delivered_at == null ? {} : { delivered_at: String(row.delivered_at) },
    created_at: String(row.created_at),
    updated_at: String(row.updated_at)
  };
}
function rowToWorkerQueueItem(row) {
  if (!isRecord(row)) return void 0;
  const status = String(row.status);
  if (![
    "queued",
    "leased",
    "retry_wait",
    "completed",
    "dead_letter",
    "discarded",
    "cancelled",
    "blocked",
    "reconciliation_required"
  ].includes(status)) return void 0;
  const executionMode = row.execution_mode == null ? "legacy" : String(row.execution_mode);
  if (executionMode !== "legacy" && executionMode !== "supervised_worker") return void 0;
  const cancellationControlRolePresent = Number(row.cancellation_control_role_present ?? 0) === 1;
  const cancellationControlRole = row.cancellation_control_role;
  if (cancellationControlRolePresent && cancellationControlRole != null && !/^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/.test(String(cancellationControlRole))) return void 0;
  return {
    proposal_id: String(row.proposal_id),
    status,
    execution_mode: executionMode,
    contract_digest: row.contract_digest == null ? void 0 : String(row.contract_digest),
    ...cancellationControlRolePresent ? { cancellation_control_role: cancellationControlRole == null ? null : String(cancellationControlRole) } : {},
    attempts: Number(row.attempts),
    max_attempts: Number(row.max_attempts),
    next_attempt_at: String(row.next_attempt_at),
    lease_owner: row.lease_owner == null ? void 0 : String(row.lease_owner),
    lease_id: row.lease_id == null ? void 0 : String(row.lease_id),
    lease_expires_at: row.lease_expires_at == null ? void 0 : String(row.lease_expires_at),
    last_error_code: row.last_error_code == null ? void 0 : String(row.last_error_code),
    terminal_outcome: row.terminal_outcome == null ? void 0 : String(row.terminal_outcome),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at)
  };
}
function workerLeaseId(proposalId, workerId, attempt, now) {
  const prefixLength = "sha256:".length;
  return `wlease_${canonicalJsonDigest({ proposal_id: proposalId, worker_id: workerId, attempt, now }).slice(prefixLength, prefixLength + 32)}`;
}
function rowToCloudOutboxItem(row) {
  if (!isRecord(row)) return void 0;
  const kind = String(row.kind);
  const status = String(row.status);
  if (!["proposal", "activity", "result"].includes(kind) || !["pending", "leased", "acknowledged", "dead_letter", "reconciliation_required"].includes(status)) return void 0;
  return {
    event_id: String(row.event_id),
    proposal_id: row.proposal_id == null ? void 0 : String(row.proposal_id),
    sequence: Number(row.sequence),
    kind,
    status,
    payload_hash: String(row.payload_hash),
    payload: JSON.parse(String(row.payload_json)),
    attempts: Number(row.attempts),
    max_attempts: Number(row.max_attempts),
    next_attempt_at: String(row.next_attempt_at),
    lease_owner: row.lease_owner == null ? void 0 : String(row.lease_owner),
    lease_expires_at: row.lease_expires_at == null ? void 0 : String(row.lease_expires_at),
    last_error_code: row.last_error_code == null ? void 0 : String(row.last_error_code),
    sent_at: row.sent_at == null ? void 0 : String(row.sent_at),
    acknowledged_at: row.acknowledged_at == null ? void 0 : String(row.acknowledged_at),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at)
  };
}
function rowToCloudGovernanceEvent(row) {
  if (!isRecord(row) || String(row.authority) !== "synapsor_cloud") return void 0;
  return {
    event_id: String(row.event_id),
    proposal_id: String(row.proposal_id),
    cloud_proposal_id: row.cloud_proposal_id == null ? void 0 : String(row.cloud_proposal_id),
    kind: String(row.kind),
    state: String(row.state),
    authority: "synapsor_cloud",
    payload: JSON.parse(String(row.payload_json)),
    integrity_hash: String(row.integrity_hash),
    created_at: String(row.created_at)
  };
}
function rowToReceipt(row) {
  if (!isRecord(row)) return void 0;
  return {
    receipt_id: Number(row.receipt_id),
    writeback_job_id: String(row.writeback_job_id),
    proposal_id: String(row.proposal_id),
    runner_id: String(row.runner_id),
    status: String(row.status),
    idempotency_key: String(row.idempotency_key),
    source_database_mutated: Number(row.source_database_mutated) === 1,
    receipt: parseExecutionReceipt(JSON.parse(String(row.receipt_json))),
    created_at: String(row.created_at),
    tenant_id: row.tenant_id == null ? void 0 : String(row.tenant_id),
    principal: row.principal == null ? void 0 : String(row.principal),
    capability: row.capability == null ? void 0 : String(row.capability),
    business_object: row.business_object == null ? void 0 : String(row.business_object),
    object_id: row.object_id == null ? void 0 : String(row.object_id),
    source_id: row.source_id == null ? void 0 : String(row.source_id),
    source_table: row.source_table == null ? void 0 : String(row.source_table)
  };
}
function rowToWritebackJob(row) {
  if (!isRecord(row)) return void 0;
  let payload;
  try {
    payload = JSON.parse(String(row.job_json));
  } catch {
    throw new ProposalStoreError("WRITEBACK_JOB_CORRUPT", `writeback job ${String(row.writeback_job_id)} payload is not valid JSON`);
  }
  if (!isRecord(payload)) {
    throw new ProposalStoreError("WRITEBACK_JOB_CORRUPT", `writeback job ${String(row.writeback_job_id)} payload is not an object`);
  }
  const handler = payload.schema_version === "synapsor.handler-writeback.v1";
  let normalizedJob;
  if (!handler) {
    try {
      normalizedJob = parseWritebackJob(payload);
    } catch {
      throw new ProposalStoreError("WRITEBACK_JOB_CORRUPT", `writeback job ${String(row.writeback_job_id)} payload is not a supported writeback protocol`);
    }
  }
  const payloadJobId = handler ? payload.writeback_job_id : normalizedJob?.job_id;
  const payloadProposalId = handler ? payload.proposal_id : normalizedJob?.proposal_id;
  const payloadProposalHash = handler ? payload.proposal_hash : normalizedJob?.protocol_version === "5.0" ? normalizedJob.proposal_hash : normalizedJob?.approval_id;
  if (payloadJobId !== String(row.writeback_job_id) || payloadProposalId !== String(row.proposal_id) || payloadProposalHash !== String(row.proposal_hash)) {
    throw new ProposalStoreError("WRITEBACK_JOB_CORRUPT", `writeback job ${String(row.writeback_job_id)} index fields do not match its payload`);
  }
  return {
    writeback_job_id: String(row.writeback_job_id),
    proposal_id: String(row.proposal_id),
    proposal_hash: String(row.proposal_hash),
    status: String(row.status),
    kind: handler ? "app_handler" : "direct_sql",
    payload,
    ...normalizedJob ? { normalized_job: normalizedJob } : {},
    created_at: String(row.created_at),
    updated_at: String(row.updated_at)
  };
}
function rowToStoredReplay(row) {
  if (!isRecord(row)) return void 0;
  let payload;
  try {
    payload = JSON.parse(String(row.payload_json));
  } catch {
    throw new ProposalStoreError("REPLAY_RECORD_CORRUPT", `replay ${String(row.replay_id)} payload is not valid JSON`);
  }
  if (!isRecord(payload) || !isRecord(payload.proposal)) {
    throw new ProposalStoreError("REPLAY_RECORD_CORRUPT", `replay ${String(row.replay_id)} payload is not a supported replay record`);
  }
  const replayId = String(row.replay_id);
  const proposalId = String(row.proposal_id);
  if (payload.replay_id !== replayId || payload.proposal.proposal_id !== proposalId || !Array.isArray(payload.approvals) || !Array.isArray(payload.events) || !Array.isArray(payload.receipts) || !Array.isArray(payload.query_audit) || !Array.isArray(payload.evidence) || typeof payload.generated_at !== "string") {
    throw new ProposalStoreError("REPLAY_RECORD_CORRUPT", `replay ${replayId} index fields do not match its payload`);
  }
  return payload;
}
function rowToWritebackIntent(row) {
  if (!isRecord(row)) return void 0;
  const status = String(row.status);
  if (![
    "intent_recorded",
    "applying",
    "applied",
    "already_applied",
    "conflict",
    "failed",
    "reconciliation_required"
  ].includes(status)) return void 0;
  const operation = String(row.operation);
  if (!isStoredWritebackOperation(operation)) return void 0;
  return {
    intent_id: String(row.intent_id),
    idempotency_key: String(row.idempotency_key),
    writeback_job_id: String(row.writeback_job_id),
    proposal_id: String(row.proposal_id),
    proposal_hash: String(row.proposal_hash),
    runner_id: String(row.runner_id),
    operation,
    status,
    intent: parseWritebackJob(JSON.parse(String(row.intent_json))),
    result: row.result_json == null ? void 0 : parseWritebackResult(JSON.parse(String(row.result_json))),
    reconciliation_reason: row.reconciliation_reason == null ? void 0 : String(row.reconciliation_reason),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at)
  };
}
function isStoredWritebackOperation(operation) {
  return [
    "single_row_update",
    "single_row_insert",
    "single_row_delete",
    "set_update",
    "set_delete",
    "batch_insert",
    "restore_update",
    "remove_insert",
    "restore_insert"
  ].includes(operation);
}
function rowToQueryAudit(row) {
  if (!isRecord(row)) return void 0;
  return {
    audit_id: Number(row.audit_id),
    proposal_id: row.proposal_id == null ? void 0 : String(row.proposal_id),
    evidence_bundle_id: row.evidence_bundle_id == null ? void 0 : String(row.evidence_bundle_id),
    tenant_id: row.tenant_id == null ? void 0 : String(row.tenant_id),
    principal: row.principal == null ? void 0 : String(row.principal),
    capability: row.capability == null ? void 0 : String(row.capability),
    business_object: row.business_object == null ? void 0 : String(row.business_object),
    object_id: row.object_id == null ? void 0 : String(row.object_id),
    primary_key_value: row.primary_key_value == null ? void 0 : String(row.primary_key_value),
    source_id: String(row.source_id),
    query_fingerprint: String(row.query_fingerprint),
    table_name: String(row.table_name),
    row_count: Number(row.row_count),
    payload: JSON.parse(String(row.payload_json)),
    created_at: String(row.created_at)
  };
}
function rowToShadowHumanAction(row) {
  if (!isRecord(row)) return void 0;
  return {
    action_id: Number(row.action_id),
    proposal_id: String(row.proposal_id),
    actor: String(row.actor),
    patch: JSON.parse(String(row.patch_json)),
    notes: row.notes == null ? void 0 : String(row.notes),
    created_at: String(row.created_at)
  };
}
function rowToShadowStudy(row) {
  if (!isRecord(row)) return void 0;
  const status = String(row.status);
  if (status !== "active" && status !== "closed") return void 0;
  const capabilities = JSON.parse(String(row.selected_capabilities_json));
  if (!Array.isArray(capabilities) || capabilities.some((item) => typeof item !== "string")) return void 0;
  return {
    study_id: String(row.study_id),
    name: String(row.name),
    description: row.description == null ? void 0 : String(row.description),
    selected_capabilities: capabilities,
    starts_at: row.starts_at == null ? void 0 : String(row.starts_at),
    ends_at: row.ends_at == null ? void 0 : String(row.ends_at),
    status,
    created_at: String(row.created_at),
    updated_at: String(row.updated_at)
  };
}
function rowToShadowCase(row) {
  if (!isRecord(row)) return void 0;
  const agentResult = String(row.agent_result);
  if (!isShadowAgentResult(agentResult)) return void 0;
  const proposedEffect = row.proposed_effect_json == null ? void 0 : JSON.parse(String(row.proposed_effect_json));
  return {
    case_id: String(row.case_id),
    study_id: String(row.study_id),
    request_id: String(row.request_id),
    proposal_id: row.proposal_id == null ? void 0 : String(row.proposal_id),
    tenant_id: String(row.tenant_id),
    principal: row.principal == null ? void 0 : String(row.principal),
    capability: String(row.capability),
    business_object: String(row.business_object),
    object_id: String(row.object_id),
    evidence_bundle_id: row.evidence_bundle_id == null ? void 0 : String(row.evidence_bundle_id),
    proposed_effect: proposedEffect,
    agent_result: agentResult,
    decision_reason: row.decision_reason == null ? void 0 : String(row.decision_reason),
    risk_score: row.risk_score == null ? void 0 : Number(row.risk_score),
    amount_value: row.amount_value == null ? void 0 : Number(row.amount_value),
    created_at: String(row.created_at)
  };
}
function rowToShadowOutcome(row) {
  if (!isRecord(row)) return void 0;
  const disposition = String(row.disposition);
  if (!isShadowOutcomeDisposition(disposition)) return void 0;
  const actualEffect = row.actual_effect_json == null ? void 0 : JSON.parse(String(row.actual_effect_json));
  return {
    outcome_id: String(row.outcome_id),
    study_id: String(row.study_id),
    request_id: String(row.request_id),
    proposal_id: row.proposal_id == null ? void 0 : String(row.proposal_id),
    tenant_id: String(row.tenant_id),
    business_object: String(row.business_object),
    object_id: String(row.object_id),
    actor: String(row.actor),
    disposition,
    actual_effect: actualEffect,
    occurred_at: String(row.occurred_at),
    source: String(row.source),
    reference: row.reference == null ? void 0 : String(row.reference),
    reason: row.reason == null ? void 0 : String(row.reason),
    created_at: String(row.created_at)
  };
}

// ../synapsor-runner/packages/proposal-store/src/privacy-release.ts
function normalizedExplorePrivacyReleaseClaims(input) {
  const claims = [{
    complement_fingerprints: input.complement_fingerprints,
    release_kind: input.release_kind
  }, ...input.additional_releases ?? []];
  const seen = /* @__PURE__ */ new Set();
  return claims.flatMap((claim) => {
    const fingerprints = [...new Set(claim.complement_fingerprints)].sort();
    if (fingerprints.length === 0) return [];
    const key2 = JSON.stringify([
      claim.release_kind,
      claim.conflict_reason ?? null,
      fingerprints
    ]);
    if (seen.has(key2)) return [];
    seen.add(key2);
    return [{ ...claim, complement_fingerprints: fingerprints }];
  });
}

// ../synapsor-runner/packages/proposal-store/src/sqlite-proposal-methods.ts
var proposalStoreProposalsMethods = {
  createProposal(input) {
    const changeSet = parseChangeSet(input);
    assertNoSecretMaterial(changeSet, "change_set");
    const scope2 = proposalScopeIndex(changeSet);
    const existing = this.getProposal(changeSet.proposal_id);
    if (existing) {
      if (existing.proposal_version !== changeSet.proposal_version || existing.proposal_hash !== changeSet.integrity.proposal_hash) {
        throw new ProposalStoreError(
          "PROPOSAL_IMMUTABILITY_VIOLATION",
          `proposal ${changeSet.proposal_id} already exists with a different version or hash`
        );
      }
      return existing;
    }
    const active = this.findActiveProposal({
      tenant_id: scope2.id,
      action: changeSet.action,
      business_object: changeSet.scope.business_object,
      object_id: changeSet.scope.object_id
    });
    if (active) {
      throw new ProposalStoreError(
        "PROPOSAL_ALREADY_EXISTS",
        `active proposal ${active.proposal_id} is ${active.state} for ${active.business_object}:${active.object_id}`
      );
    }
    const state = stateFromChangeSet(changeSet);
    const now = changeSet.created_at || (/* @__PURE__ */ new Date()).toISOString();
    const insert = this.db.prepare(`
        INSERT INTO proposals (
          proposal_id,
          proposal_version,
          proposal_hash,
          action,
          state,
          tenant_id,
          principal,
          capability,
          interaction_id,
          tool_call_id,
          business_object,
          object_id,
          source_kind,
          source_id,
          source_schema,
          source_table,
          source_database_mutated,
          change_set_json,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
    this.transaction(() => {
      insert.run(
        changeSet.proposal_id,
        changeSet.proposal_version,
        changeSet.integrity.proposal_hash,
        changeSet.action,
        state,
        scope2.id,
        changeSet.principal.id,
        changeSet.action,
        null,
        null,
        changeSet.scope.business_object,
        changeSet.scope.object_id,
        changeSet.source.kind,
        changeSet.source.source_id,
        changeSet.source.schema,
        changeSet.source.table,
        changeSet.source_database_mutated ? 1 : 0,
        JSON.stringify(changeSet),
        now,
        now
      );
      this.appendEvent(changeSet.proposal_id, "proposal_created", changeSet.principal.id, {
        proposal_hash: changeSet.integrity.proposal_hash,
        proposal_version: changeSet.proposal_version,
        source_database_mutated: changeSet.source_database_mutated
      });
      if (changeSet.mode === "shadow") {
        this.attachShadowChangeSetToActiveStudies(changeSet, now);
      }
    });
    const created = this.getProposal(changeSet.proposal_id);
    if (!created) {
      throw new ProposalStoreError("PROPOSAL_CREATE_FAILED", `proposal ${changeSet.proposal_id} was not persisted`);
    }
    return created;
  },
  getProposal(proposalId) {
    const row = this.db.prepare("SELECT * FROM proposals WHERE proposal_id = ?").get(proposalId);
    return rowToProposal(row);
  },
  findActiveProposal(input) {
    const row = this.db.prepare(`
        SELECT * FROM proposals
        WHERE tenant_id = ?
          AND action = ?
          AND business_object = ?
          AND object_id = ?
          AND state IN ('pending_review', 'approved', 'pending_worker')
        ORDER BY created_at DESC
        LIMIT 1
      `).get(input.tenant_id, input.action, input.business_object, input.object_id);
    return rowToProposal(row);
  },
  listProposals(filters) {
    if (typeof filters === "string") filters = { state: filters };
    const query = buildProposalQuery(filters ?? {});
    const rows = this.db.prepare(query.sql).all(...query.params);
    return rows.map((row) => rowToProposal(row)).filter((proposal) => proposal !== void 0);
  },
  countProposals(filters = {}) {
    const query = buildProposalCountQuery(filters);
    const row = this.db.prepare(query.sql).get(...query.params);
    return isRecord(row) ? Number(row.count ?? 0) : 0;
  },
  listEvidenceBundles(filters = {}) {
    const query = buildEvidenceQuery(filters);
    const rows = this.db.prepare(query.sql).all(...query.params);
    return rows.map((row) => this.rowToEvidenceBundle(row)).filter((evidence) => evidence !== void 0);
  },
  listQueryAudit(filters = {}) {
    const query = buildQueryAuditQuery(filters);
    const rows = this.db.prepare(query.sql).all(...query.params);
    return rows.map(rowToQueryAudit).filter((record2) => record2 !== void 0);
  },
  getQueryAudit(auditId) {
    return rowToQueryAudit(this.db.prepare("SELECT * FROM query_audit WHERE audit_id = ?").get(auditId));
  },
  claimExplorePrivacyRelease(input) {
    const claims = normalizedExplorePrivacyReleaseClaims(input);
    if (claims.length === 0) return { allowed: true };
    return this.transaction(() => {
      for (const claim of claims) {
        const opposite = claim.release_kind === "scalar_total" ? "suppressed_grouping" : "scalar_total";
        const placeholders = claim.complement_fingerprints.map(() => "?").join(", ");
        const conflict = this.db.prepare(`
            SELECT release_kind
            FROM explore_privacy_releases
            WHERE scope_fingerprint = ?
              AND release_kind = ?
              AND complement_fingerprint IN (${placeholders})
            LIMIT 1
          `).get(input.scope_fingerprint, opposite, ...claim.complement_fingerprints);
        if (isRecord(conflict)) {
          return {
            allowed: false,
            conflicting_release_kind: opposite,
            ...claim.conflict_reason ? { conflicting_release_reason: claim.conflict_reason } : {}
          };
        }
      }
      const insert = this.db.prepare(`
          INSERT OR IGNORE INTO explore_privacy_releases (
            scope_fingerprint,
            complement_fingerprint,
            release_kind,
            query_fingerprint,
            boundary_digest,
            created_at
          ) VALUES (?, ?, ?, ?, ?, ?)
        `);
      const now = (/* @__PURE__ */ new Date()).toISOString();
      for (const claim of claims) {
        for (const fingerprint of claim.complement_fingerprints) {
          insert.run(
            input.scope_fingerprint,
            fingerprint,
            claim.release_kind,
            input.query_fingerprint,
            input.boundary_digest,
            now
          );
        }
      }
      return { allowed: true };
    });
  },
  claimExploreBudgetReservation(input) {
    const now = parseBudgetTimestamp(input.now, "reservation time");
    assertBudgetReservationInput(input);
    return this.transaction(() => {
      this.db.prepare("DELETE FROM explore_budget_reservations WHERE created_at < ?").run(new Date(now - EXPLORE_BUDGET_RETENTION_MS).toISOString());
      const usage = exploreBudgetUsage(this.db, input, now);
      const variants = exploreDifferencingVariants(this.db, input, now);
      const variantAlreadyCounted = variants.has(input.variant_fingerprint);
      try {
        enforcePrivacyBudgets({
          limits: input.limits,
          snapshot: {
            query_count: usage.query_count,
            queries_last_minute: usage.queries_last_minute,
            extracted_cells: usage.extracted_cells,
            differencing_attempts: variantAlreadyCounted ? Math.max(0, variants.size - 1) : variants.size
          },
          estimated_response_cells: input.estimated_response_cells,
          aggregate: input.requires_differencing
        });
      } catch (error) {
        if (!(error instanceof PrivacyBoundaryError) || !isExploreBudgetErrorCode(error.code)) {
          throw error;
        }
        return {
          allowed: false,
          code: error.code,
          message: error.message,
          usage: {
            ...usage,
            differencing_attempts: variants.size
          }
        };
      }
      this.db.prepare(`
          INSERT INTO explore_budget_reservations (
            reservation_id,
            scope_fingerprint,
            resource_id,
            variant_fingerprint,
            requires_differencing,
            differencing_counted,
            reserved_cells,
            accounted_cells,
            status,
            created_at,
            completed_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, NULL)
        `).run(
        input.reservation_id,
        input.scope_fingerprint,
        input.resource_id,
        input.variant_fingerprint,
        input.requires_differencing ? 1 : 0,
        input.requires_differencing ? 1 : 0,
        input.estimated_response_cells,
        input.estimated_response_cells,
        input.now
      );
      return {
        allowed: true,
        usage_after_reservation: {
          query_count: usage.query_count + 1,
          queries_last_minute: usage.queries_last_minute + 1,
          extracted_cells: usage.extracted_cells + input.estimated_response_cells,
          differencing_attempts: variants.size + (input.requires_differencing && !variantAlreadyCounted ? 1 : 0)
        },
        variant_already_counted: variantAlreadyCounted
      };
    });
  },
  completeExploreBudgetReservation(input) {
    parseBudgetTimestamp(input.completed_at, "completion time");
    if (!Number.isSafeInteger(input.returned_cells) || input.returned_cells < 0) {
      throw new ProposalStoreError(
        "EXPLORE_BUDGET_RESERVATION_INVALID",
        "Explore returned-cell accounting must be a non-negative safe integer."
      );
    }
    return this.transaction(() => {
      const row = this.db.prepare(`
          SELECT status, requires_differencing, reserved_cells, accounted_cells
          FROM explore_budget_reservations
          WHERE reservation_id = ?
        `).get(input.reservation_id);
      if (!isRecord(row)) return { completed: false, reason: "reservation_missing" };
      const status = String(row.status);
      if (status !== "pending") {
        const sameOutcome = status === "released" === input.result_released;
        const sameCells = Number(row.accounted_cells) === (input.result_released ? input.returned_cells : 0);
        return sameOutcome && sameCells ? { completed: true } : { completed: false, reason: "reservation_already_finalized" };
      }
      const reservedCells = Number(row.reserved_cells);
      if (input.result_released && input.returned_cells > reservedCells) {
        this.db.prepare(`
            UPDATE explore_budget_reservations
            SET status = 'not_released', differencing_counted = 0,
                accounted_cells = 0, completed_at = ?
            WHERE reservation_id = ? AND status = 'pending'
          `).run(input.completed_at, input.reservation_id);
        return { completed: false, reason: "response_exceeded_reservation" };
      }
      this.db.prepare(`
          UPDATE explore_budget_reservations
          SET status = ?, differencing_counted = ?, accounted_cells = ?, completed_at = ?
          WHERE reservation_id = ? AND status = 'pending'
        `).run(
        input.result_released ? "released" : "not_released",
        input.result_released && Number(row.requires_differencing) === 1 ? 1 : 0,
        input.result_released ? input.returned_cells : 0,
        input.completed_at,
        input.reservation_id
      );
      return { completed: true };
    });
  },
  listReceipts(filters = {}) {
    const query = buildReceiptQuery(filters);
    const rows = this.db.prepare(query.sql).all(...query.params);
    return rows.map(rowToReceipt).filter((receipt2) => receipt2 !== void 0);
  },
  getReceipt(receiptId) {
    return rowToReceipt(this.db.prepare("SELECT * FROM writeback_receipts WHERE receipt_id = ?").get(receiptId));
  },
  getReplayByReplayId(replayId) {
    const prefix = "replay_";
    const proposalId = replayId.startsWith(prefix) ? replayId.slice(prefix.length) : replayId;
    return this.replay(proposalId);
  },
  getStoredReplay(replayId) {
    const row = this.db.prepare("SELECT * FROM replay_records WHERE replay_id = ?").get(replayId);
    return rowToStoredReplay(row);
  },
  getStoredReplayForProposal(proposalId) {
    const row = this.db.prepare(`
        SELECT * FROM replay_records
        WHERE proposal_id = ?
        ORDER BY created_at DESC, replay_id DESC
        LIMIT 1
      `).get(proposalId);
    return rowToStoredReplay(row);
  },
  proposalIdForEvidence(evidenceBundleId) {
    const evidence = this.getEvidenceBundle(evidenceBundleId);
    if (evidence?.proposal_id) return evidence.proposal_id;
    const row = this.db.prepare("SELECT proposal_id FROM query_audit WHERE evidence_bundle_id = ? AND proposal_id IS NOT NULL ORDER BY created_at DESC LIMIT 1").get(evidenceBundleId);
    return isRecord(row) && row.proposal_id != null ? String(row.proposal_id) : void 0;
  },
  recordFreshnessProof(input) {
    const proof = parseFreshnessProof(input);
    const proposal = this.requireProposal(proof.proposal_id);
    assertProposalIdentity(proposal, proof.proposal_hash, proof.proposal_version);
    const authority2 = proposalFreshnessAuthority(proposal);
    if (!authority2) {
      throw new ProposalStoreError(
        "FRESHNESS_NOT_REQUIRED",
        `proposal ${proof.proposal_id} has no reviewed freshness authority`
      );
    }
    if (proof.dependency_set_digest !== authority2.dependency_set_digest) {
      throw new ProposalStoreError(
        "FRESHNESS_PROOF_AUTHORITY_MISMATCH",
        `freshness proof does not match proposal ${proof.proposal_id}`
      );
    }
    const now = (/* @__PURE__ */ new Date()).toISOString();
    this.transaction(() => {
      this.appendEvent(proof.proposal_id, "proposal_freshness_checked", "runner", { proof });
      if (proof.result === "stale") {
        const current = this.requireProposal(proof.proposal_id);
        if (current.state === "pending_review" || current.state === "approved" || current.state === "pending_worker") {
          this.db.prepare("UPDATE proposals SET state = ?, updated_at = ? WHERE proposal_id = ?").run("conflict", now, proof.proposal_id);
          this.appendEvent(proof.proposal_id, "proposal_conflict", "runner", {
            reason: "freshness_stale",
            safe_code: proof.safe_code,
            proof_digest: proof.proof_digest
          });
        }
      }
    });
    return proof;
  },
  latestFreshnessProof(proposalId) {
    this.requireProposal(proposalId);
    const row = this.db.prepare(`
        SELECT payload_json
        FROM proposal_events
        WHERE proposal_id = ? AND kind = 'proposal_freshness_checked'
        ORDER BY event_id DESC
        LIMIT 1
      `).get(proposalId);
    if (!isRecord(row)) return void 0;
    try {
      const payload = JSON.parse(String(row.payload_json));
      return parseFreshnessProof(payload.proof);
    } catch {
      throw new ProposalStoreError(
        "FRESHNESS_PROOF_TAMPERED",
        `stored freshness proof for proposal ${proposalId} failed integrity validation`
      );
    }
  },
  recordFreshnessApprovalBlocked(proposalId, input) {
    this.requireProposal(proposalId);
    const proof = this.latestFreshnessProof(proposalId);
    if (!proof || proof.proof_digest !== input.proof_digest || proof.result === "fresh") {
      throw new ProposalStoreError(
        "FRESHNESS_BLOCK_RECORD_INVALID",
        `freshness block for proposal ${proposalId} does not match its latest non-fresh proof`
      );
    }
    this.appendEvent(proposalId, "proposal_approval_blocked_freshness", input.actor, {
      proof_digest: proof.proof_digest,
      safe_code: input.safe_code,
      result: proof.result
    });
  },
  approveProposal(proposalId, options) {
    const proposal = this.requireProposal(proposalId);
    assertWritebackAllowed(proposal, "approved");
    assertProposalIdentity(proposal, options.proposal_hash, options.proposal_version);
    if (proposal.state !== "pending_review") {
      throw new ProposalStoreError("PROPOSAL_NOT_PENDING_REVIEW", `proposal ${proposalId} is ${proposal.state}`);
    }
    assertOperatorDecision(proposal, "approve", options.approver, options.identity, options.require_verified_identity === true);
    const now = (/* @__PURE__ */ new Date()).toISOString();
    this.transaction(() => {
      const current = this.requireProposal(proposalId);
      if (current.state !== "pending_review") {
        throw new ProposalStoreError("PROPOSAL_NOT_PENDING_REVIEW", `proposal ${proposalId} is ${current.state}`);
      }
      const existing = this.db.prepare(`
          SELECT status FROM approvals WHERE proposal_id = ? AND approver = ? ORDER BY approval_id DESC LIMIT 1
        `).get(proposalId, options.approver);
      if (isRecord(existing)) {
        throw new ProposalStoreError("APPROVER_ALREADY_COUNTED", `operator ${options.approver} already recorded a decision for proposal ${proposalId}`);
      }
      this.assertApprovalFreshness(current, options.freshness_proof_digest, now);
      this.db.prepare(`
          INSERT INTO approvals (
            proposal_id, proposal_version, proposal_hash, approver, status, reason,
            identity_json, decision_hash, signature, integrity_hash, freshness_proof_digest, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
        proposalId,
        options.proposal_version,
        options.proposal_hash,
        options.approver,
        "approved",
        options.reason ?? null,
        options.identity ? JSON.stringify(options.identity) : null,
        options.identity?.decision_hash ?? null,
        options.identity?.signature ?? null,
        options.identity?.integrity_hash ?? null,
        options.freshness_proof_digest ?? null,
        now
      );
      const progress = this.approvalProgress(proposalId);
      const complete = progress.approved >= progress.required;
      if (complete) {
        this.db.prepare("UPDATE proposals SET state = ?, updated_at = ? WHERE proposal_id = ?").run("approved", now, proposalId);
      }
      this.appendEvent(proposalId, complete ? "proposal_approved" : "proposal_approval_recorded", options.approver, {
        proposal_hash: options.proposal_hash,
        proposal_version: options.proposal_version,
        reason: options.reason ?? null,
        identity: publicIdentitySummary(options.identity),
        freshness_proof_digest: options.freshness_proof_digest ?? null,
        approvals: progress.approved,
        required_approvals: progress.required,
        remaining_approvals: progress.remaining
      });
    });
    return this.requireProposal(proposalId);
  },
  approveProposalByPolicy(proposalId, options) {
    const actor = `policy:${options.policy}`;
    const now = options.now ?? (/* @__PURE__ */ new Date()).toISOString();
    const window2 = utcDayWindow(now);
    const trippedLimits = [];
    const nearLimits = [];
    const boundaryTrippedLimits = [];
    const boundaryNearLimits = [];
    let quorumDeferred = false;
    this.transaction(() => {
      const proposal = this.requireProposal(proposalId);
      assertWritebackAllowed(proposal, "approved by policy");
      assertProposalIdentity(proposal, options.proposal_hash, options.proposal_version);
      if (proposal.state !== "pending_review") {
        throw new ProposalStoreError("PROPOSAL_NOT_PENDING_REVIEW", `proposal ${proposalId} is ${proposal.state}`);
      }
      const requiredApprovals = requiredApprovalCount(proposal);
      const semanticAutomaticPolicy = proposal.change_set.schema_version === protocolVersions.changeSetV4 && proposal.change_set.approval.mode === "policy" && proposal.change_set.semantic_authority.proof.approval_path === "automatic_eligible";
      if (requiredApprovals > 1 && !semanticAutomaticPolicy) {
        quorumDeferred = true;
        this.appendEvent(proposalId, "policy_auto_approval_deferred", actor, {
          policy: options.policy,
          fallback: "human_review",
          reason: "multi_reviewer_quorum_requires_verified_human_approvals",
          approvals: 0,
          required_approvals: requiredApprovals
        });
        return;
      }
      for (const limit of options.limits ?? []) {
        const scope2 = limit.scope ?? "tenant_policy";
        const rows = this.db.prepare(`
            SELECT p.change_set_json
            FROM approvals a
            JOIN proposals p ON p.proposal_id = a.proposal_id
            WHERE a.approver = ?
              AND a.status = 'approved'
              AND p.tenant_id = ?
              AND a.created_at >= ?
              AND a.created_at < ?
              ${scope2 === "tenant_policy_object" ? "AND p.business_object = ? AND p.object_id = ?" : ""}
          `).all(
          actor,
          proposal.tenant_id,
          window2.start,
          window2.end,
          ...scope2 === "tenant_policy_object" ? [proposal.business_object, proposal.object_id] : []
        );
        if (limit.kind === "count") {
          const projected2 = rows.length + 1;
          if (projected2 > limit.max) {
            trippedLimits.push({
              ...limit,
              scope: scope2,
              observed: rows.length,
              proposed: 1,
              projected: projected2,
              window_start: window2.start,
              window_end: window2.end,
              reason: `${scope2} daily auto-approval count ${projected2} exceeds ${limit.max}`
            });
          } else if (projected2 / limit.max >= 0.8) {
            nearLimits.push({
              ...limit,
              scope: scope2,
              observed: rows.length,
              proposed: 1,
              projected: projected2,
              window_start: window2.start,
              window_end: window2.end,
              reason: `${scope2} daily auto-approval count ${projected2} is approaching ${limit.max}`
            });
          }
          continue;
        }
        const field = limit.field;
        const proposed = field ? proposal.change_set.patch[field] : void 0;
        let observed = 0;
        let invalidHistory = false;
        for (const row of rows) {
          if (!isRecord(row)) {
            invalidHistory = true;
            continue;
          }
          try {
            const historical = parseChangeSet(JSON.parse(String(row.change_set_json)));
            const value = field ? historical.patch[field] : void 0;
            if (typeof value !== "number" || !Number.isSafeInteger(value)) invalidHistory = true;
            else observed += Math.abs(value);
          } catch {
            invalidHistory = true;
          }
        }
        const proposedNumber = typeof proposed === "number" && Number.isSafeInteger(proposed) ? Math.abs(proposed) : 0;
        const projected = observed + proposedNumber;
        if (!field || invalidHistory || typeof proposed !== "number" || !Number.isSafeInteger(proposed) || projected > limit.max) {
          trippedLimits.push({
            ...limit,
            scope: scope2,
            observed,
            proposed: proposedNumber,
            projected,
            window_start: window2.start,
            window_end: window2.end,
            reason: invalidHistory || !field || typeof proposed !== "number" || !Number.isSafeInteger(proposed) ? `${scope2} daily auto-approval total could not be verified safely${field ? ` for ${field}` : ""}` : `${scope2} daily auto-approval total ${projected} for ${field} exceeds ${limit.max}`
          });
        } else if (projected / limit.max >= 0.8) {
          nearLimits.push({
            ...limit,
            scope: scope2,
            observed,
            proposed: proposedNumber,
            projected,
            window_start: window2.start,
            window_end: window2.end,
            reason: `${scope2} daily auto-approval total is approaching its reviewed maximum`
          });
        }
      }
      if (options.action_boundary) {
        const boundaryLimits = evaluateActionBoundaryApprovalLimits(
          this.db,
          proposal,
          options.action_boundary,
          now
        );
        boundaryTrippedLimits.push(...boundaryLimits.tripped);
        boundaryNearLimits.push(...boundaryLimits.near);
      }
      if (trippedLimits.length > 0 || boundaryTrippedLimits.length > 0) {
        this.appendEvent(proposalId, "policy_auto_approval_deferred", actor, {
          policy: options.policy,
          fallback: "human_review",
          tripped_limits: [...trippedLimits, ...boundaryTrippedLimits],
          ...options.action_boundary ? {
            action_boundary: {
              name: options.action_boundary.name,
              digest: options.action_boundary.digest
            }
          } : {}
        });
        return;
      }
      this.assertApprovalFreshness(proposal, options.freshness_proof_digest, now);
      this.db.prepare("UPDATE proposals SET state = ?, updated_at = ? WHERE proposal_id = ?").run("approved", now, proposalId);
      this.db.prepare(`
          INSERT INTO approvals (
            proposal_id, proposal_version, proposal_hash, approver, status, reason,
            freshness_proof_digest, action_boundary_name, action_boundary_digest, created_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
        proposalId,
        options.proposal_version,
        options.proposal_hash,
        actor,
        "approved",
        options.reason,
        options.freshness_proof_digest ?? null,
        options.action_boundary?.name ?? null,
        options.action_boundary?.digest ?? null,
        now
      );
      this.appendEvent(proposalId, "proposal_approved", actor, {
        proposal_hash: options.proposal_hash,
        proposal_version: options.proposal_version,
        reason: options.reason,
        policy: options.policy,
        aggregate_limits: options.limits ?? [],
        action_boundary: options.action_boundary ? {
          name: options.action_boundary.name,
          digest: options.action_boundary.digest,
          shared_limits: options.action_boundary.limits
        } : null,
        freshness_proof_digest: options.freshness_proof_digest ?? null
      });
      for (const near of nearLimits) {
        this.appendEvent(proposalId, "policy_limit_near", actor, {
          policy: options.policy,
          kind: near.kind,
          scope: near.scope,
          observed: near.observed,
          proposed: near.proposed,
          projected: near.projected,
          max: near.max,
          window_start: near.window_start,
          window_end: near.window_end
        });
      }
      for (const near of boundaryNearLimits) {
        this.appendEvent(proposalId, "action_boundary_limit_near", actor, {
          action_boundary_name: options.action_boundary?.name ?? null,
          action_boundary_digest: options.action_boundary?.digest ?? null,
          limit_id: near.id,
          kind: near.kind,
          scope: near.scope,
          observed: near.observed,
          proposed: near.proposed,
          projected: near.projected,
          maximum: near.maximum,
          window_start: near.window_start,
          window_end: near.window_end
        });
      }
    });
    return {
      proposal: this.requireProposal(proposalId),
      approved: !quorumDeferred && trippedLimits.length === 0 && boundaryTrippedLimits.length === 0,
      policy: options.policy,
      tripped_limits: [...trippedLimits, ...boundaryTrippedLimits]
    };
  },
  rejectProposal(proposalId, options) {
    const proposal = this.requireProposal(proposalId);
    assertProposalIdentity(proposal, options.proposal_hash, options.proposal_version);
    if (proposal.state !== "pending_review" && proposal.state !== "approved") {
      throw new ProposalStoreError("PROPOSAL_NOT_REJECTABLE", `proposal ${proposalId} is ${proposal.state}`);
    }
    assertOperatorDecision(proposal, "reject", options.actor, options.identity, options.require_verified_identity === true);
    const now = (/* @__PURE__ */ new Date()).toISOString();
    this.transaction(() => {
      this.db.prepare("UPDATE proposals SET state = ?, updated_at = ? WHERE proposal_id = ?").run("rejected", now, proposalId);
      this.db.prepare(`
          INSERT INTO approvals (
            proposal_id, proposal_version, proposal_hash, approver, status, reason,
            identity_json, decision_hash, signature, integrity_hash, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
        proposalId,
        options.proposal_version,
        options.proposal_hash,
        options.actor,
        "rejected",
        options.reason,
        options.identity ? JSON.stringify(options.identity) : null,
        options.identity?.decision_hash ?? null,
        options.identity?.signature ?? null,
        options.identity?.integrity_hash ?? null,
        now
      );
      this.appendEvent(proposalId, "proposal_rejected", options.actor, {
        proposal_hash: options.proposal_hash,
        proposal_version: options.proposal_version,
        reason: options.reason,
        identity: publicIdentitySummary(options.identity)
      });
    });
    return this.requireProposal(proposalId);
  },
  approvals(proposalId) {
    return this.db.prepare("SELECT * FROM approvals WHERE proposal_id = ? ORDER BY approval_id ASC").all(proposalId).map(rowToApproval).filter((approval) => approval !== void 0);
  },
  approvalProgress(proposalId) {
    const proposal = this.requireProposal(proposalId);
    const required = requiredApprovalCount(proposal);
    const row = this.db.prepare(`
        SELECT
          COUNT(DISTINCT CASE WHEN status = 'approved' THEN approver END) AS approved,
          MAX(CASE WHEN status = 'rejected' THEN 1 ELSE 0 END) AS rejected
        FROM approvals
        WHERE proposal_id = ?
      `).get(proposalId);
    const approved = isRecord(row) ? Number(row.approved ?? 0) : 0;
    const rejected = proposal.state === "rejected" || isRecord(row) && Number(row.rejected ?? 0) === 1;
    return {
      approved,
      required,
      remaining: Math.max(0, required - approved),
      rejected,
      complete: !rejected && approved >= required
    };
  },
  recordOperatorAuthorization(proposalId, identity, requireVerifiedIdentity = false) {
    const proposal = this.requireProposal(proposalId);
    assertOperatorDecision(proposal, "apply", identity.subject, identity, requireVerifiedIdentity);
    this.appendEvent(proposalId, "writeback_authorized", identity.subject, {
      identity: publicIdentitySummary(identity),
      decision_hash: identity.decision_hash,
      signature: identity.signature,
      integrity_hash: identity.integrity_hash
    });
  },
  markPendingWorker(proposalId, proposalHash, proposalVersion) {
    const proposal = this.requireProposal(proposalId);
    assertWritebackAllowed(proposal, "moved to pending worker");
    assertProposalIdentity(proposal, proposalHash, proposalVersion);
    if (proposal.state !== "approved") {
      throw new ProposalStoreError("PROPOSAL_NOT_APPROVED", `proposal ${proposalId} is ${proposal.state}`);
    }
    this.setState(proposalId, "pending_worker", "runner", { proposal_hash: proposalHash, proposal_version: proposalVersion });
    return this.requireProposal(proposalId);
  }
};
var EXPLORE_BUDGET_WINDOW_MS = 24 * 60 * 60 * 1e3;
var EXPLORE_BUDGET_RETENTION_MS = 30 * EXPLORE_BUDGET_WINDOW_MS;
function parseBudgetTimestamp(value, label) {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new ProposalStoreError(
      "EXPLORE_BUDGET_RESERVATION_INVALID",
      `Explore ${label} must be a valid ISO timestamp.`
    );
  }
  return parsed;
}
function assertBudgetReservationInput(input) {
  const limits = Object.values(input.limits);
  if (!input.reservation_id || !input.scope_fingerprint.startsWith("sha256:") || !input.variant_fingerprint.startsWith("sha256:") || !input.resource_id || !Number.isSafeInteger(input.estimated_response_cells) || input.estimated_response_cells < 0 || limits.some((value) => !Number.isSafeInteger(value) || value < 1)) {
    throw new ProposalStoreError(
      "EXPLORE_BUDGET_RESERVATION_INVALID",
      "Explore budget reservation input is malformed."
    );
  }
}
function isExploreBudgetErrorCode(code) {
  return code === "QUERY_BUDGET_EXHAUSTED" || code === "RATE_LIMIT_EXHAUSTED" || code === "EXTRACTION_BUDGET_EXHAUSTED" || code === "DIFFERENCING_BUDGET_EXHAUSTED";
}
function exploreBudgetUsage(db, input, now) {
  const windowStart = now - EXPLORE_BUDGET_WINDOW_MS;
  const minuteStart = now - 6e4;
  let queryCount = 0;
  let queriesLastMinute = 0;
  let extractedCells = 0;
  const reservations = db.prepare(`
    SELECT accounted_cells, created_at
    FROM explore_budget_reservations
    WHERE scope_fingerprint = ? AND created_at >= ? AND created_at <= ?
  `).all(input.scope_fingerprint, new Date(windowStart).toISOString(), input.now);
  for (const row of reservations) {
    if (!isRecord(row)) continue;
    queryCount += 1;
    if (Date.parse(String(row.created_at)) >= minuteStart) queriesLastMinute += 1;
    extractedCells += Math.max(0, Number(row.accounted_cells) || 0);
  }
  for (const audit of legacyExploreBudgetAudits(db, input, windowStart, now)) {
    queryCount += 1;
    if (audit.recordedAt >= minuteStart) queriesLastMinute += 1;
    extractedCells += audit.returnedCells;
  }
  return {
    query_count: queryCount,
    queries_last_minute: queriesLastMinute,
    extracted_cells: extractedCells,
    differencing_attempts: 0
  };
}
function exploreDifferencingVariants(db, input, now) {
  const windowStart = now - EXPLORE_BUDGET_WINDOW_MS;
  const variants = /* @__PURE__ */ new Set();
  const rows = db.prepare(`
    SELECT variant_fingerprint
    FROM explore_budget_reservations
    WHERE scope_fingerprint = ? AND resource_id = ?
      AND created_at >= ? AND created_at <= ? AND differencing_counted = 1
  `).all(
    input.scope_fingerprint,
    input.resource_id,
    new Date(windowStart).toISOString(),
    input.now
  );
  for (const row of rows) {
    if (isRecord(row) && typeof row.variant_fingerprint === "string") {
      variants.add(row.variant_fingerprint);
    }
  }
  for (const audit of legacyExploreBudgetAudits(db, input, windowStart, now)) {
    if (audit.informationBearingAggregate && audit.resourceId === input.resource_id) {
      variants.add(audit.variantFingerprint);
    }
  }
  return variants;
}
function legacyExploreBudgetAudits(db, input, windowStart, now) {
  const legacyFingerprints = new Set(input.legacy_session_fingerprints);
  const results = [];
  const rows = db.prepare("SELECT query_fingerprint, payload_json, created_at FROM query_audit").all();
  for (const row of rows) {
    if (!isRecord(row) || typeof row.payload_json !== "string") continue;
    let payload;
    try {
      const parsed = JSON.parse(row.payload_json);
      if (!isRecord(parsed)) continue;
      payload = parsed;
    } catch {
      continue;
    }
    if (typeof payload.budget_reservation_id === "string") continue;
    const inScope = payload.budget_scope_fingerprint === input.scope_fingerprint || typeof payload.session_fingerprint === "string" && legacyFingerprints.has(payload.session_fingerprint);
    if (!inScope) continue;
    const recordedAt = Date.parse(
      typeof payload.recorded_at === "string" ? payload.recorded_at : String(row.created_at)
    );
    if (!Number.isFinite(recordedAt) || recordedAt < windowStart || recordedAt > now) continue;
    if (payload.source_execution_started === false || payload.source_query_executed === false) continue;
    const normalizedPlan = isRecord(payload.normalized_plan) ? payload.normalized_plan : void 0;
    const status = payload.status;
    results.push({
      queryFingerprint: String(row.query_fingerprint),
      variantFingerprint: typeof payload.differencing_variant === "string" ? payload.differencing_variant : typeof payload.argument_fingerprint === "string" ? payload.argument_fingerprint : String(row.query_fingerprint),
      recordedAt,
      returnedCells: typeof payload.returned_cells === "number" ? Math.max(0, payload.returned_cells) : 0,
      ...typeof normalizedPlan?.resource === "string" ? { resourceId: normalizedPlan.resource } : typeof payload.capability === "string" ? { resourceId: payload.capability } : {},
      informationBearingAggregate: normalizedPlan?.kind === "aggregate" && (status === "ok" || status === "empty" || status === "fully_suppressed" || status === "incomplete_comparison") || payload.protected_read_version === "synapsor.protected-read.v1" && payload.mode === "aggregate" && status === "returned"
    });
  }
  return results;
}
function evaluateActionBoundaryApprovalLimits(db, proposal, boundary, now) {
  if (!/^[A-Za-z][A-Za-z0-9_.-]{0,79}$/.test(boundary.name) || !/^sha256:[a-f0-9]{64}$/.test(boundary.digest) || !Array.isArray(boundary.limits)) {
    throw new ProposalStoreError(
      "ACTION_BOUNDARY_LIMIT_INVALID",
      "Action Boundary approval accounting requires an exact reviewed boundary name, digest, and limit set."
    );
  }
  const nowMs = Date.parse(now);
  if (!Number.isFinite(nowMs)) {
    throw new ProposalStoreError("ACTION_BOUNDARY_LIMIT_TIME_INVALID", "Action Boundary approval accounting requires a valid time.");
  }
  const tripped = [];
  const near = [];
  const currentCapability = proposal.capability ?? proposal.action;
  for (const limit of boundary.limits) {
    assertActionBoundaryLimit(limit);
    if (limit.capability && limit.capability !== currentCapability) continue;
    const windowStart = new Date(nowMs - limit.window_seconds * 1e3).toISOString();
    const windowEnd = new Date(nowMs).toISOString();
    const proposedTotal = limit.kind === "total" ? actionBoundaryTotalValue(proposal, limit.field) : void 0;
    const base = {
      ...limit,
      observed: 0,
      proposed: limit.kind === "count" ? 1 : proposedTotal ?? 0,
      projected: 0,
      window_start: windowStart,
      window_end: windowEnd,
      reason: ""
    };
    if (limit.scope === "tenant_principal" && !proposal.principal) {
      tripped.push({
        ...base,
        projected: base.proposed,
        reason: `${limit.id} could not verify tenant/principal scope because the proposal has no trusted principal`
      });
      continue;
    }
    const clauses = [
      "a.action_boundary_name = ?",
      "a.status = 'approved'",
      "a.created_at >= ?",
      "a.created_at <= ?"
    ];
    const params = [boundary.name, windowStart, windowEnd];
    if (limit.capability) {
      clauses.push("COALESCE(p.capability, p.action) = ?");
      params.push(limit.capability);
    }
    if (limit.scope === "capability" && !limit.capability) {
      clauses.push("COALESCE(p.capability, p.action) = ?");
      params.push(currentCapability);
    }
    if (limit.scope === "tenant" || limit.scope === "tenant_principal" || limit.scope === "tenant_object") {
      clauses.push("p.tenant_id = ?");
      params.push(proposal.tenant_id);
    }
    if (limit.scope === "tenant_principal") {
      clauses.push("p.principal = ?");
      params.push(proposal.principal);
    }
    if (limit.scope === "tenant_object") {
      clauses.push("p.business_object = ?", "p.object_id = ?");
      params.push(proposal.business_object, proposal.object_id);
    }
    const rows = db.prepare(`
      SELECT p.change_set_json
      FROM approvals a
      JOIN proposals p ON p.proposal_id = a.proposal_id
      WHERE ${clauses.join(" AND ")}
    `).all(...params);
    let observed = rows.length;
    let historyInvalid = false;
    if (limit.kind === "total") {
      observed = 0;
      for (const row of rows) {
        if (!isRecord(row)) {
          historyInvalid = true;
          continue;
        }
        try {
          const historical = parseChangeSet(JSON.parse(String(row.change_set_json)));
          const value = limit.field ? historical.patch[limit.field] : void 0;
          if (typeof value !== "number" || !Number.isSafeInteger(value)) historyInvalid = true;
          else observed += Math.abs(value);
        } catch {
          historyInvalid = true;
        }
      }
    }
    const projected = observed + base.proposed;
    const result = {
      ...base,
      observed,
      projected,
      reason: proposedTotal === void 0 && limit.kind === "total" ? `${limit.id} could not verify the proposed total safely` : historyInvalid ? `${limit.id} could not verify its rolling history safely` : `${limit.id} rolling ${limit.kind} ${projected} exceeds ${limit.maximum}`
    };
    if (limit.kind === "total" && proposedTotal === void 0 || historyInvalid || projected > limit.maximum) {
      tripped.push(result);
    } else if (projected / limit.maximum >= 0.8) {
      near.push({
        ...result,
        reason: `${limit.id} rolling ${limit.kind} ${projected} is approaching ${limit.maximum}`
      });
    }
  }
  return { tripped, near };
}
function actionBoundaryTotalValue(proposal, field) {
  const value = field ? proposal.change_set.patch[field] : void 0;
  return typeof value === "number" && Number.isSafeInteger(value) ? Math.abs(value) : void 0;
}
function assertActionBoundaryLimit(limit) {
  if (!limit || !/^[A-Za-z][A-Za-z0-9_.-]{0,79}$/.test(limit.id) || limit.kind !== "count" && limit.kind !== "total" || !["boundary", "capability", "tenant", "tenant_principal", "tenant_object"].includes(limit.scope) || !Number.isSafeInteger(limit.maximum) || limit.maximum <= 0 || !Number.isSafeInteger(limit.window_seconds) || limit.window_seconds < 60 || limit.window_seconds > 31536e3 || limit.capability !== void 0 && !/^[A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_.]*$/.test(limit.capability) || limit.kind === "total" && (typeof limit.field !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(limit.field)) || limit.kind === "count" && limit.field !== void 0) {
    throw new ProposalStoreError("ACTION_BOUNDARY_LIMIT_INVALID", "Action Boundary approval limit metadata is invalid.");
  }
}

// ../synapsor-runner/packages/proposal-store/src/writeback-domain.ts
function stateFromReceipt(receipt2) {
  if (receipt2.status === "applied" || receipt2.status === "already_applied") return "applied";
  if (receipt2.status === "conflict") return "conflict";
  if (receipt2.status === "canceled") return "canceled";
  if (receipt2.status === "reconciliation_required") return "reconciliation_required";
  return "failed";
}
function localStateFromCloudGovernance(state) {
  if (state === "applied" || state === "already_applied") return "applied";
  if (state === "rejected") return "rejected";
  if (state === "canceled") return "canceled";
  if (state === "conflict") return "conflict";
  if (state === "failed") return "failed";
  if (state === "indeterminate" || state === "reconciliation_required") return "reconciliation_required";
  return void 0;
}
function receiptToWritebackResult(receipt2) {
  if (receipt2.schema_version === protocolVersions.executionReceiptV4) {
    return parseWritebackResult({
      protocol_version: protocolVersions.normalizedWritebackJobV4,
      job_id: receipt2.writeback_job_id,
      runner_id: receipt2.runner_id,
      operation: receipt2.operation,
      receipt_authority: receipt2.receipt_authority,
      status: receipt2.status,
      affected_rows: receipt2.rows_affected,
      target_identities: receipt2.target.identities,
      member_effects: receipt2.member_effects,
      inverse: receipt2.inverse,
      result_hash: receipt2.receipt_hash,
      completed_at: receipt2.executed_at,
      error_code: receipt2.safe_error_code,
      intent_id: receipt2.reconciliation?.intent_id
    });
  }
  if (receipt2.schema_version === protocolVersions.executionReceiptV3) {
    return parseWritebackResult({
      protocol_version: protocolVersions.normalizedWritebackJobV3,
      job_id: receipt2.writeback_job_id,
      runner_id: receipt2.runner_id,
      operation: receipt2.operation,
      receipt_authority: receipt2.receipt_authority,
      status: receipt2.status,
      affected_rows: receipt2.rows_affected,
      target_identities: receipt2.target.identities,
      set_digest: receipt2.target.set_digest,
      member_effects: receipt2.member_effects,
      inverse: receipt2.inverse,
      result_hash: receipt2.receipt_hash,
      completed_at: receipt2.executed_at,
      error_code: receipt2.safe_error_code,
      intent_id: receipt2.reconciliation?.intent_id
    });
  }
  return parseWritebackResult({
    protocol_version: protocolVersions.normalizedWritebackJobV2,
    job_id: receipt2.writeback_job_id,
    runner_id: receipt2.runner_id,
    operation: receipt2.operation,
    receipt_authority: receipt2.receipt_authority,
    status: receipt2.status,
    affected_rows: receipt2.rows_affected,
    target_identity: receipt2.target.identity,
    before_digest: receipt2.before_digest,
    after_digest: receipt2.after_digest,
    tombstone_digest: receipt2.tombstone_digest,
    inverse: receipt2.inverse,
    result_hash: receipt2.receipt_hash,
    completed_at: receipt2.executed_at,
    error_code: receipt2.safe_error_code,
    intent_id: receipt2.reconciliation?.intent_id
  });
}
function inverseCaptureFromChangeSet(changeSet, writebackJobId) {
  if (changeSet.schema_version !== protocolVersions.changeSetV2 && changeSet.schema_version !== protocolVersions.changeSetV3) return void 0;
  if (!changeSet.reversibility || changeSet.reversibility.mode !== "reviewed_inverse") return void 0;
  const base = {
    schema_version: protocolVersions.inverseDescriptor,
    cardinality: changeSet.schema_version === protocolVersions.changeSetV3 ? "set" : "single",
    forward_proposal_id: changeSet.proposal_id,
    forward_writeback_job_id: writebackJobId,
    target: {
      source_id: changeSet.source.source_id,
      schema: changeSet.source.schema,
      table: changeSet.source.table,
      primary_key_column: changeSet.source.primary_key.column
    },
    tenant_guard: changeSet.guards.tenant,
    ...changeSet.guards.principal_scope ? { principal_scope: changeSet.guards.principal_scope } : {},
    allowed_columns: changeSet.guards.allowed_columns,
    lineage: changeSet.reversibility.lineage
  };
  if (changeSet.schema_version === protocolVersions.changeSetV2) {
    const primaryValue = changeSet.source.primary_key.value;
    if (primaryValue === void 0) throw new ProposalStoreError("REVERSIBILITY_PRIMARY_KEY_REQUIRED", `reversible proposal ${changeSet.proposal_id} has no deterministic primary-key identity`);
    if (changeSet.operation === "single_row_delete") {
      return {
        ...base,
        availability: "best_effort_unavailable",
        reason_codes: ["HARD_DELETE_HIDDEN_STATE_NOT_RESTORABLE", "HARD_DELETE_SIDE_EFFECTS_NOT_REVERSIBLE"],
        operation: "restore_insert",
        members: [{ primary_key: { column: changeSet.source.primary_key.column, value: primaryValue }, expected_state: {} }],
        max_rows: 1,
        aggregate_bounds: []
      };
    }
    if (changeSet.operation === "single_row_insert") {
      return {
        ...base,
        availability: "available",
        reason_codes: [],
        operation: "remove_insert",
        members: [{
          primary_key: { column: changeSet.source.primary_key.column, value: primaryValue },
          expected_state: selectReviewedState(changeSet.after, [changeSet.source.primary_key.column, changeSet.guards.tenant.column, ...changeSet.guards.principal_scope ? [changeSet.guards.principal_scope.column] : [], ...changeSet.guards.allowed_columns])
        }],
        max_rows: 1,
        aggregate_bounds: []
      };
    }
    const versionAdvance2 = changeSet.guards.version_advance;
    if (!versionAdvance2 || versionAdvance2.strategy !== "integer_increment") throw new ProposalStoreError("REVERSIBILITY_INTEGER_VERSION_REQUIRED", `reversible proposal ${changeSet.proposal_id} requires integer version advancement`);
    return {
      ...base,
      availability: "available",
      reason_codes: [],
      operation: "restore_update",
      members: [{
        primary_key: { column: changeSet.source.primary_key.column, value: primaryValue },
        expected_state: selectReviewedState(changeSet.after, [...changeSet.guards.allowed_columns, versionAdvance2.column]),
        restore_values: selectReviewedState(changeSet.before, changeSet.guards.allowed_columns)
      }],
      max_rows: 1,
      aggregate_bounds: [],
      version_advance: versionAdvance2
    };
  }
  if (changeSet.operation === "set_delete") {
    return {
      ...base,
      availability: "best_effort_unavailable",
      reason_codes: ["HARD_DELETE_HIDDEN_STATE_NOT_RESTORABLE", "HARD_DELETE_SIDE_EFFECTS_NOT_REVERSIBLE"],
      operation: "restore_insert",
      members: changeSet.frozen_set.members.map((member) => ({ primary_key: member.primary_key, expected_state: {} })),
      max_rows: changeSet.frozen_set.max_rows,
      aggregate_bounds: changeSet.frozen_set.aggregate_bounds
    };
  }
  if (changeSet.operation === "batch_insert") {
    return {
      ...base,
      availability: "available",
      reason_codes: [],
      operation: "remove_insert",
      members: changeSet.frozen_set.members.map((member) => ({
        primary_key: member.primary_key,
        expected_state: selectReviewedState(member.after, [changeSet.source.primary_key.column, changeSet.guards.tenant.column, ...changeSet.guards.allowed_columns])
      })),
      max_rows: changeSet.frozen_set.max_rows,
      aggregate_bounds: changeSet.frozen_set.aggregate_bounds
    };
  }
  const versionAdvance = changeSet.guards.version_advance;
  if (!versionAdvance || versionAdvance.strategy !== "integer_increment") throw new ProposalStoreError("REVERSIBILITY_INTEGER_VERSION_REQUIRED", `reversible proposal ${changeSet.proposal_id} requires integer version advancement`);
  return {
    ...base,
    availability: "available",
    reason_codes: [],
    operation: "restore_update",
    members: changeSet.frozen_set.members.map((member) => ({
      primary_key: member.primary_key,
      expected_state: selectReviewedState(member.after, [...changeSet.guards.allowed_columns, versionAdvance.column]),
      restore_values: selectReviewedState(member.before, changeSet.guards.allowed_columns)
    })),
    max_rows: changeSet.frozen_set.max_rows,
    aggregate_bounds: changeSet.frozen_set.aggregate_bounds,
    version_advance: versionAdvance
  };
}
function selectReviewedState(value, columns) {
  const selected = {};
  for (const column of [...new Set(columns)].sort()) {
    const item = value[column];
    if (item === null || typeof item === "string" || typeof item === "number" || typeof item === "boolean") selected[column] = item;
  }
  return selected;
}
function writebackMutationFromChangeSet(changeSet) {
  if (changeSet.operation === "single_row_insert") {
    if (!changeSet.guards.deduplication) throw new ProposalStoreError("INSERT_DEDUPLICATION_REQUIRED", `proposal ${changeSet.proposal_id} has no resolved deduplication identity`);
    return {
      kind: "single_row_insert",
      values: changeSet.patch,
      deduplication: changeSet.guards.deduplication
    };
  }
  const guard = changeSet.guards.expected_version;
  if (!guard) throw new ProposalStoreError("CONFLICT_GUARD_REQUIRED", `proposal ${changeSet.proposal_id} has no exact version guard`);
  if (changeSet.operation === "single_row_delete") {
    return {
      kind: "single_row_delete",
      conflict_guard: { kind: "column", column: guard.column, expected_value: guard.value }
    };
  }
  return {
    kind: "single_row_update",
    values: changeSet.patch,
    conflict_guard: { kind: "column", column: guard.column, expected_value: guard.value },
    ...changeSet.guards.version_advance ? { version_advance: changeSet.guards.version_advance } : {}
  };
}
function conflictGuardFromChangeSet(changeSet) {
  if (changeSet.schema_version === protocolVersions.changeSetV3 || changeSet.schema_version === protocolVersions.compensationChangeSet) return { kind: "none" };
  const guard = "expected_version" in changeSet.guards ? changeSet.guards.expected_version : void 0;
  if (!guard) return { kind: "none" };
  if (guard.column === "__row_hash") {
    return { kind: "row_hash", expected_hash: String(guard.value) };
  }
  if (!guard.column || guard.value === null || guard.value === void 0) {
    return { kind: "none" };
  }
  return { kind: "column", column: guard.column, expected_value: guard.value };
}

// ../synapsor-runner/packages/proposal-store/src/sqlite-writeback-methods.ts
function validatedRecordedAt(value, label) {
  const recordedAt = value ?? (/* @__PURE__ */ new Date()).toISOString();
  if (!Number.isFinite(Date.parse(recordedAt))) {
    throw new ProposalStoreError("LEDGER_TIMESTAMP_INVALID", `${label} created_at must be an ISO timestamp`);
  }
  return recordedAt;
}
function proposalHashFromWritebackJob(job) {
  return job.protocol_version === protocolVersions.normalizedWritebackJobV5 ? job.proposal_hash : job.approval_id;
}
var proposalStoreWritebackMethods = {
  recordExecutionReceipt(input) {
    const receipt2 = parseExecutionReceipt(input);
    const proposal = this.requireProposal(receipt2.proposal_id);
    assertWritebackAllowed(proposal, "recorded with an execution receipt");
    this.transaction(() => {
      this.recordExecutionReceiptRows(receipt2, proposal);
    });
    return this.requireProposal(receipt2.proposal_id);
  },
  recordWritebackJob(input) {
    const job = parseWritebackJob(input);
    const proposal = this.requireProposal(job.proposal_id);
    assertWritebackAllowed(proposal, "recorded with a writeback job");
    const proposalHash = proposalHashFromWritebackJob(job);
    assertProposalIdentity(proposal, proposalHash, proposal.proposal_version);
    const now = (/* @__PURE__ */ new Date()).toISOString();
    this.transaction(() => {
      this.db.prepare(`
          INSERT INTO writeback_jobs (
            writeback_job_id,
            proposal_id,
            proposal_hash,
            status,
            job_json,
            created_at,
            updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(writeback_job_id) DO UPDATE SET
            status = excluded.status,
            job_json = excluded.job_json,
            updated_at = excluded.updated_at
        `).run(job.job_id, job.proposal_id, proposalHash, "pending_worker", JSON.stringify(job), now, now);
      this.appendEvent(job.proposal_id, "writeback_job_recorded", "runner", {
        writeback_job_id: job.job_id,
        proposal_hash: proposalHash,
        source_id: job.source_id
      });
    });
    return job;
  },
  getWritebackJob(writebackJobId) {
    return rowToWritebackJob(this.db.prepare("SELECT * FROM writeback_jobs WHERE writeback_job_id = ?").get(writebackJobId));
  },
  listWritebackJobs(options = {}) {
    const clauses = [];
    const values = [];
    if (options.proposal_id) {
      clauses.push("proposal_id = ?");
      values.push(options.proposal_id);
    }
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 1e3);
    return this.db.prepare(`SELECT * FROM writeback_jobs${clauses.length ? ` WHERE ${clauses.join(" AND ")}` : ""} ORDER BY created_at ASC, writeback_job_id ASC LIMIT ?`).all(...values, limit).map(rowToWritebackJob).filter((job) => Boolean(job));
  },
  claimWritebackIntent(jobInput, runnerId) {
    const job = parseWritebackJob(jobInput);
    const proposal = this.requireProposal(job.proposal_id);
    assertWritebackAllowed(proposal, "recorded with a writeback intent");
    const proposalHash = proposalHashFromWritebackJob(job);
    assertProposalIdentity(proposal, proposalHash, proposal.proposal_version);
    const intentId = `wbi:${job.job_id}`;
    const existing = this.getWritebackIntent(intentId);
    if (existing) {
      if (existing.idempotency_key !== job.idempotency_key || existing.writeback_job_id !== job.job_id || existing.proposal_id !== job.proposal_id || existing.proposal_hash !== proposalHash) {
        throw new ProposalStoreError("WRITEBACK_INTENT_IDENTITY_MISMATCH", `writeback intent ${intentId} does not match the immutable job identity`);
      }
      if (["applied", "already_applied", "conflict", "failed"].includes(existing.status)) {
        if (!existing.result) {
          return { decision: "reconciliation_required", intent_id: intentId, reason: "terminal intent is missing its durable result" };
        }
        return { decision: "existing_result", intent_id: intentId, result: existing.result };
      }
      if (existing.status === "applying" || existing.status === "reconciliation_required") {
        return {
          decision: "reconciliation_required",
          intent_id: intentId,
          reason: existing.reconciliation_reason ?? "a previous apply crossed the source mutation boundary without a durable terminal result"
        };
      }
      return { decision: "proceed", intent_id: intentId };
    }
    const now = (/* @__PURE__ */ new Date()).toISOString();
    this.transaction(() => {
      this.db.prepare(`
          INSERT INTO writeback_intents (
            intent_id, idempotency_key, writeback_job_id, proposal_id, proposal_hash,
            runner_id, operation, status, intent_json, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 'intent_recorded', ?, ?, ?)
        `).run(
        intentId,
        job.idempotency_key,
        job.job_id,
        job.proposal_id,
        proposalHash,
        runnerId,
        job.operation ?? "single_row_update",
        JSON.stringify(job),
        now,
        now
      );
      this.appendEvent(job.proposal_id, "writeback_intent_recorded", runnerId, {
        intent_id: intentId,
        writeback_job_id: job.job_id,
        operation: job.operation ?? "single_row_update"
      });
    });
    return { decision: "proceed", intent_id: intentId };
  },
  markWritebackIntentApplying(intentId, runnerId) {
    const intent = this.requireWritebackIntent(intentId);
    const now = (/* @__PURE__ */ new Date()).toISOString();
    const result = this.db.prepare(`
        UPDATE writeback_intents
        SET status = 'applying', runner_id = ?, reconciliation_reason = NULL, updated_at = ?
        WHERE intent_id = ? AND status = 'intent_recorded'
      `).run(runnerId, now, intentId);
    if (Number(result.changes) !== 1) {
      throw new ProposalStoreError(
        "WRITEBACK_INTENT_NOT_CLAIMABLE",
        `writeback intent ${intentId} is ${intent.status}; its source outcome must be reconciled before another apply`
      );
    }
    this.appendEvent(intent.proposal_id, "writeback_intent_applying", runnerId, {
      intent_id: intentId,
      writeback_job_id: intent.writeback_job_id,
      operation: intent.operation
    });
  },
  completeWritebackIntent(intentId, resultInput) {
    const result = parseWritebackResult(resultInput);
    const intent = this.requireWritebackIntent(intentId);
    if (result.job_id !== intent.writeback_job_id) {
      throw new ProposalStoreError("WRITEBACK_INTENT_RESULT_MISMATCH", `result ${result.job_id} does not belong to intent ${intentId}`);
    }
    if (!["applied", "already_applied", "conflict", "failed", "reconciliation_required"].includes(result.status)) {
      throw new ProposalStoreError("WRITEBACK_INTENT_RESULT_NOT_TERMINAL", `result for ${intentId} is not terminal`);
    }
    const now = (/* @__PURE__ */ new Date()).toISOString();
    const reconciliationReason = result.status === "reconciliation_required" ? "source outcome requires operator reconciliation" : null;
    const updated = this.db.prepare(`
        UPDATE writeback_intents
        SET status = ?, result_json = ?, reconciliation_reason = ?, updated_at = ?
        WHERE intent_id = ? AND status IN ('applying', 'reconciliation_required')
      `).run(result.status, JSON.stringify(result), reconciliationReason, now, intentId);
    if (Number(updated.changes) !== 1) {
      const latest = this.requireWritebackIntent(intentId);
      if (latest.result && JSON.stringify(latest.result) === JSON.stringify(result)) return;
      throw new ProposalStoreError("WRITEBACK_INTENT_COMPLETION_CONFLICT", `writeback intent ${intentId} cannot move from ${latest.status} to ${result.status}`);
    }
    this.appendEvent(intent.proposal_id, `writeback_intent_${result.status}`, result.runner_id, {
      intent_id: intentId,
      writeback_job_id: intent.writeback_job_id,
      operation: intent.operation,
      result_hash: result.result_hash
    });
  },
  requireWritebackReconciliation(intentId, reason) {
    const intent = this.requireWritebackIntent(intentId);
    if (intent.status === "applied" || intent.status === "already_applied") return;
    const safeReason = String(reason || "source outcome is unknown").slice(0, 500);
    const now = (/* @__PURE__ */ new Date()).toISOString();
    this.db.prepare(`
        UPDATE writeback_intents
        SET status = 'reconciliation_required', reconciliation_reason = ?, updated_at = ?
        WHERE intent_id = ?
      `).run(safeReason, now, intentId);
    this.appendEvent(intent.proposal_id, "writeback_reconciliation_required", intent.runner_id, {
      intent_id: intentId,
      writeback_job_id: intent.writeback_job_id,
      operation: intent.operation,
      reason: safeReason
    });
  },
  getWritebackIntent(intentId) {
    return rowToWritebackIntent(this.db.prepare("SELECT * FROM writeback_intents WHERE intent_id = ?").get(intentId));
  },
  listWritebackIntents(options = {}) {
    const clauses = [];
    const values = [];
    if (options.status) {
      clauses.push("status = ?");
      values.push(options.status);
    }
    if (options.proposal_id) {
      clauses.push("proposal_id = ?");
      values.push(options.proposal_id);
    }
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 1e3);
    return this.db.prepare(`SELECT * FROM writeback_intents${clauses.length ? ` WHERE ${clauses.join(" AND ")}` : ""} ORDER BY updated_at DESC LIMIT ?`).all(...values, limit).map(rowToWritebackIntent).filter((intent) => Boolean(intent));
  },
  reconcileWritebackIntent(input) {
    const intent = this.requireWritebackIntent(input.intent_id);
    const proposal = this.requireProposal(intent.proposal_id);
    const receipt2 = parseExecutionReceipt(input.receipt);
    if (receipt2.schema_version !== protocolVersions.executionReceiptV2 && receipt2.schema_version !== protocolVersions.executionReceiptV3 && receipt2.schema_version !== protocolVersions.executionReceiptV4) throw new ProposalStoreError("RECONCILIATION_RECEIPT_VERSION_REQUIRED", "reconciliation requires an execution-receipt v2, v3, or v4");
    if (!input.reason.trim()) throw new ProposalStoreError("RECONCILIATION_REASON_REQUIRED", "reconciliation requires an operator reason");
    if (intent.status !== "reconciliation_required" && intent.status !== "applying") {
      throw new ProposalStoreError("WRITEBACK_INTENT_NOT_RECONCILABLE", `writeback intent ${intent.intent_id} is ${intent.status}`);
    }
    if (receipt2.receipt_authority !== "runner_ledger" || receipt2.writeback_job_id !== intent.writeback_job_id || receipt2.proposal_id !== intent.proposal_id || receipt2.proposal_hash !== intent.proposal_hash || receipt2.operation !== intent.operation || !["applied", "conflict", "failed"].includes(receipt2.status)) {
      throw new ProposalStoreError("RECONCILIATION_RECEIPT_MISMATCH", `reconciliation receipt does not match intent ${intent.intent_id}`);
    }
    assertOperatorDecision(proposal, "reconcile", input.actor, input.identity, input.require_verified_identity === true);
    assertNoSecretMaterial(input.observation, "writeback_reconciliation_observation");
    const reason = input.reason.trim().slice(0, 500);
    this.transaction(() => {
      const updated = this.db.prepare(`
          UPDATE writeback_intents
          SET status = ?, result_json = ?, reconciliation_reason = ?, updated_at = ?
          WHERE intent_id = ? AND status IN ('applying', 'reconciliation_required')
        `).run(receipt2.status, JSON.stringify(receiptToWritebackResult(receipt2)), reason, receipt2.executed_at, intent.intent_id);
      if (Number(updated.changes) !== 1) throw new ProposalStoreError("WRITEBACK_INTENT_RECONCILIATION_CONFLICT", `writeback intent ${intent.intent_id} changed during reconciliation`);
      this.appendEvent(intent.proposal_id, "writeback_reconciled", input.actor, {
        intent_id: intent.intent_id,
        writeback_job_id: intent.writeback_job_id,
        operation: intent.operation,
        outcome: receipt2.status,
        reason,
        observation: input.observation,
        identity: publicIdentitySummary(input.identity),
        decision_hash: input.identity?.decision_hash
      });
      this.recordExecutionReceiptRows(receipt2, proposal);
      const workerItem = this.workerQueueItem(intent.proposal_id);
      if (workerItem?.status === "reconciliation_required") {
        const queueStatus = receipt2.status === "failed" ? "dead_letter" : "completed";
        const terminalOutcome = receipt2.status === "failed" ? "dead_letter" : receipt2.status;
        this.db.prepare(`
            UPDATE worker_queue
            SET status = ?, lease_owner = NULL, lease_id = NULL,
                lease_expires_at = NULL, last_error_code = ?,
                terminal_outcome = ?, updated_at = ?
            WHERE proposal_id = ? AND status = 'reconciliation_required'
          `).run(
          queueStatus,
          receipt2.status === "failed" ? "RECONCILED_FAILED" : null,
          terminalOutcome,
          receipt2.executed_at,
          intent.proposal_id
        );
        this.appendEvent(intent.proposal_id, "writeback_worker_reconciled", input.actor, {
          intent_id: intent.intent_id,
          outcome: receipt2.status,
          queue_status: queueStatus,
          source_database_changed: false
        });
      }
    });
    return this.requireWritebackIntent(intent.intent_id);
  },
  requireWritebackIntent(intentId) {
    const intent = this.getWritebackIntent(intentId);
    if (!intent) throw new ProposalStoreError("WRITEBACK_INTENT_NOT_FOUND", `writeback intent not found: ${intentId}`);
    return intent;
  },
  recordExecutionReceiptRows(receipt2, proposal) {
    const state = stateFromReceipt(receipt2);
    const now = receipt2.executed_at || (/* @__PURE__ */ new Date()).toISOString();
    this.db.prepare(`
        INSERT OR IGNORE INTO writeback_receipts (
          writeback_job_id, proposal_id, runner_id, status, idempotency_key,
          source_database_mutated, receipt_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
      receipt2.writeback_job_id,
      receipt2.proposal_id,
      receipt2.runner_id,
      receipt2.status,
      receipt2.idempotency_key,
      receipt2.source_database_mutated ? 1 : 0,
      JSON.stringify(receipt2),
      now
    );
    this.db.prepare("UPDATE proposals SET state = ?, source_database_mutated = ?, updated_at = ? WHERE proposal_id = ?").run(state, receipt2.source_database_mutated ? 1 : proposal.source_database_mutated ? 1 : 0, now, receipt2.proposal_id);
    this.db.prepare(`
        INSERT OR REPLACE INTO idempotency_receipts (
          idempotency_key, writeback_job_id, proposal_id, receipt_status, receipt_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).run(receipt2.idempotency_key, receipt2.writeback_job_id, receipt2.proposal_id, receipt2.status, JSON.stringify(receipt2), now);
    this.db.prepare("UPDATE writeback_jobs SET status = ?, updated_at = ? WHERE writeback_job_id = ?").run(receipt2.status, now, receipt2.writeback_job_id);
    this.appendEvent(receipt2.proposal_id, `writeback_${receipt2.status}`, receipt2.runner_id, {
      writeback_job_id: receipt2.writeback_job_id,
      rows_affected: receipt2.rows_affected,
      source_database_mutated: receipt2.source_database_mutated,
      receipt_hash: receipt2.receipt_hash,
      safe_error_code: "safe_error_code" in receipt2 ? receipt2.safe_error_code ?? null : null
    });
  },
  recordHandlerWritebackJob(input) {
    const proposal = this.requireProposal(input.proposal_id);
    assertWritebackAllowed(proposal, "recorded with a handler writeback job");
    assertProposalIdentity(proposal, input.proposal_hash, proposal.proposal_version);
    assertNoSecretMaterial(input.request, "handler_writeback_job");
    const now = (/* @__PURE__ */ new Date()).toISOString();
    this.transaction(() => {
      this.db.prepare(`
          INSERT INTO writeback_jobs (
            writeback_job_id,
            proposal_id,
            proposal_hash,
            status,
            job_json,
            created_at,
            updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(writeback_job_id) DO UPDATE SET
            status = excluded.status,
            job_json = excluded.job_json,
            updated_at = excluded.updated_at
        `).run(
        input.writeback_job_id,
        input.proposal_id,
        input.proposal_hash,
        "pending_worker",
        JSON.stringify({
          schema_version: "synapsor.handler-writeback.v1",
          writeback_job_id: input.writeback_job_id,
          proposal_id: input.proposal_id,
          proposal_hash: input.proposal_hash,
          runner_id: input.runner_id,
          executor: input.executor,
          request: input.request
        }),
        now,
        now
      );
      this.appendEvent(input.proposal_id, "handler_writeback_job_recorded", input.runner_id, {
        writeback_job_id: input.writeback_job_id,
        executor: input.executor
      });
    });
  },
  createWritebackJobFromProposal(proposalId, options = {}) {
    const proposal = this.requireProposal(proposalId);
    assertWritebackAllowed(proposal, "converted into a writeback job");
    if (proposal.state !== "approved" && proposal.state !== "pending_worker") {
      throw new ProposalStoreError("PROPOSAL_NOT_APPROVED", `proposal ${proposalId} is ${proposal.state}`);
    }
    const changeSet = proposal.change_set;
    if (changeSet.writeback.mode !== "trusted_worker_required") {
      throw new ProposalStoreError("WRITEBACK_NOT_REQUIRED", `proposal ${proposalId} uses ${changeSet.writeback.mode}`);
    }
    const writebackExecutor = changeSet.writeback.executor;
    if (typeof writebackExecutor === "string" && writebackExecutor !== "sql_update" && writebackExecutor !== "trusted_worker_required" && writebackExecutor !== "semantic_rule") {
      throw new ProposalStoreError("WRITEBACK_NOT_DIRECT_SQL", `proposal ${proposalId} uses app-owned or non-local writeback executor ${writebackExecutor}`);
    }
    if (changeSet.source.kind !== "external_postgres" && changeSet.source.kind !== "external_mysql") {
      throw new ProposalStoreError("WRITEBACK_TARGET_NOT_EXTERNAL", `proposal ${proposalId} targets ${changeSet.source.kind}`);
    }
    const engine = changeSet.source.kind === "external_postgres" ? "postgres" : "mysql";
    const leaseSeconds = Math.max(15, Math.min(Number(options.lease_seconds ?? 300), 3600));
    const attempt = Math.max(1, Math.min(Number(options.attempt ?? 1), 100));
    const now = Date.now();
    const writebackJobId = `wbj_${proposal.proposal_id.replace(/[^A-Za-z0-9_:-]/g, "_")}${attempt > 1 ? `_a${attempt}` : ""}`;
    const lease = {
      lease_id: options.lease_id ?? `lease_${proposal.proposal_id.replace(/[^A-Za-z0-9_:-]/g, "_")}_a${attempt}`,
      attempt,
      expires_at: new Date(now + leaseSeconds * 1e3).toISOString()
    };
    const tenantGuard = changeSet.guards.tenant;
    const common = {
      writeback_job_id: writebackJobId,
      proposal_id: proposal.proposal_id,
      proposal_version: proposal.proposal_version,
      proposal_hash: proposal.proposal_hash,
      runner_scope: { project_id: options.project_id ?? "local", source_id: proposal.source_id },
      engine,
      tenant_guard: tenantGuard,
      ...changeSet.guards.principal_scope ? { principal_scope: changeSet.guards.principal_scope } : {},
      allowed_columns: changeSet.guards.allowed_columns,
      ..."freshness" in changeSet && changeSet.freshness ? { freshness: parseFreshnessAuthority(changeSet.freshness) } : {},
      idempotency_key: `${proposal.proposal_id}:${proposal.object_id}`,
      lease
    };
    const inverseCapture = inverseCaptureFromChangeSet(changeSet, writebackJobId);
    const job = changeSet.schema_version === protocolVersions.changeSet ? {
      schema_version: protocolVersions.writebackJob,
      ...common,
      operation: "single_row_update",
      target: { schema: proposal.source_schema, table: proposal.source_table, primary_key: changeSet.source.primary_key },
      patch: changeSet.patch,
      conflict_guard: conflictGuardFromChangeSet(changeSet)
    } : changeSet.schema_version === protocolVersions.changeSetV2 ? {
      schema_version: protocolVersions.writebackJobV2,
      ...common,
      target: { schema: proposal.source_schema, table: proposal.source_table, primary_key: changeSet.source.primary_key },
      mutation: writebackMutationFromChangeSet(changeSet),
      ...inverseCapture ? { inverse_capture: inverseCapture } : {}
    } : changeSet.schema_version === protocolVersions.changeSetV3 ? {
      schema_version: protocolVersions.writebackJobV3,
      ...common,
      operation: changeSet.operation,
      target: { schema: proposal.source_schema, table: proposal.source_table, primary_key: changeSet.source.primary_key },
      patch: changeSet.patch,
      ...changeSet.guards.version_advance ? { version_advance: changeSet.guards.version_advance } : {},
      frozen_set: changeSet.frozen_set,
      ...inverseCapture ? { inverse_capture: inverseCapture } : {}
    } : changeSet.schema_version === protocolVersions.changeSetV4 ? {
      schema_version: protocolVersions.writebackJobV5,
      writeback_job_id: writebackJobId,
      proposal_id: proposal.proposal_id,
      proposal_hash: proposal.proposal_hash,
      approval_id: semanticApprovalSetDigest(proposal, this.approvals(proposal.proposal_id)),
      ...changeSet.contract ? {
        contract: {
          contract_id: options.project_id ?? "local",
          contract_version_id: changeSet.contract.version,
          digest: changeSet.contract.digest
        }
      } : {},
      runner_scope: { project_id: options.project_id ?? "local", source_id: proposal.source_id },
      engine,
      operation: changeSet.operation,
      target: {
        schema: proposal.source_schema,
        table: proposal.source_table,
        primary_key: changeSet.source.primary_key,
        ...changeSet.guards.tenant ? { tenant_guard: changeSet.guards.tenant } : {},
        ...changeSet.guards.organization_scope ? { organization_scope: changeSet.guards.organization_scope } : {},
        ...changeSet.guards.principal_scope ? { principal_scope: changeSet.guards.principal_scope } : {}
      },
      allowed_columns: changeSet.guards.allowed_columns,
      patch: changeSet.patch,
      conflict_guard: changeSet.guards.expected_version ? {
        kind: "version_column",
        column: changeSet.guards.expected_version.column,
        expected_value: changeSet.guards.expected_version.value
      } : { kind: "none" },
      ...changeSet.guards.version_advance ? { version_advance: changeSet.guards.version_advance } : {},
      ...changeSet.guards.deduplication ? { deduplication: changeSet.guards.deduplication } : {},
      semantic_authority: changeSet.semantic_authority,
      idempotency_key: `semantic:${proposal.proposal_id}`,
      lease
    } : {
      schema_version: protocolVersions.writebackJobV4,
      writeback_job_id: writebackJobId,
      proposal_id: proposal.proposal_id,
      proposal_version: proposal.proposal_version,
      proposal_hash: proposal.proposal_hash,
      runner_scope: { project_id: options.project_id ?? "local", source_id: proposal.source_id },
      engine,
      operation: changeSet.compensation.descriptor.operation,
      target: {
        schema: proposal.source_schema,
        table: proposal.source_table,
        primary_key: {
          column: changeSet.source.primary_key.column,
          ...changeSet.compensation.descriptor.members.length === 1 ? { value: changeSet.compensation.descriptor.members[0].primary_key.value } : {}
        }
      },
      tenant_guard: changeSet.guards.tenant,
      ...changeSet.guards.principal_scope ? { principal_scope: changeSet.guards.principal_scope } : {},
      allowed_columns: changeSet.guards.allowed_columns,
      patch: {},
      compensation: changeSet.compensation.descriptor,
      forward_receipt_hash: changeSet.compensation.forward_receipt_hash,
      idempotency_key: `${proposal.proposal_id}:${proposal.object_id}`,
      lease
    };
    this.transaction(() => {
      if (proposal.state === "approved") {
        this.db.prepare("UPDATE proposals SET state = ?, updated_at = ? WHERE proposal_id = ?").run("pending_worker", (/* @__PURE__ */ new Date()).toISOString(), proposalId);
        this.appendEvent(proposalId, "proposal_pending_worker", options.runner_id ?? "local_runner", {
          proposal_hash: proposal.proposal_hash,
          proposal_version: proposal.proposal_version
        });
      }
      const normalized = parseWritebackJob(job);
      this.db.prepare(`
          INSERT INTO writeback_jobs (
            writeback_job_id,
            proposal_id,
            proposal_hash,
            status,
            job_json,
            created_at,
            updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(writeback_job_id) DO UPDATE SET
            status = excluded.status,
            job_json = excluded.job_json,
            updated_at = excluded.updated_at
        `).run(normalized.job_id, proposal.proposal_id, proposal.proposal_hash, "pending_worker", JSON.stringify(normalized), (/* @__PURE__ */ new Date()).toISOString(), (/* @__PURE__ */ new Date()).toISOString());
      this.appendEvent(proposal.proposal_id, "writeback_job_recorded", options.runner_id ?? "local_runner", {
        writeback_job_id: normalized.job_id,
        proposal_hash: proposal.proposal_hash,
        source_id: normalized.source_id
      });
    });
    return job;
  },
  recordEvidenceBundle(input) {
    assertNoSecretMaterial({
      payload: input.payload,
      items: input.items ?? [],
      query_audit: input.query_audit ?? []
    }, "evidence_bundle");
    const now = validatedRecordedAt(input.created_at, "evidence bundle");
    const proposal = input.proposal_id ? this.requireProposal(input.proposal_id) : void 0;
    const metadata = this.evidenceMetadata({ proposal, payload: input.payload, items: input.items ?? [] });
    const record2 = () => {
      this.db.prepare(`
          INSERT OR REPLACE INTO evidence_bundles (
            evidence_bundle_id,
            proposal_id,
            tenant_id,
            principal,
            capability,
            source_id,
            source_table,
            business_object,
            object_id,
            query_fingerprint,
            payload_json,
            created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
        input.evidence_bundle_id,
        input.proposal_id ?? null,
        input.tenant_id,
        metadata.principal ?? null,
        metadata.capability ?? null,
        metadata.source_id ?? null,
        metadata.source_table ?? null,
        metadata.business_object ?? null,
        metadata.object_id ?? null,
        metadata.query_fingerprint ?? null,
        JSON.stringify(input.payload),
        now
      );
      for (const item of input.items ?? []) {
        this.db.prepare(`
            INSERT INTO evidence_items (evidence_bundle_id, item_json, created_at)
            VALUES (?, ?, ?)
          `).run(input.evidence_bundle_id, JSON.stringify(item), now);
      }
      if (input.proposal_id) {
        this.appendEvent(input.proposal_id, "evidence_recorded", "runner", {
          evidence_bundle_id: input.evidence_bundle_id,
          item_count: input.items?.length ?? 0
        });
      }
      for (const audit of input.query_audit ?? []) {
        if (audit.evidence_bundle_id && audit.evidence_bundle_id !== input.evidence_bundle_id) {
          throw new ProposalStoreError(
            "EVIDENCE_QUERY_AUDIT_MISMATCH",
            `query audit evidence bundle ${audit.evidence_bundle_id} does not match ${input.evidence_bundle_id}`
          );
        }
        this.recordQueryAudit({
          ...audit,
          evidence_bundle_id: input.evidence_bundle_id,
          created_at: audit.created_at ?? now
        });
      }
    };
    if (this.db.isTransaction) record2();
    else this.transaction(record2);
  },
  recordQueryAudit(input) {
    assertNoSecretMaterial(input.payload, "query_audit");
    const now = validatedRecordedAt(input.created_at, "query audit");
    const proposal = input.proposal_id ? this.requireProposal(input.proposal_id) : void 0;
    const evidence = input.evidence_bundle_id ? this.getEvidenceBundle(input.evidence_bundle_id) : void 0;
    const metadata = this.queryAuditMetadata({ proposal, evidence, payload: input.payload });
    this.db.prepare(`
        INSERT INTO query_audit (
          proposal_id,
          evidence_bundle_id,
          tenant_id,
          principal,
          capability,
          business_object,
          object_id,
          primary_key_value,
          source_id,
          query_fingerprint,
          table_name,
          row_count,
          payload_json,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
      input.proposal_id ?? null,
      input.evidence_bundle_id ?? null,
      input.tenant_id ?? metadata.tenant_id ?? null,
      input.principal ?? metadata.principal ?? null,
      input.capability ?? metadata.capability ?? null,
      metadata.business_object ?? null,
      metadata.object_id ?? null,
      metadata.primary_key_value ?? null,
      input.source_id,
      input.query_fingerprint,
      input.table_name,
      input.row_count,
      JSON.stringify(input.payload),
      now
    );
  },
  getEvidenceBundle(evidenceBundleId) {
    const row = this.db.prepare("SELECT * FROM evidence_bundles WHERE evidence_bundle_id = ?").get(evidenceBundleId);
    return this.rowToEvidenceBundle(row);
  },
  rowToEvidenceBundle(row) {
    if (!isRecord(row)) return void 0;
    return {
      evidence_bundle_id: String(row.evidence_bundle_id),
      proposal_id: row.proposal_id == null ? void 0 : String(row.proposal_id),
      tenant_id: String(row.tenant_id),
      principal: row.principal == null ? void 0 : String(row.principal),
      capability: row.capability == null ? void 0 : String(row.capability),
      source_id: row.source_id == null ? void 0 : String(row.source_id),
      source_table: row.source_table == null ? void 0 : String(row.source_table),
      business_object: row.business_object == null ? void 0 : String(row.business_object),
      object_id: row.object_id == null ? void 0 : String(row.object_id),
      query_fingerprint: row.query_fingerprint == null ? void 0 : String(row.query_fingerprint),
      payload: JSON.parse(String(row.payload_json)),
      items: this.evidenceItems(String(row.evidence_bundle_id)),
      query_audit: this.queryAuditByEvidence(String(row.evidence_bundle_id)),
      created_at: String(row.created_at)
    };
  },
  events(proposalId) {
    const rows = this.db.prepare("SELECT * FROM proposal_events WHERE proposal_id = ? ORDER BY event_id ASC").all(proposalId);
    return rows.map(rowToEvent).filter((event) => event !== void 0);
  },
  listEvents(filters = {}) {
    const query = buildEventQuery(filters);
    const rows = this.db.prepare(query.sql).all(...query.params);
    return rows.map(rowToEvent).filter((event) => event !== void 0);
  }
};

// ../synapsor-runner/packages/proposal-store/src/subject-reference-domain.ts
var DIGEST = /^sha256:[a-f0-9]{64}$/;
var SUBJECT_REF = /^obj_[A-Za-z0-9_-]{32,128}$/;
var SAFE_NAME = /^[A-Za-z_][A-Za-z0-9_.:-]{0,255}$/;
var SAFE_RESOURCE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+$/;
var BASE64URL = /^[A-Za-z0-9_-]+$/;
function subjectReferenceUnavailable() {
  return new ProposalStoreError(
    "SUBJECT_REFERENCE_UNAVAILABLE",
    "One or more observed subjects are unavailable for this request. Re-read the reviewed row and try again."
  );
}
function record(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw subjectReferenceUnavailable();
  return value;
}
function text(value, pattern, maximum = 512) {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum || !pattern.test(value)) {
    throw subjectReferenceUnavailable();
  }
  return value;
}
function digest(value) {
  return text(value, DIGEST, 71);
}
function timestamp2(value) {
  if (typeof value !== "string") throw subjectReferenceUnavailable();
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    throw subjectReferenceUnavailable();
  }
  return value;
}
function authority(value) {
  const input = record(value);
  return {
    outcome: text(input.outcome, SAFE_NAME, 256),
    action_boundary_digest: digest(input.action_boundary_digest),
    action_rule_digest: digest(input.action_rule_digest)
  };
}
function normalizeStoredObservedSubjectReference(value) {
  const input = record(value);
  if (input.schema_version !== "synapsor.observed-subject-ref.v1") throw subjectReferenceUnavailable();
  const protectedIdentity = record(input.protected_identity);
  if (protectedIdentity.algorithm !== "A256GCM") throw subjectReferenceUnavailable();
  const outcomeAuthorities = Array.isArray(input.outcome_authorities) ? input.outcome_authorities.map(authority).sort((left, right) => {
    const outcome = left.outcome.localeCompare(right.outcome);
    return outcome !== 0 ? outcome : left.action_rule_digest.localeCompare(right.action_rule_digest);
  }) : [];
  if (outcomeAuthorities.length === 0 || new Set(outcomeAuthorities.map((item) => item.outcome)).size !== outcomeAuthorities.length) {
    throw subjectReferenceUnavailable();
  }
  const state = input.state;
  if (state !== "active" && state !== "consumed" && state !== "revoked") {
    throw subjectReferenceUnavailable();
  }
  const normalized = {
    schema_version: "synapsor.observed-subject-ref.v1",
    subject_ref: text(input.subject_ref, SUBJECT_REF, 132),
    subject_ref_digest: digest(input.subject_ref_digest),
    source_id: text(input.source_id, SAFE_NAME, 256),
    resource: text(input.resource, SAFE_RESOURCE, 256),
    protected_identity: {
      algorithm: "A256GCM",
      nonce: text(protectedIdentity.nonce, BASE64URL, 128),
      ciphertext: text(protectedIdentity.ciphertext, BASE64URL, 16384),
      authentication_tag: text(protectedIdentity.authentication_tag, BASE64URL, 128)
    },
    evidence_bundle_id: text(input.evidence_bundle_id, SAFE_NAME, 256),
    read_boundary_digest: digest(input.read_boundary_digest),
    generation_lock_fingerprint: digest(input.generation_lock_fingerprint),
    tenant_scope_fingerprint: digest(input.tenant_scope_fingerprint),
    ...input.principal_scope_fingerprint === void 0 ? {} : { principal_scope_fingerprint: digest(input.principal_scope_fingerprint) },
    workflow_session_id: text(input.workflow_session_id, SAFE_NAME, 256),
    ...input.observed_version_digest === void 0 ? {} : { observed_version_digest: digest(input.observed_version_digest) },
    outcome_authorities: outcomeAuthorities,
    issued_at: timestamp2(input.issued_at),
    expires_at: timestamp2(input.expires_at),
    state,
    ...input.claim_id === void 0 ? {} : { claim_id: text(input.claim_id, SAFE_NAME, 256) },
    ...input.consumed_at === void 0 ? {} : { consumed_at: timestamp2(input.consumed_at) },
    ...input.revoked_at === void 0 ? {} : { revoked_at: timestamp2(input.revoked_at) }
  };
  if (Date.parse(normalized.expires_at) <= Date.parse(normalized.issued_at)) throw subjectReferenceUnavailable();
  const expectedDigest = canonicalJsonDigest({
    schema_version: normalized.schema_version,
    subject_ref: normalized.subject_ref
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
function normalizeNewObservedSubjectReference(value) {
  const normalized = normalizeStoredObservedSubjectReference(value);
  if (normalized.state !== "active") throw subjectReferenceUnavailable();
  return normalized;
}
function normalizeObservedSubjectClaim(value) {
  if (!Array.isArray(value.subject_refs) || value.subject_refs.length < 1 || value.subject_refs.length > 8 || new Set(value.subject_refs).size !== value.subject_refs.length) {
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
    ...value.principal_scope_fingerprint === void 0 ? {} : { principal_scope_fingerprint: digest(value.principal_scope_fingerprint) },
    workflow_session_id: text(value.workflow_session_id, SAFE_NAME, 256),
    now: timestamp2(value.now ?? (/* @__PURE__ */ new Date()).toISOString())
  };
}
function assertObservedSubjectMatchesClaim(subject, claim) {
  const authority2 = subject.outcome_authorities.find((candidate) => candidate.outcome === claim.outcome && candidate.action_boundary_digest === claim.action_boundary_digest && candidate.action_rule_digest === claim.action_rule_digest);
  if (!authority2 || subject.read_boundary_digest !== claim.read_boundary_digest || subject.generation_lock_fingerprint !== claim.generation_lock_fingerprint || subject.tenant_scope_fingerprint !== claim.tenant_scope_fingerprint || subject.principal_scope_fingerprint !== claim.principal_scope_fingerprint || subject.workflow_session_id !== claim.workflow_session_id || Date.parse(subject.expires_at) <= Date.parse(claim.now) || subject.state === "consumed" && subject.claim_id !== claim.claim_id || subject.state === "revoked") {
    throw subjectReferenceUnavailable();
  }
}
function consumedObservedSubjectReference(subject, claimId, consumedAt) {
  return normalizeStoredObservedSubjectReference({
    ...subject,
    state: "consumed",
    claim_id: claimId,
    consumed_at: consumedAt
  });
}
function normalizeObservedSubjectRevocation(value) {
  const refs = value.subject_refs ?? [];
  if (refs.length > 256 || new Set(refs).size !== refs.length) throw subjectReferenceUnavailable();
  const readDigest = value.read_boundary_digest === void 0 ? void 0 : digest(value.read_boundary_digest);
  const actionDigest = value.action_boundary_digest === void 0 ? void 0 : digest(value.action_boundary_digest);
  const workflow = value.workflow_session_id === void 0 ? void 0 : text(value.workflow_session_id, SAFE_NAME, 256);
  if (refs.length === 0 && !readDigest && !actionDigest && !workflow) throw subjectReferenceUnavailable();
  return {
    subject_refs: refs.map((item) => text(item, SUBJECT_REF, 132)),
    ...readDigest === void 0 ? {} : { read_boundary_digest: readDigest },
    ...actionDigest === void 0 ? {} : { action_boundary_digest: actionDigest },
    ...workflow === void 0 ? {} : { workflow_session_id: workflow },
    now: timestamp2(value.now ?? (/* @__PURE__ */ new Date()).toISOString())
  };
}

// ../synapsor-runner/packages/proposal-store/src/sqlite-subject-reference-methods.ts
function fromRow(row) {
  if (!isRecord(row)) return void 0;
  let immutable;
  try {
    immutable = JSON.parse(String(row.record_json));
  } catch {
    throw subjectReferenceUnavailable();
  }
  return normalizeStoredObservedSubjectReference({
    ...immutable,
    state: row.state,
    ...row.claim_id == null ? {} : { claim_id: String(row.claim_id) },
    ...row.consumed_at == null ? {} : { consumed_at: String(row.consumed_at) },
    ...row.revoked_at == null ? {} : { revoked_at: String(row.revoked_at) }
  });
}
var proposalStoreSubjectReferenceMethods = {
  createObservedSubjectReference(input) {
    const subject = normalizeNewObservedSubjectReference(input);
    return this.transaction(() => {
      const existing = this.getObservedSubjectReference(subject.subject_ref);
      if (existing) {
        if (canonicalJsonStringify(existing) !== canonicalJsonStringify(subject)) {
          throw new ProposalStoreError(
            "SUBJECT_REFERENCE_IMMUTABILITY_VIOLATION",
            "An observed subject reference already exists with different protected metadata."
          );
        }
        return existing;
      }
      this.db.prepare(`
        INSERT INTO observed_subject_references (
          subject_ref, subject_ref_digest, state, claim_id, record_json,
          issued_at, expires_at, consumed_at, revoked_at
        ) VALUES (?, ?, 'active', NULL, ?, ?, ?, NULL, NULL)
      `).run(
        subject.subject_ref,
        subject.subject_ref_digest,
        JSON.stringify(subject),
        subject.issued_at,
        subject.expires_at
      );
      return subject;
    });
  },
  getObservedSubjectReference(subjectRef) {
    if (!/^obj_[A-Za-z0-9_-]{32,128}$/.test(subjectRef)) return void 0;
    return fromRow(this.db.prepare(`
      SELECT record_json, state, claim_id, consumed_at, revoked_at
      FROM observed_subject_references
      WHERE subject_ref = ?
    `).get(subjectRef));
  },
  claimObservedSubjectReferences(input) {
    const claim = normalizeObservedSubjectClaim(input);
    return this.transaction(() => {
      const subjects = claim.subject_refs.map((subjectRef) => {
        const subject = this.getObservedSubjectReference(subjectRef);
        if (!subject) throw subjectReferenceUnavailable();
        assertObservedSubjectMatchesClaim(subject, claim);
        return subject;
      });
      for (const subject of subjects) {
        if (subject.state === "consumed") continue;
        const changed = this.db.prepare(`
          UPDATE observed_subject_references
          SET state = 'consumed', claim_id = ?, consumed_at = ?
          WHERE subject_ref = ? AND state = 'active'
        `).run(claim.claim_id, claim.now, subject.subject_ref);
        if (Number(changed.changes) !== 1) throw subjectReferenceUnavailable();
      }
      return subjects.map((subject) => subject.state === "consumed" ? subject : consumedObservedSubjectReference(subject, claim.claim_id, claim.now));
    });
  },
  revokeObservedSubjectReferences(input) {
    const revocation = normalizeObservedSubjectRevocation(input);
    return this.transaction(() => {
      const rows = this.db.prepare(`
        SELECT record_json, state, claim_id, consumed_at, revoked_at
        FROM observed_subject_references
        WHERE state = 'active'
      `).all();
      const requestedRefs = new Set(revocation.subject_refs);
      const selected = rows.map(fromRow).filter((subject) => subject !== void 0).filter((subject) => (requestedRefs.size === 0 || requestedRefs.has(subject.subject_ref)) && (!revocation.read_boundary_digest || subject.read_boundary_digest === revocation.read_boundary_digest) && (!revocation.action_boundary_digest || subject.outcome_authorities.some((authority2) => authority2.action_boundary_digest === revocation.action_boundary_digest)) && (!revocation.workflow_session_id || subject.workflow_session_id === revocation.workflow_session_id));
      let count = 0;
      for (const subject of selected) {
        const changed = this.db.prepare(`
          UPDATE observed_subject_references
          SET state = 'revoked', revoked_at = ?
          WHERE subject_ref = ? AND state = 'active'
        `).run(revocation.now, subject.subject_ref);
        count += Number(changed.changes);
      }
      return count;
    });
  }
};

// ../synapsor-runner/packages/proposal-store/src/sqlite-worker-methods.ts
var proposalStoreWorkersMethods = {
  enqueueWorkerProposal(options) {
    const proposal = this.requireProposal(options.proposal_id);
    if (proposal.state !== "approved" && proposal.state !== "pending_worker") {
      throw new ProposalStoreError(
        "WORKER_PROPOSAL_NOT_APPROVED",
        `proposal ${proposal.proposal_id} is ${proposal.state}, not approved for worker execution`
      );
    }
    const executionMode = options.execution_mode ?? "legacy";
    const contractDigest = options.contract_digest;
    const hasCancellationControlRole = Object.hasOwn(options, "cancellation_control_role");
    const cancellationControlRole = options.cancellation_control_role;
    if (hasCancellationControlRole && cancellationControlRole === void 0) {
      throw new ProposalStoreError(
        "WORKER_CANCEL_CONTROL_ROLE_SNAPSHOT_INVALID",
        "worker cancellation control role must be omitted for a legacy row or explicitly set to a role or null"
      );
    }
    if (executionMode === "supervised_worker" && !contractDigest) {
      throw new ProposalStoreError(
        "SUPERVISED_WORKER_DIGEST_REQUIRED",
        `supervised worker queue item ${proposal.proposal_id} requires an exact contract digest`
      );
    }
    if (contractDigest && !/^sha256:[a-f0-9]{64}$/.test(contractDigest)) {
      throw new ProposalStoreError("WORKER_CONTRACT_DIGEST_INVALID", "worker queue contract digest must be a full lowercase sha256 digest");
    }
    if (hasCancellationControlRole && cancellationControlRole != null && !/^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/.test(cancellationControlRole)) {
      throw new ProposalStoreError("WORKER_CANCEL_CONTROL_ROLE_INVALID", "worker cancellation control role must be a safe identifier");
    }
    const maxAttempts = Math.max(1, Math.min(options.max_attempts ?? 5, 100));
    const queueLimit = Math.max(1, Math.min(options.queue_limit ?? 1e4, 1e5));
    const now = options.now ?? (/* @__PURE__ */ new Date()).toISOString();
    this.transaction(() => {
      const existing = this.workerQueueItem(proposal.proposal_id);
      if (existing) {
        if (existing.execution_mode !== executionMode || existing.contract_digest !== contractDigest || existing.cancellation_control_role !== void 0 && (!hasCancellationControlRole || existing.cancellation_control_role !== cancellationControlRole)) {
          throw new ProposalStoreError(
            "WORKER_QUEUE_AUTHORITY_MISMATCH",
            `worker queue item ${proposal.proposal_id} already exists under different execution authority`
          );
        }
        return;
      }
      const active = this.db.prepare(`
          SELECT COUNT(*) AS count
          FROM worker_queue q
          JOIN proposals p ON p.proposal_id = q.proposal_id
          WHERE q.execution_mode = ?
            AND (? IS NULL OR q.contract_digest = ?)
            AND p.action = ?
            AND q.status IN ('queued', 'leased', 'retry_wait', 'blocked', 'reconciliation_required')
        `).get(executionMode, contractDigest ?? null, contractDigest ?? null, proposal.action);
      if (isRecord(active) && Number(active.count ?? 0) >= queueLimit) {
        throw new ProposalStoreError(
          "WORKER_QUEUE_LIMIT_EXCEEDED",
          `worker queue limit ${queueLimit} reached for ${proposal.action}`
        );
      }
      this.db.prepare(`
          INSERT INTO worker_queue (
            proposal_id, status, execution_mode, contract_digest, cancellation_control_role,
            cancellation_control_role_present, attempts,
            max_attempts, next_attempt_at, lease_owner, lease_id,
            lease_expires_at, last_error_code, terminal_outcome, created_at,
            updated_at
          ) VALUES (?, 'queued', ?, ?, ?, ?, 0, ?, ?, NULL, NULL, NULL, NULL, NULL, ?, ?)
        `).run(
        proposal.proposal_id,
        executionMode,
        contractDigest ?? null,
        hasCancellationControlRole ? cancellationControlRole ?? null : null,
        hasCancellationControlRole ? 1 : 0,
        maxAttempts,
        now,
        now,
        now
      );
      this.appendEvent(proposal.proposal_id, "writeback_worker_queued", "runner", {
        execution_mode: executionMode,
        contract_digest: contractDigest ?? null,
        max_attempts: maxAttempts
      });
    });
    return this.requireWorkerQueueItem(proposal.proposal_id);
  },
  enqueueApprovedForWorker(options = {}) {
    const maxAttempts = Math.max(1, Math.min(options.maxAttempts ?? 5, 100));
    const now = options.now ?? (/* @__PURE__ */ new Date()).toISOString();
    const proposals = [
      ...this.listProposals({ capability: options.capability, tenant: options.tenant, state: "approved" }),
      ...this.listProposals({ capability: options.capability, tenant: options.tenant, state: "pending_worker" })
    ].sort((left, right) => left.created_at.localeCompare(right.created_at)).slice(0, options.limit ?? Number.POSITIVE_INFINITY);
    this.transaction(() => {
      for (const proposal of proposals) {
        this.db.prepare(`
            INSERT OR IGNORE INTO worker_queue (
              proposal_id, status, execution_mode, contract_digest, attempts,
              max_attempts, next_attempt_at, lease_owner, lease_id,
              lease_expires_at, last_error_code, terminal_outcome, created_at,
              updated_at
            ) VALUES (?, 'queued', 'legacy', NULL, 0, ?, ?, NULL, NULL, NULL, NULL, NULL, ?, ?)
          `).run(proposal.proposal_id, maxAttempts, now, now, now);
      }
    });
    return proposals.map((proposal) => this.workerQueueItem(proposal.proposal_id)).filter((item) => item !== void 0);
  },
  claimWorkerItem(options) {
    const now = options.now ?? (/* @__PURE__ */ new Date()).toISOString();
    const leaseSeconds = Math.max(15, Math.min(options.leaseSeconds ?? 60, 3600));
    const leaseExpiresAt = new Date(Date.parse(now) + leaseSeconds * 1e3).toISOString();
    let claimed;
    this.transaction(() => {
      if (options.maxConcurrent !== void 0) {
        const maximum = Math.max(1, Math.min(options.maxConcurrent, 32));
        const active = this.db.prepare(`
            SELECT COUNT(*) AS count
            FROM worker_queue q
            JOIN proposals p ON p.proposal_id = q.proposal_id
            WHERE q.status = 'leased'
              AND q.lease_expires_at > ?
              AND (? IS NULL OR q.execution_mode = ?)
              AND (? IS NULL OR p.action = ?)
              AND (? IS NULL OR p.tenant_id = ?)
              AND (? IS NULL OR q.contract_digest = ?)
          `).get(
          now,
          options.executionMode ?? null,
          options.executionMode ?? null,
          options.capability ?? null,
          options.capability ?? null,
          options.tenant ?? null,
          options.tenant ?? null,
          options.contractDigest ?? null,
          options.contractDigest ?? null
        );
        if (isRecord(active) && Number(active.count ?? 0) >= maximum) return;
      }
      if (options.rateLimit) {
        const executions = Math.max(1, Math.min(options.rateLimit.executions, 1e5));
        const windowSeconds = Math.max(1, Math.min(options.rateLimit.windowSeconds, 86400));
        const windowStart = new Date(Date.parse(now) - windowSeconds * 1e3).toISOString();
        const recent = this.db.prepare(`
            SELECT COUNT(*) AS count
            FROM worker_queue q
            JOIN proposals p ON p.proposal_id = q.proposal_id
            WHERE q.status = 'completed'
              AND q.updated_at >= ?
              AND (? IS NULL OR q.execution_mode = ?)
              AND (? IS NULL OR p.action = ?)
              AND (? IS NULL OR p.tenant_id = ?)
              AND (? IS NULL OR q.contract_digest = ?)
          `).get(
          windowStart,
          options.executionMode ?? null,
          options.executionMode ?? null,
          options.capability ?? null,
          options.capability ?? null,
          options.tenant ?? null,
          options.tenant ?? null,
          options.contractDigest ?? null,
          options.contractDigest ?? null
        );
        if (isRecord(recent) && Number(recent.count ?? 0) >= executions) return;
      }
      const raw = this.db.prepare(`
          SELECT q.*
          FROM worker_queue q
          JOIN proposals p ON p.proposal_id = q.proposal_id
          WHERE (
            (q.status IN ('queued', 'retry_wait') AND q.next_attempt_at <= ?)
            OR (q.status = 'leased' AND q.lease_expires_at <= ?)
          )
            AND p.state IN ('approved', 'pending_worker', 'failed')
            AND (? IS NULL OR q.execution_mode = ?)
            AND (? IS NULL OR p.action = ?)
            AND (? IS NULL OR p.tenant_id = ?)
            AND (? IS NULL OR q.contract_digest = ?)
          ORDER BY q.next_attempt_at ASC, q.created_at ASC
          LIMIT 1
        `).get(
        now,
        now,
        options.executionMode ?? null,
        options.executionMode ?? null,
        options.capability ?? null,
        options.capability ?? null,
        options.tenant ?? null,
        options.tenant ?? null,
        options.contractDigest ?? null,
        options.contractDigest ?? null
      );
      const item = rowToWorkerQueueItem(raw);
      if (!item) return;
      const proposal = this.requireProposal(item.proposal_id);
      if (options.proposalTtlSeconds !== void 0) {
        const ttlSeconds = Math.max(60, Math.min(options.proposalTtlSeconds, 2592e3));
        const expiresAt = Date.parse(proposal.created_at) + ttlSeconds * 1e3;
        if (!Number.isFinite(expiresAt) || expiresAt <= Date.parse(now)) {
          this.blockQueuedWorkerItem(item, options.workerId, "SUPERVISED_WORKER_PROPOSAL_EXPIRED", now);
          return;
        }
      }
      if (options.policyExecution) {
        const trips = this.workerPolicyExecutionLimitTrips({
          proposal,
          policy: options.policyExecution.policy,
          limits: options.policyExecution.limits,
          now
        });
        if (trips.length > 0) {
          this.blockQueuedWorkerItem(
            item,
            options.workerId,
            "SUPERVISED_WORKER_POLICY_LIMIT_EXCEEDED",
            now,
            { policy: options.policyExecution.policy, tripped_limits: trips }
          );
          return;
        }
      }
      const leaseId = workerLeaseId(item.proposal_id, options.workerId, item.attempts + 1, now);
      this.db.prepare(`
          UPDATE worker_queue
          SET status = 'leased', attempts = attempts + 1, lease_owner = ?,
              lease_id = ?, lease_expires_at = ?, last_error_code = NULL,
              terminal_outcome = NULL, updated_at = ?
          WHERE proposal_id = ?
        `).run(options.workerId, leaseId, leaseExpiresAt, now, item.proposal_id);
      if (proposal.state === "failed") {
        this.db.prepare("UPDATE proposals SET state = 'pending_worker', updated_at = ? WHERE proposal_id = ?").run(now, item.proposal_id);
      }
      this.appendEvent(item.proposal_id, "writeback_worker_claimed", options.workerId, {
        attempt: item.attempts + 1,
        max_attempts: item.max_attempts,
        execution_mode: item.execution_mode,
        contract_digest: item.contract_digest ?? null,
        lease_id: leaseId,
        lease_expires_at: leaseExpiresAt
      });
      claimed = this.workerQueueItem(item.proposal_id);
    });
    return claimed;
  },
  assertWorkerPolicyExecutionLimits(input) {
    const proposal = this.requireProposal(input.proposalId);
    const trips = this.workerPolicyExecutionLimitTrips({
      proposal,
      policy: input.policy,
      limits: input.limits,
      now: input.now ?? (/* @__PURE__ */ new Date()).toISOString()
    });
    if (trips.length > 0) {
      throw new ProposalStoreError(
        "SUPERVISED_WORKER_POLICY_LIMIT_EXCEEDED",
        `execution-time policy limit no longer permits proposal ${proposal.proposal_id}`
      );
    }
  },
  blockQueuedWorkerItem(item, actor, errorCode, now, payload = {}) {
    this.db.prepare(`
        UPDATE worker_queue
        SET status = 'blocked', lease_owner = NULL, lease_id = NULL,
            lease_expires_at = NULL, last_error_code = ?,
            terminal_outcome = NULL, updated_at = ?
        WHERE proposal_id = ?
      `).run(errorCode, now, item.proposal_id);
    this.appendEvent(item.proposal_id, "writeback_worker_blocked", actor, {
      error_code: errorCode,
      execution_mode: item.execution_mode,
      contract_digest: item.contract_digest ?? null,
      ...payload
    });
  },
  workerPolicyExecutionLimitTrips(input) {
    if (input.limits.length === 0) return [];
    const actor = `policy:${input.policy}`;
    const candidateApproval = this.db.prepare(`
        SELECT approval_id
        FROM approvals
        WHERE proposal_id = ?
          AND approver = ?
          AND status = 'approved'
          AND proposal_hash = ?
          AND proposal_version = ?
        LIMIT 1
      `).get(
      input.proposal.proposal_id,
      actor,
      input.proposal.proposal_hash,
      input.proposal.proposal_version
    );
    if (!isRecord(candidateApproval)) return [];
    const window2 = utcDayWindow(input.now);
    const rows = this.db.prepare(`
        SELECT DISTINCT
          p.proposal_id,
          p.business_object,
          p.object_id,
          p.change_set_json
        FROM worker_queue q
        JOIN proposals p ON p.proposal_id = q.proposal_id
        JOIN approvals a ON a.proposal_id = p.proposal_id
        WHERE a.approver = ?
          AND a.status = 'approved'
          AND p.tenant_id = ?
          AND (
            (q.status = 'leased' AND q.lease_expires_at > ?)
            OR (
              q.status = 'completed'
              AND q.terminal_outcome IN ('applied', 'already_applied')
              AND q.updated_at >= ?
              AND q.updated_at < ?
            )
            OR (
              q.status = 'reconciliation_required'
              AND q.updated_at >= ?
              AND q.updated_at < ?
            )
            OR (
              p.state = 'applied'
              AND p.updated_at >= ?
              AND p.updated_at < ?
            )
          )
      `).all(
      actor,
      input.proposal.tenant_id,
      input.now,
      window2.start,
      window2.end,
      window2.start,
      window2.end,
      window2.start,
      window2.end
    );
    const active = /* @__PURE__ */ new Map();
    let invalidHistory = false;
    for (const row of rows) {
      if (!isRecord(row)) continue;
      try {
        const proposalId = String(row.proposal_id);
        active.set(proposalId, {
          proposal_id: proposalId,
          business_object: String(row.business_object),
          object_id: String(row.object_id),
          change_set: parseChangeSet(JSON.parse(String(row.change_set_json)))
        });
      } catch {
        invalidHistory = true;
        active.set(String(row.proposal_id), {
          proposal_id: String(row.proposal_id),
          business_object: String(row.business_object),
          object_id: String(row.object_id),
          change_set: input.proposal.change_set
        });
      }
    }
    active.set(input.proposal.proposal_id, {
      proposal_id: input.proposal.proposal_id,
      business_object: input.proposal.business_object,
      object_id: input.proposal.object_id,
      change_set: input.proposal.change_set
    });
    const trips = [];
    for (const limit of input.limits) {
      const scope2 = limit.scope ?? "tenant_policy";
      const scoped = [...active.values()].filter((proposal) => scope2 !== "tenant_policy_object" || proposal.business_object === input.proposal.business_object && proposal.object_id === input.proposal.object_id);
      if (limit.kind === "count") {
        const projected2 = scoped.length;
        if (projected2 > limit.max) {
          trips.push({
            ...limit,
            scope: scope2,
            observed: Math.max(0, projected2 - 1),
            proposed: 1,
            projected: projected2,
            window_start: window2.start,
            window_end: window2.end,
            reason: `${scope2} execution count ${projected2} exceeds ${limit.max}`
          });
        }
        continue;
      }
      const field = limit.field;
      let projected = 0;
      let proposed = 0;
      let invalid = !field || invalidHistory;
      for (const proposal of scoped) {
        const value = field ? proposal.change_set.patch[field] : void 0;
        if (typeof value !== "number" || !Number.isSafeInteger(value)) {
          invalid = true;
          continue;
        }
        projected += value;
        if (proposal.proposal_id === input.proposal.proposal_id) proposed = value;
      }
      if (invalid || projected > limit.max) {
        trips.push({
          ...limit,
          scope: scope2,
          observed: projected - proposed,
          proposed,
          projected,
          window_start: window2.start,
          window_end: window2.end,
          reason: invalid ? `${scope2} execution total could not be verified safely${field ? ` for ${field}` : ""}` : `${scope2} execution total ${projected} for ${field} exceeds ${limit.max}`
        });
      }
    }
    return trips;
  },
  assertActiveWorkerLease(options) {
    const now = options.now ?? (/* @__PURE__ */ new Date()).toISOString();
    const item = this.assertWorkerLease(options.proposalId, options.workerId, options.leaseId);
    if (!item.lease_expires_at || Date.parse(item.lease_expires_at) <= Date.parse(now)) {
      throw new ProposalStoreError("WORKER_LEASE_EXPIRED", `worker lease ${options.leaseId} for ${options.proposalId} has expired`);
    }
    return item;
  },
  renewWorkerLease(options) {
    const now = options.now ?? (/* @__PURE__ */ new Date()).toISOString();
    const leaseSeconds = Math.max(15, Math.min(options.leaseSeconds ?? 60, 3600));
    const leaseExpiresAt = new Date(Date.parse(now) + leaseSeconds * 1e3).toISOString();
    this.transaction(() => {
      this.assertActiveWorkerLease({ ...options, now });
      this.db.prepare(`
          UPDATE worker_queue
          SET lease_expires_at = ?, updated_at = ?
          WHERE proposal_id = ? AND status = 'leased' AND lease_owner = ? AND lease_id = ?
        `).run(leaseExpiresAt, now, options.proposalId, options.workerId, options.leaseId);
    });
    return this.requireWorkerQueueItem(options.proposalId);
  },
  completeWorkerItem(proposalId, workerId, outcome, now = (/* @__PURE__ */ new Date()).toISOString(), leaseId) {
    this.transaction(() => {
      this.assertWorkerLease(proposalId, workerId, leaseId);
      this.db.prepare(`
          UPDATE worker_queue
          SET status = 'completed', lease_owner = NULL, lease_id = NULL,
              lease_expires_at = NULL, last_error_code = NULL,
              terminal_outcome = ?, updated_at = ?
          WHERE proposal_id = ?
        `).run(outcome, now, proposalId);
      this.appendEvent(proposalId, "writeback_worker_completed", workerId, { outcome, lease_id: leaseId ?? null });
    });
    return this.requireWorkerQueueItem(proposalId);
  },
  retryWorkerItem(options) {
    const now = options.now ?? (/* @__PURE__ */ new Date()).toISOString();
    this.transaction(() => {
      const item = this.assertWorkerLease(options.proposalId, options.workerId, options.leaseId);
      const deadLetter = item.attempts >= item.max_attempts;
      this.db.prepare(`
          UPDATE worker_queue
          SET status = ?, next_attempt_at = ?, lease_owner = NULL, lease_id = NULL,
              lease_expires_at = NULL, last_error_code = ?, terminal_outcome = NULL,
              updated_at = ?
          WHERE proposal_id = ?
        `).run(deadLetter ? "dead_letter" : "retry_wait", options.retryAt, options.errorCode, now, options.proposalId);
      this.appendEvent(options.proposalId, deadLetter ? "writeback_dead_lettered" : "writeback_retry_scheduled", options.workerId, {
        attempt: item.attempts,
        max_attempts: item.max_attempts,
        error_code: options.errorCode,
        lease_id: options.leaseId ?? null,
        ...deadLetter ? {} : { retry_at: options.retryAt }
      });
    });
    return this.requireWorkerQueueItem(options.proposalId);
  },
  deadLetterWorkerItem(options) {
    const now = options.now ?? (/* @__PURE__ */ new Date()).toISOString();
    this.transaction(() => {
      const item = this.assertWorkerLease(options.proposalId, options.workerId, options.leaseId);
      this.db.prepare(`
          UPDATE worker_queue
          SET status = 'dead_letter', lease_owner = NULL, lease_id = NULL,
              lease_expires_at = NULL, last_error_code = ?,
              terminal_outcome = 'dead_letter', updated_at = ?
          WHERE proposal_id = ?
        `).run(options.errorCode, now, options.proposalId);
      this.appendEvent(options.proposalId, "writeback_dead_lettered", options.workerId, {
        attempt: item.attempts,
        max_attempts: item.max_attempts,
        error_code: options.errorCode,
        lease_id: options.leaseId ?? null
      });
    });
    return this.requireWorkerQueueItem(options.proposalId);
  },
  blockWorkerItem(options) {
    const now = options.now ?? (/* @__PURE__ */ new Date()).toISOString();
    this.transaction(() => {
      this.assertWorkerLease(options.proposalId, options.workerId, options.leaseId);
      this.db.prepare(`
          UPDATE worker_queue
          SET status = 'blocked', lease_owner = NULL, lease_id = NULL,
              lease_expires_at = NULL, last_error_code = ?,
              terminal_outcome = 'blocked', updated_at = ?
          WHERE proposal_id = ?
        `).run(options.errorCode, now, options.proposalId);
      this.appendEvent(options.proposalId, "writeback_worker_blocked", options.workerId, {
        error_code: options.errorCode,
        lease_id: options.leaseId
      });
    });
    return this.requireWorkerQueueItem(options.proposalId);
  },
  requireWorkerReconciliation(options) {
    const now = options.now ?? (/* @__PURE__ */ new Date()).toISOString();
    this.transaction(() => {
      this.assertWorkerLease(options.proposalId, options.workerId, options.leaseId);
      this.db.prepare(`
          UPDATE worker_queue
          SET status = 'reconciliation_required', lease_owner = NULL,
              lease_id = NULL, lease_expires_at = NULL, last_error_code = ?,
              terminal_outcome = 'reconciliation_required', updated_at = ?
          WHERE proposal_id = ?
        `).run(options.errorCode, now, options.proposalId);
      this.appendEvent(options.proposalId, "writeback_reconciliation_required", options.workerId, {
        safe_error_code: options.errorCode,
        lease_id: options.leaseId
      });
    });
    return this.requireWorkerQueueItem(options.proposalId);
  },
  cancelWorkerItem(options) {
    const now = options.now ?? (/* @__PURE__ */ new Date()).toISOString();
    const proposal = this.requireProposal(options.proposalId);
    const item = this.requireWorkerQueueItem(options.proposalId);
    assertOperatorDecision(
      proposal,
      "worker_cancel",
      options.actor,
      options.identity,
      options.require_verified_identity === true
    );
    if (item.cancellation_control_role && !options.identity?.roles.includes(item.cancellation_control_role)) {
      throw new ProposalStoreError(
        "WORKER_CANCEL_CONTROL_ROLE_REQUIRED",
        `operator ${options.actor} lacks required worker cancellation control role ${item.cancellation_control_role}`
      );
    }
    this.transaction(() => {
      const item2 = this.requireWorkerQueueItem(options.proposalId);
      if (item2.status !== "queued" && item2.status !== "retry_wait") {
        throw new ProposalStoreError(
          "WORKER_ITEM_NOT_CANCELLABLE",
          `worker queue item ${options.proposalId} is ${item2.status}, not safely cancellable before lease`
        );
      }
      this.db.prepare(`
          UPDATE worker_queue
          SET status = 'cancelled', lease_owner = NULL, lease_id = NULL,
              lease_expires_at = NULL, terminal_outcome = 'cancelled',
              updated_at = ?
          WHERE proposal_id = ?
        `).run(now, options.proposalId);
      if (proposal.state === "approved" || proposal.state === "pending_worker") {
        this.db.prepare(`
            UPDATE proposals
            SET state = 'canceled', updated_at = ?
            WHERE proposal_id = ?
          `).run(now, options.proposalId);
      }
      this.appendEvent(options.proposalId, "writeback_canceled", options.actor, {
        execution_mode: item2.execution_mode,
        contract_digest: item2.contract_digest ?? null,
        identity: options.identity ? publicIdentitySummary(options.identity) : null
      });
    });
    return this.requireWorkerQueueItem(options.proposalId);
  },
  listWorkerQueue(status) {
    const rows = status ? this.db.prepare("SELECT * FROM worker_queue WHERE status = ? ORDER BY created_at ASC").all(status) : this.db.prepare("SELECT * FROM worker_queue ORDER BY created_at ASC").all();
    return rows.map(rowToWorkerQueueItem).filter((item) => item !== void 0);
  },
  getWorkerQueueItem(proposalId) {
    return this.workerQueueItem(proposalId);
  },
  requeueDeadLetter(options) {
    const now = options.now ?? (/* @__PURE__ */ new Date()).toISOString();
    const retryBudget = Math.max(1, Math.min(options.retryBudget, 100));
    const proposal = this.requireProposal(options.proposalId);
    assertOperatorDecision(proposal, "worker_requeue", options.identity.subject, options.identity, true);
    this.transaction(() => {
      const item = this.requireWorkerQueueItem(options.proposalId);
      if (item.status !== "dead_letter") {
        throw new ProposalStoreError("WORKER_ITEM_NOT_DEAD_LETTER", `worker queue item ${options.proposalId} is ${item.status}`);
      }
      const provenEffect = this.receipts(options.proposalId).find((receipt2) => receipt2.source_database_mutated || receipt2.status === "applied" || receipt2.status === "already_applied");
      if (provenEffect) {
        throw new ProposalStoreError("DEAD_LETTER_EFFECT_ALREADY_RECORDED", `proposal ${options.proposalId} has a receipt proving the database effect already completed`);
      }
      this.db.prepare(`
          UPDATE worker_queue
          SET status = 'queued', attempts = 0, max_attempts = ?, next_attempt_at = ?,
              lease_owner = NULL, lease_id = NULL, lease_expires_at = NULL,
              last_error_code = NULL, terminal_outcome = NULL, updated_at = ?
          WHERE proposal_id = ?
        `).run(retryBudget, now, now, options.proposalId);
      if (proposal.state === "failed") {
        this.db.prepare("UPDATE proposals SET state = 'approved', updated_at = ? WHERE proposal_id = ?").run(now, options.proposalId);
      }
      this.appendEvent(options.proposalId, "writeback_dead_letter_requeued", options.identity.subject, {
        retry_budget: retryBudget,
        reason: options.reason ?? null,
        identity: publicIdentitySummary(options.identity)
      });
    });
    return this.requireWorkerQueueItem(options.proposalId);
  },
  discardDeadLetter(options) {
    const now = options.now ?? (/* @__PURE__ */ new Date()).toISOString();
    const proposal = this.requireProposal(options.proposalId);
    assertOperatorDecision(proposal, "worker_discard", options.identity.subject, options.identity, true);
    this.transaction(() => {
      const item = this.requireWorkerQueueItem(options.proposalId);
      if (item.status !== "dead_letter") {
        throw new ProposalStoreError("WORKER_ITEM_NOT_DEAD_LETTER", `worker queue item ${options.proposalId} is ${item.status}`);
      }
      this.db.prepare(`
          UPDATE worker_queue
          SET status = 'discarded', lease_owner = NULL, lease_id = NULL,
              lease_expires_at = NULL, terminal_outcome = 'discarded', updated_at = ?
          WHERE proposal_id = ?
        `).run(now, options.proposalId);
      this.appendEvent(options.proposalId, "writeback_dead_letter_discarded", options.identity.subject, {
        reason: options.reason,
        identity: publicIdentitySummary(options.identity)
      });
    });
    return this.requireWorkerQueueItem(options.proposalId);
  },
  workerQueueItem(proposalId) {
    return rowToWorkerQueueItem(this.db.prepare("SELECT * FROM worker_queue WHERE proposal_id = ?").get(proposalId));
  },
  requireWorkerQueueItem(proposalId) {
    const item = this.workerQueueItem(proposalId);
    if (!item) throw new ProposalStoreError("WORKER_ITEM_NOT_FOUND", `worker queue item not found for ${proposalId}`);
    return item;
  },
  assertWorkerLease(proposalId, workerId, leaseId) {
    if (!leaseId) {
      throw new ProposalStoreError(
        "WORKER_LEASE_ID_REQUIRED",
        `worker ${workerId} must present the exact lease id for ${proposalId}`
      );
    }
    const item = this.requireWorkerQueueItem(proposalId);
    if (item.status !== "leased" || item.lease_owner !== workerId || item.lease_id !== leaseId) {
      throw new ProposalStoreError("WORKER_LEASE_MISMATCH", `worker ${workerId} does not hold the lease for ${proposalId}`);
    }
    return item;
  }
};

// ../synapsor-runner/packages/proposal-store/src/sqlite-metrics-policy-methods.ts
var proposalStoreMetricsPolicyMethods = {
  operationalMetrics(filters = {}) {
    const rows = /* @__PURE__ */ new Map();
    const ensure = (tenantId, capability) => {
      const key2 = `${tenantId}\0${capability}`;
      let row = rows.get(key2);
      if (!row) {
        row = { tenant_id: tenantId, capability, proposals: 0, approvals: 0, rejections: 0, applies: 0, conflicts: 0, failures: 0, revert_proposals: 0, revert_applies: 0 };
        rows.set(key2, row);
      }
      return row;
    };
    for (const proposal of this.listProposals({ tenant: filters.tenant, capability: filters.capability })) {
      const row = ensure(proposal.tenant_id, proposal.action);
      row.proposals += 1;
      if (proposal.change_set.schema_version === protocolVersions.compensationChangeSet) row.revert_proposals += 1;
    }
    const approvalRows = this.db.prepare(`
        SELECT p.tenant_id, p.action, a.status, COUNT(*) AS count
        FROM approvals a JOIN proposals p ON p.proposal_id = a.proposal_id
        WHERE (? IS NULL OR p.tenant_id = ?) AND (? IS NULL OR p.action = ?)
        GROUP BY p.tenant_id, p.action, a.status
      `).all(filters.tenant ?? null, filters.tenant ?? null, filters.capability ?? null, filters.capability ?? null);
    for (const raw of approvalRows) {
      if (!isRecord(raw)) continue;
      const row = ensure(String(raw.tenant_id), String(raw.action));
      if (raw.status === "approved") row.approvals += Number(raw.count);
      if (raw.status === "rejected") row.rejections += Number(raw.count);
    }
    const receiptRows = this.db.prepare(`
        SELECT p.tenant_id, p.action, r.status, COUNT(*) AS count,
          SUM(CASE WHEN json_extract(p.change_set_json, '$.schema_version') = 'synapsor.compensation-change-set.v1' THEN 1 ELSE 0 END) AS revert_count
        FROM writeback_receipts r JOIN proposals p ON p.proposal_id = r.proposal_id
        WHERE (? IS NULL OR p.tenant_id = ?) AND (? IS NULL OR p.action = ?)
        GROUP BY p.tenant_id, p.action, r.status
      `).all(filters.tenant ?? null, filters.tenant ?? null, filters.capability ?? null, filters.capability ?? null);
    for (const raw of receiptRows) {
      if (!isRecord(raw)) continue;
      const row = ensure(String(raw.tenant_id), String(raw.action));
      const count = Number(raw.count);
      if (raw.status === "applied" || raw.status === "already_applied") row.applies += count;
      else if (raw.status === "conflict") row.conflicts += count;
      else if (raw.status === "failed") row.failures += count;
      if (raw.status === "applied" || raw.status === "already_applied") row.revert_applies += Number(raw.revert_count ?? 0);
    }
    return [...rows.values()].sort((left, right) => left.tenant_id.localeCompare(right.tenant_id) || left.capability.localeCompare(right.capability));
  },
  fleetEventMetrics(filters = {}) {
    const rows = /* @__PURE__ */ new Map();
    const ensure = (tenantId, capability) => {
      const key2 = `${tenantId}\0${capability}`;
      let row = rows.get(key2);
      if (!row) {
        row = {
          tenant_id: tenantId,
          capability,
          worker_retries: 0,
          dead_letters: 0,
          auto_approval_limit_trips: 0,
          freshness_checks: 0,
          freshness_fresh: 0,
          freshness_stale_target: 0,
          freshness_stale_supporting: 0,
          freshness_unavailable: 0,
          freshness_unsupported: 0,
          freshness_approval_blocked: 0,
          freshness_apply_blocked: 0
        };
        rows.set(key2, row);
      }
      return row;
    };
    const events = this.db.prepare(`
        SELECT p.tenant_id, p.action, e.kind, e.payload_json
        FROM proposal_events e JOIN proposals p ON p.proposal_id = e.proposal_id
        WHERE e.kind IN (
          'writeback_retry_scheduled',
          'writeback_dead_lettered',
          'policy_auto_approval_deferred',
          'proposal_freshness_checked',
          'proposal_approval_blocked_freshness',
          'writeback_conflict'
        )
          AND (? IS NULL OR p.tenant_id = ?)
          AND (? IS NULL OR p.action = ?)
      `).all(filters.tenant ?? null, filters.tenant ?? null, filters.capability ?? null, filters.capability ?? null);
    for (const raw of events) {
      if (!isRecord(raw)) continue;
      const row = ensure(String(raw.tenant_id), String(raw.action));
      if (raw.kind === "writeback_retry_scheduled") row.worker_retries += 1;
      if (raw.kind === "writeback_dead_lettered") row.dead_letters += 1;
      let payload = {};
      try {
        const parsed = JSON.parse(String(raw.payload_json));
        if (isRecord(parsed)) payload = parsed;
      } catch {
      }
      if (raw.kind === "proposal_freshness_checked") {
        row.freshness_checks += 1;
        const proof = isRecord(payload.proof) ? payload.proof : {};
        if (proof.result === "fresh") row.freshness_fresh += 1;
        if (proof.result === "unavailable") row.freshness_unavailable += 1;
        if (proof.result === "unsupported") row.freshness_unsupported += 1;
        if (proof.result === "stale") {
          const checks = Array.isArray(proof.checks) ? proof.checks.filter(isRecord) : [];
          if (checks.some((check) => check.kind === "target" && check.status === "stale")) row.freshness_stale_target += 1;
          if (checks.some((check) => check.kind === "supporting" && check.status === "stale")) row.freshness_stale_supporting += 1;
        }
      }
      if (raw.kind === "proposal_approval_blocked_freshness") row.freshness_approval_blocked += 1;
      if (raw.kind === "writeback_conflict" && /^FRESHNESS_/.test(String(payload.safe_error_code ?? ""))) row.freshness_apply_blocked += 1;
      if (raw.kind === "policy_auto_approval_deferred") {
        if (Array.isArray(payload.tripped_limits) && payload.tripped_limits.length > 0) row.auto_approval_limit_trips += 1;
      }
    }
    return [...rows.values()].sort((left, right) => left.tenant_id.localeCompare(right.tenant_id) || left.capability.localeCompare(right.capability));
  },
  receipts(proposalId) {
    const rows = this.db.prepare("SELECT * FROM writeback_receipts WHERE proposal_id = ? ORDER BY receipt_id ASC").all(proposalId);
    return rows.map(rowToReceipt).filter((receipt2) => receipt2 !== void 0);
  },
  replay(proposalId) {
    const proposal = this.requireProposal(proposalId);
    const replay = {
      replay_id: `replay_${proposalId}`,
      proposal,
      approvals: this.approvals(proposalId),
      events: this.events(proposalId),
      receipts: this.receipts(proposalId),
      query_audit: this.queryAudit(proposalId),
      evidence: this.evidence(proposalId),
      generated_at: (/* @__PURE__ */ new Date()).toISOString()
    };
    this.db.prepare(`
        INSERT OR REPLACE INTO replay_records (replay_id, proposal_id, payload_json, created_at)
        VALUES (?, ?, ?, ?)
      `).run(replay.replay_id, proposalId, JSON.stringify(replay), replay.generated_at);
    return replay;
  },
  createPolicyRecommendation(input) {
    const now = input.now ?? (/* @__PURE__ */ new Date()).toISOString();
    const identity = {
      tenant_id: input.tenant_id,
      capability: input.capability,
      policy: input.policy,
      base_contract_digest: input.base_contract_digest,
      current_threshold: input.current_threshold,
      proposed_threshold: input.proposed_threshold,
      evidence_proposal_ids: [...input.evidence_proposal_ids].sort(),
      created_at: now
    };
    const recommendationId = `ptr_${canonicalJsonDigest(identity).slice("sha256:".length, "sha256:".length + 20)}`;
    const unsigned = {
      schema_version: "synapsor.policy-recommendation.v1",
      recommendation_id: recommendationId,
      ...input.workspace_id ? { workspace_id: input.workspace_id } : {},
      ...input.project_id ? { project_id: input.project_id } : {},
      tenant_id: input.tenant_id,
      capability: input.capability,
      policy: input.policy,
      field: input.field,
      base_contract_digest: input.base_contract_digest,
      base_contract_version: input.base_contract_version,
      current_threshold: input.current_threshold,
      proposed_threshold: input.proposed_threshold,
      maximum_increment: input.maximum_increment,
      absolute_ceiling: input.absolute_ceiling,
      criteria: input.criteria,
      metrics: input.metrics,
      evidence_proposal_ids: [...input.evidence_proposal_ids].sort(),
      explanation: [...input.explanation],
      status: "pending_review",
      created_at: now,
      updated_at: now
    };
    const recommendation = { ...unsigned, integrity_hash: canonicalJsonDigest(unsigned) };
    assertPolicyRecommendationShape(recommendation);
    assertNoSecretMaterial(recommendation, "policy_recommendation");
    this.db.prepare(`
        INSERT INTO policy_recommendations (
          recommendation_id, tenant_id, capability, policy, base_contract_digest,
          status, payload_json, integrity_hash, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
      recommendation.recommendation_id,
      recommendation.tenant_id,
      recommendation.capability,
      recommendation.policy,
      recommendation.base_contract_digest,
      recommendation.status,
      JSON.stringify(policyRecommendationUnsigned(recommendation)),
      recommendation.integrity_hash,
      recommendation.created_at,
      recommendation.updated_at
    );
    return recommendation;
  },
  getPolicyRecommendation(recommendationId) {
    return rowToPolicyRecommendation(this.db.prepare("SELECT * FROM policy_recommendations WHERE recommendation_id = ?").get(recommendationId));
  },
  listPolicyRecommendations(filters = {}) {
    const clauses = [];
    const params = [];
    for (const [column, value] of [["tenant_id", filters.tenant], ["capability", filters.capability], ["policy", filters.policy], ["status", filters.status]]) {
      if (!value) continue;
      clauses.push(`${column} = ?`);
      params.push(value);
    }
    const sql = `SELECT * FROM policy_recommendations${clauses.length ? ` WHERE ${clauses.join(" AND ")}` : ""} ORDER BY created_at DESC, recommendation_id DESC`;
    return this.db.prepare(sql).all(...params).map(rowToPolicyRecommendation).filter((item) => item !== void 0);
  },
  decidePolicyRecommendation(recommendationId, input) {
    const recommendation = this.requirePolicyRecommendation(recommendationId);
    if (recommendation.status !== "pending_review") throw new ProposalStoreError("POLICY_RECOMMENDATION_NOT_PENDING", `policy recommendation ${recommendationId} is ${recommendation.status}`);
    assertPolicyRecommendationIdentity(recommendation, input);
    const now = input.now ?? (/* @__PURE__ */ new Date()).toISOString();
    const unsigned = {
      ...policyRecommendationUnsigned(recommendation),
      status: input.action === "approve" ? "approved" : "rejected",
      decision: { actor: input.actor, action: input.action, reason: input.reason, identity: input.identity, decided_at: now },
      updated_at: now
    };
    const updated = { ...unsigned, integrity_hash: canonicalJsonDigest(unsigned) };
    this.db.prepare("UPDATE policy_recommendations SET status = ?, payload_json = ?, integrity_hash = ?, updated_at = ? WHERE recommendation_id = ?").run(updated.status, JSON.stringify(unsigned), updated.integrity_hash, now, recommendationId);
    return updated;
  },
  markPolicyRecommendationExported(recommendationId, input) {
    const recommendation = this.requirePolicyRecommendation(recommendationId);
    if (recommendation.status !== "approved") throw new ProposalStoreError("POLICY_RECOMMENDATION_NOT_APPROVED", `policy recommendation ${recommendationId} is ${recommendation.status}`);
    if (!/^sha256:[a-f0-9]{64}$/.test(input.artifact_digest)) throw new ProposalStoreError("POLICY_ARTIFACT_DIGEST_INVALID", "policy recommendation export requires a canonical SHA-256 artifact digest");
    const now = input.now ?? (/* @__PURE__ */ new Date()).toISOString();
    const unsigned = {
      ...policyRecommendationUnsigned(recommendation),
      status: "exported",
      export: { actor: input.actor, artifact_digest: input.artifact_digest, exported_at: now },
      updated_at: now
    };
    const updated = { ...unsigned, integrity_hash: canonicalJsonDigest(unsigned) };
    this.db.prepare("UPDATE policy_recommendations SET status = ?, payload_json = ?, integrity_hash = ?, updated_at = ? WHERE recommendation_id = ?").run(updated.status, JSON.stringify(unsigned), updated.integrity_hash, now, recommendationId);
    return updated;
  },
  requirePolicyRecommendation(recommendationId) {
    const recommendation = this.getPolicyRecommendation(recommendationId);
    if (!recommendation) throw new ProposalStoreError("POLICY_RECOMMENDATION_NOT_FOUND", `policy recommendation not found: ${recommendationId}`);
    return recommendation;
  }
};

// ../synapsor-runner/packages/proposal-store/src/sqlite-attention-methods.ts
var proposalStoreAttentionMethods = {
  recordAttentionEvent(input) {
    let event;
    const record2 = () => {
      event = this.recordAttentionEventInternal(input);
    };
    if (this.db.isTransaction) record2();
    else this.transaction(record2);
    if (!event) throw new ProposalStoreError("ATTENTION_EVENT_CREATE_FAILED", "attention event was not persisted");
    return event;
  },
  listAttentionEvents(filters = {}) {
    const clauses = [];
    const params = [];
    if (filters.event_type) {
      clauses.push("event_type = ?");
      params.push(filters.event_type);
    }
    if (filters.severity) {
      clauses.push("severity = ?");
      params.push(filters.severity);
    }
    if (filters.proposal_id) {
      clauses.push("proposal_id = ?");
      params.push(filters.proposal_id);
    }
    if (filters.capability) {
      clauses.push("capability = ?");
      params.push(filters.capability);
    }
    if (filters.tenant) {
      clauses.push("EXISTS (SELECT 1 FROM proposals p WHERE p.proposal_id = attention_events.proposal_id AND p.tenant_id = ?)");
      params.push(filters.tenant);
    }
    if (filters.principal) {
      clauses.push("EXISTS (SELECT 1 FROM proposals p WHERE p.proposal_id = attention_events.proposal_id AND p.principal = ?)");
      params.push(filters.principal);
    }
    if (filters.from) {
      clauses.push("occurred_at >= ?");
      params.push(filters.from);
    }
    const limit = Math.max(1, Math.min(filters.limit ?? 200, 1e3));
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    return this.db.prepare(`
        SELECT *
        FROM attention_events
        ${where}
        ORDER BY occurred_at DESC, event_id DESC
        LIMIT ?
      `).all(...params, limit).map(rowToAttentionEvent).filter((event) => event !== void 0);
  },
  getAttentionEvent(eventId) {
    return rowToAttentionEvent(
      this.db.prepare("SELECT * FROM attention_events WHERE event_id = ?").get(eventId)
    );
  },
  listAttentionItems(filters = {}) {
    const clauses = [];
    const params = [];
    if (filters.status) {
      clauses.push("status = ?");
      params.push(filters.status);
    }
    if (filters.severity) {
      clauses.push("severity = ?");
      params.push(filters.severity);
    }
    if (filters.capability) {
      clauses.push("capability = ?");
      params.push(filters.capability);
    }
    if (filters.tenant) {
      clauses.push(`EXISTS (
          SELECT 1
          FROM attention_events ae
          JOIN proposals p ON p.proposal_id = ae.proposal_id
          WHERE ae.attention_key = attention_items.attention_key
            AND p.tenant_id = ?
        )`);
      params.push(filters.tenant);
    }
    if (filters.principal) {
      clauses.push(`EXISTS (
          SELECT 1
          FROM attention_events ae
          JOIN proposals p ON p.proposal_id = ae.proposal_id
          WHERE ae.attention_key = attention_items.attention_key
            AND p.principal = ?
        )`);
      params.push(filters.principal);
    }
    const limit = Math.max(1, Math.min(filters.limit ?? 200, 1e3));
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    return this.db.prepare(`
        SELECT *
        FROM attention_items
        ${where}
        ORDER BY
          CASE severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END,
          last_seen_at DESC,
          attention_id DESC
        LIMIT ?
      `).all(...params, limit).map(rowToAttentionItem).filter((item) => item !== void 0);
  },
  getAttentionItem(attentionId) {
    return rowToAttentionItem(this.db.prepare("SELECT * FROM attention_items WHERE attention_id = ?").get(attentionId));
  },
  acknowledgeAttention(input) {
    const actor = boundedSafeLabel(input.actor, "attention acknowledgement actor", 256);
    const now = input.now ?? (/* @__PURE__ */ new Date()).toISOString();
    this.transaction(() => {
      const item = this.requireAttentionItem(input.attention_id);
      if (item.status !== "open") {
        throw new ProposalStoreError("ATTENTION_ITEM_NOT_ACKNOWLEDGEABLE", `attention item ${item.attention_id} is ${item.status}`);
      }
      assertAttentionOperatorDecision(
        item,
        actor,
        input.identity,
        input.require_verified_identity === true
      );
      this.db.prepare(`
          UPDATE attention_items
          SET status = 'acknowledged', acknowledged_by = ?, acknowledged_at = ?,
              acknowledgement_identity_json = ?,
              acknowledgement_decision_hash = ?,
              acknowledgement_signature = ?,
              acknowledgement_integrity_hash = ?,
              last_seen_at = MAX(last_seen_at, ?)
          WHERE attention_id = ?
        `).run(
        actor,
        now,
        input.identity ? JSON.stringify(input.identity) : null,
        input.identity?.decision_hash ?? null,
        input.identity?.signature ?? null,
        input.identity?.integrity_hash ?? null,
        now,
        item.attention_id
      );
    });
    return this.requireAttentionItem(input.attention_id);
  },
  resolveAttention(input) {
    const now = input.now ?? (/* @__PURE__ */ new Date()).toISOString();
    this.transaction(() => {
      const item = this.requireAttentionItem(input.attention_id);
      if (item.status === "expired") {
        throw new ProposalStoreError("ATTENTION_ITEM_NOT_RESOLVABLE", `attention item ${item.attention_id} is expired`);
      }
      this.db.prepare(`
          UPDATE attention_items
          SET status = 'resolved', resolved_at = ?, last_seen_at = MAX(last_seen_at, ?)
          WHERE attention_id = ?
        `).run(now, now, item.attention_id);
    });
    return this.requireAttentionItem(input.attention_id);
  },
  enqueueNotificationDelivery(input) {
    const sinkId = boundedSinkId(input.sink_id);
    const event = this.requireAttentionEvent(input.event_id);
    const attention = input.attention_id ? this.requireAttentionItem(input.attention_id) : void 0;
    if (attention && event.attention_key !== attention.attention_key) {
      throw new ProposalStoreError(
        "NOTIFICATION_ATTENTION_MISMATCH",
        `attention event ${event.event_id} does not belong to attention item ${attention.attention_id}`
      );
    }
    const maxAttempts = Math.max(1, Math.min(input.max_attempts ?? 5, 100));
    const status = input.status ?? "pending";
    const now = input.now ?? (/* @__PURE__ */ new Date()).toISOString();
    if (!Number.isFinite(Date.parse(now))) {
      throw new ProposalStoreError("NOTIFICATION_TIME_INVALID", "notification delivery time must be an ISO timestamp");
    }
    const nextAttemptAt = input.next_attempt_at ?? now;
    if (!Number.isFinite(Date.parse(nextAttemptAt))) {
      throw new ProposalStoreError(
        "NOTIFICATION_TIME_INVALID",
        "notification delivery next-attempt time must be an ISO timestamp"
      );
    }
    const deliveryId = notificationDeliveryId(sinkId, event.event_id);
    this.transaction(() => {
      const existing = this.getNotificationDelivery(deliveryId);
      if (existing) {
        if (existing.sink_id !== sinkId || existing.event_id !== event.event_id || existing.attention_id !== attention?.attention_id) {
          throw new ProposalStoreError(
            "NOTIFICATION_DELIVERY_IDEMPOTENCY_MISMATCH",
            `notification delivery ${deliveryId} already exists with different immutable routing`
          );
        }
        return;
      }
      this.db.prepare(`
          INSERT INTO notification_deliveries (
            delivery_id, sink_id, event_id, attention_id, status, attempts,
            max_attempts, next_attempt_at, lease_owner, lease_id,
            lease_expires_at, last_error_code, external_reference, delivered_at,
            created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, 0, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?)
        `).run(
        deliveryId,
        sinkId,
        event.event_id,
        attention?.attention_id ?? null,
        status,
        maxAttempts,
        nextAttemptAt,
        now,
        now
      );
    });
    return this.requireNotificationDelivery(deliveryId);
  },
  includeNotificationDeliveriesInDigest(input) {
    const sinkId = boundedSinkId(input.sink_id);
    const deliveryIds = [...new Set(input.delivery_ids)];
    if (deliveryIds.length === 0 || deliveryIds.length > 1e3) {
      throw new ProposalStoreError(
        "NOTIFICATION_DIGEST_MEMBERS_INVALID",
        "a notification digest must contain from 1 through 1000 delivery ids"
      );
    }
    const digestEvent = this.requireAttentionEvent(input.digest_event_id);
    if (digestEvent.event_type !== "notification.digest") {
      throw new ProposalStoreError(
        "NOTIFICATION_DIGEST_EVENT_INVALID",
        "notification digest membership requires a notification.digest event"
      );
    }
    const now = input.now ?? (/* @__PURE__ */ new Date()).toISOString();
    if (!Number.isFinite(Date.parse(now))) {
      throw new ProposalStoreError("NOTIFICATION_TIME_INVALID", "notification digest time must be an ISO timestamp");
    }
    let included = 0;
    this.transaction(() => {
      for (const deliveryId of deliveryIds) {
        const item = this.requireNotificationDelivery(deliveryId);
        const digestReference = `digest:${digestEvent.event_id}`;
        if (item.status === "suppressed" && item.sink_id === sinkId && item.external_reference === digestReference) {
          continue;
        }
        if (item.sink_id !== sinkId || item.status !== "batched") {
          throw new ProposalStoreError(
            "NOTIFICATION_DIGEST_MEMBER_STATE_INVALID",
            `notification delivery ${deliveryId} is not a batched member of sink ${sinkId}`
          );
        }
        this.db.prepare(`
            UPDATE notification_deliveries
            SET status = 'suppressed', external_reference = ?, updated_at = ?
            WHERE delivery_id = ?
          `).run(digestReference, now, deliveryId);
        included += 1;
      }
    });
    return included;
  },
  claimNotificationDeliveries(input) {
    const owner = boundedSafeLabel(input.owner, "notification dispatcher identity", 128);
    const sinkId = input.sink_id ? boundedSinkId(input.sink_id) : void 0;
    const limit = Math.max(1, Math.min(input.limit ?? 20, 100));
    const leaseSeconds = Math.max(15, Math.min(input.lease_seconds ?? 60, 3600));
    const now = input.now ?? (/* @__PURE__ */ new Date()).toISOString();
    if (!Number.isFinite(Date.parse(now))) {
      throw new ProposalStoreError("NOTIFICATION_TIME_INVALID", "notification claim time must be an ISO timestamp");
    }
    const leaseExpiresAt = new Date(Date.parse(now) + leaseSeconds * 1e3).toISOString();
    const claimed = [];
    this.transaction(() => {
      const rows = this.db.prepare(`
          SELECT *
          FROM notification_deliveries
          WHERE (
            (status IN ('pending', 'retry_wait') AND next_attempt_at <= ?)
            OR (status = 'leased' AND lease_expires_at <= ?)
          )
            AND (? IS NULL OR sink_id = ?)
          ORDER BY next_attempt_at ASC, created_at ASC, delivery_id ASC
          LIMIT ?
        `).all(now, now, sinkId ?? null, sinkId ?? null, limit);
      for (const row of rows) {
        const item = rowToNotificationDelivery(row);
        if (!item) continue;
        const leaseId = notificationLeaseId(item.delivery_id, owner, item.attempts + 1, now);
        this.db.prepare(`
            UPDATE notification_deliveries
            SET status = 'leased', attempts = attempts + 1, lease_owner = ?,
                lease_id = ?, lease_expires_at = ?, last_error_code = NULL,
                updated_at = ?
            WHERE delivery_id = ?
          `).run(owner, leaseId, leaseExpiresAt, now, item.delivery_id);
        claimed.push(this.requireNotificationDelivery(item.delivery_id));
      }
    });
    return claimed;
  },
  completeNotificationDelivery(input) {
    const now = input.now ?? (/* @__PURE__ */ new Date()).toISOString();
    const externalReference = input.external_reference ? boundedSafeLabel(input.external_reference, "notification external reference", 256) : void 0;
    this.transaction(() => {
      this.assertNotificationLease(input.delivery_id, input.owner, input.lease_id, now);
      this.db.prepare(`
          UPDATE notification_deliveries
          SET status = 'delivered', lease_owner = NULL, lease_id = NULL,
              lease_expires_at = NULL, last_error_code = NULL,
              external_reference = COALESCE(?, external_reference),
              delivered_at = ?, updated_at = ?
          WHERE delivery_id = ?
        `).run(externalReference ?? null, now, now, input.delivery_id);
    });
    return this.requireNotificationDelivery(input.delivery_id);
  },
  failNotificationDelivery(input) {
    const now = input.now ?? (/* @__PURE__ */ new Date()).toISOString();
    const errorCode = boundedSafeErrorCode(input.error_code);
    this.transaction(() => {
      const item = this.assertNotificationLease(input.delivery_id, input.owner, input.lease_id, now);
      const retryable = input.retryable && item.attempts < item.max_attempts;
      const retryAt = retryable ? input.retry_at ?? new Date(Date.parse(now) + 1e3).toISOString() : now;
      if (!Number.isFinite(Date.parse(retryAt))) {
        throw new ProposalStoreError("NOTIFICATION_RETRY_TIME_INVALID", "notification retry time must be an ISO timestamp");
      }
      this.db.prepare(`
          UPDATE notification_deliveries
          SET status = ?, next_attempt_at = ?, lease_owner = NULL, lease_id = NULL,
              lease_expires_at = NULL, last_error_code = ?, updated_at = ?
          WHERE delivery_id = ?
        `).run(retryable ? "retry_wait" : "dead_letter", retryAt, errorCode, now, input.delivery_id);
    });
    return this.requireNotificationDelivery(input.delivery_id);
  },
  listNotificationDeliveries(filters = {}) {
    const clauses = [];
    const params = [];
    for (const [column, value] of [
      ["status", filters.status],
      ["sink_id", filters.sink_id],
      ["event_id", filters.event_id],
      ["attention_id", filters.attention_id]
    ]) {
      if (!value) continue;
      clauses.push(`${column} = ?`);
      params.push(value);
    }
    const limit = Math.max(1, Math.min(filters.limit ?? 200, 1e3));
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    return this.db.prepare(`
        SELECT *
        FROM notification_deliveries
        ${where}
        ORDER BY created_at DESC, delivery_id DESC
        LIMIT ?
      `).all(...params, limit).map(rowToNotificationDelivery).filter((delivery) => delivery !== void 0);
  },
  getNotificationDelivery(deliveryId) {
    return rowToNotificationDelivery(
      this.db.prepare("SELECT * FROM notification_deliveries WHERE delivery_id = ?").get(deliveryId)
    );
  },
  requeueNotificationDelivery(input) {
    const now = input.now ?? (/* @__PURE__ */ new Date()).toISOString();
    const reason = boundedSafeLabel(input.reason, "notification replay reason", 256);
    this.transaction(() => {
      const item = this.requireNotificationDelivery(input.delivery_id);
      if (!["dead_letter", "suppressed", "batched"].includes(item.status)) {
        throw new ProposalStoreError(
          "NOTIFICATION_DELIVERY_NOT_REQUEUEABLE",
          `notification delivery ${item.delivery_id} is ${item.status}`
        );
      }
      assertNotificationReplayOperatorDecision(item, input.identity, reason);
      const event = this.requireAttentionEvent(item.event_id);
      this.db.prepare(`
          UPDATE notification_deliveries
          SET status = 'pending', attempts = 0, next_attempt_at = ?,
              lease_owner = NULL, lease_id = NULL, lease_expires_at = NULL,
              last_error_code = NULL, delivered_at = NULL, updated_at = ?
          WHERE delivery_id = ?
        `).run(now, now, item.delivery_id);
      this.recordAttentionEventInternal({
        event_type: "notification.replayed",
        severity: "informational",
        environment: event.environment,
        ...event.proposal_id ? { proposal_id: event.proposal_id } : {},
        ...event.job_id ? { job_id: event.job_id } : {},
        ...event.operation_id ? { operation_id: event.operation_id } : {},
        ...event.correlation_id ? { correlation_id: event.correlation_id } : {},
        ...event.capability ? { capability: event.capability } : {},
        ...event.contract_digest ? { contract_digest: event.contract_digest } : {},
        attention_required: false,
        immediate_default: false,
        summary: `Notification delivery ${item.delivery_id} requeued by a verified operator`,
        ...event.workbench_path ? { workbench_path: event.workbench_path } : {},
        details: {
          delivery_id: item.delivery_id,
          sink_id: item.sink_id,
          replayed_event_id: item.event_id,
          operator_subject: input.identity.subject,
          identity_provider: input.identity.provider,
          operator_decision_hash: input.identity.decision_hash,
          reason,
          approval_replayed: false,
          mutation_replayed: false,
          source_database_changed: false
        },
        source_event_key: `notification-replay:${item.delivery_id}:${input.identity.decision_hash}`,
        now
      });
    });
    return this.requireNotificationDelivery(input.delivery_id);
  },
  recordAttentionEventInternal(input) {
    assertAttentionEventInput(input);
    const occurredAt = input.now ?? (/* @__PURE__ */ new Date()).toISOString();
    const environment = boundedSafeLabel(input.environment, "attention environment", 64);
    const capability = input.capability ? boundedSafeLabel(input.capability, "attention capability", 256) : void 0;
    const contractDigest = input.contract_digest;
    const attentionRequired = input.attention_required ?? defaultAttentionEventTypes.has(input.event_type);
    const immediateDefault = input.immediate_default ?? defaultImmediateAttentionEventTypes.has(input.event_type);
    const details = Object.fromEntries(
      Object.entries(input.details ?? {}).sort(([left], [right]) => left.localeCompare(right))
    );
    const sourceEventKey = input.source_event_key ? boundedSafeLabel(input.source_event_key, "attention source event key", 512) : canonicalJsonDigest({
      event_type: input.event_type,
      occurred_at: occurredAt,
      proposal_id: input.proposal_id ?? null,
      job_id: input.job_id ?? null,
      operation_id: input.operation_id ?? null,
      capability: capability ?? null,
      details
    });
    const eventId = attentionEventId(sourceEventKey, input.event_type);
    const attentionKey = attentionRequired ? boundedSafeLabel(
      input.attention_key ?? defaultAttentionKey({
        environment,
        event_type: input.event_type,
        capability,
        contract_digest: contractDigest,
        details
      }),
      "attention coalescing key",
      512
    ) : void 0;
    const unsigned = {
      schema_version: "synapsor.attention-event.v1",
      event_id: eventId,
      event_type: input.event_type,
      severity: input.severity,
      occurred_at: occurredAt,
      environment,
      ...input.proposal_id ? { proposal_id: boundedSafeLabel(input.proposal_id, "attention proposal id", 256) } : {},
      ...input.job_id ? { job_id: boundedSafeLabel(input.job_id, "attention job id", 256) } : {},
      ...input.operation_id ? { operation_id: boundedSafeLabel(input.operation_id, "attention operation id", 256) } : {},
      ...input.correlation_id ? { correlation_id: boundedSafeLabel(input.correlation_id, "attention correlation id", 256) } : {},
      ...capability ? { capability } : {},
      ...contractDigest ? { contract_digest: contractDigest } : {},
      ...attentionKey ? { attention_key: attentionKey } : {},
      attention_required: attentionRequired,
      immediate_default: immediateDefault,
      summary: boundedSafeLabel(input.summary ?? attentionEventTitle(input.event_type), "attention summary", 512),
      ...input.approval_source ? { approval_source: input.approval_source } : {},
      ...input.worker_state ? { worker_state: boundedSafeLabel(input.worker_state, "attention worker state", 128) } : {},
      ...input.failure_class ? { failure_class: boundedSafeLabel(input.failure_class, "attention failure class", 128) } : {},
      ...input.expires_at ? { expires_at: input.expires_at } : {},
      ...input.workbench_path ? { workbench_path: boundedWorkbenchPath(input.workbench_path) } : {},
      details
    };
    assertNoSecretMaterial(unsigned, `attention_event.${eventId}`);
    const event = {
      ...unsigned,
      payload_hash: canonicalJsonDigest(unsigned)
    };
    const existing = rowToAttentionEvent(this.db.prepare("SELECT * FROM attention_events WHERE event_id = ?").get(eventId));
    if (existing) {
      if (existing.payload_hash !== event.payload_hash) {
        throw new ProposalStoreError(
          "ATTENTION_EVENT_IDEMPOTENCY_MISMATCH",
          `attention event ${eventId} already exists with different immutable content`
        );
      }
      return existing;
    }
    this.db.prepare(`
        INSERT INTO attention_events (
          event_id, schema_version, event_type, severity, occurred_at, environment,
          proposal_id, job_id, operation_id, correlation_id, capability,
          contract_digest, attention_key, attention_required, immediate_default,
          summary, approval_source, worker_state, failure_class, expires_at,
          workbench_path, details_json, payload_hash, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
      event.event_id,
      event.schema_version,
      event.event_type,
      event.severity,
      event.occurred_at,
      event.environment,
      event.proposal_id ?? null,
      event.job_id ?? null,
      event.operation_id ?? null,
      event.correlation_id ?? null,
      event.capability ?? null,
      event.contract_digest ?? null,
      event.attention_key ?? null,
      event.attention_required ? 1 : 0,
      event.immediate_default ? 1 : 0,
      event.summary,
      event.approval_source ?? null,
      event.worker_state ?? null,
      event.failure_class ?? null,
      event.expires_at ?? null,
      event.workbench_path ?? null,
      JSON.stringify(event.details),
      event.payload_hash,
      event.occurred_at
    );
    if (event.attention_required && event.attention_key) this.projectAttentionItem(event);
    if (event.proposal_id && event.event_type === "proposal.expired") {
      this.closeProposalExpiryAttention(event, "expired");
    } else if (event.proposal_id && (event.event_type === "proposal.applied" || event.event_type === "proposal.cancelled" || event.event_type === "proposal.refused")) {
      this.closeProposalExpiryAttention(event, "resolved");
    }
    return event;
  },
  closeProposalExpiryAttention(event, status) {
    if (!event.proposal_id) return;
    this.db.prepare(`
        UPDATE attention_items
        SET status = ?,
            event_type = ?,
            title = ?,
            latest_event_id = ?,
            resolved_at = CASE WHEN ? = 'resolved' THEN ? ELSE NULL END,
            last_seen_at = MAX(last_seen_at, ?)
        WHERE status IN ('open', 'acknowledged')
          AND attention_key IN (
            SELECT DISTINCT attention_key
            FROM attention_events
            WHERE proposal_id = ?
              AND event_type = 'proposal.expiring'
              AND attention_key IS NOT NULL
          )
      `).run(
      status,
      event.event_type,
      event.summary,
      event.event_id,
      status,
      event.occurred_at,
      event.occurred_at,
      event.proposal_id
    );
  },
  projectAttentionItem(event) {
    const attentionKey = event.attention_key;
    if (!attentionKey) return;
    const existing = rowToAttentionItem(this.db.prepare("SELECT * FROM attention_items WHERE attention_key = ?").get(attentionKey));
    if (!existing) {
      this.db.prepare(`
          INSERT INTO attention_items (
            attention_id, attention_key, status, severity, environment, event_type,
            capability, contract_digest, title, occurrence_count, first_event_id,
            latest_event_id, first_seen_at, last_seen_at, acknowledged_by,
            acknowledged_at, resolved_at, expires_at
          ) VALUES (?, ?, 'open', ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, NULL, NULL, NULL, ?)
        `).run(
        attentionItemId(attentionKey),
        attentionKey,
        event.severity,
        event.environment,
        event.event_type,
        event.capability ?? null,
        event.contract_digest ?? null,
        event.summary,
        event.event_id,
        event.event_id,
        event.occurred_at,
        event.occurred_at,
        event.expires_at ?? null
      );
      return;
    }
    const severity = attentionSeverityRank(event.severity) > attentionSeverityRank(existing.severity) ? event.severity : existing.severity;
    this.db.prepare(`
        UPDATE attention_items
        SET status = 'open', severity = ?, event_type = ?, title = ?,
            occurrence_count = occurrence_count + 1, latest_event_id = ?,
            last_seen_at = ?, acknowledged_by = NULL, acknowledged_at = NULL,
            acknowledgement_identity_json = NULL,
            acknowledgement_decision_hash = NULL,
            acknowledgement_signature = NULL,
            acknowledgement_integrity_hash = NULL,
            resolved_at = NULL,
            expires_at = COALESCE(?, expires_at)
        WHERE attention_id = ?
      `).run(
      severity,
      event.event_type,
      event.summary,
      event.event_id,
      event.occurred_at,
      event.expires_at ?? null,
      existing.attention_id
    );
  },
  requireAttentionItem(attentionId) {
    const item = this.getAttentionItem(attentionId);
    if (!item) throw new ProposalStoreError("ATTENTION_ITEM_NOT_FOUND", `attention item not found: ${attentionId}`);
    return item;
  },
  requireAttentionEvent(eventId) {
    const event = rowToAttentionEvent(this.db.prepare("SELECT * FROM attention_events WHERE event_id = ?").get(eventId));
    if (!event) throw new ProposalStoreError("ATTENTION_EVENT_NOT_FOUND", `attention event not found: ${eventId}`);
    return event;
  },
  requireNotificationDelivery(deliveryId) {
    const delivery = this.getNotificationDelivery(deliveryId);
    if (!delivery) {
      throw new ProposalStoreError("NOTIFICATION_DELIVERY_NOT_FOUND", `notification delivery not found: ${deliveryId}`);
    }
    return delivery;
  },
  assertNotificationLease(deliveryId, owner, leaseId, now) {
    const item = this.requireNotificationDelivery(deliveryId);
    if (item.status !== "leased" || item.lease_owner !== owner || item.lease_id !== leaseId) {
      throw new ProposalStoreError(
        "NOTIFICATION_LEASE_MISMATCH",
        `dispatcher ${owner} does not hold lease ${leaseId} for ${deliveryId}`
      );
    }
    if (!item.lease_expires_at || Date.parse(item.lease_expires_at) <= Date.parse(now)) {
      throw new ProposalStoreError("NOTIFICATION_LEASE_EXPIRED", `notification lease ${leaseId} has expired`);
    }
    return item;
  }
};

// ../synapsor-runner/packages/proposal-store/src/worker-control-domain.ts
function workerControlDecisionSubject(state, target) {
  assertWorkerControlTarget(target);
  const targetDigest = canonicalJsonDigest({
    schema_version: "synapsor.worker-control-decision-subject.v1",
    current_revision: state.revision,
    current_integrity_hash: state.integrity_hash,
    action: target.action,
    capability: target.capability ?? null,
    contract_digest: target.contract_digest ?? null
  });
  return {
    proposal_id: `worker_control_${targetDigest.slice("sha256:".length, "sha256:".length + 32)}`,
    proposal_version: state.revision + 1,
    proposal_hash: targetDigest
  };
}
function defaultWorkerControlState() {
  const unsigned = {
    schema_version: "synapsor.worker-control.v1",
    mode: "active",
    revision: 0,
    capability_controls: [],
    updated_at: "1970-01-01T00:00:00.000Z"
  };
  return { ...unsigned, integrity_hash: canonicalJsonDigest(unsigned) };
}
function parseWorkerControlState(value) {
  if (!isRecord(value) || value.schema_version !== "synapsor.worker-control.v1" || !["active", "paused", "draining"].includes(String(value.mode)) || !Number.isSafeInteger(value.revision) || Number(value.revision) < 0 || !Array.isArray(value.capability_controls) || typeof value.updated_at !== "string" || typeof value.integrity_hash !== "string") {
    throw new ProposalStoreError("WORKER_CONTROL_STATE_INVALID", "stored supervised-worker control state is invalid");
  }
  const controls = value.capability_controls.map((entry) => {
    if (!isRecord(entry) || typeof entry.capability !== "string" || !/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(entry.capability) || typeof entry.contract_digest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(entry.contract_digest) || !["enabled", "disabled", "revoked"].includes(String(entry.status)) || typeof entry.updated_at !== "string" || typeof entry.actor !== "string") {
      throw new ProposalStoreError("WORKER_CONTROL_STATE_INVALID", "stored supervised-worker capability control is invalid");
    }
    return {
      capability: entry.capability,
      contract_digest: entry.contract_digest,
      status: entry.status,
      updated_at: entry.updated_at,
      actor: entry.actor
    };
  });
  const lastDecision = isRecord(value.last_decision) ? value.last_decision : void 0;
  const unsigned = {
    schema_version: "synapsor.worker-control.v1",
    mode: value.mode,
    revision: Number(value.revision),
    capability_controls: controls,
    ...lastDecision ? { last_decision: lastDecision } : {},
    updated_at: value.updated_at
  };
  const integrityHash = value.integrity_hash;
  if (integrityHash !== canonicalJsonDigest(unsigned)) {
    throw new ProposalStoreError("WORKER_CONTROL_STATE_TAMPERED", "stored supervised-worker control state failed integrity validation");
  }
  return { ...unsigned, integrity_hash: integrityHash };
}
function assertWorkerControlTarget(target) {
  const capabilityAction = target.action === "capability_enable" || target.action === "capability_disable" || target.action === "digest_revoke";
  if (capabilityAction) {
    if (!target.capability || !/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(target.capability)) {
      throw new ProposalStoreError("WORKER_CONTROL_CAPABILITY_REQUIRED", `${target.action} requires a fixed capability name`);
    }
    if (!target.contract_digest || !/^sha256:[a-f0-9]{64}$/.test(target.contract_digest)) {
      throw new ProposalStoreError("WORKER_CONTROL_DIGEST_REQUIRED", `${target.action} requires an exact sha256 contract digest`);
    }
  } else if (target.capability || target.contract_digest) {
    throw new ProposalStoreError("WORKER_CONTROL_TARGET_INVALID", `${target.action} is a global control and cannot carry capability authority`);
  }
}
function workerControlOperatorAction(action) {
  if (action === "pause") return "worker_pause";
  if (action === "resume") return "worker_resume";
  if (action === "drain") return "worker_drain";
  if (action === "capability_enable") return "worker_capability_enable";
  if (action === "capability_disable") return "worker_capability_disable";
  return "worker_digest_revoke";
}
function assertWorkerControlOperatorDecision(state, target, actor, identity, requireVerified) {
  if (requireVerified && (!identity || !identity.verified || identity.provider === "dev_env")) {
    throw new ProposalStoreError(
      "VERIFIED_OPERATOR_IDENTITY_REQUIRED",
      `verified operator identity is required to ${target.action} supervised execution`
    );
  }
  if (!identity) return;
  if (identity.subject !== actor || identity.decision.subject !== actor) {
    throw new ProposalStoreError("OPERATOR_IDENTITY_MISMATCH", "worker-control identity does not match its actor");
  }
  const subject = workerControlDecisionSubject(state, target);
  if (identity.decision.action !== workerControlOperatorAction(target.action) || identity.decision.proposal_id !== subject.proposal_id || identity.decision.proposal_version !== subject.proposal_version || identity.decision.proposal_hash !== subject.proposal_hash) {
    throw new ProposalStoreError("OPERATOR_DECISION_MISMATCH", "operator proof is not bound to this exact worker-control revision");
  }
  if (identity.decision_hash !== canonicalJsonDigest(identity.decision)) {
    throw new ProposalStoreError("OPERATOR_IDENTITY_TAMPERED", "worker-control decision hash failed integrity validation");
  }
  const { integrity_hash: _integrityHash, ...identityCore } = identity;
  if (identity.integrity_hash !== canonicalJsonDigest(identityCore)) {
    throw new ProposalStoreError("OPERATOR_IDENTITY_TAMPERED", "worker-control identity proof failed integrity validation");
  }
}
function workerControlSummary(target) {
  if (target.action === "pause") return "Supervised execution paused by an operator";
  if (target.action === "resume") return "Supervised execution resumed by an operator";
  if (target.action === "drain") return "Supervised execution is draining without new leases";
  if (target.action === "capability_enable") return `${target.capability} supervised execution enabled for the exact reviewed digest`;
  if (target.action === "capability_disable") return `${target.capability} supervised execution disabled for the exact reviewed digest`;
  return `${target.capability} supervised execution digest revoked`;
}

// ../synapsor-runner/packages/proposal-store/src/shared-ledger-domain.ts
var sharedLedgerJsonColumns = /* @__PURE__ */ new Set([
  "change_set_json",
  "payload_json",
  "identity_json",
  "job_json",
  "intent_json",
  "result_json",
  "receipt_json",
  "item_json",
  "value_json",
  "patch_json",
  "selected_capabilities_json",
  "proposed_effect_json",
  "actual_effect_json",
  "details_json",
  "acknowledgement_identity_json"
]);
var sharedLedgerKindToTable = {
  proposal: "proposals",
  proposal_event: "proposal_events",
  approval: "approvals",
  writeback_job: "writeback_jobs",
  writeback_intent: "writeback_intents",
  idempotency_receipt: "idempotency_receipts",
  writeback_receipt: "writeback_receipts",
  evidence_bundle: "evidence_bundles",
  evidence_item: "evidence_items",
  query_audit: "query_audit",
  explore_budget_reservation: "explore_budget_reservations",
  replay_record: "replay_records",
  shadow_human_action: "shadow_human_actions",
  shadow_study: "shadow_studies",
  shadow_study_case: "shadow_study_cases",
  shadow_outcome: "shadow_outcomes",
  worker_queue_item: "worker_queue",
  attention_event: "attention_events",
  attention_item: "attention_items",
  notification_delivery: "notification_deliveries",
  runner_state: "runner_state",
  policy_recommendation: "policy_recommendations",
  cloud_outbox_event: "cloud_outbox",
  cloud_governance_event: "cloud_governance_events"
};
var sharedLedgerRestoreSpecs = {
  proposals: restoreSpec("proposal_id", [
    "proposal_id",
    "proposal_version",
    "proposal_hash",
    "action",
    "state",
    "tenant_id",
    "principal",
    "capability",
    "interaction_id",
    "tool_call_id",
    "business_object",
    "object_id",
    "source_kind",
    "source_id",
    "source_schema",
    "source_table",
    "source_database_mutated",
    "change_set_json",
    "created_at",
    "updated_at"
  ], ["proposal_id", "proposal_version", "proposal_hash", "action", "state", "tenant_id", "business_object", "object_id", "source_kind", "source_id", "source_schema", "source_table", "source_database_mutated", "change_set_json", "created_at", "updated_at"]),
  proposal_events: restoreSpec("event_id", ["event_id", "proposal_id", "kind", "actor", "payload_json", "created_at"], ["event_id", "proposal_id", "kind", "actor", "payload_json", "created_at"]),
  approvals: restoreSpec("approval_id", ["approval_id", "proposal_id", "proposal_version", "proposal_hash", "approver", "status", "reason", "identity_json", "decision_hash", "signature", "integrity_hash", "freshness_proof_digest", "action_boundary_name", "action_boundary_digest", "created_at"], ["approval_id", "proposal_id", "proposal_version", "proposal_hash", "approver", "status", "created_at"]),
  writeback_jobs: restoreSpec("writeback_job_id", ["writeback_job_id", "proposal_id", "proposal_hash", "status", "job_json", "created_at", "updated_at"], ["writeback_job_id", "proposal_id", "proposal_hash", "status", "job_json", "created_at", "updated_at"]),
  writeback_intents: restoreSpec("intent_id", ["intent_id", "idempotency_key", "writeback_job_id", "proposal_id", "proposal_hash", "runner_id", "operation", "status", "intent_json", "result_json", "reconciliation_reason", "created_at", "updated_at"], ["intent_id", "idempotency_key", "writeback_job_id", "proposal_id", "proposal_hash", "runner_id", "operation", "status", "intent_json", "created_at", "updated_at"]),
  idempotency_receipts: restoreSpec("idempotency_key", ["idempotency_key", "writeback_job_id", "proposal_id", "receipt_status", "receipt_json", "created_at"], ["idempotency_key", "writeback_job_id", "proposal_id", "receipt_status", "receipt_json", "created_at"]),
  writeback_receipts: restoreSpec("receipt_id", ["receipt_id", "writeback_job_id", "proposal_id", "runner_id", "status", "idempotency_key", "source_database_mutated", "receipt_json", "created_at"], ["receipt_id", "writeback_job_id", "proposal_id", "runner_id", "status", "idempotency_key", "source_database_mutated", "receipt_json", "created_at"]),
  evidence_bundles: restoreSpec("evidence_bundle_id", ["evidence_bundle_id", "proposal_id", "tenant_id", "principal", "capability", "source_id", "source_table", "business_object", "object_id", "query_fingerprint", "payload_json", "created_at"], ["evidence_bundle_id", "tenant_id", "payload_json", "created_at"]),
  evidence_items: restoreSpec("evidence_item_id", ["evidence_item_id", "evidence_bundle_id", "item_json", "created_at"], ["evidence_item_id", "evidence_bundle_id", "item_json", "created_at"]),
  query_audit: restoreSpec("audit_id", ["audit_id", "proposal_id", "evidence_bundle_id", "tenant_id", "principal", "capability", "business_object", "object_id", "primary_key_value", "source_id", "query_fingerprint", "table_name", "row_count", "payload_json", "created_at"], ["audit_id", "source_id", "query_fingerprint", "table_name", "row_count", "payload_json", "created_at"]),
  explore_budget_reservations: restoreSpec("reservation_id", ["reservation_id", "scope_fingerprint", "resource_id", "variant_fingerprint", "requires_differencing", "differencing_counted", "reserved_cells", "accounted_cells", "status", "created_at", "completed_at"], ["reservation_id", "scope_fingerprint", "resource_id", "variant_fingerprint", "requires_differencing", "differencing_counted", "reserved_cells", "accounted_cells", "status", "created_at"]),
  replay_records: restoreSpec("replay_id", ["replay_id", "proposal_id", "payload_json", "created_at"], ["replay_id", "proposal_id", "payload_json", "created_at"]),
  shadow_human_actions: restoreSpec("action_id", ["action_id", "proposal_id", "actor", "patch_json", "notes", "created_at"], ["action_id", "proposal_id", "actor", "patch_json", "created_at"]),
  shadow_studies: restoreSpec("study_id", ["study_id", "name", "description", "selected_capabilities_json", "starts_at", "ends_at", "status", "created_at", "updated_at"], ["study_id", "name", "selected_capabilities_json", "status", "created_at", "updated_at"]),
  shadow_study_cases: restoreSpec("case_id", ["case_id", "study_id", "request_id", "proposal_id", "tenant_id", "principal", "capability", "business_object", "object_id", "evidence_bundle_id", "proposed_effect_json", "agent_result", "decision_reason", "risk_score", "amount_value", "created_at"], ["case_id", "study_id", "request_id", "tenant_id", "capability", "business_object", "object_id", "agent_result", "created_at"]),
  shadow_outcomes: restoreSpec("outcome_id", ["outcome_id", "study_id", "request_id", "proposal_id", "tenant_id", "business_object", "object_id", "actor", "disposition", "actual_effect_json", "occurred_at", "source", "reference", "reason", "created_at"], ["outcome_id", "study_id", "request_id", "tenant_id", "business_object", "object_id", "actor", "disposition", "occurred_at", "source", "created_at"]),
  worker_queue: restoreSpec(
    "proposal_id",
    [
      "proposal_id",
      "status",
      "execution_mode",
      "contract_digest",
      "cancellation_control_role",
      "cancellation_control_role_present",
      "attempts",
      "max_attempts",
      "next_attempt_at",
      "lease_owner",
      "lease_id",
      "lease_expires_at",
      "last_error_code",
      "terminal_outcome",
      "created_at",
      "updated_at"
    ],
    ["proposal_id", "status", "attempts", "max_attempts", "next_attempt_at", "created_at", "updated_at"]
  ),
  attention_events: restoreSpec(
    "event_id",
    [
      "event_id",
      "schema_version",
      "event_type",
      "severity",
      "occurred_at",
      "environment",
      "proposal_id",
      "job_id",
      "operation_id",
      "correlation_id",
      "capability",
      "contract_digest",
      "attention_key",
      "attention_required",
      "immediate_default",
      "summary",
      "approval_source",
      "worker_state",
      "failure_class",
      "expires_at",
      "workbench_path",
      "details_json",
      "payload_hash",
      "created_at"
    ],
    [
      "event_id",
      "schema_version",
      "event_type",
      "severity",
      "occurred_at",
      "environment",
      "attention_required",
      "immediate_default",
      "summary",
      "details_json",
      "payload_hash",
      "created_at"
    ]
  ),
  attention_items: restoreSpec(
    "attention_id",
    [
      "attention_id",
      "attention_key",
      "status",
      "severity",
      "environment",
      "event_type",
      "capability",
      "contract_digest",
      "title",
      "occurrence_count",
      "first_event_id",
      "latest_event_id",
      "first_seen_at",
      "last_seen_at",
      "acknowledged_by",
      "acknowledged_at",
      "acknowledgement_identity_json",
      "acknowledgement_decision_hash",
      "acknowledgement_signature",
      "acknowledgement_integrity_hash",
      "resolved_at",
      "expires_at"
    ],
    [
      "attention_id",
      "attention_key",
      "status",
      "severity",
      "environment",
      "event_type",
      "title",
      "occurrence_count",
      "first_event_id",
      "latest_event_id",
      "first_seen_at",
      "last_seen_at"
    ]
  ),
  notification_deliveries: restoreSpec(
    "delivery_id",
    [
      "delivery_id",
      "sink_id",
      "event_id",
      "attention_id",
      "status",
      "attempts",
      "max_attempts",
      "next_attempt_at",
      "lease_owner",
      "lease_id",
      "lease_expires_at",
      "last_error_code",
      "external_reference",
      "delivered_at",
      "created_at",
      "updated_at"
    ],
    [
      "delivery_id",
      "sink_id",
      "event_id",
      "status",
      "attempts",
      "max_attempts",
      "next_attempt_at",
      "created_at",
      "updated_at"
    ]
  ),
  runner_state: restoreSpec("key", ["key", "value_json", "updated_at"], ["key", "value_json", "updated_at"]),
  policy_recommendations: restoreSpec("recommendation_id", ["recommendation_id", "tenant_id", "capability", "policy", "base_contract_digest", "status", "payload_json", "integrity_hash", "created_at", "updated_at"], ["recommendation_id", "tenant_id", "capability", "policy", "base_contract_digest", "status", "payload_json", "integrity_hash", "created_at", "updated_at"]),
  cloud_outbox: restoreSpec("event_id", ["event_id", "proposal_id", "sequence", "kind", "status", "payload_hash", "payload_json", "attempts", "max_attempts", "next_attempt_at", "lease_owner", "lease_expires_at", "last_error_code", "sent_at", "acknowledged_at", "created_at", "updated_at"], ["event_id", "sequence", "kind", "status", "payload_hash", "payload_json", "attempts", "max_attempts", "next_attempt_at", "created_at", "updated_at"]),
  cloud_governance_events: restoreSpec("event_id", ["event_id", "proposal_id", "cloud_proposal_id", "kind", "state", "authority", "payload_json", "integrity_hash", "created_at"], ["event_id", "proposal_id", "kind", "state", "authority", "payload_json", "integrity_hash", "created_at"])
};
function sharedLedgerPayload(table, row) {
  const payload = { table };
  for (const [key2, value] of Object.entries(row)) {
    if (value == null) continue;
    const normalizedKey = key2.endsWith("_json") ? key2.slice(0, -5) : key2;
    if (sharedLedgerJsonColumns.has(key2)) {
      try {
        payload[normalizedKey] = JSON.parse(String(value));
      } catch {
        payload[normalizedKey] = String(value);
      }
    } else {
      payload[key2] = value;
    }
  }
  return payload;
}
function restoreSpec(conflict, columns, required) {
  return { conflict, columns, required: new Set(required) };
}
function sharedLedgerTableForEntry(entry) {
  const explicit = typeof entry.payload.table === "string" ? entry.payload.table : void 0;
  const table = explicit ?? sharedLedgerKindToTable[entry.kind];
  return table && sharedLedgerRestoreSpecs[table] ? table : void 0;
}
function sharedLedgerRestoreRank(entry) {
  const order = [
    "proposals",
    "evidence_bundles",
    "evidence_items",
    "query_audit",
    "explore_budget_reservations",
    "approvals",
    "writeback_jobs",
    "writeback_intents",
    "idempotency_receipts",
    "writeback_receipts",
    "replay_records",
    "proposal_events",
    "shadow_studies",
    "shadow_study_cases",
    "shadow_human_actions",
    "shadow_outcomes",
    "worker_queue",
    "attention_events",
    "attention_items",
    "notification_deliveries",
    "runner_state",
    "policy_recommendations",
    "cloud_outbox",
    "cloud_governance_events"
  ];
  const table = sharedLedgerTableForEntry(entry);
  const index = table ? order.indexOf(table) : -1;
  return index === -1 ? Number.MAX_SAFE_INTEGER : index;
}
function sharedLedgerRestoreValue(payload, column) {
  const key2 = column.endsWith("_json") ? column.slice(0, -5) : column;
  const value = payload[key2] ?? payload[column];
  if (value == null) return null;
  if (sharedLedgerJsonColumns.has(column)) return JSON.stringify(value);
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "string" || typeof value === "number" || typeof value === "bigint" || value instanceof Uint8Array) return value;
  return JSON.stringify(value);
}

// ../synapsor-runner/packages/proposal-store/src/sqlite-cloud-control-methods.ts
var proposalStoreCloudControlMethods = {
  enqueueCloudOutbox(input) {
    const eventId = input.event_id.trim();
    if (!eventId) throw new ProposalStoreError("CLOUD_OUTBOX_EVENT_ID_REQUIRED", "cloud outbox event_id is required");
    if (!["proposal", "activity", "result"].includes(input.kind)) throw new ProposalStoreError("CLOUD_OUTBOX_KIND_INVALID", `unsupported Cloud outbox kind: ${input.kind}`);
    if (input.proposal_id) this.requireProposal(input.proposal_id);
    assertNoSecretMaterial(input.payload, `cloud_outbox.${eventId}`);
    const payloadHash = canonicalJsonDigest(input.payload);
    const now = input.now ?? (/* @__PURE__ */ new Date()).toISOString();
    const sequence = Math.max(0, Math.trunc(input.sequence ?? 0));
    const maxAttempts = Math.max(1, Math.min(100, Math.trunc(input.max_attempts ?? 12)));
    this.db.prepare(`
        INSERT OR IGNORE INTO cloud_outbox (
          event_id, proposal_id, sequence, kind, status, payload_hash, payload_json,
          attempts, max_attempts, next_attempt_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'pending', ?, ?, 0, ?, ?, ?, ?)
      `).run(eventId, input.proposal_id ?? null, sequence, input.kind, payloadHash, JSON.stringify(input.payload), maxAttempts, now, now, now);
    const item = this.requireCloudOutboxItem(eventId);
    if (item.payload_hash !== payloadHash || item.kind !== input.kind || item.proposal_id !== input.proposal_id) {
      throw new ProposalStoreError("CLOUD_OUTBOX_IDEMPOTENCY_MISMATCH", `cloud outbox event ${eventId} was already recorded with different immutable content`);
    }
    return item;
  },
  claimCloudOutbox(input) {
    const owner = input.owner.trim();
    if (!owner) throw new ProposalStoreError("CLOUD_OUTBOX_OWNER_REQUIRED", "cloud outbox lease owner is required");
    const now = input.now ?? (/* @__PURE__ */ new Date()).toISOString();
    const leaseExpiresAt = new Date(Date.parse(now) + Math.max(1e3, Math.min(3e5, input.lease_ms ?? 3e4))).toISOString();
    const limit = Math.max(1, Math.min(100, Math.trunc(input.limit ?? 10)));
    const claimed = [];
    this.transaction(() => {
      this.db.prepare(`
          UPDATE cloud_outbox
          SET status = 'pending', lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
          WHERE status = 'leased' AND lease_expires_at <= ?
        `).run(now, now);
      const rows = this.db.prepare(`
          SELECT candidate.event_id
          FROM cloud_outbox candidate
          WHERE candidate.status = 'pending'
            AND candidate.next_attempt_at <= ?
            AND NOT EXISTS (
              SELECT 1 FROM cloud_outbox earlier
              WHERE earlier.proposal_id = candidate.proposal_id
                AND earlier.sequence < candidate.sequence
                AND earlier.status NOT IN ('acknowledged')
            )
          ORDER BY candidate.sequence ASC, candidate.created_at ASC, candidate.event_id ASC
          LIMIT ?
        `).all(now, limit);
      for (const row of rows) {
        if (!isRecord(row) || typeof row.event_id !== "string") continue;
        const result = this.db.prepare(`
            UPDATE cloud_outbox
            SET status = 'leased', lease_owner = ?, lease_expires_at = ?, attempts = attempts + 1,
                sent_at = COALESCE(sent_at, ?), updated_at = ?
            WHERE event_id = ? AND status = 'pending'
          `).run(owner, leaseExpiresAt, now, now, row.event_id);
        if (Number(result.changes) === 1) claimed.push(row.event_id);
      }
    });
    return claimed.map((eventId) => this.requireCloudOutboxItem(eventId));
  },
  acknowledgeCloudOutbox(eventId, owner, now = (/* @__PURE__ */ new Date()).toISOString()) {
    const result = this.db.prepare(`
        UPDATE cloud_outbox
        SET status = 'acknowledged', lease_owner = NULL, lease_expires_at = NULL,
            acknowledged_at = ?, last_error_code = NULL, updated_at = ?
        WHERE event_id = ? AND status = 'leased' AND lease_owner = ?
      `).run(now, now, eventId, owner);
    if (Number(result.changes) !== 1) throw new ProposalStoreError("CLOUD_OUTBOX_LEASE_MISMATCH", `cloud outbox event ${eventId} is not leased by ${owner}`);
    return this.requireCloudOutboxItem(eventId);
  },
  failCloudOutbox(input) {
    const now = input.now ?? (/* @__PURE__ */ new Date()).toISOString();
    const current = this.requireCloudOutboxItem(input.event_id);
    if (current.status !== "leased" || current.lease_owner !== input.owner) {
      throw new ProposalStoreError("CLOUD_OUTBOX_LEASE_MISMATCH", `cloud outbox event ${input.event_id} is not leased by ${input.owner}`);
    }
    const exhausted = current.attempts >= current.max_attempts;
    const status = input.reconciliation ? "reconciliation_required" : input.retryable && !exhausted ? "pending" : "dead_letter";
    const fallbackDelay = Math.min(3e5, 500 * 2 ** Math.min(current.attempts, 9));
    const delayMs = Math.max(0, Math.min(36e5, input.retry_after_ms ?? fallbackDelay));
    const nextAttemptAt = new Date(Date.parse(now) + delayMs).toISOString();
    this.db.prepare(`
        UPDATE cloud_outbox
        SET status = ?, lease_owner = NULL, lease_expires_at = NULL, last_error_code = ?,
            next_attempt_at = ?, updated_at = ?
        WHERE event_id = ?
      `).run(status, input.error_code, nextAttemptAt, now, input.event_id);
    return this.requireCloudOutboxItem(input.event_id);
  },
  requeueCloudOutbox(eventId, now = (/* @__PURE__ */ new Date()).toISOString()) {
    const current = this.requireCloudOutboxItem(eventId);
    if (!["dead_letter", "reconciliation_required"].includes(current.status)) {
      throw new ProposalStoreError("CLOUD_OUTBOX_NOT_REQUEUEABLE", `cloud outbox event ${eventId} is ${current.status}, not dead_letter or reconciliation_required`);
    }
    this.db.prepare(`
        UPDATE cloud_outbox
        SET status = 'pending', attempts = 0, next_attempt_at = ?, lease_owner = NULL,
            lease_expires_at = NULL, last_error_code = NULL, updated_at = ?
        WHERE event_id = ?
      `).run(now, now, eventId);
    return this.requireCloudOutboxItem(eventId);
  },
  listCloudOutbox(filters = {}) {
    const conditions = [];
    const values = [];
    if (filters.status) {
      conditions.push("status = ?");
      values.push(filters.status);
    }
    if (filters.proposal_id) {
      conditions.push("proposal_id = ?");
      values.push(filters.proposal_id);
    }
    const limit = Math.max(1, Math.min(1e4, Math.trunc(filters.limit ?? 100)));
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    return this.db.prepare(`SELECT * FROM cloud_outbox ${where} ORDER BY sequence ASC, created_at ASC, event_id ASC LIMIT ?`).all(...values, limit).map(rowToCloudOutboxItem).filter((item) => item !== void 0);
  },
  compactCloudOutbox(input) {
    const result = this.db.prepare("DELETE FROM cloud_outbox WHERE status = 'acknowledged' AND acknowledged_at < ?").run(input.acknowledged_before);
    return Number(result.changes);
  },
  recordCloudGovernanceEvent(input) {
    this.requireProposal(input.proposal_id);
    assertNoSecretMaterial(input.payload, `cloud_governance_event.${input.event_id}`);
    const createdAt = input.created_at ?? (/* @__PURE__ */ new Date()).toISOString();
    const unsigned = {
      event_id: input.event_id,
      proposal_id: input.proposal_id,
      ...input.cloud_proposal_id ? { cloud_proposal_id: input.cloud_proposal_id } : {},
      kind: input.kind,
      state: input.state,
      authority: "synapsor_cloud",
      payload: input.payload,
      created_at: createdAt
    };
    const event = { ...unsigned, integrity_hash: canonicalJsonDigest(unsigned) };
    this.db.prepare(`
        INSERT OR IGNORE INTO cloud_governance_events (
          event_id, proposal_id, cloud_proposal_id, kind, state, authority, payload_json, integrity_hash, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(event.event_id, event.proposal_id, event.cloud_proposal_id ?? null, event.kind, event.state, event.authority, JSON.stringify(event.payload), event.integrity_hash, event.created_at);
    const localState = localStateFromCloudGovernance(event.state);
    if (localState) {
      const sourceMutated = localState === "applied" ? 1 : 0;
      const projected = this.db.prepare(`
          UPDATE proposals
          SET state = ?, source_database_mutated = CASE WHEN ? = 1 THEN 1 ELSE source_database_mutated END, updated_at = ?
          WHERE proposal_id = ? AND state IN ('pending_review', 'approved', 'pending_worker')
        `).run(localState, sourceMutated, event.created_at, event.proposal_id);
      if (Number(projected.changes) === 1) {
        this.appendEvent(event.proposal_id, `proposal_cloud_${localState}`, "synapsor_cloud", {
          cloud_event_id: event.event_id,
          cloud_proposal_id: event.cloud_proposal_id ?? event.proposal_id,
          cloud_state: event.state,
          authority: event.authority
        });
      }
    }
    const stored = this.listCloudGovernanceEvents(input.proposal_id).find((item) => item.event_id === input.event_id);
    if (!stored || stored.integrity_hash !== event.integrity_hash) {
      throw new ProposalStoreError("CLOUD_GOVERNANCE_EVENT_MISMATCH", `Cloud governance event ${input.event_id} conflicts with an existing immutable event`);
    }
    return stored;
  },
  listCloudGovernanceEvents(proposalId) {
    const rows = proposalId ? this.db.prepare("SELECT * FROM cloud_governance_events WHERE proposal_id = ? ORDER BY created_at ASC, event_id ASC").all(proposalId) : this.db.prepare("SELECT * FROM cloud_governance_events ORDER BY created_at ASC, event_id ASC").all();
    return rows.map(rowToCloudGovernanceEvent).filter((item) => item !== void 0);
  },
  requireCloudOutboxItem(eventId) {
    const item = rowToCloudOutboxItem(this.db.prepare("SELECT * FROM cloud_outbox WHERE event_id = ?").get(eventId));
    if (!item) throw new ProposalStoreError("CLOUD_OUTBOX_EVENT_NOT_FOUND", `cloud outbox event not found: ${eventId}`);
    return item;
  },
  workerControlState() {
    const raw = this.getRunnerState("supervised_worker_control");
    if (!raw) return defaultWorkerControlState();
    return parseWorkerControlState(raw);
  },
  updateWorkerControl(input) {
    const now = input.now ?? (/* @__PURE__ */ new Date()).toISOString();
    const current = this.workerControlState();
    assertWorkerControlTarget(input);
    assertWorkerControlOperatorDecision(
      current,
      input,
      input.actor,
      input.identity,
      input.require_verified_identity === true
    );
    let mode = current.mode;
    let controls = [...current.capability_controls];
    if (input.action === "pause") mode = "paused";
    else if (input.action === "resume") mode = "active";
    else if (input.action === "drain") mode = "draining";
    else {
      const capability = input.capability;
      const contractDigest = input.contract_digest;
      const keyMatches = (entry) => entry.capability === capability && entry.contract_digest === contractDigest;
      const existing = controls.find(keyMatches);
      if (existing?.status === "revoked" && input.action === "capability_enable") {
        throw new ProposalStoreError(
          "WORKER_DIGEST_REVOKED",
          `revoked supervised-worker digest ${contractDigest} cannot be re-enabled`
        );
      }
      const status = input.action === "capability_enable" ? "enabled" : input.action === "capability_disable" ? "disabled" : "revoked";
      controls = [
        ...controls.filter((entry) => !keyMatches(entry)),
        {
          capability,
          contract_digest: contractDigest,
          status,
          updated_at: now,
          actor: input.actor
        }
      ].sort((left, right) => left.capability.localeCompare(right.capability) || left.contract_digest.localeCompare(right.contract_digest));
    }
    const unsigned = {
      schema_version: "synapsor.worker-control.v1",
      mode,
      revision: current.revision + 1,
      capability_controls: controls,
      ...input.identity ? { last_decision: input.identity } : {},
      updated_at: now
    };
    const updated = {
      ...unsigned,
      integrity_hash: canonicalJsonDigest(unsigned)
    };
    assertNoSecretMaterial(updated, "runner_state.supervised_worker_control");
    this.transaction(() => {
      this.db.prepare(`
          INSERT INTO runner_state (key, value_json, updated_at)
          VALUES ('supervised_worker_control', ?, ?)
          ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
        `).run(JSON.stringify(updated), now);
      const global = input.action === "pause" || input.action === "resume" || input.action === "drain";
      const eventType = input.action === "resume" || input.action === "capability_enable" ? "capability.activated" : global ? "worker.paused" : "capability.revoked";
      this.recordAttentionEventInternal({
        event_type: eventType,
        severity: "informational",
        environment: input.environment ? boundedSafeLabel(input.environment, "worker control environment", 64) : "unknown",
        ...input.capability ? { capability: input.capability } : {},
        ...input.contract_digest ? { contract_digest: input.contract_digest } : {},
        attention_required: false,
        immediate_default: false,
        summary: workerControlSummary(input),
        worker_state: mode,
        details: {
          control_action: input.action,
          control_revision: updated.revision,
          source_database_changed: false
        },
        source_event_key: `worker-control:${updated.revision}:${updated.integrity_hash}`,
        now
      });
    });
    return updated;
  },
  setRunnerState(key2, value) {
    assertNoSecretMaterial(value, `runner_state.${key2}`);
    this.db.prepare(`
        INSERT INTO runner_state (key, value_json, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
      `).run(key2, JSON.stringify(value), (/* @__PURE__ */ new Date()).toISOString());
  },
  getRunnerState(key2) {
    const row = this.db.prepare("SELECT value_json FROM runner_state WHERE key = ?").get(key2);
    if (!isRecord(row)) return void 0;
    return JSON.parse(String(row.value_json));
  },
  sharedLedgerEntries() {
    const specs = [
      { table: "proposals", kind: "proposal", key: "proposal_id", created: "created_at", proposal: "proposal_id", tenant: "tenant_id", capability: "capability" },
      { table: "proposal_events", kind: "proposal_event", key: "event_id", created: "created_at", proposal: "proposal_id" },
      { table: "approvals", kind: "approval", key: "approval_id", created: "created_at", proposal: "proposal_id" },
      { table: "writeback_jobs", kind: "writeback_job", key: "writeback_job_id", created: "created_at", proposal: "proposal_id" },
      { table: "writeback_intents", kind: "writeback_intent", key: "intent_id", created: "created_at", proposal: "proposal_id" },
      { table: "idempotency_receipts", kind: "idempotency_receipt", key: "idempotency_key", created: "created_at", proposal: "proposal_id" },
      { table: "writeback_receipts", kind: "writeback_receipt", key: "receipt_id", created: "created_at", proposal: "proposal_id" },
      { table: "evidence_bundles", kind: "evidence_bundle", key: "evidence_bundle_id", created: "created_at", proposal: "proposal_id", tenant: "tenant_id", capability: "capability" },
      { table: "evidence_items", kind: "evidence_item", key: "evidence_item_id", created: "created_at" },
      { table: "query_audit", kind: "query_audit", key: "audit_id", created: "created_at", proposal: "proposal_id", tenant: "tenant_id", capability: "capability" },
      { table: "explore_budget_reservations", kind: "explore_budget_reservation", key: "reservation_id", created: "created_at" },
      { table: "replay_records", kind: "replay_record", key: "replay_id", created: "created_at", proposal: "proposal_id" },
      { table: "shadow_human_actions", kind: "shadow_human_action", key: "action_id", created: "created_at", proposal: "proposal_id" },
      { table: "shadow_studies", kind: "shadow_study", key: "study_id", created: "created_at" },
      { table: "shadow_study_cases", kind: "shadow_study_case", key: "case_id", created: "created_at", proposal: "proposal_id", tenant: "tenant_id", capability: "capability" },
      { table: "shadow_outcomes", kind: "shadow_outcome", key: "outcome_id", created: "created_at", proposal: "proposal_id", tenant: "tenant_id" },
      { table: "worker_queue", kind: "worker_queue_item", key: "proposal_id", created: "created_at", proposal: "proposal_id" },
      { table: "attention_events", kind: "attention_event", key: "event_id", created: "created_at", proposal: "proposal_id", capability: "capability" },
      { table: "attention_items", kind: "attention_item", key: "attention_id", created: "first_seen_at", capability: "capability" },
      { table: "notification_deliveries", kind: "notification_delivery", key: "delivery_id", created: "created_at" },
      { table: "runner_state", kind: "runner_state", key: "key", created: "updated_at" },
      { table: "policy_recommendations", kind: "policy_recommendation", key: "recommendation_id", created: "created_at", tenant: "tenant_id", capability: "capability" },
      { table: "cloud_outbox", kind: "cloud_outbox_event", key: "event_id", created: "created_at", proposal: "proposal_id" },
      { table: "cloud_governance_events", kind: "cloud_governance_event", key: "event_id", created: "created_at", proposal: "proposal_id" }
    ];
    const entries = [];
    for (const spec of specs) {
      const rows = this.db.prepare(`SELECT * FROM ${spec.table} ORDER BY ${spec.created} ASC`).all();
      for (const row of rows) {
        if (!isRecord(row)) continue;
        const payload = sharedLedgerPayload(spec.table, row);
        assertNoSecretMaterial(payload, `shared_ledger.${spec.table}`);
        entries.push({
          entry_key: `${spec.table}:${String(row[spec.key])}`,
          kind: spec.kind,
          proposal_id: spec.proposal && row[spec.proposal] != null ? String(row[spec.proposal]) : void 0,
          tenant_id: spec.tenant && row[spec.tenant] != null ? String(row[spec.tenant]) : void 0,
          capability: spec.capability && row[spec.capability] != null ? String(row[spec.capability]) : void 0,
          payload,
          created_at: row[spec.created] == null ? (/* @__PURE__ */ new Date()).toISOString() : String(row[spec.created])
        });
      }
    }
    return entries;
  },
  importSharedLedgerEntries(entries) {
    let imported = 0;
    let skipped = 0;
    const sorted = [...entries].sort((left, right) => sharedLedgerRestoreRank(left) - sharedLedgerRestoreRank(right));
    this.transaction(() => {
      for (const entry of sorted) {
        const table = sharedLedgerTableForEntry(entry);
        if (!table) {
          skipped += 1;
          continue;
        }
        assertNoSecretMaterial(entry.payload, `shared_ledger.${table}`);
        if (this.restoreSharedLedgerEntry(table, entry.payload)) imported += 1;
        else skipped += 1;
      }
    });
    return { imported, skipped };
  },
  restoreSharedLedgerEntry(table, payload) {
    const spec = sharedLedgerRestoreSpecs[table];
    if (!spec) return false;
    const values = spec.columns.map((column) => sharedLedgerRestoreValue(payload, column));
    if (values.some((value, index) => value == null && spec.required.has(spec.columns[index]))) return false;
    const assignments = spec.columns.filter((column) => column !== spec.conflict).map((column) => `${column} = excluded.${column}`).join(", ");
    this.db.prepare(`
        INSERT INTO ${table} (${spec.columns.join(", ")})
        VALUES (${spec.columns.map(() => "?").join(", ")})
        ON CONFLICT(${spec.conflict}) DO UPDATE SET ${assignments}
      `).run(...values);
    return true;
  }
};

// ../synapsor-runner/packages/proposal-store/src/sqlite-shadow-methods.ts
var proposalStoreShadowMethods = {
  createShadowStudy(input) {
    const name4 = requiredBoundedText(input.name, "shadow study name", 160);
    const description = optionalBoundedText(input.description, "shadow study description", 2e3);
    const selectedCapabilities = [...new Set((input.selected_capabilities ?? []).map(
      (value) => requiredBoundedText(value, "shadow study capability", 256)
    ))].sort();
    const startsAt = optionalIsoTimestamp(input.starts_at, "shadow study starts_at");
    const endsAt = optionalIsoTimestamp(input.ends_at, "shadow study ends_at");
    if (startsAt && endsAt && Date.parse(endsAt) < Date.parse(startsAt)) {
      throw new ProposalStoreError("SHADOW_STUDY_TIME_RANGE_INVALID", "shadow study ends_at must not precede starts_at");
    }
    assertNoSecretMaterial({ name: name4, description, selected_capabilities: selectedCapabilities }, "shadow_study");
    const now = (/* @__PURE__ */ new Date()).toISOString();
    const studyId = input.study_id ? safeShadowId(input.study_id, "study") : `sst_${canonicalJsonDigest({ name: name4, now, ordinal: this.countTable("shadow_studies") }).slice("sha256:".length, "sha256:".length + 20)}`;
    try {
      this.db.prepare(`
          INSERT INTO shadow_studies (
            study_id, name, description, selected_capabilities_json, starts_at,
            ends_at, status, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)
        `).run(
        studyId,
        name4,
        description ?? null,
        JSON.stringify(selectedCapabilities),
        startsAt ?? null,
        endsAt ?? null,
        now,
        now
      );
    } catch (error) {
      throw new ProposalStoreError("SHADOW_STUDY_CREATE_FAILED", safeSqliteFailure(error, `shadow study ${studyId} could not be created`));
    }
    const study = this.getShadowStudy(studyId);
    if (!study) throw new ProposalStoreError("SHADOW_STUDY_CREATE_FAILED", `shadow study ${studyId} was not persisted`);
    this.syncShadowStudy(studyId);
    return this.getShadowStudy(studyId) ?? study;
  },
  getShadowStudy(studyId) {
    return rowToShadowStudy(this.db.prepare("SELECT * FROM shadow_studies WHERE study_id = ?").get(studyId));
  },
  listShadowStudies() {
    return this.db.prepare("SELECT * FROM shadow_studies ORDER BY created_at DESC, study_id ASC").all().map(rowToShadowStudy).filter((study) => study !== void 0);
  },
  closeShadowStudy(studyId, endsAt = (/* @__PURE__ */ new Date()).toISOString()) {
    this.requireShadowStudy(studyId);
    const normalizedEndsAt = optionalIsoTimestamp(endsAt, "shadow study ends_at");
    this.db.prepare(`
        UPDATE shadow_studies SET status = 'closed', ends_at = ?, updated_at = ?
        WHERE study_id = ?
      `).run(normalizedEndsAt, (/* @__PURE__ */ new Date()).toISOString(), studyId);
    return this.requireShadowStudy(studyId);
  },
  syncShadowStudy(studyId) {
    const study = this.requireShadowStudy(studyId);
    let attached = 0;
    for (const proposal of this.listProposals().filter((item) => item.change_set.mode === "shadow")) {
      if (!shadowStudyIncludes(study, proposal.capability ?? proposal.action, proposal.created_at)) continue;
      const before = this.shadowCases(studyId).length;
      this.addShadowProposalToStudy(studyId, proposal.proposal_id);
      if (this.shadowCases(studyId).length > before) attached += 1;
    }
    return { attached, total: this.shadowCases(studyId).length };
  },
  addShadowProposalToStudy(studyId, proposalId, requestId) {
    const study = this.requireShadowStudy(studyId);
    const proposal = this.requireProposal(proposalId);
    if (proposal.change_set.mode !== "shadow") {
      throw new ProposalStoreError("NOT_SHADOW_PROPOSAL", `proposal ${proposalId} is not a shadow proposal`);
    }
    if (!shadowStudyIncludes(study, proposal.capability ?? proposal.action, proposal.created_at)) {
      throw new ProposalStoreError("SHADOW_STUDY_SCOPE_MISMATCH", `proposal ${proposalId} is outside shadow study ${studyId}`);
    }
    return this.recordShadowCase({
      study_id: studyId,
      request_id: requestId ?? proposal.interaction_id ?? proposal.tool_call_id ?? proposal.proposal_id,
      proposal_id: proposal.proposal_id,
      tenant_id: proposal.tenant_id,
      principal: proposal.principal,
      capability: proposal.capability ?? proposal.action,
      business_object: proposal.business_object,
      object_id: proposal.object_id,
      evidence_bundle_id: proposal.change_set.evidence.bundle_id,
      proposed_effect: shadowEffectFromChangeSet(proposal.change_set),
      agent_result: "proposed",
      amount_value: effectAmountValue(shadowEffectFromChangeSet(proposal.change_set)),
      created_at: proposal.created_at
    });
  },
  recordShadowCase(input) {
    const study = this.requireShadowStudy(input.study_id);
    const requestId = requiredBoundedText(input.request_id, "shadow request_id", 256);
    const tenantId = requiredBoundedText(input.tenant_id, "shadow tenant_id", 256);
    const capability = requiredBoundedText(input.capability, "shadow capability", 256);
    const businessObject = requiredBoundedText(input.business_object, "shadow business_object", 128);
    const objectId = requiredBoundedText(input.object_id, "shadow object_id", 256);
    assertShadowAgentResult(input.agent_result);
    if (!shadowStudyIncludes(study, capability, input.created_at ?? (/* @__PURE__ */ new Date()).toISOString())) {
      throw new ProposalStoreError("SHADOW_STUDY_SCOPE_MISMATCH", `shadow case is outside study ${study.study_id}`);
    }
    if (input.proposal_id) {
      const proposal = this.requireProposal(input.proposal_id);
      if (proposal.change_set.mode !== "shadow") {
        throw new ProposalStoreError("NOT_SHADOW_PROPOSAL", `proposal ${input.proposal_id} is not a shadow proposal`);
      }
      if (proposal.tenant_id !== tenantId || proposal.business_object !== businessObject || proposal.object_id !== objectId || (proposal.capability ?? proposal.action) !== capability) {
        throw new ProposalStoreError("SHADOW_CASE_PROPOSAL_SCOPE_MISMATCH", "shadow case does not match the proposal's trusted tenant, target, or capability");
      }
    }
    if (input.agent_result === "proposed" && !input.proposed_effect) {
      throw new ProposalStoreError("SHADOW_PROPOSED_EFFECT_REQUIRED", "a proposed shadow case requires a normalized proposed effect");
    }
    const proposedEffect = input.proposed_effect ? normalizeShadowEffect(input.proposed_effect, "shadow_case.proposed_effect") : void 0;
    const riskScore = optionalFiniteNumber(input.risk_score, "shadow risk_score", 0, 100);
    const amountValue = optionalFiniteNumber(
      input.amount_value ?? (proposedEffect ? effectAmountValue(proposedEffect) : void 0),
      "shadow amount_value",
      0,
      Number.MAX_SAFE_INTEGER
    );
    const createdAt = optionalIsoTimestamp(input.created_at, "shadow case created_at") ?? (/* @__PURE__ */ new Date()).toISOString();
    const caseId = `scase_${canonicalJsonDigest({
      study_id: study.study_id,
      request_id: requestId,
      tenant_id: tenantId,
      business_object: businessObject,
      object_id: objectId
    }).slice("sha256:".length, "sha256:".length + 20)}`;
    const payload = {
      request_id: requestId,
      tenant_id: tenantId,
      principal: input.principal,
      capability,
      business_object: businessObject,
      object_id: objectId,
      evidence_bundle_id: input.evidence_bundle_id,
      proposed_effect: proposedEffect,
      decision_reason: input.decision_reason
    };
    assertNoSecretMaterial(payload, "shadow_case");
    this.db.prepare(`
        INSERT INTO shadow_study_cases (
          case_id, study_id, request_id, proposal_id, tenant_id, principal,
          capability, business_object, object_id, evidence_bundle_id,
          proposed_effect_json, agent_result, decision_reason, risk_score,
          amount_value, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(study_id, request_id, tenant_id, business_object, object_id)
        DO NOTHING
      `).run(
      caseId,
      study.study_id,
      requestId,
      input.proposal_id ?? null,
      tenantId,
      optionalBoundedText(input.principal, "shadow principal", 256) ?? null,
      capability,
      businessObject,
      objectId,
      optionalBoundedText(input.evidence_bundle_id, "shadow evidence reference", 256) ?? null,
      proposedEffect ? JSON.stringify(proposedEffect) : null,
      input.agent_result,
      optionalBoundedText(input.decision_reason, "shadow decision reason", 2e3) ?? null,
      riskScore ?? null,
      amountValue ?? null,
      createdAt
    );
    const stored = this.getShadowCase(caseId) ?? this.shadowCases(study.study_id).find(
      (item) => item.request_id === requestId && item.tenant_id === tenantId && item.business_object === businessObject && item.object_id === objectId
    );
    if (!stored) throw new ProposalStoreError("SHADOW_CASE_CREATE_FAILED", `shadow case ${caseId} was not persisted`);
    if (stored.agent_result !== input.agent_result || stored.capability !== capability || stored.proposal_id !== input.proposal_id) {
      throw new ProposalStoreError("SHADOW_CASE_IDENTITY_CONFLICT", `shadow case identity already exists with different immutable intent`);
    }
    return stored;
  },
  getShadowCase(caseId) {
    return rowToShadowCase(this.db.prepare("SELECT * FROM shadow_study_cases WHERE case_id = ?").get(caseId));
  },
  shadowCases(studyId) {
    return this.db.prepare(`
        SELECT * FROM shadow_study_cases WHERE study_id = ?
        ORDER BY created_at ASC, case_id ASC
      `).all(studyId).map(rowToShadowCase).filter((item) => item !== void 0);
  },
  recordShadowOutcome(input) {
    const study = this.requireShadowStudy(input.study_id);
    const requestId = requiredBoundedText(input.request_id, "shadow outcome request_id", 256);
    const tenantId = requiredBoundedText(input.tenant_id, "shadow outcome tenant_id", 256);
    const businessObject = requiredBoundedText(input.business_object, "shadow outcome business_object", 128);
    const objectId = requiredBoundedText(input.object_id, "shadow outcome object_id", 256);
    assertShadowOutcomeDisposition(input.disposition);
    const matchingCase = this.shadowCases(study.study_id).find(
      (item) => item.request_id === requestId && item.tenant_id === tenantId && item.business_object === businessObject && item.object_id === objectId
    );
    if (!matchingCase) {
      throw new ProposalStoreError("SHADOW_OUTCOME_CASE_NOT_FOUND", "authoritative outcome does not match a case in this shadow study");
    }
    if (input.proposal_id !== void 0 && matchingCase.proposal_id !== input.proposal_id) {
      throw new ProposalStoreError("SHADOW_OUTCOME_PROPOSAL_MISMATCH", "authoritative outcome proposal does not match the correlated shadow case");
    }
    if (input.disposition === "applied" && !input.actual_effect) {
      throw new ProposalStoreError("SHADOW_ACTUAL_EFFECT_REQUIRED", "an applied authoritative outcome requires actual before/after effect");
    }
    const actualEffect = input.actual_effect ? normalizeShadowEffect(input.actual_effect, "shadow_outcome.actual_effect") : void 0;
    const occurredAt = optionalIsoTimestamp(input.occurred_at, "shadow outcome occurred_at") ?? (/* @__PURE__ */ new Date()).toISOString();
    const actor = requiredBoundedText(input.actor, "shadow outcome actor", 256);
    const source = requiredBoundedText(input.source, "shadow outcome source", 256);
    const reference = optionalBoundedText(input.reference, "shadow outcome reference", 1024);
    const reason = optionalBoundedText(input.reason, "shadow outcome reason", 2e3);
    assertNoSecretMaterial({
      request_id: requestId,
      tenant_id: tenantId,
      business_object: businessObject,
      object_id: objectId,
      actor,
      source,
      actual_effect: actualEffect,
      reference,
      reason
    }, "shadow_outcome");
    const outcomeId = `sout_${canonicalJsonDigest({
      study_id: study.study_id,
      request_id: requestId,
      tenant_id: tenantId,
      business_object: businessObject,
      object_id: objectId,
      actor,
      disposition: input.disposition,
      actual_effect: actualEffect ?? null,
      occurred_at: occurredAt,
      source,
      reference: reference ?? null
    }).slice("sha256:".length, "sha256:".length + 20)}`;
    this.db.prepare(`
        INSERT OR IGNORE INTO shadow_outcomes (
          outcome_id, study_id, request_id, proposal_id, tenant_id,
          business_object, object_id, actor, disposition, actual_effect_json,
          occurred_at, source, reference, reason, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
      outcomeId,
      study.study_id,
      requestId,
      matchingCase.proposal_id ?? null,
      tenantId,
      businessObject,
      objectId,
      actor,
      input.disposition,
      actualEffect ? JSON.stringify(actualEffect) : null,
      occurredAt,
      source,
      reference ?? null,
      reason ?? null,
      (/* @__PURE__ */ new Date()).toISOString()
    );
    const outcome = this.getShadowOutcome(outcomeId);
    if (!outcome) throw new ProposalStoreError("SHADOW_OUTCOME_CREATE_FAILED", `shadow outcome ${outcomeId} was not persisted`);
    return outcome;
  },
  getShadowOutcome(outcomeId) {
    return rowToShadowOutcome(this.db.prepare("SELECT * FROM shadow_outcomes WHERE outcome_id = ?").get(outcomeId));
  },
  shadowOutcomes(studyId) {
    return this.db.prepare(`
        SELECT * FROM shadow_outcomes WHERE study_id = ?
        ORDER BY occurred_at ASC, outcome_id ASC
      `).all(studyId).map(rowToShadowOutcome).filter((item) => item !== void 0);
  },
  compareShadowStudyCase(caseId) {
    const shadowCase = this.getShadowCase(caseId);
    if (!shadowCase) throw new ProposalStoreError("SHADOW_CASE_NOT_FOUND", `shadow case not found: ${caseId}`);
    const outcome = this.latestShadowOutcomeForCase(shadowCase);
    return compareShadowStudyCase(shadowCase, outcome);
  },
  shadowStudyReport(studyId) {
    const study = this.requireShadowStudy(studyId);
    const cases = this.shadowCases(studyId);
    const outcomes = this.shadowOutcomes(studyId);
    const comparisons = cases.map((item) => this.compareShadowStudyCase(item.case_id));
    const comparable = comparisons.filter((item) => item.comparable);
    const exact = countShadowStatus(comparisons, "exact_agreement");
    const byCapability = {};
    const byDecisionReason = {};
    for (const comparison of comparisons) {
      byCapability[comparison.capability] ??= emptyShadowStatusCounts();
      byCapability[comparison.capability][comparison.status] += 1;
      const reason = comparison.decision_reason ?? comparison.outcome?.reason ?? "(none recorded)";
      byDecisionReason[reason] = (byDecisionReason[reason] ?? 0) + 1;
    }
    const amountValues = comparisons.map((item) => item.amount_value).filter((value) => typeof value === "number" && Number.isFinite(value));
    const highestRisk = comparisons.filter((item) => item.status === "disagreement" || item.status === "partial_agreement" || item.status === "invalid_or_unsafe_scope_attempt").sort(
      (left, right) => (right.risk_score ?? 0) - (left.risk_score ?? 0) || (right.amount_value ?? 0) - (left.amount_value ?? 0) || left.case_id.localeCompare(right.case_id)
    ).slice(0, 10);
    const suggestedPolicies = suggestedShadowPolicies(comparisons);
    return {
      study,
      total_tasks_observed: comparisons.length,
      tasks_with_authoritative_outcomes: comparisons.filter((item) => item.outcome !== void 0).length,
      comparable_tasks: comparable.length,
      exact_agreements: exact,
      exact_agreement_rate: comparable.length === 0 ? null : exact / comparable.length,
      partial_agreements: countShadowStatus(comparisons, "partial_agreement"),
      disagreements: countShadowStatus(comparisons, "disagreement"),
      human_rejections_no_action: countShadowStatus(comparisons, "human_rejected_no_action"),
      policy_denials: countShadowStatus(comparisons, "agent_policy_denied"),
      stale_conflicts: countShadowStatus(comparisons, "stale_conflict"),
      unmatched_cases: countShadowStatus(comparisons, "unmatched_no_authoritative_outcome"),
      invalid_or_unsafe_scope_attempts: countShadowStatus(comparisons, "invalid_or_unsafe_scope_attempt"),
      amount_value_distribution: distribution(amountValues),
      by_capability: byCapability,
      by_decision_reason: byDecisionReason,
      highest_risk_disagreements: highestRisk,
      suggested_policies: suggestedPolicies,
      trust_progression: shadowTrustProgression(comparisons, suggestedPolicies),
      comparisons,
      generated_at: latestIsoTimestamp([
        study.updated_at,
        ...cases.map((item) => item.created_at),
        ...outcomes.map((item) => item.created_at)
      ])
    };
  },
  requireShadowStudy(studyId) {
    const study = this.getShadowStudy(studyId);
    if (!study) throw new ProposalStoreError("SHADOW_STUDY_NOT_FOUND", `shadow study not found: ${studyId}`);
    return study;
  },
  latestShadowOutcomeForCase(shadowCase) {
    return rowToShadowOutcome(this.db.prepare(`
        SELECT * FROM shadow_outcomes
        WHERE study_id = ? AND request_id = ? AND tenant_id = ?
          AND business_object = ? AND object_id = ?
        ORDER BY occurred_at DESC, outcome_id DESC
        LIMIT 1
      `).get(
      shadowCase.study_id,
      shadowCase.request_id,
      shadowCase.tenant_id,
      shadowCase.business_object,
      shadowCase.object_id
    ));
  },
  attachShadowChangeSetToActiveStudies(changeSet, createdAt) {
    const studies = this.db.prepare("SELECT * FROM shadow_studies WHERE status = 'active'").all().map(rowToShadowStudy).filter((study) => study !== void 0);
    for (const study of studies) {
      if (!shadowStudyIncludes(study, changeSet.action, createdAt)) continue;
      this.insertShadowCaseFromChangeSet(study.study_id, changeSet, createdAt);
    }
  },
  insertShadowCaseFromChangeSet(studyId, changeSet, createdAt) {
    const requestId = changeSet.proposal_id;
    const scope2 = proposalScopeIndex(changeSet);
    const caseId = `scase_${canonicalJsonDigest({
      study_id: studyId,
      request_id: requestId,
      tenant_id: scope2.id,
      business_object: changeSet.scope.business_object,
      object_id: changeSet.scope.object_id
    }).slice("sha256:".length, "sha256:".length + 20)}`;
    const effect = shadowEffectFromChangeSet(changeSet);
    this.db.prepare(`
        INSERT OR IGNORE INTO shadow_study_cases (
          case_id, study_id, request_id, proposal_id, tenant_id, principal,
          capability, business_object, object_id, evidence_bundle_id,
          proposed_effect_json, agent_result, decision_reason, risk_score,
          amount_value, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'proposed', NULL, NULL, ?, ?)
      `).run(
      caseId,
      studyId,
      requestId,
      changeSet.proposal_id,
      scope2.id,
      changeSet.principal.id,
      changeSet.action,
      changeSet.scope.business_object,
      changeSet.scope.object_id,
      changeSet.evidence.bundle_id,
      JSON.stringify(effect),
      effectAmountValue(effect) ?? null,
      createdAt
    );
  },
  recordShadowHumanAction(proposalId, input) {
    const proposal = this.requireProposal(proposalId);
    if (proposal.change_set.mode !== "shadow") {
      throw new ProposalStoreError("NOT_SHADOW_PROPOSAL", `proposal ${proposalId} is not a shadow proposal`);
    }
    assertNoSecretMaterial(input.patch, "shadow_human_action.patch");
    const now = (/* @__PURE__ */ new Date()).toISOString();
    let actionId = 0;
    this.transaction(() => {
      const result = this.db.prepare(`
          INSERT INTO shadow_human_actions (proposal_id, actor, patch_json, notes, created_at)
          VALUES (?, ?, ?, ?, ?)
        `).run(proposalId, input.actor, JSON.stringify(input.patch), input.notes ?? null, now);
      actionId = Number(result.lastInsertRowid);
      this.appendEvent(proposalId, "shadow_human_action_recorded", input.actor, {
        action_id: actionId,
        patch_columns: Object.keys(input.patch),
        notes: input.notes ?? null
      });
    });
    const action = this.shadowHumanActions(proposalId).find((item) => item.action_id === actionId);
    if (!action) throw new ProposalStoreError("SHADOW_ACTION_CREATE_FAILED", `shadow action for ${proposalId} was not persisted`);
    const legacyStudy = this.getShadowStudy("sst_legacy") ?? this.createShadowStudy({
      study_id: "sst_legacy",
      name: "Legacy shadow comparison",
      description: "Compatibility study for shadow record-human-action commands."
    });
    const shadowCase = this.addShadowProposalToStudy(legacyStudy.study_id, proposalId);
    this.recordShadowOutcome({
      study_id: legacyStudy.study_id,
      request_id: shadowCase.request_id,
      proposal_id: proposalId,
      tenant_id: proposal.tenant_id,
      business_object: proposal.business_object,
      object_id: proposal.object_id,
      actor: input.actor,
      disposition: "applied",
      actual_effect: normalizeShadowEffect({
        before: proposal.change_set.before,
        after: { ...proposal.change_set.before, ...input.patch },
        patch: input.patch
      }, "shadow_human_action.effect"),
      occurred_at: now,
      source: "legacy_cli",
      reference: `shadow_human_action:${actionId}`,
      reason: input.notes
    });
    return action;
  },
  shadowHumanActions(proposalId) {
    const rows = this.db.prepare("SELECT * FROM shadow_human_actions WHERE proposal_id = ? ORDER BY action_id ASC").all(proposalId);
    return rows.map(rowToShadowHumanAction).filter((action) => action !== void 0);
  },
  compareShadowProposal(proposalId) {
    const proposal = this.requireProposal(proposalId);
    if (proposal.change_set.mode !== "shadow") {
      throw new ProposalStoreError("NOT_SHADOW_PROPOSAL", `proposal ${proposalId} is not a shadow proposal`);
    }
    const actions = this.shadowHumanActions(proposalId);
    const latest = actions.at(-1);
    return comparePatches(proposalId, proposal.change_set.patch, latest);
  },
  shadowReport() {
    const proposals = this.listProposals().filter((proposal) => proposal.change_set.mode === "shadow");
    const comparisons = proposals.map((proposal) => this.compareShadowProposal(proposal.proposal_id));
    return {
      total_shadow_proposals: proposals.length,
      with_human_action: comparisons.filter((comparison) => comparison.status !== "no_human_action").length,
      exact_matches: comparisons.filter((comparison) => comparison.status === "exact_match").length,
      partial_matches: comparisons.filter((comparison) => comparison.status === "partial_match").length,
      mismatches: comparisons.filter((comparison) => comparison.status === "mismatch").length,
      no_human_action: comparisons.filter((comparison) => comparison.status === "no_human_action").length,
      comparisons
    };
  }
};

// ../synapsor-runner/packages/proposal-store/src/sqlite-core-methods.ts
var proposalStoreInternalsMethods = {
  requireProposal(proposalId) {
    const proposal = this.getProposal(proposalId);
    if (!proposal) {
      throw new ProposalStoreError("PROPOSAL_NOT_FOUND", `proposal ${proposalId} not found`);
    }
    return proposal;
  },
  assertApprovalFreshness(proposal, proofDigest, now) {
    const authority2 = proposalFreshnessAuthority(proposal);
    if (!authority2) {
      if (proofDigest !== void 0) {
        throw new ProposalStoreError(
          "FRESHNESS_PROOF_UNEXPECTED",
          `proposal ${proposal.proposal_id} does not require a freshness proof`
        );
      }
      return;
    }
    if (!proofDigest) {
      throw new ProposalStoreError(
        "FRESHNESS_PROOF_REQUIRED",
        `proposal ${proposal.proposal_id} requires a fresh live proof before approval`
      );
    }
    const proof = this.latestFreshnessProof(proposal.proposal_id);
    if (!proof || proof.proof_digest !== proofDigest) {
      throw new ProposalStoreError(
        "FRESHNESS_PROOF_MISSING",
        `the latest freshness proof for proposal ${proposal.proposal_id} was not supplied`
      );
    }
    if (proof.proposal_hash !== proposal.proposal_hash || proof.proposal_version !== proposal.proposal_version || proof.dependency_set_digest !== authority2.dependency_set_digest) {
      throw new ProposalStoreError(
        "FRESHNESS_PROOF_AUTHORITY_MISMATCH",
        `freshness proof does not match proposal ${proposal.proposal_id}`
      );
    }
    if (proof.result !== "fresh") {
      throw new ProposalStoreError(
        proof.result === "stale" ? "FRESHNESS_STALE" : "FRESHNESS_NOT_VERIFIED",
        `proposal ${proposal.proposal_id} freshness result is ${proof.result}`
      );
    }
    if (Date.parse(proof.valid_until) < Date.parse(now)) {
      throw new ProposalStoreError(
        "FRESHNESS_PROOF_EXPIRED",
        `freshness proof for proposal ${proposal.proposal_id} has expired`
      );
    }
    const used = this.db.prepare(`
        SELECT approval_id
        FROM approvals
        WHERE proposal_id = ? AND freshness_proof_digest = ?
        LIMIT 1
      `).get(proposal.proposal_id, proofDigest);
    if (isRecord(used)) {
      throw new ProposalStoreError(
        "FRESHNESS_PROOF_ALREADY_USED",
        `freshness proof for proposal ${proposal.proposal_id} already authorized a reviewer decision`
      );
    }
  },
  setState(proposalId, state, actor, payload) {
    const now = (/* @__PURE__ */ new Date()).toISOString();
    this.transaction(() => {
      this.db.prepare("UPDATE proposals SET state = ?, updated_at = ? WHERE proposal_id = ?").run(state, now, proposalId);
      this.appendEvent(proposalId, `proposal_${state}`, actor, payload);
    });
  },
  appendEvent(proposalId, kind, actor, payload) {
    const append = () => {
      const createdAt = (/* @__PURE__ */ new Date()).toISOString();
      const result = this.db.prepare(`
          INSERT INTO proposal_events (proposal_id, kind, actor, payload_json, created_at)
          VALUES (?, ?, ?, ?, ?)
        `).run(proposalId, kind, actor, JSON.stringify(payload), createdAt);
      const proposal = this.requireProposal(proposalId);
      for (const event of attentionEventsForProposalEvent({
        proposal,
        proposal_event_id: String(result.lastInsertRowid),
        kind,
        actor,
        payload,
        environment: this.attentionEnvironment(),
        occurred_at: createdAt
      })) {
        this.recordAttentionEventInternal(event);
      }
      if (proposal.state !== "pending_review") {
        this.resolveSatisfiedProposalReviewAttention(proposal, createdAt);
      }
    };
    if (this.db.isTransaction) append();
    else this.transaction(append);
  },
  attentionEnvironment() {
    const context = this.getRunnerState("attention_context");
    const environment = context?.environment;
    return typeof environment === "string" && /^(development|staging|production|unknown)$/.test(environment) ? environment : "unknown";
  },
  resolveSatisfiedProposalReviewAttention(proposal, now) {
    const attentionKey = proposalReviewAttentionKey(proposal, this.attentionEnvironment());
    const pending = this.db.prepare(`
        SELECT COUNT(DISTINCT p.proposal_id) AS count
        FROM attention_events ae
        JOIN proposals p ON p.proposal_id = ae.proposal_id
        WHERE ae.attention_key = ?
          AND p.state = 'pending_review'
      `).get(attentionKey);
    if (isRecord(pending) && Number(pending.count ?? 0) > 0) return;
    this.db.prepare(`
        UPDATE attention_items
        SET status = 'resolved', resolved_at = ?, last_seen_at = MAX(last_seen_at, ?)
        WHERE attention_key = ?
          AND status IN ('open', 'acknowledged')
      `).run(now, now, attentionKey);
  },
  queryAudit(proposalId) {
    const rows = this.db.prepare("SELECT * FROM query_audit WHERE proposal_id = ? ORDER BY audit_id ASC").all(proposalId);
    const records = [];
    for (const row of rows) {
      if (!isRecord(row)) continue;
      records.push({
        audit_id: Number(row.audit_id),
        proposal_id: row.proposal_id == null ? void 0 : String(row.proposal_id),
        evidence_bundle_id: row.evidence_bundle_id == null ? void 0 : String(row.evidence_bundle_id),
        source_id: String(row.source_id),
        query_fingerprint: String(row.query_fingerprint),
        table_name: String(row.table_name),
        row_count: Number(row.row_count),
        payload: JSON.parse(String(row.payload_json)),
        created_at: String(row.created_at)
      });
    }
    return records;
  },
  queryAuditByEvidence(evidenceBundleId) {
    const rows = this.db.prepare("SELECT * FROM query_audit WHERE evidence_bundle_id = ? ORDER BY audit_id ASC").all(evidenceBundleId);
    return rows.map(rowToQueryAudit).filter((record2) => record2 !== void 0);
  },
  evidence(proposalId) {
    const rows = this.db.prepare("SELECT * FROM evidence_bundles WHERE proposal_id = ? ORDER BY created_at ASC").all(proposalId);
    const records = [];
    for (const row of rows) {
      if (!isRecord(row)) continue;
      records.push({
        evidence_bundle_id: String(row.evidence_bundle_id),
        proposal_id: row.proposal_id == null ? void 0 : String(row.proposal_id),
        tenant_id: String(row.tenant_id),
        payload: JSON.parse(String(row.payload_json)),
        items: this.evidenceItems(String(row.evidence_bundle_id)),
        query_audit: this.queryAuditByEvidence(String(row.evidence_bundle_id)),
        created_at: String(row.created_at)
      });
    }
    return records;
  },
  evidenceItems(evidenceBundleId) {
    const rows = this.db.prepare("SELECT * FROM evidence_items WHERE evidence_bundle_id = ? ORDER BY evidence_item_id ASC").all(evidenceBundleId);
    const records = [];
    for (const row of rows) {
      if (!isRecord(row)) continue;
      records.push({
        evidence_item_id: Number(row.evidence_item_id),
        evidence_bundle_id: String(evidenceBundleId),
        item: JSON.parse(String(row.item_json)),
        created_at: String(row.created_at)
      });
    }
    return records;
  },
  evidenceMetadata(input) {
    if (input.proposal) {
      return {
        principal: input.proposal.change_set.principal.id,
        capability: input.proposal.action,
        source_id: input.proposal.source_id,
        source_table: `${input.proposal.source_schema}.${input.proposal.source_table}`,
        business_object: input.proposal.business_object,
        object_id: input.proposal.object_id,
        query_fingerprint: input.proposal.change_set.evidence.query_fingerprint
      };
    }
    const firstItem = input.items.find(isRecord);
    const primaryKey = isRecord(firstItem?.primary_key) ? firstItem.primary_key : void 0;
    const principal = stringFromPrincipal(input.payload.principal);
    const table = stringFromUnknown(input.payload.source_table) ?? stringFromUnknown(input.payload.target) ?? stringFromUnknown(firstItem?.table);
    return {
      principal,
      capability: stringFromUnknown(input.payload.capability),
      source_id: stringFromUnknown(input.payload.source_id) ?? stringFromUnknown(firstItem?.source_id),
      source_table: table,
      business_object: table ? lastIdentifier(table) : void 0,
      object_id: primaryKey ? stringFromUnknown(primaryKey.value) : void 0,
      query_fingerprint: stringFromUnknown(input.payload.query_fingerprint)
    };
  },
  queryAuditMetadata(input) {
    if (input.proposal) {
      return {
        tenant_id: input.proposal.tenant_id,
        principal: input.proposal.change_set.principal.id,
        capability: input.proposal.action,
        business_object: input.proposal.business_object,
        object_id: input.proposal.object_id,
        primary_key_value: "value" in input.proposal.change_set.source.primary_key ? String(input.proposal.change_set.source.primary_key.value) : input.proposal.object_id
      };
    }
    const firstItem = input.evidence?.items.find((item) => isRecord(item.item))?.item;
    const primaryKey = isRecord(firstItem?.primary_key) ? firstItem.primary_key : void 0;
    return {
      tenant_id: input.evidence?.tenant_id ?? stringFromUnknown(input.payload.tenant_id),
      principal: input.evidence?.principal ?? stringFromPrincipal(input.payload.principal),
      capability: input.evidence?.capability ?? stringFromUnknown(input.payload.capability),
      business_object: input.evidence?.business_object ?? stringFromUnknown(input.payload.business_object),
      object_id: input.evidence?.object_id ?? stringFromUnknown(input.payload.object_id),
      primary_key_value: primaryKey ? stringFromUnknown(primaryKey.value) : input.evidence?.object_id ?? stringFromUnknown(input.payload.primary_key_value)
    };
  },
  countTable(table) {
    return this.countWhere(table, "1 = 1", []);
  },
  countWhere(table, where, params) {
    const row = this.db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${where}`).get(...params);
    return isRecord(row) ? Number(row.count ?? 0) : 0;
  },
  numberValue(sql) {
    const row = this.db.prepare(sql).get();
    if (!isRecord(row)) return 0;
    const value = Object.values(row)[0];
    return typeof value === "number" ? value : Number(value ?? 0);
  },
  stringColumn(sql, params, column) {
    return this.db.prepare(sql).all(...params).map((row) => isRecord(row) ? row[column] : void 0).filter((value) => typeof value === "string" || typeof value === "number").map(String);
  },
  evidenceIdsForPrune(cutoffIso, proposalIds) {
    const proposalWhere = inWhere("proposal_id", proposalIds);
    if (!proposalWhere) {
      return this.stringColumn("SELECT evidence_bundle_id FROM evidence_bundles WHERE created_at < ?", [cutoffIso], "evidence_bundle_id");
    }
    return this.stringColumn(
      `SELECT evidence_bundle_id FROM evidence_bundles WHERE created_at < ? OR ${proposalWhere.sql}`,
      [cutoffIso, ...proposalWhere.params],
      "evidence_bundle_id"
    );
  },
  transaction(fn) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
};

// ../synapsor-runner/packages/proposal-store/src/sqlite-method-installer.ts
function installProposalStoreMethods(target, ...groups) {
  for (const group of groups) {
    for (const key2 of Reflect.ownKeys(group)) {
      if (Object.prototype.hasOwnProperty.call(target, key2)) {
        throw new Error(`duplicate ProposalStore method: ${String(key2)}`);
      }
      const descriptor = Object.getOwnPropertyDescriptor(group, key2);
      if (!descriptor) continue;
      Object.defineProperty(target, key2, {
        ...descriptor,
        enumerable: false
      });
    }
  }
}

// ../synapsor-runner/packages/proposal-store/src/control-policy-repository.ts
import { randomUUID as randomUUID3 } from "node:crypto";

// ../synapsor-runner/packages/proposal-store/src/control-policy-values.ts
function scopeKey(scope2) {
  if (!scope2 || typeof scope2 !== "object") fail("POLICY_SCOPE_INVALID");
  const keys = Object.keys(scope2).sort().join(",");
  if (scope2.level === "operator" && keys === "level") return canonicalJsonStringify(scope2);
  if (scope2.level === "tenant" && keys === "level,tenant_id") {
    identifier(scope2.tenant_id);
    return canonicalJsonStringify(scope2);
  }
  if (scope2.level === "principal" && keys === "level,principal,tenant_id") {
    identifier(scope2.tenant_id);
    identifier(scope2.principal);
    return canonicalJsonStringify(scope2);
  }
  return fail("POLICY_SCOPE_INVALID");
}
function policyKind(value) {
  if (typeof value !== "string" || !["read", "action", "execution", "parent", "delegation", "management"].includes(value)) fail("POLICY_KIND_INVALID");
  return value;
}
function identifier(value) {
  if (typeof value !== "string" || !value || value.length > 256 || value.trim() !== value || /[\u0000-\u001f\u007f]/u.test(value)) fail("POLICY_IDENTIFIER_INVALID");
  return value;
}
function digest2(value) {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(value)) fail("POLICY_DIGEST_INVALID");
  return value;
}
function epoch(value) {
  const number = typeof value === "number" ? value : typeof value === "string" && /^[0-9]+$/u.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(number) || number < 0) fail("POLICY_EPOCH_INVALID");
  return number;
}
function boundedJson(value, limit) {
  const json = canonicalJsonStringify(value);
  if (Buffer.byteLength(json) > limit) fail("POLICY_CONTENT_TOO_LARGE");
  return json;
}
function exactlyOne(rows) {
  if (rows.length !== 1) fail("POLICY_REPOSITORY_UNAVAILABLE");
}
function fail(code) {
  throw new ProposalStoreError(code, code);
}

// ../synapsor-runner/packages/proposal-store/src/control-policy-reviews.ts
import { randomBytes, randomUUID } from "node:crypto";
function controlPolicyReviewSchema(c) {
  return [
    { sql: `CREATE TABLE IF NOT EXISTS ${c.table("reviews")} (
    deployment_id TEXT NOT NULL, review_id TEXT NOT NULL,
    scope_key TEXT NOT NULL, kind TEXT NOT NULL, name TEXT NOT NULL, revision_id TEXT NOT NULL,
    expected_epoch BIGINT NOT NULL CHECK (expected_epoch >= 0), operation TEXT NOT NULL CHECK (operation IN ('activate', 'revoke')),
    actor TEXT NOT NULL, session_digest TEXT NOT NULL, summary_digest TEXT NOT NULL, nonce_digest TEXT NOT NULL,
    expires_at_ms BIGINT NOT NULL, consumed_event_id TEXT,
    PRIMARY KEY (deployment_id, review_id),
    FOREIGN KEY (deployment_id, scope_key, kind, name, revision_id)
      REFERENCES ${c.table("revisions")}(deployment_id, scope_key, kind, name, revision_id),
    FOREIGN KEY (deployment_id, consumed_event_id) REFERENCES ${c.table("events")}(deployment_id, event_id))` },
    { sql: `CREATE INDEX IF NOT EXISTS control_policy_pending_reviews ON ${c.table("reviews")}
    (deployment_id, scope_key, kind, name, actor, consumed_event_id, expires_at_ms)` },
    { sql: `CREATE INDEX IF NOT EXISTS control_policy_review_history ON ${c.table("reviews")}
    (deployment_id, scope_key, kind, name, expected_epoch, revision_id)` }
  ];
}
var ControlPolicyReviews = class {
  constructor(c) {
    this.c = c;
  }
  c;
  async prepare(input) {
    const target = normalizedTarget(input);
    const ttl = input.ttl_ms ?? 3e5;
    if (!Number.isSafeInteger(ttl) || ttl < 1 || ttl > 9e5) fail("POLICY_REVIEW_TTL_INVALID");
    const reviewId = randomUUID(), nonce = randomBytes(32).toString("base64url");
    const k2 = keyValues(target);
    const rows = await this.c.execute([
      this.lock(target, false),
      this.currentPointer(target),
      {
        sql: `SELECT COUNT(*) AS n FROM ${this.c.table("reviews")}
          WHERE deployment_id = $1 AND scope_key = $2 AND kind = $3 AND name = $4 AND actor = $5
            AND expected_epoch = $6 AND consumed_event_id IS NULL AND expires_at_ms > ${this.c.nowMs}`,
        values: [...k2, target.actor, target.expected_epoch],
        check: (rows2) => {
          if (epoch(rows2[0]?.n) >= 16) fail("POLICY_REVIEW_LIMIT");
        }
      },
      {
        sql: `INSERT INTO ${this.c.table("reviews")}
          (deployment_id, scope_key, kind, name, revision_id, expected_epoch, operation,
           actor, session_digest, summary_digest, review_id, nonce_digest, expires_at_ms)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, ${this.c.nowMs} + $13)
          RETURNING expires_at_ms`,
        values: [
          ...k2,
          target.revision_id,
          target.expected_epoch,
          target.operation,
          target.actor,
          target.session_digest,
          target.summary_digest,
          reviewId,
          canonicalJsonDigest({ nonce }),
          ttl
        ]
      }
    ], "write");
    return { review: { ...target, review_id: reviewId, expires_at_ms: epoch(rows.at(-1)?.[0]?.expires_at_ms) }, nonce };
  }
  async confirm(input) {
    const target = normalizedTarget(input);
    const reviewId = identifier(input.review_id);
    if (typeof input.nonce !== "string" || !/^[a-zA-Z0-9_-]{43}$/u.test(input.nonce)) fail("POLICY_REVIEW_INVALID");
    const k2 = keyValues(target), eventId = `policy_review:${reviewId}`;
    const claim = [
      ...k2,
      target.revision_id,
      target.expected_epoch,
      target.operation,
      target.actor,
      target.session_digest,
      target.summary_digest,
      reviewId,
      canonicalJsonDigest({ nonce: input.nonce })
    ];
    const columns = [
      "deployment_id",
      "scope_key",
      "kind",
      "name",
      "revision_id",
      "expected_epoch",
      "operation",
      "actor",
      "session_digest",
      "summary_digest",
      "review_id",
      "nonce_digest"
    ];
    const match = (prefix = "") => columns.map((column, index) => `${prefix}${column} = $${index + 1}`).join(" AND ");
    const receipt2 = {
      operation: target.operation,
      key: target.key,
      revision_id: target.revision_id,
      summary_digest: target.summary_digest,
      review_id: reviewId,
      source_database_changed: false
    };
    let already;
    const replay = new Error("recorded review");
    const statements = [
      this.lock(target, false, false),
      {
        sql: `SELECT r.*, e.epoch AS committed_epoch, e.occurred_at
          FROM ${this.c.table("reviews")} r LEFT JOIN ${this.c.table("events")} e
            ON e.deployment_id = r.deployment_id AND e.event_id = r.consumed_event_id
          WHERE ${match("r.")}`,
        values: claim,
        check: (rows) => {
          const row = rows[0];
          if (rows.length !== 1 || !row) fail("POLICY_REVIEW_INVALID");
          if (row.consumed_event_id !== null) {
            if (row.consumed_event_id !== eventId || row.committed_epoch === null || typeof row.occurred_at !== "string") fail("POLICY_REVIEW_RECEIPT_INVALID");
            already = { ...receipt2, status: "already_committed", epoch: epoch(row.committed_epoch), event_id: eventId, occurred_at: row.occurred_at };
            throw replay;
          }
        }
      },
      this.lock(target, true),
      this.currentPointer(target),
      {
        sql: `SELECT review_id FROM ${this.c.table("reviews")} WHERE ${match()}
          AND consumed_event_id IS NULL AND expires_at_ms > ${this.c.nowMs}`,
        values: claim,
        check: (rows) => {
          if (rows.length !== 1) fail("POLICY_REVIEW_EXPIRED");
        }
      },
      {
        sql: `INSERT INTO ${this.c.table("active")} (deployment_id, scope_key, kind, name, revision_id)
          VALUES ($1, $2, $3, $4, $5) ON CONFLICT (deployment_id, scope_key, kind, name)
          DO UPDATE SET revision_id = excluded.revision_id`,
        values: [...k2, target.operation === "activate" ? target.revision_id : null]
      },
      ...target.operation === "activate" ? [{
        sql: `UPDATE ${this.c.table("drafts")} SET revision_id = NULL
          WHERE deployment_id = $1 AND scope_key = $2 AND kind = $3 AND name = $4 AND revision_id = $5`,
        values: [...k2, target.revision_id]
      }] : [],
      {
        sql: `INSERT INTO ${this.c.table("events")} (deployment_id, epoch, event_id, actor, occurred_at, receipt_json)
          VALUES ($1, $2, $3, $4, ${this.c.nowIso}, $5) RETURNING occurred_at`,
        values: [target.deployment_id, target.expected_epoch + 1, eventId, target.actor, boundedJson(receipt2, 64 * 1024)]
      },
      {
        sql: `UPDATE ${this.c.table("reviews")} SET consumed_event_id = $13 WHERE ${match()}
          AND consumed_event_id IS NULL AND expires_at_ms > ${this.c.nowMs} RETURNING review_id`,
        values: [...claim, eventId],
        check: (rows) => {
          if (rows.length !== 1) fail("POLICY_REVIEW_EXPIRED");
        }
      }
    ];
    try {
      const rows = await this.c.execute(statements, "write");
      return {
        ...receipt2,
        status: "committed",
        epoch: target.expected_epoch + 1,
        event_id: eventId,
        occurred_at: String(rows.at(-2)?.[0]?.occurred_at)
      };
    } catch (error) {
      if (error === replay && already) return already;
      throw error;
    }
  }
  lock(target, increment, checkEpoch = true) {
    return {
      sql: `UPDATE ${this.c.table("deployments")} SET epoch = epoch${increment ? " + 1" : ""}
        WHERE deployment_id = $1${checkEpoch ? " AND epoch = $2" : ""} RETURNING epoch`,
      values: [target.deployment_id, ...checkEpoch ? [target.expected_epoch] : []],
      check: (rows) => {
        if (rows.length !== 1) fail("POLICY_REVISION_CONFLICT");
      }
    };
  }
  currentPointer(target) {
    const table = this.c.table(target.operation === "activate" ? "drafts" : "active");
    return {
      sql: `SELECT revision_id FROM ${table}
        WHERE deployment_id = $1 AND scope_key = $2 AND kind = $3 AND name = $4 AND revision_id = $5`,
      values: [...keyValues(target), target.revision_id],
      check: (rows) => {
        if (rows.length !== 1) fail("POLICY_REVIEW_REVISION_CHANGED");
      }
    };
  }
};
function keyValues(target) {
  return [target.deployment_id, scopeKey(target.key.scope), policyKind(target.key.kind), identifier(target.key.name)];
}
function normalizedTarget(input) {
  const expected = epoch(input.expected_epoch);
  if (expected >= Number.MAX_SAFE_INTEGER) fail("POLICY_EPOCH_INVALID");
  if (input.operation !== "activate" && input.operation !== "revoke") fail("POLICY_REVIEW_OPERATION_INVALID");
  return {
    deployment_id: identifier(input.deployment_id),
    key: {
      scope: JSON.parse(scopeKey(input.key.scope)),
      kind: policyKind(input.key.kind),
      name: identifier(input.key.name)
    },
    revision_id: identifier(input.revision_id),
    expected_epoch: expected,
    operation: input.operation,
    actor: identifier(input.actor),
    session_digest: digest2(input.session_digest),
    summary_digest: digest2(input.summary_digest)
  };
}

// ../synapsor-runner/packages/proposal-store/src/control-hard-budgets.ts
function controlHardBudgetSchema(c) {
  return [
    { sql: `CREATE TABLE IF NOT EXISTS ${c.table("budget_accounts")} (
      deployment_id TEXT NOT NULL, scope_key TEXT NOT NULL, meter TEXT NOT NULL, unit TEXT NOT NULL, scale BIGINT NOT NULL CHECK (scale > 0),
      PRIMARY KEY (deployment_id, scope_key, meter), FOREIGN KEY (deployment_id) REFERENCES ${c.table("deployments")}(deployment_id))` },
    { sql: `CREATE TABLE IF NOT EXISTS ${c.table("budget_requests")} (
      deployment_id TEXT NOT NULL, request_id TEXT NOT NULL, effect_digest TEXT NOT NULL, payload_digest TEXT NOT NULL,
      policy_chain_digest TEXT NOT NULL, authorization_epoch BIGINT NOT NULL, account_count INTEGER NOT NULL CHECK (account_count BETWEEN 1 AND 8),
      state TEXT NOT NULL CHECK (state IN ('reserved', 'unknown', 'committed', 'released')), reserved_at_ms BIGINT NOT NULL,
      receipt_digest TEXT, PRIMARY KEY (deployment_id, request_id),
      FOREIGN KEY (deployment_id) REFERENCES ${c.table("deployments")}(deployment_id))` },
    { sql: `CREATE TABLE IF NOT EXISTS ${c.table("budget_entries")} (
      deployment_id TEXT NOT NULL, scope_key TEXT NOT NULL, meter TEXT NOT NULL, request_id TEXT NOT NULL,
      amount BIGINT NOT NULL CHECK (amount > 0), state TEXT NOT NULL CHECK (state IN ('reserved', 'unknown', 'committed', 'released')),
      window_ms BIGINT NOT NULL CHECK (window_ms > 0),
      settled_at_ms BIGINT,
      PRIMARY KEY (deployment_id, scope_key, meter, request_id),
      FOREIGN KEY (deployment_id, scope_key, meter) REFERENCES ${c.table("budget_accounts")}(deployment_id, scope_key, meter),
      FOREIGN KEY (deployment_id, request_id) REFERENCES ${c.table("budget_requests")}(deployment_id, request_id))` },
    { sql: `CREATE INDEX IF NOT EXISTS control_policy_budget_usage ON ${c.table("budget_entries")}
      (deployment_id, scope_key, meter, state, settled_at_ms)` },
    { sql: `CREATE INDEX IF NOT EXISTS control_policy_budget_request_entries ON ${c.table("budget_entries")} (deployment_id, request_id)` },
    { sql: `CREATE TABLE IF NOT EXISTS ${c.table("budget_receipts")} (
      deployment_id TEXT NOT NULL, request_id TEXT NOT NULL, receipt_digest TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('unknown', 'committed', 'released')), recorded_at_ms BIGINT NOT NULL,
      PRIMARY KEY (deployment_id, request_id, receipt_digest),
      FOREIGN KEY (deployment_id, request_id) REFERENCES ${c.table("budget_requests")}(deployment_id, request_id))` }
  ];
}
var ControlHardBudgets = class {
  constructor(c) {
    this.c = c;
  }
  c;
  async reserve(input) {
    const replay = new Error("existing reservation");
    let existing;
    const statements = this.reservationStatements(input, (row) => {
      existing = receipt(row, "existing");
      throw replay;
    });
    try {
      await this.c.execute(statements, "write");
    } catch (error) {
      if (error === replay && existing) return existing;
      throw error;
    }
    return { request_id: identifier(input.request_id), state: "reserved", status: "reserved", execution_authorized: false };
  }
  /** Internal same-connection composition with effect admission. It must run
   * as ONE write transaction, never as independent statements. Existing holds
   * may continue only for the same exact chain/effect and still-current cap. */
  reservationStatements(input, onExisting) {
    const deployment = identifier(input.deployment_id), request = identifier(input.request_id), effect = digest2(input.effect_digest);
    const expected = epoch(input.expected_epoch), chain = digest2(input.policy_chain_digest);
    if (!Array.isArray(input.accounts) || input.accounts.length < 1 || input.accounts.length > 8) fail("BUDGET_ACCOUNT_LIMIT");
    const accounts = input.accounts.map((value) => ({ ...normalizeLimit(value), amount: positive(value.amount) })).sort((a2, b) => accountId(a2).localeCompare(accountId(b)));
    if (new Set(accounts.map(accountId)).size !== accounts.length) fail("BUDGET_DUPLICATE_ACCOUNT");
    const payload = canonicalJsonDigest({
      effect_digest: effect,
      accounts: accounts.map(({ limit: _limit, window_ms: _window, ...value }) => value)
    });
    const statements = [this.lock(deployment, expected), {
      sql: `SELECT * FROM ${this.c.table("budget_requests")} WHERE deployment_id = $1 AND request_id = $2`,
      values: [deployment, request],
      check: (rows) => {
        if (!rows.length) return;
        if (rows[0].payload_digest !== payload || rows[0].effect_digest !== effect) fail("BUDGET_REQUEST_CONFLICT");
        onExisting?.(rows[0]);
        if (rows[0].state !== "reserved" || rows[0].policy_chain_digest !== chain) fail("EFFECT_BUDGET_NOT_RESERVED");
      }
    }, {
      sql: `INSERT INTO ${this.c.table("budget_requests")}
        (deployment_id, request_id, effect_digest, payload_digest, policy_chain_digest, authorization_epoch, account_count, state, reserved_at_ms)
        VALUES ($1, $2, $3, $4, $5, $6, $7, 'reserved', ${this.c.nowMs})
        ON CONFLICT (deployment_id, request_id) DO NOTHING`,
      values: [deployment, request, effect, payload, chain, expected, accounts.length]
    }];
    for (const account of accounts) {
      const key2 = [deployment, account.scope_key, account.meter];
      statements.push({
        sql: `INSERT INTO ${this.c.table("budget_accounts")} (deployment_id, scope_key, meter, unit, scale)
          VALUES ($1, $2, $3, $4, $5) ON CONFLICT (deployment_id, scope_key, meter) DO NOTHING`,
        values: [...key2, account.unit, account.scale]
      }, this.accountCheck(deployment, account), this.usage(deployment, account, (committed, reserved) => {
        if (account.amount > account.limit - committed - reserved) fail("HARD_BUDGET_EXCEEDED");
      }, request), {
        sql: `INSERT INTO ${this.c.table("budget_entries")} (deployment_id, scope_key, meter, request_id, amount, window_ms, state)
          VALUES ($1, $2, $3, $4, $5, $6, 'reserved')
          ON CONFLICT (deployment_id, scope_key, meter, request_id) DO NOTHING`,
        values: [...key2, request, account.amount, account.window_ms]
      });
    }
    return statements;
  }
  async inspect(input) {
    const deployment = identifier(input.deployment_id), account = normalizeLimit(input.account);
    let result = { committed: 0, reserved: 0, available: account.limit };
    await this.c.execute([this.accountCheck(deployment, account, true), this.usage(deployment, account, (committed, reserved) => {
      result = { committed, reserved, available: Math.max(0, account.limit - committed - reserved) };
    })]);
    return result;
  }
  /** Settlement records a real effect even after policy revocation. `released`
   * requires trusted evidence that no effect occurred; a timeout is `unknown`.
   * Terminal outcomes cannot be rewritten or refunded by changing policy. */
  async settle(input) {
    const deployment = identifier(input.deployment_id), request = identifier(input.request_id), effect = digest2(input.effect_digest);
    const proof = digest2(input.receipt_digest), state = input.state;
    if (!["committed", "unknown", "released"].includes(state)) fail("BUDGET_SETTLEMENT_INVALID");
    let count = 0, existing;
    const replay = new Error("recorded settlement");
    const statements = [this.lock(deployment), {
      sql: `SELECT * FROM ${this.c.table("budget_requests")} WHERE deployment_id = $1 AND request_id = $2`,
      values: [deployment, request],
      check: (rows) => {
        const row = rows[0];
        if (!row || row.effect_digest !== effect) fail("BUDGET_REQUEST_CONFLICT");
        count = epoch(row.account_count);
        if (row.state === state && row.receipt_digest === proof) {
          existing = receipt(row, "existing");
          throw replay;
        }
        if (row.state === "committed" || row.state === "released") fail("BUDGET_SETTLEMENT_CONFLICT");
      }
    }, {
      sql: `INSERT INTO ${this.c.table("budget_receipts")} (deployment_id, request_id, receipt_digest, state, recorded_at_ms)
        VALUES ($1, $2, $3, $4, ${this.c.nowMs})`,
      values: [deployment, request, proof, state]
    }, {
      sql: `UPDATE ${this.c.table("budget_entries")} SET state = $3, settled_at_ms = ${state === "unknown" ? "NULL" : this.c.nowMs}
        WHERE deployment_id = $1 AND request_id = $2 AND state IN ('reserved', 'unknown') RETURNING meter`,
      values: [deployment, request, state],
      check: (rows) => {
        if (rows.length !== count) fail("BUDGET_SETTLEMENT_CONFLICT");
      }
    }, {
      sql: `UPDATE ${this.c.table("budget_requests")} SET state = $3, receipt_digest = $4
        WHERE deployment_id = $1 AND request_id = $2 AND state IN ('reserved', 'unknown') RETURNING *`,
      values: [deployment, request, state, proof],
      check: (rows) => {
        if (rows.length !== 1) fail("BUDGET_SETTLEMENT_CONFLICT");
      }
    }];
    try {
      const rows = await this.c.execute(statements, "write");
      return receipt(rows.at(-1)[0], "settled");
    } catch (error) {
      if (error === replay && existing) return existing;
      throw error;
    }
  }
  lock(deployment, expected) {
    return {
      sql: `UPDATE ${this.c.table("deployments")} SET epoch = epoch WHERE deployment_id = $1${expected === void 0 ? "" : " AND epoch = $2"} RETURNING epoch`,
      values: [deployment, ...expected === void 0 ? [] : [expected]],
      check: (rows) => {
        if (rows.length !== 1) fail("POLICY_REVISION_CONFLICT");
      }
    };
  }
  accountCheck(deployment, account, allowMissing = false) {
    return {
      sql: `SELECT unit, scale FROM ${this.c.table("budget_accounts")} WHERE deployment_id = $1 AND scope_key = $2 AND meter = $3`,
      values: [deployment, account.scope_key, account.meter],
      check: (rows) => {
        if (allowMissing && !rows.length) return;
        if (rows.length !== 1 || rows[0].unit !== account.unit || epoch(rows[0].scale) !== account.scale) fail("BUDGET_UNIT_MISMATCH");
      }
    };
  }
  usage(deployment, account, check, excludeRequest) {
    return {
      sql: `SELECT state, COALESCE(SUM(amount), 0) AS amount FROM ${this.c.table("budget_entries")}
        WHERE deployment_id = $1 AND scope_key = $2 AND meter = $3${excludeRequest ? " AND request_id <> $5" : ""}
          AND (state IN ('reserved', 'unknown') OR (state = 'committed'
            AND settled_at_ms > ${this.c.nowMs} - CASE WHEN window_ms > $4 THEN window_ms ELSE $4 END)) GROUP BY state`,
      values: [deployment, account.scope_key, account.meter, account.window_ms, ...excludeRequest ? [excludeRequest] : []],
      check: (rows) => {
        const committed = rows.filter((row) => row.state === "committed").reduce((n2, row) => n2 + epoch(row.amount), 0);
        const reserved = rows.filter((row) => row.state !== "committed").reduce((n2, row) => n2 + epoch(row.amount), 0);
        if (!Number.isSafeInteger(committed + reserved)) fail("BUDGET_USAGE_OVERFLOW");
        check(committed, reserved);
      }
    };
  }
};
function normalizeLimit(input) {
  const limit = input.limit;
  if (!Number.isSafeInteger(limit) || limit < 0) fail("BUDGET_VALUE_INVALID");
  return {
    scope_key: scopeKey(input.scope),
    meter: identifier(input.meter),
    unit: identifier(input.unit),
    scale: positive(input.scale),
    limit,
    window_ms: positive(input.window_ms, 366 * 864e5)
  };
}
function positive(value, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) fail("BUDGET_VALUE_INVALID");
  return value;
}
function accountId(value) {
  return canonicalJsonDigest({ scope_key: value.scope_key, meter: value.meter });
}
function receipt(row, status) {
  if (!["reserved", "unknown", "committed", "released"].includes(String(row.state))) fail("BUDGET_STATE_INVALID");
  return {
    request_id: identifier(row.request_id),
    state: row.state,
    status,
    ...row.receipt_digest == null ? {} : { receipt_digest: digest2(row.receipt_digest) },
    execution_authorized: false
  };
}

// ../synapsor-runner/packages/proposal-store/src/control-effect-admissions.ts
import { randomBytes as randomBytes2, randomUUID as randomUUID2 } from "node:crypto";
function controlEffectAdmissionSchema(c) {
  return [
    { sql: `CREATE TABLE IF NOT EXISTS ${c.table("effect_admissions")} (
      deployment_id TEXT NOT NULL, request_id TEXT NOT NULL, dispatch_id TEXT NOT NULL,
      actor_digest TEXT NOT NULL, policy_chain_digest TEXT NOT NULL, effect_digest TEXT NOT NULL,
      budget_request_id TEXT, prepared_epoch BIGINT NOT NULL, dispatch_epoch BIGINT,
      expires_at_ms BIGINT NOT NULL, nonce_digest TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('prepared', 'dispatched', 'unknown', 'completed', 'no_effect')),
      dispatched_at_ms BIGINT, receipt_digest TEXT,
      PRIMARY KEY (deployment_id, request_id), UNIQUE (deployment_id, dispatch_id), UNIQUE (deployment_id, budget_request_id),
      FOREIGN KEY (deployment_id) REFERENCES ${c.table("deployments")}(deployment_id),
      FOREIGN KEY (deployment_id, budget_request_id) REFERENCES ${c.table("budget_requests")}(deployment_id, request_id))` },
    { sql: `CREATE TABLE IF NOT EXISTS ${c.table("effect_receipts")} (
      deployment_id TEXT NOT NULL, dispatch_id TEXT NOT NULL, receipt_digest TEXT NOT NULL, recorded_at_ms BIGINT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('unknown', 'completed', 'no_effect')),
      PRIMARY KEY (deployment_id, dispatch_id, receipt_digest),
      FOREIGN KEY (deployment_id, dispatch_id) REFERENCES ${c.table("effect_admissions")}(deployment_id, dispatch_id))` }
  ];
}
var ControlEffectAdmissions = class {
  constructor(c, budgets) {
    this.c = c;
    this.budgets = budgets;
  }
  c;
  budgets;
  /** Trusted executor reconciliation only. No nonce or new dispatch authority
   * is returned, and completed/uncertain effects remain inspectable after the
   * originating short-lived workload or parent permission expires. */
  async inspect(input) {
    const target = normalize({ ...input, expected_epoch: 0 });
    const rows = await this.c.execute([{
      sql: `SELECT * FROM ${this.c.table("effect_admissions")}
        WHERE deployment_id = $1 AND request_id = $2 AND actor_digest = $3 AND policy_chain_digest = $4 AND effect_digest = $5`,
      values: targetValues(target),
      check: (rows2) => {
        if (rows2.length !== 1) fail("EFFECT_ADMISSION_INVALID");
      }
    }]);
    const row = rows[0][0], result = prepared(row);
    return {
      dispatch_id: result.dispatch_id,
      state: result.state,
      ...row.receipt_digest == null ? {} : { receipt_digest: digest2(row.receipt_digest) }
    };
  }
  async prepare(input) {
    const target = normalize(input), expires = epoch(input.expires_at_ms);
    if (input.budget_request_id !== void 0 && input.budget_accounts !== void 0) fail("EFFECT_ADMISSION_INVALID");
    const budget = input.budget_accounts === void 0 ? input.budget_request_id === void 0 ? null : identifier(input.budget_request_id) : target.request_id;
    const reservation = input.budget_accounts === void 0 ? [] : this.budgets.reservationStatements({ ...target, accounts: input.budget_accounts });
    const nonce = randomBytes2(32).toString("base64url"), nonceDigest = canonicalJsonDigest({ nonce });
    const replay = new Error("existing admission");
    let existing;
    const values = targetValues(target);
    const statements = [this.lock(target), {
      sql: `SELECT * FROM ${this.c.table("effect_admissions")} WHERE deployment_id = $1 AND request_id = $2`,
      values: values.slice(0, 2),
      check: (rows) => {
        const row = rows[0];
        if (!row) return;
        if (row.actor_digest !== target.actor_digest || row.policy_chain_digest !== target.policy_chain_digest || row.effect_digest !== target.effect_digest || row.budget_request_id !== budget || epoch(row.expires_at_ms) !== expires) fail("EFFECT_ADMISSION_CONFLICT");
        if (row.state !== "prepared") {
          existing = prepared(row);
          throw replay;
        }
      }
    }, {
      sql: `SELECT ${this.c.nowMs} AS now_ms`,
      check: (rows) => {
        const now = epoch(rows[0]?.now_ms);
        if (expires <= now || expires > now + 9e5) fail("EFFECT_ADMISSION_EXPIRED");
      }
    }, ...reservation, ...budget ? [this.budgetCheck(target, budget)] : [], {
      sql: `INSERT INTO ${this.c.table("effect_admissions")}
        (deployment_id, request_id, actor_digest, policy_chain_digest, effect_digest, dispatch_id, budget_request_id,
         prepared_epoch, expires_at_ms, nonce_digest, state)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'prepared')
        ON CONFLICT (deployment_id, request_id) DO UPDATE SET nonce_digest = excluded.nonce_digest
        RETURNING *`,
      values: [...values, randomUUID2(), budget, target.expected_epoch, expires, nonceDigest]
    }];
    try {
      const rows = await this.c.execute(statements, "write");
      return { ...prepared(rows.at(-1)[0]), nonce };
    } catch (error) {
      if (error === replay && existing) return existing;
      throw error;
    }
  }
  async dispatch(input) {
    const target = normalize(input);
    if (typeof input.nonce !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(input.nonce)) fail("EFFECT_ADMISSION_INVALID");
    const values = [...targetValues(target), canonicalJsonDigest({ nonce: input.nonce })];
    const match = "deployment_id = $1 AND request_id = $2 AND actor_digest = $3 AND policy_chain_digest = $4 AND effect_digest = $5 AND nonce_digest = $6";
    const replay = new Error("already consumed");
    let existing;
    const statements = [this.lock(target), {
      sql: `SELECT * FROM ${this.c.table("effect_admissions")} WHERE ${match}`,
      values,
      check: (rows) => {
        if (rows.length !== 1) fail("EFFECT_ADMISSION_INVALID");
        if (rows[0].state !== "prepared") {
          existing = prepared(rows[0]);
          throw replay;
        }
      }
    }, {
      sql: `SELECT a.dispatch_id FROM ${this.c.table("effect_admissions")} a
        LEFT JOIN ${this.c.table("budget_requests")} b ON a.deployment_id = b.deployment_id AND a.budget_request_id = b.request_id
        WHERE a.deployment_id = $1 AND a.request_id = $2
          AND (a.budget_request_id IS NULL OR (b.state = 'reserved' AND b.effect_digest = a.effect_digest))`,
      values: values.slice(0, 2),
      check: (rows) => {
        if (rows.length !== 1) fail("EFFECT_BUDGET_NOT_RESERVED");
      }
    }, {
      sql: `UPDATE ${this.c.table("effect_admissions")} SET state = 'dispatched', dispatch_epoch = $7, dispatched_at_ms = ${this.c.nowMs}
        WHERE ${match} AND state = 'prepared' AND expires_at_ms > ${this.c.nowMs} RETURNING dispatch_id`,
      values: [...values, target.expected_epoch],
      check: (rows) => {
        if (rows.length !== 1) fail("EFFECT_ADMISSION_EXPIRED");
      }
    }];
    try {
      const rows = await this.c.execute(statements, "write");
      return { dispatch_id: identifier(rows.at(-1)[0].dispatch_id), status: "authorized", state: "dispatched", reconciliation_required: false };
    } catch (error) {
      if (error === replay && existing) return {
        dispatch_id: existing.dispatch_id,
        status: "not_authorized",
        state: existing.state,
        reconciliation_required: existing.state === "dispatched" || existing.state === "unknown"
      };
      throw error;
    }
  }
  /** The receipt comes from the executor, not a model statement. Record it
   * durably before settlement. A crash between these two transactions leaves
   * capacity held, never prematurely free; replay retries accounting safely. */
  async record(input) {
    return this.recordResult(input, false);
  }
  /** Cancellation proves absence of dispatch under the same writer lock. Once
   * dispatched, only executor evidence may resolve an effect as no_effect. */
  async cancelPrepared(input) {
    return this.recordResult({ ...input, state: "no_effect", receipt_digest: canonicalJsonDigest({ operation: "cancel_prepared_effect", ...input }) }, true);
  }
  async recordResult(input, preparedOnly) {
    const deployment = identifier(input.deployment_id), request = identifier(input.request_id), dispatch = identifier(input.dispatch_id);
    const effect = digest2(input.effect_digest), proof = digest2(input.receipt_digest), state = input.state;
    if (!["unknown", "completed", "no_effect"].includes(state)) fail("EFFECT_RECEIPT_INVALID");
    let budget = null, recorded = false;
    const replay = new Error("recorded effect receipt");
    try {
      await this.c.execute([{
        sql: `UPDATE ${this.c.table("deployments")} SET epoch = epoch WHERE deployment_id = $1 RETURNING epoch`,
        values: [deployment],
        check: (rows) => {
          if (rows.length !== 1) fail("POLICY_REPOSITORY_UNAVAILABLE");
        }
      }, {
        sql: `SELECT * FROM ${this.c.table("effect_admissions")} WHERE deployment_id = $1 AND request_id = $2 AND dispatch_id = $3 AND effect_digest = $4`,
        values: [deployment, request, dispatch, effect],
        check: (rows) => {
          const row = rows[0];
          if (!row) fail("EFFECT_ADMISSION_INVALID");
          budget = row.budget_request_id == null ? null : identifier(row.budget_request_id);
          if (row.state === state && row.receipt_digest === proof) {
            recorded = true;
            throw replay;
          }
          if (preparedOnly && row.state !== "prepared") fail("EFFECT_ALREADY_DISPATCHED");
          if (row.state === "completed" || row.state === "no_effect" || !preparedOnly && row.state === "prepared") fail("EFFECT_RECEIPT_CONFLICT");
        }
      }, {
        sql: `INSERT INTO ${this.c.table("effect_receipts")} (deployment_id, dispatch_id, receipt_digest, recorded_at_ms, state)
          VALUES ($1, $2, $3, ${this.c.nowMs}, $4)`,
        values: [deployment, dispatch, proof, state]
      }, {
        sql: `UPDATE ${this.c.table("effect_admissions")} SET state = $3, receipt_digest = $4
          WHERE deployment_id = $1 AND request_id = $2 RETURNING request_id`,
        values: [deployment, request, state, proof],
        check: (rows) => {
          if (rows.length !== 1) fail("EFFECT_RECEIPT_CONFLICT");
        }
      }], "write");
    } catch (error) {
      if (error !== replay || !recorded) throw error;
    }
    if (budget) {
      try {
        await this.budgets.settle({
          deployment_id: deployment,
          request_id: budget,
          effect_digest: effect,
          state: state === "completed" ? "committed" : state === "no_effect" ? "released" : "unknown",
          receipt_digest: proof
        });
      } catch {
        return { state, receipt_digest: proof, accounting_pending: true };
      }
    }
    return { state, receipt_digest: proof, accounting_pending: false };
  }
  lock(target) {
    return {
      sql: `UPDATE ${this.c.table("deployments")} SET epoch = epoch WHERE deployment_id = $1 AND epoch = $2 RETURNING epoch`,
      values: [target.deployment_id, target.expected_epoch],
      check: (rows) => {
        if (rows.length !== 1) fail("POLICY_REVISION_CONFLICT");
      }
    };
  }
  budgetCheck(target, request) {
    return {
      sql: `SELECT request_id FROM ${this.c.table("budget_requests")}
      WHERE deployment_id = $1 AND request_id = $2 AND effect_digest = $3 AND state = 'reserved'`,
      values: [target.deployment_id, request, target.effect_digest],
      check: (rows) => {
        if (rows.length !== 1) fail("EFFECT_BUDGET_NOT_RESERVED");
      }
    };
  }
};
function normalize(input) {
  return {
    deployment_id: identifier(input.deployment_id),
    request_id: identifier(input.request_id),
    expected_epoch: epoch(input.expected_epoch),
    actor_digest: digest2(input.actor_digest),
    policy_chain_digest: digest2(input.policy_chain_digest),
    effect_digest: digest2(input.effect_digest)
  };
}
function targetValues(input) {
  return [input.deployment_id, input.request_id, input.actor_digest, input.policy_chain_digest, input.effect_digest];
}
function prepared(row) {
  const state = row.state;
  if (!["prepared", "dispatched", "unknown", "completed", "no_effect"].includes(state)) fail("EFFECT_ADMISSION_INVALID");
  return { dispatch_id: identifier(row.dispatch_id), state, expires_at_ms: epoch(row.expires_at_ms) };
}

// ../synapsor-runner/packages/proposal-store/src/control-runtime-proofs.ts
function controlRuntimeProofSchema(c) {
  return [
    { sql: `CREATE TABLE IF NOT EXISTS ${c.table("runtime_proofs")} (
    deployment_id TEXT NOT NULL, proposal_id TEXT NOT NULL, scope_key TEXT NOT NULL,
    content_digest TEXT NOT NULL, content_json TEXT NOT NULL, expires_at_ms BIGINT NOT NULL, created_epoch BIGINT NOT NULL,
    PRIMARY KEY (deployment_id, proposal_id),
    FOREIGN KEY (deployment_id) REFERENCES ${c.table("deployments")}(deployment_id))` },
    { sql: `CREATE INDEX IF NOT EXISTS control_policy_scoped_runtime_proofs ON ${c.table("runtime_proofs")} (deployment_id, scope_key, expires_at_ms)` }
  ];
}
var ControlRuntimeProofs = class {
  constructor(c) {
    this.c = c;
  }
  c;
  async register(input) {
    const normalized = normalize2(input), json = boundedJson(input.content, 65536), expected = epoch(input.expected_epoch);
    if (canonicalJsonDigest(input.content) !== normalized.content_digest) fail("RUNTIME_PROOF_INTEGRITY_INVALID");
    const replay = new Error("existing runtime proof");
    let exists = false;
    try {
      await this.c.execute([{
        sql: `UPDATE ${this.c.table("deployments")} SET epoch = epoch WHERE deployment_id = $1 AND epoch = $2 RETURNING epoch`,
        values: [normalized.deployment_id, expected],
        check: (rows) => {
          if (rows.length !== 1) fail("POLICY_REVISION_CONFLICT");
        }
      }, {
        sql: `SELECT * FROM ${this.c.table("runtime_proofs")} WHERE deployment_id = $1 AND proposal_id = $2`,
        values: [normalized.deployment_id, normalized.proposal_id],
        check: (rows) => {
          if (!rows.length) return;
          const row = rows[0];
          if (row.scope_key !== scopeKey(normalized.scope) || row.content_digest !== normalized.content_digest || row.content_json !== json || epoch(row.expires_at_ms) !== normalized.expires_at_ms) fail("RUNTIME_PROOF_CONFLICT");
          exists = true;
          throw replay;
        }
      }, {
        sql: `SELECT ${this.c.nowMs} AS now_ms`,
        check: (rows) => {
          const now = epoch(rows[0]?.now_ms);
          if (normalized.expires_at_ms <= now || normalized.expires_at_ms > now + 9e5) fail("RUNTIME_PROOF_EXPIRED");
        }
      }, {
        sql: `INSERT INTO ${this.c.table("runtime_proofs")} (deployment_id, proposal_id, scope_key, content_digest, content_json, expires_at_ms, created_epoch)
          VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        values: [
          normalized.deployment_id,
          normalized.proposal_id,
          scopeKey(normalized.scope),
          normalized.content_digest,
          json,
          normalized.expires_at_ms,
          expected
        ]
      }], "write");
      return "registered";
    } catch (error) {
      if (error === replay && exists) return "existing";
      throw error;
    }
  }
  async get(input) {
    const values = [identifier(input.deployment_id), identifier(input.proposal_id), scopeKey(input.scope), digest2(input.content_digest)];
    const rows = await this.c.execute([{
      sql: `SELECT *, ${this.c.nowMs} AS now_ms FROM ${this.c.table("runtime_proofs")}
        WHERE deployment_id = $1 AND proposal_id = $2 AND scope_key = $3 AND content_digest = $4`,
      values,
      check: (rows2) => {
        if (rows2.length !== 1) fail("RUNTIME_PROOF_UNAVAILABLE");
        if (epoch(rows2[0].expires_at_ms) <= epoch(rows2[0].now_ms)) fail("RUNTIME_PROOF_EXPIRED");
      }
    }]);
    return decode(rows[0][0]);
  }
};
function normalize2(input) {
  return {
    deployment_id: identifier(input.deployment_id),
    proposal_id: identifier(input.proposal_id),
    scope: JSON.parse(scopeKey(input.scope)),
    content_digest: digest2(input.content_digest),
    content: input.content,
    expires_at_ms: epoch(input.expires_at_ms)
  };
}
function decode(row) {
  const content = JSON.parse(String(row.content_json));
  if (canonicalJsonDigest(content) !== digest2(row.content_digest)) fail("RUNTIME_PROOF_INTEGRITY_INVALID");
  return normalize2({
    deployment_id: String(row.deployment_id),
    proposal_id: String(row.proposal_id),
    scope: JSON.parse(String(row.scope_key)),
    content_digest: String(row.content_digest),
    content,
    expires_at_ms: epoch(row.expires_at_ms)
  });
}

// ../synapsor-runner/packages/proposal-store/src/control-policy-repository.ts
var ControlPolicyRepository = class {
  constructor(connection) {
    this.connection = connection;
    this.reviews = new ControlPolicyReviews(connection);
    this.budgets = new ControlHardBudgets(connection);
    this.effects = new ControlEffectAdmissions(connection, this.budgets);
    this.runtimeProofs = new ControlRuntimeProofs(connection);
  }
  connection;
  reviews;
  budgets;
  effects;
  runtimeProofs;
  async initialize() {
    const t2 = (name4) => this.connection.table(name4);
    const rows = await this.connection.execute([
      { sql: `CREATE TABLE IF NOT EXISTS ${t2("identity")} (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), repository_id TEXT NOT NULL)` },
      { sql: `CREATE TABLE IF NOT EXISTS ${t2("deployments")} (
          deployment_id TEXT PRIMARY KEY, project_id TEXT NOT NULL UNIQUE,
          epoch BIGINT NOT NULL CHECK (epoch >= 0), migration_digest TEXT NOT NULL)` },
      { sql: `CREATE TABLE IF NOT EXISTS ${t2("revisions")} (
          deployment_id TEXT NOT NULL, scope_key TEXT NOT NULL, kind TEXT NOT NULL, name TEXT NOT NULL,
          revision_id TEXT NOT NULL, epoch BIGINT NOT NULL, authority_digest TEXT NOT NULL, content_digest TEXT NOT NULL, content_json TEXT NOT NULL,
          PRIMARY KEY (deployment_id, revision_id),
          UNIQUE (deployment_id, scope_key, kind, name, revision_id),
          FOREIGN KEY (deployment_id) REFERENCES ${t2("deployments")}(deployment_id))` },
      { sql: `CREATE TABLE IF NOT EXISTS ${t2("active")} (
          deployment_id TEXT NOT NULL, scope_key TEXT NOT NULL, kind TEXT NOT NULL, name TEXT NOT NULL, revision_id TEXT,
          PRIMARY KEY (deployment_id, scope_key, kind, name),
          FOREIGN KEY (deployment_id) REFERENCES ${t2("deployments")}(deployment_id),
          FOREIGN KEY (deployment_id, scope_key, kind, name, revision_id)
            REFERENCES ${t2("revisions")}(deployment_id, scope_key, kind, name, revision_id))` },
      { sql: `CREATE TABLE IF NOT EXISTS ${t2("drafts")} (
          deployment_id TEXT NOT NULL, scope_key TEXT NOT NULL, kind TEXT NOT NULL, name TEXT NOT NULL, revision_id TEXT,
          PRIMARY KEY (deployment_id, scope_key, kind, name),
          FOREIGN KEY (deployment_id) REFERENCES ${t2("deployments")}(deployment_id),
          FOREIGN KEY (deployment_id, scope_key, kind, name, revision_id)
            REFERENCES ${t2("revisions")}(deployment_id, scope_key, kind, name, revision_id))` },
      { sql: `CREATE INDEX IF NOT EXISTS control_policy_revision_history ON ${t2("revisions")}
          (deployment_id, scope_key, kind, name, epoch, revision_id)` },
      { sql: `CREATE TABLE IF NOT EXISTS ${t2("events")} (
          deployment_id TEXT NOT NULL, epoch BIGINT NOT NULL, event_id TEXT NOT NULL,
          actor TEXT NOT NULL, occurred_at TEXT NOT NULL, receipt_json TEXT NOT NULL,
          PRIMARY KEY (deployment_id, epoch), UNIQUE (deployment_id, event_id),
          FOREIGN KEY (deployment_id) REFERENCES ${t2("deployments")}(deployment_id))` },
      ...controlPolicyReviewSchema(this.connection),
      ...controlHardBudgetSchema(this.connection),
      ...controlEffectAdmissionSchema(this.connection),
      ...controlRuntimeProofSchema(this.connection),
      { sql: `INSERT INTO ${t2("identity")} (singleton, repository_id) VALUES (1, $1) ON CONFLICT (singleton) DO NOTHING`, values: [randomUUID3()] },
      { sql: `SELECT repository_id FROM ${t2("identity")} WHERE singleton = 1`, check: exactlyOne }
    ], "migration");
    return String(rows.at(-1)[0].repository_id);
  }
  async identity() {
    const rows = await this.connection.execute([{ sql: `SELECT repository_id FROM ${this.connection.table("identity")} WHERE singleton = 1`, check: exactlyOne }]);
    return String(rows[0][0].repository_id);
  }
  async deployment(deploymentId) {
    const rows = await this.connection.execute([{
      sql: `SELECT project_id, epoch, migration_digest FROM ${this.connection.table("deployments")} WHERE deployment_id = $1`,
      values: [identifier(deploymentId)]
    }]);
    const value = rows[0][0];
    return value ? { project_id: identifier(value.project_id), epoch: epoch(value.epoch), migration_digest: digest2(value.migration_digest) } : void 0;
  }
  /** Imports one verified legacy snapshot, including its pointers, in one commit.
   * A retry recognizes the original migration without replaying its authority. */
  async importDeployment(input) {
    const deploymentId = identifier(input.deployment_id);
    identifier(input.project_id);
    digest2(input.migration_digest);
    const existing = await this.deployment(deploymentId);
    if (existing) {
      if (existing.project_id !== input.project_id || existing.migration_digest !== input.migration_digest) fail("POLICY_MIGRATION_MISMATCH");
      return "already_imported";
    }
    const statements = [{
      sql: `INSERT INTO ${this.connection.table("deployments")} (deployment_id, project_id, epoch, migration_digest)
        VALUES ($1, $2, 0, $3) ON CONFLICT DO NOTHING RETURNING deployment_id`,
      values: [deploymentId, input.project_id, input.migration_digest],
      check: (rows) => {
        if (rows.length !== 1) fail("POLICY_MIGRATION_RACE");
      }
    }, ...this.changeStatements({ ...input, expected_epoch: 0 })];
    try {
      await this.connection.execute(statements, "write");
    } catch (error) {
      if (!(error instanceof ProposalStoreError) || error.code !== "POLICY_MIGRATION_RACE") throw error;
      const raced = await this.deployment(deploymentId);
      if (raced?.project_id !== input.project_id || raced.migration_digest !== input.migration_digest) fail("POLICY_MIGRATION_MISMATCH");
      return "already_imported";
    }
    return "imported";
  }
  async commit(input) {
    await this.connection.execute(this.changeStatements(input), "write");
    return input.expected_epoch + 1;
  }
  /** Trusted management callers only. Receipts are not a model-facing audit
   * feed; the service must authorize the exact deployment before this lookup. */
  async event(deploymentId, eventId) {
    const rows = await this.connection.execute([{
      sql: `SELECT epoch, event_id, actor, occurred_at, receipt_json FROM ${this.connection.table("events")}
        WHERE deployment_id = $1 AND event_id = $2`,
      values: [identifier(deploymentId), identifier(eventId)]
    }]);
    const row = rows[0][0];
    return row ? {
      epoch: epoch(row.epoch),
      event_id: identifier(row.event_id),
      actor: identifier(row.actor),
      occurred_at: String(row.occurred_at),
      receipt: JSON.parse(String(row.receipt_json))
    } : void 0;
  }
  async revision(deploymentId, key2, revisionId) {
    const values = [identifier(deploymentId), scopeKey(key2.scope), policyKind(key2.kind), identifier(key2.name), identifier(revisionId)];
    const rows = await this.connection.execute([{
      sql: `SELECT r.* FROM ${this.connection.table("revisions")} r
        WHERE deployment_id = $1 AND scope_key = $2 AND kind = $3 AND name = $4 AND revision_id = $5`,
      values
    }]);
    return rows[0][0] ? decodeRevision(rows[0][0]) : void 0;
  }
  async active(deploymentId, key2) {
    const rows = await this.connection.execute([this.pointerStatement(deploymentId, key2, "active")]);
    return rows[0][0] ? decodeRevision(rows[0][0]) : void 0;
  }
  async draft(deploymentId, key2) {
    const rows = await this.connection.execute([this.pointerStatement(deploymentId, key2, "drafts")]);
    return rows[0][0] ? decodeRevision(rows[0][0]) : void 0;
  }
  /** Reads a bounded, caller-authorized chain and its CAS epoch in one snapshot. */
  async snapshot(deploymentId, keys, guard) {
    if (keys.length > 64) fail("POLICY_BATCH_TOO_LARGE");
    const guards = this.readGuardStatements(deploymentId, guard);
    const rows = await this.connection.execute([{
      sql: `SELECT epoch FROM ${this.connection.table("deployments")} WHERE deployment_id = $1`,
      values: [identifier(deploymentId)],
      check: exactlyOne
    }, ...guards, ...keys.flatMap((key2) => [this.pointerStatement(deploymentId, key2, "active"), this.pointerStatement(deploymentId, key2, "drafts")])]);
    return { epoch: epoch(rows[0][0].epoch), policies: keys.map((_2, index) => ({
      ...rows[index * 2 + 1 + guards.length][0] ? { active: decodeRevision(rows[index * 2 + 1 + guards.length][0]) } : {},
      ...rows[index * 2 + 2 + guards.length][0] ? { draft: decodeRevision(rows[index * 2 + 2 + guards.length][0]) } : {}
    })) };
  }
  /** Reads one exact pointer pair after the caller's guard has authorized the
   * snapshot. Management callers use this instead of expanding a whole scope. */
  async exactPointerSnapshot(input, guard) {
    const maximumBytes = input.max_bytes ?? 1048576;
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || maximumBytes > 1048576) fail("POLICY_SNAPSHOT_BYTES_INVALID");
    const guards = this.readGuardStatements(input.deployment_id, guard);
    const states = ["active", "drafts"];
    const sizeStatement = (state) => ({
      sql: `SELECT ${this.connection.byteLength("r.content_json")} AS bytes FROM ${this.connection.table(state)} a
        JOIN ${this.connection.table("revisions")} r ON r.deployment_id = a.deployment_id AND r.revision_id = a.revision_id
          AND r.scope_key = a.scope_key AND r.kind = a.kind AND r.name = a.name
        WHERE a.deployment_id = $1 AND a.scope_key = $2 AND a.kind = $3 AND a.name = $4`,
      values: [identifier(input.deployment_id), scopeKey(input.key.scope), policyKind(input.key.kind), identifier(input.key.name)]
    });
    let bytes = 0;
    const statements = [{
      sql: `SELECT epoch FROM ${this.connection.table("deployments")} WHERE deployment_id = $1`,
      values: [identifier(input.deployment_id)],
      check: exactlyOne
    }, ...guards, ...states.map((state) => ({ ...sizeStatement(state), check: (rows2) => {
      if (rows2.length > 1) fail("POLICY_SNAPSHOT_TOO_LARGE");
      bytes += rows2.reduce((sum, row) => sum + epoch(row.bytes), 0);
      if (bytes > maximumBytes) fail("POLICY_SNAPSHOT_TOO_LARGE");
    } })), ...states.map((state) => this.pointerStatement(input.deployment_id, input.key, state))];
    const rows = await this.connection.execute(statements);
    const offset = 1 + guards.length + states.length;
    return {
      epoch: epoch(rows[0][0].epoch),
      ...rows[offset][0] ? { active: decodeRevision(rows[offset][0]) } : {},
      ...rows[offset + 1][0] ? { draft: decodeRevision(rows[offset + 1][0]) } : {}
    };
  }
  /** Returns a single kind's active/draft pointers in deterministic keyset
   * order. The cursor is pinned to the deployment epoch so a later page can
   * never silently combine authority from two snapshots. Bodies are size
   * checked before any JSON is decoded. */
  async scopePointerPage(input, guard) {
    const limit = input.limit ?? 20;
    const maximumBytes = input.max_bytes ?? 1048576;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 32) fail("POLICY_LIST_LIMIT_INVALID");
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || maximumBytes > 1048576) fail("POLICY_SNAPSHOT_BYTES_INVALID");
    const after = input.after ? { name: identifier(input.after.name), epoch: epoch(input.after.epoch) } : void 0;
    const values = [identifier(input.deployment_id), scopeKey(input.scope), policyKind(input.kind), after?.name ?? "", limit + 1];
    const names = `WITH pointer_names AS (
        SELECT name FROM (
          SELECT name FROM ${this.connection.table("active")} WHERE deployment_id = $1 AND scope_key = $2 AND kind = $3 AND revision_id IS NOT NULL AND name COLLATE ${this.connection.collation} > $4
          UNION
          SELECT name FROM ${this.connection.table("drafts")} WHERE deployment_id = $1 AND scope_key = $2 AND kind = $3 AND revision_id IS NOT NULL AND name COLLATE ${this.connection.collation} > $4
        ) pointers ORDER BY name COLLATE ${this.connection.collation} LIMIT $5
      )`;
    const selected = (state, columns) => `SELECT '${state}' AS pointer_state, r.name AS pointer_name${columns} FROM pointer_names p
        JOIN ${this.connection.table(state)} a ON a.deployment_id = $1 AND a.scope_key = $2 AND a.kind = $3 AND a.name = p.name
        JOIN ${this.connection.table("revisions")} r ON r.deployment_id = a.deployment_id AND r.revision_id = a.revision_id
          AND r.scope_key = a.scope_key AND r.kind = a.kind AND r.name = a.name`;
    const guards = this.readGuardStatements(input.deployment_id, guard);
    let bytes = 0;
    const statements = [{
      sql: `SELECT epoch FROM ${this.connection.table("deployments")} WHERE deployment_id = $1`,
      values: [values[0]],
      check: (rows2) => {
        exactlyOne(rows2);
        const current = epoch(rows2[0].epoch);
        if (after && current !== after.epoch) fail("POLICY_PAGE_EPOCH_STALE");
      }
    }, ...guards, {
      sql: `${names} ${selected("active", `, ${this.connection.byteLength("r.content_json")} AS bytes`)} UNION ALL ${selected("drafts", `, ${this.connection.byteLength("r.content_json")} AS bytes`)}`,
      values,
      check: (rows2) => {
        if (rows2.length > (limit + 1) * 2) fail("POLICY_SNAPSHOT_TOO_LARGE");
        bytes = rows2.reduce((sum, row) => sum + epoch(row.bytes), 0);
        if (bytes > maximumBytes) fail("POLICY_SNAPSHOT_TOO_LARGE");
      }
    }, {
      sql: `${names} SELECT * FROM (${selected("active", ", r.*")} UNION ALL ${selected("drafts", ", r.*")}) pointer_rows
        ORDER BY pointer_name COLLATE ${this.connection.collation}, pointer_state`,
      values
    }];
    const rows = await this.connection.execute(statements);
    const currentEpoch = epoch(rows[0][0].epoch);
    const body = rows.at(-1);
    const byName = /* @__PURE__ */ new Map();
    for (const row of body) {
      const pointerName = identifier(row.pointer_name);
      const item = byName.get(pointerName) ?? { name: pointerName };
      if (row.pointer_state === "active") item.active = decodeRevision(row);
      else if (row.pointer_state === "drafts") item.draft = decodeRevision(row);
      else fail("POLICY_POINTER_STATE_INVALID");
      byName.set(pointerName, item);
    }
    const selectedItems = [...byName.values()];
    const items = selectedItems.slice(0, limit);
    const last = items.at(-1);
    return {
      epoch: currentEpoch,
      items,
      ...selectedItems.length > limit && last ? { next: { name: last.name, epoch: currentEpoch } } : {}
    };
  }
  /** A complete, bounded scope view for trusted policy services. Overflow is a
   * refusal, not a truncated authority set. Null pointers are revocations and
   * are deliberately absent; immutable history remains separately available. */
  async scopeSnapshot(input, guard) {
    const limit = input.limit ?? 64;
    const maximumBytes = input.max_bytes ?? 128 * 1024 * 1024;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 64) fail("POLICY_LIST_LIMIT_INVALID");
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || maximumBytes > 128 * 1024 * 1024) fail("POLICY_SNAPSHOT_BYTES_INVALID");
    if (!input.kinds.length || input.kinds.length > 6 || new Set(input.kinds).size !== input.kinds.length) fail("POLICY_KIND_SELECTION_INVALID");
    const values = [identifier(input.deployment_id), scopeKey(input.scope), ...input.kinds.map(policyKind), limit + 1];
    const kinds = input.kinds.map((_2, index) => `$${index + 3}`).join(", ");
    const source = (state) => `FROM ${this.connection.table(state)} a JOIN ${this.connection.table("revisions")} r
        ON r.deployment_id = a.deployment_id AND r.scope_key = a.scope_key
        AND r.kind = a.kind AND r.name = a.name AND r.revision_id = a.revision_id
        WHERE a.deployment_id = $1 AND a.scope_key = $2 AND a.kind IN (${kinds})
        ORDER BY a.kind COLLATE ${this.connection.collation}, a.name COLLATE ${this.connection.collation}
        LIMIT $${values.length}`;
    let count = 0;
    let bytes = 0;
    const guards = this.readGuardStatements(input.deployment_id, guard);
    const statements = [{
      sql: `SELECT epoch FROM ${this.connection.table("deployments")} WHERE deployment_id = $1`,
      values: [values[0]],
      check: exactlyOne
    }, ...guards, ...["active", "drafts"].map((state) => ({
      // Check sizes within this transaction before fetching or parsing bodies.
      sql: `SELECT ${this.connection.byteLength("r.content_json")} AS bytes ${source(state)}`,
      values,
      check: (rows2) => {
        count += rows2.length;
        bytes += rows2.reduce((sum, row) => sum + epoch(row.bytes), 0);
        if (count > limit || bytes > maximumBytes) fail("POLICY_SNAPSHOT_TOO_LARGE");
      }
    })), ...["active", "drafts"].map((state) => ({
      sql: `SELECT r.* ${source(state)}`,
      values
    }))];
    const rows = await this.connection.execute(statements);
    return { epoch: epoch(rows[0][0].epoch), active: rows[3 + guards.length].map(decodeRevision), drafts: rows[4 + guards.length].map(decodeRevision) };
  }
  readGuardStatements(deploymentId, guard) {
    if (!guard) return [];
    if (!guard.keys.length || guard.keys.length > 8) fail("POLICY_READ_GUARD_INVALID");
    const current = [];
    return [...guard.keys.map((key2) => ({
      ...this.pointerStatement(deploymentId, key2, "active"),
      check: (rows) => {
        current.push(rows[0] ? decodeRevision(rows[0]) : void 0);
      }
    })), { sql: "SELECT 1", check: () => guard.authorize(current) }];
  }
  pointerStatement(deploymentId, key2, state) {
    return {
      sql: `SELECT r.* FROM ${this.connection.table(state)} a JOIN ${this.connection.table("revisions")} r
        ON r.deployment_id = a.deployment_id AND r.revision_id = a.revision_id
        AND r.scope_key = a.scope_key AND r.kind = a.kind AND r.name = a.name
        WHERE a.deployment_id = $1 AND a.scope_key = $2 AND a.kind = $3 AND a.name = $4`,
      values: [identifier(deploymentId), scopeKey(key2.scope), policyKind(key2.kind), identifier(key2.name)]
    };
  }
  async listActive(input) {
    return this.listPointers(input, "active");
  }
  async listDrafts(input) {
    return this.listPointers(input, "drafts");
  }
  async listPointers(input, state) {
    const limit = input.limit ?? 20;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) fail("POLICY_LIST_LIMIT_INVALID");
    const rows = await this.connection.execute([{
      sql: `SELECT r.* FROM ${this.connection.table(state)} a JOIN ${this.connection.table("revisions")} r
        ON r.deployment_id = a.deployment_id AND r.revision_id = a.revision_id
        AND r.scope_key = a.scope_key AND r.kind = a.kind AND r.name = a.name
        WHERE a.deployment_id = $1 AND a.scope_key = $2 AND a.kind = $3 AND a.name COLLATE ${this.connection.collation} > $4
        ORDER BY a.name COLLATE ${this.connection.collation} LIMIT $5`,
      values: [identifier(input.deployment_id), scopeKey(input.scope), policyKind(input.kind), input.after === void 0 ? "" : identifier(input.after), limit]
    }]);
    return rows[0].map(decodeRevision);
  }
  async history(input) {
    const limit = input.limit ?? 20;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) fail("POLICY_LIST_LIMIT_INVALID");
    const rows = await this.connection.execute([{
      sql: `SELECT r.* FROM ${this.connection.table("revisions")} r
        WHERE deployment_id = $1 AND scope_key = $2 AND kind = $3 AND name = $4
          AND (epoch < $5 OR (epoch = $5 AND revision_id COLLATE ${this.connection.collation} < $6))
        ORDER BY epoch DESC, revision_id COLLATE ${this.connection.collation} DESC LIMIT $7`,
      values: [
        identifier(input.deployment_id),
        scopeKey(input.key.scope),
        policyKind(input.key.kind),
        identifier(input.key.name),
        input.before === void 0 ? Number.MAX_SAFE_INTEGER : epoch(input.before.epoch),
        input.before === void 0 ? "" : identifier(input.before.revision_id),
        limit
      ]
    }]);
    return rows[0].map((row) => ({ epoch: epoch(row.epoch), revision: decodeRevision(row) }));
  }
  /** Owner-service history for revisions and exact review decisions, with no
   * unscoped event payloads. Each branch applies its key and limit in SQL. */
  async policyHistory(input, guard) {
    const limit = input.limit ?? 20;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) fail("POLICY_LIST_LIMIT_INVALID");
    const values = [
      identifier(input.deployment_id),
      scopeKey(input.key.scope),
      policyKind(input.key.kind),
      identifier(input.key.name),
      input.before ? epoch(input.before.epoch) : Number.MAX_SAFE_INTEGER,
      input.before ? identifier(input.before.revision_id) : "",
      limit + 1
    ];
    const collation = this.connection.collation;
    const branch = (review) => {
      const version = review ? "r.expected_epoch + 1" : "r.epoch";
      return `SELECT ${version} AS epoch, r.revision_id, e.event_id, e.actor, e.occurred_at,
          ${review ? "r.operation" : "'revision_created'"} AS operation
        FROM ${this.connection.table(review ? "reviews" : "revisions")} r
        JOIN ${this.connection.table("events")} e ON e.deployment_id = r.deployment_id
          AND ${review ? "e.event_id = r.consumed_event_id" : "e.epoch = r.epoch"}
        WHERE r.deployment_id = $1 AND r.scope_key = $2 AND r.kind = $3 AND r.name = $4
          AND (${version} < $5 OR (${version} = $5 AND r.revision_id COLLATE ${collation} < $6))
        ORDER BY ${review ? "r.expected_epoch" : "r.epoch"} DESC, r.revision_id COLLATE ${collation} DESC LIMIT $7`;
    };
    const rows = await this.connection.execute([...this.readGuardStatements(input.deployment_id, guard), {
      sql: `SELECT * FROM (SELECT * FROM (${branch(false)}) versions UNION ALL SELECT * FROM (${branch(true)}) decisions) history
        ORDER BY epoch DESC, revision_id COLLATE ${collation} DESC LIMIT $7`,
      values
    }]);
    const page2 = rows.at(-1);
    const items = page2.slice(0, limit).map((row) => ({
      epoch: epoch(row.epoch),
      revision_id: identifier(row.revision_id),
      event_id: identifier(row.event_id),
      actor: identifier(row.actor),
      occurred_at: String(row.occurred_at),
      operation: String(row.operation)
    }));
    const last = items.at(-1);
    return { items, ...page2.length > limit && last ? { next: { epoch: last.epoch, revision_id: last.revision_id } } : {} };
  }
  changeStatements(input) {
    const deploymentId = identifier(input.deployment_id);
    if (!Number.isSafeInteger(input.expected_epoch) || input.expected_epoch < 0 || input.expected_epoch >= Number.MAX_SAFE_INTEGER) fail("POLICY_EPOCH_INVALID");
    if (input.revisions.length > 64 || input.active.length + (input.drafts?.length ?? 0) > 64) fail("POLICY_BATCH_TOO_LARGE");
    const event = input.event;
    identifier(event.event_id);
    identifier(event.actor);
    if (typeof event.occurred_at !== "string" || !Number.isFinite(Date.parse(event.occurred_at)) || new Date(event.occurred_at).toISOString() !== event.occurred_at) fail("POLICY_EVENT_TIME_INVALID");
    const receipt2 = boundedJson(event.receipt, 64 * 1024);
    const receiptValue = JSON.parse(receipt2);
    if (receiptValue?.operation === "cancel_unconfirmed_policy_publication") {
      if (input.revisions.length || input.active.length || input.drafts?.length || receiptValue.authority_changed !== false || receiptValue.source_database_changed !== false || Object.keys(receiptValue).length !== 4) fail("POLICY_PUBLICATION_FENCE_INVALID");
      digest2(receiptValue.publication_event_digest);
    }
    const statements = [{
      sql: `UPDATE ${this.connection.table("deployments")} SET epoch = epoch + 1
        WHERE deployment_id = $1 AND epoch = $2 RETURNING epoch`,
      values: [deploymentId, input.expected_epoch],
      check: (rows) => {
        if (rows.length !== 1) fail("POLICY_REVISION_CONFLICT");
      }
    }];
    let bytes = 0;
    for (const revision of input.revisions) {
      const content = boundedJson(revision.content, 64 * 1024 * 1024);
      bytes += Buffer.byteLength(content);
      if (bytes > 128 * 1024 * 1024) fail("POLICY_BATCH_TOO_LARGE");
      if (digest2(revision.content_digest) !== canonicalJsonDigest(revision.content)) fail("POLICY_CONTENT_MISMATCH");
      statements.push({
        sql: `INSERT INTO ${this.connection.table("revisions")}
          (deployment_id, scope_key, kind, name, revision_id, epoch, authority_digest, content_digest, content_json)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        values: [
          deploymentId,
          scopeKey(revision.scope),
          policyKind(revision.kind),
          identifier(revision.name),
          identifier(revision.revision_id),
          input.expected_epoch + 1,
          digest2(revision.authority_digest),
          revision.content_digest,
          content
        ]
      });
    }
    for (const state of ["active", "drafts"]) {
      const pointerKeys = /* @__PURE__ */ new Set();
      for (const pointer of input[state] ?? []) {
        const key2 = [scopeKey(pointer.scope), policyKind(pointer.kind), identifier(pointer.name)];
        const token = JSON.stringify(key2);
        if (pointerKeys.has(token)) fail("POLICY_DUPLICATE_POINTER");
        pointerKeys.add(token);
        statements.push({
          sql: `INSERT INTO ${this.connection.table(state)} (deployment_id, scope_key, kind, name, revision_id)
            VALUES ($1, $2, $3, $4, $5) ON CONFLICT (deployment_id, scope_key, kind, name)
            DO UPDATE SET revision_id = excluded.revision_id`,
          values: [deploymentId, ...key2, pointer.revision_id === null ? null : identifier(pointer.revision_id)]
        });
      }
    }
    statements.push({
      sql: `INSERT INTO ${this.connection.table("events")} (deployment_id, epoch, event_id, actor, occurred_at, receipt_json)
        VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (deployment_id, event_id) DO NOTHING RETURNING event_id`,
      values: [deploymentId, input.expected_epoch + 1, event.event_id, event.actor, event.occurred_at, receipt2],
      check: (rows) => {
        if (rows.length !== 1) fail("POLICY_EVENT_ALREADY_RECORDED");
      }
    });
    return statements;
  }
};
function sqliteControlPolicyRepository(db) {
  if (db.prepare("PRAGMA foreign_keys").get()?.foreign_keys !== 1) fail("POLICY_FOREIGN_KEYS_REQUIRED");
  return new ControlPolicyRepository({
    table: (name4) => `"control_policy_${name4}"`,
    collation: "BINARY",
    nowMs: "CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)",
    nowIso: "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')",
    byteLength: (expression) => `length(CAST(${expression} AS BLOB))`,
    async execute(statements, mode = "read") {
      if (db.prepare("PRAGMA foreign_keys").get()?.foreign_keys !== 1) fail("POLICY_FOREIGN_KEYS_REQUIRED");
      db.exec(mode === "read" ? "BEGIN" : "BEGIN IMMEDIATE");
      try {
        const result = statements.map((statement) => {
          const parameters = Object.fromEntries((statement.values ?? []).map((value, index) => [`$${index + 1}`, value]));
          const rows = db.prepare(statement.sql).all(parameters);
          statement.check?.(rows);
          return rows;
        });
        db.exec("COMMIT");
        return result;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    }
  });
}
function decodeRevision(row) {
  const content = JSON.parse(String(row.content_json));
  if (canonicalJsonDigest(content) !== row.content_digest) fail("POLICY_CONTENT_MISMATCH");
  const scope2 = JSON.parse(String(row.scope_key));
  if (scopeKey(scope2) !== row.scope_key) fail("POLICY_SCOPE_INVALID");
  return {
    scope: scope2,
    kind: policyKind(row.kind),
    name: identifier(row.name),
    revision_id: identifier(row.revision_id),
    authority_digest: digest2(row.authority_digest),
    content_digest: digest2(row.content_digest),
    content
  };
}

// ../synapsor-runner/packages/proposal-store/src/sqlite-store.ts
var SQLITE_BUSY_TIMEOUT_MS = 5e3;
var ProposalStore = class {
  db;
  controlPolicies;
  path;
  constructor(path7 = ":memory:") {
    this.path = path7;
    if (path7 !== ":memory:") {
      mkdirSync(dirname(resolve(path7)), { recursive: true, mode: 448 });
    }
    this.db = new DatabaseSync(path7);
    this.db.exec(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
    if (path7 !== ":memory:" && process.platform !== "win32") {
      try {
        chmodSync(path7, 384);
      } catch (error) {
        process.stderr.write(`warning: unable to restrict Synapsor store permissions to 0600: ${error instanceof Error ? error.message : String(error)}
`);
      }
    }
    this.migrate();
    this.controlPolicies = sqliteControlPolicyRepository(this.db);
  }
};
installProposalStoreMethods(
  ProposalStore.prototype,
  proposalStoreSchemaMethods,
  proposalStoreProposalsMethods,
  proposalStoreWritebackMethods,
  proposalStoreSubjectReferenceMethods,
  proposalStoreWorkersMethods,
  proposalStoreMetricsPolicyMethods,
  proposalStoreAttentionMethods,
  proposalStoreCloudControlMethods,
  proposalStoreShadowMethods,
  proposalStoreInternalsMethods
);

// ../synapsor-runner/packages/proposal-store/src/postgres-runtime-store.ts
var PRODUCTION_EXPLORE_BUDGET_RETENTION_MS = 7 * 24 * 60 * 60 * 1e3;
var PRODUCTION_EXPLORE_AUDIT_RETENTION_MS = 7 * 24 * 60 * 60 * 1e3;
var PRODUCTION_EXPLORE_MAINTENANCE_INTERVAL_MS = 60 * 60 * 1e3;

// ../synapsor-runner/packages/spec/dist/version.js
var SPEC_VERSION = "0.1";

// ../synapsor-runner/packages/spec/dist/errors.js
var SynapsorSpecValidationError = class extends Error {
  issues;
  constructor(issues) {
    super(`Invalid Synapsor contract:
${issues.map((issue) => `${issue.path} ${issue.code}: ${issue.message}`).join("\n")}`);
    this.issues = issues;
    this.name = "SynapsorSpecValidationError";
  }
};

// ../synapsor-runner/packages/spec/dist/validate.js
var TOP_LEVEL_KEYS = /* @__PURE__ */ new Set([
  "spec_version",
  "kind",
  "metadata",
  "resources",
  "contexts",
  "capabilities",
  "workflows",
  "policies",
  "evidence",
  "proposals",
  "receipts",
  "replay",
  "external_actions",
  "verification_boundaries",
  "derived_effect_envelopes",
  "action_rules"
]);
var METADATA_KEYS = /* @__PURE__ */ new Set(["name", "description", "version", "tags"]);
var RESOURCE_KEYS = /* @__PURE__ */ new Set(["name", "engine", "schema", "table", "type", "primary_key", "tenant_key", "conflict_key", "single_tenant_dev"]);
var CONTEXT_KEYS = /* @__PURE__ */ new Set(["name", "description", "bindings", "tenant_binding", "principal_binding"]);
var BINDING_KEYS = /* @__PURE__ */ new Set(["name", "source", "key", "required"]);
var CAPABILITY_KEYS = /* @__PURE__ */ new Set(["name", "description", "returns_hint", "kind", "context", "source", "subject", "args", "lookup", "visible_fields", "kept_out_fields", "model_withheld_fields", "evidence", "max_rows", "proposal", "aggregate", "protected_read"]);
var SUBJECT_KEYS = /* @__PURE__ */ new Set(["resource", "schema", "table", "primary_key", "tenant_key", "principal_scope_key", "conflict_key", "single_tenant_dev"]);
var ARG_KEYS = /* @__PURE__ */ new Set(["type", "description", "required", "max_length", "minimum", "maximum", "enum", "max_items", "fields"]);
var LOOKUP_KEYS = /* @__PURE__ */ new Set(["id_from_arg"]);
var EVIDENCE_KEYS = /* @__PURE__ */ new Set(["required", "sources", "query_audit", "handle_prefix"]);
var PROPOSAL_KEYS = /* @__PURE__ */ new Set(["action", "organization_scope", "operation", "allowed_fields", "patch", "numeric_bounds", "transition_guards", "reversibility", "conflict_guard", "approval", "execution", "writeback"]);
var OPERATION_KEYS = /* @__PURE__ */ new Set(["kind", "cardinality", "selection", "max_rows", "aggregate_bounds", "batch", "deduplication", "version_advance"]);
var SELECTION_KEYS = /* @__PURE__ */ new Set(["all"]);
var PREDICATE_TERM_KEYS = /* @__PURE__ */ new Set(["column", "operator", "value"]);
var AGGREGATE_BOUND_KEYS = /* @__PURE__ */ new Set(["column", "measure", "maximum"]);
var BATCH_KEYS = /* @__PURE__ */ new Set(["items_from_arg"]);
var DEDUPLICATION_KEYS = /* @__PURE__ */ new Set(["components"]);
var DEDUPLICATION_COMPONENT_KEYS = /* @__PURE__ */ new Set(["column", "source", "fixed", "item_field"]);
var VERSION_ADVANCE_KEYS = /* @__PURE__ */ new Set(["column", "strategy"]);
var PATCH_KEYS = /* @__PURE__ */ new Set(["fixed", "from_arg", "from_item"]);
var SET_MAX_ROWS_HARD_CEILING = 100;
var NUMERIC_BOUND_KEYS = /* @__PURE__ */ new Set(["minimum", "maximum"]);
var TRANSITION_GUARD_KEYS = /* @__PURE__ */ new Set(["from_column", "allowed"]);
var CONFLICT_GUARD_KEYS = /* @__PURE__ */ new Set(["column", "weak_guard_ack"]);
var APPROVAL_KEYS = /* @__PURE__ */ new Set(["mode", "required_role", "required_approvals", "policy"]);
var EXECUTION_KEYS = /* @__PURE__ */ new Set(["supervised_worker"]);
var WRITEBACK_KEYS = /* @__PURE__ */ new Set(["mode", "executor", "idempotency_key"]);
var REVERSIBILITY_KEYS = /* @__PURE__ */ new Set(["mode"]);
var AGGREGATE_READ_KEYS = /* @__PURE__ */ new Set(["function", "count_mode", "column", "selection", "minimum_group_size"]);
var PROTECTED_READ_KEYS = /* @__PURE__ */ new Set([
  "version",
  "mode",
  "boundary_digest",
  "generation_lock_fingerprint",
  "organization_scope",
  "predicates",
  "relationship",
  "relationships",
  "time_window",
  "row_order_by",
  "aggregate",
  "limits"
]);
var PROTECTED_ORGANIZATION_SCOPE_KEYS = /* @__PURE__ */ new Set([
  "mode",
  "organization_id",
  "acknowledgement"
]);
var PROTECTED_VALUE_KEYS = /* @__PURE__ */ new Set(["fixed", "from_arg"]);
var PROTECTED_PREDICATE_KEYS = /* @__PURE__ */ new Set(["field", "relationship", "operator", "value", "values"]);
var PROTECTED_RELATIONSHIP_KEYS = /* @__PURE__ */ new Set([
  "name",
  "schema",
  "table",
  "primary_key",
  "tenant_key",
  "principal_scope_key",
  "local_key",
  "target_key",
  "cardinality",
  "max_fan_out"
]);
var PROTECTED_RELATIONSHIP_PATH_KEYS = /* @__PURE__ */ new Set(["name", "links"]);
var PROTECTED_RELATIONSHIP_LINK_KEYS = /* @__PURE__ */ new Set([
  "schema",
  "table",
  "primary_key",
  "tenant_key",
  "principal_scope_key",
  "local_key",
  "target_key",
  "cardinality",
  "max_fan_out",
  "unmatched_rows"
]);
var PROTECTED_ROW_ORDER_KEYS = /* @__PURE__ */ new Set(["field", "direction"]);
var PROTECTED_AGGREGATE_KEYS = /* @__PURE__ */ new Set([
  "counted_entity",
  "measures",
  "dimensions",
  "time_bucket",
  "comparison",
  "order_by",
  "top_n",
  "minimum_group_size"
]);
var PROTECTED_MEASURE_KEYS = /* @__PURE__ */ new Set(["name", "function", "field", "relationship", "derived"]);
var PROTECTED_RATIO_DERIVED_MEASURE_KEYS = /* @__PURE__ */ new Set(["shape", "numerator", "denominator", "null_policy"]);
var PROTECTED_POST_DERIVED_MEASURE_KEYS = /* @__PURE__ */ new Set(["shape", "base_measure", "direction", "window_size"]);
var PROTECTED_DERIVED_OPERAND_KEYS = /* @__PURE__ */ new Set(["function", "field", "relationship"]);
var PROTECTED_POST_AGGREGATE_SHAPES = /* @__PURE__ */ new Set([
  "running_total",
  "rank",
  "lag_absolute_change",
  "lag_percentage_change",
  "moving_average",
  "share_of_released_total"
]);
var PROTECTED_SEQUENTIAL_AGGREGATE_SHAPES = /* @__PURE__ */ new Set([
  "running_total",
  "lag_absolute_change",
  "lag_percentage_change",
  "moving_average"
]);
var PROTECTED_DIMENSION_KEYS = /* @__PURE__ */ new Set(["name", "field", "relationship", "numeric_band"]);
var PROTECTED_NUMERIC_BAND_KEYS = /* @__PURE__ */ new Set(["edges", "bucket_labels"]);
var PROTECTED_TIME_BUCKET_KEYS = /* @__PURE__ */ new Set(["name", "field", "bucket", "relationship"]);
var PROTECTED_TIME_WINDOW_KEYS = /* @__PURE__ */ new Set(["field", "relationship", "start", "end"]);
var PROTECTED_COMPARISON_KEYS = /* @__PURE__ */ new Set(["field", "relationship", "ranges"]);
var PROTECTED_RANGE_KEYS = /* @__PURE__ */ new Set(["start", "end"]);
var PROTECTED_AGGREGATE_ORDER_KEYS = /* @__PURE__ */ new Set(["kind", "measure", "change", "direction"]);
var PROTECTED_LIMIT_KEYS = /* @__PURE__ */ new Set([
  "max_rows",
  "max_groups",
  "max_ranked_groups",
  "max_response_cells",
  "max_response_bytes",
  "statement_timeout_ms",
  "max_queries_per_session",
  "max_extracted_cells_per_session",
  "max_differencing_queries",
  "rate_limit_per_minute"
]);
var WORKFLOW_KEYS = /* @__PURE__ */ new Set(["name", "description", "context", "allowed_capabilities", "required_evidence", "approval", "settlement", "replay"]);
var POLICY_KEYS = /* @__PURE__ */ new Set(["name", "kind", "mode", "rules", "limits"]);
var APPROVAL_POLICY_LIMIT_KEYS = /* @__PURE__ */ new Set(["kind", "max", "period", "field", "scope"]);
var EVIDENCE_RECORD_KEYS = /* @__PURE__ */ new Set(["handle", "capability", "query_fingerprint", "items"]);
var PROPOSAL_RECORD_KEYS = /* @__PURE__ */ new Set(["id", "capability", "subject", "status", "diff", "evidence_handle"]);
var RECEIPT_KEYS = /* @__PURE__ */ new Set(["id", "proposal_id", "status", "idempotency_key", "source_database_mutated", "rows_affected"]);
var REPLAY_KEYS = /* @__PURE__ */ new Set(["id", "proposal_id", "run_id", "events"]);
var EXTERNAL_ACTION_KEYS = /* @__PURE__ */ new Set(["id", "action", "handler", "idempotency_key", "receipt"]);
var VERIFICATION_BOUNDARY_KEYS = /* @__PURE__ */ new Set(["schema_version", "name", "source", "context", "generation_lock_fingerprint", "resources", "lock_order", "transaction"]);
var VERIFICATION_RESOURCE_KEYS = /* @__PURE__ */ new Set(["binding", "resource", "source", "primary_key", "version_field", "fields", "scope", "cardinality", "collection_consistency", "max_rows", "overflow", "deterministic_order", "lock"]);
var VERIFICATION_FIELD_KEYS = /* @__PURE__ */ new Set(["name", "type", "nullable", "model_visible"]);
var VERIFICATION_SOURCE_KEYS = /* @__PURE__ */ new Set(["kind", "from_binding", "relationship", "local_field", "target_field", "field_pairs", "direction"]);
var VERIFICATION_SCOPE_KEYS = /* @__PURE__ */ new Set(["mode", "tenant_field", "principal_field", "from_binding", "organization_id"]);
var VERIFICATION_ORDER_KEYS = /* @__PURE__ */ new Set(["field", "direction"]);
var VERIFICATION_TRANSACTION_KEYS = /* @__PURE__ */ new Set(["isolation", "timezone"]);
var EFFECT_ENVELOPE_KEYS = /* @__PURE__ */ new Set(["schema_version", "name", "source", "operation", "target_resource", "target_binding", "primary_key", "tenant_key", "organization_scope", "principal_scope_key", "conflict_key", "max_rows", "allowed_fields", "version_advance", "deduplication", "approval_classes", "writeback", "atomic_updates"]);
var ATOMIC_UPDATE_ENVELOPE_KEYS = /* @__PURE__ */ new Set(["operation", "target_resource", "target_binding", "primary_key", "tenant_key", "organization_scope", "principal_scope_key", "conflict_key", "max_rows", "allowed_fields", "version_advance"]);
var EFFECT_FIELD_KEYS = /* @__PURE__ */ new Set(["name", "type", "minimum", "maximum", "values"]);
var EFFECT_DEDUP_KEYS = /* @__PURE__ */ new Set(["components"]);
var EFFECT_DEDUP_COMPONENT_KEYS = /* @__PURE__ */ new Set(["column", "source", "derived", "fixed"]);
var EFFECT_VERSION_ADVANCE_KEYS = /* @__PURE__ */ new Set(["column", "strategy"]);
var EFFECT_WRITEBACK_KEYS = /* @__PURE__ */ new Set(["mode", "supervised_worker"]);
var ACTION_RULE_KEYS = /* @__PURE__ */ new Set(["schema_version", "name", "outcome", "context", "source", "verification_boundary_ref", "effect_envelope_ref", "subjects", "inputs", "require", "derive", "effect", "atomic_updates", "approval_class", "ttl_seconds"]);
var ACTION_RULE_SUBJECT_KEYS = /* @__PURE__ */ new Set(["binding", "resource", "input"]);
var ACTION_RULE_EFFECT_KEYS = /* @__PURE__ */ new Set(["operation", "target_resource", "target_binding", "set"]);
var ACTION_RULE_SCALAR_TYPE_KEYS = /* @__PURE__ */ new Set(["kind", "unit", "currency", "max_length", "enum", "comparison"]);
var ACTION_RULE_SCALAR_EXPR_KEYS = /* @__PURE__ */ new Set(["kind", "value", "value_type", "binding", "field", "name", "operation", "inputs", "input", "constant", "rounding", "minimum", "maximum", "timestamp", "seconds", "where", "timezone"]);
var ACTION_RULE_BOOLEAN_EXPR_KEYS = /* @__PURE__ */ new Set(["kind", "expressions", "expression", "operator", "left", "right", "value", "values", "binding", "where"]);
var ACTION_RULE_SCALAR_TYPE_VARIANT_KEYS = {
  boolean: /* @__PURE__ */ new Set(["kind"]),
  integer: /* @__PURE__ */ new Set(["kind", "unit"]),
  money_minor: /* @__PURE__ */ new Set(["kind", "currency"]),
  string: /* @__PURE__ */ new Set(["kind", "max_length", "enum", "comparison"]),
  date: /* @__PURE__ */ new Set(["kind"]),
  timestamp: /* @__PURE__ */ new Set(["kind"])
};
var ACTION_RULE_SCALAR_EXPR_VARIANT_KEYS = {
  input: /* @__PURE__ */ new Set(["kind", "name"]),
  literal: /* @__PURE__ */ new Set(["kind", "value", "value_type"]),
  trusted: /* @__PURE__ */ new Set(["kind", "binding"]),
  field: /* @__PURE__ */ new Set(["kind", "binding", "field"]),
  derived: /* @__PURE__ */ new Set(["kind", "name"]),
  aggregate: /* @__PURE__ */ new Set(["kind", "operation", "binding", "field", "where"]),
  math: /* @__PURE__ */ new Set(["kind", "operation", "inputs"]),
  scale: /* @__PURE__ */ new Set(["kind", "operation", "input", "constant", "rounding"]),
  clamp: /* @__PURE__ */ new Set(["kind", "input", "minimum", "maximum"]),
  add_duration: /* @__PURE__ */ new Set(["kind", "timestamp", "seconds"]),
  date_of: /* @__PURE__ */ new Set(["kind", "timestamp", "timezone"])
};
var ACTION_RULE_BOOLEAN_EXPR_VARIANT_KEYS = {
  all: /* @__PURE__ */ new Set(["kind", "expressions"]),
  any: /* @__PURE__ */ new Set(["kind", "expressions"]),
  not: /* @__PURE__ */ new Set(["kind", "expression"]),
  compare: /* @__PURE__ */ new Set(["kind", "operator", "left", "right"]),
  null_check: /* @__PURE__ */ new Set(["kind", "operator", "value"]),
  in: /* @__PURE__ */ new Set(["kind", "value", "values"]),
  exists: /* @__PURE__ */ new Set(["kind", "binding", "where"])
};
var TRUSTED_ARG_NAMES = /* @__PURE__ */ new Set([
  "tenant_id",
  "tenantId",
  "principal",
  "principal_id",
  "principalId",
  "schema",
  "table",
  "column",
  "columns",
  "database_url",
  "write_url",
  "read_url",
  "expected_version",
  "row_version"
]);
function validateContract(input) {
  const errors = [];
  const warnings = [];
  if (!isRecord3(input)) {
    return {
      ok: false,
      errors: [{ path: "$", code: "CONTRACT_NOT_OBJECT", message: "Contract must be a JSON object." }],
      warnings
    };
  }
  checkUnknownKeys(input, TOP_LEVEL_KEYS, "$", errors);
  if (input.spec_version !== SPEC_VERSION) {
    errors.push({ path: "$.spec_version", code: "UNSUPPORTED_SPEC_VERSION", message: `spec_version must be ${SPEC_VERSION}.` });
  }
  if (input.kind !== "SynapsorContract") {
    errors.push({ path: "$.kind", code: "INVALID_KIND", message: "kind must be SynapsorContract." });
  }
  validateMetadata(input.metadata, "$.metadata", errors);
  const resourceNames = validateResources(input.resources, errors, warnings);
  const contextNames = validateContexts(input.contexts, errors, warnings);
  const capabilities = Array.isArray(input.capabilities) ? input.capabilities : [];
  const policies = Array.isArray(input.policies) ? input.policies : [];
  const capabilityNames = validateCapabilities(input.capabilities, contextNames, resourceNames, errors, warnings);
  validatePrincipalScopes(input.capabilities, input.contexts, input.resources, errors);
  validateProtectedOrganizationContexts(input.capabilities, input.contexts, errors);
  validateWorkflows(input.workflows, contextNames, capabilityNames, errors);
  const policyByName = validatePolicies(input.policies, errors);
  validateCapabilityApprovalPolicies(capabilities, policies, policyByName, errors);
  validateEvidenceRecords(input.evidence, errors);
  validateProposalRecords(input.proposals, capabilityNames, errors);
  validateReceiptRecords(input.receipts, errors);
  validateReplay(input.replay, errors);
  validateExternalActions(input.external_actions, errors);
  validateActionRuleAuthority(input, resourceNames, contextNames, errors);
  scanForInlineSecrets(input, "$", errors);
  return { ok: errors.length === 0, errors, warnings };
}
function assertValidContract(input) {
  const result = validateContract(input);
  if (!result.ok)
    throw new SynapsorSpecValidationError(result.errors);
}
function validateMetadata(value, path7, errors) {
  if (value === void 0)
    return;
  if (!isRecord3(value)) {
    errors.push({ path: path7, code: "METADATA_NOT_OBJECT", message: "metadata must be an object." });
    return;
  }
  checkUnknownKeys(value, METADATA_KEYS, path7, errors);
  if (value.name !== void 0 && !isNonEmptyString(value.name))
    errors.push({ path: `${path7}.name`, code: "INVALID_METADATA_NAME", message: "metadata.name must be a non-empty string." });
  if (value.tags !== void 0 && (!Array.isArray(value.tags) || value.tags.some((tag) => !isNonEmptyString(tag)))) {
    errors.push({ path: `${path7}.tags`, code: "INVALID_METADATA_TAGS", message: "metadata.tags must be an array of non-empty strings." });
  }
}
function validateResources(value, errors, warnings) {
  const names = /* @__PURE__ */ new Set();
  if (value === void 0)
    return names;
  if (!Array.isArray(value)) {
    errors.push({ path: "$.resources", code: "RESOURCES_NOT_ARRAY", message: "resources must be an array." });
    return names;
  }
  value.forEach((resource, index) => {
    const path7 = `$.resources[${index}]`;
    if (!isRecord3(resource)) {
      errors.push({ path: path7, code: "RESOURCE_NOT_OBJECT", message: "resource must be an object." });
      return;
    }
    checkUnknownKeys(resource, RESOURCE_KEYS, path7, errors);
    if (!isQualifiedOrSafeName(resource.name))
      errors.push({ path: `${path7}.name`, code: "INVALID_RESOURCE_NAME", message: "resource name must be a safe identifier or qualified name." });
    else
      addUnique(names, resource.name, `${path7}.name`, "DUPLICATE_RESOURCE_NAME", errors);
    if (!["postgres", "mysql", "synapsor"].includes(String(resource.engine)))
      errors.push({ path: `${path7}.engine`, code: "INVALID_RESOURCE_ENGINE", message: "engine must be postgres, mysql, or synapsor." });
    for (const key2 of ["schema", "table", "primary_key"]) {
      if (!isSafeIdentifier(resource[key2]))
        errors.push({ path: `${path7}.${key2}`, code: "INVALID_RESOURCE_IDENTIFIER", message: `${key2} must be a fixed safe identifier.` });
    }
    if (resource.tenant_key !== void 0 && !isSafeIdentifier(resource.tenant_key))
      errors.push({ path: `${path7}.tenant_key`, code: "INVALID_TENANT_KEY", message: "tenant_key must be a fixed safe identifier." });
    if (!isSafeIdentifier(resource.tenant_key) && resource.single_tenant_dev !== true) {
      errors.push({ path: `${path7}.tenant_key`, code: "TENANT_KEY_REQUIRED", message: "tenant_key is required unless single_tenant_dev is explicitly true." });
    }
    if (resource.single_tenant_dev === true)
      warnings.push({ path: `${path7}.single_tenant_dev`, code: "SINGLE_TENANT_DEV", message: "single_tenant_dev is only for local demos and must not be used for shared tenant data." });
    if (resource.conflict_key !== void 0 && !isSafeIdentifier(resource.conflict_key))
      errors.push({ path: `${path7}.conflict_key`, code: "INVALID_CONFLICT_KEY", message: "conflict_key must be a fixed safe identifier." });
  });
  return names;
}
function validateContexts(value, errors, warnings) {
  const names = /* @__PURE__ */ new Set();
  if (!Array.isArray(value) || value.length === 0) {
    errors.push({ path: "$.contexts", code: "CONTEXTS_REQUIRED", message: "At least one context is required." });
    return names;
  }
  value.forEach((context, index) => {
    const path7 = `$.contexts[${index}]`;
    if (!isRecord3(context)) {
      errors.push({ path: path7, code: "CONTEXT_NOT_OBJECT", message: "context must be an object." });
      return;
    }
    checkUnknownKeys(context, CONTEXT_KEYS, path7, errors);
    if (!isQualifiedOrSafeName(context.name))
      errors.push({ path: `${path7}.name`, code: "INVALID_CONTEXT_NAME", message: "context name must be a safe identifier or qualified name." });
    else
      addUnique(names, context.name, `${path7}.name`, "DUPLICATE_CONTEXT_NAME", errors);
    if (!Array.isArray(context.bindings) || context.bindings.length === 0) {
      errors.push({ path: `${path7}.bindings`, code: "BINDINGS_REQUIRED", message: "context.bindings must contain trusted/session bindings." });
      return;
    }
    const bindingNames = /* @__PURE__ */ new Set();
    context.bindings.forEach((binding, bindingIndex) => {
      const bindingPath = `${path7}.bindings[${bindingIndex}]`;
      if (!isRecord3(binding)) {
        errors.push({ path: bindingPath, code: "BINDING_NOT_OBJECT", message: "binding must be an object." });
        return;
      }
      checkUnknownKeys(binding, BINDING_KEYS, bindingPath, errors);
      if (!isSafeIdentifier(binding.name))
        errors.push({ path: `${bindingPath}.name`, code: "INVALID_BINDING_NAME", message: "binding name must be a safe identifier." });
      else
        addUnique(bindingNames, binding.name, `${bindingPath}.name`, "DUPLICATE_BINDING_NAME", errors);
      if (!["session", "environment", "cloud_session", "static_dev", "http_claim", "reviewed_organization"].includes(String(binding.source)))
        errors.push({ path: `${bindingPath}.source`, code: "INVALID_BINDING_SOURCE", message: "binding source must be session, environment, cloud_session, static_dev, http_claim, or reviewed_organization." });
      if (!isNonEmptyString(binding.key))
        errors.push({ path: `${bindingPath}.key`, code: "INVALID_BINDING_KEY", message: "binding key must be a non-empty string." });
      if (binding.source === "static_dev")
        warnings.push({ path: `${bindingPath}.source`, code: "STATIC_DEV_BINDING", message: "static_dev bindings are for local demos only." });
    });
    for (const key2 of ["tenant_binding", "principal_binding"]) {
      if (context[key2] !== void 0 && (!isSafeIdentifier(context[key2]) || !bindingNames.has(String(context[key2])))) {
        errors.push({ path: `${path7}.${key2}`, code: "UNKNOWN_CONTEXT_BINDING", message: `${key2} must reference a binding name.` });
      }
    }
  });
  return names;
}
function validateCapabilities(value, contextNames, resourceNames, errors, warnings) {
  const names = /* @__PURE__ */ new Set();
  if (!Array.isArray(value)) {
    errors.push({ path: "$.capabilities", code: "CAPABILITIES_REQUIRED", message: "capabilities must be an array; an empty array represents zero authority." });
    return names;
  }
  value.forEach((capability, index) => {
    const path7 = `$.capabilities[${index}]`;
    if (!isRecord3(capability)) {
      errors.push({ path: path7, code: "CAPABILITY_NOT_OBJECT", message: "capability must be an object." });
      return;
    }
    checkUnknownKeys(capability, CAPABILITY_KEYS, path7, errors);
    if (!isQualifiedName(capability.name))
      errors.push({ path: `${path7}.name`, code: "INVALID_CAPABILITY_NAME", message: "capability name must be namespace.name." });
    else
      addUnique(names, capability.name, `${path7}.name`, "DUPLICATE_CAPABILITY_NAME", errors);
    if (capability.returns_hint !== void 0 && !isNonEmptyString(capability.returns_hint))
      errors.push({ path: `${path7}.returns_hint`, code: "INVALID_RETURNS_HINT", message: "returns_hint must be a non-empty string." });
    if (!["read", "aggregate_read", "proposal", "external_action", "answer_with_evidence"].includes(String(capability.kind)))
      errors.push({ path: `${path7}.kind`, code: "INVALID_CAPABILITY_KIND", message: "kind must be read, aggregate_read, proposal, external_action, or answer_with_evidence." });
    if (!isNonEmptyString(capability.context) || !contextNames.has(capability.context))
      errors.push({ path: `${path7}.context`, code: "UNKNOWN_CONTEXT", message: "capability.context must reference a declared context." });
    const proposalOrganizationScope = isRecord3(capability.proposal) ? capability.proposal.organization_scope : void 0;
    const protectedOrganizationScope = isRecord3(capability.protected_read) ? capability.protected_read.organization_scope : void 0;
    validateSubject(capability.subject, `${path7}.subject`, resourceNames, errors, warnings, proposalOrganizationScope ?? protectedOrganizationScope);
    const hasProtectedRead = capability.protected_read !== void 0;
    validateArgs(capability.args, `${path7}.args`, errors, capability.kind === "aggregate_read" || hasProtectedRead);
    if (capability.lookup !== void 0)
      validateLookup(capability.lookup, `${path7}.lookup`, capability.args, errors);
    validateFieldList(capability.visible_fields, `${path7}.visible_fields`, "VISIBLE_FIELDS_REQUIRED", errors, capability.kind === "aggregate_read");
    if (capability.kept_out_fields !== void 0)
      validateFieldList(capability.kept_out_fields, `${path7}.kept_out_fields`, "INVALID_KEPT_OUT_FIELDS", errors, true);
    if (capability.model_withheld_fields !== void 0) {
      validateFieldList(capability.model_withheld_fields, `${path7}.model_withheld_fields`, "INVALID_MODEL_WITHHELD_FIELDS", errors, true);
    }
    validateKeptOutExclusion(capability.visible_fields, capability.kept_out_fields, path7, errors);
    validateModelWithheldExclusion(capability.kept_out_fields, capability.model_withheld_fields, path7, errors);
    if (capability.evidence !== void 0)
      validateEvidenceRequirement(capability.evidence, `${path7}.evidence`, errors);
    if (capability.max_rows !== void 0 && !isPositiveInteger(capability.max_rows))
      errors.push({ path: `${path7}.max_rows`, code: "INVALID_MAX_ROWS", message: "max_rows must be a positive integer." });
    if (capability.kind === "proposal") {
      validateProposalAction(capability.proposal, capability.subject, `${path7}.proposal`, errors);
      validateSetCapabilityArgs(capability, path7, errors);
    }
    if (capability.kind !== "proposal" && capability.proposal !== void 0)
      errors.push({ path: `${path7}.proposal`, code: "PROPOSAL_ONLY_FOR_PROPOSAL_KIND", message: "proposal is only valid for proposal capabilities." });
    if (hasProtectedRead)
      validateProtectedRead(capability, path7, errors);
    if (capability.kind === "aggregate_read") {
      if (!hasProtectedRead)
        validateAggregateRead(capability, path7, errors);
      else if (capability.aggregate !== void 0)
        errors.push({ path: `${path7}.aggregate`, code: "LEGACY_AGGREGATE_WITH_PROTECTED_READ", message: "protected aggregate reads use protected_read.aggregate and must not also declare the legacy scalar aggregate field." });
    } else if (capability.aggregate !== void 0) {
      errors.push({ path: `${path7}.aggregate`, code: "AGGREGATE_ONLY_FOR_AGGREGATE_READ", message: "aggregate is valid only for aggregate_read capabilities." });
    }
  });
  return names;
}
function validateSetCapabilityArgs(capability, path7, errors) {
  if (!isRecord3(capability.proposal) || !isRecord3(capability.proposal.operation) || capability.proposal.operation.cardinality !== "set")
    return;
  const operation = capability.proposal.operation;
  const args = isRecord3(capability.args) ? capability.args : {};
  const patch = isRecord3(capability.proposal.patch) ? capability.proposal.patch : {};
  const visible = new Set(Array.isArray(capability.visible_fields) ? capability.visible_fields.filter((field) => typeof field === "string") : []);
  const requiredReadFields = [
    ...Array.isArray(operation.aggregate_bounds) ? operation.aggregate_bounds.filter(isRecord3).map((bound) => bound.column) : [],
    ...isRecord3(operation.selection) && Array.isArray(operation.selection.all) ? operation.selection.all.filter(isRecord3).map((term) => term.column) : [],
    ...isRecord3(capability.proposal.conflict_guard) ? [capability.proposal.conflict_guard.column] : []
  ].filter(isSafeIdentifier);
  for (const field of requiredReadFields)
    if (!visible.has(field))
      errors.push({ path: `${path7}.visible_fields`, code: "SET_REVIEW_FIELD_NOT_VISIBLE", message: `bounded set review requires visible field ${field}.` });
  if (operation.kind === "insert") {
    const itemsArg = isRecord3(operation.batch) ? operation.batch.items_from_arg : void 0;
    const arg = isSafeIdentifier(itemsArg) ? args[itemsArg] : void 0;
    if (!isRecord3(arg) || arg.type !== "object_array") {
      errors.push({ path: `${path7}.proposal.operation.batch.items_from_arg`, code: "BATCH_ITEMS_ARG_NOT_OBJECT_ARRAY", message: "batch.items_from_arg must reference an object_array argument." });
      return;
    }
    if (Number(arg.max_items) > Number(operation.max_rows))
      errors.push({ path: `${path7}.args.${String(itemsArg)}.max_items`, code: "BATCH_ITEMS_EXCEED_MAX_ROWS", message: "object_array max_items must not exceed operation.max_rows." });
    const fields = isRecord3(arg.fields) ? arg.fields : {};
    for (const [column, binding] of Object.entries(patch)) {
      if (!isRecord3(binding) || !isSafeIdentifier(binding.from_item) || !Object.prototype.hasOwnProperty.call(fields, binding.from_item)) {
        errors.push({ path: `${path7}.proposal.patch.${column}.from_item`, code: "UNKNOWN_BATCH_ITEM_FIELD", message: "batch INSERT patch fields must bind a declared item field." });
      }
    }
    const components = isRecord3(operation.deduplication) && Array.isArray(operation.deduplication.components) ? operation.deduplication.components : [];
    const primaryKey = isRecord3(capability.subject) ? capability.subject.primary_key : void 0;
    if (isSafeIdentifier(primaryKey) && !components.some((component) => isRecord3(component) && component.source === "item_field" && component.column === primaryKey)) {
      errors.push({ path: `${path7}.proposal.operation.deduplication.components`, code: "BATCH_PRIMARY_KEY_REQUIRED", message: `batch INSERT must derive primary key ${primaryKey} from a typed item field.` });
    }
    for (const [index, component] of components.entries()) {
      if (isRecord3(component) && component.source === "item_field" && (!isSafeIdentifier(component.item_field) || !Object.prototype.hasOwnProperty.call(fields, component.item_field))) {
        errors.push({ path: `${path7}.proposal.operation.deduplication.components[${index}].item_field`, code: "UNKNOWN_DEDUP_ITEM_FIELD", message: "item_field deduplication must reference a declared batch item field." });
      }
    }
  } else {
    for (const [column, binding] of Object.entries(patch))
      if (isRecord3(binding) && binding.from_item !== void 0)
        errors.push({ path: `${path7}.proposal.patch.${column}.from_item`, code: "FROM_ITEM_BATCH_INSERT_ONLY", message: "from_item is valid only for batch INSERT." });
  }
}
function validateSubject(value, path7, resourceNames, errors, warnings, organizationScope) {
  if (!isRecord3(value)) {
    errors.push({ path: path7, code: "SUBJECT_REQUIRED", message: "subject must be an object." });
    return;
  }
  checkUnknownKeys(value, SUBJECT_KEYS, path7, errors);
  if (value.resource !== void 0 && (!isQualifiedOrSafeName(value.resource) || resourceNames.size > 0 && !resourceNames.has(String(value.resource)))) {
    errors.push({ path: `${path7}.resource`, code: "UNKNOWN_RESOURCE", message: "subject.resource must reference a declared resource." });
  }
  if (value.resource === void 0) {
    for (const key2 of ["schema", "table", "primary_key"]) {
      if (!isSafeIdentifier(value[key2]))
        errors.push({ path: `${path7}.${key2}`, code: "INVALID_SUBJECT_IDENTIFIER", message: `${key2} must be provided as a fixed safe identifier when resource is omitted.` });
    }
    if (!isSafeIdentifier(value.tenant_key) && value.single_tenant_dev !== true && !validProtectedOrganizationScope(organizationScope)) {
      errors.push({ path: `${path7}.tenant_key`, code: "TENANT_KEY_REQUIRED", message: "tenant_key is required unless single_tenant_dev is explicitly true or the capability freezes a reviewed single organization." });
    }
  }
  if (value.principal_scope_key !== void 0 && !isSafeIdentifier(value.principal_scope_key)) {
    errors.push({ path: `${path7}.principal_scope_key`, code: "INVALID_PRINCIPAL_SCOPE_KEY", message: "principal_scope_key must be a fixed safe identifier." });
  }
  if (value.principal_scope_key !== void 0 && value.resource === void 0 && !isSafeIdentifier(value.tenant_key) && !validProtectedOrganizationScope(organizationScope)) {
    errors.push({ path: `${path7}.principal_scope_key`, code: "PRINCIPAL_SCOPE_TENANT_REQUIRED", message: "principal_scope_key requires either a reviewed tenant_key or a reviewed single-organization authority." });
  }
  if (value.principal_scope_key !== void 0 && value.single_tenant_dev === true) {
    errors.push({ path: `${path7}.principal_scope_key`, code: "PRINCIPAL_SCOPE_TENANT_REQUIRED", message: "principal_scope_key cannot be used with single_tenant_dev; declare a reviewed tenant_key." });
  }
  if (value.single_tenant_dev === true)
    warnings.push({ path: `${path7}.single_tenant_dev`, code: "SINGLE_TENANT_DEV", message: "single_tenant_dev is only for local demos and must not be used for shared tenant data." });
}
function validatePrincipalScopes(capabilities, contexts, resources, errors) {
  if (!Array.isArray(capabilities) || !Array.isArray(contexts))
    return;
  const contextByName = /* @__PURE__ */ new Map();
  const resourceByName = /* @__PURE__ */ new Map();
  for (const context of contexts) {
    if (isRecord3(context) && isNonEmptyString(context.name))
      contextByName.set(context.name, context);
  }
  if (Array.isArray(resources)) {
    for (const resource of resources) {
      if (isRecord3(resource) && isNonEmptyString(resource.name))
        resourceByName.set(resource.name, resource);
    }
  }
  capabilities.forEach((capability, index) => {
    if (!isRecord3(capability) || !isRecord3(capability.subject))
      return;
    const protectedRead = isRecord3(capability.protected_read) ? capability.protected_read : void 0;
    const protectedRelationshipPrincipal = isRecord3(protectedRead?.relationship) && protectedRead.relationship.principal_scope_key !== void 0;
    const protectedPathPrincipal = Array.isArray(protectedRead?.relationships) && protectedRead.relationships.some((relationship) => isRecord3(relationship) && Array.isArray(relationship.links) && relationship.links.some((link) => isRecord3(link) && link.principal_scope_key !== void 0));
    const rootPrincipal = capability.subject.principal_scope_key !== void 0;
    if (!rootPrincipal && !protectedRelationshipPrincipal && !protectedPathPrincipal)
      return;
    const path7 = `$.capabilities[${index}]`;
    const resource = typeof capability.subject.resource === "string" ? resourceByName.get(capability.subject.resource) : void 0;
    const tenantKey = capability.subject.tenant_key ?? resource?.tenant_key;
    const singleTenantDev = capability.subject.single_tenant_dev ?? resource?.single_tenant_dev;
    const organizationScoped = validProtectedOrganizationScope(isRecord3(capability.proposal) && capability.proposal.organization_scope !== void 0 ? capability.proposal.organization_scope : isRecord3(capability.protected_read) ? capability.protected_read.organization_scope : void 0);
    if (rootPrincipal && (!isSafeIdentifier(tenantKey) && !organizationScoped || singleTenantDev === true)) {
      errors.push({ path: `${path7}.subject.principal_scope_key`, code: "PRINCIPAL_SCOPE_TENANT_REQUIRED", message: "principal_scope_key requires a reviewed tenant_key or protected single-organization authority." });
    }
    const context = contextByName.get(String(capability.context));
    if (!context || !isSafeIdentifier(context.principal_binding)) {
      errors.push({ path: `${path7}.context`, code: "PRINCIPAL_SCOPE_BINDING_REQUIRED", message: "principal-scoped capabilities require a context with principal_binding." });
      return;
    }
    const binding = Array.isArray(context.bindings) ? context.bindings.find((item) => isRecord3(item) && item.name === context.principal_binding) : void 0;
    if (!isRecord3(binding) || binding.required !== true) {
      errors.push({ path: `${path7}.context`, code: "PRINCIPAL_SCOPE_BINDING_REQUIRED", message: "principal_binding must reference a required trusted context binding." });
    }
    if (rootPrincipal) {
      const scopeKey2 = capability.subject.principal_scope_key;
      if (isRecord3(capability.args) && Object.prototype.hasOwnProperty.call(capability.args, String(scopeKey2))) {
        errors.push({ path: `${path7}.args.${String(scopeKey2)}`, code: "MODEL_CONTROLLED_PRINCIPAL_SCOPE", message: "the reviewed principal scope column cannot also be a model-facing argument." });
      }
      if (isRecord3(capability.proposal)) {
        if (Array.isArray(capability.proposal.allowed_fields) && capability.proposal.allowed_fields.includes(scopeKey2)) {
          errors.push({ path: `${path7}.proposal.allowed_fields`, code: "PRINCIPAL_SCOPE_WRITE_FORBIDDEN", message: "the reviewed principal scope column cannot be model-writeable." });
        }
        if (isRecord3(capability.proposal.patch) && Object.prototype.hasOwnProperty.call(capability.proposal.patch, String(scopeKey2))) {
          errors.push({ path: `${path7}.proposal.patch.${String(scopeKey2)}`, code: "PRINCIPAL_SCOPE_WRITE_FORBIDDEN", message: "the reviewed principal scope column is forced from trusted context and cannot be patched by the model." });
        }
      }
    }
  });
}
function validateProtectedOrganizationContexts(capabilities, contexts, errors) {
  if (!Array.isArray(capabilities) || !Array.isArray(contexts))
    return;
  const contextByName = /* @__PURE__ */ new Map();
  for (const context of contexts) {
    if (isRecord3(context) && isNonEmptyString(context.name))
      contextByName.set(context.name, context);
  }
  capabilities.forEach((capability, index) => {
    if (!isRecord3(capability))
      return;
    const protectedRead = isRecord3(capability.protected_read) ? capability.protected_read : void 0;
    const proposal = isRecord3(capability.proposal) ? capability.proposal : void 0;
    const rawOrganizationScope = proposal?.organization_scope ?? protectedRead?.organization_scope;
    const organizationScope = isRecord3(rawOrganizationScope) ? rawOrganizationScope : void 0;
    const context = contextByName.get(String(capability.context));
    const tenantBindingName = context?.tenant_binding;
    const tenantBinding = Array.isArray(context?.bindings) ? context.bindings.find((binding) => isRecord3(binding) && binding.name === tenantBindingName) : void 0;
    const path7 = `$.capabilities[${index}]`;
    if (organizationScope !== void 0) {
      if (!isRecord3(tenantBinding) || tenantBinding.source !== "reviewed_organization" || tenantBinding.key !== organizationScope.organization_id || tenantBinding.required !== true) {
        errors.push({
          path: `${path7}.context`,
          code: "PROTECTED_ORGANIZATION_BINDING_REQUIRED",
          message: "reviewed single-organization authority requires a matching required reviewed_organization tenant binding."
        });
      }
    } else if (isRecord3(tenantBinding) && tenantBinding.source === "reviewed_organization") {
      errors.push({
        path: `${path7}.context`,
        code: "PROTECTED_ORGANIZATION_AUTHORITY_REQUIRED",
        message: "a reviewed_organization tenant binding is valid only for a read or proposal capability that freezes the same organization."
      });
    }
  });
}
function validProtectedOrganizationScope(value) {
  return isRecord3(value) && value.mode === "single_organization" && typeof value.organization_id === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value.organization_id) && value.acknowledgement === "all_rows_belong_to_one_organization";
}
function validateProtectedOrganizationScope(value, path7, errors) {
  if (value === void 0)
    return false;
  if (!isRecord3(value)) {
    errors.push({ path: path7, code: "PROTECTED_ORGANIZATION_SCOPE_NOT_OBJECT", message: "organization_scope must be a fixed reviewed authority object." });
    return false;
  }
  checkUnknownKeys(value, PROTECTED_ORGANIZATION_SCOPE_KEYS, path7, errors);
  if (value.mode !== "single_organization") {
    errors.push({ path: `${path7}.mode`, code: "INVALID_PROTECTED_ORGANIZATION_MODE", message: "organization_scope.mode must be single_organization." });
  }
  if (typeof value.organization_id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value.organization_id)) {
    errors.push({ path: `${path7}.organization_id`, code: "INVALID_PROTECTED_ORGANIZATION_ID", message: "organization_id must contain 1-128 letters, numbers, dots, colons, underscores, or dashes." });
  }
  if (value.acknowledgement !== "all_rows_belong_to_one_organization") {
    errors.push({ path: `${path7}.acknowledgement`, code: "PROTECTED_ORGANIZATION_ACKNOWLEDGEMENT_REQUIRED", message: "organization_scope must retain the reviewed all-rows-belong-to-one-organization acknowledgement." });
  }
  return validProtectedOrganizationScope(value);
}
function validateArgs(value, path7, errors, allowEmpty = false) {
  if (!isRecord3(value) || !allowEmpty && Object.keys(value).length === 0) {
    errors.push({ path: path7, code: "ARGS_REQUIRED", message: "args must define at least one model-facing business argument." });
    return;
  }
  for (const [name4, arg] of Object.entries(value)) {
    const argPath = `${path7}.${name4}`;
    if (!isSafeIdentifier(name4))
      errors.push({ path: argPath, code: "INVALID_ARG_NAME", message: "arg names must be safe identifiers." });
    if (TRUSTED_ARG_NAMES.has(name4))
      errors.push({ path: argPath, code: "MODEL_CONTROLLED_TRUST_ARG", message: "model-facing args cannot include trust scope, dynamic identifiers, or version authority." });
    if (!isRecord3(arg)) {
      errors.push({ path: argPath, code: "ARG_NOT_OBJECT", message: "arg definition must be an object." });
      continue;
    }
    checkUnknownKeys(arg, ARG_KEYS, argPath, errors);
    if (!["string", "number", "boolean", "object_array"].includes(String(arg.type)))
      errors.push({ path: `${argPath}.type`, code: "INVALID_ARG_TYPE", message: "arg type must be string, number, boolean, or object_array." });
    if (arg.description !== void 0 && !isNonEmptyString(arg.description))
      errors.push({ path: `${argPath}.description`, code: "INVALID_ARG_DESCRIPTION", message: "arg description must be a non-empty string." });
    if (arg.type === "object_array") {
      if (!Number.isSafeInteger(arg.max_items) || Number(arg.max_items) < 1 || Number(arg.max_items) > SET_MAX_ROWS_HARD_CEILING)
        errors.push({ path: `${argPath}.max_items`, code: "INVALID_OBJECT_ARRAY_MAX_ITEMS", message: `object_array max_items must be 1 through ${SET_MAX_ROWS_HARD_CEILING}.` });
      if (!isRecord3(arg.fields) || Object.keys(arg.fields).length === 0 || Object.keys(arg.fields).length > 64) {
        errors.push({ path: `${argPath}.fields`, code: "OBJECT_ARRAY_FIELDS_REQUIRED", message: "object_array fields must define 1 through 64 typed item fields." });
      } else {
        validateArgs(arg.fields, `${argPath}.fields`, errors);
        for (const [fieldName, field] of Object.entries(arg.fields)) {
          if (isRecord3(field) && field.type === "object_array")
            errors.push({ path: `${argPath}.fields.${fieldName}`, code: "NESTED_OBJECT_ARRAY_FORBIDDEN", message: "object_array item fields must be scalar." });
        }
      }
      for (const key2 of ["max_length", "minimum", "maximum", "enum"])
        if (arg[key2] !== void 0)
          errors.push({ path: `${argPath}.${key2}`, code: "OBJECT_ARRAY_SCALAR_OPTION_FORBIDDEN", message: `${key2} is valid only on scalar arguments or item fields.` });
      continue;
    }
    if (arg.max_items !== void 0 || arg.fields !== void 0)
      errors.push({ path: argPath, code: "OBJECT_ARRAY_OPTIONS_REQUIRE_OBJECT_ARRAY", message: "max_items and fields require type object_array." });
    if (arg.max_length !== void 0 && (!Number.isInteger(arg.max_length) || Number(arg.max_length) <= 0))
      errors.push({ path: `${argPath}.max_length`, code: "INVALID_MAX_LENGTH", message: "max_length must be a positive integer." });
    if ((arg.minimum !== void 0 || arg.maximum !== void 0) && arg.type !== "number")
      errors.push({ path: argPath, code: "NUMERIC_BOUNDS_REQUIRE_NUMBER", message: "minimum/maximum can only be used with number args." });
    if (arg.minimum !== void 0 && !isFiniteNumber(arg.minimum))
      errors.push({ path: `${argPath}.minimum`, code: "INVALID_MINIMUM", message: "minimum must be a finite number." });
    if (arg.maximum !== void 0 && !isFiniteNumber(arg.maximum))
      errors.push({ path: `${argPath}.maximum`, code: "INVALID_MAXIMUM", message: "maximum must be a finite number." });
    if (isFiniteNumber(arg.minimum) && isFiniteNumber(arg.maximum) && Number(arg.minimum) > Number(arg.maximum))
      errors.push({ path: argPath, code: "INVALID_ARG_NUMERIC_RANGE", message: "minimum must be less than or equal to maximum." });
    if (arg.enum !== void 0) {
      if (!Array.isArray(arg.enum) || arg.enum.length === 0 || arg.enum.length > 64) {
        errors.push({ path: `${argPath}.enum`, code: "INVALID_ARG_ENUM", message: "enum must contain 1 through 64 scalar values." });
      } else {
        const expectedType = arg.type;
        const keys = /* @__PURE__ */ new Set();
        arg.enum.forEach((item, enumIndex) => {
          if (item === null || typeof item !== expectedType)
            errors.push({ path: `${argPath}.enum[${enumIndex}]`, code: "ARG_ENUM_TYPE_MISMATCH", message: `enum values must match argument type ${String(expectedType)} and cannot be null.` });
          const key2 = `${typeof item}:${JSON.stringify(item)}`;
          if (keys.has(key2))
            errors.push({ path: `${argPath}.enum[${enumIndex}]`, code: "ARG_ENUM_DUPLICATE_VALUE", message: "enum values must be unique after canonicalization." });
          keys.add(key2);
        });
      }
    }
  }
}
function validateProtectedRead(capability, path7, errors) {
  const protectedRead = capability.protected_read;
  if (!isRecord3(protectedRead)) {
    errors.push({ path: `${path7}.protected_read`, code: "PROTECTED_READ_NOT_OBJECT", message: "protected_read must be a reviewed authority object." });
    return;
  }
  checkUnknownKeys(protectedRead, PROTECTED_READ_KEYS, `${path7}.protected_read`, errors);
  if (capability.kind !== "read" && capability.kind !== "aggregate_read") {
    errors.push({ path: `${path7}.protected_read`, code: "PROTECTED_READ_KIND_FORBIDDEN", message: "protected_read is valid only on read and aggregate_read capabilities." });
  }
  if (protectedRead.version !== "1")
    errors.push({ path: `${path7}.protected_read.version`, code: "INVALID_PROTECTED_READ_VERSION", message: "protected_read.version must be 1." });
  if (protectedRead.mode !== "rows" && protectedRead.mode !== "aggregate")
    errors.push({ path: `${path7}.protected_read.mode`, code: "INVALID_PROTECTED_READ_MODE", message: "protected_read.mode must be rows or aggregate." });
  if (protectedRead.mode === "rows" && capability.kind !== "read")
    errors.push({ path: `${path7}.kind`, code: "PROTECTED_READ_KIND_MISMATCH", message: "protected rows require capability kind read." });
  if (protectedRead.mode === "aggregate" && capability.kind !== "aggregate_read")
    errors.push({ path: `${path7}.kind`, code: "PROTECTED_READ_KIND_MISMATCH", message: "protected aggregates require capability kind aggregate_read." });
  for (const key2 of ["boundary_digest", "generation_lock_fingerprint"]) {
    if (!isSha256Digest(protectedRead[key2]))
      errors.push({ path: `${path7}.protected_read.${key2}`, code: "INVALID_PROTECTED_READ_DIGEST", message: `${key2} must be a canonical sha256 digest.` });
  }
  const organizationScoped = validateProtectedOrganizationScope(protectedRead.organization_scope, `${path7}.protected_read.organization_scope`, errors);
  const subject = isRecord3(capability.subject) ? capability.subject : {};
  if (organizationScoped && isSafeIdentifier(subject.tenant_key)) {
    errors.push({
      path: `${path7}.protected_read.organization_scope`,
      code: "PROTECTED_SCOPE_MODES_CONFLICT",
      message: "protected_read must freeze either tenant-key scope or one reviewed organization, never both."
    });
  }
  if (!organizationScoped && !isSafeIdentifier(subject.tenant_key)) {
    errors.push({
      path: `${path7}.subject.tenant_key`,
      code: "PROTECTED_TENANT_AUTHORITY_REQUIRED",
      message: "protected_read requires a reviewed tenant_key unless it freezes one reviewed organization."
    });
  }
  const args = isRecord3(capability.args) ? capability.args : {};
  const referencedArgs = /* @__PURE__ */ new Set();
  const keptOut = new Set(Array.isArray(capability.kept_out_fields) ? capability.kept_out_fields.filter((field) => typeof field === "string") : []);
  const trustedScopeFields = new Set([subject.tenant_key, subject.principal_scope_key].filter((field) => isSafeIdentifier(field)));
  const relationshipNames = /* @__PURE__ */ new Set();
  const legacyRelationshipName = validateProtectedRelationship(protectedRead.relationship, keptOut, trustedScopeFields, `${path7}.protected_read.relationship`, organizationScoped, errors);
  if (legacyRelationshipName)
    relationshipNames.add(legacyRelationshipName);
  if (protectedRead.relationship !== void 0 && protectedRead.relationships !== void 0) {
    errors.push({
      path: `${path7}.protected_read`,
      code: "PROTECTED_RELATIONSHIP_FORMS_CONFLICT",
      message: "protected_read must use either legacy relationship or reviewed relationships, not both."
    });
  }
  validateProtectedRelationshipPaths(protectedRead.relationships, keptOut, trustedScopeFields, `${path7}.protected_read.relationships`, relationshipNames, organizationScoped, errors);
  if (protectedRead.time_window !== void 0) {
    const timeWindowPath = `${path7}.protected_read.time_window`;
    if (!isRecord3(protectedRead.time_window)) {
      errors.push({ path: timeWindowPath, code: "PROTECTED_TIME_WINDOW_NOT_OBJECT", message: "time_window must be a fixed reviewed UTC range." });
    } else {
      checkUnknownKeys(protectedRead.time_window, PROTECTED_TIME_WINDOW_KEYS, timeWindowPath, errors);
      validateProtectedFieldReference(protectedRead.time_window.field, protectedRead.time_window.relationship, relationshipNames, keptOut, trustedScopeFields, timeWindowPath, errors);
      const start = protectedRead.time_window.start;
      const end = protectedRead.time_window.end;
      if (!isCanonicalUtcInstant(start) || !isCanonicalUtcInstant(end) || Date.parse(start) >= Date.parse(end)) {
        errors.push({
          path: timeWindowPath,
          code: "INVALID_PROTECTED_TIME_WINDOW",
          message: "time_window must freeze one canonical half-open UTC range with start < end; dynamic arguments are not allowed."
        });
      }
    }
  }
  if (!isRecord3(capability.evidence) || capability.evidence.required !== true || capability.evidence.query_audit !== true) {
    errors.push({
      path: `${path7}.evidence`,
      code: "PROTECTED_READ_EVIDENCE_REQUIRED",
      message: "protected reads require evidence.required=true and query_audit=true."
    });
  }
  if (protectedRead.predicates !== void 0) {
    if (!Array.isArray(protectedRead.predicates) || protectedRead.predicates.length > 8) {
      errors.push({ path: `${path7}.protected_read.predicates`, code: "INVALID_PROTECTED_PREDICATES", message: "protected_read.predicates must contain at most 8 reviewed predicates." });
    } else {
      protectedRead.predicates.forEach((predicate, index) => {
        const predicatePath = `${path7}.protected_read.predicates[${index}]`;
        if (!isRecord3(predicate)) {
          errors.push({ path: predicatePath, code: "PROTECTED_PREDICATE_NOT_OBJECT", message: "protected predicate must be an object." });
          return;
        }
        checkUnknownKeys(predicate, PROTECTED_PREDICATE_KEYS, predicatePath, errors);
        validateProtectedFieldReference(predicate.field, predicate.relationship, relationshipNames, keptOut, trustedScopeFields, predicatePath, errors);
        if (!["eq", "neq", "lt", "lte", "gt", "gte", "in"].includes(String(predicate.operator))) {
          errors.push({ path: `${predicatePath}.operator`, code: "INVALID_PROTECTED_PREDICATE_OPERATOR", message: "protected predicate operator must be eq, neq, lt, lte, gt, gte, or in." });
        }
        if (predicate.operator === "in") {
          if (predicate.value !== void 0)
            errors.push({ path: `${predicatePath}.value`, code: "PROTECTED_IN_VALUE_FORBIDDEN", message: "in predicates use a fixed values list, not value." });
          if (!Array.isArray(predicate.values) || predicate.values.length < 1 || predicate.values.length > 20 || predicate.values.some((value) => !isJsonScalar(value))) {
            errors.push({ path: `${predicatePath}.values`, code: "INVALID_PROTECTED_IN_VALUES", message: "in predicates require 1 through 20 fixed scalar values." });
          }
        } else {
          if (predicate.values !== void 0)
            errors.push({ path: `${predicatePath}.values`, code: "PROTECTED_VALUES_IN_ONLY", message: "values is valid only for an in predicate." });
          validateProtectedValue(predicate.value, args, referencedArgs, `${predicatePath}.value`, errors);
        }
      });
    }
  }
  if (protectedRead.row_order_by !== void 0) {
    if (!Array.isArray(protectedRead.row_order_by) || protectedRead.row_order_by.length < 1 || protectedRead.row_order_by.length > 3) {
      errors.push({ path: `${path7}.protected_read.row_order_by`, code: "INVALID_PROTECTED_ROW_ORDER", message: "row_order_by must contain 1 through 3 fixed sort fields." });
    } else {
      const visible = new Set(Array.isArray(capability.visible_fields) ? capability.visible_fields.filter((field) => typeof field === "string") : []);
      protectedRead.row_order_by.forEach((order, index) => {
        const orderPath = `${path7}.protected_read.row_order_by[${index}]`;
        if (!isRecord3(order)) {
          errors.push({ path: orderPath, code: "PROTECTED_ROW_ORDER_NOT_OBJECT", message: "row order must be an object." });
          return;
        }
        checkUnknownKeys(order, PROTECTED_ROW_ORDER_KEYS, orderPath, errors);
        if (!isSafeIdentifier(order.field) || !visible.has(String(order.field)) || keptOut.has(String(order.field))) {
          errors.push({ path: `${orderPath}.field`, code: "PROTECTED_ROW_ORDER_FIELD_FORBIDDEN", message: "row order field must be a visible, non-kept-out subject field." });
        }
        if (order.direction !== "asc" && order.direction !== "desc")
          errors.push({ path: `${orderPath}.direction`, code: "INVALID_PROTECTED_ORDER_DIRECTION", message: "order direction must be asc or desc." });
      });
    }
  }
  validateProtectedReadLimits(protectedRead.limits, `${path7}.protected_read.limits`, errors);
  if (protectedRead.mode === "rows") {
    if (protectedRead.aggregate !== void 0)
      errors.push({ path: `${path7}.protected_read.aggregate`, code: "PROTECTED_AGGREGATE_ROWS_FORBIDDEN", message: "protected row reads must not declare aggregate." });
    if (capability.lookup !== void 0)
      errors.push({ path: `${path7}.lookup`, code: "PROTECTED_LOOKUP_FORBIDDEN", message: "protected row reads use only their reviewed predicates and must not also declare legacy lookup." });
    if (!Array.isArray(capability.visible_fields) || capability.visible_fields.length === 0)
      errors.push({ path: `${path7}.visible_fields`, code: "PROTECTED_ROW_VISIBLE_FIELDS_REQUIRED", message: "protected row reads require one or more visible fields." });
    const maxRows = isRecord3(protectedRead.limits) ? protectedRead.limits.max_rows : void 0;
    if (!Number.isSafeInteger(capability.max_rows) || capability.max_rows !== maxRows) {
      errors.push({ path: `${path7}.max_rows`, code: "PROTECTED_ROW_LIMIT_MISMATCH", message: "capability.max_rows must exactly match protected_read.limits.max_rows." });
    }
  } else if (protectedRead.mode === "aggregate") {
    if (capability.lookup !== void 0)
      errors.push({ path: `${path7}.lookup`, code: "PROTECTED_AGGREGATE_LOOKUP_FORBIDDEN", message: "protected aggregate reads do not use legacy lookup." });
    if (Array.isArray(capability.visible_fields) && capability.visible_fields.length > 0)
      errors.push({ path: `${path7}.visible_fields`, code: "PROTECTED_AGGREGATE_VISIBLE_ROWS_FORBIDDEN", message: "protected aggregate reads return no source row fields." });
    if (protectedRead.row_order_by !== void 0)
      errors.push({ path: `${path7}.protected_read.row_order_by`, code: "PROTECTED_AGGREGATE_ROW_ORDER_FORBIDDEN", message: "protected aggregates use aggregate.order_by." });
    validateProtectedAggregate(protectedRead.aggregate, {
      args,
      referencedArgs,
      relationshipNames,
      keptOut,
      trustedScopeFields,
      maxGroups: isRecord3(protectedRead.limits) ? protectedRead.limits.max_groups : void 0,
      maxRankedGroups: isRecord3(protectedRead.limits) ? protectedRead.limits.max_ranked_groups : void 0,
      path: `${path7}.protected_read.aggregate`,
      errors
    });
    if (protectedRead.time_window !== void 0 && isRecord3(protectedRead.aggregate) && protectedRead.aggregate.comparison !== void 0) {
      errors.push({
        path: `${path7}.protected_read`,
        code: "PROTECTED_TIME_SELECTION_CONFLICT",
        message: "protected_read must use either one fixed time_window or an aggregate comparison, not both."
      });
    }
  }
  for (const [name4, arg] of Object.entries(args)) {
    if (isRecord3(arg) && arg.type === "object_array") {
      errors.push({ path: `${path7}.args.${name4}`, code: "PROTECTED_READ_SCALAR_ARGS_ONLY", message: "protected reads accept only bounded scalar arguments." });
    }
    if (!referencedArgs.has(name4)) {
      errors.push({ path: `${path7}.args.${name4}`, code: "PROTECTED_READ_UNUSED_ARG", message: "every protected-read argument must be selected by a human for one reviewed value position." });
    }
  }
}
function validateProtectedRelationship(value, keptOut, trustedScopeFields, path7, organizationScoped, errors) {
  if (value === void 0)
    return void 0;
  if (!isRecord3(value)) {
    errors.push({ path: path7, code: "PROTECTED_RELATIONSHIP_NOT_OBJECT", message: "protected relationship must be an object." });
    return void 0;
  }
  checkUnknownKeys(value, PROTECTED_RELATIONSHIP_KEYS, path7, errors);
  for (const key2 of ["name", "schema", "table", "primary_key", "local_key", "target_key"]) {
    if (!isSafeIdentifier(value[key2]))
      errors.push({ path: `${path7}.${key2}`, code: "INVALID_PROTECTED_RELATIONSHIP_IDENTIFIER", message: `${key2} must be a fixed safe identifier.` });
  }
  if (organizationScoped && value.tenant_key !== void 0) {
    errors.push({ path: `${path7}.tenant_key`, code: "PROTECTED_SCOPE_MODES_CONFLICT", message: "single-organization protected relationships must not declare tenant_key." });
  } else if (!organizationScoped && !isSafeIdentifier(value.tenant_key)) {
    errors.push({ path: `${path7}.tenant_key`, code: "INVALID_PROTECTED_RELATIONSHIP_IDENTIFIER", message: "tenant_key must be a fixed safe identifier for tenant-scoped protected relationships." });
  }
  if (value.principal_scope_key !== void 0 && !isSafeIdentifier(value.principal_scope_key))
    errors.push({ path: `${path7}.principal_scope_key`, code: "INVALID_PROTECTED_RELATIONSHIP_IDENTIFIER", message: "principal_scope_key must be a fixed safe identifier." });
  if (value.cardinality !== "many_to_one" || value.max_fan_out !== 1) {
    errors.push({ path: path7, code: "PROTECTED_RELATIONSHIP_CARDINALITY_FORBIDDEN", message: "the protected-read release permits only an explicitly reviewed many-to-one relationship with max_fan_out 1." });
  }
  if (isSafeIdentifier(value.local_key) && (keptOut.has(value.local_key) || trustedScopeFields.has(value.local_key))) {
    errors.push({
      path: `${path7}.local_key`,
      code: "PROTECTED_RELATIONSHIP_LOCAL_KEY_FORBIDDEN",
      message: "the reviewed relationship cannot join through a kept-out or trusted-scope subject field."
    });
  }
  return isSafeIdentifier(value.name) ? value.name : void 0;
}
function validateProtectedRelationshipPaths(value, keptOut, trustedScopeFields, path7, relationshipNames, organizationScoped, errors) {
  if (value === void 0)
    return;
  if (!Array.isArray(value) || value.length < 1 || value.length > 3) {
    errors.push({
      path: path7,
      code: "INVALID_PROTECTED_RELATIONSHIP_PATHS",
      message: "protected relationships must contain 1 through 3 reviewed paths."
    });
    return;
  }
  value.forEach((candidate, pathIndex) => {
    const candidatePath = `${path7}[${pathIndex}]`;
    if (!isRecord3(candidate)) {
      errors.push({ path: candidatePath, code: "PROTECTED_RELATIONSHIP_PATH_NOT_OBJECT", message: "protected relationship path must be an object." });
      return;
    }
    checkUnknownKeys(candidate, PROTECTED_RELATIONSHIP_PATH_KEYS, candidatePath, errors);
    if (!isSafeIdentifier(candidate.name)) {
      errors.push({ path: `${candidatePath}.name`, code: "INVALID_PROTECTED_RELATIONSHIP_IDENTIFIER", message: "relationship path name must be a fixed safe identifier." });
    } else if (relationshipNames.has(candidate.name)) {
      errors.push({ path: `${candidatePath}.name`, code: "DUPLICATE_PROTECTED_RELATIONSHIP", message: "protected relationship names must be unique." });
    } else {
      relationshipNames.add(candidate.name);
    }
    if (!Array.isArray(candidate.links) || candidate.links.length < 1 || candidate.links.length > 3) {
      errors.push({ path: `${candidatePath}.links`, code: "INVALID_PROTECTED_RELATIONSHIP_LINKS", message: "a protected relationship path requires one through three reviewed many-to-one links." });
      return;
    }
    candidate.links.forEach((link, linkIndex) => {
      const linkPath = `${candidatePath}.links[${linkIndex}]`;
      if (!isRecord3(link)) {
        errors.push({ path: linkPath, code: "PROTECTED_RELATIONSHIP_LINK_NOT_OBJECT", message: "protected relationship link must be an object." });
        return;
      }
      checkUnknownKeys(link, PROTECTED_RELATIONSHIP_LINK_KEYS, linkPath, errors);
      for (const key2 of ["schema", "table", "primary_key", "local_key", "target_key"]) {
        if (!isSafeIdentifier(link[key2]))
          errors.push({ path: `${linkPath}.${key2}`, code: "INVALID_PROTECTED_RELATIONSHIP_IDENTIFIER", message: `${key2} must be a fixed safe identifier.` });
      }
      if (organizationScoped && link.tenant_key !== void 0) {
        errors.push({ path: `${linkPath}.tenant_key`, code: "PROTECTED_SCOPE_MODES_CONFLICT", message: "single-organization protected relationship links must not declare tenant_key." });
      } else if (!organizationScoped && !isSafeIdentifier(link.tenant_key)) {
        errors.push({ path: `${linkPath}.tenant_key`, code: "INVALID_PROTECTED_RELATIONSHIP_IDENTIFIER", message: "tenant_key must be a fixed safe identifier for tenant-scoped protected relationship links." });
      }
      if (link.principal_scope_key !== void 0 && !isSafeIdentifier(link.principal_scope_key)) {
        errors.push({ path: `${linkPath}.principal_scope_key`, code: "INVALID_PROTECTED_RELATIONSHIP_IDENTIFIER", message: "principal_scope_key must be a fixed safe identifier." });
      }
      if (link.cardinality !== "many_to_one" || link.max_fan_out !== 1) {
        errors.push({ path: linkPath, code: "PROTECTED_RELATIONSHIP_CARDINALITY_FORBIDDEN", message: "every protected relationship link must be reviewed many-to-one with max_fan_out 1." });
      }
      if (link.unmatched_rows !== "exclude" && link.unmatched_rows !== "keep_null") {
        errors.push({ path: `${linkPath}.unmatched_rows`, code: "PROTECTED_RELATIONSHIP_NULL_SEMANTICS_REQUIRED", message: "every protected relationship link must freeze exclude or keep_null unmatched-row semantics." });
      }
      if (linkIndex === 0 && isSafeIdentifier(link.local_key) && (keptOut.has(link.local_key) || trustedScopeFields.has(link.local_key))) {
        errors.push({
          path: `${linkPath}.local_key`,
          code: "PROTECTED_RELATIONSHIP_LOCAL_KEY_FORBIDDEN",
          message: "the reviewed relationship cannot join through a kept-out or trusted-scope subject field."
        });
      }
    });
  });
}
function validateProtectedAggregate(value, input) {
  const { path: path7, errors } = input;
  if (!isRecord3(value)) {
    errors.push({ path: path7, code: "PROTECTED_AGGREGATE_REQUIRED", message: "protected aggregate mode requires a frozen aggregate definition." });
    return;
  }
  checkUnknownKeys(value, PROTECTED_AGGREGATE_KEYS, path7, errors);
  if (value.counted_entity !== "subject")
    errors.push({ path: `${path7}.counted_entity`, code: "INVALID_PROTECTED_COUNTED_ENTITY", message: "the initial protected aggregate release counts the scoped subject entity." });
  const measureNames = /* @__PURE__ */ new Set();
  if (!Array.isArray(value.measures) || value.measures.length < 1 || value.measures.length > 4) {
    errors.push({ path: `${path7}.measures`, code: "INVALID_PROTECTED_MEASURES", message: "protected aggregate requires 1 through 4 reviewed measures." });
  } else {
    value.measures.forEach((measure, index) => {
      const measurePath = `${path7}.measures[${index}]`;
      if (!isRecord3(measure)) {
        errors.push({ path: measurePath, code: "PROTECTED_MEASURE_NOT_OBJECT", message: "protected measure must be an object." });
        return;
      }
      checkUnknownKeys(measure, PROTECTED_MEASURE_KEYS, measurePath, errors);
      validateUniqueIdentifier(measure.name, measureNames, `${measurePath}.name`, "DUPLICATE_PROTECTED_MEASURE_NAME", errors);
      if (!["count", "count_distinct", "sum", "avg", "stddev_samp", "stddev_pop", "var_samp", "var_pop", "null_count", "non_null_count", "completion_rate", "reviewed_derived"].includes(String(measure.function)))
        errors.push({ path: `${measurePath}.function`, code: "INVALID_PROTECTED_MEASURE_FUNCTION", message: "measure function is not in the reviewed fixed aggregate allowlist." });
      if (measure.function === "reviewed_derived") {
        if (measure.field !== void 0 || measure.relationship !== void 0) {
          errors.push({ path: measurePath, code: "PROTECTED_DERIVED_DIRECT_FIELD_FORBIDDEN", message: "a reviewed derived measure freezes its fields inside derived operands." });
        }
        validateProtectedDerivedMeasure(measure.derived, measurePath, input, value, errors);
      } else {
        if (measure.derived !== void 0)
          errors.push({ path: `${measurePath}.derived`, code: "PROTECTED_DERIVED_SHAPE_FORBIDDEN", message: "only reviewed_derived measures may declare a fixed derived shape." });
        validateProtectedRelationshipReference(measure.relationship, input.relationshipNames, `${measurePath}.relationship`, errors);
      }
      if (measure.function === "count") {
        if (measure.field !== void 0)
          errors.push({ path: `${measurePath}.field`, code: "PROTECTED_COUNT_FIELD_FORBIDDEN", message: "count measures count scoped subject rows and must not declare a field." });
        if (measure.relationship !== void 0)
          errors.push({ path: `${measurePath}.relationship`, code: "PROTECTED_COUNT_RELATIONSHIP_FORBIDDEN", message: "count measures count the scoped subject entity, not a joined relation." });
      } else if (measure.function !== "reviewed_derived") {
        validateProtectedFieldReference(measure.field, measure.relationship, input.relationshipNames, input.keptOut, input.trustedScopeFields, measurePath, errors);
      }
    });
    if (value.measures.some((measure) => isRecord3(measure) && ["stddev_samp", "stddev_pop", "var_samp", "var_pop", "reviewed_derived"].includes(String(measure.function))) && (!Number.isSafeInteger(value.minimum_group_size) || Number(value.minimum_group_size) < 5)) {
      errors.push({
        path: `${path7}.minimum_group_size`,
        code: "PROTECTED_DISPERSION_COHORT_TOO_SMALL",
        message: "dispersion and reviewed derived measures require a minimum group size of at least 5 contributors."
      });
    }
  }
  const dimensionNames = /* @__PURE__ */ new Set();
  if (value.dimensions !== void 0) {
    if (!Array.isArray(value.dimensions) || value.dimensions.length > 3) {
      errors.push({ path: `${path7}.dimensions`, code: "INVALID_PROTECTED_DIMENSIONS", message: "protected aggregate permits at most 3 reviewed dimensions." });
    } else {
      value.dimensions.forEach((dimension, index) => {
        const dimensionPath = `${path7}.dimensions[${index}]`;
        if (!isRecord3(dimension)) {
          errors.push({ path: dimensionPath, code: "PROTECTED_DIMENSION_NOT_OBJECT", message: "protected dimension must be an object." });
          return;
        }
        checkUnknownKeys(dimension, PROTECTED_DIMENSION_KEYS, dimensionPath, errors);
        validateUniqueIdentifier(dimension.name, dimensionNames, `${dimensionPath}.name`, "DUPLICATE_PROTECTED_DIMENSION_NAME", errors);
        validateProtectedFieldReference(dimension.field, dimension.relationship, input.relationshipNames, input.keptOut, input.trustedScopeFields, dimensionPath, errors);
        if (dimension.numeric_band !== void 0) {
          validateProtectedNumericBand(dimension.numeric_band, `${dimensionPath}.numeric_band`, errors);
        }
      });
    }
  }
  if (value.time_bucket !== void 0) {
    const bucketPath = `${path7}.time_bucket`;
    if (!isRecord3(value.time_bucket)) {
      errors.push({ path: bucketPath, code: "PROTECTED_TIME_BUCKET_NOT_OBJECT", message: "time_bucket must be an object." });
    } else {
      checkUnknownKeys(value.time_bucket, PROTECTED_TIME_BUCKET_KEYS, bucketPath, errors);
      if (!isSafeIdentifier(value.time_bucket.name))
        errors.push({ path: `${bucketPath}.name`, code: "INVALID_PROTECTED_TIME_BUCKET_NAME", message: "time bucket name must be a safe identifier." });
      if (!["hour", "day", "week", "month", "quarter", "year", "day_of_week"].includes(String(value.time_bucket.bucket)))
        errors.push({ path: `${bucketPath}.bucket`, code: "INVALID_PROTECTED_TIME_BUCKET", message: "time bucket must be hour, day, week, month, quarter, year, or day_of_week." });
      validateProtectedFieldReference(value.time_bucket.field, value.time_bucket.relationship, input.relationshipNames, input.keptOut, input.trustedScopeFields, bucketPath, errors);
    }
  }
  if (value.comparison !== void 0) {
    const comparisonPath = `${path7}.comparison`;
    if (!isRecord3(value.comparison)) {
      errors.push({ path: comparisonPath, code: "PROTECTED_COMPARISON_NOT_OBJECT", message: "comparison must be an object." });
    } else {
      checkUnknownKeys(value.comparison, PROTECTED_COMPARISON_KEYS, comparisonPath, errors);
      validateProtectedFieldReference(value.comparison.field, value.comparison.relationship, input.relationshipNames, input.keptOut, input.trustedScopeFields, comparisonPath, errors);
      if (!Array.isArray(value.comparison.ranges) || value.comparison.ranges.length < 1 || value.comparison.ranges.length > 2) {
        errors.push({ path: `${comparisonPath}.ranges`, code: "INVALID_PROTECTED_COMPARISON_RANGES", message: "comparison requires one or two bounded time ranges." });
      } else {
        value.comparison.ranges.forEach((range, index) => {
          const rangePath = `${comparisonPath}.ranges[${index}]`;
          if (!isRecord3(range)) {
            errors.push({ path: rangePath, code: "PROTECTED_COMPARISON_RANGE_NOT_OBJECT", message: "comparison range must be an object." });
            return;
          }
          checkUnknownKeys(range, PROTECTED_RANGE_KEYS, rangePath, errors);
          validateProtectedValue(range.start, input.args, input.referencedArgs, `${rangePath}.start`, errors);
          validateProtectedValue(range.end, input.args, input.referencedArgs, `${rangePath}.end`, errors);
        });
      }
    }
  }
  if (value.order_by !== void 0) {
    const orderPath = `${path7}.order_by`;
    if (!isRecord3(value.order_by)) {
      errors.push({ path: orderPath, code: "PROTECTED_AGGREGATE_ORDER_NOT_OBJECT", message: "aggregate order_by must be an object." });
    } else {
      checkUnknownKeys(value.order_by, PROTECTED_AGGREGATE_ORDER_KEYS, orderPath, errors);
      if (value.order_by.direction !== "asc" && value.order_by.direction !== "desc")
        errors.push({ path: `${orderPath}.direction`, code: "INVALID_PROTECTED_ORDER_DIRECTION", message: "order direction must be asc or desc." });
      if (value.order_by.kind === "measure") {
        if (!isSafeIdentifier(value.order_by.measure) || !measureNames.has(String(value.order_by.measure)))
          errors.push({ path: `${orderPath}.measure`, code: "UNKNOWN_PROTECTED_ORDER_MEASURE", message: "measure ordering must reference a reviewed measure name." });
        if (value.order_by.change !== void 0)
          errors.push({ path: `${orderPath}.change`, code: "PROTECTED_MEASURE_ORDER_CHANGE_FORBIDDEN", message: "measure ordering must not declare a comparison-change shape." });
      } else if (value.order_by.kind === "comparison_change") {
        if (!isSafeIdentifier(value.order_by.measure) || !measureNames.has(String(value.order_by.measure)))
          errors.push({ path: `${orderPath}.measure`, code: "UNKNOWN_PROTECTED_ORDER_MEASURE", message: "comparison-change ordering must reference a reviewed measure name." });
        if (value.order_by.change !== "absolute" && value.order_by.change !== "percentage")
          errors.push({ path: `${orderPath}.change`, code: "INVALID_PROTECTED_COMPARISON_CHANGE", message: "comparison-change ordering must use absolute or percentage change." });
        if (!isRecord3(value.comparison) || !Array.isArray(value.comparison.ranges) || value.comparison.ranges.length !== 2) {
          errors.push({ path: orderPath, code: "PROTECTED_CHANGE_ORDER_REQUIRES_COMPARISON", message: "comparison-change ordering requires exactly two reviewed periods." });
        }
      } else if (value.order_by.kind === "time_bucket") {
        if (value.order_by.measure !== void 0)
          errors.push({ path: `${orderPath}.measure`, code: "PROTECTED_TIME_ORDER_MEASURE_FORBIDDEN", message: "time-bucket ordering must not declare a measure." });
        if (value.order_by.change !== void 0)
          errors.push({ path: `${orderPath}.change`, code: "PROTECTED_TIME_ORDER_CHANGE_FORBIDDEN", message: "time-bucket ordering must not declare a comparison-change shape." });
        if (!isRecord3(value.time_bucket))
          errors.push({ path: orderPath, code: "PROTECTED_TIME_ORDER_REQUIRES_BUCKET", message: "time-bucket ordering requires a reviewed time bucket." });
        if (isRecord3(value.comparison))
          errors.push({ path: orderPath, code: "PROTECTED_COMPARISON_TIME_ORDER_FORBIDDEN", message: "a two-period comparison cannot order by an absolute time bucket." });
      } else {
        errors.push({ path: `${orderPath}.kind`, code: "INVALID_PROTECTED_AGGREGATE_ORDER", message: "aggregate order kind must be measure, comparison_change, or time_bucket." });
      }
    }
  }
  const hasPostAggregateTransform = Array.isArray(value.measures) && value.measures.some((measure) => isRecord3(measure) && measure.function === "reviewed_derived" && isRecord3(measure.derived) && PROTECTED_POST_AGGREGATE_SHAPES.has(String(measure.derived.shape)));
  const ranked = hasPostAggregateTransform || isRecord3(value.order_by) && (value.order_by.kind === "measure" || value.order_by.kind === "comparison_change");
  const maximumGroups = ranked && Number.isSafeInteger(input.maxRankedGroups) ? Number(input.maxRankedGroups) : input.maxGroups;
  if (!Number.isSafeInteger(value.top_n) || Number(value.top_n) < 1 || Number(value.top_n) > 100 || Number.isSafeInteger(maximumGroups) && Number(value.top_n) > Number(maximumGroups)) {
    errors.push({ path: `${path7}.top_n`, code: "INVALID_PROTECTED_TOP_N", message: "top_n must be positive, at most 100, and no greater than its reviewed group limit." });
  }
  if (!Number.isSafeInteger(value.minimum_group_size) || Number(value.minimum_group_size) < 1 || Number(value.minimum_group_size) > 1e6) {
    errors.push({ path: `${path7}.minimum_group_size`, code: "INVALID_PROTECTED_MINIMUM_GROUP_SIZE", message: "minimum_group_size must be from 1 through 1000000." });
  }
}
function validateProtectedNumericBand(value, path7, errors) {
  if (!isRecord3(value)) {
    errors.push({ path: path7, code: "PROTECTED_NUMERIC_BAND_NOT_OBJECT", message: "reviewed numeric band must be an object." });
    return;
  }
  checkUnknownKeys(value, PROTECTED_NUMERIC_BAND_KEYS, path7, errors);
  const edges = Array.isArray(value.edges) ? value.edges : [];
  if (edges.length < 1 || edges.length > 16 || edges.some((edge) => typeof edge !== "number" || !Number.isFinite(edge)) || edges.some((edge, index) => index > 0 && Number(edge) <= Number(edges[index - 1]))) {
    errors.push({ path: `${path7}.edges`, code: "INVALID_PROTECTED_NUMERIC_BAND_EDGES", message: "reviewed numeric band requires 1 through 16 finite, strictly increasing edges." });
  }
  const labels = Array.isArray(value.bucket_labels) ? value.bucket_labels : [];
  if (labels.length !== edges.length + 1 || labels.some((label) => typeof label !== "string" || !label.trim() || [...label].length > 64 || /[\u0000-\u001f\u007f]/.test(label)) || new Set(labels).size !== labels.length || new TextEncoder().encode(JSON.stringify(labels)).byteLength > 2048) {
    errors.push({ path: `${path7}.bucket_labels`, code: "INVALID_PROTECTED_NUMERIC_BAND_LABELS", message: "reviewed numeric band requires one unique bounded label per bucket and at most 2048 UTF-8 bytes total." });
  }
}
function validateProtectedDerivedMeasure(value, measurePath, input, aggregate, errors) {
  const path7 = `${measurePath}.derived`;
  if (!isRecord3(value)) {
    errors.push({ path: path7, code: "PROTECTED_DERIVED_REQUIRED", message: "reviewed_derived requires one fixed reviewed calculation." });
    return;
  }
  if (["ratio", "percentage", "per_unit_average"].includes(String(value.shape))) {
    checkUnknownKeys(value, PROTECTED_RATIO_DERIVED_MEASURE_KEYS, path7, errors);
    if (value.null_policy !== "null_on_zero_or_null_denominator") {
      errors.push({ path: `${path7}.null_policy`, code: "INVALID_PROTECTED_DERIVED_NULL_POLICY", message: "derived denominator behavior must be null_on_zero_or_null_denominator." });
    }
    const numerator = validateProtectedDerivedOperand(value.numerator, `${path7}.numerator`, input, errors);
    const denominator = validateProtectedDerivedOperand(value.denominator, `${path7}.denominator`, input, errors);
    if (numerator && denominator && numerator.relationship !== denominator.relationship) {
      errors.push({ path: path7, code: "PROTECTED_DERIVED_RELATIONSHIP_MISMATCH", message: "derived operands must use the same reviewed relationship path." });
    }
    if (value.shape === "per_unit_average" && (numerator?.function !== "sum" || !["count", "count_distinct"].includes(denominator?.function ?? ""))) {
      errors.push({ path: path7, code: "INVALID_PROTECTED_PER_UNIT_SHAPE", message: "per_unit_average requires SUM divided by COUNT or COUNT DISTINCT." });
    }
    return;
  }
  if (!PROTECTED_POST_AGGREGATE_SHAPES.has(String(value.shape))) {
    errors.push({
      path: `${path7}.shape`,
      code: "INVALID_PROTECTED_DERIVED_SHAPE",
      message: "derived shape is not in the fixed reviewed calculation allowlist."
    });
    return;
  }
  checkUnknownKeys(value, PROTECTED_POST_DERIVED_MEASURE_KEYS, path7, errors);
  validateProtectedDerivedOperand(value.base_measure, `${path7}.base_measure`, input, errors);
  if (value.shape === "rank") {
    if (value.direction !== "asc" && value.direction !== "desc") {
      errors.push({ path: `${path7}.direction`, code: "PROTECTED_RANK_DIRECTION_REQUIRED", message: "rank requires a fixed asc or desc direction." });
    }
  } else if (value.direction !== void 0) {
    errors.push({ path: `${path7}.direction`, code: "PROTECTED_TRANSFORM_DIRECTION_FORBIDDEN", message: "only rank may declare a direction." });
  }
  if (value.shape === "moving_average") {
    if (!Number.isSafeInteger(value.window_size) || Number(value.window_size) < 2 || Number(value.window_size) > 12) {
      errors.push({ path: `${path7}.window_size`, code: "PROTECTED_MOVING_WINDOW_INVALID", message: "moving_average requires a fixed window_size from 2 through 12." });
    }
  } else if (value.window_size !== void 0) {
    errors.push({ path: `${path7}.window_size`, code: "PROTECTED_TRANSFORM_WINDOW_FORBIDDEN", message: "only moving_average may declare a window_size." });
  }
  if (aggregate.comparison !== void 0) {
    errors.push({ path: path7, code: "PROTECTED_TRANSFORM_COMPARISON_FORBIDDEN", message: "post-suppression calculations cannot be combined with a two-period comparison." });
  }
  if (PROTECTED_SEQUENTIAL_AGGREGATE_SHAPES.has(String(value.shape))) {
    if (!isRecord3(aggregate.time_bucket)) {
      errors.push({ path: path7, code: "PROTECTED_TRANSFORM_TIME_BUCKET_REQUIRED", message: `${String(value.shape)} requires one reviewed ordered time bucket.` });
    } else if (aggregate.time_bucket.bucket === "day_of_week") {
      errors.push({ path: path7, code: "PROTECTED_TRANSFORM_TIME_BUCKET_UNORDERED", message: `${String(value.shape)} cannot use day_of_week because it is not a continuous calendar sequence.` });
    }
  } else {
    if (aggregate.time_bucket !== void 0) {
      errors.push({ path: path7, code: "PROTECTED_TRANSFORM_TIME_BUCKET_FORBIDDEN", message: `${String(value.shape)} operates across released dimension groups and cannot use a time bucket.` });
    }
    if (!Array.isArray(aggregate.dimensions) || aggregate.dimensions.length === 0) {
      errors.push({ path: path7, code: "PROTECTED_TRANSFORM_DIMENSION_REQUIRED", message: `${String(value.shape)} requires at least one reviewed dimension.` });
    }
  }
}
function validateProtectedDerivedOperand(value, path7, input, errors) {
  if (!isRecord3(value)) {
    errors.push({ path: path7, code: "PROTECTED_DERIVED_OPERAND_REQUIRED", message: "a derived operand must be a fixed reviewed aggregate." });
    return void 0;
  }
  checkUnknownKeys(value, PROTECTED_DERIVED_OPERAND_KEYS, path7, errors);
  if (!["count", "count_distinct", "sum", "avg"].includes(String(value.function))) {
    errors.push({ path: `${path7}.function`, code: "INVALID_PROTECTED_DERIVED_OPERAND", message: "derived operands permit only count, count_distinct, sum, or avg." });
  }
  validateProtectedRelationshipReference(value.relationship, input.relationshipNames, `${path7}.relationship`, errors);
  if (value.function === "count") {
    if (value.field !== void 0 || value.relationship !== void 0) {
      errors.push({ path: path7, code: "PROTECTED_DERIVED_COUNT_SHAPE_INVALID", message: "a derived COUNT operand counts scoped root rows and has no field or relationship." });
    }
  } else {
    validateProtectedFieldReference(value.field, value.relationship, input.relationshipNames, input.keptOut, input.trustedScopeFields, path7, errors);
  }
  return {
    function: String(value.function),
    ...typeof value.relationship === "string" ? { relationship: value.relationship } : {}
  };
}
function validateProtectedReadLimits(value, path7, errors) {
  if (!isRecord3(value)) {
    errors.push({ path: path7, code: "PROTECTED_READ_LIMITS_REQUIRED", message: "protected_read requires immutable execution, response, extraction, and differencing limits." });
    return;
  }
  checkUnknownKeys(value, PROTECTED_LIMIT_KEYS, path7, errors);
  const ceilings = {
    max_rows: 100,
    max_groups: 500,
    max_ranked_groups: 1e4,
    max_response_cells: 1e4,
    max_response_bytes: 1048576,
    statement_timeout_ms: 3e4,
    max_queries_per_session: 1e3,
    max_extracted_cells_per_session: 1e5,
    max_differencing_queries: 100,
    rate_limit_per_minute: 120
  };
  for (const [key2, maximum] of Object.entries(ceilings)) {
    if (key2 === "max_ranked_groups" && value[key2] === void 0)
      continue;
    if (!Number.isSafeInteger(value[key2]) || Number(value[key2]) < 1 || Number(value[key2]) > maximum) {
      errors.push({ path: `${path7}.${key2}`, code: "INVALID_PROTECTED_READ_LIMIT", message: `${key2} must be a positive integer no greater than ${maximum}.` });
    }
  }
  if (Number.isSafeInteger(value.max_ranked_groups) && Number.isSafeInteger(value.max_groups) && Number(value.max_ranked_groups) < Number(value.max_groups)) {
    errors.push({ path: `${path7}.max_ranked_groups`, code: "INVALID_PROTECTED_RANKED_GROUP_LIMIT", message: "max_ranked_groups cannot be lower than max_groups." });
  }
}
function validateProtectedValue(value, args, referencedArgs, path7, errors) {
  if (!isRecord3(value)) {
    errors.push({ path: path7, code: "PROTECTED_VALUE_REQUIRED", message: "protected value must be exactly one fixed literal or one reviewed argument reference." });
    return;
  }
  checkUnknownKeys(value, PROTECTED_VALUE_KEYS, path7, errors);
  const hasFixed = Object.prototype.hasOwnProperty.call(value, "fixed");
  const hasArg = Object.prototype.hasOwnProperty.call(value, "from_arg");
  if (hasFixed === hasArg) {
    errors.push({ path: path7, code: "PROTECTED_VALUE_EXACTLY_ONE_SOURCE", message: "protected value must declare exactly one of fixed or from_arg." });
    return;
  }
  if (hasFixed && !isJsonScalar(value.fixed))
    errors.push({ path: `${path7}.fixed`, code: "INVALID_PROTECTED_FIXED_VALUE", message: "fixed must be a JSON scalar." });
  if (hasArg) {
    const argument = isSafeIdentifier(value.from_arg) ? args[value.from_arg] : void 0;
    if (!isSafeIdentifier(value.from_arg) || !isRecord3(argument) || argument.type === "object_array") {
      errors.push({ path: `${path7}.from_arg`, code: "UNKNOWN_PROTECTED_VALUE_ARG", message: "from_arg must reference a declared scalar capability argument." });
    } else {
      referencedArgs.add(value.from_arg);
    }
  }
}
function validateProtectedFieldReference(field, relationship, relationshipNames, keptOut, trustedScopeFields, path7, errors) {
  if (!isSafeIdentifier(field)) {
    errors.push({ path: `${path7}.field`, code: "INVALID_PROTECTED_FIELD", message: "protected field must be a fixed safe identifier." });
  } else if (relationship === void 0 && (keptOut.has(field) || trustedScopeFields.has(field))) {
    errors.push({ path: `${path7}.field`, code: "PROTECTED_FIELD_FORBIDDEN", message: "kept-out and trusted-scope fields cannot be selected, filtered, grouped, sorted, joined, aggregated, or counted distinctly." });
  }
  validateProtectedRelationshipReference(relationship, relationshipNames, `${path7}.relationship`, errors);
}
function validateProtectedRelationshipReference(value, relationshipNames, path7, errors) {
  if (value === void 0)
    return;
  if (!isSafeIdentifier(value) || !relationshipNames.has(value)) {
    errors.push({ path: path7, code: "UNKNOWN_PROTECTED_RELATIONSHIP", message: "relationship must reference one of the capability's reviewed many-to-one paths." });
  }
}
function validateUniqueIdentifier(value, seen, path7, code, errors) {
  if (!isSafeIdentifier(value)) {
    errors.push({ path: path7, code: "INVALID_PROTECTED_ALIAS", message: "reviewed aliases must be safe identifiers." });
    return;
  }
  if (seen.has(value))
    errors.push({ path: path7, code, message: `Duplicate reviewed alias: ${value}.` });
  seen.add(value);
}
function validateAggregateRead(capability, path7, errors) {
  const aggregate = capability.aggregate;
  if (!isRecord3(aggregate)) {
    errors.push({ path: `${path7}.aggregate`, code: "AGGREGATE_READ_REQUIRED", message: "aggregate_read requires an aggregate definition." });
    return;
  }
  checkUnknownKeys(aggregate, AGGREGATE_READ_KEYS, `${path7}.aggregate`, errors);
  const fn = String(aggregate.function);
  if (!["count", "sum", "avg"].includes(fn))
    errors.push({ path: `${path7}.aggregate.function`, code: "INVALID_AGGREGATE_FUNCTION", message: "aggregate function must be count, sum, or avg." });
  if (!Number.isSafeInteger(aggregate.minimum_group_size) || Number(aggregate.minimum_group_size) < 1 || Number(aggregate.minimum_group_size) > 1e6) {
    errors.push({ path: `${path7}.aggregate.minimum_group_size`, code: "AGGREGATE_MINIMUM_GROUP_SIZE_REQUIRED", message: "aggregate reads require minimum_group_size from 1 through 1000000." });
  }
  if (fn === "count") {
    if (aggregate.count_mode !== "rows" && aggregate.count_mode !== "non_null")
      errors.push({ path: `${path7}.aggregate.count_mode`, code: "COUNT_MODE_REQUIRED", message: "COUNT requires count_mode rows or non_null." });
    if (aggregate.count_mode === "rows" && aggregate.column !== void 0)
      errors.push({ path: `${path7}.aggregate.column`, code: "COUNT_ROWS_COLUMN_FORBIDDEN", message: "COUNT rows must not declare a column." });
    if (aggregate.count_mode === "non_null" && !isSafeIdentifier(aggregate.column))
      errors.push({ path: `${path7}.aggregate.column`, code: "COUNT_COLUMN_REQUIRED", message: "COUNT non_null requires a fixed column." });
  } else {
    if (!isSafeIdentifier(aggregate.column))
      errors.push({ path: `${path7}.aggregate.column`, code: "AGGREGATE_NUMERIC_COLUMN_REQUIRED", message: "SUM/AVG require a fixed reviewed numeric column." });
    if (aggregate.count_mode !== void 0)
      errors.push({ path: `${path7}.aggregate.count_mode`, code: "COUNT_MODE_COUNT_ONLY", message: "count_mode is valid only for COUNT." });
  }
  if (aggregate.selection !== void 0)
    validateFixedSelection(aggregate.selection, `${path7}.aggregate.selection`, errors);
  if (isRecord3(capability.args) && Object.keys(capability.args).length > 0)
    errors.push({ path: `${path7}.args`, code: "AGGREGATE_MODEL_ARGS_FORBIDDEN", message: "the first aggregate-read release permits no model-controlled predicate arguments." });
  if (capability.lookup !== void 0)
    errors.push({ path: `${path7}.lookup`, code: "AGGREGATE_LOOKUP_FORBIDDEN", message: "aggregate reads use only trusted scope and contract-fixed selection." });
  if (Array.isArray(capability.visible_fields) && capability.visible_fields.length > 0)
    errors.push({ path: `${path7}.visible_fields`, code: "AGGREGATE_VISIBLE_ROWS_FORBIDDEN", message: "aggregate reads return no source row fields." });
  if (!isRecord3(capability.evidence) || capability.evidence.required !== true || capability.evidence.query_audit !== true)
    errors.push({ path: `${path7}.evidence`, code: "AGGREGATE_EVIDENCE_REQUIRED", message: "aggregate reads require evidence and query audit." });
}
function validateFixedSelection(value, path7, errors) {
  if (!isRecord3(value)) {
    errors.push({ path: path7, code: "FIXED_SELECTION_REQUIRED", message: "selection must be a reviewed object." });
    return;
  }
  checkUnknownKeys(value, SELECTION_KEYS, path7, errors);
  if (!Array.isArray(value.all) || value.all.length < 1 || value.all.length > 8) {
    errors.push({ path: `${path7}.all`, code: "INVALID_FIXED_SELECTION", message: "selection.all must contain 1 through 8 fixed equality terms." });
    return;
  }
  value.all.forEach((term, index) => {
    const termPath = `${path7}.all[${index}]`;
    if (!isRecord3(term)) {
      errors.push({ path: termPath, code: "PREDICATE_TERM_NOT_OBJECT", message: "predicate term must be an object." });
      return;
    }
    checkUnknownKeys(term, PREDICATE_TERM_KEYS, termPath, errors);
    if (!isSafeIdentifier(term.column))
      errors.push({ path: `${termPath}.column`, code: "INVALID_PREDICATE_COLUMN", message: "predicate column must be a fixed safe identifier." });
    if (term.operator !== "eq")
      errors.push({ path: `${termPath}.operator`, code: "INVALID_PREDICATE_OPERATOR", message: "only literal equality predicates are supported." });
    if (!("value" in term) || !isJsonScalar(term.value))
      errors.push({ path: `${termPath}.value`, code: "FIXED_PREDICATE_VALUE_REQUIRED", message: "predicate value must be a contract literal." });
  });
}
function validateLookup(value, path7, args, errors) {
  if (!isRecord3(value)) {
    errors.push({ path: path7, code: "LOOKUP_NOT_OBJECT", message: "lookup must be an object." });
    return;
  }
  checkUnknownKeys(value, LOOKUP_KEYS, path7, errors);
  if (!isSafeIdentifier(value.id_from_arg) || !isRecord3(args) || !Object.prototype.hasOwnProperty.call(args, String(value.id_from_arg))) {
    errors.push({ path: `${path7}.id_from_arg`, code: "UNKNOWN_LOOKUP_ARG", message: "lookup.id_from_arg must reference a model-facing arg." });
  }
}
function validateEvidenceRequirement(value, path7, errors) {
  if (!isRecord3(value)) {
    errors.push({ path: path7, code: "EVIDENCE_NOT_OBJECT", message: "evidence must be an object." });
    return;
  }
  checkUnknownKeys(value, EVIDENCE_KEYS, path7, errors);
  if (typeof value.required !== "boolean")
    errors.push({ path: `${path7}.required`, code: "INVALID_EVIDENCE_REQUIRED", message: "evidence.required must be boolean." });
  if (value.sources !== void 0 && (!Array.isArray(value.sources) || value.sources.some((source) => !isNonEmptyString(source))))
    errors.push({ path: `${path7}.sources`, code: "INVALID_EVIDENCE_SOURCES", message: "evidence.sources must be non-empty strings." });
}
function validateProposalAction(value, subject, path7, errors) {
  if (!isRecord3(value)) {
    errors.push({ path: path7, code: "PROPOSAL_REQUIRED", message: "proposal capabilities must define proposal action semantics." });
    return;
  }
  checkUnknownKeys(value, PROPOSAL_KEYS, path7, errors);
  if (!isQualifiedOrSafeName(value.action))
    errors.push({ path: `${path7}.action`, code: "INVALID_PROPOSAL_ACTION", message: "proposal.action must be a safe action name." });
  const organizationScoped = validateProtectedOrganizationScope(value.organization_scope, `${path7}.organization_scope`, errors);
  if (organizationScoped && isRecord3(subject)) {
    if (isSafeIdentifier(subject.tenant_key)) {
      errors.push({
        path: `${path7}.organization_scope`,
        code: "PROPOSAL_SCOPE_MODES_CONFLICT",
        message: "a proposal must use either a reviewed tenant column or one reviewed organization, never both."
      });
    }
    if (subject.single_tenant_dev === true) {
      errors.push({
        path: `${path7}.organization_scope`,
        code: "PROPOSAL_SCOPE_MODES_CONFLICT",
        message: "reviewed single-organization authority cannot be combined with single_tenant_dev."
      });
    }
  }
  const operation = validateProposalOperation(value.operation, subject, value.patch, value.conflict_guard, `${path7}.operation`, errors);
  const deleteOperation = operation === "delete";
  validateFieldList(value.allowed_fields, `${path7}.allowed_fields`, "ALLOWED_FIELDS_REQUIRED", errors, deleteOperation);
  if (!isRecord3(value.patch) || !deleteOperation && Object.keys(value.patch).length === 0) {
    errors.push({ path: `${path7}.patch`, code: "PATCH_REQUIRED", message: "UPDATE and INSERT proposals must map allowed fields to fixed or arg values." });
  } else if (deleteOperation && Object.keys(value.patch).length > 0) {
    errors.push({ path: `${path7}.patch`, code: "DELETE_PATCH_FORBIDDEN", message: "DELETE proposals must not contain a model-generated patch." });
  } else {
    for (const [field, patch] of Object.entries(value.patch)) {
      const patchPath = `${path7}.patch.${field}`;
      if (!isSafeIdentifier(field))
        errors.push({ path: patchPath, code: "INVALID_PATCH_FIELD", message: "patch field must be a safe identifier." });
      if (Array.isArray(value.allowed_fields) && !value.allowed_fields.includes(field))
        errors.push({ path: patchPath, code: "PATCH_FIELD_NOT_ALLOWED", message: "patch field must be listed in allowed_fields." });
      if (!isRecord3(patch)) {
        errors.push({ path: patchPath, code: "PATCH_BINDING_NOT_OBJECT", message: "patch binding must be an object." });
        continue;
      }
      checkUnknownKeys(patch, PATCH_KEYS, patchPath, errors);
      const bindingCount = [patch.fixed !== void 0, isSafeIdentifier(patch.from_arg), isSafeIdentifier(patch.from_item)].filter(Boolean).length;
      if (bindingCount !== 1)
        errors.push({ path: patchPath, code: "PATCH_BINDING_REQUIRED", message: "patch binding must include exactly one of fixed, from_arg, or from_item." });
    }
  }
  validateNumericBounds(value.numeric_bounds, value.patch, `${path7}.numeric_bounds`, errors);
  validateTransitionGuards(value.transition_guards, value.patch, `${path7}.transition_guards`, errors);
  if (value.reversibility !== void 0) {
    if (!isRecord3(value.reversibility)) {
      errors.push({ path: `${path7}.reversibility`, code: "REVERSIBILITY_NOT_OBJECT", message: "reversibility must be an object." });
    } else {
      checkUnknownKeys(value.reversibility, REVERSIBILITY_KEYS, `${path7}.reversibility`, errors);
      if (value.reversibility.mode !== "reviewed_inverse") {
        errors.push({ path: `${path7}.reversibility.mode`, code: "INVALID_REVERSIBILITY_MODE", message: "reversibility.mode must be reviewed_inverse." });
      }
    }
  }
  if (value.conflict_guard !== void 0) {
    if (!isRecord3(value.conflict_guard))
      errors.push({ path: `${path7}.conflict_guard`, code: "CONFLICT_GUARD_NOT_OBJECT", message: "conflict_guard must be an object." });
    else {
      checkUnknownKeys(value.conflict_guard, CONFLICT_GUARD_KEYS, `${path7}.conflict_guard`, errors);
      if (value.conflict_guard.column !== void 0 && !isSafeIdentifier(value.conflict_guard.column))
        errors.push({ path: `${path7}.conflict_guard.column`, code: "INVALID_CONFLICT_COLUMN", message: "conflict_guard.column must be a safe identifier." });
      if (value.conflict_guard.column === void 0 && value.conflict_guard.weak_guard_ack !== true)
        errors.push({ path: `${path7}.conflict_guard`, code: "CONFLICT_GUARD_REQUIRED", message: "proposal needs conflict_guard.column unless weak_guard_ack is explicit." });
    }
  }
  if (value.approval !== void 0) {
    validateNestedObject(value.approval, APPROVAL_KEYS, `${path7}.approval`, errors);
    if (isRecord3(value.approval) && value.approval.mode !== void 0 && !["human", "operator", "policy"].includes(String(value.approval.mode))) {
      errors.push({ path: `${path7}.approval.mode`, code: "INVALID_APPROVAL_MODE", message: "approval.mode must be human, operator, or policy." });
    }
    if (isRecord3(value.approval) && value.approval.required_approvals !== void 0 && (!Number.isSafeInteger(value.approval.required_approvals) || Number(value.approval.required_approvals) < 1 || Number(value.approval.required_approvals) > 10)) {
      errors.push({
        path: `${path7}.approval.required_approvals`,
        code: "INVALID_REQUIRED_APPROVALS",
        message: "approval.required_approvals must be a safe integer from 1 through 10."
      });
    }
  }
  if (value.execution !== void 0) {
    validateNestedObject(value.execution, EXECUTION_KEYS, `${path7}.execution`, errors);
    if (isRecord3(value.execution) && value.execution.supervised_worker !== "allowed") {
      errors.push({
        path: `${path7}.execution.supervised_worker`,
        code: "INVALID_SUPERVISED_WORKER_PERMISSION",
        message: "execution.supervised_worker must be allowed when the optional permission is present."
      });
    }
    if (isRecord3(value.execution) && value.execution.supervised_worker === "allowed") {
      const cardinality = isRecord3(value.operation) ? value.operation.cardinality ?? "single" : "single";
      const writebackMode = isRecord3(value.writeback) ? value.writeback.mode : "direct_sql";
      if (writebackMode !== "direct_sql") {
        errors.push({
          path: `${path7}.writeback.mode`,
          code: "SUPERVISED_WORKER_DIRECT_SQL_REQUIRED",
          message: "supervised-worker execution is initially limited to Runner-owned direct_sql writeback."
        });
      }
      if (cardinality !== "single") {
        errors.push({
          path: `${path7}.operation.cardinality`,
          code: "SUPERVISED_WORKER_SINGLE_ROW_REQUIRED",
          message: "supervised-worker execution is initially limited to deterministic single-row writes."
        });
      }
      if (deleteOperation) {
        errors.push({
          path: `${path7}.operation.kind`,
          code: "SUPERVISED_WORKER_DELETE_FORBIDDEN",
          message: "hard DELETE is not eligible for supervised-worker execution in this release."
        });
      }
      if (value.reversibility !== void 0) {
        errors.push({
          path: `${path7}.reversibility`,
          code: "SUPERVISED_WORKER_REVERSIBILITY_FORBIDDEN",
          message: "reviewed compensation actions require manual execution in this release."
        });
      }
      if (operation === "update" && (!isRecord3(value.conflict_guard) || !isSafeIdentifier(value.conflict_guard.column) || value.conflict_guard.weak_guard_ack === true)) {
        errors.push({
          path: `${path7}.conflict_guard.column`,
          code: "SUPERVISED_WORKER_EXACT_CONFLICT_GUARD_REQUIRED",
          message: "supervised-worker UPDATE requires an exact source version/conflict column; a weak row hash is not eligible."
        });
      }
    }
  }
  if (value.writeback !== void 0) {
    validateNestedObject(value.writeback, WRITEBACK_KEYS, `${path7}.writeback`, errors);
    if (isRecord3(value.writeback) && !["direct_sql", "app_handler", "cloud_worker", "none"].includes(String(value.writeback.mode)))
      errors.push({ path: `${path7}.writeback.mode`, code: "INVALID_WRITEBACK_MODE", message: "writeback.mode must be direct_sql, app_handler, cloud_worker, or none." });
  }
  if (organizationScoped) {
    const writebackMode = isRecord3(value.writeback) ? value.writeback.mode : "direct_sql";
    if (writebackMode !== "none") {
      errors.push({
        path: `${path7}.writeback.mode`,
        code: "PROPOSAL_ORGANIZATION_WRITEBACK_UNSUPPORTED",
        message: "reviewed single-organization proposal authority is proposal-only in this release; executable writeback still requires a direct reviewed tenant column."
      });
    }
    if (value.execution !== void 0) {
      errors.push({
        path: `${path7}.execution`,
        code: "PROPOSAL_ORGANIZATION_EXECUTION_UNSUPPORTED",
        message: "reviewed single-organization proposal authority cannot grant supervised execution in this release."
      });
    }
    if (operation === "insert") {
      errors.push({
        path: `${path7}.operation.kind`,
        code: "PROPOSAL_ORGANIZATION_INSERT_UNSUPPORTED",
        message: "reviewed single-organization proposal authority currently supports UPDATE and DELETE proposals; INSERT still requires source-enforced tenant deduplication."
      });
    }
  }
  if (deleteOperation && isRecord3(value.writeback) && value.writeback.mode === "direct_sql") {
    const approvalMode = isRecord3(value.approval) ? value.approval.mode : void 0;
    if (approvalMode !== "human" && approvalMode !== "operator") {
      errors.push({ path: `${path7}.approval.mode`, code: "HARD_DELETE_HUMAN_APPROVAL_REQUIRED", message: "Direct hard DELETE must require human/operator approval and cannot use policy auto-approval." });
    }
  }
  if (isRecord3(value.operation) && value.operation.cardinality === "set") {
    const approvalMode = isRecord3(value.approval) ? value.approval.mode : void 0;
    if (approvalMode !== "human" && approvalMode !== "operator")
      errors.push({ path: `${path7}.approval.mode`, code: "SET_WRITE_HUMAN_APPROVAL_REQUIRED", message: "bounded set writes require human/operator approval in the first release." });
    if (!isRecord3(value.writeback) || value.writeback.mode !== "direct_sql")
      errors.push({ path: `${path7}.writeback.mode`, code: "SET_WRITE_DIRECT_SQL_REQUIRED", message: "bounded set writes require Runner-owned direct_sql writeback." });
    if (value.operation.kind === "update" && (!isRecord3(value.operation.version_advance) || value.operation.version_advance.strategy !== "integer_increment"))
      errors.push({ path: `${path7}.operation.version_advance`, code: "SET_INTEGER_VERSION_REQUIRED", message: "bounded set UPDATE requires integer_increment version advancement." });
  }
  if (isRecord3(value.reversibility) && value.reversibility.mode === "reviewed_inverse") {
    const writebackMode = isRecord3(value.writeback) ? value.writeback.mode : void 0;
    const approvalMode = isRecord3(value.approval) ? value.approval.mode : void 0;
    if (writebackMode !== "direct_sql") {
      errors.push({ path: `${path7}.writeback.mode`, code: "REVERSIBILITY_DIRECT_SQL_REQUIRED", message: "reviewed inverse capture is supported only for Runner-owned direct_sql writeback." });
    }
    if (approvalMode !== "human" && approvalMode !== "operator") {
      errors.push({ path: `${path7}.approval.mode`, code: "REVERSIBILITY_HUMAN_APPROVAL_REQUIRED", message: "reversible writes require human/operator approval; policy auto-approval is not allowed." });
    }
    if (operation === "update") {
      if (!isRecord3(value.conflict_guard) || !isSafeIdentifier(value.conflict_guard.column)) {
        errors.push({ path: `${path7}.conflict_guard.column`, code: "REVERSIBILITY_CONFLICT_GUARD_REQUIRED", message: "reversible UPDATE requires an exact conflict_guard.column." });
      }
      if (!isRecord3(value.operation) || !isRecord3(value.operation.version_advance) || value.operation.version_advance.strategy !== "integer_increment") {
        errors.push({ path: `${path7}.operation.version_advance`, code: "REVERSIBILITY_INTEGER_VERSION_REQUIRED", message: "reversible UPDATE requires integer_increment version advancement so compensation advances rather than rewinds concurrency state." });
      }
    }
    if (operation === "insert" && isRecord3(subject)) {
      const primaryKey = subject.primary_key;
      const components = isRecord3(value.operation) && isRecord3(value.operation.deduplication) && Array.isArray(value.operation.deduplication.components) ? value.operation.deduplication.components : [];
      if (!isSafeIdentifier(primaryKey) || !components.some((component) => isRecord3(component) && component.column === primaryKey)) {
        errors.push({ path: `${path7}.operation.deduplication.components`, code: "REVERSIBILITY_PRIMARY_KEY_DEDUP_REQUIRED", message: "reversible INSERT requires a deterministic primary-key component in its reviewed deduplication key." });
      }
    }
  }
}
function validateProposalOperation(value, subject, patch, conflictGuard, path7, errors) {
  if (value === void 0)
    return "update";
  if (!isRecord3(value)) {
    errors.push({ path: path7, code: "OPERATION_NOT_OBJECT", message: "proposal.operation must be an object." });
    return "update";
  }
  checkUnknownKeys(value, OPERATION_KEYS, path7, errors);
  const kind = value.kind;
  if (kind !== "update" && kind !== "insert" && kind !== "delete") {
    errors.push({ path: `${path7}.kind`, code: "INVALID_OPERATION_KIND", message: "operation.kind must be update, insert, or delete." });
    return "update";
  }
  const cardinality = value.cardinality ?? "single";
  if (cardinality !== "single" && cardinality !== "set") {
    errors.push({ path: `${path7}.cardinality`, code: "INVALID_OPERATION_CARDINALITY", message: "operation.cardinality must be single or set." });
  }
  if (cardinality === "set") {
    validateSetOperation(value, kind, path7, errors);
  } else {
    for (const key2 of ["selection", "max_rows", "aggregate_bounds", "batch"]) {
      if (value[key2] !== void 0)
        errors.push({ path: `${path7}.${key2}`, code: "SET_FIELD_REQUIRES_SET_CARDINALITY", message: `${key2} requires operation.cardinality set.` });
    }
  }
  if (value.version_advance !== void 0) {
    if (!isRecord3(value.version_advance)) {
      errors.push({ path: `${path7}.version_advance`, code: "VERSION_ADVANCE_NOT_OBJECT", message: "version_advance must be an object." });
    } else {
      checkUnknownKeys(value.version_advance, VERSION_ADVANCE_KEYS, `${path7}.version_advance`, errors);
      if (!isSafeIdentifier(value.version_advance.column))
        errors.push({ path: `${path7}.version_advance.column`, code: "INVALID_VERSION_ADVANCE_COLUMN", message: "version_advance.column must be a fixed safe identifier." });
      if (value.version_advance.strategy !== "integer_increment" && value.version_advance.strategy !== "database_generated")
        errors.push({ path: `${path7}.version_advance.strategy`, code: "INVALID_VERSION_ADVANCE_STRATEGY", message: "version_advance.strategy must be integer_increment or database_generated." });
      const conflictColumn = isRecord3(conflictGuard) ? conflictGuard.column : void 0;
      if (isSafeIdentifier(value.version_advance.column) && value.version_advance.column !== conflictColumn)
        errors.push({ path: `${path7}.version_advance.column`, code: "VERSION_ADVANCE_GUARD_MISMATCH", message: "version_advance.column must match conflict_guard.column." });
    }
    if (kind !== "update")
      errors.push({ path: `${path7}.version_advance`, code: "VERSION_ADVANCE_UPDATE_ONLY", message: "version_advance is valid only for UPDATE." });
  }
  if (kind === "insert") {
    validateDeduplication(value.deduplication, subject, patch, `${path7}.deduplication`, errors, cardinality === "set");
  } else if (value.deduplication !== void 0) {
    errors.push({ path: `${path7}.deduplication`, code: "DEDUPLICATION_INSERT_ONLY", message: "deduplication is valid only for INSERT." });
  }
  if (kind === "delete") {
    if (!isRecord3(conflictGuard) || !isSafeIdentifier(conflictGuard.column))
      errors.push({ path: `${path7.replace(/\.operation$/, "")}.conflict_guard.column`, code: "DELETE_CONFLICT_GUARD_REQUIRED", message: "DELETE requires an exact conflict_guard.column." });
  }
  return kind;
}
function validateSetOperation(value, kind, path7, errors) {
  if (!Number.isSafeInteger(value.max_rows) || Number(value.max_rows) < 1 || Number(value.max_rows) > SET_MAX_ROWS_HARD_CEILING) {
    errors.push({ path: `${path7}.max_rows`, code: "SET_MAX_ROWS_REQUIRED", message: `bounded set writes require max_rows from 1 through ${SET_MAX_ROWS_HARD_CEILING}.` });
  }
  if (!Array.isArray(value.aggregate_bounds) || value.aggregate_bounds.length === 0 || value.aggregate_bounds.length > 8) {
    errors.push({ path: `${path7}.aggregate_bounds`, code: "SET_AGGREGATE_BOUND_REQUIRED", message: "bounded set writes require 1 through 8 aggregate value bounds." });
  } else {
    value.aggregate_bounds.forEach((bound, index) => {
      const boundPath = `${path7}.aggregate_bounds[${index}]`;
      if (!isRecord3(bound)) {
        errors.push({ path: boundPath, code: "AGGREGATE_BOUND_NOT_OBJECT", message: "aggregate bound must be an object." });
        return;
      }
      checkUnknownKeys(bound, AGGREGATE_BOUND_KEYS, boundPath, errors);
      if (!isSafeIdentifier(bound.column))
        errors.push({ path: `${boundPath}.column`, code: "INVALID_AGGREGATE_BOUND_COLUMN", message: "aggregate bound column must be a fixed safe identifier." });
      if (!["before", "after", "absolute_delta"].includes(String(bound.measure)))
        errors.push({ path: `${boundPath}.measure`, code: "INVALID_AGGREGATE_BOUND_MEASURE", message: "aggregate bound measure must be before, after, or absolute_delta." });
      if (!isFiniteNumber(bound.maximum) || Number(bound.maximum) < 0)
        errors.push({ path: `${boundPath}.maximum`, code: "INVALID_AGGREGATE_BOUND_MAXIMUM", message: "aggregate bound maximum must be a finite non-negative number." });
    });
  }
  if (kind === "insert") {
    if (value.selection !== void 0)
      errors.push({ path: `${path7}.selection`, code: "BATCH_INSERT_SELECTION_FORBIDDEN", message: "batch INSERT reviews explicit items and cannot use a selection predicate." });
    if (!isRecord3(value.batch))
      errors.push({ path: `${path7}.batch`, code: "BATCH_INSERT_ITEMS_REQUIRED", message: "batch INSERT requires batch.items_from_arg." });
    else {
      checkUnknownKeys(value.batch, BATCH_KEYS, `${path7}.batch`, errors);
      if (!isSafeIdentifier(value.batch.items_from_arg))
        errors.push({ path: `${path7}.batch.items_from_arg`, code: "INVALID_BATCH_ITEMS_ARG", message: "batch.items_from_arg must be a fixed argument name." });
    }
    return;
  }
  if (value.batch !== void 0)
    errors.push({ path: `${path7}.batch`, code: "BATCH_INSERT_ONLY", message: "batch is valid only for set INSERT." });
  if (!isRecord3(value.selection)) {
    errors.push({ path: `${path7}.selection`, code: "SET_FIXED_SELECTION_REQUIRED", message: "set UPDATE/DELETE requires a contract-fixed typed selection." });
    return;
  }
  checkUnknownKeys(value.selection, SELECTION_KEYS, `${path7}.selection`, errors);
  if (!Array.isArray(value.selection.all) || value.selection.all.length === 0 || value.selection.all.length > 8) {
    errors.push({ path: `${path7}.selection.all`, code: "INVALID_FIXED_SELECTION", message: "selection.all must contain 1 through 8 fixed predicate terms." });
    return;
  }
  value.selection.all.forEach((term, index) => {
    const termPath = `${path7}.selection.all[${index}]`;
    if (!isRecord3(term)) {
      errors.push({ path: termPath, code: "PREDICATE_TERM_NOT_OBJECT", message: "predicate term must be an object." });
      return;
    }
    checkUnknownKeys(term, PREDICATE_TERM_KEYS, termPath, errors);
    if (!isSafeIdentifier(term.column))
      errors.push({ path: `${termPath}.column`, code: "INVALID_PREDICATE_COLUMN", message: "predicate column must be a fixed safe identifier." });
    if (term.operator !== "eq")
      errors.push({ path: `${termPath}.operator`, code: "INVALID_PREDICATE_OPERATOR", message: "the first bounded-set release supports only literal equality predicates." });
    if (!("value" in term) || !isJsonScalar(term.value))
      errors.push({ path: `${termPath}.value`, code: "FIXED_PREDICATE_VALUE_REQUIRED", message: "predicate value must be a contract literal." });
  });
}
function validateDeduplication(value, subject, patch, path7, errors, batch = false) {
  if (!isRecord3(value)) {
    errors.push({ path: path7, code: "INSERT_DEDUPLICATION_REQUIRED", message: "INSERT requires source-enforced deduplication components." });
    return;
  }
  checkUnknownKeys(value, DEDUPLICATION_KEYS, path7, errors);
  if (!Array.isArray(value.components) || value.components.length === 0 || value.components.length > 8) {
    errors.push({ path: `${path7}.components`, code: "INVALID_DEDUPLICATION_COMPONENTS", message: "deduplication.components must contain 1 through 8 fixed components." });
    return;
  }
  const seen = /* @__PURE__ */ new Set();
  let hasProposalId = false;
  let hasItemField = false;
  let hasTrustedTenant = false;
  const patchFields = isRecord3(patch) ? new Set(Object.keys(patch)) : /* @__PURE__ */ new Set();
  const tenantKey = isRecord3(subject) ? subject.tenant_key : void 0;
  value.components.forEach((component, index) => {
    const componentPath = `${path7}.components[${index}]`;
    if (!isRecord3(component)) {
      errors.push({ path: componentPath, code: "DEDUPLICATION_COMPONENT_NOT_OBJECT", message: "deduplication component must be an object." });
      return;
    }
    checkUnknownKeys(component, DEDUPLICATION_COMPONENT_KEYS, componentPath, errors);
    if (!isSafeIdentifier(component.column))
      errors.push({ path: `${componentPath}.column`, code: "INVALID_DEDUPLICATION_COLUMN", message: "deduplication column must be a fixed safe identifier." });
    else if (seen.has(component.column))
      errors.push({ path: `${componentPath}.column`, code: "DUPLICATE_DEDUPLICATION_COLUMN", message: "deduplication columns must be unique." });
    else
      seen.add(component.column);
    if (patchFields.has(String(component.column)))
      errors.push({ path: `${componentPath}.column`, code: "DEDUPLICATION_COLUMN_MODEL_CONTROLLED", message: "deduplication columns are Runner-supplied and must not also be patch fields." });
    if (component.source !== "proposal_id" && component.source !== "trusted_tenant" && component.source !== "fixed" && component.source !== "item_field")
      errors.push({ path: `${componentPath}.source`, code: "INVALID_DEDUPLICATION_SOURCE", message: "deduplication source must be proposal_id, trusted_tenant, fixed, or item_field." });
    if (component.source === "proposal_id")
      hasProposalId = true;
    if (component.source === "item_field") {
      hasItemField = true;
      if (!isSafeIdentifier(component.item_field))
        errors.push({ path: `${componentPath}.item_field`, code: "DEDUPLICATION_ITEM_FIELD_REQUIRED", message: "item_field deduplication requires a fixed item field name." });
    }
    if (component.source === "trusted_tenant") {
      if (isSafeIdentifier(tenantKey) && component.column === tenantKey)
        hasTrustedTenant = true;
      else
        errors.push({ path: `${componentPath}.column`, code: "DEDUPLICATION_TENANT_MISMATCH", message: "trusted_tenant deduplication must map to subject.tenant_key." });
    }
    if (component.source === "fixed" && component.fixed === void 0)
      errors.push({ path: `${componentPath}.fixed`, code: "DEDUPLICATION_FIXED_VALUE_REQUIRED", message: "fixed deduplication components require fixed." });
    if (component.source !== "fixed" && component.fixed !== void 0)
      errors.push({ path: `${componentPath}.fixed`, code: "DEDUPLICATION_FIXED_VALUE_FORBIDDEN", message: "fixed is valid only when source is fixed." });
    if (component.source !== "item_field" && component.item_field !== void 0)
      errors.push({ path: `${componentPath}.item_field`, code: "DEDUPLICATION_ITEM_FIELD_FORBIDDEN", message: "item_field is valid only when source is item_field." });
  });
  if (batch ? !hasItemField : !hasProposalId)
    errors.push({ path: `${path7}.components`, code: batch ? "ITEM_DEDUPLICATION_REQUIRED" : "PROPOSAL_DEDUPLICATION_REQUIRED", message: batch ? "batch INSERT deduplication must include a source-unique item_field component." : "INSERT deduplication must include a proposal_id component so retries are source-identifiable." });
  if (!hasTrustedTenant)
    errors.push({ path: `${path7}.components`, code: "TRUSTED_TENANT_DEDUPLICATION_REQUIRED", message: "INSERT deduplication must include subject.tenant_key from trusted_tenant so retries cannot cross tenant scope." });
}
function validateNumericBounds(value, patch, path7, errors) {
  if (value === void 0)
    return;
  if (!isRecord3(value)) {
    errors.push({ path: path7, code: "NUMERIC_BOUNDS_NOT_OBJECT", message: "numeric_bounds must map patch fields to numeric bounds." });
    return;
  }
  const patchFields = isRecord3(patch) ? new Set(Object.keys(patch)) : /* @__PURE__ */ new Set();
  for (const [field, bounds] of Object.entries(value)) {
    const boundPath = `${path7}.${field}`;
    if (!isSafeIdentifier(field))
      errors.push({ path: boundPath, code: "INVALID_NUMERIC_BOUND_FIELD", message: "numeric_bounds keys must be safe patch fields." });
    if (!patchFields.has(field))
      errors.push({ path: boundPath, code: "NUMERIC_BOUND_PATCH_FIELD_REQUIRED", message: "numeric_bounds can only constrain fields in proposal.patch." });
    if (!isRecord3(bounds)) {
      errors.push({ path: boundPath, code: "NUMERIC_BOUND_NOT_OBJECT", message: "numeric bound must be an object." });
      continue;
    }
    checkUnknownKeys(bounds, NUMERIC_BOUND_KEYS, boundPath, errors);
    const hasMinimum = bounds.minimum !== void 0;
    const hasMaximum = bounds.maximum !== void 0;
    if (!hasMinimum && !hasMaximum)
      errors.push({ path: boundPath, code: "NUMERIC_BOUND_EMPTY", message: "numeric bound must define minimum, maximum, or both." });
    if (hasMinimum && !isFiniteNumber(bounds.minimum))
      errors.push({ path: `${boundPath}.minimum`, code: "INVALID_MINIMUM", message: "minimum must be a finite number." });
    if (hasMaximum && !isFiniteNumber(bounds.maximum))
      errors.push({ path: `${boundPath}.maximum`, code: "INVALID_MAXIMUM", message: "maximum must be a finite number." });
    if (isFiniteNumber(bounds.minimum) && isFiniteNumber(bounds.maximum) && Number(bounds.minimum) > Number(bounds.maximum)) {
      errors.push({ path: boundPath, code: "INVALID_NUMERIC_RANGE", message: "minimum must be less than or equal to maximum." });
    }
  }
}
function validateTransitionGuards(value, patch, path7, errors) {
  if (value === void 0)
    return;
  if (!isRecord3(value)) {
    errors.push({ path: path7, code: "TRANSITION_GUARDS_NOT_OBJECT", message: "transition_guards must map patch fields to allowed state transitions." });
    return;
  }
  const patchFields = isRecord3(patch) ? new Set(Object.keys(patch)) : /* @__PURE__ */ new Set();
  for (const [field, guard] of Object.entries(value)) {
    const guardPath = `${path7}.${field}`;
    if (!isSafeIdentifier(field))
      errors.push({ path: guardPath, code: "INVALID_TRANSITION_GUARD_FIELD", message: "transition_guards keys must be safe patch fields." });
    if (!patchFields.has(field))
      errors.push({ path: guardPath, code: "TRANSITION_GUARD_PATCH_FIELD_REQUIRED", message: "transition_guards can only constrain fields in proposal.patch." });
    if (!isRecord3(guard)) {
      errors.push({ path: guardPath, code: "TRANSITION_GUARD_NOT_OBJECT", message: "transition guard must be an object." });
      continue;
    }
    checkUnknownKeys(guard, TRANSITION_GUARD_KEYS, guardPath, errors);
    if (guard.from_column !== void 0 && !isSafeIdentifier(guard.from_column)) {
      errors.push({ path: `${guardPath}.from_column`, code: "INVALID_TRANSITION_FROM_COLUMN", message: "from_column must be a safe identifier." });
    }
    if (!isRecord3(guard.allowed) || Object.keys(guard.allowed).length === 0) {
      errors.push({ path: `${guardPath}.allowed`, code: "TRANSITION_ALLOWED_REQUIRED", message: "transition guard must define allowed transitions." });
      continue;
    }
    for (const [from, toValues] of Object.entries(guard.allowed)) {
      const allowedPath = `${guardPath}.allowed.${from}`;
      if (!isNonEmptyString(from))
        errors.push({ path: allowedPath, code: "TRANSITION_FROM_REQUIRED", message: "transition source state must be a non-empty string." });
      if (!Array.isArray(toValues) || toValues.length === 0 || toValues.some((item) => !isNonEmptyString(item))) {
        errors.push({ path: allowedPath, code: "TRANSITION_TO_VALUES_REQUIRED", message: "transition target states must be non-empty strings." });
      }
    }
  }
}
function validateWorkflows(value, contextNames, capabilityNames, errors) {
  if (value === void 0)
    return;
  if (!Array.isArray(value)) {
    errors.push({ path: "$.workflows", code: "WORKFLOWS_NOT_ARRAY", message: "workflows must be an array." });
    return;
  }
  const names = /* @__PURE__ */ new Set();
  value.forEach((workflow, index) => {
    const path7 = `$.workflows[${index}]`;
    if (!isRecord3(workflow)) {
      errors.push({ path: path7, code: "WORKFLOW_NOT_OBJECT", message: "workflow must be an object." });
      return;
    }
    checkUnknownKeys(workflow, WORKFLOW_KEYS, path7, errors);
    if (!isQualifiedName(workflow.name))
      errors.push({ path: `${path7}.name`, code: "INVALID_WORKFLOW_NAME", message: "workflow name must be namespace.name." });
    else
      addUnique(names, workflow.name, `${path7}.name`, "DUPLICATE_WORKFLOW_NAME", errors);
    if (!isNonEmptyString(workflow.context) || !contextNames.has(workflow.context))
      errors.push({ path: `${path7}.context`, code: "UNKNOWN_CONTEXT", message: "workflow.context must reference a declared context." });
    if (!Array.isArray(workflow.allowed_capabilities) || workflow.allowed_capabilities.length === 0) {
      errors.push({ path: `${path7}.allowed_capabilities`, code: "WORKFLOW_CAPABILITIES_REQUIRED", message: "workflow.allowed_capabilities must list allowed capabilities." });
    } else {
      workflow.allowed_capabilities.forEach((name4, allowedIndex) => {
        if (!isNonEmptyString(name4) || !capabilityNames.has(name4))
          errors.push({ path: `${path7}.allowed_capabilities[${allowedIndex}]`, code: "UNKNOWN_CAPABILITY", message: "workflow allowed capability must reference a declared capability." });
      });
    }
  });
}
function validatePolicies(value, errors) {
  const names = /* @__PURE__ */ new Map();
  if (value === void 0)
    return names;
  if (!Array.isArray(value)) {
    errors.push({ path: "$.policies", code: "POLICIES_NOT_ARRAY", message: "$.policies must be an array." });
    return names;
  }
  value.forEach((policy, index) => {
    const path7 = `$.policies[${index}]`;
    if (!isRecord3(policy)) {
      errors.push({ path: path7, code: "POLICY_NOT_OBJECT", message: "policy entry must be an object." });
      return;
    }
    checkUnknownKeys(policy, POLICY_KEYS, path7, errors);
    if (!isQualifiedOrSafeName(policy.name))
      errors.push({ path: `${path7}.name`, code: "INVALID_POLICY_NAME", message: "policy name must be a safe identifier or qualified name." });
    else {
      if (names.has(String(policy.name)))
        errors.push({ path: `${path7}.name`, code: "DUPLICATE_POLICY_NAME", message: `Duplicate name: ${String(policy.name)}` });
      names.set(String(policy.name), policy);
    }
    if (!["approval", "settlement", "scope", "custom"].includes(String(policy.kind)))
      errors.push({ path: `${path7}.kind`, code: "INVALID_POLICY_KIND", message: "policy.kind must be approval, settlement, scope, or custom." });
    if (policy.mode !== void 0 && !["green", "yellow", "red", "manual", "block"].includes(String(policy.mode)))
      errors.push({ path: `${path7}.mode`, code: "INVALID_POLICY_MODE", message: "policy.mode must be green, yellow, red, manual, or block." });
    if (policy.rules !== void 0) {
      if (!Array.isArray(policy.rules)) {
        errors.push({ path: `${path7}.rules`, code: "POLICY_RULES_NOT_ARRAY", message: "policy.rules must be an array." });
      } else if (policy.kind === "approval") {
        policy.rules.forEach((rule2, ruleIndex) => validateApprovalPolicyRuleShape(rule2, `${path7}.rules[${ruleIndex}]`, errors));
      }
    }
    if (policy.limits !== void 0) {
      if (!Array.isArray(policy.limits) || policy.limits.length === 0) {
        errors.push({ path: `${path7}.limits`, code: "APPROVAL_POLICY_LIMITS_NOT_ARRAY", message: "approval policy limits must be a non-empty array." });
      } else if (policy.kind !== "approval") {
        errors.push({ path: `${path7}.limits`, code: "APPROVAL_POLICY_LIMITS_KIND_REQUIRED", message: "aggregate limits are supported only for approval policies." });
      } else {
        policy.limits.forEach((limit, limitIndex) => validateApprovalPolicyLimitShape(limit, `${path7}.limits[${limitIndex}]`, errors));
      }
    }
  });
  return names;
}
function validateApprovalPolicyLimitShape(limit, path7, errors) {
  if (!isRecord3(limit)) {
    errors.push({ path: path7, code: "APPROVAL_POLICY_LIMIT_NOT_OBJECT", message: "approval policy limits must be objects." });
    return;
  }
  checkUnknownKeys(limit, APPROVAL_POLICY_LIMIT_KEYS, path7, errors);
  if (limit.kind !== "count" && limit.kind !== "total") {
    errors.push({ path: `${path7}.kind`, code: "INVALID_APPROVAL_POLICY_LIMIT_KIND", message: "approval policy limit kind must be count or total." });
  }
  if (!Number.isSafeInteger(limit.max) || Number(limit.max) < 0) {
    errors.push({ path: `${path7}.max`, code: "INVALID_APPROVAL_POLICY_LIMIT_MAX", message: "approval policy limit max must be a safe non-negative integer." });
  }
  if (limit.period !== "day") {
    errors.push({ path: `${path7}.period`, code: "INVALID_APPROVAL_POLICY_LIMIT_PERIOD", message: "approval policy limit period must be day." });
  }
  if (limit.scope !== void 0 && limit.scope !== "tenant_policy" && limit.scope !== "tenant_policy_object") {
    errors.push({ path: `${path7}.scope`, code: "INVALID_APPROVAL_POLICY_LIMIT_SCOPE", message: "approval policy limit scope must be tenant_policy or tenant_policy_object." });
  }
  if (limit.kind === "total" && !isSafeIdentifier(limit.field)) {
    errors.push({ path: `${path7}.field`, code: "APPROVAL_POLICY_TOTAL_FIELD_REQUIRED", message: "total approval limits require a safe numeric field." });
  }
  if (limit.kind === "count" && limit.field !== void 0) {
    errors.push({ path: `${path7}.field`, code: "APPROVAL_POLICY_COUNT_FIELD_FORBIDDEN", message: "count approval limits must not declare a field." });
  }
}
function validateApprovalPolicyRuleShape(rule2, path7, errors) {
  if (!isRecord3(rule2)) {
    errors.push({ path: path7, code: "APPROVAL_POLICY_RULE_NOT_OBJECT", message: "approval policy rules must be objects." });
    return;
  }
  const keys = /* @__PURE__ */ new Set(["source", "field", "max", "operator", "value", "values"]);
  checkUnknownKeys(rule2, keys, path7, errors);
  if (!isSafeIdentifier(rule2.field))
    errors.push({ path: `${path7}.field`, code: "INVALID_APPROVAL_POLICY_FIELD", message: "approval policy rule field must be a safe identifier." });
  if (rule2.source !== void 0 && rule2.source !== "patch" && rule2.source !== "before") {
    errors.push({ path: `${path7}.source`, code: "INVALID_APPROVAL_POLICY_SOURCE", message: "approval policy rule source must be patch or before." });
  }
  const legacy = rule2.max !== void 0;
  if (legacy) {
    if (!Number.isInteger(rule2.max) || Number(rule2.max) < 0)
      errors.push({ path: `${path7}.max`, code: "INVALID_APPROVAL_POLICY_MAX", message: "approval policy rule max must be a non-negative integer." });
    if (rule2.source === "before" || rule2.operator !== void 0 || rule2.value !== void 0 || rule2.values !== void 0) {
      errors.push({ path: path7, code: "APPROVAL_POLICY_LEGACY_RULE_CONFLICT", message: "legacy max rules cannot also declare source, operator, value, or values." });
    }
    return;
  }
  if (rule2.operator !== "lte" && rule2.operator !== "gte" && rule2.operator !== "eq" && rule2.operator !== "in" && rule2.operator !== "max_length") {
    errors.push({ path: `${path7}.operator`, code: "INVALID_APPROVAL_POLICY_OPERATOR", message: "typed approval rules require lte, gte, eq, in, or max_length." });
    return;
  }
  if (rule2.operator === "in") {
    if (!Array.isArray(rule2.values) || rule2.values.length < 1 || rule2.values.length > 64 || rule2.values.some((value) => !isJsonScalar(value))) {
      errors.push({ path: `${path7}.values`, code: "INVALID_APPROVAL_POLICY_VALUES", message: "in rules require 1 through 64 JSON scalar values." });
    }
    if (rule2.value !== void 0)
      errors.push({ path: `${path7}.value`, code: "APPROVAL_POLICY_VALUE_FORBIDDEN", message: "in rules use values, not value." });
  } else {
    if (!isJsonScalar(rule2.value))
      errors.push({ path: `${path7}.value`, code: "INVALID_APPROVAL_POLICY_VALUE", message: "lte, gte, and eq rules require one JSON scalar value." });
    if (rule2.values !== void 0)
      errors.push({ path: `${path7}.values`, code: "APPROVAL_POLICY_VALUES_FORBIDDEN", message: "lte, gte, and eq rules use value, not values." });
    if ((rule2.operator === "lte" || rule2.operator === "gte" || rule2.operator === "max_length") && typeof rule2.value !== "number") {
      errors.push({ path: `${path7}.value`, code: "APPROVAL_POLICY_NUMERIC_VALUE_REQUIRED", message: "lte, gte, and max_length rules require a numeric value." });
    }
    if (rule2.operator === "max_length" && (!Number.isSafeInteger(rule2.value) || Number(rule2.value) < 1)) {
      errors.push({ path: `${path7}.value`, code: "APPROVAL_POLICY_LENGTH_INVALID", message: "max_length rules require a positive safe integer." });
    }
  }
}
function validateCapabilityApprovalPolicies(capabilities, policies, policyByName, errors) {
  const policyIndexByName = /* @__PURE__ */ new Map();
  policies.forEach((policy, index) => {
    if (isRecord3(policy) && typeof policy.name === "string")
      policyIndexByName.set(policy.name, index);
  });
  capabilities.forEach((capability, index) => {
    if (!isRecord3(capability) || !isRecord3(capability.proposal))
      return;
    const proposal = capability.proposal;
    const approval = proposal.approval;
    if (!isRecord3(approval))
      return;
    const path7 = `$.capabilities[${index}].proposal.approval`;
    const mode = approval.mode;
    const policyName = approval.policy;
    if (mode === "policy") {
      if (!isNonEmptyString(approval.required_role)) {
        errors.push({ path: `${path7}.required_role`, code: "APPROVAL_POLICY_ROLE_REQUIRED", message: "approval.mode policy still requires required_role for human fallback." });
      }
      if (!isQualifiedOrSafeName(policyName)) {
        errors.push({ path: `${path7}.policy`, code: "APPROVAL_POLICY_REQUIRED", message: "approval.mode policy requires approval.policy." });
        return;
      }
      const policy = policyByName.get(policyName);
      if (!policy) {
        errors.push({ path: `${path7}.policy`, code: "UNKNOWN_APPROVAL_POLICY", message: `approval.policy must reference an existing approval policy: ${policyName}` });
        return;
      }
      if (policy.kind !== "approval") {
        errors.push({ path: `${path7}.policy`, code: "APPROVAL_POLICY_KIND_REQUIRED", message: "approval.policy must reference a policy with kind approval." });
        return;
      }
      validateApprovalPolicyRulesAgainstCapability(policy, policyIndexByName.get(policyName) ?? 0, capability, index, errors);
    } else if (policyName !== void 0) {
      errors.push({ path: `${path7}.policy`, code: "APPROVAL_POLICY_MODE_REQUIRED", message: "approval.policy can only be set when approval.mode is policy." });
    }
  });
}
function validateApprovalPolicyRulesAgainstCapability(policy, policyIndex, capability, capabilityIndex, errors) {
  const proposal = capability.proposal;
  if (!proposal)
    return;
  if (Array.isArray(policy.rules))
    policy.rules.forEach((rule2, ruleIndex) => {
      if (!isRecord3(rule2))
        return;
      const field = rule2.field;
      const max = rule2.max;
      const rulePath = `$.policies[${policyIndex}].rules[${ruleIndex}]`;
      if (!isSafeIdentifier(field))
        return;
      const source = rule2.source === "before" ? "before" : "patch";
      const operator = typeof max === "number" ? "lte" : rule2.operator;
      const value = typeof max === "number" ? max : rule2.value;
      if (source === "patch" && !Object.prototype.hasOwnProperty.call(proposal.patch, field)) {
        errors.push({
          path: `${rulePath}.field`,
          code: "APPROVAL_POLICY_FIELD_NOT_PATCHED",
          message: `approval policy patch field ${field} must be written by capability ${capability.name}.`
        });
        return;
      }
      if (source === "before" && !capability.visible_fields.includes(field) && proposal.conflict_guard?.column !== field && !Object.prototype.hasOwnProperty.call(proposal.transition_guards ?? {}, field)) {
        errors.push({
          path: `${rulePath}.field`,
          code: "APPROVAL_POLICY_BEFORE_FIELD_NOT_CAPTURED",
          message: `approval policy before field ${field} must be in the reviewed pre-change snapshot for ${capability.name}.`
        });
        return;
      }
      if ((operator === "lte" || operator === "gte") && !isNumericProposalField(proposal, capability.args, field)) {
        errors.push({
          path: `${rulePath}.field`,
          code: "APPROVAL_POLICY_FIELD_NOT_NUMERIC",
          message: `approval policy ${operator} field ${field} must be numeric for capability ${capability.name}.`
        });
      }
      const bound = proposal.numeric_bounds?.[field];
      if (operator === "lte" && bound?.maximum !== void 0 && Number(value) > Number(bound.maximum)) {
        errors.push({
          path: `${rulePath}.${max !== void 0 ? "max" : "value"}`,
          code: "APPROVAL_POLICY_MAX_EXCEEDS_BOUND",
          message: `approval policy max for ${field} must be <= numeric_bounds maximum on $.capabilities[${capabilityIndex}].proposal.numeric_bounds.${field}.maximum.`
        });
      }
      if (operator === "lte" && bound?.minimum !== void 0 && Number(value) < Number(bound.minimum)) {
        errors.push({
          path: `${rulePath}.${max !== void 0 ? "max" : "value"}`,
          code: "APPROVAL_POLICY_MAX_BELOW_BOUND",
          message: `approval policy max for ${field} must be >= numeric_bounds minimum on $.capabilities[${capabilityIndex}].proposal.numeric_bounds.${field}.minimum.`
        });
      }
      if (operator === "gte" && bound?.minimum !== void 0 && Number(value) < Number(bound.minimum)) {
        errors.push({
          path: `${rulePath}.value`,
          code: "APPROVAL_POLICY_MIN_BELOW_BOUND",
          message: `approval policy minimum for ${field} must be >= numeric_bounds minimum on $.capabilities[${capabilityIndex}].proposal.numeric_bounds.${field}.minimum.`
        });
      }
      if (operator === "gte" && bound?.maximum !== void 0 && Number(value) > Number(bound.maximum)) {
        errors.push({
          path: `${rulePath}.value`,
          code: "APPROVAL_POLICY_MIN_ABOVE_BOUND",
          message: `approval policy minimum for ${field} must be <= numeric_bounds maximum on $.capabilities[${capabilityIndex}].proposal.numeric_bounds.${field}.maximum.`
        });
      }
      if (source === "patch" && (operator === "eq" || operator === "in")) {
        const patch = proposal.patch[field];
        const argument = patch?.from_arg ? capability.args[patch.from_arg] : void 0;
        const values = operator === "in" && Array.isArray(rule2.values) ? rule2.values : [value];
        if (argument && argument.type !== "object_array" && argument.enum?.length && values.some((candidate) => !argument.enum.some((allowed) => allowed === candidate))) {
          errors.push({
            path: `${rulePath}.${operator === "in" ? "values" : "value"}`,
            code: "APPROVAL_POLICY_VALUE_OUTSIDE_ENUM",
            message: `approval policy values for ${field} must stay inside the reviewed argument enum for ${capability.name}.`
          });
        }
      }
      if (source === "patch" && operator === "max_length") {
        const patch = proposal.patch[field];
        const argument = patch?.from_arg ? capability.args[patch.from_arg] : void 0;
        if (!argument || argument.type !== "string") {
          errors.push({
            path: `${rulePath}.field`,
            code: "APPROVAL_POLICY_LENGTH_FIELD_NOT_STRING",
            message: `approval policy max_length field ${field} must come from a reviewed string argument for ${capability.name}.`
          });
        } else if (argument.max_length !== void 0 && Number(value) > argument.max_length) {
          errors.push({
            path: `${rulePath}.value`,
            code: "APPROVAL_POLICY_LENGTH_EXCEEDS_BOUND",
            message: `approval policy max_length for ${field} must be <= the reviewed argument max_length for ${capability.name}.`
          });
        }
      }
    });
  if (Array.isArray(policy.limits))
    policy.limits.forEach((limit, limitIndex) => {
      if (!isRecord3(limit) || limit.kind !== "total" || !isSafeIdentifier(limit.field))
        return;
      if (!isNumericProposalField(proposal, capability.args, limit.field)) {
        errors.push({
          path: `$.policies[${policyIndex}].limits[${limitIndex}].field`,
          code: "APPROVAL_POLICY_TOTAL_FIELD_NOT_NUMERIC",
          message: `aggregate approval total field ${limit.field} must be numeric for capability ${capability.name}.`
        });
      }
    });
}
function isNumericProposalField(proposal, args, field) {
  if (proposal.numeric_bounds?.[field] !== void 0)
    return true;
  const patch = proposal.patch?.[field];
  if (!patch)
    return false;
  if (typeof patch.fixed === "number" && Number.isInteger(patch.fixed))
    return true;
  if (patch.from_arg && args[patch.from_arg]?.type === "number")
    return true;
  return false;
}
function validateEvidenceRecords(value, errors) {
  if (value === void 0)
    return;
  validateArrayRecords(value, "$.evidence", EVIDENCE_RECORD_KEYS, "EVIDENCE", errors);
}
function validateProposalRecords(value, capabilityNames, errors) {
  if (value === void 0)
    return;
  if (!Array.isArray(value)) {
    errors.push({ path: "$.proposals", code: "PROPOSALS_NOT_ARRAY", message: "proposals must be an array." });
    return;
  }
  value.forEach((proposal, index) => {
    const path7 = `$.proposals[${index}]`;
    if (!isRecord3(proposal)) {
      errors.push({ path: path7, code: "PROPOSAL_NOT_OBJECT", message: "proposal must be an object." });
      return;
    }
    checkUnknownKeys(proposal, PROPOSAL_RECORD_KEYS, path7, errors);
    if (!isNonEmptyString(proposal.id))
      errors.push({ path: `${path7}.id`, code: "INVALID_PROPOSAL_ID", message: "proposal.id must be non-empty." });
    if (!isNonEmptyString(proposal.capability) || capabilityNames.size > 0 && !capabilityNames.has(String(proposal.capability)))
      errors.push({ path: `${path7}.capability`, code: "UNKNOWN_CAPABILITY", message: "proposal.capability must reference a declared capability." });
  });
}
function validateReceiptRecords(value, errors) {
  if (value === void 0)
    return;
  validateArrayRecords(value, "$.receipts", RECEIPT_KEYS, "RECEIPT", errors);
}
function validateReplay(value, errors) {
  if (value === void 0)
    return;
  if (!Array.isArray(value)) {
    errors.push({ path: "$.replay", code: "REPLAY_NOT_ARRAY", message: "replay must be an array." });
    return;
  }
  value.forEach((record2, index) => {
    const path7 = `$.replay[${index}]`;
    if (!isRecord3(record2)) {
      errors.push({ path: path7, code: "REPLAY_RECORD_NOT_OBJECT", message: "replay record must be an object." });
      return;
    }
    checkUnknownKeys(record2, REPLAY_KEYS, path7, errors);
    if (!isNonEmptyString(record2.id))
      errors.push({ path: `${path7}.id`, code: "INVALID_REPLAY_ID", message: "replay id must be non-empty." });
    if (!Array.isArray(record2.events))
      errors.push({ path: `${path7}.events`, code: "REPLAY_EVENTS_REQUIRED", message: "replay.events must be an array." });
  });
}
function validateExternalActions(value, errors) {
  if (value === void 0)
    return;
  validateArrayRecords(value, "$.external_actions", EXTERNAL_ACTION_KEYS, "EXTERNAL_ACTION", errors);
}
function validateActionRuleAuthority(contract, resourceNames, contextNames, errors) {
  const boundaryNames = /* @__PURE__ */ new Set();
  const envelopeNames = /* @__PURE__ */ new Set();
  if (contract.verification_boundaries !== void 0) {
    if (!Array.isArray(contract.verification_boundaries)) {
      errors.push({ path: "$.verification_boundaries", code: "VERIFICATION_BOUNDARIES_NOT_ARRAY", message: "verification_boundaries must be an array." });
    } else {
      contract.verification_boundaries.forEach((raw, index) => {
        const path7 = `$.verification_boundaries[${index}]`;
        if (!isRecord3(raw)) {
          errors.push({ path: path7, code: "VERIFICATION_BOUNDARY_NOT_OBJECT", message: "verification boundary must be an object." });
          return;
        }
        checkUnknownKeys(raw, VERIFICATION_BOUNDARY_KEYS, path7, errors);
        if (raw.schema_version !== "synapsor.verification-boundary.v1")
          errors.push({ path: `${path7}.schema_version`, code: "INVALID_VERIFICATION_BOUNDARY_VERSION", message: "schema_version must be synapsor.verification-boundary.v1." });
        validateNamedAuthority(raw.name, `${path7}.name`, boundaryNames, "VERIFICATION_BOUNDARY", errors);
        if (!isSafeIdentifier(raw.source))
          errors.push({ path: `${path7}.source`, code: "INVALID_VERIFICATION_SOURCE", message: "source must be a fixed safe identifier." });
        if (!isQualifiedOrSafeName(raw.context) || !contextNames.has(String(raw.context)))
          errors.push({ path: `${path7}.context`, code: "UNKNOWN_VERIFICATION_CONTEXT", message: "context must reference a declared trusted context." });
        if (!isSha256Digest(raw.generation_lock_fingerprint))
          errors.push({ path: `${path7}.generation_lock_fingerprint`, code: "INVALID_VERIFICATION_GENERATION_LOCK", message: "generation_lock_fingerprint must be an exact sha256 digest." });
        validateVerificationResources(raw.resources, path7, resourceNames, errors);
        if (!Array.isArray(raw.lock_order) || raw.lock_order.length === 0 || raw.lock_order.some((item) => !isSafeIdentifier(item)))
          errors.push({ path: `${path7}.lock_order`, code: "INVALID_VERIFICATION_LOCK_ORDER", message: "lock_order must contain fixed binding names." });
        if (!isRecord3(raw.transaction))
          errors.push({ path: `${path7}.transaction`, code: "VERIFICATION_TRANSACTION_REQUIRED", message: "transaction must freeze isolation and UTC timezone." });
        else {
          checkUnknownKeys(raw.transaction, VERIFICATION_TRANSACTION_KEYS, `${path7}.transaction`, errors);
          if (!["read_committed", "repeatable_read", "serializable"].includes(String(raw.transaction.isolation)))
            errors.push({ path: `${path7}.transaction.isolation`, code: "INVALID_VERIFICATION_ISOLATION", message: "unsupported transaction isolation." });
          if (raw.transaction.timezone !== "UTC")
            errors.push({ path: `${path7}.transaction.timezone`, code: "VERIFICATION_TIMEZONE_MUST_BE_UTC", message: "Action Rule verification uses UTC." });
        }
      });
    }
  }
  if (contract.derived_effect_envelopes !== void 0) {
    if (!Array.isArray(contract.derived_effect_envelopes)) {
      errors.push({ path: "$.derived_effect_envelopes", code: "EFFECT_ENVELOPES_NOT_ARRAY", message: "derived_effect_envelopes must be an array." });
    } else {
      contract.derived_effect_envelopes.forEach((raw, index) => {
        const path7 = `$.derived_effect_envelopes[${index}]`;
        if (!isRecord3(raw)) {
          errors.push({ path: path7, code: "EFFECT_ENVELOPE_NOT_OBJECT", message: "derived effect envelope must be an object." });
          return;
        }
        checkUnknownKeys(raw, EFFECT_ENVELOPE_KEYS, path7, errors);
        if (raw.schema_version !== "synapsor.derived-effect-envelope.v1")
          errors.push({ path: `${path7}.schema_version`, code: "INVALID_EFFECT_ENVELOPE_VERSION", message: "schema_version must be synapsor.derived-effect-envelope.v1." });
        validateNamedAuthority(raw.name, `${path7}.name`, envelopeNames, "EFFECT_ENVELOPE", errors);
        if (!isSafeIdentifier(raw.source))
          errors.push({ path: `${path7}.source`, code: "INVALID_EFFECT_SOURCE", message: "source must be a fixed safe identifier." });
        validateDerivedEffectTarget(raw, path7, resourceNames, errors);
        if (raw.atomic_updates !== void 0) {
          const members = validateAtomicUpdateList(raw.atomic_updates, `${path7}.atomic_updates`, errors);
          const bindings = /* @__PURE__ */ new Set([raw.target_binding]);
          validateAtomicUpdateGuard(raw, path7, errors);
          members.forEach((member, index2) => {
            const memberPath = `${path7}.atomic_updates[${index2}]`;
            checkUnknownKeys(member, ATOMIC_UPDATE_ENVELOPE_KEYS, memberPath, errors);
            validateDerivedEffectTarget(member, memberPath, resourceNames, errors);
            validateAtomicUpdateGuard(member, memberPath, errors);
            if (bindings.has(member.target_binding))
              errors.push({ path: memberPath, code: "DUPLICATE_ATOMIC_UPDATE_TARGET", message: "Atomic update bindings must be distinct." });
            bindings.add(member.target_binding);
          });
        }
        if (!Array.isArray(raw.approval_classes) || raw.approval_classes.length === 0 || raw.approval_classes.length > 64 || raw.approval_classes.some((item) => !isDottedName(item)) || new Set(raw.approval_classes).size !== raw.approval_classes.length)
          errors.push({ path: `${path7}.approval_classes`, code: "EFFECT_APPROVAL_CLASSES_REQUIRED", message: "approval_classes must contain 1 through 64 unique fixed names." });
        if (!isRecord3(raw.writeback))
          errors.push({ path: `${path7}.writeback`, code: "EFFECT_WRITEBACK_REQUIRED", message: "writeback posture is required." });
        else {
          checkUnknownKeys(raw.writeback, EFFECT_WRITEBACK_KEYS, `${path7}.writeback`, errors);
          if (raw.writeback.mode !== "none" && raw.writeback.mode !== "direct_sql")
            errors.push({ path: `${path7}.writeback.mode`, code: "INVALID_DERIVED_WRITEBACK", message: "derived effects support none or direct_sql." });
          if (raw.writeback.supervised_worker !== "disabled" && raw.writeback.supervised_worker !== "allowed")
            errors.push({ path: `${path7}.writeback.supervised_worker`, code: "INVALID_DERIVED_WORKER_POSTURE", message: "supervised_worker must be disabled or allowed." });
          if (raw.writeback.mode === "none" && raw.writeback.supervised_worker === "allowed")
            errors.push({ path: `${path7}.writeback`, code: "INVALID_DERIVED_WORKER_POSTURE", message: "a supervised worker requires reviewed direct_sql writeback." });
        }
      });
    }
  }
  if (contract.action_rules === void 0)
    return;
  if (!Array.isArray(contract.action_rules)) {
    errors.push({ path: "$.action_rules", code: "ACTION_RULES_NOT_ARRAY", message: "action_rules must be an array." });
    return;
  }
  const ruleNames = /* @__PURE__ */ new Set();
  const outcomes = /* @__PURE__ */ new Set();
  contract.action_rules.forEach((raw, index) => {
    const path7 = `$.action_rules[${index}]`;
    if (!isRecord3(raw)) {
      errors.push({ path: path7, code: "ACTION_RULE_NOT_OBJECT", message: "action rule must be an object." });
      return;
    }
    checkUnknownKeys(raw, ACTION_RULE_KEYS, path7, errors);
    if (raw.schema_version !== "synapsor.action-rule.v1")
      errors.push({ path: `${path7}.schema_version`, code: "INVALID_ACTION_RULE_VERSION", message: "schema_version must be synapsor.action-rule.v1." });
    validateNamedAuthority(raw.name, `${path7}.name`, ruleNames, "ACTION_RULE", errors);
    if (!isDottedName(raw.outcome))
      errors.push({ path: `${path7}.outcome`, code: "INVALID_ACTION_OUTCOME", message: "outcome must be a fixed qualified business name." });
    else
      addUnique(outcomes, raw.outcome, `${path7}.outcome`, "DUPLICATE_ACTION_OUTCOME", errors);
    if (!isQualifiedOrSafeName(raw.context) || !contextNames.has(String(raw.context)))
      errors.push({ path: `${path7}.context`, code: "UNKNOWN_ACTION_RULE_CONTEXT", message: "context must reference a declared trusted context." });
    if (!isSafeIdentifier(raw.source))
      errors.push({ path: `${path7}.source`, code: "INVALID_ACTION_RULE_SOURCE", message: "source must be a fixed safe identifier." });
    if (!boundaryNames.has(String(raw.verification_boundary_ref)))
      errors.push({ path: `${path7}.verification_boundary_ref`, code: "UNKNOWN_VERIFICATION_BOUNDARY", message: "verification_boundary_ref must reference this contract." });
    if (!envelopeNames.has(String(raw.effect_envelope_ref)))
      errors.push({ path: `${path7}.effect_envelope_ref`, code: "UNKNOWN_EFFECT_ENVELOPE", message: "effect_envelope_ref must reference this contract." });
    validateActionRuleSubjects(raw.subjects, path7, resourceNames, errors);
    if (raw.inputs !== void 0)
      validateRuleInputs(raw.inputs, `${path7}.inputs`, errors);
    validateRuleBooleanExpression(raw.require, `${path7}.require`, errors, 0);
    if (!isRecord3(raw.derive))
      errors.push({ path: `${path7}.derive`, code: "ACTION_RULE_DERIVE_NOT_OBJECT", message: "derive must map fixed names to scalar expressions." });
    else
      for (const [name4, expression] of Object.entries(raw.derive)) {
        if (!isSafeIdentifier(name4))
          errors.push({ path: `${path7}.derive.${name4}`, code: "INVALID_DERIVED_NAME", message: "derived value names must be safe identifiers." });
        validateRuleScalarExpression(expression, `${path7}.derive.${name4}`, errors, 0);
      }
    validateActionRuleEffect(raw.effect, `${path7}.effect`, resourceNames, errors);
    if (raw.atomic_updates !== void 0) {
      const members = validateAtomicUpdateList(raw.atomic_updates, `${path7}.atomic_updates`, errors);
      if (!isRecord3(raw.effect) || raw.effect.operation !== "update")
        errors.push({ path: `${path7}.effect`, code: "ATOMIC_UPDATE_REQUIRED", message: "Atomic updates require an UPDATE as the primary effect." });
      members.forEach((member, index2) => {
        validateActionRuleEffect(member, `${path7}.atomic_updates[${index2}]`, resourceNames, errors);
        if (member.operation !== "update" || !isSafeIdentifier(member.target_binding))
          errors.push({ path: `${path7}.atomic_updates[${index2}]`, code: "ATOMIC_UPDATE_REQUIRED", message: "Each atomic update needs one exact target binding." });
      });
    }
    if (!isDottedName(raw.approval_class))
      errors.push({ path: `${path7}.approval_class`, code: "INVALID_ACTION_RULE_APPROVAL_CLASS", message: "approval_class must be a fixed name." });
    if (!Number.isSafeInteger(raw.ttl_seconds) || Number(raw.ttl_seconds) < 15 || Number(raw.ttl_seconds) > 3600)
      errors.push({ path: `${path7}.ttl_seconds`, code: "INVALID_ACTION_RULE_TTL", message: "ttl_seconds must be an integer from 15 through 3600." });
  });
}
function validateAtomicUpdateList(value, path7, errors) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 3 || value.some((member) => !isRecord3(member))) {
    errors.push({ path: path7, code: "INVALID_ATOMIC_UPDATES", message: "atomic_updates must contain one through three exact additional updates." });
    return [];
  }
  return value;
}
function validateAtomicUpdateGuard(raw, path7, errors) {
  if (raw.operation !== "update" || !isRecord3(raw.version_advance) || raw.version_advance.strategy !== "integer_increment" || raw.version_advance.column !== raw.conflict_key || raw.deduplication !== void 0) {
    errors.push({ path: path7, code: "ATOMIC_UPDATE_GUARDS_REQUIRED", message: "Every atomic update requires its own integer version advance and no INSERT deduplication." });
  }
}
function validateDerivedEffectTarget(raw, path7, resourceNames, errors) {
  if (raw.operation !== "update" && raw.operation !== "insert")
    errors.push({ path: `${path7}.operation`, code: "INVALID_DERIVED_EFFECT_OPERATION", message: "derived effects support update or insert only." });
  if (!isQualifiedOrSafeName(raw.target_resource) || !resourceNames.has(String(raw.target_resource)))
    errors.push({ path: `${path7}.target_resource`, code: "UNKNOWN_EFFECT_RESOURCE", message: "target_resource must reference a declared resource." });
  for (const key2 of ["target_binding", "primary_key", "tenant_key", "principal_scope_key", "conflict_key"]) {
    if (raw[key2] !== void 0 && !isSafeIdentifier(raw[key2]))
      errors.push({ path: `${path7}.${key2}`, code: "INVALID_EFFECT_IDENTIFIER", message: `${key2} must be a fixed safe identifier.` });
  }
  if (!isSafeIdentifier(raw.primary_key))
    errors.push({ path: `${path7}.primary_key`, code: "DERIVED_EFFECT_PRIMARY_KEY_REQUIRED", message: "derived effects require one exact target primary key." });
  const organizationScoped = validateProtectedOrganizationScope(raw.organization_scope, `${path7}.organization_scope`, errors);
  if (raw.tenant_key === void 0 === !organizationScoped) {
    errors.push({
      path: path7,
      code: "DERIVED_EFFECT_SCOPE_REQUIRED",
      message: "derived effect envelope must declare exactly one trusted tenant key or reviewed single-organization scope."
    });
  }
  if (raw.max_rows !== 1)
    errors.push({ path: `${path7}.max_rows`, code: "DERIVED_EFFECT_SINGLE_ROW_REQUIRED", message: "first-release derived effects must change exactly one row." });
  validateDerivedEffectFields(raw.allowed_fields, path7, errors);
  if (raw.operation === "update") {
    if (!isSafeIdentifier(raw.target_binding) || !isSafeIdentifier(raw.conflict_key))
      errors.push({ path: path7, code: "DERIVED_UPDATE_GUARDS_REQUIRED", message: "derived UPDATE requires target_binding and conflict_key." });
    if (raw.deduplication !== void 0)
      errors.push({ path: `${path7}.deduplication`, code: "DERIVED_UPDATE_DEDUP_FORBIDDEN", message: "derived UPDATE uses row identity and a conflict guard, not INSERT deduplication." });
  }
  if (raw.operation === "insert") {
    if (!isRecord3(raw.deduplication))
      errors.push({ path: `${path7}.deduplication`, code: "DERIVED_INSERT_DEDUP_REQUIRED", message: "derived INSERT requires reviewed source-enforced deduplication." });
    for (const key2 of ["target_binding", "conflict_key", "version_advance"]) {
      if (raw[key2] !== void 0)
        errors.push({ path: `${path7}.${key2}`, code: "DERIVED_INSERT_UPDATE_GUARD_FORBIDDEN", message: `derived INSERT cannot declare UPDATE-only ${key2}.` });
    }
  }
  if (raw.version_advance !== void 0) {
    if (!isRecord3(raw.version_advance))
      errors.push({ path: `${path7}.version_advance`, code: "INVALID_DERIVED_VERSION_ADVANCE", message: "version_advance must freeze one integer conflict-column increment." });
    else {
      checkUnknownKeys(raw.version_advance, EFFECT_VERSION_ADVANCE_KEYS, `${path7}.version_advance`, errors);
      if (!isSafeIdentifier(raw.version_advance.column) || raw.version_advance.strategy !== "integer_increment")
        errors.push({ path: `${path7}.version_advance`, code: "INVALID_DERIVED_VERSION_ADVANCE", message: "version_advance must freeze one integer conflict-column increment." });
      if (raw.operation === "update" && raw.version_advance.column !== raw.conflict_key)
        errors.push({ path: `${path7}.version_advance.column`, code: "DERIVED_VERSION_GUARD_MISMATCH", message: "version_advance must increment the reviewed conflict key." });
    }
  }
  if (raw.deduplication !== void 0)
    validateDerivedDedup(raw.deduplication, `${path7}.deduplication`, errors);
}
function validateActionRuleEffect(effect, path7, resourceNames, errors) {
  if (!isRecord3(effect))
    errors.push({ path: path7, code: "ACTION_RULE_EFFECT_REQUIRED", message: "effect must be an exact object." });
  else {
    checkUnknownKeys(effect, ACTION_RULE_EFFECT_KEYS, path7, errors);
    if (effect.operation !== "update" && effect.operation !== "insert")
      errors.push({ path: `${path7}.operation`, code: "INVALID_ACTION_RULE_EFFECT", message: "effect operation must be update or insert." });
    if (!isQualifiedOrSafeName(effect.target_resource) || !resourceNames.has(String(effect.target_resource)))
      errors.push({ path: `${path7}.target_resource`, code: "UNKNOWN_ACTION_RULE_EFFECT_RESOURCE", message: "effect target_resource must reference a declared resource." });
    if (effect.target_binding !== void 0 && !isSafeIdentifier(effect.target_binding))
      errors.push({ path: `${path7}.target_binding`, code: "INVALID_ACTION_RULE_TARGET_BINDING", message: "target_binding must be a safe identifier." });
    if (!isRecord3(effect.set) || Object.keys(effect.set).length === 0)
      errors.push({ path: `${path7}.set`, code: "ACTION_RULE_EFFECT_SET_REQUIRED", message: "effect.set must contain at least one derived field." });
    else
      for (const [field, expression] of Object.entries(effect.set)) {
        if (!isSafeIdentifier(field))
          errors.push({ path: `${path7}.set.${field}`, code: "INVALID_ACTION_RULE_EFFECT_FIELD", message: "effect fields must be safe identifiers." });
        validateRuleScalarExpression(expression, `${path7}.set.${field}`, errors, 0);
      }
  }
}
function validateVerificationResources(value, boundaryPath, resourceNames, errors) {
  const path7 = `${boundaryPath}.resources`;
  if (!Array.isArray(value) || value.length === 0 || value.length > 32) {
    errors.push({ path: path7, code: "VERIFICATION_RESOURCES_REQUIRED", message: "verification resources must contain 1 through 32 bounded bindings." });
    return;
  }
  const bindings = /* @__PURE__ */ new Set();
  value.forEach((raw, index) => {
    const itemPath = `${path7}[${index}]`;
    if (!isRecord3(raw)) {
      errors.push({ path: itemPath, code: "VERIFICATION_RESOURCE_NOT_OBJECT", message: "verification resource must be an object." });
      return;
    }
    checkUnknownKeys(raw, VERIFICATION_RESOURCE_KEYS, itemPath, errors);
    if (!isSafeIdentifier(raw.binding))
      errors.push({ path: `${itemPath}.binding`, code: "INVALID_VERIFICATION_BINDING", message: "binding must be a safe identifier." });
    else
      addUnique(bindings, raw.binding, `${itemPath}.binding`, "DUPLICATE_VERIFICATION_BINDING", errors);
    if (!isQualifiedOrSafeName(raw.resource) || !resourceNames.has(String(raw.resource)))
      errors.push({ path: `${itemPath}.resource`, code: "UNKNOWN_VERIFICATION_RESOURCE", message: "resource must reference a declared resource." });
    if (!isSafeIdentifier(raw.primary_key))
      errors.push({ path: `${itemPath}.primary_key`, code: "INVALID_VERIFICATION_PRIMARY_KEY", message: "primary_key must be a safe identifier." });
    if (raw.version_field !== void 0 && !isSafeIdentifier(raw.version_field))
      errors.push({ path: `${itemPath}.version_field`, code: "INVALID_VERIFICATION_VERSION_FIELD", message: "version_field must be a safe identifier." });
    validateVerificationBindingSource(raw.source, `${itemPath}.source`, errors);
    validateVerificationFields(raw.fields, `${itemPath}.fields`, errors);
    validateVerificationScope(raw.scope, `${itemPath}.scope`, errors);
    if (raw.cardinality !== "one" && raw.cardinality !== "many")
      errors.push({ path: `${itemPath}.cardinality`, code: "INVALID_VERIFICATION_CARDINALITY", message: "cardinality must be one or many." });
    if (!Number.isSafeInteger(raw.max_rows) || Number(raw.max_rows) < 1 || Number(raw.max_rows) > 100 || raw.cardinality === "one" && raw.max_rows !== 1)
      errors.push({ path: `${itemPath}.max_rows`, code: "INVALID_VERIFICATION_ROW_BOUND", message: "one bindings require 1 row; many bindings require an explicit maximum no greater than 100." });
    if (raw.overflow !== "ineligible" && raw.overflow !== "unsupported")
      errors.push({ path: `${itemPath}.overflow`, code: "INVALID_VERIFICATION_OVERFLOW", message: "overflow must fail as ineligible or unsupported." });
    if (raw.collection_consistency !== void 0 && (raw.collection_consistency !== "complete_locked" || raw.cardinality !== "many")) {
      errors.push({ path: `${itemPath}.collection_consistency`, code: "INVALID_COLLECTION_CONSISTENCY", message: "complete_locked requires a bounded many-row collection." });
    }
    if (raw.lock !== "for_update")
      errors.push({ path: `${itemPath}.lock`, code: "VERIFICATION_LOCK_REQUIRED", message: "first-release rule facts require for_update locking." });
    if (raw.deterministic_order !== void 0) {
      if (!Array.isArray(raw.deterministic_order) || raw.deterministic_order.length === 0)
        errors.push({ path: `${itemPath}.deterministic_order`, code: "INVALID_VERIFICATION_ORDER", message: "deterministic_order must be a non-empty bounded list." });
      else
        raw.deterministic_order.forEach((entry, orderIndex) => {
          const orderPath = `${itemPath}.deterministic_order[${orderIndex}]`;
          if (!isRecord3(entry))
            errors.push({ path: orderPath, code: "VERIFICATION_ORDER_NOT_OBJECT", message: "order entry must be an object." });
          else {
            checkUnknownKeys(entry, VERIFICATION_ORDER_KEYS, orderPath, errors);
            if (!isSafeIdentifier(entry.field) || entry.direction !== "asc" && entry.direction !== "desc")
              errors.push({ path: orderPath, code: "INVALID_VERIFICATION_ORDER", message: "order requires one fixed field and direction." });
          }
        });
    }
  });
  if (Array.isArray(value))
    value.forEach((raw, index) => {
      if (!isRecord3(raw) || !isRecord3(raw.source) || raw.source.kind !== "relationship")
        return;
      if (!bindings.has(String(raw.source.from_binding)))
        errors.push({ path: `${path7}[${index}].source.from_binding`, code: "UNKNOWN_VERIFICATION_PARENT_BINDING", message: "relationship source must reference another binding." });
    });
}
function validateVerificationBindingSource(value, path7, errors) {
  if (!isRecord3(value)) {
    errors.push({ path: path7, code: "VERIFICATION_SOURCE_REQUIRED", message: "binding source is required." });
    return;
  }
  checkUnknownKeys(value, VERIFICATION_SOURCE_KEYS, path7, errors);
  if (value.kind === "subject_ref") {
    checkVariantKeys(value, VERIFICATION_SOURCE_KEYS, /* @__PURE__ */ new Set(["kind"]), path7, errors);
    for (const key2 of ["from_binding", "relationship", "local_field", "target_field", "field_pairs", "direction"])
      if (value[key2] !== void 0)
        errors.push({ path: `${path7}.${key2}`, code: "SUBJECT_SOURCE_FIELD_FORBIDDEN", message: "subject_ref has no relationship fields." });
    return;
  }
  if (value.kind !== "relationship") {
    errors.push({ path: `${path7}.kind`, code: "INVALID_VERIFICATION_SOURCE_KIND", message: "source kind must be subject_ref or relationship." });
    return;
  }
  checkVariantKeys(value, VERIFICATION_SOURCE_KEYS, VERIFICATION_SOURCE_KEYS, path7, errors);
  for (const key2 of ["from_binding", "relationship"])
    if (!isSafeIdentifier(value[key2]))
      errors.push({ path: `${path7}.${key2}`, code: "INVALID_VERIFICATION_RELATIONSHIP", message: `${key2} must be a fixed identifier.` });
  if (value.field_pairs === void 0) {
    for (const key2 of ["local_field", "target_field"])
      if (!isSafeIdentifier(value[key2]))
        errors.push({ path: `${path7}.${key2}`, code: "INVALID_VERIFICATION_RELATIONSHIP", message: `${key2} must be a fixed identifier.` });
  } else {
    const pairs = value.field_pairs;
    const local = /* @__PURE__ */ new Set();
    const target = /* @__PURE__ */ new Set();
    if (value.local_field !== void 0 || value.target_field !== void 0 || !Array.isArray(pairs) || pairs.length < 2 || pairs.length > 16) {
      errors.push({ path: path7, code: "INVALID_VERIFICATION_RELATIONSHIP", message: "Composite relationships require 2 through 16 ordered field pairs and no singular fields." });
    } else
      pairs.forEach((pair, index) => {
        const pairPath = `${path7}.field_pairs[${index}]`;
        if (!isRecord3(pair)) {
          errors.push({ path: pairPath, code: "INVALID_VERIFICATION_RELATIONSHIP", message: "Expected a fixed field pair." });
          return;
        }
        checkUnknownKeys(pair, /* @__PURE__ */ new Set(["local_field", "target_field"]), pairPath, errors);
        for (const [key2, seen] of [["local_field", local], ["target_field", target]]) {
          if (!isSafeIdentifier(pair[key2]) || seen.has(String(pair[key2])))
            errors.push({ path: `${pairPath}.${key2}`, code: "INVALID_VERIFICATION_RELATIONSHIP", message: "Relationship fields must be fixed, non-repeated identifiers." });
          seen.add(String(pair[key2]));
        }
      });
  }
  if (value.direction !== "forward" && value.direction !== "inverse")
    errors.push({ path: `${path7}.direction`, code: "INVALID_VERIFICATION_DIRECTION", message: "direction must be forward or inverse." });
}
function validateVerificationFields(value, path7, errors) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 256) {
    errors.push({ path: path7, code: "VERIFICATION_FIELDS_REQUIRED", message: "fields must contain 1 through 256 reviewed fields." });
    return;
  }
  const names = /* @__PURE__ */ new Set();
  value.forEach((raw, index) => {
    const itemPath = `${path7}[${index}]`;
    if (!isRecord3(raw)) {
      errors.push({ path: itemPath, code: "VERIFICATION_FIELD_NOT_OBJECT", message: "field must be an object." });
      return;
    }
    checkUnknownKeys(raw, VERIFICATION_FIELD_KEYS, itemPath, errors);
    if (!isSafeIdentifier(raw.name))
      errors.push({ path: `${itemPath}.name`, code: "INVALID_VERIFICATION_FIELD", message: "field name must be a safe identifier." });
    else
      addUnique(names, raw.name, `${itemPath}.name`, "DUPLICATE_VERIFICATION_FIELD", errors);
    validateRuleScalarType(raw.type, `${itemPath}.type`, errors);
    if (raw.nullable !== void 0 && typeof raw.nullable !== "boolean")
      errors.push({ path: `${itemPath}.nullable`, code: "INVALID_VERIFICATION_NULLABLE", message: "nullable must be boolean." });
    if (raw.model_visible !== void 0 && typeof raw.model_visible !== "boolean")
      errors.push({ path: `${itemPath}.model_visible`, code: "INVALID_VERIFICATION_VISIBILITY", message: "model_visible must be boolean." });
  });
}
function validateVerificationScope(value, path7, errors) {
  if (!isRecord3(value)) {
    errors.push({ path: path7, code: "VERIFICATION_SCOPE_REQUIRED", message: "every verification resource requires reviewed trusted scope." });
    return;
  }
  checkUnknownKeys(value, VERIFICATION_SCOPE_KEYS, path7, errors);
  if (value.mode === "columns") {
    checkVariantKeys(value, VERIFICATION_SCOPE_KEYS, /* @__PURE__ */ new Set(["mode", "tenant_field", "principal_field"]), path7, errors);
    if (!isSafeIdentifier(value.tenant_field))
      errors.push({ path: `${path7}.tenant_field`, code: "VERIFICATION_TENANT_FIELD_REQUIRED", message: "column scope requires tenant_field." });
    if (value.principal_field !== void 0 && !isSafeIdentifier(value.principal_field))
      errors.push({ path: `${path7}.principal_field`, code: "INVALID_VERIFICATION_PRINCIPAL_FIELD", message: "principal_field must be fixed." });
  } else if (value.mode === "inherited") {
    checkVariantKeys(value, VERIFICATION_SCOPE_KEYS, /* @__PURE__ */ new Set(["mode", "from_binding"]), path7, errors);
    if (!isSafeIdentifier(value.from_binding))
      errors.push({ path: `${path7}.from_binding`, code: "VERIFICATION_SCOPE_PARENT_REQUIRED", message: "inherited scope requires a parent binding." });
  } else if (value.mode === "single_organization") {
    checkVariantKeys(value, VERIFICATION_SCOPE_KEYS, /* @__PURE__ */ new Set(["mode", "organization_id", "principal_field"]), path7, errors);
    if (!isNonEmptyString(value.organization_id))
      errors.push({ path: `${path7}.organization_id`, code: "VERIFICATION_ORGANIZATION_REQUIRED", message: "single-organization scope requires the reviewed organization ID." });
    if (value.principal_field !== void 0 && !isSafeIdentifier(value.principal_field))
      errors.push({ path: `${path7}.principal_field`, code: "INVALID_VERIFICATION_PRINCIPAL_FIELD", message: "principal_field must be fixed." });
  } else
    errors.push({ path: `${path7}.mode`, code: "INVALID_VERIFICATION_SCOPE", message: "scope mode must be columns, inherited, or single_organization." });
}
function validateDerivedEffectFields(value, envelopePath, errors) {
  const path7 = `${envelopePath}.allowed_fields`;
  if (!Array.isArray(value) || value.length === 0 || value.length > 64) {
    errors.push({ path: path7, code: "DERIVED_EFFECT_FIELDS_REQUIRED", message: "allowed_fields must contain 1 through 64 exact fields." });
    return;
  }
  const names = /* @__PURE__ */ new Set();
  value.forEach((raw, index) => {
    const itemPath = `${path7}[${index}]`;
    if (!isRecord3(raw)) {
      errors.push({ path: itemPath, code: "DERIVED_EFFECT_FIELD_NOT_OBJECT", message: "allowed effect field must be an object." });
      return;
    }
    checkUnknownKeys(raw, EFFECT_FIELD_KEYS, itemPath, errors);
    if (!isSafeIdentifier(raw.name))
      errors.push({ path: `${itemPath}.name`, code: "INVALID_DERIVED_EFFECT_FIELD", message: "effect field must be fixed." });
    else
      addUnique(names, raw.name, `${itemPath}.name`, "DUPLICATE_DERIVED_EFFECT_FIELD", errors);
    validateRuleScalarType(raw.type, `${itemPath}.type`, errors);
    if (raw.minimum !== void 0 && !Number.isSafeInteger(raw.minimum))
      errors.push({ path: `${itemPath}.minimum`, code: "INVALID_DERIVED_EFFECT_MINIMUM", message: "numeric minimum must be a safe integer." });
    if (raw.maximum !== void 0 && !Number.isSafeInteger(raw.maximum))
      errors.push({ path: `${itemPath}.maximum`, code: "INVALID_DERIVED_EFFECT_MAXIMUM", message: "numeric maximum must be a safe integer." });
    if (typeof raw.minimum === "number" && typeof raw.maximum === "number" && raw.minimum > raw.maximum)
      errors.push({ path: itemPath, code: "INVALID_DERIVED_EFFECT_RANGE", message: "minimum must not exceed maximum." });
    if ((raw.minimum !== void 0 || raw.maximum !== void 0) && (!isRecord3(raw.type) || raw.type.kind !== "integer" && raw.type.kind !== "money_minor")) {
      errors.push({ path: itemPath, code: "INVALID_DERIVED_EFFECT_RANGE_TYPE", message: "minimum and maximum are valid only for integer or money_minor fields." });
    }
    if (raw.values !== void 0) {
      if (!Array.isArray(raw.values) || raw.values.length === 0 || raw.values.length > 256 || raw.values.some((item) => !isJsonScalar(item)) || new Set(raw.values.map((item) => JSON.stringify(item))).size !== raw.values.length) {
        errors.push({ path: `${itemPath}.values`, code: "INVALID_DERIVED_EFFECT_VALUES", message: "values must be a bounded, unique finite scalar allowlist." });
      } else {
        raw.values.forEach((item, valueIndex) => validateRuleLiteralValue(item, raw.type, `${itemPath}.values[${valueIndex}]`, errors));
      }
    }
  });
}
function validateDerivedDedup(value, path7, errors) {
  if (!isRecord3(value)) {
    errors.push({ path: path7, code: "DERIVED_INSERT_DEDUP_REQUIRED", message: "deduplication must be an object." });
    return;
  }
  checkUnknownKeys(value, EFFECT_DEDUP_KEYS, path7, errors);
  if (!Array.isArray(value.components) || value.components.length < 1 || value.components.length > 8) {
    errors.push({ path: `${path7}.components`, code: "INVALID_DERIVED_DEDUP_COMPONENTS", message: "deduplication requires 1 through 8 components." });
    return;
  }
  const columns = /* @__PURE__ */ new Set();
  value.components.forEach((raw, index) => {
    const itemPath = `${path7}.components[${index}]`;
    if (!isRecord3(raw)) {
      errors.push({ path: itemPath, code: "DERIVED_DEDUP_COMPONENT_NOT_OBJECT", message: "deduplication component must be an object." });
      return;
    }
    checkUnknownKeys(raw, EFFECT_DEDUP_COMPONENT_KEYS, itemPath, errors);
    if (!isSafeIdentifier(raw.column))
      errors.push({ path: `${itemPath}.column`, code: "INVALID_DERIVED_DEDUP_COLUMN", message: "deduplication column must be fixed." });
    else
      addUnique(columns, raw.column, `${itemPath}.column`, "DUPLICATE_DERIVED_DEDUP_COLUMN", errors);
    if (!["proposal_id", "trusted_tenant", "derived", "fixed"].includes(String(raw.source)))
      errors.push({ path: `${itemPath}.source`, code: "INVALID_DERIVED_DEDUP_SOURCE", message: "unsupported deduplication source." });
    if (raw.source === "derived") {
      checkVariantKeys(raw, EFFECT_DEDUP_COMPONENT_KEYS, /* @__PURE__ */ new Set(["column", "source", "derived"]), itemPath, errors);
      if (!isSafeIdentifier(raw.derived))
        errors.push({ path: `${itemPath}.derived`, code: "DERIVED_DEDUP_VALUE_REQUIRED", message: "derived source requires one derived value name." });
    } else if (raw.source === "fixed") {
      checkVariantKeys(raw, EFFECT_DEDUP_COMPONENT_KEYS, /* @__PURE__ */ new Set(["column", "source", "fixed"]), itemPath, errors);
      if (!isJsonScalar(raw.fixed))
        errors.push({ path: `${itemPath}.fixed`, code: "FIXED_DEDUP_VALUE_REQUIRED", message: "fixed source requires one scalar." });
    } else if (raw.source === "proposal_id" || raw.source === "trusted_tenant") {
      checkVariantKeys(raw, EFFECT_DEDUP_COMPONENT_KEYS, /* @__PURE__ */ new Set(["column", "source"]), itemPath, errors);
    }
  });
}
function validateActionRuleSubjects(value, rulePath, resourceNames, errors) {
  const path7 = `${rulePath}.subjects`;
  if (!Array.isArray(value) || value.length === 0 || value.length > 8) {
    errors.push({ path: path7, code: "ACTION_RULE_SUBJECTS_REQUIRED", message: "subjects must contain 1 through 8 opaque-reference bindings." });
    return;
  }
  const bindings = /* @__PURE__ */ new Set();
  value.forEach((raw, index) => {
    const itemPath = `${path7}[${index}]`;
    if (!isRecord3(raw)) {
      errors.push({ path: itemPath, code: "ACTION_RULE_SUBJECT_NOT_OBJECT", message: "subject must be an object." });
      return;
    }
    checkUnknownKeys(raw, ACTION_RULE_SUBJECT_KEYS, itemPath, errors);
    if (!isSafeIdentifier(raw.binding))
      errors.push({ path: `${itemPath}.binding`, code: "INVALID_ACTION_RULE_SUBJECT_BINDING", message: "subject binding must be fixed." });
    else
      addUnique(bindings, raw.binding, `${itemPath}.binding`, "DUPLICATE_ACTION_RULE_SUBJECT_BINDING", errors);
    if (!isQualifiedOrSafeName(raw.resource) || !resourceNames.has(String(raw.resource)))
      errors.push({ path: `${itemPath}.resource`, code: "UNKNOWN_ACTION_RULE_SUBJECT_RESOURCE", message: "subject resource must be declared." });
    if (raw.input !== "opaque_subject_ref")
      errors.push({ path: `${itemPath}.input`, code: "ACTION_RULE_OPAQUE_SUBJECT_REQUIRED", message: "rule subjects must use opaque_subject_ref." });
  });
}
function validateRuleScalarType(value, path7, errors) {
  if (!isRecord3(value)) {
    errors.push({ path: path7, code: "ACTION_RULE_TYPE_REQUIRED", message: "one portable scalar type is required." });
    return;
  }
  checkUnknownKeys(value, ACTION_RULE_SCALAR_TYPE_KEYS, path7, errors);
  if (!["boolean", "integer", "money_minor", "string", "date", "timestamp"].includes(String(value.kind))) {
    errors.push({ path: `${path7}.kind`, code: "INVALID_ACTION_RULE_TYPE", message: "unsupported portable scalar type." });
    return;
  }
  checkVariantKeys(value, ACTION_RULE_SCALAR_TYPE_KEYS, ACTION_RULE_SCALAR_TYPE_VARIANT_KEYS[value.kind], path7, errors);
  if (value.kind === "integer" && value.unit !== void 0 && !isSafeUnit(value.unit))
    errors.push({ path: `${path7}.unit`, code: "INVALID_ACTION_RULE_UNIT", message: "integer unit must be a short fixed unit." });
  if (value.kind === "money_minor" && (typeof value.currency !== "string" || !/^[A-Z]{3}$/.test(value.currency)))
    errors.push({ path: `${path7}.currency`, code: "ACTION_RULE_CURRENCY_REQUIRED", message: "money_minor requires an ISO-style three-letter currency." });
  if (value.kind === "string") {
    if (!Number.isSafeInteger(value.max_length) || Number(value.max_length) < 1 || Number(value.max_length) > 4096)
      errors.push({ path: `${path7}.max_length`, code: "ACTION_RULE_STRING_BOUND_REQUIRED", message: "string max_length must be 1 through 4096." });
    if (value.comparison !== "exact")
      errors.push({ path: `${path7}.comparison`, code: "ACTION_RULE_EXACT_STRING_REQUIRED", message: "first-release string comparisons are exact." });
    if (value.enum !== void 0 && (!Array.isArray(value.enum) || value.enum.length === 0 || value.enum.length > 256 || value.enum.some((item) => typeof item !== "string" || item.length > Number(value.max_length)) || new Set(value.enum).size !== value.enum.length)) {
      errors.push({ path: `${path7}.enum`, code: "INVALID_ACTION_RULE_ENUM", message: "enum must be a bounded, unique string allowlist whose values fit max_length." });
    }
  }
}
function validateRuleLiteralValue(value, type, path7, errors) {
  if (value === null || !isRecord3(type))
    return;
  let valid = false;
  switch (type.kind) {
    case "boolean":
      valid = typeof value === "boolean";
      break;
    case "integer":
    case "money_minor":
      valid = Number.isSafeInteger(value);
      break;
    case "string":
      valid = typeof value === "string" && Number.isSafeInteger(type.max_length) && value.length <= Number(type.max_length) && (!Array.isArray(type.enum) || type.enum.includes(value));
      break;
    case "date":
      valid = isCanonicalDate(value);
      break;
    case "timestamp":
      valid = isCanonicalUtcInstant(value);
      break;
    default:
      return;
  }
  if (!valid)
    errors.push({ path: path7, code: "ACTION_RULE_LITERAL_TYPE_MISMATCH", message: "literal value must exactly match its declared portable type." });
}
function validateRuleInputs(value, path7, errors) {
  if (!Array.isArray(value) || value.length > 32) {
    errors.push({ path: path7, code: "INVALID_ACTION_INPUTS", message: "inputs must contain at most 32 reviewed business inputs." });
    return;
  }
  const names = /* @__PURE__ */ new Set();
  value.forEach((input, index) => {
    const location = `${path7}[${index}]`;
    if (!isRecord3(input)) {
      errors.push({ path: location, code: "INVALID_ACTION_INPUT", message: "input must be an object." });
      return;
    }
    checkUnknownKeys(input, /* @__PURE__ */ new Set(["name", "description", "type", "minimum", "maximum"]), location, errors);
    if (!isSafeIdentifier(input.name) || names.has(String(input.name)) || ["__proto__", "constructor", "prototype"].includes(String(input.name)))
      errors.push({ path: location, code: "INVALID_ACTION_INPUT", message: "input name must be safe and unique." });
    names.add(String(input.name));
    if (typeof input.description !== "string" || !input.description.trim() || input.description.length > 500)
      errors.push({ path: location, code: "INVALID_ACTION_INPUT", message: "input requires a concise business description." });
    validateRuleScalarType(input.type, `${location}.type`, errors);
    const numeric = isRecord3(input.type) && ["integer", "money_minor"].includes(String(input.type.kind));
    if (numeric && (!Number.isSafeInteger(input.minimum) || !Number.isSafeInteger(input.maximum) || Number(input.minimum) > Number(input.maximum)))
      errors.push({ path: location, code: "INVALID_ACTION_INPUT", message: "numeric inputs require finite reviewed minimum and maximum bounds." });
    if (!numeric && (input.minimum !== void 0 || input.maximum !== void 0))
      errors.push({ path: location, code: "INVALID_ACTION_INPUT", message: "non-numeric inputs cannot have numeric bounds." });
    if (isRecord3(input.type) && input.type.kind === "string" && Number(input.type.max_length) > 4096)
      errors.push({ path: location, code: "INVALID_ACTION_INPUT", message: "business text inputs cannot exceed 4096 characters." });
  });
}
function validateRuleScalarExpression(value, path7, errors, depth) {
  if (depth > 24) {
    errors.push({ path: path7, code: "ACTION_RULE_EXPRESSION_TOO_DEEP", message: "rule expressions may be at most 24 levels deep." });
    return;
  }
  if (!isRecord3(value)) {
    errors.push({ path: path7, code: "ACTION_RULE_SCALAR_EXPRESSION_REQUIRED", message: "scalar expression must be an object." });
    return;
  }
  checkUnknownKeys(value, ACTION_RULE_SCALAR_EXPR_KEYS, path7, errors);
  switch (value.kind) {
    case "input":
      checkVariantKeys(value, ACTION_RULE_SCALAR_EXPR_KEYS, ACTION_RULE_SCALAR_EXPR_VARIANT_KEYS.input, path7, errors);
      if (!isSafeIdentifier(value.name))
        errors.push({ path: `${path7}.name`, code: "INVALID_ACTION_INPUT_REFERENCE", message: "input reference must name a reviewed business input." });
      return;
    case "literal":
      checkVariantKeys(value, ACTION_RULE_SCALAR_EXPR_KEYS, ACTION_RULE_SCALAR_EXPR_VARIANT_KEYS.literal, path7, errors);
      if (!isJsonScalar(value.value))
        errors.push({ path: `${path7}.value`, code: "INVALID_ACTION_RULE_LITERAL", message: "literal must be a finite JSON scalar." });
      validateRuleScalarType(value.value_type, `${path7}.value_type`, errors);
      validateRuleLiteralValue(value.value, value.value_type, `${path7}.value`, errors);
      return;
    case "trusted":
      checkVariantKeys(value, ACTION_RULE_SCALAR_EXPR_KEYS, ACTION_RULE_SCALAR_EXPR_VARIANT_KEYS.trusted, path7, errors);
      if (!["tenant", "organization", "principal", "transaction_time"].includes(String(value.binding)))
        errors.push({ path: `${path7}.binding`, code: "INVALID_TRUSTED_RULE_BINDING", message: "trusted binding must be tenant, organization, principal, or transaction_time." });
      return;
    case "field":
      checkVariantKeys(value, ACTION_RULE_SCALAR_EXPR_KEYS, ACTION_RULE_SCALAR_EXPR_VARIANT_KEYS.field, path7, errors);
      if (!isSafeIdentifier(value.binding) || !isSafeIdentifier(value.field))
        errors.push({ path: path7, code: "INVALID_ACTION_RULE_FIELD_REFERENCE", message: "field references require fixed binding and field identifiers." });
      return;
    case "derived":
      checkVariantKeys(value, ACTION_RULE_SCALAR_EXPR_KEYS, ACTION_RULE_SCALAR_EXPR_VARIANT_KEYS.derived, path7, errors);
      if (!isSafeIdentifier(value.name))
        errors.push({ path: `${path7}.name`, code: "INVALID_ACTION_RULE_DERIVED_REFERENCE", message: "derived reference must be fixed." });
      return;
    case "aggregate":
      checkVariantKeys(value, ACTION_RULE_SCALAR_EXPR_KEYS, ACTION_RULE_SCALAR_EXPR_VARIANT_KEYS.aggregate, path7, errors);
      if (!["count", "sum", "min", "max"].includes(String(value.operation)) || !isSafeIdentifier(value.binding) || (value.operation !== "count" || value.field !== void 0) && !isSafeIdentifier(value.field))
        errors.push({ path: path7, code: "INVALID_ACTION_RULE_AGGREGATE", message: "aggregate requires a supported operation and fixed bounded binding." });
      if (value.where !== void 0)
        validateRuleBooleanExpression(value.where, `${path7}.where`, errors, depth + 1);
      return;
    case "math":
      checkVariantKeys(value, ACTION_RULE_SCALAR_EXPR_KEYS, ACTION_RULE_SCALAR_EXPR_VARIANT_KEYS.math, path7, errors);
      if (!["add", "subtract", "min", "max"].includes(String(value.operation)) || !Array.isArray(value.inputs) || value.inputs.length < 2 || value.inputs.length > 16)
        errors.push({ path: path7, code: "INVALID_ACTION_RULE_MATH", message: "math requires 2 through 16 inputs." });
      else
        value.inputs.forEach((item, index) => validateRuleScalarExpression(item, `${path7}.inputs[${index}]`, errors, depth + 1));
      return;
    case "scale":
      checkVariantKeys(value, ACTION_RULE_SCALAR_EXPR_KEYS, ACTION_RULE_SCALAR_EXPR_VARIANT_KEYS.scale, path7, errors);
      if (value.operation !== "multiply" && value.operation !== "divide")
        errors.push({ path: `${path7}.operation`, code: "INVALID_ACTION_RULE_SCALE", message: "scale supports multiply or divide." });
      if (!Number.isSafeInteger(value.constant) || value.constant === 0)
        errors.push({ path: `${path7}.constant`, code: "INVALID_ACTION_RULE_SCALE_CONSTANT", message: "scale constant must be a non-zero safe integer." });
      if (!["floor", "ceiling", "half_even"].includes(String(value.rounding)))
        errors.push({ path: `${path7}.rounding`, code: "ACTION_RULE_ROUNDING_REQUIRED", message: "scale requires explicit rounding." });
      validateRuleScalarExpression(value.input, `${path7}.input`, errors, depth + 1);
      return;
    case "clamp":
      checkVariantKeys(value, ACTION_RULE_SCALAR_EXPR_KEYS, ACTION_RULE_SCALAR_EXPR_VARIANT_KEYS.clamp, path7, errors);
      validateRuleScalarExpression(value.input, `${path7}.input`, errors, depth + 1);
      validateRuleScalarExpression(value.minimum, `${path7}.minimum`, errors, depth + 1);
      validateRuleScalarExpression(value.maximum, `${path7}.maximum`, errors, depth + 1);
      return;
    case "date_of":
      checkVariantKeys(value, ACTION_RULE_SCALAR_EXPR_KEYS, ACTION_RULE_SCALAR_EXPR_VARIANT_KEYS.date_of, path7, errors);
      if (value.timezone !== "UTC")
        errors.push({ path: `${path7}.timezone`, code: "INVALID_ACTION_RULE_TIMEZONE", message: "date_of requires the explicit reviewed UTC calendar day." });
      validateRuleScalarExpression(value.timestamp, `${path7}.timestamp`, errors, depth + 1);
      return;
    case "add_duration":
      checkVariantKeys(value, ACTION_RULE_SCALAR_EXPR_KEYS, ACTION_RULE_SCALAR_EXPR_VARIANT_KEYS.add_duration, path7, errors);
      if (!Number.isSafeInteger(value.seconds) || Number(value.seconds) < -31536e3 || Number(value.seconds) > 31536e3)
        errors.push({ path: `${path7}.seconds`, code: "INVALID_ACTION_RULE_DURATION", message: "duration must be a reviewed whole-second value within one year." });
      validateRuleScalarExpression(value.timestamp, `${path7}.timestamp`, errors, depth + 1);
      return;
    default:
      errors.push({ path: `${path7}.kind`, code: "UNKNOWN_ACTION_RULE_SCALAR_OPERATOR", message: "unsupported scalar expression kind." });
  }
}
function validateRuleBooleanExpression(value, path7, errors, depth) {
  if (depth > 24) {
    errors.push({ path: path7, code: "ACTION_RULE_EXPRESSION_TOO_DEEP", message: "rule expressions may be at most 24 levels deep." });
    return;
  }
  if (!isRecord3(value)) {
    errors.push({ path: path7, code: "ACTION_RULE_BOOLEAN_EXPRESSION_REQUIRED", message: "boolean expression must be an object." });
    return;
  }
  checkUnknownKeys(value, ACTION_RULE_BOOLEAN_EXPR_KEYS, path7, errors);
  if (value.kind === "all" || value.kind === "any") {
    checkVariantKeys(value, ACTION_RULE_BOOLEAN_EXPR_KEYS, ACTION_RULE_BOOLEAN_EXPR_VARIANT_KEYS[value.kind], path7, errors);
    if (!Array.isArray(value.expressions) || value.expressions.length < 1 || value.expressions.length > 32)
      errors.push({ path: `${path7}.expressions`, code: "INVALID_ACTION_RULE_BOOLEAN_SET", message: "all/any requires 1 through 32 expressions." });
    else
      value.expressions.forEach((item, index) => validateRuleBooleanExpression(item, `${path7}.expressions[${index}]`, errors, depth + 1));
    return;
  }
  if (value.kind === "not") {
    checkVariantKeys(value, ACTION_RULE_BOOLEAN_EXPR_KEYS, ACTION_RULE_BOOLEAN_EXPR_VARIANT_KEYS.not, path7, errors);
    validateRuleBooleanExpression(value.expression, `${path7}.expression`, errors, depth + 1);
    return;
  }
  if (value.kind === "compare") {
    checkVariantKeys(value, ACTION_RULE_BOOLEAN_EXPR_KEYS, ACTION_RULE_BOOLEAN_EXPR_VARIANT_KEYS.compare, path7, errors);
    if (!["eq", "neq", "lt", "lte", "gt", "gte"].includes(String(value.operator)))
      errors.push({ path: `${path7}.operator`, code: "INVALID_ACTION_RULE_COMPARISON", message: "unsupported comparison operator." });
    validateRuleScalarExpression(value.left, `${path7}.left`, errors, depth + 1);
    validateRuleScalarExpression(value.right, `${path7}.right`, errors, depth + 1);
    return;
  }
  if (value.kind === "null_check") {
    checkVariantKeys(value, ACTION_RULE_BOOLEAN_EXPR_KEYS, ACTION_RULE_BOOLEAN_EXPR_VARIANT_KEYS.null_check, path7, errors);
    if (value.operator !== "is_null" && value.operator !== "is_not_null")
      errors.push({ path: `${path7}.operator`, code: "INVALID_ACTION_RULE_NULL_CHECK", message: "null check must be is_null or is_not_null." });
    validateRuleScalarExpression(value.value, `${path7}.value`, errors, depth + 1);
    return;
  }
  if (value.kind === "in") {
    checkVariantKeys(value, ACTION_RULE_BOOLEAN_EXPR_KEYS, ACTION_RULE_BOOLEAN_EXPR_VARIANT_KEYS.in, path7, errors);
    validateRuleScalarExpression(value.value, `${path7}.value`, errors, depth + 1);
    if (!Array.isArray(value.values) || value.values.length < 1 || value.values.length > 256)
      errors.push({ path: `${path7}.values`, code: "INVALID_ACTION_RULE_IN_SET", message: "in requires 1 through 256 reviewed scalar expressions." });
    else
      value.values.forEach((item, index) => validateRuleScalarExpression(item, `${path7}.values[${index}]`, errors, depth + 1));
    return;
  }
  if (value.kind === "exists") {
    checkVariantKeys(value, ACTION_RULE_BOOLEAN_EXPR_KEYS, ACTION_RULE_BOOLEAN_EXPR_VARIANT_KEYS.exists, path7, errors);
    if (!isSafeIdentifier(value.binding))
      errors.push({ path: `${path7}.binding`, code: "INVALID_ACTION_RULE_EXISTS_BINDING", message: "exists binding must be fixed." });
    validateRuleBooleanExpression(value.where, `${path7}.where`, errors, depth + 1);
    return;
  }
  errors.push({ path: `${path7}.kind`, code: "UNKNOWN_ACTION_RULE_BOOLEAN_OPERATOR", message: "unsupported boolean expression kind." });
}
function validateNamedAuthority(value, path7, names, label, errors) {
  if (!isDottedName(value))
    errors.push({ path: path7, code: `INVALID_${label}_NAME`, message: "name must be a fixed safe or qualified name." });
  else
    addUnique(names, value, path7, `DUPLICATE_${label}_NAME`, errors);
}
function isDottedName(value) {
  return typeof value === "string" && /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(value);
}
function isSafeUnit(value) {
  return typeof value === "string" && /^[A-Za-z][A-Za-z0-9_.-]{0,31}$/.test(value);
}
function validateArrayRecords(value, path7, keys, label, errors) {
  if (!Array.isArray(value)) {
    errors.push({ path: path7, code: `${label}_NOT_ARRAY`, message: `${path7} must be an array.` });
    return;
  }
  value.forEach((record2, index) => {
    const itemPath = `${path7}[${index}]`;
    if (!isRecord3(record2)) {
      errors.push({ path: itemPath, code: `${label}_NOT_OBJECT`, message: `${label.toLowerCase()} entry must be an object.` });
      return;
    }
    checkUnknownKeys(record2, keys, itemPath, errors);
  });
}
function validateFieldList(value, path7, code, errors, allowEmpty = false) {
  if (!Array.isArray(value) || !allowEmpty && value.length === 0) {
    errors.push({ path: path7, code, message: "field list must be a non-empty array of safe identifiers." });
    return;
  }
  const seen = /* @__PURE__ */ new Set();
  value.forEach((field, index) => {
    if (!isSafeIdentifier(field))
      errors.push({ path: `${path7}[${index}]`, code: "INVALID_FIELD_IDENTIFIER", message: "field names must be fixed safe identifiers." });
    else
      addUnique(seen, field, `${path7}[${index}]`, "DUPLICATE_FIELD", errors);
  });
}
function validateKeptOutExclusion(visible, keptOut, path7, errors) {
  if (!Array.isArray(visible) || !Array.isArray(keptOut))
    return;
  const visibleSet = new Set(visible);
  for (const field of keptOut) {
    if (visibleSet.has(field))
      errors.push({ path: `${path7}.kept_out_fields`, code: "KEPT_OUT_FIELD_VISIBLE", message: `kept-out field must not also be visible: ${String(field)}` });
  }
}
function validateModelWithheldExclusion(keptOut, modelWithheld, path7, errors) {
  if (!Array.isArray(keptOut) || !Array.isArray(modelWithheld))
    return;
  const keptOutSet = new Set(keptOut);
  for (const field of modelWithheld) {
    if (keptOutSet.has(field)) {
      errors.push({
        path: `${path7}.model_withheld_fields`,
        code: "MODEL_WITHHELD_FIELD_KEPT_OUT",
        message: `model-withheld field must not also be kept out: ${String(field)}`
      });
    }
  }
}
function validateNestedObject(value, keys, path7, errors) {
  if (!isRecord3(value)) {
    errors.push({ path: path7, code: "NESTED_VALUE_NOT_OBJECT", message: "nested value must be an object." });
    return;
  }
  checkUnknownKeys(value, keys, path7, errors);
}
function scanForInlineSecrets(value, path7, errors) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => scanForInlineSecrets(item, `${path7}[${index}]`, errors));
    return;
  }
  if (!isRecord3(value))
    return;
  for (const [key2, child] of Object.entries(value)) {
    const childPath = `${path7}.${key2}`;
    if (/database_url|read_url|write_url|connection_string|password|secret|token/i.test(key2) && typeof child === "string" && /(postgres(?:ql)?:\/\/|mysql:\/\/|Bearer\s+|[A-Za-z0-9+/=]{24,})/i.test(child)) {
      errors.push({ path: childPath, code: "INLINE_SECRET_OR_URL", message: "Contracts must not contain database URLs, passwords, bearer tokens, or secrets. Put runtime wiring in runner config/env vars." });
    }
    scanForInlineSecrets(child, childPath, errors);
  }
}
function checkUnknownKeys(value, allowed, path7, errors) {
  for (const key2 of Object.keys(value)) {
    if (allowed.has(key2) || isExtensionKey(key2))
      continue;
    errors.push({ path: `${path7}.${key2}`, code: "UNKNOWN_CORE_FIELD", message: `Unknown core field ${key2}. Use x-cloud-*, x-runner-*, or x-experimental-* for extensions.` });
  }
}
function checkVariantKeys(value, unionKeys, variantKeys, path7, errors) {
  for (const key2 of Object.keys(value)) {
    if (!unionKeys.has(key2) || variantKeys.has(key2) || isExtensionKey(key2))
      continue;
    errors.push({
      path: `${path7}.${key2}`,
      code: "INVALID_DISCRIMINATED_VARIANT_FIELD",
      message: `${key2} is not valid when kind/mode/source is ${String(value.kind ?? value.mode ?? value.source)}.`
    });
  }
}
function addUnique(seen, name4, path7, code, errors) {
  const value = String(name4);
  if (seen.has(value))
    errors.push({ path: path7, code, message: `Duplicate name: ${value}` });
  seen.add(value);
}
function isExtensionKey(key2) {
  return /^x-(cloud|runner|experimental)-[A-Za-z0-9_.-]+$/.test(key2);
}
function isRecord3(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}
function isSafeIdentifier(value) {
  return typeof value === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
}
function isQualifiedName(value) {
  return typeof value === "string" && /^[A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*$/.test(value);
}
function isQualifiedOrSafeName(value) {
  return isSafeIdentifier(value) || isQualifiedName(value);
}
function isSha256Digest(value) {
  return typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value);
}
function isCanonicalUtcInstant(value) {
  if (typeof value !== "string")
    return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}
function isCanonicalDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value))
    return false;
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day;
}
function isPositiveInteger(value) {
  return Number.isInteger(value) && Number(value) > 0;
}
function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}
function isJsonScalar(value) {
  return value === null || typeof value === "string" || typeof value === "boolean" || isFiniteNumber(value);
}

// ../synapsor-runner/packages/spec/dist/normalize.js
function normalizeContract(input) {
  assertValidContract(input);
  return sortJson(input);
}
function sortJson(value) {
  if (Array.isArray(value))
    return value.map(sortJson);
  if (!value || typeof value !== "object")
    return value;
  const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
  const output = {};
  for (const [key2, child] of entries)
    output[key2] = sortJson(child);
  return output;
}

// ../synapsor-runner/packages/postgres/src/index.ts
import { Pool, types as pgTypes } from "pg";

// ../synapsor-runner/packages/mcp-server/src/source-runtime.ts
import mysql from "mysql2/promise";

// ../synapsor-runner/packages/mcp-server/src/runtime-config.ts
import fs from "node:fs";
import path from "node:path";
function resolveRuntimeConfig(config, baseDir = process.cwd()) {
  const governance = config.governance?.connection_file ? { ...config.governance, connection_file: path.resolve(baseDir, config.governance.connection_file) } : config.governance;
  const generatedAuthority = config.generated_authority?.generation_lock_path ? { ...config.generated_authority, generation_lock_path: path.resolve(baseDir, config.generated_authority.generation_lock_path) } : config.generated_authority;
  const productionExplore = config.production_explore?.project_root ? { ...config.production_explore, project_root: path.resolve(baseDir, config.production_explore.project_root) } : config.production_explore;
  const actionRules = config.action_rules?.project_root ? { ...config.action_rules, project_root: path.resolve(baseDir, config.action_rules.project_root) } : config.action_rules;
  if (!Array.isArray(config.contracts) || config.contracts.length === 0) {
    if (governance === config.governance && generatedAuthority === config.generated_authority && productionExplore === config.production_explore && actionRules === config.action_rules) return config;
    return {
      ...config,
      ...governance ? { governance } : {},
      ...generatedAuthority ? { generated_authority: generatedAuthority } : {},
      ...productionExplore ? { production_explore: productionExplore } : {},
      ...actionRules ? { action_rules: actionRules } : {}
    };
  }
  const seenCapabilities = /* @__PURE__ */ new Map();
  const seenPolicies = /* @__PURE__ */ new Map();
  for (const [index, capability] of (config.capabilities ?? []).entries()) {
    rememberCapabilityName(seenCapabilities, capability.name, `embedded capabilities[${index}]`);
  }
  for (const [index, policy] of (config.policies ?? []).entries()) {
    rememberPolicyName(seenPolicies, policy.name, `embedded policies[${index}]`);
  }
  const resolved = {
    ...config,
    ...governance ? { governance } : {},
    ...generatedAuthority ? { generated_authority: generatedAuthority } : {},
    ...productionExplore ? { production_explore: productionExplore } : {},
    ...actionRules ? { action_rules: actionRules } : {},
    contexts: { ...config.contexts ?? {} },
    capabilities: [...config.capabilities ?? []],
    policies: [...config.policies ?? []]
  };
  for (const [contractIndex, contractPath] of config.contracts.entries()) {
    const fullPath = path.resolve(baseDir, contractPath);
    const contract = normalizeContract(JSON.parse(fs.readFileSync(fullPath, "utf8")));
    mergeContractIntoRuntimeConfig(resolved, contract, `contracts[${contractIndex}] ${contractPath}`, seenCapabilities, seenPolicies);
  }
  delete resolved.contracts;
  return resolved;
}
function rememberCapabilityName(seen, name4, origin) {
  const previous = seen.get(name4);
  if (previous) {
    throw new Error(`Duplicate capability ${name4}: ${origin} conflicts with ${previous}. Capability names must be unique across embedded runner config and referenced contracts.`);
  }
  seen.set(name4, origin);
}
function rememberPolicyName(seen, name4, origin) {
  const previous = seen.get(name4);
  if (previous) {
    throw new Error(`Duplicate policy ${name4}: ${origin} conflicts with ${previous}. Policy names must be unique across embedded runner config and referenced contracts.`);
  }
  seen.set(name4, origin);
}
function mergeContractIntoRuntimeConfig(config, contract, origin, seenCapabilities, seenPolicies) {
  const resources = new Map((contract.resources ?? []).map((resource) => [resource.name, resource]));
  const provenance = {
    digest: canonicalJsonDigest(contract),
    version: contract.metadata?.version ?? contract.spec_version
  };
  for (const context of contract.contexts) {
    if (!config.contexts) config.contexts = {};
    config.contexts[context.name] ??= runtimeContextFromSpec(context);
  }
  if (!config.trusted_context && contract.contexts.length === 1) {
    const [context] = contract.contexts;
    if (context) config.trusted_context = runtimeContextFromSpec(context);
  }
  if (!config.capabilities) config.capabilities = [];
  for (const [capabilityIndex, capability] of contract.capabilities.entries()) {
    rememberCapabilityName(seenCapabilities, capability.name, `${origin} capabilities[${capabilityIndex}]`);
    config.capabilities.push(runtimeCapabilityFromSpec(capability, resources, config, provenance));
  }
  if (contract.policies?.length) {
    if (!config.policies) config.policies = [];
    for (const [policyIndex, policy] of contract.policies.entries()) {
      rememberPolicyName(seenPolicies, policy.name, `${origin} policies[${policyIndex}]`);
      config.policies.push(policy);
    }
  }
}
function runtimeContextFromSpec(context) {
  const unsupportedSessionBinding = context.bindings.find((binding) => binding.source === "session");
  if (unsupportedSessionBinding) {
    throw new Error(
      `SESSION_BINDING_UNSUPPORTED: context ${context.name} binding ${unsupportedSessionBinding.name} uses canonical SESSION source, but Synapsor Runner has no generic web-session trust provider. Use ENVIRONMENT for local stdio, HTTP_CLAIM for verified HTTP JWT claims, or CLOUD_SESSION for verified Cloud-linked identity.`
    );
  }
  const tenantBinding = context.bindings.find((binding) => binding.name === context.tenant_binding) ?? context.bindings.find((binding) => binding.name === "tenant_id");
  const principalBinding = context.bindings.find((binding) => binding.name === context.principal_binding) ?? context.bindings.find((binding) => binding.name === "principal");
  const reviewedOrganization = context.bindings.find((binding) => binding.source === "reviewed_organization");
  const provider = context.bindings.some((binding) => binding.source === "environment") ? "environment" : context.bindings.some((binding) => binding.source === "cloud_session") ? "cloud_session" : context.bindings.some((binding) => binding.source === "http_claim") ? "http_claims" : context.bindings.some((binding) => binding.source === "static_dev") ? "static_dev" : reviewedOrganization ? "reviewed_organization" : (() => {
    throw new Error(`TRUSTED_CONTEXT_BINDING_UNSUPPORTED: context ${context.name} has no binding source supported by Synapsor Runner.`);
  })();
  return {
    provider,
    tenant_binding: context.tenant_binding,
    principal_binding: context.principal_binding,
    values: {
      ...tenantBinding?.source === "reviewed_organization" ? { tenant_id: tenantBinding.key, organization_id: tenantBinding.key } : tenantBinding ? { tenant_id_env: tenantBinding.key, tenant_id_key: tenantBinding.key } : {},
      ...principalBinding ? { principal_env: principalBinding.key, principal_key: principalBinding.key } : {}
    }
  };
}
function runtimeCapabilityFromSpec(capability, resources, config, provenance) {
  const subjectResource = capability.subject.resource ? resources.get(capability.subject.resource) : void 0;
  const source = resolveCapabilitySource(capability, config);
  const target = {
    schema: subjectResource?.schema ?? capability.subject.schema ?? "",
    table: subjectResource?.table ?? capability.subject.table ?? "",
    primary_key: subjectResource?.primary_key ?? capability.subject.primary_key ?? "",
    tenant_key: subjectResource?.tenant_key ?? capability.subject.tenant_key,
    principal_scope_key: capability.subject.principal_scope_key,
    single_tenant_dev: subjectResource?.single_tenant_dev ?? capability.subject.single_tenant_dev
  };
  const runtime = {
    name: capability.name,
    kind: capability.kind === "proposal" ? "proposal" : capability.kind === "aggregate_read" ? "aggregate_read" : "read",
    contract_provenance: provenance,
    ...capability.description ? { description: capability.description } : {},
    ...capability.returns_hint ? { returns_hint: capability.returns_hint } : {},
    source,
    context: capability.context,
    target,
    args: capability.args,
    lookup: capability.lookup ?? { id_from_arg: Object.keys(capability.args)[0] ?? "id" },
    visible_columns: capability.visible_fields,
    ...capability.kept_out_fields ? { kept_out_fields: capability.kept_out_fields } : {},
    ...capability.model_withheld_fields ? { model_withheld_fields: capability.model_withheld_fields } : {},
    evidence: capability.evidence?.required === false ? "optional" : "required",
    ...capability.max_rows ? { max_rows: capability.max_rows } : {},
    ...capability.aggregate ? { aggregate: capability.aggregate } : {},
    ...capability.protected_read ? { protected_read: capability.protected_read } : {},
    ...capability.proposal?.organization_scope ? { organization_scope: capability.proposal.organization_scope } : {}
  };
  if (capability.kind === "proposal" && capability.proposal) {
    runtime.patch = capability.proposal.patch;
    runtime.allowed_columns = capability.proposal.allowed_fields;
    runtime.numeric_bounds = capability.proposal.numeric_bounds;
    runtime.transition_guards = capability.proposal.transition_guards;
    runtime.reversibility = capability.proposal.reversibility;
    runtime.operation = capability.proposal.operation;
    runtime.conflict_guard = capability.proposal.conflict_guard;
    runtime.approval = capability.proposal.approval;
    runtime.execution = capability.proposal.execution;
    runtime.writeback = {
      mode: capability.proposal.writeback?.mode ?? "direct_sql",
      ...capability.proposal.writeback?.executor ? { executor: capability.proposal.writeback.executor } : {}
    };
    if (capability.proposal.writeback?.executor) {
      runtime.executor = capability.proposal.writeback.executor;
    }
  }
  return runtime;
}
function resolveCapabilitySource(capability, config) {
  if (capability.source) return capability.source;
  const sourceNames = Object.keys(config.sources ?? {});
  if (sourceNames.length === 1 && sourceNames[0]) return sourceNames[0];
  throw new Error(`contract capability ${capability.name} must set source when runner config has ${sourceNames.length} sources`);
}

// ../synapsor-runner/packages/mcp-server/src/semantic-action-schema.ts
import { z as z3 } from "zod";

// ../synapsor-runner/packages/mcp-server/src/scoped-catalog.ts
var CATALOG_LIMITS = Object.freeze({
  defaultPage: 5,
  maxPage: 20,
  queryCharacters: 256,
  queryTerms: 16,
  responseBytes: 16384,
  detailBytes: 12288,
  cursorMs: 3e5,
  sessionCalls: 80,
  sessionRecords: 300,
  sessionBytes: 262144,
  maxEntries: 1e4,
  maxSearchWork: 1e4,
  cursors: 128
});

// ../synapsor-runner/packages/mcp-server/src/owner-runtime-identity.ts
import { z as z4 } from "zod";
var id = z4.string().min(1).max(256).refine((value) => value === value.trim() && !/[\u0000-\u001f\u007f]/u.test(value));
var ownerRuntimeIdentitySchema = z4.object({
  subject: id,
  tenant_id: id,
  principal: id,
  agent_id: id,
  delegator: id,
  run_id: id,
  actor_digest: z4.string().regex(/^sha256:[a-f0-9]{64}$/u),
  expires_at_ms: z4.number().int().positive().safe()
}).strict();

// ../synapsor-runner/packages/mcp-server/src/analytics-output-schema.ts
import {
  z as z5
} from "zod";

// ../synapsor-runner/node_modules/.pnpm/zod-to-json-schema@3.25.2_zod@3.25.76/node_modules/zod-to-json-schema/dist/esm/selectParser.js
import { ZodFirstPartyTypeKind as ZodFirstPartyTypeKind3 } from "zod/v3";

// ../synapsor-runner/node_modules/.pnpm/zod-to-json-schema@3.25.2_zod@3.25.76/node_modules/zod-to-json-schema/dist/esm/parsers/array.js
import { ZodFirstPartyTypeKind } from "zod/v3";

// ../synapsor-runner/node_modules/.pnpm/zod-to-json-schema@3.25.2_zod@3.25.76/node_modules/zod-to-json-schema/dist/esm/parsers/record.js
import { ZodFirstPartyTypeKind as ZodFirstPartyTypeKind2 } from "zod/v3";

// ../synapsor-runner/node_modules/.pnpm/zod-to-json-schema@3.25.2_zod@3.25.76/node_modules/zod-to-json-schema/dist/esm/parsers/string.js
var ALPHA_NUMERIC = new Set("ABCDEFGHIJKLMNOPQRSTUVXYZabcdefghijklmnopqrstuvxyz0123456789");

// ../synapsor-runner/packages/mcp-server/src/analytics-output-schema.ts
var jsonScalarSchema = z5.union([
  z5.string(),
  z5.number().finite(),
  z5.boolean(),
  z5.null()
]);
var sha256Schema = z5.string().regex(/^sha256:[a-f0-9]{64}$/);
var runnerModeSchema = z5.enum(["read_only", "shadow", "review", "cloud"]);
var safeRecordSchema = z5.record(z5.unknown());
var fieldEgressSchema = z5.record(z5.object({
  model_egress: z5.enum(["visible", "withheld"])
}).strict());
var reviewedFieldMetadataSchema = z5.object({
  id: z5.string(),
  label: z5.string().max(64).optional(),
  description: z5.string().max(280).optional(),
  plan_reference: z5.literal("exact_id_only").optional(),
  semantic_status: z5.enum([
    "reviewed_vocabulary",
    "descriptive_identifier",
    "coded_values",
    "opaque_identifier"
  ]).optional(),
  operations: z5.object({
    return_value: z5.boolean(),
    model_egress: z5.enum(["visible", "withheld"]),
    filter_operators: z5.array(z5.enum(["eq", "neq", "lt", "lte", "gt", "gte", "in"])),
    sortable: z5.boolean(),
    groupable: z5.boolean(),
    aggregate_functions: z5.array(z5.enum([
      "sum",
      "avg",
      "stddev_samp",
      "stddev_pop",
      "var_samp",
      "var_pop"
    ])),
    presence_functions: z5.array(z5.enum(["null_count", "non_null_count", "completion_rate"])),
    count_distinct: z5.boolean(),
    time_buckets: z5.array(z5.enum([
      "hour",
      "day",
      "week",
      "month",
      "quarter",
      "year",
      "day_of_week"
    ]))
  }).strict().optional(),
  allowed_values: z5.array(jsonScalarSchema).optional()
}).strict();
var reviewedClientFieldMetadataSchema = z5.object({
  id: z5.string(),
  label: z5.string().max(64).optional(),
  description: z5.string().max(280).optional()
}).passthrough();
var exploreVocabularyCoverageSchema = z5.object({
  status: z5.enum(["ready", "review_advised", "review_required"]),
  model_facing_fields: z5.number().int().nonnegative(),
  fields_with_labels: z5.number().int().nonnegative(),
  fields_with_descriptions: z5.number().int().nonnegative(),
  fields_with_reviewed_vocabulary: z5.number().int().nonnegative(),
  opaque_resource_without_vocabulary: z5.boolean(),
  opaque_fields_without_vocabulary: z5.array(z5.string()),
  coded_fields_without_vocabulary: z5.array(z5.string())
}).strict();
var modelWithheldTokenSchema = z5.string().regex(/^\[withheld:[a-f0-9]{12}:[1-9][0-9]*\]$/);
var modelEgressResultSchema = z5.object({
  values_withheld: z5.literal(true),
  tokenized_columns: z5.array(z5.string()),
  token_scope: z5.literal("this_tool_response_only")
}).strict();
var scopedExploreMeasureFunctionSchema = z5.enum([
  "count",
  "count_distinct",
  "sum",
  "avg",
  "stddev_samp",
  "stddev_pop",
  "var_samp",
  "var_pop",
  "null_count",
  "non_null_count",
  "completion_rate",
  "reviewed_derived"
]);
var sequentialDerivedGrain = "one reviewed ordered time_bucket; dimensions are optional partitions";
var groupedDerivedGrain = "one or more reviewed dimensions and no time_bucket";
var scopedDerivedMeasureSchema = z5.object({
  name: z5.string(),
  label: z5.string(),
  shape: z5.enum([
    "ratio",
    "percentage",
    "per_unit_average",
    "child_count_total",
    "child_count_average",
    "running_total",
    "lag_absolute_change",
    "lag_percentage_change",
    "moving_average",
    "rank",
    "share_of_released_total"
  ]),
  effective_minimum_cohort_size: z5.number().int().min(5),
  calculation_stage: z5.enum([
    "after cohort validation",
    "scoped child count aggregated over reviewed parent cohorts",
    "after small-group suppression"
  ]),
  null_behavior: z5.literal("null when the reviewed denominator is zero or null").optional(),
  child_resource: z5.string().optional(),
  relationship: z5.string().optional(),
  parent_contributor_floor: z5.literal("applied before release").optional(),
  raw_child_rows_returned: z5.literal(false).optional(),
  required_grain: z5.enum([sequentialDerivedGrain, groupedDerivedGrain]).optional(),
  records_without_reviewed_time: z5.literal("omitted").optional(),
  suppressed_groups_included: z5.literal(false).optional(),
  fixed_window_size: z5.number().int().min(2).max(12).optional(),
  fixed_direction: z5.enum(["asc", "desc"]).optional()
}).strict().superRefine((value, context) => {
  const requireValue = (field, expected) => {
    if (value[field] !== expected) {
      context.addIssue({
        code: z5.ZodIssueCode.custom,
        path: [field],
        message: `${String(field)} must match the reviewed derived-measure shape`
      });
    }
  };
  if (["ratio", "percentage", "per_unit_average"].includes(value.shape)) {
    requireValue("calculation_stage", "after cohort validation");
    requireValue("null_behavior", "null when the reviewed denominator is zero or null");
    return;
  }
  if (value.shape === "child_count_total" || value.shape === "child_count_average") {
    requireValue("calculation_stage", "scoped child count aggregated over reviewed parent cohorts");
    if (!value.child_resource) requireValue("child_resource", "required");
    if (!value.relationship) requireValue("relationship", "required");
    requireValue("parent_contributor_floor", "applied before release");
    requireValue("raw_child_rows_returned", false);
    return;
  }
  requireValue("calculation_stage", "after small-group suppression");
  requireValue("suppressed_groups_included", false);
  if (["running_total", "lag_absolute_change", "lag_percentage_change", "moving_average"].includes(value.shape)) {
    requireValue("required_grain", sequentialDerivedGrain);
    requireValue("records_without_reviewed_time", "omitted");
    if (value.shape === "moving_average" && value.fixed_window_size === void 0) {
      requireValue("fixed_window_size", "required");
    }
    return;
  }
  requireValue("required_grain", groupedDerivedGrain);
  if (value.shape === "rank" && value.fixed_direction === void 0) {
    requireValue("fixed_direction", "required");
  }
});
var scopedNumericBandSchema = z5.object({
  name: z5.string(),
  label: z5.string(),
  field: z5.string(),
  relationship: z5.string().nullable(),
  edges: z5.array(z5.number().finite()).min(1).max(16),
  bucket_labels: z5.array(z5.string()).min(2).max(17)
}).strict();
var scopedAutoBandSchema = z5.object({
  field: z5.string(),
  methods: z5.array(z5.enum(["quantile", "equal_width"])).min(1).max(2),
  min_buckets: z5.number().int().min(2).max(16),
  max_buckets: z5.number().int().min(2).max(16),
  min_bucket_width: z5.number().positive().nullable().optional(),
  label_style: z5.enum(["ordinal", "rounded"]),
  label_round_to: z5.number().positive().nullable().optional(),
  model_selects: z5.array(z5.enum(["field", "method", "buckets"])).optional(),
  raw_edges_returned: z5.literal(false)
}).strict();
var scopedAutoBandResultSchema = z5.object({
  field: z5.string(),
  method: z5.enum(["quantile", "equal_width"]),
  requested_buckets: z5.number().int().min(2).max(16),
  effective_buckets: z5.number().int().nonnegative().max(16),
  reduced: z5.boolean(),
  label_style: z5.enum(["ordinal", "rounded"]),
  raw_edges_returned: z5.literal(false)
}).strict();
var scopedExploreTimeBucketSchema = z5.enum([
  "hour",
  "day",
  "week",
  "month",
  "quarter",
  "year",
  "day_of_week"
]);
var reviewedValueControlsSchema = z5.object({
  bucketed_fields: z5.array(z5.object({
    resource: z5.string(),
    field: z5.string(),
    output_field: z5.string(),
    bucket_returned: z5.boolean(),
    bucket_token: z5.string().regex(/^\[outside-reviewed-values(?:-[1-9][0-9]*)?\]$/).optional()
  }).strict()),
  excluded_fields: z5.array(z5.object({
    resource: z5.string(),
    field: z5.string(),
    effect: z5.literal("rows_outside_reviewed_values_excluded")
  }).strict()),
  source_values_exposed: z5.literal(false)
}).strict();
var runtimeErrorFields = {
  ok: z5.literal(false),
  code: z5.string().min(1),
  error: z5.string().min(1),
  retry_after_ms: z5.number().int().positive().optional()
};
var resultEnvelopeErrorSchema = z5.object({
  code: z5.string().min(1),
  message: z5.string().min(1),
  retryable: z5.boolean(),
  retry_after_ms: z5.number().int().positive().optional()
}).strict();
var evidenceHandleSchema = z5.object({
  bundle_id: z5.string().min(1),
  note: z5.string()
}).strict();
var observedSubjectReferenceSchema = z5.object({
  row_index: z5.number().int().nonnegative(),
  resource: z5.string().min(1),
  ref: z5.string().regex(/^obj_[A-Za-z0-9_-]{32,128}$/),
  expires_at: z5.string().datetime()
}).strict();
var resultEnvelopeMetaSchema = z5.object({
  tenant_id: z5.string().optional(),
  principal: z5.string().optional(),
  provenance: z5.string().optional(),
  canonical_capability: z5.string().min(1),
  reporting_timezone: z5.literal("UTC").optional()
}).strict();
var protectedQueryAuditSchema = z5.object({
  query_fingerprint: sha256Schema.optional(),
  result_values_persisted: z5.literal(false),
  trusted_values_persisted: z5.literal(false),
  returned_rows_or_groups: z5.number().int().nonnegative(),
  returned_cells: z5.number().int().nonnegative()
}).strict();
var protectedTrustedContextSchema = z5.object({
  tenant_bound: z5.boolean(),
  organization_bound: z5.boolean().optional(),
  principal_bound: z5.boolean(),
  provenance: z5.string()
}).strict();
var legacyTrustedContextSchema = z5.object({
  tenant_id: z5.string(),
  principal: z5.string(),
  provenance: z5.string()
}).strict();
var scopedExploreResultSchema = z5.object({
  status: z5.enum(["ok", "empty", "fully_suppressed", "incomplete_comparison"]),
  counted_entity: z5.object({
    resource: z5.string(),
    primary_key: z5.string(),
    semantics: z5.string()
  }).strict(),
  grain: z5.discriminatedUnion("kind", [
    z5.object({
      kind: z5.literal("rows"),
      selected_fields: z5.array(z5.string()),
      maximum_rows: z5.number().int().positive()
    }).strict(),
    z5.object({
      kind: z5.literal("aggregate_groups"),
      time_bucket: z5.object({
        field: z5.string(),
        bucket: scopedExploreTimeBucketSchema,
        relationship: z5.string().nullable(),
        output_alias: z5.string()
      }).strict().nullable()
    }).strict(),
    z5.object({
      kind: z5.literal("period_comparison"),
      reviewed_time_field: z5.string(),
      reviewed_time_bucket: scopedExploreTimeBucketSchema.nullable(),
      periods: z5.array(z5.object({
        id: z5.enum(["period_1", "period_2"]),
        start_inclusive: z5.string().datetime(),
        end_exclusive: z5.string().datetime()
      }).strict()).length(2)
    }).strict()
  ]),
  measures: z5.array(z5.object({
    alias: z5.string(),
    function: scopedExploreMeasureFunctionSchema,
    field: z5.string().nullable(),
    relationship: z5.string().nullable(),
    derived_measure: z5.string().optional(),
    contributor_cohort: z5.enum([
      "non-null values for this reviewed field",
      "reviewed root rows"
    ]),
    comparison_outputs: z5.object({
      period_1: z5.string(),
      period_2: z5.string(),
      absolute_change: z5.string(),
      percentage_change: z5.string(),
      percentage_change_denominator: z5.literal("absolute period_1 value"),
      percentage_change_when_period_1_is_zero: z5.null()
    }).strict().optional()
  }).strict()),
  dimensions: z5.array(z5.object({
    alias: z5.string(),
    field: z5.string(),
    relationship: z5.string().nullable(),
    numeric_band: z5.string().optional(),
    auto_band: z5.object({
      method: z5.enum(["quantile", "equal_width"]),
      requested_buckets: z5.number().int().min(2).max(16),
      reviewed_bucket_range: z5.tuple([
        z5.number().int().min(2).max(16),
        z5.number().int().min(2).max(16)
      ]),
      label_style: z5.enum(["ordinal", "rounded"]),
      raw_edges_returned: z5.literal(false)
    }).strict().optional(),
    null_label: z5.literal("Not set (database null)")
  }).strict()),
  filters: z5.array(z5.object({
    field: z5.string(),
    operator: z5.enum(["eq", "neq", "lt", "lte", "gt", "gte", "in"]),
    relationship: z5.string().nullable(),
    value_type: z5.enum(["list", "null", "string", "number", "boolean"]),
    value_count: z5.number().int().positive(),
    value_returned_in_metadata: z5.literal(false)
  }).strict()),
  adaptive_numeric_bands: z5.array(scopedAutoBandResultSchema).optional(),
  relationship_paths: z5.array(z5.object({
    id: z5.string(),
    target_resource: z5.string(),
    cardinality: z5.literal("many_to_one"),
    path_depth: z5.number().int().positive(),
    unmatched_rows: z5.enum(["exclude", "keep_null"])
  }).strict()),
  reporting_timezone: z5.object({
    name: z5.string(),
    authority_bound: z5.boolean(),
    legacy_boundary_without_timezone_binding: z5.boolean()
  }).strict(),
  freshness: z5.object({
    execution_started_at: z5.string().datetime(),
    observed_at: z5.string().datetime(),
    snapshot_consistency: z5.literal("single_read_only_transaction"),
    upstream_source_freshness: z5.literal("not_asserted")
  }).strict(),
  suppression: z5.object({
    minimum_cohort_size: z5.number().int().positive().nullable(),
    effective_minimum_cohort_size: z5.number().int().positive().nullable(),
    contributor_aware: z5.boolean(),
    minimum_cohort_overridden: z5.literal(true).optional(),
    outcome: z5.enum(["ok", "empty", "fully_suppressed", "incomplete_comparison"]),
    suppressed_groups: z5.number().int().nonnegative(),
    incomplete_comparison_groups: z5.number().int().nonnegative(),
    suppression_aware_totals_returned: z5.literal(false)
  }).strict(),
  reviewed_value_controls: reviewedValueControlsSchema.optional(),
  returned: z5.object({
    rows_or_groups: z5.number().int().nonnegative(),
    cells: z5.number().int().nonnegative(),
    bytes: z5.number().int().nonnegative()
  }).strict(),
  remaining_budgets: z5.object({
    queries: z5.number().int().nonnegative(),
    rate_window_requests: z5.number().int().nonnegative(),
    extracted_cells: z5.number().int().nonnegative(),
    differencing_queries: z5.number().int().nonnegative().nullable(),
    differencing_variants_for_root_resource: z5.object({
      resource: z5.string().min(1),
      used: z5.number().int().nonnegative(),
      limit: z5.number().int().positive(),
      remaining: z5.number().int().nonnegative(),
      window: z5.literal("rolling_24_hours"),
      persists_across_sessions: z5.literal(true)
    }).strict().nullable()
  }).strict(),
  query_audit_handle: sha256Schema,
  source_database_changed: z5.literal(false)
}).strict();
var scopedDescribeOutcomeSchema = z5.discriminatedUnion("type", [
  z5.object({ type: z5.literal("success") }).strict(),
  z5.object({
    type: z5.literal("refusal"),
    code: z5.string().min(1),
    message: z5.string().min(1),
    details: safeRecordSchema.optional()
  }).strict()
]);
var scopedExploreOutcomeSchema = z5.discriminatedUnion("type", [
  z5.object({
    type: z5.literal("success"),
    status: z5.enum(["ok", "empty", "fully_suppressed", "incomplete_comparison"]),
    result: scopedExploreResultSchema
  }).strict(),
  z5.object({
    type: z5.literal("refusal"),
    code: z5.string().min(1),
    message: z5.string().min(1),
    details: safeRecordSchema.optional()
  }).strict()
]);
var scopedExploreDescribeOutputSchema = z5.object({
  ok: z5.boolean(),
  outcome: scopedDescribeOutcomeSchema,
  error_code: z5.string().optional(),
  message: z5.string().optional(),
  details: safeRecordSchema.optional(),
  source_database_changed: z5.literal(false).optional(),
  boundary_digest: sha256Schema.optional(),
  active_boundary_set_digest: sha256Schema.optional(),
  boundary_name: z5.string().optional(),
  organization_scope: z5.object({
    mode: z5.literal("single_organization"),
    tenant_filter: z5.literal("not_applicable"),
    organization_identity: z5.literal("fixed_outside_model_arguments")
  }).strict().optional(),
  boundaries: z5.array(z5.object({
    name: z5.string(),
    digest: sha256Schema,
    table_count: z5.number().int().positive(),
    resources: z5.array(z5.string())
  }).strict()).optional(),
  pack: z5.string().optional(),
  reporting_timezone: z5.object({
    name: z5.string(),
    authority_bound: z5.boolean()
  }).strict().optional(),
  relative_time_windows: z5.object({
    available: z5.boolean(),
    reporting_timezone: z5.literal("UTC").nullable(),
    windows: z5.array(z5.enum([
      "today",
      "yesterday",
      "last_7_days",
      "last_30_days",
      "last_90_days",
      "this_week",
      "previous_week",
      "this_month",
      "previous_month",
      "this_quarter",
      "previous_quarter",
      "this_year",
      "day_to_date",
      "week_to_date",
      "month_to_date",
      "quarter_to_date",
      "year_to_date"
    ])),
    comparison_partners: z5.array(z5.enum([
      "preceding_period",
      "same_period_last_year"
    ])),
    range_semantics: z5.literal("half-open [start, end)"),
    week_starts_on: z5.literal("Monday"),
    model_supplied_date_arithmetic: z5.literal(false)
  }).strict().optional(),
  vocabulary_policy: z5.object({
    reviewed_metadata_is_semantic_only: z5.literal(true),
    exact_ids_required_in_plans: z5.literal(true),
    opaque_identifier_behavior: z5.literal(
      "do_not_guess; ask the operator to add a reviewed label or description"
    ),
    coded_value_behavior: z5.literal(
      "do_not_infer_business_meaning_from_codes; use exact codes only when the question names them or reviewed metadata explains them"
    )
  }).strict().optional(),
  resources: z5.array(z5.object({
    boundary_name: z5.string().optional(),
    id: z5.string(),
    label: z5.string().max(64).optional(),
    description: z5.string().max(280).optional(),
    vocabulary: exploreVocabularyCoverageSchema.optional(),
    primary_key: z5.string(),
    fields: z5.array(reviewedFieldMetadataSchema),
    field_egress: fieldEgressSchema,
    selectable_fields: z5.array(z5.string()),
    filterable_fields: z5.array(z5.string()),
    filter_operators: z5.record(z5.array(z5.string())),
    sortable_fields: z5.array(z5.string()),
    groupable_fields: z5.array(z5.string()),
    aggregate_measures: z5.array(z5.string()),
    aggregate_measure_functions: z5.record(z5.array(scopedExploreMeasureFunctionSchema)),
    presence_measure_fields: z5.array(z5.string()),
    presence_measure_functions: z5.array(scopedExploreMeasureFunctionSchema),
    derived_measures: z5.array(scopedDerivedMeasureSchema),
    numeric_bands: z5.array(scopedNumericBandSchema),
    auto_bands: z5.array(scopedAutoBandSchema).optional(),
    count_distinct_fields: z5.array(z5.string()),
    time_bucket_fields: z5.record(z5.array(z5.string())),
    relative_time_window_fields: z5.array(z5.string()).optional(),
    time_coverage: z5.record(z5.object({
      status: z5.enum(["available", "empty", "withheld_below_minimum_cohort", "unavailable"]),
      start_date: z5.string().optional(),
      end_date: z5.string().optional(),
      reporting_timezone: z5.enum(["UTC", "database_session"]).optional()
    }).strict()),
    field_types: z5.record(z5.string()),
    field_enums: z5.record(z5.array(jsonScalarSchema)),
    kept_out_field_count: z5.number().int().nonnegative(),
    relationships: z5.array(z5.object({
      id: z5.string(),
      activation: z5.enum(["active", "review_required"]),
      operator_review_required: z5.boolean(),
      target_resource: z5.string(),
      target_label: z5.string().max(64).optional(),
      target_description: z5.string().max(280).optional(),
      vocabulary: exploreVocabularyCoverageSchema.optional(),
      cardinality: z5.literal("many_to_one"),
      counted_entity: z5.string(),
      path_depth: z5.number().int().positive(),
      path: z5.object({
        resources: z5.array(z5.string()).min(2),
        via_columns: z5.array(z5.array(z5.string()).min(1)).min(1)
      }).strict(),
      nullable: z5.boolean(),
      unmatched_rows: z5.enum(["exclude", "keep_null"]),
      structural_evidence: z5.array(z5.object({
        constraint_name: z5.string(),
        source_resource: z5.string(),
        target_resource: z5.string(),
        source_columns: z5.array(z5.string()),
        target_columns: z5.array(z5.string()),
        target_uniqueness: z5.object({
          kind: z5.string(),
          name: z5.string(),
          columns: z5.array(z5.string())
        }).passthrough(),
        nullable: z5.boolean(),
        cardinality: z5.literal("many_to_one")
      }).strict()),
      field_egress: fieldEgressSchema,
      fields: z5.array(reviewedFieldMetadataSchema),
      filterable_fields: z5.array(z5.string()),
      filter_operators: z5.record(z5.array(z5.string())),
      groupable_fields: z5.array(z5.string()),
      aggregate_measures: z5.array(z5.string()),
      aggregate_measure_functions: z5.record(z5.array(scopedExploreMeasureFunctionSchema)),
      presence_measure_fields: z5.array(z5.string()),
      presence_measure_functions: z5.array(scopedExploreMeasureFunctionSchema),
      derived_measures: z5.array(scopedDerivedMeasureSchema),
      count_distinct_fields: z5.array(z5.string()),
      time_bucket_fields: z5.record(z5.array(z5.string())),
      relative_time_window_fields: z5.array(z5.string()).optional(),
      field_types: z5.record(z5.string()),
      field_enums: z5.record(z5.array(jsonScalarSchema)).optional()
    }).strict()),
    minimum_cohort_size: z5.number().int().positive(),
    minimum_cohort_overridden: z5.literal(true).optional(),
    maximum_rows: z5.number().int().positive(),
    maximum_groups: z5.number().int().positive(),
    suggested_questions: z5.array(z5.object({
      text: z5.string(),
      measure: z5.object({
        function: scopedExploreMeasureFunctionSchema,
        field: z5.string().optional(),
        relationship: z5.string().optional()
      }).strict(),
      dimension: z5.union([
        z5.string(),
        z5.object({
          field: z5.string(),
          relationship: z5.string().optional()
        }).strict()
      ]).optional(),
      time_field: z5.string().optional(),
      time_bucket: scopedExploreTimeBucketSchema.optional(),
      relationship_review_required: z5.boolean().optional()
    }).strict())
  }).strict()).optional(),
  next_cursor: z5.union([z5.number().int().nonnegative(), z5.string().regex(/^cur_[A-Za-z0-9_-]{43}$/u)]).nullable().optional(),
  raw_sql_available: z5.literal(false).optional(),
  source_rows_available_before_activation: z5.literal(false).optional()
}).strict();
var scopedExploreClientDescribeOutcomeSchema = z5.discriminatedUnion("type", [
  z5.object({ type: z5.literal("success") }).strict(),
  z5.object({
    type: z5.literal("refusal"),
    code: z5.string().min(1),
    message: z5.string().min(1),
    details: safeRecordSchema.optional()
  }).strict()
]);
var scopedExploreClientDescribeResourceSchema = z5.object({
  id: z5.string().min(1),
  label: z5.string().max(64).optional(),
  description: z5.string().max(280).optional(),
  fields: z5.array(reviewedClientFieldMetadataSchema).optional()
}).passthrough();
var scopedExploreDescribeToolOutputSchema = z5.object({
  ok: z5.boolean(),
  outcome: scopedExploreClientDescribeOutcomeSchema.optional(),
  error_code: z5.string().optional(),
  message: z5.string().optional(),
  details: safeRecordSchema.optional(),
  source_database_changed: z5.literal(false).optional(),
  resources: z5.array(scopedExploreClientDescribeResourceSchema).optional(),
  next_cursor: z5.union([z5.number().int().nonnegative(), z5.string().regex(/^cur_[A-Za-z0-9_-]{43}$/u)]).nullable().optional(),
  catalog_view: z5.enum(["resource_index", "resource_detail"]).optional(),
  metadata_only: z5.literal(true).optional(),
  contains_source_values: z5.literal(false).optional(),
  next_action: z5.string().optional()
}).passthrough();
var scopedExploreQueryOutputSchema = z5.object({
  ok: z5.boolean(),
  outcome: scopedExploreOutcomeSchema,
  error_code: z5.string().optional(),
  message: z5.string().optional(),
  details: safeRecordSchema.optional(),
  kind: z5.enum(["rows", "aggregate"]).optional(),
  counted_entity: z5.object({
    resource: z5.string(),
    primary_key: z5.string(),
    semantics: z5.string()
  }).strict().optional(),
  boundary_digest: sha256Schema.optional(),
  active_boundary_set_digest: sha256Schema.optional(),
  boundary_name: z5.string().optional(),
  source_database_changed: z5.literal(false),
  untrusted_data: z5.literal(true).optional(),
  untrusted_data_notice: z5.string().optional(),
  data: z5.array(z5.record(jsonScalarSchema)).optional(),
  subjects: z5.array(observedSubjectReferenceSchema).max(100).optional(),
  model_egress: z5.object({
    values_withheld: z5.literal(true),
    tokenized_columns: z5.array(z5.string()),
    token_scope: z5.literal("this_tool_response_only")
  }).strict().optional(),
  privacy: z5.object({
    minimum_cohort_size: z5.number().int().positive().nullable(),
    effective_minimum_cohort_size: z5.number().int().positive().nullable(),
    contributor_aware_measures: z5.array(z5.number().int().nonnegative()),
    minimum_cohort_overridden: z5.literal(true).optional(),
    suppressed_groups: z5.number().int().nonnegative(),
    totals_returned: z5.literal(false),
    auto_bands: z5.array(scopedAutoBandResultSchema).optional(),
    reviewed_value_controls: reviewedValueControlsSchema.optional()
  }).strict().optional(),
  audit: z5.object({
    query_fingerprint: sha256Schema,
    evidence_bundle_id: z5.string().min(1),
    returned_rows_or_groups: z5.number().int().nonnegative(),
    returned_cells: z5.number().int().nonnegative(),
    persisted_result_values: z5.literal(false)
  }).strict().optional(),
  evidence_bundle_id: z5.string().min(1).optional(),
  evidence_resource: z5.string().min(1).optional(),
  protect: z5.object({
    token: z5.string().min(1),
    expires_at: z5.string().datetime(),
    action: z5.string()
  }).strict().optional()
}).strict();
var scopedExploreClientResultEnvelopeSchema = z5.object({
  query_audit_handle: sha256Schema.optional()
}).passthrough();
var scopedExploreClientPrivacyEnvelopeSchema = z5.object({
  reviewed_value_controls: reviewedValueControlsSchema.optional()
}).passthrough();
var scopedExploreClientOutcomeSchema = z5.discriminatedUnion("type", [
  z5.object({
    type: z5.literal("success"),
    status: z5.enum(["ok", "empty", "fully_suppressed", "incomplete_comparison"]),
    result: scopedExploreClientResultEnvelopeSchema
  }).strict(),
  z5.object({
    type: z5.literal("refusal"),
    code: z5.string().min(1),
    message: z5.string().min(1),
    details: safeRecordSchema.optional()
  }).strict()
]);
var scopedExploreQueryToolOutputSchema = z5.object({
  ok: z5.boolean(),
  outcome: scopedExploreClientOutcomeSchema,
  error_code: z5.string().optional(),
  message: z5.string().optional(),
  details: safeRecordSchema.optional(),
  source_database_changed: z5.literal(false),
  data: z5.array(z5.record(jsonScalarSchema)).optional(),
  subjects: z5.array(observedSubjectReferenceSchema).max(100).optional(),
  privacy: scopedExploreClientPrivacyEnvelopeSchema.optional(),
  audit: safeRecordSchema.optional()
}).passthrough();

// ../synapsor-runner/packages/mcp-server/src/analytics-catalog.ts
import {
  z as z7
} from "zod";

// ../synapsor-runner/packages/mcp-server/src/tool-input-schema.ts
import {
  z as z6
} from "zod";

// ../synapsor-runner/packages/mcp-server/src/delegated-semantic-runtime.ts
import { z as z11 } from "zod";

// ../synapsor-runner/packages/mcp-server/src/owner-policy-language.ts
import { z as z8 } from "zod";
var name = z8.string().regex(/^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/u);
var text2 = z8.string().min(1).max(240).refine((value) => !/[\u0000-\u001f\u007f]/u.test(value));
var digest3 = z8.string().regex(/^sha256:[a-f0-9]{64}$/u);
var scalar4 = z8.union([z8.string().max(256), z8.number().finite().safe(), z8.boolean()]);
var compare = z8.enum(["eq", "neq", "lt", "lte", "gt", "gte"]);
var ownerPredicateSchema = z8.lazy(() => z8.union([
  z8.object({ kind: z8.literal("all"), conditions: z8.array(ownerPredicateSchema).min(1).max(16) }).strict(),
  z8.object({ kind: z8.literal("any"), conditions: z8.array(ownerPredicateSchema).min(1).max(16) }).strict(),
  z8.object({ kind: z8.literal("not"), condition: ownerPredicateSchema }).strict(),
  z8.object({ kind: z8.literal("compare"), fact: name, operator: compare, value: scalar4 }).strict(),
  z8.object({ kind: z8.literal("compare_facts"), fact: name, operator: compare, other_fact: name }).strict(),
  z8.object({ kind: z8.literal("one_of"), fact: name, values: z8.array(scalar4).min(1).max(32) }).strict(),
  z8.object({ kind: z8.literal("is_present"), fact: name }).strict()
]));
var ownerFactSchema = z8.object({
  name,
  title: text2,
  source: z8.discriminatedUnion("kind", [
    z8.object({ kind: z8.literal("field"), binding: name, field: name }).strict(),
    z8.object({ kind: z8.literal("derived"), name }).strict(),
    z8.object({ kind: z8.literal("input"), name }).strict(),
    z8.object({ kind: z8.literal("trusted"), binding: z8.literal("transaction_time") }).strict()
  ]),
  operators: z8.array(z8.enum(["eq", "neq", "lt", "lte", "gt", "gte", "one_of", "is_present"])).min(1).max(8),
  literal_range: z8.object({ minimum: z8.number().safe(), maximum: z8.number().safe() }).strict().optional(),
  literal_values: z8.array(scalar4).min(1).max(32).optional()
}).strict();
var ownerBudgetSchema = z8.object({
  meter: name,
  title: text2,
  scope: z8.enum(["tenant", "tenant_principal"]),
  unit: z8.string().regex(/^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/u),
  // All values are already in reviewed integral units. Money uses ISO:minor;
  // no implicit currency conversion, fees or refund accounting is supported.
  scale: z8.literal(1),
  maximum: z8.number().int().nonnegative().safe(),
  window_ms: z8.number().int().positive().max(366 * 864e5)
}).strict();
var ownerBudgetChargeSchema = z8.discriminatedUnion("kind", [
  z8.object({ meter: name, kind: z8.literal("effect_count") }).strict(),
  z8.object({ meter: name, kind: z8.literal("effect_field"), field: name }).strict()
]);
var ownerPolicyParentSchema = z8.object({
  schema_version: z8.literal("synapsor.owner-policy-parent.v1"),
  agents: z8.array(name).min(1).max(64),
  budgets: z8.array(ownerBudgetSchema).min(1).max(8).optional(),
  outcomes: z8.array(z8.object({
    outcome: name,
    compiled_plan_digest: digest3,
    facts: z8.array(ownerFactSchema).min(1).max(32),
    require: ownerPredicateSchema.optional(),
    allow_automatic_approval: z8.boolean(),
    budget_charges: z8.array(ownerBudgetChargeSchema).min(1).max(8).optional()
  }).strict()).min(1).max(32)
}).strict();
var ownerPolicyDefinitionSchema = z8.object({
  schema_version: z8.literal("synapsor.owner-policy.v1"),
  agents: z8.array(name).min(1).max(64),
  budget_limits: z8.array(z8.object({ meter: name, maximum: z8.number().int().nonnegative().safe() }).strict()).min(1).max(8).optional(),
  rules: z8.array(z8.object({
    outcome: name,
    require: ownerPredicateSchema,
    approval: z8.enum(["inherit", "human"]),
    auto_approve_when: ownerPredicateSchema.optional()
  }).strict()).min(1).max(32)
}).strict();

// ../synapsor-runner/packages/mcp-server/src/owner-policy-records.ts
import { z as z10 } from "zod";

// ../synapsor-runner/packages/mcp-server/src/policy-management-identity.ts
import { z as z9 } from "zod";
var id2 = z9.string().min(1).max(256).refine((value) => value === value.trim() && !/[\u0000-\u001f\u007f]/u.test(value));
var policyOwnerScopeSchema = z9.discriminatedUnion("level", [
  z9.object({ level: z9.literal("operator") }).strict(),
  z9.object({ level: z9.literal("tenant"), tenant_id: id2 }).strict(),
  z9.object({ level: z9.literal("principal"), tenant_id: id2, principal: id2 }).strict()
]);
var permission = z9.enum(["inspect", "draft", "activate", "revoke", "audit"]);
var policyManagerGrantSchema = z9.object({
  subject: id2,
  actor_kind: z9.enum(["human", "agent", "service"]),
  tenant_id: id2,
  scope: z9.discriminatedUnion("mode", [
    z9.object({ mode: z9.literal("personal") }).strict(),
    z9.object({ mode: z9.literal("exact"), scope: policyOwnerScopeSchema }).strict(),
    z9.object({ mode: z9.literal("deployment") }).strict()
  ]),
  permissions: z9.array(permission).min(1).max(5)
}).strict().superRefine((grant, context) => {
  if (new Set(grant.permissions).size !== grant.permissions.length) context.addIssue({ code: "custom", message: "Duplicate management permission" });
  if (grant.actor_kind !== "human" && grant.permissions.some((p2) => p2 === "activate" || p2 === "revoke")) {
    context.addIssue({ code: "custom", message: "Policy activation and revocation require an authenticated human" });
  }
  if (grant.actor_kind !== "human" && grant.scope.mode === "deployment") {
    context.addIssue({ code: "custom", message: "Deployment-wide management requires an authenticated human" });
  }
});

// ../synapsor-runner/packages/mcp-server/src/owner-policy-records.ts
var name2 = z10.string().regex(/^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/u);
var id3 = z10.string().min(1).max(256).refine((value) => value === value.trim() && !/[\u0000-\u001f\u007f]/u.test(value));
var digest4 = z10.string().regex(/^sha256:[a-f0-9]{64}$/u);
var runtimeBinding = z10.object({
  agent: name2,
  delegator: id3,
  owner: policyOwnerScopeSchema,
  policies: z10.array(z10.object({ scope: policyOwnerScopeSchema, name: name2 }).strict()).min(1).max(8),
  expires_at: z10.string().datetime().optional()
}).strict();
function sameOwnerScope(a2, b) {
  return canonicalJsonDigest(a2) === canonicalJsonDigest(b);
}
var policyManagementParentSchema = z10.object({
  schema_version: z10.literal("synapsor.policy-management-parent.v1"),
  managers: z10.array(policyManagerGrantSchema).max(256),
  delegation: ownerPolicyParentSchema,
  agent_owners: z10.array(z10.object({ agent: name2, scope: policyOwnerScopeSchema }).strict()).min(1).max(256),
  // No binding means no delegated runtime authority. Each selected layer is
  // mandatory; revocation never silently reverts to an unrestricted default.
  runtime_delegations: z10.array(runtimeBinding).max(256).optional()
}).strict().superRefine((parent, context) => {
  const identities = /* @__PURE__ */ new Set();
  for (const binding of parent.runtime_delegations ?? []) {
    const identity = canonicalJsonDigest({ agent: binding.agent, delegator: binding.delegator, owner: binding.owner });
    if (identities.has(identity) || binding.owner.level === "operator" || !parent.delegation.agents.includes(binding.agent)) {
      context.addIssue({ code: "custom", message: "Invalid or duplicate runtime delegation" });
    }
    identities.add(identity);
    const keys = /* @__PURE__ */ new Set();
    for (const policy of binding.policies) {
      const scope2 = policy.scope, owner = binding.owner, key2 = canonicalJsonDigest(policy);
      const ancestor = scope2.level === "tenant" && owner.level !== "operator" && scope2.tenant_id === owner.tenant_id;
      if (keys.has(key2) || scope2.level === "operator" || !ancestor && !sameOwnerScope(scope2, owner) || !parent.agent_owners.some((entry) => entry.agent === binding.agent && sameOwnerScope(entry.scope, scope2))) {
        context.addIssue({ code: "custom", message: "Runtime policy must be a unique authorized owner or tenant ancestor" });
      }
      keys.add(key2);
    }
  }
});
var managedDelegationSchema = z10.object({
  schema_version: z10.literal("synapsor.managed-owner-policy.v1"),
  parent_revision_id: z10.string().min(1).max(256),
  parent_authority_digest: digest4,
  parent_name: name2,
  definition: ownerPolicyDefinitionSchema,
  compiled_digest: digest4
}).strict();

// ../synapsor-runner/packages/mcp-server/src/delegated-semantic-runtime.ts
var digest5 = z11.string().regex(/^sha256:[a-f0-9]{64}$/u);
var attestationSchema = z11.object({
  schema_version: z11.literal("synapsor.delegated-proposal-context.v1"),
  deployment_id: z11.string().min(1).max(256),
  parent_name: z11.string().min(1).max(128),
  proposal_id: z11.string().min(1).max(256),
  actor: ownerRuntimeIdentitySchema,
  chain_digest: digest5,
  compiled_plan_digest: digest5,
  effect_digest: digest5,
  inputs_digest: digest5,
  approval: z11.enum(["inherit", "human"]),
  valid_until: z11.string().datetime()
}).strict();

// ../synapsor-runner/packages/mcp-server/src/policy-management.ts
import { z as z12 } from "zod";
var name3 = z12.string().regex(/^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/u);
var scopePageInput = z12.object({
  query: z12.string().max(256).optional(),
  limit: z12.number().int().min(1).max(20).optional(),
  after: z12.string().regex(/^ps_[A-Za-z0-9_-]{43}$/u).optional()
}).strict();

// ../synapsor-runner/packages/mcp-server/src/owner-policy-parent-model-schema.ts
import { z as z13 } from "zod";
var ownerPolicyParentModelResultSchema = z13.discriminatedUnion("state", [
  z13.object({ state: z13.literal("clarification"), question: z13.string().min(1).max(600) }).strict(),
  z13.object({
    state: z13.literal("candidate"),
    delegation: ownerPolicyParentSchema,
    summary: z13.string().min(1).max(1200)
  }).strict()
]);

// ../synapsor-runner/packages/mcp-server/src/policy-management-tools.ts
import { z as z14 } from "zod";
var POLICY_VIEW = "agent_rules";
var POLICY_REVISION_OUTCOME = "agent_rules.propose_revision";
var view = z14.literal(POLICY_VIEW);
var page = { cursor: z14.string().regex(/^cur_[A-Za-z0-9_-]{43}$/u).optional(), limit: z14.number().int().min(1).max(20).optional() };
var describe = z14.object({ policy_view: view }).strict();
var explore = z14.object({ policy_view: view, section: z14.enum(["summary", "active_rules", "draft_rules", "vocabulary", "budgets"]), ...page }).strict();
var revise = z14.object({
  policy_view: view,
  outcome: z14.literal(POLICY_REVISION_OUTCOME),
  control_ref: z14.string().regex(/^pol_[A-Za-z0-9_-]{43}$/u),
  definition: z14.unknown()
}).strict();

// ../synapsor-runner/packages/mcp-server/src/http-security.ts
import {
  OAuthProtectedResourceMetadataSchema
} from "@modelcontextprotocol/sdk/shared/auth.js";
import {
  isInitializeRequest
} from "@modelcontextprotocol/sdk/types.js";

// ../synapsor-runner/packages/schema-inspector/src/index.ts
import mysql2 from "mysql2/promise";
import { Pool as Pool2 } from "pg";

// ../synapsor-runner/packages/schema-inspector/src/sensitivity.ts
var HIGH_CONFIDENCE_RULES = [
  rule(
    "credential_or_secret",
    "The field name or description indicates credentials, authentication material, or a secret.",
    [
      "password",
      "passwordhash",
      "passwd",
      "passphrase",
      "secret",
      "token",
      "apikey",
      "accesskey",
      "privatekey",
      "credential",
      "oauth",
      "cookie",
      "sessiontoken"
    ]
  ),
  rule(
    "payment_or_bank_detail",
    "The field name or description indicates a payment instrument or bank detail.",
    [
      "paymentmethod",
      "paymentinstrument",
      "paymentdetails",
      "paymentcard",
      "cardonfile",
      "cardholder",
      "cardholdername",
      "cardexpiry",
      "cardexpiration",
      "cardnumber",
      "fullpan",
      "creditcard",
      "debitcard",
      "cardtoken",
      "card",
      "cc",
      "ccnumber",
      "ccnum",
      "pan",
      "cvv",
      "cvc",
      "bankaccount",
      "accountnumber",
      "routingnumber",
      "iban",
      "swiftcode"
    ]
  ),
  rule(
    "government_identifier",
    "The field name or description indicates a government-issued or tax identifier.",
    [
      "ssn",
      "socialsecurity",
      "socialsecuritynumber",
      "taxid",
      "nationalid",
      "nationalinsurance",
      "nationalinsurancenumber",
      "nin",
      "passport",
      "passportnumber",
      "passportno",
      "passportid",
      "passportref",
      "driverslicense",
      "driverlicense",
      "drivinglicense",
      "driverslicence",
      "driverlicence",
      "drivinglicence",
      "licensenumber",
      "licenseno",
      "licenseid",
      "licenseref",
      "licencenumber",
      "licenceno",
      "licenceid",
      "licenceref",
      "governmentid",
      "governmentidentifier"
    ]
  ),
  rule(
    "institutional_identifier",
    "The field name or description indicates an institutional badge identifier.",
    [
      "badgenumber",
      "badgeno",
      "badgeid",
      "badgeref"
    ]
  ),
  rule(
    "birth_information",
    "The field name or description indicates a date of birth or birth information.",
    ["dateofbirth", "birthdate", "dob"]
  ),
  rule(
    "person_name",
    "The field name or description indicates a person's name.",
    [
      "fullname",
      "firstname",
      "lastname",
      "surname",
      "givenname",
      "familyname",
      "personname",
      "customername",
      "contactname",
      "membername",
      "employeename",
      "userfullname"
    ]
  ),
  rule(
    "medical_or_health_information",
    "The field name or description indicates medical or health information.",
    [
      "medical",
      "health",
      "diagnosis",
      "treatment",
      "medication",
      "prescription",
      "allergy",
      "clinical",
      "patientnote",
      "patientid",
      "patientidentifier",
      "waivernote",
      "medicalrecord",
      "medicalrecordnumber",
      "healthrecord",
      "mrn",
      "patientname",
      "patientfullname",
      "insurancemember",
      "insurancepolicy",
      "healthplanmember"
    ]
  ),
  rule(
    "direct_contact_or_address",
    "The field name or description indicates direct contact or address information.",
    [
      "email",
      "emailaddress",
      "phone",
      "phonenumber",
      "telephone",
      "address",
      "streetaddress",
      "homeaddress",
      "mailingaddress",
      "postalcode",
      "zipcode"
    ]
  ),
  rule(
    "biometric_or_precise_location",
    "The field name or description indicates biometric or precise-location information.",
    [
      "biometric",
      "fingerprint",
      "faceprint",
      "voiceprint",
      "geolocation",
      "gpscoordinate",
      "latitude",
      "longitude",
      "preciselocation"
    ]
  ),
  rule(
    "private_or_risk_information",
    "The field name or description indicates private notes, internal risk data, or a risk score.",
    ["privatenote", "privatedata", "internalrisk", "riskscore"]
  )
];
function rule(code, reason, patterns) {
  return {
    code,
    reason,
    matches: (value) => patterns.some((pattern) => {
      if (pattern === "pan" || pattern === "cc" || pattern === "card") {
        return value.compact === pattern || value.descriptionTokens.has(pattern);
      }
      if (pattern.length <= 4) {
        return value.compact === pattern || value.tokens.has(pattern) || value.descriptionTokens.has(pattern);
      }
      return value.compact.includes(pattern) || value.descriptionCompact.includes(pattern);
    })
  };
}

// ../synapsor-runner/packages/mcp-server/src/http-transport.ts
import {
  StreamableHTTPServerTransport
} from "@modelcontextprotocol/sdk/server/streamableHttp.js";

// ../synapsor-runner/packages/mcp-server/src/runtime-observability.ts
import mysql3 from "mysql2/promise";

// ../synapsor-runner/packages/mcp-server/src/server-composition.ts
import {
  McpServer,
  ResourceTemplate
} from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  StdioServerTransport
} from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  z as z15
} from "zod";

// ../synapsor-runner/node_modules/.pnpm/@modelcontextprotocol+ext-apps@1.7.4_@modelcontextprotocol+sdk@1.29.0_zod@3.25.76__zod@3.25.76/node_modules/@modelcontextprotocol/ext-apps/dist/src/server/index.js
import { mergeCapabilities as zQ } from "@modelcontextprotocol/sdk/shared/protocol.js";
import { CallToolRequestSchema as OQ, CallToolResultSchema as IQ, CreateMessageResultSchema as PQ, CreateMessageResultWithToolsSchema as wQ, EmptyResultSchema as HQ, ListResourcesResultSchema as _Q, ListToolsRequestSchema as AQ, PingRequestSchema as EQ, ReadResourceResultSchema as RQ } from "@modelcontextprotocol/sdk/types.js";
import { Protocol as i } from "@modelcontextprotocol/sdk/shared/protocol.js";
import { JSONRPCMessageSchema as n } from "@modelcontextprotocol/sdk/types.js";
import { z as Q } from "zod/v4";
import { ContentBlockSchema as y, CallToolResultSchema as o, EmbeddedResourceSchema as a, ImplementationSchema as g, RequestIdSchema as s, ResourceLinkSchema as t, ToolSchema as e } from "@modelcontextprotocol/sdk/types.js";
import { z as UQ } from "zod/v4";
var r = ((Z) => typeof __require < "u" ? __require : typeof Proxy < "u" ? new Proxy(Z, { get: ($, J) => (typeof __require < "u" ? __require : $)[J] }) : Z)(function(Z) {
  if (typeof __require < "u") return __require.apply(this, arguments);
  throw Error('Dynamic require of "' + Z + '" is not supported');
});
var v = Q.union([Q.literal("light"), Q.literal("dark")]).describe("Color theme preference for the host environment.");
var K = Q.union([Q.literal("inline"), Q.literal("fullscreen"), Q.literal("pip")]).describe("Display mode for UI presentation.");
var QQ = Q.union([Q.literal("--color-background-primary"), Q.literal("--color-background-secondary"), Q.literal("--color-background-tertiary"), Q.literal("--color-background-inverse"), Q.literal("--color-background-ghost"), Q.literal("--color-background-info"), Q.literal("--color-background-danger"), Q.literal("--color-background-success"), Q.literal("--color-background-warning"), Q.literal("--color-background-disabled"), Q.literal("--color-text-primary"), Q.literal("--color-text-secondary"), Q.literal("--color-text-tertiary"), Q.literal("--color-text-inverse"), Q.literal("--color-text-ghost"), Q.literal("--color-text-info"), Q.literal("--color-text-danger"), Q.literal("--color-text-success"), Q.literal("--color-text-warning"), Q.literal("--color-text-disabled"), Q.literal("--color-border-primary"), Q.literal("--color-border-secondary"), Q.literal("--color-border-tertiary"), Q.literal("--color-border-inverse"), Q.literal("--color-border-ghost"), Q.literal("--color-border-info"), Q.literal("--color-border-danger"), Q.literal("--color-border-success"), Q.literal("--color-border-warning"), Q.literal("--color-border-disabled"), Q.literal("--color-ring-primary"), Q.literal("--color-ring-secondary"), Q.literal("--color-ring-inverse"), Q.literal("--color-ring-info"), Q.literal("--color-ring-danger"), Q.literal("--color-ring-success"), Q.literal("--color-ring-warning"), Q.literal("--font-sans"), Q.literal("--font-mono"), Q.literal("--font-weight-normal"), Q.literal("--font-weight-medium"), Q.literal("--font-weight-semibold"), Q.literal("--font-weight-bold"), Q.literal("--font-text-xs-size"), Q.literal("--font-text-sm-size"), Q.literal("--font-text-md-size"), Q.literal("--font-text-lg-size"), Q.literal("--font-heading-xs-size"), Q.literal("--font-heading-sm-size"), Q.literal("--font-heading-md-size"), Q.literal("--font-heading-lg-size"), Q.literal("--font-heading-xl-size"), Q.literal("--font-heading-2xl-size"), Q.literal("--font-heading-3xl-size"), Q.literal("--font-text-xs-line-height"), Q.literal("--font-text-sm-line-height"), Q.literal("--font-text-md-line-height"), Q.literal("--font-text-lg-line-height"), Q.literal("--font-heading-xs-line-height"), Q.literal("--font-heading-sm-line-height"), Q.literal("--font-heading-md-line-height"), Q.literal("--font-heading-lg-line-height"), Q.literal("--font-heading-xl-line-height"), Q.literal("--font-heading-2xl-line-height"), Q.literal("--font-heading-3xl-line-height"), Q.literal("--border-radius-xs"), Q.literal("--border-radius-sm"), Q.literal("--border-radius-md"), Q.literal("--border-radius-lg"), Q.literal("--border-radius-xl"), Q.literal("--border-radius-full"), Q.literal("--border-width-regular"), Q.literal("--shadow-hairline"), Q.literal("--shadow-sm"), Q.literal("--shadow-md"), Q.literal("--shadow-lg")]).describe("CSS variable keys available to MCP apps for theming.");
var ZQ = Q.record(QQ.describe(`Style variables for theming MCP apps.

Individual style keys are optional - hosts may provide any subset of these values.
Values are strings containing CSS values (colors, sizes, font stacks, etc.).

Note: This type uses \`Record<K, string | undefined>\` rather than \`Partial<Record<K, string>>\`
for compatibility with Zod schema generation. Both are functionally equivalent for validation.`), Q.union([Q.string(), Q.undefined()]).describe(`Style variables for theming MCP apps.

Individual style keys are optional - hosts may provide any subset of these values.
Values are strings containing CSS values (colors, sizes, font stacks, etc.).

Note: This type uses \`Record<K, string | undefined>\` rather than \`Partial<Record<K, string>>\`
for compatibility with Zod schema generation. Both are functionally equivalent for validation.`)).describe(`Style variables for theming MCP apps.

Individual style keys are optional - hosts may provide any subset of these values.
Values are strings containing CSS values (colors, sizes, font stacks, etc.).

Note: This type uses \`Record<K, string | undefined>\` rather than \`Partial<Record<K, string>>\`
for compatibility with Zod schema generation. Both are functionally equivalent for validation.`);
var $Q = Q.object({ method: Q.literal("ui/open-link"), params: Q.object({ url: Q.string().describe("URL to open in the host's browser") }) });
var I = Q.object({ isError: Q.boolean().optional().describe("True if the host failed to open the URL (e.g., due to security policy).") }).passthrough();
var P = Q.object({ isError: Q.boolean().optional().describe("True if the download failed (e.g., user cancelled or host denied).") }).passthrough();
var w = Q.object({ isError: Q.boolean().optional().describe("True if the host rejected or failed to deliver the message.") }).passthrough();
var JQ = Q.object({ method: Q.literal("ui/notifications/sandbox-proxy-ready"), params: Q.object({}) });
var Y = Q.object({ connectDomains: Q.array(Q.string()).optional().describe(`Origins for network requests (fetch/XHR/WebSocket).

- Maps to CSP \`connect-src\` directive
- Empty or omitted \u2192 no network connections (secure default)`), resourceDomains: Q.array(Q.string()).optional().describe("Origins for static resources (images, scripts, stylesheets, fonts, media).\n\n- Maps to CSP `img-src`, `script-src`, `style-src`, `font-src`, `media-src` directives\n- Wildcard subdomains supported: `https://*.example.com`\n- Empty or omitted \u2192 no network resources (secure default)"), frameDomains: Q.array(Q.string()).optional().describe("Origins for nested iframes.\n\n- Maps to CSP `frame-src` directive\n- Empty or omitted \u2192 no nested iframes allowed (`frame-src 'none'`)"), baseUriDomains: Q.array(Q.string()).optional().describe("Allowed base URIs for the document.\n\n- Maps to CSP `base-uri` directive\n- Empty or omitted \u2192 only same origin allowed (`base-uri 'self'`)") });
var j = Q.object({ camera: Q.object({}).optional().describe("Request camera access.\n\nMaps to Permission Policy `camera` feature."), microphone: Q.object({}).optional().describe("Request microphone access.\n\nMaps to Permission Policy `microphone` feature."), geolocation: Q.object({}).optional().describe("Request geolocation access.\n\nMaps to Permission Policy `geolocation` feature."), clipboardWrite: Q.object({}).optional().describe("Request clipboard write access.\n\nMaps to Permission Policy `clipboard-write` feature.") });
var XQ = Q.object({ method: Q.literal("ui/notifications/size-changed"), params: Q.object({ width: Q.number().optional().describe("New width in pixels."), height: Q.number().optional().describe("New height in pixels.") }) });
var H = Q.object({ method: Q.literal("ui/notifications/tool-input"), params: Q.object({ arguments: Q.record(Q.string(), Q.unknown().describe("Complete tool call arguments as key-value pairs.")).optional().describe("Complete tool call arguments as key-value pairs.") }) });
var _ = Q.object({ method: Q.literal("ui/notifications/tool-input-partial"), params: Q.object({ arguments: Q.record(Q.string(), Q.unknown().describe("Partial tool call arguments (incomplete, may change).")).optional().describe("Partial tool call arguments (incomplete, may change).") }) });
var A = Q.object({ method: Q.literal("ui/notifications/tool-cancelled"), params: Q.object({ reason: Q.string().optional().describe('Optional reason for the cancellation (e.g., "user action", "timeout").') }) });
var f = Q.object({ fonts: Q.string().optional() });
var u = Q.object({ variables: ZQ.optional().describe("CSS variables for theming the app."), css: f.optional().describe("CSS blocks that apps can inject.") });
var E = Q.object({ method: Q.literal("ui/resource-teardown"), params: Q.object({}) });
var VQ = Q.record(Q.string(), Q.unknown());
var O = Q.object({ text: Q.object({}).optional().describe("Host supports text content blocks."), image: Q.object({}).optional().describe("Host supports image content blocks."), audio: Q.object({}).optional().describe("Host supports audio content blocks."), resource: Q.object({}).optional().describe("Host supports resource content blocks."), resourceLink: Q.object({}).optional().describe("Host supports resource link content blocks."), structuredContent: Q.object({}).optional().describe("Host supports structured content.") });
var DQ = Q.object({ method: Q.literal("ui/notifications/request-teardown"), params: Q.object({}).optional() });
var d = Q.object({ experimental: Q.object({}).optional().describe("Experimental features (structure TBD)."), openLinks: Q.object({}).optional().describe("Host supports opening external URLs."), downloadFile: Q.object({}).optional().describe("Host supports file downloads via ui/download-file."), serverTools: Q.object({ listChanged: Q.boolean().optional().describe("Host supports tools/list_changed notifications.") }).optional().describe("Host can proxy tool calls to the MCP server."), serverResources: Q.object({ listChanged: Q.boolean().optional().describe("Host supports resources/list_changed notifications.") }).optional().describe("Host can proxy resource reads to the MCP server."), logging: Q.object({}).optional().describe("Host accepts log messages."), sandbox: Q.object({ permissions: j.optional().describe("Permissions granted by the host (camera, microphone, geolocation)."), csp: Y.optional().describe("CSP domains approved by the host.") }).optional().describe("Sandbox configuration applied by the host."), updateModelContext: O.optional().describe("Host accepts context updates (ui/update-model-context) to be included in the model's context for future turns."), message: O.optional().describe("Host supports receiving content messages (ui/message) from the view."), sampling: Q.object({ tools: Q.object({}).optional().describe("Host supports tool use via `tools` and `toolChoice` parameters.") }).optional().describe("Host supports LLM sampling (sampling/createMessage) from the view.\nMirrors the MCP `ClientCapabilities.sampling` shape so hosts can pass it through.") });
var h = Q.object({ experimental: Q.object({}).optional().describe("Experimental features (structure TBD)."), tools: Q.object({ listChanged: Q.boolean().optional().describe("App supports tools/list_changed notifications.") }).optional().describe("App exposes MCP-style tools that the host can call."), availableDisplayModes: Q.array(K).optional().describe("Display modes the app supports.") });
var LQ = Q.object({ method: Q.literal("ui/notifications/initialized"), params: Q.object({}).optional() });
var WQ = Q.object({ csp: Y.optional().describe("Content Security Policy configuration for UI resources."), permissions: j.optional().describe("Sandbox permissions requested by the UI resource."), domain: Q.string().optional().describe(`Dedicated origin for view sandbox.

Useful when views need stable, dedicated origins for OAuth callbacks, CORS policies, or API key allowlists.

**Host-dependent:** The format and validation rules for this field are determined by each host. Servers MUST consult host-specific documentation for the expected domain format. Common patterns include:
- Hash-based subdomains (e.g., \`{hash}.claudemcpcontent.com\`)
- URL-derived subdomains (e.g., \`www-example-com.oaiusercontent.com\`)

If omitted, host uses default sandbox origin (typically per-conversation).`), prefersBorder: Q.boolean().optional().describe(`Visual boundary preference - true if view prefers a visible border.

Boolean requesting whether a visible border and background is provided by the host. Specifying an explicit value for this is recommended because hosts' defaults may vary.

- \`true\`: request visible border + background
- \`false\`: request no visible border + background
- omitted: host decides border`) });
var BQ = Q.object({ method: Q.literal("ui/request-display-mode"), params: Q.object({ mode: K.describe("The display mode being requested.") }) });
var R = Q.object({ mode: K.describe("The display mode that was actually set. May differ from requested if not supported.") }).passthrough();
var m = Q.union([Q.literal("model"), Q.literal("app")]).describe("Tool visibility scope - who can access the tool.");
var GQ = Q.object({ resourceUri: Q.string().optional(), visibility: Q.array(m).optional().describe(`Who can access this tool. Default: ["model", "app"]
- "model": Tool visible to and callable by the agent
- "app": Tool callable by the app from this server only`), csp: Q.never().optional(), permissions: Q.never().optional() });
var dQ = Q.object({ mimeTypes: Q.array(Q.string()).optional().describe('Array of supported MIME types for UI resources.\nMust include `"text/html;profile=mcp-app"` for MCP Apps support.') });
var KQ = Q.object({ method: Q.literal("ui/download-file"), params: Q.object({ contents: Q.array(Q.union([a, t])).describe("Resource contents to download \u2014 embedded (inline data) or linked (host fetches). Uses standard MCP resource types.") }) });
var NQ = Q.object({ method: Q.literal("ui/message"), params: Q.object({ role: Q.literal("user").describe('Message role, currently only "user" is supported.'), content: Q.array(y).describe("Message content blocks (text, image, etc.).") }) });
var YQ = Q.object({ method: Q.literal("ui/notifications/sandbox-resource-ready"), params: Q.object({ html: Q.string().describe("HTML content to load into the inner iframe."), sandbox: Q.string().optional().describe("Optional override for the inner iframe's sandbox attribute."), csp: Y.optional().describe("CSP configuration from resource metadata."), permissions: j.optional().describe("Sandbox permissions from resource metadata.") }) });
var U = Q.object({ method: Q.literal("ui/notifications/tool-result"), params: o.describe("Standard MCP tool execution result.") });
var T = Q.object({ toolInfo: Q.object({ id: s.optional().describe("JSON-RPC id of the tools/call request."), tool: e.describe("Tool definition including name, inputSchema, etc.") }).optional().describe("Metadata of the tool call that instantiated this App."), theme: v.optional().describe("Current color theme preference."), styles: u.optional().describe("Style configuration for theming the app."), displayMode: K.optional().describe("How the UI is currently displayed."), availableDisplayModes: Q.array(K).optional().describe("Display modes the host supports."), containerDimensions: Q.union([Q.object({ height: Q.number().describe("Fixed container height in pixels.") }), Q.object({ maxHeight: Q.union([Q.number(), Q.undefined()]).optional().describe("Maximum container height in pixels.") })]).and(Q.union([Q.object({ width: Q.number().describe("Fixed container width in pixels.") }), Q.object({ maxWidth: Q.union([Q.number(), Q.undefined()]).optional().describe("Maximum container width in pixels.") })])).optional().describe(`Container dimensions. Represents the dimensions of the iframe or other
container holding the app. Specify either width or maxWidth, and either height or maxHeight.`), locale: Q.string().optional().describe("User's language and region preference in BCP 47 format."), timeZone: Q.string().optional().describe("User's timezone in IANA format."), userAgent: Q.string().optional().describe("Host application identifier."), platform: Q.union([Q.literal("web"), Q.literal("desktop"), Q.literal("mobile")]).optional().describe("Platform type for responsive design decisions."), deviceCapabilities: Q.object({ touch: Q.boolean().optional().describe("Whether the device supports touch input."), hover: Q.boolean().optional().describe("Whether the device supports hover interactions.") }).optional().describe("Device input capabilities."), safeAreaInsets: Q.object({ top: Q.number().describe("Top safe area inset in pixels."), right: Q.number().describe("Right safe area inset in pixels."), bottom: Q.number().describe("Bottom safe area inset in pixels."), left: Q.number().describe("Left safe area inset in pixels.") }).optional().describe("Mobile safe area boundaries in pixels.") }).passthrough();
var k = Q.object({ method: Q.literal("ui/notifications/host-context-changed"), params: T.describe("Partial context update containing only changed fields.") });
var jQ = Q.object({ method: Q.literal("ui/update-model-context"), params: Q.object({ content: Q.array(y).optional().describe("Context content blocks (text, image, etc.)."), structuredContent: Q.record(Q.string(), Q.unknown().describe("Structured content for machine-readable context data.")).optional().describe("Structured content for machine-readable context data.") }) });
var FQ = Q.object({ method: Q.literal("ui/initialize"), params: Q.object({ appInfo: g.describe("App identification (name and version)."), appCapabilities: h.describe("Features and capabilities this app provides."), protocolVersion: Q.string().describe("Protocol version this app supports.") }) });
var M = Q.object({ protocolVersion: Q.string().describe('Negotiated protocol version string (e.g., "2025-11-21").'), hostInfo: g.describe("Host application identification and version."), hostCapabilities: d.describe("Features and capabilities provided by the host."), hostContext: T.describe("Rich context about the host environment.") }).passthrough();

// ../synapsor-runner/packages/mcp-server/src/subject-references.ts
var DEFAULT_SUBJECT_REFERENCE_TTL_SECONDS = 10 * 60;
var MAX_SUBJECT_REFERENCE_TTL_SECONDS = 15 * 60;

// ../synapsor-runner/apps/runner/src/cli-project.ts
import path4 from "node:path";
import process2 from "node:process";
import readline from "node:readline/promises";

// ../synapsor-runner/apps/runner/src/cli-assets.ts
import path2 from "node:path";
import { fileURLToPath } from "node:url";

// ../synapsor-runner/apps/runner/src/cli-options.ts
function normalizeCliArgv(argv) {
  const [first, ...rest] = argv;
  if (first === "synapsor-runner" || first === "synapsor") return rest;
  return argv;
}
function optionalArg(args, flag) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : void 0;
}

// ../synapsor-runner/apps/runner/src/cli-assets.ts
var moduleDir = path2.dirname(fileURLToPath(import.meta.url));
var packageAssetRoot = path2.resolve(moduleDir, "..");
var sourceAssetRoot = path2.resolve(moduleDir, "../../..");

// ../synapsor-runner/apps/runner/src/control-policy-execution.ts
import { z as z18 } from "zod";

// ../synapsor-runner/apps/runner/src/control-policy-record.ts
import { z as z16 } from "zod";
var OPERATOR_POLICY_RECORD_VERSION = "synapsor.stored-operator-authority/v1";
var readAuthoringBindingsSchema = z16.object({
  repository_id: z16.string().uuid(),
  deployment_id: z16.string().uuid(),
  project_id: z16.string().uuid(),
  epoch: z16.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  revision_id: z16.string().regex(/^policy:[a-f0-9]{64}$/u)
}).strict();

// ../synapsor-runner/apps/runner/src/control-policy-store.ts
import fs2 from "node:fs/promises";
import path3 from "node:path";
import { DatabaseSync as DatabaseSync4 } from "node:sqlite";

// ../synapsor-runner/apps/runner/src/project-authority-mutation.ts
import { DatabaseSync as DatabaseSync2 } from "node:sqlite";

// ../synapsor-runner/apps/runner/src/project-runtime-admission.ts
import { DatabaseSync as DatabaseSync3 } from "node:sqlite";

// ../synapsor-runner/apps/runner/src/control-policy-store.ts
import { z as z17 } from "zod";
var identifier2 = z17.string().min(1).max(256).refine((value) => value.trim() === value && !/[\u0000-\u001f\u007f]/u.test(value));
var digest6 = z17.string().regex(/^sha256:[a-f0-9]{64}$/u);
var targetSchema = z17.discriminatedUnion("kind", [
  z17.object({ kind: z17.literal("sqlite"), path: z17.string().min(1) }).strict(),
  z17.object({ kind: z17.literal("postgres"), url_env: identifier2, schema: identifier2 }).strict()
]);
var scope = z17.discriminatedUnion("level", [
  z17.object({ level: z17.literal("operator") }).strict(),
  z17.object({ level: z17.literal("tenant"), tenant_id: identifier2 }).strict(),
  z17.object({ level: z17.literal("principal"), tenant_id: identifier2, principal: identifier2 }).strict()
]);
var key = { scope, kind: z17.enum(["read", "action", "execution", "parent", "delegation", "management"]), name: identifier2 };
var snapshotSchema = z17.object({
  revisions: z17.array(z17.object({ ...key, revision_id: identifier2, authority_digest: digest6, content_digest: digest6, content: z17.unknown() }).strict()).max(64),
  active: z17.array(z17.object({ ...key, revision_id: identifier2.nullable() }).strict()).max(64),
  drafts: z17.array(z17.object({ ...key, revision_id: identifier2.nullable() }).strict()).max(64),
  provenance: z17.array(z17.object({ path: z17.string().min(1).max(4096), digest: digest6 }).strict()).max(256)
}).strict();
var manifestSchema = z17.object({
  schema_version: z17.literal("synapsor.control-policy-migration/v1"),
  repository_id: z17.string().uuid(),
  deployment_id: z17.string().uuid(),
  project_id: z17.string().uuid(),
  target: targetSchema,
  migration_digest: digest6,
  actor: identifier2,
  created_at: z17.string().datetime()
}).strict();
var MAX_MANIFEST_BYTES = 16 * 1024;
var MAX_SNAPSHOT_BYTES = 128 * 1024 * 1024;
var MANIFEST_FILE = ".synapsor/control-policy/migration.json";
async function inspectProjectControlPolicyTargets(input) {
  const manifest = await readManifest(input.projectRoot);
  return { selected: selectedTarget(input), ...manifest ? { bound: manifest.target } : {} };
}
function selectedTarget(input) {
  const shared = input.config.storage?.shared_postgres;
  if (shared?.mode === "runtime_store") return targetSchema.parse({ kind: "postgres", url_env: shared.url_env, schema: shared.schema ?? "synapsor_runner" });
  if (input.storePath === ":memory:") throw failure("POLICY_STORE_MUST_PERSIST", "Policy authority requires a persistent control store.");
  return { kind: "sqlite", path: path3.resolve(input.storePath) };
}
async function readManifest(projectRoot) {
  const value = await readPrivateJson(path3.join(path3.resolve(projectRoot), MANIFEST_FILE), MAX_MANIFEST_BYTES);
  if (value === void 0) {
    const directory = path3.dirname(path3.join(path3.resolve(projectRoot), MANIFEST_FILE));
    const artifacts = await fs2.readdir(directory).catch((error) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    if (artifacts.some((file) => file.endsWith(".snapshot.json"))) {
      throw failure("POLICY_MIGRATION_MANIFEST_MISSING", "Policy migration input exists but its binding is missing. Restore the migration record; older file authority cannot be used.");
    }
    return void 0;
  }
  const parsed = manifestSchema.safeParse(value);
  if (!parsed.success) throw failure("POLICY_MIGRATION_RECORD_INVALID", "The policy migration record is invalid. Restore the original record; no older authority will be used.");
  return parsed.data;
}
async function readPrivateJson(file, maximum) {
  const handle = await fs2.open(file, "r").catch((error) => {
    if (error.code === "ENOENT") return void 0;
    throw error;
  });
  if (!handle) return void 0;
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maximum) throw new Error("Invalid migration record size.");
    const bytes = Buffer.alloc(stat.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const result = await handle.read(bytes, length, bytes.length - length, length);
      if (!result.bytesRead) break;
      length += result.bytesRead;
    }
    if (length > stat.size) throw new Error("Migration record changed during read.");
    return JSON.parse(bytes.subarray(0, length).toString("utf8"));
  } catch {
    throw failure("POLICY_MIGRATION_RECORD_INVALID", "The policy migration record is invalid. Restore the original record; no older authority will be used.");
  } finally {
    await handle.close();
  }
}
function failure(code, message) {
  return Object.assign(new Error(message), { code });
}

// ../synapsor-runner/apps/runner/src/control-policy-execution.ts
var operatorExecutionDocument = z18.object({
  schema_version: z18.literal(OPERATOR_POLICY_RECORD_VERSION),
  type: z18.literal("execution"),
  runtime_binding_digest: z18.string().regex(/^sha256:[a-f0-9]{64}$/u),
  policy: z18.record(z18.unknown())
}).strict();

// ../synapsor-runner/apps/runner/src/cli-project.ts
var activeProjectResolutionState = { current: void 0 };
var referenceDemoDir = "examples/reference-support-billing-app";
var referenceDemoConfigPath = `${referenceDemoDir}/synapsor.runner.json`;
function runnerConfigPath(args, fallback = "synapsor.runner.json") {
  return optionalArg(args, "--config") ?? process2.env.SYNAPSOR_RUNNER_CONFIG ?? process2.env.SYNAPSOR_MCP_CONFIG ?? activeProjectResolutionState.current?.config_path ?? fallback;
}
function resolvedLocalStorePath(args, configuredPath2, fallback = "./.synapsor/local.db") {
  return optionalResolvedLocalStorePath(args) ?? configuredPath2 ?? fallback;
}
function resolvedRuntimeStorePath(args, configPath, configuredPath2) {
  const configured = configuredPath2 === ":memory:" ? configuredPath2 : path4.resolve(path4.dirname(path4.resolve(configPath)), configuredPath2 ?? ".synapsor/local.db");
  return resolvedLocalStorePath(args, configured);
}
function optionalResolvedLocalStorePath(args) {
  const explicit = optionalArg(args, "--store");
  if (explicit) return explicit;
  if (process2.env.SYNAPSOR_LOCAL_STORE) return process2.env.SYNAPSOR_LOCAL_STORE;
  if (!optionalArg(args, "--config") && activeProjectResolutionState.current?.store_path) {
    return activeProjectResolutionState.current.store_path;
  }
  return void 0;
}

// ../synapsor-runner/apps/runner/src/project-resolution.ts
import fs3 from "node:fs/promises";
import os from "node:os";
import path5 from "node:path";
var CONFIG_ENV_NAMES = ["SYNAPSOR_RUNNER_CONFIG", "SYNAPSOR_MCP_CONFIG"];
var STORE_ENV_NAME = "SYNAPSOR_LOCAL_STORE";
async function resolveSynapsorProject(startDirectory = process.cwd(), env = process.env) {
  const configured = configuredPath(CONFIG_ENV_NAMES, env);
  if (configured) {
    return {
      source: "environment",
      config_path: configured,
      ...nonEmpty(env[STORE_ENV_NAME]) ? { store_path: env[STORE_ENV_NAME] } : {}
    };
  }
  const discovered = await discoverNearestProject(path5.resolve(startDirectory));
  if (!discovered) return void 0;
  return {
    source: "discovered",
    project_root: discovered.projectRoot,
    config_path: discovered.configPath,
    store_path: await discoveredStorePath(discovered.projectRoot, discovered.configPath)
  };
}
async function discoverNearestProject(startDirectory) {
  let current = startDirectory;
  const home = path5.resolve(os.homedir());
  while (true) {
    const candidates = await projectConfigCandidates(current);
    if (candidates.length > 1) {
      throw new Error([
        `Multiple Synapsor projects are valid at ${current}:`,
        ...candidates.map((candidate) => `  - ${candidate}`),
        "Pass --config <path> to choose one explicitly."
      ].join("\n"));
    }
    if (candidates.length === 1) {
      return { projectRoot: current, configPath: candidates[0] };
    }
    const parent = path5.dirname(current);
    if (await isRepositoryBoundary(current) || current === home || parent === current) return void 0;
    current = parent;
  }
}
async function projectConfigCandidates(directory) {
  const candidates = /* @__PURE__ */ new Set();
  const conventional = path5.join(directory, "synapsor.runner.json");
  if (await isRegularFile(conventional)) candidates.add(conventional);
  const conventionalNested = path5.join(directory, "synapsor/synapsor.runner.json");
  if (await isRegularFile(conventionalNested)) candidates.add(conventionalNested);
  const statePath = path5.join(directory, ".synapsor/guided-onboarding.json");
  if (await isRegularFile(statePath)) {
    const state = await readJsonObject(statePath);
    const artifacts = isRecord4(state?.artifacts) ? state.artifacts : void 0;
    const recorded = nonEmpty(artifacts?.runner_config);
    if (recorded) {
      const resolved = resolveContained(directory, recorded);
      if (await isRegularFile(resolved)) candidates.add(resolved);
    }
  }
  return [...candidates].sort();
}
async function discoveredStorePath(projectRoot, configPath) {
  const config = await readJsonObject(configPath);
  const storage = isRecord4(config?.storage) ? config.storage : void 0;
  const configured = nonEmpty(storage?.sqlite_path);
  return configured ? path5.resolve(path5.dirname(configPath), configured) : path5.join(projectRoot, ".synapsor/local.db");
}
function configuredPath(names, env) {
  const configured = names.map((name4) => ({ name: name4, value: nonEmpty(env[name4]) })).filter((entry) => Boolean(entry.value));
  const values = [...new Set(configured.map((entry) => entry.value))];
  if (values.length > 1) {
    throw new Error(
      `${configured.map((entry) => entry.name).join(" and ")} point to different Runner configs. Keep one value or pass --config explicitly.`
    );
  }
  return values[0];
}
function resolveContained(root, value) {
  const resolved = path5.resolve(root, value);
  const relative = path5.relative(root, resolved);
  if (relative.startsWith("..") || path5.isAbsolute(relative)) {
    throw new Error(`Guided project config path escapes its project root: ${value}`);
  }
  return resolved;
}
async function isRepositoryBoundary(directory) {
  try {
    const stat = await fs3.lstat(path5.join(directory, ".git"));
    return (stat.isDirectory() || stat.isFile()) && !stat.isSymbolicLink();
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}
async function isRegularFile(filePath) {
  try {
    const stat = await fs3.lstat(filePath);
    return stat.isFile() && !stat.isSymbolicLink();
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}
async function readJsonObject(filePath) {
  try {
    const parsed = JSON.parse(await fs3.readFile(filePath, "utf8"));
    if (!isRecord4(parsed)) throw new Error(`Expected a JSON object in ${filePath}.`);
    return parsed;
  } catch (error) {
    if (error.code === "ENOENT") return void 0;
    if (error instanceof SyntaxError) {
      throw new Error(`Cannot discover Synapsor project because ${filePath} is invalid JSON: ${error.message}`);
    }
    throw error;
  }
}
function nonEmpty(value) {
  return typeof value === "string" && value.trim() ? value.trim() : void 0;
}
function isRecord4(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

// ../synapsor-runner/apps/runner/src/qualification-storage-preflight.ts
async function inspectQualificationStorage(args) {
  if (args.includes("--secrets-provider")) throw refused("Resolve managed secrets before entering the isolated test environment.");
  const previous = activeProjectResolutionState.current;
  try {
    const [command, subcommand] = normalizeCliArgv(args);
    const freshSetup = command === "start" || command === "onboard" && subcommand === "db";
    activeProjectResolutionState.current = optionalArg(args, "--config") || freshSetup ? void 0 : await resolveSynapsorProject(process.cwd(), process.env);
    const configPath = path6.resolve(runnerConfigPath(args));
    let config = {};
    try {
      config = resolveRuntimeConfig(JSON.parse(await fs4.readFile(configPath, "utf8")), path6.dirname(configPath));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const roots = [...new Set([
      path6.resolve(optionalArg(args, "--project-root") ?? activeProjectResolutionState.current?.project_root ?? process.cwd()),
      config.action_rules?.project_root,
      config.production_explore?.project_root
    ].filter((value) => Boolean(value)).map((value) => path6.resolve(value)))];
    const storePath = resolvedRuntimeStorePath(args, configPath, config.storage?.sqlite_path);
    const directStore = resolvedLocalStorePath(args);
    const destinations = [{ role: "direct CLI ledger", kind: "sqlite", path: directStore === ":memory:" ? directStore : path6.resolve(directStore) }];
    for (const projectRoot of roots) {
      const targets = await inspectProjectControlPolicyTargets({ projectRoot, config, storePath });
      destinations.push({ role: `selected runtime at ${projectRoot}`, ...targets.selected });
      if (targets.bound) destinations.push({ role: `governed authoring at ${projectRoot}`, ...targets.bound });
    }
    const shared = config.storage?.shared_postgres;
    if (shared && shared.mode !== "disabled") {
      destinations.push({ role: `shared ${shared.mode}`, kind: "postgres", url_env: shared.url_env, schema: shared.schema ?? "synapsor_runner" });
    }
    return { config_path: configPath, project_roots: roots, destinations };
  } finally {
    activeProjectResolutionState.current = previous;
  }
}
async function assertQualificationStorageOwned(input) {
  if (!input.mounts.length) throw refused("No owned writable mount was declared.");
  const mounts = await Promise.all(input.mounts.map(async (mount) => {
    const logical = await fs4.realpath(mount.logical), physical = await fs4.realpath(mount.physical);
    const left = await fs4.stat(logical), right = await fs4.stat(physical);
    if (!left.isDirectory() || !right.isDirectory() || left.dev !== right.dev || left.ino !== right.ino) {
      throw refused("The logical project is not mounted from its owned test copy.");
    }
    return { logical, physical };
  }));
  const contained = (root, file) => {
    const relative = path6.relative(root, file);
    return relative !== ".." && !relative.startsWith(`..${path6.sep}`) && !path6.isAbsolute(relative);
  };
  async function checkPath(file) {
    if (file === ":memory:") throw refused("Qualification requires an owned persistent ledger.");
    const absolute = path6.resolve(file);
    let existing = absolute;
    let suffix = "";
    while (true) {
      try {
        const canonical = path6.join(await fs4.realpath(existing), suffix);
        const mount = mounts.find((value) => contained(value.logical, canonical));
        if (!mount) throw refused("A writable destination escapes the declared owned mounts.");
        const stat = await fs4.stat(existing);
        if (stat.isFile() && stat.nlink !== 1) throw refused("A writable destination has shared hard links.");
        const physical = path6.join(mount.physical, path6.relative(mount.logical, await fs4.realpath(existing)));
        const owner = await fs4.stat(physical);
        if (stat.dev !== owner.dev || stat.ino !== owner.ino) throw refused("A destination does not resolve to its owned physical copy.");
        return;
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        const unresolved = await fs4.lstat(existing).catch((cause) => {
          if (cause.code === "ENOENT") return void 0;
          throw cause;
        });
        if (unresolved?.isSymbolicLink()) throw refused("A writable destination has an unresolved symbolic link.");
        const parent = path6.dirname(existing);
        if (parent === existing) throw refused("A destination has no verifiable owned parent.");
        suffix = path6.join(path6.basename(existing), suffix);
        existing = parent;
      }
    }
  }
  for (const file of [input.inspection.config_path, ...input.inspection.project_roots]) await checkPath(file);
  for (const destination of input.inspection.destinations) {
    if (destination.kind === "sqlite") {
      await checkPath(destination.path);
      for (const suffix of ["-wal", "-shm", "-journal", ".lease.json"]) await checkPath(destination.path + suffix);
    } else {
      const url = (input.env ?? process.env)[destination.url_env];
      if (!url || !input.ownedPostgresUrls?.includes(url)) throw refused("A shared store does not select an explicitly owned test database.");
    }
  }
}
function refused(message) {
  return Object.assign(new Error(message), { code: "QUALIFICATION_STORAGE_NOT_ISOLATED" });
}

// ../Progress docs tracking/r13-e07-20260911/isolation-completion-591555b/preflight-entry.ts
var plan = JSON.parse(await fs5.readFile(process.env.QUALIFICATION_MOUNT_PLAN, "utf8"));
var inspection = await inspectQualificationStorage(process.argv.slice(2));
await assertQualificationStorageOwned({
  inspection,
  mounts: plan.mounts,
  ownedPostgresUrls: (plan.owned_database_envs ?? []).map((key2) => process.env[key2]).filter(Boolean)
});
process.stdout.write(JSON.stringify({ ok: true, inspection, database_opened: false }) + "\n");
