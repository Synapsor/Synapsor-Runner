import type {
  LocalProposalState,
  StoredProposal,
  OperatorDecision,
  OperatorIdentityProof,
} from "./domain-types.js";
import {
  parseFreshnessAuthority,
  type ChangeSet,
  type FreshnessAuthorityV1,
} from "@synapsor-runner/protocol";
import {
  isRecord,
} from "./common.js";
import { ProposalStoreError } from "./errors.js";

export function stateFromChangeSet(changeSet: ChangeSet): LocalProposalState {
  if (changeSet.approval.status === "approved") return "approved";
  if (changeSet.approval.status === "rejected") return "rejected";
  if (changeSet.approval.status === "canceled") return "canceled";
  return "pending_review";
}

export function proposalFreshnessAuthority(proposal: StoredProposal): FreshnessAuthorityV1 | undefined {
  if (!("freshness" in proposal.change_set) || proposal.change_set.freshness === undefined) return undefined;
  try {
    return parseFreshnessAuthority(proposal.change_set.freshness);
  } catch {
    throw new ProposalStoreError(
      "FRESHNESS_AUTHORITY_TAMPERED",
      `stored freshness authority for proposal ${proposal.proposal_id} failed integrity validation`,
    );
  }
}

export function requiredApprovalCount(proposal: StoredProposal): number {
  const configured = proposal.change_set.approval.required_approvals;
  return typeof configured === "number" && Number.isSafeInteger(configured) && configured >= 1
    ? configured
    : 1;
}

export function assertOperatorDecision(
  proposal: StoredProposal,
  action: OperatorDecision["action"],
  actor: string,
  identity: OperatorIdentityProof | undefined,
  requireVerified: boolean,
): void {
  if (requireVerified && (!identity || !identity.verified)) {
    throw new ProposalStoreError("VERIFIED_OPERATOR_IDENTITY_REQUIRED", `verified operator identity is required to ${action} proposal ${proposal.proposal_id}`);
  }
  if (!identity) return;
  if (identity.subject !== actor || identity.decision.subject !== actor) {
    throw new ProposalStoreError("OPERATOR_IDENTITY_MISMATCH", `operator identity ${identity.subject} does not match actor ${actor}`);
  }
  if (identity.decision.action !== action
    || identity.decision.proposal_id !== proposal.proposal_id
    || identity.decision.proposal_version !== proposal.proposal_version
    || identity.decision.proposal_hash !== proposal.proposal_hash) {
    throw new ProposalStoreError("OPERATOR_DECISION_MISMATCH", `operator proof is not bound to this ${action} decision`);
  }
  const requiredRole = proposal.change_set.approval.required_role;
  if ((action === "approve" || action === "reject") && requiredRole && !identity.roles.includes(requiredRole)) {
    throw new ProposalStoreError("APPROVER_ROLE_REQUIRED", `operator ${identity.subject} lacks required role ${requiredRole}`);
  }
}

export function publicIdentitySummary(identity: OperatorIdentityProof | undefined): Record<string, unknown> | undefined {
  if (!identity) return undefined;
  return {
    provider: identity.provider,
    verified: identity.verified,
    subject: identity.subject,
    roles: identity.roles,
    key_id: identity.key_id,
    algorithm: identity.algorithm,
    decision_hash: identity.decision_hash,
    integrity_hash: identity.integrity_hash,
  };
}

export function utcDayWindow(value: string): { start: string; end: string } {
  const instant = new Date(value);
  if (Number.isNaN(instant.getTime())) {
    throw new ProposalStoreError("INVALID_POLICY_CLOCK", `invalid policy evaluation time: ${value}`);
  }
  const start = new Date(Date.UTC(instant.getUTCFullYear(), instant.getUTCMonth(), instant.getUTCDate()));
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return { start: start.toISOString(), end: end.toISOString() };
}

export function assertProposalIdentity(proposal: StoredProposal, hash: string, version: number): void {
  if (proposal.proposal_hash !== hash) {
    throw new ProposalStoreError("PROPOSAL_HASH_MISMATCH", `proposal ${proposal.proposal_id} hash mismatch`);
  }
  if (proposal.proposal_version !== version) {
    throw new ProposalStoreError("PROPOSAL_VERSION_MISMATCH", `proposal ${proposal.proposal_id} version mismatch`);
  }
}

export function assertWritebackAllowed(proposal: StoredProposal, operation: string): void {
  if (proposal.change_set.mode === "shadow") {
    throw new ProposalStoreError(
      "SHADOW_WRITEBACK_DISABLED",
      `shadow proposal ${proposal.proposal_id} cannot be ${operation}; shadow mode stores proposals, evidence, query audit, and replay only and never mutates the source database`,
    );
  }
  if (proposal.change_set.mode === "read_only") {
    throw new ProposalStoreError(
      "READ_ONLY_WRITEBACK_DISABLED",
      `read-only proposal ${proposal.proposal_id} cannot be ${operation}; read-only mode does not allow proposal writeback`,
    );
  }
}

export const secretKeyPattern = /(^|[_-])(password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|cookie|credential|connection[_-]?string|database[_-]?url|read[_-]?url|write[_-]?url)($|[_-])/i;
export const secretValuePattern = /(postgres(?:ql)?:\/\/|mysql:\/\/|Bearer\s+[A-Za-z0-9._~+/=-]+|syn_wbr_[A-Za-z0-9._~+/=-]+|-----BEGIN [A-Z ]*PRIVATE KEY-----)/i;

export function assertNoSecretMaterial(value: unknown, path: string): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoSecretMaterial(item, `${path}[${index}]`));
    return;
  }
  if (isRecord(value)) {
    for (const [key, entry] of Object.entries(value)) {
      const entryPath = `${path}.${key}`;
      if (secretKeyPattern.test(key)) {
        throw new ProposalStoreError(
          "SECRET_MATERIAL_REJECTED",
          `refusing to persist secret-like field ${entryPath}; remove it from reviewed visible/evidence/query-audit data`,
        );
      }
      assertNoSecretMaterial(entry, entryPath);
    }
    return;
  }
  if (typeof value === "string" && secretValuePattern.test(value)) {
    throw new ProposalStoreError(
      "SECRET_MATERIAL_REJECTED",
      `refusing to persist secret-like value at ${path}; remove it from reviewed visible/evidence/query-audit data`,
    );
  }
}
