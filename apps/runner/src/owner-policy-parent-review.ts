import { randomUUID } from "node:crypto";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { assertBoundedOwnerPolicyInput, policyManagementParentSchema, validateOwnerPolicyParent,
  type PolicyManagementParent, type RuntimeConfig } from "@synapsor-runner/mcp-server";
import type { ControlPolicyKey, ControlPolicyRevision } from "@synapsor-runner/proposal-store";
import { createActiveActionRuleAuthorityLoader } from "./action-rule-authority.js";
import { assertRuntimeControlPolicyContinuity, commitImmutableControlPolicies,
  type BoundProjectPolicyStore } from "./control-policy-store.js";
import { withProjectAuthorityMutation } from "./project-authority-mutation.js";

export type OperatorParentReview = {
  name: string;
  expected_epoch: number;
  before_revision: string | null;
  before: PolicyManagementParent | null;
  after: PolicyManagementParent;
  digest: `sha256:${string}`;
  expires_at: string;
};

/** Trusted local operator surface, never an owner API or model tool. A person
 * who can replace the local process/store is the deployment bootstrap trust root. */
export function createOperatorParentReview(input: {
  projectRoot: string; binding: BoundProjectPolicyStore; config: RuntimeConfig; actor: string;
}) {
  const heldReviews = new WeakMap<OperatorParentReview, OperatorParentReview>();
  const configDigest = canonicalJsonDigest(input.config);
  if (!input.actor.trim() || input.actor.length > 256 || /[\u0000-\u001f\u007f]/u.test(input.actor)) fail("POLICY_OPERATOR_IDENTITY_INVALID");
  const loadRules = createActiveActionRuleAuthorityLoader(input.projectRoot, input.binding);
  const keyFor = (name: string): ControlPolicyKey => {
    if (!/^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/u.test(name)) fail("POLICY_PARENT_NAME_INVALID");
    return { scope: { level: "operator" }, kind: "parent", name };
  };
  const validate = async (value: unknown) => {
    assertBoundedOwnerPolicyInput(value);
    const parsed = policyManagementParentSchema.safeParse(value);
    if (!parsed.success) fail("POLICY_PARENT_INVALID");
    const document = parsed.data;
    const rules = (await loadRules({ dependency_check: "report" })).registry.rules.map((entry) => entry.compiled);
    validateOwnerPolicyParent({ parent: document.delegation, rules });
    const owners = new Set<string>();
    for (const owner of document.agent_owners) {
      const key = canonicalJsonDigest(owner);
      if (owners.has(key) || owner.scope.level === "operator" || !document.delegation.agents.includes(owner.agent)) {
        fail("POLICY_PARENT_OWNER_INVALID");
      }
      owners.add(key);
    }
    if (document.delegation.agents.some((agent) => !document.agent_owners.some((entry) => entry.agent === agent))) {
      fail("POLICY_PARENT_OWNER_INVALID");
    }
    return document;
  };
  const current = async (name: string) => {
    await assertRuntimeControlPolicyContinuity(input.projectRoot, input.binding);
    return input.binding.repository.exactPointerSnapshot({ deployment_id: input.binding.deployment_id,
      key: keyFor(name), max_bytes: 1_048_576 });
  };
  return {
    async prepare(name: string, proposed: unknown): Promise<OperatorParentReview> {
      const snapshot = await current(name);
      const after = await validate(proposed);
      const before = snapshot.active ? policyManagementParentSchema.parse(snapshot.active.content) : null;
      const body = { name, expected_epoch: snapshot.epoch, before_revision: snapshot.active?.revision_id ?? null,
        before, after, expires_at: new Date(Date.now() + 300_000).toISOString() };
      const review: OperatorParentReview = { ...body, digest: canonicalJsonDigest(body) };
      heldReviews.set(review, structuredClone(review));
      return review;
    },
    cancel(review: OperatorParentReview): void { heldReviews.delete(review); },
    async confirm(review: OperatorParentReview): Promise<{ epoch: number; changed: boolean; revision_id: string }> {
      const frozen = heldReviews.get(review);
      heldReviews.delete(review);
      if (!frozen || canonicalJsonDigest(frozen) !== canonicalJsonDigest(review)
        || Date.parse(frozen.expires_at) <= Date.now() || configDigest !== canonicalJsonDigest(input.config)) {
        fail("POLICY_PARENT_REVIEW_STALE");
      }
      return withProjectAuthorityMutation(input.projectRoot, async () => {
        const snapshot = await current(frozen.name);
        if (snapshot.epoch !== frozen.expected_epoch || (snapshot.active?.revision_id ?? null) !== frozen.before_revision) {
          fail("POLICY_PARENT_REVIEW_STALE");
        }
        const document = await validate(frozen.after);
        const digest = canonicalJsonDigest(document);
        if (snapshot.active?.content_digest === digest) return { epoch: snapshot.epoch, changed: false, revision_id: snapshot.active.revision_id };
        const key = keyFor(frozen.name);
        const revision: ControlPolicyRevision = { ...key, revision_id: randomUUID(), content: document,
          content_digest: digest, authority_digest: digest };
        const epoch = await commitImmutableControlPolicies(input.binding, { expected_epoch: snapshot.epoch,
          revisions: [revision], active: [{ ...key, revision_id: revision.revision_id }], drafts: [],
          event: { event_id: randomUUID(), actor: input.actor, occurred_at: new Date().toISOString(), receipt: {
            operation: "review_operator_owner_delegation", confirmation_digest: frozen.digest,
            before_revision: frozen.before_revision, after_revision: revision.revision_id,
            authentication: "trusted_local_operator", source_database_changed: false,
            existing_owner_policies_require_revalidation: frozen.before_revision !== null,
          } } });
        return { epoch, changed: true, revision_id: revision.revision_id };
      });
    },
  };
}

function fail(code: string): never { throw Object.assign(new Error(`${code}: operator delegation authority was not changed.`), { code }); }
