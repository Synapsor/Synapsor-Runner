import { z } from "zod";
import { canonicalJsonDigest as hash } from "@synapsor-runner/protocol";
import { readAuthoringBindingsSchema } from "./control-policy-record.js";
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/u).transform(value => value as `sha256:${string}`);
const text = z.string().min(1).max(256).refine(value => value === value.trim());
/** Exact existing protected structural record identity. The owner must resolve
 * this reference against its actual current records; hashes alone are not proof. */
export const actionSubjectStructuralReferenceSchema = z.object({
  kind: z.literal("boundary_review"), boundary_id: text, review_revision: z.number().int().min(1),
  binding: z.object({ draft_digest: digest, candidate_digest: digest, generation_lock_fingerprint: digest,
    schema_fingerprint: digest, role_posture_fingerprint: digest, review_revision: z.number().int().min(0),
    authoring: readAuthoringBindingsSchema.optional() }).strict(),
  bundle_digest: digest, source_digest: digest, confirmations_digest: digest,
}).strict();
export const actionSubjectProofOptionSchema = z.object({ reference: digest, target_digest: digest,
  kind: z.enum(["principal", "tenant", "global"]), dependencies_digest: digest }).strict();
const scope = z.object({ root_resource: text, reference: text, source_digest: digest, review_digest: digest,
  configuration_digest: digest, kind: z.enum(["principal", "tenant", "global"]) }).strict();
export const actionSubjectRequestAckSchema = z.object({ question_id: z.string().uuid(), question_revision: z.number().int().min(1),
  question_digest: digest, checkpoint_digest: digest, resume_revision_digest: digest, proposal_digest: digest }).strict();
export const actionSubjectReviewMaterialSchema = z.object({ version: z.literal(1), phase: z.enum(["planned", "prepared", "reviewed"]), before: actionSubjectStructuralReferenceSchema,
  after: actionSubjectStructuralReferenceSchema, request_ack: actionSubjectRequestAckSchema,
  mutation: z.object({ preview_digest: digest, candidate_digest: digest, generation_lock_fingerprint: digest, draft_digest: digest, review_revision: z.number().int().min(1),
    requests: z.array(z.object({ resource: text, kind: z.enum(["direct", "derived", "postgres_rls"]), value: text }).strict()).min(1).max(64) }).strict(),
  changed_targets: z.array(digest).min(1).max(64),
  targets: z.array(z.object({ target_digest: digest, options: z.array(actionSubjectProofOptionSchema).max(64),
    proof: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("initial"), options_digest: digest }).strict(),
      z.object({ kind: z.literal("boundary_scope"), scope }).strict(),
    ]) }).strict()).min(1).max(64),
}).strict();
export type ActionSubjectStructuralReference = z.infer<typeof actionSubjectStructuralReferenceSchema>;
export type ActionSubjectReviewMaterial = z.infer<typeof actionSubjectReviewMaterialSchema>;
export type ActionSubjectRequestAck = z.infer<typeof actionSubjectRequestAckSchema>;
export function parseActionSubjectReviewMaterial(value: unknown): ActionSubjectReviewMaterial {
  const parsed = actionSubjectReviewMaterialSchema.safeParse(value);
  if (!parsed.success || hash(parsed.data) !== hash(value)) throw Error("ACTION_SUBJECT_PROOF_INVALID: The exact acknowledged structural transition is unavailable.");
  const p = parsed.data;
  if (p.before.boundary_id !== p.after.boundary_id || p.before.source_digest !== p.after.source_digest
    || ["schema_fingerprint", "role_posture_fingerprint"].some(key =>
      p.before.binding[key as "schema_fingerprint"] !== p.after.binding[key as "schema_fingerprint"])
    || (p.phase === "planned" ? hash(p.before) !== hash(p.after) || p.mutation.review_revision !== p.before.review_revision + 1
      : p.after.review_revision < p.mutation.review_revision || p.after.binding.candidate_digest !== p.mutation.candidate_digest
        || p.after.binding.generation_lock_fingerprint !== p.mutation.generation_lock_fingerprint || p.after.binding.draft_digest !== p.mutation.draft_digest)
    || p.after.review_revision !== p.after.binding.review_revision
    || new Set(p.changed_targets).size !== p.changed_targets.length || new Set(p.targets.map(t => t.target_digest)).size !== p.targets.length
    || p.changed_targets.some(target => !p.targets.some(t => t.target_digest === target)))
    throw Error("ACTION_SUBJECT_PROOF_INVALID: Structural review changed an unrelated binding or lost a target.");
  return structuredClone(parsed.data);
}
