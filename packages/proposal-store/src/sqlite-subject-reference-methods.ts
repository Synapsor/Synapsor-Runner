import { canonicalJsonStringify } from "@synapsor-runner/protocol";
import type {
  ClaimObservedSubjectReferencesInput,
  RevokeObservedSubjectReferencesInput,
  StoredObservedSubjectReference,
} from "./domain-types.js";
import { isRecord } from "./common.js";
import { ProposalStoreError } from "./errors.js";
import {
  assertObservedSubjectMatchesClaim,
  consumedObservedSubjectReference,
  normalizeNewObservedSubjectReference,
  normalizeObservedSubjectClaim,
  normalizeObservedSubjectRevocation,
  normalizeStoredObservedSubjectReference,
  subjectReferenceUnavailable,
} from "./subject-reference-domain.js";
import type {
  ProposalStoreMethodContext,
  ProposalStoreSubjectReferenceMethods,
} from "./sqlite-method-signatures.js";

function fromRow(row: unknown): StoredObservedSubjectReference | undefined {
  if (!isRecord(row)) return undefined;
  let immutable: unknown;
  try {
    immutable = JSON.parse(String(row.record_json));
  } catch {
    throw subjectReferenceUnavailable();
  }
  return normalizeStoredObservedSubjectReference({
    ...(immutable as Record<string, unknown>),
    state: row.state,
    ...(row.claim_id == null ? {} : { claim_id: String(row.claim_id) }),
    ...(row.consumed_at == null ? {} : { consumed_at: String(row.consumed_at) }),
    ...(row.revoked_at == null ? {} : { revoked_at: String(row.revoked_at) }),
  });
}

export const proposalStoreSubjectReferenceMethods:
ProposalStoreSubjectReferenceMethods & ThisType<ProposalStoreMethodContext> = {
  createObservedSubjectReference(input: StoredObservedSubjectReference): StoredObservedSubjectReference {
    const subject = normalizeNewObservedSubjectReference(input);
    return this.transaction(() => {
      const existing = this.getObservedSubjectReference(subject.subject_ref);
      if (existing) {
        if (canonicalJsonStringify(existing) !== canonicalJsonStringify(subject)) {
          throw new ProposalStoreError(
            "SUBJECT_REFERENCE_IMMUTABILITY_VIOLATION",
            "An observed subject reference already exists with different protected metadata.",
          );
        }
        return existing;
      }
      this.db.prepare(`
        INSERT INTO observed_subject_references (
          subject_ref, subject_ref_digest, state, claim_id, record_json,
          issued_at, expires_at, consumed_at, revoked_at
        ) VALUES (?, ?, 'active', NULL, ?, ?, ?, NULL, NULL)
      `).run(
        subject.subject_ref,
        subject.subject_ref_digest,
        JSON.stringify(subject),
        subject.issued_at,
        subject.expires_at,
      );
      return subject;
    });
  },

  getObservedSubjectReference(subjectRef: string): StoredObservedSubjectReference | undefined {
    if (!/^obj_[A-Za-z0-9_-]{32,128}$/.test(subjectRef)) return undefined;
    return fromRow(this.db.prepare(`
      SELECT record_json, state, claim_id, consumed_at, revoked_at
      FROM observed_subject_references
      WHERE subject_ref = ?
    `).get(subjectRef));
  },

  claimObservedSubjectReferences(input: ClaimObservedSubjectReferencesInput): StoredObservedSubjectReference[] {
    const claim = normalizeObservedSubjectClaim(input);
    return this.transaction(() => {
      const subjects = claim.subject_refs.map((subjectRef) => {
        const subject = this.getObservedSubjectReference(subjectRef);
        if (!subject) throw subjectReferenceUnavailable();
        assertObservedSubjectMatchesClaim(subject, claim);
        return subject;
      });
      for (const subject of subjects) {
        if (subject.state === "consumed") continue;
        const changed = this.db.prepare(`
          UPDATE observed_subject_references
          SET state = 'consumed', claim_id = ?, consumed_at = ?
          WHERE subject_ref = ? AND state = 'active'
        `).run(claim.claim_id, claim.now, subject.subject_ref);
        if (Number(changed.changes) !== 1) throw subjectReferenceUnavailable();
      }
      return subjects.map((subject) =>
        subject.state === "consumed"
          ? subject
          : consumedObservedSubjectReference(subject, claim.claim_id, claim.now));
    });
  },

  revokeObservedSubjectReferences(input: RevokeObservedSubjectReferencesInput): number {
    const revocation = normalizeObservedSubjectRevocation(input);
    return this.transaction(() => {
      const rows = this.db.prepare(`
        SELECT record_json, state, claim_id, consumed_at, revoked_at
        FROM observed_subject_references
        WHERE state = 'active'
      `).all();
      const requestedRefs = new Set(revocation.subject_refs);
      const selected = rows
        .map(fromRow)
        .filter((subject): subject is StoredObservedSubjectReference => subject !== undefined)
        .filter((subject) =>
          (requestedRefs.size === 0 || requestedRefs.has(subject.subject_ref))
          && (!revocation.read_boundary_digest
            || subject.read_boundary_digest === revocation.read_boundary_digest)
          && (!revocation.action_boundary_digest
            || subject.outcome_authorities.some((authority) =>
              authority.action_boundary_digest === revocation.action_boundary_digest))
          && (!revocation.workflow_session_id
            || subject.workflow_session_id === revocation.workflow_session_id));
      let count = 0;
      for (const subject of selected) {
        const changed = this.db.prepare(`
          UPDATE observed_subject_references
          SET state = 'revoked', revoked_at = ?
          WHERE subject_ref = ? AND state = 'active'
        `).run(revocation.now, subject.subject_ref);
        count += Number(changed.changes);
      }
      return count;
    });
  },
};
