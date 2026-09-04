import { describe, expect, it } from "vitest";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { ProposalStore, ProposalStoreError } from "./index.js";
import type { StoredObservedSubjectReference } from "./domain-types.js";

const READ_BOUNDARY = `sha256:${"1".repeat(64)}` as const;
const ACTION_BOUNDARY = `sha256:${"2".repeat(64)}` as const;
const ACTION_RULE = `sha256:${"3".repeat(64)}` as const;
const GENERATION_LOCK = `sha256:${"4".repeat(64)}` as const;
const TENANT_SCOPE = `sha256:${"5".repeat(64)}` as const;
const PRINCIPAL_SCOPE = `sha256:${"6".repeat(64)}` as const;

function subject(
  suffix: string,
  overrides: Partial<StoredObservedSubjectReference> = {},
): StoredObservedSubjectReference {
  const subjectRef = `obj_${suffix.repeat(43).slice(0, 43)}`;
  return {
    schema_version: "synapsor.observed-subject-ref.v1",
    subject_ref: subjectRef,
    subject_ref_digest: canonicalJsonDigest({
      schema_version: "synapsor.observed-subject-ref.v1",
      subject_ref: subjectRef,
    }),
    source_id: "local_postgres",
    resource: "field_service.appointments",
    protected_identity: {
      algorithm: "A256GCM",
      nonce: "AQIDBAUGBwgJCgsM",
      ciphertext: "ZW5jcnlwdGVkLXJvdy1pZGVudGl0eQ",
      authentication_tag: "DQ4PEBESExQVFhcYGRobHA",
    },
    evidence_bundle_id: "ev_explore_subject_fixture",
    read_boundary_digest: READ_BOUNDARY,
    generation_lock_fingerprint: GENERATION_LOCK,
    tenant_scope_fingerprint: TENANT_SCOPE,
    principal_scope_fingerprint: PRINCIPAL_SCOPE,
    workflow_session_id: "mcp_workflow_fixture",
    observed_version_digest: `sha256:${"7".repeat(64)}`,
    outcome_authorities: [{
      outcome: "field_service.reschedule_to_offered_slot",
      action_boundary_digest: ACTION_BOUNDARY,
      action_rule_digest: ACTION_RULE,
    }],
    issued_at: "2026-09-02T12:00:00.000Z",
    expires_at: "2026-09-02T12:10:00.000Z",
    state: "active",
    ...overrides,
  };
}

function claim(subjectRefs: string[], overrides: Record<string, unknown> = {}) {
  return {
    subject_refs: subjectRefs,
    claim_id: "request_change_fixture",
    outcome: "field_service.reschedule_to_offered_slot",
    action_boundary_digest: ACTION_BOUNDARY,
    action_rule_digest: ACTION_RULE,
    read_boundary_digest: READ_BOUNDARY,
    generation_lock_fingerprint: GENERATION_LOCK,
    tenant_scope_fingerprint: TENANT_SCOPE,
    principal_scope_fingerprint: PRINCIPAL_SCOPE,
    workflow_session_id: "mcp_workflow_fixture",
    now: "2026-09-02T12:05:00.000Z",
    ...overrides,
  };
}

function expectUnavailable(run: () => unknown): void {
  try {
    run();
    throw new Error("expected observed subject refusal");
  } catch (error) {
    expect(error).toBeInstanceOf(ProposalStoreError);
    expect(error).toMatchObject({ code: "SUBJECT_REFERENCE_UNAVAILABLE" });
  }
}

