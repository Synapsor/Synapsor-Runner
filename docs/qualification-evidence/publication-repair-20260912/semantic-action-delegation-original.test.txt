import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SignJWT } from "jose";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createActionRuleApprovalClasses, createActionRuleAuthority } from "@synapsor-runner/action-rules";
import { REQUEST_CHANGE_TOOL, subjectReferenceScopeFingerprints, type RuntimeConfig } from "@synapsor-runner/mcp-server";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { ProposalStore, type ControlPolicyKey, type ControlPolicyRevision } from "@synapsor-runner/proposal-store";
import { compileOwnerPolicy } from "../../../packages/mcp-server/src/owner-policy-compiler.js";
import { ownerPolicyTestFixture } from "../../../packages/mcp-server/src/owner-policy-test-fixture.js";
import type { PolicyManagementParent } from "../../../packages/mcp-server/src/owner-policy-records.js";
import * as actionAuthority from "./action-rule-authority.js";
import { migrateProjectControlPolicies, type ControlPolicyMigrationSnapshot } from "./control-policy-store.js";
import { createOptionalActionRuleRuntimeServices } from "./semantic-action-runtime.js";

const roots: string[] = [];
const stores: ProposalStore[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

const workloadSecret = "delegated_runtime_test_secret_at_least_32_bytes";
const subjectKey = "delegated_subject_reference_key_at_least_32_bytes";
const issuer = "https://runtime-identity.example";
const audience = "synapsor-runtime-workload";
const owner = { level: "principal" as const, tenant_id: "acme", principal: "maya" };

async function workloadToken(overrides: Record<string, unknown> = {}, expiresAt = "5m") {
  return new SignJWT({ sub: "agent-workload", tenant_id: "acme", principal: "maya", agent_id: "agent-a", delegator: "maya", run_id: "run-1",
    actor_kind: "agent", delegation_channel: "runtime", ...overrides })
    .setProtectedHeader({ alg: "HS256" }).setIssuer(issuer).setAudience(audience).setExpirationTime(expiresAt)
    .sign(new TextEncoder().encode(workloadSecret));
}

function reviewedAuthority() {
  const fixture = ownerPolicyTestFixture();
  fixture.parent.budgets = [{ meter: "allocated_units", title: "Allocated units", scope: "tenant", unit: "units", scale: 1, maximum: 25, window_ms: 86_400_000 }];
  fixture.parent.outcomes[0]!.budget_charges = [{ meter: "allocated_units", kind: "effect_field", field: fixture.amount }];
  fixture.definition.budget_limits = [{ meter: "allocated_units", maximum: 20 }];
  const compiled = fixture.compiled;
  const loaded = createActionRuleAuthority({ name: "reviewed_runtime_actions", action_boundary_name: "reviewed.actions",
    catalog: { schema_version: "synapsor.action-rule-catalog.v1", generation_lock_fingerprint: compiled.generation_lock_fingerprint,
      resources: [compiled.target_resource], relationships: [] },
    rules: [{ read_boundary_name: "reviewed.read", read_boundary_digest: canonicalJsonDigest("reviewed-read"),
      verification_boundary: compiled.verification_boundary, effect_envelope: compiled.effect_envelope, rule: compiled.rule,
      activated_at: "2026-09-07T00:00:00.000Z" }],
    approval_classes: [{ name: compiled.approval_class, mode: "policy", required_role: "reviewer", required_approvals: 1,
      rules: [{ outcome: compiled.outcome, auto_approve_when: compiled.rule.require }], shared_limits: [
        { id: "action_limit", kind: "count", scope: "capability", capability: compiled.outcome, maximum: 10, window_seconds: 86_400 },
        { id: "owner_limit", kind: "count", scope: "tenant_principal", capability: compiled.outcome, maximum: 3, window_seconds: 86_400 },
      ] }],
  });
  const activation = { schema_version: "synapsor.action-rule-authority-activation.v1" as const, state: "active" as const,
    authority: loaded.authority, digest: loaded.authority.digest, reviews: [{ outcome: compiled.outcome, when: "Reviewed facts permit the request.",
      then: "Create a proposal.", refused: ["Facts do not permit the request."], human_review: "A human review may be required.",
      examples: [{ kind: "eligible" as const, scenario: "Eligible", result: "Create a proposal" }] }],
    actor: "test-operator", activated_at: "2026-09-07T00:00:00.000Z" };
  return { fixture, reviewed: { ...loaded, activation } };
}

async function fixture(options: { delegated?: boolean } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-semantic-delegation-")); roots.push(root);
  const controlPath = path.join(root, ".synapsor", "control.db");
  const { fixture: policyFixture, reviewed } = reviewedAuthority();
  const parentKey: ControlPolicyKey = { scope: { level: "operator" }, kind: "parent", name: "runtime_parent" };
  const ownerKey: ControlPolicyKey = { scope: owner, kind: "delegation", name: "maya_runtime_policy" };
  const parentDocument: PolicyManagementParent = { schema_version: "synapsor.policy-management-parent.v1", managers: [], delegation: policyFixture.parent,
    agent_owners: [{ agent: "agent-a", scope: owner }], runtime_delegations: [{ agent: "agent-a", delegator: "maya", owner,
      policies: [{ scope: owner, name: ownerKey.name }], expires_at: new Date(Date.now() + 120_000).toISOString() }] };
  const make = (key: ControlPolicyKey, content: unknown, authorityDigest: ControlPolicyRevision["authority_digest"] = canonicalJsonDigest(content)): ControlPolicyRevision => ({ ...key,
    revision_id: randomUUID(), content, content_digest: canonicalJsonDigest(content), authority_digest: authorityDigest });
  const parent = make(parentKey, parentDocument);
  const compiledOwner = compileOwnerPolicy({ parent: { ...policyFixture.parent, agents: ["agent-a"] }, definition: policyFixture.definition,
    rules: [reviewed.registry.rules[0]!.compiled] });
  const ownerPolicy = make(ownerKey, { schema_version: "synapsor.managed-owner-policy.v1", parent_name: parentKey.name,
    parent_revision_id: parent.revision_id, parent_authority_digest: parent.authority_digest,
    definition: policyFixture.definition, compiled_digest: compiledOwner.digest }, compiledOwner.digest);
  const snapshot: ControlPolicyMigrationSnapshot = { revisions: [parent, ownerPolicy], active: [parent, ownerPolicy]
    .map(({ scope, kind, name, revision_id }) => ({ scope, kind, name, revision_id })), drafts: [],
    provenance: [{ path: ".synapsor/frozen-delegation.json", digest: canonicalJsonDigest({ parent, ownerPolicy }) }] };
  const env: NodeJS.ProcessEnv = { SUBJECT_KEY: subjectKey, WORKLOAD_SECRET: workloadSecret, WORKLOAD_TOKEN: await workloadToken() };
  const config: RuntimeConfig = { version: 1, mode: "review", storage: { sqlite_path: controlPath }, capabilities: [],
    sources: { local_postgres: { engine: "postgres", read_url_env: "UNUSED_SOURCE_URL" } },
    trusted_context: { provider: "static_dev", values: { tenant_id: "acme", principal: "maya" } },
    action_rules: { project_root: root, subject_reference_hmac_key_env: "SUBJECT_KEY", subject_reference_namespace: "delegation-test",
      ...(options.delegated === false ? {} : { owner_delegation: { parent_name: parentKey.name, credential_env: "WORKLOAD_TOKEN",
        authentication: { provider: "jwt_hs256", issuer, audience, secret_env: "WORKLOAD_SECRET" } } }) } };
  if (options.delegated !== false) {
    const migrated = await migrateProjectControlPolicies({ projectRoot: root, storePath: controlPath, config, env, actor: "test-operator",
      readLegacySnapshot: async () => structuredClone(snapshot), validateSnapshot: async (candidate) => { expect(candidate).toEqual(snapshot); } });
    await migrated.binding.close();
  }
  const store = new ProposalStore(controlPath); stores.push(store);
  const factLoader = vi.fn(async () => structuredClone(policyFixture.facts.bindings.request!.rows));
  const factSessionFactory = vi.fn(async () => ({ fact_loader: { engine: "postgres" as const, load: factLoader }, close: async () => undefined }));
  vi.spyOn(actionAuthority, "createActiveActionRuleAuthorityLoader").mockReturnValue(async () => reviewed);
  const services = await createOptionalActionRuleRuntimeServices({ projectRoot: root, config, env, store,
    factSessionFactory, key: Buffer.from(subjectKey), deployment_scope: "delegation-test", workflow_session_id: "authenticated-runner-session" });
  if (!services) throw new Error("Expected reviewed Action runtime");
  const activated = reviewed.registry.rules[0]!;
  const issue = async (evidence: string) => {
    const fingerprints = subjectReferenceScopeFingerprints({ key: Buffer.from(subjectKey), deployment_scope: "delegation-test",
      source_id: activated.compiled.source, tenant: "acme", principal: "maya" });
    const subjects = await services.subjectReferences.issue({ source_id: activated.compiled.source,
      read_boundary_digest: activated.read_boundary_digest, generation_lock_fingerprint: activated.compiled.generation_lock_fingerprint,
      ...fingerprints, workflow_session_id: services.workflow_session_id, resource: policyFixture.resource, evidence_bundle_id: evidence,
      observations: [{ row_index: 0, primary_key_value: "request-1", observed_version_value: 1 }] });
    return subjects[0]!.ref;
  };
  const request = (subject: string, quantity = 10) => services.semanticActions.callTool(REQUEST_CHANGE_TOOL, {
    outcome: activated.compiled.outcome, subject_refs: { request: subject }, inputs: { quantity },
  });
  const reviseOwner = async () => {
    const current = (await store.controlPolicies.deployment((await migrationIdentity(root))!))!;
    const next = { ...ownerPolicy, revision_id: randomUUID() };
    await store.controlPolicies.commit({ deployment_id: (await migrationIdentity(root))!, expected_epoch: current.epoch, revisions: [next],
      active: [{ ...ownerKey, revision_id: next.revision_id }], event: policyEvent("revise-owner") });
  };
  const revokeOwner = async () => {
    const deployment = (await migrationIdentity(root))!, current = (await store.controlPolicies.deployment(deployment))!;
    await store.controlPolicies.commit({ deployment_id: deployment, expected_epoch: current.epoch, revisions: [],
      active: [{ ...ownerKey, revision_id: null }], event: policyEvent("revoke-owner") });
  };
  return { root, config, env, store, services, policyFixture, reviewed, factLoader, factSessionFactory, issue, request, reviseOwner, revokeOwner };
}

async function migrationIdentity(root: string): Promise<string | undefined> {
  const manifest = JSON.parse(await fs.readFile(path.join(root, ".synapsor", "control-policy", "migration.json"), "utf8")) as { deployment_id?: unknown };
  return typeof manifest.deployment_id === "string" ? manifest.deployment_id : undefined;
}

function policyEvent(operation: string) {
  return { event_id: randomUUID(), actor: "test-operator", occurred_at: new Date().toISOString(), receipt: { operation } };
}

describe("delegated semantic Action runtime composition", () => {
  it("discovers only current delegated outcomes, binds opaque subjects to the authenticated run, and creates no source write", async () => {
    const f = await fixture();
    await expect(f.services.semanticActions.callTool("app.describe_actions", { limit: 1 })).resolves.toMatchObject({ actions: [{ outcome: f.reviewed.registry.rules[0]!.compiled.outcome }] });
    const overCap = await f.issue("ev_over_hard_cap");
    await expect(f.request(overCap, 21)).rejects.toMatchObject({ code: "SEMANTIC_ACTION_UNAVAILABLE" });
    expect(await f.store.listProposals()).toHaveLength(0);
    f.policyFixture.facts.bindings.request!.rows[0]!.category = "exception";
    const humanFallback = await f.issue("ev_human_fallback");
    await expect(f.request(humanFallback)).resolves.toMatchObject({ status: "pending_human_review", source_database_changed: false });
    expect(f.factSessionFactory).toHaveBeenCalledTimes(2);
    expect(f.factLoader).toHaveBeenCalledTimes(2);
    expect(await f.store.listProposals()).toHaveLength(1);

    const nextSubject = await f.issue("ev_other_run");
    f.env.WORKLOAD_TOKEN = await workloadToken({ run_id: "run-2" });
    await expect(f.request(nextSubject)).rejects.toMatchObject({ code: "SUBJECT_REFERENCE_UNAVAILABLE" });
    expect(await f.store.listProposals()).toHaveLength(1);
  });

  it("refuses workload/trusted-context mismatches, expired or missing workload credentials before opening a fact session", async () => {
    const f = await fixture();
    f.env.WORKLOAD_TOKEN = await workloadToken({ tenant_id: "beta" });
    await expect(f.services.semanticActions.callTool("app.describe_actions", {})).rejects.toMatchObject({ code: "DELEGATION_NOT_AVAILABLE" });
    expect(f.factSessionFactory).not.toHaveBeenCalled();
    f.env.WORKLOAD_TOKEN = await workloadToken({}, "0s");
    await expect(f.services.semanticActions.callTool("app.describe_actions", {})).rejects.toMatchObject({ code: "DELEGATION_AUTHENTICATION_FAILED" });
    delete f.env.WORKLOAD_TOKEN;
    await expect(f.services.semanticActions.callTool("app.describe_actions", {})).rejects.toMatchObject({ code: "DELEGATION_AUTHENTICATION_FAILED" });
    expect(f.factSessionFactory).not.toHaveBeenCalled();
  });

  it("refuses old references after a current owner change and refuses an existing proposal after revocation", async () => {
    const f = await fixture(), oldSubject = await f.issue("ev_before_change");
    await f.reviseOwner();
    await expect(f.request(oldSubject)).rejects.toMatchObject({ code: "SUBJECT_REFERENCE_UNAVAILABLE" });
    const currentSubject = await f.issue("ev_current");
    await expect(f.request(currentSubject)).resolves.toMatchObject({ request_disposition: "created", source_database_changed: false });
    await f.revokeOwner();
    await expect(f.request(currentSubject)).rejects.toMatchObject({ code: "SEMANTIC_ACTION_UNAVAILABLE" });
    expect(await f.store.listProposals()).toHaveLength(1);
  });

  it("keeps non-delegated Action requests working while a configured delegated runtime refuses a missing governed repository", async () => {
    const ordinary = await fixture({ delegated: false });
    const fingerprints = subjectReferenceScopeFingerprints({ key: Buffer.from(subjectKey), deployment_scope: "delegation-test",
      source_id: ordinary.reviewed.registry.rules[0]!.compiled.source, tenant: "acme", principal: "maya" });
    const [subject] = await ordinary.services.subjectReferences.issue({ source_id: ordinary.reviewed.registry.rules[0]!.compiled.source,
      read_boundary_digest: ordinary.reviewed.registry.rules[0]!.read_boundary_digest,
      generation_lock_fingerprint: ordinary.reviewed.registry.rules[0]!.compiled.generation_lock_fingerprint,
      ...fingerprints, workflow_session_id: ordinary.services.workflow_session_id, resource: ordinary.policyFixture.resource,
      evidence_bundle_id: "ev_ordinary", observations: [{ row_index: 0, primary_key_value: "request-1", observed_version_value: 1 }] });
    await expect(ordinary.request(subject!.ref)).resolves.toMatchObject({ source_database_changed: false });

    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-missing-delegation-store-")); roots.push(root);
    const env: NodeJS.ProcessEnv = { SUBJECT_KEY: subjectKey, WORKLOAD_SECRET: workloadSecret, WORKLOAD_TOKEN: await workloadToken() };
    const config = { ...ordinary.config, action_rules: { ...ordinary.config.action_rules!, project_root: root,
      owner_delegation: { parent_name: "runtime_parent", credential_env: "WORKLOAD_TOKEN",
        authentication: { provider: "jwt_hs256" as const, issuer, audience, secret_env: "WORKLOAD_SECRET" } } } };
    const store = new ProposalStore(path.join(root, ".synapsor", "control.db")); stores.push(store);
    await expect(createOptionalActionRuleRuntimeServices({ projectRoot: root, config, env, store, key: Buffer.from(subjectKey) }))
      .rejects.toMatchObject({ code: "DELEGATION_POLICY_STORE_REQUIRED" });
  }, 20_000);
});
