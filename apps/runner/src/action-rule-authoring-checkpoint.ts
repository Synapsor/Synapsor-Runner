import { parseActionRequirementProposals, type ActionRequirementProposals } from "./authoring-action-requirements.js";
import { parseStructuredAuthoringProtocol, type StructuredAuthoringProtocol } from "./authoring-protocol.js";
import { assertAuthoringGenerationAdmission } from "./authoring-generation-recovery.js";
import { AskError } from "./model-provider-transport.js";
import type { AskAuthoringEpisodeBudget } from "./model-ask.js";
import type { AuthoringQuestionCompletion } from "./authoring-generation-recovery.js";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import type { ActionRuleModelDraftV1 } from "./action-rule-draft.js";
type Digest = `sha256:${string}`;

export type ActionWorkUnitBindingPermutation = { slots: number[]; original_bindings: string[] };

export type ActionWorkUnitCorrection = {
  source_digest: string; read_digest: Digest; catalog_digest: Digest; parent_digest: Digest; outcome: string;
  source_answer_history_digest: Digest;
  interpretation_digest: Digest; source_ranges: Array<{ start: number; end: number }>;
  component: "subject" | "predicate" | "private_role"; editable_paths: string[];
  binding_permutation?: ActionWorkUnitBindingPermutation;
};

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

export type ReviewedPrivateActionSource = import("./action-rule-resource-review.js").PrivateActionSourceReview;

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

/** Append-only accounting for one ordinary conversational producer turn.
 * Completion fields are associations to actual B35 output, never self-proving
 * consent. The coordinated host must verify them before closure or rollover. */
export type ActionAuthoringLogicalTurn = {
  id: string;
  origin_context_digest: Digest;
  iterations_used: number;
  tool_calls_used: number;
  used_version_corrections?: string[];
  wording_correction_used?: true;
  completed?: { kind: "ordinary_clarification" | "compiled_draft";
    completion: AuthoringQuestionCompletion; material_digest: Digest };
  legacy_start?: { checkpoint_digest: Digest; completion: AuthoringQuestionCompletion };
};
export type ActionAuthoringPendingVersion = {
  turn_id: string; root_question_id: string; question_id: string; handoff_id: string;
  resource: string; field: string; proof_digest: Digest;
};

export type ActionRuleAuthoringCheckpoint = {
  schema_version: "synapsor.action-authoring-checkpoint.v1" | "synapsor.action-authoring-checkpoint.v4";
  authoring_protocol?: StructuredAuthoringProtocol;
  intent_digest: `sha256:${string}`;
  context_digest: `sha256:${string}`;
  components: Partial<Record<"verification" | "effect" | "rule" | "approval", Record<string, unknown>>>;
  logical_turns?: ActionAuthoringLogicalTurn[];
  pending_version?: ActionAuthoringPendingVersion;
  subject_question?: { id: string; revision: number; question_digest: Digest };
  /** Exact validated native proposal DATA, retained before ordinary closure. */
  requirement_proposals?: ActionRequirementProposals;
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
  const core = { schema_version: input.authoring_protocol ? "synapsor.action-authoring-checkpoint.v4" as const : "synapsor.action-authoring-checkpoint.v1" as const, ...structuredClone(input) };
  return parseActionRuleAuthoringCheckpoint({ ...core, digest: canonicalJsonDigest(core) });
}