describe("observed subject reference lifecycle", () => {
  it("stores only protected identity metadata and preserves immutable creation", () => {
    const store = new ProposalStore();
    try {
      const created = store.createObservedSubjectReference(subject("a"));
      expect(store.createObservedSubjectReference(created)).toEqual(created);
      expect(store.getObservedSubjectReference(created.subject_ref)).toEqual(created);
      expect(store.stats().observed_subject_references).toBe(1);

      const raw = store.db.prepare(`
        SELECT record_json FROM observed_subject_references WHERE subject_ref = ?
      `).get(created.subject_ref) as { record_json: string };
      expect(raw.record_json).not.toContain("appointment-primary-key-42");
      expect(raw.record_json).not.toContain("tenant-northstar");
      expect(raw.record_json).not.toContain("principal-maya");

      try {
        store.createObservedSubjectReference({
          ...created,
          evidence_bundle_id: "ev_explore_changed",
        });
        throw new Error("expected immutable reference refusal");
      } catch (error) {
        expect(error).toMatchObject({ code: "SUBJECT_REFERENCE_IMMUTABILITY_VIOLATION" });
      }
    } finally {
      store.close();
    }
  });

  it("claims multiple references atomically and permits only the same idempotent claim", () => {
    const store = new ProposalStore();
    try {
      const appointment = store.createObservedSubjectReference(subject("b"));
      const offer = store.createObservedSubjectReference(subject("c", {
        resource: "field_service.appointment_slot_offers",
      }));
      const request = claim([appointment.subject_ref, offer.subject_ref]);

      expect(store.claimObservedSubjectReferences(request)).toEqual([
        expect.objectContaining({ subject_ref: appointment.subject_ref, state: "consumed" }),
        expect.objectContaining({ subject_ref: offer.subject_ref, state: "consumed" }),
      ]);
      expect(store.claimObservedSubjectReferences(request)).toEqual([
        expect.objectContaining({ claim_id: "request_change_fixture", state: "consumed" }),
        expect.objectContaining({ claim_id: "request_change_fixture", state: "consumed" }),
      ]);

      expectUnavailable(() => store.claimObservedSubjectReferences(claim(
        [appointment.subject_ref, offer.subject_ref],
        { claim_id: "different_request" },
      )));
    } finally {
      store.close();
    }
  });

  it("rolls back a multi-reference claim when any subject is invalid", () => {
    const store = new ProposalStore();
    try {
      const valid = store.createObservedSubjectReference(subject("d"));
      const wrongScope = store.createObservedSubjectReference(subject("e", {
        tenant_scope_fingerprint: `sha256:${"9".repeat(64)}`,
      }));

      expectUnavailable(() => store.claimObservedSubjectReferences(claim([
        valid.subject_ref,
        wrongScope.subject_ref,
      ])));
      expect(store.getObservedSubjectReference(valid.subject_ref)?.state).toBe("active");
      expect(store.getObservedSubjectReference(wrongScope.subject_ref)?.state).toBe("active");
    } finally {
      store.close();
    }
  });

  it("collapses forged, expired, wrong-scope, wrong-authority, and wrong-session use", () => {
    const store = new ProposalStore();
    try {
      const created = store.createObservedSubjectReference(subject("f"));
      const cases = [
        claim([`obj_${"z".repeat(43)}`]),
        claim([created.subject_ref], { now: created.expires_at }),
        claim([created.subject_ref], { tenant_scope_fingerprint: `sha256:${"8".repeat(64)}` }),
        claim([created.subject_ref], { action_rule_digest: `sha256:${"8".repeat(64)}` }),
        claim([created.subject_ref], { workflow_session_id: "mcp_workflow_other" }),
      ];
      for (const item of cases) expectUnavailable(() => store.claimObservedSubjectReferences(item));
      expect(store.getObservedSubjectReference(created.subject_ref)?.state).toBe("active");
    } finally {
      store.close();
    }
  });

  it("revokes active references by exact authority or workflow scope", () => {
    const store = new ProposalStore();
    try {
      const sameBoundary = store.createObservedSubjectReference(subject("g"));
      const otherBoundary = store.createObservedSubjectReference(subject("h", {
        outcome_authorities: [{
          outcome: "field_service.reschedule_to_offered_slot",
          action_boundary_digest: `sha256:${"8".repeat(64)}`,
          action_rule_digest: ACTION_RULE,
        }],
      }));
      expect(store.revokeObservedSubjectReferences({
        action_boundary_digest: ACTION_BOUNDARY,
        now: "2026-09-02T12:06:00.000Z",
      })).toBe(1);
      expect(store.getObservedSubjectReference(sameBoundary.subject_ref)?.state).toBe("revoked");
      expect(store.getObservedSubjectReference(otherBoundary.subject_ref)?.state).toBe("active");
      expectUnavailable(() => store.claimObservedSubjectReferences(claim([sameBoundary.subject_ref])));
    } finally {
      store.close();
    }
  });
});
