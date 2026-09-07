import { randomBytes, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { sqliteControlPolicyRepository, postgresControlPolicyRepository, type ControlPolicyKey, type ControlPolicyRevision } from "@synapsor-runner/proposal-store";
import { compileOwnerPolicy } from "./owner-policy-compiler.js";
import { createEffectiveOwnerPolicyResolver, evaluateEffectiveOwnerPolicy } from "./effective-owner-policy.js";
import { delegationForOwner, policyManagementParentSchema, type PolicyManagementParent } from "./owner-policy-records.js";
import { ownerPolicyTestFixture } from "./owner-policy-test-fixture.js";
import type { OwnerPolicyDefinition } from "./owner-policy-language.js";
import type { OwnerRuntimeIdentity } from "./owner-runtime-identity.js";

const url = process.env.SYNAPSOR_TEST_POSTGRES_URL;
const tenant = { level: "tenant" as const, tenant_id: "acme" };
const personal = { level: "principal" as const, tenant_id: "acme", principal: "maya" };
const parentKey: ControlPolicyKey = { scope: { level: "operator" }, kind: "parent", name: "self_service" };
const tenantKey: ControlPolicyKey = { scope: tenant, kind: "delegation", name: "account_rules" };
const ownerKey: ControlPolicyKey = { scope: personal, kind: "delegation", name: "personal_rules" };
for (const backend of ["sqlite", "postgres"] as const) {
  describe.skipIf(backend === "postgres" && !url)(`effective owner policy: ${backend}`, () => {
    let pool: Pool;
    const connections: DatabaseSync[] = [];
    const schema = `effective_owner_${process.pid}_${randomBytes(4).toString("hex")}`;
    beforeAll(() => { if (backend === "postgres") pool = new Pool({ connectionString: url, max: 4 }); });
    afterEach(() => { vi.restoreAllMocks(); for (const db of connections.splice(0)) db.close(); });
    afterAll(async () => { if (pool) { try { await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); } finally { await pool.end(); } } });
    async function fixture() {
      const f = ownerPolicyTestFixture("university", true), deployment = randomUUID();
      const db = backend === "sqlite" ? new DatabaseSync(":memory:") : undefined;
      if (db) { connections.push(db); db.exec("PRAGMA foreign_keys = ON"); }
      const repository = db ? sqliteControlPolicyRepository(db) : postgresControlPolicyRepository(pool, schema);
      await repository.initialize();
      const parentDocument: PolicyManagementParent = { schema_version: "synapsor.policy-management-parent.v1", managers: [], delegation: f.parent,
        agent_owners: [{ agent: "agent-a", scope: tenant }, { agent: "agent-a", scope: personal }],
        runtime_delegations: [{ agent: "agent-a", delegator: "owner-maya", owner: personal,
          policies: [{ scope: tenant, name: tenantKey.name }, { scope: personal, name: ownerKey.name }] }],
      };
      function revision(key: ControlPolicyKey, content: unknown, authority: string = canonicalJsonDigest(content)): ControlPolicyRevision {
        return { ...key, revision_id: randomUUID(), content, content_digest: canonicalJsonDigest(content), authority_digest: authority };
      }
      const parent = revision(parentKey, parentDocument);
      const ownerRevision = (key: ControlPolicyKey, definition: OwnerPolicyDefinition) => {
        const compiled = compileOwnerPolicy({ parent: delegationForOwner(parentDocument, key.scope), definition, rules: [f.compiled] });
        return revision(key, { schema_version: "synapsor.managed-owner-policy.v1", parent_name: parentKey.name,
          parent_revision_id: parent.revision_id, parent_authority_digest: parent.authority_digest, definition, compiled_digest: compiled.digest }, compiled.digest);
      };
      const accountDefinition = structuredClone(f.definition); accountDefinition.rules[0]!.require = { kind: "compare", fact: "requested_units", operator: "lte", value: 30 };
      const tenantPolicy = ownerRevision(tenantKey, accountDefinition), personalPolicy = ownerRevision(ownerKey, f.definition);
      const event = () => ({ event_id: randomUUID(), actor: "authenticated-test-operator", occurred_at: new Date().toISOString(), receipt: {} });
      const revisions = [parent, tenantPolicy, personalPolicy];
      await repository.importDeployment({ deployment_id: deployment, project_id: deployment, migration_digest: canonicalJsonDigest(deployment),
        revisions, active: revisions.map((entry) => ({ ...entry, revision_id: entry.revision_id })), event: event() });
      // Backend authenticator injection is trusted. JWT verification is tested
      // independently; tool arguments never provide this object.
      const actor: OwnerRuntimeIdentity = { subject: "verified-agent", tenant_id: "acme", principal: "maya", agent_id: "agent-a", delegator: "owner-maya",
        run_id: "run-1", actor_digest: canonicalJsonDigest("authenticated-run-1"), expires_at_ms: Date.now() + 60_000 };
      const authenticate = vi.fn(async () => structuredClone(actor)), resolveRules = vi.fn(async () => [f.compiled]);
      const resolver = createEffectiveOwnerPolicyResolver({ repository, deployment_id: deployment, parent_name: parentKey.name, authenticate, resolveRules });
      const commit = async (key: ControlPolicyKey, next?: ControlPolicyRevision) => repository.commit({ deployment_id: deployment,
        expected_epoch: (await repository.deployment(deployment))!.epoch, revisions: next ? [next] : [],
        active: [{ ...key, revision_id: next?.revision_id ?? null }], event: event() });
      const evaluate = async (quantity: number, facts = f.facts) => evaluateEffectiveOwnerPolicy({ effective: await resolver.resolve("backend-token"),
        compiled: f.compiled, facts, inputs: { quantity }, proposal_id: "proposal-one" });
      return { ...f, repository, resolver, deployment, actor, authenticate, resolveRules, parentDocument, revision, ownerRevision, commit, evaluate };
    }

    it("conjoins root, tenant and personal restrictions using coded reviewed facts", async () => {
      const f = await fixture();
      expect(await f.evaluate(15)).toEqual({ result: "allowed", approval: "inherit" });
      expect(await f.evaluate(25)).toMatchObject({ result: "refused" });
      const changed = structuredClone(f.definition); changed.rules[0]!.require = { kind: "compare", fact: "requested_units", operator: "lte", value: 40 };
      await f.commit(ownerKey, f.ownerRevision(ownerKey, changed));
      expect(await f.evaluate(25)).toMatchObject({ result: "allowed" });
      expect(await f.evaluate(35)).toMatchObject({ result: "refused" });
      const facts = structuredClone(f.facts); facts.bindings.request!.rows[0]!.available = false;
      expect(await f.evaluate(15, facts)).toMatchObject({ result: "refused" });
      facts.bindings.request!.rows[0]!.available = true; facts.bindings.request!.rows[0]!.expires_at = "2020-01-01T00:00:00.000Z";
      expect(await f.evaluate(15, facts)).toMatchObject({ result: "refused" });
    });
    it("keeps any layer's human requirement without replacing parent approval obligations", async () => {
      const f = await fixture(), changed = structuredClone(f.definition);
      changed.rules[0]!.approval = "human"; delete changed.rules[0]!.auto_approve_when;
      await f.commit(tenantKey, f.ownerRevision(tenantKey, changed));
      expect(await f.evaluate(10)).toEqual({ result: "allowed", approval: "human" });
      const facts = structuredClone(f.facts); delete facts.bindings.request!.rows[0]!.expires_at;
      expect(await f.evaluate(10, facts)).toMatchObject({ result: "unknown" });
    });
    it.each([{ tenant_id: "beta" }, { principal: "colleague" }, { agent_id: "agent-b" }, { delegator: "another-owner" }])("refuses unaffiliated callers before owner content lookup %j", async (change) => {
      const f = await fixture(); f.authenticate.mockResolvedValue({ ...f.actor, ...change });
      const snapshot = vi.spyOn(f.repository, "snapshot");
      await expect(f.resolver.resolve("backend-token")).rejects.toThrow("DELEGATION_NOT_AVAILABLE");
      expect(snapshot.mock.calls).toHaveLength(1);
      expect(snapshot.mock.calls[0]![1]).toEqual([parentKey]);
    });
    it("rejects expired workloads, changed runs and source facts for another principal", async () => {
      const f = await fixture(), old = await f.resolver.resolve("backend-token");
      f.authenticate.mockResolvedValue({ ...f.actor, run_id: "next-run", actor_digest: canonicalJsonDigest("authenticated-next-run") });
      await expect(f.resolver.assertCurrent("backend-token", old)).rejects.toThrow("DELEGATION_CHANGED");
      f.authenticate.mockResolvedValue({ ...f.actor, expires_at_ms: 1 });
      await expect(f.resolver.resolve("backend-token")).rejects.toThrow("DELEGATION_AUTHENTICATION_FAILED");
      const facts = structuredClone(f.facts); facts.trusted.principal = "colleague";
      expect(evaluateEffectiveOwnerPolicy({ effective: old, compiled: f.compiled, facts, inputs: { quantity: 5 }, proposal_id: "test" })).toMatchObject({ result: "refused" });
    });
    it("revokes the chain immediately and never treats a disabled draft as active", async () => {
      const f = await fixture(), before = await f.resolver.resolve("backend-token");
      await f.commit(ownerKey);
      const draft = f.ownerRevision(ownerKey, f.definition);
      await f.repository.commit({ deployment_id: f.deployment, expected_epoch: 2, revisions: [draft], active: [],
        drafts: [{ ...ownerKey, revision_id: draft.revision_id }], event: { event_id: randomUUID(), actor: "test", occurred_at: new Date().toISOString(), receipt: {} } });
      await expect(f.resolver.assertCurrent("backend-token", before)).rejects.toThrow("DELEGATION_NOT_AVAILABLE");
    });
    it("rejects parent edits and withdrawals during asynchronous rule loading", async () => {
      const f = await fixture();
      f.resolveRules.mockImplementationOnce(async () => { await f.commit(ownerKey); return [f.compiled]; });
      await expect(f.resolver.resolve("backend-token")).rejects.toThrow("DELEGATION_CHANGED");
      await f.commit(ownerKey, f.ownerRevision(ownerKey, f.definition));
      await f.commit(parentKey, f.revision(parentKey, f.parentDocument));
      await expect(f.resolver.resolve("backend-token")).rejects.toThrow("DELEGATION_PARENT_CHANGED");
    });
    it("requires explicitly enabled runtime bindings and rejects cross-tenant chains", async () => {
      const f = await fixture();
      const invalid = structuredClone(f.parentDocument);
      invalid.runtime_delegations![0]!.policies[0]!.scope = { level: "tenant", tenant_id: "beta" };
      expect(policyManagementParentSchema.safeParse(invalid).success).toBe(false);
      const disabled = structuredClone(f.parentDocument); delete disabled.runtime_delegations;
      await f.commit(parentKey, f.revision(parentKey, disabled));
      await expect(f.resolver.resolve("backend-token")).rejects.toThrow("DELEGATION_NOT_AVAILABLE");
    });
  });
}
