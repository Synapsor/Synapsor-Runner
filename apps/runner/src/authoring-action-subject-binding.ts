import { z } from "zod";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { parseTypedParameterReference, type TypedParameterReference } from "./authoring-typed-parameter-binding.js";
import { parseTypedReviewView, parseTypedFieldEvent, validateTypedFieldEvent } from "./authoring-typed-review-codec.js";
import type { TypedFieldEvent, TypedReviewView } from "./authoring-typed-review.js";
import type { AuthoringQuestionCompletion, AuthoringTransportState } from "./authoring-generation-recovery.js";

type Digest = `sha256:${string}`;
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/u).transform(v => v as Digest);
const text = z.string().min(1).max(256).refine(v => v.trim() === v);
const revision = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const completion = z.object({ operation_id: text, request_digest: digest, context_digest: digest, response_digest: digest }).strict();
const targetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("verification_subject"), binding: text, resource: text }).strict(),
  z.object({ kind: z.literal("primary_effect"), resource: text, binding: text.optional() }).strict(),
  z.object({ kind: z.literal("atomic_effect"), index: z.number().int().min(0).max(63), resource: text, binding: text }).strict(),
]);
const optionSchema = z.object({ reference: digest, target_digest: digest, kind: z.enum(["principal", "tenant", "global"]), dependencies_digest: digest }).strict();
const materialSchema = z.object({ version: z.literal(1), outcome: text, logical_turn_id: text, baseline: z.unknown(), request_digest: digest,
  applicability_digest: digest, candidate_digest: digest,
  targets: z.array(z.object({ target: targetSchema, target_digest: digest, options: z.array(optionSchema).min(1).max(64) }).strict()).min(1).max(64),
}).strict();
const bindingSchema = z.object({ version: z.literal(1), material: materialSchema,
  origin: z.object({ completion, material_digest: digest }).strict(),
  predecessor: z.object({ question_id: z.string().uuid(), question_digest: digest }).strict().optional(),
}).strict();
const rawAnswerSchema = z.object({ kind: z.literal("operator_answer"), question_id: z.string().uuid(), question_revision: revision,
  answer_id: z.string().uuid(), answer_digest: digest, context_digest: digest }).strict();
const supportSchema = z.discriminatedUnion("kind", [rawAnswerSchema,
  z.object({ kind: z.literal("source_interpretation"), source_session: text, source_digest: digest, store_digest: digest,
    interpretation_question_id: z.string().uuid(), interpretation_question_revision: revision, proposal_digest: digest,
    start: revision, end: revision }).strict(),
  z.object({ kind: z.literal("read_subject"), question_id: z.string().uuid(), question_revision: revision,
    question_digest: digest, scope_record_digest: digest, requirement_id: text }).strict(),
  z.object({ kind: z.literal("operator_choice"), proposal_revision: revision, event_digest: digest }).strict(),
]);
const entrySchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("awaiting"), target_digest: digest }).strict(),
  z.object({ state: z.literal("unresolved"), target_digest: digest, question: z.string().min(1).max(4000), support: supportSchema.optional() }).strict(),
  z.object({ state: z.literal("proposed"), target_digest: digest, meaning: z.enum(["trusted_principal", "reviewed_scope"]), scope_reference: digest, support: supportSchema }).strict(),
]);
export type ActionSubjectTarget = z.infer<typeof targetSchema>;
export type ActionSubjectOption = z.infer<typeof optionSchema>;
export type ActionSubjectSupport = z.infer<typeof supportSchema>;
export type ActionSubjectEntry = z.infer<typeof entrySchema>;
export type ActionSubjectHostMaterial = Omit<z.infer<typeof materialSchema>, "baseline"> & { baseline: TypedParameterReference | null };
export type ActionSubjectBinding = Omit<z.infer<typeof bindingSchema>, "material"> & { material: ActionSubjectHostMaterial };
export type ActionSubjectProposal = {
  version: 1; entries: ActionSubjectEntry[]; meaning_digest: Digest; view: TypedReviewView;
  provenance: { kind: "initial_producer" } | { kind: "model_answer"; completion: AuthoringQuestionCompletion; answer: z.infer<typeof rawAnswerSchema> }
    | { kind: "operator_field"; event: TypedFieldEvent };
  predecessor_proposal_digest?: Digest;
};
function fail(): never { throw new Error("ACTION_SUBJECT_INVALID: The exact Action target, scope, provenance or retained proposal is invalid. No authority was accepted."); }
const equal = (a: unknown, b: unknown) => canonicalJsonDigest(a) === canonicalJsonDigest(b);
function strict<S extends z.ZodTypeAny>(schema: S, value: unknown): z.output<S> {
  const result = schema.safeParse(value);
  if (!result.success || !equal(result.data, value)) fail();
  return structuredClone(result.data);
}
export function parseActionSubjectMaterial(value: unknown): ActionSubjectHostMaterial {
  const raw = strict(materialSchema, value);
  const baseline = raw.baseline === null ? null : parseTypedParameterReference(raw.baseline);
  if (baseline && baseline.outcome !== raw.outcome) fail();
  if (new Set(raw.targets.map(t => t.target_digest)).size !== raw.targets.length) fail();
  for (const item of raw.targets) {
    if (item.target_digest !== canonicalJsonDigest(item.target) || new Set(item.options.map(o => o.reference)).size !== item.options.length) fail();
    for (const option of item.options) if (option.target_digest !== item.target_digest) fail();
  }
  return { ...raw, baseline };
}
export function parseActionSubjectBinding(value: unknown): ActionSubjectBinding {
  const raw = strict(bindingSchema, value);
  return { ...raw, material: parseActionSubjectMaterial(raw.material) };
}
/** This validates references, not their authority. The host must resolve every
 * support against current records before a grouped confirmation can be consumed. */
