import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { z } from "zod";
import type { ControlPolicyKey, ControlPolicyRevision } from "@synapsor-runner/proposal-store";

export const OPERATOR_POLICY_RECORD_VERSION = "synapsor.stored-operator-authority/v1";
export const OPERATOR_READ_SELECTION_KEY: ControlPolicyKey = { scope: { level: "operator" }, kind: "management", name: "read_selection" };
export const OPERATOR_READ_AUTHORING_KEY: ControlPolicyKey = { scope: { level: "operator" }, kind: "management", name: "read_authoring" };
export const OPERATOR_EXECUTION_POLICY_KEY: ControlPolicyKey = { scope: { level: "operator" }, kind: "execution", name: "supervised_worker" };

export type ReadAuthoringBindings = {
  repository_id: string;
  deployment_id: string;
  project_id: string;
  epoch: number;
  revision_id: string;
};

export const readAuthoringBindingsSchema = z.object({
  repository_id: z.string().uuid(), deployment_id: z.string().uuid(), project_id: z.string().uuid(),
  epoch: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  revision_id: z.string().regex(/^policy:[a-f0-9]{64}$/u),
}).strict();

export function assertReadAuthoringBindings(expected: ReadAuthoringBindings | undefined, current: ReadAuthoringBindings): void {
  if (!expected || canonicalJsonDigest(expected) !== canonicalJsonDigest(current)) {
    throw Object.assign(new Error("The saved Read review changed. Reopen the current draft before applying this decision."),
      { code: "POLICY_AUTHORING_REVIEW_CHANGED" });
  }
}

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
