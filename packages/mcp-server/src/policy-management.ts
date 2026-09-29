import { actionRuleStringMatches } from "@synapsor/spec";
import { randomBytes, randomUUID } from "node:crypto";
import type { CompiledActionRuleV1 } from "@synapsor-runner/action-rules";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import type { ControlPolicyKey, ControlPolicyRepository, ControlPolicyRevision, ControlPolicyReview,
  ControlPolicyReviewConfirmation, ControlPolicyScope, ControlPolicyReadGuard } from "@synapsor-runner/proposal-store";
import { z } from "zod";
import { compileOwnerPolicy } from "./owner-policy-compiler.js";
import { assertBoundedOwnerPolicyInput, type OwnerPolicyDefinition, type OwnerPolicyFact, type OwnerPolicyParent } from "./owner-policy-language.js";
import { assertPolicyManagementRight, PolicyManagementError, policyOwnerScopeSchema,
  type PolicyManagementAuthenticator, type PolicyManagementIdentity, type PolicyManagementPermission } from "./policy-management-identity.js";

import { policyManagementParentSchema, managedDelegationSchema as delegationSchema, delegationForOwner, type ManagedDelegation } from "./owner-policy-records.js";
export { policyManagementParentSchema } from "./owner-policy-records.js";
const name = z.string().regex(/^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/u);
type Parent = { revision: ControlPolicyRevision; document: z.infer<typeof policyManagementParentSchema>; scope: ControlPolicyScope };
const scopePageInput = z.object({
  query: z.string().max(256).optional(),
  limit: z.number().int().min(1).max(20).optional(),
  after: z.string().regex(/^ps_[A-Za-z0-9_-]{43}$/u).optional(),
}).strict();
type ScopeSelection = { scope: ControlPolicyScope; label: string; permissions: Array<"inspect" | "draft" | "audit">; agent_count: number };
type ScopeCursor = { binding: string; epoch: number; identity: string; query: string; offset: number; expires_at: number };

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
  const scopeCursors = new Map<string, ScopeCursor>();

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
  async function authenticate(credential: string, human: boolean) {
    const identity = await (human ? options.human_authenticate : options.assistant_authenticate)(credential);
    if (identity.channel !== (human ? "human_review" : "assistant")) throw new PolicyManagementError("POLICY_AUTHENTICATION_FAILED");
    return identity;
  }
  async function loadScope(credential: string, scope: ControlPolicyScope, permission: PolicyManagementPermission, human = false) {
    const requestedScope = policyOwnerScopeSchema.parse(scope);
    const identity = await authenticate(credential, human);
    let parent: Parent | undefined;
    const snapshot = await repository.scopeSnapshot({ deployment_id: options.deployment_id, scope: requestedScope,
      kinds: ["delegation"], limit: 64, max_bytes: 1_048_576 }, authorizationGuard(identity, requestedScope, permission, (value) => { parent = value; }));
    if (!parent) throw new PolicyManagementError("POLICY_SELF_SERVICE_DISABLED");
    return { identity, parent, snapshot };
  }
  async function loadExact(credential: string, key: ControlPolicyKey, permission: PolicyManagementPermission, human = false) {
    const identity = await authenticate(credential, human);
    let parent: Parent | undefined;
    const snapshot = await repository.exactPointerSnapshot({ deployment_id: options.deployment_id, key, max_bytes: 1_048_576 },
      authorizationGuard(identity, key.scope, permission, (value) => { parent = value; }));
    if (!parent) throw new PolicyManagementError("POLICY_SELF_SERVICE_DISABLED");
    return { identity, parent, snapshot };
  }

  function scopePermissions(identity: PolicyManagementIdentity, parent: Parent, scope: ControlPolicyScope) {
    return (["inspect", "draft", "audit"] as const).filter((permission) => {
      try { assertPolicyManagementRight(identity, parent.document.managers, scope, permission); return true; }
      catch (error) {
        if (error instanceof PolicyManagementError && error.code === "POLICY_MANAGEMENT_FORBIDDEN") return false;
        throw error;
      }
    });
  }
  function scopeLabel(scope: ControlPolicyScope): string {
    if (scope.level === "operator") return "Operator";
    if (scope.level === "tenant") return `Tenant: ${scope.tenant_id}`;
    return `Principal: ${scope.tenant_id} / ${scope.principal}`;
  }
  function normalizeScopeQuery(query: string | undefined): string {
    return (query ?? "").normalize("NFKC").toLocaleLowerCase("en-US").trim().replace(/\s+/gu, " ");
  }
  function scopeId(scope: ControlPolicyScope): string { return canonicalJsonDigest(scope); }
  function pageBinding(identity: PolicyManagementIdentity, parent: Parent, epoch: number, query: string): string {
    return canonicalJsonDigest({ deployment_id: options.deployment_id, parent_revision_id: parent.revision.revision_id,
      epoch, identity: identity.session_digest, query });
  }
  function isScopeMatch(item: ScopeSelection, query: string): boolean {
    if (!query) return true;
    return [item.label, item.scope.level, ...(item.scope.level === "operator" ? [] : [item.scope.tenant_id]),
      ...(item.scope.level === "principal" ? [item.scope.principal] : [])]
      .some((value) => value.normalize("NFKC").toLocaleLowerCase("en-US").includes(query));
  }
  function authorizedScopes(identity: PolicyManagementIdentity, parent: Parent): ScopeSelection[] {
    const grouped = new Map<string, { scope: ControlPolicyScope; agents: Set<string> }>();
    for (const owner of parent.document.agent_owners) {
      const id = scopeId(owner.scope), current = grouped.get(id);
      if (current) current.agents.add(owner.agent);
      else grouped.set(id, { scope: owner.scope, agents: new Set([owner.agent]) });
    }
    const scopes = [...grouped.values()].map(({ scope, agents }) => ({ scope, agent_count: agents.size,
      permissions: scopePermissions(identity, parent, scope) })).filter((item) => item.permissions.includes("inspect"))
      .map((item) => ({ ...item, label: scopeLabel(item.scope) }));
    if (!scopes.length) throw new PolicyManagementError("POLICY_MANAGEMENT_FORBIDDEN");
    return scopes.sort((left, right) => scopeId(left.scope).localeCompare(scopeId(right.scope)));
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
  function pointerSummary(revision: ControlPolicyRevision, parent: Parent) {
    const document = decode(revision, parent);
    return { revision_id: revision.revision_id,
      parent_current: document.parent_revision_id === parent.revision.revision_id && document.parent_authority_digest === parent.revision.authority_digest };
  }
  function exactEpoch(expected: number, actual: number) {
    if (!Number.isSafeInteger(expected) || expected !== actual) throw new PolicyManagementError("POLICY_REVISION_CONFLICT");
  }
  function selectedKey(scope: ControlPolicyScope, policyName: string): ControlPolicyKey {
    return { scope: policyOwnerScopeSchema.parse(scope), kind: "delegation", name: name.parse(policyName) };
  }
  function summary(key: ControlPolicyKey, definition: OwnerPolicyDefinition, operation: "activate" | "revoke", before?: OwnerPolicyDefinition, parent?: Parent) {
    return { scope: key.scope, name: key.name, agents: definition.agents,
      actions: definition.rules.map((rule) => ({ outcome: rule.outcome, require: rule.require,
        approval: rule.approval, ...(rule.auto_approve_when ? { auto_approve_when: rule.auto_approve_when } : {}) })),
      ...(definition.budget_limits ? { hard_budget_limits: definition.budget_limits, budget_consumption_preserved: true } : {}),
      ...(parent?.document.delegation.budgets ? { parent_budget_contracts: parent.document.delegation.budgets } : {}),
      operation, previous_definition: before ?? null, parent_requirements_preserved: true, source_database_changed: false };
  }
  function delegationForScope(parent: Parent) {
    return delegationForOwner(parent.document, parent.scope);
  }
  function factType(rule: CompiledActionRuleV1, fact: OwnerPolicyFact) {
    const source = fact.source;
    if (source.kind === "trusted") return { kind: "timestamp" } as const;
    if (source.kind === "input") return rule.rule.inputs?.find((input) => input.name === source.name)?.type;
    if (source.kind === "derived") return rule.derived_types[source.name];
    const binding = rule.bindings.find((value) => value.binding === source.binding);
    return binding?.verification.cardinality === "one"
      ? binding.verification.fields.find((field) => field.name === source.field)?.type
      : undefined;
  }
  function publicFact(fact: OwnerPolicyFact, rule: CompiledActionRuleV1) {
    const type = factType(rule, fact);
    if (!type) throw new PolicyManagementError("POLICY_DELEGATION_PARENT_CHANGED");
    const base = { name: fact.name, title: fact.title, operators: [...fact.operators], value_type: type.kind };
    const values = fact.literal_values;
    const literalValues = values ? { literal_values: [...values] } : {};
    switch (type.kind) {
      case "boolean":
        if (fact.literal_range || values?.some((value) => typeof value !== "boolean")) throw new PolicyManagementError("POLICY_DELEGATION_PARENT_CHANGED");
        return { ...base, ...literalValues };
      case "integer": case "money_minor":
        if (values?.some((value) => typeof value !== "number" || !Number.isSafeInteger(value))) throw new PolicyManagementError("POLICY_DELEGATION_PARENT_CHANGED");
        return { ...base, ...(fact.literal_range ? { literal_range: { ...fact.literal_range } } : {}), ...literalValues };
      case "string": {
        if (fact.literal_range || values?.some((value) => !actionRuleStringMatches(value,type))) {
          throw new PolicyManagementError("POLICY_DELEGATION_PARENT_CHANGED");
        }
        const allowed = type.enum ? type.enum.filter((value) => !values || values.includes(value)) : values;
        return { ...base, ...literalValues, ...(type.enum ? { allowed_values: allowed } : {}) };
      }
      case "date": case "timestamp":
        if (fact.literal_range || values?.some((value) => typeof value !== "string")) throw new PolicyManagementError("POLICY_DELEGATION_PARENT_CHANGED");
        return { ...base, ...literalValues };
      default: throw new PolicyManagementError("POLICY_DELEGATION_PARENT_CHANGED");
    }
  }
  function vocabulary(parent: OwnerPolicyParent, rules: CompiledActionRuleV1[]) {
    return parent.outcomes.map((outcome) => {
      const matches = rules.filter((rule) => rule.outcome === outcome.outcome && rule.compiled_plan_digest === outcome.compiled_plan_digest);
      if (matches.length !== 1) throw new PolicyManagementError("POLICY_DELEGATION_PARENT_CHANGED");
      return { outcome: outcome.outcome, automatic_approval_delegable: outcome.allow_automatic_approval,
        ...(outcome.require ? { parent_require: outcome.require } : {}),
        facts: outcome.facts.map((fact) => publicFact(fact, matches[0]!)) };
    });
  }
  async function currentVocabulary(parent: OwnerPolicyParent) {
    try { return { state: "current" as const, entries: vocabulary(parent, await options.resolveRules()) }; }
    catch (error) {
      if (error instanceof PolicyManagementError && error.code === "POLICY_DELEGATION_PARENT_CHANGED") {
        return { state: "unavailable" as const, entries: [] };
      }
      throw error;
    }
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
    async scopes(credential: string, input: { query?: string; limit?: number; after?: string } = {}) {
      const request = scopePageInput.parse(input), identity = await authenticate(credential, false);
      let parent: Parent | undefined, authorized: ScopeSelection[] | undefined;
      const snapshot = await repository.exactPointerSnapshot({ deployment_id: options.deployment_id, key: parentKey, max_bytes: 1_048_576 }, {
        keys: [parentKey], authorize(current) {
          const revision = current[0];
          if (!revision) throw new PolicyManagementError("POLICY_SELF_SERVICE_DISABLED");
          assertBoundedOwnerPolicyInput(revision.content);
          const document = policyManagementParentSchema.safeParse(revision.content);
          if (!document.success) throw new PolicyManagementError("POLICY_MANAGEMENT_CONFIGURATION_INVALID");
          parent = { revision, document: document.data, scope: parentKey.scope };
          authorized = authorizedScopes(identity, parent);
        },
      });
      if (!parent || !authorized) throw new PolicyManagementError("POLICY_SELF_SERVICE_DISABLED");
      const query = normalizeScopeQuery(request.query);
      const filtered = authorized.filter((item) => isScopeMatch(item, query));
      const binding = pageBinding(identity, parent, snapshot.epoch, query);
      const now = Date.now();
      for (const [token, cursor] of scopeCursors) if (cursor.expires_at <= now) scopeCursors.delete(token);
      let offset = 0;
      if (request.after) {
        const cursor = scopeCursors.get(request.after);
        if (!cursor || cursor.identity !== identity.session_digest || cursor.query !== query) throw new PolicyManagementError("POLICY_SCOPE_CURSOR_INVALID");
        if (cursor.epoch !== snapshot.epoch || cursor.binding !== binding) throw new PolicyManagementError("POLICY_PAGE_EPOCH_STALE");
        offset = cursor.offset;
        scopeCursors.delete(request.after);
      }
      const items = filtered.slice(offset, offset + (request.limit ?? 10));
      const nextOffset = offset + items.length;
      let next: string | undefined;
      if (nextOffset < filtered.length) {
        next = `ps_${randomBytes(32).toString("base64url")}`;
        while (scopeCursors.size >= 128) scopeCursors.delete(scopeCursors.keys().next().value!);
        scopeCursors.set(next, { binding, epoch: snapshot.epoch, identity: identity.session_digest, query, offset: nextOffset, expires_at: now + 300_000 });
      }
      return { epoch: snapshot.epoch, total: filtered.length, scopes: items, ...(next ? { next } : {}) };
    },
    async audit(credential: string, input: { scope: ControlPolicyScope; name: string; limit?: number; before?: { epoch: number; revision_id: string } }) {
      const key = selectedKey(input.scope, input.name), identity = await options.assistant_authenticate(credential);
      if (identity.channel !== "assistant") throw new PolicyManagementError("POLICY_AUTHENTICATION_FAILED");
      return repository.policyHistory({ deployment_id: options.deployment_id, key, limit: input.limit, before: input.before }, authorizationGuard(identity, key.scope, "audit"));
    },
    async browse(credential: string, input: { scope: ControlPolicyScope; limit?: number; after?: { name: string; epoch: number } }) {
      const scope = policyOwnerScopeSchema.parse(input.scope), identity = await authenticate(credential, false);
      let parent: Parent | undefined;
      const page = await repository.scopePointerPage({ deployment_id: options.deployment_id, scope, kind: "delegation",
        limit: input.limit, after: input.after, max_bytes: 1_048_576 }, authorizationGuard(identity, scope, "inspect", (value) => { parent = value; }));
      const authorizedParent = parent;
      if (!authorizedParent) throw new PolicyManagementError("POLICY_SELF_SERVICE_DISABLED");
      return { epoch: page.epoch, scope, items: page.items.map((item) => ({ name: item.name,
        ...(item.active ? { active: pointerSummary(item.active, authorizedParent) } : {}),
        ...(item.draft ? { draft: pointerSummary(item.draft, authorizedParent) } : {}) })), ...(page.next ? { next: page.next } : {}) };
    },
    async list(credential: string, scope: ControlPolicyScope) {
      const { parent, snapshot } = await loadScope(credential, scope, "inspect");
      return { epoch: snapshot.epoch, scope, active: snapshot.active.map((value) => view(value, parent)),
        drafts: snapshot.drafts.map((value) => view(value, parent)) };
    },
    async detail(credential: string, scope: ControlPolicyScope, policyName: string) {
      const key = selectedKey(scope, policyName), { identity, parent, snapshot } = await loadExact(credential, key, "inspect");
      const { active, draft } = snapshot;
      const permissions = (["inspect", "draft", "audit"] as const).filter((permission) => {
        try { assertPolicyManagementRight(identity, parent.document.managers, key.scope, permission); return true; }
        catch (error) { if (error instanceof PolicyManagementError && error.code === "POLICY_MANAGEMENT_FORBIDDEN") return false; throw error; }
      });
      const reviewedVocabulary = await currentVocabulary(parent.document.delegation);
      return { epoch: snapshot.epoch, key, ...(active ? { active: view(active, parent) } : {}), ...(draft ? { draft: view(draft, parent) } : {}),
        permissions,
        agents: delegationForScope(parent).agents,
        ...(parent.document.delegation.budgets ? { parent_hard_budgets: parent.document.delegation.budgets } : {}),
        vocabulary_status: reviewedVocabulary.state, vocabulary: reviewedVocabulary.entries };
    },
    async propose(credential: string, input: { scope: ControlPolicyScope; name: string; expected_epoch: number; definition: unknown }) {
      const key = selectedKey(input.scope, input.name), { identity, parent, snapshot } = await loadExact(credential, key, "draft");
      exactEpoch(input.expected_epoch, snapshot.epoch);
      for (const existing of [snapshot.active, snapshot.draft]) if (existing) decode(existing, parent);
      const scopedParent = delegationForScope(parent);
      if (!scopedParent.agents.length) throw new PolicyManagementError("POLICY_NO_DELEGABLE_AGENTS");
      const compiled = compileOwnerPolicy({ parent: scopedParent, definition: input.definition, rules: await options.resolveRules() });
      const content: ManagedDelegation = { schema_version: "synapsor.managed-owner-policy.v1", parent_name: parentKey.name,
        parent_revision_id: parent.revision.revision_id, parent_authority_digest: parent.revision.authority_digest,
        definition: compiled.definition, compiled_digest: compiled.digest };
      // A new authenticated session may rediscover a saved draft after a lost
      // response. Identical validated content is a receipt, not another revision.
      if (snapshot.draft?.content_digest === canonicalJsonDigest(content)) {
        assertPolicyManagementRight(identity, parent.document.managers, key.scope, "draft");
        const current = await loadExact(credential, key, "draft");
        exactEpoch(snapshot.epoch, current.snapshot.epoch);
        return { epoch: snapshot.epoch, revision_id: snapshot.draft.revision_id,
          summary: summary(key, compiled.definition, "activate"), authority_changed: false, source_database_changed: false,
          status: "draft_saved" as const, replay: true };
      }
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
      const key = selectedKey(input.scope, input.name), { identity, parent, snapshot } = await loadExact(credential, key, input.operation, true);
      exactEpoch(input.expected_epoch, snapshot.epoch);
      const revision = input.operation === "activate" ? snapshot.draft : snapshot.active;
      if (revision?.revision_id !== input.revision_id) throw new PolicyManagementError("POLICY_REVIEW_REVISION_CHANGED");
      const definition = input.operation === "activate" ? (await compileExisting(revision, parent)).definition : decode(revision, parent).definition;
      const previous = snapshot.active;
      const reviewSummary = summary(key, definition, input.operation, previous ? decode(previous, parent).definition : undefined, parent);
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
      const { identity, parent, snapshot } = await loadExact(credential, review.key, review.operation, true);
      if (review.actor !== identity.actor || review.session_digest !== identity.session_digest) throw new PolicyManagementError("POLICY_REVIEW_INVALID");
      const confirmation: ControlPolicyReviewConfirmation = { ...review, actor: identity.actor, session_digest: identity.session_digest, nonce: input.nonce };
      const prior = await repository.event(options.deployment_id, `policy_review:${review.review_id}`);
      if (!prior) {
        exactEpoch(review.expected_epoch, snapshot.epoch);
        const revision = review.operation === "activate" ? snapshot.draft : snapshot.active;
        if (!revision || revision.revision_id !== review.revision_id) throw new PolicyManagementError("POLICY_REVIEW_REVISION_CHANGED");
        const definition = review.operation === "activate" ? (await compileExisting(revision, parent)).definition : decode(revision, parent).definition;
        const previous = snapshot.active;
        if (canonicalJsonDigest(summary(review.key, definition, review.operation, previous ? decode(previous, parent).definition : undefined, parent)) !== review.summary_digest) {
          throw new PolicyManagementError("POLICY_REVIEW_INVALID");
        }
      }
      assertPolicyManagementRight(identity, parent.document.managers, review.key.scope, review.operation);
      return repository.reviews.confirm(confirmation);
    },
  };
}
