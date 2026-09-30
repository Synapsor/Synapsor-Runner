import type { AuthoringQuestionCompletion } from "./authoring-generation-recovery.js";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import type { ActionRuleModelDraftV1 } from "./action-rule-draft.js";
import type { ActionWorkUnitCorrection } from "./action-authoring-work-unit-contract.js";

/** Identity of an actual completed coverage submission, not a verdict. */
export type ActionWorkUnitCoverageProvenance = {
  context_key: `sha256:${string}`; episode_id: string; submission_number: number;
};
export function parseActionWorkUnitCoverageProvenance(value: unknown): ActionWorkUnitCoverageProvenance {
  const v = value as ActionWorkUnitCoverageProvenance;
  // ensurePreparedPolicyCoverage allocates its episode with node:crypto randomUUID.
  if (!v || typeof v !== "object" || Array.isArray(v)
    || Object.keys(v).some(k => !["context_key", "episode_id", "submission_number"].includes(k))
    || typeof v.context_key !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(v.context_key)
    || typeof v.episode_id !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(v.episode_id)
    || !Number.isInteger(v.submission_number) || v.submission_number < 1 || v.submission_number > 3)
    throw new Error("ACTION_AUTHORING_CHECKPOINT_INVALID: Original coverage submission provenance is unavailable or malformed.");
  return structuredClone(v);
}

/** A nomination reference, never a stored semantic verdict. The original report
 * must be reconstructed and canonically revalidated by the host on reopen. */
export type ActionRuleSourceRepairCheckpoint = {
  original_parent: ActionRuleModelDraftV1;
  correction: ActionWorkUnitCorrection;
  passage_indexes: number[];
  prepared_draft_digest: `sha256:${string}`;
  corrections_used: number;
  coverage_provenance?: ActionWorkUnitCoverageProvenance;
};

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
  pending_question?: {
    question: string;
    operator_message: string;
    policy_source_digest?: `sha256:${string}`;
    completion?: AuthoringQuestionCompletion;
  };
  reviewed_relationships?: string[];
  reviewed_private_sources?: ReviewedPrivateActionSource[];
  reviewed_version_fields?: ReviewedActionVersionField[];
  reopened_draft?: { outcome: string; digest: `sha256:${string}`; covered_intent_indexes: number[] };
  source_repair?: ActionRuleSourceRepairCheckpoint;
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
    || Object.keys(record).some((key) => !["schema_version", "intent_digest", "context_digest", "components", "operator_messages", "pending_question", "reviewed_relationships", "reviewed_private_sources", "reviewed_version_fields", "reopened_draft", "source_repair", "digest"].includes(key))
    || ![record.intent_digest, record.context_digest, record.digest].every((digest) => typeof digest === "string" && /^sha256:[a-f0-9]{64}$/u.test(digest))
    || !record.components || typeof record.components !== "object" || Array.isArray(record.components)) throw fail();
  if (record.operator_messages !== undefined && (!Array.isArray(record.operator_messages)
    || record.operator_messages.length > 16
    || record.operator_messages.some((message) => typeof message !== "string" || !message.trim() || message.length > 4_000))) throw fail();
  if (record.pending_question !== undefined) {
    const q = record.pending_question as ActionRuleAuthoringCheckpoint["pending_question"];
    const isDigest = (v: unknown) => typeof v === "string" && /^sha256:[a-f0-9]{64}$/u.test(v);
    if (!q || typeof q !== "object" || Array.isArray(q)
      || Object.keys(q).some(k => !["question","operator_message","policy_source_digest","completion"].includes(k))
      || typeof q.question !== "string" || !q.question.trim() || q.question.length > 20_000
      || typeof q.operator_message !== "string" || !q.operator_message.trim() || q.operator_message.length > 4_000
      || q.policy_source_digest !== undefined && !isDigest(q.policy_source_digest)) throw fail();
    if (q.completion !== undefined) {
      const c = q.completion;
      if (!c || typeof c !== "object" || Array.isArray(c) || Object.keys(c).some(k => !["operation_id","request_digest","context_digest","response_digest"].includes(k))
        || typeof c.operation_id !== "string" || !/^[a-f0-9-]{36}$/u.test(c.operation_id)
        || ![c.request_digest,c.context_digest,c.response_digest].every(isDigest)) throw fail();
    }
  }
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
  if (record.source_repair !== undefined) {
    const repair = record.source_repair as ActionRuleSourceRepairCheckpoint;
    const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
    const digest = (v: unknown) => typeof v === "string" && /^sha256:[a-f0-9]{64}$/u.test(v);
    const exact = (v: Record<string, unknown>, keys: string[]) => Object.keys(v).every(k => keys.includes(k));
    if (!object(repair) || !exact(repair, ["original_parent", "correction", "passage_indexes", "prepared_draft_digest", "corrections_used", "coverage_provenance"])
      || !object(repair.original_parent) || !object(repair.correction) || !digest(repair.prepared_draft_digest)
      || !Number.isSafeInteger(repair.corrections_used) || repair.corrections_used < 0 || repair.corrections_used > 2
      || !Array.isArray(repair.passage_indexes) || !repair.passage_indexes.length || repair.passage_indexes.length > 120
      || new Set(repair.passage_indexes).size !== repair.passage_indexes.length
      || repair.passage_indexes.some(i => !Number.isSafeInteger(i) || i < 0 || i > 119)) throw fail();
    const c = repair.correction;
    if (!exact(c, ["source_digest", "read_digest", "catalog_digest", "parent_digest", "outcome", "source_answer_history_digest", "interpretation_digest", "source_ranges", "component", "editable_paths"])
      || ![c.read_digest, c.catalog_digest, c.parent_digest, c.source_answer_history_digest, c.interpretation_digest].every(digest)
      || typeof c.source_digest !== "string" || !c.source_digest.trim() || c.source_digest.length > 256
      || typeof c.outcome !== "string" || !c.outcome.trim() || c.outcome.length > 256 || c.outcome !== repair.original_parent.outcome
      || canonicalJsonDigest(repair.original_parent) !== c.parent_digest || !["subject", "predicate", "private_role"].includes(c.component)
      || !Array.isArray(c.editable_paths) || !c.editable_paths.length || c.editable_paths.length > 32
      || new Set(c.editable_paths).size !== c.editable_paths.length
      || c.editable_paths.some(p => typeof p !== "string" || !p.startsWith("/") || p.length > 1_000)
      || !Array.isArray(c.source_ranges) || !c.source_ranges.length || c.source_ranges.length > 120
      || c.source_ranges.some(r => !object(r) || !exact(r, ["start", "end"]) || !Number.isSafeInteger(r.start)
        || !Number.isSafeInteger(r.end) || r.start < 1 || r.end < r.start)) throw fail();
    if (repair.coverage_provenance !== undefined) parseActionWorkUnitCoverageProvenance(repair.coverage_provenance);
  }
  if (Buffer.byteLength(JSON.stringify(record), "utf8") > 96 * 1024) throw fail();
  const { digest, ...core } = record;
  if (canonicalJsonDigest(core) !== digest) throw fail();
  return structuredClone(record) as ActionRuleAuthoringCheckpoint;
}