export function parseActionRuleAuthoringCheckpoint(value: unknown): ActionRuleAuthoringCheckpoint {
  const fail = () => new Error("ACTION_AUTHORING_CHECKPOINT_INVALID: saved draft components are invalid or changed. Active authority is unchanged.");
  if (!value || typeof value !== "object" || Array.isArray(value)) throw fail();
  const record = value as Record<string, unknown>;
  if ((record.schema_version !== "synapsor.action-authoring-checkpoint.v1" && record.schema_version !== "synapsor.action-authoring-checkpoint.v4")
    || Object.keys(record).some((key) => !["schema_version", "authoring_protocol", "intent_digest", "context_digest", "components", "requirement_proposals", "operator_messages", "pending_question", "reviewed_relationships", "reviewed_private_sources", "reviewed_version_fields", "reopened_draft", "source_repair", "logical_turns", "pending_version", "subject_question", "digest"].includes(key))
    || ![record.intent_digest, record.context_digest, record.digest].every((digest) => typeof digest === "string" && /^sha256:[a-f0-9]{64}$/u.test(digest))
    || !record.components || typeof record.components !== "object" || Array.isArray(record.components)) throw fail();
  if (record.schema_version === "synapsor.action-authoring-checkpoint.v4") parseStructuredAuthoringProtocol(record.authoring_protocol);
  else if (record.authoring_protocol !== undefined) throw fail();
  if (record.requirement_proposals !== undefined) {
    if (record.schema_version !== "synapsor.action-authoring-checkpoint.v4") throw fail();
    parseActionRequirementProposals(record.requirement_proposals);
  }
  const rule = (record.components as Record<string, unknown>).rule;
  if (rule && typeof rule === "object" && (Object.hasOwn(rule, "shared_sum_proposal") || Object.hasOwn(rule, "requirement_proposals"))
    && record.schema_version !== "synapsor.action-authoring-checkpoint.v4") throw fail();
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
  if (record.logical_turns !== undefined) {
    const turns = record.logical_turns;
    const digest = (v: unknown) => typeof v === "string" && /^sha256:[a-f0-9]{64}$/u.test(v);
    const uuid = (v: unknown) => typeof v === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(v);
    const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
    const completion = (v: unknown) => object(v) && Object.keys(v).every(k => ["operation_id", "request_digest", "context_digest", "response_digest"].includes(k))
      && uuid(v.operation_id) && [v.request_digest, v.context_digest, v.response_digest].every(digest);
    if (!Array.isArray(turns) || !turns.length) throw fail();
    const ids = new Set<string>();
    for (let i = 0; i < turns.length; i += 1) {
      const turn = turns[i];
      if (!object(turn) || Object.keys(turn).some(k => !["id", "origin_context_digest", "iterations_used", "tool_calls_used", "used_version_corrections", "wording_correction_used", "completed", "legacy_start"].includes(k))
        || !uuid(turn.id) || ids.has(turn.id as string) || !digest(turn.origin_context_digest)
        || !Number.isSafeInteger(turn.iterations_used) || (turn.iterations_used as number) < 0 || (turn.iterations_used as number) > 12
        || !Number.isSafeInteger(turn.tool_calls_used) || (turn.tool_calls_used as number) < 0 || (turn.tool_calls_used as number) > 24) throw fail();
      ids.add(turn.id as string);
      if (turn.wording_correction_used !== undefined && turn.wording_correction_used !== true) throw fail();
      if (turn.used_version_corrections !== undefined && (!Array.isArray(turn.used_version_corrections)
        || !turn.used_version_corrections.length || turn.used_version_corrections.some(root => !uuid(root))
        || new Set(turn.used_version_corrections).size !== turn.used_version_corrections.length)) throw fail();
      if (turn.completed !== undefined) {
        const c = turn.completed;
        if (!object(c) || Object.keys(c).some(k => !["kind", "completion", "material_digest"].includes(k))
          || !["ordinary_clarification", "compiled_draft"].includes(c.kind as string)
          || !completion(c.completion) || !digest(c.material_digest)) throw fail();
      } else if (i !== turns.length - 1) throw fail();
      if (turn.legacy_start !== undefined) {
        const legacy = turn.legacy_start;
        if (i !== 0 || !object(legacy) || Object.keys(legacy).some(k => !["checkpoint_digest", "completion"].includes(k))
          || !digest(legacy.checkpoint_digest) || !completion(legacy.completion)) throw fail();
      }
    }
  }
  if (record.subject_question !== undefined) {
    const q = record.subject_question as ActionRuleAuthoringCheckpoint["subject_question"];
    if (record.schema_version !== "synapsor.action-authoring-checkpoint.v4" || !q || typeof q !== "object" || Array.isArray(q)
      || Object.keys(q).some(k => !["id", "revision", "question_digest"].includes(k))
      || typeof q.id !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(q.id)
      || !Number.isSafeInteger(q.revision) || q.revision < 1 || typeof q.question_digest !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(q.question_digest)
      || !(record.logical_turns as ActionAuthoringLogicalTurn[] | undefined)?.length) throw fail();
  }
  if (record.pending_version !== undefined) {
    const v = record.pending_version as ActionAuthoringPendingVersion;
    const uuid = (v: unknown) => typeof v === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(v);
    const tail = (record.logical_turns as ActionAuthoringLogicalTurn[] | undefined)?.at(-1);
    if (!v || typeof v !== "object" || Array.isArray(v)
      || Object.keys(v).some(k => !["turn_id", "root_question_id", "question_id", "handoff_id", "resource", "field", "proof_digest"].includes(k))
      || ![v.turn_id, v.root_question_id, v.question_id].every(uuid)
      || typeof v.handoff_id !== "string" || !v.handoff_id.trim() || v.handoff_id.length > 256
      || typeof v.resource !== "string" || v.resource.length > 256 || !/^[A-Za-z_][A-Za-z0-9_.]*$/u.test(v.resource)
      || typeof v.field !== "string" || v.field.length > 256 || !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(v.field)
      || typeof v.proof_digest !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(v.proof_digest)
      || !tail || tail.id !== v.turn_id || tail.completed
      || !(record.pending_question as ActionRuleAuthoringCheckpoint["pending_question"])?.completion) throw fail();
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
        || Object.keys(source).some(key => !["resource", "parent_resource", "relationship", "proof_digest", "evidence_mode", "scope_mapping", "scope_confirmation"].includes(key))
        || [source.resource, source.parent_resource, source.relationship].some(name => typeof name !== "string"
          || name.length > 256 || !/^[A-Za-z_][A-Za-z0-9_.]*$/u.test(name))
        || typeof source.proof_digest !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(source.proof_digest)
        || names.has(source.resource)) throw fail();
      names.add(source.resource);
      if (source.evidence_mode !== undefined) {
        const mapping = source.scope_mapping, confirmation = source.scope_confirmation;
        if (source.evidence_mode !== "required_scoped_singleton" || !mapping || !confirmation
          || Object.keys(mapping).some(key => !["tenant_field", "principal_field"].includes(key))
          || ![mapping.tenant_field, mapping.principal_field].every(name => typeof name === "string" && /^[A-Za-z_][A-Za-z0-9_$]*$/u.test(name))
          || mapping.tenant_field === mapping.principal_field
          || Object.keys(confirmation).some(key => !["actor", "confirmed_at"].includes(key))
          || confirmation.actor !== "local_installation_operator" || typeof confirmation.confirmed_at !== "string"
          || !Number.isFinite(Date.parse(confirmation.confirmed_at))
          || new Date(confirmation.confirmed_at).toISOString() !== confirmation.confirmed_at) throw fail();
      } else if (source.scope_mapping !== undefined || source.scope_confirmation !== undefined) throw fail();
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
    if (!exact(c, ["source_digest", "read_digest", "catalog_digest", "parent_digest", "outcome", "source_answer_history_digest", "interpretation_digest", "source_ranges", "component", "editable_paths", "binding_permutation"])
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
    if (c.binding_permutation !== undefined) {
      const p = c.binding_permutation;
      if (!object(p) || !exact(p, ["slots", "original_bindings"]) || !Array.isArray(p.slots) || p.slots.length < 2 || p.slots.length > 32
        || !Array.isArray(p.original_bindings) || p.original_bindings.length !== p.slots.length
        || new Set(p.original_bindings).size !== p.original_bindings.length
        || p.slots.some((slot,i) => !Number.isSafeInteger(slot) || slot < 0 || i > 0 && slot <= p.slots[i-1]!
          || repair.original_parent.verification?.resources?.[slot]?.binding !== p.original_bindings[i])) throw fail();
    }
  }
  if (Buffer.byteLength(JSON.stringify(record), "utf8") > 96 * 1024) throw fail();
  const { digest, ...core } = record;
  if (canonicalJsonDigest(core) !== digest) throw fail();
  return structuredClone(record) as ActionRuleAuthoringCheckpoint;
}

