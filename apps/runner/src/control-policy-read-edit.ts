import { z } from "zod";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { readAuthoringBindingsSchema, type ReadAuthoringBindings } from "./control-policy-record.js";

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const operatorProofSchema = z.object({
  provider: z.enum(["signed_key", "jwt_oidc"]), verified: z.literal(true),
  subject: z.string().min(1).max(128), roles: z.array(z.string().min(1).max(256)).max(128),
  key_id: z.string().max(256).optional(), algorithm: z.string().max(64).optional(), issuer: z.string().max(2048).optional(),
  decision: z.object({ schema_version: z.literal("synapsor.operator-decision.v1"), action: z.literal("boundary_review"),
    proposal_id: z.string().max(128), proposal_version: z.literal(1), proposal_hash: digest,
    subject: z.string().min(1).max(128), issued_at: z.string().datetime(), reason: z.string().max(500).optional(),
  }).strict(), decision_hash: digest, signature: z.string().min(1).max(16_384), integrity_hash: digest,
}).strict();
const envelopeSchema = z.object({
  schema_version: z.literal("synapsor.boundary-review-operator-decision.v1"), review_decision_digest: digest,
  before: z.object({ draft_digest: digest, candidate_digest: digest, generation_lock_fingerprint: digest,
    schema_fingerprint: digest, role_posture_fingerprint: digest, review_revision: z.number().int().min(0),
    authoring: readAuthoringBindingsSchema,
  }).strict(), after_candidate_digest: digest, generated_contract_digest: digest,
  required_role: z.string().min(1).max(256), environment: z.string().min(1).max(64),
  issued_at: z.string().datetime(), expires_at: z.string().datetime(), nonce: z.string().regex(/^[A-Za-z0-9._~-]{16,200}$/u),
}).strict();
const decisionSchema = z.object({
  purpose: z.literal("edit_read"), repository_id: z.string().uuid(),
  deployment_id: z.string().uuid(), project_id: z.string().uuid(),
  before: readAuthoringBindingsSchema,
  event_id: z.string().max(256), nonce_digest: digest, decision_id: digest,
  review_decision_digest: digest, candidate_digest: digest, generated_contract_digest: digest,
  subject: z.string().min(1).max(128), provider: z.enum(["signed_key", "jwt_oidc"]),
  decision_hash: z.string().min(1).max(256), integrity_hash: z.string().min(1).max(256),
  issued_at: z.string().datetime(), expires_at: z.string().datetime(),
  operator_proof: operatorProofSchema, operator_envelope: envelopeSchema,
}).strict();

/** Internal receipt of the existing cryptographically verified operator proof.
 * This is not an authenticator, and no model tool accepts it. */
export type GovernedReadEditDecision = z.infer<typeof decisionSchema>;
export type GovernedReadEditReview = Pick<GovernedReadEditDecision,
  "before" | "review_decision_digest" | "candidate_digest" | "generated_contract_digest">;

export function readEditEventId(input: Pick<GovernedReadEditDecision,
  "repository_id" | "deployment_id" | "project_id" | "subject" | "nonce_digest">): string {
  return `read_edit:${canonicalJsonDigest({ purpose: "edit_read", repository_id: input.repository_id,
    deployment_id: input.deployment_id, project_id: input.project_id, subject: input.subject, nonce_digest: input.nonce_digest })}`;
}

export function assertGovernedReadEditDecision(input: GovernedReadEditDecision,
  binding: Pick<ReadAuthoringBindings, "repository_id" | "deployment_id" | "project_id">,
  actor: string, review: GovernedReadEditReview): void {
  const parsed = decisionSchema.safeParse(input);
  const now = Date.now();
  if (!parsed.success || input.repository_id !== binding.repository_id || input.deployment_id !== binding.deployment_id
    || input.project_id !== binding.project_id || input.subject !== actor
    || canonicalJsonDigest(input.before) !== canonicalJsonDigest(review.before)
    || input.review_decision_digest !== review.review_decision_digest || input.candidate_digest !== review.candidate_digest
    || input.generated_contract_digest !== review.generated_contract_digest || input.event_id !== readEditEventId(input)
    || canonicalJsonDigest(input.operator_envelope) !== input.decision_id
    || canonicalJsonDigest(input.operator_envelope.before.authoring) !== canonicalJsonDigest(input.before)
    || input.operator_envelope.review_decision_digest !== input.review_decision_digest
    || input.operator_envelope.after_candidate_digest !== input.candidate_digest
    || input.operator_envelope.generated_contract_digest !== input.generated_contract_digest
    || canonicalJsonDigest({ nonce: input.operator_envelope.nonce }) !== input.nonce_digest
    || input.operator_envelope.issued_at !== input.issued_at || input.operator_envelope.expires_at !== input.expires_at
    || input.operator_proof.subject !== input.subject || input.operator_proof.provider !== input.provider
    || !input.operator_proof.roles.includes(input.operator_envelope.required_role)
    || input.operator_proof.decision.proposal_hash !== input.decision_id || input.operator_proof.decision.subject !== input.subject
    || input.operator_proof.decision.issued_at !== input.issued_at
    || input.operator_proof.decision.proposal_id !== `boundary_review_${input.review_decision_digest.slice(7, 31)}`
    || input.operator_proof.decision_hash !== input.decision_hash || input.operator_proof.integrity_hash !== input.integrity_hash
    || Date.parse(input.issued_at) > now || Date.parse(input.expires_at) <= now
    || Date.parse(input.expires_at) <= Date.parse(input.issued_at)) {
    throw Object.assign(new Error("The verified Read edit is stale or does not match this exact review. No draft or active authority changed."),
      { code: "POLICY_READ_EDIT_DECISION_INVALID" });
  }
}

export function readEditAlreadyConsumed(): Error {
  return Object.assign(new Error("Boundary-review decision was already consumed; create a fresh short-lived decision with a new nonce."),
    { code: "POLICY_EVENT_ALREADY_RECORDED" });
}
