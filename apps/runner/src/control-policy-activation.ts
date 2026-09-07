import { z } from "zod";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import type { BoundProjectPolicyStore } from "./control-policy-store.js";

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const readDecisionSchema = z.object({
  purpose: z.literal("activate_read"), repository_id: z.string().uuid(),
  deployment_id: z.string().uuid(), project_id: z.string().uuid(),
  event_id: z.string().max(256), nonce_digest: digest, decision_id: digest,
  boundary_digest: digest, review_bundle_digest: digest,
  subject: z.string().min(1).max(128), provider: z.enum(["signed_key", "jwt_oidc"]),
  decision_hash: z.string().min(1).max(256), integrity_hash: z.string().min(1).max(256),
  issued_at: z.string().datetime(), expires_at: z.string().datetime(),
}).strict();

/** An internal receipt of an already verified operator proof, NOT an identity
 * verifier or an activation endpoint. No model tool accepts this structure. */
export type GovernedReadActivationDecision = z.infer<typeof readDecisionSchema>;

export function readActivationEventId(input: Pick<GovernedReadActivationDecision,
  "repository_id" | "deployment_id" | "project_id" | "subject" | "nonce_digest">): string {
  return `read_activation:${canonicalJsonDigest({ purpose: "activate_read", repository_id: input.repository_id,
    deployment_id: input.deployment_id, project_id: input.project_id, subject: input.subject, nonce_digest: input.nonce_digest })}`;
}

export function assertGovernedReadActivationDecision(input: GovernedReadActivationDecision,
  binding: BoundProjectPolicyStore, actor: string, boundaryDigest: string): void {
  const parsed = readDecisionSchema.safeParse(input);
  const now = Date.now();
  if (!parsed.success || input.repository_id !== binding.repository_id || input.deployment_id !== binding.deployment_id
    || input.project_id !== binding.project_id || input.subject !== actor || input.boundary_digest !== boundaryDigest
    || input.event_id !== readActivationEventId(input)
    || Date.parse(input.issued_at) > now || Date.parse(input.expires_at) <= now
    || Date.parse(input.expires_at) <= Date.parse(input.issued_at)) {
    throw Object.assign(new Error("The verified Read activation decision is stale or does not match this exact review. No authority changed."),
      { code: "POLICY_ACTIVATION_DECISION_INVALID" });
  }
}

export function readActivationAlreadyConsumed(): Error {
  return Object.assign(new Error("Boundary activation decision was already consumed; create a fresh short-lived decision with a new nonce."),
    { code: "POLICY_EVENT_ALREADY_RECORDED" });
}
