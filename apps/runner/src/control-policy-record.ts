import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import type { ControlPolicyKey, ControlPolicyRevision } from "@synapsor-runner/proposal-store";

export const OPERATOR_POLICY_RECORD_VERSION = "synapsor.stored-operator-authority/v1";
export const OPERATOR_READ_SELECTION_KEY: ControlPolicyKey = { scope: { level: "operator" }, kind: "management", name: "read_selection" };
export const OPERATOR_READ_AUTHORING_KEY: ControlPolicyKey = { scope: { level: "operator" }, kind: "management", name: "read_authoring" };
export const OPERATOR_EXECUTION_POLICY_KEY: ControlPolicyKey = { scope: { level: "operator" }, kind: "execution", name: "supervised_worker" };

/** Envelope integrity only. Callers must still use the existing Read, Action
 * and execution validators; a valid hash is never sufficient authority. */
export function storedOperatorPolicyRecord(key: ControlPolicyKey, authorityDigest: string, content: unknown): ControlPolicyRevision {
  const contentDigest = canonicalJsonDigest(content);
  return { scope: structuredClone(key.scope), kind: key.kind, name: key.name,
    revision_id: `policy:${contentDigest.slice(7)}`, authority_digest: authorityDigest, content_digest: contentDigest, content: structuredClone(content) };
}

export function assertOperatorPolicyRecord(revision: ControlPolicyRevision, key: ControlPolicyKey, authorityDigest: string): void {
  if (revision.scope.level !== "operator" || key.scope.level !== "operator"
    || canonicalJsonDigest(revision) !== canonicalJsonDigest(storedOperatorPolicyRecord(key, authorityDigest, revision.content))) {
    throw Object.assign(new Error("Stored policy identity or content is invalid. Older exports cannot be used."), { code: "POLICY_CONTENT_MISMATCH" });
  }
}
