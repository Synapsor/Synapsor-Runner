import { z } from "zod";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import type { OperatorQuestion } from "./authoring-operator-question.js";
import { parseActionSubjectEntries, type ActionSubjectEntry } from "./authoring-action-subject-binding.js";
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/u).transform(v => v as `sha256:${string}`);
const submitted = z.discriminatedUnion("state", [
  z.object({ state: z.literal("requested"), target_digest: digest, requested_kind: z.enum(["principal", "tenant", "global"]) }).strict(),
  z.object({ state: z.literal("awaiting"), target_digest: digest }).strict(),
  z.object({ state: z.literal("unresolved"), target_digest: digest, question: z.string().min(1).max(4000) }).strict(),
  z.object({ state: z.literal("proposed"), target_digest: digest, meaning: z.enum(["trusted_principal", "reviewed_scope"]), scope_reference: digest }).strict(),
]);
/** Model nominates exact choices, never native provenance, view hashes or Yes. */
export function actionSubjectSubmissionSchema(q: OperatorQuestion) {
  const b = q.action_subject;
  if (!b || !q.raw_answer) throw new Error("ACTION_SUBJECT_ANSWER_REQUIRED");
  const target = { type: "string", enum: b.material.targets.map(t => t.target_digest) };
  const common = { target_digest: target };
  return { type: "array", minItems: b.material.targets.length, maxItems: b.material.targets.length, items: { oneOf: [
    ...(b.version === 2 ? [{ type: "object", additionalProperties: false, required: ["state", "target_digest", "requested_kind"], properties: { ...common, state: { const: "requested" }, requested_kind: { enum: ["principal", "tenant", "global"] } } }] : []),
    { type: "object", additionalProperties: false, required: ["state", "target_digest"], properties: { ...common, state: { const: "awaiting" } } },
    { type: "object", additionalProperties: false, required: ["state", "target_digest", "question"], properties: { ...common, state: { const: "unresolved" }, question: { type: "string", minLength: 1, maxLength: 4000 } } },
    { type: "object", additionalProperties: false, required: ["state", "target_digest", "meaning", "scope_reference"], properties: { ...common,
      state: { const: "proposed" }, meaning: { enum: ["trusted_principal", "reviewed_scope"] },
      scope_reference: { type: "string", enum: (q.proposal?.value?.kind === "action_subject" && q.proposal.value.record.review_material?.targets || b.material.targets).flatMap(t => t.options.map(o => o.reference)) } } },
  ] } };
}
export function decodeActionSubjectSubmission(q: OperatorQuestion, input: unknown): ActionSubjectEntry[] {
  if (!q.action_subject || !q.raw_answer?.text.trim()) throw new Error("ACTION_SUBJECT_ANSWER_REQUIRED");
  const result = z.array(submitted).min(1).max(64).safeParse(input);
  if (!result.success || canonicalJsonDigest(result.data) !== canonicalJsonDigest(input)) throw new Error("ACTION_SUBJECT_SUBMISSION_INVALID");
  const support = { kind: "operator_answer" as const, question_id: q.id, question_revision: q.revision,
    answer_id: q.raw_answer.id, answer_digest: canonicalJsonDigest(q.raw_answer), context_digest: q.context_digest };
  const previous = q.proposal?.value?.kind === "action_subject" ? q.proposal.value.record.entries : [];
  return parseActionSubjectEntries(result.data.map(entry => {
    // Exact unchanged typed choices retain their original support; the captured
    // answer cannot silently replace another already established record.
    const old = previous.find(e => e.target_digest === entry.target_digest);
    if (entry.state === "awaiting" && (old?.state === "proposed" || old?.state === "requested")) return old;
    if (entry.state === "requested" && old?.state === "requested" && entry.requested_kind === old.requested_kind) return old;
    if (entry.state === "proposed" && old?.state === "proposed" && entry.meaning === old.meaning && entry.scope_reference === old.scope_reference) return old;
    return entry.state === "awaiting" ? entry : { ...entry, support };
  }), q.action_subject.material, q.proposal?.value?.kind === "action_subject" ? q.proposal.value.record.review_material : undefined);
}

/** Prepared context distinguishes the immutable producer material from current
 * host-verified options; the model never needs hidden structural proof records. */
export function actionSubjectModelContext(q: OperatorQuestion) {
  if (!q.action_subject || q.proposal?.value?.kind !== "action_subject") throw new Error("ACTION_SUBJECT_REQUIRED");
  const record = q.proposal.value.record;
  return { material: q.action_subject.material, effective_options: (record.review_material?.targets ?? q.action_subject.material.targets)
    .map(target => ({ target_digest: target.target_digest, options: target.options })), entries: record.entries };
}
