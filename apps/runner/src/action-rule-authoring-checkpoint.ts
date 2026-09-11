import { canonicalJsonDigest } from "@synapsor-runner/protocol";

export type ReviewedPrivateActionSource = {
  resource: string;
  parent_resource: string;
  relationship: string;
  proof_digest: `sha256:${string}`;
};

export type ReviewedActionVersionField = {
  resource: string;
  field: string;
  maintenance: "all_writers_increment";
  proof_digest: `sha256:${string}`;
};

export function parseReviewedActionVersionFields(value: unknown, maximum = 16): ReviewedActionVersionField[] {
  const fail = () => new Error("ACTION_AUTHORING_CHECKPOINT_INVALID: saved counter reviews are invalid. Active authority is unchanged.");
  if (!Number.isSafeInteger(maximum) || maximum < 0 || !Array.isArray(value) || value.length > maximum) throw fail();
  const names = new Set<string>();
  for (const review of value) {
    if (!review || typeof review !== "object" || Array.isArray(review)
      || Object.keys(review).some(key => !["resource", "field", "maintenance", "proof_digest"].includes(key))
      || typeof review.resource !== "string" || review.resource.length > 256 || !/^[A-Za-z_][A-Za-z0-9_.]*$/u.test(review.resource)
      || typeof review.field !== "string" || review.field.length > 256 || !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(review.field)
      || review.maintenance !== "all_writers_increment"
      || typeof review.proof_digest !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(review.proof_digest)
      || names.has(review.resource)) throw fail();
    names.add(review.resource);
  }
  return structuredClone(value) as ReviewedActionVersionField[];
}

export type ActionRuleAuthoringCheckpoint = {
  schema_version: "synapsor.action-authoring-checkpoint.v1";
  intent_digest: `sha256:${string}`;
  context_digest: `sha256:${string}`;
  components: Partial<Record<"verification" | "effect" | "rule" | "approval", Record<string, unknown>>>;
  operator_messages?: string[];
  reviewed_relationships?: string[];
  reviewed_private_sources?: ReviewedPrivateActionSource[];
  reviewed_version_fields?: ReviewedActionVersionField[];
  reopened_draft?: { outcome: string; digest: `sha256:${string}`; covered_intent_indexes: number[] };
  digest: `sha256:${string}`;
};

export function actionRuleAuthoringCheckpoint(
  input: Omit<ActionRuleAuthoringCheckpoint, "schema_version" | "digest">,
): ActionRuleAuthoringCheckpoint {
  const core = { schema_version: "synapsor.action-authoring-checkpoint.v1" as const, ...structuredClone(input) };
  return parseActionRuleAuthoringCheckpoint({ ...core, digest: canonicalJsonDigest(core) });
}

export function parseActionRuleAuthoringCheckpoint(value: unknown): ActionRuleAuthoringCheckpoint {
  const fail = () => new Error("ACTION_AUTHORING_CHECKPOINT_INVALID: saved draft components are invalid or changed. Active authority is unchanged.");
  if (!value || typeof value !== "object" || Array.isArray(value)) throw fail();
  const record = value as Record<string, unknown>;
  if (record.schema_version !== "synapsor.action-authoring-checkpoint.v1"
    || Object.keys(record).some((key) => !["schema_version", "intent_digest", "context_digest", "components", "operator_messages", "reviewed_relationships", "reviewed_private_sources", "reviewed_version_fields", "reopened_draft", "digest"].includes(key))
    || ![record.intent_digest, record.context_digest, record.digest].every((digest) => typeof digest === "string" && /^sha256:[a-f0-9]{64}$/u.test(digest))
    || !record.components || typeof record.components !== "object" || Array.isArray(record.components)) throw fail();
  if (record.operator_messages !== undefined && (!Array.isArray(record.operator_messages)
    || record.operator_messages.length > 16
    || record.operator_messages.some((message) => typeof message !== "string" || !message.trim() || message.length > 4_000))) throw fail();
  if (record.reopened_draft !== undefined) {
    const selected = record.reopened_draft as ActionRuleAuthoringCheckpoint["reopened_draft"];
    if (!selected || typeof selected !== "object" || Array.isArray(selected)
      || Object.keys(selected).some((key) => !["outcome", "digest", "covered_intent_indexes"].includes(key))
      || typeof selected.outcome !== "string" || !selected.outcome.trim() || selected.outcome.length > 256
      || typeof selected.digest !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(selected.digest)
      || !Array.isArray(selected.covered_intent_indexes) || !selected.covered_intent_indexes.includes(0)
      || selected.covered_intent_indexes.length > 8
      || new Set(selected.covered_intent_indexes).size !== selected.covered_intent_indexes.length
      || selected.covered_intent_indexes.some((index) => !Number.isInteger(index) || index < 0 || index > 7)) throw fail();
  }
  for (const [phase, component] of Object.entries(record.components)) {
    if (!["verification", "effect", "rule", "approval"].includes(phase)
      || !component || typeof component !== "object" || Array.isArray(component)) throw fail();
  }
  if (record.reviewed_relationships !== undefined && (!Array.isArray(record.reviewed_relationships)
    || record.reviewed_relationships.length > 64
    || new Set(record.reviewed_relationships).size !== record.reviewed_relationships.length
    || record.reviewed_relationships.some((name) => typeof name !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)))) throw fail();
  if (record.reviewed_private_sources !== undefined) {
    const sources = record.reviewed_private_sources;
    if (!Array.isArray(sources) || sources.length > 16) throw fail();
    const names = new Set<string>();
    for (const source of sources) {
      if (!source || typeof source !== "object" || Array.isArray(source)
        || Object.keys(source).some(key => !["resource", "parent_resource", "relationship", "proof_digest"].includes(key))
        || [source.resource, source.parent_resource, source.relationship].some(name => typeof name !== "string"
          || name.length > 256 || !/^[A-Za-z_][A-Za-z0-9_.]*$/u.test(name))
        || typeof source.proof_digest !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(source.proof_digest)
        || names.has(source.resource)) throw fail();
      names.add(source.resource);
    }
  }
  if (record.reviewed_version_fields !== undefined) {
    parseReviewedActionVersionFields(record.reviewed_version_fields);
  }
  if (Buffer.byteLength(JSON.stringify(record), "utf8") > 96 * 1024) throw fail();
  const { digest, ...core } = record;
  if (canonicalJsonDigest(core) !== digest) throw fail();
  return structuredClone(record) as ActionRuleAuthoringCheckpoint;
}