export function parseActionSubjectEntries(value: unknown, materialInput: ActionSubjectHostMaterial): ActionSubjectEntry[] {
  const material = parseActionSubjectMaterial(materialInput);
  const entries = strict(z.array(entrySchema).min(1).max(64), value);
  if (entries.length !== material.targets.length || new Set(entries.map(e => e.target_digest)).size !== entries.length) fail();
  for (const entry of entries) {
    const target = material.targets.find(t => t.target_digest === entry.target_digest);
    if (!target) fail();
    if (entry.state === "awaiting") continue;
    if (entry.support?.kind === "source_interpretation" && entry.support.end < entry.support.start) fail();
    if (entry.support?.kind === "read_subject" && target.target.kind !== "verification_subject") fail();
    if (entry.state === "proposed") {
      const option = target.options.find(o => o.reference === entry.scope_reference);
      if (!option || entry.meaning === "trusted_principal" && option.kind !== "principal") fail();
    }
  }
  return entries;
}
export function actionSubjectOriginDigest(material: ActionSubjectHostMaterial, initial: readonly ActionSubjectEntry[]): Digest {
  return canonicalJsonDigest({ host: parseActionSubjectMaterial(material), initial: parseActionSubjectEntries(initial, material) });
}
export function actionSubjectFieldDependencies(material: ActionSubjectHostMaterial, target: ActionSubjectHostMaterial["targets"][number]): Digest {
  return canonicalJsonDigest({ applicability_digest: material.applicability_digest, candidate_digest: material.candidate_digest, target });
}
export function actionSubjectViewDigest(view: TypedReviewView): Digest {
  const { view_digest: _, ...binding } = view.binding;
  return canonicalJsonDigest({ ...view, binding });
}
export function parseActionSubjectProposal(value: unknown, binding: ActionSubjectBinding): ActionSubjectProposal {
  const raw = strict(z.object({ version: z.literal(1), entries: z.unknown(), meaning_digest: digest, view: z.unknown(),
    provenance: z.discriminatedUnion("kind", [z.object({ kind: z.literal("initial_producer") }).strict(),
      z.object({ kind: z.literal("model_answer"), completion, answer: rawAnswerSchema }).strict(),
      z.object({ kind: z.literal("operator_field"), event: z.unknown() }).strict()]),
    predecessor_proposal_digest: digest.optional() }).strict(), value);
  const entries = parseActionSubjectEntries(raw.entries, binding.material), view = parseTypedReviewView(raw.view);
  if (raw.meaning_digest !== canonicalJsonDigest(entries) || view.binding.proposal_digest !== raw.meaning_digest
    || view.binding.applicability_digest !== binding.material.applicability_digest || view.binding.operation_id !== binding.origin.completion.operation_id) fail();
  const provenance = raw.provenance.kind === "operator_field" ? { kind: "operator_field" as const, event: parseTypedFieldEvent(raw.provenance.event) } : raw.provenance;
  // No hidden fields or option expansion may be smuggled into the local readback.
  if (view.binding.view_digest !== actionSubjectViewDigest(view) || view.fields.length !== binding.material.targets.length) fail();
  for (const target of binding.material.targets) {
    const fields = view.fields.filter(f => f.target_digest === target.target_digest);
    if (fields.length !== 1) fail();
    const field = fields[0]!;
    if (field.kind !== "choice" || !field.required || field.dependencies_digest !== actionSubjectFieldDependencies(binding.material, target) || field.options.length !== target.options.length
      || !equal(field.options.map(o => o.value).sort(), target.options.map(o => o.reference).sort())) fail();
  }
  return { ...raw, entries, view, provenance };
}
/** Full records remain in existing native question history. No mutable meaning
 * lives in the fixed binding, and a direct choice never fabricates raw testimony. */
