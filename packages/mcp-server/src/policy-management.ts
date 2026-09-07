import { randomUUID } from "node:crypto";
import type { CompiledActionRuleV1 } from "@synapsor-runner/action-rules";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import type { ControlPolicyKey, ControlPolicyRepository, ControlPolicyRevision, ControlPolicyReview,
  ControlPolicyReviewConfirmation, ControlPolicyScope, ControlPolicyReadGuard } from "@synapsor-runner/proposal-store";
import { z } from "zod";
import { compileOwnerPolicy } from "./owner-policy-compiler.js";
import { assertBoundedOwnerPolicyInput, ownerPolicyDefinitionSchema, ownerPolicyParentSchema, type OwnerPolicyDefinition } from "./owner-policy-language.js";
import { assertPolicyManagementRight, PolicyManagementError, policyManagerGrantSchema, policyOwnerScopeSchema,
  type PolicyManagementAuthenticator, type PolicyManagementIdentity, type PolicyManagementPermission } from "./policy-management-identity.js";

const name = z.string().regex(/^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/u);
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
export const policyManagementParentSchema = z.object({
  schema_version: z.literal("synapsor.policy-management-parent.v1"),
  managers: z.array(policyManagerGrantSchema).max(256),
  delegation: ownerPolicyParentSchema,
  agent_owners: z.array(z.object({ agent: name, scope: policyOwnerScopeSchema }).strict()).min(1).max(256),
}).strict();
const delegationSchema = z.object({
  schema_version: z.literal("synapsor.managed-owner-policy.v1"),
  parent_revision_id: z.string().min(1).max(256), parent_authority_digest: digest,
  parent_name: name, definition: ownerPolicyDefinitionSchema,
  compiled_digest: digest,
}).strict();
type ManagedDelegation = z.infer<typeof delegationSchema>;
type Parent = { revision: ControlPolicyRevision; document: z.infer<typeof policyManagementParentSchema>; scope: ControlPolicyScope };

/** A trusted provider API, not an MCP tool or raw control-store API. Instantiate
 * for one configured deployment and parent. Authenticators and rule loading are
 * backend dependencies; request bodies cannot choose them or management grants.
 * resolveRules must return that deployment's currently activated Action rules. */