/** Structural CAS transition guard. Genuine B35 completion, currentness and
 * human INPUT acknowledgement are independently required by the host. */
export function assertActionLogicalTurnJournalAdvance(previous: ActionRuleAuthoringCheckpoint | undefined,
  next: ActionRuleAuthoringCheckpoint): void {
  const fail = () => new Error("ACTION_AUTHORING_LOGICAL_TURN_STALE: Preserve the owning turn; its admissions or completion changed.");
  const before = previous?.logical_turns, after = next.logical_turns;
  if (!before) {
    if (!after) return;
    if (after.length !== 1 || after[0]!.completed || after[0]!.iterations_used !== 0 || after[0]!.tool_calls_used !== 0
      || after[0]!.used_version_corrections || after[0]!.wording_correction_used) throw fail();
    if (previous && after[0]!.legacy_start?.checkpoint_digest !== previous.digest) throw fail();
    if (!previous && after[0]!.legacy_start) throw fail();
    return;
  }
  if (!after || after.length < before.length || after.length > before.length + 1 || previous!.intent_digest !== next.intent_digest) throw fail();
  for (let i = 0; i < before.length; i += 1) {
    const old = before[i]!, current = after[i]!;
    if (old.completed) { if (canonicalJsonDigest(old) !== canonicalJsonDigest(current)) throw fail(); continue; }
    if (i !== before.length - 1 || current.id !== old.id || current.origin_context_digest !== old.origin_context_digest
      || canonicalJsonDigest(current.legacy_start ?? null) !== canonicalJsonDigest(old.legacy_start ?? null)
      || current.iterations_used < old.iterations_used || current.tool_calls_used < old.tool_calls_used) throw fail();
    const roots = old.used_version_corrections ?? [], nextRoots = current.used_version_corrections ?? [];
    if (old.wording_correction_used && !current.wording_correction_used) throw fail();
    if (nextRoots.length < roots.length || roots.some((root, index) => nextRoots[index] !== root)) throw fail();
    if (after.length > before.length && !current.completed) throw fail();
  }
  if (after.length > before.length) {
    const tail = after.at(-1)!;
    if (tail.completed || tail.legacy_start || tail.iterations_used !== 0 || tail.tool_calls_used !== 0 || tail.used_version_corrections || tail.wording_correction_used) throw fail();
  }
}

