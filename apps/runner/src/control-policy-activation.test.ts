import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { assertGovernedReadActivationDecision, readActivationEventId, type GovernedReadActivationDecision } from "./control-policy-activation.js";
import type { BoundProjectPolicyStore } from "./control-policy-store.js";

describe("governed Read activation receipt binding", () => {
  const binding = { repository_id: randomUUID(), deployment_id: randomUUID(), project_id: randomUUID() } as BoundProjectPolicyStore;
  const decision = (): GovernedReadActivationDecision => {
    const value = { purpose: "activate_read" as const, repository_id: binding.repository_id,
      deployment_id: binding.deployment_id, project_id: binding.project_id, nonce_digest: canonicalJsonDigest("nonce"),
      decision_id: canonicalJsonDigest("verified decision"), boundary_digest: canonicalJsonDigest("reviewed boundary"),
      review_bundle_digest: canonicalJsonDigest("exact review"), subject: "alice", provider: "signed_key" as const,
      decision_hash: canonicalJsonDigest("signed proof"), integrity_hash: canonicalJsonDigest("signature"),
      issued_at: new Date(Date.now() - 1000).toISOString(), expires_at: new Date(Date.now() + 60_000).toISOString() };
    return { ...value, event_id: readActivationEventId(value) };
  };

  it("binds replay identity to purpose, repository, deployment, project, operator and nonce, not issuance time", () => {
    const current = decision();
    expect(() => assertGovernedReadActivationDecision(current, binding, "alice", current.boundary_digest)).not.toThrow();
    expect(readActivationEventId({ ...current, issued_at: new Date().toISOString() } as GovernedReadActivationDecision)).toBe(current.event_id);
    for (const key of ["repository_id", "deployment_id", "project_id", "subject", "nonce_digest"] as const) {
      expect(readActivationEventId({ ...current, [key]: key === "nonce_digest" ? canonicalJsonDigest("other nonce") : randomUUID() })).not.toBe(current.event_id);
    }
  });

  it.each(["expired", "future", "repository", "deployment", "project", "actor", "candidate", "nonce", "extra", "unverified_provider"])(
    "refuses an invalid receipt: %s", (change) => {
      const current = decision();
      const modified = structuredClone(current);
      if (change === "expired") modified.expires_at = new Date(Date.now() - 100).toISOString();
      if (change === "future") modified.issued_at = new Date(Date.now() + 10_000).toISOString();
      if (change === "repository") modified.repository_id = randomUUID();
      if (change === "deployment") modified.deployment_id = randomUUID();
      if (change === "project") modified.project_id = randomUUID();
      if (change === "nonce") modified.nonce_digest = canonicalJsonDigest("other nonce");
      if (change === "extra") Object.assign(modified, { authority: "all" });
      if (change === "unverified_provider") Object.assign(modified, { provider: "dev_env" });
      expect(() => assertGovernedReadActivationDecision(modified, binding, change === "actor" ? "bob" : "alice",
        change === "candidate" ? canonicalJsonDigest("another candidate") : current.boundary_digest))
        .toThrow("verified Read activation decision is stale or does not match");
    });
});
