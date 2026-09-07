import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { assertGovernedReadEditDecision, readEditEventId, type GovernedReadEditDecision } from "./control-policy-read-edit.js";
import { parseBoundaryReviewDecisionFile } from "./boundary-review-decision-file.js";

function fixture() {
  const binding = { repository_id: randomUUID(), deployment_id: randomUUID(), project_id: randomUUID() };
  const before = { ...binding, epoch: 3, revision_id: `policy:${"a".repeat(64)}` };
  const review = { before, review_decision_digest: canonicalJsonDigest("review"), candidate_digest: canonicalJsonDigest("candidate"),
    generated_contract_digest: canonicalJsonDigest("contract") };
  const issued_at = new Date(Date.now() - 1000).toISOString();
  const expires_at = new Date(Date.now() + 60_000).toISOString();
  const operator_envelope: GovernedReadEditDecision["operator_envelope"] = {
    schema_version: "synapsor.boundary-review-operator-decision.v1", review_decision_digest: review.review_decision_digest,
    before: { draft_digest: canonicalJsonDigest("draft"), candidate_digest: canonicalJsonDigest("old"),
      generation_lock_fingerprint: canonicalJsonDigest("lock"), schema_fingerprint: canonicalJsonDigest("schema"),
      role_posture_fingerprint: canonicalJsonDigest("role"), review_revision: 1, authoring: before },
    after_candidate_digest: review.candidate_digest, generated_contract_digest: review.generated_contract_digest,
    required_role: "reviewer", environment: "staging", issued_at, expires_at, nonce: "nonsecret-review-nonce-0001",
  };
  const decision_id = canonicalJsonDigest(operator_envelope);
  const operator_proof: GovernedReadEditDecision["operator_proof"] = {
    provider: "signed_key", verified: true, subject: "alice", roles: ["reviewer"],
    decision: { schema_version: "synapsor.operator-decision.v1", action: "boundary_review",
      proposal_id: `boundary_review_${review.review_decision_digest.slice(7, 31)}`, proposal_version: 1,
      proposal_hash: decision_id, subject: "alice", issued_at },
    decision_hash: canonicalJsonDigest("proof"), integrity_hash: canonicalJsonDigest("integrity"), signature: "unit-test-signature",
  };
  const input = { ...binding, ...review, purpose: "edit_read" as const, subject: "alice", provider: "signed_key" as const,
    nonce_digest: canonicalJsonDigest({ nonce: operator_envelope.nonce }), decision_id, decision_hash: operator_proof.decision_hash,
    integrity_hash: operator_proof.integrity_hash, issued_at, expires_at, operator_envelope, operator_proof };
  const decision: GovernedReadEditDecision = { ...input, event_id: readEditEventId(input) };
  return { binding, review, decision };
}

describe("verified governed Read edit receipts", () => {
  it("binds an exact review and keeps the nonce identity stable across later proofs and revisions", () => {
    const { binding, review, decision } = fixture();
    expect(() => assertGovernedReadEditDecision(decision, binding, "alice", review)).not.toThrow();
    const later = { ...decision, decision_id: canonicalJsonDigest("later proof"), before: { ...decision.before, epoch: 4 },
      issued_at: new Date().toISOString(), review_decision_digest: canonicalJsonDigest("later review") };
    expect(readEditEventId(later)).toBe(decision.event_id);
    expect(readEditEventId({ ...later, nonce_digest: canonicalJsonDigest("new nonce") })).not.toBe(decision.event_id);
  });

  it.each(["repository", "deployment", "project", "actor", "before", "candidate", "review", "contract", "event", "nonce",
    "expired", "future", "invalid_expiry", "provider", "extra", "proof_actor", "proof_role", "proof_decision", "envelope"])("refuses mismatched or invalid %s", (mode) => {
    const { binding, review, decision } = fixture();
    if (mode === "repository") decision.repository_id = randomUUID();
    if (mode === "deployment") decision.deployment_id = randomUUID();
    if (mode === "project") decision.project_id = randomUUID();
    if (mode === "actor") decision.subject = "mallory";
    if (mode === "before") decision.before = { ...decision.before, epoch: 4 };
    if (mode === "candidate") decision.candidate_digest = canonicalJsonDigest("wrong");
    if (mode === "review") decision.review_decision_digest = canonicalJsonDigest("wrong");
    if (mode === "contract") decision.generated_contract_digest = canonicalJsonDigest("wrong");
    if (mode === "event") decision.event_id = "invented";
    if (mode === "nonce") decision.nonce_digest = canonicalJsonDigest("wrong");
    if (mode === "expired") decision.expires_at = new Date(Date.now() - 500).toISOString();
    if (mode === "future") decision.issued_at = new Date(Date.now() + 1000).toISOString();
    if (mode === "invalid_expiry") decision.expires_at = "invalid";
    if (mode === "provider") (decision as { provider: string }).provider = "dev_env";
    if (mode === "extra") Object.assign(decision, { approved_by_model: true });
    if (mode === "proof_actor") decision.operator_proof.subject = "mallory";
    if (mode === "proof_role") decision.operator_proof.roles = ["reader"];
    if (mode === "proof_decision") decision.operator_proof.decision.proposal_hash = canonicalJsonDigest("different proof");
    if (mode === "envelope") decision.operator_envelope.after_candidate_digest = canonicalJsonDigest("different envelope");
    expect(() => assertGovernedReadEditDecision(decision, binding, "alice", review))
      .toThrow(expect.objectContaining({ code: "POLICY_READ_EDIT_DECISION_INVALID" }));
  });

  it.each(["valid", "legacy", "extra", "bad_epoch", "bad_revision", "bad_repository"])("parses exact batch authoring bindings: %s", (mode) => {
    const { review } = fixture();
    const authoring = { ...review.before };
    if (mode === "extra") Object.assign(authoring, { approved: true });
    if (mode === "bad_epoch") authoring.epoch = -1;
    if (mode === "bad_revision") authoring.revision_id = "selected";
    if (mode === "bad_repository") (authoring as { repository_id: string }).repository_id = "other";
    const file = { schema_version: "synapsor.boundary-review-decisions.v1", review_bundle_digest: canonicalJsonDigest("bundle"),
      bindings: { draft_digest: canonicalJsonDigest("draft"), candidate_digest: review.candidate_digest,
        generation_lock_fingerprint: canonicalJsonDigest("lock"), schema_fingerprint: canonicalJsonDigest("schema"),
        role_posture_fingerprint: canonicalJsonDigest("role"), review_revision: 2,
        ...(mode === "legacy" ? {} : { authoring }) }, actor: "alice", reason: "Keep private verification available",
      resources: [{ resource_id: "inventory.items", withhold_from_model_fields: ["version"] }] };
    if (mode === "valid" || mode === "legacy") {
      expect(parseBoundaryReviewDecisionFile(file)).toEqual(file);
    } else expect(() => parseBoundaryReviewDecisionFile(file)).toThrow();
  });
});
