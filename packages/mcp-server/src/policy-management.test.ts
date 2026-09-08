import { randomUUID, randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { Pool } from "pg";
import { SignJWT } from "jose";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { sqliteControlPolicyRepository, postgresControlPolicyRepository, type ControlPolicyRevision, type PostgresRuntimePool } from "@synapsor-runner/proposal-store";
import { createPolicyManagementJwtAuthenticator } from "./policy-management-identity.js";
import { compileOwnerPolicy } from "./owner-policy-compiler.js";
import { createPolicyManagementService } from "./policy-management.js";
import type { PolicyManagementParent } from "./owner-policy-records.js";
import { ownerPolicyTestFixture } from "./owner-policy-test-fixture.js";

const secret = "disposable_policy_service_identity_key_32_bytes";
const issuer = "https://identity.example";
const config = { provider: "jwt_hs256" as const, issuer, secret_env: "TEST_POLICY_KEY", audience: "policy-assistant" };
const scope = { level: "principal" as const, tenant_id: "acme", principal: "maya" };
const beta = { ...scope, tenant_id: "beta" };
async function credential(human = false, overrides: Record<string, unknown> = {}) {
  return new SignJWT({ sub: "maya-login", tenant_id: "acme", principal: "maya", actor_kind: "human", sid: "session-a", iss: issuer,
    aud: human ? "policy-review" : "policy-assistant", policy_channel: human ? "human_review" : "assistant",
    exp: Math.floor(Date.now() / 1000) + 300, ...overrides }).setProtectedHeader({ alg: "HS256" }).sign(new TextEncoder().encode(secret));
}
const url = process.env.SYNAPSOR_TEST_POSTGRES_URL;
for (const backend of ["sqlite", "postgres"] as const) {
  describe.skipIf(backend === "postgres" && !url)(`authenticated owner policy service: ${backend}`, () => {
    let pool: Pool;
    const connections: DatabaseSync[] = [];
    const schema = `owner_service_${process.pid}_${randomBytes(4).toString("hex")}`;
    beforeAll(() => { if (backend === "postgres") pool = new Pool({ connectionString: url, max: 4 }); });
    afterEach(() => { vi.restoreAllMocks(); for (const db of connections.splice(0)) db.close(); });
    afterAll(async () => { if (pool) { try { await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); } finally { await pool.end(); } } });

    async function fixture() {
      const f = ownerPolicyTestFixture();
      const db = backend === "sqlite" ? new DatabaseSync(":memory:") : undefined;
      if (db) { connections.push(db); db.exec("PRAGMA foreign_keys = ON"); }
      const queries: string[] = [];
      const tracked: PostgresRuntimePool = { query: (sql, values) => pool.query(sql, values),
        async connect() {
          const client = await pool.connect();
          return { query: (sql, values) => { queries.push(sql); return client.query(sql, values); }, release: () => client.release() };
        } };
      const repository = db ? sqliteControlPolicyRepository(db) : postgresControlPolicyRepository(tracked, schema);
      await repository.initialize();
      const deployment = randomUUID(), parentKey = { scope: { level: "operator" as const }, kind: "parent" as const, name: "self_service" };
      const parentContent: PolicyManagementParent = { schema_version: "synapsor.policy-management-parent.v1", delegation: f.parent,
        agent_owners: [{ agent: "agent-a", scope }, { agent: "agent-b", scope: beta }],
        managers: [{ subject: "maya-login", actor_kind: "human", tenant_id: "acme", scope: { mode: "personal" },
          permissions: ["inspect", "draft", "activate", "revoke", "audit"] },
        { subject: "maya-login", actor_kind: "human", tenant_id: "beta", scope: { mode: "personal" }, permissions: ["inspect", "draft", "activate", "revoke", "audit"] }],
      };
      const parent = (content = parentContent): ControlPolicyRevision => ({ ...parentKey, revision_id: randomUUID(), content,
        content_digest: canonicalJsonDigest(content), authority_digest: canonicalJsonDigest(content) });
      const firstParent = parent();
      const event = () => ({ event_id: randomUUID(), actor: "operator", occurred_at: new Date().toISOString(), receipt: {} });
      await repository.importDeployment({ deployment_id: deployment, project_id: deployment, migration_digest: canonicalJsonDigest({ deployment }),
        revisions: [firstParent], active: [{ ...parentKey, revision_id: firstParent.revision_id }], event: event() });
      const resolveRules = vi.fn(async () => [f.compiled]);
      const service = createPolicyManagementService({ repository, deployment_id: deployment, parent_name: "self_service", resolveRules,
        assistant_authenticate: createPolicyManagementJwtAuthenticator(config, "assistant", { TEST_POLICY_KEY: secret }),
        human_authenticate: createPolicyManagementJwtAuthenticator({ ...config, audience: "policy-review" }, "human_review", { TEST_POLICY_KEY: secret }),
      });
      const ordinary = await credential(), human = await credential(true);
      const propose = (expected_epoch = 1, definition = f.definition) => service.propose(ordinary, { scope, name: "my_agent_rules", expected_epoch, definition });
      const replaceParent = async (content = parentContent) => {
        const next = parent(content), current = (await repository.deployment(deployment))!;
        await repository.commit({ deployment_id: deployment, expected_epoch: current.epoch, revisions: [next], active: [{ ...parentKey, revision_id: next.revision_id }], event: event() });
      };
      const addDelegations = async (count: number) => {
        const currentParent = (await repository.active(deployment, parentKey))!;
        const compiledDelegation = compileOwnerPolicy({ parent: f.parent, definition: f.definition, rules: [f.compiled] });
        const names = Array.from({ length: count }, (_, index) => `policy_${String(index).padStart(3, "0")}`);
        for (const batch of [names.slice(0, 64), names.slice(64)]) {
          if (!batch.length) continue;
          const revisions = batch.map((policyName): ControlPolicyRevision => {
            const content = { schema_version: "synapsor.managed-owner-policy.v1" as const, parent_name: parentKey.name,
              parent_revision_id: currentParent.revision_id, parent_authority_digest: currentParent.authority_digest,
              definition: f.definition, compiled_digest: compiledDelegation.digest };
            return { scope, kind: "delegation", name: policyName, revision_id: randomUUID(), content,
              content_digest: canonicalJsonDigest(content), authority_digest: compiledDelegation.digest };
          });
          const current = (await repository.deployment(deployment))!;
          await repository.commit({ deployment_id: deployment, expected_epoch: current.epoch, revisions, active: [],
            drafts: revisions.map(({ scope, kind, name, revision_id }) => ({ scope, kind, name, revision_id })), event: event() });
        }
        return names;
      };
      return { ...f, db, repository, service, deployment, ordinary, human, propose, replaceParent, addDelegations, parentContent, parentKey, resolveRules, queries };
    }

    it("drafts, reviews, activates, edits and retries through the same scoped service without changing source data", async () => {
      const f = await fixture(), draft = await f.propose();
      expect(draft).toMatchObject({ epoch: 2, authority_changed: false, source_database_changed: false });
      const initial = await f.service.detail(f.ordinary, scope, "my_agent_rules");
      expect(initial.active).toBeUndefined(); expect(initial.draft?.revision_id).toBe(draft.revision_id);
      expect(JSON.stringify(initial.vocabulary)).not.toContain('"source"');
      expect(initial.agents).toEqual(["agent-a"]);
      const review = await f.service.prepareReview(f.human, { scope, name: "my_agent_rules", expected_epoch: 2, revision_id: draft.revision_id, operation: "activate" });
      const receipt = await f.service.confirmReview(f.human, review);
      expect(receipt).toMatchObject({ status: "committed", epoch: 3, source_database_changed: false });
      await expect(f.service.confirmReview(f.human, review)).resolves.toMatchObject({ status: "already_committed", epoch: 3 });
      f.definition.rules[0]!.require = { kind: "compare", fact: "requested_units", operator: "lte", value: 30 };
      const next = await f.propose(3);
      expect(next.revision_id).not.toBe(draft.revision_id);
      expect((await f.service.detail(f.ordinary, scope, "my_agent_rules")).active?.revision_id).toBe(draft.revision_id);
    });

    it("denies before fetching owner content and does not let a data reader's roles grant management", async () => {
      const f = await fixture();
      await f.propose();
      const prepare = f.db ? vi.spyOn(f.db, "prepare") : undefined;
      f.queries.length = 0;
      await expect(f.service.browse(await credential(false, { sub: "ordinary-reader", roles: ["owner", "admin"] }), { scope })).rejects.toThrow("POLICY_MANAGEMENT_FORBIDDEN");
      if (prepare) expect(prepare.mock.calls.map(([sql]) => sql).some((sql) => sql.includes("pointer_names"))).toBe(false);
      expect(f.queries.some((sql) => sql.includes("pointer_names"))).toBe(false);
      expect(f.resolveRules).toHaveBeenCalledTimes(1);
      await expect(f.service.list(f.ordinary, beta)).rejects.toThrow("POLICY_MANAGEMENT_FORBIDDEN");
    });

    it("lists only currently authorized reviewed owner scopes in bounded cursor pages", async () => {
      const f = await fixture();
      const delegationPage = vi.spyOn(f.repository, "scopePointerPage");
      const tenantScope = { level: "tenant" as const, tenant_id: "acme" };
      await f.replaceParent({ ...f.parentContent,
        agent_owners: [...f.parentContent.agent_owners, { agent: "agent-a", scope: tenantScope }],
        managers: [...f.parentContent.managers,
          { subject: "tenant-admin", actor_kind: "human", tenant_id: "acme", scope: { mode: "exact", scope: tenantScope }, permissions: ["inspect"] },
          { subject: "operator", actor_kind: "human", tenant_id: "acme", scope: { mode: "deployment" }, permissions: ["inspect", "draft", "audit"] }],
      });
      const tenantAdmin = await credential(false, { sub: "tenant-admin", principal: "tenant-admin", sid: "tenant-admin-session" });
      const operator = await credential(false, { sub: "operator", principal: "operator", sid: "operator-session" });
      const ordinary = await f.service.scopes(f.ordinary);
      expect(ordinary).toMatchObject({ total: 1, scopes: [{ scope, label: "Principal: acme / maya", permissions: ["inspect", "draft", "audit"], agent_count: 1 }] });
      expect((await f.service.scopes(tenantAdmin)).scopes).toEqual([{ scope: tenantScope, label: "Tenant: acme", permissions: ["inspect"], agent_count: 1 }]);

      const first = await f.service.scopes(operator, { limit: 1 });
      expect(first).toMatchObject({ total: 3 });
      expect(first.scopes).toHaveLength(1);
      expect(first.next).toMatch(/^ps_/u);
      const second = await f.service.scopes(operator, { limit: 1, after: first.next });
      expect(second.scopes).toHaveLength(1);
      expect(second.scopes[0]!.scope).not.toEqual(first.scopes[0]!.scope);
      expect(second.scopes[0]!.permissions).toEqual(["inspect", "draft", "audit"]);
      const betaOnly = await f.service.scopes(operator, { query: "beta", limit: 1 });
      expect(betaOnly).toMatchObject({ total: 1, scopes: [{ scope: beta, label: "Principal: beta / maya", agent_count: 1 }] });
      await expect(f.service.scopes(operator, { query: "beta", after: first.next })).rejects.toThrow("POLICY_SCOPE_CURSOR_INVALID");
      await expect(f.service.scopes(await credential(false, { sub: "ordinary-reader", sid: "reader-session" }))).rejects.toThrow("POLICY_MANAGEMENT_FORBIDDEN");
      expect(delegationPage).not.toHaveBeenCalled();
      await expect(f.service.scopes(operator, { limit: 0 })).rejects.toThrow();
      await expect(f.service.scopes(operator, { limit: 21 })).rejects.toThrow();
      await expect(f.service.scopes(operator, { query: "x".repeat(257) })).rejects.toThrow();

      const current = (await f.repository.deployment(f.deployment))!;
      await f.repository.commit({ deployment_id: f.deployment, expected_epoch: current.epoch, revisions: [], active: [], drafts: [],
        event: { event_id: randomUUID(), actor: "operator", occurred_at: new Date().toISOString(), receipt: {} } });
      await expect(f.service.scopes(operator, { limit: 1, after: second.next! })).rejects.toThrow("POLICY_PAGE_EPOCH_STALE");
      await f.replaceParent({ ...f.parentContent, managers: [] });
      await expect(f.service.scopes(operator, { limit: 1, after: second.next! })).rejects.toThrow("POLICY_MANAGEMENT_FORBIDDEN");
    });

    it("rediscovers an identical saved draft after a new session without creating another revision", async () => {
      const f = await fixture(), draft = await f.propose();
      const fresh = await credential(false, { sid: "reconnected-assistant-session" });
      const same = await f.service.propose(fresh, { scope, name: "my_agent_rules", expected_epoch: draft.epoch, definition: f.definition });
      expect(same).toMatchObject({ epoch: draft.epoch, revision_id: draft.revision_id, replay: true, authority_changed: false });
      expect((await f.repository.deployment(f.deployment))?.epoch).toBe(draft.epoch);
      const detail = await f.service.detail(fresh, scope, "my_agent_rules");
      expect(detail.permissions).toEqual(["inspect", "draft", "audit"]);
      expect(detail.vocabulary[0]?.parent_require).toEqual(f.parent.outcomes[0]?.require);
      f.resolveRules.mockImplementationOnce(async () => { await f.replaceParent({ ...f.parentContent, managers: [] }); return [f.compiled]; });
      await expect(f.service.propose(fresh, { scope, name: "my_agent_rules", expected_epoch: draft.epoch, definition: f.definition }))
        .rejects.toThrow("POLICY_MANAGEMENT_FORBIDDEN");
      expect((await f.repository.draft(f.deployment, { scope, kind: "delegation", name: "my_agent_rules" }))?.revision_id).toBe(draft.revision_id);
    });

    it("browses only an authorized owner scope in bounded stable pages and keeps detail independent of unrelated pointers", async () => {
      const f = await fixture(), names = await f.addDelegations(65);
      const first = await f.service.browse(f.ordinary, { scope, limit: 32 });
      expect(first.epoch).toBe(3);
      expect(first.items.map((item) => item.name)).toEqual(names.slice(0, 32));
      expect(first.next).toEqual({ name: names[31], epoch: 3 });
      expect(JSON.stringify(first)).not.toMatch(/definition|compiled_digest|parent_authority_digest|source/u);
      const second = await f.service.browse(f.ordinary, { scope, limit: 32, after: first.next });
      expect(second.items.map((item) => item.name)).toEqual(names.slice(32, 64));
      const third = await f.service.browse(f.ordinary, { scope, limit: 32, after: second.next });
      expect(third.items.map((item) => item.name)).toEqual(names.slice(64));
      expect(third.next).toBeUndefined();
      expect((await f.service.detail(f.ordinary, scope, names[64]!)).draft?.revision_id).toBeDefined();
      const betaCredential = await credential(false, { tenant_id: "beta" });
      expect((await f.service.browse(betaCredential, { scope: beta })).items).toEqual([]);
      await expect(f.service.browse(f.ordinary, { scope: beta })).rejects.toThrow("POLICY_MANAGEMENT_FORBIDDEN");
      const current = (await f.repository.deployment(f.deployment))!;
      await f.repository.commit({ deployment_id: f.deployment, expected_epoch: current.epoch, revisions: [], active: [],
        event: { event_id: randomUUID(), actor: "operator", occurred_at: new Date().toISOString(), receipt: {} } });
      await expect(f.service.browse(f.ordinary, { scope, after: first.next })).rejects.toThrow("POLICY_PAGE_EPOCH_STALE");
    });

    it("keeps two tenants with the same principal separate and prevents adopting the other owner's agent", async () => {
      const f = await fixture(); await f.propose();
      const betaCredential = await credential(false, { tenant_id: "beta" });
      expect((await f.service.list(betaCredential, beta)).drafts).toEqual([]);
      await expect(f.service.propose(f.ordinary, { scope, name: "other", expected_epoch: 2,
        definition: { ...f.definition, agents: ["agent-b"] } })).rejects.toThrow("OWNER_POLICY_AGENT_NOT_DELEGABLE");
      await f.service.propose(betaCredential, { scope: beta, name: "my_agent_rules", expected_epoch: 2, definition: { ...f.definition, agents: ["agent-b"] } });
      expect((await f.service.list(f.ordinary, scope)).drafts[0]?.definition.agents).toEqual(["agent-a"]);
      expect((await f.service.list(betaCredential, beta)).drafts[0]?.definition.agents).toEqual(["agent-b"]);
    });

    it("refuses generic MCP credentials, tampered summaries and a different human session", async () => {
      const f = await fixture(), draft = await f.propose();
      const input = { scope, name: "my_agent_rules", expected_epoch: 2, revision_id: draft.revision_id, operation: "activate" as const };
      await expect(f.service.prepareReview(f.ordinary, input)).rejects.toThrow("POLICY_AUTHENTICATION_FAILED");
      const review = await f.service.prepareReview(f.human, input);
      await expect(f.service.confirmReview(await credential(true, { sid: "other-session" }), review)).rejects.toThrow("POLICY_REVIEW_INVALID");
      await expect(f.service.confirmReview(f.human, { ...review, review: { ...review.review, summary_digest: canonicalJsonDigest("tampered") } })).rejects.toThrow("POLICY_REVIEW_INVALID");
      expect((await f.service.detail(f.ordinary, scope, "my_agent_rules")).active).toBeUndefined();
      await expect(f.service.confirmReview(f.human, review)).resolves.toMatchObject({ status: "committed" });
    });

    it("refuses stale or revoked parent rights during review and after asynchronous compilation", async () => {
      const f = await fixture(), draft = await f.propose();
      const review = await f.service.prepareReview(f.human, { scope, name: "my_agent_rules", expected_epoch: 2, revision_id: draft.revision_id, operation: "activate" });
      await f.replaceParent({ ...f.parentContent, managers: [] });
      await expect(f.service.confirmReview(f.human, review)).rejects.toThrow("POLICY_MANAGEMENT_FORBIDDEN");
      expect(await f.repository.active(f.deployment, { scope, kind: "delegation", name: "my_agent_rules" })).toBeUndefined();
      await f.replaceParent();
      f.resolveRules.mockImplementationOnce(async () => { await f.replaceParent(); return [f.compiled]; });
      const epoch = (await f.repository.deployment(f.deployment))!.epoch;
      await expect(f.propose(epoch)).rejects.toThrow("POLICY_REVISION_CONFLICT");
      expect((await f.service.detail(f.ordinary, scope, "my_agent_rules")).draft?.revision_id).toBe(draft.revision_id);
    });

    it("permits revocation after the parent or base Action changes, preserving disabled work", async () => {
      const f = await fixture(), draft = await f.propose();
      const active = await f.service.prepareReview(f.human, { scope, name: "my_agent_rules", expected_epoch: 2, revision_id: draft.revision_id, operation: "activate" });
      await f.service.confirmReview(f.human, active);
      const next = await f.propose(3);
      await f.replaceParent();
      f.resolveRules.mockResolvedValue([]);
      const revoke = await f.service.prepareReview(f.human, { scope, name: "my_agent_rules", expected_epoch: 5, revision_id: draft.revision_id, operation: "revoke" });
      await expect(f.service.confirmReview(f.human, revoke)).resolves.toMatchObject({ status: "committed", epoch: 6 });
      const state = await f.service.detail(f.ordinary, scope, "my_agent_rules");
      expect(state.active).toBeUndefined(); expect(state.draft?.revision_id).toBe(next.revision_id);
      await expect(f.service.confirmReview(f.human, active)).resolves.toMatchObject({ status: "already_committed", epoch: 3 });
      expect((await f.service.detail(f.ordinary, scope, "my_agent_rules")).active).toBeUndefined();
    });

    it("shows bounded authorized draft and review history without raw control events or another owner's records", async () => {
      const f = await fixture(), draft = await f.propose();
      const activate = await f.service.prepareReview(f.human, { scope, name: "my_agent_rules", expected_epoch: 2, revision_id: draft.revision_id, operation: "activate" });
      expect(activate.summary.previous_definition).toBeNull();
      await f.service.confirmReview(f.human, activate);
      const next = await f.propose(3);
      const revised = await f.service.prepareReview(f.human, { scope, name: "my_agent_rules", expected_epoch: 4, revision_id: next.revision_id, operation: "activate" });
      expect(revised.summary.previous_definition).toEqual(f.definition);
      const page = await f.service.audit(f.ordinary, { scope, name: "my_agent_rules", limit: 2 });
      expect(page.items.map((value) => value.operation)).toEqual(["revision_created", "activate"]);
      expect(page.next).toBeDefined();
      const remaining = await f.service.audit(f.ordinary, { scope, name: "my_agent_rules", limit: 2, before: page.next });
      expect(remaining.items.map((value) => value.operation)).toEqual(["revision_created"]);
      expect(remaining.next).toBeUndefined();
      expect(JSON.stringify(page)).not.toContain(activate.nonce);
      expect(JSON.stringify(page)).not.toContain("receipt_json");
      expect((await f.service.audit(await credential(false, { tenant_id: "beta" }), { scope: beta, name: "my_agent_rules" })).items).toEqual([]);
      await expect(f.service.audit(f.ordinary, { scope: beta, name: "my_agent_rules" })).rejects.toThrow("POLICY_MANAGEMENT_FORBIDDEN");
    });

    it("does not overwrite a policy identity owned by another parent", async () => {
      const f = await fixture(), draft = await f.propose();
      const key = { scope, kind: "delegation" as const, name: "my_agent_rules" };
      const saved = (await f.repository.draft(f.deployment, key))!;
      const content = { ...saved.content as Record<string, unknown>, parent_name: "another_parent" };
      const changed = { ...saved, revision_id: randomUUID(), content, content_digest: canonicalJsonDigest(content) };
      await f.repository.commit({ deployment_id: f.deployment, expected_epoch: 2, revisions: [changed], active: [], drafts: [{ ...key, revision_id: changed.revision_id }],
        event: { event_id: randomUUID(), actor: "operator", occurred_at: new Date().toISOString(), receipt: {} } });
      await expect(f.propose(3)).rejects.toThrow("POLICY_NAME_OWNED_BY_DIFFERENT_PARENT");
      await expect(f.service.browse(f.ordinary, { scope })).rejects.toThrow("POLICY_NAME_OWNED_BY_DIFFERENT_PARENT");
      expect((await f.repository.draft(f.deployment, key))?.revision_id).toBe(changed.revision_id);
      expect(await f.repository.revision(f.deployment, key, draft.revision_id)).toEqual(saved);
    });
  });
}
