import { z } from "zod";
import { canonicalJsonDigest } from "./canonical-json.js";
import { parseWritebackJob, parseWritebackResult, type WritebackJob, type WritebackResult } from "./index.js";

const hash = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const bindingSchema = z.object({
  schema_version: z.literal("synapsor.source-completion-binding.v1"),
  job_digest: hash,
  source_binding_digest: hash,
  execution_binding_digest: hash,
  writer_reference: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
  digest: hash,
}).strict();
export type SourceCompletionBinding = z.infer<typeof bindingSchema>;

export function parseSourceCompletionBinding(value: unknown): SourceCompletionBinding {
  const parsed = bindingSchema.parse(value);
  const { digest, ...body } = parsed;
  if (canonicalJsonDigest(body) !== digest) throw new Error("SOURCE_COMPLETION_BINDING_INVALID");
  return parsed;
}

export type SourceCompletionEvidence = {
  schema_version: "synapsor.postgres.source-completion.v1";
  job_digest: string;
  binding_digest: string;
  result: WritebackResult;
  result_digest: string;
};
const evidenceSchema = z.object({
  schema_version: z.literal("synapsor.postgres.source-completion.v1"),
  job_digest: hash,
  binding_digest: hash,
  result: z.unknown(),
  result_digest: hash,
}).strict();

/** Whole original job and every completed effect are required. This validates
 * a Source producer's envelope; it never infers completion from business rows. */
export function parseSourceCompletionEvidence(value: unknown, jobInput: WritebackJob,
  bindingInput: SourceCompletionBinding): SourceCompletionEvidence {
  const job = parseWritebackJob(jobInput), binding = parseSourceCompletionBinding(bindingInput);
  const evidence = evidenceSchema.parse(value), result = parseWritebackResult(evidence.result);
  const invalid = (): never => { throw new Error("SOURCE_COMPLETION_PROOF_INVALID"); };
  if (job.engine !== "postgres" || !["2.0", "5.0"].includes(job.protocol_version)
    || binding.job_digest !== canonicalJsonDigest(job) || evidence.job_digest !== binding.job_digest
    || evidence.binding_digest !== binding.digest || evidence.result_digest !== canonicalJsonDigest(result)
    || result.protocol_version !== job.protocol_version || result.job_id !== job.job_id
    || !("receipt_authority" in result) || result.receipt_authority !== "source_db"
    || result.status !== "applied" || !("operation" in result) || result.operation !== job.operation) return invalid();
  if (job.protocol_version === "2.0") {
    if (result.protocol_version !== "2.0" || job.operation !== "single_row_update" || result.affected_rows !== 1
      || canonicalJsonDigest(result.target_identity) !== canonicalJsonDigest([job.target.primary_key])) return invalid();
    if (job.version_advance?.strategy === "integer_increment" && (job.conflict_guard.kind !== "version_column"
      || typeof job.conflict_guard.expected_value !== "number"
      || Number(result.result_version) !== job.conflict_guard.expected_value + 1)) return invalid();
  } else if (job.protocol_version === "5.0") {
    if (result.protocol_version !== "5.0") return invalid();
    const proof = job.semantic_authority.proof, verification = result.semantic_verification;
    if (verification.status !== "reverified" || verification.proof_digest !== proof.proof_digest
      || verification.action_rule_digest !== proof.action_rule_digest || verification.compiled_plan_digest !== proof.compiled_plan_digest
      || verification.proposal_dependency_set_digest !== proof.dependency_set_digest
      || verification.dependency_set_digest !== proof.dependency_set_digest || verification.effect_digest !== proof.derived_effect_digest) return invalid();
    const identity = [job.target.primary_key];
    for (const component of job.deduplication?.components ?? []) {
      if (!identity.some(item => item.column === component.column)) identity.push({ column: component.column, value: component.value });
    }
    if (canonicalJsonDigest(result.target_identity) !== canonicalJsonDigest(identity)) return invalid();
    const primary = job.semantic_authority.effect;
    if (primary.atomic_updates) {
      const members = [primary, ...primary.atomic_updates];
      if (result.affected_rows !== members.length || result.atomic_effects?.length !== members.length) return invalid();
      for (const [index, member] of members.entries()) {
        const actual = result.atomic_effects![index]!;
        const expectedVersion = member.expected_version?.value;
        const expectedIdentity = [member.primary_key, ...(member.tenant_guard ? [member.tenant_guard] : []), ...(member.principal_scope ? [member.principal_scope] : [])];
        if (actual.affected_rows !== 1 || actual.effect_digest !== member.effect_digest || actual.resource !== member.resource
          || actual.schema !== member.schema || actual.table !== member.table
          || canonicalJsonDigest(actual.target_identity) !== canonicalJsonDigest(expectedIdentity)
          || typeof expectedVersion !== "number" || !Number.isSafeInteger(expectedVersion + 1)
          || actual.before_digest !== canonicalJsonDigest({ identity: member.primary_key, version: member.expected_version })
          || actual.after_digest !== canonicalJsonDigest({ effect_digest: member.effect_digest, version: expectedVersion + 1 })) return invalid();
      }
    } else if (result.affected_rows !== 1 || result.atomic_effects !== undefined) return invalid();
  }
  return { ...evidence, result };
}
