import type { AutomaticApprovalActionRevision } from "./domain-types.js";
import { identifier } from "./control-policy-values.js";
import { ProposalStoreError } from "./errors.js";

export function automaticApprovalActionRevision(value: AutomaticApprovalActionRevision): AutomaticApprovalActionRevision {
  return Object.freeze({ deployment_id: identifier(value.deployment_id), action_name: identifier(value.action_name),
    revision_id: identifier(value.revision_id) });
}

export function assertAutomaticApprovalActionRevision(rows: ReadonlyArray<Record<string, unknown>>,
  expected: AutomaticApprovalActionRevision): void {
  if (rows.length !== 1 || rows[0]?.name !== expected.action_name || rows[0]?.revision_id !== expected.revision_id) {
    throw new ProposalStoreError("POLICY_REVISION_CONFLICT", "The reviewed Action revision changed before automatic approval.");
  }
}