export function createPolicyManagementService(options: {
  repository: ControlPolicyRepository;
  deployment_id: string;
  parent_name: string;
  assistant_authenticate: PolicyManagementAuthenticator;
  human_authenticate: PolicyManagementAuthenticator;
  resolveRules: () => Promise<CompiledActionRuleV1[]>;
}) {
  const repository = options.repository;
  const parentKey: ControlPolicyKey = { scope: { level: "operator" }, kind: "parent", name: name.parse(options.parent_name) };

  function authorizationGuard(identity: PolicyManagementIdentity, scope: ControlPolicyScope, permission: PolicyManagementPermission,
    accept?: (parent: Parent) => void): ControlPolicyReadGuard {
    return { keys: [parentKey], authorize(current) {
      const revision = current[0];
      if (!revision) throw new PolicyManagementError("POLICY_SELF_SERVICE_DISABLED");
      assertBoundedOwnerPolicyInput(revision.content);
      const parsed = policyManagementParentSchema.safeParse(revision.content);
      if (!parsed.success) throw new PolicyManagementError("POLICY_MANAGEMENT_CONFIGURATION_INVALID");
      assertPolicyManagementRight(identity, parsed.data.managers, scope, permission);
      accept?.({ revision, document: parsed.data, scope });
    } };
  }
  async function load(credential: string, scope: ControlPolicyScope, permission: PolicyManagementPermission, human = false) {
    const identity = await (human ? options.human_authenticate : options.assistant_authenticate)(credential);
    if (identity.channel !== (human ? "human_review" : "assistant")) throw new PolicyManagementError("POLICY_AUTHENTICATION_FAILED");
    let parent: Parent | undefined;
    const snapshot = await repository.scopeSnapshot({ deployment_id: options.deployment_id, scope: policyOwnerScopeSchema.parse(scope),
      kinds: ["delegation"], limit: 64, max_bytes: 1_048_576 }, authorizationGuard(identity, scope, permission, (value) => { parent = value; }));
    if (!parent) throw new PolicyManagementError("POLICY_SELF_SERVICE_DISABLED");
    return { identity, parent, snapshot };
  }

  function decode(revision: ControlPolicyRevision, parent: Parent): ManagedDelegation {
    const parsed = delegationSchema.safeParse(revision.content);
    if (!parsed.success) throw new PolicyManagementError("POLICY_DELEGATION_INVALID");
    if (parsed.data.parent_name !== parentKey.name) throw new PolicyManagementError("POLICY_NAME_OWNED_BY_DIFFERENT_PARENT");
    return parsed.data;
  }
  function view(revision: ControlPolicyRevision, parent: Parent) {
    const document = decode(revision, parent);
    return { name: revision.name, revision_id: revision.revision_id, definition: document.definition,
      parent_current: document.parent_revision_id === parent.revision.revision_id && document.parent_authority_digest === parent.revision.authority_digest };
  }
  function exactEpoch(expected: number, actual: number) {
    if (!Number.isSafeInteger(expected) || expected !== actual) throw new PolicyManagementError("POLICY_REVISION_CONFLICT");
  }
  function selectedKey(scope: ControlPolicyScope, policyName: string): ControlPolicyKey {
    return { scope: policyOwnerScopeSchema.parse(scope), kind: "delegation", name: name.parse(policyName) };
  }
  function summary(key: ControlPolicyKey, definition: OwnerPolicyDefinition, operation: "activate" | "revoke", before?: OwnerPolicyDefinition) {
    return { scope: key.scope, name: key.name, agents: definition.agents,
      actions: definition.rules.map((rule) => ({ outcome: rule.outcome, require: rule.require,
        approval: rule.approval, ...(rule.auto_approve_when ? { auto_approve_when: rule.auto_approve_when } : {}) })),
      operation, previous_definition: before ?? null, parent_requirements_preserved: true, source_database_changed: false };
  }
  function delegationForScope(parent: Parent) {
    const owners = parent.document.agent_owners.filter((owner) => canonicalJsonDigest(owner.scope) === canonicalJsonDigest(parent.scope));
    return { ...parent.document.delegation, agents: parent.document.delegation.agents.filter((agent) => owners.some((owner) => owner.agent === agent)) };
  }
  async function compileExisting(revision: ControlPolicyRevision, parent: Parent) {
    const document = decode(revision, parent);
    if (document.parent_revision_id !== parent.revision.revision_id || document.parent_authority_digest !== parent.revision.authority_digest) {
      throw new PolicyManagementError("POLICY_DELEGATION_PARENT_CHANGED");
    }
    const policy = compileOwnerPolicy({ parent: delegationForScope(parent), definition: document.definition, rules: await options.resolveRules() });
    if (policy.digest !== document.compiled_digest || revision.authority_digest !== policy.digest) throw new PolicyManagementError("POLICY_DELEGATION_INVALID");
    return policy;
  }

  return {
    async audit(credential: string, input: { scope: ControlPolicyScope; name: string; limit?: number; before?: { epoch: number; revision_id: string } }) {
      const key = selectedKey(input.scope, input.name), identity = await options.assistant_authenticate(credential);
      if (identity.channel !== "assistant") throw new PolicyManagementError("POLICY_AUTHENTICATION_FAILED");
      return repository.policyHistory({ deployment_id: options.deployment_id, key, limit: input.limit, before: input.before }, authorizationGuard(identity, key.scope, "audit"));
    },
    async list(credential: string, scope: ControlPolicyScope) {
      const { parent, snapshot } = await load(credential, scope, "inspect");
      return { epoch: snapshot.epoch, scope, active: snapshot.active.map((value) => view(value, parent)),
        drafts: snapshot.drafts.map((value) => view(value, parent)) };
    },
    async detail(credential: string, scope: ControlPolicyScope, policyName: string) {
      const key = selectedKey(scope, policyName), { parent, snapshot } = await load(credential, scope, "inspect");
      const active = snapshot.active.find((value) => value.name === key.name), draft = snapshot.drafts.find((value) => value.name === key.name);
      return { epoch: snapshot.epoch, key, ...(active ? { active: view(active, parent) } : {}), ...(draft ? { draft: view(draft, parent) } : {}),
        agents: delegationForScope(parent).agents,
        vocabulary: parent.document.delegation.outcomes.map((outcome) => ({ outcome: outcome.outcome, automatic_approval_delegable: outcome.allow_automatic_approval,
          facts: outcome.facts.map(({ source: _privateSource, ...fact }) => fact) })) };
    },
    async propose(credential: string, input: { scope: ControlPolicyScope; name: string; expected_epoch: number; definition: unknown }) {
      const key = selectedKey(input.scope, input.name), { identity, parent, snapshot } = await load(credential, key.scope, "draft");
      exactEpoch(input.expected_epoch, snapshot.epoch);
      for (const existing of [...snapshot.active, ...snapshot.drafts].filter((value) => value.name === key.name)) decode(existing, parent);
      const scopedParent = delegationForScope(parent);
      if (!scopedParent.agents.length) throw new PolicyManagementError("POLICY_NO_DELEGABLE_AGENTS");
      const compiled = compileOwnerPolicy({ parent: scopedParent, definition: input.definition, rules: await options.resolveRules() });
      const content: ManagedDelegation = { schema_version: "synapsor.managed-owner-policy.v1", parent_name: parentKey.name,
        parent_revision_id: parent.revision.revision_id, parent_authority_digest: parent.revision.authority_digest,
        definition: compiled.definition, compiled_digest: compiled.digest };
      const revision: ControlPolicyRevision = { ...key, revision_id: randomUUID(), content,
        content_digest: canonicalJsonDigest(content), authority_digest: compiled.digest };
      assertPolicyManagementRight(identity, parent.document.managers, key.scope, "draft");
      const epoch = await repository.commit({ deployment_id: options.deployment_id, expected_epoch: snapshot.epoch, revisions: [revision],
        active: [], drafts: [{ ...key, revision_id: revision.revision_id }], event: { event_id: randomUUID(), actor: identity.actor,
          occurred_at: new Date().toISOString(), receipt: { operation: "propose_owner_policy", key, revision_id: revision.revision_id,
            parent_revision_id: parent.revision.revision_id, authority_changed: false, source_database_changed: false } } });
      return { epoch, revision_id: revision.revision_id, summary: summary(key, compiled.definition, "activate"),
        authority_changed: false, source_database_changed: false, status: "draft_saved" as const };
    },
    // Called only by the trusted human review interface after it authenticates
    // the reviewer. The runtime model receives no nonce or confirmation method.
    async prepareReview(credential: string, input: { scope: ControlPolicyScope; name: string; expected_epoch: number;
      revision_id: string; operation: "activate" | "revoke" }) {
      const key = selectedKey(input.scope, input.name), { identity, parent, snapshot } = await load(credential, key.scope, input.operation, true);
      exactEpoch(input.expected_epoch, snapshot.epoch);
      const revision = (input.operation === "activate" ? snapshot.drafts : snapshot.active).find((value) => value.name === key.name && value.revision_id === input.revision_id);
      if (!revision) throw new PolicyManagementError("POLICY_REVIEW_REVISION_CHANGED");
      const definition = input.operation === "activate" ? (await compileExisting(revision, parent)).definition : decode(revision, parent).definition;
      const previous = snapshot.active.find((value) => value.name === key.name);
      const reviewSummary = summary(key, definition, input.operation, previous ? decode(previous, parent).definition : undefined);
      const ttl = Math.min(300_000, identity.expires_at_ms - Date.now());
      if (ttl <= 0) throw new PolicyManagementError("POLICY_AUTHENTICATION_FAILED");
      const prepared = await repository.reviews.prepare({ deployment_id: options.deployment_id, key, revision_id: revision.revision_id,
        expected_epoch: snapshot.epoch, operation: input.operation, actor: identity.actor, session_digest: identity.session_digest,
        summary_digest: canonicalJsonDigest(reviewSummary), ttl_ms: ttl });
      return { ...prepared, summary: reviewSummary };
    },
    async confirmReview(credential: string, input: { review: ControlPolicyReview; nonce: string }) {
      const review = input.review;
      if (review.deployment_id !== options.deployment_id || review.key.kind !== "delegation") throw new PolicyManagementError("POLICY_REVIEW_INVALID");
      const { identity, parent, snapshot } = await load(credential, review.key.scope, review.operation, true);
      if (review.actor !== identity.actor || review.session_digest !== identity.session_digest) throw new PolicyManagementError("POLICY_REVIEW_INVALID");
      const confirmation: ControlPolicyReviewConfirmation = { ...review, actor: identity.actor, session_digest: identity.session_digest, nonce: input.nonce };
      const prior = await repository.event(options.deployment_id, `policy_review:${review.review_id}`);
      if (!prior) {
        exactEpoch(review.expected_epoch, snapshot.epoch);
        const revision = (review.operation === "activate" ? snapshot.drafts : snapshot.active).find((value) => value.name === review.key.name && value.revision_id === review.revision_id);
        if (!revision) throw new PolicyManagementError("POLICY_REVIEW_REVISION_CHANGED");
        const definition = review.operation === "activate" ? (await compileExisting(revision, parent)).definition : decode(revision, parent).definition;
        const previous = snapshot.active.find((value) => value.name === review.key.name);
        if (canonicalJsonDigest(summary(review.key, definition, review.operation, previous ? decode(previous, parent).definition : undefined)) !== review.summary_digest) {
          throw new PolicyManagementError("POLICY_REVIEW_INVALID");
        }
      }
      assertPolicyManagementRight(identity, parent.document.managers, review.key.scope, review.operation);
      return repository.reviews.confirm(confirmation);
    },
  };
}
