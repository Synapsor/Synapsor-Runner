import fs from "node:fs/promises";
import path from "node:path";
import { resolveActivatedApprovalClass, type RuntimeActionRuleRegistryV1 } from "@synapsor-runner/action-rules";
import type { RuntimeConfig } from "@synapsor-runner/mcp-server";
import { validateRunnerCapabilityConfig } from "@synapsor-runner/config";
import { assertOperatorPublicKeyFingerprint, assertSignedOperatorDecisionScope, signedOperatorKeyAlgorithm } from "./operator-identity.js";

/** Operator-only configuration evidence. It is never a request eligibility
 * oracle, a signature, a cached approval permit or a runtime roster projection. */
export type ApprovalPathReadiness = {
  state: "covered" | "missing" | "unknown" | "not_applicable";
  human_path: "mandatory" | "conditional" | "unestablished";
  current_request: "not_assessed";
  authentication: "not_checked";
  human_availability: "unknown";
  required_role?: string;
  required_approvals?: number;
  eligible_subjects: Array<{ subject: string; public_key: "valid"; binding: "pinned" | "unpinned" }>;
  excluded_subjects: Array<{ subject: string; code: string }>;
  reason?: string;
};

export function unknownApprovalPath(reason: string): ApprovalPathReadiness {
  return { state: "unknown", human_path: "unestablished", current_request: "not_assessed",
    authentication: "not_checked", human_availability: "unknown", eligible_subjects: [], excluded_subjects: [], reason };
}

export async function assessApprovalPath(input: {
  config: RuntimeConfig; configPath: string; registry: RuntimeActionRuleRegistryV1;
  outcome: string; unavailableOutcomes?: readonly string[];
}): Promise<ApprovalPathReadiness> {
  const result = unknownApprovalPath("APPROVAL_AUTHORITY_UNAVAILABLE");
  if (!validateRunnerCapabilityConfig(input.config).ok) {
    result.reason = "APPROVAL_CONFIGURATION_INVALID"; return result;
  }
  if (input.unavailableOutcomes?.includes(input.outcome)) {
    result.reason = "APPROVAL_READ_DEPENDENCY_UNAVAILABLE"; return result;
  }
  let approval;
  try { approval = resolveActivatedApprovalClass(input.registry, input.outcome); }
  catch { return result; }
  result.human_path = approval.mode === "human" ? "mandatory" : "conditional";
  result.required_role = approval.required_role;
  result.required_approvals = approval.required_approvals;
  const identity = input.config.operator_identity;
  if (identity?.provider !== "signed_key") {
    result.reason = identity?.provider === "jwt_oidc" ? "EXTERNAL_REVIEWER_COVERAGE_UNASSESSED" : "DEVELOPMENT_REVIEWER_COVERAGE_UNASSESSED";
    return result;
  }
  delete result.reason;
  // The real approval quorum counts distinct subjects, not keys or roles.
  for (const subject of Object.keys(identity.operators ?? {}).sort()) {
    const operator = identity.operators![subject]!;
    try {
      assertSignedOperatorDecisionScope(identity, subject, { action: "approve", requiredRole: approval.required_role,
        proposal: { action: input.outcome, proposal_id: "approval_configuration_inspection", proposal_version: 1, proposal_hash: "not_a_decision" } });
    } catch {
      result.excluded_subjects.push({ subject, code: "REVIEWER_SCOPE_OR_ROLE_NOT_ELIGIBLE" }); continue;
    }
    try {
      const publicKey = await fs.readFile(path.resolve(path.dirname(input.configPath), operator.public_key_path));
      signedOperatorKeyAlgorithm(publicKey);
      assertOperatorPublicKeyFingerprint(operator, publicKey);
      result.eligible_subjects.push({ subject, public_key: "valid", binding: operator.public_key_fingerprint ? "pinned" : "unpinned" });
    } catch {
      result.excluded_subjects.push({ subject, code: "REVIEWER_PUBLIC_KEY_UNUSABLE_OR_CHANGED" });
    }
  }
  result.state = result.eligible_subjects.length >= approval.required_approvals ? "covered" : "missing";
  return result;
}

export function approvalPathReadinessLines(result: ApprovalPathReadiness): string[] {
  return [
    `Human approval configuration: ${result.state}; path ${result.human_path}${result.required_role ? `; role ${result.required_role}, quorum ${result.required_approvals}` : ""}${result.reason ? ` (${result.reason})` : ""}.`,
    ...result.eligible_subjects.map(item => `Eligible configured reviewer ${item.subject}: public key valid (${item.binding}); possession and future signature not checked.`),
    ...result.excluded_subjects.map(item => `Reviewer ${item.subject}: excluded from configuration coverage (${item.code}).`),
    "Coverage counts distinct configured subjects. It does not establish distinct people or human availability; availability is unknown.",
    "This check does not inspect private facts or determine this request's approval path. Approval, execution and APPLY readiness remain separate; no authority or decision is created.",
  ];
}
