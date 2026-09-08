import { randomBytes, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { SignJWT } from "jose";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { postgresControlPolicyRepository, sqliteControlPolicyRepository, type ControlPolicyKey, type ControlPolicyRevision, type ControlPolicyScope } from "@synapsor-runner/proposal-store";
import { createPolicyManagementJwtAuthenticator } from "./policy-management-identity.js";
import { createPolicyManagementService } from "./policy-management.js";
import { createPolicyReviewContinuationService } from "./policy-review-continuation.js";
import { compileOwnerPolicy } from "./owner-policy-compiler.js";
import { ownerPolicyTestFixture } from "./owner-policy-test-fixture.js";
import type { PolicyManagementParent } from "./owner-policy-records.js";

const url = process.env.SYNAPSOR_TEST_POSTGRES_URL;
const secret = "policy_review_continuation_disposable_key_32_bytes";
const issuer = "https://review-continuation.identity.example";
const assistantConfig = { provider: "jwt_hs256" as const, issuer, audience: "policy-assistant", secret_env: "POLICY_REVIEW_TEST_KEY" };
const scope: ControlPolicyScope = { level: "principal", tenant_id: "acme", principal: "maya" };

async function credential(human: boolean, overrides: Record<string, unknown> = {}) {
  return new SignJWT({ sub: "maya-login", tenant_id: "acme", principal: "maya", actor_kind: "human", sid: "session-a",
    policy_channel: human ? "human_review" : "assistant", iss: issuer, aud: human ? "policy-review" : "policy-assistant",
    exp: Math.floor(Date.now() / 1000) + 300, ...overrides }).setProtectedHeader({ alg: "HS256" }).sign(new TextEncoder().encode(secret));
}

for (const backend of ["sqlite", "postgres"] as const) {
  describe.skipIf(backend === "postgres" && !url)(`policy review continuation: ${backend}`, () => {
    let pool: Pool;
    const connections: DatabaseSync[] = [];
    const schema = `review_continuation_${process.pid}_${randomBytes(4).toString("hex")}`;
    beforeAll(() => { if (backend === "postgres") pool = new Pool({ connectionString: url, max: 4 }); });
    afterEach(() => { vi.restoreAllMocks(); for (const db of connections.splice(0)) db.close(); });
    afterAll(async () => { if (pool) { try { await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); } finally { await pool.end(); } } });

    async function fixture() {
      const f = ownerPolicyTestFixture(), db = backend === "sqlite" ? new DatabaseSync(":memory:") : undefined;
      if (db) { connections.push(db); db.exec("PRAGMA foreign_keys = ON"); }
      const repository = db ? sqliteControlPolicyRepository(db) : postgresControlPolicyRepository(pool, schema);
      await repository.initialize();
      const deployment = randomUUID();
      const parentKey: ControlPolicyKey = { scope: { level: "operator" }, kind: "parent", name: "review_parent" };
      const ownerKey: ControlPolicyKey = { scope, kind: "delegation", name: "maya_policy" };
      const parentDocument: PolicyManagementParent = { schema_version: "synapsor.policy-management-parent.v1", delegation: f.parent,
        agent_owners: [{ agent: "agent-a", scope }], managers: ["maya-login", "reviewer-two"].map((subject) => ({ subject,
          actor_kind: "human" as const, tenant_id: "acme", scope: { mode: "personal" as const }, permissions: ["inspect", "draft", "activate", "revoke", "audit"] })) };
      const make = (key: ControlPolicyKey, content: unknown, authorityDigest = canonicalJsonDigest(content)): ControlPolicyRevision => ({ ...key,
        revision_id: randomUUID(), content, content_digest: canonicalJsonDigest(content), authority_digest: authorityDigest });
      const parent = make(parentKey, parentDocument);
      await repository.importDeployment({ deployment_id: deployment, project_id: deployment, migration_digest: canonicalJsonDigest({ deployment }), revisions: [parent],
        active: [{ ...parentKey, revision_id: parent.revision_id }], event: event("import") });
      const service = createPolicyManagementService({ repository, deployment_id: deployment, parent_name: parentKey.name,
        resolveRules: async () => [f.compiled], assistant_authenticate: createPolicyManagementJwtAuthenticator(assistantConfig, "assistant", { POLICY_REVIEW_TEST_KEY: secret }),
        human_authenticate: createPolicyManagementJwtAuthenticator({ ...assistantConfig, audience: "policy-review" }, "human_review", { POLICY_REVIEW_TEST_KEY: secret }) });
      const assistant = await credential(false);
      const draft = await service.propose(assistant, { scope, name: ownerKey.name, expected_epoch: 1, definition: f.definition });
      const continuation = createPolicyReviewContinuationService(service);
      return { f, repository, deployment, service, continuation, assistant, draft, parentKey, ownerKey };
    }

    function published(f: Awaited<ReturnType<typeof fixture>>) {
      return f.continuation.publish({ scope, name: f.ownerKey.name, expected_epoch: f.draft.epoch, revision_id: f.draft.revision_id });
    }

    it("keeps a publish handle opaque and delegates exact human confirmation plus durable retry", async () => {
      const f = await fixture(), handle = published(f), human = await credential(true);
      expect(handle).toMatchObject({ handle: expect.stringMatching(/^pvr_[A-Za-z0-9_-]{43}$/u) });
      expect(JSON.stringify(handle)).not.toMatch(/nonce|scope|revision/u);
      const prepared = await f.continuation.prepare(human, handle.handle);
      expect(prepared).toMatchObject({ review: { revision_id: f.draft.revision_id, expected_epoch: 2, operation: "activate" }, summary: { source_database_changed: false } });
      const confirm = vi.spyOn(f.service, "confirmReview");
      await expect(f.continuation.confirm(human, handle.handle, prepared)).resolves.toMatchObject({ status: "committed", epoch: 3, source_database_changed: false });
      await expect(f.continuation.confirm(human, handle.handle, prepared)).resolves.toMatchObject({ status: "already_committed", epoch: 3 });
      expect(confirm).toHaveBeenCalledTimes(2);
      await expect(f.continuation.prepare(human, handle.handle)).rejects.toMatchObject({ code: "POLICY_REVIEW_CONTINUATION_CONFIRMED" });
    });

    it("allows a different authorized human to replace a pending challenge but rejects stale sessions and tampering", async () => {
      const f = await fixture(), handle = published(f), first = await credential(true), second = await credential(true, { sub: "reviewer-two", sid: "session-b" });
      const firstPrepared = await f.continuation.prepare(first, handle.handle);
      const secondPrepared = await f.continuation.prepare(second, handle.handle);
      await expect(f.continuation.confirm(first, handle.handle, firstPrepared)).rejects.toMatchObject({ code: "POLICY_REVIEW_CONTINUATION_INVALID" });
      await expect(f.continuation.confirm(first, handle.handle, secondPrepared)).rejects.toMatchObject({ code: "POLICY_REVIEW_INVALID" });
      const confirm = vi.spyOn(f.service, "confirmReview");
      await expect(f.continuation.confirm(second, handle.handle, { ...secondPrepared, review: { ...secondPrepared.review, revision_id: "tampered" } }))
        .rejects.toMatchObject({ code: "POLICY_REVIEW_CONTINUATION_INVALID" });
      expect(confirm).not.toHaveBeenCalled();
      await expect(f.continuation.confirm(second, handle.handle, secondPrepared)).resolves.toMatchObject({ status: "committed" });
    });

    it("fails closed for a replaced target, bad nonce, expiry, cancellation, and bounded handle exhaustion", async () => {
      const f = await fixture(), human = await credential(true);
      const wrongScope = f.continuation.publish({ scope: { level: "principal", tenant_id: "other-tenant", principal: "maya" },
        name: f.ownerKey.name, expected_epoch: f.draft.epoch, revision_id: f.draft.revision_id });
      await expect(f.continuation.prepare(human, wrongScope.handle)).rejects.toMatchObject({ code: "POLICY_MANAGEMENT_FORBIDDEN" });
      const wrongRevision = f.continuation.publish({ scope, name: f.ownerKey.name, expected_epoch: f.draft.epoch, revision_id: randomUUID() });
      await expect(f.continuation.prepare(human, wrongRevision.handle)).rejects.toMatchObject({ code: "POLICY_REVIEW_REVISION_CHANGED" });
      const handle = published(f), prepared = await f.continuation.prepare(human, handle.handle);
      await expect(f.continuation.confirm(human, handle.handle, { ...prepared, nonce: "a".repeat(43) })).rejects.toMatchObject({ code: "POLICY_REVIEW_INVALID" });
      await expect(f.continuation.confirm(human, handle.handle, prepared)).resolves.toMatchObject({ status: "committed" });

      let now = 1_000;
      const bounded = createPolicyReviewContinuationService(f.service, { now: () => now, ttl_ms: 10, max_handles: 2 });
      const first = bounded.publish({ scope, name: f.ownerKey.name, expected_epoch: f.draft.epoch, revision_id: f.draft.revision_id });
      bounded.publish({ scope, name: f.ownerKey.name, expected_epoch: f.draft.epoch, revision_id: f.draft.revision_id });
      await expect(Promise.resolve().then(() => bounded.publish({ scope, name: f.ownerKey.name, expected_epoch: f.draft.epoch, revision_id: f.draft.revision_id })))
        .rejects.toMatchObject({ code: "POLICY_REVIEW_CONTINUATION_LIMIT" });
      now += 10;
      await expect(bounded.prepare(human, first.handle)).rejects.toMatchObject({ code: "POLICY_REVIEW_CONTINUATION_INVALID" });
      const cancellable = bounded.publish({ scope, name: f.ownerKey.name, expected_epoch: f.draft.epoch, revision_id: f.draft.revision_id });
      bounded.cancel(cancellable.handle);
      await expect(bounded.prepare(human, cancellable.handle)).rejects.toMatchObject({ code: "POLICY_REVIEW_CONTINUATION_INVALID" });
    });
  });
}

function event(operation: string) {
  return { event_id: randomUUID(), actor: "test-operator", occurred_at: new Date().toISOString(), receipt: { operation } };
}