export function assertActionSubjectSequence(bindingInput: ActionSubjectBinding, values: readonly unknown[]): ActionSubjectProposal[] {
  const binding = parseActionSubjectBinding(bindingInput);
  if (!values.length) fail();
  const records = values.map(value => parseActionSubjectProposal(value, binding));
  for (let index = 0; index < records.length; index++) {
    const record = records[index]!, previous = records[index - 1];
    if (record.view.binding.proposal_revision !== index + 1) fail();
    if (!previous) {
      if (record.provenance.kind !== "initial_producer" || record.predecessor_proposal_digest
        || actionSubjectOriginDigest(binding.material, record.entries) !== binding.origin.material_digest
        || record.entries.some(e => e.state !== "awaiting" && e.support?.kind === "operator_choice")) fail();
      continue;
    }
    if (record.view.binding.proposal_id !== previous.view.binding.proposal_id || record.predecessor_proposal_digest !== canonicalJsonDigest(previous)
      || record.provenance.kind === "initial_producer") fail();
    if (record.provenance.kind === "operator_field") {
      const event = record.provenance.event;
      validateTypedFieldEvent(previous.view, event);
      if (event.kind !== "select_option" && event.kind !== "leave_pending") fail();
      for (const old of previous.entries) {
        const next = record.entries.find(e => e.target_digest === old.target_digest)!;
        if (old.target_digest !== event.target_digest) { if (!equal(old, next)) fail(); continue; }
        if (event.kind === "leave_pending") { if (!equal(next, { state: "awaiting", target_digest: event.target_digest })) fail(); continue; }
        const option = binding.material.targets.find(t => t.target_digest === event.target_digest)!.options.find(o => o.reference === event.value);
        const expected = { state: "proposed", target_digest: event.target_digest, meaning: option?.kind === "principal" ? "trusted_principal" : "reviewed_scope",
          scope_reference: event.value, support: { kind: "operator_choice", proposal_revision: index + 1, event_digest: canonicalJsonDigest(event) } };
        if (!option || !equal(next, expected)) fail();
      }
    } else {
      for (const entry of record.entries) {
        const old = previous.entries.find(e => e.target_digest === entry.target_digest)!;
        if (equal(old, entry) || entry.state === "awaiting") continue;
        if (entry.support?.kind === "operator_choice" || entry.support?.kind === "operator_answer" && !equal(entry.support, record.provenance.answer)) fail();
      }
    }
  }
  return records;
}
/** Genuine saved transport association only; never manufactures completion. */
export function assertActionSubjectGeneration(binding: ActionSubjectBinding, generation: AuthoringTransportState | undefined): void {
  const c = binding.origin.completion, op = generation?.operations.find(o => o.id === c.operation_id);
  if (!op || op.state !== "checkpointed" || op.checkpoint_seen !== true || op.request_digest !== c.request_digest || op.context_digest !== c.context_digest
    || op.attempts.at(-1)?.outcome !== "response" || !equal(op.action_checkpoint, { consumer: "action_rule_components", kind: "subject_proposal",
      material_digest: binding.origin.material_digest, response_digest: c.response_digest })) fail();
}
