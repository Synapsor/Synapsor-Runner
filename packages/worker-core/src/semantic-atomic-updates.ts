import { canonicalJsonDigest, parseWritebackJob, type ExactDerivedEffectProtocolV1,
  type NormalizedWritebackJobV5, type NormalizedWritebackResultV5 } from "@synapsor-runner/protocol";

export type SemanticMutationInput = Pick<NormalizedWritebackJobV5,
  "operation" | "allowed_columns" | "patch" | "conflict_guard" | "version_advance" | "deduplication"> & {
  target: Omit<NormalizedWritebackJobV5["target"], "principal_scope"> & {
    principal_scope?: { column: string; value?: string | number | boolean | null };
  };
};
export type SemanticAtomicEffectResult = NonNullable<NormalizedWritebackResultV5["atomic_effects"]>[number];

export function semanticAtomicUpdateEffects(job: NormalizedWritebackJobV5): ExactDerivedEffectProtocolV1[] {
  const parsed = parseWritebackJob(job);
  if (parsed.protocol_version !== "5.0" || !parsed.semantic_authority.effect.atomic_updates) throw new Error("SEMANTIC_EFFECT_MISMATCH");
  return [parsed.semantic_authority.effect, ...parsed.semantic_authority.effect.atomic_updates];
}

/** SQL-builder input only. Never constructs a child job, approval or verification proof. */
export function semanticEffectMutation(effect: ExactDerivedEffectProtocolV1): SemanticMutationInput {
  if (effect.operation !== "single_row_update" || !effect.expected_version || !effect.version_advance) throw new Error("SEMANTIC_EFFECT_MISMATCH");
  return { operation: effect.operation,
    target: { schema: effect.schema, table: effect.table, primary_key: effect.primary_key,
      ...(effect.tenant_guard ? { tenant_guard: effect.tenant_guard } : {}),
      ...(effect.organization_scope ? { organization_scope: effect.organization_scope } : {}),
      ...(effect.principal_scope ? { principal_scope: effect.principal_scope } : {}) },
    allowed_columns: effect.allowed_columns, patch: effect.set,
    conflict_guard: { kind: "version_column", column: effect.expected_version.column, expected_value: effect.expected_version.value },
    version_advance: effect.version_advance };
}

export function semanticAtomicEffectResult(effect: ExactDerivedEffectProtocolV1, version?: unknown): SemanticAtomicEffectResult {
  const applied = version !== undefined;
  const expected = effect.expected_version?.value;
  if (applied && (typeof expected !== "number" || !Number.isSafeInteger(expected + 1) || Number(version) !== expected + 1)) {
    throw new Error("VERSION_DID_NOT_ADVANCE");
  }
  if (effect.primary_key.value === undefined) throw new Error("SEMANTIC_EFFECT_MISMATCH");
  return { resource: effect.resource, schema: effect.schema, table: effect.table, effect_digest: effect.effect_digest,
    target_identity: [{ column: effect.primary_key.column, value: effect.primary_key.value },
      ...(effect.tenant_guard ? [effect.tenant_guard] : []), ...(effect.principal_scope ? [effect.principal_scope] : [])],
    affected_rows: applied ? 1 : 0,
    ...(applied ? { before_digest: canonicalJsonDigest({ identity: effect.primary_key, version: effect.expected_version }),
      after_digest: canonicalJsonDigest({ effect_digest: effect.effect_digest, version: Number(version) }) } : {}) };
}