/** Non-circular ordinary material association. Own journal/completion metadata
 * is excluded; this digest alone is never proof that a response was consumed. */
export function actionLogicalTurnMaterialDigest(checkpoint: ActionRuleAuthoringCheckpoint): Digest {
  return canonicalJsonDigest({ intent_digest: checkpoint.intent_digest, context_digest: checkpoint.context_digest,
    components: checkpoint.components, ...(checkpoint.requirement_proposals ? { requirement_proposals: checkpoint.requirement_proposals } : {}), question: checkpoint.pending_question ? {
      question: checkpoint.pending_question.question, operator_message: checkpoint.pending_question.operator_message,
      policy_source_digest: checkpoint.pending_question.policy_source_digest ?? null } : null });
}

/** The host reads its exact current checkpoint and atomically saves against the
 * supplied digest. This helper never infers admissions from transport rows. */
export function actionLogicalTurnBudget(input: {
  read(): ActionRuleAuthoringCheckpoint;
  save(next: ActionRuleAuthoringCheckpoint, expectedDigest: Digest): Promise<void>;
}): AskAuthoringEpisodeBudget & { reserveCorrection(rootQuestionId: string): Promise<boolean>; reserveWordingCorrection(): Promise<boolean> } {
  const tail = (checkpoint: ActionRuleAuthoringCheckpoint) => {
    const current = checkpoint.logical_turns?.at(-1);
    if (!current || current.completed) throw new AskError("ASK_ACTION_LOGICAL_TURN_PENDING", "The genuine owning Action turn is unavailable; preserve saved work.", 409);
    return current;
  };
  const update = async (change: (turn: ActionAuthoringLogicalTurn, checkpoint: ActionRuleAuthoringCheckpoint) => boolean) => {
    const previous = parseActionRuleAuthoringCheckpoint(input.read()), current = structuredClone(tail(previous));
    if (!change(current, previous)) return false;
    const { schema_version: _schema, digest: _digest, ...core } = previous;
    const next = actionRuleAuthoringCheckpoint({ ...core, logical_turns: [...previous.logical_turns!.slice(0, -1), current] });
    assertActionLogicalTurnJournalAdvance(previous, next);
    await input.save(next, previous.digest);
    return true;
  };
  return {
    async admitIteration() {
      assertAuthoringGenerationAdmission();
      await update(turn => {
        if (turn.iterations_used >= 12) throw new AskError("ASK_LOOP_LIMIT_EXCEEDED", "The saved Action logical turn has used its twelve model iterations. Preserve its pending work.", 422);
        turn.iterations_used += 1; return true;
      });
    },
    async reserveToolBatch(count) {
      await update(turn => {
        if (!Number.isSafeInteger(count) || count < 1 || count > 4 || turn.tool_calls_used + count > 24)
          throw new AskError("ASK_TOOL_BUDGET_EXCEEDED", "The whole batch does not fit the saved Action logical turn. No callback was admitted.", 422);
        turn.tool_calls_used += count; return true;
      });
    },
    async reserveCorrection(rootQuestionId) {
      return update((turn, checkpoint) => {
        if (checkpoint.pending_version?.root_question_id !== rootQuestionId)
          throw new AskError("ASK_ACTION_VERSION_QUESTION_STALE", "The correction does not belong to the current pending Version root.", 409);
        if (turn.used_version_corrections?.includes(rootQuestionId)) return false;
        turn.used_version_corrections = [...turn.used_version_corrections ?? [], rootQuestionId]; return true;
      });
    },
    async reserveWordingCorrection() {
      return update(turn => {
        if (turn.wording_correction_used) return false;
        turn.wording_correction_used = true; return true;
      });
    },
  };
}
